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

-- ─────────────────────────────────────────────────────────────
-- 7) 同步链路修复：同步表去重 + 补齐 ON CONFLICT 所需唯一索引
--    （历史表缺约束导致每次同步 INSERT 重复行、首次同步报
--      "there is no unique or exclusion constraint matching the ON CONFLICT specification"）
-- ─────────────────────────────────────────────────────────────
DELETE FROM meter_status_cache a USING meter_status_cache b
 WHERE a.device_id = b.device_id AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_status_cache_device_id ON meter_status_cache (device_id);

DELETE FROM meter_devices a USING meter_devices b
 WHERE a.address = b.address AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_devices_address ON meter_devices (address);

DELETE FROM meter_hourly a USING meter_hourly b
 WHERE a.address = b.address AND a.hour_time = b.hour_time AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_hourly_address_hour ON meter_hourly (address, hour_time);

DELETE FROM meter_daily a USING meter_daily b
 WHERE a.address = b.address AND a.day_date = b.day_date AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_daily_address_day ON meter_daily (address, day_date);

DELETE FROM meter_monthly a USING meter_monthly b
 WHERE a.address = b.address AND a.month_period = b.month_period AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_monthly_address_month ON meter_monthly (address, month_period);

DELETE FROM meter_yearly a USING meter_yearly b
 WHERE a.address = b.address AND a.year_period = b.year_period AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_yearly_address_year ON meter_yearly (address, year_period);

-- ─────────────────────────────────────────────────────────────
-- 8) 场地方多业主：landlord_owners 子表（一个场地方可有多个业主，含历史）
--    landlords.contact 保留为「当前业主」冗余（最新业主自动同步）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS landlord_owners (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
    owner_name VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    start_date DATE,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_landlord_owners_landlord ON landlord_owners (landlord_id);

-- 存量联系人迁移为业主记录（幂等）
INSERT INTO landlord_owners (landlord_id, owner_name, phone, remark)
SELECT l.id, l.contact, l.phone, '存量业主（自动迁移）'
FROM landlords l
WHERE l.contact IS NOT NULL AND l.contact <> ''
  AND NOT EXISTS (SELECT 1 FROM landlord_owners o WHERE o.landlord_id = l.id AND o.owner_name = l.contact);
