-- 预警配置表（key-value）：电量同比阈值 + 合同到期提前天数
-- 在「基础档案 → 预警设置」中维护
CREATE TABLE IF NOT EXISTS alert_configs (
    key VARCHAR(50) PRIMARY KEY,
    value VARCHAR(200) NOT NULL,
    remark VARCHAR(200),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE alert_configs IS '预警配置（key-value）：电量同比上涨阈值 / 合同到期提前提醒天数';

-- 默认配置
INSERT INTO alert_configs (key, value, remark) VALUES
('elec_yoy_ratio', '1.5', '电量异常预警：本月用电量 ÷ 去年同期 ≥ 该倍数时预警（如 1.5 = 上涨 50%）'),
('contract_expire_days_venue', '30', '场地合同：到期前多少天提醒（含已到期）'),
('contract_expire_days_brand', '30', '品牌方合同：到期前多少天提醒（含已到期）')
ON CONFLICT (key) DO UPDATE SET remark = EXCLUDED.remark;
