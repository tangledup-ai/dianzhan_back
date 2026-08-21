-- ============================================================
-- 2026_08_approval_dividend_link.sql
-- 审批单 ↔ 分红记录 一对多关联表（支持多月批量审批）
-- 幂等：可重复执行
-- ============================================================

CREATE TABLE IF NOT EXISTS approval_dividend_records (
    id SERIAL PRIMARY KEY,
    approval_id INTEGER NOT NULL REFERENCES approval_requests(id),
    dividend_record_id INTEGER NOT NULL REFERENCES dividend_records(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(approval_id, dividend_record_id)
);
