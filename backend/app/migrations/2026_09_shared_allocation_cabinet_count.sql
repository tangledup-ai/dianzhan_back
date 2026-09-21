-- 共享电表品牌分摊：新增「电柜数量」列（2026-09）
--
-- 背景：一块场地总表（meters.tag='共享电表' 且 brand_id 为空）下可能接入多个品牌方，
--       各品牌方在该表下投放的电柜数量不同，且会**逐月动态调整**（增减柜子）。
--       此前分摊行只有「应付电费 / 单价」，缺少柜数这个分摊依据。
--
-- 口径（用户 2026-09 确认）：
--   cabinet_count 落「电表 × 月份 × 品牌」维度 —— 每月可不同，不做全局唯一值。
--   录入时留空 = 前端自动沿用该品牌**最近一次**填写值（仅预填，不落库）；
--   若某月调整了柜数，下个月默认值即随之变为新值。
--
-- 说明：cabinets 表（物理资产，挂电表下）不适用于本场景 ——
--       共享电表的 brand_id 为空，柜子挂上去后无法表达「哪个品牌的柜」；
--       cabinets.brand_id 已于 2026-09 退役。故柜数直接落在分摊行上。

ALTER TABLE meter_shared_allocations ADD COLUMN IF NOT EXISTS cabinet_count INTEGER;

COMMENT ON COLUMN meter_shared_allocations.cabinet_count IS '该品牌当月在此共享电表下投放的电柜数量（逐月可变，可为空）';
