-- 共享电表「品牌分摊」录入（2026-09）
-- 背景：电表被设为「所有品牌共用此电表」（meters.tag='共享电表' 且 brand_id 为空）时，
--       该表是一块场地总表，无法再用「某个品牌的用电量 × 单价」算该品牌的电费。
--       改为人工在「录入度数」里按品牌录入该月应付电费（收款金额），
--       用电量由「金额 ÷ 单价」倒推（单价默认取该品牌方合同单价，可人工覆盖）。
--
-- 口径（用户 2026-09 确认）：
--   collect_amount = 品牌方付给我方的电费（收款/收入，含税）
--   unit_price     = 倒推单价；NULL = 用该品牌方合同单价
--   kwh            = collect_amount ÷ unit_price（不落库，生成台账时实时计算）
--   付款给场地方   = 倒推出的用电量 × 场地合同单价（口径不变）
--
-- 兜底：某块共享电表某月没有任何分摊行时，台账仍按原口径
--       （电表读数 × 合同单价）自动生成，整场地出一行（brand_id 为空）。

CREATE TABLE IF NOT EXISTS meter_shared_allocations (
    id SERIAL PRIMARY KEY,
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    address VARCHAR(100) NOT NULL,
    month_period VARCHAR(6) NOT NULL,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    entity_id INTEGER REFERENCES entities(id),
    collect_amount NUMERIC(14,2) NOT NULL,
    unit_price NUMERIC(8,4),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(address, month_period, brand_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_alloc_period ON meter_shared_allocations(month_period);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_meter ON meter_shared_allocations(meter_id);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_brand ON meter_shared_allocations(brand_id);

COMMENT ON TABLE meter_shared_allocations IS '共享电表品牌分摊：按 电表×月份×品牌 人工录入应付电费（收款），用电量=金额÷单价倒推';
COMMENT ON COLUMN meter_shared_allocations.collect_amount IS '品牌方付给我方的电费（收款/收入，含税）';
COMMENT ON COLUMN meter_shared_allocations.unit_price IS '倒推用电量用的单价（元/度）；为空=取该品牌方合同单价';
COMMENT ON COLUMN meter_shared_allocations.month_period IS '月份，统一 6 位 YYYYMM';
