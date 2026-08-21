-- #8 分红配置支持「同一股东/介绍人 × 同一站点 × 多段生效期」
-- 背景：原唯一索引 UNIQUE(station_id, shareholder_id) [brand_id IS NULL] 只允许一条整站配置，
--       而 UI/分红计算支持 start_date/end_date 生效期过滤，同一配置多段生效期写不进去。
-- 改法：把 start_date 纳入唯一键（NULL 视为 1970-01-01），同一股东同一站可配置多段不重叠生效期。
-- 幂等：可重复执行。

DROP INDEX IF EXISTS uq_ssh_conf_whole;
DROP INDEX IF EXISTS uq_ssh_conf_brand;
DROP INDEX IF EXISTS uq_sint_conf_whole;
DROP INDEX IF EXISTS uq_sint_conf_brand;
-- 兼容旧约束名（早期 UNIQUE 约束自动生成的名字）
ALTER TABLE station_shareholder_configs DROP CONSTRAINT IF EXISTS station_shareholder_configs_station_id_shareholder_id_key;
ALTER TABLE station_introducer_configs DROP CONSTRAINT IF EXISTS station_introducer_configs_station_id_introducer_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ssh_conf_whole
    ON station_shareholder_configs (station_id, shareholder_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ssh_conf_brand
    ON station_shareholder_configs (station_id, brand_id, shareholder_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sint_conf_whole
    ON station_introducer_configs (station_id, introducer_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sint_conf_brand
    ON station_introducer_configs (station_id, brand_id, introducer_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NOT NULL;
