# 数据库全量重设计 v2 — 一条主链串联场地方 / 电表 / 股东分红

> 状态：**设计完成**（2026-08，只出设计文档 + 建表 SQL，不改业务代码与 mock 数据）
> 配套建表 SQL：`backend/app/migrations/2026_08_full_redesign.sql`（全部 **39 表 + 3 视图**，幂等）
> 本文替代分线文档的"总览"作用：① 电表/② 合同/③ 分红三份 `*_LINE_DESIGN.md` 的结论全部并入本设计，
> 本设计把**所有表**（含派生台账、审批、用户）统一收口，避免再出现"各写各的"。

---

## 一、为什么重设计

上一版（增量打补丁的产物）存在六大类杂乱，核心都出在**数据没有一条清晰的主链**：

| # | 问题 | 表现 | 后果 |
|---|---|---|---|
| 1 | **电表两套实现** | 业务 `meters` 表 vs `meter_repo_v2` 直读 `meter_devices`（Meters 页在用） | Meters 页看不到站点/品牌/场地；与电费/分红页面脱节 |
| 2 | **`meter_monthly` 三套 schema** | `database_init.sql`、`sync_meters.py`、`meter_repo_v2` 各写各的列（含不在任何建表脚本里的 `d0`、`year_month`、`date`） | 同一张表无法重建出可用库；部署即炸 |
| 3 | **`landlord` 双源** | `meters.landlord_id` 与 `stations.landlord_id` 各存一份，两条匹配路径（electricity 走站点、dividend 走电表） | 同一笔电费在两个页面算岔 |
| 4 | **租金三处记录** | `contracts.monthly_rent` / `rent_leases|rent_incomes|rent_receipts` / 美团 Excel 运行时解析 | 同一场地租金多个数字 |
| 5 | **period 双轨** | 6 位 `202608` 与 7 位 `2026-08` 混存 | 跨表关联（分红↔台账）全部落空 |
| 6 | **派生值混存** | `contracts.venue_cost`、`rent_incomes.profit`、`contracts.pay_status` 等算出来的值落库 | 改一处源头，库里的派生值就脏 |

**重设计原则**：
1. **一条主链**：`场地方(landlord) → 站点(station) → 电表(meter) → 合同(contract) → 台账/分红(derived)`，所有表都能在主链上找到位置。
2. **源头三层**：第三方接入（配置→缓存→档案）与人工数据（档案→配置→规则）分层清晰，**缓存只写不读、档案只读不写**。
3. **派生不落库**：能实时算的（柜数、venue_cost、pay_status、场地汇总）一律实时算，落库的派生值只有"快照"（分红记录/电费台账，因为历史不可变）。
4. **period 全系统 6 位 `YYYYMM`**。

---

## 二、一条主链（全局串联）

```
                         ┌────────────────────────────────────────────────────────┐
                         │  档案域（Directory 维护，主链的"名字"）                  │
                         │  brands  entities  landlords  shareholders  introducers │
                         │  entity_brands（主体↔品牌）  platform_users（登录）      │
                         └───────┬──────────────────────────┬─────────────────────┘
                                 │ landlord_id              │ shareholder_id / introducer_id
        ┌─ 第三方接入域（GET-only）│                          ▼
        │  third_party_configs（账户）                分配规则域
        │      ↓ 同步                          station_shareholder_configs
        │  meter_devices / meter_status_cache    station_introducer_configs
        │  meter_monthly|daily|hourly|yearly     （mode/ratio/fixed_amount/周期/生效期）
        │  meter_warnings_cache / sync_logs                    │
        └──────────────┬─────────────────────────┬────────────┘
                       ▼ 导入/建档                │
        ┌──────── 电表档案域 ────────┐            │
        │  meters（station/brand/    │            │
        │   landlord/entity/倍数/标签）│           │
        │  cabinets（柜子，挂电表）    │            │
        └───────┬───────────────────┘            │
                │ meter_no / address=读数        │
        ┌───────▼──────── 合同域 ─────────┐      │
        │  contracts（场地合同=成本/       │      │
        │   品牌方合同=收入，含单价/月租/税）│      │
        │  rent_payment_schedule          │      │
        │  rent_income_schedule           │      │
        └───────┬─────────────────────────┘      │
                │ 度数 × 单价                    │
        ┌───────▼──── 台账派生域 ─────────┐      │
        │  electricity_records(+details)  │      │
        │  operating_expenses（独立输入）   │      │
        │  dividend_records(+shares)  ◄───┘ 按分配规则分摊
        └───────┬─────────────────────────┘
                │ 聚合
        ┌───────▼──────── 支持域 ────────┐
        │  landlord_site_summary（视图）   │
        │  landlord_monthly_summary（视图）│
        │  approval_*（审批流转）          │
        └────────────────────────────────┘
```

**主链上的三个关键 JOIN（全系统统一，不允许有第二套）：**

```
① 电表→场地：   meters.station_id → stations.landlord_id        （landlord 单源，meters.landlord_id 仅冗余跟随）
② 电表→品牌：   meters.brand_id → brands.id                     （1 电表 = 1 品牌，派生收款单价）
③ 度数→单价：   meter_monthly(address=meters.meter_no) 度数
                × contracts(landlord_id, brand_id, contract_type).electricity_price → 电费台账
```

> 上一版最深的坑就是这三个 JOIN 各页面各写一套（generate 走站点、dividend 走电表 landlord、station-view 取最后一个合同）。本设计把这三条链路**钉死为唯一口径**（详见 §五）。

---

## 三、分域总览（39 表 + 3 视图）

| 域 | 表 | 职责 | 谁能写 |
|---|---|---|---|
| 档案域 | brands, entities, landlords, shareholders, introducers, entity_brands, platform_users | 主链的"名字"，全系统引用 | 人工（Directory） |
| 站点域 | stations | 主链枢纽：挂场地/主体/公司占股/状态 | 人工 |
| 电表·接入域 | third_party_configs, meter_devices, meter_collectors, meter_status_cache, meter_monthly, meter_daily, meter_hourly, meter_yearly, meter_warnings_cache, sync_logs | 第三方平台数据缓存（GET-only） | 仅同步任务 |
| 电表·档案域 | meters, cabinets | 业务电表档案（唯一计算入口） | 人工 + 设备导入 |
| 合同域 | contracts, rent_payment_schedule, rent_income_schedule | 商务量（单价/租金/税/期次） | 人工 + Excel 导入 |
| 分配规则域 | station_shareholder_configs, station_introducer_configs | 分红规则（受益人×站点×模式/比例/周期/生效期） | 人工（Shareholders 页） |
| 台账派生域 | electricity_records, electricity_meter_details, operating_expenses, dividend_records, dividend_shares | 主链计算的落点（快照） | 生成器 + 人工小改 |
| 审批域 | approval_flows, approval_requests, approval_records, approval_dividend_records | 收付款/分红审批流转 | 人工 |
| 视图 | landlord_site_summary / landlord_monthly_summary / dividend_settlement_schedule | 场地实时聚合 / 场地月度经营汇总 / 分红结算周期 | 只读 |
| 过渡表 | rent_leases, rent_incomes, rent_receipts, rent_payment_records, rent_income_records | 旧租金台账，标注 DEPRECATED/限期并入 | 只迁不写 |

---

## 四、分域表结构设计（重点：电表第三方接入）

> 每域给出**关键字段与关系**；完整字段类型见建表 SQL（SQL 为唯一权威，字段级 COMMENT 全部在 SQL 内）。

### 4.1 档案域

#### `landlords` — 场地方（主链聚合根）
- 关键字段：`id`、`name`(UNIQUE)、`contact`、`phone`、`region`、`address`、`latitude/longitude`、`remark`、审计列。
- **聚合根职责**：场地的公共属性只存在这里一份；站点、合同、电表全部通过 landlord_id 挂回。
- 场地租金成本/收入 = 该场地所有场地合同/品牌方合同月租之和（**视图实时算**，不落缓存列）。

#### `brands` / `entities` / `shareholders` / `introducers`
- 保持简单档案：`name` + 联系方式 + 备注 + 审计列（shareholders/introducers 补 `updated_at`）。
- 被引用：meters.brand_id、meters.entity_id、contracts.brand_id/entity_id、configs.shareholder_id/introducer_id、dividend_shares、platform_users.shareholder_id。

#### `entity_brands` — 公司主体 ↔ 品牌方
- `(entity_id, brand_id)` 唯一。用于主体/品牌看板的多对多归属展示。

#### `platform_users` — 平台用户（RBAC）
- `id, name, role(boss/finance/finance_supervisor/shareholder), password(哈希), shareholder_id, landlord_ids(INTEGER[], 股东可看场地), phone, remark`。
- role=shareholder 的用户：只能看 `landlord_ids` 内场地的数据（应用层 scope）。

### 4.2 站点域

#### `stations` — 站点（主链枢纽）
- `id, name, code, region, address, landlord_id(FK), entity_id(FK), company_share(NUMERIC(5,4)), status(运营中/筹建中/已关停), latitude/longitude, remark, created_at`。
- **landlord_id 是主链第①键的唯一真相**；电表的 landlord 从这里带出。
- `company_share` 为公司占股（看板展示用，分红计算以 station_*_configs 为准，不依赖本列——避免双口径）。

### 4.3 电表域（重设计重点：第三方接入）

#### 4.3.1 三层职责（解决"电表杂乱"的总开关）

| 层 | 表 | 写入方 | 读取方 |
|---|---|---|---|
| **接入层** | `third_party_configs` | 人工（Directory） | 同步任务 |
| **缓存层** | `meter_devices` / `meter_collectors` / `meter_status_cache` / `meter_monthly` / `meter_daily` / `meter_hourly` / `meter_yearly` / `meter_warnings_cache` / `sync_logs` | **仅同步任务**（GET 拉取） | 业务只读（且只允许经 `meters` 间接关联读） |
| **档案层** | `meters` / `cabinets` | 人工 + 设备导入 | **所有业务计算唯一入口** |

> 铁律：**业务代码禁止绕过 `meters` 直接读缓存表做金额计算**。上一版 Meters 页直读 `meter_devices` 就是这个铁律的违反案例。

#### 4.3.2 `third_party_configs` — 第三方账户
- `id, name, base_url, auth_code, meter_tag(合作商电表/民用电表/共享电表), remark, created_at`。
- 同步任务遍历所有账户，各账户用各自 URL/auth 拉数据；导入 meters 时按 `config_id → meter_tag` 写 `meters.tag`。

#### 4.3.3 缓存层（全部只写不读）
- **`meter_devices`**：设备快照。`device_id`(第三方内部ID)、`collector_id`、**`address`(UNIQUE，= 业务电表号)**、`description`(含品牌信息)、`rate`(互感器倍率)、`config_id`(来源账户)、`meter_id`(已导入档案的关联，可空)、`synced_at`。
- **`meter_status_cache`**：实时状态快照。`device_id`(UNIQUE)、`address`、`c0`(总电量)/`c1~c4`(峰尖平谷)、`remain_money`、`synced_at`。每 10 分钟覆盖式同步。
- **`meter_monthly`（月度读数，电费/分红源头）**：
  - `device_id`(溯源)、**`address`(NOT NULL = meters.meter_no)**、**`month_period`(VARCHAR(6) = YYYYMM)**、`kwh`(**第三方原始表码度数**，同步覆盖)、**`actual_kwh`(本月实际用电量，人工修正，同步不覆盖)**、**`prev_actual_reading`(上月实际电表读数，人工修正，同步不覆盖)**、**`curr_actual_reading`(本月实际电表读数，人工修正，同步不覆盖)**、`prev/curr_reading[_date]`(第三方原始起止读数，同步覆盖)、`raw_data`(JSONB)、`synced_at`。
  - **唯一键 `(address, month_period)`**；辅助索引 `(device_id, month_period)`。
  - **人工修正三字段（actual_kwh / prev_actual_reading / curr_actual_reading）第三方同步永不覆盖**——数据错漏时人工填真实读数，业务计算优先用 `actual_kwh`；填了实际读数且未填实际用电量时自动按「本月−上月」计算。
  - **废弃**：`year_month`（与 month_period 重复）、`d0`（早期残留）。存量按 SQL 破坏性段处理。
- **`meter_daily / meter_hourly / meter_yearly`**：能耗统计。公共列 `device_id, address, kwh(原始表码), raw_data, synced_at` + 各自周期列（`day_date=YYYYMMDD` / `hour_time=YYYYMMDDHH` / `year_period=YYYY`）；唯一键 `(address, 周期列)`。
- **`meter_collectors`** / **`meter_warnings_cache`** / **`sync_logs`**：采集器快照、报警缓存（覆盖式）、同步日志（审计）。

#### 4.3.4 档案层（业务计算唯一入口）
- **`meters`**：
  - `id`、**`meter_no`(UNIQUE = 第三方 address，全局身份)**、`meter_name`、`collector_id`、**`transformer_ratio`(默认 1)**、**`station_id`(NOT NULL FK)**、`brand_id`(FK，1 电表=1 品牌)、**`landlord_id`(FK，跟随站点单源)**、`entity_id`(FK 报税主体)、`tag`(合作商/民用/共享)、`status`、`remark`、审计列。
  - **landlord 单源规则**：`stations.landlord_id` 为真相；建/改电表时由站点带出强制写入；校验 SQL 应恒 0 行不一致。
  - 来源两条路径：① 第三方设备导入（增量按 `address NOT IN meters.meter_no`）；② 手工建档。都要求 meter_no 唯一。
- **`cabinets`**：`meter_id`(FK)、`cabinet_no`、`cabinet_type`(充电柜/储电柜…)、`brand_id`(可空)、`remark`。**计费柜数 = 实时统计**（合同域用，不落库）。

#### 4.3.5 第三方接入全流程（GET-only 纪律）
```
人工在 Directory 配账户（third_party_configs）
  ↓ 定时/手动触发同步（jobs/sync_meters.py，遍历账户，全部 GET）
设备/采集器 → meter_devices / meter_collectors
实时状态     → meter_status_cache
能耗(月/日/时/年) → meter_monthly / meter_daily / meter_hourly / meter_yearly
报警         → meter_warnings_cache
每一步        → sync_logs（成功/失败/条数）
  ↓ 人工点「导入」或手工建档
meters（按 config_id 打 tag，landlord 随站点，倍数复制 rate）
  ↓ 人工挂柜子
cabinets
```
> **不向第三方回写任何数据**（只能 GET）。录读数 = 改本地 meter_monthly（address + month_period UPSERT），与第三方无关；第三方下次同步会覆盖同键行（预期行为）。

### 4.4 合同域

#### `contracts` — 合同台账（商务量唯一主源）
- 六组字段（完整清单见 SQL）：
  - **关联**：`landlord_id`(NOT NULL，一级挂场地)、`brand_id`、`entity_id`、`station_id`(兼容遗留)、`station_name`(DEPRECATED)。
  - **类型**：`contract_type`(**场地合同/品牌方合同**，两分法 CHECK)、`data_source`(manual/excel)、`partner`(DEPRECATED)、`pay_entity`(过渡文本，以 entity_id 为准)。
  - **电费**：`electricity_price`(付款/收款单价)、`tax_enabled`、`tax_rate`、`post_tax_electricity_price`。
  - **租金**：`rent_calc_method`、`unit_monthly_rent`、`cabinets_count`(参考快照，**计费以实时柜数为准**)、`monthly_rent`、`rent_amount`、`first_month_rent`、`rent_refund`、`early_end_date`、`deposit`。
  - **期次**：`pay_method`(月付/季付/半年付/年付)、`rent_advance_days`、`pay_status`(DEPRECATED，读分期推导)、`start_date`、`end_date`、`rent_tax_enabled/rent_tax_rate/post_tax_rent_price`。
  - **位置/审计**：`region/address/latitude/longitude/remark/created_at/updated_at`。
- 唯一约束：场地合同 `(landlord_id, start_date, end_date)`；品牌方合同 `(landlord_id, brand_id, start_date, end_date)`（防重复导入）。

#### `rent_payment_schedule` / `rent_income_schedule` — 收付款分期
- `contract_id`(FK CASCADE)、`seq`、`period_start/period_end`、`amount`、`status`、`pay_date`、`invoice`、`remark`；UNIQUE(contract_id, seq)。
- 生成规则：按 pay_method 拆期，每期金额 = monthly_rent × 期长月数；重建时按 seq 保留已付状态。
- **pay_status 由全部分期推导**（全部已付→已付款）。

#### 过渡表（不承担主源职责）
- `rent_leases / rent_incomes / rent_receipts`：DEPRECATED，存量并入 contracts + schedules 后下线。
- `rent_payment_records / rent_income_records`：年度发票/进项台账（station+brand+fiscal_year），保留，与分期表 invoice 的分工实施轮明确。

### 4.5 台账派生域（快照）

#### `electricity_records` — 电费月台账（站点 × 月份快照）
- 关键字段：`station_id`、`period`(6位)、**付款侧**（pay_start/end_date、pay_start/end_reading、pay_kwh、pay_unit_price、pay_amount、pay_status）、**收款侧**（collect_* 同构 + tax_rate + collect_net + collect_status）、`profit = collect_net − pay_amount`、`remark`、审计列；UNIQUE(station_id, period)。
- **生成器口径（唯一）**：`meters.station_id → stations.landlord_id → contracts(contract_type).electricity_price`；度数 = `meter_monthly(实际度数)`（见 §五.2）；**只取匹配到的第一份合同单价**（多合同场景实施轮再按品牌细分，见遗留）。

#### `electricity_meter_details` — 电费分表明细
- `electricity_id`(FK)、`meter_id`(FK)、`start/end_reading`、`kwh`、`pay_unit_price/pay_amount`、`collect_unit_price/collect_amount/collect_net`。
- 口径：明细合计 = 台账合计（生成时同源写入，禁止行内编辑只改台账不改明细）。

#### `operating_expenses` — 运营费用（独立手工输入）
- `station_id + period(6位) + amount + remark`；UNIQUE(station_id, period)。分红计算的成本项之一。

#### `dividend_records` — 分红月结（快照）
- `station_id, period(6位), type, elec_income, rent_income, total_income, elec_cost, rent_cost, op_expense, biz_dividend_cost, total_cost, profit, status(未结算→申报中→已通过→已结算), settlement_date, approval_id`。
- 由 dividend_calc 生成：收入=电费+租金；成本=电费+场地租+运营费+(计入成本的商务分红)+税费+退款。

#### `dividend_shares` — 分红明细（配置快照）
- `dividend_id`(FK)、`introducer_id / shareholder_id / brand_id`、`mode`、`ratio`、`fixed_amount`、`amount`。
- **快照语义**：生成时把生效配置的 mode/ratio/fixed_amount 复制进来，历史分红不受后续改配置影响。

### 4.6 审批域

- `approval_flows`：流程配置（biz_type 唯一 + nodes JSON）。
- `approval_requests`：审批单（biz_type、title、reason、amount、applicant、attachments、flow_nodes、current_node、status、urge_count、station_id、period、electricity_amount、rent_amount、dividend_record_id、审计列）。
- `approval_records`：节点流转记录（request_id、node_index、node_name、approver、action、comment）。
- `approval_dividend_records`：审批单 ↔ 分红记录一对多（支持多月批量审批）。

### 4.7 视图

- `landlord_site_summary`：场地公共属性 + 场地租金成本（场地合同月租和）+ 品牌租金收入（品牌方合同月租和）+ 合同 id 数组。**只读实时聚合，不落缓存列**。
- `landlord_monthly_summary`：**场地月度经营汇总**（跨表聚合：landlords/stations/meters/electricity_records/contracts/operating_expenses/dividend_records/dividend_shares）。按 `(landlord_id, period)` 一行输出：站点数/电表数、电费付款/收款(含税/不含税)/税费/利润、租金成本/收入/利润/税费（标准月口径，仅统计覆盖该月的合同）、运营费用、净利润（分红口径）、经营毛利、股东分红/商务分红（分红明细实分金额）。**利润口径（税费为空按 0）**：`elec_profit = 含税收款 − 付款 − 电费税费`（= 不含税收款 − 付款）；`rent_profit = 租金收入 − 租金成本 − 租金税费`；`gross_profit = 电费利润 + 租金利润 − 运营费用 − 股东分红 − 商务分红`。用法：`SELECT * FROM landlord_monthly_summary WHERE landlord_id=1 AND period='202607'`。
- `dividend_settlement_schedule`：**分红结算周期视图**。按 受益人(股东/介绍人) × 结算周期(月/季度/半年/年) 一行：下次结算期/日期（按当前日期动态推算：月=本月末、季=本季度末、半年=6月/12月末、年=12月末）、待结算金额（当前周期内已生成且未结算的分红）、已结算金额。用途：回答"谁什么时候该分红、该分多少"。用法：`SELECT * FROM dividend_settlement_schedule WHERE beneficiary_name='张三'`。

---

## 五、串联与派生口径（全系统唯一口径，钉死）

### 5.1 三个关键 JOIN（不允许第二套）
```
① 电表归属场地： meters.station_id → stations.landlord_id
② 电表归属品牌： meters.brand_id → brands.id
③ 电表归属主体： meters.entity_id → entities.id（报税）
```
> `meters.landlord_id` 是冗余跟随列；任何查询以 ① 为准。

### 5.2 度数口径（电表 → 台账）
```
实际度数 = meter_monthly.kwh(原始表码) × meters.transformer_ratio
         （若 actual_kwh 非空，直接取 actual_kwh——人工修正优先）
```
- 缓存表永远存原始表码，换算只发生在读取/生成处（避免二次相乘）。

### 5.3 电费台账口径（度数 × 合同单价）
```
付款侧 = 实际度数 × 场地合同.electricity_price（付给业主，成本）
收款侧 = 实际度数 × 品牌方合同.electricity_price（品牌方付给公司，收入）
不含税收款 = collect_amount / (1 + tax_rate)
利润     = collect_net − pay_amount
```

### 5.4 租金口径（合同 → 台账/分红）
```
场地租金成本 = Σ 场地合同.monthly_rent（同场地）
品牌租金收入 = Σ 品牌方合同.monthly_rent（同场地，按柜 = unit_monthly_rent × 实时柜数）
首月         = first_month_rent（有值优先，否则 monthly_rent）
提前结束退款 = rent_refund（在 early_end_date 所在月冲减收入）
venue_cost（品牌方承担场地成本）= 场地月租总 ÷ 全品牌计费柜数总 × 本品牌柜数（实时算，不落库）
```

### 5.5 分红口径（收入成本 → 分配规则）
```
净利润 = 电费收款 + 租金收款 − 电费成本 − 场地租金 − 运营费用 − 税费 − 退款 − (计入成本的商务分红)
股东分红 = 按 mode：收入分红=总收入×ratio / 利润分红=净利润×ratio / 固定金额=fixed_amount，再 × 周期倍数
商务分红 = 同三种 mode；count_as_cost=TRUE 时先进成本
```

### 5.6 状态口径
- `contracts.pay_status` ← 分期推导（全部分期已付→已付款）。
- `dividend_records.status` ← 审批流驱动（审批通过→已通过→已结算）。
- 审批联动（实施轮）：电费/场地费审批通过后回写对应台账/分期状态，实现"审批即付款"。

---

## 六、存量库迁移策略（SQL 三段落）

建表 SQL `2026_08_full_redesign.sql` 分四段：

1. **全新安装**（CREATE TABLE IF NOT EXISTS）：全部 39 表 + 3 视图一次建齐，字段级 COMMENT 全部内联。可作为 `database_init.sql` 的整体替代基准。
2. **存量对齐**（非破坏性）：补列（updated_at、configs 生效期/审计列等）、period 去横线、"季→季度"、旧合同类型映射（场租付款→场地合同、场租收款→品牌方合同）、守卫式 CHECK/唯一索引（有存量违规时跳过并提示）、常用索引。
3. **核对 SQL**：landlord 不一致、period 非法、重复合同、非法 mode/周期、生效期重叠、缓存与档案未对应等——期望全 0。
4. **破坏性段**（确认后手动执行，先备份）：删 `meter_monthly.year_month/d0`、`meter_daily.date`、`contracts.station_name/partner`；rent_* 台账并入后下线；可选启用分红配置生效期排除约束（需 btree_gist）。

---

## 七、实施轮清单（设计落地，非本轮）

1. 用 `2026_08_full_redesign.sql` 替换 `database_init.sql`（消除双源漂移）。
2. 代码适配：
   - `meter_repo_v2` 切回读 `meters`（Meters 页恢复站点/品牌/场地关联）；
   - `sync_meters.py` 冲突键切 `(address, month_period)` 等 `(address, 周期)`，删 year_month/d0 写入；
   - `electricity.generate` / `dividend_calc` 统一走 §五 口径（landlord 单源、按品牌匹配单价、period 6 位）；
   - 合同旧类型/旧表单（ContractForm.tsx）统一两分法；Rent 页改读 contracts + schedules，下线 rent_* 接口与美团 Excel 运行时解析；
   - 审批通过回写台账/分期状态（C6）。
3. Mock 数据按新结构重写（`src/mocks/index.ts` 与 SQL 对齐）。
4. 对账回归：任意站月「电费台账利润 == 分红预览净利润」，抽查 ≥5 站 × ≥3 月。

---

## 八、文档索引

| 文件 | 内容 |
|---|---|
| **本文件** | 全量重设计 v2：一条主链 + 分域设计 + 唯一口径 |
| `backend/app/migrations/2026_08_full_redesign.sql` | 全部 39 表 + 3 视图的幂等建表 SQL（权威字段定义，与 database_init.sql 同步） |
| `backend/app/migrations/2026_08_table_comments.sql` | 表注释脚本（Navicat 直接执行，幂等） |
| `backend/app/migrations/2026_08_meter_actual_reading_fields.sql` | meter_monthly 人工实际读数字段（增量迁移） |
| `backend/app/migrations/2026_08_landlord_monthly_summary.sql` | 场地月度经营汇总视图（增量迁移） |
| `backend/app/migrations/2026_08_dividend_settlement_schedule.sql` | 分红结算周期视图（增量迁移） |
| `TABLE_QUICK_REFERENCE.md` | **表速查手册**：39 表 + 3 视图，一张表一句话用途 |
| `THREE_SOURCE_LINES.md` | 三数据源总纲（v2 的"源头层"视角） |
| `METER_LINE_DESIGN.md` / `CONTRACT_LINE_DESIGN.md` / `DIVIDEND_LINE_DESIGN.md` | 三线分治的设计细节（结论已并入 v2） |
| `DATA_GOVERNANCE.md` / `DATA_RELATIONSHIPS.md` | 历史问题与页面数据关联（v2 的"问题清单"来源） |
