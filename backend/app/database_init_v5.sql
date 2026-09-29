-- ============================================================
-- huandian_v5 —— 智慧电表域 V5 全量建库脚本
-- ============================================================
-- 依据：METER_DOMAIN_V5.md（业务口径基线） + METER_DOMAIN_V5_SCHEMA.md（表结构方案 v1）
-- 生成日期：2026-09-26
--
-- 用途：在【全新空库】上一次建齐 44 张表 + 视图 + 字典初值。
--
-- 与 database_init.sql（V4/现状）的差异总览：
--   ① 新增 9 张表：meter_categories / meter_shared_brand_bindings / landlord_monthly_elec /
--      cabinet_monthly_snapshot / rent_records / period_closings / correction_logs / deposits
--      （另含视图若干）
--   ② 表名变更：meter_monthly → meter_readings
--   ③ 关联键：meter_monthly.address / meter_shared_allocations.address → meter_id 外键
--   ④ meters：新增 category_code / is_shared / device_address / initial_reading / 生命周期
--   ⑤ cabinets：加回 brand_id + 加进/离场日期
--   ⑥ 台账：electricity_records 加 row_type / meter_category，唯一键含 row_type
--   ⑦ contracts：加 previous_contract_id + 生效期排他约束
--   ⑧ 分摊表：加 collect_kwh / input_mode / rent_share / 读数快照
--
-- 过渡策略（重要）：
--   V4 里被标 DEPRECATED 的列**暂时保留**（meters.tag / contracts.partner /
--   contracts.cabinets_count / contracts.pay_status），只加注释不再写入，
--   便于后端逐模块适配；全部适配完成后再执行迁移脚本末尾的「收尾删除」段。
--
-- 执行：psql -h 127.0.0.1 -U quant -d huandian_v5 -f database_init_v5.sql
-- 幂等：CREATE ... IF NOT EXISTS；可重复执行。
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ════════════════════════════════════════════════════════════
-- §1  档案域
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS brands (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    contact VARCHAR(100),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE brands IS '品牌方（客户/收入来源，如美团/哈啰/青桔）';

CREATE TABLE IF NOT EXISTS entities (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL UNIQUE,
    short_name VARCHAR(50),
    tax_no VARCHAR(50),
    taxpayer_type VARCHAR(20),
    invoice_bank VARCHAR(200),
    invoice_account VARCHAR(100),
    invoice_address VARCHAR(300),
    invoice_phone VARCHAR(50),
    status VARCHAR(20) DEFAULT '启用',
    sort INTEGER DEFAULT 0,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE entities IS '公司主体（报税法人）—— ★V5：主体只用于【收入报税】，成本不归主体';

CREATE TABLE IF NOT EXISTS landlords (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL UNIQUE,
    contact VARCHAR(100),
    phone VARCHAR(50),
    region VARCHAR(50),
    address VARCHAR(300),
    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE landlords IS '场地方（业主，主链聚合根）';

CREATE TABLE IF NOT EXISTS landlord_owners (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
    owner_name VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    start_date DATE,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_landlord_owners_landlord ON landlord_owners (landlord_id);

CREATE TABLE IF NOT EXISTS shareholders (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE shareholders IS '股东（投资人，分红受益人之一）';

CREATE TABLE IF NOT EXISTS introducers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE introducers IS '介绍人（商务关系人，商务分红受益人）';

CREATE TABLE IF NOT EXISTS entity_brands (
    id SERIAL PRIMARY KEY,
    entity_id INTEGER NOT NULL REFERENCES entities(id),
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(entity_id, brand_id)
);
COMMENT ON TABLE entity_brands IS '公司主体-品牌方 归属关系（多对多）';

CREATE TABLE IF NOT EXISTS platform_users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    role VARCHAR(50),
    shareholder_id INTEGER REFERENCES shareholders(id),
    password VARCHAR(200),
    landlord_ids INTEGER[],
    meter_tag_scope VARCHAR(20),
    meter_category_scope VARCHAR(24),   -- ★V5：按电表大类（= 财务分工）限定可见范围
    phone VARCHAR(50),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE platform_users IS '平台用户（RBAC：boss/finance/finance_supervisor/shareholder）';
COMMENT ON COLUMN platform_users.meter_category_scope IS '★V5：数据隔离——限定可见的电表大类（一个财务管一个大类）；NULL=不限制';
COMMENT ON COLUMN platform_users.landlord_ids IS '股东可见场地范围；★V5：股东只能看与自己相关的数据（同场地其他股东的数据不可见）';

-- ════════════════════════════════════════════════════════════
-- §2  电表档案域（V5 核心）
-- ════════════════════════════════════════════════════════════

-- 2.1 电表大类字典：★ 只是"分给哪个财务管"的职责分组标签，不含任何算法开关
CREATE TABLE IF NOT EXISTS meter_categories (
    code        VARCHAR(24) PRIMARY KEY,
    name        VARCHAR(50) NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    remark      TEXT
);
COMMENT ON TABLE meter_categories IS '★V5 新增：电表大类字典（合作商电表/民用电表/共享电表/…）。只是分类标签，与"是否所有品牌共用一个表"【完全无关】';
INSERT INTO meter_categories (code, name, sort_order, remark) VALUES
    ('partner', '合作商电表', 10, '换电业务合作商'),
    ('shared',  '共享电表',   20, '★只是分类名，不代表"所有品牌共用一个表"'),
    ('civil',   '民用电表',   30, '民用/办公用电，计入成本、无品牌收款对象')
ON CONFLICT (code) DO NOTHING;

-- 2.2 电表主表
CREATE TABLE IF NOT EXISTS meters (
    id              SERIAL PRIMARY KEY,
    meter_no        VARCHAR(100) NOT NULL UNIQUE,     -- 业务编号，人工可改（给人看）
    meter_name      VARCHAR(200),

    -- 归属
    landlord_id     INTEGER REFERENCES landlords(id) ON DELETE RESTRICT,
    brand_id        INTEGER REFERENCES brands(id) ON DELETE RESTRICT,
        -- 非空 = 普通电表且归属某品牌；空 = 无品牌（民用电表）或共享表（品牌靠绑定清单，见 2.5）
    entity_id       INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    entity_source   VARCHAR(10) DEFAULT 'manual' CHECK (entity_source IN ('auto','manual')),

    -- 分类与属性
    category_code   VARCHAR(24) NOT NULL DEFAULT 'partner' REFERENCES meter_categories(code) ON DELETE RESTRICT,
    is_shared       BOOLEAN NOT NULL DEFAULT FALSE,
        -- ★V5：TRUE = 所有品牌共用一个表（人工勾选，不由大类推导）
    status          VARCHAR(16) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','inactive','removed')),

    -- 计量
    transformer_ratio NUMERIC(10,2) NOT NULL DEFAULT 1,
    initial_reading   NUMERIC(14,2),                  -- 投运起始表码（换表=新建 ⇒ 必需）

    -- 设备对接（★V5：业务编号与设备地址解耦）
    device_address  VARCHAR(100),                     -- 第三方设备地址（建立后不再变）
    device_id       VARCHAR(100),
    collector_id    VARCHAR(100),
    third_party_config_id INTEGER,   -- FK 在 §3 建完 third_party_configs 后补（避免建表顺序依赖）
    data_source     VARCHAR(16) NOT NULL DEFAULT 'manual'
                    CHECK (data_source IN ('auto','manual')),  -- auto=接第三方 / manual=自建手工

    -- 生命周期
    installed_at    DATE,
    removed_at      DATE,
    remark          TEXT,
    updated_by      INTEGER,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),

    CONSTRAINT ck_meter_removed CHECK (
        (status = 'removed' AND removed_at IS NOT NULL)
        OR (status <> 'removed' AND removed_at IS NULL)
    ),
    -- 遗留列（★V5 DEPRECATED：不再写入，待收尾删除）
    tag             VARCHAR(20)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_meters_device_address
    ON meters (device_address) WHERE device_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meters_landlord  ON meters (landlord_id, category_code);
CREATE INDEX IF NOT EXISTS idx_meters_brand     ON meters (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meters_shared    ON meters (is_shared) WHERE is_shared = TRUE;
COMMENT ON TABLE  meters IS '电表档案（业务计算唯一入口）';
COMMENT ON COLUMN meters.meter_no IS '业务编号：人工可编（如"学府路001"），可随时改';
COMMENT ON COLUMN meters.device_address IS '★V5：第三方设备地址，建立后不变（与 meter_no 解耦，防止改编号导致读数失联）';
COMMENT ON COLUMN meters.is_shared IS '★V5：是否"所有品牌共用一个表"（人工勾选；与 category_code 正交，不可互相推导）';
COMMENT ON COLUMN meters.category_code IS '★V5：电表大类（= 哪个财务负责的品类），替代旧 tag';
COMMENT ON COLUMN meters.tag IS 'DEPRECATED(V5)：被 category_code 取代，保留仅为过渡';
COMMENT ON COLUMN meters.transformer_ratio IS '互感器倍数：实际用电量 = 表码度数 × 倍数';
COMMENT ON COLUMN meters.initial_reading IS '投运起始表码（换表 = 新建一块表，新表必须给起始码）';

-- 2.3 柜子（★V5：加回品牌维度 + 生命周期）
CREATE TABLE IF NOT EXISTS cabinets (
    id           SERIAL PRIMARY KEY,
    meter_id     INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    cabinet_no   VARCHAR(100),
    cabinet_type VARCHAR(50) DEFAULT '普通柜',
    brand_id     INTEGER REFERENCES brands(id) ON DELETE RESTRICT,
        -- ★V5 加回：共享表(brand_id 为空)下的柜子必须靠它表达品牌
    installed_at DATE,      -- ★V5：进场日期（加柜本月生效）
    removed_at   DATE,      -- ★V5：离场日期（减柜下月生效）
    data_source  VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (data_source IN ('auto','manual')),
    remark       TEXT,
    updated_by   INTEGER,
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cabinets_meter_brand ON cabinets (meter_id, brand_id);
CREATE INDEX IF NOT EXISTS idx_cabinets_landlord    ON cabinets (meter_id, installed_at, removed_at);
COMMENT ON TABLE cabinets IS '柜子（物理资产，挂电表下）；★V5：柜数只影响"场地费平摊成本"这一个值';
COMMENT ON COLUMN cabinets.installed_at IS '★V5：进场日期——加柜【本月生效】';
COMMENT ON COLUMN cabinets.removed_at  IS '★V5：离场日期——减柜【下月生效】；同月"加了又退"仍按加了算';
COMMENT ON COLUMN cabinets.brand_id IS '★V5 加回：品牌归属；无品牌归属的柜子【不参与】平摊分母';

-- 2.4 电表换主体审计
CREATE TABLE IF NOT EXISTS meter_entity_changes (
    id SERIAL PRIMARY KEY,
    meter_id INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    meter_no VARCHAR(100),
    from_entity_id INTEGER REFERENCES entities(id),
    to_entity_id   INTEGER REFERENCES entities(id),
    effective_period VARCHAR(6),          -- ★V5：生效月（生效月之前的历史留旧主体）
    operator VARCHAR(64),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meter_entity_changes_meter ON meter_entity_changes (meter_id, created_at DESC);
COMMENT ON TABLE meter_entity_changes IS '电表换主体审计；★V5：带生效月——生效月【之前】的历史台账留旧主体，生效月起归新主体';

-- 2.5 共享表的品牌绑定清单（★V5 新增）
CREATE TABLE IF NOT EXISTS meter_shared_brand_bindings (
    id           SERIAL PRIMARY KEY,
    meter_id     INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    brand_id     INTEGER NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    start_period CHAR(6) NOT NULL,        -- 从哪个月起（变动【当月生效】）
    end_period   CHAR(6),                 -- 到哪个月止（空 = 仍有效 ⇒ 没手动改就自动沿袭上月）
    remark       TEXT,
    data_source  VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (data_source IN ('auto','manual')),
    updated_by   INTEGER,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ck_shared_binding_period CHECK (end_period IS NULL OR end_period >= start_period),
    CONSTRAINT ux_shared_brand UNIQUE (meter_id, brand_id, start_period)
);
CREATE INDEX IF NOT EXISTS idx_shared_brand_lookup
    ON meter_shared_brand_bindings (meter_id, start_period, end_period);
COMMENT ON TABLE meter_shared_brand_bindings IS
'★V5 新增：共享表(所有品牌共用一个电表)的品牌绑定清单，人工维护。
 动态月度 + 默认沿袭上月（用生效期表达）+ 变动当月生效 + 历史可复现。
 未绑定的品牌【不参与分摊】；已绑定但某月漏录分摊 ⇒ 告警，不自动补。
 同一品牌【不会】同时绑同一场地的两块共享表。';

-- ════════════════════════════════════════════════════════════
-- §3  第三方接入域（缓存，不参与算账）
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS third_party_configs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    base_url VARCHAR(200) NOT NULL,
    auth_code VARCHAR(100) NOT NULL,
    meter_tag VARCHAR(20) NOT NULL DEFAULT '合作商电表',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,       -- ★V5：账户可停用/启用
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE third_party_configs IS '第三方（天雀）接口账户配置：同步任务遍历本表逐账户拉取';
COMMENT ON COLUMN third_party_configs.meter_tag IS '★V5：保留但不参与任何分类推导——【账户推不出电表大类/是否共享】，一律人工选';
COMMENT ON COLUMN third_party_configs.is_active IS '★V5：可停用/启用';

-- 补齐 meters.third_party_config_id 的外键（建表顺序解耦）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meters_third_party_config') THEN
        ALTER TABLE meters ADD CONSTRAINT fk_meters_third_party_config
            FOREIGN KEY (third_party_config_id) REFERENCES third_party_configs(id) ON DELETE SET NULL;
    END IF;
END $$;

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
COMMENT ON TABLE meter_devices IS '第三方设备快照；address = meters.device_address；rate = 互感器倍率';

CREATE TABLE IF NOT EXISTS meter_collectors (
    id VARCHAR(50) PRIMARY KEY,
    collector_id VARCHAR(50),
    description VARCHAR(200),
    device_count INTEGER DEFAULT 0,
    raw_data JSONB,
    synced_at TIMESTAMP
);
COMMENT ON TABLE meter_collectors IS '采集器快照（第三方）；只做展示，不参与算账（但是读数的来源）';

CREATE TABLE IF NOT EXISTS meter_status_cache (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) UNIQUE NOT NULL,
    address VARCHAR(100),
    c0 NUMERIC(14,2), c1 NUMERIC(14,2), c2 NUMERIC(14,2), c3 NUMERIC(14,2), c4 NUMERIC(14,2),
    remain_money NUMERIC(14,2),
    synced_at TIMESTAMP
);
COMMENT ON TABLE meter_status_cache IS '实时状态缓存（覆盖式）；c0=总电量，c1~c4=峰尖平谷';

-- 3.1 月度读数（原 meter_monthly，★V5 改名 + 关联键改 meter_id + 倍数快照）
CREATE TABLE IF NOT EXISTS meter_readings (
    id           SERIAL PRIMARY KEY,
    meter_id     INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    period       CHAR(6) NOT NULL,                 -- YYYYMM（自然月）
    device_address VARCHAR(100),                   -- 冗余：同步用，不参与关联
    device_id    VARCHAR(50),

    -- 第三方（平台）值：同步【照写刷新】
    kwh              NUMERIC(14,2),                -- 原始表码度数（未乘倍数）
    prev_reading     NUMERIC(14,2),
    curr_reading     NUMERIC(14,2),
    prev_reading_date DATE,
    curr_reading_date DATE,
    raw_data     JSONB,

    -- 人工（实际）值：★同步【永不覆盖】，算账【永远优先取它】
    actual_kwh             NUMERIC(14,2),          -- ★V5：人工值的唯一口径（录表码时系统算差写入）
    actual_start_date      DATE,                   -- 抄表起止日期：财务可改，改完本月重算（归属月不变）
    actual_end_date        DATE,

    transformer_ratio_snapshot NUMERIC(10,2),      -- ★V5：倍数快照（换倍数不改历史）
    data_source  VARCHAR(16) NOT NULL DEFAULT 'auto' CHECK (data_source IN ('auto','manual')),
    updated_by   INTEGER,
    synced_at    TIMESTAMP,
    remark       TEXT,
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW(),

    -- 遗留列（★V5 DEPRECATED：人工值统一到 actual_kwh，此二列保留仅为过渡）
    prev_actual_reading NUMERIC(14,2),
    curr_actual_reading NUMERIC(14,2),
    month_period VARCHAR(6),
    address      VARCHAR(100),

    CONSTRAINT ux_readings_meter_period UNIQUE (meter_id, period)
);
CREATE INDEX IF NOT EXISTS idx_readings_period ON meter_readings (period);
COMMENT ON TABLE meter_readings IS '月度读数（电费/分红源头）；★V5：(address,period) 唯一键改为 (meter_id,period)';
COMMENT ON COLUMN meter_readings.kwh IS '第三方原始表码度数（同步照写刷新）';
COMMENT ON COLUMN meter_readings.actual_kwh IS '★V5 人工实际用电量（同步不覆盖，算账优先取）；录表码时系统算出差写入本列';
COMMENT ON COLUMN meter_readings.transformer_ratio_snapshot IS '★V5 倍数快照：换互感器倍数不影响历史月份';

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
COMMENT ON TABLE meter_daily IS '日能耗（原始表码度数）；只做展示，不参与算账';

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
COMMENT ON TABLE meter_hourly IS '小时能耗；只做展示，不参与算账';

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
COMMENT ON TABLE meter_yearly IS '年能耗；只做展示，不参与算账';

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
COMMENT ON TABLE meter_warnings_cache IS '报警缓存（覆盖式）';

CREATE TABLE IF NOT EXISTS sync_logs (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    records_synced INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);
COMMENT ON TABLE sync_logs IS '第三方同步日志（审计）';

-- ════════════════════════════════════════════════════════════
-- §4  合同域
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS contracts (
    id SERIAL PRIMARY KEY,
    -- 关联组
    landlord_id INTEGER NOT NULL REFERENCES landlords(id),
    brand_id    INTEGER REFERENCES brands(id),
    entity_id   INTEGER REFERENCES entities(id),
    -- 类型组
    contract_type VARCHAR(20) NOT NULL DEFAULT '场地合同'
                  CHECK (contract_type IN ('场地合同','品牌方合同')),
    data_source VARCHAR(20) NOT NULL DEFAULT 'manual',
    -- 电费组
    electricity_price NUMERIC(8,4),
    tax_enabled BOOLEAN DEFAULT FALSE,
    tax_rate NUMERIC(6,4) DEFAULT 0.01,
    post_tax_electricity_price NUMERIC(8,4),
    -- 租金组
    rent_calc_method VARCHAR(20) DEFAULT '固定价格'
                     CHECK (rent_calc_method IN ('固定价格','按柜子数量')),
    unit_monthly_rent NUMERIC(10,2),   -- 单柜月租（按柜数计租时）
    monthly_rent NUMERIC(12,2),        -- 月租（场地合同=付业主；品牌方合同=品牌方应付）
    rent_amount  NUMERIC(12,2),        -- 年费（品牌方合同常用：年费 ÷ 12 = 月费）
    input_cost   NUMERIC(12,2),
    first_month_rent NUMERIC(12,2),
    rent_refund  NUMERIC(12,2),
    early_end_date DATE,               -- ★提前退租终止日
    deposit NUMERIC(12,2),             -- DEPRECATED(V5)：改用 deposits 表
    deposit_refund_amount NUMERIC(12,2),
    deposit_refund_date DATE,
    deposit_refund_approval_id INTEGER,
    -- 期次/付款组
    pay_method VARCHAR(50),
    rent_advance_days INTEGER NOT NULL DEFAULT 0,
    invoice_required BOOLEAN DEFAULT FALSE,        -- ★V5：是否开票
    invoice_done     BOOLEAN DEFAULT FALSE,        -- ★V5：是否开票成功（人工切换）
    -- 租金税组
    rent_tax_enabled BOOLEAN DEFAULT FALSE,
    rent_tax_rate NUMERIC(6,4),
    post_tax_rent_price NUMERIC(8,4),
    -- 合同承接（★V5 新增）
    previous_contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
    -- 预警处理
    alert_handled_at TIMESTAMPTZ,
    alert_handled_sig TEXT,
    -- 期限
    start_date DATE,
    end_date   DATE,
    -- 位置/审计
    region VARCHAR(50),
    address VARCHAR(300),
    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),
    remark TEXT,
    updated_by INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    -- 遗留列（★V5 DEPRECATED，保留仅为过渡后删除）
    partner VARCHAR(150),
    cabinets_count NUMERIC(8,2),
    pay_status VARCHAR(20) DEFAULT '未付款',
    auto_split BOOLEAN DEFAULT TRUE,

    -- 业务校验：品牌方合同必须挂品牌
    CONSTRAINT ck_contract_brand CHECK (contract_type <> '品牌方合同' OR brand_id IS NOT NULL),
    CONSTRAINT ck_contract_period CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_contracts_prev ON contracts (previous_contract_id);
CREATE INDEX IF NOT EXISTS idx_contracts_landlord ON contracts (landlord_id, contract_type);
COMMENT ON TABLE contracts IS '合同台账：场地合同=成本（公司付业主）/ 品牌方合同=收入（品牌方付公司）';
COMMENT ON COLUMN contracts.previous_contract_id IS '★V5：合同承接指针——调价/续签 = 新建一份 + 指向上一份';
COMMENT ON COLUMN contracts.partner IS 'DEPRECATED(V5)：无用列，收尾删除';
COMMENT ON COLUMN contracts.cabinets_count IS 'DEPRECATED(V5)：计费柜数唯一源 = 实时/快照统计';
COMMENT ON COLUMN contracts.pay_status IS 'DEPRECATED(V5)：业务读分期推导值';
COMMENT ON COLUMN contracts.invoice_required IS '★V5：是否开票';
COMMENT ON COLUMN contracts.invoice_done IS '★V5：是否开票成功（人工切换）；"是否开票"与"是否到账"是两件独立的事';

-- ★V5 新增：同场地 + 同品牌，生效期不得重叠（防止调价出现两份同时生效）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ex_contract_no_overlap') THEN
        ALTER TABLE contracts ADD CONSTRAINT ex_contract_no_overlap
        EXCLUDE USING gist (
            landlord_id WITH =,
            COALESCE(brand_id, 0) WITH =,
            daterange(COALESCE(start_date, DATE '1970-01-01'),
                      COALESCE(early_end_date, end_date, DATE '9999-12-31'), '[]') WITH &&
        );
    END IF;
END $$;
COMMENT ON CONSTRAINT ex_contract_no_overlap ON contracts IS
'★V5：同一场地 + 同一品牌，合同生效期不得重叠（含 early_end_date 提前终止）';

CREATE TABLE IF NOT EXISTS contract_audit_log (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL,
    action VARCHAR(16) NOT NULL,
    changes JSONB,
    operator VARCHAR(64),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_audit_contract ON contract_audit_log (contract_id, created_at DESC);
COMMENT ON TABLE contract_audit_log IS '合同变更审计：action=create/update/delete';

-- 4.1 付款分期（现金流：我方向场地方付）
CREATE TABLE IF NOT EXISTS rent_payment_schedule (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    period CHAR(6),                    -- ★V5：归属月
    period_start DATE, period_end DATE,
    amount NUMERIC(12,2),              -- 系统建议额
    actual_amount NUMERIC(12,2),       -- ★V5：实付额（手动调价落这里）
    actual_date DATE,                  -- ★V5：实付日期
    status VARCHAR(20) DEFAULT '未付款',
    pay_date DATE,
    invoice VARCHAR(200),
    data_source VARCHAR(16) DEFAULT 'auto',
    updated_by INTEGER,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(contract_id, seq)
);
COMMENT ON TABLE rent_payment_schedule IS '付款分期（场地合同：公司付给场地方）——管【现金流】；应计由台账/场地级月度表承担';

-- 4.2 收款分期（现金流：品牌方向我方付）
CREATE TABLE IF NOT EXISTS rent_income_schedule (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    period CHAR(6),                    -- ★V5：归属月
    period_start DATE, period_end DATE,
    amount NUMERIC(12,2),              -- 系统建议额
    actual_amount NUMERIC(12,2),       -- ★V5：实收额
    actual_date DATE,
    status VARCHAR(20) DEFAULT '未到账',
    pay_date DATE,
    invoice VARCHAR(200),
    data_source VARCHAR(16) DEFAULT 'auto',
    updated_by INTEGER,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(contract_id, seq)
);
COMMENT ON TABLE rent_income_schedule IS '收款分期（品牌方合同：品牌方付给公司）——管【现金流】';

-- ════════════════════════════════════════════════════════════
-- §5  电费业务域
-- ════════════════════════════════════════════════════════════

-- 5.1 共享表品牌分摊（只服务 is_shared = TRUE 的表）
CREATE TABLE IF NOT EXISTS meter_shared_allocations (
    id             SERIAL PRIMARY KEY,
    meter_id       INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    month_period   CHAR(6) NOT NULL,
    brand_id       INTEGER NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    entity_id      INTEGER REFERENCES entities(id) ON DELETE SET NULL,   -- 只用于收入报税

    -- 录入：二选一，另一个按单价推导
    input_mode     VARCHAR(10) NOT NULL DEFAULT 'amount'
                   CHECK (input_mode IN ('amount','kwh')),
    collect_amount NUMERIC(14,2),        -- ★V5 改为可空（可只录电量）
    collect_kwh    NUMERIC(14,2),        -- ★V5 新增：现状没有这一列，双向录入物理上做不到
    unit_price     NUMERIC(8,4),         -- 人工覆盖价；空 = 取该品牌该月生效的品牌方合同价

    -- 成本分摊
    rent_share     NUMERIC(14,2),        -- ★V5 新增：该品牌分摊到的场地费成本
    cabinet_count  INTEGER,              -- 该品牌当月在这块共享表下的柜数（人工录，逐月可变）

    -- 读数快照（历史可复现）
    meter_kwh           NUMERIC(14,2),   -- 当月整表电量
    reading_start_date  DATE,
    reading_end_date    DATE,

    data_source    VARCHAR(16) DEFAULT 'auto',
    updated_by     INTEGER,
    remark         TEXT,
    created_at     TIMESTAMP DEFAULT NOW(),
    updated_at     TIMESTAMP DEFAULT NOW(),

    -- 遗留列（★V5 DEPRECATED）
    address        VARCHAR(100),

    CONSTRAINT ux_shared_alloc UNIQUE (meter_id, month_period, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_period ON meter_shared_allocations (month_period);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_meter  ON meter_shared_allocations (meter_id);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_brand  ON meter_shared_allocations (brand_id);
COMMENT ON TABLE meter_shared_allocations IS
'共享表的品牌分摊行（电表 × 月份 × 品牌）。只服务 is_shared = TRUE 的表；普通表永不写本表。
 双向录入：input_mode=amount ⇒ collect_kwh = collect_amount ÷ unit_price；
           input_mode=kwh    ⇒ collect_amount = collect_kwh × unit_price。';
COMMENT ON COLUMN meter_shared_allocations.rent_share IS '★V5：该品牌分摊到的场地费成本 = 场地月租 × 本品牌柜数 ÷ 场地品牌总柜数';

-- 5.2 场地级月度电费（★V5 新增：损耗的唯一载体）
CREATE TABLE IF NOT EXISTS landlord_monthly_elec (
    id           SERIAL PRIMARY KEY,
    landlord_id  INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    period       CHAR(6) NOT NULL,
    ref_kwh      NUMERIC(14,2),      -- 系统算：Σ场地内所有表的实际用电量
    final_kwh    NUMERIC(14,2),      -- 财务填：最终付给场地方老板的电量（默认 = ref_kwh）
    final_amount NUMERIC(14,2),      -- 财务可直接填金额（账单只给钱不给度数时）
    unit_price   NUMERIC(8,4),       -- 场地合同电费单价（快照，便于历史复现）
    loss_kwh     NUMERIC(14,2),      -- ★损耗电量 = final_kwh − ref_kwh
    loss_amount  NUMERIC(14,2),      -- ★损耗金额 = loss_kwh × unit_price
    data_source  VARCHAR(16) DEFAULT 'auto' CHECK (data_source IN ('auto','manual')),
    updated_by   INTEGER,
    remark       TEXT,
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW(),
    CONSTRAINT ux_landlord_month_elec UNIQUE (landlord_id, period)
);
COMMENT ON TABLE landlord_monthly_elec IS
'★V5 新增：场地级月度电费。参考值 = Σ场地内所有表实际用电量 × 场地单价；
 最终值由财务填（默认 = 参考值，因智慧电表读数常有损耗）；
 ★损耗 = 最终付给场地方的电量 − Σ场地内所有表的实际用电量 → 我方承担、单独列示，不摊给品牌。';
COMMENT ON COLUMN landlord_monthly_elec.loss_amount IS '★损耗金额（我方承担；不归任何主体；不摊给品牌）';

-- 5.3 柜数月度快照（★V5 新增）
CREATE TABLE IF NOT EXISTS cabinet_monthly_snapshot (
    id            SERIAL PRIMARY KEY,
    period        CHAR(6) NOT NULL,
    landlord_id   INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    meter_id      INTEGER REFERENCES meters(id) ON DELETE CASCADE,
    brand_id      INTEGER REFERENCES brands(id) ON DELETE RESTRICT,
        -- 空 = 无品牌归属（【不进】平摊分母）
    cabinet_count INTEGER NOT NULL DEFAULT 0,
    source        VARCHAR(16) NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
    updated_by    INTEGER,
    remark        TEXT
);
-- 唯一键含表达式 ⇒ 必须用唯一索引（表级 UNIQUE 约束不支持表达式）
CREATE UNIQUE INDEX IF NOT EXISTS ux_cabinet_month
    ON cabinet_monthly_snapshot (period, meter_id, COALESCE(brand_id, 0));
CREATE INDEX IF NOT EXISTS idx_cabinet_month_landlord ON cabinet_monthly_snapshot (landlord_id, period);
COMMENT ON TABLE cabinet_monthly_snapshot IS
'★V5 新增：柜数月度快照。规则：加柜【本月生效】/ 减柜【下月生效】/ 同月加了又退仍按加了算
 （= 柜子 [installed_at, removed_at] 与当月区间【相交】即计入）。
 柜数【只影响场地费平摊成本】这一个值；没手动改默认沿袭上月。';

-- 5.4 电费台账（快照）
CREATE TABLE IF NOT EXISTS electricity_records (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id),
    brand_id    INTEGER REFERENCES brands(id),
    entity_id   INTEGER REFERENCES entities(id),          -- ★只对【收入】有意义
    period      CHAR(6) NOT NULL,
    row_type    VARCHAR(12) NOT NULL DEFAULT 'normal'
                CHECK (row_type IN ('normal','civil','loss')),
        -- ★V5：normal=普通表行 / civil=民用电表行 / loss=损耗行
        -- 不加这一列：损耗行(brand/entity 都空)会与民用表行【撞唯一键】，物理上无法共存
    meter_category VARCHAR(24) REFERENCES meter_categories(code) ON DELETE SET NULL,
        -- ★V5：电表大类（供"按大类筛选"）

    -- 付款侧（我方付场地方）
    pay_start_date DATE, pay_start_reading NUMERIC(14,2),
    pay_end_date   DATE, pay_end_reading   NUMERIC(14,2),
    pay_kwh        NUMERIC(14,2),
    pay_unit_price NUMERIC(8,4),
    pay_amount     NUMERIC(14,2),
    pay_status     VARCHAR(20) DEFAULT '未付款',

    -- 收款侧（向品牌收）
    collect_start_date DATE, collect_start_reading NUMERIC(14,2),
    collect_end_date   DATE, collect_end_reading   NUMERIC(14,2),
    collect_kwh        NUMERIC(14,2),
    collect_unit_price NUMERIC(8,4),
    collect_amount     NUMERIC(14,2),
    tax_rate           NUMERIC(5,4),
    collect_net        NUMERIC(14,2),
    collect_status     VARCHAR(20) DEFAULT '未到账',

    profit NUMERIC(14,2),
    data_source VARCHAR(16) DEFAULT 'auto',
    updated_by INTEGER,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_elec_records_group
    ON electricity_records (landlord_id, COALESCE(brand_id, 0), COALESCE(entity_id, 0), period, row_type);
CREATE INDEX IF NOT EXISTS idx_elec_records_entity   ON electricity_records (entity_id);
CREATE INDEX IF NOT EXISTS idx_elec_records_category ON electricity_records (period, meter_category);
COMMENT ON TABLE electricity_records IS
'电费月台账（快照）；★V5：唯一键加入 row_type，让"损耗行"与"民用表行"可以共存；成本侧不按主体拆分。';
COMMENT ON COLUMN electricity_records.entity_id IS '★V5：只用于【收入报税】；成本不归主体';
COMMENT ON COLUMN electricity_records.row_type IS '★V5：normal/civil/loss——区分"民用表行"与"损耗行"（两者 brand_id 都为空）';
COMMENT ON COLUMN electricity_records.meter_category IS '★V5：电表大类，供报表按大类筛选';

CREATE TABLE IF NOT EXISTS electricity_meter_details (
    id SERIAL PRIMARY KEY,
    electricity_id INTEGER NOT NULL REFERENCES electricity_records(id) ON DELETE CASCADE,
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    shared_alloc_id INTEGER REFERENCES meter_shared_allocations(id) ON DELETE SET NULL,  -- ★V5
    row_type VARCHAR(12) DEFAULT 'normal',
    start_reading NUMERIC(14,2),
    end_reading NUMERIC(14,2),
    kwh NUMERIC(14,2),
    pay_unit_price NUMERIC(8,4),
    pay_amount NUMERIC(14,2),
    collect_unit_price NUMERIC(8,4),
    collect_amount NUMERIC(14,2),
    collect_net NUMERIC(14,2)
);
COMMENT ON TABLE electricity_meter_details IS '电费分表明细（与台账同源写入，明细合计 = 台账合计）——"费用绑电表"的载体';

-- 5.5 场租台账（★V5 新增，与 electricity_records 对称）
CREATE TABLE IF NOT EXISTS rent_records (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    brand_id    INTEGER REFERENCES brands(id),
    entity_id   INTEGER REFERENCES entities(id),        -- ★只对【收入】有意义
    period      CHAR(6) NOT NULL,
    row_type    VARCHAR(12) NOT NULL DEFAULT 'normal'
                CHECK (row_type IN ('normal','loss')),

    -- 成本侧（我方付场地方）
    pay_cabinet_count INTEGER,
    pay_days          INTEGER,
    pay_unit_price    NUMERIC(10,2),
    pay_amount        NUMERIC(14,2),
    pay_status        VARCHAR(20) DEFAULT '未付款',

    -- 收入侧（向品牌收）
    collect_cabinet_count INTEGER,
    collect_days          INTEGER,
    collect_unit_price    NUMERIC(10,2),
    collect_amount        NUMERIC(14,2),
    collect_tax_rate      NUMERIC(6,4),
    collect_net           NUMERIC(14,2),
    collect_status        VARCHAR(20) DEFAULT '未到账',

    profit NUMERIC(14,2),
    data_source VARCHAR(16) DEFAULT 'auto',
    updated_by INTEGER,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rent_records_group
    ON rent_records (landlord_id, COALESCE(brand_id, 0), COALESCE(entity_id, 0), period, row_type);
COMMENT ON TABLE rent_records IS
'★V5 新增：场地场租台账（快照）。结构对称于 electricity_records ⇒ 两张表在报表层合并出「合计总利润」。
 满月按整月；首月/末月按天折算（日历天，含头含尾）或财务直接填。';

-- 5.6 运营费用
CREATE TABLE IF NOT EXISTS operating_expenses (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER REFERENCES landlords(id),
    entity_id INTEGER REFERENCES entities(id),
    period VARCHAR(6) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    data_source VARCHAR(16) DEFAULT 'manual',
    updated_by INTEGER,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_op_expenses_entity ON operating_expenses(entity_id);
COMMENT ON TABLE operating_expenses IS '运营费用（独立手工输入，分红成本项）；★V5：entity_id 为空 ⇒ 【不分摊到任何主体】';

-- 5.7 结账（★V5 新增：月 × 往来对象）
CREATE TABLE IF NOT EXISTS period_closings (
    id          SERIAL PRIMARY KEY,
    period      CHAR(6) NOT NULL,
    side        VARCHAR(8)  NOT NULL CHECK (side IN ('pay','collect')),           -- 应付 / 应收
    target_type VARCHAR(12) NOT NULL CHECK (target_type IN ('landlord','brand')), -- 往来对象类型
    target_id   INTEGER NOT NULL,
    status      VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    closed_at   TIMESTAMPTZ,
    closed_by   INTEGER,
    remark      TEXT,
    CONSTRAINT ux_period_closing UNIQUE (period, side, target_type, target_id)
);
COMMENT ON TABLE period_closings IS
'★V5 新增：结账（月度往来对账）。粒度 = 一个月 × 一个往来对象；场地侧(应付)与品牌侧(应收)可分别结。
 ★结账不等于锁死：只表示"这个月核对过了"；要改走 correction_logs（更正历史账单）。没有截止日，可一直顺延。';

-- 5.8 更正日志（★V5 新增）
CREATE TABLE IF NOT EXISTS correction_logs (
    id         SERIAL PRIMARY KEY,
    table_name VARCHAR(64) NOT NULL,
    row_id     INTEGER NOT NULL,
    field      VARCHAR(64),
    old_value  TEXT,
    new_value  TEXT,
    reason     TEXT NOT NULL,          -- ★强制填原因
    operator   INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_correction_row ON correction_logs (table_name, row_id, created_at DESC);
COMMENT ON TABLE correction_logs IS
'★V5 新增：更正历史账单的留痕。做法 = 【直接改原记录】 + 强制填原因 + 自动记录 谁/何时/字段从多少改到多少。
 不需要"反结账→重结"两步。';

-- ════════════════════════════════════════════════════════════
-- §6  分红域
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dividend_records (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER REFERENCES landlords(id),
    brand_id INTEGER REFERENCES brands(id),
    period VARCHAR(6) NOT NULL,
    type VARCHAR(20) NOT NULL,
    elec_income NUMERIC(14,2),
    rent_income NUMERIC(14,2),
    total_income NUMERIC(14,2),
    elec_cost NUMERIC(14,2),
    rent_cost NUMERIC(14,2),
    op_expense NUMERIC(14,2),
    biz_dividend_cost NUMERIC(14,2),
    total_cost NUMERIC(14,2),
    profit NUMERIC(14,2),
    status VARCHAR(20) DEFAULT '未结算',
    settlement_date DATE,
    approval_id INTEGER,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE dividend_records IS
'分红月结（快照，由分红计算生成）。★V5：只承担"分红月结快照"职责，明细看 electricity_records / rent_records。
 ★落表时机：月份没结束/没结账 ⇒ 只显示不落表；月份结束/结账后 ⇒ 落表快照。';

CREATE TABLE IF NOT EXISTS dividend_shares (
    id SERIAL PRIMARY KEY,
    dividend_id INTEGER NOT NULL REFERENCES dividend_records(id) ON DELETE CASCADE,
    introducer_id INTEGER REFERENCES introducers(id),
    shareholder_id INTEGER REFERENCES shareholders(id),
    brand_id INTEGER REFERENCES brands(id),
    entity_id INTEGER REFERENCES entities(id),
    mode VARCHAR(20) NOT NULL,
    ratio NUMERIC(6,4),
    fixed_amount NUMERIC(12,2),
    amount NUMERIC(14,2),
    remark VARCHAR(200)
);
COMMENT ON TABLE dividend_shares IS '分红明细（配置快照：生成时复制 mode/ratio/fixed_amount，历史不受后续改配置影响）';

-- ════════════════════════════════════════════════════════════
-- §7  分配规则域
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS landlord_shareholder_configs (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id),
    shareholder_id INTEGER NOT NULL REFERENCES shareholders(id),
    brand_id INTEGER REFERENCES brands(id),
    entity_id INTEGER REFERENCES entities(id),
    mode VARCHAR(20) NOT NULL,                 -- 收入分红/利润分红/固定金额
    ratio NUMERIC(6,4),
    fixed_amount NUMERIC(12,2),
    settlement_period VARCHAR(10) NOT NULL DEFAULT '月',
    start_date DATE, end_date DATE,
    remark VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE landlord_shareholder_configs IS '股东分红配置（★比例按场地约定）';

CREATE TABLE IF NOT EXISTS landlord_introducer_configs (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id),
    introducer_id INTEGER NOT NULL REFERENCES introducers(id),
    brand_id INTEGER REFERENCES brands(id),
    entity_id INTEGER REFERENCES entities(id),
    mode VARCHAR(20) NOT NULL,
    ratio NUMERIC(6,4),
    fixed_amount NUMERIC(12,2),
    settlement_period VARCHAR(10) NOT NULL DEFAULT '月',
    count_as_cost BOOLEAN DEFAULT FALSE,
    start_date DATE, end_date DATE,
    remark VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE landlord_introducer_configs IS '介绍人商务分红配置（★比例按场地约定；count_as_cost=是否先扣再算股东分红）';

CREATE UNIQUE INDEX IF NOT EXISTS uq_lsh_conf_whole
    ON landlord_shareholder_configs (landlord_id, shareholder_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lsh_conf_brand
    ON landlord_shareholder_configs (landlord_id, brand_id, shareholder_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lin_conf_whole
    ON landlord_introducer_configs (landlord_id, introducer_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lin_conf_brand
    ON landlord_introducer_configs (landlord_id, brand_id, introducer_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- §8  押金域（★V5 新增）
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    direction VARCHAR(4) NOT NULL CHECK (direction IN ('in','out')),
        -- in  = 品牌方交我方（负债/其他应付款）
        -- out = 我方交场地方（资产/其他应收款）
    amount NUMERIC(12,2) NOT NULL,
    paid_date DATE,
    refund_date DATE,
    refund_amount NUMERIC(12,2),
    forfeited_amount NUMERIC(12,2),        -- 被没收金额（此时才转收入/损失）
    status VARCHAR(16) NOT NULL DEFAULT 'unpaid'
           CHECK (status IN ('unpaid','paid','partial_refund','refunded','forfeited')),
    approval_id INTEGER,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deposits_contract ON deposits (contract_id);
COMMENT ON TABLE deposits IS
'★V5 新增：押金（支持一份合同多笔、多次退还、部分没收）。★押金不进利润、不进分红：
 品牌方交我方 = 负债；我方交场地方 = 资产；被没收时才转收入/损失。';

-- ════════════════════════════════════════════════════════════
-- §9  审批域
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS approval_flows (
    id SERIAL PRIMARY KEY,
    biz_type VARCHAR(50) NOT NULL UNIQUE,
    nodes TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE approval_flows IS '审批流程配置（biz_type 唯一；nodes 为 JSON 文本）';

CREATE TABLE IF NOT EXISTS approval_requests (
    id SERIAL PRIMARY KEY,
    biz_type VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    reason TEXT,
    amount NUMERIC(14,2),
    applicant VARCHAR(100) NOT NULL,
    attachments TEXT,
    flow_nodes TEXT NOT NULL,
    current_node INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT '审批中',
    urge_count INTEGER DEFAULT 0,
    landlord_id INTEGER REFERENCES landlords(id),
    dividend_record_id INTEGER REFERENCES dividend_records(id),
    contract_id INTEGER REFERENCES contracts(id),
    deposit_id INTEGER REFERENCES deposits(id),        -- ★V5
    period VARCHAR(10),
    electricity_amount NUMERIC(14,2),
    rent_amount NUMERIC(14,2),
    created_at TIMESTAMP DEFAULT NOW(),
    finished_at TIMESTAMP
);
COMMENT ON TABLE approval_requests IS '审批单（含场地/分红/合同/押金关联；通过后回写台账与分红状态）';

CREATE TABLE IF NOT EXISTS approval_records (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    node_index INTEGER NOT NULL,
    node_name VARCHAR(100),
    approver VARCHAR(100),
    action VARCHAR(20) NOT NULL,
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE approval_records IS '审批节点流转记录';

CREATE TABLE IF NOT EXISTS approval_dividend_records (
    id SERIAL PRIMARY KEY,
    approval_id INTEGER NOT NULL REFERENCES approval_requests(id),
    dividend_record_id INTEGER NOT NULL REFERENCES dividend_records(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(approval_id, dividend_record_id)
);
COMMENT ON TABLE approval_dividend_records IS '审批单 ↔ 分红记录 一对多（支持多月批量审批）';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dividend_records_approval') THEN
        ALTER TABLE dividend_records ADD CONSTRAINT fk_dividend_records_approval
            FOREIGN KEY (approval_id) REFERENCES approval_requests(id);
    END IF;
END $$;

-- ════════════════════════════════════════════════════════════
-- §10  视图
-- ════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS landlord_site_summary CASCADE;
CREATE OR REPLACE VIEW landlord_site_summary AS
SELECT
    l.id AS landlord_id, l.name AS landlord_name, l.contact, l.phone,
    l.region, l.address, l.latitude, l.longitude,
    COALESCE(SUM(c.monthly_rent) FILTER (WHERE c.contract_type = '场地合同'), 0)::NUMERIC(14,2) AS site_rent_cost,
    COALESCE(SUM(c.monthly_rent) FILTER (WHERE c.contract_type = '品牌方合同'), 0)::NUMERIC(14,2) AS brand_rent_income,
    COUNT(c.id) FILTER (WHERE c.contract_type = '场地合同') AS site_contract_count,
    COUNT(c.id) FILTER (WHERE c.contract_type = '品牌方合同') AS brand_contract_count,
    COALESCE(ARRAY_AGG(c.id) FILTER (WHERE c.contract_type = '场地合同'), '{}'::INTEGER[]) AS site_contract_ids,
    COALESCE(ARRAY_AGG(c.id) FILTER (WHERE c.contract_type = '品牌方合同'), '{}'::INTEGER[]) AS brand_contract_ids
FROM landlords l
LEFT JOIN contracts c ON c.landlord_id = l.id
GROUP BY l.id, l.name, l.contact, l.phone, l.region, l.address, l.latitude, l.longitude;
COMMENT ON VIEW landlord_site_summary IS '场地维度实时聚合（租金成本/收入/合同清单）';

-- ★V5 新增：两块台账合并 ⇒ 合计总利润明细（按 场地 × 品牌 × 主体 × 月）
DROP VIEW IF EXISTS ledger_profit_summary CASCADE;
CREATE OR REPLACE VIEW ledger_profit_summary AS
WITH elec AS (
    SELECT landlord_id, COALESCE(brand_id,0) AS b, COALESCE(entity_id,0) AS e, period,
           SUM(pay_kwh) AS pay_kwh,
           SUM(pay_amount) AS elec_pay_amount,
           SUM(collect_amount) AS elec_collect_amount,
           SUM(collect_net) AS elec_collect_net,
           SUM(profit) AS elec_profit
    FROM electricity_records GROUP BY 1,2,3,4
),
rent AS (
    SELECT landlord_id, COALESCE(brand_id,0) AS b, COALESCE(entity_id,0) AS e, period,
           SUM(pay_amount) AS rent_pay_amount,
           SUM(collect_amount) AS rent_collect_amount,
           SUM(collect_net) AS rent_collect_net,
           SUM(profit) AS rent_profit
    FROM rent_records GROUP BY 1,2,3,4
),
keys AS (
    SELECT landlord_id, b, e, period FROM elec
    UNION
    SELECT landlord_id, b, e, period FROM rent
)
SELECT
    k.landlord_id, NULLIF(k.b,0) AS brand_id, NULLIF(k.e,0) AS entity_id, k.period,
    COALESCE(el.pay_kwh,0)::NUMERIC(14,2)                AS elec_pay_kwh,
    COALESCE(el.elec_pay_amount,0)::NUMERIC(14,2)        AS elec_pay_amount,
    COALESCE(el.elec_collect_amount,0)::NUMERIC(14,2)    AS elec_collect_amount,
    COALESCE(el.elec_collect_net,0)::NUMERIC(14,2)       AS elec_collect_net,
    COALESCE(el.elec_profit,0)::NUMERIC(14,2)            AS elec_profit,
    COALESCE(r.rent_pay_amount,0)::NUMERIC(14,2)         AS rent_pay_amount,
    COALESCE(r.rent_collect_amount,0)::NUMERIC(14,2)     AS rent_collect_amount,
    COALESCE(r.rent_collect_net,0)::NUMERIC(14,2)        AS rent_collect_net,
    COALESCE(r.rent_profit,0)::NUMERIC(14,2)             AS rent_profit,
    (COALESCE(el.elec_collect_net,0) - COALESCE(el.elec_pay_amount,0)
     + COALESCE(r.rent_collect_net,0) - COALESCE(r.rent_pay_amount,0))::NUMERIC(14,2) AS gross_profit
FROM keys k
LEFT JOIN elec el ON el.landlord_id=k.landlord_id AND el.b=k.b AND el.e=k.e AND el.period=k.period
LEFT JOIN rent r  ON r.landlord_id=k.landlord_id  AND r.b=k.b  AND r.e=k.e  AND r.period=k.period;
COMMENT ON VIEW ledger_profit_summary IS
'★V5 新增：电费台账 + 场租台账 合并的合计总利润明细（按 场地 × 品牌 × 主体 × 月）；不含运营费与退款（那部分看 dividend_records）';

DROP VIEW IF EXISTS landlord_monthly_summary CASCADE;
CREATE OR REPLACE VIEW landlord_monthly_summary AS
WITH periods AS (
    SELECT period FROM electricity_records
    UNION SELECT period FROM operating_expenses
    UNION SELECT period FROM dividend_records
),
elec AS (
    SELECT landlord_id, period,
           SUM(pay_kwh) AS pay_kwh, SUM(pay_amount) AS pay_amount,
           SUM(collect_amount) AS collect_amount, SUM(collect_net) AS collect_net, SUM(profit) AS profit
    FROM electricity_records GROUP BY landlord_id, period
),
rent_agg AS (
    SELECT landlord_id, period,
           SUM(pay_amount) AS rent_cost, SUM(collect_amount) AS rent_income,
           SUM(profit) AS rent_profit
    FROM rent_records GROUP BY landlord_id, period
),
op AS (
    SELECT landlord_id, period, SUM(amount) AS amount FROM operating_expenses GROUP BY landlord_id, period
),
div AS (
    SELECT d.landlord_id, d.period,
           SUM(d.profit) AS net_profit,
           SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL) AS shareholder_dividend,
           SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL) AS biz_dividend
    FROM dividend_records d LEFT JOIN dividend_shares ds ON ds.dividend_id = d.id
    GROUP BY d.landlord_id, d.period
)
SELECT
    l.id AS landlord_id, l.name AS landlord_name, p.period,
    (SELECT COUNT(DISTINCT m.id) FROM meters m
      WHERE m.landlord_id = l.id AND m.brand_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%')::INTEGER AS meter_count,
    COALESCE(e.pay_kwh,0)::NUMERIC(14,2) AS elec_pay_kwh,
    COALESCE(e.pay_amount,0)::NUMERIC(14,2) AS elec_pay_amount,
    COALESCE(e.collect_amount,0)::NUMERIC(14,2) AS elec_collect_amount,
    COALESCE(e.collect_net,0)::NUMERIC(14,2) AS elec_collect_net,
    (COALESCE(e.collect_amount,0) - COALESCE(e.collect_net,0))::NUMERIC(14,2) AS elec_tax,
    (COALESCE(e.collect_net,0) - COALESCE(e.pay_amount,0))::NUMERIC(14,2) AS elec_profit,
    COALESCE(rc.rent_cost,0)::NUMERIC(14,2) AS rent_cost,
    COALESCE(rc.rent_income,0)::NUMERIC(14,2) AS rent_income,
    COALESCE(rc.rent_profit,0)::NUMERIC(14,2) AS rent_profit,
    COALESCE(op.amount,0)::NUMERIC(14,2) AS op_expense,
    COALESCE(dv.net_profit,0)::NUMERIC(14,2) AS net_profit,
    (COALESCE(e.collect_net,0) - COALESCE(e.pay_amount,0)
     + COALESCE(rc.rent_profit,0)
     - COALESCE(op.amount,0)
     - COALESCE(dv.shareholder_dividend,0) - COALESCE(dv.biz_dividend,0))::NUMERIC(14,2) AS gross_profit,
    COALESCE(dv.shareholder_dividend,0)::NUMERIC(14,2) AS shareholder_dividend,
    COALESCE(dv.biz_dividend,0)::NUMERIC(14,2) AS biz_dividend
FROM landlords l
CROSS JOIN periods p
LEFT JOIN elec e   ON e.landlord_id = l.id  AND e.period = p.period
LEFT JOIN rent_agg rc ON rc.landlord_id = l.id AND rc.period = p.period
LEFT JOIN op       ON op.landlord_id = l.id AND op.period = p.period
LEFT JOIN div dv   ON dv.landlord_id = l.id AND dv.period = p.period
ORDER BY l.id, p.period;
COMMENT ON VIEW landlord_monthly_summary IS '场地月度经营汇总（V5：租金取自 rent_records 台账）';

DROP VIEW IF EXISTS dividend_settlement_schedule CASCADE;
CREATE OR REPLACE VIEW dividend_settlement_schedule AS
WITH cur AS (
    SELECT to_char(CURRENT_DATE,'YYYYMM') AS cur_period, to_char(CURRENT_DATE,'YYYY') AS cur_year,
           to_char(date_trunc('quarter',CURRENT_DATE),'YYYYMM') AS q_start,
           to_char(date_trunc('quarter',CURRENT_DATE) + interval '3 months' - interval '1 day','YYYYMM') AS q_end,
           to_char(date_trunc('year',CURRENT_DATE),'YYYYMM') AS y_start,
           to_char(date_trunc('year',CURRENT_DATE) + interval '1 year' - interval '1 day','YYYYMM') AS y_end
),
period_range AS (
    SELECT '月' AS settlement_period, cur.cur_period AS p_start, cur.cur_period AS p_end,
           cur.cur_period AS next_period,
           (date_trunc('month',CURRENT_DATE) + interval '1 month' - interval '1 day')::date AS next_date
    FROM cur
    UNION ALL SELECT '季度', cur.q_start, cur.q_end, cur.q_end,
           (date_trunc('quarter',CURRENT_DATE) + interval '3 months' - interval '1 day')::date FROM cur
    UNION ALL SELECT '半年',
           CASE WHEN cur.cur_period <= cur.cur_year||'06' THEN cur.cur_year||'01' ELSE cur.cur_year||'07' END,
           CASE WHEN cur.cur_period <= cur.cur_year||'06' THEN cur.cur_year||'06' ELSE cur.y_end END,
           CASE WHEN cur.cur_period <= cur.cur_year||'06' THEN cur.cur_year||'06' ELSE cur.y_end END,
           CASE WHEN cur.cur_period <= cur.cur_year||'06'
                THEN (date_trunc('year',CURRENT_DATE) + interval '6 months' - interval '1 day')::date
                ELSE (date_trunc('year',CURRENT_DATE) + interval '1 year' - interval '1 day')::date END FROM cur
    UNION ALL SELECT '年', cur.y_start, cur.y_end, cur.y_end,
           (date_trunc('year',CURRENT_DATE) + interval '1 year' - interval '1 day')::date FROM cur
),
periods AS (
    SELECT '股东' AS beneficiary_type, shareholder_id AS beneficiary_id, settlement_period,
           COUNT(DISTINCT landlord_id) AS landlord_count
    FROM landlord_shareholder_configs
    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
    GROUP BY shareholder_id, settlement_period
    UNION ALL
    SELECT '商务', introducer_id, settlement_period, COUNT(DISTINCT landlord_id)
    FROM landlord_introducer_configs
    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
    GROUP BY introducer_id, settlement_period
)
SELECT p.beneficiary_type, p.beneficiary_id, COALESCE(sh.name, i.name) AS beneficiary_name,
       p.settlement_period, p.landlord_count,
       pr.p_start, pr.p_end, pr.next_period, pr.next_date,
       COALESCE(SUM(CASE WHEN d.status = '已结算' THEN ds.amount ELSE 0 END),0)::NUMERIC(14,2) AS settled_amount,
       COALESCE(SUM(CASE WHEN d.status <> '已结算' THEN ds.amount ELSE 0 END),0)::NUMERIC(14,2) AS pending_amount
FROM periods p
CROSS JOIN period_range pr
LEFT JOIN dividend_shares ds ON ds.dividend_id IS NOT NULL
    AND ((p.beneficiary_type='股东' AND ds.shareholder_id=p.beneficiary_id)
      OR (p.beneficiary_type='商务' AND ds.introducer_id=p.beneficiary_id))
LEFT JOIN dividend_records d ON ds.dividend_id = d.id AND d.period BETWEEN pr.p_start AND pr.p_end
LEFT JOIN shareholders sh ON p.beneficiary_type='股东' AND sh.id=p.beneficiary_id
LEFT JOIN introducers  i  ON p.beneficiary_type='商务' AND i.id=p.beneficiary_id
GROUP BY p.beneficiary_type, p.beneficiary_id, sh.name, i.name, p.settlement_period,
         p.landlord_count, pr.p_start, pr.p_end, pr.next_period, pr.next_date;
COMMENT ON VIEW dividend_settlement_schedule IS '分红结算周期视图：受益人 × 周期 的下次结算期/日期 + 待结算/已结算金额';

-- ════════════════════════════════════════════════════════════
-- §11  收尾（★ 等后端全部适配完成后再手动执行）
-- ════════════════════════════════════════════════════════════
-- ALTER TABLE meters   DROP COLUMN IF EXISTS tag;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS partner;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS cabinets_count;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS pay_status;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS deposit;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS deposit_refund_amount;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS deposit_refund_date;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS deposit_refund_approval_id;
-- ALTER TABLE meter_readings DROP COLUMN IF EXISTS address;
-- ALTER TABLE meter_readings DROP COLUMN IF EXISTS month_period;
-- ALTER TABLE meter_readings DROP COLUMN IF EXISTS prev_actual_reading;
-- ALTER TABLE meter_readings DROP COLUMN IF EXISTS curr_actual_reading;
-- ALTER TABLE meter_shared_allocations DROP COLUMN IF EXISTS address;

-- ════════════════════════════════════════════════════════════
-- §12  补建：旧库有、V5 建库遗漏的表（2026-09-27 补）
-- ════════════════════════════════════════════════════════════
-- · `system_configs`：由 `api/system_config.py` 首次写入时 CREATE TABLE IF NOT EXISTS 自建，无需在此建。
-- · `alert_configs`：原先只在 `migrations/2026_08_alert_configs.sql`，V5 建库漏了 —— 补上以保证「从零重建」完整。
CREATE TABLE IF NOT EXISTS alert_configs (
    key         VARCHAR(50) PRIMARY KEY,
    value       VARCHAR(200) NOT NULL,
    remark      VARCHAR(200),
    updated_at  TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE alert_configs IS '预警配置（key-value）：电量同比上涨阈值 / 合同到期提前提醒天数（基础档案→预警设置）';
INSERT INTO alert_configs (key, value, remark) VALUES
('elec_yoy_ratio', '1.5', '电量异常预警：本月用电量 ÷ 去年同期 ≥ 该倍数时预警（如 1.5 = 上涨 50%）'),
('contract_expire_days_venue', '30', '场地合同：到期前多少天提醒（含已到期）'),
('contract_expire_days_brand', '30', '品牌方合同：到期前多少天提醒（含已到期）')
ON CONFLICT (key) DO UPDATE SET remark = EXCLUDED.remark;

-- ════════════════════════════════════════════════════════════
-- §13  兼容列补齐（2026-09-27 后端适配时实测发现：旧代码仍在读，v5 建库漏了）
-- ════════════════════════════════════════════════════════════
-- 用「列级差异扫描」比对 huandian_v2 / huandian_v5 后，只缺这 2 列（第 3 个 landlord_monthly_summary.rent_tax
-- 属于视图列，无任何 app 代码读取，忽略）。按「遗留列保留、逐模块切换」的既定策略补回。
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS pay_entity VARCHAR(150);
COMMENT ON COLUMN contracts.pay_entity IS 'DEPRECATED(V5)：付款主体文本，历史遗留；以 entity_id 为准，过渡保留';
ALTER TABLE landlords ADD COLUMN IF NOT EXISTS company_share NUMERIC(5,4);
COMMENT ON COLUMN landlords.company_share IS 'DEPRECATED(V5)：历史遗留展示列；分红以 landlord_shareholder_configs 为准';
