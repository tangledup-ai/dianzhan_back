-- 迁移脚本：分红配置/分红明细增加品牌维度
-- 执行方式：psql -d your_database -f add_brand_dividend.sql
--
-- 业务规则：同一场地下有多个品牌，股东/介绍人可只参与其中一个品牌的分红。
-- brand_id 为 NULL 表示参与整个场地全部分红（兼容既有配置）。

-- 1. 分红配置表增加品牌列
ALTER TABLE station_shareholder_configs ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id);
ALTER TABLE station_introducer_configs ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id);

-- 2. 分红明细表增加品牌列
ALTER TABLE dividend_shares ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id);

-- 3. 唯一约束改造：原来 UNIQUE(station_id, shareholder_id)，
--    改为「整个场地(brand_id IS NULL)」与「指定品牌(brand_id IS NOT NULL)」两类部分唯一索引。
ALTER TABLE station_shareholder_configs DROP CONSTRAINT IF EXISTS station_shareholder_configs_station_id_shareholder_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ssh_conf_whole
    ON station_shareholder_configs (station_id, shareholder_id) WHERE brand_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ssh_conf_brand
    ON station_shareholder_configs (station_id, brand_id, shareholder_id) WHERE brand_id IS NOT NULL;

ALTER TABLE station_introducer_configs DROP CONSTRAINT IF EXISTS station_introducer_configs_station_id_introducer_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sint_conf_whole
    ON station_introducer_configs (station_id, introducer_id) WHERE brand_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sint_conf_brand
    ON station_introducer_configs (station_id, brand_id, introducer_id) WHERE brand_id IS NOT NULL;
