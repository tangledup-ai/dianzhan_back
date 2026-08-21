# ③ 股东分红基础信息线 — 表结构设计文档

> 状态：**设计完成**（2026-08，本轮只定表结构；不涉及业务代码与 mock 改动）
> 配套建表 SQL：`backend/app/migrations/2026_08_dividend_line_clean.sql`
> 关联文档：`THREE_SOURCE_LINES.md`（总纲）、`DATA_GOVERNANCE.md`（P6）、`PROJECT_UNDERSTANDING.md`（§七 分红体系）

---

## 一、主线定位

**股东分红基础信息线是整个系统的"分配规则"来源**：回答三个问题——**分给谁**（股东/介绍人）、**按什么分**（收入/利润/固定金额）、**按什么比例/金额、什么周期、什么时候生效**。

电表线提供"度数"、合同线提供"单价/租金"，两者算出"净利润"后，**这条线决定利润怎么分**。

### 两类受益人

| 类型 | 表 | 角色 | 计算顺序 |
|---|---|---|---|
| **介绍人（商务分红）** | `introducers` + `station_introducer_configs` | 商务关系人，介绍站点资源 | **先算**；可配置是否计入成本（`count_as_cost`） |
| **股东（股东分红）** | `shareholders` + `station_shareholder_configs` | 投资人 | **后算**（基数 = 净利润，商务分红若计入成本则先扣） |

### 数据流全景

```
人工维护（Directory 档案 + Shareholders 配置弹窗）
  ▼
shareholders / introducers（受益人档案）
  ▼ 每站点 × 每受益人 配置
station_shareholder_configs / station_introducer_configs（分配规则）
  │  mode=收入分红|利润分红|固定金额；ratio / fixed_amount
  │  settlement_period=月|季度|半年|年；start_date/end_date 生效期
  ▼
dividend_calc（分红计算器，读 ①线度数 × ②线单价 算出的收入成本）
  ▼
dividend_records（月结）+ dividend_shares（明细快照，落 mode/ratio/amount）
```

---

## 二、现状问题核验（本线要解决的"杂乱"）

| # | 问题 | 证据 | 本设计如何处理 |
|---|---|---|---|
| D1 | **配置表 schema 曾漂移**：`database_init.sql` 原建表无 `start_date/end_date` 列，代码在写、UI 在配；已由 `2026_08_schema_alignment.sql` + `2026_08_dividend_config_effective_period.sql` 补齐并重构唯一键 | `DATA_GOVERNANCE.md` P6 | 以"含生效期"为最终形态，唯一键 = `(站点, 受益人, [品牌], COALESCE(start_date,'1970-01-01'))`；建表 SQL 固化 |
| D2 | **mode 枚举无约束**：`mode` 存中文，代码只认 `收入分红/利润分红/固定金额`，库层无 CHECK | `dividend_calc.py:576-583` | 加 CHECK 约束；存量非法值核对 |
| D3 | **结算周期口径不统一**：文档写"月/季/半年/年"，代码用 `月/季度/半年/年`（`_get_period_multiplier`），旧数据可能有"季" | `dividend_calc.py:669-691`；`Shareholders.tsx:177-180` | **统一 `月 / 季度 / 半年 / 年`**；存量"季"映射为"季度" |
| D4 | **ratio/fixed_amount 与 mode 联动无约束**：固定金额模式 ratio 应为空、比例模式 fixed_amount 应为空，库层不管 | `Shareholders.tsx:105-106` | 加守卫式 CHECK（先核对存量，无违规再加） |
| D5 | **配置表缺审计列**：两张 config 表无 `created_at/updated_at` | `database_init.sql` 建表定义 | 补 `created_at` / `updated_at`（DEFAULT NOW()，不破坏现有写入） |
| D6 | **brand_id 语义未文档化**：空 = 整站配置，非空 = 绑定品牌配置；两类并存且各自参与计算 | `dividend_calc.py:546-660` | 本文档固化语义（见 §四.5） |
| D7 | **生效期重叠无防呆**：唯一键只防"同起点重复"，不防"区间重叠"（1-3月 与 2-4月 并存会双算） | `2026_08_dividend_config_effective_period.sql` | 文档给出重叠核对 SQL + 可选排除约束（EXCLUDE USING gist）升级方案 |

---

## 三、目标表结构

### `shareholders` — 股东档案

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| name | VARCHAR(100) NOT NULL | 股东姓名 |
| phone | VARCHAR(50) | 联系电话 |
| remark | TEXT | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | 审计列（本设计补齐） |

> 被引用方：`station_shareholder_configs.shareholder_id`、`dividend_shares.shareholder_id`、`platform_users.shareholder_id`（股东角色登录）。

### `introducers` — 介绍人档案

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| name | VARCHAR(100) NOT NULL | 介绍人姓名 |
| phone | VARCHAR(50) | |
| remark | TEXT | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | 审计列（本设计补齐） |

### `station_shareholder_configs` — 站点 × 股东 分红配置（分配规则主表）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| station_id | INTEGER FK → stations(id) **NOT NULL** | 站点 |
| shareholder_id | INTEGER FK → shareholders(id) **NOT NULL** | 股东 |
| brand_id | INTEGER FK → brands(id) | **空 = 整站配置；非空 = 绑定品牌配置**（两类可并存） |
| mode | VARCHAR(20) **NOT NULL** | **`收入分红` / `利润分红` / `固定金额`**（CHECK） |
| ratio | NUMERIC(6,4) | 分红比例（**小数**，如 0.3 = 30%）；固定金额模式为空 |
| fixed_amount | NUMERIC(12,2) | 固定金额（元/期）；仅固定金额模式使用 |
| settlement_period | VARCHAR(10) NOT NULL DEFAULT '月' | **`月` / `季度` / `半年` / `年`**（CHECK） |
| start_date | DATE | 生效开始（**空 = 1970-01-01，即始终生效**） |
| end_date | DATE | 生效结束（空 = 无限期） |
| remark | VARCHAR(200) | |
| created_at | TIMESTAMP DEFAULT NOW() | 审计列（本设计补齐） |
| updated_at | TIMESTAMP DEFAULT NOW() | 审计列（本设计补齐） |

**唯一键（含生效期，同一股东同一站可配多段不重叠生效期）**
- 整站：`UNIQUE(station_id, shareholder_id, COALESCE(start_date,'1970-01-01')) WHERE brand_id IS NULL`
- 品牌：`UNIQUE(station_id, brand_id, shareholder_id, COALESCE(start_date,'1970-01-01')) WHERE brand_id IS NOT NULL`

### `station_introducer_configs` — 站点 × 介绍人 商务分红配置

与股东配置结构一致，多一列：

| 字段 | 类型 | 说明 |
|---|---|---|
| count_as_cost | BOOLEAN DEFAULT FALSE | **商务分红是否计入成本**：TRUE = 先扣商务分红再算股东分红基数；FALSE = 单独算、不影响股东 |

**唯一键**：同股东配置（introducer_id 替代 shareholder_id）。

> 通用 CHECK（两张表相同，SQL 中守卫式添加）：
> - `mode IN ('收入分红','利润分红','固定金额')`
> - `settlement_period IN ('月','季度','半年','年')`
> - `(mode <> '固定金额') OR (fixed_amount IS NOT NULL)`（固定金额模式必须填金额）
> - `(mode = '固定金额') OR (ratio IS NOT NULL)`（比例模式必须填比例）

---

## 四、口径规则（本线核心约定）

### 4.1 分红模式（mode）
| mode | 基数 | 公式 | 备注 |
|---|---|---|---|
| `收入分红` | 总收入（电费收款 + 租金收款） | 基数 × ratio | 不看成本 |
| `利润分红` | 净利润（总收入 − 总成本） | 基数 × ratio | 股东默认模式；商务分红先算后是否扣成本看 count_as_cost |
| `固定金额` | — | fixed_amount | 不看收入成本，直接给 |

### 4.2 结算周期（settlement_period）与周期倍数
| 值 | 倍数（对单月基数） |
|---|---|
| `月` | ×1 |
| `季度` | ×3 |
| `半年` | ×6 |
| `年` | ×12 |

> 计算规则：`金额 = 基数 × ratio（或 fixed_amount） × 周期倍数`（`dividend_calc._get_period_multiplier`）。

### 4.3 ratio 与 fixed_amount
- `ratio` 存**小数**（0~1），UI 输入百分比后 /100 落库；0.3 = 30%。
- `fixed_amount` 单位为元（/期，期长由 settlement_period 决定）。
- 与 mode 联动：固定金额模式 ratio 留空；比例模式 fixed_amount 留空。

### 4.4 生效期（start_date / end_date）
- 过滤规则（`_filter_configs_by_period`）：`start_date 为空 或 ≤ 当月`，且 `end_date 为空 或 ≥ 当月` 的配置参与当月计算。
- **空 start_date 在唯一键中等价 1970-01-01**（一条"永久生效"的整站配置）。
- 建议：同一受益人在同一站的各段生效期**不重叠**（重叠 = 双算）；核对 SQL 见建表 SQL 第三部分。

### 4.5 brand_id 语义（整站配置 vs 品牌配置）
- `brand_id IS NULL`：整站分红——基数 = 场地总收入 / 场地净利润，对所有品牌生效。
- `brand_id IS NOT NULL`：绑定品牌的分红——基数 = 该品牌的收入 / 品牌利润。
- **两者可并存、各自计算**（整站股东 + 绑定品牌的介绍人等组合场景）。

### 4.6 商务分红与成本（count_as_cost）
```
① 算总收入 = 电费收款 + 租金收款
② 算基础成本 = 电费成本 + 场地租金 + 运营费用
③ 商务分红（介绍人）
   - count_as_cost = TRUE：基数 = ①−②，金额 = 基数×ratio；总成本 = ② + 商务分红金额
   - count_as_cost = FALSE：金额单独算，不进成本
④ 净利润 = ① − 总成本
⑤ 股东分红：收入分红 = ①×ratio；利润分红 = ④×ratio；固定金额 = fixed_amount
```

### 4.7 派生快照（dividend_shares）
- 生成分红记录时，把生效配置的 `mode / ratio / fixed_amount` **快照**进 `dividend_shares`，与 `amount` 一并落库——**历史分红不受后续改配置影响**。
- 本线只负责"配置是规则源"，快照落在派生层。

---

## 五、与①线 / ②线 / 派生层的衔接

| 消费方 | 读本线哪些表 | 公式 |
|---|---|---|
| `dividend_calc` 分红预估/生成 | configs（过滤生效期后按 mode/ratio/fixed_amount 计算） | 见 §四 |
| `dividend_shares` 明细快照 | configs 的 mode/ratio/fixed_amount | 快照复制 |
| `platform_users` 登录 | shareholders.id | 股东角色权限（仅看关联场地分红） |
| Shareholders 页配置/汇总 | configs + ①线度数 + ②线单价 | 全链路最深页面 |

---

## 六、建表 SQL 说明

- 文件：`backend/app/migrations/2026_08_dividend_line_clean.sql`
- **全新安装**：直接执行（幂等），可作为 `database_init.sql` 分红线部分的替代/基准（实施轮替换）。
- **存量库对齐**：补 `created_at/updated_at`、`start_date/end_date`（幂等）、"季→季度"映射、守卫式 CHECK、注释、唯一索引（与 #8 迁移同款，`IF NOT EXISTS` 幂等）。
- **核对 SQL**：非法 mode/结算周期、ratio 越界、比例模式缺 ratio、固定金额模式缺金额、生效期重叠。
- **可选增强**（注释段，需 `btree_gist` 扩展）：`EXCLUDE USING gist (station_id WITH =, shareholder_id WITH =, daterange(start_date, end_date) WITH &&)` 从库层杜绝重叠。

## 七、遗留（本轮不动，后续处理）

1. 生效期重叠的**应用层校验**（提交配置时弹窗提示）或启用 §六 的排除约束。
2. `dividend_records` / `dividend_shares` 派生表的结构文档（属派生层，待三条主线定稿后统一出"派生层设计"）。
3. `platform_users` 股东角色的 `landlord_ids` 与 shareholders 的联动规则（属权限，非本线表结构）。
