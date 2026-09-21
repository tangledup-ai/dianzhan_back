-- ============================================================
-- schema_sync.sql —— 存量库结构同步（每次后端启动自动执行）
-- ============================================================
-- 背景：database_init.sql 的 CREATE TABLE IF NOT EXISTS 不会给已存在的旧表补新列；
--       老库升级后新代码 INSERT/SELECT 引用新列会报错（如新建电表 400）。
--       本文件由 init_database() 逐条执行，单条失败只记日志不影响其他语句。
-- 原则：只加列 / 加表 / 加索引，绝无 DELETE / DROP / 改列类型；
--       数据回填只填空（NULL），不覆盖已有值；全部语句幂等，可重复执行。
--       一次性/含清理的迁移仍在 migrations/ 目录手工执行。
-- ============================================================

-- ── 1) meters（v3：直挂场地方 + 公司主体继承）────────────────
ALTER TABLE meters ADD COLUMN IF NOT EXISTS landlord_id INTEGER;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS entity_id INTEGER;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS entity_source VARCHAR(10);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS tag VARCHAR(20) NOT NULL DEFAULT '合作商电表';
ALTER TABLE meters ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT '正常';
ALTER TABLE meters ADD COLUMN IF NOT EXISTS transformer_ratio NUMERIC(10,2) NOT NULL DEFAULT 1;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS meter_name VARCHAR(200);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS collector_id VARCHAR(100);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS remark TEXT;

-- 主体来源回填：已有主体的电表视为显式设置（只填 NULL，不覆盖已有值）
UPDATE meters SET entity_source = 'manual' WHERE entity_id IS NOT NULL AND entity_source IS NULL;

-- 无主体电表按「场地方最新一份场地合同」继承主体（只填空，不覆盖已有关联）
UPDATE meters m
SET entity_id = c.entity_id, entity_source = 'auto'
FROM contracts c
WHERE m.landlord_id IS NOT NULL
  AND m.entity_id IS NULL
  AND c.contract_type = '场地合同'
  AND c.entity_id IS NOT NULL
  AND c.landlord_id = m.landlord_id
  AND c.id = (
    SELECT c2.id FROM contracts c2
    WHERE c2.landlord_id = m.landlord_id
      AND c2.contract_type = '场地合同'
      AND c2.entity_id IS NOT NULL
    ORDER BY c2.id DESC
    LIMIT 1
  );

-- ── 2) platform_users（财务按电表类型隔离）──────────────────
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS meter_tag_scope VARCHAR(20);

-- ── 3) contracts（押金退还 / 合同预警已处理）─────────────────
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_amount NUMERIC(12,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_date DATE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_refund_approval_id INTEGER;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS alert_handled_at TIMESTAMPTZ;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS alert_handled_sig TEXT;

-- ── 4) approval_requests（关联合同：场地费退款审批回写用）────
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS contract_id INTEGER;

-- ── 5) electricity_records（台账数据来源 auto/manual）────────
ALTER TABLE electricity_records ADD COLUMN IF NOT EXISTS data_source VARCHAR(16) DEFAULT 'auto';

-- ── 6) meter_monthly（人工实际读数，同步不覆盖）──────────────
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS actual_kwh NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS prev_actual_reading NUMERIC(14,2);
ALTER TABLE meter_monthly ADD COLUMN IF NOT EXISTS curr_actual_reading NUMERIC(14,2);

-- ── 7) 合同审计日志（老库缺表时补建）────────────────────────
CREATE TABLE IF NOT EXISTS contract_audit_log (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL,
    action VARCHAR(16) NOT NULL,
    changes JSONB,
    operator VARCHAR(64),
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_audit_contract ON contract_audit_log (contract_id, created_at DESC);

-- ── 8) 场地方多业主子表（老库缺表时补建）────────────────────
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

-- 存量联系人迁移为业主记录（幂等：已存在同名业主则跳过）
INSERT INTO landlord_owners (landlord_id, owner_name, phone, remark)
SELECT l.id, l.contact, l.phone, '存量业主（自动迁移）'
FROM landlords l
WHERE l.contact IS NOT NULL AND l.contact <> ''
  AND NOT EXISTS (SELECT 1 FROM landlord_owners o WHERE o.landlord_id = l.id AND o.owner_name = l.contact);

-- ── 9) electricity_records 加公司主体维度（三元分组：场地×品牌×主体）──
-- 归属原则：电费按电表的 meters.entity_id 归属（一表一主体）。
ALTER TABLE electricity_records ADD COLUMN IF NOT EXISTS entity_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_elec_records_entity ON electricity_records(entity_id);

-- 存量回填：按明细电表的主体众数归属（只填空 NULL，不覆盖已有值；跨主体的旧行下次重生成时自动拆行）
UPDATE electricity_records e
SET entity_id = (
    SELECT m.entity_id FROM electricity_meter_details d
    JOIN meters m ON m.id = d.meter_id
    WHERE d.electricity_id = e.id AND m.entity_id IS NOT NULL
    GROUP BY m.entity_id ORDER BY COUNT(*) DESC, m.entity_id LIMIT 1
)
WHERE e.entity_id IS NULL;

-- 旧「场地×品牌×月」唯一约束/唯一索引会拦截同场地同品牌的跨主体拆行，必须移除；
-- 唯一性改由下方表达式索引承担（COALESCE 让可空的 brand/entity 参与 != 比较）。
-- 不依赖具体名字（各库建的约束/索引名不同），按"列组恰好 = landlord+brand+period 的唯一键"识别。
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT c.conname AS name, NULL::text AS schema, 'CONSTRAINT' AS kind
        FROM pg_constraint c
        WHERE c.conrelid = 'electricity_records'::regclass AND c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(c.conkey) k
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
              = ARRAY['brand_id', 'landlord_id', 'period']::text[]
        UNION ALL
        SELECT i.relname AS name, ns.nspname AS schema, 'INDEX' AS kind
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_namespace ns ON ns.oid = i.relnamespace
        WHERE x.indrelid = 'electricity_records'::regclass AND x.indisunique AND NOT x.indisprimary
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(x.indkey::smallint[]) k
               JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k)
              = ARRAY['brand_id', 'landlord_id', 'period']::text[]
    LOOP
        IF r.kind = 'CONSTRAINT' THEN
            EXECUTE format('ALTER TABLE electricity_records DROP CONSTRAINT %I', r.name);
        ELSE
            EXECUTE format('DROP INDEX %I.%I', r.schema, r.name);
        END IF;
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_elec_records_group
    ON electricity_records (landlord_id, COALESCE(brand_id, 0), COALESCE(entity_id, 0), period);

-- ── 10) 电表换主体审计（回答"这块表某月为什么算到某主体"）────────
CREATE TABLE IF NOT EXISTS meter_entity_changes (
    id SERIAL PRIMARY KEY,
    meter_id INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    meter_no VARCHAR(100),
    from_entity_id INTEGER,
    to_entity_id INTEGER,
    operator VARCHAR(64),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meter_entity_changes_meter ON meter_entity_changes (meter_id, created_at DESC);

-- ── 11) entities 报税法人档案补全 ────────────────────────────
ALTER TABLE entities ADD COLUMN IF NOT EXISTS tax_no VARCHAR(50);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS taxpayer_type VARCHAR(20);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS invoice_bank VARCHAR(200);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS invoice_account VARCHAR(100);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS invoice_address VARCHAR(300);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS invoice_phone VARCHAR(50);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT '启用';
ALTER TABLE entities ADD COLUMN IF NOT EXISTS sort INTEGER DEFAULT 0;
UPDATE entities SET status = '启用' WHERE status IS NULL;

-- ── 12) operating_expenses 按主体（entity_id NULL=场地公共，按柜数分摊）──
ALTER TABLE operating_expenses ADD COLUMN IF NOT EXISTS entity_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_op_expenses_entity ON operating_expenses(entity_id);

-- 旧「场地×月」唯一键（约束或唯一索引，名字因库而异）按列组识别后移除：
-- 同场地同月允许 公共(一条)+各主体(各一条) 多笔并存，防重由应用层按 (场地,月,主体) upsert 承担
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT c.conname AS name, NULL::text AS schema, 'CONSTRAINT' AS kind
        FROM pg_constraint c
        WHERE c.conrelid = 'operating_expenses'::regclass AND c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(c.conkey) k
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
              = ARRAY['landlord_id', 'period']::text[]
        UNION ALL
        SELECT i.relname AS name, ns.nspname AS schema, 'INDEX' AS kind
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_namespace ns ON ns.oid = i.relnamespace
        WHERE x.indrelid = 'operating_expenses'::regclass AND x.indisunique AND NOT x.indisprimary
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(x.indkey::smallint[]) k
               JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k)
              = ARRAY['landlord_id', 'period']::text[]
    LOOP
        IF r.kind = 'CONSTRAINT' THEN
            EXECUTE format('ALTER TABLE operating_expenses DROP CONSTRAINT %I', r.name);
        ELSE
            EXECUTE format('DROP INDEX %I.%I', r.schema, r.name);
        END IF;
    END LOOP;
END $$;

-- ── 13) 品牌方合同支持按主体拆签（D4）────────────────────────
-- 旧 (场地×品牌×租期) 唯一键按列组识别删除（列组含 brand_id，不会误删场地合同的 uq_contracts_venue），
-- 新键加入主体：同场地同品牌不同主体可各签一份，收付款主体与运营主体对齐。
-- 拆签后电价/租金按电表主体精确匹配（electricity_pricing.brand_price_for），报表层柜数拆分退为兜底。
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT c.conname AS name, NULL::text AS schema, 'CONSTRAINT' AS kind
        FROM pg_constraint c
        WHERE c.conrelid = 'contracts'::regclass AND c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(c.conkey) k
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
              = ARRAY['brand_id', 'end_date', 'landlord_id', 'start_date']::text[]
        UNION ALL
        SELECT i.relname AS name, ns.nspname AS schema, 'INDEX' AS kind
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_namespace ns ON ns.oid = i.relnamespace
        WHERE x.indrelid = 'contracts'::regclass AND x.indisunique AND NOT x.indisprimary
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(x.indkey::smallint[]) k
               JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k)
              = ARRAY['brand_id', 'end_date', 'landlord_id', 'start_date']::text[]
    LOOP
        IF r.kind = 'CONSTRAINT' THEN
            EXECUTE format('ALTER TABLE contracts DROP CONSTRAINT %I', r.name);
        ELSE
            EXECUTE format('DROP INDEX %I.%I', r.schema, r.name);
        END IF;
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contracts_brand_split
    ON contracts (landlord_id, COALESCE(brand_id, 0), COALESCE(entity_id, 0), start_date, end_date)
    WHERE contract_type = '品牌方合同';

-- ── 14) 电表换主体支持生效月（三期：时点维度）────────────────
-- effective_period = 台账从该月（6 位 YYYYMM）起归新主体；NULL=立即（全量重算）
ALTER TABLE meter_entity_changes ADD COLUMN IF NOT EXISTS effective_period VARCHAR(6);

-- ── 15) 分红配置/明细支持按主体（三期：主体分红基数）──────────
-- 配置 entity_id：NULL=不按主体（沿用 整场地/按品牌）；非空=以该主体在该场地的收入/利润为基数
-- （与品牌同时配置时品牌优先——品牌是更细维度，主体基数供跨品牌归集场景）
ALTER TABLE landlord_shareholder_configs ADD COLUMN IF NOT EXISTS entity_id INTEGER;
ALTER TABLE landlord_introducer_configs ADD COLUMN IF NOT EXISTS entity_id INTEGER;
ALTER TABLE dividend_shares ADD COLUMN IF NOT EXISTS entity_id INTEGER;

-- ── 16) 合同分期自动拆期开关 ─────────────────────────────────
-- TRUE（默认）：保存合同时按「场地收付款方式 × 起止日期」自动拆出每期与应收应付；
-- FALSE：不自动拆期，由用户在合同列表展开该合同后「+ 添加一期」手动录入
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS auto_split BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 17) 共享电表品牌分摊（「所有品牌共用此电表」时按品牌录入应付电费）──
-- 电表 tag='共享电表' 且 brand_id 为空 = 场地总表，无法用「某品牌用电量 × 单价」算电费；
-- 改为按 电表×月份×品牌 人工录入收款金额，用电量 = 金额 ÷ 单价 倒推。
-- 某表某月无分摊行时，台账仍按原口径（读数 × 合同单价）整场地出一行。
CREATE TABLE IF NOT EXISTS meter_shared_allocations (
    id SERIAL PRIMARY KEY,
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    address VARCHAR(100) NOT NULL,
    month_period VARCHAR(6) NOT NULL,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    entity_id INTEGER REFERENCES entities(id),
    collect_amount NUMERIC(14,2) NOT NULL,
    unit_price NUMERIC(8,4),
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(address, month_period, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_period ON meter_shared_allocations(month_period);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_meter ON meter_shared_allocations(meter_id);
CREATE INDEX IF NOT EXISTS idx_shared_alloc_brand ON meter_shared_allocations(brand_id);

-- 电柜数量：某品牌当月在该共享电表（场地总表）下投放的柜数。
-- 逐月可动态调整（柜子会增减），所以落「电表×月份×品牌」维度，不做全局唯一值。
-- 录入时留空 = 自动沿用该品牌最近一次填写值（前端预填，不落库）。
ALTER TABLE meter_shared_allocations ADD COLUMN IF NOT EXISTS cabinet_count INTEGER;
COMMENT ON COLUMN meter_shared_allocations.cabinet_count IS '该品牌当月在此共享电表下投放的电柜数量（逐月可变，可为空）';
