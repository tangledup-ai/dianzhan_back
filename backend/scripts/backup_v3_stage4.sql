-- v3 阶段4 备份：stations 表 + 含 station_id 的表 + v2 旧表（删前保护）
-- 执行：psql -U quant -d huandian_v2 -f backup_v3_stage4.sql
\set ON_ERROR_STOP off

\copy stations TO 'backup_v3_stage4_stations.csv' WITH CSV HEADER
\copy meters TO 'backup_v3_stage4_meters.csv' WITH CSV HEADER
\copy contracts TO 'backup_v3_stage4_contracts.csv' WITH CSV HEADER
\copy electricity_records TO 'backup_v3_stage4_electricity_records.csv' WITH CSV HEADER
\copy operating_expenses TO 'backup_v3_stage4_operating_expenses.csv' WITH CSV HEADER
\copy dividend_records TO 'backup_v3_stage4_dividend_records.csv' WITH CSV HEADER
\copy approval_requests TO 'backup_v3_stage4_approval_requests.csv' WITH CSV HEADER
\copy rent_payment_schedule TO 'backup_v3_stage4_rent_payment_schedule.csv' WITH CSV HEADER
\copy rent_income_schedule TO 'backup_v3_stage4_rent_income_schedule.csv' WITH CSV HEADER
\copy landlord_shareholder_configs TO 'backup_v3_stage4_landlord_shareholder_configs.csv' WITH CSV HEADER
\copy landlord_introducer_configs TO 'backup_v3_stage4_landlord_introducer_configs.csv' WITH CSV HEADER
