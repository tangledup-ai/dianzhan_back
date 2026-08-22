-- 补充审批流程配置：电费付款 / 场地费付款 / 电费+场地费
-- 与现有「分红审批」一致的 3 节点流程（财务提交 → 财务主管审核 → 老板审批）
-- 幂等：biz_type 冲突时更新 nodes

INSERT INTO approval_flows (biz_type, nodes, updated_at) VALUES
('电费付款', '[{"name": "财务提交", "approver": "财务"}, {"name": "财务主管审核", "approver": "财务主管"}, {"name": "老板审批", "approver": "老板"}]', NOW()),
('场地费付款', '[{"name": "财务提交", "approver": "财务"}, {"name": "财务主管审核", "approver": "财务主管"}, {"name": "老板审批", "approver": "老板"}]', NOW()),
('电费+场地费', '[{"name": "财务提交", "approver": "财务"}, {"name": "财务主管审核", "approver": "财务主管"}, {"name": "老板审批", "approver": "老板"}]', NOW())
ON CONFLICT (biz_type) DO UPDATE SET nodes = EXCLUDED.nodes, updated_at = NOW();
