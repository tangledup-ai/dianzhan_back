-- ============================================================
-- 2026_08_contract_schedules.sql
-- 合同收付款分期表（挂 contracts，按 pay_method 拆期）
-- 幂等：可重复执行
-- ============================================================

-- 付款分期（场地合同：公司付给场地方）
CREATE TABLE IF NOT EXISTS rent_payment_schedule (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id),
    seq INTEGER NOT NULL,
    period_start DATE,
    period_end DATE,
    amount NUMERIC(12,2),
    status VARCHAR(20) DEFAULT '未付款',
    pay_date DATE,
    invoice VARCHAR(200),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(contract_id, seq)
);

-- 收款分期（品牌方合同：品牌方付给公司）
CREATE TABLE IF NOT EXISTS rent_income_schedule (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id),
    seq INTEGER NOT NULL,
    period_start DATE,
    period_end DATE,
    amount NUMERIC(12,2),
    status VARCHAR(20) DEFAULT '未到账',
    pay_date DATE,
    invoice VARCHAR(200),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(contract_id, seq)
);
