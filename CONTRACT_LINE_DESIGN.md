# ② 合同信息线 — 表结构设计文档

> 状态：**设计完成**（2026-08，本轮只定表结构；不涉及业务代码与 mock 改动）
> 配套建表 SQL：`backend/app/migrations/2026_08_contract_line_clean.sql`
> 关联文档：`THREE_SOURCE_LINES.md`（总纲）、`DATA_GOVERNANCE.md`（P3/P4/P5、R1-R3、C1-C6）

---

## 一、主线定位

**合同信息线是整个系统的"商务量"来源**：提供电费单价、场地租金、税费、柜数、首月租金/退款等**计价参数**。电费台账、租金台账、分红全部拿电表线给的"度数"去乘本合同线给的"单价/租金"。

**关键特征**：合同是**系统内人工新建/维护**的数据（支持 Excel 一次性导入），不存在第三方接口。

### 合同两分法（全系统分流的总开关）

| contract_type | 方向 | 业务含义 | 提供什么 |
|---|---|---|---|
| **场地合同** | 公司 → 场地方（业主） | **成本** | 电费付款单价、场地月租金（付给业主） |
| **品牌方合同** | 品牌方 → 公司 | **收入** | 电费收款单价、品牌场地租金（品牌方付给公司） |

> 一个场地（landlord）下：1 份场地合同（成本）+ N 份品牌方合同（每个品牌方 1 份，收入）。
> 派生层所有"付/收、成本/收入"的判定都只看 `contract_type`。

### 数据流全景

```
人工维护 / Excel 导入（系统内写）
  ▼
contracts（合同台账：单价/月租/税/柜数/首月租/退款/起止日期）
  ├── 按 pay_method × monthly_rent 拆期 ──► rent_payment_schedule / rent_income_schedule（分期）
  │
  ├──(乘) 电表线度数 ──► electricity_records（电费台账：度数×单价）
  ├──(加) 租金收入/成本 ──► dividend_records（分红月结收入成本项）
  ├──(算) 品牌方场地成本分摊 ──► venue_cost（实时计算，不落库）
  └──(推) 分期状态 ──► pay_status（实时推导，不落库）
```

---

## 二、现状问题核验（本线要解决的"杂乱"）

| # | 问题 | 证据 | 本设计如何处理 |
|---|---|---|---|
| C1 | **合同类型口径不统一**：后端只认 `场地合同/品牌方合同`，前端旧表单仍提供 `场租付款/场租收款/电费/合作/其他` | `src/components/ContractForm.tsx:65` vs `contract_repo.py:134` | 全系统统一两分法；存量旧值映射（场租付款→场地合同、场租收款→品牌方合同），歧义值人工确认后清理 |
| C2 | **租金三处记录互不打通**：`contracts.monthly_rent` / `rent_leases|rent_incomes|rent_receipts` / 美团 Excel 运行时解析 | `DATA_GOVERNANCE.md` P4/R1 | **`contracts` 定为租金唯一主源**；rent_* 表标记 DEPRECATED（实施轮一次性并入 contracts）；Excel 改为一次性导入 contracts，删除运行时解析 |
| C3 | **柜数两套来源**：`contracts.cabinets_count` 手填一份，`meters→cabinets` 实时统计一份；前端已用实时值覆盖手填值 | `contract_repo.py:28-34`（live_cabinets_count）；`Contracts.tsx:467` | **实时柜数 = 唯一计费柜数**（`meters→cabinets` 统计）；`cabinets_count` 降级为"表单时参考快照"，业务计算一律用实时值 |
| C4 | **`venue_cost` 派生值混存**：品牌方合同承担的场地成本是算出来的，不应落库 | `contract_repo.py:95-104` 已实时算 | 明确 **venue_cost 永不落库**，读取处实时计算（contract 列表 / dividend_calc 同口径） |
| C5 | **`pay_status` 语义混乱**：库里存默认"未付款"，列表实际按分期推导 | `contract_repo.py:105-110` | **pay_status 由分期推导**（全部分期已付→已付款），库列仅作历史兼容，业务读派生值 |
| C6 | **字段有机增长、无分组文档**：deposit / first_month_rent / rent_refund / early_end_date / rent_tax_* / post_tax_* 后补字段堆在一张表 | `DATABASE_REDESIGN.md` §七；`2026_08_schema_alignment.sql` | 本文档按**基础/电费/租金/税务/期次/审计**六组给出字段清单与注释，SQL 同步加 COMMENT |
| C7 | **冗余/废弃列**：`station_name`（已 DEPRECATED）、`partner`（无代码写）、`pay_entity`（文本，已有 entity_id 外键） | `2026_08_contracts_normalize.sql`；`contract_repo.py` INSERT 无 partner | station_name/partner 标注废弃（收尾删除）；pay_entity 保留过渡（Entities 页历史匹配用），以 entity_id 为准 |
| C8 | **无唯一约束**：Excel 导入已按 (landlord_id, 类型, 起止) 查重，但表本身无约束，重复导入防不住 | `contracts.py:212-216, 282-286` | 加部分唯一索引：场地合同 `(landlord_id, start_date, end_date)`；品牌方合同 `(landlord_id, brand_id, start_date, end_date)` |
| C9 | **缺审计列**：contracts 无 `updated_at` | `database_init.sql` contracts 定义 | 补齐 `updated_at` |

---

## 三、目标表结构

### 主表：`contracts` — 合同台账（商务量唯一主源）

> 字段按六组划分，SQL 中逐列加 COMMENT。

**① 关联组**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| landlord_id | INTEGER FK → landlords(id) **NOT NULL** | 场地方（合同的归属主体，**一级挂 landlord**，不区分站点） |
| brand_id | INTEGER FK → brands(id) | 品牌方（仅品牌方合同必填；1 场地 1 品牌 1 合同） |
| entity_id | INTEGER FK → entities(id) | 报税公司主体（收款/付款法人） |
| station_id | INTEGER FK → stations(id) | 兼容遗留（合同归一挂 landlord，不强制） |
| station_name | VARCHAR(200) | **DEPRECATED** 冗余显示列（曾存场地方名），收尾删除 |

**② 类型组**

| 字段 | 类型 | 说明 |
|---|---|---|
| contract_type | VARCHAR(20) **NOT NULL** | **仅 `场地合同` / `品牌方合同`**（CHECK 约束），全系统分流键 |
| data_source | VARCHAR(20) NOT NULL DEFAULT 'manual' | 来源：manual 手工 / excel 导入（审计用） |
| partner | VARCHAR(150) | **DEPRECATED** 无用列（无代码写入），收尾删除 |
| pay_entity | VARCHAR(150) | 付款主体文本（历史遗留；**以 entity_id 为准**，过渡保留） |

**③ 电费组**

| 字段 | 类型 | 说明 |
|---|---|---|
| electricity_price | NUMERIC(8,4) | **单价（元/度）**：场地合同=付款单价，品牌方合同=收款单价；电费台账乘数 |
| tax_enabled | BOOLEAN DEFAULT FALSE | 电费是否含税计 |
| tax_rate | NUMERIC(6,4) DEFAULT 0.01 | 电费税率（含税→不含税换算） |
| post_tax_electricity_price | NUMERIC(8,4) | 税后电费单价（= 税前 × (1−税率)，前端实时算，允许人工覆盖） |

**④ 租金组**

| 字段 | 类型 | 说明 |
|---|---|---|
| rent_calc_method | VARCHAR(20) DEFAULT '按柜子数量' | 计价方式：按柜子数量 / 固定价格 |
| unit_monthly_rent | NUMERIC(10,2) | 单柜月租金（品牌方合同，按柜计价时用） |
| cabinets_count | NUMERIC(8,2) | **DEPRECATED 参考快照**：计费柜数以 `meters→cabinets` 实时统计为准，本列仅表单回显参考 |
| monthly_rent | NUMERIC(12,2) | **月租金（元/月）**：场地合同=付业主；品牌方合同=品牌方应付（按柜 = 单柜×柜数，固定 = 直填） |
| rent_amount | NUMERIC(12,2) | 年租金总额（冗余便捷列，= monthly_rent×12，允许按实填） |
| first_month_rent | NUMERIC(12,2) | 首月场地租金（品牌方合同，首月优惠/单独金额；分红计算有专门分支） |
| rent_refund | NUMERIC(12,2) | 提前结束退款（品牌方合同；配合 early_end_date 使用） |
| early_end_date | DATE | 合同提前结束日（晚于 end_date 语义 = 实际结束日；触发"提前结束"状态与退款分支） |
| deposit | NUMERIC(12,2) | 押金 |

**⑤ 期次/付款组**

| 字段 | 类型 | 说明 |
|---|---|---|
| pay_method | VARCHAR(50) | 月付/季付/半年付/年付 → 决定分期表拆期 |
| rent_advance_days | INTEGER NOT NULL DEFAULT 0 | 场地租金提前支付天数（影响到期月份计算） |
| pay_status | VARCHAR(20) DEFAULT '未付款' | **DEPRECATED**：业务读分期推导值（全部分期已付→已付款），本列仅历史兼容 |
| start_date | DATE | 合同开始日期 |
| end_date | DATE | 合同结束日期 |

**⑥ 位置/审计组**

| 字段 | 类型 | 说明 |
|---|---|---|
| region | VARCHAR(50) | 区域 |
| address | VARCHAR(300) | 地址 |
| latitude / longitude | NUMERIC(10,7) | 经纬度 |
| remark | TEXT | 备注 |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | 审计列（原表缺失，本设计补齐） |

**唯一约束（防重复导入）**
- `uq_contracts_venue`：`UNIQUE(landlord_id, start_date, end_date) WHERE contract_type='场地合同'`
- `uq_contracts_brand`：`UNIQUE(landlord_id, brand_id, start_date, end_date) WHERE contract_type='品牌方合同'`

**索引**：`(landlord_id)`、`(brand_id)`、`(contract_type)`。

### 分期表：`rent_payment_schedule` / `rent_income_schedule`

> 两张表**结构完全一致**，按合同类型分流（场地合同→付款分期；品牌方合同→收款分期），保留现有设计。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| contract_id | INTEGER FK → contracts(id) **ON DELETE CASCADE** | 所属合同 |
| seq | INTEGER NOT NULL | 期次序号（1,2,3…） |
| period_start / period_end | DATE | 本期区间 |
| amount | NUMERIC(12,2) | 本期金额（= monthly_rent × 期长月数） |
| status | VARCHAR(20) DEFAULT '未付款' / '未到账' | 付款分期=未付款/已付款；收款分期=未到账/已到账 |
| pay_date | DATE | 实际收/付款日期 |
| invoice | VARCHAR(200) | 发票信息 |
| remark | TEXT | |
| created_at | TIMESTAMP DEFAULT NOW() | |

- 唯一键：`UNIQUE(contract_id, seq)`。
- 生成规则：合同保存时按 `pay_method` 拆期（月付=1月/期、季付=3、半年付=6、年付=12），每期金额 = `monthly_rent × 期长`；重建时按 seq 保留已付状态。
- 状态口径：`contracts.pay_status` 由全部分期推导（全部已付→已付款）。

> 可选视图（实施轮）：`v_contract_schedules = rent_payment_schedule UNION ALL rent_income_schedule (+ side 列)`，统一查询。

### 过渡表（DEPRECATED，不在新设计中承担主源职责）

| 表 | 现状 | 处置 |
|---|---|---|
| `rent_leases` | 场地租金付款台账（与场地合同重复） | **DEPRECATED**：实施轮把存量一次性并入 `contracts`（contract_type=场地合同），随后下线接口与表 |
| `rent_incomes` | 品牌场地租金收款台账（与品牌方合同重复） | **DEPRECATED**：同上并入 `contracts`（contract_type=品牌方合同） |
| `rent_receipts` | rent_incomes 的分期收款 | **DEPRECATED**：并入 `rent_income_schedule` |
| `rent_payment_records` / `rent_income_records` | 按年归档发票/进项成本（station_id+brand_id+fiscal_year） | **保留为"年度发票/进项台账"**：与分期表 `invoice` 字段存在冗余，实施轮决定合并或明确分工（发票归属按年 vs 按期） |
| `operating_expenses` | 运营费用（station_id+period+amount，**独立手工输入**） | **不属于合同线**，保留现状；它是派生层（分红计算）的一个独立输入项，period 已归一化为 6 位 |

> 原则：**租金只进 `contracts` 一个口子**。Rent 页改读 contracts + schedules；美团 Excel 一次性导入 contracts（data_source='excel'）后删除运行时解析（`rent.py` 的 6 层 `..` 硬编码路径）。

---

## 四、口径规则（本线核心约定）

### 4.1 合同类型 = 全系统分流键
```
场地合同 → 电费付款单价(electricity_price)、场地月租(monthly_rent) → 进"成本"
品牌方合同 → 电费收款单价(electricity_price)、品牌场地租金(monthly_rent) → 进"收入"
```

### 4.2 计费柜数唯一源（C3）
- 计费柜数 = 实时统计 `meters→cabinets`：按 `landlord_id + brand_id` 匹配电表，累加每表柜数（排除 TEST 电表）。
- `contracts.cabinets_count` 仅作表单回显参考（前端已用实时值覆盖），**业务计算不读本列**。

### 4.3 品牌方场地成本分摊（venue_cost，C4）
```
venue_cost = 该场地所有场地合同月租总和 ÷ 该场地所有品牌计费柜数总和 × 本品牌计费柜数
```
- **纯派生值，永不落库**；contract 列表与 dividend_calc 用同一口径（保证"各品牌分摊之和 = 整场地租金成本"）。

### 4.4 收付款状态（C5）
- `pay_status` 由分期推导：无分期 → 未付款；全部分期已付（或已到账）→ 已付款；否则未付款。
- 审批联动（C6，实施轮）：审批通过后回写对应分期/台账状态。

### 4.5 税费口径
- 电费：含税单价 `electricity_price`，不含税 = 含税 / (1+tax_rate)；启用税后单价的品牌另按 `kwh × (税前−税后)` 单算电费税（`post_tax_electricity_price`）。
- 租金：`rent_tax_enabled` / `rent_tax_rate` / `post_tax_rent_price`（本线涉及，与 ③ 线分红计算共用）。
- 说明：台账与分红两套税费算法的不一致（DATA_GOVERNANCE P1）属派生层收敛项，本线只固化"合同提供哪些税字段"。

### 4.6 首月租 / 退款 / 提前结束
- 首月（start_date 所在月）：品牌方合同用 `first_month_rent`（有值则优先），否则 `monthly_rent`。
- 提前结束月（early_end_date，缺省用 end_date）：品牌方合同按 `rent_refund` 冲减收入。
- 场地合同侧目前无首月/退款字段（R3 遗留：首月租只算收入不算成本），实施轮按业务确认是否补场地合同侧字段。

### 4.7 租金主源（C2）
- 所有租金数字以 `contracts.monthly_rent`（+ 分期表）为准；页面/导出不再读 rent_* 台账与 Excel。

---

## 五、与①线 / ③线 / 派生层的衔接

| 消费方 | 读合同线哪些字段 | 公式 |
|---|---|---|
| 电费台账 generate（①线度数 × 本合同单价） | 场地合同 electricity_price（付款）、品牌方合同 electricity_price（收款） | 度数 × 单价 |
| 分红计算（③线） | 两类合同 monthly_rent / first_month_rent / rent_refund / early_end_date / tax_* | 收入 − 成本，按分红配置分摊 |
| 合同列表页 | 全部 + live_cabinets_count（①线实时柜数）+ venue_cost（派生） | — |
| 品牌/主体/场地看板 | monthly_rent、electricity_price 聚合 | 加减乘除 |

---

## 六、建表 SQL 说明

- 文件：`backend/app/migrations/2026_08_contract_line_clean.sql`
- **全新安装**：直接执行（幂等），可作为 `database_init.sql` 合同线部分的替代/基准（实施轮替换）。
- **存量库对齐**：补 `updated_at`、加 COMMENT、旧合同类型映射（场租付款→场地合同、场租收款→品牌方合同）、加唯一约束（有重复时跳过并提示）、加索引。
- **核对 SQL**：重复合同、歧义合同类型、cabinets_count 与实时柜数不一致等。
- **破坏性段**（确认后手动执行）：删 station_name / partner；rent_* 表并入 contracts 后下线。

## 七、遗留（本轮不动，后续处理）

1. `ContractForm.tsx` 旧表单（合作/电费等旧类型）→ 实施轮并入 Contracts.tsx 的新表单（两分法 + 分组字段）。
2. Rent 页改读 contracts + schedules，下线 rent_* 接口与美团 Excel 运行时解析。
3. 审批联动回写收付款状态（C6，跨线实施）。
4. `contracts` 段替换进 `database_init.sql`，消除双源漂移。
