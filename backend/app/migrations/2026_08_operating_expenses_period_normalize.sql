-- 运营费用 period 归一化：7 位 'YYYY-MM' → 6 位 'YYYYMM'
-- 背景：运营费用此前由前端直接以 7 位写入（Shareholders 保存传 selectedMonth），
--       而分红计算（dividend_calc.get_expense / 分红记录）按 6 位查询，导致运营费用进不了分红。
--       现统一存储为 6 位（与 meter_monthly.month_period / electricity_records.period 一致）。
-- 幂等：可重复执行。

-- 1) 若同站点同月已存在 6 位记录，删除 7 位重复行（保留已存在的 6 位行）
DELETE FROM operating_expenses o
WHERE o.period ~ '^\d{4}-\d{2}$'
  AND EXISTS (
      SELECT 1 FROM operating_expenses o2
      WHERE o2.station_id = o.station_id
        AND o2.period = REPLACE(o.period, '-', '')
  );

-- 2) 剩余 7 位行转换为 6 位
UPDATE operating_expenses
SET period = REPLACE(period, '-', '')
WHERE period ~ '^\d{4}-\d{2}$';

-- 校验：转换后不应再有 7 位格式
-- SELECT COUNT(*) FROM operating_expenses WHERE period ~ '^\d{4}-\d{2}$';  -- 期望 0
