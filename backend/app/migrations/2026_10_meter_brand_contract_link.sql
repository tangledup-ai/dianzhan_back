-- 电表明确关联品牌合同。普通电表存于 meters；共享电表按月份、品牌存于分摊行。
ALTER TABLE meters ADD COLUMN IF NOT EXISTS brand_contract_id INTEGER;
ALTER TABLE meter_shared_allocations ADD COLUMN IF NOT EXISTS brand_contract_id INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meters_brand_contract') THEN
        ALTER TABLE meters ADD CONSTRAINT fk_meters_brand_contract
            FOREIGN KEY (brand_contract_id) REFERENCES contracts(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_shared_alloc_brand_contract') THEN
        ALTER TABLE meter_shared_allocations ADD CONSTRAINT fk_shared_alloc_brand_contract
            FOREIGN KEY (brand_contract_id) REFERENCES contracts(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 只有场地内该品牌恰好一份品牌合同的记录才自动回填；存在多份时交由用户选择。
UPDATE meters m SET brand_contract_id = c.id
FROM contracts c
WHERE m.brand_contract_id IS NULL AND m.is_shared = FALSE
  AND m.landlord_id = c.landlord_id AND m.brand_id = c.brand_id
  AND c.contract_type = '品牌方合同'
  AND (SELECT COUNT(*) FROM contracts c2
       WHERE c2.landlord_id = m.landlord_id AND c2.brand_id = m.brand_id
         AND c2.contract_type = '品牌方合同') = 1;

UPDATE meter_shared_allocations a SET brand_contract_id = c.id
FROM meters m, contracts c
WHERE a.brand_contract_id IS NULL AND a.meter_id = m.id
  AND m.landlord_id = c.landlord_id AND a.brand_id = c.brand_id
  AND c.contract_type = '品牌方合同'
  AND (SELECT COUNT(*) FROM contracts c2
       WHERE c2.landlord_id = m.landlord_id AND c2.brand_id = a.brand_id
         AND c2.contract_type = '品牌方合同') = 1;
