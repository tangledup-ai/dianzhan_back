-- ============================================================
-- 2026_08_dividend_settlement_schedule.sql
-- 分红结算周期视图（需求：让分红周期不同的人知道「下次分红时间、应该分红的金额」）
--
-- 口径：
--   - 按 受益人(股东/介绍人) × 结算周期(月/季度/半年/年) 一行；
--   - 周期为「生效中」的配置（end_date 为空或 >= 今天）；
--   - 下次结算期/日期按当前日期动态推算：月=本月末、季度=本季度末、
--     半年=6月或12月末、年=12月末；
--   - 待结算金额 = 当前周期内 已生成分红记录且状态≠已结算 的明细金额合计
--     （未生成分红记录的月份不含在内——生成后即出现）；
--   - 已结算金额 = 当前周期内 状态=已结算 的明细金额合计。
-- 用法：
--   SELECT * FROM dividend_settlement_schedule ORDER BY beneficiary_type, beneficiary_name;
--   -- 只看某股东：SELECT * FROM dividend_settlement_schedule WHERE beneficiary_name = '张三';
-- 幂等：DROP + CREATE（视图无数据）。
-- ============================================================

DROP VIEW IF EXISTS dividend_settlement_schedule;

CREATE OR REPLACE VIEW dividend_settlement_schedule AS
WITH cur AS (
    SELECT
        to_char(CURRENT_DATE, 'YYYYMM') AS cur_period,
        to_char(CURRENT_DATE, 'YYYY')   AS cur_year,
        to_char(date_trunc('quarter', CURRENT_DATE), 'YYYYMM') AS q_start,
        to_char(date_trunc('quarter', CURRENT_DATE) + interval '3 months' - interval '1 day', 'YYYYMM') AS q_end,
        to_char(date_trunc('year', CURRENT_DATE), 'YYYYMM') AS y_start,
        to_char(date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day', 'YYYYMM') AS y_end
),
-- 各结算周期的 区间起止月 + 下次结算期/日期
period_range AS (
    SELECT '月' AS settlement_period,
           cur.cur_period AS p_start, cur.cur_period AS p_end,
           cur.cur_period AS next_period,
           (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')::date AS next_date
    FROM cur
    UNION ALL
    SELECT '季度', cur.q_start, cur.q_end, cur.q_end,
           (date_trunc('quarter', CURRENT_DATE) + interval '3 months' - interval '1 day')::date
    FROM cur
    UNION ALL
    SELECT '半年',
           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '01' ELSE cur.cur_year || '07' END,
           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '06' ELSE cur.y_end END,
           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '06' ELSE cur.y_end END,
           CASE WHEN cur.cur_period <= cur.cur_year || '06'
                THEN (date_trunc('year', CURRENT_DATE) + interval '6 months' - interval '1 day')::date
                ELSE (date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day')::date END
    FROM cur
    UNION ALL
    SELECT '年', cur.y_start, cur.y_end, cur.y_end,
           (date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day')::date
    FROM cur
),
-- 生效中的分红配置（受益人 × 周期 × 站点数）
periods AS (
    SELECT '股东' AS beneficiary_type, shareholder_id AS beneficiary_id, settlement_period,
           COUNT(DISTINCT station_id) AS station_count
    FROM station_shareholder_configs
    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
    GROUP BY shareholder_id, settlement_period
    UNION ALL
    SELECT '介绍人' AS beneficiary_type, introducer_id AS beneficiary_id, settlement_period,
           COUNT(DISTINCT station_id) AS station_count
    FROM station_introducer_configs
    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
    GROUP BY introducer_id, settlement_period
),
-- 受益人名字
b AS (
    SELECT '股东' AS beneficiary_type, id AS beneficiary_id, name AS beneficiary_name FROM shareholders
    UNION ALL
    SELECT '介绍人', id, name FROM introducers
),
-- 分红明细（已生成的分红记录）
shares AS (
    SELECT '股东' AS beneficiary_type, ds.shareholder_id AS beneficiary_id,
           d.period, d.status, ds.amount
    FROM dividend_shares ds JOIN dividend_records d ON ds.dividend_id = d.id
    WHERE ds.shareholder_id IS NOT NULL
    UNION ALL
    SELECT '介绍人', ds.introducer_id, d.period, d.status, ds.amount
    FROM dividend_shares ds JOIN dividend_records d ON ds.dividend_id = d.id
    WHERE ds.introducer_id IS NOT NULL
)
SELECT
    p.beneficiary_type,
    b.beneficiary_name,
    p.settlement_period,
    p.station_count,
    pr.next_period      AS next_settlement_period,
    pr.next_date        AS next_settlement_date,
    pr.p_start          AS period_start,
    pr.p_end            AS period_end,
    COALESCE(SUM(CASE WHEN s.period BETWEEN pr.p_start AND pr.p_end
                       AND s.status <> '已结算' THEN s.amount END), 0)::NUMERIC(14,2) AS pending_amount,
    COALESCE(SUM(CASE WHEN s.period BETWEEN pr.p_start AND pr.p_end
                       AND s.status = '已结算' THEN s.amount END), 0)::NUMERIC(14,2) AS settled_amount
FROM periods p
JOIN period_range pr ON pr.settlement_period = p.settlement_period
JOIN b ON b.beneficiary_type = p.beneficiary_type AND b.beneficiary_id = p.beneficiary_id
LEFT JOIN shares s ON s.beneficiary_type = p.beneficiary_type
                  AND s.beneficiary_id = p.beneficiary_id
GROUP BY p.beneficiary_type, b.beneficiary_name, p.settlement_period, p.station_count,
         pr.next_period, pr.next_date, pr.p_start, pr.p_end;

COMMENT ON VIEW dividend_settlement_schedule IS '分红结算周期视图：受益人×周期 的 下次结算期/日期、待结算金额、已结算金额';
