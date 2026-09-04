-- ============================================================
-- 2026_08_full_redesign.sql
-- 数据库全量重设计 v3 —— 全部表一次建齐（全新安装基准 + 存量库对齐，stations 已移除）
--
-- 配套设计文档：DATABASE_REDESIGN_V2.md
-- 覆盖：档案域 / 电表接入域 / 电表档案域 / 合同域 /
--       台账派生域 / 分配规则域 / 审批域 / 视图  = 33 表 + 3 视图
-- 幂等：可重复执行（CREATE IF NOT EXISTS / ALTER IF NOT EXISTS / DO 块加约束）
-- 说明：
--   1) 对"全新空库"：本文件即完整数据库（可作为 database_init.sql 的整体替代基准，
--      实施轮再替换）。
--   2) 对"已有库"：第二段做非破坏性对齐；第三段核对；第四段破坏性动作需确认后手动执行。
-- 执行顺序：备份 → 执行本文件 → 执行「第三部分 核对 SQL」→ 确认 0 异常。
-- 建表顺序按外键依赖排列；dividend_records.approval_id 外键在末尾 DO 块补充（避免循环引用）。
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 第一部分：全新安装（CREATE TABLE IF NOT EXISTS）
-- ────────────────────────────────────────────────────────────

-- ══════════ 1. 档案域 ══════════

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
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE entities IS '公司主体（报税法人，收款/付款主体）';

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
COMMENT ON TABLE landlords IS '场地方（业主，主链聚合根：公共属性唯一出处，站点/合同/电表经 landlord_id 挂回）';

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
COMMENT ON TABLE landlord_owners IS '场地方的多业主子表：一个场地可有多任/多位业主；landlords.contact 冗余存最新业主';
COMMENT ON COLUMN landlords.contact IS '当前业主（冗余，自动同步 landlord_owners 最新一条）';

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
    phone VARCHAR(50),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE platform_users IS '平台用户（RBAC：boss/finance/finance_supervisor/shareholder；shareholder 用 landlord_ids 限定可见场地）';

-- ══════════ 2. 站点域（v3 已废弃，保留表定义用于兼容） ══════════

-- CREATE TABLE IF NOT EXISTS stations (
--     id SERIAL PRIMARY KEY,
--     name VARCHAR(200) NOT NULL,
--     code VARCHAR(50),
--     region VARCHAR(50),
--     address VARCHAR(300),
--     landlord_id INTEGER REFERENCES landlords(id),
--     entity_id INTEGER REFERENCES entities(id),
--     company_share NUMERIC(5,4),
--     status VARCHAR(20) DEFAULT '运营中',
--     latitude NUMERIC(10,7),
--     longitude NUMERIC(10,7),
--     remark TEXT,
--     created_at TIMESTAMP DEFAULT NOW()
-- );
-- COMMENT ON TABLE stations IS '站点（v3 已废弃，landlord_id 为单源真相）';

-- ══════════ 3. 电表·档案域（业务计算唯一入口）══════════

CREATE TABLE IF NOT EXISTS meters (
    id SERIAL PRIMARY KEY,
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
COMMENT ON TABLE meters IS '电表档案（业务计算唯一入口，禁止业务绕过本表直读缓存层）';
COMMENT ON COLUMN meters.meter_no IS '电表号 = 第三方设备 address（全局唯一身份）';
COMMENT ON COLUMN meters.transformer_ratio IS '互感器倍数：实际用电量 = 表码度数 × 倍数';
COMMENT ON COLUMN meters.landlord_id IS '场地方（v3 主链聚合根：以 landlords 为唯一真相）';
COMMENT ON COLUMN meters.tag IS '电表类型：合作商电表/民用电表/共享电表（第三方导入按账户写）';

CREATE TABLE IF NOT EXISTS cabinets (
    id SERIAL PRIMARY KEY,
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    cabinet_no VARCHAR(100),
    cabinet_type VARCHAR(50) DEFAULT '普通柜',
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE cabinets IS '柜子（物理资产，挂电表下）；计费柜数=实时统计本表，不落合同；品牌归属经 meter 派生（brand_id 列已于 2026-09 退役）';

-- ══════════ 4. 电表·接入域（第三方缓存，只写不读业务）══════════

CREATE TABLE IF NOT EXISTS third_party_configs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    base_url VARCHAR(200) NOT NULL,
    auth_code VARCHAR(100) NOT NULL,
    meter_tag VARCHAR(20) NOT NULL DEFAULT '合作商电表',
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE third_party_configs IS '第三方（天雀）接口账户配置：同步任务遍历本表逐账户 GET 拉取';

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
COMMENT ON TABLE meter_devices IS '第三方设备快照；address=业务电表号（= meters.meter_no）；rate=互感器倍率（导入时复制到 meters.transformer_ratio）';

CREATE TABLE IF NOT EXISTS meter_collectors (
    id VARCHAR(50) PRIMARY KEY,
    collector_id VARCHAR(50),
    description VARCHAR(200),
    device_count INTEGER DEFAULT 0,
    raw_data JSONB,
    synced_at TIMESTAMP
);
COMMENT ON TABLE meter_collectors IS '采集器快照（第三方）';

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
COMMENT ON TABLE meter_status_cache IS '实时状态缓存（覆盖式，每10分钟同步）；c0=总电量，c1~c4=峰尖平谷';

CREATE TABLE IF NOT EXISTS meter_monthly (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50),
    address VARCHAR(100) NOT NULL,
    month_period VARCHAR(6) NOT NULL,
    kwh NUMERIC(14,2),
    actual_kwh NUMERIC(14,2),
    prev_actual_reading NUMERIC(14,2),
    curr_actual_reading NUMERIC(14,2),
    prev_reading_date DATE,
    prev_reading NUMERIC(14,2),
    curr_reading_date DATE,
    curr_reading NUMERIC(14,2),
    raw_data JSONB,
    synced_at TIMESTAMP,
    UNIQUE(address, month_period)
);
COMMENT ON TABLE meter_monthly IS '月度读数（电费/分红源头）；kwh=第三方原始表码度数；actual_kwh=本月实际用电量（人工修正，同步不覆盖）';
COMMENT ON COLUMN meter_monthly.month_period IS '月份，统一 6 位 YYYYMM';
COMMENT ON COLUMN meter_monthly.device_id IS '第三方设备 ID（溯源用，不参与唯一键）';
COMMENT ON COLUMN meter_monthly.actual_kwh IS '本月实际用电量（人工填真实度数用；同步不覆盖，计算优先取本值）';
COMMENT ON COLUMN meter_monthly.prev_actual_reading IS '上月实际电表读数（人工填真实读数用；第三方同步不覆盖）';
COMMENT ON COLUMN meter_monthly.curr_actual_reading IS '本月实际电表读数（人工填真实读数用；第三方同步不覆盖）';
COMMENT ON COLUMN meter_monthly.prev_reading IS '上月起始度数（第三方原始值，同步覆盖）';
COMMENT ON COLUMN meter_monthly.curr_reading IS '本月抄表度数（第三方原始值，同步覆盖）';

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
COMMENT ON TABLE meter_daily IS '日能耗（原始表码度数）；day_date=YYYYMMDD';

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
COMMENT ON TABLE meter_hourly IS '小时能耗（原始表码度数）；hour_time=YYYYMMDDHH';

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
COMMENT ON TABLE meter_yearly IS '年能耗（原始表码度数）；year_period=YYYY';

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

-- ══════════ 5. 合同域（商务量唯一主源）══════════

CREATE TABLE IF NOT EXISTS contracts (
    id SERIAL PRIMARY KEY,
    -- ① 关联组
    landlord_id INTEGER NOT NULL REFERENCES landlords(id),
    brand_id INTEGER REFERENCES brands(id),
    entity_id INTEGER REFERENCES entities(id),
    -- ② 类型组
    contract_type VARCHAR(20) NOT NULL DEFAULT '场地合同',
    data_source VARCHAR(20) NOT NULL DEFAULT 'manual',
    partner VARCHAR(150),
    pay_entity VARCHAR(150),
    -- ③ 电费组
    electricity_price NUMERIC(8,4),
    tax_enabled BOOLEAN DEFAULT FALSE,
    tax_rate NUMERIC(6,4) DEFAULT 0.01,
    post_tax_electricity_price NUMERIC(8,4),
    -- ④ 租金组
    rent_calc_method VARCHAR(20) DEFAULT '按柜子数量',
    unit_monthly_rent NUMERIC(10,2),
    cabinets_count NUMERIC(8,2),
    monthly_rent NUMERIC(12,2),
    rent_amount NUMERIC(12,2),
    input_cost NUMERIC(12,2),
    first_month_rent NUMERIC(12,2),
    rent_refund NUMERIC(12,2),
    early_end_date DATE,
    deposit NUMERIC(12,2),
    deposit_refund_amount NUMERIC(12,2),
    deposit_refund_date DATE,
    deposit_refund_approval_id INTEGER,
    -- ⑤ 期次/付款组
    pay_method VARCHAR(50),
    rent_advance_days INTEGER NOT NULL DEFAULT 0,
    pay_status VARCHAR(20) DEFAULT '未付款',
    -- ⑥ 预警处理：记录「标记已处理」时间与当时的预警特征，特征未变化则不再提醒
    alert_handled_at TIMESTAMPTZ,
    alert_handled_sig TEXT,
    start_date DATE,
    end_date DATE,
    rent_tax_enabled BOOLEAN DEFAULT FALSE,
    rent_tax_rate NUMERIC(6,4),
    post_tax_rent_price NUMERIC(8,4),
    -- ⑥ 位置/审计组
    region VARCHAR(50),
    address VARCHAR(300),
    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE contracts IS '合同台账（商务量唯一主源）：场地合同=成本（公司付业主）/ 品牌方合同=收入（品牌方付公司）';
COMMENT ON COLUMN contracts.contract_type IS '合同类型：场地合同 / 品牌方合同（全系统分流键）';
COMMENT ON COLUMN contracts.electricity_price IS '电费单价（元/度）：场地合同=付款单价，品牌方合同=收款单价';
COMMENT ON COLUMN contracts.monthly_rent IS '月租金（元/月）：场地合同=付业主；品牌方合同=品牌方应付';
COMMENT ON COLUMN contracts.cabinets_count IS 'DEPRECATED(2026-09)：计费柜数唯一源=实时统计 meters→cabinets（live_cabinets_count），本列仅历史回显，不再写入';
COMMENT ON COLUMN contracts.deposit_refund_amount IS '押金退还金额（场地费退款审批通过时回写）';
COMMENT ON COLUMN contracts.deposit_refund_date IS '押金退还日期（审批通过时回写）';
COMMENT ON COLUMN contracts.deposit_refund_approval_id IS '关联的场地费退款审批单';
COMMENT ON COLUMN contracts.pay_status IS 'DEPRECATED：业务读分期推导值';
COMMENT ON COLUMN contracts.partner IS 'DEPRECATED 无用列（无代码写入），收尾删除';

CREATE TABLE IF NOT EXISTS contract_audit_log (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL,
    action VARCHAR(16) NOT NULL,
    changes JSONB,
    operator VARCHAR(64),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_audit_contract
    ON contract_audit_log (contract_id, created_at DESC);
COMMENT ON TABLE contract_audit_log IS '合同变更审计：action=create/update/delete；update 时 changes={字段:{from,to}}，create/delete 为合同快照';

CREATE TABLE IF NOT EXISTS rent_payment_schedule (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    period_start DATE,
    period_end DATE,
    amount NUMERIC(12,2),
    status VARCHAR(20) DEFAULT '未付款',
    pay_date DATE,
    invoice VARCHAR(200),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(contract_id, seq)
);
COMMENT ON TABLE rent_payment_schedule IS '付款分期（场地合同：公司付给场地方，按 pay_method 拆期）';

CREATE TABLE IF NOT EXISTS rent_income_schedule (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    period_start DATE,
    period_end DATE,
    amount NUMERIC(12,2),
    status VARCHAR(20) DEFAULT '未到账',
    pay_date DATE,
    invoice VARCHAR(200),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(contract_id, seq)
);
COMMENT ON TABLE rent_income_schedule IS '收款分期（品牌方合同：品牌方付给公司，按 pay_method 拆期）';

-- ══════════ 6. 台账派生域（快照）══════════

CREATE TABLE IF NOT EXISTS electricity_records (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER REFERENCES landlords(id),
    brand_id INTEGER REFERENCES brands(id),
    period VARCHAR(6) NOT NULL,
    pay_start_date DATE,
    pay_start_reading NUMERIC(14,2),
    pay_end_date DATE,
    pay_end_reading NUMERIC(14,2),
    pay_kwh NUMERIC(14,2),
    pay_unit_price NUMERIC(8,4),
    pay_amount NUMERIC(14,2),
    pay_status VARCHAR(20) DEFAULT '未付款',
    collect_start_date DATE,
    collect_start_reading NUMERIC(14,2),
    collect_end_date DATE,
    collect_end_reading NUMERIC(14,2),
    collect_kwh NUMERIC(14,2),
    collect_unit_price NUMERIC(8,4),
    collect_amount NUMERIC(14,2),
    tax_rate NUMERIC(5,4),
    collect_net NUMERIC(14,2),
    collect_status VARCHAR(20) DEFAULT '未到账',
    profit NUMERIC(14,2),
    data_source VARCHAR(16) DEFAULT 'auto',
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(landlord_id, brand_id, period)
);
COMMENT ON TABLE electricity_records IS '电费月台账（快照，由 表码×倍数×合同单价 生成）；period 统一 6 位 YYYYMM';

CREATE TABLE IF NOT EXISTS electricity_meter_details (
    id SERIAL PRIMARY KEY,
    electricity_id INTEGER NOT NULL REFERENCES electricity_records(id),
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    start_reading NUMERIC(14,2),
    end_reading NUMERIC(14,2),
    kwh NUMERIC(14,2),
    pay_unit_price NUMERIC(8,4),
    pay_amount NUMERIC(14,2),
    collect_unit_price NUMERIC(8,4),
    collect_amount NUMERIC(14,2),
    collect_net NUMERIC(14,2)
);
COMMENT ON TABLE electricity_meter_details IS '电费分表明细（生成时与台账同源写入，明细合计=台账合计）';

CREATE TABLE IF NOT EXISTS operating_expenses (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER REFERENCES landlords(id),
    period VARCHAR(6) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(landlord_id, period)
);
COMMENT ON TABLE operating_expenses IS '运营费用（独立手工输入，分红计算成本项）；period 统一 6 位 YYYYMM';

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
COMMENT ON TABLE dividend_records IS '分红月结（快照，由 dividend_calc 生成）；period 统一 6 位 YYYYMM；status: 未结算→申报中→已通过→已结算';
COMMENT ON COLUMN dividend_records.approval_id IS '关联审批单（外键在文件末尾 DO 块补充，避免循环引用）';

CREATE TABLE IF NOT EXISTS dividend_shares (
    id SERIAL PRIMARY KEY,
    dividend_id INTEGER NOT NULL REFERENCES dividend_records(id),
    introducer_id INTEGER REFERENCES introducers(id),
    shareholder_id INTEGER REFERENCES shareholders(id),
    brand_id INTEGER REFERENCES brands(id),
    mode VARCHAR(20) NOT NULL,
    ratio NUMERIC(6,4),
    fixed_amount NUMERIC(12,2),
    amount NUMERIC(14,2),
    remark VARCHAR(200)
);
COMMENT ON TABLE dividend_shares IS '分红明细（配置快照：生成时复制 mode/ratio/fixed_amount，历史不受后续改配置影响）';

-- ══════════ 7. 分配规则域 ══════════

CREATE TABLE IF NOT EXISTS landlord_shareholder_configs (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id),
    shareholder_id INTEGER NOT NULL REFERENCES shareholders(id),
    brand_id INTEGER REFERENCES brands(id),
    mode VARCHAR(20) NOT NULL,
    ratio NUMERIC(6,4),
    fixed_amount NUMERIC(12,2),
    settlement_period VARCHAR(10) NOT NULL DEFAULT '月',
    start_date DATE,
    end_date DATE,
    remark VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE landlord_shareholder_configs IS '股东分红配置（分配规则）；mode: 收入分红/利润分红/固定金额；settlement_period: 月/季度/半年/年';
COMMENT ON COLUMN landlord_shareholder_configs.brand_id IS '空=整场地配置（基数=场地总收入/净利润）；非空=绑定品牌配置；两类可并存';
COMMENT ON COLUMN landlord_shareholder_configs.start_date IS '生效开始（空=1970-01-01，参与唯一键）';
COMMENT ON COLUMN landlord_shareholder_configs.end_date IS '生效结束（空=无限期）';

CREATE TABLE IF NOT EXISTS landlord_introducer_configs (
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id),
    introducer_id INTEGER NOT NULL REFERENCES introducers(id),
    brand_id INTEGER REFERENCES brands(id),
    mode VARCHAR(20) NOT NULL,
    ratio NUMERIC(6,4),
    fixed_amount NUMERIC(12,2),
    settlement_period VARCHAR(10) NOT NULL DEFAULT '月',
    count_as_cost BOOLEAN DEFAULT FALSE,
    start_date DATE,
    end_date DATE,
    remark VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE landlord_introducer_configs IS '介绍人商务分红配置（结构同股东配置 + count_as_cost）';
COMMENT ON COLUMN landlord_introducer_configs.count_as_cost IS '商务分红是否计入成本：TRUE=先扣再算股东分红；FALSE=单独算';

-- 分配规则唯一键（含生效期：同一受益人同场地可配多段不重叠生效期）
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

-- ══════════ 8. 审批域 ══════════

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
    period VARCHAR(10),
    electricity_amount NUMERIC(14,2),
    rent_amount NUMERIC(14,2),
    created_at TIMESTAMP DEFAULT NOW(),
    finished_at TIMESTAMP
);
COMMENT ON TABLE approval_requests IS '审批单（含场地/分红关联；通过后回写台账与分红状态）';

CREATE TABLE IF NOT EXISTS approval_records (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES approval_requests(id),
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

-- ══════════ 10. 视图 ══════════

CREATE OR REPLACE VIEW landlord_site_summary AS
SELECT
    l.id AS landlord_id,
    l.name AS landlord_name,
    l.contact,
    l.phone,
    l.region,
    l.address,
    l.latitude,
    l.longitude,
    COALESCE(SUM(c.monthly_rent) FILTER (WHERE c.contract_type = '场地合同'), 0)::NUMERIC(14,2) AS site_rent_cost,
    COALESCE(SUM(c.monthly_rent) FILTER (WHERE c.contract_type = '品牌方合同'), 0)::NUMERIC(14,2) AS brand_rent_income,
    COUNT(c.id) FILTER (WHERE c.contract_type = '场地合同') AS site_contract_count,
    COUNT(c.id) FILTER (WHERE c.contract_type = '品牌方合同') AS brand_contract_count,
    COALESCE(ARRAY_AGG(c.id) FILTER (WHERE c.contract_type = '场地合同'), '{}'::INTEGER[]) AS site_contract_ids,
    COALESCE(ARRAY_AGG(c.id) FILTER (WHERE c.contract_type = '品牌方合同'), '{}'::INTEGER[]) AS brand_contract_ids
FROM landlords l
LEFT JOIN contracts c ON c.landlord_id = l.id
GROUP BY l.id, l.name, l.contact, l.phone, l.region, l.address, l.latitude, l.longitude;
COMMENT ON VIEW landlord_site_summary IS '场地维度实时聚合（租金成本/收入/合同清单），只读不落缓存列';

-- 场地月度经营汇总视图：跨表关联（电费台账 + 合同月租 + 运营费用 + 分红）
-- 用途：查"某场地方某月经营数据"，如
--   SELECT * FROM landlord_monthly_summary WHERE landlord_id = 1 AND period = '202607';
-- 口径说明：
--   - 电费各项取 electricity_records（已生成台账，与页面一致）；电费税费 = 台账 含税收款−不含税收款；
--   - 租金为"标准月"口径（合同 monthly_rent × 覆盖该月的合同）；租金税费 = 品牌方合同启用租金税率时 含税月租−税后月租；
--   - net_profit 取 dividend_records（分红计算器口径，含税费/首月租/退款/商务分红成本），未生成分红记录的月为 0；
--   - gross_profit = 电费利润 + 租金毛利 − 运营费用（实时口径，不依赖分红记录）；
--   - shareholder_dividend / biz_dividend 取分红明细（股东/介绍人实分金额），未生成分红记录的月为 0。
DROP VIEW IF EXISTS landlord_monthly_summary;
CREATE OR REPLACE VIEW landlord_monthly_summary AS
WITH periods AS (
    SELECT period FROM electricity_records
    UNION SELECT period FROM operating_expenses
    UNION SELECT period FROM dividend_records
),
elec AS (
    SELECT landlord_id, period,
           SUM(pay_kwh) AS pay_kwh,
           SUM(pay_amount) AS pay_amount,
           SUM(collect_amount) AS collect_amount,
           SUM(collect_net) AS collect_net,
           SUM(profit) AS profit
    FROM electricity_records
    GROUP BY landlord_id, period
),
venue_cost AS (
    SELECT oc.landlord_id, p.period,
           SUM(oc.monthly_rent) AS rent_cost
    FROM contracts oc
    CROSS JOIN periods p
    WHERE oc.contract_type = '场地合同'
      AND (oc.start_date IS NULL OR oc.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
      AND (COALESCE(oc.early_end_date, oc.end_date) IS NULL OR COALESCE(oc.early_end_date, oc.end_date) >= DATE(p.period || '01'))
    GROUP BY oc.landlord_id, p.period
),
brand_income AS (
    SELECT ic.landlord_id, p.period,
           SUM(ic.monthly_rent) AS rent_income,
           SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                    THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END) AS rent_tax
    FROM contracts ic
    CROSS JOIN periods p
    WHERE ic.contract_type = '品牌方合同'
      AND (ic.start_date IS NULL OR ic.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
      AND (COALESCE(ic.early_end_date, ic.end_date) IS NULL OR COALESCE(ic.early_end_date, ic.end_date) >= DATE(p.period || '01'))
    GROUP BY ic.landlord_id, p.period
),
op AS (
    SELECT landlord_id, period, SUM(amount) AS amount
    FROM operating_expenses
    GROUP BY landlord_id, period
),
div AS (
    SELECT d.landlord_id, d.period,
           SUM(d.profit) AS net_profit,
           SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL) AS shareholder_dividend,
           SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL) AS biz_dividend
    FROM dividend_records d
    LEFT JOIN dividend_shares ds ON ds.dividend_id = d.id
    GROUP BY d.landlord_id, d.period
)
SELECT
    l.id AS landlord_id,
    l.name AS landlord_name,
    p.period,
    (SELECT COUNT(DISTINCT m.id) FROM meters m
      WHERE m.landlord_id = l.id AND m.brand_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%')::INTEGER AS meter_count,
    COALESCE(e.pay_kwh, 0)::NUMERIC(14,2) AS elec_pay_kwh,
    COALESCE(e.pay_amount, 0)::NUMERIC(14,2) AS elec_pay_amount,
    COALESCE(e.collect_amount, 0)::NUMERIC(14,2) AS elec_collect_amount,
    COALESCE(e.collect_net, 0)::NUMERIC(14,2) AS elec_collect_net,
    (COALESCE(e.collect_amount, 0) - COALESCE(e.collect_net, 0))::NUMERIC(14,2) AS elec_tax,
    (COALESCE(e.collect_net, 0) - COALESCE(e.pay_amount, 0))::NUMERIC(14,2) AS elec_profit,
    COALESCE(vc.rent_cost, 0)::NUMERIC(14,2) AS rent_cost,
    COALESCE(bi.rent_income, 0)::NUMERIC(14,2) AS rent_income,
    (COALESCE(bi.rent_income, 0) - COALESCE(vc.rent_cost, 0) - COALESCE(bi.rent_tax, 0))::NUMERIC(14,2) AS rent_profit,
    COALESCE(bi.rent_tax, 0)::NUMERIC(14,2) AS rent_tax,
    COALESCE(op.amount, 0)::NUMERIC(14,2) AS op_expense,
    COALESCE(dv.net_profit, 0)::NUMERIC(14,2) AS net_profit,
    (COALESCE(e.collect_net, 0) - COALESCE(e.pay_amount, 0)
     + COALESCE(bi.rent_income, 0) - COALESCE(vc.rent_cost, 0)
     - COALESCE(bi.rent_tax, 0)
     - COALESCE(op.amount, 0)
     - COALESCE(dv.shareholder_dividend, 0)
     - COALESCE(dv.biz_dividend, 0))::NUMERIC(14,2) AS gross_profit,
    COALESCE(dv.shareholder_dividend, 0)::NUMERIC(14,2) AS shareholder_dividend,
    COALESCE(dv.biz_dividend, 0)::NUMERIC(14,2) AS biz_dividend
FROM landlords l
CROSS JOIN periods p
LEFT JOIN elec e ON e.landlord_id = l.id AND e.period = p.period
LEFT JOIN venue_cost vc ON vc.landlord_id = l.id AND vc.period = p.period
LEFT JOIN brand_income bi ON bi.landlord_id = l.id AND bi.period = p.period
LEFT JOIN op ON op.landlord_id = l.id AND op.period = p.period
LEFT JOIN div dv ON dv.landlord_id = l.id AND dv.period = p.period
ORDER BY l.id, p.period;
COMMENT ON VIEW landlord_monthly_summary IS '场地月度经营汇总（v3：landlord 直连，各源预聚合防笛卡尔积）：电费收支+税费/租金收支+税费/运营费用/净利润/分红，按场地×月份一行';


-- 分红结算周期视图：受益人 × 周期（月/季度/半年/年）的 下次结算期/日期 + 待结算/已结算金额
DROP VIEW IF EXISTS dividend_settlement_schedule;
CREATE OR REPLACE VIEW dividend_settlement_schedule AS
WITH cur AS (
    SELECT
        to_char(CURRENT_DATE, 'YYYYMM') AS cur_period,
        to_char(CURRENT_DATE, 'YYYY')   AS cur_year,
        to_char(date_trunc('quarter', CURRENT_DATE), 'YYYYMM') AS q_start,
        to_char(date_trunc('quarter', CURRENT_DATE) + interval '3 months' - interval '1 day', 'YYYYMM') AS q_end,
        to_char(date_trunc('year', CURRENT_DATE), 'YYYYMM') AS y_start,
        to_char(date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day', 'YYYYMM') AS y_end
),
period_range AS (
    SELECT '月' AS settlement_period,
           cur.cur_period AS p_start, cur.cur_period AS p_end,
           cur.cur_period AS next_period,
           (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')::date AS next_date
    FROM cur
    UNION ALL
    SELECT '季度', cur.q_start, cur.q_end, cur.q_end,
           (date_trunc('quarter', CURRENT_DATE) + interval '3 months' - interval '1 day')::date
    FROM cur
    UNION ALL
    SELECT '半年',
           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '01' ELSE cur.cur_year || '07' END,
           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '06' ELSE cur.y_end END,
           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '06' ELSE cur.y_end END,
           CASE WHEN cur.cur_period <= cur.cur_year || '06'
                THEN (date_trunc('year', CURRENT_DATE) + interval '6 months' - interval '1 day')::date
                ELSE (date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day')::date END
    FROM cur
    UNION ALL
    SELECT '年', cur.y_start, cur.y_end, cur.y_end,
           (date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day')::date
    FROM cur
),
periods AS (
    SELECT '股东' AS beneficiary_type, shareholder_id AS beneficiary_id, settlement_period,
           COUNT(DISTINCT landlord_id) AS landlord_count
    FROM landlord_shareholder_configs
    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
    GROUP BY shareholder_id, settlement_period
    UNION ALL
    SELECT '商务' AS beneficiary_type, introducer_id AS beneficiary_id, settlement_period,
           COUNT(DISTINCT landlord_id) AS landlord_count
    FROM landlord_introducer_configs
    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
    GROUP BY introducer_id, settlement_period
)
SELECT
    p.beneficiary_type,
    p.beneficiary_id,
    COALESCE(sh.name, i.name) AS beneficiary_name,
    p.settlement_period,
    p.landlord_count,
    pr.p_start, pr.p_end, pr.next_period, pr.next_date,
    COALESCE(SUM(CASE WHEN d.status = '已结算' THEN ds.amount ELSE 0 END), 0)::NUMERIC(14,2) AS settled_amount,
    COALESCE(SUM(CASE WHEN d.status <> '已结算' THEN ds.amount ELSE 0 END), 0)::NUMERIC(14,2) AS pending_amount
FROM periods p
CROSS JOIN period_range pr
LEFT JOIN dividend_shares ds ON ds.dividend_id IS NOT NULL
    AND ((p.beneficiary_type = '股东' AND ds.shareholder_id = p.beneficiary_id)
         OR (p.beneficiary_type = '商务' AND ds.introducer_id = p.beneficiary_id))
LEFT JOIN dividend_records d ON ds.dividend_id = d.id AND d.period BETWEEN pr.p_start AND pr.p_end
LEFT JOIN shareholders sh ON p.beneficiary_type = '股东' AND sh.id = p.beneficiary_id
LEFT JOIN introducers i ON p.beneficiary_type = '商务' AND i.id = p.beneficiary_id
GROUP BY p.beneficiary_type, p.beneficiary_id, sh.name, i.name, p.settlement_period,
         p.landlord_count, pr.p_start, pr.p_end, pr.next_period, pr.next_date;
COMMENT ON VIEW dividend_settlement_schedule IS '分红结算周期视图（v3：landlord 配置表）：受益人 × 周期 的下次结算期/日期 + 待结算/已结算金额';

-- 末尾补充：dividend_records.approval_id 外键（解除循环引用）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dividend_records_approval') THEN
        ALTER TABLE dividend_records ADD CONSTRAINT fk_dividend_records_approval
            FOREIGN KEY (approval_id) REFERENCES approval_requests(id);
    END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 第二部分：存量库对齐（非破坏性）
-- ────────────────────────────────────────────────────────────

-- 2.1 档案补列
ALTER TABLE shareholders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE introducers  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE landlords    ADD COLUMN IF NOT EXISTS region VARCHAR(50);
ALTER TABLE landlords    ADD COLUMN IF NOT EXISTS address VARCHAR(300);
ALTER TABLE landlords    ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7);
ALTER TABLE landlords    ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);

-- 2.2 电表档案补列
ALTER TABLE meters ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS entity_id  INTEGER REFERENCES entities(id);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE meters ADD COLUMN IF NOT EXISTS tag VARCHAR(20) DEFAULT '合作商电表';

-- 2.3 缓存表补列（兼容漂移过的存量库）
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS device_id VARCHAR(50);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS actual_kwh NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_actual_reading NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_actual_reading NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_reading_date DATE;
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_reading NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_reading_date DATE;
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_reading NUMERIC(14,2);
ALTER TABLE meter_daily ADD COLUMN IF NOT EXISTS device_id VARCHAR(50);

-- 2.4 period 统一 6 位 YYYYMM（去横线）
UPDATE meter_monthly     SET month_period = REPLACE(month_period, '-', '') WHERE month_period LIKE '%-%';
UPDATE electricity_records SET period = REPLACE(period, '-', '') WHERE period LIKE '%-%';
UPDATE dividend_records  SET period = REPLACE(period, '-', '') WHERE period LIKE '%-%';
UPDATE operating_expenses SET period = REPLACE(period, '-', '') WHERE period LIKE '%-%';

-- 2.5 合同旧类型映射（两分法；歧义值留待人工）
UPDATE contracts SET contract_type = '场地合同'   WHERE contract_type = '场租付款';
UPDATE contracts SET contract_type = '品牌方合同' WHERE contract_type = '场租收款';

-- 2.6 contracts 补列（兼容历史缺列库）
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS entity_id INTEGER REFERENCES entities(id);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS input_cost NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS first_month_rent NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_refund NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS early_end_date DATE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_tax_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_tax_rate NUMERIC(6,4);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS post_tax_rent_price NUMERIC(8,4);

-- 2.7 审批表补列
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS dividend_record_id INTEGER REFERENCES dividend_records(id);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS period VARCHAR(10);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS electricity_amount NUMERIC(14,2);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS rent_amount NUMERIC(14,2);
ALTER TABLE dividend_records ADD COLUMN IF NOT EXISTS approval_id INTEGER;

-- 2.8 守卫式 CHECK 约束（仅当存量无违规时才添加）

-- contracts.contract_type 两分法
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_contracts_type')
       AND NOT EXISTS (SELECT 1 FROM contracts WHERE contract_type NOT IN ('场地合同', '品牌方合同')) THEN
        ALTER TABLE contracts ADD CONSTRAINT ck_contracts_type
            CHECK (contract_type IN ('场地合同', '品牌方合同'));
    END IF;
END $$;

-- meter_monthly.month_period 6 位
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_meter_monthly_period') THEN
        ALTER TABLE meter_monthly ADD CONSTRAINT ck_meter_monthly_period
            CHECK (month_period ~ '^\d{6}$');
    END IF;
END $$;

-- 分红配置 mode / settlement_period / 联动（股东 + 介绍人，共 8 个，v3：landlord_* 配置表）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_lsh_mode')
       AND NOT EXISTS (SELECT 1 FROM landlord_shareholder_configs WHERE mode NOT IN ('收入分红','利润分红','固定金额')) THEN
        ALTER TABLE landlord_shareholder_configs ADD CONSTRAINT ck_lsh_mode
            CHECK (mode IN ('收入分红','利润分红','固定金额'));
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_lsh_settlement')
       AND NOT EXISTS (SELECT 1 FROM landlord_shareholder_configs WHERE settlement_period NOT IN ('月','季度','半年','年')) THEN
        ALTER TABLE landlord_shareholder_configs ADD CONSTRAINT ck_lsh_settlement
            CHECK (settlement_period IN ('月','季度','半年','年'));
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_lsh_fixed')
       AND NOT EXISTS (SELECT 1 FROM landlord_shareholder_configs
                       WHERE mode = '固定金额' AND fixed_amount IS NULL) THEN
        ALTER TABLE landlord_shareholder_configs ADD CONSTRAINT ck_lsh_fixed
            CHECK (mode <> '固定金额' OR fixed_amount IS NOT NULL);
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_lsh_ratio')
       AND NOT EXISTS (SELECT 1 FROM landlord_shareholder_configs
                       WHERE mode <> '固定金额' AND ratio IS NULL) THEN
        ALTER TABLE landlord_shareholder_configs ADD CONSTRAINT ck_lsh_ratio
            CHECK (mode = '固定金额' OR ratio IS NOT NULL);
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_li_mode')
       AND NOT EXISTS (SELECT 1 FROM landlord_introducer_configs WHERE mode NOT IN ('收入分红','利润分红','固定金额')) THEN
        ALTER TABLE landlord_introducer_configs ADD CONSTRAINT ck_li_mode
            CHECK (mode IN ('收入分红','利润分红','固定金额'));
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_li_settlement')
       AND NOT EXISTS (SELECT 1 FROM landlord_introducer_configs WHERE settlement_period NOT IN ('月','季度','半年','年')) THEN
        ALTER TABLE landlord_introducer_configs ADD CONSTRAINT ck_li_settlement
            CHECK (settlement_period IN ('月','季度','半年','年'));
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_li_fixed')
       AND NOT EXISTS (SELECT 1 FROM landlord_introducer_configs
                       WHERE mode = '固定金额' AND fixed_amount IS NULL) THEN
        ALTER TABLE landlord_introducer_configs ADD CONSTRAINT ck_li_fixed
            CHECK (mode <> '固定金额' OR fixed_amount IS NOT NULL);
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_li_ratio')
       AND NOT EXISTS (SELECT 1 FROM landlord_introducer_configs
                       WHERE mode <> '固定金额' AND ratio IS NULL) THEN
        ALTER TABLE landlord_introducer_configs ADD CONSTRAINT ck_li_ratio
            CHECK (mode = '固定金额' OR ratio IS NOT NULL);
    END IF;
END $$;

-- 2.9 防重复/唯一索引（仅当无重复时添加）

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_contracts_venue')
       AND NOT EXISTS (SELECT 1 FROM contracts
                       WHERE contract_type = '场地合同'
                       GROUP BY landlord_id, start_date, end_date HAVING COUNT(*) > 1) THEN
        CREATE UNIQUE INDEX uq_contracts_venue
            ON contracts (landlord_id, start_date, end_date) WHERE contract_type = '场地合同';
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_contracts_brand')
       AND NOT EXISTS (SELECT 1 FROM contracts
                       WHERE contract_type = '品牌方合同'
                       GROUP BY landlord_id, brand_id, start_date, end_date HAVING COUNT(*) > 1) THEN
        CREATE UNIQUE INDEX uq_contracts_brand
            ON contracts (landlord_id, brand_id, start_date, end_date) WHERE contract_type = '品牌方合同';
    END IF;
END $$;

-- 能耗表 (address, 周期) 唯一键（存量旧键是 (device_id, 周期)，同步/录读数按 address 冲突更新需此键）
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

-- 2.10 常用查询索引
CREATE INDEX IF NOT EXISTS idx_meter_monthly_device ON meter_monthly(device_id, month_period);
CREATE INDEX IF NOT EXISTS idx_meters_landlord  ON meters(landlord_id);
CREATE INDEX IF NOT EXISTS idx_meters_brand     ON meters(brand_id);
CREATE INDEX IF NOT EXISTS idx_meters_entity    ON meters(entity_id);
CREATE INDEX IF NOT EXISTS idx_meter_daily_addr ON meter_daily(address, day_date);
CREATE INDEX IF NOT EXISTS idx_meter_hourly_addr ON meter_hourly(address, hour_time);
CREATE INDEX IF NOT EXISTS idx_meter_yearly_addr ON meter_yearly(address, year_period);
CREATE INDEX IF NOT EXISTS idx_meter_warnings_addr ON meter_warnings_cache(device_address, start_time);
CREATE INDEX IF NOT EXISTS idx_cabinets_meter   ON cabinets(meter_id);
CREATE INDEX IF NOT EXISTS idx_contracts_landlord ON contracts(landlord_id);
CREATE INDEX IF NOT EXISTS idx_contracts_brand    ON contracts(brand_id);
CREATE INDEX IF NOT EXISTS idx_contracts_type     ON contracts(contract_type);
CREATE INDEX IF NOT EXISTS idx_lsh_landlord       ON landlord_shareholder_configs(landlord_id);
CREATE INDEX IF NOT EXISTS idx_lsh_shareholder    ON landlord_shareholder_configs(shareholder_id);
CREATE INDEX IF NOT EXISTS idx_li_landlord        ON landlord_introducer_configs(landlord_id);
CREATE INDEX IF NOT EXISTS idx_li_introducer      ON landlord_introducer_configs(introducer_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_landlord ON approval_requests(landlord_id);
CREATE INDEX IF NOT EXISTS idx_platform_users_name ON platform_users(name);
CREATE INDEX IF NOT EXISTS idx_elec_details_meter ON electricity_meter_details(meter_id);

-- ────────────────────────────────────────────────────────────
-- 第三部分：核对 SQL（期望全部 0 行/无输出）
-- ────────────────────────────────────────────────────────────

-- 3.1 电表 landlord 与站点不一致（应 0 行）
-- SELECT m.id, m.meter_no FROM meters m
-- JOIN stations s ON m.station_id = s.id
-- WHERE s.landlord_id IS NOT NULL
--   AND m.landlord_id IS DISTINCT FROM s.landlord_id;

-- 3.2 各 period 残留 7 位/非法格式（应 0 行）
-- SELECT 'mm' AS t, id, month_period AS p FROM meter_monthly WHERE month_period !~ '^\d{6}$'
-- UNION ALL SELECT 'er', id, period FROM electricity_records WHERE period !~ '^\d{6}$'
-- UNION ALL SELECT 'dr', id, period FROM dividend_records WHERE period !~ '^\d{6}$'
-- UNION ALL SELECT 'oe', id, period FROM operating_expenses WHERE period !~ '^\d{6}$';

-- 3.3 歧义合同类型（应 0 行；有则人工确认后映射）
-- SELECT id, contract_type FROM contracts WHERE contract_type NOT IN ('场地合同', '品牌方合同');

-- 3.4 合同重复（应 0 行）
-- SELECT landlord_id, start_date, end_date, COUNT(*) FROM contracts
-- WHERE contract_type = '场地合同' GROUP BY landlord_id, start_date, end_date HAVING COUNT(*) > 1;
-- SELECT landlord_id, brand_id, start_date, end_date, COUNT(*) FROM contracts
-- WHERE contract_type = '品牌方合同' GROUP BY landlord_id, brand_id, start_date, end_date HAVING COUNT(*) > 1;

-- 3.5 分红配置非法值（应 0 行）
-- SELECT 'ssh' AS t, id, mode, settlement_period, ratio, fixed_amount FROM station_shareholder_configs
-- WHERE mode NOT IN ('收入分红','利润分红','固定金额')
--    OR settlement_period NOT IN ('月','季度','半年','年')
--    OR (mode <> '固定金额' AND ratio IS NULL)
--    OR (mode = '固定金额' AND fixed_amount IS NULL)
--    OR ratio > 1 OR ratio < 0
-- UNION ALL
-- SELECT 'sint', id, mode, settlement_period, ratio, fixed_amount FROM station_introducer_configs
-- WHERE mode NOT IN ('收入分红','利润分红','固定金额')
--    OR settlement_period NOT IN ('月','季度','半年','年')
--    OR (mode <> '固定金额' AND ratio IS NULL)
--    OR (mode = '固定金额' AND fixed_amount IS NULL)
--    OR ratio > 1 OR ratio < 0;

-- 3.6 分红配置生效期重叠（同一受益人同站区间相交，会双算，应人工处理）
-- SELECT a.id AS cfg_a, b.id AS cfg_b, a.station_id, a.shareholder_id,
--        a.start_date, a.end_date, b.start_date, b.end_date
-- FROM station_shareholder_configs a
-- JOIN station_shareholder_configs b
--   ON a.station_id = b.station_id AND a.shareholder_id = b.shareholder_id
--  AND COALESCE(a.brand_id, 0) = COALESCE(b.brand_id, 0) AND a.id < b.id
-- WHERE COALESCE(a.start_date, DATE '1970-01-01') <= COALESCE(b.end_date, DATE '9999-12-31')
--   AND COALESCE(b.start_date, DATE '1970-01-01') <= COALESCE(a.end_date, DATE '9999-12-31');

-- 3.7 缓存与档案未对应（提醒：待人工确认/导入）
-- SELECT d.address, d.description FROM meter_devices d
-- LEFT JOIN meters m ON m.meter_no = d.address
-- WHERE m.id IS NULL;

-- 3.8 台账明细合计 ≠ 台账合计（应 0 行）
-- SELECT e.id FROM electricity_records e
-- LEFT JOIN (
--     SELECT electricity_id, SUM(pay_amount) AS p, SUM(collect_amount) AS c
--     FROM electricity_meter_details GROUP BY electricity_id
-- ) d ON d.electricity_id = e.id
-- WHERE (d.p IS NOT NULL AND ABS(COALESCE(d.p,0) - COALESCE(e.pay_amount,0)) > 0.01)
--    OR (d.c IS NOT NULL AND ABS(COALESCE(d.c,0) - COALESCE(e.collect_amount,0)) > 0.01);

-- ────────────────────────────────────────────────────────────
-- 第四部分：破坏性动作（核对无误后手动执行，先备份！）
-- ────────────────────────────────────────────────────────────

-- 4.1 缓存表废弃列（确认 3.2 通过且代码已切 (address, 周期) 冲突键后）
-- ALTER TABLE meter_monthly DROP COLUMN IF EXISTS year_month;
-- ALTER TABLE meter_monthly DROP COLUMN IF EXISTS d0;
-- ALTER TABLE meter_daily   DROP COLUMN IF EXISTS date;

-- 4.2 contracts 废弃列（确认无代码引用后）
-- ALTER TABLE contracts DROP COLUMN IF EXISTS station_name;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS partner;

-- 4.3 rent_* 台账下线（先完成数据并入 contracts + 前端改造，再执行）
-- DROP TABLE IF EXISTS rent_receipts;
-- DROP TABLE IF EXISTS rent_incomes;
-- DROP TABLE IF EXISTS rent_leases;

-- 4.4 可选增强：分红配置生效期排除约束（杜绝重叠，需 btree_gist；先清 3.6）
-- CREATE EXTENSION IF NOT EXISTS btree_gist;
-- ALTER TABLE station_shareholder_configs DROP CONSTRAINT IF EXISTS ex_ssh_no_overlap;
-- ALTER TABLE station_shareholder_configs ADD CONSTRAINT ex_ssh_no_overlap
--     EXCLUDE USING gist (
--         station_id WITH =, shareholder_id WITH =, COALESCE(brand_id, 0) WITH =,
--         daterange(COALESCE(start_date, DATE '1970-01-01'), COALESCE(end_date, DATE '9999-12-31'), '[]') WITH &&
--     );
-- ALTER TABLE station_introducer_configs DROP CONSTRAINT IF EXISTS ex_sint_no_overlap;
-- ALTER TABLE station_introducer_configs ADD CONSTRAINT ex_sint_no_overlap
--     EXCLUDE USING gist (
--         station_id WITH =, introducer_id WITH =, COALESCE(brand_id, 0) WITH =,
--         daterange(COALESCE(start_date, DATE '1970-01-01'), COALESCE(end_date, DATE '9999-12-31'), '[]') WITH &&
--     );

-- ─── 合同预警「标记已处理」：存量库补列（幂等）──────────────────
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS alert_handled_at TIMESTAMPTZ;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS alert_handled_sig TEXT;
