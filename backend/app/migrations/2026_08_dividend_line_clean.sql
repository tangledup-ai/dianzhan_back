-- ============================================================
-- 2026_08_dividend_line_clean.sql
-- ③ 股东分红基础信息线 —— 标准表结构（全新安装基准 + 存量库对齐）
--
-- 配套设计文档：DIVIDEND_LINE_DESIGN.md
-- 依赖：stations / brands / shareholders / introducers 已存在（database_init.sql 先行）
-- 幂等：可重复执行（CREATE IF NOT EXISTS / ALTER IF NOT EXISTS / DO 块加约束）
-- 说明：
--   1) 对"全新空库"：本文件直接建出分红线全部表（可作为 database_init.sql
--      分红线部分的替代基准，实施轮再替换）。
--   2) 对"已有库"：后半段做非破坏性对齐（补列/周期映射/约束/注释/索引）。
-- 执行顺序：备份 → 执行本文件 → 执行「第三部分 核对 SQL」→ 确认 0 异常。
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 第一部分：全新安装（CREATE TABLE IF NOT EXISTS）
-- ────────────────────────────────────────────────────────────

-- ── 受益人档案 ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shareholders (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS introducers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ── 分配规则（站点 × 受益人 配置）────────────────────────────

-- 股东分红配置
CREATE TABLE IF NOT EXISTS station_shareholder_configs (
    id SERIAL PRIMARY KEY,
    station_id INTEGER NOT NULL REFERENCES stations(id),
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

-- 介绍人（商务分红）配置
CREATE TABLE IF NOT EXISTS station_introducer_configs (
    id SERIAL PRIMARY KEY,
    station_id INTEGER NOT NULL REFERENCES stations(id),
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

-- ── 唯一键（含生效期：同一受益人 × 同一站可配多段不重叠生效期）──

CREATE UNIQUE INDEX IF NOT EXISTS uq_ssh_conf_whole
    ON station_shareholder_configs (station_id, shareholder_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ssh_conf_brand
    ON station_shareholder_configs (station_id, brand_id, shareholder_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sint_conf_whole
    ON station_introducer_configs (station_id, introducer_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sint_conf_brand
    ON station_introducer_configs (station_id, brand_id, introducer_id, COALESCE(start_date, DATE '1970-01-01'))
    WHERE brand_id IS NOT NULL;

-- ── 字段注释（幂等覆盖）─────────────────────────────────────

COMMENT ON COLUMN station_shareholder_configs.mode              IS '分红模式：收入分红=总收入×比例 / 利润分红=净利润×比例 / 固定金额=fixed_amount';
COMMENT ON COLUMN station_shareholder_configs.ratio             IS '分红比例（小数，0.3=30%）；固定金额模式留空';
COMMENT ON COLUMN station_shareholder_configs.fixed_amount      IS '固定金额（元/期，期长由 settlement_period 决定）；仅固定金额模式使用';
COMMENT ON COLUMN station_shareholder_configs.settlement_period IS '结算周期：月 / 季度 / 半年 / 年（金额 = 基数 × 比例 × 周期倍数）';
COMMENT ON COLUMN station_shareholder_configs.brand_id          IS '空=整站配置（基数=场地总收入/净利润）；非空=绑定品牌配置（基数=该品牌收入/利润）；两类可并存';
COMMENT ON COLUMN station_shareholder_configs.start_date        IS '生效开始（空=1970-01-01，即始终生效；参与唯一键）';
COMMENT ON COLUMN station_shareholder_configs.end_date          IS '生效结束（空=无限期）';
COMMENT ON COLUMN station_introducer_configs.count_as_cost      IS '商务分红是否计入成本：TRUE=先扣商务分红再算股东分红基数；FALSE=单独算不影响股东';

-- ────────────────────────────────────────────────────────────
-- 第二部分：存量库对齐（非破坏性）
-- ────────────────────────────────────────────────────────────

-- 2.1 档案表补审计列
ALTER TABLE shareholders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE introducers  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- 2.2 配置表补列（生效期 + 审计列；兼容历史缺列库）
ALTER TABLE station_shareholder_configs ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE station_shareholder_configs ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE station_shareholder_configs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE station_shareholder_configs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE station_introducer_configs  ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE station_introducer_configs  ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE station_introducer_configs  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE station_introducer_configs  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- 2.3 结算周期口径统一：季 → 季度（幂等）
UPDATE station_shareholder_configs SET settlement_period = '季度' WHERE settlement_period = '季';
UPDATE station_introducer_configs  SET settlement_period = '季度' WHERE settlement_period = '季';

-- 2.4 守卫式 CHECK 约束（仅当存量无违规时才添加，否则留待核对段人工处理）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ssh_mode')
       AND NOT EXISTS (SELECT 1 FROM station_shareholder_configs WHERE mode NOT IN ('收入分红','利润分红','固定金额')) THEN
        ALTER TABLE station_shareholder_configs ADD CONSTRAINT ck_ssh_mode
            CHECK (mode IN ('收入分红','利润分红','固定金额'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ssh_settlement')
       AND NOT EXISTS (SELECT 1 FROM station_shareholder_configs WHERE settlement_period NOT IN ('月','季度','半年','年')) THEN
        ALTER TABLE station_shareholder_configs ADD CONSTRAINT ck_ssh_settlement
            CHECK (settlement_period IN ('月','季度','半年','年'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ssh_fixed')
       AND NOT EXISTS (SELECT 1 FROM station_shareholder_configs
                       WHERE mode = '固定金额' AND fixed_amount IS NULL) THEN
        ALTER TABLE station_shareholder_configs ADD CONSTRAINT ck_ssh_fixed
            CHECK (mode <> '固定金额' OR fixed_amount IS NOT NULL);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ssh_ratio')
       AND NOT EXISTS (SELECT 1 FROM station_shareholder_configs
                       WHERE mode <> '固定金额' AND ratio IS NULL) THEN
        ALTER TABLE station_shareholder_configs ADD CONSTRAINT ck_ssh_ratio
            CHECK (mode = '固定金额' OR ratio IS NOT NULL);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sint_mode')
       AND NOT EXISTS (SELECT 1 FROM station_introducer_configs WHERE mode NOT IN ('收入分红','利润分红','固定金额')) THEN
        ALTER TABLE station_introducer_configs ADD CONSTRAINT ck_sint_mode
            CHECK (mode IN ('收入分红','利润分红','固定金额'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sint_settlement')
       AND NOT EXISTS (SELECT 1 FROM station_introducer_configs WHERE settlement_period NOT IN ('月','季度','半年','年')) THEN
        ALTER TABLE station_introducer_configs ADD CONSTRAINT ck_sint_settlement
            CHECK (settlement_period IN ('月','季度','半年','年'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sint_fixed')
       AND NOT EXISTS (SELECT 1 FROM station_introducer_configs
                       WHERE mode = '固定金额' AND fixed_amount IS NULL) THEN
        ALTER TABLE station_introducer_configs ADD CONSTRAINT ck_sint_fixed
            CHECK (mode <> '固定金额' OR fixed_amount IS NOT NULL);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sint_ratio')
       AND NOT EXISTS (SELECT 1 FROM station_introducer_configs
                       WHERE mode <> '固定金额' AND ratio IS NULL) THEN
        ALTER TABLE station_introducer_configs ADD CONSTRAINT ck_sint_ratio
            CHECK (mode = '固定金额' OR ratio IS NOT NULL);
    END IF;
END $$;

-- 2.5 常用查询索引
CREATE INDEX IF NOT EXISTS idx_ssh_station ON station_shareholder_configs(station_id);
CREATE INDEX IF NOT EXISTS idx_ssh_shareholder ON station_shareholder_configs(shareholder_id);
CREATE INDEX IF NOT EXISTS idx_sint_station ON station_introducer_configs(station_id);
CREATE INDEX IF NOT EXISTS idx_sint_introducer ON station_introducer_configs(introducer_id);

-- ────────────────────────────────────────────────────────────
-- 第三部分：核对 SQL（期望全部 0 行/无输出）
-- ────────────────────────────────────────────────────────────

-- 3.1 非法 mode（应 0 行）
-- SELECT 'ssh' AS t, id, mode FROM station_shareholder_configs WHERE mode NOT IN ('收入分红','利润分红','固定金额')
-- UNION ALL SELECT 'sint', id, mode FROM station_introducer_configs WHERE mode NOT IN ('收入分红','利润分红','固定金额');

-- 3.2 非法结算周期（应 0 行）
-- SELECT 'ssh' AS t, id, settlement_period FROM station_shareholder_configs WHERE settlement_period NOT IN ('月','季度','半年','年')
-- UNION ALL SELECT 'sint', id, settlement_period FROM station_introducer_configs WHERE settlement_period NOT IN ('月','季度','半年','年');

-- 3.3 比例模式缺 ratio / 固定金额模式缺金额（应 0 行）
-- SELECT 'ssh' AS t, id, mode, ratio, fixed_amount FROM station_shareholder_configs
-- WHERE (mode <> '固定金额' AND ratio IS NULL) OR (mode = '固定金额' AND fixed_amount IS NULL)
-- UNION ALL
-- SELECT 'sint', id, mode, ratio, fixed_amount FROM station_introducer_configs
-- WHERE (mode <> '固定金额' AND ratio IS NULL) OR (mode = '固定金额' AND fixed_amount IS NULL);

-- 3.4 生效期重叠（同一受益人同一站区间相交 = 会双算，应人工处理）
-- SELECT a.id AS cfg_a, b.id AS cfg_b, a.station_id, a.shareholder_id,
--        a.start_date, a.end_date, b.start_date, b.end_date
-- FROM station_shareholder_configs a
-- JOIN station_shareholder_configs b
--   ON a.station_id = b.station_id
--  AND a.shareholder_id = b.shareholder_id
--  AND COALESCE(a.brand_id, 0) = COALESCE(b.brand_id, 0)
--  AND a.id < b.id
--  WHERE COALESCE(a.start_date, DATE '1970-01-01') <= COALESCE(b.end_date, DATE '9999-12-31')
--    AND COALESCE(b.start_date, DATE '1970-01-01') <= COALESCE(a.end_date, DATE '9999-12-31');

-- 3.5 ratio 越界（应 0 行；ratio 应为 0~1 的小数）
-- SELECT 'ssh' AS t, id, ratio FROM station_shareholder_configs WHERE ratio > 1 OR ratio < 0
-- UNION ALL SELECT 'sint', id, ratio FROM station_introducer_configs WHERE ratio > 1 OR ratio < 0;

-- ────────────────────────────────────────────────────────────
-- 第四部分：可选增强（杜绝生效期重叠，需先启用 btree_gist 扩展）
-- ────────────────────────────────────────────────────────────

-- 4.1 启用扩展（需超级用户；云库可能不允许）
-- CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 4.2 排除约束：同受益人同站（同品牌范围）的生效期区间不得相交
--     （实施轮确认无误后启用；启用前先跑 3.4 清理存量重叠）
-- ALTER TABLE station_shareholder_configs DROP CONSTRAINT IF EXISTS ex_ssh_no_overlap;
-- ALTER TABLE station_shareholder_configs ADD CONSTRAINT ex_ssh_no_overlap
--     EXCLUDE USING gist (
--         station_id WITH =,
--         shareholder_id WITH =,
--         COALESCE(brand_id, 0) WITH =,
--         daterange(COALESCE(start_date, DATE '1970-01-01'), COALESCE(end_date, DATE '9999-12-31'), '[]') WITH &&
--     );
-- ALTER TABLE station_introducer_configs DROP CONSTRAINT IF EXISTS ex_sint_no_overlap;
-- ALTER TABLE station_introducer_configs ADD CONSTRAINT ex_sint_no_overlap
--     EXCLUDE USING gist (
--         station_id WITH =,
--         introducer_id WITH =,
--         COALESCE(brand_id, 0) WITH =,
--         daterange(COALESCE(start_date, DATE '1970-01-01'), COALESCE(end_date, DATE '9999-12-31'), '[]') WITH &&
--     );
