-- 电表公司主体默认继承场地合同主体（2026-09）
-- 规则：场地下电表默认关联「该场地方最新一份场地合同」的公司主体；
--       用户可在 Entities 页/电表表单显式改（entity_source='manual'，永不被自动覆盖）。
--       场地合同主体保存/变更后，auto 电表自动跟随。

-- 1) 来源标记：manual=用户显式设置；auto=跟随场地合同默认；NULL=未指定（等待场地合同给出主体）
ALTER TABLE meters ADD COLUMN IF NOT EXISTS entity_source VARCHAR(10);

-- 2) 历史数据：已有主体的电表视为显式设置（含 Entities 页关联、表单选择、导入「纳税主体」列）
UPDATE meters SET entity_source = 'manual' WHERE entity_id IS NOT NULL AND entity_source IS NULL;

-- 3) 历史回填：无主体的电表按其场地方最新场地合同的主体填充（仅填空，不覆盖已有关联）
UPDATE meters m
SET entity_id = c.entity_id, entity_source = 'auto'
FROM contracts c
WHERE m.landlord_id IS NOT NULL
  AND m.entity_id IS NULL
  AND c.contract_type = '场地合同'
  AND c.entity_id IS NOT NULL
  AND c.landlord_id = m.landlord_id
  AND c.id = (
    SELECT c2.id FROM contracts c2
    WHERE c2.landlord_id = m.landlord_id
      AND c2.contract_type = '场地合同'
      AND c2.entity_id IS NOT NULL
    ORDER BY c2.id DESC
    LIMIT 1
  );
