-- ============================================================
-- 2026_08_contract_line_clean.sql
-- ② 合同信息线 —— 标准表结构（全新安装基准 + 存量库对齐）
--
-- 配套设计文档：CONTRACT_LINE_DESIGN.md
-- 依赖：landlords / brands / entities / stations 已存在（database_init.sql 先行）
-- 幂等：可重复执行（CREATE IF NOT EXISTS / ALTER IF NOT EXISTS / DO 块加约束）
-- 说明：
--   1) 对"全新空库"：本文件直接建出合同线全部表（可作为 database_init.sql
--      合同线部分的替代基准，实施轮再替换）。
--   2) 对"已有库"：后半段做非破坏性对齐（补列/注释/旧类型映射/约束/索引），
--      破坏性动作（删 station_name/partner、rent_* 下线）放在最后，核对后手动执行。
-- 执行顺序：备份 → 执行本文件 → 执行「第三部分 核对 SQL」→ 确认 0 异常。
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 第一部分：全新安装（CREATE TABLE IF NOT EXISTS）
-- ────────────────────────────────────────────────────────────

-- ── contracts：合同台账（商务量唯一主源）────────────────────

CREATE TABLE IF NOT EXISTS contracts (
    -- ① 关联组
    id SERIAL PRIMARY KEY,
    landlord_id INTEGER NOT NULL REFERENCES landlords(id),
    brand_id INTEGER REFERENCES brands(id),
    entity_id INTEGER REFERENCES entities(id),
    station_id INTEGER REFERENCES stations(id),
    station_name VARCHAR(200),
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
    first_month_rent NUMERIC(12,2),
    rent_refund NUMERIC(12,2),
    early_end_date DATE,
    deposit NUMERIC(12,2),
    -- ⑤ 期次/付款组
    pay_method VARCHAR(50),
    rent_advance_days INTEGER NOT NULL DEFAULT 0,
    pay_status VARCHAR(20) DEFAULT '未付款',
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

-- ── 分期表（场地合同=付款，品牌方合同=收款）────────────────

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

-- ── contracts 字段注释（六组，幂等覆盖）────────────────────

COMMENT ON COLUMN contracts.landlord_id        IS '场地方（合同归属主体，一级挂 landlord，不区分站点）';
COMMENT ON COLUMN contracts.brand_id           IS '品牌方（仅品牌方合同必填；1 场地 1 品牌 1 合同）';
COMMENT ON COLUMN contracts.entity_id          IS '报税公司主体（收款/付款法人）';
COMMENT ON COLUMN contracts.station_id         IS '兼容遗留（合同归一挂 landlord，不强制）';
COMMENT ON COLUMN contracts.station_name       IS 'DEPRECATED 冗余显示列（曾存场地方名），收尾迁移将删除';
COMMENT ON COLUMN contracts.contract_type      IS '合同类型：场地合同=成本（公司付业主）/ 品牌方合同=收入（品牌方付公司），全系统分流键';
COMMENT ON COLUMN contracts.data_source        IS '数据来源：manual 手工 / excel 导入';
COMMENT ON COLUMN contracts.partner            IS 'DEPRECATED 无用列（无代码写入），收尾迁移将删除';
COMMENT ON COLUMN contracts.pay_entity         IS '付款主体文本（历史遗留；以 entity_id 为准，过渡保留）';
COMMENT ON COLUMN contracts.electricity_price  IS '电费单价（元/度）：场地合同=付款单价，品牌方合同=收款单价';
COMMENT ON COLUMN contracts.tax_enabled        IS '电费是否含税计';
COMMENT ON COLUMN contracts.tax_rate           IS '电费税率（含税→不含税换算）';
COMMENT ON COLUMN contracts.post_tax_electricity_price IS '税后电费单价（= 税前 × (1−税率)）';
COMMENT ON COLUMN contracts.rent_calc_method   IS '计价方式：按柜子数量 / 固定价格';
COMMENT ON COLUMN contracts.unit_monthly_rent  IS '单柜月租金（品牌方合同，按柜计价时用）';
COMMENT ON COLUMN contracts.cabinets_count     IS 'DEPRECATED 参考快照：计费柜数以 meters→cabinets 实时统计为准，本列仅表单回显参考';
COMMENT ON COLUMN contracts.monthly_rent       IS '月租金（元/月）：场地合同=付业主；品牌方合同=品牌方应付';
COMMENT ON COLUMN contracts.rent_amount        IS '年租金总额（冗余便捷列）';
COMMENT ON COLUMN contracts.first_month_rent   IS '首月场地租金（品牌方合同，分红计算有专门分支）';
COMMENT ON COLUMN contracts.rent_refund        IS '提前结束退款（品牌方合同，配合 early_end_date）';
COMMENT ON COLUMN contracts.early_end_date     IS '合同提前结束日（触发提前结束状态与退款分支）';
COMMENT ON COLUMN contracts.deposit            IS '押金';
COMMENT ON COLUMN contracts.pay_method          IS '月付/季付/半年付/年付 → 决定分期表拆期';
COMMENT ON COLUMN contracts.rent_advance_days  IS '场地租金提前支付天数（影响到期月份计算）';
COMMENT ON COLUMN contracts.pay_status         IS 'DEPRECATED：业务读分期推导值（全部分期已付→已付款），本列仅历史兼容';
COMMENT ON COLUMN contracts.rent_tax_enabled   IS '租金是否含税计';
COMMENT ON COLUMN contracts.rent_tax_rate      IS '租金税率';
COMMENT ON COLUMN contracts.post_tax_rent_price IS '税后月租金';
COMMENT ON COLUMN contracts.updated_at         IS '审计列（最后更新时间）';

-- ────────────────────────────────────────────────────────────
-- 第二部分：存量库对齐（非破坏性）
-- ────────────────────────────────────────────────────────────

-- 2.1 contracts 补列（幂等；多数已由 2026_08_schema_alignment.sql 补齐）
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS entity_id INTEGER REFERENCES entities(id);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS first_month_rent NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_refund NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS early_end_date DATE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_tax_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS rent_tax_rate NUMERIC(6,4);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS post_tax_rent_price NUMERIC(8,4);

-- 2.2 旧合同类型映射（口径统一为两分法；歧义值留待人工确认）
UPDATE contracts SET contract_type = '场地合同'   WHERE contract_type = '场租付款';
UPDATE contracts SET contract_type = '品牌方合同' WHERE contract_type = '场租收款';

-- 2.3 contract_type CHECK（仅当无歧义值时添加，否则留待核对段处理）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_contracts_type')
       AND NOT EXISTS (SELECT 1 FROM contracts WHERE contract_type NOT IN ('场地合同', '品牌方合同')) THEN
        ALTER TABLE contracts ADD CONSTRAINT ck_contracts_type
            CHECK (contract_type IN ('场地合同', '品牌方合同'));
    END IF;
END $$;

-- 2.4 防重复唯一索引（部分唯一；仅当无重复时添加）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_contracts_venue')
       AND NOT EXISTS (
           SELECT 1 FROM contracts
           WHERE contract_type = '场地合同'
           GROUP BY landlord_id, start_date, end_date HAVING COUNT(*) > 1
       ) THEN
        CREATE UNIQUE INDEX uq_contracts_venue
            ON contracts (landlord_id, start_date, end_date) WHERE contract_type = '场地合同';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_contracts_brand')
       AND NOT EXISTS (
           SELECT 1 FROM contracts
           WHERE contract_type = '品牌方合同'
           GROUP BY landlord_id, brand_id, start_date, end_date HAVING COUNT(*) > 1
       ) THEN
        CREATE UNIQUE INDEX uq_contracts_brand
            ON contracts (landlord_id, brand_id, start_date, end_date) WHERE contract_type = '品牌方合同';
    END IF;
END $$;

-- 2.5 常用查询索引
CREATE INDEX IF NOT EXISTS idx_contracts_landlord ON contracts(landlord_id);
CREATE INDEX IF NOT EXISTS idx_contracts_brand    ON contracts(brand_id);
CREATE INDEX IF NOT EXISTS idx_contracts_type     ON contracts(contract_type);

-- 2.6 过渡表标注（rent_* 台账已被 contracts 取代，不再承担主源职责）
COMMENT ON TABLE rent_leases   IS 'DEPRECATED 场地租金付款台账（与 contracts 场地合同重复），实施轮并入 contracts 后下线';
COMMENT ON TABLE rent_incomes  IS 'DEPRECATED 品牌场地租金收款台账（与 contracts 品牌方合同重复），实施轮并入 contracts 后下线';
COMMENT ON TABLE rent_receipts IS 'DEPRECATED rent_incomes 的分期收款，实施轮并入 rent_income_schedule';
COMMENT ON TABLE rent_payment_records IS '年度发票/付款台账（station+brand+fiscal_year），与分期表 invoice 存在冗余，实施轮明确分工';
COMMENT ON TABLE rent_income_records  IS '年度发票/进项成本台账（station+brand+fiscal_year），与分期表 invoice 存在冗余，实施轮明确分工';

-- ────────────────────────────────────────────────────────────
-- 第三部分：核对 SQL（期望全部 0 行/无输出）
-- ────────────────────────────────────────────────────────────

-- 3.1 歧义合同类型（应 0 行；有则人工确认后映射）
-- SELECT id, contract_type, landlord_id FROM contracts
-- WHERE contract_type NOT IN ('场地合同', '品牌方合同');

-- 3.2 场地合同重复（应 0 行；有则人工合并）
-- SELECT landlord_id, start_date, end_date, COUNT(*) FROM contracts
-- WHERE contract_type = '场地合同'
-- GROUP BY landlord_id, start_date, end_date HAVING COUNT(*) > 1;

-- 3.3 品牌方合同重复（应 0 行）
-- SELECT landlord_id, brand_id, start_date, end_date, COUNT(*) FROM contracts
-- WHERE contract_type = '品牌方合同'
-- GROUP BY landlord_id, brand_id, start_date, end_date HAVING COUNT(*) > 1;

-- 3.4 手填柜数与实时柜数不一致（仅提醒，业务以实时柜数为准）
-- SELECT c.id, c.monthly_rent, c.cabinets_count AS stored_cabs,
--        (SELECT COALESCE(SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id))), 0)
--         FROM meters m WHERE m.landlord_id = c.landlord_id AND m.brand_id = c.brand_id
--           AND m.meter_no NOT LIKE 'TEST%') AS live_cabs
-- FROM contracts c WHERE c.contract_type = '品牌方合同';

-- 3.5 rent_* 台账残留（实施轮并入 contracts 前清点）
-- SELECT 'rent_leases' AS t, COUNT(*) FROM rent_leases
-- UNION ALL SELECT 'rent_incomes', COUNT(*) FROM rent_incomes
-- UNION ALL SELECT 'rent_receipts', COUNT(*) FROM rent_receipts;

-- ────────────────────────────────────────────────────────────
-- 第四部分：破坏性动作（核对无误后手动执行，先备份！）
-- ────────────────────────────────────────────────────────────

-- 4.1 删除废弃列（确认代码无引用后）
-- ALTER TABLE contracts DROP COLUMN IF EXISTS station_name;
-- ALTER TABLE contracts DROP COLUMN IF EXISTS partner;

-- 4.2 rent_* 台账下线（先完成数据并入 contracts + 前端改造，再执行）
-- 数据并入（示意：按 landlord 合并 rent_incomes → 品牌方合同，按站点合并 rent_leases → 场地合同）
-- DROP TABLE IF EXISTS rent_receipts;
-- DROP TABLE IF EXISTS rent_incomes;
-- DROP TABLE IF EXISTS rent_leases;
