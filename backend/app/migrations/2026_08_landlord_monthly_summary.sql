-- ============================================================
-- 2026_08_landlord_monthly_summary.sql
-- 场地月度经营汇总视图（需求：查"某场地方某月经营数据"，跨多表聚合）
--
-- 涉及表：landlords / stations / meters / electricity_records /
--         contracts（场地合同=成本、品牌方合同=收入）/ operating_expenses /
--         dividend_records / dividend_shares
-- 用法：
--   SELECT * FROM landlord_monthly_summary WHERE landlord_id = 1 AND period = '202607';
--   -- 或按场地看趋势：SELECT * FROM landlord_monthly_summary WHERE landlord_id = 1 ORDER BY period;
-- 口径：
--   电费收款 = 实际度数 × 品牌方合同单价（按电表品牌匹配，来自台账）
--   电费税费 = 台账 含税收款 − 不含税收款
--   租金税费 = 品牌方合同启用租金税率时 (含税月租 − 税后月租)
--   净利润   = 分红计算器口径（含税费/首月租/退款/商务分红成本）
--   经营毛利 = 电费利润 + 租金毛利 − 运营费用（实时口径）
--   分红去向 = 分红明细中 股东/介绍人 实分金额
-- 幂等：先 DROP 再 CREATE（视图为纯计算无数据；CREATE OR REPLACE 不允许重命名已有列）
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
    COUNT(DISTINCT s.id)::INTEGER AS station_count,
    COUNT(DISTINCT m.id)::INTEGER AS meter_count,
    -- 电费（已生成台账口径：收款 = 实际度数 × 品牌方合同单价，按电表品牌匹配）
    COALESCE(SUM(e.pay_kwh), 0)::NUMERIC(14,2) AS elec_pay_kwh,
    COALESCE(SUM(e.pay_amount), 0)::NUMERIC(14,2) AS elec_pay_amount,
    COALESCE(SUM(e.collect_amount), 0)::NUMERIC(14,2) AS elec_collect_amount,
    COALESCE(SUM(e.collect_net), 0)::NUMERIC(14,2) AS elec_collect_net,
    (COALESCE(SUM(e.collect_amount), 0) - COALESCE(SUM(e.collect_net), 0))::NUMERIC(14,2) AS elec_tax,
    -- 电费利润 = 含税收款 − 付款 − 电费税费（等价 不含税收款 − 付款；税费为空按 0）
    (COALESCE(SUM(e.collect_net), 0) - COALESCE(SUM(e.pay_amount), 0))::NUMERIC(14,2) AS elec_profit,
    -- 租金（标准月口径：场地合同=成本，品牌方合同=收入；仅统计覆盖该月的合同）
    COALESCE(SUM(oc.monthly_rent), 0)::NUMERIC(14,2) AS rent_cost,
    COALESCE(SUM(ic.monthly_rent), 0)::NUMERIC(14,2) AS rent_income,
    -- 租金利润 = 收入 − 成本 − 租金税费（税费为空按 0）
    (COALESCE(SUM(ic.monthly_rent), 0) - COALESCE(SUM(oc.monthly_rent), 0)
     - COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                         THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0))::NUMERIC(14,2) AS rent_profit,
    COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                      THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0)::NUMERIC(14,2) AS rent_tax,
    -- 运营费用
    COALESCE(SUM(oe.amount), 0)::NUMERIC(14,2) AS op_expense,
    -- 净利润（分红计算器口径，含税费/退款/商务分红成本）
    COALESCE(SUM(d.profit), 0)::NUMERIC(14,2) AS net_profit,
    -- 经营毛利 = 电费利润 + 租金利润 − 运营费用 − 股东分红 − 商务分红
    (COALESCE(SUM(e.collect_net), 0) - COALESCE(SUM(e.pay_amount), 0)
     + COALESCE(SUM(ic.monthly_rent), 0) - COALESCE(SUM(oc.monthly_rent), 0)
     - COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                         THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0)
     - COALESCE(SUM(oe.amount), 0)
     - COALESCE(SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL), 0)
     - COALESCE(SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL), 0))::NUMERIC(14,2) AS gross_profit,
    -- 分红去向（分红明细实分金额）
    COALESCE(SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL), 0)::NUMERIC(14,2) AS shareholder_dividend,
    COALESCE(SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL), 0)::NUMERIC(14,2) AS biz_dividend
FROM landlords l
CROSS JOIN periods p
LEFT JOIN stations s ON s.landlord_id = l.id
LEFT JOIN meters m ON m.station_id = s.id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
LEFT JOIN electricity_records e ON e.station_id = s.id AND e.period = p.period
LEFT JOIN contracts oc ON oc.landlord_id = l.id AND oc.contract_type = '场地合同'
    AND (oc.start_date IS NULL OR oc.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
    AND (COALESCE(oc.early_end_date, oc.end_date) IS NULL OR COALESCE(oc.early_end_date, oc.end_date) >= DATE(p.period || '01'))
LEFT JOIN contracts ic ON ic.landlord_id = l.id AND ic.contract_type = '品牌方合同'
    AND (ic.start_date IS NULL OR ic.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
    AND (COALESCE(ic.early_end_date, ic.end_date) IS NULL OR COALESCE(ic.early_end_date, ic.end_date) >= DATE(p.period || '01'))
LEFT JOIN operating_expenses oe ON oe.station_id = s.id AND oe.period = p.period
LEFT JOIN dividend_records d ON d.station_id = s.id AND d.period = p.period
LEFT JOIN dividend_shares ds ON ds.dividend_id = d.id
GROUP BY l.id, l.name, p.period;

COMMENT ON VIEW landlord_monthly_summary IS '场地月度经营汇总（跨表聚合）：电费收支+税费/租金收支+税费/运营费用/净利润/分红，按场地×月份一行';
