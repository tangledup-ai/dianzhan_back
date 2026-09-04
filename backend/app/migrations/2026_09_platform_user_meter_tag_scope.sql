-- 平台人员电表类型数据隔离（2026-09）
-- 规则：platform_users.meter_tag_scope 指定财务/财务主管可见的电表类型
--       （合作商电表/民用电表/共享电表）；NULL=不限制。
--       指定后该账号全系统只能看到该类型电表相关的数据：
--       - 电表维度：列表/读数/柜子/抄表明细等只显示该类型电表；
--       - 场地维度：合同/场租/总览等按「场地拥有该类型电表」派生可见场地。

ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS meter_tag_scope VARCHAR(20);

COMMENT ON COLUMN platform_users.meter_tag_scope IS '数据隔离：限定可见的电表类型（合作商电表/民用电表/共享电表）；NULL=不限制（仅对 finance/finance_supervisor 生效）';
