-- 为meter_monthly表添加抄表详细信息字段
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_reading_date DATE;
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_reading NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_reading_date DATE;
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_reading NUMERIC(14,2);

-- 添加注释
COMMENT ON COLUMN meter_monthly.prev_reading_date IS '上月抄表时间';
COMMENT ON COLUMN meter_monthly.prev_reading IS '起始度数（上月读数）';
COMMENT ON COLUMN meter_monthly.curr_reading_date IS '本月抄表时间';
COMMENT ON COLUMN meter_monthly.curr_reading IS '抄表度数（本月读数）';