-- #10 单源收敛：电表 landlord = 所属站点 landlord
-- 背景：电表从第三方接口自动导入时只写 station/brand，landlord 由人工配置；
--       现统一以「站点场地方」为单源（meters.station_id → stations.landlord_id）。
-- 本迁移只回填「站点已配场地方」的不一致电表（如 TEST-001）；
-- 站点本身没配场地方的电表（约 93 台，导入后待人工配置）保持不动。
-- 幂等：可重复执行。

UPDATE meters m
SET landlord_id = s.landlord_id
FROM stations s
WHERE m.station_id = s.id
  AND s.landlord_id IS NOT NULL
  AND m.landlord_id IS DISTINCT FROM s.landlord_id;

-- 校验：仍不一致的数量应为 0（站点无 landlord 的不算不一致）
-- SELECT COUNT(*) FROM meters m JOIN stations s ON m.station_id = s.id
-- WHERE s.landlord_id IS NOT NULL AND m.landlord_id IS DISTINCT FROM s.landlord_id;
