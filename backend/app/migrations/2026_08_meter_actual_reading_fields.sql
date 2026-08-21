-- ============================================================
-- 2026_08_meter_actual_reading_fields.sql
-- 电表月度读数：增加「人工实际读数」字段（需求：第三方数据错漏时人工填真实度数）
--
-- 背景：meter_monthly 已有 actual_kwh（本月实际用电量，同步不覆盖）。
--       sync 写入的 prev_reading/curr_reading 是第三方原始值（会被同步覆盖）。
--       本次新增两列，供人工填写真实电表读数，第三方同步永远不会覆盖这三列。
-- 幂等：可重复执行。
-- 用法：Navicat 查询窗口直接执行。
-- ============================================================

ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_actual_reading NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_actual_reading NUMERIC(14,2);

COMMENT ON COLUMN meter_monthly.actual_kwh IS '本月实际用电量（人工填真实度数用；同步不覆盖，计算优先取本值）';
COMMENT ON COLUMN meter_monthly.prev_actual_reading IS '上月实际电表读数（人工填真实读数用；第三方同步不覆盖）';
COMMENT ON COLUMN meter_monthly.curr_actual_reading IS '本月实际电表读数（人工填真实读数用；第三方同步不覆盖）';

-- 校验：应显示 3 个实际字段
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'meter_monthly' AND column_name IN ('actual_kwh','prev_actual_reading','curr_actual_reading');
