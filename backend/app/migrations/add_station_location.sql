-- 为stations表添加经纬度字段
ALTER TABLE stations ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7);
ALTER TABLE stations ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);

-- 添加注释
COMMENT ON COLUMN stations.latitude IS '纬度';
COMMENT ON COLUMN stations.longitude IS '经度';