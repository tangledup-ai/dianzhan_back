-- 修复 landlord_monthly_summary 视图：各数据源预聚合 CTE，彻底避免 e×oc×ic 笛卡尔积放大
DROP VIEW IF EXISTS landlord_monthly_summary;
CREATE OR REPLACE VIEW landlord_monthly_summary AS
WITH periods AS (
    SELECT period FROM electricity_records
    UNION SELECT period FROM operating_expenses
    UNION SELECT period FROM dividend_records
),
elec AS (
    SELECT landlord_id, period,
           SUM(pay_kwh) AS pay_kwh,
           SUM(pay_amount) AS pay_amount,
           SUM(collect_amount) AS collect_amount,
           SUM(collect_net) AS collect_net,
           SUM(profit) AS profit
    FROM electricity_records
    GROUP BY landlord_id, period
),
venue_cost AS (
    SELECT landlord_id, period,
           SUM(monthly_rent) AS rent_cost
    FROM contracts oc
    CROSS JOIN periods p
    WHERE oc.contract_type = '场地合同'
      AND (oc.start_date IS NULL OR oc.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
      AND (COALESCE(oc.early_end_date, oc.end_date) IS NULL OR COALESCE(oc.early_end_date, oc.end_date) >= DATE(p.period || '01'))
    GROUP BY landlord_id, period
),
brand_income AS (
    SELECT landlord_id, period,
           SUM(monthly_rent) AS rent_income,
           SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                    THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END) AS rent_tax
    FROM contracts ic
    CROSS JOIN periods p
    WHERE ic.contract_type = '品牌方合同'
      AND (ic.start_date IS NULL OR ic.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
      AND (COALESCE(ic.early_end_date, ic.end_date) IS NULL OR COALESCE(ic.early_end_date, ic.end_date) >= DATE(p.period || '01'))
    GROUP BY landlord_id, period
),
op AS (
    SELECT landlord_id, period, SUM(amount) AS amount
    FROM operating_expenses
    GROUP BY landlord_id, period
),
div AS (
    SELECT d.landlord_id, d.period,
           SUM(d.profit) AS net_profit,
           SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL) AS shareholder_dividend,
           SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL) AS biz_dividend
    FROM dividend_records d
    LEFT JOIN dividend_shares ds ON ds.dividend_id = d.id
    GROUP BY d.landlord_id, d.period
)
SELECT
    l.id AS landlord_id,
    l.name AS landlord_name,
    p.period,
    (SELECT COUNT(DISTINCT m.id) FROM meters m
      WHERE m.landlord_id = l.id AND m.brand_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%')::INTEGER AS meter_count,
    COALESCE(e.pay_kwh, 0)::NUMERIC(14,2) AS elec_pay_kwh,
    COALESCE(e.pay_amount, 0)::NUMERIC(14,2) AS elec_pay_amount,
    COALESCE(e.collect_amount, 0)::NUMERIC(14,2) AS elec_collect_amount,
    COALESCE(e.collect_net, 0)::NUMERIC(14,2) AS elec_collect_net,
    (COALESCE(e.collect_amount, 0) - COALESCE(e.collect_net, 0))::NUMERIC(14,2) AS elec_tax,
    (COALESCE(e.collect_net, 0) - COALESCE(e.pay_amount, 0))::NUMERIC(14,2) AS elec_profit,
    COALESCE(vc.rent_cost, 0)::NUMERIC(14,2) AS rent_cost,
    COALESCE(bi.rent_income, 0)::NUMERIC(14,2) AS rent_income,
    (COALESCE(bi.rent_income, 0) - COALESCE(vc.rent_cost, 0) - COALESCE(bi.rent_tax, 0))::NUMERIC(14,2) AS rent_profit,
    COALESCE(bi.rent_tax, 0)::NUMERIC(14,2) AS rent_tax,
    COALESCE(op.amount, 0)::NUMERIC(14,2) AS op_expense,
    COALESCE(dv.net_profit, 0)::NUMERIC(14,2) AS net_profit,
    (COALESCE(e.collect_net, 0) - COALESCE(e.pay_amount, 0)
     + COALESCE(bi.rent_income, 0) - COALESCE(vc.rent_cost, 0)
     - COALESCE(bi.rent_tax, 0)
     - COALESCE(op.amount, 0)
     - COALESCE(dv.shareholder_dividend, 0)
     - COALESCE(dv.biz_dividend, 0))::NUMERIC(14,2) AS gross_profit,
    COALESCE(dv.shareholder_dividend, 0)::NUMERIC(14,2) AS shareholder_dividend,
    COALESCE(dv.biz_dividend, 0)::NUMERIC(14,2) AS biz_dividend
FROM landlords l
CROSS JOIN periods p
LEFT JOIN elec e ON e.landlord_id = l.id AND e.period = p.period
LEFT JOIN venue_cost vc ON vc.landlord_id = l.id AND vc.period = p.period
LEFT JOIN brand_income bi ON bi.landlord_id = l.id AND bi.period = p.period
LEFT JOIN op ON op.landlord_id = l.id AND op.period = p.period
LEFT JOIN div dv ON dv.landlord_id = l.id AND dv.period = p.period
ORDER BY l.id, p.period;
COMMENT ON VIEW landlord_monthly_summary IS '场地月度经营汇总（v3：landlord 直连，各源预聚合防笛卡尔积）：电费收支+税费/租金收支+税费/运营费用/净利润/分红，按场地×月份一行';
