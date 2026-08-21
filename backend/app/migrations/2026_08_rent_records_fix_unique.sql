-- ============================================================
-- 2026_08_rent_records_fix_unique.sql
-- rent 台账唯一键修正：station_name 快照键 → station_id 外键键
-- 幂等：可重复执行
-- ============================================================

-- 1) 补齐代码在写但建表脚本缺的列（运行库已有则跳过）
ALTER TABLE rent_payment_records ADD COLUMN IF NOT EXISTS station_name VARCHAR(200);
ALTER TABLE rent_income_records     ADD COLUMN IF NOT EXISTS station_name VARCHAR(200);

-- 2) 回填 station_id：通过 station_name 反查 stations.name（空表无存量，脚本留兜底）
UPDATE rent_payment_records r SET station_id = s.id
FROM stations s
WHERE r.station_id IS NULL AND r.station_name IS NOT NULL AND r.station_name = s.name;

UPDATE rent_income_records r SET station_id = s.id
FROM stations s
WHERE r.station_id IS NULL AND r.station_name IS NOT NULL AND r.station_name = s.name;

-- 3) 去重：回填后可能出现 (station_id, brand_id, fiscal_year) 重复行，保留最小 id
DELETE FROM rent_payment_records a USING rent_payment_records b
WHERE a.id > b.id AND a.station_id = b.station_id
  AND COALESCE(a.brand_id, 0) = COALESCE(b.brand_id, 0) AND a.fiscal_year = b.fiscal_year;

DELETE FROM rent_income_records a USING rent_income_records b
WHERE a.id > b.id AND a.station_id = b.station_id
  AND COALESCE(a.brand_id, 0) = COALESCE(b.brand_id, 0) AND a.fiscal_year = b.fiscal_year;

-- 4) 新增正确唯一键（过渡期与旧 station_name 键并存；
--    Postgres 唯一索引中 NULL 不参与冲突，旧键继续兜底 station_id IS NULL 的行）
CREATE UNIQUE INDEX IF NOT EXISTS uq_rent_payment_station_brand_year
  ON rent_payment_records (station_id, brand_id, fiscal_year);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rent_income_station_brand_year
  ON rent_income_records (station_id, brand_id, fiscal_year);
