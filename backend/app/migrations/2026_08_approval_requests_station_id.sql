-- approval_requests.station_id 补齐
-- 背景：approval_repo.create_request / list_requests / act_on_request（场地费付款联动）
--       都引用 approval_requests.station_id，但 database_init.sql 与历史迁移从未建过该列，
--       仓库脚本无法重建出可用的库（部署/重建必炸）。
-- 幂等：可重复执行。

ALTER TABLE approval_requests
    ADD COLUMN IF NOT EXISTS station_id INTEGER REFERENCES stations(id);

CREATE INDEX IF NOT EXISTS idx_approval_requests_station
    ON approval_requests(station_id);
