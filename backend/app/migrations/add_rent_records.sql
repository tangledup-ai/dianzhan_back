-- 付款记录（按年份保存付款情况、发票等）
CREATE TABLE IF NOT EXISTS rent_payment_records (
    id SERIAL PRIMARY KEY,
    station_id INTEGER NOT NULL REFERENCES stations(id),
    brand_id INTEGER REFERENCES brands(id),
    fiscal_year VARCHAR(20) NOT NULL,
    pay_status VARCHAR(100),
    invoice VARCHAR(200),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(station_id, brand_id, fiscal_year)
);

-- 收款记录（按年份保存收款情况、进项成本等）
CREATE TABLE IF NOT EXISTS rent_income_records (
    id SERIAL PRIMARY KEY,
    station_id INTEGER NOT NULL REFERENCES stations(id),
    brand_id INTEGER REFERENCES brands(id),
    fiscal_year VARCHAR(20) NOT NULL,
    income_status VARCHAR(100),
    input_cost NUMERIC(12,2),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(station_id, brand_id, fiscal_year)
);
