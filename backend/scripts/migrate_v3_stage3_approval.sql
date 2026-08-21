-- v3 阶段3：审批单挂场地（landlord_id），电费/场地费审批按场地联动
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id);

CREATE INDEX IF NOT EXISTS idx_approval_requests_landlord ON approval_requests(landlord_id);
