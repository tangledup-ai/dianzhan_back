-- 迁移脚本：为 contracts 表添加税后计算相关字段
-- 执行方式：psql -d your_database -f migrate_tax_fields.sql

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS tax_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,4) DEFAULT 0.01;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS post_tax_electricity_price NUMERIC(8,4);

-- 为已有记录设置默认值
UPDATE contracts SET tax_enabled = FALSE WHERE tax_enabled IS NULL;
UPDATE contracts SET tax_rate = 0.01 WHERE tax_rate IS NULL;
