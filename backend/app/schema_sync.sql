-- ============================================================
-- schema_sync.sql —— 存量库结构同步（每次后端启动自动执行）
-- ============================================================
-- 背景：database_init.sql 的 CREATE TABLE IF NOT EXISTS 不会给已存在的旧表补新列；
--       老库升级后新代码 INSERT/SELECT 引用新列会报错（如新建电表 400）。
--       本文件由 init_database() 逐条执行，单条失败只记日志不影响其他语句。
-- 原则：只加列 / 加表 / 加索引，绝无 DELETE / DROP / 改列类型；
--       数据回填只填空（NULL），不覆盖已有值；全部语句幂等，可重复执行。
--       一次性/含清理的迁移仍在 migrations/ 目录手工执行。
-- ============================================================

-- ── 1) meters（v3：直挂场地方 + 公司主体继承）────────────────
ALTER TABLE meters ADD COLUMN IF NOT EXISTS landlord_id INTEGER;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS entity_id INTEGER;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS entity_source VARCHAR(10);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS tag VARCHAR(20) NOT NULL DEFAULT '合作商电表';
ALTER TABLE meters ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT '正常';
ALTER TABLE meters ADD COLUMN IF NOT EXISTS transformer_ratio NUMERIC(10,2) NOT NULL DEFAULT 1;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS meter_name VARCHAR(200);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS collector_id VARCHAR(100);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS remark TEXT;

-- 主体来源回填：已有主体的电表视为显式设置（只填 NULL，不覆盖已有值）
UPDATE meters SET entity_source = 'manual' WHERE entity_id IS NOT NULL AND entity_source IS NULL;

-- 无主体电表按「场地方最新一份场地合同」继承主体（只填空，不覆盖已有关联）
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

-- ── 2) platform_users（财务按电表类型隔离）──────────────────
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS meter_tag_scope VARCHAR(20);

-- ── 3) contracts（押金退还 / 合同预警已处理）─────────────────
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_amount NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_date DATE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_approval_id INTEGER;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS alert_handled_at TIMESTAMPTZ;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS alert_handled_sig TEXT;

-- ── 4) approval_requests（关联合同：场地费退款审批回写用）────
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS contract_id INTEGER;

-- ── 5) electricity_records（台账数据来源 auto/manual）────────
ALTER TABLE electricity_records ADD COLUMN IF NOT EXISTS data_source VARCHAR(16) DEFAULT 'auto';

-- ── 6) meter_monthly（人工实际读数，同步不覆盖）──────────────
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS actual_kwh NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_actual_reading NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_actual_reading NUMERIC(14,2);

-- ── 7) 合同审计日志（老库缺表时补建）────────────────────────
CREATE TABLE IF NOT EXISTS contract_audit_log (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL,
    action VARCHAR(16) NOT NULL,
    changes JSONB,
    operator VARCHAR(64),
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_audit_contract ON contract_audit_log (contract_id, created_at DESC);

-- ── 8) 场地方多业主子表（老库缺表时补建）────────────────────
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

-- 存量联系人迁移为业主记录（幂等：已存在同名业主则跳过）
INSERT INTO landlord_owners (landlord_id, owner_name, phone, remark)
SELECT l.id, l.contact, l.phone, '存量业主（自动迁移）'
FROM landlords l
WHERE l.contact IS NOT NULL AND l.contact <> ''
  AND NOT EXISTS (SELECT 1 FROM landlord_owners o WHERE o.landlord_id = l.id AND o.owner_name = l.contact);
