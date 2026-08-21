-- 迁移脚本：补充小时/日/年用电量表、采集器表、同步日志表

-- 小时用电量
CREATE TABLE IF NOT EXISTS meter_hourly (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    address VARCHAR(100),
    hour_time VARCHAR(10) NOT NULL,
    kwh NUMERIC(14,2),
    raw_data JSONB,
    synced_at TIMESTAMP,
    UNIQUE(device_id, hour_time)
);

-- 日用电量
CREATE TABLE IF NOT EXISTS meter_daily (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    address VARCHAR(100),
    day_date VARCHAR(8) NOT NULL,
    kwh NUMERIC(14,2),
    raw_data JSONB,
    synced_at TIMESTAMP,
    UNIQUE(device_id, day_date)
);

-- 年用电量
CREATE TABLE IF NOT EXISTS meter_yearly (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    address VARCHAR(100),
    year_period VARCHAR(4) NOT NULL,
    kwh NUMERIC(14,2),
    raw_data JSONB,
    synced_at TIMESTAMP,
    UNIQUE(device_id, year_period)
);

-- 采集器
CREATE TABLE IF NOT EXISTS meter_collectors (
    id VARCHAR(50) PRIMARY KEY,
    collector_id VARCHAR(50),
    description VARCHAR(200),
    device_count INTEGER DEFAULT 0,
    raw_data JSONB,
    synced_at TIMESTAMP
);

-- 同步日志
CREATE TABLE IF NOT EXISTS sync_logs (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    records_synced INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);
