-- 修复「改名断链」相关的数据残留
-- 1) contracts.station_name 是 landlord 名的冗余快照，历史数据被前端写成了字符串 'None'，
--    统一置 NULL（Rent 页有 landlord_id 兜底匹配）。
-- 2) 该列语义 = landlord 名（合同挂场地方一级）；landlord 改名时由代码同步（见 directory_repo.update_landlord）。
-- 幂等：可重复执行。

UPDATE contracts SET station_name = NULL WHERE station_name = 'None';
