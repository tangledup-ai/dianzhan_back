-- ============================================================
-- 2026_08_contracts_normalize.sql
-- 合同归位场地方(landlord) + 消除 station_name 快照（第一阶段）
-- 幂等：可重复执行
-- ============================================================

-- 1) 新增 entity_id 外键（解决 Entities 页 pay_entity 文本匹配）
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS entity_id INTEGER REFERENCES entities(id);

-- 2) 回填 entity_id：用 pay_entity 文本匹配 entities.name / short_name
UPDATE contracts c SET entity_id = e.id
FROM entities e
WHERE c.entity_id IS NULL AND (c.pay_entity = e.name OR c.pay_entity = e.short_name);

-- 3) station_name 降级：松 NOT NULL（不再作为必填键）
ALTER TABLE contracts ALTER COLUMN station_name DROP NOT NULL;
COMMENT ON COLUMN contracts.station_name IS
  'DEPRECATED 冗余显示列（曾存场地方名）。自 2026-08 起不再写入/匹配，显示名由后端 JOIN landlord/brand 计算，收尾迁移将删除本列。';

-- ⚠️ 说明：不回填 station_id。合同统一挂场地方(landlord)一级，不区分具体站点；
--   且 landlord 4/5 各对应多个站点，按 landlord_id 反查 station_id 会产生多行、无法确定唯一站点。
