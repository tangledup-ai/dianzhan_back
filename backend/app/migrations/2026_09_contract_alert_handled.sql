-- 合同预警「标记已处理」：
-- 点击「已处理」后记录处理时间与当时的预警特征（状态|到期日|逾期期数），
-- 预警特征未变化则不再提醒；出现新的逾期分期或状态变化（如临期→已到期）会再次预警。
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS alert_handled_at TIMESTAMPTZ;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS alert_handled_sig TEXT;
