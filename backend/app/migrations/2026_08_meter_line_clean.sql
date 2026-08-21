-- ============================================================
-- 2026_08_meter_line_clean.sql
-- ① 智慧电表线 —— 标准表结构（全新安装基准 + 存量库对齐）
--
-- 配套设计文档：METER_LINE_DESIGN.md
-- 依赖：stations / brands / landlords / entities 已存在（database_init.sql 先行）
-- 幂等：可重复执行（CREATE IF NOT EXISTS / ALTER IF NOT EXISTS / DO 块加约束）
-- 说明：
--   1) 对"全新空库"：本文件直接建出电表线全部表（可作为 database_init.sql
--      电表线部分的替代基准，实施轮再替换）。
--   2) 对"已有库"：后半段做非破坏性对齐（补列/清洗/加约束/补索引），
--      破坏性废弃列（year_month / d0 / date）放在最后，核对后手动执行。
-- 执行顺序：备份 → 执行本文件 → 执行「第三部分 核对 SQL」→ 确认 0 异常。
-- 注意：建表顺序按外键依赖排（层 C 档案先于层 B 缓存，因为 meter_devices
--       外键引用 meters；层 B 缓存表之间无外键）。
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 第一部分：全新安装（CREATE TABLE IF NOT EXISTS）
-- ────────────────────────────────────────────────────────────

-- ── 层 A：第三方接入配置 ────────────────────────────────────

CREATE TABLE IF NOT EXISTS third_party_configs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    base_url VARCHAR(200) NOT NULL,
    auth_code VARCHAR(100) NOT NULL,
    meter_tag VARCHAR(20) NOT NULL DEFAULT '合作商电表',
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ── 层 C：业务电表档案（先建，供层 B 外键引用）───────────────

CREATE TABLE IF NOT EXISTS meters (
    id SERIAL PRIMARY KEY,
    station_id INTEGER NOT NULL REFERENCES stations(id),
    brand_id INTEGER REFERENCES brands(id),
    landlord_id INTEGER REFERENCES landlords(id),
    entity_id INTEGER REFERENCES entities(id),
    meter_no VARCHAR(100) NOT NULL UNIQUE,
    meter_name VARCHAR(200),
    collector_id VARCHAR(100),
    transformer_ratio NUMERIC(10,2) NOT NULL DEFAULT 1,
    tag VARCHAR(20) NOT NULL DEFAULT '合作商电表',
    status VARCHAR(20) NOT NULL DEFAULT '正常',
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cabinets (
    id SERIAL PRIMARY KEY,
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    cabinet_no VARCHAR(100),
    cabinet_type VARCHAR(50) DEFAULT '普通柜',
    brand_id INTEGER REFERENCES brands(id),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ── 层 B：第三方数据缓存（同步写入，业务只读）───────────────

CREATE TABLE IF NOT EXISTS meter_devices (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50),
    collector_id VARCHAR(50),
    address VARCHAR(100) UNIQUE NOT NULL,
    description VARCHAR(200),
    rate NUMERIC(10,2),
    meter_id INTEGER REFERENCES meters(id),
    config_id INTEGER REFERENCES third_party_configs(id),
    synced_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meter_collectors (
    id VARCHAR(50) PRIMARY KEY,
    collector_id VARCHAR(50),
    description VARCHAR(200),
    device_count INTEGER DEFAULT 0,
    raw_data JSONB,
    synced_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meter_status_cache (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) UNIQUE NOT NULL,
    address VARCHAR(100),
    c0 NUMERIC(14,2),
    c1 NUMERIC(14,2),
    c2 NUMERIC(14,2),
    c3 NUMERIC(14,2),
    c4 NUMERIC(14,2),
    remain_money NUMERIC(14,2),
    synced_at TIMESTAMP
);

-- 月度读数（电费/分红源头）
CREATE TABLE IF NOT EXISTS meter_monthly (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50),
    address VARCHAR(100) NOT NULL,
    month_period VARCHAR(6) NOT NULL,
    kwh NUMERIC(14,2),
    actual_kwh NUMERIC(14,2),
    prev_reading_date DATE,
    prev_reading NUMERIC(14,2),
    curr_reading_date DATE,
    curr_reading NUMERIC(14,2),
    raw_data JSONB,
    synced_at TIMESTAMP,
    UNIQUE(address, month_period)
);

-- 能耗统计（日/小时/年）
CREATE TABLE IF NOT EXISTS meter_daily (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50),
    address VARCHAR(100) NOT NULL,
    day_date VARCHAR(8) NOT NULL,
    kwh NUMERIC(14,2),
    raw_data JSONB,
    synced_at TIMESTAMP,
    UNIQUE(address, day_date)
);

CREATE TABLE IF NOT EXISTS meter_hourly (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50),
    address VARCHAR(100) NOT NULL,
    hour_time VARCHAR(10) NOT NULL,
    kwh NUMERIC(14,2),
    raw_data JSONB,
    synced_at TIMESTAMP,
    UNIQUE(address, hour_time)
);

CREATE TABLE IF NOT EXISTS meter_yearly (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50),
    address VARCHAR(100) NOT NULL,
    year_period VARCHAR(4) NOT NULL,
    kwh NUMERIC(14,2),
    raw_data JSONB,
    synced_at TIMESTAMP,
    UNIQUE(address, year_period)
);

-- 报警缓存（覆盖式）
CREATE TABLE IF NOT EXISTS meter_warnings_cache (
    id SERIAL PRIMARY KEY,
    device_type INTEGER,
    device_id VARCHAR(50),
    device_address VARCHAR(100),
    warning_def_id INTEGER,
    start_time TIMESTAMP,
    msg TEXT,
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

-- ────────────────────────────────────────────────────────────
-- 第二部分：存量库对齐（非破坏性）
-- ────────────────────────────────────────────────────────────

-- 2.1 meters 补列 + landlord 单源回填（以站点为准，幂等）
ALTER TABLE meters ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS entity_id  INTEGER REFERENCES entities(id);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
UPDATE meters m
SET landlord_id = s.landlord_id
FROM stations s
WHERE m.station_id = s.id
  AND s.landlord_id IS NOT NULL
  AND m.landlord_id IS DISTINCT FROM s.landlord_id;

-- 2.2 meter_monthly 补列（device_id 溯源列 / actual_kwh 手工修正列 / 抄表起止）
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS device_id VARCHAR(50);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS actual_kwh NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_reading_date DATE;
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_reading NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_reading_date DATE;
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_reading NUMERIC(14,2);

-- 2.3 meter_daily 补列
ALTER TABLE meter_daily ADD COLUMN IF NOT EXISTS device_id VARCHAR(50);

-- 2.4 period 统一 6 位 YYYYMM（去横线）
UPDATE meter_monthly SET month_period = REPLACE(month_period, '-', '') WHERE month_period LIKE '%-%';

-- 2.5 meter_monthly 月份格式 CHECK（先清洗后加约束，避免 7 位数据导致失败）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_meter_monthly_period') THEN
        ALTER TABLE meter_monthly ADD CONSTRAINT ck_meter_monthly_period
            CHECK (month_period ~ '^\d{6}$');
    END IF;
END $$;

-- 2.6 能耗表 (address, 周期) 唯一键（存量库旧键是 (device_id, 周期)；
--     后续同步/录读数按 address 冲突更新，必须补此键；
--     仅当数据无重复时才添加，否则留待核对段处理）
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_name = 'meter_daily'
          AND tc.constraint_type = 'UNIQUE'
          AND EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                      WHERE k.constraint_name = tc.constraint_name AND k.column_name = 'address')
          AND EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                      WHERE k.constraint_name = tc.constraint_name AND k.column_name = 'day_date')
    ) AND NOT EXISTS (SELECT 1 FROM meter_daily GROUP BY address, day_date HAVING COUNT(*) > 1) THEN
        ALTER TABLE meter_daily ADD CONSTRAINT uq_meter_daily_addr_period UNIQUE(address, day_date);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_name = 'meter_hourly'
          AND tc.constraint_type = 'UNIQUE'
          AND EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                      WHERE k.constraint_name = tc.constraint_name AND k.column_name = 'address')
          AND EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                      WHERE k.constraint_name = tc.constraint_name AND k.column_name = 'hour_time')
    ) AND NOT EXISTS (SELECT 1 FROM meter_hourly GROUP BY address, hour_time HAVING COUNT(*) > 1) THEN
        ALTER TABLE meter_hourly ADD CONSTRAINT uq_meter_hourly_addr_period UNIQUE(address, hour_time);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_name = 'meter_yearly'
          AND tc.constraint_type = 'UNIQUE'
          AND EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                      WHERE k.constraint_name = tc.constraint_name AND k.column_name = 'address')
          AND EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                      WHERE k.constraint_name = tc.constraint_name AND k.column_name = 'year_period')
    ) AND NOT EXISTS (SELECT 1 FROM meter_yearly GROUP BY address, year_period HAVING COUNT(*) > 1) THEN
        ALTER TABLE meter_yearly ADD CONSTRAINT uq_meter_yearly_addr_period UNIQUE(address, year_period);
    END IF;
END $$;

-- 2.7 索引（辅助查询与同步去重）
CREATE INDEX IF NOT EXISTS idx_meter_monthly_device ON meter_monthly(device_id, month_period);
CREATE INDEX IF NOT EXISTS idx_meters_station   ON meters(station_id);
CREATE INDEX IF NOT EXISTS idx_meters_landlord  ON meters(landlord_id);
CREATE INDEX IF NOT EXISTS idx_meters_brand     ON meters(brand_id);
CREATE INDEX IF NOT EXISTS idx_meters_entity    ON meters(entity_id);
CREATE INDEX IF NOT EXISTS idx_meter_daily_addr ON meter_daily(address, day_date);
CREATE INDEX IF NOT EXISTS idx_meter_hourly_addr ON meter_hourly(address, hour_time);
CREATE INDEX IF NOT EXISTS idx_meter_yearly_addr ON meter_yearly(address, year_period);
CREATE INDEX IF NOT EXISTS idx_meter_warnings_addr ON meter_warnings_cache(device_address, start_time);
CREATE INDEX IF NOT EXISTS idx_cabinets_meter   ON cabinets(meter_id);

-- ────────────────────────────────────────────────────────────
-- 第三部分：核对 SQL（期望全部 0 行/无输出）
-- ────────────────────────────────────────────────────────────

-- 3.1 电表 landlord 与站点不一致（应 0 行）
-- SELECT m.id, m.meter_no FROM meters m
-- JOIN stations s ON m.station_id = s.id
-- WHERE s.landlord_id IS NOT NULL
--   AND m.landlord_id IS DISTINCT FROM s.landlord_id;

-- 3.2 meter_monthly 残留 7 位 period（应 0 行）
-- SELECT id, address, month_period FROM meter_monthly
-- WHERE month_period !~ '^\d{6}$';

-- 3.3 meter_monthly 同 (address, month_period) 重复（应 0 行）
-- SELECT address, month_period, COUNT(*) FROM meter_monthly
-- GROUP BY address, month_period HAVING COUNT(*) > 1;

-- 3.4 meters.meter_no 与 meter_devices.address 未对应（仅提醒，非错误）
-- SELECT d.address, d.description FROM meter_devices d
-- LEFT JOIN meters m ON m.meter_no = d.address
-- WHERE m.id IS NULL;

-- ────────────────────────────────────────────────────────────
-- 第四部分：破坏性废弃列迁移（核对无误后手动执行，先备份！）
-- ────────────────────────────────────────────────────────────

-- 背景：早期 ad-hoc 变更给 meter_monthly 加过 year_month/d0，
--       给 meter_daily 加过 date。本设计统一用 month_period/kwh/day_date，
--       废弃列确认无代码引用后删除（先跑 3.2/3.3 核对）。

-- 4.1 确认 year_month 与 month_period 数据一致（应 0 行不一致）
-- SELECT id FROM meter_monthly
-- WHERE year_month IS NOT NULL AND year_month <> month_period;

-- 4.2 确认 d0 与 kwh 数据一致（应 0 行不一致；NULL 差异可忽略）
-- SELECT id FROM meter_monthly
-- WHERE d0 IS NOT NULL AND kwh IS NOT NULL AND d0 <> kwh;

-- 4.3 删除废弃列（确认 4.1/4.2 通过后执行）
-- ALTER TABLE meter_monthly DROP COLUMN IF EXISTS year_month;
-- ALTER TABLE meter_monthly DROP COLUMN IF EXISTS d0;
-- ALTER TABLE meter_daily   DROP COLUMN IF EXISTS date;
