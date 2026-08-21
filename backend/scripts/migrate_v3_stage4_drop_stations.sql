-- ═══════════════════════════════════════════════════════════════════════════
-- v3 阶段4：彻底删除站点层（stations 表 + 全部 station_id 列 + v2 旧配置/租金表）
-- 前置：业务已全部场地化（landlord_id/brand_id 直连），本脚本为收尾清理。
-- 先执行备份脚本 backup_v3_stage4.sql，再执行本脚本。
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. 解除对 stations 的外键 ───────────────────────────────────────────
ALTER TABLE contracts                 DROP CONSTRAINT IF EXISTS contracts_station_id_fkey;
ALTER TABLE dividend_records          DROP CONSTRAINT IF EXISTS dividend_records_station_id_fkey;
ALTER TABLE electricity_records       DROP CONSTRAINT IF EXISTS electricity_records_station_id_fkey;
ALTER TABLE meters                    DROP CONSTRAINT IF EXISTS meters_station_id_fkey;
ALTER TABLE operating_expenses        DROP CONSTRAINT IF EXISTS operating_expenses_station_id_fkey;
ALTER TABLE rent_income_records       DROP CONSTRAINT IF EXISTS rent_income_records_station_id_fkey;
ALTER TABLE rent_incomes              DROP CONSTRAINT IF EXISTS rent_incomes_station_id_fkey;
ALTER TABLE rent_leases               DROP CONSTRAINT IF EXISTS rent_leases_station_id_fkey;
ALTER TABLE rent_payment_records      DROP CONSTRAINT IF EXISTS rent_payment_records_station_id_fkey;
ALTER TABLE station_introducer_configs DROP CONSTRAINT IF EXISTS station_introducer_configs_station_id_fkey;
ALTER TABLE station_shareholder_configs DROP CONSTRAINT IF EXISTS station_shareholder_configs_station_id_fkey;
ALTER TABLE approval_requests         DROP CONSTRAINT IF EXISTS approval_requests_station_id_fkey;

-- ── 2. 删除 station_id 列（保留数据表本体，仅移除冗余关联列）──────────
ALTER TABLE contracts            DROP COLUMN IF EXISTS station_id;
ALTER TABLE dividend_records     DROP COLUMN IF EXISTS station_id;
ALTER TABLE electricity_records  DROP COLUMN IF EXISTS station_id;
ALTER TABLE meters               DROP COLUMN IF EXISTS station_id;
ALTER TABLE operating_expenses   DROP COLUMN IF EXISTS station_id;
ALTER TABLE rent_income_records  DROP COLUMN IF EXISTS station_id;
ALTER TABLE rent_incomes         DROP COLUMN IF EXISTS station_id;
ALTER TABLE rent_leases          DROP COLUMN IF EXISTS station_id;
ALTER TABLE rent_payment_records DROP COLUMN IF EXISTS station_id;
ALTER TABLE station_introducer_configs DROP COLUMN IF EXISTS station_id;
ALTER TABLE station_shareholder_configs DROP COLUMN IF EXISTS station_id;
ALTER TABLE approval_requests    DROP COLUMN IF EXISTS station_id;

-- contracts.station_name 为 DEPRECATED 冗余显示列，一并删除（前端已改 landlordName）
ALTER TABLE contracts            DROP COLUMN IF EXISTS station_name;
ALTER TABLE approval_requests    DROP COLUMN IF EXISTS station_name;

-- ── 3. 删除 stations 表 ──────────────────────────────────────────────────
DROP TABLE IF EXISTS stations;

-- ── 4. 删除 v2 遗留空表（已由 landlord_* / rent_*_schedule 替代）────────
DROP TABLE IF EXISTS station_shareholder_configs;
DROP TABLE IF EXISTS station_introducer_configs;
DROP TABLE IF EXISTS rent_leases;
DROP TABLE IF EXISTS rent_incomes;
DROP TABLE IF EXISTS rent_income_records;
DROP TABLE IF EXISTS rent_payment_records;
DROP TABLE IF EXISTS rent_receipts;

COMMIT;

-- ── 5. 重建依赖 stations 的视图（v3：landlord_id/brand_id 直连）─────────
-- 视图独立事务外执行（DROP/CREATE VIEW 不参与上事务亦可，这里单独执行）

-- 5.1 landlord_monthly_summary：电费/运营费/分红 按 landlord_id 直连，不再经站点
DROP VIEW IF EXISTS landlord_monthly_summary;
CREATE OR REPLACE VIEW landlord_monthly_summary AS
WITH periods AS (
    SELECT period FROM electricity_records
    UNION SELECT period FROM operating_expenses
    UNION SELECT period FROM dividend_records
)
SELECT
    l.id AS landlord_id,
    l.name AS landlord_name,
    p.period,
    COUNT(DISTINCT m.id)::INTEGER AS meter_count,
    COUNT(DISTINCT e.id)::INTEGER AS elec_record_count,
    COALESCE(SUM(e.pay_kwh), 0)::NUMERIC(14,2) AS elec_pay_kwh,
    COALESCE(SUM(e.pay_amount), 0)::NUMERIC(14,2) AS elec_pay_amount,
    COALESCE(SUM(e.collect_amount), 0)::NUMERIC(14,2) AS elec_collect_amount,
    COALESCE(SUM(e.collect_net), 0)::NUMERIC(14,2) AS elec_collect_net,
    (COALESCE(SUM(e.collect_amount), 0) - COALESCE(SUM(e.collect_net), 0))::NUMERIC(14,2) AS elec_tax,
    (COALESCE(SUM(e.collect_net), 0) - COALESCE(SUM(e.pay_amount), 0))::NUMERIC(14,2) AS elec_profit,
    COALESCE(SUM(oc.monthly_rent), 0)::NUMERIC(14,2) AS rent_cost,
    COALESCE(SUM(ic.monthly_rent), 0)::NUMERIC(14,2) AS rent_income,
    (COALESCE(SUM(ic.monthly_rent), 0) - COALESCE(SUM(oc.monthly_rent), 0)
     - COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                         THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0))::NUMERIC(14,2) AS rent_profit,
    COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                      THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0)::NUMERIC(14,2) AS rent_tax,
    COALESCE(SUM(oe.amount), 0)::NUMERIC(14,2) AS op_expense,
    COALESCE(SUM(d.profit), 0)::NUMERIC(14,2) AS net_profit,
    (COALESCE(SUM(e.collect_net), 0) - COALESCE(SUM(e.pay_amount), 0)
     + COALESCE(SUM(ic.monthly_rent), 0) - COALESCE(SUM(oc.monthly_rent), 0)
     - COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                         THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0)
     - COALESCE(SUM(oe.amount), 0)
     - COALESCE(SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL), 0)
     - COALESCE(SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL), 0))::NUMERIC(14,2) AS gross_profit,
    COALESCE(SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL), 0)::NUMERIC(14,2) AS shareholder_dividend,
    COALESCE(SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL), 0)::NUMERIC(14,2) AS biz_dividend
FROM landlords l
CROSS JOIN periods p
LEFT JOIN meters m ON m.landlord_id = l.id AND m.brand_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%'
LEFT JOIN electricity_records e ON e.landlord_id = l.id AND e.period = p.period
LEFT JOIN contracts oc ON oc.landlord_id = l.id AND oc.contract_type = '场地合同'
    AND (oc.start_date IS NULL OR oc.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
    AND (COALESCE(oc.early_end_date, oc.end_date) IS NULL OR COALESCE(oc.early_end_date, oc.end_date) >= DATE(p.period || '01'))
LEFT JOIN contracts ic ON ic.landlord_id = l.id AND ic.contract_type = '品牌方合同'
    AND (ic.start_date IS NULL OR ic.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
    AND (COALESCE(ic.early_end_date, ic.end_date) IS NULL OR COALESCE(ic.early_end_date, ic.end_date) >= DATE(p.period || '01'))
LEFT JOIN operating_expenses oe ON oe.landlord_id = l.id AND oe.period = p.period
LEFT JOIN dividend_records d ON d.landlord_id = l.id AND d.period = p.period
LEFT JOIN dividend_shares ds ON ds.dividend_id = d.id
GROUP BY l.id, l.name, p.period;
COMMENT ON VIEW landlord_monthly_summary IS '场地月度经营汇总（v3：landlord 直连）：电费收支+税费/租金收支+税费/运营费用/净利润/分红，按场地×月份一行';

-- 5.2 dividend_settlement_schedule：配置表从 station_* 改为 landlord_*
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
periods AS (
    SELECT '股东' AS beneficiary_type, shareholder_id AS beneficiary_id, settlement_period,
           COUNT(DISTINCT landlord_id) AS landlord_count
    FROM landlord_shareholder_configs
    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
    GROUP BY shareholder_id, settlement_period
    UNION ALL
    SELECT '商务' AS beneficiary_type, introducer_id AS beneficiary_id, settlement_period,
           COUNT(DISTINCT landlord_id) AS landlord_count
    FROM landlord_introducer_configs
    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
    GROUP BY introducer_id, settlement_period
)
SELECT
    p.beneficiary_type,
    p.beneficiary_id,
    COALESCE(sh.name, i.name) AS beneficiary_name,
    p.settlement_period,
    p.landlord_count,
    pr.p_start, pr.p_end, pr.next_period, pr.next_date,
    COALESCE(SUM(CASE WHEN d.status = '已结算' THEN ds.amount ELSE 0 END), 0)::NUMERIC(14,2) AS settled_amount,
    COALESCE(SUM(CASE WHEN d.status <> '已结算' THEN ds.amount ELSE 0 END), 0)::NUMERIC(14,2) AS pending_amount
FROM periods p
CROSS JOIN period_range pr
LEFT JOIN dividend_shares ds ON ds.dividend_id IS NOT NULL
    AND ((p.beneficiary_type = '股东' AND ds.shareholder_id = p.beneficiary_id)
         OR (p.beneficiary_type = '商务' AND ds.introducer_id = p.beneficiary_id))
LEFT JOIN dividend_records d ON ds.dividend_id = d.id AND d.period BETWEEN pr.p_start AND pr.p_end
LEFT JOIN shareholders sh ON p.beneficiary_type = '股东' AND sh.id = p.beneficiary_id
LEFT JOIN introducers i ON p.beneficiary_type = '商务' AND i.id = p.beneficiary_id
GROUP BY p.beneficiary_type, p.beneficiary_id, COALESCE(sh.name, i.name), p.settlement_period,
         p.landlord_count, pr.p_start, pr.p_end, pr.next_period, pr.next_date;
COMMENT ON VIEW dividend_settlement_schedule IS '分红结算周期视图（v3：landlord 配置表）：受益人 × 周期 的下次结算期/日期 + 待结算/已结算金额';
