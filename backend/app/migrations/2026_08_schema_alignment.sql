-- ============================================================
-- 2026_08_schema_alignment.sql
-- 一次性对齐「代码在写但建表脚本缺失」的列/表
-- 幂等：可重复执行
-- ============================================================

-- ── approval_requests：approval_repo 写入但脚本缺的 5 列 ──
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS station_name VARCHAR(200);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS dividend_record_id INTEGER REFERENCES dividend_records(id);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS period VARCHAR(10);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS electricity_amount NUMERIC(14,2);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS rent_amount NUMERIC(14,2);

-- ── dividend_records：approval_repo 写入 approval_id ──
ALTER TABLE dividend_records ADD COLUMN IF NOT EXISTS approval_id INTEGER REFERENCES approval_requests(id);

-- ── meters：meter_repo 写入 landlord_id / entity_id ──
ALTER TABLE meters ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS entity_id INTEGER REFERENCES entities(id);

-- ── contracts：contract_repo 写入的一批后补字段 ──
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS first_month_rent NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_refund NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS early_end_date DATE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_tax_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_tax_rate NUMERIC(6,4);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS post_tax_rent_price NUMERIC(8,4);

-- ── 分红配置生效期列（DATA_GOVERNANCE P6 实锤漂移）──
ALTER TABLE station_shareholder_configs ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE station_shareholder_configs ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE station_introducer_configs  ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE station_introducer_configs  ADD COLUMN IF NOT EXISTS end_date DATE;

-- ── 完全不在任何建表脚本里的表（代码在用）──
CREATE TABLE IF NOT EXISTS cabinets (
    id SERIAL PRIMARY KEY,
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    cabinet_no VARCHAR(100),
    cabinet_type VARCHAR(50) DEFAULT '普通柜',
    brand_id INTEGER REFERENCES brands(id),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entity_brands (
    id SERIAL PRIMARY KEY,
    entity_id INTEGER NOT NULL REFERENCES entities(id),
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    role VARCHAR(50),
    shareholder_id INTEGER REFERENCES shareholders(id),
    phone VARCHAR(50),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ── period 归一化（E1）：7位 'YYYY-MM' → 6位 'YYYYMM'，与 meter_monthly 一致 ──
UPDATE dividend_records   SET period = REPLACE(period, '-', '') WHERE period LIKE '%-%';
UPDATE operating_expenses SET period = REPLACE(period, '-', '') WHERE period LIKE '%-%';
