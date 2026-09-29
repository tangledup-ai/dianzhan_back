# 表结构优化方案 v1（配套 `METER_DOMAIN_V5.md`）

> **依据**：`METER_DOMAIN_V5.md`（业务口径基线，五轮问答确认）。
> **前提**：主人已定 —— ① **新建一个数据库**，在新库里改 ② **先优化表结构 → 再迁移数据** ③ 迁移只带「结构 + 第三方来源的读数」。
> **原则**：**只加不删**（先加列/建表，旧代码不受影响；DEPRECATED 列等引用清干净后最后再删）；**所有关联键统一用 id，不用字符串**。
> 现状依据：`backend/app/database_init.sql`（权威 DDL）。

---

## 实施状态（2026-09-26）

| 项 | 状态 |
|---|---|
| 建库脚本 | ✅ 已生成：**`backend/app/database_init_v5.sql`**（幂等，可重复执行） |
| 数据库 | ✅ 已建：**`huandian_v5`**（PG 容器 `postgres-quant`，127.0.0.1:5432） |
| 执行结果 | ✅ **45 张表 + 4 视图 + 3 个大类字典初值**，零报错 |
| 关键约束 | ✅ `ex_contract_no_overlap`（合同生效期排他）、`fk_meters_third_party_config`、`ck_meter_removed`、`ck_contract_brand`、`ux_readings_meter_period`、`ux_shared_alloc`、`ux_shared_brand`、`ux_elec_records_group`、`ux_rent_records_group`、`ux_cabinet_month`、`ux_meters_device_address` |
| **数据迁移** | ✅ **已完成**：`backend/app/migrate_v2_to_v5.sql`（幂等）<br>· 迁移 **126 电表 / 170 柜子 / 711 行第三方读数 / 19 合同 / 6 分摊行 / 3 品牌绑定**<br>· 舍弃测试数据（台账/分期/分红/审批）<br>· 详见 **`METER_DOMAIN_V5_MIGRATION_REPORT.md`** |
| **派生预填** | ✅ `cabinet_monthly_snapshot` 308 行、`landlord_monthly_elec` 65 行（财务可覆盖） |
| **页面原型** | ✅ `docs/prototype/excel-ui.html`（Excel 风，行内编辑 + 两层筛选 + 批量填值）<br>· 规范见 **`EXCEL_UI_SPEC.md`** |
| 后端适配 | ⬜ 未开始（后端当前仍连 `huandian_v2`；V5 改了表名与列名，需逐模块适配） |

> ⚠️ **注意**：`postgres-quant` 容器此前是**停止状态**，本次已启动。若要长期使用请确认 Docker Desktop 的容器启动策略。

---

---

## 1. 新增表（7 张）

### 1.1 `meter_categories` —— 电表大类字典
```sql
CREATE TABLE meter_categories (
    code        VARCHAR(24) PRIMARY KEY,        -- 'partner' | 'civil' | 'shared' | 以后新增
    name        VARCHAR(50) NOT NULL,           -- '合作商电表' | '民用电表' | '共享电表'
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,  -- 停用后不再可选（旧数据仍可引用）
    sort_order  INTEGER NOT NULL DEFAULT 100,
    remark      TEXT
);
-- ⚠️ 本表不含任何算法开关（大类 = 财务分工标签，不承载算法）
INSERT INTO meter_categories (code,name,sort_order) VALUES
  ('partner','合作商电表',10), ('civil','民用电表',30), ('shared','共享电表',20);
```

### 1.2 `meter_shared_brand_bindings` —— 共享表的品牌绑定清单
```sql
CREATE TABLE meter_shared_brand_bindings (
    id           SERIAL PRIMARY KEY,
    meter_id     INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    brand_id     INTEGER NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    start_period CHAR(6) NOT NULL,        -- 从哪个月起（变动当月生效）
    end_period   CHAR(6),                 -- 到哪个月止（空 = 仍有效）⇒ 没手动改就自动沿袭上月
    remark       TEXT,
    data_source  VARCHAR(16) DEFAULT 'manual',
    updated_by   INTEGER,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ck_binding_period CHECK (end_period IS NULL OR end_period >= start_period),
    CONSTRAINT ux_shared_brand  UNIQUE (meter_id, brand_id, start_period)
);
CREATE INDEX idx_shared_brand_lookup
    ON meter_shared_brand_bindings (meter_id, start_period, end_period);
```
> 用途：① 页面录入分摊时**知道该填哪几个品牌**（未录 ⇒ 告警）；② **历史可复现**（查某月绑了谁）。

### 1.3 `landlord_monthly_elec` —— 场地级月度电费（损耗的载体）
```sql
CREATE TABLE landlord_monthly_elec (
    id           SERIAL PRIMARY KEY,
    landlord_id  INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    period       CHAR(6) NOT NULL,
    ref_kwh      NUMERIC(14,2),      -- 系统算：Σ场地内所有表的实际用电量
    final_kwh    NUMERIC(14,2),      -- 财务填：最终付给场地方老板的电量（默认 = ref_kwh）
    final_amount NUMERIC(14,2),      -- 财务可直接填金额（账单只给钱不给度数时）
    unit_price   NUMERIC(8,4),       -- 场地合同电费单价（快照，便于历史复现）
    loss_kwh     NUMERIC(14,2),      -- 损耗电量 = final_kwh − ref_kwh
    loss_amount  NUMERIC(14,2),      -- 损耗金额 = loss_kwh × unit_price
    data_source  VARCHAR(16) DEFAULT 'auto',
    updated_by   INTEGER,
    remark       TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ux_landlord_month UNIQUE (landlord_id, period)
);
```

### 1.4 `cabinet_monthly_snapshot` —— 柜数月度快照
```sql
CREATE TABLE cabinet_monthly_snapshot (
    id            SERIAL PRIMARY KEY,
    period        CHAR(6) NOT NULL,
    landlord_id   INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    meter_id      INTEGER REFERENCES meters(id) ON DELETE CASCADE,
    brand_id      INTEGER REFERENCES brands(id) ON DELETE RESTRICT,   -- 空 = 无品牌归属（不进分摊分母）
    cabinet_count INTEGER NOT NULL DEFAULT 0,
    source        VARCHAR(16) NOT NULL DEFAULT 'auto',  -- auto=按柜子进/离场日期算 / manual=人工改
    updated_by    INTEGER,
    CONSTRAINT ux_cabinet_month UNIQUE (period, meter_id, brand_id)
);
CREATE INDEX idx_cabinet_month_landlord ON cabinet_monthly_snapshot (landlord_id, period);
```
> 规则：**加柜本月生效 / 减柜下月生效 / 同月加了又退仍算** ⇒ 按 `cabinets.installed_at / removed_at` 与当月区间**相交**即计入。

### 1.5 `period_closings` —— 结账（月度往来对账）
```sql
CREATE TABLE period_closings (
    id          SERIAL PRIMARY KEY,
    period      CHAR(6) NOT NULL,
    side        VARCHAR(8)  NOT NULL CHECK (side IN ('pay','collect')),          -- 应付 / 应收
    target_type VARCHAR(12) NOT NULL CHECK (target_type IN ('landlord','brand')),-- 往来对象类型
    target_id   INTEGER NOT NULL,                                                -- 场地 id 或 品牌 id
    status      VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    closed_at   TIMESTAMPTZ,
    closed_by   INTEGER,
    CONSTRAINT ux_period_closing UNIQUE (period, side, target_type, target_id)
);
```
> 结账**不是锁死**：`closed` 只表示"这个月我核对过了"；要改走「更正」。

### 1.6 `correction_logs` —— 更正历史账单的留痕
```sql
CREATE TABLE correction_logs (
    id         SERIAL PRIMARY KEY,
    table_name VARCHAR(64) NOT NULL,
    row_id     INTEGER     NOT NULL,
    field      VARCHAR(64),           -- 改的是整行时可为空
    old_value  TEXT,
    new_value  TEXT,
    reason     TEXT        NOT NULL,  -- ★ 强制填
    operator   INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_correction_row ON correction_logs (table_name, row_id, created_at DESC);
```

### 1.7 `deposits` —— 押金（独立表）
```sql
CREATE TABLE deposits (
    id               SERIAL PRIMARY KEY,
    contract_id      INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    direction        VARCHAR(4) NOT NULL CHECK (direction IN ('in','out')),
        -- in  = 品牌方交我方（负债/其他应付款）
        -- out = 我方交场地方（资产/其他应收款）
    amount           NUMERIC(12,2) NOT NULL,
    paid_date        DATE,
    refund_date      DATE,
    refund_amount    NUMERIC(12,2),
    forfeited_amount NUMERIC(12,2),   -- 被没收金额（这时才转收入/损失）
    status           VARCHAR(16) NOT NULL DEFAULT 'unpaid'
                     CHECK (status IN ('unpaid','paid','partial_refund','refunded','forfeited')),
    approval_id      INTEGER,
    remark           TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_deposits_contract ON deposits (contract_id);
```
> ⚠️ **押金不进利润、不进分红**。

### 1.8 `rent_records` —— 场租台账（★ 方案 A 已确认）
```sql
CREATE TABLE rent_records (
    id            SERIAL PRIMARY KEY,
    landlord_id   INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
    brand_id      INTEGER REFERENCES brands(id) ON DELETE RESTRICT,
    entity_id     INTEGER REFERENCES entities(id) ON DELETE SET NULL,  -- 只对收入侧有意义
    period        CHAR(6) NOT NULL,
    row_type      VARCHAR(12) NOT NULL DEFAULT 'normal'
                  CHECK (row_type IN ('normal','loss')),
    -- 成本侧（我方付场地方）
    pay_cabinet_count INTEGER,          -- 该品牌当月在场地里的柜数（分摊依据）
    pay_days          INTEGER,          -- 计费天数（不满月用）
    pay_unit_price    NUMERIC(10,2),    -- 每柜月租（按柜数计租时）
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
    profit        NUMERIC(14,2),
    data_source   VARCHAR(16) DEFAULT 'auto',
    updated_by    INTEGER,
    remark        TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_rent_records_group
    ON rent_records (landlord_id, COALESCE(brand_id,0), COALESCE(entity_id,0), period, row_type);
```
> 用途：**场租明细（场地场租台账）**。结构与 `electricity_records` 对称 ⇒ 两张表在报表层合并出「**合计总利润**」。详见第 9 节。

### 1.9（不建）`meter_monthly_payments`
V4 草案里那张"表级付款录入表"**不建** —— 本方案的人工输入落在**读数双轨**上，付款额 = 电量 × 单价（派生值，落台账快照）。

---

## 2. 逐表变更

### 2.1 `meters`（电表档案）
| 动作 | 列 | 说明 |
|---|---|---|
| **加** | `category_code VARCHAR(24) REFERENCES meter_categories(code) NOT NULL DEFAULT 'partner'` | 替代 `tag`；大类 = 财务分工标签 |
| **加** | `is_shared BOOLEAN NOT NULL DEFAULT FALSE` | **是否所有品牌共用一个表**（人工勾选，**不由大类推导**） |
| **加** | `device_address VARCHAR(100)` + 部分唯一索引 | 第三方设备地址（**与 `meter_no` 解耦**，建立后不变） |
| **加** | `third_party_config_id INTEGER REFERENCES third_party_configs(id)` | 该表在哪个第三方账户下 |
| **加** | `initial_reading NUMERIC(14,2)` | 投运起始表码（换表=新建 ⇒ 必需） |
| **加** | `installed_at DATE` / `removed_at DATE` | 生命周期 |
| **加** | `data_source VARCHAR(16)`（auto=接第三方 / manual=自建手工） / `updated_by INTEGER` | 来源与留痕 |
| **改** | `status VARCHAR(20)` → 枚举 `active/inactive/removed` | 配 CHECK：`removed` 必须有 `removed_at`，反之必须为空 |
| **删（后置）** | `tag` | 引用清干净后再删 |

### 2.2 `cabinets`（柜子）★ 结构缺陷最严重
| 动作 | 列 | 说明 |
|---|---|---|
| **加** | `brand_id INTEGER REFERENCES brands(id)` | **加回来**（共享表下的柜子否则永远推不出品牌） |
| **加** | `installed_at DATE` / `removed_at DATE` | 支持"加本月生效/减下月生效+按天折算" |
| **加** | `data_source` / `updated_by` | 留痕 |

### 2.3 `meter_monthly` → `meter_readings`（月度读数）
| 动作 | 列 | 说明 |
|---|---|---|
| **加** | `meter_id INTEGER NOT NULL REFERENCES meters(id)` | 关联键从字符串改为 id |
| **改** | 唯一键 `(address, month_period)` → `(meter_id, month_period)` | 一次消除"改表号变孤儿" |
| **加** | `transformer_ratio_snapshot NUMERIC(10,2)` | **倍数快照**（换倍数不改历史） |
| **加** | `data_source VARCHAR(16)` / `updated_by` | 区分第三方同步 / 人工录入 |
| **保留** | `kwh`（平台值，同步刷新）/ `actual_kwh`（人工值，永不被覆盖） | 算账**永远优先取人工值** |
| **简化建议** | 现有 `prev_actual_reading / curr_actual_reading` 与 `actual_kwh` **两套人工值** | 建议**以 `actual_kwh` 为唯一人工口径**，录表码时算出差后写入 `actual_kwh`（避免两套打架） |
| **保留** | 抄表起止日期**可人工改**，改完本月重算（归属月不变） | — |

### 2.4 `meter_shared_allocations`（共享表品牌分摊）
| 动作 | 列 | 说明 |
|---|---|---|
| **加** | `collect_kwh NUMERIC(14,2)` | 现状**没有**这一列 ⇒ 双向录入物理上做不到 |
| **加** | `input_mode VARCHAR(10) CHECK (input_mode IN ('amount','kwh'))` | 这行录的是金额还是电量 |
| **改** | `collect_amount` 改为**可空**（现状 NOT NULL ⇒ 只能录金额） | 与双向推导配套 |
| **加** | `rent_share NUMERIC(14,2)` | 该品牌分摊到的场地费成本 |
| **加** | `meter_kwh` / `reading_start_date` / `reading_end_date` | 整表读数快照（历史可复现） |
| **加** | `data_source` / `updated_by` | 留痕 |
| **保留** | `cabinet_count` | 共享表的品牌柜数（人工录，逐月可变）✅ |
| **改** | 唯一键 `(address, month_period, brand_id)` → `(meter_id, month_period, brand_id)`；**删 `address`** | 与现状形状一致，仅换键 |

### 2.5 `contracts`（合同）
| 动作 | 列 | 说明 |
|---|---|---|
| **加** | `previous_contract_id INTEGER REFERENCES contracts(id)` | 调价/续签的承接指针（可溯前任） |
| **改行为** | **场地合同允许 `rent_calc_method='按柜子数量'`** | 现状导入时被**强制**成"固定价格" |
| **保留** | `unit_monthly_rent`（单柜月租）/ `rent_amount`（年费）/ `monthly_rent` / `first_month_rent` / `rent_refund` / `early_end_date` | 全部**真实在用** |
| **加约束** | 同 `(landlord_id, COALESCE(brand_id,0))` **生效期不得重叠**（`btree_gist` 排他约束，带 `start_date/end_date`） | 否则调价会出现两份同时生效 |
| **删（后置）** | `partner`（无用列）/ `cabinets_count`（DEPRECATED）/ `pay_status`（DEPRECATED，状态由分期推导） | — |

### 2.6 `rent_payment_schedule` / `rent_income_schedule`（现金流）
| 动作 | 列 | 说明 |
|---|---|---|
| **加** | `period CHAR(6)` | **归属月**（与做账日期分开） |
| **加** | `actual_amount NUMERIC(12,2)` / `actual_date DATE` | **手动调价 / 实付实收** 落在这里（合同值只作系统建议） |
| **加** | `data_source` / `updated_by` | 留痕 |
> 定位不变：这两张表管**现金流**（钱付了没）；**应计**（这个月该记多少）由台账 + 场地级月度表承担。

### 2.7 `electricity_records`（电费台账）
| 动作 | 列 | 说明 |
|---|---|---|
| **加** | `row_type VARCHAR(12) NOT NULL CHECK (row_type IN ('normal','civil','loss'))` | ★ 否则损耗行与民用表行**撞唯一键、物理上共存放不下** |
| **改** | 唯一键 → `(landlord_id, COALESCE(brand_id,0), COALESCE(entity_id,0), period, row_type)` | 加 `row_type` |
| **加** | `meter_category VARCHAR(24)` | 按电表大类筛选 |
| **加** | `updated_by` | 留痕 |
| **口径改** | **成本列不再按主体拆**（`entity_id` 只对**收入**有效） | 现状是成本也按主体拆 |
| **保留** | `electricity_meter_details` 明细表（合计 = 台账） | 正好是"费用绑电表"的载体 |

### 2.8 其余小改
| 表 | 动作 |
|---|---|
| `operating_expenses` | 加 `data_source` / `updated_by`；**口径改**：`entity_id` 为空 ⇒ **不分摊** |
| `third_party_configs` | 加 `is_active BOOLEAN DEFAULT TRUE`（停用/启用） |
| `meter_devices` | 保留（第三方快照）；设备关系**上提到 `meters.device_address` / `third_party_config_id`** |

---

## 3. 关联键统一（一次性收口）

| 表 | 现状 | 改为 |
|---|---|---|
| `meter_monthly` | `address` 字符串 ↔ `meters.meter_no` | `meter_id` 外键 |
| `meter_shared_allocations` | `address` + `meter_id` 并存，唯一键建在 `address` | **只留 `meter_id`** |
| `meters` | `meter_no` **兼职**设备地址 | 拆 `device_address` |

---

## 4. 约束与索引要点

- `meter_categories`：无算法开关；`is_active` 控制可选性。
- `meters`：`device_address` 部分唯一（`WHERE device_address IS NOT NULL`）；`status='removed'` 与 `removed_at` 一致性 CHECK。
- `meter_shared_brand_bindings`：`UNIQUE(meter_id, brand_id, start_period)`（同表同品牌同一起始月只能一条 ⇒ 历史可复现）。
- `contracts`：同 (场地, 品牌) 生效期**排他约束**。
- `electricity_records`：唯一键**必须含 `row_type`**。
- 所有可编辑业务表：统一补 `data_source` + `updated_by` + `updated_at`（系统不只一个人在用）。

---

## 5. 实施顺序（**先结构、后数据**）

```
第 1 步  建字典表 + 新增列（is_shared / device_address / initial_reading / installed_at / removed_at / data_source / updated_by …）
         —— 只加不改，旧代码照跑
第 2 步  建新表（meter_categories / meter_shared_brand_bindings / landlord_monthly_elec /
                cabinet_monthly_snapshot / period_closings / correction_logs / deposits）
第 3 步  cabinets 补 brand_id + 进/离场日期；能动规则推的先回填（普通表 = 表上的品牌）
第 4 步  切换关联键（meter_monthly.address → meter_id；分摊表去掉 address）
第 5 步  electricity_records 加 row_type + meter_category，重做唯一索引（★ 与旧数据清算同时做）
第 6 步  合同加排他约束（★ 必须先清掉区间重叠的测试数据）
第 7 步  清理 DEPRECATED 列（tag / contracts.partner / cabinets_count / pay_status 等）
——— 到这里结构就绪，再开始迁移数据（只迁结构 + 第三方来源读数） ———
```

---

## 6. 待主人拍板 / 需注意的风险

| # | 事项 | 我的建议 |
|---|---|---|
| S1 | 柜数快照：**系统按柜子进/离场日期算出来落表**，还是**人工直接填**？ | 系统算 + 落表 + 可人工覆盖（覆盖走更正留痕） |
| S2 | `meter_readings` 人工值保留**一套**（`actual_kwh`），表码只作录入方式？ | 是（否则两套人工值会打架） |
| S3 | 台账要不要真的**存 `profit` 快照**？（现状存了） | 存（报表要按已结账数字复现） |
| S4 | `landlord_monthly_elec.unit_price` 要不要**快照**（合同调价后历史可复现）？ | 要 |
| S5 | 结账的 `target_type` 只有 `landlord` / `brand` 够不够？（要不要按电表大类分别结？） | 先用两类，不够再加 |
| S6 | **第 5、6 步会与现有数据冲突**（唯一键、合同区间重叠）—— 按主人定的"测试数据不迁"，建议**直接在新库建房、旧库只做只读备份** | 是 |
| S7 | 新库要不要**保留旧表**（`meter_daily/hourly/yearly/status_cache/warnings_cache/meter_collectors`）？ | 保留（纯展示缓存，不参与算账） |

---

## 7. 需要清理的 DEPRECATED 清单（最后一步做）

| 对象 | 现状注释 |
|---|---|
| `contracts.partner` | "DEPRECATED 无用列（无代码写入），收尾删除" |
| `contracts.cabinets_count` | "DEPRECATED：计费柜数唯一源=实时统计 meters→cabinets" |
| `contracts.pay_status` | "DEPRECATED：业务读分期推导值" |
| `meters.tag` | 被 `category_code` 取代 |
| `stations` | 早已废弃（v3） |

---

## 8. 新增需求 A：按品牌「筛选电表 + 批量维护实际值」

**主人要的**：筛出某个品牌的**所有电表**，一次性更新它们的**真实电表值**。

**现状能不能**：

| 能力 | 现状 | 结论 |
|---|---|---|
| 筛出"该品牌自己的表" | `meters.brand_id` 可以 | ✅ 能 |
| **筛出"该品牌参与分摊的共享表"** | ❌ 既没有"是否共用一个表"的标记，也没有"共享表 ↔ 品牌"绑定 | ❌ **不能**（只能按月翻 `meter_shared_allocations` 反推，某月没录就断） |
| 写"实际值" | `meter_monthly.actual_kwh`（人工值，同步不覆盖，算账优先取） | ✅ 结构通 |
| **批量**录入/更新 | 现状是单条 / 弹窗录入 | ❌ 没有批量界面 |
| 更新留痕 | ❌ 没有 | 需补 |

**⚠️ 概念提醒（很重要）**："给某品牌的所有电表更新真实值"实际是**两种不同操作**：

| 表类型 | 改什么 |
|---|---|
| 该品牌**自有表** | 改**表读数**（`actual_kwh`） |
| **共享表** | **不能改表读数**（那是整表的）⇒ 只能改**它在分摊行里的电量/金额** |

⇒ 批量维护界面必须**分开处理这两类**。

**依赖**：① `meters.is_shared` ② `meter_shared_brand_bindings` ③ 页面按品牌筛选 + 批量提交 ④ `correction_logs` 留痕。

---

## 9. 新增需求 B：电费明细 / 场租明细 / 合计总利润

**主人要的**：
1. 利润明细
2. 电费明细
3. **场地场租台账 + 电费台账 合并**的总利润明细

| 要的东西 | 现状 | 结论 |
|---|---|---|
| **电费明细** | ✅ `electricity_records`（场地×品牌×主体×月：应付/应收/税/净额/利润）+ `electricity_meter_details`（下钻到表） | **能用**；补 `row_type` / `meter_category`，改掉"成本按主体拆" |
| **场租明细（场地场租台账）** | ❌ **没有独立表** —— 场租**全是现算**（`dividend_calc` / `api/rent.py` 每次算），只在分红里汇总成两个数 | ★ **要新建一张「场租台账」表** |
| **合计总利润明细** | ⚠️ 部分有：`dividend_records`（场景×品牌×月：`elec_income / rent_income / elec_cost / rent_cost / op_expense / profit`） | 汇总口径**已有**，但它是"**分红月结快照**"（不生成就没有），**不是明细台账** |

### 建议方案（推荐 A）

**方案 A —— 两张对称台账 + 一个汇总视图**

```sql
-- 新增：场租台账（结构与 electricity_records 对称）
CREATE TABLE rent_records (
    id            SERIAL PRIMARY KEY,
    landlord_id   INTEGER NOT NULL REFERENCES landlords(id),
    brand_id      INTEGER REFERENCES brands(id),
    entity_id     INTEGER REFERENCES entities(id),   -- 只对收入侧有意义
    period        CHAR(6) NOT NULL,
    row_type      VARCHAR(12) NOT NULL,              -- normal / loss / (其他)
    -- 成本侧（我方付场地方）
    pay_cabinet_count INTEGER,
    pay_days          INTEGER,
    pay_unit_price    NUMERIC(10,2),
    pay_amount        NUMERIC(14,2),
    pay_status        VARCHAR(20),
    -- 收入侧（向品牌收）
    collect_cabinet_count INTEGER,
    collect_days          INTEGER,
    collect_unit_price    NUMERIC(10,2),
    collect_amount        NUMERIC(14,2),
    collect_tax_rate      NUMERIC(6,4),
    collect_net           NUMERIC(14,2),
    collect_status        VARCHAR(20),
    profit        NUMERIC(14,2),
    data_source   VARCHAR(16) DEFAULT 'auto',
    updated_by    INTEGER,
    remark        TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

- **电费明细** = `electricity_records`（已有，小改）
- **场租明细** = `rent_records`（新增）
- **合计总利润明细** = 两张表在**报表层合并**（按 场地×品牌×主体×月 对齐），得到三视图：
  - 电费明细（支出 / 收入 / 损耗）
  - 场租明细（付场地方 / 从品牌收）
  - **合计总利润**（两本台账合并 + 运营费 + 退款 → 与 `dividend_records` 对得上）
- `dividend_records` **继续只做"分红月结快照"**，不承担明细职责。

**方案 B（不推荐）**：做一张大表 `monthly_settlements`（月 × 场地 × 品牌 × 主体 × 项目[电费/场租]）—— 电费的"量"是电量/单价，场租的"量"是柜数/天数，强行合并会有大量空列。

> **状态**：✅ **主人已确认方案 A**（2026-09-26）⇒ `rent_records` 升为正式新增表（见 **1.8** 节 DDL）；电费台账继续用 `electricity_records`（小改）；`dividend_records` 只做分红月结快照。

### 三张视图的最终形态

| 视图 | 数据来源 | 展示 |
|---|---|---|
| **电费明细** | `electricity_records` + `electricity_meter_details` | 电费支出 / 电费收入 / **损耗** |
| **场租明细** | `rent_records` | 付给场地方的成本 / 从品牌方收的收入 |
| **合计总利润** | 上面两张按 (场地×品牌×主体×月) 合并 + 运营费 + 退款 | 与 `dividend_records` 对得上 |
