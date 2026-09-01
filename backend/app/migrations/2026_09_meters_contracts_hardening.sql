-- ─────────────────────────────────────────────────────────────
-- 2026-09 健壮性加固（meters/contracts/electricity/审批）
-- 1) 合同押金生命周期：记录押金退还金额/日期/关联审批单
-- 2) 审批单关联合同（场地费退款审批回写用）
-- 3) 合同变更审计日志
-- 4) 电费台账数据来源（auto=系统生成 / manual=人工最后修改）
-- 5) cabinets.brand_id 退役（业务统计全部使用 meters.brand_id，该列从未维护）
-- 6) contracts.cabinets_count 标记退役（唯一源=实时统计 meters→cabinets）
-- ─────────────────────────────────────────────────────────────

-- 1) 押金生命周期
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_amount NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_date DATE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_approval_id INTEGER;

-- 2) 审批单关联合同
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS contract_id INTEGER;

-- 3) 合同变更审计
CREATE TABLE IF NOT EXISTS contract_audit_log (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL,
    action VARCHAR(16) NOT NULL,              -- create / update / delete
    changes JSONB,                            -- update: {字段: {from,to}}；create/delete: 合同快照
    operator VARCHAR(64),
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_audit_contract ON contract_audit_log (contract_id, created_at DESC);

-- 4) 电费台账数据来源
ALTER TABLE electricity_records ADD COLUMN IF NOT EXISTS data_source VARCHAR(16) DEFAULT 'auto';
COMMENT ON COLUMN electricity_records.data_source IS 'auto=系统按读数+合同生成；manual=人工最后修改（台账页可见徽章）';

-- 5) cabinets.brand_id 退役
ALTER TABLE cabinets DROP COLUMN IF EXISTS brand_id;

-- 6) cabinets_count 退役标记
COMMENT ON COLUMN contracts.cabinets_count IS 'DEPRECATED(2026-09)：计费柜数唯一源=实时统计 meters→cabinets（live_cabinets_count），本列仅历史回显，不再写入';
