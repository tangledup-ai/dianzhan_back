# 电表域 V4 设计草案

> **状态**：设计草案（**未实施**，供评审）
> **基线**：commit `cbecb77`，2026-09-23；本机库 `huandian_v2` 实测数据
> **决策来源**：2026-09-23 与主人的 13 轮问答（见第 3 章决策记录 28 条，每条标注原始口径）
> **配套文档**：`DATA_LINEAGE.md`（现状字段级溯源）· `METER_TAG.md` / `ELECTRICITY_RATIO.md` / `MANUAL_READING_ACTUAL.md`（历史设计，2026-08 已落地）
> **目标**：把「电表 → 读数 → 单价 → 电费 → 成本 → 主体」这条链重新建模，支撑后续数据库重构
>
> **修订 v2**（第二轮，主人指正三处）：① `meter_contract_bindings` 的 EXCLUDE 约束**加入品牌维度**（原设计会让共享表挂不了第二个品牌）② 电表类型改为**可扩展分类字典**（主人预告会新增其他大类，原枚举方案会立刻过时）③ **民用电表定位明确**为「计入成本 + 与品牌隔离 + 可按大类筛选」。另确认滇池两块表为历史误标。
> **修订 v3**（第三轮，主人再指正两处）：① **大类不改变计算方式** —— 「这只是电表的大类不同，计算方式还是和其他的一样的」⇒ 分类字典**去掉** `billing_mode`/`cost_bearer` 算法开关，算法唯一分叉是「是否一表多品牌」② **滇池两块改判为合作商电表**（8→台铃、62→八维通）；大类管理**不做页面**。
> **修订 v4**（第四轮，主人纠正一处）：「民用表复用场地品牌方合同单价」系**误读**。主人原话：**「民用表和合作表，只是电表的一个大类。计算方式都是一样的。」** ⇒ 民用表**不是特例** —— 走与合作商表**同一个** `resolve_meter_price()`、同一条「单价 × 电量」；因无品牌方可收，只需一份 `pay` binding（场地合同），与同场地其他表的**付款侧同源同价**。原「从多份品牌方合同中挑一份」的歧义**不存在**，8.2 的选项 A/B/C **全部作废**。
> **修订 v5**（第五轮，主人纠正一处 —— **概念降维**）：「**共享**」**不是一个电表大类**，而是**表级横向属性**。主人原话：**「我说的共享电表，是有一个特殊的电表，'所有品牌共用此电表（场地总表）'，他可能隶属合作商表也可能隶属民用电表这个大类，或者其他大类。」** ⇒ ① `meter_categories` **删掉 `is_multi_brand`**，大类退化回纯粹的「归类与筛选」；② 算法唯一开关改为**表级** `meters.is_shared`（**人工设置，不再是生成列**）；③ 场地总表与 `category_code` **正交**，可出现在任意大类下；④ 现有 3 块场地总表**各自还需指定大类**（见 [8.13](#8-未决问题)）。
> **修订 v6**（第五轮续 —— 主人回答四问，其中两问**改动结构**）：① **场地付款是「一个场地一笔」**（不是一块表一笔）⇒ 付款表由 `meter_monthly_payments(meter_id, …)` **改为 `landlord_monthly_payments(landlord_id, …)`**，**损耗随之改为场地级**（决策 30）；② **场地总表纯人工判定** —— 无客观线索，`is_shared` 就是人工开关（决策 33）；③ **换表规则 = 新建表 + 旧表退役**（**推翻原决策 16「同表改设备地址」**，决策 31）；④ `third_party_configs.meter_tag` **保留字段但不参与任何分类推导**（主人：先保留，决策 32）。
> **修订 v7**（第五轮续 —— 主人再答四问，其中一问**推翻 v6 的付款粒度**）：① **「费用绑定在电表上」** —— 主人原话：**「我觉得费用最好是绑定在电表上，这样就可以随意按照场地分类或者按照品牌分类，或者按照主体分类了。」** ⇒ **v6 把付款表改成 `landlord_monthly_payments` 属于过度修正**。正确解法是 **表级存储（`meter_monthly_payments`）+ 任意维度聚合**：「一个场地一笔」是**聚合视图**，不是存储粒度（决策 30 **重写**）。② **场地损耗：不分主体、单独列示**（决策 34）；③ **换表后不串联**，新旧表各出各行（决策 35）；④ 3 块场地总表的**来源已查实**：龙泉路108 / 大观2 来自第三方拉取（挂「民用账户」），学府路68 是手工建档（见 2.2 问题 6）。

---

## 目录

- [1. 业务模型](#1-业务模型)
- [2. 数据现状实测](#2-数据现状实测)
- [3. 决策记录（35 条）](#3-决策记录35-条)
- [4. 表结构设计](#4-表结构设计)
- [5. 核心算法](#5-核心算法)
- [6. 迁移映射](#6-迁移映射)
- [7. 受影响代码清单](#7-受影响代码清单)
- [8. 未决问题](#8-未决问题)

---

## 1. 业务模型

### 1.1 一句话

**从场地方租场地 → 场内装电表计电 → 按电表读数向品牌方收电费、向场地方付电费 → 差价进入分红。**

### 1.2 电表与品牌是 M:N 关系

这是本次设计的**起点**。主人确认的三种现实：

| 关系 | 例子 | 现状如何表达 |
|---|---|---|
| 1 表 : 1 品牌 | 一块表专供某品牌 | `meters.brand_id` 非空 |
| N 表 : 1 品牌 | 同场地同品牌多块表 | `meters.brand_id` 相同（多行） |
| 1 表 : N 品牌 | 共享表，多品牌共用 | `meters.brand_id` **为空** + 分摊表 |

**结论**：`meters.brand_id` 一列只能表达前两种，第三种靠「空值 + 分摊表」特例化。V4 保留这个双轨结构（不做全 M:N 化，因为 `brand_id` 在代码中被引用 118 次，全改是地震级），但**明确语义、加约束、消灭歧义**。

### 1.3 两个正交维度：电表大类 × 是否场地总表（核心分界）

> **修正记录（第二轮）**：主人明确两点 —— ①「**民用电表是电表的一个大类。还有其他大类的。**」⇒ 分类必须可扩展，不能用硬编码枚举，改为**分类字典表**（`meter_categories`，见 [4.1](#41-meters--meter_categories分类字典与电表主表)）；②「**这只是电表的大类不同，计算方式还是和其他的一样的。**」⇒ **大类只是分类标签，不承载算法差异**。
> **修正记录（第五轮，本轮）**：主人指出「共享」**不是一个大类** —— 原话：**「我说的共享电表，是有一个特殊的电表，'所有品牌共用此电表（场地总表）'，他可能隶属合作商表也可能隶属民用电表这个大类，或者其他大类。」** ⇒ 把「共享」从大类列表里**移出**，降为**表级属性** `meters.is_shared`。

V4 的模型是**两个正交维度**，而不是一个枚举 —— 这是本轮最重要的结构修正：

| 维度 | 落在哪 | 回答的问题 | 取值 |
|---|---|---|---|
| **电表大类** | `meters.category_code` → `meter_categories` | 这块表**归哪类、报表怎么分** | 合作商 `partner` / 民用 `civil` / …（**可扩展**） |
| **是否场地总表** | `meters.is_shared`（**表级布尔**） | 这块表**服务几个品牌** | `TRUE` = 所有品牌共用此表（场地总表）；`FALSE` = 单品牌或无品牌 |

**两个维度互相独立** —— 场地总表可以挂在任何大类下面：

| 组合 | 例子 | 算账方式 |
|---|---|---|
| 合作商 × 非总表 | 一块表专供某品牌（现状 75 块的主体） | 电量 × 单价（自动） |
| **合作商 × 场地总表** | **一块表属合作商大类，但场内所有品牌共用它** | **品牌分摊额人工录**（物理上分不出各品牌度数） |
| 民用 × 非总表 | 民用表（现状 46 块） | 电量 × 单价（自动）—— **与合作商表完全相同** |
| **民用 × 场地总表** | **属民用大类，但场内所有品牌共用它** | **品牌分摊额人工录** |
| 未来大类 × 任意 | 后新增的大类 | 同上两分叉 |

**因此算账方式只有一个分叉，且与「大类」无关**：

| | 由什么决定 |
|---|---|
| **算账方式**（自动算 / 人工分摊） | **只看 `is_shared`** —— 表服务多品牌 ⇒ 人工分摊；否则自动算 |
| **归类与筛选**（这是什么表、报表怎么分） | **只看 `category_code`** |

> ⚠️ **最容易记错的一点（本轮纠错）**：**不存在「共享电表」这个大类**。库里「一切共享相关的表」= `WHERE is_shared = TRUE`，与它归哪个 `category_code` 无关；反之，同一个大类下既有场地总表也有普通表。
>
> **术语约定（全文适用）**：下文出现的「**共享表**」「**共享电表**」「**场地总表**」一律指 **`is_shared = TRUE` 的表**，是**属性**不是大类。旧的 `category_code = 'shared'` 取值**已废弃**（见迁移映射），不要再按大类理解。

现有大类（实测块数，按现状 `tag` 归类）：

| 大类 | code | 块数 | 算账方式 |
|---|---|---|---|
| 合作商电表 | `partner` | 75 | **由 `is_shared` 决定**（默认自动） |
| 民用电表 | `civil` | 46 | **由 `is_shared` 决定**（默认自动）；**与大类无关，与合作商表同一条公式** |

另有一个**横向标记**（当前不属于任何大类）：现状 `tag='共享电表'` 的 **3 块场地总表**（龙泉路108 / 大观2 / 学府路68，见 [2.1](#21-规模) 与问题 5）。V4 下这 3 块**必须各自补一个 `category_code`**，同时 `is_shared = TRUE` —— 具体归哪个大类待主人定（见 [8.13](#8-未决问题)）。

**同一个「单价 × 电量」，两条分支** —— 唯一分叉是**这块表服务几个品牌**（`is_shared`）：

| | 单品牌 / 无品牌（`is_shared = FALSE`） | **场地总表（`is_shared = TRUE`）** |
|---|---|---|
| **整表读数** | 天雀同步（可人工修正） | **天雀同步** —— 完全相同，实测 3/3 块场地总表接了天雀 |
| **品牌维度** | 一表一品牌，或民用表无品牌 | **一表多品牌**（见 1.4） |
| **单价来源** | 挂的合同（付款侧 = 场地合同） | 分摊行人工值 / 该品牌挂的合同；付款侧同样取场地合同 |
| **电量** | 该表读数 | 各品牌电量人工录（双向推导） |
| **金额** | 单价 × 电量（自动） | 分摊行人工录 |
| **收款** | 有（向品牌收）；民用表无收款对象 | 有（各品牌分摊行） |
| **报表归属** | 按其大类 `category_code` | 按其大类 `category_code` —— **共享与否不影响大类归属** |

> ✅ **民用表没有任何专属规则**：它与合作商表走**同一个函数、同一个公式**（`单价 × 电量`），单价一律来自**它自己的 `pay` binding（场地合同）**—— 也就是与同场地其他表的付款侧**同一份合同、同一个价**。唯一差别是**没有收款侧**（无品牌方可收），以及报表里归到独立大类供筛选（决策 22）。
> ⚠️ 「算法相同」**不等于**「数字相同」：民用表读的是它自己的电量，算出来是**民用成本**，不要直接与品牌表的数字比较。

**新增第四个大类时**，只需在 `meter_categories` 插一行（code + 名称），**不需要定义新算法** —— 因为算法只由表级 `is_shared` 决定。

### 1.4 场地总表（`is_shared`）= 一块表服务多品牌（binding 必须带品牌维度）

主人原话：**「共享电表是一块电表所有品牌共享。所以共享电表存在一块电表关联不同品牌的问题。」**
第五轮补充：**「我说的共享电表，是有一个特殊的电表，'所有品牌共用此电表（场地总表）'」** —— 注意「特殊」二字：它特殊在**用法**（全场地所有品牌共用一个表计电），**不特殊在归类**。所以 V4 用一个表级布尔 `is_shared` 表达它，而不是给它开一个大类。

```sql
-- 表级属性：TRUE = 场地总表（所有品牌共用此表）
--            由人工在电表建档/编辑时设置（业务事实，不可从大类推导）
ALTER TABLE meters ADD COLUMN is_shared BOOLEAN NOT NULL DEFAULT FALSE;
```

判据是**业务事实**而非数据推导：当一块表的物理位置决定「全场地的电都从它走」，就置 `TRUE`。**现状代码里那个 `tag = '共享电表' AND brand_id IS NULL` 的双重判断，本质是在猜这个事实** —— V4 直接把它变成一个显式开关。

这句话直接指出了上一版设计的一个**错误**：`meter_contract_bindings` 的 `EXCLUDE` 约束若只按 `(meter_id, role)` 判重，会导致**一块场地总表无法为多个品牌各挂一份收款合同** —— 挂第二份就违反约束，设计在场地总表上直接不成立。**V4 已修正：约束键加入 `brand_id`**（见 [4.2](#42-meter_contract_bindings新建)）。

**现状其实已经支持多品牌**（这是好消息，迁移无需重构数据）：

`meter_shared_allocations` 的唯一约束是 `UNIQUE(address, month_period, brand_id)`，龙泉路表 202609 就是 3 个品牌各一行：

| 表号 | 月 | 品牌 | 金额 |
|---|---|---|---|
| 260319554778 | 202609 | 云驰换电 | 1620.00 |
| 260319554778 | 202609 | 永群出行 | 4500.00 |
| 260319554778 | 202609 | 电皇后 | 6000.00 |

V4 保留这个结构（表名 `meter_shared_allocations` 沿用，语义 = **场地总表的品牌分摊行**），只把关联键 `address` 换成 `meter_id`。

| 关系 | 表达方式 |
|---|---|
| 场地总表 × N 品牌（分摊额） | `meter_shared_allocations` 每品牌一行 |
| 场地总表 × N 品牌（合同） | `meter_contract_bindings` 每品牌一份，`role='collect'` + `brand_id` 非空 |
| 场地总表 × 1 场地（付款） | `meter_contract_bindings` 一份，`role='pay'` + `brand_id` 为空 |

### 1.5 报税主体的三级粒度（全系统归集的一级维度）

主人原话拆解为三层，**取数优先级：分摊行 > 电表 > 合同**。

| 层级 | 适用场景 | 载体 |
|---|---|---|
| **默认：场地 × 品牌** | 「一个场地方中的一个品牌只有一个报税主体」 | 品牌方合同的 `entity_id` |
| **覆盖 1：电表** | 「一个场地方中的同一个品牌的不同电表关联的是不同的报税主体」 | `meters.entity_id` |
| **覆盖 2：共享表分摊行** | 「共享电表中的品牌方可能有不同的报税主体」 | 分摊行的 `entity_id` |

**主人明确要求的硬约束**：

> 共享电表的平摊场地方的成本费用（动态值）以及每月的应收电费值**都应该和电表关联**。电表是哪个报税主体，这些值就得**跟着报税主体走**。

落地含义：共享表分摊的**每一行**都必须携带 `entity_id`，且电费（`collect_amount/collect_kwh`）与成本（`rent_share`）**同主体归集** —— 报表按主体出，主体变了这些值必须跟着走。

### 1.6 场地电表拓扑：平铺

主人确认场地内电表关系复杂（1:1 / N:1 / 1:N 三种都存在），但**表与表之间没有包含关系**：

```
场地（landlord）
 ├─ 电表A（品牌1专用, is_shared=F）  ─ 付款 = 表A读数 × 场地单价
 ├─ 电表B（品牌2专用, is_shared=F）  ─ 付款 = 表B读数 × 场地单价
 └─ 电表C（场地总表, is_shared=T）   ─ 付款人工录，收款按品牌分摊（品牌2+3）
付款参考值 = Σ(场地内全部电表读数) × 场地单价
真实付款   = 人工填写（因线损，通常 > 品牌方电量合计）
```

**不做主从拓扑**（进线总表 − 分表）。若未来出现真正的进线总表，见 [8.7](#8-未决问题)。

> ⚠️ **别混淆两个「总表」**：本文档的「**场地总表**」专指 `is_shared = TRUE`（**所有品牌共用一个表计电**，属业务属性）；[8.7](#8-未决问题) 的「**进线总表**」指物理**上下级**计量关系（总表读数 = 分表读数之和）。二者无关，前者已建模，后者 V4 不支持。

---

## 2. 数据现状实测

> 2026-09-23 对 `huandian_v2` 实测（只读查询）。

### 2.1 规模

| 项 | 数量 | 项 | 数量 |
|---|---|---|---|
| 场地（landlords） | 49 | 电表总数 | **126** |
| 品牌（brands） | 17 | 　合作商电表 `partner` | 75 |
| 主体（entities） | 7 | 　民用电表 `civil` | 46 |
| **合同（contracts）** | **19** | 　场地总表 `is_shared=TRUE`（**横跨大类**） | 5 |
| 柜子（cabinets） | 170 | 月度读数行 | 743 |
| 分摊行 | **6** | 台账行 | 106 |

**电表分类交叉（现状 `tag` × 品牌 × 场地）**：

| 现状 `tag` | 块数 | brand 空 | brand 有 | 有场地 | 无场地 | V4 归属 |
|---|---|---|---|---|---|---|
| 合作商电表 | 75 | 2（异常） | 73 | 24 | **51** | `category_code='partner'` |
| 民用电表 | 46 | 46 | 0 | **1** | **45** | `category_code='civil'` |
| 共享电表 | 5 | 5 | 0 | 5 | 0 | ⚠️ **不是大类** → `is_shared=TRUE`，另补 `category_code`（见 [8.13](#8-未决问题)） |
| 合计 | 126 | 53 | 73 | 30 | **96** | — |

> 另附：`cabinets` 170 块（**无 `brand_id` 列**，见问题 8）；民用电表名下 **399 行读数**（数据一直在采，只是不进财务）。
> ⚠️ **统计口径的变更（本轮）**：上表「共享电表 5」是**现状 `tag` 的字面值**；V4 里它**不是一个分类**，而是**表级布尔** `is_shared`。迁移后统计口径变成 `WHERE is_shared = TRUE`，且这些表会**同时**计入它们各自大类的块数（两个维度正交）。
> ⚠️ 其中滇池 2 块已确认是误标、将改判为**普通合作商表**（`is_shared=FALSE`）⇒ **迁移后实际场地总表 3 块**（见问题 5）。

### 2.2 九个必须正视的现实问题

**问题 1：96/126 块电表（76%）没有场地归属。**

```
无 landlord_id 的电表：民用电表 45 块 + 合作商电表 51 块 = 96 块
```

这批表当前**不参与任何电费台账**（生成器按 `landlord_id` 分组）。它们是从第三方导入后**未完成建档归位**的残留。

**问题 2：民用电表 46 块 —— 已确认「计入成本，但要与其他品牌隔离」。**

> 主人原话：**「民用电表也是计入成本的，但是需要和其他品牌的做隔离（方便我后续做筛选）。民用电表是电表的一个大类。还有其他大类的。」**

实测：

- 46 块**全部有 `collector_id`**（是天雀设备，**399 行读数一直在采**，数据是齐的）
- 其中 45 块**无场地**、**0 块有报税主体**、柜子只有 1 个
- 代码里 `auth_scope.py:10` 认识它（`METER_TAGS` 三类之一），但 `electricity.py` 的台账生成、分红引擎**完全不处理它**

**V4 落地要点（三条，缺一不可）**：

| # | 要求 | 怎么落 |
|---|---|---|
| 1 | **计入成本** | 民用表的付款额要进电费成本，不能像现状那样整块丢弃 |
| 2 | **与品牌隔离** | `brand_id` 恒为空，不参与品牌分摊、不进「品牌应付」类报表 |
| 3 | **可按大类筛选** | 台账行带 `meter_category = 'civil'` —— 光靠 `brand_id` 为空不够（共享表的损耗行也为空），必须有显式类别列 |

> 第 3 条是主人「方便我后续做筛选」的直接落地要求，且**这个列所有大类都要有**（不只为民用）—— 因为大类本身是可扩展的，报表要能按任意大类分组。

**问题 3：合同严重不足 —— 49 个场地只有 19 份合同。**

按「无合同 = 跳过 + 告警」的决策，**大量场地会被跳过**。这不是设计问题，是**数据治理问题**，必须在切换前补齐。

> 实测已经能看到后果：场地 74 的 202609 台账行是「付款 70800.00 / 收款 0.00」—— 有付款无收款，就是缺品牌合同导致的。

**问题 4：共享表分摊功能刚启用，字段基本是空的。**

6 行分摊数据（202608/202609），`entity_id` 全空、`unit_price` 全空、`cabinet_count` 全是 1。**主体和单价从未被真正使用过** —— 这既是好消息（迁移无历史包袱），也是隐患（口径未经验证）。另见问题 9。

**问题 5：一个场地多块场地总表的场景已存在 —— 但滇池两块是误标。**

> 主人原话：**「滇池会展中心那两块共享表不是共享表，应该是我之前改错了。」**

迁移后的场地总表（`is_shared = TRUE`）清单：

| 场地 | 场地名 | 场地总表数 | 表号 | V4 里的归类 |
|---|---|---|---|---|
| 2 | 大观体育公园 | 1 | 251206550085 | ⚠️ **待定**（`category_code` 未定，见 8.13） |
| 68 | 学府路 | 1 | 学府路001 | ⚠️ **待定**（见 8.13） |
| 108 | 龙泉路 | 1 | 260319554778 | ⚠️ **待定**（见 8.13） |
| ~~69~~ | ~~滇池会展中心~~ | ~~2~~ | `260319550072` / `260319550057` | **✅ 已定：普通合作商表**（`is_shared=FALSE`，见 8.9） |

滇池两块表的实测特征：`brand_id` 为空、`transformer_ratio = 40`、各 1 个柜子、有读数（4~5 行）、**场地 69 一份合同都没有**、平台描述分别是「台铃-滇池国际会展中心站」「八维通-滇池国际会展中心」。

**✅ 滇池已定（8.9）**：从「一表一柜一品牌」的特征看，这两块是**普通合作商电表**，主人已确认改判 ⇒ `category_code='partner'`、`is_shared=FALSE`，各补 `brand_id`（8→台铃、62→八维通）。这一步把「走人工分摊」纠正为「走读数 × 合同单价」，口径差异很大。

**⚠️ 剩下三块仍未定（本轮新增）**：龙泉路 / 大观 / 学府路这三块**确认为场地总表**（`is_shared=TRUE`），但**各自归哪个大类仍待主人指定** —— 主人原话：「他**可能隶属合作商表也可能隶属民用电表这个大类，或者其他大类**」。这个字段不能空（V4 里 `category_code` 是 NOT NULL），所以**不解决就无法完成迁移**。见 [8.13](#8-未决问题)。

注意 `学府路001` 这种非数字表号，说明 `meter_no` 是人工编的，**不能依赖它做设备对接**（V4 引入 `device_address` 的动机之一）。

**问题 6：场地总表不是「纯人工表」—— 4/5 块接在天雀上，而且挂在他类账户下。**

| 电表 id | 表号 | 场地 | 第三方配置 | 设备号 | 平台描述 |
|---|---|---|---|---|---|
| 8 | 260319550072 | 69 | **1 合作商账户** | 3788268 | 台铃-滇池国际会展中心站 |
| 62 | 260319550057 | 69 | **1 合作商账户** | 3755098 | 八维通-滇池国际会展中心 |
| 99 | 251206550085 | 2 | **2 民用账户** | 3580986 | 大观体育公园 |
| 119 | 260319554778 | 108 | **2 民用账户** | 3837349 | 德利邦龙泉路 |
| 126 | 学府路001 | 68 | 无 | — | (无设备记录) |

两条重要推论：

1. **场地总表读数可以自动同步**（4 块有 `device_id`，且都有 `meter_monthly` 读数行）。所以「场地总表全部人工录」只适用于**品牌分摊额**，不适用于整表读数。
2. **`third_party_configs.meter_tag` 既推不出 `meters.category_code`、也推不出 `meters.is_shared`** —— 两块表挂在「合作商账户」下、两块挂在「民用账户」下。**场地总表是从他类账户里人工提拔出来的，它是表自身的属性，不是账户属性**（这正是第五轮把 `is_shared` 定为「人工设置的业务事实」的实测依据）。

**问题 7：14 块人工建档的表与第三方设备地址对不上。**

```
共享电表  场地68   学府路001
合作商电表 场地4   TEST-001            ← 测试表（应排除）
合作商电表 场地6   1111
合作商电表 场地42  美团-归十西路电表
合作商电表 场地56  美团-华尔顿大厦
合作商电表 场地100 2603195548431      ← 数字表号但也对不上设备
合作商电表 场地101 260319554707
合作商电表 场地102 401086095832
合作商电表 场地103 六甲青桔
合作商电表 场地104 归十西路家园
合作商电表 场地105 昆明市盘龙区凤凰巷青桔
合作商电表 场地106 青桔-龙润路
合作商电表 场地107 青桔如安街电表
合作商电表 场地74  2509620684000188
```

**这是 V4 解耦 `meter_no` 与 `device_address` 的最强论据**：人工为了可读性把电表号改成了「美团-归十西路电表」「青桔-龙润路」这类名字，于是**再也 join 不到第三方设备**（`meter_monthly.address = meters.meter_no` 的字符串关联直接断链）。

**问题 8（本轮新发现）：`cabinets` 表结构缺陷 —— 柜子无法表达品牌。**

实测 `cabinets` 只有 6 列：`id, meter_id, cabinet_no, cabinet_type, remark, created_at` —— **没有 `brand_id`**。

柜子的品牌是靠 `meters.brand_id` 推的。这对合作商电表够用（表本身就是那个品牌的），但对共享表**完全失效**（共享表 `brand_id` 为空 → 其下全部柜子都推不出品牌）。

**这就是「共享表的品牌柜数只能存进 `meter_shared_allocations.cabinet_count`」的根本原因** —— 不是设计选择，是被表结构逼出来的特例。V4 修法：`cabinets` 补 `brand_id`（见 [4.6](#46-柜数维持双载体但补上柜子的品牌维度)），让品牌维度在两个载体里都能表达。

**问题 9（本轮新发现）：分摊表缺列，主人要求的「双向录入」当前物理上做不到。**

实测 `meter_shared_allocations` 共 12 列：`id, meter_id, address, month_period, brand_id, entity_id, collect_amount, unit_price, remark, created_at, updated_at, cabinet_count`。

| 缺口 | 后果 |
|---|---|
| **没有 `collect_kwh`** | 「录金额 → 倒推电量」**算出来无处存放**；「录电量 → 倒推金额」更无从下手 |
| 没有 `rent_share` | 主人要求的「分摊场地成本」无法落表（现状散在 `dividend_calc` 现算） |
| 没有读数快照列 | 决策 12「存快照、历史可复现」无法实现 |

所以主人要求的双向录入**必须先加列**，不是改算法能解决的。V4 DDL 见 [4.4](#44-meter_shared_allocations扩展为分摊行)。

**另外确认**：`landlords.company_share` 列**实际存在**（存量遗留，无 DDL 建它，见 `DATA_LINEAGE.md` 8.3 ⑨）。

---

## 3. 决策记录（35 条）

> 每条标注主人原始口径，后续实施遇争议以本表为准。
> 1~20 为第一轮问答确定；**21~26 为第二轮修正**（EXCLUDE 约束缺陷、滇池误标、民用定位、大类可扩展）；**28 为第三轮补充**（大类管理入口）；**27 为第四轮修正**（民用表单价来源 —— 原「复用品牌方合同」系误读，已改为「与合作商表付款侧同源」）；**29 为第五轮修正**（「共享」从大类降为**表级属性** `is_shared`）；**30~33 为第五轮续**（付款粒度、换表规则、`meter_tag` 定位、总表判据）；**34~35 为第五轮再续**（损耗主体、换表是否串联），其中 **30 由 v7 重写**。

| # | 决策点 | 结论 | 落成什么 |
|---|---|---|---|
| 1 | 挂合同的形式 | **关联表 + 生效期** | 新建 `meter_contract_bindings` |
| 2 | 共享表品牌电量来源 | **人工录金额，倒推电量；也可人工录电量，倒推金额** | `input_mode` + 双向推导（**需先补 `collect_kwh` 列**，见问题 9） |
| 3 | 同场地多共享表 | **逐表独立**，不合并计价 | 分摊按 `meter_id` 维度 |
| 4 | 账期口径 | **自然月归档 + 抄表区间为准** | `period` 归档，金额取区间读数差 |
| 5 | 无合同兜底 | **跳过 + 告警** | 生成器跳过并产出告警清单 |
| 6 | **费用录入**（v7 定案） | **全部人工录**，系统给参考值 + 留口子填真实值；**粒度 = 电表（绑在表上）**，场地级是聚合视图 | `meter_monthly_payments(meter_id, month_period)` |
| 7 | 共享表读数 | **第三方值展示 + 留人工修正口**（双轨） | `kwh`（同步）+ `actual_kwh`（人工） |
| 8 | 合同调价 | **新建合同 + 承接指针**，需能溯源、真外键关联 | `previous_contract_id` 自引用 FK |
| 9 | 报税主体 | **三级粒度**，优先级 分摊行 > 电表 > 合同 | `entity_id` 三处落位 |
| 10 | 分摊行内容 | 应收电费 + 报税主体 + **分摊的场地租金** | 见 4.4 |
| 11 | 场地租金分摊 | **按柜数占比**（动态值） | `rent_share = 场地月租 × 品牌柜数 ÷ 场地总柜数` |
| 12 | 抄表信息 | **存快照在分摊行** | `meter_kwh` / `reading_*_date` |
| 13 | 损耗 | **单独成行，不摊** | 台账一条 `brand_id IS NULL` 的损耗行 |
| 14 | 场地付款口径 | 参考值 = **该表读数 × 场地单价**（逐表给参考），**留口子填真实值**；场地级参考总额 = 各表之和 | `meter_monthly_payments` + `data_source` auto/manual |
| 15 | 电表生命周期 | **完整生命周期** | `status` 枚举 + `installed_at`/`removed_at` |
| 16 | **换表 / 换设备**（v6 **推翻**） | ~~同表改设备地址~~ ⇒ **新建一块表 + 旧表退役**：旧表 `status='removed'` + `removed_at` 并**停止计费**，历史读数留在旧表行上；新表从 `initial_reading`（投运起始表码）起算 | `device_address` 仍独立于 `meter_no`（设备绑定用）；**`initial_reading` 因此成为必填语义** |
| 17 | 分时/阶梯电价 | **不支持**，保持单一单价 | 不引入电价分段表 |
| 18 | 电表与品牌 | M:N（1:1 / N:1 / 1:N 均存在） | 保留 `brand_id` + 分摊表双轨 |
| 19 | **电表大类** | **可扩展分类字典**（现有合作商 / 民用两类，后续会增）；**大类不改变计算方式** | `meter_categories` + `meters.category_code` |
| 20 | 场地成本 | 共享表要分摊场地成本，且**跟主体走** | 分摊行 `rent_share` + `entity_id` |
| **21** | **共享表挂合同** | 一块共享表 **按品牌各挂一份收款合同**（一表 × N 品牌） | `meter_contract_bindings.brand_id` **进 EXCLUDE 约束键** |
| **22** | **民用电表** | **计入成本** + **与品牌隔离** + **可按大类筛选**；**计算方式与合作商表完全一致**（大类不改变算法） | `category_code='civil'`，`brand_id` 恒空，`electricity_records.meter_category` |
| **23** | **台账筛选维度** | 台账行**必须带电表大类列**，且对**所有大类**通用 | `electricity_records.meter_category` |
| **24** | **滇池两块表** | ✅ **已定**：主人确认是历史误标 ⇒ **改判为普通合作商表**（id 8→台铃、id 62→八维通），**不是场地总表** | 迁移时改 `category_code='partner'` + 补 `brand_id` + **`is_shared` 保持 FALSE** |
| **25** | **柜子品牌维度** | `cabinets` **补 `brand_id`**（现表无此列，是共享表柜数被迫另存的根因） | `cabinets.brand_id` |
| **26** | **大类不承载算法** | 大类只配**分类/展示类**开关（`billable` / `isolated`），**不配** `is_multi_brand` / `billing_mode` / `cost_bearer` 这类算法开关 —— **第五轮把 `is_multi_brand` 也移出大类**（算法开关改挂表级 `is_shared`） | `meter_categories`（见 1.3、4.1） |
| **27** | **民用表单价来源**（第四轮修正） | **民用表不是特例** —— 走与合作商表**同一个** `resolve_meter_price()`；单价取**它自己挂的合同**，实际就是**场地合同**（与同场地其他表的付款侧同源同价）。**不存在「复用品牌方合同」这回事**，也不存在「从多份品牌方合同里挑一份」的歧义 | `meter_contract_bindings` 的 `pay` 角色（1 份场地合同，`brand_id` 空）；大类不额外加机制 |
| **28** | **大类管理入口** | **不新建页面**；`directory` 的「第三方接口配置」已有同类配置形态，需要时比照放置，或仅建表 | 只加 `meter_categories` 表 |
| **29** | **「共享」不是大类**（第五轮修正） | **共享是表级属性 `is_shared`，不是 `meter_categories` 的一个取值。** 主人原话：「我说的共享电表，是有一个特殊的电表，'**所有品牌共用此电表（场地总表）**'，他**可能隶属合作商表也可能隶属民用电表这个大类，或者其他大类**。」⇒ ① 字典**删掉 `is_multi_brand`**；② 大类与 `is_shared` **正交**；③ 现状 `tag='共享电表'` 的 3 块表**另需指定大类**（8.13） | `meters.is_shared`（**人工设置 + 普通列，非生成列**）；迁移时 `'共享电表'` **不再映射为任何分类** |
| **30** | **费用粒度：绑电表**（v6 初定 → **v7 重写**） | **存储粒度 = 电表，聚合维度自由**。主人原话：**「费用最好是绑定在电表上，这样就可以随意按照场地分类或者按照品牌分类，或者按照主体分类了。」** ⇒ 付款表 = `meter_monthly_payments(meter_id, month_period)`；**「一个场地一笔」是 `GROUP BY landlord_id` 的聚合视图，不是存储粒度**（v6 的 `landlord_monthly_payments` **作废** —— 存到场地级会把品牌/主体维度永久丢掉） | `meter_monthly_payments`（见 4.5 / 5.3） |
| **31** | **换表规则**（v6，**推翻决策 16**） | **新建一块表 + 旧表退役**：表号可以变，旧表 `status='removed'` + `removed_at` 并**停止计费**，历史读数留在旧表行上；新表从 `initial_reading`（投运起始表码）起算 | `meters.status` + `removed_at` + `initial_reading` |
| **32** | **`third_party_configs.meter_tag`**（v6） | **保留字段，但不参与任何分类推导**（主人：「我不知道，先保留吧」）—— **既不**强制账户下电表的大类等于它，**也不**作为导入默认值自动写入。实测已证明推不出来（场地总表挂在他类账户下） | 字段留存；`meters.category_code` / `is_shared` **一律人工指定** |
| **33** | **场地总表判据**（v6） | **纯人工判断**（主人：「纯人工判断」）—— 无客观线索可自动识别 ⇒ `is_shared` 是一个**纯手工开关**，建档/编辑时人工勾选 | `meters.is_shared`（**无任何推导规则**） |
| **34** | **损耗行归哪个主体**（v7） | **不分主体，单独列示**（主人：「不分主体，单独列示」）—— 损耗行 `brand_id IS NULL` **且** `entity_id IS NULL`，报表里独立成一行，不并入任何主体 | `electricity_records` 的损耗行 |
| **35** | **换表后是否串联**（v7） | **不串，各出各行**（主人：「不串，各出各行」）—— 新旧表各出各的行；因二者天然共享 `landlord_id` + `brand_id`，同场地/同品牌汇总时数值**自动累加**，已够用 ⇒ **不加** `previous_meter_id` / `site_key` | 无需额外字段 |

---

## 4. 表结构设计

### 4.1 `meters` + `meter_categories`（分类字典与电表主表）

> 下面是**目标态**结构。存量库改造请用 `ALTER TABLE`（见第 6 章迁移映射），**不要 DROP 重建** —— 现有 126 块表的数据必须保留。

```sql
-- ① 分类字典：大类可扩展，且**不承载算法**
--    （主人原话：「这只是电表的大类不同，计算方式还是和其他的一样的」）
--    ★ 第五轮：本表**不再有 is_multi_brand** —— 「共享」不是大类，是表级属性（见 meters.is_shared）
CREATE TABLE meter_categories (
    code            VARCHAR(24) PRIMARY KEY,        -- 'partner' | 'civil' | ...
    name            VARCHAR(50) NOT NULL,           -- '合作商电表' | '民用电表' | ...
    billable        BOOLEAN NOT NULL DEFAULT TRUE,  -- 是否参与电费台账
    isolated        BOOLEAN NOT NULL DEFAULT FALSE, -- ★ 报表分组行为：是否与品牌维度隔离（民用 = TRUE）
                                                    --   注意这是「怎么展示」，不是「怎么算」
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,  -- 停用后不再可选（旧数据仍可引用）
    sort_order      INTEGER NOT NULL DEFAULT 100,
    remark          TEXT
);
-- ⚠️ 本表**不设任何算法开关**（is_multi_brand / billing_mode / cost_bearer 都不设）
--    —— 大类只回答「归哪类、报表怎么分」，不回答「怎么算」（决策 19 / 26 / 29）

INSERT INTO meter_categories
    (code, name, isolated, sort_order) VALUES
    ('partner', '合作商电表', FALSE, 10),
    ('civil',   '民用电表',   TRUE,  30);
    -- ★ 以后新增大类 = 这里插一行；**不需要定义任何算法**（算法只看 meters.is_shared）
    -- ⚠️ 没有 'shared' 这个大类 —— 场地总表用 meters.is_shared 标记（决策 29）

CREATE TYPE meter_status_enum AS ENUM ('active', 'inactive', 'removed');

CREATE TABLE meters (
    id              SERIAL PRIMARY KEY,
    meter_no        VARCHAR(100) NOT NULL UNIQUE,        -- 业务主键，人工编（如「学府路001」）
    meter_name      VARCHAR(200),

    -- 归属
    landlord_id     INTEGER REFERENCES landlords(id) ON DELETE RESTRICT,
    brand_id        INTEGER REFERENCES brands(id)    ON DELETE RESTRICT,
        -- 语义：非空 = 归属某品牌（可多块表同品牌）；空 = 无品牌归属
        -- ⚠️ 「brand_id 为空」**不等于**「共享表」—— 46 块民用电表也全是空。
        --    是否是场地总表，只由 is_shared 决定（决策 29）
    entity_id       INTEGER REFERENCES entities(id)  ON DELETE SET NULL,
    entity_source   VARCHAR(10) DEFAULT 'manual'
                    CHECK (entity_source IN ('auto', 'manual')),   -- 主体继承来源

    -- 大类 / 状态
    category_code   VARCHAR(24) NOT NULL DEFAULT 'partner'
                    REFERENCES meter_categories(code) ON DELETE RESTRICT,
    -- ★ 表级属性（第五轮新增）：是否「所有品牌共用此电表（场地总表）」
    --   TRUE  = 场地总表 → 各品牌电量物理上分不出 → 走人工分摊行
    --   FALSE = 普通表   → 表读数即对象电量     → 单价 × 电量自动算
    --   ⚠️ 与 category_code **正交**：场地总表可以属任意大类
    --   ⚠️ 人工设置（业务事实），**不是生成列**，不能从大类推导
    is_shared       BOOLEAN NOT NULL DEFAULT FALSE,
    status          meter_status_enum NOT NULL DEFAULT 'active',

    -- 计量
    transformer_ratio NUMERIC(10,2) NOT NULL DEFAULT 1,
    initial_reading   NUMERIC(14,2),                     -- 投运初始表码（★ v6 换表规则下成为关键字段）
                                                          --   换表 = 新建行 ⇒ 新表必须给出起始码，否则首月度数算不出来

    -- 设备对接（与业务主键解耦：meter_no 可人工编，device_address 是第三方标识）
    device_address  VARCHAR(100),                        -- 新增：第三方设备地址
    device_id       VARCHAR(100),
    collector_id    VARCHAR(100),
    third_party_config_id INTEGER REFERENCES third_party_configs(id) ON DELETE SET NULL,

    -- 生命周期
    installed_at    DATE,                                -- 新增
    removed_at      DATE,                                -- 新增
    remark          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    -- 一致性：拆除必须有日期，在用不能有拆除日期
    CONSTRAINT ck_meter_removed CHECK (
        (status = 'removed' AND removed_at IS NOT NULL)
        OR (status <> 'removed' AND removed_at IS NULL)
    )
);

CREATE UNIQUE INDEX ux_meters_device_address
    ON meters (device_address) WHERE device_address IS NOT NULL;
CREATE INDEX idx_meters_landlord ON meters (landlord_id, category_code);
CREATE INDEX idx_meters_brand    ON meters (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX idx_meters_shared   ON meters (is_shared) WHERE is_shared = TRUE;   -- ★ 场地总表筛选
```

```sql
-- ★ 第五轮**删除**了这里原先的生成列：
--   ALTER TABLE meters ADD COLUMN is_shared BOOLEAN
--       GENERATED ALWAYS AS (category_code = 'shared') STORED;
-- 删除原因：① 它的前提「category_code = 'shared' 是一个分类」已不成立（shared 不再是分类）；
--           ② 更根本 —— 「是不是场地总表」是**业务事实**，不是从大类推出来的结论。
-- 现在 is_shared 是 meters 表里的**普通布尔列**（定义见上方 CREATE TABLE），由人工设置。
```

**关键变化**：

| 变化 | 理由 |
|---|---|
| `tag` → `category_code`（**引用字典表**，不是枚举） | 现 28 处中文字面量比对；且主人已预告"还会增加其他大类"，硬编码枚举会立刻过时 |
| 新增 `meter_categories` | 把「大类怎么归类/筛选」从代码里的 `if tag == '共享电表'` 变成**数据**（2 个展示类开关列），加类不改代码；**不含任何算法开关**（决策 26 / 29） |
| **新增 `is_shared`（表级普通列）** | ★ 第五轮：把「是否场地总表」从**大类**位置挪到**表级** —— 算法开关随之从字典移到这里；「共享表」判定原本散落各处，现在收敛为一列；**人工设置，非生成列** |
| 新增 `device_address` | `meter_monthly.address = meter_no` 的字符串关联是最大事故源；解耦后业务编号可自由编辑 |
| 新增 `initial_reading` | ★ v6 换表 = **新建表**（决策 31）⇒ 新表的起始码必须有地方存，否则首月度数算不出来；现状只能猜 `prev_reading` |
| `status` 枚举 + 生命周期日期 | 现在无法表达「表已退役」，柜子记录还在就会继续计费 |
| 新增 `third_party_config_id` | 多账户对接关系现挂在 `meter_devices.config_id`（实测列名）上，应上提到电表 |

**`device_address` 的实测依据**：现存 14 块人工建档的表（「美团-归十西路电表」「青桔-龙润路」等）因改了 `meter_no` 而与第三方设备永久失联。V4 拆分后，`meter_no` 可随意改（给人看），`device_address` 一旦建立不再变（给机器认）。

> ⚠️ **换表时（决策 31）**：新表领**新的** `device_address`，旧表行**保留原地址**（它记录的是当时的事实）。`ux_meters_device_address` 是部分唯一索引（`WHERE device_address IS NOT NULL`）⇒ 正常换表不冲突；**只有第三方把同一地址复用给新设备时**，需人工把旧表地址置空以让出唯一性。

**不做的事**：`meters` 里**不含任何价格/金额字段**。单价在合同、金额在台账 —— 这个分层是对的，保持。

### 4.2 `meter_contract_bindings`（新建）

```sql
CREATE TABLE meter_contract_bindings (
    id          SERIAL PRIMARY KEY,
    meter_id    INTEGER NOT NULL REFERENCES meters(id)    ON DELETE CASCADE,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
    role        VARCHAR(10) NOT NULL CHECK (role IN ('pay', 'collect')),
        -- pay     = 付款侧（成本）→ 挂场地合同
        -- collect = 收款侧（收入）→ 挂品牌方合同
    brand_id    INTEGER REFERENCES brands(id) ON DELETE RESTRICT,
        -- ★ 品牌维度（决策 21）。共享表一块表服务多品牌，收款侧必须能每品牌一份：
        --   pay     + brand_id 空   → 该表的付款合同（场地合同），一块表一份
        --   collect + brand_id 非空 → 该表为某品牌服务的收款合同（共享表按品牌多份）
        --   collect + brand_id 空   → 该表整体一个价（合作商表可不填）
    start_date  DATE NOT NULL,
    end_date    DATE,
    remark      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT ck_binding_period CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT ux_binding UNIQUE (meter_id, contract_id, role, brand_id)
);

CREATE INDEX idx_binding_lookup
    ON meter_contract_bindings (meter_id, role, brand_id, start_date);

-- 同一块表、同一角色、**同一品牌**，生效期不得重叠
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE meter_contract_bindings ADD CONSTRAINT ex_binding_no_overlap
    EXCLUDE USING gist (
        meter_id WITH =,
        role     WITH =,
        COALESCE(brand_id, 0) WITH =,     -- ★ 品牌必须进约束键，见下方说明
        daterange(start_date, COALESCE(end_date, 'infinity'::date), '[]') WITH &&
    );
```

> ⚠️ **`COALESCE(brand_id, 0)` 这一项不能省 —— 这是第一版设计的错误。**
> 第一版把约束键写成 `(meter_id, role)`，直接与「共享表是一块表所有品牌共享」冲突：给同一块共享表挂**第二个品牌**的收款合同就会被数据库拒绝。而现状 `meter_shared_allocations` 的唯一约束本来就是 `(address, month_period, brand_id)` **三个键**，binding 的约束键应该与它对等。`COALESCE(..., 0)` 是为了让 NULL 也参与相等判断（`0` 不与任何真实品牌 id 冲突，`SERIAL` 从 1 起）。

**三种合法组合**（约束只保证「同键不重叠」，组合本身的合法性靠业务层校验）：

| role | brand_id | 含义 | 同一时刻上限 |
|---|---|---|---|
| `pay` | 空 | 该表的付款合同（场地合同） | 1 份 |
| `collect` | 非空 | 该表为某品牌服务的收款合同 | **每品牌 1 份，品牌数不限** |
| `collect` | 空 | 该表整体一个价（合作商表用） | 1 份 |

**为什么用 `EXCLUDE` 而不是普通唯一索引**：合同调价场景是「新合同从某月接上」，两份合同在时间轴上必须无缝隙、无重叠。普通唯一索引管不住时间区间，`btree_gist` 的排除约束可以。**并且它天然支持同一块共享表在时间轴上为同一品牌换多份合同**（前一份 `end_date` 接后一份 `start_date`）。

**合同链（承接指针）**：

```sql
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS previous_contract_id INTEGER
    REFERENCES contracts(id) ON DELETE SET NULL;          -- 真外键，非字符串
CREATE INDEX IF NOT EXISTS idx_contracts_prev ON contracts (previous_contract_id);
```

**溯源示例**：查「某表某月的付款单价是从哪份合同来的，以及这份合同的前任是谁」。

```sql
WITH RECURSIVE chain AS (
    SELECT c.id, c.previous_contract_id, c.electricity_price, c.start_date, c.end_date, 1 AS lvl
    FROM meter_contract_bindings b
    JOIN contracts c ON c.id = b.contract_id
    WHERE b.meter_id = 123 AND b.role = 'pay'
      AND b.start_date <= '2027-06-30' AND COALESCE(b.end_date,'9999-12-31') >= '2027-06-01'
    UNION ALL
    SELECT c.id, c.previous_contract_id, c.electricity_price, c.start_date, c.end_date, lvl + 1
    FROM contracts c JOIN chain ON c.id = chain.previous_contract_id
    WHERE lvl < 20
)
SELECT * FROM chain ORDER BY lvl;
```

### 4.3 `meter_readings`（原 `meter_monthly` 改造）

```sql
CREATE TABLE meter_readings (
    id              SERIAL PRIMARY KEY,
    meter_id        INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    period          CHAR(6) NOT NULL,                    -- YYYYMM（自然月归档）
    device_address  VARCHAR(100),                        -- 冗余：同步对接用，不参与关联

    -- 第三方原始值（同步覆盖）
    kwh                NUMERIC(14,2),                    -- 原始表码读数
    raw_start_reading  NUMERIC(14,2),
    raw_end_reading    NUMERIC(14,2),
    raw_start_date     DATE,
    raw_end_date       DATE,

    -- 人工修正真实值（同步永不覆盖）
    actual_kwh             NUMERIC(14,2),
    actual_start_reading   NUMERIC(14,2),
    actual_end_reading     NUMERIC(14,2),
    actual_start_date      DATE,
    actual_end_date        DATE,

    data_source     VARCHAR(16) DEFAULT 'auto',
    synced_at       TIMESTAMPTZ,
    remark          TEXT,

    UNIQUE (meter_id, period)                            -- 从 (address, period) 改为 meter_id
);

CREATE INDEX idx_readings_period ON meter_readings (period);
```

**关键变化**：关联键从 `address` 字符串 → `meter_id` 外键。这一条**一次性消除两类事故**：改电表编号导致读数孤儿、孤儿行无人发现。`device_address` 保留为冗余列仅供同步写入。

**双轨制保留**（主人要求「显示平台值 + 留手动修正口」）：`kwh` 系列（平台）+ `actual_kwh` 系列（真实值），界面**并排显示两个数**，取数一律 `COALESCE(actual_kwh, kwh × transformer_ratio)`。

### 4.4 `meter_shared_allocations`（扩展为「场地总表的分摊行」）

> 本表**只服务 `is_shared = TRUE` 的表**（场地总表）。普通表（含民用表）**永不写这张表** —— 它们走「读数 × 单价」自动算，不需要分摊行。表名沿用历史拼写，语义见 [1.4](#14-场地总表is_shared--一块表服务多品牌binding-必须带品牌维度)。

```sql
CREATE TABLE meter_shared_allocations (
    id              SERIAL PRIMARY KEY,
    meter_id        INTEGER NOT NULL REFERENCES meters(id)  ON DELETE CASCADE,
    month_period    CHAR(6) NOT NULL,
    brand_id        INTEGER NOT NULL REFERENCES brands(id)  ON DELETE RESTRICT,
    entity_id       INTEGER REFERENCES entities(id) ON DELETE SET NULL,   -- 报税主体（覆盖1/2）

    -- 录入（二选一，另一个按单价推导）
    input_mode      VARCHAR(10) NOT NULL DEFAULT 'amount'
                    CHECK (input_mode IN ('amount', 'kwh')),
    collect_amount  NUMERIC(14,2),          -- 应收电费（含税）
    collect_kwh     NUMERIC(14,2),          -- 应收电量
    unit_price      NUMERIC(8,4),           -- 单价：默认取合同，可人工覆盖

    -- 成本分摊（系统按柜数占比计算，快照落表）
    rent_share      NUMERIC(14,2),          -- 分摊的场地租金（跟 entity_id 走）
    cabinet_count   INTEGER,                -- 该品牌柜数（人工录，逐月可调）

    -- 读数快照（主人要求：存快照，历史可复现）
    meter_kwh           NUMERIC(14,2),      -- 当月整表度数
    reading_start_date  DATE,
    reading_end_date    DATE,

    data_source     VARCHAR(16) DEFAULT 'auto',
    remark          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (meter_id, month_period, brand_id)   -- 从 (address, ...) 改为 meter_id
);
```

**相对现状的列变更（重要：多数是「新增」，不是改名）**

现状 12 列：`id, meter_id, address, month_period, brand_id, entity_id, collect_amount, unit_price, remark, created_at, updated_at, cabinet_count`。

| 变更 | 列 | 说明 |
|---|---|---|
| 关联键换 | `address` → `meter_id` | 唯一约束同步从 `(address,month,brand)` 改为 `(meter_id,month,brand)` —— **约束形状不变，现状已支持一表多品牌** |
| **新增** | `collect_kwh` | ⚠️ 现状**没有这一列**，"倒推电量"物理上无处存放（问题 9）；不补则双向录入无法落地 |
| **新增** | `input_mode` | 标记人工录的是金额还是电量 |
| **新增** | `rent_share` | 分摊的场地租金（现状散在 `dividend_calc` 现算，不落表） |
| **新增** | `meter_kwh` / `reading_start_date` / `reading_end_date` | 读数快照，保证历史可复现（`monthly` 表数据被改后不影响历史分摊） |
| **新增** | `data_source` | `auto`/`manual` 徽标与重算保护 |

**双向录入的数学**（决策 2）：

```
input_mode = 'amount'：collect_kwh   = collect_amount ÷ unit_price
input_mode = 'kwh'   ：collect_amount = collect_kwh × unit_price
```

`unit_price` 解析顺序：**分摊行人工值 → 该品牌该月生效的 `collect` binding 合同单价 → 告警跳过**。

**成本分摊口径**（决策 11）：

```
rent_share = 该场地当月场地合同月租 × (本行 cabinet_count ÷ 该场地当月总柜数)
```

总柜数口径：场地内**全部品牌**的柜数（含品牌专用表下的 `cabinets` 记录 + 共享表分摊行的 `cabinet_count`），与现有 `rent._live_cabs` / `dividend_calc._get_landlord_cabinet_totals` 保持一致。

### 4.5 `meter_monthly_payments`（新建：**表级**费用录入 —— 细粒度存储）

主人要求：付款「全部人工录」，但「系统给参考值、留口子填真实值」。

> ★ **v7 定案：费用绑定在电表上。** 主人原话：**「我觉得费用最好是绑定在电表上，这样就可以随意按照场地分类或者按照品牌分类，或者按照主体分类了。」**
> 这条把 v6 的修正**拉了回来** —— **业务事实**是「场地方一个场地开一张单」，但**存储粒度应当是电表**：
>
> ```
> 存储：每块电表一笔（meter_id 维度）      ← 最细，维度信息不丢失
> 聚合：按场地求和  = 「一个场地一笔」 ✓
>       按品牌求和 / 按主体求和 也都天然可得 ✓
> ```
>
> ⇒ **「一个场地一笔」是聚合视图，不是存储粒度**。若直接存到场地级，品牌/主体两个维度就**永久丢失**，之后再也拆不开。

```sql
CREATE TABLE meter_monthly_payments (
    id              SERIAL PRIMARY KEY,
    meter_id        INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
    month_period    CHAR(6) NOT NULL,

    -- 系统建议值（自动算）
    suggest_kwh     NUMERIC(14,2),          -- 参考电量（= 该表当月实际用电量）
    suggest_amount  NUMERIC(14,2),          -- 参考金额（= 参考电量 × 场地单价）

    -- 人工真实值（以这个为准）
    pay_kwh         NUMERIC(14,2),
    pay_amount      NUMERIC(14,2),
    unit_price      NUMERIC(8,4),

    reading_start_date DATE,
    reading_end_date   DATE,
    data_source     VARCHAR(16) DEFAULT 'auto',   -- auto=采纳建议 / manual=人工覆盖
    remark          TEXT,
    UNIQUE (meter_id, month_period)               -- 一块表一月一笔
);
```

**参考值 vs 真实值**：`data_source='manual'` 时必须留 `remark` 说明差异原因（线损、表差等），供审计。

**四个视角都从这一张表聚合出来**（这就是「绑电表」的收益 —— 维度全部经 `meter_id` 关联取得，付款表**不冗余存** `landlord_id`/`brand_id`/`entity_id`，避免不一致）：

| 想要的视角 | 聚合方式 |
|---|---|
| **一个场地一笔**（场地方账单口径） | `GROUP BY landlord_id, month_period` —— 经 `meters.landlord_id` 汇总 |
| 按品牌 | `GROUP BY brand_id` —— 经 `meters.brand_id` 汇总 |
| 按报税主体 | `GROUP BY entity_id` —— 经 `meters.entity_id` 汇总 |
| 单块表 / 逐表损耗 | 直接读本表 |

> ⚠️ **v6 提出的 `landlord_monthly_payments` 已作废**，不要用 —— 把粒度提到场地级会丢掉品牌/主体两个维度。
> ⚠️ 与之对应地，**损耗也回到表级**（每块表一条，见 5.3）—— 因为付款是表级的，逐表才能算出「这块表收了多少、付了多少」，场地级损耗 = Σ 各表损耗。

### 4.6 柜数：维持双载体，但补上柜子的品牌维度

**先补一个结构缺陷**（问题 8）：现状 `cabinets` 只有 6 列（`id, meter_id, cabinet_no, cabinet_type, remark, created_at`），**没有 `brand_id`** —— 品牌只能靠 `meters.brand_id` 推。场地总表（`is_shared = TRUE`）`brand_id` 必然为空，其下柜子就永远推不出品牌，**这才是场地总表品牌柜数被迫存进分摊表的根因**（不是设计选择）。

```sql
-- 柜子补品牌维度（可空：空 = 该表未细分品牌时的占位，兼容存量 170 行）
ALTER TABLE cabinets ADD COLUMN IF NOT EXISTS brand_id INTEGER
    REFERENCES brands(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_cabinets_meter_brand ON cabinets (meter_id, brand_id);
```

补上之后，柜数的品牌维度在**两个载体里都能表达**，不再依赖「表级 brand_id」。

V4 **不强行统一**两个载体（成本高、收益低），但明确边界：

| 表类型 | 柜数载体 |
|---|---|
| **普通表**（`is_shared = FALSE`） | `cabinets` 表 `COUNT(*)`，按 `brand_id` 分组，口径 `GREATEST(1, COUNT(*))`；`brand_id` 为空的柜子（民用表）**不参与品牌分配** |
| **场地总表**（`is_shared = TRUE`） | 分摊行 `cabinet_count`，逐月可调，未录时预填该品牌最近一次值 |
| **兜底** | 整表无任何柜数记录时，≥1 柜归 `brand_id = NULL` |

> ★ **注意这里的划分依据是 `is_shared`，不是大类** —— 一个民用大类的场地总表，柜数同样走分摊行（决策 29）。

**防双算铁律**：`is_shared = TRUE` 的表「已按品牌录柜数」时，其下 `cabinets` 记录**必须排除**。SQL 端用 `NOT EXISTS(... sa.cabinet_count IS NOT NULL)`，Python 端用 `shared_meter_cabinets()` 叠加 —— **必须成对出现，漏一半就双算**（见 `DATA_LINEAGE.md` 8.3）。

> ⚠️ **判据必须是 `is_shared`，不能是 `brand_id IS NULL`** —— 民用电表的 `brand_id` 同样为空（46 块全是空），拿「空」当共享表会把这 46 块误并入。这正是 V4 要把判定收成一个显式布尔列的原因之一。

### 4.7 `electricity_records`（补列：电表大类）

决策 22/23 要求「民用成本计入但要能与品牌隔离、可按大类筛选」。光靠 `brand_id` 为空**不够** —— 场地总表的损耗行 `brand_id` 也是空的，46 块民用电表的 `brand_id` 更是全空。必须有一个**显式的大类列**。

> ⚠️ **别把这一列和 `is_shared` 搞混**：`meter_category` 记的是**大类**（`partner` / `civil` / …），**不是** `is_shared`。场地总表算出的台账行，`meter_category` 填**它自己所属的大类**。要筛「场地总表相关的行」，得回查 `meters.is_shared`（或按 `meter_id` 关联）。

```sql
ALTER TABLE electricity_records ADD COLUMN IF NOT EXISTS meter_category VARCHAR(24);
    -- 值取自 meters.category_code；同一台账行合并多块表时取「主表」的类别
    -- 历史 106 行回填：按 landlord_id + brand_id 反查 meters 推断，无法推断的留 NULL 人工核
CREATE INDEX IF NOT EXISTS idx_elec_category
    ON electricity_records (period, meter_category);
```

**用途**：

| 场景 | 查询 |
|---|---|
| 只看民用成本 | `WHERE meter_category = 'civil'` |
| 排除民用，看换电业务 | `WHERE meter_category <> 'civil'` |
| 成本按大类构成 | `GROUP BY meter_category` |

> 这个列**对所有大类都填**，不只为民用 —— 因为大类可扩展，报表要能按任意大类分组，不能写死三个值。

### 4.8 废弃 / 合并清单

| 对象 | 处理 | 理由 |
|---|---|---|
| `meters.tag` | → `category_code`（引用 `meter_categories`） | 中文字面量比对；且大类要可扩展 |
| `meters.status`（自由文本） | → `meter_status_enum` | 现在只写不读；**v6 起「换表」靠它 + `removed_at` 表达旧表退役**（决策 31） |
| `meter_monthly.address` 关联键 | → `meter_id` FK | 事故源 |
| `meter_shared_allocations.address` 关联键 | → `meter_id` FK | 同源问题 |
| `cabinets`（无品牌列） | **补 `brand_id`** | 共享表下柜子推不出品牌 |
| `meter_devices.meter_id` | 保留，但对接关系上提到 `meters.device_address` | — |
| `third_party_configs.meter_tag` | **保留字段，但不参与任何分类推导**（决策 32） | 实测推不出电表大类 —— 场地总表挂在他类账户下；主人：先保留 |
| `meter_daily/hourly/yearly/status_cache/warnings_cache/meter_collectors` | **保留**，纯同步缓存不参与业务（`meter_collectors` 是采集器快照，127 行） | 无需动 |
| `contracts.cabinets_count` | 保持 DEPRECATED | 2026-09 已标记退役 |

---

## 5. 核心算法

### 5.1 单价解析 V4（替代 `electricity_pricing.resolve_prices`）

**现状问题**：付款侧取「该场地 id 最小的场地合同单价」，**完全不看日期**，多份单价不同时只标记冲突（`pay_price_conflict`），无解。

**V4 规则**：按 `(meter_id, period)` 精确取该月生效的 binding。

```python
def resolve_meter_price(meter_id: int, role: str, period: str,
                        brand_id: int | None = None) -> dict | None:
    """取某表某月某角色（某品牌）的生效合同单价。

    role:     'pay' | 'collect'
    brand_id: ★ 共享表收款侧**必须传** —— 一块表服务多品牌，每品牌各有一份合同。
              None = 不区分品牌（付款侧、合作商表的收款侧）
    period:   'YYYYMM'
    返回 None 表示该月无生效合同 → 调用方告警并跳过（决策 5）
    """
    month_start = f"{period[:4]}-{period[4:6]}-01"
    month_end   = last_day_of_month(period)

    rows = query("""
        SELECT c.id AS contract_id, c.electricity_price, c.tax_enabled,
               c.tax_rate, c.post_tax_electricity_price,
               c.start_date, c.end_date, c.entity_id
        FROM meter_contract_bindings b
        JOIN contracts c ON c.id = b.contract_id
        WHERE b.meter_id = %s AND b.role = %s
          AND COALESCE(b.brand_id, 0) = COALESCE(%s, 0)     -- ★ 品牌维度
          AND b.start_date <= %s
          AND COALESCE(b.end_date, '9999-12-31') >= %s
        ORDER BY b.start_date DESC
        LIMIT 1
    """, (meter_id, role, brand_id, month_end, month_start))

    return rows[0] if rows else None
```

**解析顺序（共享表收款侧，逐品牌独立解析）**：

```
1. 分摊行 unit_price（人工覆盖，最高优先）—— 表结构里已有此列，保留
2. 该表该月生效的 collect binding：
   a. brand_id = 该品牌的绑定（共享表为某品牌专签的合同）   ← 优先
   b. brand_id IS NULL 的绑定（整表通用价 / 全品牌合同）    ← 次之
3. 都没有 → 告警「缺单价，无法推导」，跳过该行（决策 5）
```

> **关键差异**：现状付款侧取「该场地 id 最小的场地合同单价」，**多品牌、多合同时无法区分**（只标记 `pay_price_conflict`）。V4 按 `(meter_id, role, brand_id)` 三个键精确定位，冲突在数据结构层面就不可能出现（EXCLUDE 已禁止）。

**税口径保持不变**：单价一律取**税前** `electricity_price`，税费单独算 —— 价内税，`税费 = 含税金额 × 税率`，`不含税 = 含税金额 − 税费`（`split_tax`）。付款侧**不计税**。

### 5.2 合作商电表：合同驱动

```
电量 = COALESCE(actual_kwh, kwh × transformer_ratio)
收款 = 电量 × collect_binding.合同单价（税前）
税费 = 收款 × 税率（仅当 tax_enabled）
收款净额 = 收款 − 税费
付款 = 电量 × pay_binding.合同单价
利润 = 收款净额 − 付款
```

**无合同的处理**：该月无 `pay` 或 `collect` binding → 该表**跳过**并进入告警清单（决策 5）。不再像现状那样「取 id 最小那份」兜底。

### 5.3 场地总表：人工驱动（一块表 × N 品牌）

```
# ① 表级付款（人工录，系统给参考）—— 每块表一笔
suggest = 该表当月读数 × 场地单价              # 场地单价 = resolve_meter_price(表, 'pay', 月)
real    = meter_monthly_payments.pay_amount    # 人工填，优先
# 场地级应付 = GROUP BY landlord_id 求和（聚合视图，不是另一张表）

# ② 品牌分摊行（逐行双向推导；一行 = 一个品牌；只针对场地总表）
for a in 分摊行(场地总表, 月):                  # 唯一键 (meter_id, month, brand_id)
    # ★ 传 brand_id：一块场地总表每个品牌各有一份收款合同
    price = a.unit_price or resolve_meter_price(表, 'collect', 月, brand_id=a.brand_id)
    if a.input_mode == 'amount': a.collect_kwh    = a.collect_amount / price
    else:                        a.collect_amount = a.collect_kwh * price
    a.rent_share = 场地月租 × a.cabinet_count / 场地总柜数
    a.meter_kwh, a.reading_* = 当月整表读数快照

# ③ 损耗（决策 13：单独成行，不摊；决策 34：不分主体、单独列示）—— 逐表算
品牌电量合计 = Σ a.collect_kwh                 # 跨该表全部品牌行求和
损耗电量     = 真实付款电量 − 品牌电量合计       # 通常 > 0（线损）
损耗金额     = 损耗电量 × 场地单价
```

> ⚠️ **① 与 ③ 都是表级**（v7 修正）—— 费用与损耗都**绑在电表上**，场地级只是 `GROUP BY landlord_id` 的**聚合结果**（决策 30）。这样品牌、主体两个维度才不会丢。
> 逐表损耗的形态：**品牌专用表**无分摊行 ⇒ 其品牌电量 ≈ 表读数，损耗理论为 0；**场地总表**损耗 = 总表读数 − Σ 各品牌分摊电量 > 0（线损）；**民用表**无品牌 ⇒ 不产生损耗行。

**多品牌的两个要点**：

1. **每个品牌独立解析单价** —— 龙泉路一块表服务云驰 / 永群 / 电皇后三家，三家的收款合同单价可以完全不同，`resolve_meter_price` 必须**逐品牌调用**。
2. **品牌行数不受限** —— 约束 `UNIQUE(meter_id, month, brand_id)` 保证「一表一品牌一月一行」，品牌数无上限；EXCLUDE 约束（4.2）保证同一品牌的合同在时间轴上不重叠。

**与现状的差异**：现状把损耗按电量比例**摊进各品牌付款额**（`scale = full_kwh / alloc_kwh_sum`，`electricity.py:647-650`）。V4 改为**独立损耗行**，各品牌付款额不再被放大，成本单独可见。

### 5.4 台账生成 V4

**现状分组键**：`(landlord_id, brand_id, entity_id)`。

**V4 两阶段**（先表级、后聚合），因为场地总表要逐表独立、损耗要单独成行。
★ **分支条件只看 `is_shared`，不看大类**（决策 29）：

```
阶段一：表级明细（每块表展开）
  ── is_shared = FALSE（普通表，不论属哪个大类）──
      有品牌（合作商表）→ 1 条：[付款 电量×场地价] + [收款 电量×品牌价]
      无品牌（民用表）  → 1 条：[付款 电量×场地价] + [收款 0]，brand_id = NULL
  ── is_shared = TRUE（场地总表，不论属哪个大类）──
      N 条：[付款 分摊] + [收款 分摊行金额]，每品牌一条
          + 1 条损耗行
  每条明细都带自己的 category_code（取自 meters，**不因 is_shared 而改变**）

阶段二：聚合成台账行（landlord × brand × entity × period）
  合并同一分组下多块表的明细
  损耗行单独成一条：brand_id = NULL, entity_id = NULL，**不分主体**（决策 34）
  每行写 meter_category（决策 23）：取该组主表的 category_code
  ★ 场地级视图 = 对上述行按 landlord_id 汇总（纯查询，不额外建表，决策 30）
```

**民用表的处理**（决策 22 / 27）—— **算法与合作商表完全相同**，唯一区别是收款侧没有对象：

```
民用电表：
  电量 = COALESCE(actual_kwh, kwh × transformer_ratio)   # 与合作商表同一公式
  单价 = resolve_meter_price(该表, 'pay', 月)                    # 计算方式不变
         = 该表挂的场地合同 electricity_price    # 同场地品牌表的付款侧同一份合同、同一个价
  金额 = 电量 × 单价                                       # 与合作商表同一公式（计入我方成本）
  收款 = 0（没有品牌方向我方付这笔钱）
  brand_id       = NULL      ← 与品牌行天然隔离
  meter_category = 'civil'   ← 供筛选（关键：仅靠 brand_id 空无法与「损耗行」区分）
```

> ✅ **第四轮纠正**：上一版写的「民用表默认复用该场地的品牌方合同单价」是**误读** —— 品牌方合同是**向品牌收钱**的价，与民用表的**成本**方向相反，本就不该用。正确模型：民用表与合作商表的差异**只在报表归类**，算账是**同一套**；单价一律来自**付款侧合同（场地合同）**，与同场地品牌表的付款侧完全同源。**因此 8.2「取哪一份」的问题不存在（原 A/B/C 选项全部作废）。**

民用电表**不出现在任何「按品牌汇总」的报表里**，但会出现在「按大类汇总」「场地总成本」里 —— 这是主人要的「计入成本但隔离」。

**生成前置校验**（任一不通过则跳过该表/该组并告警）：

| 校验 | 不通过的后果 |
|---|---|
| 表有 `landlord_id` | 跳过（96 块无归属表全在此拦下） |
| 表 `status = 'active'` | 跳过（已拆除的表不再生成） |
| 表所属大类 `billable = TRUE` | 跳过（大类级总开关，某大类若确定不核算可置 `FALSE`） |
| 该月有生效的 `pay`/`collect` binding（或共享表有分摊行） | 跳过 + 告警 |
| 该月有读数行 | 跳过 + 告警 |

**人工修改保护**（保持现状）：`electricity_records.data_source = 'manual'` 的记录，重算时需确认是否覆盖；`pay_status` / `collect_status` 人工状态**不被重算覆盖**。

### 5.5 报税主体解析

```python
def resolve_entity(meter: dict, alloc: dict | None, contract: dict | None) -> int | None:
    """三级优先级（决策 9）"""
    if alloc and alloc.get("entity_id"):     # 覆盖 2：分摊行
        return alloc["entity_id"]
    if meter.get("entity_id"):               # 覆盖 1：电表
        return meter["entity_id"]
    if contract and contract.get("entity_id"):   # 默认：合同（= 场地 × 品牌）
        return contract["entity_id"]
    return None                              # 兜底：无主体 → 告警
```

注意现状是 `分摊行 → 合同 → 电表`（合同优先于电表），**V4 调整为 `分摊行 → 电表 → 合同`** —— 因为主人明确「同场地同品牌不同电表可以不同主体」，电表级必须优先于合同级（合同是场地×品牌维度，比电表粗）。

---

## 6. 迁移映射

| 旧 | 新 | 转换规则 |
|---|---|---|
| `meters.tag` | `meters.category_code` | `合作商电表→partner` / `民用电表→civil`；⚠️ **`共享电表` 不映射为任何 `category_code`**（它不是大类，见下一行）；**未知标签不静默映射**，需建新大类或归 `partner` 后人工核 |
| `meters.tag='共享电表'` | **拆成两件事**：`is_shared = TRUE` + **另补一个 `category_code`** | ★ 第五轮核心变更。`tag='共享电表'` 描述的是**表的用法**（所有品牌共用此表），V4 里它就是 `is_shared = TRUE`；**大类归属另算，需人工指定**（3 块，见 [8.13](#8-未决问题)）。<br>⚠️ **滇池 id=8 / id=62 是例外**：主人已确认为误标 ⇒ 它们是**普通合作商表**（`category_code='partner'`、补 `brand_id`、**`is_shared` 保持 FALSE**），见 8.9 |
| `meters.status`（`'正常'`） | `meter_status_enum` | `正常→active`，其余人工核；**v6 起：新表投运必须同时给 `initial_reading`，退役表置 `removed` + `removed_at`**（决策 31） |
| `meters.meter_no` | `meters.meter_no` + `device_address` | `device_address` 初始 = 与 `meter_devices` join 匹配到的 address，匹配不到则 = `meter_no` |
| `cabinets` | 补 `brand_id` | `is_shared = FALSE` 的表：`brand_id = meters.brand_id`（民用表因 `meters.brand_id` 为空而留空）；`is_shared = TRUE` 的表：留空（柜数走分摊行） |
| `meter_monthly.address` | `meter_id` | `JOIN meters ON meters.meter_no = meter_monthly.address`；**匹配不到的行导出为孤儿清单人工处理** |
| `meter_shared_allocations.address` | `meter_id` | 同上 |
| `electricity_records` | 补 `meter_category` | 历史 106 行按 `(landlord_id, brand_id)` 反查 `meters.category_code` 推断，推不出的留 NULL 人工核 |
| `contracts.previous_contract_id` | 新增 | 初始全 NULL，按业务人工补链 |
| `meter_contract_bindings` | 新增 | **需人工建**：按现有「场地合同 → 该场地全部表」批量生成 `pay` binding（`brand_id` 空）；品牌方合同 → 按 `(landlord_id, brand_id)` 生成 `collect` binding（`brand_id` = 该品牌） |
| `electricity_records`（金额） | 保留 | 历史台账不动（已固化，含单价快照） |

**迁移顺序**（避免循环外键）：

```
1. 建 meter_categories + 写入两个大类（`partner` / `civil`）+ meter_status_enum + `meters.is_shared` 列 + 其余新表
2. 迁移 meters：
   - tag → category_code（**`共享电表` 不参与映射**）
   - device_address 回填（join meter_devices）
   - ★ **处理 `tag='共享电表'` 的 5 块**（本轮拆成两支）：
       · **滇池 id=8 / id=62** → 误标 ⇒ `is_shared=FALSE`、`category_code='partner'`、补 `brand_id`（8→台铃 1、62→八维通 2）
       · **龙泉路108 / 大观2 / 学府路68** → 真场地总表 ⇒ `is_shared=TRUE`，⚠️ **`category_code` 待主人指定**（见 [8.13](#8-未决问题)），未定则此步无法完成
3. 迁移 meter_readings（address→meter_id），孤儿行导出人工处理
4. 迁移 meter_shared_allocations（address→meter_id）+ 补新列（collect_kwh 等）
5. cabinets 补 brand_id（按 meters.brand_id 回填；`is_shared=TRUE` 的表与民用表留空）
6. 批量建 bindings（pay 按场地；collect 按 (表, 品牌)）
7. electricity_records 补 meter_category 并回填历史 106 行
8. 建 EXCLUDE 约束 —— ⚠️ **必须在第 6 步的数据清完重叠后再加**，否则会直接失败
```

**切换前必须完成的数据治理**（否则跑不出数字）：

| # | 事项 | 量级 | 不做的后果 |
|---|---|---|---|
| 1 | 无场地归属的电表补 `landlord_id` | **96 块** | 无法进任何台账 |
| 2 | 补齐场地合同 | 49 场地仅 **19 份** | 大面积跳过 + 告警 |
| 3 | 民用电表补场地归属 | 46 块中 **45 块无场地** | 民用成本挂不上任何场地，进不了成本 |
| 4 | **滇池两块改判为普通合作商表**（规则已定：8→台铃、62→八维通） | 2 块 | 口径走错（人工分摊 vs 合同单价）；改判后还需补场地 69 的品牌方合同 |
| 5 | 分摊行补 `unit_price` | 现有 6 行**全空** | 双向推导无单价可用，只能等报警 |
| 6 | **3 块场地总表指定 `category_code`**（龙泉路108 / 大观2 / 学府路68） | 3 块 | `category_code` 是 NOT NULL，不定**迁移直接失败**（见 [8.13](#8-未决问题)） |

---

## 7. 受影响代码清单

### 后端

| 文件 | 改动 |
|---|---|
| `domain/electricity_pricing.py` | **重写**：`resolve_prices` → `resolve_meter_price(meter_id, role, period, **brand_id**)` —— **加品牌参数**（共享表逐品牌解析） |
| `domain/meter_category.py`（**新增**） | 大类字典读取（`billable` / `isolated`）—— **只定分类与报表归属，不含算法**；算法分叉改由 **`meters.is_shared`** 承担；替代散落各处的 `if tag == '共享电表'` 判断 |
| `domain/electricity_shared.py`（**新增，可选**） | 把 `is_shared` 相关判定（场地总表的分摊/损耗算法入口）收敛成一处，避免 5.3 的分支逻辑散落 |
| `api/electricity.py` | 生成器**重写**：两阶段（表级→聚合）、**费用与损耗逐表算**（决策 30 —— 绑电表，场地级只是聚合）、**损耗单独成行且不分主体**（决策 34）、**民用表成本入账**、**写 `meter_category`**、SKIP+告警 |
| `api/meters.py` | 建档/编辑支持 `category_code` / **`is_shared`（人工勾选，决策 33）** / `device_address` / 生命周期；**换表 = 新建 + 旧表退役**接口（决策 31）；binding 管理接口（**按品牌挂**） |
| ~~`api/meter_categories.py`~~ | **不建**（决策 28）：大类**不做独立页面、不做 CRUD 接口**，只读字典；如需 UI，比照 `directory` 的「第三方接口配置」形态放置 |
| `repositories/meter_repo.py` | 列白名单增删（含 **`is_shared`**）；`status` 改枚举；大类校验 |
| `repositories/shared_allocation_repo.py` | 双向录入（**补 `collect_kwh`**）、`rent_share`、快照列、`meter_id` 关联 |
| `repositories/cabinet_repo.py` | 支持 `brand_id`；柜数按品牌分组 |
| `domain/dividend_calc.py` | 电费成本改读新表；`rent_cost` 口径与 `rent_share` 对齐；**民用成本并入同一电费成本池**（与合作商表付款侧同一条路径，不做特殊分支） |
| `api/rent.py` / `repositories/rent_repo.py` | `_live_cabs` 与新柜数口径对齐 |
| `api/overview.py` | `_shared_cab_weights`、`station_board` 等按新表改；**报表支持按 `meter_category` 筛选** |
| `infra/auth_scope.py` | `METER_TAGS` 常量 → 读 `meter_categories` |
| `jobs/sync_meters.py` | 同步写 `meter_id`；`device_address` 映射；**只同步 `status='active'` 的表**（已退役的表不再拉数，决策 31） |
| `alerts.py` | 新增：无合同告警、无单价告警、损耗超阈值告警 |

### 前端

| 文件 | 改动 |
|---|---|
| `pages/Meters.tsx` | **按大类分开展示**（分组由 `meter_categories` 动态生成，**不写死**）；**新增「场地总表」标记/筛选**（读 `is_shared`）—— 它与大类分组是**两个并列维度**，不是同一层；读数双轨并排（平台值/真实值）；生命周期操作；binding 绑定界面（**场地总表按品牌挂多份**） |
| `pages/Electricity.tsx` | 台账展示损耗独立行；**按大类筛选**（民用 / 换电业务分开看）；`data_source` 徽章 |
| `lib/alloc.ts` | 与后端新柜数口径对齐（**前后端双实现必须同改**） |
| `pages/Brands.tsx` / `Contracts.tsx` / `Entities.tsx` | 柜数口径联动 |

---

## 8. 未决问题

> 以下需主人拍板或补充信息，未定前不建议开工。

**8.1 共享表挂 binding 的范围？**（第二轮更新）

主人已确认「共享表是一块表所有品牌共享」，binding 用法因此明确为：

| 角色 | 挂不挂 | 作用 |
|---|---|---|
| `pay` | **挂**（1 份场地合同，`brand_id` 空） | 生成付款参考值（实测整表读数本来就自动同步，参考值有意义） |
| `collect` | **建议挂**（每品牌 1 份，`brand_id` 非空） | **给分摊行提供默认单价** —— 人工不填 `unit_price` 时自动取该品牌合同价 |

**需主人确认**：业务上「每品牌一份收款合同」是否真的存在？（例如龙泉路的云驰 / 永群 / 电皇后三家，是否各自签了品牌方合同？）若不存在，`collect` binding 留空、单价全人工录，功能不受影响。

**8.2 民用表算法 —— ✅ 已定**（第四轮推翻重写）

主人原话：**「民用表和合作表，只是电表的一个大类。计算方式都是一样的。」**

| 项 | 结论 |
|---|---|
| 算法 | **与合作商表完全同一套**（`单价 × 电量`），**没有民用专属分支** |
| 单价来源 | **场地合同**（该表的 `pay` binding）—— 与同场地其他表的**付款侧同源同价**，**不是品牌方合同** |
| 金额方向 | **成本**（我方付给场地方）—— 由单价来源唯一确定，不存在方向歧义 |
| 收款 | 无（没有品牌方可收，不生成收款行） |
| 报表 | 按 `meter_category = 'civil'` 隔离 / 筛选 |
| 分红口径 | 并入**同一个电费成本池**（与合作商表付款侧同一条路径），不做特殊分支 |

> 原「从多份品牌方合同里挑一份」的选项 **A / B / C 全部作废** —— 该问题建立在一个误读之上（品牌方合同是**向品牌收钱**的价，与民用表的**成本**方向相反，本就不该用）。
> 遗留（属数据治理，不是算法问题）：46 块民用表中 **45 块无场地归属** ⇒ 无场地 = 无场地合同 = 无单价 ⇒ 仍会落入「跳过 + 告警」（决策 5）。

**8.2b 民用表算出的金额方向 —— ✅ 已定**（已并入 8.2）

金额方向 = **成本**（我方付给场地方）。单价取的是**场地合同**（付款价），所以「电量 × 单价」天然就是我方支出，不存在方向歧义。

**8.3 品牌专用表要不要也落「场地成本分摊」表？**
主人只提了共享表要分摊场地成本。现状品牌专用表的场地成本是在 `dividend_calc` 里现算的。**统一落表**还是**维持两套**？

> ★ **我的建议：统一落表**。理由与决策 30 同源 —— **落表 = 存事实，现算 = 存公式**；公式一旦改了，历史就跟着变。专用表落表后，`dividend_calc` 只做读取，口径与场地总表完全一致。代价是迁移时要补一批历史行（可只从切换月起落，历史仍走现算）。

**8.4 场地成本分摊的「总柜数」口径**
分母是否包含共享表分摊行里的 `cabinet_count`？（现状是包含的，但需要确认这是业务意图。）

**8.5 损耗行归到哪个报税主体？—— ✅ 已定**（v7）

**不分主体，单独列示**（主人：「不分主体，单独列示」）⇒ 损耗行 `brand_id IS NULL` **且** `entity_id IS NULL`，报表里独立成一行，不并入任何主体（决策 34）。

**8.6 一个品牌方合同能不能挂多块表 / 跨场地？**
同场地同品牌多表是现实（场地 100、4 各 2 块）。跨场地的品牌合同要不要允许？（建议加约束：binding 的合同 `landlord_id` 必须等于表 `landlord_id`。）

> ★ **我的建议：允许「一份合同挂同场地多块表」，禁止跨场地**。实测 11 份品牌方合同全部带 `brand_id` 且属于某一场地 ⇒ 跨场地在业务上不存在，加一条「binding 的合同 `landlord_id` 必须等于表 `landlord_id`」的校验既安全又不误伤。实现上：现有 `EXCLUDE(meter_id, role, COALESCE(brand_id,0), daterange)` 已允许同合同挂多表（不同 `meter_id` 不冲突），**无需改约束，只需加一条业务校验**。

**8.7 主从拓扑（总表−分表）要不要支持？**
本次按平铺建模。若未来出现真正的进线总表，需要给 `meters` 加 `parent_meter_id` 并改付款口径。

**8.8 历史数据迁移由谁做？**
96 块无归属表 + 30 个场地缺合同，是**人工数据治理工作**，不是代码能解决的。需要排期。

**8.9 滇池两块表改判 —— ✅ 已定**（第三轮）

主人确认改判为**合作商电表**：`id=8`（台铃-滇池国际会展中心站）→ `brand_id=1`（台铃）、`id=62`（八维通-滇池国际会展中心）→ `brand_id=2`（八维通），迁移时一并改。

**遗留**：场地 69 **一份合同都没有**（既无场地合同、也无品牌方合同），改判后这两块表仍会因「无合同」被跳过，**需补合同**。

**8.10 大类管理入口 —— ✅ 已定**（第三轮）

**不做独立页面**（主人原话：`directory` 的「第三方接口配置」已经有了，不用单独做一个页面；数据库如果有需要，可以新增加一张表）。⇒ 只加 `meter_categories` 表，**不建 CRUD 页面与接口**。

**8.11 已生成的台账，大类 / `is_shared` 被改了要不要重算？**
例如滇池 `is_shared` 由 `TRUE` 改为 `FALSE`、`category_code` 由待定改为 `partner`。建议：**历史不动，新月份按新值**（与 `data_source='manual'` 保护逻辑一致）。需确认。

> **同构场景（v6）**：**换表**（决策 31）同理 —— 旧表退役、新表启用，**历史月份仍归旧表**，新月份由新表产生。这条规则可以一次覆盖三类变更（改大类 / 改 `is_shared` / 换表）。

**8.12 「按大类筛选」要做到哪一层？**
台账行级筛选（`electricity_records.meter_category`）已定。**总览/分红/场地数据板是否也要按大类分组？** 例如「应付电费」是否要拆成「换电业务 / 民用」两块显示。

> ★ **我的建议：先做「台账 + 看板」两级**。台账行级是数据基础（已定），看板（总览 / 分红 / 场地数据板）加一个**可切换的分组开关**（默认合并显示，需要时按 `meter_category` 拆）—— 这样既满足「方便筛选」，又不会把现有报表全部改成多块，改动可控。全系统铺开可以留到有明确需求时再做。

**8.13 3 块场地总表分别归哪个大类？**（第五轮新增 —— **迁移阻塞项，优先级最高**）

主人原话：**「他可能隶属合作商表也可能隶属民用电表这个大类，或者其他大类。」**

⇒ 三块表已确认为**场地总表**（`is_shared = TRUE`），但它们的 **`category_code` 还没定**：

| 表号 | 场地 | 现状 `tag` | 待定项 |
|---|---|---|---|
| 260319554778 | 龙泉路 108（德利邦） | 共享电表 | `category_code` = `partner`？`civil`？新大类？ |
| 251206550085 | 大观 2（大观体育公园） | 共享电表 | 同上 |
| 学府路001 | 学府路 68 | 共享电表 | 同上 |

**为什么非定不可**：`meters.category_code` 是 **NOT NULL**，且 [4.7](#47-electricity_records补列电表大类) 的 `electricity_records.meter_category` 要按它落值 ⇒ 不定就**卡在迁移第 2 步**。

**好消息：代价很低，不影响金额。** 因为**大类不改变算法**（决策 19 / 29），这三块表选哪个大类，`电量 × 单价` 或「人工分摊」的结果**完全一样** —— 变的只是**报表归类与筛选命中**。所以按「你希望在哪个分类/筛选下看到这三块表的电费」来定即可。

**备选路径**：
| 选项 | 含义 |
|---|---|
| `partner` | 这三块表计的是**换电业务**的场地总电 → 归合作商大类 |
| `civil` | 计的是**民用/办公**用电 → 归民用大类 |
| **新增大类**（如 `site`「场地总表类」） | 都不贴切时，按决策 29 **只需在 `meter_categories` 插一行**，不需要定义算法 |

> 💡 **反过来看，这题也是检验模型对不对的好例子**：如果「共享」真的该是第 3 个大类，那么这三块表就不需要回答「归哪个大类」；正是因为共享是**横向属性**，才必须为它们各自指定大类 —— 主人这句「可能隶属…也可能隶属…」本身就是本轮降维的直接证据。

**★ 我的建议（v7 查实来源后）**：

| 表 | 场地 | 来源（v7 实测） | 我倾向 |
|---|---|---|---|
| 260319554778 | 龙泉路 108 | 第三方拉取，挂 config 2「民用账户」 | `partner` 或新开 `site` |
| 251206550085 | 大观 2 | 第三方拉取，挂 config 2「民用账户」 | 同上 |
| 学府路001 | 学府路 68 | **手工建档**（无设备记录） | 同上 |

三条路，按你想在报表里**怎么看到它们**来选：

| 选项 | 何时选 | 代价 |
|---|---|---|
| **统一归 `partner`** | 只想尽快完成迁移 | 零（不改字典）；但报表里与普通合作商表混在一起 |
| **新开 `site`（场地总表）类** ← **我推荐** | 想让报表一眼区分「整场地总电」 | 零（`meter_categories` 插一行，不定义算法）；筛选最清晰 |
| 归 `civil` | 若你确认这些表计的是民用/办公电 | 零；但两块第三方表挂「民用账户」**不能作为依据**（决策 32：账户推不出真相） |

> ⚠️ 无论选哪个，**金额都不变**（大类不改变算法，决策 19）—— 只影响它出现在哪个筛选里。所以**这题的决策成本很低，不必纠结**。

**8.14 换表后，新旧两块表在报表里要不要「合并成一处」？—— ✅ 已定**（v7）

**不串，各出各行**（主人：「不串，各出各行」）⇒ 新旧表各出各的台账行；因二者天然共享 `landlord_id` + `brand_id`，同场地 / 同品牌汇总时数值**自动累加**，已满足需要。**不加** `previous_meter_id` / `site_key`（决策 35）。

**8.15 场地级付款落到台账的哪一行？—— ✅ 已定（问题前提被消解）**（v7）

决策 30 经 v7 重写后，这个问题的前提**不再成立** —— 费用**绑在电表上**，台账行仍按 `(landlord × brand × entity)` 聚合：

| 想要的视角 | 怎么来 |
|---|---|
| **场地级「一笔」** | `GROUP BY landlord_id` 的**查询结果**（不是一条物理行） |
| 各品牌行 | 按 `(landlord, brand, entity)` 聚合时，该组内**各表付款之和**自然落入 |

⇒ 既不需要「单独成一条付款行」，也不需要「按占比二次分摊」。

> ✅ **顺带确认**：现状 `electricity.py:712` 的做法（各表付款累加后落分组行）**与 v7 口径一致，无需改动**。v6 的担心（「只在单品牌场地才等价」）源于把「场地一笔」误当成了**存储粒度**。

---

## 附：与现有文档的关系

| 文档 | 关系 |
|---|---|
| `DATA_LINEAGE.md` | **现状**溯源手册（V3 口径），本草案的输入。V4 实施后需同步更新 |
| `METER_TAG.md` | 2026-08「电表标签」设计；本草案 4.1 节把 `tag` **拆成两个正交维度**：`category_code`（大类字典）+ `is_shared`（表级布尔），见决策 29 |
| `ELECTRICITY_RATIO.md` | 互感器倍数规则，V4 保持 `COALESCE(actual_kwh, kwh × ratio)` 不变 |
| `MANUAL_READING_ACTUAL.md` | 「实际值」字段设计，V4 的双轨读数直接继承 |
| `METER_API_ACCOUNTS.md` | 第三方多账户，V4 将账户关系从 `meter_devices` 上提到 `meters` |
