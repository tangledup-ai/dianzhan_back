-- ============================================================
-- 2026_08_schedule_cascade.sql
-- 合同删除时级联删除分期记录（防止孤儿数据）
-- 幂等：可重复执行
-- ============================================================

ALTER TABLE rent_payment_schedule DROP CONSTRAINT IF EXISTS rent_payment_schedule_contract_id_fkey;
ALTER TABLE rent_payment_schedule
    ADD CONSTRAINT rent_payment_schedule_contract_id_fkey
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;

ALTER TABLE rent_income_schedule DROP CONSTRAINT IF EXISTS rent_income_schedule_contract_id_fkey;
ALTER TABLE rent_income_schedule
    ADD CONSTRAINT rent_income_schedule_contract_id_fkey
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;
