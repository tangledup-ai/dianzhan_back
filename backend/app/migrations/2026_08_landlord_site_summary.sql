-- 场地公共属性 + 场地汇总视图
-- 背景（用户确认的业务模型）：
--   场地（landlords）= 聚合根，持有公共属性（名称/区域/地址/坐标/联系人/电话）；
--   场地合同（contracts.landlord_id）挂在场地下的子记录（可能多个业主多份合同）；
--   场地租金成本 = 该场地所有「场地合同」月租金之和；
--   场地租金收入 = 该场地所有「品牌方合同」月租金之和；
--   汇总通过只读视图实时计算（不落缓存列，避免派生值漂移），并保留合同 id 数组便于索引。
-- 幂等：可重复执行。

-- 1) landlords 补充场地公共属性列（可空）
ALTER TABLE landlords
    ADD COLUMN IF NOT EXISTS region VARCHAR(50),
    ADD COLUMN IF NOT EXISTS address VARCHAR(300),
    ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);

-- 2) 场地汇总视图：公共属性 + 租金加和 + 合同 id 数组
CREATE OR REPLACE VIEW landlord_site_summary AS
SELECT
    l.id AS landlord_id,
    l.name AS landlord_name,
    l.contact,
    l.phone,
    l.region,
    l.address,
    l.latitude,
    l.longitude,
    COALESCE(SUM(c.monthly_rent) FILTER (WHERE c.contract_type = '场地合同'), 0)::NUMERIC(14,2) AS site_rent_cost,
    COALESCE(SUM(c.monthly_rent) FILTER (WHERE c.contract_type = '品牌方合同'), 0)::NUMERIC(14,2) AS brand_rent_income,
    COUNT(c.id) FILTER (WHERE c.contract_type = '场地合同') AS site_contract_count,
    COUNT(c.id) FILTER (WHERE c.contract_type = '品牌方合同') AS brand_contract_count,
    COALESCE(ARRAY_AGG(c.id) FILTER (WHERE c.contract_type = '场地合同'), '{}'::INTEGER[]) AS site_contract_ids,
    COALESCE(ARRAY_AGG(c.id) FILTER (WHERE c.contract_type = '品牌方合同'), '{}'::INTEGER[]) AS brand_contract_ids
FROM landlords l
LEFT JOIN contracts c ON c.landlord_id = l.id
GROUP BY l.id;
