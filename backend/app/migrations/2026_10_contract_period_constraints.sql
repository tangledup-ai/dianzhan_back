-- 合同按生效区间管理：允许同一场地/品牌连续续签，禁止相同计价通道的生效期重叠。
-- 部署前先检查最后的诊断 SQL；若存在历史重叠记录，需先修正后再运行本迁移。
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM contracts a JOIN contracts b ON a.id < b.id
        WHERE a.contract_type = b.contract_type
          AND a.landlord_id = b.landlord_id
          AND (a.contract_type = '场地合同'
               OR (a.brand_id IS NOT DISTINCT FROM b.brand_id
                   AND a.entity_id IS NOT DISTINCT FROM b.entity_id))
          AND daterange(COALESCE(a.start_date, DATE '1970-01-01'),
                        COALESCE(a.early_end_date, a.end_date, DATE '9999-12-31'), '[]')
              && daterange(COALESCE(b.start_date, DATE '1970-01-01'),
                           COALESCE(b.early_end_date, b.end_date, DATE '9999-12-31'), '[]')
    ) THEN
        RAISE EXCEPTION 'contracts contains overlapping effective periods; resolve duplicates before migration';
    END IF;
END $$;

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS ex_contract_no_overlap;
ALTER TABLE contracts ADD CONSTRAINT ex_contract_no_overlap
EXCLUDE USING gist (
    contract_type WITH =,
    landlord_id WITH =,
    (CASE WHEN contract_type = '品牌方合同' THEN COALESCE(brand_id, 0) ELSE 0 END) WITH =,
    (CASE WHEN contract_type = '品牌方合同' THEN COALESCE(entity_id, 0) ELSE 0 END) WITH =,
    daterange(COALESCE(start_date, DATE '1970-01-01'),
              COALESCE(early_end_date, end_date, DATE '9999-12-31'), '[]') WITH &&
);

COMMENT ON CONSTRAINT ex_contract_no_overlap ON contracts IS
'同一合同类型及计价对象的生效期不能重叠；连续合同可用于续签和调价';
