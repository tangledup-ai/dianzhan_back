# 换电站经营管理平台 · 数据溯源手册

> **用途**：你在任意页面看到任意一个数字，用这份文档可以查到 —— 它由哪个接口返回、后端哪个函数算的、最终落到哪张表的哪一列、中间经过了什么公式或口径。
>
> **代码基线**：工作区当前版本（v3 口径，`stations` 站点层已下线）。文中行号对应当前工作副本，代码改动后会漂移，但**文件路径 + 函数名**是稳定锚点。
> **生成时间**：2026-09-23

---

## 第 0 章 · 怎么用这份文档（30 秒上手）

遇到"这个数从哪来的"问题，按下面顺序走：

| 步骤 | 做什么 | 去哪一章 |
|---|---|---|
| 1 | 知道我大概在找什么业务域 | [1.1 页面总览索引](#11-页面总览索引) |
| 2 | 只想按数字的名字反查（不知道在哪个页面） | [1.2 业务名词反查索引](#12-业务名词反查索引核心) |
| 3 | 想知道某张表被谁写、被谁读 | [1.3 数据表正反向索引](#13-数据表正反向索引) |
| 4 | 看到具体页面的字段表 | [第 5 章 逐页数据溯源](#第-5-章--逐页数据溯源) |
| 5 | 数字是"算出来的"，要看公式 | [第 6 章 核心计算引擎](#第-6-章--核心计算引擎深挖) |
| 6 | 想完整追一个数字从录入到出报表 | [第 7 章 端到端溯源实例](#第-7-章--端到端溯源实例照着走) |
| 7 | 数字不对劲，怀疑是口径坑 | [第 8 章 已知陷阱清单](#第-8-章--已知陷阱与数据质量清单) |

**阅读约定**
- 字段名以 **camelCase** 为准（前端消费的那套）。后端 `CamelJSONResponse` 默认 `alias` 模式会同时输出 snake 和 camel 双 key，所以你在响应里看到两种写法是正常的。
- 月份统一 6 位 `YYYYMM`（DB 内）；接口入参常写 `YYYY-MM`，由 `to_compact()` / `replace("-","")` 归一。
- `金额` 单位一律人民币元，`电量` 单位度（kWh）。

---

## 第 1 章 · 索引区

### 1.1 页面总览索引

路由定义：`src/App.tsx:41-69`；菜单定义：`src/components/Layout.tsx:8-23`。

| 菜单名 | 路由 | 页面文件 | 主接口（唯一"入口数据"） | 溯源章节 |
|---|---|---|---|---|
| 经营总览 | `/` | `src/pages/Dashboard.tsx` | `GET /api/overview` + `/monthly-detail` | [5.1](#51-经营总览-dashboard-) |
| 场地数据 | `/stations` | `src/pages/Stations.tsx` | `GET /api/overview/station-board` | [5.2](#52-场地数据-stations-stations) |
| 电费台账 | `/electricity` | `src/pages/Electricity.tsx` | `GET /api/electricity/monthly-ledger` | [5.3](#53-电费台账-electricity-electricity) |
| 场租台账 | `/rent` | `src/pages/Rent.tsx` | `GET /api/rent/monthly-ledger` | [5.4](#54-场租台账-rent-rent) |
| 品牌方 | `/brands` | `src/pages/Brands.tsx` | 前端聚合（多接口） | [5.5](#55-品牌方看板-brands-brands) |
| 公司主体 | `/entities` | `src/pages/Entities.tsx` | 前端聚合 + `GET /api/overview/entity-monthly` | [5.6](#56-公司主体看板-entities-entities) |
| 场地方 | `/landlords` | `src/pages/Landlords.tsx` | `GET /api/directory/landlords` | [5.7](#57-场地方看板-landlords-landlords) |
| 股东分红 | `/shareholders` | `src/pages/Shareholders.tsx` | `POST /api/dividends/calculate` | [5.8](#58-股东分红-shareholders-shareholders) |
| 合同管理 | `/contracts` | `src/pages/Contracts.tsx` | `GET /api/contracts` | [5.9](#59-合同管理-contracts-contracts) |
| 审批中心 | `/approvals` | `src/pages/Approvals.tsx` | `GET /api/approvals` | [5.10](#510-审批中心-approvals-approvals) |
| 智慧电表 | `/meters` | `src/pages/Meters.tsx` | `GET /api/meters` | [5.11](#511-智慧电表-meters-meters) |
| 异常预警 | `/alerts` | `src/pages/Alerts.tsx` | `GET /api/alerts` | [5.12](#512-异常预警-alerts-alerts) |
| 基础档案 | `/directory` | `src/pages/Directory.tsx` | 8 组 CRUD | [5.13](#513-基础档案-directory-directory) |
| 系统设置 | `/settings` | `src/pages/Settings.tsx` | `GET/PUT /api/system-config` | [5.14](#514-系统设置-settings-settings) |
| （登录） | `/login` | `src/pages/Login.tsx` | `POST /api/auth/login` | [5.15](#515-登录-login-login与认证链路) |
| ~~场地地图~~ | 无路由 | `src/pages/StationMap.tsx` | — | [5.16 死代码](#516-死代码清单别浪费时间) |

**股东账号可见性**：`src/components/Layout.tsx:26` 的 `SHAREHOLDER_HIDDEN` 隐藏 8 个页面（经营总览/品牌方/公司主体/场地方/审批中心/基础档案/异常预警/系统设置），`src/App.tsx:53-55` 对直接输 URL 也做了重定向拦截。股东账号前端**全部写操作**会被后端 403 拦截（`backend/app/main.py:50-51`）。

### 1.2 业务名词反查索引（核心）

> 用法：找到你要的数字 → 拿到跳转锚点。**括号内是关键计算式**。

#### 金额类

| 你看到的数字 | 精确含义（计算式） | 源头表.列 | 章节 |
|---|---|---|---|
| 电费付款 | `Σ electricity_records.pay_amount` | `electricity_records.pay_amount` | [5.1](#51-经营总览-dashboard-) [5.3](#53-电费台账-electricity-electricity) |
| 电费收款（含税） | `Σ collect_amount` | `electricity_records.collect_amount` | [5.3](#53-电费台账-electricity-electricity) |
| 电费收款（不含税） | `Σ collect_net` | `electricity_records.collect_net` | [5.3](#53-电费台账-electricity-electricity) |
| 电费税费 | `collect_amount − collect_net`（**无独立列，现算**） | 派生 | [5.3](#53-电费台账-electricity-electricity) |
| 电费利润 | `Σ profit`（= `collect_net − pay_amount`） | `electricity_records.profit` | [6.1](#61-电费台账生成器-electricitygenerate) |
| 场租收入 / 场地费收入 | `Σ contracts.monthly_rent WHERE contract_type='品牌方合同'` | `contracts.monthly_rent` | [5.4](#54-场租台账-rent-rent) |
| 场租成本 / 场地费成本 | `Σ contracts.monthly_rent WHERE contract_type='场地合同'` | `contracts.monthly_rent` | [5.4](#54-场租台账-rent-rent) |
| 场租税费 | `Σ(monthly_rent − post_tax_rent_price)`，仅 `rent_tax_enabled` | `contracts.post_tax_rent_price` | [5.4](#54-场租台账-rent-rent) |
| 场租利润 | `rentIncome − rentCost − rentTax` | 派生 | [5.4](#54-场租台账-rent-rent) |
| 运营费用 | `Σ operating_expenses.amount` | `operating_expenses.amount` | [5.4](#54-场租台账-rent-rent) [5.8](#58-股东分红-shareholders-shareholders) |
| 净利润（总览） | `elecProfit + rentIncome − rentCost − rentTax − opExpense` | 派生 | [5.1](#51-经营总览-dashboard-) |
| 总利润（场地数据页） | `elecProfit + rentProfit − opExpense − dividend` | 派生 | [5.2](#52-场地数据-stations-stations) |
| 待收款项 | `elecUncollected + rentUncollected` | 见两列 | [5.1](#51-经营总览-dashboard-) |
| 待付款项 | `Σ pay_amount WHERE pay_status='未付款'` | `electricity_records.pay_status` | [5.1](#51-经营总览-dashboard-) |
| 已收 / 未收（场地费） | 按分期 `status='已到账'` 分桶 | `rent_income_schedule.status/amount` | [5.4](#54-场租台账-rent-rent) |
| 已付 / 未付（场地费） | 按分期 `status='已付款'` 分桶 | `rent_payment_schedule.status/amount` | [5.4](#54-场租台账-rent-rent) |
| **场地成本（分摊给品牌）** | `场地月租 × 该品牌柜数 ÷ 该月全部在期品牌总柜数` ⚠️**不是电费** | `contracts.monthly_rent` + 柜数 | [6.4](#64-共享电表机制全系统最高复杂度) |
| **电费成本** | `付款口径电量 × 场地合同 electricity_price` | `contracts.electricity_price` | [6.1](#61-电费台账生成器-electricitygenerate) |
| 分红金额 | 见 [6.2 分红引擎](#62-分红计算引擎-dividend_calc) | `dividend_shares.amount` | [6.2](#62-分红计算引擎-dividend_calc) |
| 利润 / 净利润（分红口径） | `totalIncome − totalCost` | 派生 | [6.2](#62-分红计算引擎-dividend_calc) |
| 公司净利润（电费导出） | `(电费利润 − 运营费用) × landlords.company_share` | ⚠️`landlords.company_share` **无 DDL** | [8.3](#83-隐性依赖与半成品功能) |

#### 电量 / 度数类

| 你看到的数字 | 精确含义 | 源头 | 章节 |
|---|---|---|---|
| 实际用电量 / 度数 | `COALESCE(actual_kwh, kwh × transformer_ratio)` | `meter_monthly.actual_kwh` / `kwh`，`meters.transformer_ratio` | [4.3](#43-电量口径三条铁律必背) |
| 上月/本月抄表度数 | `meter_monthly.curr_reading / prev_reading`（第三方同步**会覆盖**） | `meter_monthly` | [5.11](#511-智慧电表-meters-meters) |
| 上月/本月**实际**读数 | `prev_actual_reading / curr_actual_reading`（同步**不覆盖**，人工填） | `meter_monthly` | [5.11](#511-智慧电表-meters-meters) |
| 区间度数 | `curr_reading − prev_reading`（前端算） | 派生 | [5.11](#511-智慧电表-meters-meters) |
| 付场地方电量 / 整表电量 | `COALESCE(actual_kwh, kwh × 倍数)` | `meter_monthly` | [6.4](#64-共享电表机制全系统最高复杂度) |
| 互感器倍数 | `meters.transformer_ratio` | `meters` | [5.11](#511-智慧电表-meters-meters) |
| 总电量 | `Σ COALESCE(actual_kwh, kwh × 倍数)` | `meter_monthly` + `meters` | [5.1](#51-经营总览-dashboard-) |

#### 柜数 / 数量类

| 你看到的数字 | 精确含义 | 章节 |
|---|---|---|
| 柜数 / 计费柜数 | 三来源优先级：分摊行 `cabinet_count` → `GREATEST(1, COUNT(cabinets))` → 兜底 1 | [4.4](#44-柜数三来源优先级必背) |
| 电表数 | `COUNT(meters)`，排除 `meter_no LIKE 'TEST%'` | [5.1](#51-经营总览-dashboard-) |
| 品牌组合（"站点数"） | `COUNT(DISTINCT (landlord_id, brand_id))`，**不是物理站点** | [5.1](#51-经营总览-dashboard-) |
| 合同数 / 临期 / 已到期 | 见 `contract_repo` 状态判定 | [5.9](#59-合同管理-contracts-contracts) |
| 柜子编号 / 类型 | `cabinets.cabinet_no / cabinet_type` | [5.11](#511-智慧电表-meters-meters) |

#### 状态 / 日期类

| 你看到的数字 | 精确含义 | 章节 |
|---|---|---|
| 合同状态（正常/临期/已到期/提前结束） | `early_end_date` → `end_date` → 90 天窗口 | [5.9](#59-合同管理-contracts-contracts) |
| 预警状态（临期N天/已到期） | `COALESCE(early_end_date, end_date) − today`，窗口读配置 | [5.12](#512-异常预警-alerts-alerts) |
| 已处理 / 未处理（预警） | 签名 `状态\|到期日\|逾期期数` 与 `alert_handled_sig` 比对 | [5.12](#512-异常预警-alerts-alerts) |
| 付款情况 / 到账情况 | `electricity_records.pay_status / collect_status`（**重算不覆盖**） | [5.3](#53-电费台账-electricity-electricity) |
| 已人工修改角标 | `electricity_records.data_source = 'manual'` | [5.3](#53-电费台账-electricity-electricity) |
| 分期状态 | `rent_payment_schedule.status` / `rent_income_schedule.status` | [5.9](#59-合同管理-contracts-contracts) |
| 分红状态 | 未结算 → 申报中 → 已通过 → 已结算 | [5.10](#510-审批中心-approvals-approvals) |
| 审批状态 | `approval_requests.status` | [5.10](#510-审批中心-approvals-approvals) |

#### 特殊机制

| 名词 | 说明 | 章节 |
|---|---|---|
| 共享电表（场地总表） | `tag='共享电表' AND brand_id IS NULL`，5 块 | [6.4](#64-共享电表机制全系统最高复杂度) |
| 品牌分摊 | `meter_shared_allocations`，按 表×月×品牌 人工录应收金额 | [6.4](#64-共享电表机制全系统最高复杂度) |
| 线损 / 亏空 | `scale = 整表读数 ÷ 品牌倒推电量合计`，按电量比例摊入各品牌 | [6.4](#64-共享电表机制全系统最高复杂度) |
| 全品牌合同 | `contract_type='品牌方合同' AND brand_id IS NULL`，共享表兜底单价 | [6.1](#61-电费台账生成器-electricitygenerate) |
| 数据隔离 | 股东 `landlord_ids` / 财务 `meter_tag_scope` | [4.6](#46-权限与数据隔离) |
| 测试电表 | `meter_no LIKE 'TEST%'` 全局排除 | [4.5](#45-全局过滤规则) |

### 1.3 数据表正反向索引

> "谁写、谁读" —— 回答"这个数据从哪来、到哪去"。

| 表 | 写入方（生产） | 读取方（消费） | 说明 |
|---|---|---|---|
| `brands` | 基础档案页 / 合同 Excel 导入 / 电表导入自动建 | 几乎全部页面 | 品牌方档案 |
| `entities` | 基础档案页 / 合同 Excel 导入 | 公司主体看板、台账主体维度、分红 | 报税主体 |
| `landlords` | 基础档案页 / 合同导入 | 全部页面（**聚合根**） | 场地方 |
| `landlord_owners` | 基础档案页业主子表 | 场地方页 | 多业主；同步回写 `landlords.contact` |
| `shareholders` / `introducers` | 基础档案页 | 分红引擎、分红汇总 | 分红受益人 |
| `entity_brands` | **无页面入口**（半成品） | 无 | 见 [8.3](#83-隐性依赖与半成品功能) |
| `platform_users` | 基础档案 → 平台使用人员 | 登录、鉴权中间件、数据隔离 | RBAC + 数据范围 |
| `meters` | 智慧电表页 / 第三方导入 | 台账生成、柜数统计、分红 | 电表档案 |
| `cabinets` | 智慧电表页柜子管理 | 柜数统计（全系统） | 物理柜子 |
| `meter_entity_changes` | 电表换主体时写 | 审计查询 | 换主体留痕 |
| `third_party_configs` | 基础档案 → 第三方接口配置 | 同步任务、台账生成（取单价） | 天雀账户 |
| `meter_devices` | 天雀同步 | 导入电表 | 设备快照 |
| `meter_collectors` | 天雀同步 | 参考 | 采集器快照 |
| `meter_status_cache` | 天雀同步（2h） | **不参与业务** | 实时状态 |
| **`meter_monthly`** | 天雀同步（每天03:00）+ 智慧电表页人工录入 + Excel 导入 | **台账生成、分红、预警、场地数据页** | ★ 一切电量的源头 |
| `meter_shared_allocations` | 智慧电表页品牌分摊表单 | 台账生成、柜数统计、分红 | ★ 共享表核心 |
| `meter_daily` | 天雀同步（每天02:00） | 预警（日级电量异常） | 日能耗 |
| `meter_hourly` / `meter_yearly` | 天雀同步 | 备用 | 时/年能耗 |
| `meter_warnings_cache` | 天雀同步（先清表再插） | 备用 | 报警缓存 |
| `sync_logs` | 每次同步 | 智慧电表页同步日志 | 同步审计 |
| `contracts` | 合同页 / Excel 导入 | 全部财务页面 | ★ 商务量唯一主源 |
| `contract_audit_log` | 合同增删改自动写 | 合同页变更记录 | 变更审计 |
| `rent_payment_schedule` | 合同保存时自动拆期 / 手动添加 | 场租台账、预警、审批 | 付款分期（成本） |
| `rent_income_schedule` | 合同保存时自动拆期 / 手动添加 | 场租台账、预警、审批 | 收款分期（收入） |
| **`electricity_records`** | ★ **只由台账生成器写** + 人工手工建 | 经营总览、电费台账、场地数据、品牌方、公司主体、分红 | ★ 电费月台账 |
| `electricity_meter_details` | 台账生成时同源写入 | 电费台账明细、抄表核对 | 分表明细 |
| `operating_expenses` | 股东分红页 / `POST /api/rent/expenses` | 分红、场租台账、经营总览 | 运营费用 |
| `dividend_records` | 分红引擎 `POST /api/dividends` | 股东分红页、分红汇总、经营总览 | 分红月结 |
| `dividend_shares` | 随记录创建 / `/refresh` 重建 | 股东分红汇总、结算周期视图 | 分红明细快照 |
| `landlord_shareholder_configs` | 股东分红页配置 | 分红引擎 | 股东分配规则 |
| `landlord_introducer_configs` | 股东分红页配置 | 分红引擎 | 商务分配规则 |
| `approval_flows` | 审批流程配置 | 审批建单 | 流程定义 |
| `approval_requests` | 审批中心 / 场地数据 / 场租台账 / 合同页 / 分红提交 | 审批中心 | ★ 审批单 |
| `approval_records` | 审批动作 | 审批时间线 | 流转记录 |
| `approval_dividend_records` | 分红批量审批 | 分红回写 | 审批↔分红 多对多 |
| `alert_configs` | 基础档案 → 预警设置 | 预警计算、经营总览合同统计 | 阈值配置 |
| `system_configs` | 系统设置页 | 地图加载、小程序 AI | Key 存储（运行时建表） |
| **视图** `landlord_site_summary` | — | 基础档案场地方列表 | 场地实时聚合 |
| **视图** `landlord_monthly_summary` | — | 备用/外部查询 | 场地月度汇总 |
| **视图** `dividend_settlement_schedule` | — | 分红结算周期 | 受益人×周期 |

---

## 第 2 章 · 这个项目到底在做什么

### 2.1 一句话业务模型

公司做**换电柜投放运营**：从**场地方**租场地（付租金 + 付电费），把**电柜**投放进去给**品牌方**（美团/哈啰/青桔等）用，向品牌方收**租金 + 电费**。中间的差价就是利润，利润再按约定比例分给**股东**和**介绍人**。

```
       支出（成本）                           收入
   ┌──────────────────┐              ┌──────────────────┐
   │ 场地方            │              │ 品牌方            │
   ├──────────────────┤              ├──────────────────┤
   │ 租金  monthly_rent│ ──场地合同──>│ 租金  monthly_rent│
   │ 电费  pay_amount  │ ──场地合同──>│ 电费  collect_net │
   └──────────────────┘              └──────────────────┘
                 ↑                              ↑
                 │        ┌─────────────┐       │
                 └────────│   本公司     │───────┘
                          │ 利润 = 收入−成本│
                          └──────┬──────┘
                                 │ 按配置比例
                          ┌──────┴──────┐
                          ↓             ↓
                       股东分红      商务分红（介绍人）
```

### 2.2 四个"角色"实体必须分清

这是理解全系统的关键，**四者常被混淆**：

| 实体 | 表 | 是什么 | 在系统里的角色 |
|---|---|---|---|
| **场地方** Landlord | `landlords` | 场地业主（房东） | ★ **主链聚合根**。合同、电表、运营费用全部直挂 `landlord_id`。v3 已废除"站点"中间层。 |
| **品牌方** Brand | `brands` | 换电品牌客户（美团/哈啰…） | 收入来源。按 `(场地, 品牌)` 组合经营。 |
| **公司主体** Entity | `entities` | 我方报税法人 | 收付款/开票主体。同一场地跨主体要拆行。 |
| **股东/介绍人** Shareholder/Introducer | `shareholders`/`introducers` | 分红受益人 | 只影响分红，不影响经营。 |

### 2.3 v3 最重要的架构变更

**`stations`（站点）表已下线**。历史版本是 `场地方 → 站点 → 电表` 三级，现在是 `场地方 → 电表` 两级：

- `backend/app/repositories/station_repo.py` 已是空占位模块（只剩 docstring）。
- `/api/stations` 路由只保留两个场地维度接口，无任何站点 CRUD。
- 前端页面仍叫 `Stations.tsx`、菜单叫「场地数据」、接口仍带 `station` 字样 —— **纯历史命名遗留**，别被误导。
- 电费台账唯一键从 `(场地, 品牌, 月)` 升级为 `(场地, 品牌, 主体, 月)`，以支持同场地同品牌跨主体拆行。

---

## 第 3 章 · 数据模型总览

### 3.1 七个域

| 域 | 表 | 定位 |
|---|---|---|
| ① 档案域 | `brands` `entities` `landlords` `landlord_owners` `shareholders` `introducers` `entity_brands` `platform_users` | 静态档案 |
| ② 电表档案域 | `meters` `cabinets` `meter_entity_changes` | ★ 业务计算唯一入口 |
| ③ 电表接入域 | `third_party_configs` `meter_devices` `meter_collectors` `meter_status_cache` `meter_monthly` `meter_shared_allocations` `meter_daily/monthly/hourly/yearly` `meter_warnings_cache` `sync_logs` | 第三方缓存，**只写不读业务**（除 `meter_monthly`） |
| ④ 合同域 | `contracts` `contract_audit_log` `rent_payment_schedule` `rent_income_schedule` | ★ 商务量唯一主源 |
| ⑤ 台账派生域 | `electricity_records` `electricity_meter_details` `operating_expenses` `dividend_records` `dividend_shares` | 快照，由上游重算 |
| ⑥ 分配规则域 | `landlord_shareholder_configs` `landlord_introducer_configs` | 分红规则 |
| ⑦ 审批域 | `approval_flows` `approval_requests` `approval_records` `approval_dividend_records` | 审批流 |

> ⚠️ 注意"接入域"的定位：`meter_monthly` 之外的缓存表（`meter_daily` 等）**只用于预警和展示**，不参与财务计算。财务计算只认 `meter_monthly`。

### 3.2 主数据流（一张图看完全链路）

```
【人工录入 / 第三方】
  智慧电表页  ──POST /meter-energy/readings──>  meter_monthly
                （画布：kwh 原始表码 / actual_kwh 实际用电量）
  智慧电表页  ──POST /meter-energy/shared-allocations──>  meter_shared_allocations
  合同页      ──POST /api/contracts──>  contracts ──自动拆期──> rent_payment_schedule
                                                              rent_income_schedule
  天雀 API    ──每日03:00 定时任务──>  meter_monthly（覆盖 kwh/读数，不覆盖 actual_kwh）

【台账生成器】
  POST /api/electricity/generate   （Meters 页保存 / 同步完成 / 后端启动 / 合同保存 都触发）
      读 meter_monthly + meters + contracts + meter_shared_allocations
      ↓ 分组键 (landlord_id, brand_id, entity_id)
      ↓ 电量 = COALESCE(actual_kwh, kwh × transformer_ratio)
      ↓ 单价 = 场地合同.electricity_price（付款） / 品牌方合同.electricity_price（收款）
      ↓ 利润 = collect_net − pay_amount
      electricity_records + electricity_meter_details
      ↓ 顺手触发 refresh_dividend_records（分红重算）

【分红引擎】
  POST /api/dividends/calculate  （只算不存）
     读 electricity_records + contracts + operating_expenses + 配置
     ↓ base = 收入 / 利润（按 mode）
     ↓ amount = base × ratio × 周期倍数
  POST /api/dividends  （落库）
     dividend_records + dividend_shares（快照 mode/ratio/fixed_amount/amount）
     ↓ /submit → 审批单 → 通过 → 已通过 → /settle → 已结算
```

### 3.3 关键外键关系

```
landlords ─┬─< contracts (landlord_id)
           ├─< meters (landlord_id)          ← v3 直挂，不经 stations
           └─< operating_expenses (landlord_id)

brands ────┬─< contracts (brand_id)
           ├─< meters (brand_id)             ← NULL = 共享表/未指派
           └─< meter_shared_allocations (brand_id)

entities ──┬─< contracts (entity_id)
           ├─< meters (entity_id)            ← entity_source: manual/auto
           └─< electricity_records (entity_id)

meters ────┬─< cabinets (meter_id)
           ├─< meter_monthly (meter_no ↔ address)   ← 靠电表号字符串关联，非外键！
           ├─< meter_shared_allocations (address ↔ meter_no)
           └─< electricity_meter_details (meter_id)

contracts ─┬─< rent_payment_schedule (contract_id)
           ├─< rent_income_schedule (contract_id)
           └─< approval_requests (contract_id)

dividend_records ──< dividend_shares
                 └─> approval_requests ←── approval_dividend_records ──> dividend_records
                     （循环外键，建表末尾用 DO 块补，导库时需先摘掉）
```

> ⚠️ **`meter_monthly` 不通过外键挂 `meters`**，而是用 `address = meters.meter_no` 字符串关联。所以"电表号改错"会导致读数孤儿，这是最容易出的数据事故。

---

## 第 4 章 · 全局口径（必读，所有页面共用）

### 4.1 响应字段命名

`backend/app/api/base.py:38-47` `CamelJSONResponse`：默认 `CAMEL_MODE="alias"`，响应 JSON **同时含 snake_case 与 camelCase 两套 key**。前端一律读 camelCase。`raw_data` / `rawData` 不转换。
请求端取驼峰；后端 repo 层内部用 snake。

### 4.2 月份口径

- DB 内所有 `period` / `month_period` 统一 6 位 `YYYYMM`（`ck_meter_monthly_period` CHECK 约束强制 `^\d{6}$`）。
- 归一函数：后端 `backend/app/infra/period.py` `to_compact()`；前端 `src/lib/period.ts` `toCompact()`。
- 接口出入参常写 `YYYY-MM`（如 `period=2026-08`），后端入口做 `str(period).replace("-","")`。
- 数据库历史漂移已在 `database_init.sql:906-909` 做一次性去横线清洗。

### 4.3 电量口径：三条铁律（必背）

```
① 实际用电量 = actual_kwh（人工填，非空）优先
             否则 = kwh × meters.transformer_ratio（互感器倍数）
② meter_monthly.kwh 永远是「原始表码度数」，绝不含倍数
③ 天雀同步覆盖 kwh / prev_reading / curr_reading / 日期；
   不覆盖 actual_kwh / prev_actual_reading / curr_actual_reading
```

**出现位置**：台账生成 `backend/app/api/electricity.py:682`、场地台账、`POST /meter-energy/monthly`、电表详情、分红 `dividend_calc._get_meter_kwh`。
**SQL 写法**：`COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio,1), 2))`

**由此派生的两条使用规矩**：
- 要长期留档的真实读数，填**「上月/本月实际读数」**（`prev/curr_actual_reading`），不要填「起止度数」（同步会回退）。
- 前端编辑回填必须用 `rawKwh`（未乘倍数的原值），否则"读→编辑→写回"会二次相乘。

### 4.4 柜数三来源优先级（必背）

**单表柜数**：

```
① meter_shared_allocations.cabinet_count（共享表按品牌人工录入）
     取值次序：当月填写值 → 该月之前最近一次 → 全表最近一次
② GREATEST(1, COUNT(cabinets WHERE meter_id=m.id))     ← 每表至少 1 柜
③ 兜底 = 1
```

前端：`src/pages/Meters.tsx:484-496`（`allocCabCount ?? localCabCount`）；后端：`backend/app/repositories/shared_allocation_repo.py:297-370` `shared_meter_cabinets`、`:168-181` `_pick_cabinet`。

**⚠️ 防双算铁律**：共享表一旦「已按品牌录过柜数」（`managedByAlloc=true`），统计整场地柜数时**必须排除该整表**，否则整表计数与品牌柜数双算。SQL 端用 `NOT EXISTS(... sa.cabinet_count IS NOT NULL)` 排除，Python 端用 `_shared_cab_weights()` 叠加品牌柜数 —— **必须成对出现，漏一半就双算**。

涉及位置（改共享表时逐个检查）：
- 后端：`contract_repo.list_contracts`、`dividend_calc`（`_get_landlord_cabinet_totals` / `_get_entity_weights` / `_get_brand_entity_weights` / `_shared_cab_brand_entity`）、`rent._live_cabs`、`overview.station_board`、`overview.monthly_detail` / `entity_monthly`（helper `_shared_cab_weights`）
- 前端：`src/lib/alloc.ts`、`src/pages/Contracts.tsx` / `Entities.tsx` / `Brands.tsx`

### 4.5 全局过滤规则

| 规则 | SQL 写法 | 原因 |
|---|---|---|
| 排除测试电表 | `meter_no NOT LIKE 'TEST%'` | 造数干扰 |
| 排除无场地电表 | `landlord_id IS NOT NULL` | 未指派的不参与经营 |
| 台账只收有品牌或共享表 | `brand_id IS NOT NULL OR tag='共享电表'` | 无名电表无法定单价 |
| 共享表唯一标识 | `tag='共享电表' AND brand_id IS NULL` | 场地总表 |

### 4.6 权限与数据隔离

鉴权入口：`backend/app/main.py:20-57` `AdminAuthMiddleware`。所有 `/api/*` 必须带 `Bearer token`，放行 `/api/auth/*`、`/api/health`、`/api/scheduler/status`。校验通过后挂 `request.state.current_user`。

隔离逻辑：`backend/app/infra/auth_scope.py`

| 角色 | 隔离字段 | 效果 |
|---|---|---|
| `boss` 老板 | 无 | 全量视角 |
| `finance` / `finance_supervisor` 财务 | `platform_users.meter_tag_scope` | 只看拥有该类型电表的场地（`scope_meter_tag` → `_tag_landlord_ids`） |
| `shareholder` 股东 | `platform_users.landlord_ids` | 只看关联场地（`scope_landlord_ids`）；且**全局只读**，写操作 403 |

⚠️ 同一指标在不同账号下基数可能不同（因为 `scope_landlord_ids` 会给几乎所有 SQL 追加 `WHERE landlord_id = ANY(...)`）。排查"数据不一致"先确认登录账号。

**小程序端 `/mp/*` 是独立子应用，不经此中间件、无数据隔离、股东无只读限制。**

### 4.7 税费口径

统一「价内税」：`split_tax(amount, rate)` = `税费 = 含税 × 税率`，`不含税 = 含税 − 税费`。税率空/0 视为不扣税。
实现：`backend/app/domain/electricity_pricing.py:124-140`。

- 电费侧：`contracts.tax_enabled` / `tax_rate` / `post_tax_electricity_price`
- 租金侧：`contracts.rent_tax_enabled` / `rent_tax_rate` / `post_tax_rent_price`（存库值 = `round(monthly_rent × (1 − rate), 2)`）
- 台账 `elecTax` **不是独立列**，一律 `collect_amount − collect_net` 现算。

---

## 第 5 章 · 逐页数据溯源

> 每节结构：**页面用途 → 调用接口 → 字段溯源表 → 特殊口径与坑**
> 表格列含义：`界面显示项` = 界面中文标签；`前端位置` = file:line；`后端函数` = file:line；`计算式` = 真实公式。

### 5.1 经营总览（Dashboard，`/`）

**用途**：全公司经营总控台。顶部按月看单月运营明细，下方看全量累计核心指标、月度趋势图、合同预警概览。

**调用接口**（`src/pages/Dashboard.tsx`）

| 前端调用 | 端点 | 后端函数 | 用途 |
|---|---|---|---|
| `getOverview()`（`:37`） | `GET /api/overview` | `overview.py:48` `overview` | 核心指标 + 月度趋势 |
| `getAlerts({granularity:"monthly",days:3})`（`:39`） | `GET /api/alerts` | `alerts.py:65` `get_alerts` | 合同预警板块 |
| `getMonthlyDetail(selectedMonth)`（`:47-50`） | `GET /api/overview/monthly-detail` | `overview.py:454` `monthly_detail` | 月度运营明细卡 |

#### A. 月度运营情况（数据源 `monthly-detail`）

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 电费收入 | `Dashboard.tsx:97` `md.elec.income` | `overview.py:505` | `Σ collect_net`（按 period） | `electricity_records.collect_net` |
| 电费成本 | `:98` `md.elec.cost` | `:506` | `Σ pay_amount` | `electricity_records.pay_amount` |
| 电费利润 | `:99` `md.elec.profit` | `:507` | `Σ profit` | `electricity_records.profit` |
| 明细表「电表」 | `:105` | `:513-531` | 明细表关联 | `electricity_meter_details.meter_id` → `meters.meter_no` |
| 明细「品牌」 | `:106,113` `d.brandName` | `:519,529` | `LEFT JOIN brands ON COALESCE(er.brand_id, m.brand_id)` | `electricity_records.brand_id` 优先，回退 `meters.brand_id` |
| 明细「度数」 | `:107,114` `d.kwh` | `:515,540` | 直取 | `electricity_meter_details.kwh` |
| 明细「付款」 | `:107,115` `d.payAmount` | `:515,541` | 直取 | `electricity_meter_details.pay_amount` |
| 明细「收款(不含税)」 | `:107,116` `d.collectNet` | `:515,543` | 直取 | `electricity_meter_details.collect_net` |
| 场租收入 | `:135` `md.rent.income` | `:585-586` | `Σ rent_income_for_period(c) − Σ rent_refund_for_period(c)`，仅品牌方合同 | `contracts.monthly_rent` / `first_month_rent` / `start_date` / `early_end_date` / `rent_refund` |
| 场租成本 | `:136` `md.rent.cost` | `:587` | `Σ monthly_rent`，仅场地合同 | `contracts.monthly_rent` |
| 场租利润 | `:137` `md.rent.profit` | `:594` | `rent_income − rent_cost − rent_tax` | 派生 |
| （隐含）租金税费 | `:588-593` 参与利润 | `:588-593` | `Σ(monthly_rent − post_tax_rent_price)` | `contracts.post_tax_rent_price` |
| 收入明细「主体名」 | `:146` `d.entityName` | `:665-684` | 按「场地+品牌」柜数权重 `_split_by_cabs` 分摊到 `entities.id`；无权重→「未指定主体」 | `meters.entity_id/landlord_id/brand_id` |
| 收入明细「N 份合同」 | `:147` `d.contractCount` | `:671-672` | 每份品牌方合同 +1 | `contracts.id` |
| 成本明细「主体名」/「金额/月」 | `:158,162` | `:674-684,676,732` | 按整场地全计费电表柜数权重 `weights_ll` 拆场地合同月租 | `contracts.monthly_rent` + 柜数 |
| 总电量 | `:174,178` `md.totalKwh` | `:468-483` | `Σ COALESCE(actual_kwh, ROUNd(kwh×倍数,2))`，`WHERE month_period=%s AND landlord_id IS NOT NULL AND brand_id IS NOT NULL` | `meter_monthly` + `meters.transformer_ratio` |
| 运营费用 | `:174,179` `md.opExpense.total` | `:686-700` | `Σ amount WHERE period=%s` | `operating_expenses.amount/period` |
| 运营费明细「场地方」/「备注」/「金额」 | `:185` | `:689-700,736` | `LEFT JOIN landlords`，空→「未指定」 | `landlords.name`、`operating_expenses.remark/amount` |
| 分红总额 | `:198,201` `md.dividend.total` | `:702-716` | `Σ profit WHERE period=%s` | `dividend_records.profit/period` |
| 未结算 N 条 | `:198,202` `md.dividend.pending` | `:706,713` | `COUNT(*) FILTER (WHERE status='未结算')` | `dividend_records.status` |

#### B. 核心指标卡（数据源 `GET /api/overview`）

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 「品牌组合」主值 | `:211` `data.stationCount` | `overview.py:58-81,410` | `COUNT(*)` over `DISTINCT (landlord_id,brand_id) FROM meters`，两者非空且非 TEST | `meters.landlord_id/brand_id` |
| 「运营中 N」 | `:211` `activeStations` | `:61-65,411` | 组合内 `EXISTS(meters.status='正常')` | `meters.status` |
| 「电表 N」 | `:211` `meterCount` | `:85-97,412` | `COUNT(*) FROM meters` 非 TEST | `meters.id` |
| 净利润（元） | `:59,212` `netProfitTotal` | `:429` | `elecProfit + rentIncomeTotal − rentCostTotal − rentTaxTotal − opExpenseTotal` | 见下各列 |
| 电费差价利润 | `:213` `elecProfit` | `:129,422` | `Σ profit`（全量累计） | `electricity_records.profit` |
| 「收款(不含税)」 | `:213` `elecCollect` | `:128,421` | `Σ collect_net` | `electricity_records.collect_net` |
| 「付款」 | `:213` `elecPay` | `:127,420` | `Σ pay_amount` | `electricity_records.pay_amount` |
| 场租差价利润 | `:214` `rentProfitTotal` | `:428` | `rentIncomeTotal − rentCostTotal − rentTaxTotal` | 派生 |
| 「收入」 | `:214` `rentIncomeTotal` | `:166-188,426` | `Σ monthly_rent` WHERE 品牌方合同 | `contracts.monthly_rent` |
| 「成本」 | `:214` `rentCostTotal` | `:168-190,425` | `Σ monthly_rent` WHERE 场地合同 | `contracts.monthly_rent` |
| 「已扣税」 | `:214` `rentTaxTotal` | `:179-202,427` | `Σ(monthly_rent − post_tax_rent_price)` WHERE `rent_tax_enabled` | `contracts.post_tax_rent_price` |
| 运营费用（元） | `:219` `opExpenseTotal` | `:204-209,431` | `Σ amount`（全量，无月份过滤） | `operating_expenses.amount` |
| 待收款项主值 | `:220` | 前端相加 | `elecUncollected + rentUncollected` | 见下两行 |
| 「电费」副值 | `:220` `elecUncollected` | `:131,142,424` | `Σ CASE WHEN collect_status='未到账' THEN collect_net` | `electricity_records.collect_status` |
| 「租金」副值 | `:220` `rentUncollected` | `:171-195,430` | `Σ CASE WHEN rs.status='未到账' THEN rs.amount` JOIN 品牌方合同 | `rent_income_schedule.status/amount` |
| 待付款项 | `:221` `elecUnpaid` | `:130,141,423` | `Σ CASE WHEN pay_status='未付款' THEN pay_amount` | `electricity_records.pay_status` |
| 合同预警主值 | `:226` | `ContractAlertCard` 计数 `:45-46` | `expiringCount + overdueOnlyCount`（仅未处理） | 见 5.12 |
| 「临期 N」 | `:227` `expiringCount` | 前端 `:45` | `status==='临期'` 计数 | — |
| 「逾期分期 N」 | `:227` `overdueOnlyCount` | 前端 `:46` | `status ∉ (临期,已到期)` 计数 | — |
| 品牌方「N 个品牌方」 | `:239` `brandCount` | `:114-116,415` | `COUNT(*) FROM brands` | `brands.id` |
| 公司主体「N 个主体」 | `:245` `entityCount` | `:114-116,416` | `COUNT(*) FROM entities` | `entities.id` |
| 场地方「N 个场地方」 | `:251` `landlordCount` | `:108-113,417` | `COUNT(*) FROM landlords`（股东账号加 `id=ANY(allowed)`） | `landlords.id` |
| 股东分红「N 个股东」 | `:257` `shareholderCount` | `:117-121,418` | 股东账号恒 1；否则 `COUNT(*)` | `shareholders.id` |
| 「N 个介绍人」 | `:257` `introducerCount` | `:114-116,419` | `COUNT(*) FROM introducers` | `introducers.id` |

#### C. 电费收付月度趋势图（`/api/overview`）

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| X 轴 period | `:270` | `:265,277,441-442` | `GROUP BY period ORDER BY period DESC LIMIT 12`，输出 `YYYY-MM` | `electricity_records.period` |
| 柱「电费收款」 | `:274` | `:267,445` | `Σ collect_net GROUP BY period` | `electricity_records.collect_net` |
| 柱「电费付款」 | `:275` | `:266,444` | `Σ pay_amount GROUP BY period` | `electricity_records.pay_amount` |
| 柱「电费利润」 | `:276` | `:268,446` | `Σ profit GROUP BY period` | `electricity_records.profit` |
| （返回未画）kwh | — | `:269-274,443` | 每 period 子查询 `Σ COALESCE(actual_kwh, kwh×倍数)` | `meter_monthly` + `meters` |

#### 首页特殊口径与坑

1. **「品牌组合」≠ 物理站点**：`stationCount` 是 `DISTINCT(landlord_id, brand_id)` 组合数，一个场地挂多品牌算多个。
2. **月度明细 vs 核心指标不同源**：顶部卡片走 `monthly-detail`（按 period 过滤），下方核心指标走 `/api/overview`（**全量累计，无月份过滤**）。两者不可直接对账。
3. **电费统计未过滤 TEST 表**：`electricity_records` 表无 `meter_no` 列，所以电费统计无法排除 TEST 电表，与电表数/电量口径存在差异。
4. **税费是价内税且扣利润**：`netProfitTotal`、`rentProfitTotal` 均已扣税；但前端 fallback 公式 `Dashboard.tsx:59` 漏了税（仅在后端字段缺失时触发，正常以后端为准）。
5. **合同预警口径与 `station-board` 不同**：经营总览复用 `/api/alerts` 的 `_get_contract_alerts`（到期日 `COALESCE(early_end_date,end_date)` + 配置化窗口 + 含逾期分期）；而 `station_board` 内另有一套固定 90 天的简化统计（`overview.py:994-1001`）。**两处不可混用**。
6. **`bills` 四象限未被首页渲染**：`bills.payable.elec/site`、`bills.receivable.elec/site`（`:300-407`）接口有返回但 `Dashboard.tsx` 未引用，属预留。

---

### 5.2 场地数据（Stations，`/stations`）

**用途**：按**场地方**维度的经营看板。左侧主表一行一个场地，行展开看场地 KPI + 品牌拆分 + 品牌电表列表，右侧可视化面板（单场地饼图/多场地对比），支持提交审核与导出 Excel。

> 命名提示：页面/路由/接口都叫 `Stations`，但 v3 已无站点概念，此处「场地」= `landlords`。

**调用接口**

| 前端调用 | 端点 | 后端函数 |
|---|---|---|
| `getStationBoard({keyword,period})`（`Stations.tsx:1100-1103`） | `GET /api/overview/station-board` | `overview.py:748` `station_board` |
| `getLandlordStationMonthly(id, 6)`（`:843-846`） | `GET /api/overview/landlord-station-monthly` | `overview.py:1239` |
| `getLandlordMeterView(id, period)`（`:271-274,1144,1161`） | `GET /api/stations/landlord/{id}/meter-view` | `stations.py:56` `get_landlord_meter_view` |
| `submitStationApproval(...)`（`:91-92`） | `POST /api/approvals` | `approvals.py` |

#### A. 主表列（来源 `station-board`）

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 场地方名称 | `:1385` `r.landlord.name` | `overview.py:770-776` | `SELECT l.id,l.name,l.contact,l.phone FROM landlords l` | `landlords.name` |
| 联系人/电话 | `:1387-1388` | 同上 | 同上 | `landlords.contact` / `phone` |
| 电表数 | `:1396` `r.meterCount` | `:1107` | `len(meters)`，`landlord_id=... AND brand_id IS NOT NULL` | `meters.id` |
| 电费付款 | `:1399` `r.elecPay` | `:1109`，算于 `:939-940` | `total_kwh × elec_pay_price`，单价来自 `resolve_prices(contracts)["pay_price"]` | `contracts.electricity_price`（场地合同） |
| 电费收款（不含税） | `:1400` `r.elecCollect` | `:1110`，算于 `:944-959` | `Σ _station_collect(sb)`：品牌度数×品牌单价，或共享表分摊金额；启用税率则 `split_tax` 取净额 | `contracts.electricity_price` / `meter_shared_allocations.collect_amount` |
| 电费利润 | `:1401` `r.elecProfit` | `:1111` | `elec_collect − elec_pay` | 派生 |
| 租金成本 | `:1402` `r.rentCost` | `:1113`，算于 `:839-841` | `Σ 场地合同.monthly_rent` | `contracts.monthly_rent` |
| 租金收入 | `:1403` `r.rentIncome` | `:1114`，算于 `:962-973` | `Σ rent_income_for_period(c) − rent_refund` | `contracts.monthly_rent` / `first_month_rent` / `rent_refund` |
| 运营费用 | `:1404` `r.opExpense` | `:1117`，SQL `:988-991` | `SUM(amount) WHERE landlord_id AND period` | `operating_expenses.amount` |
| 总利润 | `:1405` `r.totalProfit` | `:1119` | `elec_profit + rent_profit − op_expense − dividend` | 派生 |
| 合同（份数/到期/临期） | `:1408-1410` | `:1120-1122`，SQL `:994-1001` | `COUNT(*)` / `end_date < CURRENT_DATE` / `end_date <= CURRENT_DATE+90d` | `contracts.end_date` |
| 合计行 | `:1436-1451` | 前端 `useMemo` | 各列求和 | 派生 |

> 返回结构：`overview.py:1098-1125` → `landlord / meterCount / totalKwh / elecPay / elecCollect / elecProfit / elecTax / rentCost / rentIncome / rentProfit / rentTax / opExpense / dividend / totalProfit / contractCount / stationBreakdown / contractBreakdown`

#### B. 行展开 KPI（`ExpandedDetail`，由主表行透传，不额外请求）

| 界面显示项 | 前端位置 | 后端字段 |
|---|---|---|
| 总度数 | `:524` `summary.totalKwh` | `overview.py:1108` |
| 电费成本 | `:528` `summary.elecPay` | `:1109` |
| 电费收入（不含税） | `:532` `summary.elecCollect` | `:1110` |
| 电费利润 | `:536` `summary.elecProfit` | `:1111` |
| 场地成本/收入/利润 | `:542/546/550` | `:1113-1115` |
| 运营费用 | `:554` | `:1117` |
| 电费税费 / 场地费税费 | `:560/564` `summary.elecTax/rentTax` | `:1112/1116`，算于 `:1060-1088` |
| 场地分红 | `:568` `summary.dividend` | `:1118`，SQL `:1091-1096`（`dividend_records.profit`） |
| 总利润 | `:572` | `:1119` |
| 各品牌拆分表 | `:768-783` `summary.stationBreakdown` | `:848-937`（`brand_id/brand_name/kwh/meter_count/elecPay/elecCollect/elecProfit`） |
| 合同构成表 | `:589/612/644` `summary.contractBreakdown` | `:1036-1058` |

#### C. 品牌电表明细（`LandlordMeterDetail`，来源 `meter-view`）

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 电表品牌 | `:366` `meter.brandName` | `stations.py:314` | `brand_name or "未指定品牌"` | `brands.name` |
| 柜子数量 | `:367` `meter.cabinetCount` | `:315` | `max(1, len(cabinets))` | `cabinets` |
| 柜子编号 | `:368` `meter.cabinetNos` | `:316` | `join(cabinet_no)` | `cabinets.cabinet_no` |
| 电表编号 | `:375` `meter.meterNo` | `:312` | 直取 | `meters.meter_no` |
| 上月抄表度数 | `:376` `meter.prevEndReading` | `:317` | 上月 `COALESCE(actual_kwh, kwh×倍数)` | `meter_monthly` + `meters.transformer_ratio` |
| 本月抄表度数 | `:377` `meter.endReading` | `:319` | 同上（本月） | 同上 |
| 付款度数 | `:378` `meter.payKwh` | `:320` | `this_month_kwh` | `meter_monthly` |
| 付款单价 | `:379` `meter.payUnitPrice` | `:321` | `pricing["pay_price"]` | `contracts.electricity_price`（场地合同） |
| 付款金额 | `:380` `meter.payAmount` | `:298` | `round(pay_kwh × pay_price, 2)` | 派生 |
| 电费付款情况 | `:383` `meter.payStatus` | `:323` | `brand_record.pay_status` | `electricity_records.pay_status` |
| 收款区间 | `:394` `collectStartDate/EndDate` | `:324-325` | ⚠️ **恒为 None**（未实现） | — |
| 收款度数 | `:399` `meter.payKwh` | `:320` | 与付款度数同值 | `meter_monthly` |
| 电费收款单价 | `:400` `meter.collectUnitPrice` | `:294/326` | `brand_price_for(pricing, brand_id, entity_id)["price"]` | `contracts.electricity_price`（品牌方合同） |
| 税后单价 | `:402` `meter.postTaxPrice` | `:332` | `brand_info["post_tax"]` | `contracts.post_tax_electricity_price` |
| 电费收入（含税） | `:404` `meter.collectAmount` | `:299` | `round(collect_kwh × collect_price, 2)` | 派生 |
| 电费收款情况 | `:407` `meter.collectStatus` | `:328` | `brand_record.collect_status` | `electricity_records.collect_status` |
| 税率 | `:415` `meter.taxRate` | `:296/330` | `brand_info["tax_rate"]` | `contracts.tax_rate` |
| 电费收入（不含税） | `:417` `meter.collectNet` | `:300-303/329` | `split_tax(collect_amount, tax_rate)` 或原值 | 派生 |
| 场地租金付款（合同） | `:425-436` `mv.contractRent.cost` | `:189-209` | 遍历 `contract_type='场地合同'` | `contracts.rent_amount/monthly_rent/pay_method/pay_status/start_date/end_date` |
| 品牌方租金收款（合同） | `:446-457` `mv.contractRent.income` | `:210-240` | 遍历 `contract_type='品牌方合同'` | 同上 + `contracts.brand_id` |
| 近 6 个月用电量 | `:472` `meter.monthlyEnergy` | `:268-276`，SQL `:139-146` | `SELECT address,month_period,kwh,actual_kwh FROM meter_monthly LIMIT 30` | `meter_monthly` |
| 场地汇总 | `:311-329` `mv.summary` | `:385-404` | 见返回体 | 派生 |

#### 场地数据页特殊口径与坑

1. **本页与「场租台账」口径不同**：本页租金收入用 `rent_income_for_period`（含首月租、扣退款），是**单月实收口径**。
2. **"站点"命名遗留**：`stationBreakdown` 的 `brandId` 缺省 key 是 `__shared__`（`Stations.tsx:769`），v2→v3 兼容命名；`station_repo.py` 已空置。
3. **`collectStartDate/collectEndDate` 恒空**：后端 `stations.py:324-325` 未从台账回填，界面区间永远显示 `-`。属已知空实现。
4. **导出 Excel 会为每个场地并发调一次 `meter-view`**（`:1160-1162`），场地多时注意性能。
5. **`ExpandedDetail` 的 summary 由父组件手工组装**（`:1425`），字段名依赖主表返回；后端改字段名前端会静默变 0。

---

### 5.3 电费台账（Electricity，`/electricity`）

**用途**：在月份区间内，按「场地方 / 品牌方 / 公司主体」三维度滚动汇总电费经营信息（电量、付款、收款含税/不含税、税费、利润）与逐电表明细。支持抄表核对、状态行内编辑、应付电费审批、Excel 导出。**本页只读汇总，不做计算。**

**调用接口**

| 触发点 | 端点 | 后端函数 |
|---|---|---|
| 页面主数据（区间逐月并发） | `GET /api/electricity/monthly-ledger?period&dim` | `electricity.py:918` `monthly_ledger` |
| 状态徽章行内编辑 | `PUT /api/electricity/{id}/status` | `electricity.py:124` |
| 「详细」抄表核对弹窗 | `GET /api/electricity/reading-detail?meterNo&period` | `electricity.py:141` |
| 「导出 Excel」 | `GET /api/electricity/export?period&dim` | `electricity.py:1110` |
| 应付电费审批弹窗 | `POST /api/approvals` | `approvals.py` |

> `dim` 取值 `landlord`（默认）| `brand` | `entity`。`GET /api/electricity`（列表）、`POST/PUT/DELETE`、`POST /generate` **本页不调用**（generate 由智慧电表页/同步/合同保存触发）。

#### A. 主数据（`monthly-ledger` 返回 `{period, dim, rows[], totals{kwh,payAmount,collectAmount,collectNet,elecTax,profit}}`）

| 界面显示项 | 前端位置 | 计算式 | 源表.字段 |
|---|---|---|---|
| 区间总览·电量（度） | `:786`，累加 `:676-688` | 逐月 `totals.kwh` 相加 | `pay_kwh`（landlord/entity）｜`details.kwh`（brand） |
| 区间总览·电费付款 | `:787,680` | 逐月 `totals.payAmount` | `electricity_records.pay_amount` ｜`details.pay_amount` |
| 区间总览·收款（含税） | `:788,681` | 逐月 `totals.collectAmount` | `collect_amount` |
| 区间总览·收款（不含税） | `:789,682` | 逐月 `totals.collectNet` | `collect_net` |
| 区间总览·电费税费 | `:790,683` | `collect − net`（`:1091`） | 派生（无独立列） |
| 区间总览·电费利润 | `:791,684` | `SUM(e.profit)` 或 `net − pay`（`:1092`） | `electricity_records.profit` |
| 月份行·六列 | `:826-831` | 同区间六列，取单月 | 同上 |
| 明细行·名称 | `:842-843,876` | landlord：`COALESCE(l.name,'未指定场地')`；brand：`COALESCE(b.name,'全品牌共享')`；entity：`COALESCE(ent.name,'未指定主体')` | `landlords/brands/entities.name` |
| 明细行·行内 电量/付/收/税/利 | `:878-885` | 同区间六列 | 同上 |
| 展开表·电表名/编号 | `:927-928` | `m.meter_name, m.meter_no` | `meters` |
| 展开表·品牌方 | `:942-944` | `COALESCE(e.brand_id, m.brand_id)` → `brands` | `electricity_records.brand_id` ↔ `meters.brand_id` |
| 展开表·互感器倍数 | `:947` | `m.transformer_ratio` | `meters.transformer_ratio` |
| 展开表·度数 | `:952-955` | `d.kwh` | `electricity_meter_details.kwh` |
| 展开表·付款单价/金额 | `:957-967` | `d.pay_unit_price` / `d.pay_amount` | `electricity_meter_details` |
| 展开表·付款情况 | `:984-987` | `e.pay_status` | `electricity_records.pay_status` |
| 展开表·收款单价/(含税)/不含税 | `:993-995` | `d.collect_unit_price/collect_amount/collect_net` | `electricity_meter_details` |
| 展开表·到账情况 | `:1007-1011` | `e.collect_status` | `electricity_records.collect_status` |
| 展开表·利润（行级） | `:1015-1016` | 前端 `collectNet − payAmount`（明细行未返 profit） | 派生 |
| 「已人工修改」角标 | `:932-934` | `e.data_source = 'manual'` | `electricity_records.data_source` |
| 抄表核对·电表信息 | `:67-68,132-135` | `meters JOIN brands JOIN landlords` | 多表 |
| 抄表核对·上/本月抄表 | `:68,147-155` | `meter_monthly WHERE address AND month_period` | `prev/curr_reading_date`、`prev/curr_reading`、`kwh`、`actual_kwh` |
| 抄表核对·上月同期用量 | `:245-246` | 上月 `month_period` 查询 | `meter_monthly.kwh` |
| 抄表核对·台账费用行 | `:69-72,217-229` | 联查 `electricity_meter_details`+`electricity_records`+`meters` | 多表 |
| 抄表核对·品牌分摊列表 | `:72,231-244` | `meter_shared_allocations LEFT JOIN brands` | `collect_amount/unit_price/remark` |

#### B. 导出 Excel（28 列，`GET /api/electricity/export`，每电表一行）

| 导出列 | 响应 key | 后端行 | 源表.字段 |
|---|---|---|---|
| 收款公司 | `collectCompany` | `:1189/1193/1197` | `entities.name` |
| 站名 | `stationName` | `:1203` | `meters.meter_name` |
| 业主方 | `landlordName` | `:1204` | `landlords.name` |
| 电表编号 | `meterNo` | `:1205` | `meters.meter_no` |
| 互感器倍数 | `transformerRatio` | `:1206` | `meters.transformer_ratio` |
| 上月抄表时间/起始度数 | `prevReadingDate`/`startReading` | `:1207-1208` | `meter_monthly.prev_reading_date/prev_reading` |
| 抄表时间/抄表度数 | `readingDate`/`endReading` | `:1209-1210` | `meter_monthly.curr_reading_date/curr_reading` |
| 区间度数 | `kwh` | `:1211` | `electricity_meter_details.kwh` |
| 付款单价/金额/情况 | `payUnitPrice`/`payAmount`/`payStatus` | `:1212-1214` | `d.pay_unit_price`/`d.pay_amount`/`e.pay_status` |
| 收款起止/度 | `collectStartReading`…`collectKwh` | `:1215-1218` | `meter_monthly` 同列；`collectKwh = d.kwh` |
| 收款单价/金额/不含税/到账 | `collectUnitPrice`… | `:1219-1222` | `d.collect_unit_price/collect_amount/collect_net`/`e.collect_status` |
| 利润 | `profit` | `:1178` | `net − pay` |
| 运营费用 | `opExpense` | `:1179`，子查询 `:1156-1158` | `operating_expenses.amount`（按 `landlord_id,period` 预聚合） |
| 运营费用后利润 | `profitAfterOp` | `:1180` | `profit − opExpense` |
| **公司占股** | `companyShare` | `:1181`，SQL `:1138` | ⚠️ `landlords.company_share`（**无 DDL，见 8.3**） |
| **公司净利润** | `companyNetProfit` | `:1182` | `profitAfterOp × companyShare` |
| 备注 | `remark` | `:1228` | `electricity_records.remark` |

#### 电费台账页特殊口径与坑

1. **三维度取数不一致**：`landlord`/`brand` 维度的 kwh 用**明细** `SUM(d.kwh)`；`entity` 维度用**记录级** `SUM(e.pay_kwh)`。`brand` 维度行**不返回 `payStatus`**（前端默认「未付款」）。
2. **`pay_status` / `collect_status` 是唯一"重算免疫"字段**：台账重算的 UPDATE 语句**不含**这两列，手工改的状态在重算后保留。
3. **人工改过的金额会被重算覆盖**：`existing_map` 按 `(landlord,brand,entity,period)` 命中时**不区分 auto/manual**，金额会被重算覆盖、`data_source` 被翻回 `'auto'`。**只有分组键消失时 manual 记录才被保留**（不被残留清理删除）。
4. **共享电表付款只有一整笔**：付场地方 = 整表读数 × 场地单价；各品牌行的 `pay_kwh` 已按 `scale` 摊入线损，合计即整表那一笔。收款金额不参与分摊。
5. **导出运营费用防翻倍**：`operating_expenses` 按 `(landlord_id, period)` **预聚合**再 JOIN（`:1155-1158`），避免同场地多主体多行导致明细行翻倍。
6. **权限过滤位置不同**：`export_ledger` 先查全量再在 Python 层过滤（`:1167-1171`）；`monthly_ledger` 把权限条件下沉进 SQL（`:926-940`）。
7. **period 归一化兼容**：`monthly-ledger`/`export` 用 `replace("-","")`；`reading-detail` 用 `to_compact()`。

---

### 5.4 场租台账（Rent，`/rent`）

**用途**：场地费（**不含电费**）月台账。按场地方/品牌方两维度看收入/成本/税费/利润，展开看公司主体分组与合同明细。底部两个模块：**年度付款计划**（分期 + 标记付款 + 提交付款审批）与**整年场地收支**。

**调用接口**

| 前端 API | 端点 | 后端函数 |
|---|---|---|
| `getMonthlyLedger(period, dim)`（`Rent.tsx:1015`） | `GET /api/rent/monthly-ledger` | `rent.py:84` `monthly_ledger` |
| `getYearlyPaymentSchedule(id, year)`（`:482-486`） | `GET /api/rent/yearly-payment-schedule` | `rent.py:537` |
| `updateSchedule(id, data)`（`:467-469,759/770/912/923`） | `PUT /api/contract-schedules/{id}` | `contract_schedules.py:29` → `contract_schedule_repo.update_schedule:255` |
| `submitStationApproval(data)`（`:307`） | `POST /api/approvals` | `approvals.py:40` |

> `GET/POST/DELETE /api/rent/expenses`（运营费用）**不由本页调用**，实际调用方是 `Shareholders.tsx:6,997,1033,1042`。`GET /api/rent/excel-data` 已废弃。

#### A. 区间总览卡与按月表行

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 区间场地费收入 | `:1202` `totals.rentIncome` | `rent.py:427-436`，聚合 `:319-321` | 各月 `rows[].rentIncome` 求和；`rentIncome = Σ 品牌方合同 monthlyRent` | `contracts.monthly_rent` |
| 区间场地费成本 | `:1203` `totals.rentCost` | `:322-323` | `Σ 场地合同 monthlyRent` | `contracts.monthly_rent` |
| 区间税费 | `:1204` `totals.rentTax` | `:245-246` | 品牌方合同且 `rent_tax_enabled`：`round(monthly_rent − post_tax_rent_price, 2)` | `contracts.rent_tax_enabled` / `post_tax_rent_price` |
| 区间利润 | `:1205` `totals.rentProfit` | `:431/436` | `rentIncome − rentCost − rentTax` | 派生 |
| 区间已收 / 未收 | `:1206-1207` | `:250-256` | 按 `status=='已到账'` 分桶 | `rent_income_schedule.status/amount` |
| 区间已付 / 未付 | `:1208-1209` | `:257-261` | 按 `status=='已付款'` 分桶 | `rent_payment_schedule.status/amount` |
| 按月表行（同上各列） | `:1298-1318` | 同上 | 取单月 `m.totals.*`；月份由 `monthRange`（`:1000-1010`，最多 36 月）生成 | 同上 |
| 展开行·场地方/品牌方名 | `:1358` | `:303-318` | 分组 key → name | `landlords.name` / `brands.name` |
| 展开行·公司主体分组名 | `:1333` `grp.entityName` | `:486-529` | `contracts.entity_id→entities.name` → 缺失回退 `meters.entity_id→entities.name` → 「未指定主体」 | `contracts.entity_id` / `meters.entity_id` / `entities.name` |

#### B. 年度付款计划模块（`RentPaymentSchedule`，`:458-983`）

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 年租金成本（大字） | `:569` `totalAmount` | `rent.py:703,677` | `Σ schedules[].amount` | `rent_payment_schedule.amount` |
| 合同租期 | `:562` | `:688-689` | `end_date` 优先取 `early_end_date` | `contracts.start_date/early_end_date/end_date` |
| 付款方式 | `:562` | `:687` | 直取 | `contracts.pay_method` |
| 每期金额 | `:563` `firstAmount` | `:696` | `schedules[0].amount` | `rent_payment_schedule.amount` |
| 付款进度 已付X/Y期 | `:557` | `:705-706` | `status=='已付款'` 计数 / 行数 | `rent_payment_schedule.status` |
| 已付/待付金额 | `:628/632` | `:704` | `Σ(amount where 已付款)`；待付=`total − paid` | `rent_payment_schedule.amount/status` |
| 分期行（期数/时间/金额/状态/实付时间） | `:712-743` | `:691-702` | 字段直出 | `rent_payment_schedule.seq/period_start/period_end/amount/status/pay_date` |
| 审批中/已驳回徽章 | `:723-730` | `:654-661` | 按 `period` 的 YYYYMM 前缀匹配审批单 | `approval_requests.period/status`（`biz_type='场地费付款'`） |
| 收款进度/已收/待收/合同数 | `:650-674` | `:603-611` | `Σ(amount where status=='已到账')` | `rent_income_schedule.amount/status` |
| 收款分期明细（按品牌分组） | `:829-961` | `:567-601` | 品牌方合同 LEFT JOIN 收款分期（区间过滤） | `rent_income_schedule.*` + `brands.name` |
| 审批弹窗·经营佐证-租金收入 | `:417` `schedule.monthIncome` | `:647-652,673` | `Σ 品牌方合同 monthly_rent`（该场地固定值） | `contracts.monthly_rent` |
| 审批弹窗·经营佐证-电费收入(不含税) | `:421` `schedule.monthElecIncome` | `:664-669` | `SUM(electricity_records.collect_net)` 按场地×月 | `electricity_records.collect_net` |

#### C. 整年场地收支表（`YearlyTable`，`:84-228`，数据源 `months[0].yearlyRows`）

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 品牌方 | `:170` | `rent.py:440-454` | `_contract_item` 直出 | `brands.name` |
| 负责人（场地） | `:172` | `:267` | 直取 | `landlords.contact` |
| 租期 / 合作年限 | `:173-174` | `:284-285`；前端 `:107-109` | `(end − start)/365.25` 保留 1 位 | `contracts.start_date/end_date/early_end_date` |
| 租金成本/年 | `:177` | `:243` | `annual = rent_amount ?? monthly_rent × 12` | `contracts.rent_amount` / `monthly_rent` |
| 付款方式 | `:179` | `:283` | 直取 | `contracts.pay_method` |
| X年付款情况 (paid/total) | `:180-187` | `:216-225` `_year_status` | 按 `period_start` 年份分组，`status ∈ (已到账,已付款)` 计数 | `rent_payment_schedule` / `rent_income_schedule` |
| 单台成本/年 | `:188` `unitCostAnnual` | `:409,468` | `venue_annual ÷ avg_month_cabs`（该年各月在期品牌总柜数平均） | `contracts.rent_amount` + 实时柜数 |
| 押金（整场地） | `:189-193` | `:278` | 仅第一行展示 | `contracts.deposit`（场地合同） |
| 合同日期（品牌） | `:195` | `:284-285` | 直取 | `contracts.start_date/early_end_date/end_date` |
| X年到账情况 | `:196-203` | `:291` `_year_status(...,('已到账',))` | 同上 | `rent_income_schedule.status` |
| 柜数 | `:204` | `:277` `liveCabinetsCount` | `_live_cabs(landlord, brand, period)`：实时电表柜数 + 共享表分摊柜数 | `meters→cabinets` + `meter_shared_allocations.cabinet_count` |
| 单台月租金(含税) | `:205` | `:275` | 直取（不重算） | `contracts.unit_monthly_rent` |
| 单台年收入(含税) | `:206` | 前端 `:155` | `unit_monthly_rent × 12` | `contracts.unit_monthly_rent` |
| **场地租金收入(含税)/年** | `:207` `venueRentGross` | 前端 `:158` | **`unitAnnual × cabinets`**（实时柜数，**非** `monthly_rent×12`） | `contracts.unit_monthly_rent` + 实时柜数 |
| 场地税率 | `:208` | `:281` | 直取 | `contracts.rent_tax_rate` |
| 租金收入(不含税)/年 | `:209` | 前端 `:159-161` | `gross × (1 − rentTaxRate)` | `contracts.rent_tax_rate` |
| 进项成本 | `:210` | `:279` | 直取 | `contracts.input_cost` |
| 租金利润 | `:211-213` | 前端 `:164-166` | `rentIncomeNet − rentCostAnnual − inputCost`，`rentCostAnnual = unitCostAnnual × cabinets` | 派生 |

#### 场租台账页特殊口径与坑

1. **月台账 vs 整年表口径不同**：月台账的收入/成本**直取落库列 `contracts.monthly_rent`**（`:242`），不做 `unit_monthly_rent × 柜数` 重算；整年表的"场地租金收入/年"却用 `单价 × 实时柜数 × 12`。**柜数变化后两者不一致**，属设计差异。
2. **`monthly_rent` 落库时已含"按柜数"结果**：品牌方合同保存时前端算 `unit_monthly_rent × cabinets_count → monthlyRent` 并落库（`Contracts.tsx:980-989`），同时 `rentAmount = calculated × 12`。
3. **场地合同的"按柜子数量"模式**：`unit_monthly_rent × 该场地下所有品牌方合同计费柜数总和`（`Contracts.tsx:991-1001`）。
4. **柜数只认实时统计**：`rent.py:157-165` 直接 `SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets WHERE meter_id=m.id)))`，**不读 `contracts.cabinets_count` 存储快照**。
5. **场地成本 ≠ 电费成本**：本页 `monthly-ledger` **完全不含电费**（`rent.py:81-82` 注释明确）。品牌方合同承担的场地成本 = `场地月租 × 该品牌柜数 ÷ 该月所有在期品牌总柜数`，**分子分母必须同月同口径**（`rent.py:360-388` 注释警告，否则虚高数倍）。
6. **税费只对品牌方合同算**：`contract_type='品牌方合同' AND rent_tax_enabled AND post_tax_rent_price IS NOT NULL`（`:245`）。
7. **首月租金只在自动拆期时参与**：含合同首月的那一期金额 = `first_month_rent + monthly_rent × (期长−1)`；不参与月台账汇总。
8. **场地费退款走审批不冲减台账**：`rent_refund` 必须与 `early_end_date` 成对填写（`contract_repo._validate_early_end`）；退款走「场地费退款」审批单，通过后回写 `contracts.deposit_refund_*`。
9. **运营费用按主体分摊**：`entity_id IS NULL` = 场地公共（按柜数分摊到主体），非空 = 该主体专属。分红口径**不区分主体、全部计入**（`rent_repo.py:31-62`）。

---

### 5.5 品牌方看板（Brands，`/brands`）

**用途**：以品牌为根，聚合每个品牌在各场地的经营数据（电费收支、租金收入、平摊场地成本、利润）。

**调用接口**：`listBrands`（`/directory/brands`）、`listContracts`（`/contracts`）、`listMeters`（`/meters`）、`listCabinets`（`/cabinets`）、`getSharedCabinetUsage`（`/meter-energy/shared-cabinet-usage`）、`listElectricity`（`/electricity`）、`getMonthlyLedger(period,'brand')`（`/rent/monthly-ledger`）。

| 界面显示项 | 前端位置 | 计算式 | 源表.字段 |
|---|---|---|---|
| 品牌名/联系人 | `Brands.tsx:310-311` | `SELECT * FROM brands` | `brands.name/contact` |
| 场地数 / 电表数 / 柜子数 | `:315-317` | `sites.length` / `brandMeters.length` / `brandCabinets.length + sharedCabCount` | `meters` + `cabinets` + `meter_shared_allocations` |
| 电费付款 | `:318,342` | `site.elecPayAmount += elecRecord.payAmount`（按 `landlordId+brandId`） | `electricity_records.pay_amount` |
| 电费收款（不含税） | `:319,345` | `site.elecCollectNet += elecRecord.collectNet` | `electricity_records.collect_net` |
| 月租金收入 | `:349-350` | `contracts[品牌方合同].monthly_rent` / `ledgerMap` | `contracts.monthly_rent` |
| **场地成本（当月平摊）** | `:353-354,379,417` | `venueShareMonth = 场地月租 × 品牌当月柜数 ÷ 该月在期品牌总柜数` | `contracts.monthly_rent` + 柜数 |
| 电费利润 | `:356-358` | `elecCollectNet − elecPayAmount` | 派生 |
| 净利润 | `:360-363` | `elecProfit + rentProfit`；`rentProfit = rentIncome − venueCostMonth − rentTax` | 派生 |
| 电表编号/名称/场地方/柜子数 | `:511-521` | `cabinets.filter(meterId===m.id).length` | `meters`、`cabinets.meter_id` |
| 共享电表柜数 | `:218-241` | `it.brandCabs[brandId]`（`managedByAlloc` 时） | `meter_shared_allocations.cabinet_count` |

**"品牌应付/应收"怎么来的**（本页最常被问）：
- **应收（收款）** = 电费收款（不含税）+ 租金收入。电费收款**直接读台账 `collect_net`**（台账生成时已按品牌拆好；共享表的 `collect_amount` 来自人工分摊，`collect_net` 再按品牌税率拆税）。**前端不再自行分摊。**
- **应付（付款）** = 电费付款 `pay_amount`。共享表付款已在**台账生成阶段**把整表读数（含亏空）按品牌摊进 `pay_amount`。
- **场地成本** = `venueShareMonth`，是**场地月租按品牌柜数占比**的分摊，**不是电费分摊**。

**坑**：
1. 年份过滤只作用于**品牌方合同**（`:122-128`）；场地合同取全量。
2. `venueCostMonth` 依赖 `getMonthlyLedger(period,'brand')` 的 `row.contracts[]`，按 `(brandId-landlordId)` 建索引（`:82-92`）—— 同品牌同场地多份品牌方合同会互相覆盖。
3. 只显示 `meterCount>0 || sharedCabCount>0` 的品牌（`:266-268`），避免纯共享表经营的品牌整条消失。
4. 品牌列表受 `scope_meter_tag` 限制。

---

### 5.6 公司主体看板（Entities，`/entities`）

**用途**：以公司主体为根，三种视图 —— **场租**（合同按柜数分摊到主体）、**电租**（主体名下电表电费明细）、**损益**（后端 `entity-monthly` 口径）。

**调用接口**：`listEntities`、`listContracts`、`listMeters`、`listCabinets`、`getSharedCabinetUsage`、`getLandlordMeterView`（`/stations/landlord/{id}/meter-view`）、`getEntityMonthly`（`/overview/entity-monthly`，后端 `overview.py:1472` `entity_monthly`）。

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 主体名/简称/税号/纳税人类型 | `Entities.tsx:564-569` | `directory_repo.py:111` | `SELECT * FROM entities` | `entities.*` |
| 合同数 | `:577` | 前端 `:116-127` | `contractAllocs` 命中该主体的合同数 | `contracts` + 柜数权重 |
| 月租金合计 | `:581` | 前端 `:130` | `Σ c._mSlice`（分片月租） | `contracts.monthly_rent` |
| 合同按主体分摊比例 | `:710` | 前端 `:83-104` | `ratio = w / totalW` | `meters` + `cabinets` + `meter_shared_allocations` |
| 场地合同-租金成本/单台成本 | `:658-670` | 前端 `:99-104,308-309` | `_mSlice = splitByAllocs(monthlyRent, allocs)`；`unitCost = costRent/totalCabinets` | 同上 |
| 品牌方合同-含税/不含税租金 | `:700-716` | 前端 `:701-706` | `netIncome = monthlyRent × (1−taxRate) × 12` | `contracts.monthly_rent/tax_enabled/tax_rate` |
| 充电柜/储电柜/合计 | `:322-324,354-356` | 前端 `:175-181` | 按 `cabinet_type` 分类计数；无柜默认 1 充电柜 | `cabinets.cabinet_type` |
| 损益·电量 | `:841` | `overview.py:1505-1514` | `SUM(pay_kwh) GROUP BY entity_id` | `electricity_records.pay_kwh` |
| 损益·电费付款 | `:842` | `:1605` | `SUM(pay_amount)` | `electricity_records.pay_amount` |
| 损益·收款（不含税） | `:843` | `:1607` | `SUM(collect_net)` | `electricity_records.collect_net` |
| 损益·电费税费 | `:844` | `:1670` | `elecCollect − elecNet` | 派生 |
| 损益·电费利润 | `:845` | `:1661` | `elecNet − elecPay` | 派生 |
| 损益·租金收入 | `:846` | `:1618-1629` | 品牌方合同按 `weights_brand[(lid,brand)]` 拆分：`split_by_weights(rent_income_for_period − rent_refund_for_period)` | `contracts` + 柜数权重 |
| 损益·租金税费 | `:847` | `:1620-1625` | `monthly_rent − post_tax_rent_price`，按同权重拆 | `contracts` |
| 损益·场地租（分摊） | `:848` | `:1613-1617` | 场地合同 `monthly_rent` 按 `weights_ll[lid]` 拆 | `contracts.monthly_rent` |
| 损益·运营费（分摊） | `:849` | `:1633-1641` | `entity_id` 非空全额归主体；否则按 `weights_ll[lid]` 拆 | `operating_expenses` |
| 损益·净利润 | `:850` | `:1662` | `elecProfit + rentIncome − rentTax − venueCost − opExpense` | 派生 |
| 电租·各列 | `:1034-1050` | `stations.py` | `meter.payAmount/collectNet/...`；`profit = collectNet − payAmount` | 电表视图 |

**柜数如何按主体拆分**（核心）：前端 `:52-92` 用 `cabinetCounter`（每表 `max(1,柜数)`，与后端 `GREATEST(1,cab_cnt)` 同口径）建两级权重：
- 收入侧 `weightIncome["场地:品牌"] → {entityId: 柜数}`（品牌方合同按此拆）
- 成本侧 `weightLandlord[场地] → {entityId: 柜数}`（场地合同按此拆）
- 共享表若 `managedByAlloc`，柜数归各品牌且**不能再按整表计**；主体归属优先级：**分摊行指定 → 电表主体**。

**坑**：
1. **场租视图与损益视图是两套独立实现**：前者前端 `splitByAllocs`（`src/lib/alloc.ts:67`），后者后端 `split_by_weights`（每片舍入到分，尾差归占比最大主体，`overview.py:1579-1598`）。分摊基数需同源才闭合。
2. **「未指定主体（待归属）」是前端合成行**（id=-1，`:247-260`）：合同存在但该场地无已归属主体的电表时出现。
3. **电租视图可能漏共享表分摊明细**：过滤用 `ownMeterNos`（`entity.meters` 的 meterNo 集合），共享表按品牌分摊的行不在 `entity.meters` 中（`:452-458,921-927`）。
4. **导出"税率"列是合同税率**，不是 13% 增值税（`:307-309`）。
5. `delete_entity` 若仍有合同/电表挂载则拒绝删除，并连带清理 `entity_brands`。

---

### 5.7 场地方看板（Landlords，`/landlords`）

**用途**：场地方列表 + 展开明细（合同、电表按品牌分组、成本/收入/利润汇总），支持搜索与导出。

**调用接口**：`GET /api/directory/landlords`（`directory.py:117` → `directory_repo.py:201`）、`listContracts`、`listMeters`。业主增删改接口（`/landlords/{id}/owners`）本页未直接调用，业主随列表返回。

| 界面显示项 | 前端位置 | 计算式 | 源表.字段 |
|---|---|---|---|
| 场地方名称 | `Landlords.tsx:141` | `landlords l LEFT JOIN landlord_site_summary s` | `landlords.name` |
| 联系人/电话 | `:144-148` | `l.*` | `landlords.contact/phone` |
| 业主子表（多业主） | 随 `landlord.owners` | `SELECT * FROM landlord_owners ORDER BY landlord_id, start_date DESC` | `landlord_owners.owner_name/phone/start_date` |
| 品牌数 | `:155` | 该场地电表品牌去重 | `meters.brand_id` |
| 电表数 | `:159` | `meters.filter(landlordId)` | `meters.landlord_id` |
| 合同数 | `:163` | 按 `landlordId` 过滤 | `contracts.landlord_id` |
| 场地成本/收入/利润 | `:167,187-195` | `Σ成本合同monthlyRent`、`Σ收入合同monthlyRent`、`收入−成本` | `contracts.monthly_rent/contract_type` |
| 电表明细·报税主体 | `:242` | `m.entityName` | `meters.entity_id → entities.name` |
| 合同计费柜数 | `:283` | `liveCabinetsCount ?? cabinetsCount`（实时统计优先） | `contracts.cabinets_count`（兜底）+ `cabinets` |

**多业主子表机制**：
- 读取：`list_landlords` 一次性按 `landlord_id` 聚合成 `owners` 数组（最新在前，`directory_repo.py:217-227`）。
- 写入：`add/update/delete_landlord_owner`（`:246/264/284`），每次写入都调 `_sync_current_owner`（`:233-243`）把**最新一条业主**写回 `landlords.contact`。
- `create_landlord`（`:327-348`）若 `contact` 非空会自动登记为首任业主；`ensure_landlord_owner`（`:301`）供合同 Excel 导入幂等补业主。

**地图坐标**：存 `landlords.latitude/longitude`，由 `create/update_landlord` 写入，`get_landlord_locations`（`stations.py:12`）读取。⚠️ **API 层断点**：`directory.py:128-134` 的 `create_landlord` 只透传 `name/contact/phone/remark`，`latitude/longitude/region/address` **无法通过常规 PUT 可靠写入**（repo 支持但 API 未暴露）。

**坑**：
1. **本页场租成本/收入是简单 `Σ 合同月租`**，不含按柜数分摊、不含电费、不含运营费，与 Brands/Entities/分红口径**均不同**。
2. `landlords.contact` 与 `landlord_owners` 双向同步：`update_landlord(contact=...)` 会改写最新业主名（`:380-389`），**编辑联系人 = 改业主**。
3. 选中月份 `selectedMonth` 在本页仅用于工具栏输入框，**未参与任何计算**（`:17-20,118`）。
4. 列表受股东权限与电表类型范围过滤。

---

### 5.8 股东分红（Shareholders，`/shareholders`）

**用途**：分红管理。两大视角 —— **按场地方**（逐月/区间预估、维护股东/商务配置、录运营费用、生成月结记录、提交审批、重算、导出）与**按股东**（汇总全部关联场地的已落库分红）。

**调用接口**

| 前端 API | 端点 | 后端 |
|---|---|---|
| `getStationBoard` | `GET /api/overview/station-board` | `overview.py:748` |
| `listShareholders` / `listEntities` | `GET /api/directory/shareholders` / `/entities` | `directory.py:189` / `:51` |
| `shareholderSummary` | `GET /api/dividends/summary/shareholder` | `dividends.py:277` → `dividend_repo.py:404` |
| `listShareholderConfigs` / `saveShareholderConfig` / `deleteShareholderConfig` | `/api/dividends/configs/shareholder` | `dividends.py:13/18/23` |
| `listIntroducerConfigs` / `saveIntroducerConfig` / `deleteIntroducerConfig` | `/api/dividends/configs/introducer` | `dividends.py:29/34/39` |
| `calculateDividend` | `POST /api/dividends/calculate` | `dividends.py:47` → `dividend_calc.py:35` |
| `listDividends` / `getDividend` / `createDividend` | `/api/dividends` | `dividends.py:90/106/145` |
| `refreshDividends` | `POST /api/dividends/refresh` | `dividends.py:70` → `dividend_refresh.py:12` |
| `submitDividend` / `settleDividend` / `deleteDividend` | `/api/dividends/{id}/submit|settle` / `DELETE` | `dividends.py:209/251/263` |
| `listExpenses` / `saveExpense` / `deleteExpense` | `/api/rent/expenses` | `rent_repo.py:6/65/100` |

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 左侧场地方名称 | `:1315` | `overview.py:749` | `SELECT l.id,l.name,l.contact,l.phone FROM landlords` | `landlords.name` |
| 公司主体分组名 | `:1301`；`groupByEntity` `src/lib/groupColors.ts:50` | `overview.py:780-797` | `DISTINCT ON (k)`：场地合同主体 → 其他合同主体 → 电表主体 | `contracts.entity_id` / `meters.entity_id` → `entities.name` |
| 场地联系人/电话 | `:1372-1373` | 同上 | `landlords.contact/phone` | `landlords` |
| 电费利润 | `:1382` | `overview.py:1111` | `round(elec_collect − elec_pay, 2)` | 派生 |
| 场地利润 | `:1386` | `:1115` | `round(rent_income − rent_cost − rent_tax, 2)` | 派生 |
| 运营费用 | `:1390` | `:1117` | `operating_expenses` 该场地该月合计 | `operating_expenses.amount` |
| 总利润（分红基数） | `:1394` | `:1119` | `elec_profit + rent_profit − op_expense − dividend` | `dividend_records.profit` |
| 分红品牌下拉 | `:902-909` | `:1046-1058` | `contractBreakdown[type=品牌方合同 && brandId]` | `contracts.brand_id → brands.name` |
| 股东列表 | `:1330-1347` | `directory_repo.py:411` | `SELECT * FROM shareholders` | `shareholders.name/phone` |
| 左侧股东「本月/区间分红」 | `:1342` | `dividend_repo.py:404` | `dividend_shares ds JOIN dividend_records d`，`ds.shareholder_id IS NOT NULL`；聚合 `totalAmount/settledAmount/pendingAmount` | `dividend_shares.amount`、`dividend_records.status` |
| 股东卡「已结算」/「待结算」 | `:1703/1709` | 同上 | 按 `status=='已结算'` 分桶 | `dividend_records.status` |
| 分红预估·总收入 | `:1506` | `dividend_calc.py:541` | `elec_income + rent_income` | 派生 |
| 分红预估·总成本 | `:1510` | `:527` | `elecCost + rentCost + opExpense + rentRefund + bizDividendCost` | 派生 |
| 分红预估·税费 | `:1514` | `:290-291` | `cost.elecTax + cost.rentTax` | 派生 |
| 分红预估·净利润 | `:1518` | `:533` | `totalIncome − totalCost` | 派生 |
| 分红预估·分红合计 | `:1523` | `:554-557` | `summary.totalShareholderDividend + totalBusinessDividend` | 派生 |
| 受益人姓名/品牌/模式/比例/周期/计入成本 | `:1209-1214` | `:1080-1097`（商务）/`:1161-1177`（股东） | 配置快照直出 | 配置表 |
| 受益人金额、是否结算月 | `:1217-1222` | 同上 | `amount`；`isSettlementMonth = is_settlement_month(...)` | 派生 |
| 运营费用录入 | `:1421-1462` | `rent_repo.py:6/65` | 按 `(landlord_id, period, entity_id)` upsert | `operating_expenses` |
| 分红配置列表项 | `:1579-1627` | `dividend_repo.py:6/100` | LEFT JOIN shareholders/brands/entities | `landlord_shareholder_configs.*` |
| 已生成分红记录 | `:1639-1659` | `dividend_repo.py:197` | `dividend_records + shares` | `dividend_records.*`、`dividend_shares.amount` |
| 核算明细·逐月构成 | `:343-374` | `dividend_calc.py:434-447` / `:509-519` | `income.*` / `cost.*`；品牌用 `brandBreakdown` | 派生 |
| 核算明细·电费收入（表级） | `:384-401` | `:263-276` + `:190-208` | `income.elecIncome.details[{meterNo,brandName,kwh,unitPrice,amount}]` | `meter_monthly` + 合同单价 |
| 核算明细·租金收入 | `:404-418` | `:250-261` | `income.rentIncome.details[{cabinets,unitMonthlyRent,amount,preTaxRent,postTaxRent}]` | `contracts.monthly_rent/first_month_rent/post_tax_rent_price` |
| 核算明细·电费成本 | `:421-438` | `:296-302` | `cost.details.electricity[{meterNo,kwh=pay_kwh,unitPrice,amount}]` | 派生 |
| 核算明细·场地成本/运营费用 | `:441-451` | `:303-310` | `cost.details.rent[{landlordName,monthlyRent}]`、`operatingExpense` | `contracts.monthly_rent`、`operating_expenses` |
| 核算明细·税费明细 | `:454-467` | `:311-318` | `cost.details.elecTax/rentTax.details` | 派生 |
| 股东视图·各场地区间预估 | `:1736` | `:1101` | `shareholderEstimateByLandlord[lid] = Σ月 amount` | 派生 |

**本页最重要的提醒**：预估（`/calculate`，不落库）与汇总（`/summary`，只读落库记录）**互不相干**，页面里两个数字通常不同；月度记录未生成时 summary 为空。分红公式详见 [6.2](#62-分红计算引擎-dividend_calc)。

---

### 5.9 合同管理（Contracts，`/contracts`）

**用途**：合同 CRUD + 分期管理。按「公司主体 → 场地方」分组，每个场地下分「场地合同（成本）」「品牌方合同（收入）」两区。支持筛选、统计卡、导出、Excel 批量导入、变更审计、场地费退款审批入口。

**调用接口**

| 前端 API | 端点 | 后端 |
|---|---|---|
| `listContracts(params)` | `GET /api/contracts` | `contracts.py:13` → `contract_repo.py:28` |
| `createContract` / `updateContract` / `deleteContract` | `POST/PUT/DELETE /api/contracts[/{id}]` | `contracts.py:24/498/523` |
| `getContractAudit(id)` | `GET /api/contracts/{id}/audit` | `contracts.py:536` → `contract_repo.py:14` |
| `importContractsExcel(file)` | `POST /api/contracts/import` | `contracts.py:239` |
| `listPaymentSchedules` / `listIncomeSchedules` | `GET /api/contract-schedules/payment|income` | `contract_schedules.py:19/24` |
| `createSchedule` / `updateSchedule` / `deleteSchedule` | `/api/contract-schedules` | `contract_schedules.py:8/29/40` |
| `createApproval`（场地费退款） | `POST /api/approvals` | `approvals.py:40` |

#### A. 列表与统计

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 合同总数/正常/临期/已到期/提前结束 | `Contracts.tsx:227-236` | `contract_repo.py:196-215` | 按 `status` 聚合 | 派生 |
| **状态 `status`** | `:575/679` | `:196-215` | `early_end_date` 存在且已过 → `提前结束`；`end_date` 已过 → `已到期`；`≤90天` → `临期`；否则 `正常` | `contracts.end_date` / `early_end_date` |
| 剩余天数 `days_left` | `:572-573` | `:196-204` | `max(0, (end − today).days)` | 派生 |
| 场地合同行·电费单价/年租金/月租金/押金/付款方式 | `:566-570` | `:123`（`SELECT c.*`） | 直出 | `contracts.electricity_price/rent_amount/monthly_rent/deposit/pay_method` |
| 品牌方合同行·单柜场地月租 | `:658` | `:123` | 直出 | `contracts.unit_monthly_rent` |
| 品牌方合同行·**计费柜数** | `:659` | `:50-67,154-175` | `live_cabinets_count`：实时按 `meters→cabinets GREATEST(1,±)` + 共享表分摊柜数；`cabinets_count` 仅兜底 | `meters→cabinets` / `meter_shared_allocations.cabinet_count` |
| 品牌方合同行·场地月租金 | `:660` | `:123` | 直出 | `contracts.monthly_rent` |
| 品牌方合同行·**承担场地成本** | `:661` | `:216-225` | `venue_monthly_rent ÷ total_brand_cabinets × live_cabinets_count` | `contracts.monthly_rent`（场地合同）+ 实时柜数 |
| 品牌方合同行·电费单价（税前/税后） | `:662-667` | `:123` | 直出 | `contracts.electricity_price` / `post_tax_electricity_price` |
| 品牌方合同行·押金/首月场地租金/场地费退款 | `:668-670` | `:123` | 直出 | `contracts.deposit/first_month_rent/rent_refund` |
| 品牌方合同行·合同期限 | `:672-675` | `:123` | `early_end_date` 优先 | `contracts.start_date/end_date/early_end_date` |
| 月成本/月收入/月利润（场地方头部） | `:500-514` | 前端聚合 | `Σ场地合同 monthlyRent` / `Σ品牌方合同 monthlyRent` / 差 | `contracts.monthly_rent` |
| 分摊比例 `_ratio`（跨主体切片） | `:656` | 前端 `:271-370` | 按电表柜数比例分摊（`allocOf`） | `meters→cabinets` |
| 变更记录 | `:1548-1568` | `:14-25` | 直出 | `contract_audit_log.action/changes/operator/created_at` |

#### B. 表单保存字段映射（`Contracts.tsx:1143-1176`）

| 前端字段 | 行 | 落库列 | 备注 |
|---|---|---|---|
| `landlordId` | `1144` | `landlord_id` | 场地合同一场地一份 |
| `brandId` | `1145` | `brand_id` | `"shared"`/空 → `null`（全品牌合同） |
| `contractType` | `1146` | `contract_type` | **两分法**，决定成本还是收入 |
| `electricityPrice` | `1147` | `electricity_price` | 场地合同=付款单价，品牌方合同=收款单价 |
| `rentAmount` / `unitMonthlyRent` / `rentCalcMethod` / `monthlyRent` | `1148-1152` | 同名 snake | 前端按 `unit × 柜数` 算好落库 |
| `payMethod` / `autoSplit` / `rentAdvanceDays` | `1153-1155` | 同名 snake | 决定自动拆期 |
| `entityId` | `1162` | `entity_id` | **仅场地合同携带**；品牌方合同恒 `null` |
| `taxEnabled/taxRate/postTaxElectricityPrice` | `1165-1167` | 同名 snake | 前端算 `price×(1−rate)`（`:1108-1110`） |
| `rentTaxEnabled/rentTaxRate/postTaxRentPrice` | `1172-1174` | 同名 snake | 前端算 `monthly×(1−rate)`（`:1116-1118`） |
| `deposit/firstMonthRent/rentRefund/earlyEndDate` | `1168-1171` | 同名 snake | 三者允许显式清空（`contract_repo.py:387-394`） |
| ~~`cabinetsCount`~~ | `1149` 注释 | — | **已退役**，不再写入 |

#### C. 自动拆期算法（`contract_schedule_repo.py`）

前端有同算法预检 `splitPeriodsPreview`（`Contracts.tsx:36-52`），界面提示"将拆成 N 期"（`:1325-1334,1414-1423`）。

```
期长表 _PERIOD_MONTHS (:11-16)  月付=1 / 季付=3 / 半年付=6 / 年付=12，其它→1
日期推进 _add_months (:19-30)   按合同周年日推进；月末日（1/31）对齐目标月最后一天
拆期 _split_periods (:56-67)
    k=0; cur=start
    while cur <= end:
        nxt = _add_months(start, (k+1)*months_per_period)
        periods.append((cur, min(nxt-1天, end)))    # 尾期被 end 截断
        cur = nxt; k += 1
每期金额 _period_amount (:38-53)
    完整期(pe >= nominal_end)  → 若该期起点月 == 合同首月且填了 first_month_rent
                                 则 first_month_rent + monthly_rent × (months−1)
                                 否则 monthly_rent × months
    被截短的尾期               → 返回 None（金额留空）❗由用户手填，系统不擅自折算
落库 generate_schedules (:104-170)
    先读旧分期建 seq → {status, pay_date, invoice, remark, amount} 映射 (:137-140)
    DELETE 全部旧分期 (:142)
    逐期 INSERT ... ON CONFLICT (contract_id, seq) DO UPDATE (:150-165)
    ⭐ 按 seq 回填旧状态（已付款/已到账、付款日期、发票、备注）并保留手填金额
    默认状态：付款表 未付款 / 收款表 未到账 (:163)
```

**调用时机**：新建合同（`contract_repo.py:319-333`）、更新合同（`:426-440`）。
**表选择**：`table = "rent_payment_schedule" if contract_type == "场地合同" else "rent_income_schedule"`（`contract_schedule_repo.py:131`）。
**`end_date` 生效值**：调用方传 `earlyEndDate || endDate`，提前结束的合同分期止于提前结束月。

#### D. `rent_advance_days`（提前支付天数）的作用

`payment_due_months`（`:70-101`）：
```
due = period_start − rent_advance_days
到期月 = "{due.year}-{due.month:02d}"
```
用途：提交场地费审批时校验所选月份是否处于可提交的月份。
⚠️ **不影响 `period_start/period_end/amount`** —— `generate_schedules` 不使用它，只按 `pay_method` 拆期。

#### E. `auto_split` 开关

- `TRUE`（默认）→ 保存合同自动拆期。
- `FALSE` → 不拆，用户在列表展开行手动「+ 添加一期」（或新建时用 `ManualPeriodsEditor`，`:1063-1089`）。
- `pay_method == "自定义周期"` → **强制** `auto_split=False`（`contract_repo.py:264-266`，前端 `autoSplitLocked` `Contracts.tsx:875,1320,1409`）。
- 更新时：`if updated.auto_split and updated.pay_method != "自定义周期"` 才重建（`:426`）。

#### F. Excel 批量导入（`POST /api/contracts/import`，`contracts.py:239-493`）

- 优先选 sheet 名含"合同"或"收付"的表（`:262-265`）；**第 3 行为表头**（`rows[2]`，`:274`），兼容新旧模板，无表头回退旧版固定列位（`_resolve_import_cols` `:222-234`）。
- 列映射 `_IMPORT_COLS`（`:186-219`），主要字段：

| Excel 列 | 去向 |
|---|---|
| 合同类型(场地) / 公司收款主体 / 场地方 / 区域 / 地址 | `contract_type` / `entities`（无则建）→ `entity_id` / 场地负责人 → `landlords.contact` + 建业主 / `contracts.region` / **场地名 = 「地址」列** |
| 场地年租金 / 场地月租金 / 电费单价 / 场地租金付款方式 / 场地押金 / 提前支付天数 | `rent_amount` / `monthly_rent`（空则 年租金/12）/ `electricity_price` / `pay_method`（默认月付）/ `deposit` / `rent_advance_days` |
| 场地合同开始/结束日期 / 备注 | `start_date` / `end_date` / `remark` |
| 合同类型(品牌) / 品牌方 / 计费方式 / 单柜场地月租金 | 品牌方合同判定 / `brands`（无则建）→ `brand_id` / `rent_calc_method`（含"固定"→固定价格，否则按柜子数量）/ `unit_monthly_rent` |
| ~~计费柜数~~ | **不导入**（已退役） |
| 品牌场地月租金 / 品牌合同年租金 | `monthly_rent` / **强制置 null**（`:433`） |
| 电费收款单价(税前) / 租金收款方式 / 品牌押金 / 首月场地租金 / 场地费退款 | `electricity_price` / `pay_method` / `deposit` / `first_month_rent` / `rent_refund` |
| 电费税率(%) / 场地费税率(%) | `tax_enabled` + `tax_rate` + `post_tax_electricity_price`（`:438-440`）/ `rent_tax_enabled` + `rent_tax_rate` + `post_tax_rent_price`（`:441`） |

- 场地合同与品牌合同**可出现在同一行**（合并单元格首行），各自独立处理（`:345-347`）。
- 品牌合同无"关联场地"列 → **按顺序关联前一行场地合同对应的场地方**（`current_landlord_id`，`:410-414`）。
- 去重键：`(contract_type, landlord_id[, brand_id], start_date, end_date)`（`:375-387,447-460`）。
- 返回 `{imported, skipped, errors, created_landlords, created_brands, created_entities}`。

#### 合同页特殊口径与坑

1. **`contract_type` 两分法是全局分流键**：`场地合同` = 成本（公司付场地方，写 `rent_payment_schedule`）；`品牌方合同` = 收入（品牌方付公司，写 `rent_income_schedule`）。**一个场地方只能有一份场地合同**（`contract_repo.py:270-279` / `:400-409`）；品牌方合同可多份、可按主体拆签（唯一键含 `entity_id`）。
2. **`contracts.cabinets_count` 已 DEPRECATED**（2026-09）：前端不写、导入不导，仅作 `liveCabinetsCount ?? cabinetsCount` 兜底展示。唯一源 = 实时统计。
3. **首月租金/退款/押金**：`first_month_rent` 只在自动拆期参与；`rent_refund` 必须与 `early_end_date` 成对填写（`_validate_early_end` `:247-257`），退款走审批回写 `deposit_refund_*`，**不直接冲减月台账**；`deposit` 月台账仅展示（整年表第一行）。
4. **品牌方合同唯一键含主体**（v3.2/D4）：`(landlord_id, brand_id, entity_id, start_date, end_date) WHERE contract_type='品牌方合同'`，支持同场地同品牌按主体拆签。
5. **拆期重建会保留状态**：按 `seq` 回填 `status/pay_date/invoice/remark` 与手填金额，不会因改合同丢失已付款标记。
6. **变更审计**：`contract_audit_log` 记录 `action ∈ (create/update/delete)`，update 存 `changes={字段:{from,to}}`。

---

### 5.10 审批中心（Approvals，`/approvals`）

**用途**：统一审批中心，三个 Tab —— **待办审批**（通过/驳回/催办 + 详情 + 流程时间线）、**提交审批**（手工建单）、**审批台账**（筛选 + 导出）。

**调用接口**：`listFlows`（`/approvals/flows`）、`saveFlow`（`POST /approvals/flows`）、`listApprovals`（`GET /approvals`）、`getApproval`（`/{id}`）、`createApproval`（`POST`）、`actOnApproval`（`POST /{id}/act`）、`getApprovalStats`（`/stats/overview`）、`calculateDividend`（`POST /api/dividends/calculate`，分红审批详情实时预览）。

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 待审批 / 已通过 / 已驳回 / 累计 | `Approvals.tsx:639-642` | `approval_repo.py:338-345` | `COUNT(*) FILTER (WHERE status=...)` | `approval_requests.status` |
| 编号 `AP-xxxxx` | `:592` | `:54-66` | `padStart(id,5)` | `approval_requests.id` |
| 类型 | `:594` `r.bizType` | 同上 | 直出 | `approval_requests.biz_type` |
| 审批事由 | `:596-598` `r.title` | 同上 | 直出 | `approval_requests.title` |
| 事由后场地名 | `:598` `r.landlordName` | `:56-63` | `COALESCE(l.name, al.name)`：优先分红记录场地，再审批单场地 | `landlords.name`（经 `dividend_records.landlord_id` 或 `approval_requests.landlord_id`） |
| 金额 / 申请人 / 申请时间 / 状态 | `:601-604` | 同上 | 直出 | `approval_requests.amount/applicant/created_at/status` |
| 详情·各字段 | `:452-483` | `:77-88` | 直出 | `approval_requests.*` |
| 费用构成-电费成本/场地租金/合计 | `:186-207` | 同上 | 直出 | `approval_requests.electricity_amount/rent_amount/amount` |
| 分红金额 / 分红对象 | `:252-277` | `POST /dividends/calculate` | 实时重算 `shareholderDividends[].amount` / `bizDividends[].amount` | `dividend_calc` 派生 |
| 收入构成（电费/租金） | `:289-312` | 同上 | `income.elecIncome.total` / `income.rentIncome.total` / `income.totalIncome` | 电费台账 + `contracts.monthly_rent` |
| 成本构成（电费/租金/运营/商务分红/税） | `:324-368` | 同上 | `cost.elecCost/rentCost/opExpense/bizDividendCost/totalCost/elecTax/rentTax` | 电费 + 合同 + `operating_expenses` |
| 净利润 / 股东分红 / 商务分红明细 | `:378-420` | 同上 | `profit`、`shareholderDividends[]`、`bizDividends[]` | `dividend_calc` 派生 |
| 审批流程时间线 | `:497-502`（`FlowTimeline` `:82`） | `approval_repo.py:91-102` | 按 `node_index` 匹配节点与操作记录 | `approval_requests.flow_nodes/current_node/status` + `approval_records.*` |

#### `biz_type` 类型与通过后回写（本页最关键）

| `biz_type` | 提交来源 | 通过后回写 | 后端位置 |
|---|---|---|---|
| **分红审批** | `dividends.py:227`；`approvals.ts:29` | `dividend_records.status = '已通过'`（单条 + 多对多**全部**）；驳回 → `'已驳回'` | `approval_repo.py:291-295` / `:309-313` |
| **电费付款** | `approvals.ts:59`；场地数据页 | `electricity_records.pay_status = '已付款'`（`WHERE landlord_id AND period`） | `:238-243` |
| **场地费付款** | `Rent.tsx:311`；`approvals.ts:59` | `rent_payment_schedule.status='已付款', pay_date=NOW()`（区间匹配该月，取最早未付一期）+ 同步 `contracts.pay_status`（全部已付=已付款 / 部分=部分付款 / 否则未付款） | `:200-235` |
| **场地费退款** | `Contracts.tsx:164/1185` | `contracts.deposit_refund_amount = amount − rent_amount`；`deposit_refund_date = CURRENT_DATE`；`deposit_refund_approval_id = 审批单 id`。**绝不联动租金分期/电费台账** | `:187-198` |
| **电费+场地费** | `approvals.ts:59` | **同时**走"场地费付款"与"电费付款"两条分支 | `:201` + `:238` |

⚠️ **匹配陷阱（改审批回写必看）**：`apply_payment_links` 用**子串匹配** —— `if "场地费" in biz`（`:201`）会匹配 `"场地费付款"` **和** `"电费+场地费"`；`if "电费" in biz`（`:238`）会匹配 `"电费付款"` **和** `"电费+场地费"`。因此 `场地费退款` 被**提前 return 单独处理**（`:187-198`），否则会因含"场地费"子串误把分期标成已付款（源码 `:185-186` 注释明确警示）。

#### 状态机与流程推进

```
审批单：审批中 ──全部节点通过──> 已通过   （终态，不可再操作）
       审批中 ──任一节点驳回──> 已驳回   （终态）
分红记录：未结算/已驳回 --submit--> 申报中 --通过--> 已通过 --settle--> 已结算
                                          --驳回--> 已驳回
```

- **`flow_nodes`**：JSON 数组，元素 `{"name": "财务主管审核", "approver": "张三"}`。
  - 来源：`approval_flows.nodes`（按 `biz_type` 查，`:110-123`）；或建单时由请求体 `flowNodes` 覆盖；分红审批传 `approvers` 会动态构建（`approvals.py:44-52`）。
  - **未配置流程的兜底**：默认交老板审批（查 `platform_users WHERE role='boss'`），**绝不允许申请人自审**（`:117-123`）。
- **`current_node`**：整数，从 0 开始，指向当前待审节点。
- **推进**（`:282-302`）：`通过` 且 `current_node+1 >= len(flow_nodes)` → `status='已通过'`、`finished_at=NOW()`；否则只 `SET current_node=next_node`。
- **审批人校验**（`:262-270`）：通过/驳回必须由 `flow_nodes[current_node].approver` 执行，否则 403。节点未配审批人时放行（兼容历史）。操作人一律取登录用户，**不信任请求体名字**（`approvals.py:65-69`）。
- **操作记录**：每次动作 `INSERT INTO approval_records(request_id, node_index, node_name, approver, action, comment)`；建单时先写一条 `action='提交', node_index=0`（`:145-148`）。
- **催办**：`urge_count = urge_count + 1`（`:314-318`）。

#### 与分红 / 场地费退款的双向关联

- **单条强关联**：`approval_requests.dividend_record_id` ↔ `dividend_records.approval_id`（建成时双向写，`:127-141` + `:160-163`）。
- **多对多**：`approval_dividend_records(approval_id, dividend_record_id)`，支持**多月批量分红审批**；建单时去重后逐条 `INSERT ... ON CONFLICT DO NOTHING`（`:150-163`）；通过/驳回时取**全部**关联记录一起回写（`_linked_dividend_ids`，`:273-280`）。
- **反查接口**：`GET /api/approvals/by-dividend/{dividend_id}`（`approvals.py:92-108`）。
- **列表 JOIN**：`list_requests` LEFT JOIN `dividend_records dr`，取 `COALESCE(dr.landlord_id, ar.landlord_id)`、`dr.period`（`:54-66`）。

#### 审批页特殊口径与坑

1. **`转办` / `加签` 未实现**：前端 `ActDialog` 支持（`Approvals.tsx:21,44-49`），但后端 `act_on_request` 只处理 `通过/驳回/催办`；转办/加签落入末尾仅写一条 `approval_records`，**不改状态、不推进节点**。已知缺口。
2. **终态不可再操作**（`:254-257`），防止重复回写造成账实不符。
3. `POST /api/dividends/{id}/settle` 只允许 `已通过 → 已结算`（`dividends.py:256-258`），防止绕过审批放款。
4. `DELETE /api/dividends/{id}`：`申报中/已通过/已结算` 一律拒绝删除（`:268-269`）。

---

### 5.11 智慧电表（Meters，`/meters`）

**用途**：电表档案管理（归属场地/品牌/报税主体、标签、互感器倍数、采集器号），按场地方分组浏览电表卡片与柜子。提供四类录入入口：普通电表读数、共享电表**品牌分摊**、共享电表**场地方电费（整表补录）**、共享电表**整表抄表记录**。支持第三方同步刷新、Excel 导入、台账联动重算。

**调用接口**

| 触发点 | 端点 | 后端 |
|---|---|---|
| 电表列表 | `GET /api/meters` | `meters.py:232` → `meter_repo.py:4-35` |
| 新增/编辑/删除电表 | `POST/PUT/DELETE /api/meters[/{id}]` | `meters.py:281/306/376` |
| Excel 导入 | `POST /api/meters/import` | `meters.py:72` `import_meters` |
| 柜子增删改 | `/api/cabinets` | `cabinets.py:29-67` |
| 字典（场地方/品牌/主体） | `/api/directory/{landlords,brands,entities}` | `directory` 路由 |
| 合同（主体不一致提示） | `GET /api/contracts` | `contracts` 路由 |
| **自动生成台账** | `POST /api/electricity/generate` | `electricity.py:473` `generate_electricity` |
| 第三方同步 | `POST /api/meter-energy/sync?type=` | `meter_energy.py:533` |
| 读某表全部月度读数 | `GET /api/meter-energy/monthly?meterNo=` | `meter_energy.py:124` |
| 品牌分摊表单数据 | `GET /api/meter-energy/shared-allocations` | `meter_energy.py:276` |
| 保存品牌分摊 | `POST /api/meter-energy/shared-allocations` | `meter_energy.py:394` |
| 共享表柜数明细 | `GET /api/meter-energy/shared-cabinet-usage` | `meter_energy.py:378` → `shared_allocation_repo.py:297` |
| 保存读数 / 整表补录 | `POST /api/meter-energy/readings` | `meter_energy.py:174` |

#### A. 电表列表与档案

| 界面显示项 | 前端位置 | 取数 | 源表.字段 |
|---|---|---|---|
| 电表编号 | `Meters.tsx:531` | `m.*` | `meters.meter_no` |
| 品牌方 | `:532-534` | `LEFT JOIN brands`；空且共享→「全品牌共享」 | `meters.brand_id` / `brands.name` |
| 标签 | `:535-537` | `m.tag` | `meters.tag` |
| 「第三方」徽标 | `:538-540` | `CASE WHEN EXISTS(SELECT 1 FROM meter_devices WHERE address=m.meter_no) THEN 'synced' ELSE 'manual' END` | `meter_devices.address` |
| 状态 | `:541` | `m.status` | `meters.status` |
| 电表名称 | `:543` | `m.meter_name` | `meters.meter_name` |
| 主体不一致提示 | `:137-151,544-546` | 前端比对：同场地同品牌品牌方合同主体 ≠ 电表 `entity_id` | `contracts.entity_id` / `meters.entity_id` |
| 互感器倍数 | `:550` | `m.transformer_ratio` | `meters.transformer_ratio` |
| 柜数 | `:555`（值 `:496`） | `allocCabCount ?? localCabCount` | 见 [4.4](#44-柜数三来源优先级必背) |
| 柜子编号/类型/备注 | `:613/615/619` | `c.*, m.meter_no, m.meter_name, b.name` | `cabinets.cabinet_no/cabinet_type/remark` |
| 品牌分摊柜数标签 | `:589-596` | `brandCabs` | `meter_shared_allocations.cabinet_count` |

**互感器倍数用法**（贯穿全系统）：建档默认 `1`（`meters.tsx:742`）。`实际用电量 = actual_kwh 优先，否则 kwh × transformer_ratio`。出现位置：台账生成 `electricity.py:682-683`、单场地台账 `:62-63`、月用量接口 `meter_energy.py:162-167`、电表详情 `meters.py:267-275`、日/小时用量 `meter_energy.py:70-73,114-117`。

**主体继承规则**（`meter_repo.py`）：
- 建档未显式指定 `entityId` → 跟随场地「最新一份场地合同」的 `entity_id`（`_venue_entity_id` `:81-90`），标 `entity_source='auto'`。
- 显式指定 → `'manual'`。
- 场地变更时自动跟随（`:154-160`）；场地合同主体变更级联只覆盖**非 manual** 电表（`sync_landlord_meter_entities` `:93-110`）。

#### B. 三个录入表单写入明细（核心）

**表单 A · 品牌分摊**（紫色块，`:1303-1468`）
- 保存：`saveSharedAllocations({address, monthPeriod, rows})`（`:1189-1201`，仅 `allocDirty` 时）
- 接口：`POST /api/meter-energy/shared-allocations`（`meter_energy.py:394-513`）
- 写入表 `meter_shared_allocations`，仓储 `replace_allocations` **先删该表该月全部行再重建**（`shared_allocation_repo.py:63-95`）：
  `meter_id, address, month_period, brand_id, entity_id, collect_amount, unit_price, cabinet_count, remark`
- 校验：必须 `tag='共享电表'` 且 `brand_id IS NULL`，否则 400；同月同表品牌不可重复；金额留空行不保存（全清空=取消分摊）；单价填了必须 >0（`meter_energy.py:410-491`）
- **联动：保存成功后自动 `generate_electricity({period})` 重算该月台账**（`:498-504`）

**表单 B · 场地方电费**（琥珀块，`:1471-1592`）
- 界面只读展示「应付场地方 / 亏空」（`:1062-1077`）；「修改/手动补录」触发 `saveTableKwh.mutate()`（`:1485-1527`）
- 保存：`saveMeterReading({address, monthPeriod, kwh: rawKwh, actualKwh: v})`（`:1233`）
- 接口：`POST /api/meter-energy/readings`（`meter_energy.py:174-257`）
- 写入 `meter_monthly`：实际写 **`actual_kwh`（= 付场地方电量，已含倍数）**，同时回传 `kwh` 原值防被冲掉（`:224-240`）
- 联动：成功后 `generate_electricity({period, landlordId})` 重算（`:1240-1244`）

**表单 C · 整表抄表记录**（灰色块，`:1674-1752`）
- 保存：主 `save.mutate()` 中的 `saveMeterReading({...})`（`:1164-1185`），传 `kwh`（原始表码）、`actualKwh`（**必须回传 DB 原值**）、`prevActualReading`、`currActualReading`、`prevReadingDate`、`prevReading`、`currReadingDate`、`currReading`
- 接口同上；**`meter_monthly` 全字段 UPSERT**（`ON CONFLICT (address,month_period) DO UPDATE` 全字段覆盖）
- ⚠️ 界面「起始度数/抄表度数/区间度数」**与第三方共用字段，下次同步会被覆盖**；需长期留档的真实读数要填「上月/本月实际读数」（`prev/curr_actual_reading`，不随同步覆盖）（`:1682-1686`）
- 联动：主 save 成功后若 `hasReadingInput && (!isShared || !allocDirty)` → `generateElectricity({period, landlordId})`（`:1208-1214`）

**普通电表读数表单**：同 C 接口同写列，但不传共享表特殊回传；`actual_kwh = actualKwh`（`:1178`）。区间度数 = `currReading − prevReading`（`:974-981`）。

#### C. 天雀同步：覆盖与不覆盖（必背）

`sync_monthly_data` 对 `meter_monthly` 的 UPSERT（`jobs/sync_meters.py:426-437`）：

```sql
INSERT INTO meter_monthly (device_id, address, month_period, kwh, raw_data, synced_at,
    prev_reading, prev_reading_date, curr_reading, curr_reading_date) ...
ON CONFLICT (address, month_period) DO UPDATE SET
    device_id=EXCLUDED.device_id, kwh=EXCLUDED.kwh, raw_data=EXCLUDED.raw_data, synced_at=NOW(),
    prev_reading=EXCLUDED.prev_reading, prev_reading_date=EXCLUDED.prev_reading_date,
    curr_reading=EXCLUDED.curr_reading, curr_reading_date=EXCLUDED.curr_reading_date
```

| 分组 | 列 |
|---|---|
| ✅ 同步**会覆盖** | `device_id` `kwh`(原始表码) `raw_data` `synced_at` `prev_reading` `prev_reading_date` `curr_reading` `curr_reading_date` |
| ⛔ 同步**不覆盖** | `actual_kwh` `prev_actual_reading` `curr_actual_reading` ← **人工实际值受保护** |

其它表：`meter_daily/hourly/yearly` 全量覆盖 `device_id,kwh,raw_data,synced_at`；`meter_status_cache` 覆盖状态列；`meter_devices` 覆盖设备列。
**联动**：月同步 `total>0` 后自动 `generate_all_ledger()`（`:472-478`）。
**限流**：前端 localStorage 每天最多 10 次、24h 重置、2 秒防抖 + 5 秒冷却（`Meters.tsx:31-87,189-241`）。

#### 智慧电表页特殊口径与坑

1. **`POST /readings` 是双向覆盖坑**：`meter_monthly` **全字段 UPSERT**（`meter_energy.py:224-240`）。所以：
   - 只改抄表时间也必须回传 DB 里的 `actual_kwh` **原值**，否则"未人工补录"的月份会被固化成人工值（`Meters.tsx:1173-1177`）。
   - `kwh` 为空时后端写成 `0`（`:206-211`），故共享表保存必须回传 `existingRawKwh`（`:1165-1171`）。
2. **共享表识别**：`isShared = tag==='共享电表' && !brandId`（`:870`）。建档开关 `toggleShared` 会清空 `brandId`（`:695-704`）。
3. **柜数与整表计数互斥**：共享表一旦按品牌录过柜数（`managedByAlloc`），其下 `cabinets` 记录**不计入柜数**，且展开区不提供「添加柜子」（`:570-598`）。
4. **换主体重算范围三选一**：`all`（默认，全部历史搬到新主体）/ `current`（本月起）/ `period`（指定月起）。后端据此调 `auto_generate_for_meter(from_period=...)`（`meters.py:328-360`、`electricity.py:819-855`），并写 `meter_entity_changes` 审计（`meter_repo.py:209-219`）。
5. **自动生成触发点全清单**：电表增改（`meters.py:291-296,357-362`）、导入（`:221-227`）、品牌分摊保存（`meter_energy.py:498-504`）、月同步完成（`sync_meters.py:472-478`）、后端启动（`main.py:313-321`）、前端表单保存后（`Meters.tsx:711-715`）。
6. **`entityMismatchHint` 只提示不拦截**：电表运营主体 ≠ 品牌方合同主体（代收代付合法）仅 UI 提示（`:136-151`）。
7. **导入不写 `kwh`**：`POST /meters/import` 只写 `actual_kwh / prev_actual_reading / curr_actual_reading`（`meters.py:190-212`），不覆盖第三方原始 `kwh`。
8. **删除电表级联**：按依赖顺序删 `electricity_meter_details` → `meter_shared_allocations` → `cabinets` → 置空 `meter_devices.meter_id` → 删 `meter_monthly`（`meter_repo.py:227-247`）。
9. **柜子操作联动分红**：柜子增删改会触发 `refresh_dividend_records(landlord_id)`（`cabinets.py:9-18`）。
10. **手工新增电表读数不落 `electricity_records`**：需靠 `generate` 才生成台账。

---

### 5.12 异常预警（Alerts，`/alerts`）

**用途**：统一聚合两类风险 —— **电量异常**（按月同比 / 按日合并日均对比）+ **合同预警**（场地合同应付、品牌方合同应收的到期/逾期）。支持「标记已处理」。

**调用接口**：`getAlerts({granularity, days})`（`GET /api/alerts`，`alerts.py:65`）；`handleContractAlert(id)`（`POST /api/alerts/contracts/{id}/handle`）；`getAlertConfig` / `saveAlertConfig`（`GET/PUT /api/alerts/config`，由基础档案页使用）。

页签：`tab ∈ (elec 默认, contract)`（可从 `?tab=contract` 直达）；`granularity ∈ (monthly 默认, daily)`；`days` 仅 daily 可选 `[2,3,5,7]` 默认 3。

#### A. 电量异常页签

后端分派：`granularity==="daily"` → `_detect_elec_daily`（`alerts.py:152-234`）；否则 → `_detect_elec_yoy`（`:237-298`）。

| 界面显示项 | 前端位置 | 后端函数 | 计算式 | 源表.字段 |
|---|---|---|---|---|
| 阈值提示「阈值 ×1.5」 | `Alerts.tsx:159,164` | `_get_config` `:17-25` | `SELECT key,value FROM alert_configs`，`elec_yoy_ratio` 默认 1.5 | `alert_configs.value` |
| 统计卡·电量异常数量 | `:164` | `:218,283` | `ratio >= 阈值` 的电表数 | — |
| 统计卡·严重（≥3倍）/较高（≥2倍） | `:165-166` | 前端 | `a.ratio>=3` / `2<=ratio<3` | — |
| 口径说明·最近月份 period | `:170` | `:244-251,289` | `MAX(month_period) FROM meter_monthly WHERE kwh>0` ⚠️**可能是上月而非自然当月** | `meter_monthly.month_period` |
| 口径说明·去年同期 prevPeriod | `:170` | `:251-254,290` | 去年同月 `YYYY-1 + MM` | `meter_monthly.month_period` |
| 明细·场地方 | `:38,53` | `:190,259,285` | `LEFT JOIN landlords` | `landlords.name` |
| 明细·品牌 | `:39,54` | `:191,260,286` | `LEFT JOIN brands` | `brands.name` |
| 明细·电表号 / 名称 | `:40,56-57` | `:190,259,285-286` | 直取 | `meters.meter_no` / `meter_name` |
| 「本月度数」/「近N天日均」 | `:41,59-60` | `:192,261,291` | monthly：`cur.kwh`；daily：`AVG(kwh)` 近 N 天 | `meter_monthly.kwh` / `meter_daily.kwh` |
| 「去年同期」/「基准日均」 | `:42,62-63` | `:193,262,292` | monthly：去年同月 `kwh`；daily：前 7 天 `AVG(kwh)` | 同上 |
| 「上涨」百分比 | `:43,66` | `:229,294` | `(ratio − 1) × 100`，保留 1 位 | — |
| 「(N×)」倍率 | `:67` | `:194-195,263-264` | monthly：`cur.kwh ÷ prv.kwh`；daily：`rec.avg ÷ base.avg`；无基准→NULL **跳过** | — |
| 「严重度」徽章 | `:44,49-50,69-71` | 前端 | `ratio>=3` 严重；`>=2` 较高；否则关注 | — |

**日级 SQL 要点**（`:170-210`）：`days = max(1, min(days,14))`；`recent` = `(最新日−days, 最新日]` 的 `AVG(kwh)`；`baseline` = `(最新日−days−7, 最新日−days]` 的 `AVG(kwh)`；各按 `address` 聚合。过滤 `landlord_id IS NOT NULL AND brand_id IS NOT NULL AND meter_no NOT LIKE 'TEST%'`。

**月级 SQL 要点**（`:257-275`）：取 `MAX(month_period)` 为当期，`LEFT JOIN meter_monthly prv` 去年同月；`cur.kwh>0`；无去年同期 → ratio NULL → **跳过**。

#### B. 合同预警页签

后端 `_get_contract_alerts`（`alerts.py:301-444`）。

| 界面显示项 | 前端位置 | 计算式 | 源表.字段 |
|---|---|---|---|
| 统计卡·场地合同应付 / 品牌方合同应收 | `:184-185` | `contract_type='场地合同'`+`side=pay` / `='品牌方合同'`+`side=income` | `contracts.contract_type` |
| 其副标题「提前 N 天提醒」 | `:184-185` | `_get_config` → `contract_expire_days_venue`（默认 30）/ `contract_expire_days_brand`（默认 30） | `alert_configs.value` |
| 卡片·标题（场地方/合作方） | `ContractAlertCard.tsx:70` | `LEFT JOIN landlords`，否则 `contracts.partner` | `landlords.name` / `contracts.partner` |
| 卡片·品牌徽章 | `:73` | `LEFT JOIN brands` | `brands.name` |
| 卡片·状态徽章（已到期/临期N天） | `:59,78` | `effective_end = COALESCE(early_end_date, end_date)`；`days_left = effective_end − today`；`<0` 已到期，`<=expire_days` 临期 | `contracts.early_end_date` / `end_date` |
| 卡片·已处理/未处理徽章 | `:80-84` | `sig = f"{status}\|{endDate}\|{overdueCount}"`；`handled_sig == sig` → 已处理 | `contracts.alert_handled_sig` / `alert_handled_at` |
| 卡片·逾期 N 期 + 金额 | `:85-89` | 未完成且 `period_end < today` 的分期累加 | `rent_*_schedule.period_end/amount` |
| 卡片·付款方式 / 合同期 / 月租 | `:90-91,110` | 直取 | `contracts.pay_method/start_date/end_date/monthly_rent` |
| 卡片·总应付/总应收 | `:111` | 全部分期金额累加 | `rent_*_schedule.amount` |
| 卡片·已付/已收、未付/未收 | `:112-113` | `status ∈ ('已付款','已到账')` 分桶 | `rent_*_schedule.status` |
| 卡片·收付率 | `:114` | `paidAmount / totalAmount`（4 位小数） | 派生 |
| 卡片·联系人+电话 / 品牌联系人 | `:115-116` | 两个 LEFT JOIN | `landlords.contact/phone`、`brands.contact` |
| 卡片·公司主体分组名 | `:52` | 三级 COALESCE：场地合同主体 → 其他合同主体 → 电表主体 → 「未指定主体」 | `contracts.entity_id` / `meters.entity_id` → `entities.name` |
| 分期明细·期/区间/金额/状态/实付日期/发票/备注 | `:142-155` | 直取 | `rent_*_schedule.seq/period_start/period_end/amount/status/pay_date/invoice/remark` |

**提醒条件**（`:430`）：合同 `status ∈ ('已到期','临期')` **或** `overdueCount > 0`。

#### C. 预警配置存储

⚠️ **不是 JSON，是 key-value 行**：表 `alert_configs`（`key/value/remark/updated_at`），建表脚本 `backend/app/migrations/2026_08_alert_configs.sql`。

| 键 | 默认值 | 含义 |
|---|---|---|
| `elec_yoy_ratio` | `1.5` | 本月用电量 ÷ 去年同期 ≥ 该倍数时预警 |
| `contract_expire_days_venue` | `30` | 场地合同到期前多少天提醒 |
| `contract_expire_days_brand` | `30` | 品牌方合同到期前多少天提醒 |

读写：`_get_config`（`alerts.py:17-25`，缺行用代码兜底）；`update_alert_config`（`:40-62`，`INSERT ... ON CONFLICT (key) DO UPDATE`，只更新传入且非 None 的字段）。

#### 预警页特殊口径与坑

1. **电量异常只统计「已关联场地+品牌」的电表**：硬性要求 `landlord_id IS NOT NULL AND brand_id IS NOT NULL AND meter_no NOT LIKE 'TEST%'`；**无去年同期/无基准数据的电表直接跳过**，不算 0、不报警。
2. **月级「本月」实为最近一个有读数的月份**（`MAX(month_period) WHERE kwh>0`），可能是上月。
3. **日级是「近 N 天合并日均 vs 前 7 天日均」**：`days` 被夹在 1..14；基准期不含最近 N 天。单日波动被平滑，避免误报。
4. **「已处理」是签名机制**：签名 = `状态|到期日|逾期期数`。签名一致 → 不再提醒；一旦出现新逾期分期或状态变化 → 签名改变 → **自动回到"未处理"再次提醒**（`:102-137,431-435`）。
5. **数据隔离两层，作用范围不同**：`/api/alerts` 同时取 `scope_landlord_ids` 与 `scope_meter_tag`。电量异常在 **SQL 侧**按 `landlord_id` + 可选 `tag` 过滤；合同预警在 **Python 侧**按 `contracts.landlord_id ∈ allowed` 过滤 —— **电表 tag 范围不影响合同预警**（`:345`）。
6. **前端严重度分级硬编码** `ratio>=3`/`>=2`（`Alerts.tsx:49`），与后端阈值 `elecYoyRatio` 无耦合。
7. **排序**：合同预警按「已到期 → 临期（剩余天数升序）→ 逾期金额降序」；电量异常按 `ratio` 降序。
8. **`tab` 直达会清除 URL 参数**（`Alerts.tsx:88-93`），刷新回到默认「电量异常」页签。

---

### 5.13 基础档案（Directory，`/directory`）

**用途**：集中维护所有基础档案（CRUD + 搜索 + 导出），并含平台账号、第三方接口配置、预警设置。页面用 `<Tabs>`（`Directory.tsx:778-788`）分 **8 个 tab**：

| # | tab value | 标题 | 主接口 | 后端 |
|---|---|---|---|---|
| 1 | `brands` | 品牌方档案 | `/api/directory/brands` | `directory.py:11-45` |
| 2 | `entities` | 公司主体档案 | `/api/directory/entities` | `directory.py:50-112` |
| 3 | `landlords` | 场地方 / 业主档案 | `/api/directory/landlords` + `/owners` | `directory.py:117-183` |
| 4 | `shareholders` | 股东档案 | `/api/directory/shareholders` | `directory.py:188-218` |
| 5 | `introducers` | 介绍人档案 | `/api/directory/introducers` | `directory.py:223-248` |
| 6 | `users` | 平台使用人员 | `/api/directory/platform-users` | `directory.py:294-334` |
| 7 | `third-party` | 第三方接口配置 | `/api/directory/third-party-configs` + `/test` | `directory.py:339-397` |
| 8 | `alerts` | 预警设置 | `GET/PUT /api/alerts/config` | `alerts.py:28/40` |

#### A. 平台使用人员（tab `users`，`PlatformUsersTable` `Directory.tsx:172-399`）

| 界面显示项 | 前端位置 | 计算式 | 源表.字段 |
|---|---|---|---|
| 姓名 | `:359` | `SELECT pu.*, s.name shareholder_name FROM platform_users pu LEFT JOIN shareholders s` | `platform_users.name` |
| 角色 | `:365` | 映射 boss/finance/finance_supervisor/shareholder | `platform_users.role` |
| 关联股东 | `:367` `row.shareholderName` | LEFT JOIN | `shareholders.name` |
| 关联场地 | `:369-371` `row.landlordIds` | 数组直出 | `platform_users.landlord_ids` |
| 数据范围 | `:374-380` `row.meterTagScope` | 直出 | `platform_users.meter_tag_scope` |
| 电话 / 备注 | `:382-383` | 直出 | `platform_users.phone/remark` |
| 新增/编辑 | `:203-236` | `INSERT/UPDATE platform_users`；密码走 `hash_password` | `platform_users.*` |

**校验**：`meterTagScope` 合法性由 `_validated_meter_tag_scope` 校验（`directory.py:275-282`，取值须 ∈ `("合作商电表","民用电表","共享电表")`）；角色联动在前端 `toPayload`（`Directory.tsx:189-201`）—— 非股东清空 `landlordIds`，非财务角色清空 `meterTagScope`。响应剔除 `password`（`_sanitize_user` `directory.py:285-291`）。

#### B. 第三方接口配置（tab `third-party`）

| 界面显示项 | 前端位置 | 源表.字段 |
|---|---|---|
| 账户名称 | `:559` | `third_party_configs.name` |
| 接口地址 | `:560` | `third_party_configs.base_url` |
| 授权码 | `:561` | `third_party_configs.auth_code` |
| 电表类型 | `:563` | `third_party_configs.meter_tag` |
| 备注 | `:565` | `third_party_configs.remark` |
| 测试连接 | `:470-481` `doTest` | 用 `baseUrl+authCode` 实例化 `TQMeterClient` 调 `get_devices()`（`/Api/Meter`），统计设备数；**实时调用不落库**（`directory.py:376-397`） |

#### C. 数据隔离（档案页）

- `/brands`、`/entities` 按 `scope_meter_tag` 过滤（`directory.py:15-18,54-58`）→ 财务若限定电表类型，只看到拥有该类型电表的品牌/主体（`directory_repo.ids_with_tag_meters` `:4-18`）。
- `/landlords` 按 `scope_landlord_ids` 过滤（`:121-123`），股东只看关联场地。
- `/shareholders` 股东账号只看自己（`:192-195`）。

#### D. 删除保护

- 品牌被 `meters/contracts/rent_incomes` 引用时拒绝删除（`directory_repo.py:86-99`）。
- 主体被 `contracts/meters` 引用时拒绝删除（`:175-188`），并连带清理 `entity_brands`。
- 删除第三方配置会先把 `meter_devices.config_id` 置 `NULL`（`:734`），历史设备归入「默认账户」。

#### 档案页特殊口径与坑

1. **`entity-brands`（公司主体-品牌方关联）是半成品**：后端 `directory.py:253-270` + 前端 `src/api/directory.ts:34-39` 齐备，但 **`Directory.tsx` 未 import 或渲染**，页面无入口。属未接线功能，见 [8.3](#83-隐性依赖与半成品功能)。
2. **`update_platform_user` 用哨兵 `_UNSET`**（`directory_repo.py:605`）区分"不改"与"清空 `meter_tag_scope`"；前端传 `null` 才清空（`Directory.tsx:198`），易被误改。
3. **创建账号时密码留空 = 该账号无法登录**：`pwd = hash_password(password) if password else None`（`:614`）；但编辑时留空表示不修改（`Directory.tsx:194`）。
4. `/platform-users` 的 DELETE **无引用保护**，删除后 `landlord_ids` 关联随之失效。
5. `deleteBrand/deleteEntity` 的引用检查依赖表存在性，用 `try/except` 探测（`:89-97`），表缺失时静默跳过。

---

### 5.14 系统设置（Settings，`/settings`）

**用途**：配置两项第三方服务密钥 —— DeepSeek API Key（小程序 AI 对话）、腾讯地图 Key（地图组件/选点）。加载即 GET，保存即 PUT，**保存后立即生效，无需重启**。

| 界面显示项 | 前端位置 | 后端函数 | 存储 |
|---|---|---|---|
| DeepSeek API Key | `Settings.tsx:59` `config.deepseekApiKey` | `system_config.py:66` | PG 表 `system_configs.config_value`（`config_key='deepseek_api_key'`），空则回落 `config.py:DEFAULT_DEEPSEEK_API_KEY`（环境变量 `DEEPSEEK_API_KEY`） |
| 腾讯地图 Key | `Settings.tsx:76` `config.mapKey` | `system_config.py:67` | `system_configs`（`config_key='map_key'`），空则回落 `DEFAULT_MAP_KEY` |
| 保存 | `Settings.tsx:24` | `system_config.py:83-95` | `INSERT ... ON CONFLICT (config_key) DO UPDATE` |

**存储结论：PostgreSQL 表 `system_configs`，不是配置文件。**
- 表由 `ensure_table()` 幂等创建（`system_config.py:22-41`）：`config_key VARCHAR(64) PK / config_value TEXT / updated_at TIMESTAMP`。⚠️ 该表**不在 `database_init.sql` 里**，是运行时建的。
- 读取优先级：`system_configs` 有值 > `config.py` 默认值（空字符串也视作「未填」回落默认）。
- 写入语义：传 `None` 不改该项；传空串 = 清空并回落默认。
- `.env` / `config.py` **永远只是兜底默认**。

**坑**：
1. **Key 明文存库、明文回传**（`system_config.py:66-67` 直接返回），前端未脱敏（`Settings.tsx:59`）。任何 boss/finance 账号都能读到。
2. **小程序端另有只读接口 `GET /mp/config`**（`system_config.py:102-109`），同样返回两个 Key，仅需登录 —— **所有小程序用户均可见**。
3. 前端另有一份硬编码兜底 `FALLBACK_MAP_KEY`（`src/api/systemConfig.ts:21`），后端不可达时仍能加载地图。

---

### 5.15 登录（Login，`/login`）与认证链路

**完整链路**

```
Login.tsx submit()
  → useAuth().login(name, password)                (src/providers/auth.tsx:61-64)
      → POST /api/auth/login                        (src/api/auth.ts:15)
          → auth.py:37 login()
              SELECT platform_users + shareholders WHERE name=%s
              verify_password(明文, password)        (infra/password.py:13)
              token = create_token(id, name, role)
  → applyAuth(res.token, res.user)                  (auth.tsx:54-59)
      localStorage.setItem("dsh_token"/"dsh_user")
```

**Token 生成**（`backend/app/middleware/mp_auth.py:10-18` `create_token`）
- 载荷：`{"sub": str(user_id), "name", "role", "exp": utcnow()+7d}`
- 算法：**HS256**（`config.py:18`）；密钥 `JWT_SECRET`，默认 `"huandian-platform-secret-key-2026"`（`config.py:17`，可用环境变量覆盖）
- 有效期：**7 天**（`JWT_EXPIRE_DAYS=7`）
- 密码校验：SHA-256 **加盐**，存 `salt$hash`，`secrets.compare_digest` 防时序攻击（`infra/password.py:13-17`）⚠️ **非 bcrypt**

**中间件校验**（`backend/app/main.py:20-57` `AdminAuthMiddleware`）
- 命中：所有 `/api/*`；**放行** `/api/auth/*`、`/api/health`、`/api/scheduler/status`（`:29`）
- 要求 `Authorization: Bearer <token>`，否则 401
- 调 `verify_token` 后**回库查最新用户**（`:42`），因为角色/范围可能在签发后被管理员改动
- **股东只读**：`role='shareholder'` 且方法非 GET/HEAD/OPTIONS → 403（`:50-51`）
- 通过后挂 `request.state.current_user = dict(user)` —— 各接口做数据隔离的**唯一入口**

**`current_user` 的消费方**：`backend/app/infra/auth_scope.py`

| 函数 | 行 | 作用 |
|---|---|---|
| `METER_TAGS` | `:10` | 合法电表类型枚举 |
| `scope_meter_tag(request)` | `:13-25` | **仅** `finance`/`finance_supervisor` 生效，返回 `meter_tag_scope` |
| `scope_landlord_ids(request)` | `:61-77` | 股东 → `landlord_ids`；财务带 `meter_tag_scope` → 拥有该类型电表的场地集合（`_tag_landlord_ids` `:28-41`）；其余 `None`（不限制） |
| `ensure_meter_in_scope(...)` | `:44-58` | 读写电表时校验 `(tag, landlord_id)`；读 404、写 403 |

**坑**：
1. **JWT 密钥默认硬编码**（`config.py:17`）。生产若未设 `JWT_SECRET` 环境变量，任何人可伪造 token。
2. **密码为 SHA-256 加盐，非 bcrypt/argon2**，暴力破解成本偏低。
3. **股东只读由中间件全局拦截，但 `/mp/*` 无此保护**（小程序端股东账号同样可调用审批写接口，仅靠业务逻辑判断）。
4. **小程序登录 `/mp/auth/login` 无密码**（`mp_auth.py:10-39`，仅按 name 匹配），与后台登录是两套逻辑，存在同名账号安全边界差异。

---

### 5.16 死代码清单（别浪费时间）

依据 `src/App.tsx` 与 `src/components/Layout.tsx` 的 import / Route / NAV 引用核查：

| 文件 | 路由引用 | 菜单引用 | 判定 |
|---|---|---|---|
| `src/pages/Home.tsx` | ❌ | ❌ | **死代码** —— Vite 脚手架残留（内容只有 `useState count`） |
| `src/pages/DimensionBoard.tsx` | ❌ | ❌ | **死代码** —— 品牌/主体/场地三维看板，已被 Dashboard + Stations 取代 |
| `src/pages/StationMap.tsx` | ❌ | ❌ | **死代码** —— 地图页无入口。若手动挂载，注意 ① `station.code`/`region` 后端恒为空；② `statusFilter` 后端不接收，筛选实际无效 |
| `backend/app/repositories/station_repo.py` | — | — | **空占位模块**（只剩 docstring），v3 已删站点层 |

`App.tsx` 实际注册 15 个页面（含 Login）；`Layout.tsx:8-23` 的 NAV 与之一一对应。

---

## 第 6 章 · 核心计算引擎深挖

### 6.1 电费台账生成器（`POST /api/electricity/generate`）

后端实现：`backend/app/api/electricity.py:473-813`。入参 `{period, landlordId?}` —— ⚠️ **后端只读 `period`，实际是全量生成**（`landlordId` 仅前端声明，`:485-489`）。

**触发时机全清单**：智慧电表页保存读数/分摊、电表增改、电表 Excel 导入、天雀月同步完成、后端启动（+8s）、合同保存、柜子增删改。

#### 九步全链路

**第 1 步 · 取实表电表**（`:497-506`）
```sql
SELECT m.id, m.meter_no, m.landlord_id, m.brand_id, m.entity_id, m.transformer_ratio, b.name AS brand_name
FROM meters m LEFT JOIN brands b ON m.brand_id = b.id
WHERE m.landlord_id IS NOT NULL
  AND (m.brand_id IS NOT NULL OR m.tag = '共享电表')
  AND m.meter_no NOT LIKE 'TEST%'
```
→ 必须已挂场地方，且 **有品牌 或 是共享电表**。

**第 2 步 · 取该月读数**（`:508-517`）
`SELECT address, kwh, actual_kwh FROM meter_monthly WHERE month_period=%s AND address IN (电表号…)` → `readings[address] = {kwh, actual}`

**第 3 步 · 取相关合同**（`:519-543`）
`SELECT c.*, l.name AS landlord_name FROM contracts c LEFT JOIN landlords l ... WHERE c.landlord_id IN (场地集合)`，按 `landlord_id` 分组。

**第 4 步 · 分组键 = `(landlord_id, brand_id, entity_id)`**（`:545-561`）
- 普通电表：`groups[(m.landlord_id, m.brand_id, m.entity_id)]`
- 共享电表**该月有分摊**：按每条分摊行拆成 `groups[(m.landlord_id, a.brand_id, a.entity_id or m.entity_id)]`，**该表不再单独成组**（避免双算）
- 共享电表**该月无分摊**：按 `(lid, None, entity)` 成组

**第 5 步 · 单价匹配**（`backend/app/domain/electricity_pricing.py`）

`resolve_prices(contracts)`（`:19-86`）：
- **付款单价** `pay_price`：所有 `场地合同` 中按 `id` 升序取**第一个非空** `electricity_price`；多份不同价 → `pay_price_conflict=True`（**不因冲突跳过**）
- **收款单价**：
  - `brand_prices[brand_id]`：按品牌方合同匹配；品牌下多份（拆签）时 **未指定主体的合同优先**，否则 id 最小那份
  - `brand_price_options[brand_id]`：该品牌**全部**合同列表（含 `entity_id`），供按主体精确匹配
  - `shared_price`：`brand_id IS NULL` 的「全品牌合同」单价，**仅对共享电表（无品牌）生效**

`brand_price_for(pricing, brand_id, entity_id)`（`:89-107`）：品牌下先找 `entity_id` 完全相等的合同 → 其次未指定主体 → 再退第一份；`brand_id=None` → 返回 `shared_price`。

> **收款单价匹配优先级总结**：① 品牌方合同（按电表主体精确匹配 → 未指定主体 → id 最小）→ ② 共享表时用「全品牌合同」→ ③ 无任何合同 → 收款单价 None（**收入 = 0**）。

**第 6 步 · 逐组计算**

*入口守卫*（`:606-616`）：`has_alloc`（组内是否有分摊行）、`has_site_contract`、`has_brand_contract`。**三者全无 → 跳过不生成；若已有旧记录则删除该记录及其明细。**

*记录级税率/收款单价*（表头展示用）：
- `tax_rate` = `brand_prices` 第一个有值的税率 → 否则 `shared_price.tax_rate` → 再否则 `0.01`（`:618-620`）
- `record_collect_price` = `brand_price_for(pricing, bid, eid).price`；分摊组取第一条明细（`:622-624,716-718`）

*普通电表明细*（`:676-710`）
```
kwh         = meter_monthly.kwh
actual_kwh  = actual_kwh 非空 ? round(actual_kwh, 2) : round(kwh × transformer_ratio, 2)   ← COALESCE 口径
total_pay_kwh += actual_kwh ;  total_collect_kwh += actual_kwh
brand_info  = brand_id ? brand_price_for(pricing, brand_id, entity_id) : shared_price
brand_price = brand_info.price
detail_rate = brand_info.tax_enabled ? brand_info.tax_rate : None
pay_amount     = round(actual_kwh × pay_price, 2)      ← 无 pay_price 则 0
collect_amount = round(actual_kwh × brand_price, 2)    ← 无 brand_price 则 0
_, collect_net = split_tax(collect_amount, detail_rate)
```
明细写入 `{meterId, meterNo, brandId, brandName, kwh(=actual_kwh), payUnitPrice, payAmount, collectUnitPrice, collectAmount, collectNet}`（`:699-710`）

*共享电表品牌分摊特殊支路*（`:634-674`）—— **全系统最复杂的分支**
```
unit_price, brand_info = _alloc_unit_price(pricing, alloc, m.entity_id)
    # alloc.unit_price 人工覆盖优先，否则 brand_price_for(pricing, alloc.brand_id, entity_id/电表主体)
collect_amount = round(alloc.collect_amount, 2)          ← 人工录入的应收电费（含税）
if unit_price 为空 → 记 warning「缺单价，无法倒推」，continue 跳过该品牌
actual_kwh = round(collect_amount / unit_price, 2)        ← 电量按金额倒推

# 付场地方按「整表读数」结算，亏空按电量比例摊：
full_kwh      = _shared_full_kwh(readings, m)             # actual_kwh 优先，否则 kwh × transformer_ratio
alloc_kwh_sum = alloc_kwh_by_meter[meter_no]              # 逐表：Σ(各品牌 collect_amount / 单价)
scale         = full_kwh / alloc_kwh_sum                  # 任一方为 0 → scale = 1
pay_kwh       = round(actual_kwh × scale, 2)               ← ⭐ 摊线损后的付款电量
pay_amount    = round(pay_kwh × pay_price, 2)
_, collect_net = split_tax(collect_amount, detail_rate)
明细 source='shared_alloc'，kwh=pay_kwh，collectUnitPrice=unit_price，collectAmount=collect_amount
```
- `alloc_kwh_by_meter` 预计算 `:574-587`；`_shared_full_kwh` `:462-470`；`_alloc_unit_price` `:448-459`
- 若 `|full_kwh − alloc_kwh_sum| > max(1, full_kwh × 1%)` → 追加警告（`:656-660`）

*组小计与利润*（`:712-721`）
```
total_pay_amount     = Σ d.payAmount
total_collect_amount = Σ d.collectAmount
total_collect_net    = Σ d.collectNet
profit               = round(total_collect_net − total_pay_amount, 2)
```

**第 7 步 · 落库**
- **已有记录**（按 `(landlord,brand,entity)` 命中 `existing_map`，`:589-591`）：
  ```sql
  UPDATE electricity_records SET pay_kwh, pay_unit_price, pay_amount,
      collect_kwh, collect_unit_price, collect_amount, tax_rate, collect_net, profit,
      data_source='auto', updated_at=NOW()      -- ⚠️ 不含 pay_status / collect_status
  ```
  随后 `DELETE FROM electricity_meter_details WHERE electricity_id=…` 再逐条 INSERT（`:737-748`）
- **新记录**：`INSERT ... pay_status='未付款', collect_status='未到账', data_source='auto' RETURNING id`（`:752-762`），再插明细

`electricity_meter_details` 写入列（两处一致）：
`electricity_id, meter_id, start_reading(=NULL), end_reading(=NULL), kwh, pay_unit_price, pay_amount, collect_unit_price, collect_amount, collect_net`
> 自动生成路径 `start_reading` / `end_reading` **恒为 NULL**。

**第 8 步 · 清理残留**（`:777-791`）
```sql
SELECT id, landlord_id, brand_id, entity_id FROM electricity_records
WHERE period=%s AND COALESCE(data_source,'auto')='auto'
```
凡分组键不在当前 `groups` 中的 **auto 记录**删除（含明细）；`data_source='manual'` 记录**不动**。

**第 9 步 · 联动与返回**（`:793-810`）
`conn.commit()` → `refresh_dividend_records(lid, [period])`（失败忽略）→ 返回 `{created, updated, deleted, period, warnings, detail}`。

#### 什么情况会跳过 / 不生成

| 条件 | 结果 | 行 |
|---|---|---|
| 电表无 `landlord_id`，或既无 `brand_id` 又非共享电表 | 第 1 步就不取 | `:497-506` |
| `meter_no LIKE 'TEST%'` | 不取 | `:504` |
| 分组三者全无合同且无分摊 | **跳过并删除已有 auto 记录** | `:612-616` |
| 共享分摊行缺单价 | 该品牌分摊行跳过（记 warning） | `:640-645` |
| 无读数（kwh=0 / actual=0） | **仍生成**，金额为 0，不会跳过 | — |
| 该月 `meter_shared_allocations` 无任何行 | 共享表退回「整表读数 × 合同单价」整场地一行 | `:550-559` |

#### 生成器口径与坑

1. **`data_source` 语义**：generate 新建与更新均写 `'auto'`；`POST /api/electricity` 建记录由 repo 硬编码 `'manual'`（`electricity_repo.py:146`）；`PUT /api/electricity/{id}` 一律置 `'manual'`（`:375`）。残留清理**只删 auto**。
2. **⚠️ 人工改过的金额仍会被覆盖**：`existing_map` 只按 `(landlord,brand,entity,period)` 命中，**不区分 auto/manual**（`:590`）。只要该分组当月仍在生成范围内，人工金额会被重算覆盖、`data_source` 翻回 `'auto'`。**只有分组键消失（换品牌/换场地/共享互转）时 manual 记录才因不被清理而保留。**
3. **`pay_status` / `collect_status` 是唯一重算免疫字段**：UPDATE 不含这两列；新建时默认 `未付款`/`未到账`；`PUT /{id}/status` 只改状态、不动 `data_source`。
4. **共享电表付款只有一整笔**：付场地方 = 整表读数 × 场地单价；各品牌行 `pay_kwh` 已按 `scale` 摊入线损，**合计即整表那一笔**；**收款金额不参与分摊**。
5. **主体众数回退**：`POST /api/electricity` 未传 `entityId` 时取该「场地×品牌」下电表主体众数（`GROUP BY entity_id ORDER BY COUNT(*) DESC LIMIT 1`，`:258-262`）。
6. **`elecTax` 非独立列**，一律 `collectAmount − collectNet` 现算（`:1091`）。

---

### 6.2 分红计算引擎（`dividend_calc`）

权威入口：`backend/app/domain/dividend_calc.py:35` `DividendCalculator.calculate(landlord_id, brand_id, period, estimate=False, _cycle_sum_depth=0)`；全局单例 `dividend_calculator`（`:1259`）。

#### 6.2.1 记录维度与 type

- `dividend_records` 维度 = **`landlord_id × brand_id × period × type`**
  - `brand_id` 可空：空 = 整场地；非空 = 指定品牌
  - `period` 6 位 `YYYYMM`，**一条记录 = 一个月**（季度/半年/年分红也在"结算月"那一月生成一条）
  - ⚠️ **无唯一约束 / 无 upsert**：同键多次 POST 会插入多条重复记录
- `type` 只有两种：**`"股东分红"`（默认）** 与 **`"商务分红"`**（`dividends.py:165/181`、`dividend_refresh.py:45`）。type 只决定记录附带哪类明细，**不参与金额计算**。

#### 6.2.2 计算主流程（`dividend_calc.py:45-558`）

```
 1. 读场地      SELECT id, name, company_share FROM landlords WHERE id=%s          (:48)
 2. 取合同      contracts LEFT JOIN brands LEFT JOIN landlords WHERE landlord_id=%s (:58, :567-573)
 3. 取电量      total_kwh, meter_details = _get_meter_kwh(landlord_id, period, brand_id, contracts) (:61)
 4. 全品牌合同   has_shared_contract = 存在 contract_type='品牌方合同' AND brand_id IS NULL (:66-69)
 5. 整场地柜数   landlord_brand_cabs, landlord_total_cabs
                 = _get_landlord_cabinet_totals(landlord_id, include_shared=has_shared_contract, period) (:72)
 6. 遍历合同解析成本/收入单价（_covers_month 过滤）(:88-154)
      场地合同 → rent_cost += monthly_rent ; elec_pay_price = electricity_price   ⚠️后覆盖前
      品牌方合同 → brand_elec_map[(brand_id,entity_id)]、brand_rent_map[(brand_id,entity_id)]
                  rent_income 累加（首月用 first_month_rent，启用租金税用 post_tax_rent_price）
                  提前结束月 rent_refund_total += rent_refund
 7. 电费收入    elec_income = Σ _meter_income(d) ; _meter_income = split_tax(含税, 税率)[net] (:187)
 8. 电费成本    elec_cost = total_kwh × elec_pay_price        ← 付款口径 total_kwh（含共享表亏空） (:188)
 9. 税费        elec_tax (:191-208)、rent_tax (:211-225)
10. 运营费用    expense = rent_repo.get_expense_by_landlord(landlord_id, period)
                op_expense = expense["amount"]   ← 该场地该月全部（公共 + 主体专属）(:228-229)
11. 组装        income (:263-282)、cost (:286-324)
12. 品牌 P&L    brand_map (:327-447)
13. 主体 P&L    entity_map (:449-519)
14. 商务分红    _calc_business_dividends (:522)
15. 商务成本    biz_cost = Σ(商务分红中 countAsCost=true 的 amount)  → 回写 cost.bizDividendCost，
                重算 cost.totalCost (:525-530)
16. 净利润      profit = totalIncome − totalCost (:533)
17. 股东分红    _calc_shareholder_dividends (:536)
18. settlement_date (:539)，组装返回 (:541-558)
```

#### 6.2.3 分红基数三种 mode（股东与介绍人共用）

配置字段：`mode` / `ratio` / `fixed_amount` / `settlement_period` / `start_date` / `end_date` / `brand_id` / `entity_id`（介绍人另有 `count_as_cost`）。
前端 `ConfigDividendDialog` 把比例按「百分数 ÷ 100」写入 `ratio`（`Shareholders.tsx:125-126`）。

设 `base` = 配置命中的基数（收入或利润），`mult = _get_period_multiplier(settlement_period, period, estimate)`（`:1181`）：

| mode | 计算式（非结算月 / 预估） | 结算月落库时（`is_settle && !estimate && depth==0 && settlement_period != "月"`） |
|---|---|---|
| `收入分红` | `amount = round(base_income × ratio × mult, 2)` | `amount = round(周期内各月 base_income 之和 × ratio, 2)`（`_cycle_base` `:1143-1146` / `:1058-1065`） |
| `利润分红` | `amount = round(base_profit × ratio × mult, 2)` | `amount = round(周期内各月 base_profit 之和 × ratio, 2)`（`:1147-1153` / `:1066-1072`） |
| `固定金额` | `amount = round(fixed_amount × mult, 2)`（`base_amount=None`） | 同左（**不随周期累加**，只乘倍数） |
| 其它/空 | `amount = 0` | 同左 |

返回的 `baseAmount`：收入/利润模式 = 对应基数（结算月为周期累计值）；固定金额 = `null`。

**倍数规则 `_get_period_multiplier`**（`:1181-1209`）与 **结算月 `_is_settlement_month`**（`:1229-1244`）：

| `settlement_period` | `mult` | 结算月 |
|---|---|---|
| 月 | 1 | 每月 |
| 季度 | 3（月 ∈ {3,6,9,12}）否则 **0** | 3/6/9/12 月 |
| 半年 | 6（月 ∈ {6,12}）否则 **0** | 6/12 月 |
| 年 | 12（月 = 12）否则 **0** | 12 月 |
| `estimate=True` | **恒为 1** | 仍返回真实 `isSettlementMonth` |

> ⚠️ 非结算月 `mult=0` → 收入/利润分红金额即 **0 元**；`固定金额` 也同样为 0（因为乘 0）—— **固定金额只在结算月发放**。前端「未到结算月 累计中」文案即来源于此（`Shareholders.tsx:1219-1222`）。

#### 6.2.4 股东分红基数怎么定（`_calc_shareholder_dividends` `:1101`）

```
if brand_id 非空 且 brand_map[brand_id] 存在   → base = brand.income / brand.profit      （品牌 P&L）
elif brand_id 非空 但 brand_map 无该品牌        → base = 0 / 0    （本月无在期合同/电表，本期不参与）
elif brand_id 为空 且 entity_id 非空 且 entity_map 存在 → base = entity.income / entity.profit （主体 P&L）
else                                          → base = income.totalIncome / profit      （整场地）
```

- **整场地（`brand_id=NULL`）**：`income.totalIncome = elec_income + rent_income`（`:281`）；`profit = totalIncome − totalCost`（`:533`）
- **绑定品牌（`brand_id≠None`）**：基数取 `brand_map`（`:434-447`）
  - `brand.elecIncome = Σ split_tax(含税)`，含税 = 普通表 `度数 × 合同单价` + 共享表分摊 `alloc_amount`（`:400`）
  - `brand.rentIncome = Σ（首月 first_month_rent 或 monthly_rent，启用税则 post_tax）`（`:417-421`）
  - **场地成本按品牌柜数分摊**：`venueCost = rent_cost × brand_cabs ÷ landlord_total_brand_cabs`（`:427`；分母 `Σ landlord_brand_cabs` `:349`，为 0 则取 1）
  - **运营费同口径分摊**：`opExpense = op_expense × brand_cabs ÷ landlord_total_brand_cabs`（`:430`）
  - **电费成本按付款口径电量**：`elecCost = brand_pay_kwh × elec_pay_price`（`:429`）
  - `cost = venueCost + elecCost + opExpense`；`profit = income − cost`（`:433,446`）
- **绑定主体（`entity_id≠None` 且未绑品牌）**：基数取 `entity_map`（`:449-519`）
  - 电费收入/成本按该主体电表（`entity_kwh_map`、`entity_pay_kwh_map`，`:459-471`）；`elecCost = entity_pay_kwh × elec_pay_price`
  - `venueCost = rent_cost × entity_cabs ÷ entity_total`（`:504`）；`opExpense = op_expense × entity_cabs ÷ entity_total`（`:506`）
  - 租金收入：合同有 `entity_id` → 全归该主体；否则按 `_get_brand_entity_weights` 柜数权重拆分（`:474-500`，舍入尾差归最后一个主体）
- **品牌与主体同时配置时「品牌优先」**（`:1114`：`entity = ... if entity_id and ... and not brand_id`）

> ⚠️ `calculate(landlord_id, brand_id≠None, ...)` **顶层返回的 `income/cost/profit` 不是干净的品牌口径**（`rent_cost` / `op_expense` 仍是整场地全额）。品牌口径只存在于 `brandBreakdown`。分红计算走的是 `brandBreakdown`。

#### 6.2.5 介绍人（商务分红）与 `count_as_cost`

`_calc_business_dividends`（`:1017-1099`）与股东分支几乎同构，差异：
- 基数选择同 6.2.4，主体分支同样品牌优先（`:1029-1052`）
- **整场地利润基数不同**（`:1023-1025`）：
  ```
  商务：base_profit = total_income − (elecCost + rentCost + opExpense + elecTax + rentTax + rentRefund)
  股东：profit      = total_income − (elecCost + rentCost + opExpense + rentRefund + bizDividendCost)
  ```
  两者口径不一致（商务扣了 `elecTax/rentTax`，股东扣了 `bizDividendCost`）——见 [8.1](#81-口径不一致已知)。
- 返回项含 `countAsCost = cfg.count_as_cost`

**`count_as_cost` 的两种走法**（`:525-530`）：
```
biz_cost = Σ amount（仅 countAsCost=True 的商务分红）
cost.bizDividendCost = round(biz_cost, 2)
cost.totalCost = elecCost + rentCost + opExpense + rentRefund + biz_cost
profit = totalIncome − cost.totalCost        # 股东「整场地」基数因此被压低
```
- **`count_as_cost=True`（先扣再算股东分红）**：该商务分红计入总成本 → 拉低 `profit` → 股东「整场地/利润分红」基数随之减少，形成「先发商务、再分股东」的串联效应。**只影响整场地股东基数**；股东若绑品牌/主体，用各自 P&L，不含商务成本。
- **`count_as_cost=False`（单独算）**：`bizDividendCost` 不进 `totalCost`，股东基数不受影响；商务金额仅体现在 `summary.totalBusinessDividend`。

#### 6.2.6 结算周期如何在按月记录里体现

- 上游始终**逐月计算**，`period` 永远是单月 `YYYYMM`。
- **非结算月**：`mult=0` → 收入/利润/固定金额均为 0；但 `isSettlementMonth=false`、`periodStartMonth` 仍正确返回周期起点月（`:1211-1227`：季度→季首月，半年→1/7 月，年→1 月，月→当月）。
- **结算月**（落库、非预估、深度 0）：调 `_cycle_base`（`:994-1015`）对「周期起点月 → 当前月」逐月再调 `calculate(..., _cycle_sum_depth=1)`（防递归），把每月收入/利润累加，`amount = 周期累计基数 × ratio`，并返回 `cycleDetail[{period, income, profit}]` 供前端展示逐月构成。
- **`estimate=True`**：`mult=1`、**不做周期累加** → 单月预估 = 当月基数 × ratio。前端对区间求和得到「区间预估」（`Shareholders.tsx:843-877`），并标注"到结算月生成记录时按周期累计核算"。
- `_cycle_months`（`:977-992`）最多回溯 24 个月，防异常。

#### 6.2.7 电表电量与共享电表分摊（`_get_meter_kwh` `:579-755`）

- 电表筛选：`landlord_id=%s AND meter_no NOT LIKE 'TEST%'`；整场地时 `(brand_id IS NOT NULL OR tag='共享电表')`；指定品牌时 `(brand_id=%s OR (brand_id IS NULL AND tag='共享电表'))`（`:601-611`）
- 度数来源：`meter_monthly` 按 `address=电表号 AND month_period` 聚合 `SUM(kwh)`、`MAX(actual_kwh)`；优先 `actual_kwh`，否则 `kwh × transformer_ratio`（`:642-650,705-708`）
- **付款系数 `pay_scale`**（共享表）：用该表**全部**品牌分摊行倒推电量 `alloc_sum`，`pay_scale = 整表读数 ÷ alloc_sum`；各品牌付款电量 `pay_kwh = kwh × pay_scale`（`:655-686`）—— 即「品牌倒推合计与整表读数的差（亏空/线损）由各品牌按电量比例承担」
- **共享表已录分摊**：逐品牌拆明细，`alloc_amount` = 人工录入 `collect_amount`（含税应收），`kwh = alloc_amount ÷ unit_price`；`entity_id` 取分摊行指定主体，未指定退回共享表自身主体（`:671-702`）。指定品牌时只取该品牌分摊行。
- **未录分摊的共享表**：整表读数计入（收入按全品牌合同单价）。指定品牌时，未做分摊的共享表**不计入**该品牌（`:703-704`）

#### 6.2.8 成本项构成（逐项取数）

| 成本项 | 计算式 | 来源 | 说明 |
|---|---|---|---|
| `elecCost` | `total_kwh × elec_pay_price`（`:188`） | `meter_monthly`（付款口径，含共享表亏空分摊）+ 场地合同 `electricity_price` | **是电费成本**；按品牌/主体时改用 `pay_kwh × price`（`:429`/`:505`） |
| `rentCost` | `Σ 场地合同 monthly_rent`（`:88-93`） | `contracts`（场地合同，覆盖该月） | **场地合同月租合计**，多业主多份全部累加；整场地口径 |
| `opExpense` | `operating_expenses` 该场地该月合计（`:228-229`） | `operating_expenses`（公共 + 主体专属全加） | **不是电费**；品牌/主体 P&L 中按柜数占比分摊 |
| `bizDividendCost` | `Σ countAsCost 的商务分红 amount`（`:525-526`） | 本次计算明细 | 计入 `totalCost` |
| `rentRefund` | `Σ 品牌方合同 rent_refund`（提前结束月）（`:147-154`） | `contracts.rent_refund` + `early_end_date/end_date` | 以**正数加进 totalCost**（见 8.1） |
| `elecTax` / `rentTax` | 价内税拆分（`:190-225`） | 合同 `tax_enabled/post_tax_electricity_price/tax_rate`、`rent_tax_enabled/post_tax_rent_price/rent_tax_rate` | **独立展示，不进 totalCost/profit**（`:285` 注释），避免与已不含税的收入双扣 |

**品牌分摊口径（重点）**：`rentCost`（场地合同月租）与 `opExpense` 在品牌/主体 P&L 中都是「**按柜数占比分摊**」：
- 品牌：分母 `landlord_total_brand_cabs = Σ landlord_brand_cabs`（`:349`）
- 主体：分母 `entity_total = Σ entity_cabs`（`:454`）
- 柜数来源 `_get_landlord_cabinet_totals`（`:789-853`）与 `_get_entity_weights`（`:855-905`）：
  1. 有品牌电表：数 `cabinets` 记录数，每表 `GREATEST(1, COUNT)`（`:810-824`）
  2. 共享电表：取 `meter_shared_allocations.cabinet_count`（按月取值 `_pick_cabinet`：当月 → 该月前最近 → 全表最近），按品牌累加
  3. 兜底：完全没录柜数的共享表，`include_shared=True` 时按「整表至少 1 柜」计入 `brand_id=None` 组（`:834-848`）
- **签了合同但无电表的品牌 = 0 柜，不参与分摊**（`:383` 注释），保证各品牌分摊之和恒等于整场地成本

#### 6.2.9 生效期过滤与配置重叠

**合同生效期** `_covers_month`（`:9-29`）：`start ≤ 月末` 且 `(early_end_date or end_date) ≥ 月初`；无任一日期 = 长期有效。提前结束当月仍算覆盖（退款计入该月）。合同过滤按「月」判覆盖，**与配置过滤的"月首日"粒度不同**。

**配置生效期** `_filter_configs_by_period`（`:958-975`）：用 `period_date = f"{year}-{month:02d}-01"` 与 `start_date/end_date` 做字符串比较。
规则：`start_date > 月首日` 或 `end_date < 月首日` → 排除。⚠️ **从月中起生效的配置，当月即被排除**（如 `2026-06-15` 生效，6 月不参与，7 月才参与）。

**配置重叠**：唯一键是 `(landlord_id, 人员id, COALESCE(brand_id,0), COALESCE(entity_id,0), COALESCE(start_date,'1970-01-01'))`（`dividend_repo.py:49-56/143-150`）。同人同范围但**不同 `start_date`** 可并存；引擎对每条生效配置**独立计算、不校验互斥** —— 若两段生效期在同月重叠，会各算一次（**可能重复分红**）。

#### 6.2.10 `dividend_shares` 快照字段与"改配置是否影响历史"

`dividend_shares` 列（`dividend_repo.create_share` `:316-335`）：
`dividend_id, introducer_id, shareholder_id, brand_id, entity_id, mode, ratio, fixed_amount, amount, remark`

**写入时机**：
- **创建记录 `POST /dividends`**（`dividends.py:180-203`）：按 `type` 取 `calc["bizDividends"]` 或 `calc["shareholderDividends"]`，逐条写。此时快照的是**创建当刻**的配置与金额。
- **重算 `/dividends/refresh`**（`dividend_refresh.py`）：先 `delete_shares(record_id)` 再按当前 `calculate` 结果重建；同时用 `update_record` 覆盖 `elec_income/rent_income/total_income/elec_cost/rent_cost/op_expense/biz_dividend_cost/total_cost/profit`（`:33-43`）。

> ⚠️ 「改配置不影响历史」**只在"不触发重算"时成立**。记录落库当天把当时的 `mode/ratio/fixed_amount/amount` 固化进 shares，之后仅改配置而不重算，历史金额不变。**一旦调用 `/refresh`（业务约定"所有状态一律重算"，含已提交/已审批），shares 会按最新配置与最新上游数据整体删除重建** —— 所以快照**不是不可变审计凭证**，而是"最近一次计算结果的物化"。

#### 6.2.11 比例归一化

**没有归一化**。`_calc_shareholder_dividends` 对每条配置各算各的 `amount = base × ratio`，不做任何「比例之和是否 = 1 / 100%」的校验或强制归一（源码注释明示"各拿各的比例，互不影响" `:1102`）。**同一场上若多个股东 ratio 之和 > 100%，总分红可超过净利润，系统不拦截。**

#### 6.2.12 汇总接口与记录的关系

- `/summary/shareholder`（`dividends.py:277` → `dividend_repo.get_shareholder_summary` `:404-435`）**只读落库数据**：`dividend_shares ds JOIN dividend_records d`，条件 `ds.shareholder_id IS NOT NULL`，可选 `shareholder_id` / `period` / `period_start+period_end`（范围优先于单月）。金额来源 `ds.amount`；`已结算` vs `待结算` 由 `d.status='已结算'` 区分；`details` 携带 `period/landlord_id/landlord_name/type/status/settlement_date/brand_id/brand_name/mode/ratio/fixed_amount/amount`。
- 与「分红预估」（`/calculate`）**互不相干**：预估由配置实时重算、不落库；汇总只反映已生成记录。
- 股东账号鉴权：`role='shareholder'` 时强制 `shareholderId = current_user.shareholder_id`，并按 `scope_landlord_ids` 过滤（`dividends.py:280-286`）。
- `/summary/introducer`（`:312` → `:438-465`）同构，条件 `ds.introducer_id IS NOT NULL`。

#### 6.2.13 记录状态流转与删除约束

```
未结算/已驳回 --submit--> 申报中 --通过--> 已通过 --settle--> 已结算
                                  --驳回--> 已驳回
```
- `submit`：创建审批单（`bizType='分红审批'`，`amount = Σ shares.amount`，无明细回退 `profit`）→ 状态置 `申报中`
- `settle`：**仅允许** `已通过 → 已结算`（`dividends.py:256-258`），防止绕过审批放款
- `DELETE`：`申报中/已通过/已结算` 一律拒绝（`:268-269`）。`delete_record` 先删 shares 再删记录（`dividend_repo.py:391-401`）
- **不支持任意改状态**

---

### 6.3 天雀第三方同步与定时任务

#### 6.3.1 定时任务清单（`backend/app/jobs/scheduler.py`）

调度器 `AsyncIOScheduler`，启动于应用 `startup`（`main.py:293`）。

| 任务 id | 频率 | 函数 | 行 |
|---|---|---|---|
| `sync_devices` | 每 6 小时 | `sync_devices` | `:17` |
| `sync_collectors` | 每 6 小时 | `sync_collectors` | `:20` |
| `sync_status` | 每 2 小时 | `sync_status` | `:23` |
| `sync_hourly` | 每 2 小时 | `sync_hourly_data` | `:26` |
| `sync_daily` | 每天 02:00 | `sync_daily_data` | `:29` |
| **`sync_monthly`** | **每天 03:00** | `sync_monthly_data` | `:32` |
| `sync_yearly` | 每 10 天（注释"月限额10次"） | `sync_yearly_data` | `:35` |
| `sync_warnings` | 每 2 小时 | `sync_warnings` | `:38` |

**其它入口**：`GET /api/scheduler/status`（免鉴权，`scheduler.py:58-69`）；`POST /api/sync/trigger`（`type ∈ devices/collectors/status/hourly/daily/monthly/yearly/warnings/full`，`main.py:123-163`）。月度同步完成后自动 `generate_all_ledger()`（`sync_meters.py:472-478`）。

#### 6.3.2 各 `sync_*` 写入表与覆盖列（`backend/app/jobs/sync_meters.py`）

所有函数通过 `get_account_configs()`（`:11-24`）遍历 `third_party_configs`，每账户用各自 `base_url/auth_code` 实例化 `TQMeterClient`。

| 函数 | 写入表 | 覆盖列 / 冲突键 | 数据窗口 | 行 |
|---|---|---|---|---|
| `sync_devices` | `meter_devices` | `device_id, collector_id, address, description, rate, config_id, synced_at`；`ON CONFLICT (address)` | 全量 | `:71-113` |
| `sync_collectors` | `meter_collectors` | `id, collector_id, description, device_count, raw_data, synced_at`；`ON CONFLICT (id)` | 全量 | `:116-162` |
| `sync_status` | `meter_status_cache` | `device_id, address, c0..c4, remain_money, synced_at`；`ON CONFLICT (device_id)` | 实时 | `:167-211` |
| `sync_hourly_data` | `meter_hourly` | `device_id, address, hour_time, kwh, raw_data, synced_at`；`ON CONFLICT (address, hour_time)` | 近 24h | `:216-283` |
| `sync_daily_data` | `meter_daily` | `device_id, address, day_date, kwh, raw_data, synced_at`；`ON CONFLICT (address, day_date)` | 近 31 天 | `:286-353` |
| **`sync_monthly_data`** | **`meter_monthly`** | `device_id, address, month_period, kwh, raw_data, synced_at, prev_reading, prev_reading_date, curr_reading, curr_reading_date`；`ON CONFLICT (address, month_period)` ⛔**不含 `actual_kwh` 系列** | 近 12 个月 | `:356-479` |
| `sync_yearly_data` | `meter_yearly` | `device_id, address, year_period, kwh, raw_data, synced_at`；`ON CONFLICT (address, year_period)` | 近 12 年 | `:482-548` |
| `sync_warnings` | `meter_warnings_cache` | **先 `DELETE` 全表再插入**（`:562`） | 当前报警 | `:553-598` |
| `log_sync` | `sync_logs` | `sync_type, status, records_synced, error_message, started_at, completed_at` | 每次 | `:27-40` |

关键解析：`parse_kwh_data`（`:43-66`）把 `d[0]` → `total`，`s[0]`/`e[0]` → 起止读数；月同步另有 `parse_reading_fields`（`:363-382`）从 `s/e/st/et` 解析读数与日期。

组合入口：`sync_all_static`（`:603`）、`sync_all_energy`（`:611`）、`full_sync`（`:621`）。

#### 6.3.3 第三方接口清单（`backend/app/infra/meter_api.py`）

客户端 `TQMeterClient`（`:7-160`）：query 加 `auth=<auth_code>`，`httpx` 超时 30s、`verify=False`（`:20`）。响应解析 `_extract_data`（`:25-37`）：`status != 1` 抛 `ValueError`。全局实例 `tq_client`（`:164`），默认 URL `https://api1.tqdianbiao.com`。

| 方法 | 第三方路径 | 用途 |
|---|---|---|
| `get_devices` | `GET /Api/Meter` | 设备列表 |
| `get_collectors` | `GET /Api/Collector` | 采集器列表 |
| `get_status` | `GET /Api/EleMeterState` | 实时状态（总电量/尖峰平谷/剩余金额） |
| `get_electricity_by_hour` | `GET /Api/StatisticEle/hour` | 小时能耗 |
| `get_electricity_by_day` | `GET /Api/StatisticEle/day` | 日能耗 |
| `get_electricity_by_month` | `GET /Api/StatisticEle/month` | 月能耗 |
| `get_electricity_by_year` | `GET /Api/StatisticEle/year` | 年能耗 |
| `get_readings` | `GET /Api/DataRequest` | 历史抄表记录 |
| `get_recharge_records` | `GET /Api/Recharge` | 充值记录 |
| `get_warnings` | `GET /Api/Warning` | 报警信息 |
| `get_users` | `GET /Api/User` | 用户档案 |
| `get_prices` | `GET /Api/Price` | 价格档案 |

#### 6.3.4 「每月限 10 次」配额真相

**结论：系统只「统计并可查询」调用次数，没有任何硬性配额拦截或限流。**

1. 唯一相关实现是**只读状态查询** `GET /api/sync/monthly-kwh/status`（`main.py:166-186`）：
   ```sql
   SELECT COUNT(*) AS cnt FROM meter_monthly WHERE synced_at >= date_trunc('month', CURRENT_DATE)
   ```
   返回 `{callsThisMonth, limit: 10, remaining: max(0, 10−cnt)}` —— 这是**给上游第三方平台（天雀）月调用上限做展示**，不是本项目内的闸门。
2. `sync_monthly_data` **没有任何计数校验或提前返回**，无论本月调用几次都会照常请求第三方。
3. `scheduler.py:34-35` 注释「年用电量 - 每10天（月限额10次）」说明：**靠调度频率（每 10 天 ≈ 每月 3 次）间接控制在额度内**，属"用频率规避"而非代码强制。
4. 全后端检索未发现其它配额逻辑（`limit` 出现处均为 SQL 分页参数）。

> ⚠️ 若第三方对统计接口有 10 次/月上限，目前全靠调度频率与人工自觉；**`POST /api/sync/trigger` 无任何配额保护，误触发可能超额。**

---

### 6.4 共享电表机制（全系统最高复杂度）

#### 6.4.1 什么是共享电表

`meters.tag = '共享电表' AND meters.brand_id IS NULL` = **场地总表**（整个场地所有品牌共用一个电表）。当前共 5 块（龙泉路 108 / 大观 2 / 滇池 69×2 / 学府路 68）。

**为什么需要特殊机制**：普通模式是「某品牌电表 → 度数 × 该品牌单价 = 该品牌电费」。但共享表下各品牌**没有自己的电表**，无法用「用量 × 单价」算，只能：
- **收款**：人工按品牌录入**应付电费金额**，用电量 = 金额 ÷ 单价 **倒推**
- **付款**：按**整表读数**付场地方
- **差额（亏空/线损）**：按**电量比例**摊入各品牌付款额

#### 6.4.2 数据载体

`meter_shared_allocations`（唯一键 `(address, month_period, brand_id)`）：

| 列 | 含义 |
|---|---|
| `meter_id` / `address` | 哪块共享表 |
| `month_period` | 哪个月（6 位 YYYYMM） |
| `brand_id` | 哪个品牌 |
| `entity_id` | 报税主体（空 = 取共享表自身主体） |
| **`collect_amount`** | 品牌方付给我方的电费（**收款/收入，含税**） |
| `unit_price` | 倒推电量用单价（元/度）；空 = 取该品牌方合同单价 |
| **`cabinet_count`** | 该品牌当月在此表下投放的柜数（逐月可变，可为空） |
| `remark` | 备注 |

#### 6.4.3 两个核心公式

**① 付款分摊（线损/亏空摊入）**
```
full_kwh      = COALESCE(actual_kwh, kwh × transformer_ratio)        整表实际读数
alloc_kwh_sum = Σ_品牌 (collect_amount ÷ unit_price)                  各品牌倒推电量合计
scale         = full_kwh ÷ alloc_kwh_sum            （任一方为 0 → scale = 1）
品牌付款电量 pay_kwh = 品牌倒推电量 × scale
品牌付款额 pay_amount = pay_kwh × 场地合同单价
```
含义：品牌倒推合计与整表读数的差额（线上损耗 / 未计入用电）**由各品牌按电量比例分担**。
⚠️ 收款金额**永不缩放**（`collect_amount` 就是人工录入值），只缩付款。

**② 台账层级结果**
```
electricity_records 里：
  共享表该月「无分摊」→ 按 (场地, None, 主体) 出一行整表记录
  共享表该月「有分摊」→ 按每个品牌各出一行（brand_id = 品牌，明细 source='shared_alloc'）
                      整表那一行【不再出现】（避免双算）
因此台账里 pay_kwh ≠ collect_kwh 属【预期现象】（付款是整表口径、收款是品牌倒推口径）
```

#### 6.4.4 共享表改动排查清单（改这块先看这里）

**根因**：共享表 `brand_id IS NULL`，而「数电表 / 按品牌汇总」的 SQL 天然写成 `m.brand_id IS NOT NULL`，**会漏掉共享表**。看到 `m.brand_id IS NOT NULL` 就问一句「**共享表呢**」。

| 维度 | 必须检查的位置 |
|---|---|
| **柜数** | `contract_repo.list_contracts`、`dividend_calc`（`_get_landlord_cabinet_totals` / `_get_entity_weights` / `_get_brand_entity_weights` / `_shared_cab_brand_entity`）、`rent._live_cabs`、`overview.station_board`、`overview.monthly_detail` / `entity_monthly`（helper `_shared_cab_weights`）；前端 `src/lib/alloc.ts` + `Contracts.tsx` / `Entities.tsx` / `Brands.tsx` |
| **电费** | `electricity.py`、`dividend_calc(pay_kwh)`、`overview.station_board`、`landlord_station_monthly` |
| **不用改** | `mp_finance/mp_snapshot`、`rent` 柜数、`stations`、`alerts`。`DimensionBoard.tsx` 是死代码 |
| **成对条件** | SQL 端 `NOT EXISTS(... sa.cabinet_count IS NOT NULL)` 排除整表计数 **+** Python 端 `shared_meter_cabinets()` 叠加品牌柜数 —— **漏一半就双算** |

#### 6.4.5 共享表柜数的三级取值

`_pick_cabinet`（`shared_allocation_repo.py:168-181`）逐品牌取值次序：
```
① period 当月填写值
② 该月之前最近一次填写值（历史沿用）
③ 全表最近一次填写值（向后兜底）
```
前端预填同样逻辑：`latest_cabinet_counts(before_period)`（`:117-150`）。
完全没录过的共享表 → 按「整表至少 1 柜」归 `brand_id=None` 兜底。

#### 6.4.6 共享表相关的对外接口

| 接口 | 用途 |
|---|---|
| `GET /api/meter-energy/shared-allocations?meterNo&monthPeriod` | 品牌分摊表单数据（电表信息 + 候选品牌单价 + 已录分摊 + 各月列表 + 柜数默认值） |
| `POST /api/meter-energy/shared-allocations` | 保存某表某月分摊（**整体替换**，空数组=清空；成功后自动重算该月台账） |
| `GET /api/meter-energy/shared-cabinet-usage?landlordId&period` | 共享表柜数明细（`managedByAlloc` / `brandCabs` / `brandEntity` / `fallbackCabs`），合同页实时算计费柜数用 |

---

### 6.5 主数据流总链（复算任意数字的路线图）

```
meter_monthly.kwh / actual_kwh × transformer_ratio        （电表读数）
  └─(共享表：meter_shared_allocations.collect_amount ÷ unit_price 倒推，亏空按 pay_scale 摊)─┐
        ↓                                                                                   ↓
electricity_records.pay_amount / collect_net   ←── 台账（landlord × brand × entity × period）
        ↓
dividend_calc.calculate(landlord_id, brand_id, period)
  ├─ income.elecIncome.total = Σ split_tax(度数 × 合同单价 | alloc_amount)
  ├─ income.rentIncome.total = Σ (首月 first_month_rent | monthly_rent → 税后)
  ├─ cost.elecCost    = 付款口径 total_kwh × 场地合同单价
  ├─ cost.rentCost    = Σ 场地合同 monthly_rent
  ├─ cost.opExpense   = Σ operating_expenses(landlord, period)
  ├─ cost.elecTax / rentTax = split_tax（独立展示，不进利润）
  ├─ brand_map[b].profit  = 品牌收入 − (场地成本+运营费)×品牌柜数占比 − 品牌付款电费成本
  ├─ entity_map[e].profit = 主体收入 − (场地成本+运营费)×主体柜数占比 − 主体付款电费成本
  ├─ bizDividends[].amount         = 基数(收入|利润|固定×倍数) × ratio（countAsCost 决定是否进 totalCost）
  └─ shareholderDividends[].amount = 基数(收入|利润|固定×倍数) × ratio
        ↓
POST /dividends → dividend_records + dividend_shares（快照 mode/ratio/fixed_amount/amount）
        ↓（/refresh 按最新上游与配置删除重建）
GET /dividends/summary/shareholder → 聚合 dividend_shares.amount（已结算 / 待结算）
```

---

## 第 7 章 · 端到端溯源实例（照着走）

> 六个高频问题的完整追踪路径。每一条都可以照着 SQL / 接口复现。

### 实例 1：你在「经营总览」看到「净利润 128,450.00 元」，怎么追？

```
① 界面定位
   src/pages/Dashboard.tsx:59,212   ← 读到 data.netProfitTotal

② 接口
   GET /api/overview                （src/api/overview.ts:4）
   后端 backend/app/api/overview.py:48  overview()

③ 计算式（overview.py:429）
   netProfitTotal = elecProfit + rentIncomeTotal − rentCostTotal − rentTaxTotal − opExpenseTotal

④ 拆到五个源（全量累计，无月份过滤）
   elecProfit      ← :129/:422  Σ electricity_records.profit
   rentIncomeTotal ← :166-188   Σ contracts.monthly_rent WHERE contract_type='品牌方合同'
   rentCostTotal   ← :168-190   Σ contracts.monthly_rent WHERE contract_type='场地合同'
   rentTaxTotal    ← :179-202   Σ(monthly_rent − post_tax_rent_price) WHERE rent_tax_enabled
   opExpenseTotal  ← :204-209   Σ operating_expenses.amount

⑤ 继续向上追 electricity_records.profit
   ← 由台账生成器写（backend/app/api/electricity.py:473）
   ← profit = Σ collect_net − Σ pay_amount
   ← collect_net / pay_amount 由 meter_monthly 度数 × 合同单价 算出
   ← meter_monthly 由 天雀同步 / 智慧电表页人工录入

⑥ 复现 SQL
   SELECT SUM(profit), SUM(collect_net), SUM(pay_amount) FROM electricity_records;
   SELECT SUM(monthly_rent) FROM contracts WHERE contract_type='品牌方合同';
   SELECT SUM(monthly_rent) FROM contracts WHERE contract_type='场地合同';
   SELECT SUM(amount) FROM operating_expenses;
```

⚠️ 校验提示：若你在**某月明细卡**上看到的数字与这里不一致，是正常的 —— 明细卡走 `GET /api/overview/monthly-detail?period=` 按月份过滤，而这里是无过滤全量。

---

### 实例 2：「电费台账」某个场地展开后某块电表的「付款金额」怎么来的？

```
① 界面定位
   src/pages/Electricity.tsx:959-967  ← 读到 d.payAmount

② 接口
   GET /api/electricity/monthly-ledger?period=2026-08&dim=landlord
   （monthly_ledger 内部按 (landlord, brand, entity) 分组并发查询）
   后端 backend/app/api/electricity.py:918

③ 数据行是 electricity_meter_details 一行
   d.pay_amount ← electricity_meter_details.pay_amount
   d.pay_unit_price ← electricity_meter_details.pay_unit_price
   d.kwh ← electricity_meter_details.kwh

④ 这三个值在【台账生成时】一次算好（electricity.py:676-710）
   kwh(入库)      = COALESCE(meter_monthly.actual_kwh, meter_monthly.kwh × meters.transformer_ratio)
   pay_unit_price = 场地合同 contracts.electricity_price（resolve_prices 取 id 最小非空值）
   pay_amount     = round(kwh × pay_unit_price, 2)

⑤ 若是共享电表（tag='共享电表' 且 brand_id 为空）则走特殊支路（electricity.py:634-674）
   kwh(入库) = 品牌倒推电量 × scale
   scale     = 整表读数 ÷ Σ各品牌倒推电量        ← 摊线损
   pay_amount = round(kwh × pay_unit_price, 2)

⑥ 复现 SQL（普通电表）
   SELECT mm.address, mm.month_period, mm.kwh, mm.actual_kwh, m.transformer_ratio,
          c.electricity_price AS pay_price,
          COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio,1),2)) AS real_kwh
   FROM meter_monthly mm
   JOIN meters m ON m.meter_no = mm.address
   LEFT JOIN contracts c ON c.landlord_id = m.landlord_id AND c.contract_type = '场地合同'
   WHERE mm.address = '你的电表号' AND mm.month_period = '202608';
```

---

### 实例 3：「股东分红」某股东本月分红金额怎么来的？

```
① 界面定位
   src/pages/Shareholders.tsx:1217-1222  ← 读到受益人行的 amount

② 接口
   POST /api/dividends/calculate  {landlordId, brandId?, period, estimate?}
   后端 backend/app/domain/dividend_calc.py:35  DividendCalculator.calculate()

③ 分支判断（dividend_calc.py:1109-1129）
   brand_id 非空且 brand_map 有该品牌     → 基数 = brand_map[bid].income / .profit
   brand_id 非空但 brand_map 无该品牌     → 基数 = 0（本期不参与）
   brand_id 为空且 entity_id 非空有该主体 → 基数 = entity_map[eid].income / .profit
   其余                                  → 基数 = income.totalIncome / profit（整场地）

④ 按 mode 套公式（见 6.2.3）
   收入分红 → amount = round(base_income  × ratio × mult, 2)
   利润分红 → amount = round(base_profit  × ratio × mult, 2)
   固定金额 → amount = round(fixed_amount × mult, 2)

⑤ mult 由 settlement_period 决定（_get_period_multiplier :1181-1209）
   月=1 / 季度=3(仅3,6,9,12月)否则0 / 半年=6(仅6,12月)否则0 / 年=12(仅12月)否则0
   → 非结算月 mult=0 → 金额 0（界面显示「未到结算月 累计中」）

⑥ 结算月特殊处理（is_settle && !estimate && depth==0 && 周期≠月）
   _cycle_base (:994-1015) 把「周期起点月 → 当前月」逐月再算一遍并累加
   amount = 周期累计基数 × ratio
   同时返回 cycleDetail[{period, income, profit}] 供界面展示逐月构成

⑦ 落库（点「生成分红记录」时）
   POST /api/dividends  →  dividend_repo.create_record + create_share
   dividend_shares 快照 mode / ratio / fixed_amount / amount

⑧ 注意「本月预估」与「本月分红」是两套数
   预估 ← POST /calculate（estimate=true，mult 恒 1，不落库）
   分红 ← GET /dividends/summary/shareholder（只读 dividend_shares，落库值）
   月度记录未生成时 summary 为空
```

---

### 实例 4：「合同管理」列表里某品牌方合同的「计费柜数」怎么来的？

```
① 界面定位
   src/pages/Contracts.tsx:659  ← 读到 liveCabinetsCount ?? cabinetsCount

② 接口
   GET /api/contracts
   后端 backend/app/api/contracts.py:13 → contract_repo.list_contracts (contract_repo.py:28)

③ 主口径：live_cabinets_count（实时计算，contract_repo.py:50-67 + :154-175）
   live_cabinets_count =
       Σ_meters GREATEST(1, (SELECT COUNT(*) FROM cabinets WHERE meter_id = m.id))
     + 共享电表按品牌录入柜数（meter_shared_allocations.cabinet_count，取当月→之前最近→全表最近）
   匹配条件：meters.landlord_id = 合同.landlord_id
             AND meters.brand_id = 合同.brand_id
             AND meters.meter_no NOT LIKE 'TEST%'
   全品牌合同（brand_id IS NULL）→ 匹配共享电表；共享表已按品牌录柜数时【不再整表计】避免双算

④ 兜底：contracts.cabinets_count（已 DEPRECATED，仅当实时值为空时展示）

⑤ 复现 SQL（某场地某品牌）
   SELECT SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id)))
   FROM meters m
   WHERE m.landlord_id = 1 AND m.brand_id = 2 AND m.meter_no NOT LIKE 'TEST%';
   -- 共享表部分
   SELECT * FROM meter_shared_allocations
   WHERE address IN (SELECT meter_no FROM meters WHERE landlord_id=1 AND tag='共享电表' AND brand_id IS NULL)
     AND brand_id = 2 AND month_period <= '202608'
   ORDER BY month_period DESC LIMIT 1;
```

---

### 实例 5：「异常预警」某电表「上涨 250%」怎么算出来的？

```
① 界面定位
   src/pages/Alerts.tsx:43,66  ← 读到 a.growthPct（= (ratio − 1) × 100）
                                a.ratio 见 :67

② 接口
   GET /api/alerts?granularity=monthly&days=3
   后端 backend/app/api/alerts.py:65 get_alerts → _detect_elec_yoy (:237-298)

③ 当期与基期确定（:244-254）
   当期 period     = MAX(month_period) FROM meter_monthly WHERE kwh > 0
                     ⚠️ 可能是上月，不一定是自然当月
   基期 prevPeriod = 去年同月（YYYY-1 + MM）

④ 倍数计算（:194-195）
   ratio = cur.kwh ÷ prv.kwh
   ⚠️ 无去年同期数据 → 该电表【直接跳过】，不算 0、不报警（:272-274 continue）

⑤ 阈值过滤（:218）
   ratio >= 阈值（alert_configs 里 elec_yoy_ratio，默认 1.5）才进入列表

⑥ 增长百分比（:229）
   growthPct = round((ratio − 1) × 100, 1)

⑦ 严重度（前端硬编码 Alerts.tsx:49）
   ratio >= 3 → 严重 ; ratio >= 2 → 较高 ; 否则 关注

⑧ 复现 SQL
   SELECT cur.address, cur.kwh AS cur_kwh, prv.kwh AS prv_kwh,
          ROUND(cur.kwh / NULLIF(prv.kwh,0), 2) AS ratio
   FROM meter_monthly cur
   JOIN meters m ON m.meter_no = cur.address
   LEFT JOIN meter_monthly prv
          ON prv.address = cur.address
         AND prv.month_period = (LEFT(cur.month_period,4)::int - 1)::text || RIGHT(cur.month_period,2)
   WHERE cur.month_period = (SELECT MAX(month_period) FROM meter_monthly WHERE kwh > 0)
     AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
     AND m.meter_no NOT LIKE 'TEST%' AND cur.kwh > 0
   ORDER BY ratio DESC;
```

**补充 · 「已处理」为什么又变回「未处理」？**
签名 `sig = f"{状态}|{到期日}|{逾期期数}"`（`alerts.py:433`）。点「标记已处理」把 sig 写进 `contracts.alert_handled_sig`。一旦出现新逾期分期或状态由临期变已到期 → sig 变化 → 与新 sig 不匹配 → **自动回到"未处理"再次提醒**（`:102-137,431-435`）。这是设计行为，不是 bug。

---

### 实例 6：「场租台账」整年表里「场地租金收入(含税)/年」为什么跟月表加起来不一样？

```
① 界面定位
   src/pages/Rent.tsx:207  venueRentGross

② 它的计算式（前端，Rent.tsx:155-158）
   unitAnnual   = contracts.unit_monthly_rent × 12
   venueRentGross = unitAnnual × cabinets     ← cabinets 是【实时柜数】

③ 实时柜数来源（rent.py:277 liveCabinetsCount）
   _live_cabs(landlord, brand, period)
     = Σ_meters GREATEST(1, COUNT(cabinets))        ← 实时统计
     + 共享表 meter_shared_allocations.cabinet_count

④ 对比：月台账的「场地费收入」（rent.py:242）
   = Σ contracts.monthly_rent                       ← 直取落库值

⑤ 为什么两者会不同
   落库的 monthly_rent 是【合同保存那一刻】按当时的柜数算出来的快照
   （Contracts.tsx:980-989：monthlyRent = unit_monthly_rent × cabinets_count）
   而整年表用【当前实时柜数】重算
   ⇒ 柜数变化后两者必然不一致，这是设计差异不是 bug

⑥ 复现
   SELECT unit_monthly_rent, monthly_rent FROM contracts WHERE id = 你的合同id;
   -- 再查实时柜数，对比 unit_monthly_rent × 实时柜数 是否等于 monthly_rent
```

---

## 第 8 章 · 已知陷阱与数据质量清单

### 8.1 口径不一致（已知）

| # | 现象 | 位置 | 影响 |
|---|---|---|---|
| 1 | **场地成本口径**：`rent_cost` 在顶层返回是整场地全额，但在品牌/主体 P&L 里是按柜数分摊后的值 | `dividend_calc.py:188` vs `:427/:504` | 直接读顶层 `calculate(brand_id≠None)` 的 `cost.rentCost` 会**高估**品牌成本。品牌口径必须读 `brandBreakdown` |
| 2 | **退款方向相反**：`totalCost` 里 `rentRefund` 是**加项**（`:294`）；主体 P&L 的租金收入是 `rent_income_for_period − rent_refund_for_period`（`:477`） | `dividend_calc.py:294` vs `:477` | 两处对退款方向处理相反，可能导致同月口径不闭合 |
| 3 | **商务 vs 股东 利润基数公式不同**：商务扣了 `elecTax + rentTax`，股东扣了 `bizDividendCost`，且都没同时扣两样 | `dividend_calc.py:1023-1025` vs `:533` | 收入本身已是不含税、`totalCost` 又声明"税费不参与"，商务口径疑似**双扣税** |
| 4 | **电费单价取值不一致**：`dividend_calc` 取**循环中最后一个覆盖值**（`:91-95`）；`electricity_pricing.resolve_prices` 取 **`id` 最小的非空值**并标记 `pay_price_conflict` | 两处 | 多份场地合同且单价不同时，**分红与台账的付款单价可能不同** |
| 5 | **合同预警有两套口径**：经营总览用 `/api/alerts` 的 `_get_contract_alerts`（配置化窗口 + 含逾期分期）；`station_board` 内另有一套**固定 90 天**的简化统计 | `overview.py:231-238` vs `:994-1001` | 首页「临期合同数」与场地数据页「临期」可能不等 |
| 6 | **`monthly-ledger` 三维度取数不一致**：`landlord`/`brand` 维度 kwh 用**明细** `SUM(d.kwh)`；`entity` 维度用**记录级** `SUM(e.pay_kwh)` | `electricity.py:985` vs `:943/:1033` | 同一月度、切维度看电量会不同 |
| 7 | **`brand` 维度不返回 `payStatus`** | `electricity.py:1082-1093` | 品牌维度行的付款状态显示为默认「未付款」 |
| 8 | **Config 生效期粒度是"月首日"**，合同生效期粒度是"整月覆盖" | `dividend_calc.py:958-975` vs `:9-29` | 月中生效的配置**当月不参与**（下月才生效） |
| 9 | **`landlords.contact` 与 `landlord_owners` 双向同步**：改 contact 会改写最新业主名，改业主会回写 contact | `directory_repo.py:233-243,380-389` | 两个入口改的是同一份数据，审计时注意 |

### 8.2 ⚠️ 时序 / 覆盖风险（最容易造成"数字被改掉"）

| # | 风险 | 细节 | 规避 |
|---|---|---|---|
| 1 | **人工改的台账金额会被重算覆盖** | `existing_map` 按 `(landlord,brand,entity,period)` 命中时**不区分 auto/manual**（`electricity.py:590`），金额被重算覆盖、`data_source` 翻回 `'auto'`。只有分组键**消失**时 manual 记录才保留 | 需要人工干预的月份，改完**不要**再触发 generate；或改用 `data_source='manual'` 且确保分组键会变化 |
| 2 | **`pay_status`/`collect_status` 是唯一免疫字段** | 台账 UPDATE 不含这两列，手工改的状态在重算后保留 | 放心改状态 |
| 3 | **`POST /meter-energy/readings` 是全字段 UPSERT** | `meter_monthly` 的 `kwh`/`actual_kwh`/`prev_actual_reading`/`curr_actual_reading`/读数/日期**全被覆盖** | 只改一个值也必须回传其它值的 DB 原值；共享表必须回传 `existingRawKwh`，否则 `kwh` 被写成 0 |
| 4 | **「起止度数」下次同步会回退** | 天雀同步覆盖 `prev_reading`/`curr_reading`/日期（`sync_meters.py:426-437`） | 长期留档填「上月/本月**实际**读数」（`prev/curr_actual_reading`，同步不覆盖） |
| 5 | **`/refresh` 会重建 `dividend_shares`** | 业务约定"所有状态一律重算"，含**已提交/已审批**记录（`dividend_refresh.py:3-5`） | 快照**不是不可变审计凭证**；要留证据需另存 |
| 6 | **分红记录无唯一约束** | 同 `(landlord,brand,period,type)` 多次 POST 会插多条重复记录 | 生成前先查是否已有记录 |
| 7 | **启动自动动作** | `main.py:289-321`：① `init_database()` + `sync_schema()` → ② +2s `initial_sync()`（拉天雀，月度用量每自然月限 10 次）→ ③ +8s `initial_generate()`（**重算全部台账**） | **`--reload` + app volume ⇒ 每改一次 `app/*.py` 就重跑这三件事**。调试时一次性改完；临时脚本别放 `backend/app/` |
| 8 | **配置生效期重叠会双算** | 同人同范围不同 `start_date` 可并存，引擎对每条独立计算、不校验互斥（`dividend_calc.py`） | 建配置前确认生效期不重叠，否则重复分红 |
| 9 | **比例不归一** | 多个股东 ratio 之和可 > 100%，总分红可超净利润，系统不拦截（`:1102`） | 人工校验 |
| 10 | **`meter_monthly` 用字符串关联 `meters`** | `meter_monthly.address = meters.meter_no`，**无外键** | 改电表号会产生读数孤儿行 |

### 8.3 隐性依赖与半成品功能

| # | 项目 | 说明 | 风险 |
|---|---|---|---|
| 1 | **`landlords.company_share` 列无 DDL** | 被 `dividend_calc.py:48`（`SELECT id, name, company_share FROM landlords`）与 `electricity.py:1138`（导出）直接 SELECT；但 `database_init.sql` / `schema_sync.sql` / `migrations/` **都没有创建这一列**（`database_init.sql:130` 里只以注释形式存在于**已废弃的 stations 表**）。它是从旧 `stations.company_share` 遗留下的存量列 | ⚠️ **全新安装的库会直接报错**：`dividend_calc` 全流程不可用、电费导出的"公司占股/公司净利润"两列报错。必须在 `schema_sync.sql` 补 `ALTER TABLE landlords ADD COLUMN IF NOT EXISTS company_share NUMERIC(5,4);` |
| 2 | **`alert_configs` 表不在启动脚本里** | 建表脚本 `backend/app/migrations/2026_08_alert_configs.sql`，**不由 `init_database()` / `sync_schema()` 执行** | 全新安装无此表 → `/api/alerts` 与经营总览合同统计报错（`_get_config` 只有值兜底、没有建表兜底） |
| 3 | **`system_configs` 表运行时建** | 由 `system_config.py:22-41` `ensure_table()` 幂等创建 | 无风险，但要知道它不在 DDL 里 |
| 4 | **`entity-brands` 是半成品** | 后端 `directory.py:253-270` + 前端 `src/api/directory.ts:34-39` 齐备，但 `Directory.tsx` 未 import / 渲染，**页面无入口** | 隐功能，勿误以为已接线 |
| 5 | **审批「转办 / 加签」未实现** | 前端 `ActDialog` 支持（`Approvals.tsx:21,44-49`）；后端 `act_on_request` 只处理 `通过/驳回/催办`，转办/加签仅写一条 `approval_records`，**不改状态、不推进节点** | 误用会造成"操作了但没生效" |
| 6 | **`stations` 页面场景：`collectStartDate/collectEndDate` 恒空** | `stations.py:324-325` 未从台账回填 | 界面区间永远显示 `-` |
| 7 | **`StationMap` 的 `statusFilter` 无效** | 前端把状态传进 queryKey（`StationMap.tsx:17`），后端 `get_landlord_locations` **不接收任何参数** | 且该页本身是死代码 |
| 8 | **场地坐标无法通过常规 PUT 写入** | `directory.py:128-134` 的 `create_landlord` 只透传 `name/contact/phone/remark`；`update_landlord` 直接 `**data`（字段名须与 repo 形参一致），`latitude/longitude/region/address` **无法通过 API 可靠写入** | 地图/坐标链路存在断点 |
| 9 | **`/mp/*` 小程序端无数据隔离、股东无只读限制** | 独立 FastAPI 子应用，不经 `AdminAuthMiddleware`；`mp_approvals` 的写接口对股东账号同样可调用 | 安全边界差异 |
| 10 | **`/mp/auth/login` 无密码** | 仅按 name 匹配（`mp_auth.py:10-39`） | 与后台登录是两套逻辑 |

### 8.4 命名误导清单

| 你看到的 | 实际是什么 |
|---|---|
| 页面 `Stations` / 菜单「场地数据」 / 路由 `/stations` / 接口 `/api/stations/*` | 全部指**场地方（landlords）**，v3 已无站点概念 |
| `stationCount` / `activeStations` / `stationBreakdown` | 「场地 × 品牌组合数」/ 品牌拆分 |
| `stations.ts` 里的 `getLandlordMeterView` | 场地维度电表视图 |
| `contracts.cabinets_count` | **已退役**，只作展示兜底；真值是 `live_cabinets_count`（实时统计） |
| `contracts.partner` | **DEPRECATED 无用列**（无代码写入），收尾删除 |
| `contracts.pay_status` | **DEPRECATED**：业务读分期推导值 |
| `DimensionBoard.tsx` / `Home.tsx` / `StationMap.tsx` | **死代码**，无路由无菜单 |
| `station_repo.py` | 空占位模块 |
| `mp_*` 接口里的 `stations` / `stationCount` 键名 | 为兼容小程序前端保留，真实口径已是「场地×品牌」 |
| `rent.py` 的 `liveCabinetsCount` vs `cabinetsCount` | 前者实时统计（主口径），后者落库快照（兜底） |

### 8.5 性能 / 规模提示

| 位置 | 问题 |
|---|---|
| `src/pages/Stations.tsx:1160-1162` | 导出 Excel 会为**每个场地**并发调一次 `getLandlordMeterView`，请求量 = 场地数 |
| `src/pages/Electricity.tsx` / `Rent.tsx` | 区间明细按**逐月并发**调用（最多 36 个月 → 36 个请求） |
| `overview.py` 的 `overview()` | 单次请求内串行执行 ~20 条聚合 SQL，无缓存 |
| `dividend_calc._cycle_base` | 结算月会对周期内每个月的合同/电表/柜数**重新完整计算一遍**（`_cycle_sum_depth=1` 防递归），季度=3 次、年=12 次 |
| `_cycle_months` | 最多回溯 24 个月（`dividend_calc.py:977-992`） |
| `Stations.tsx:1425` | `ExpandedDetail` 的 summary 由父组件手工组装，字段名依赖后端返回，**改字段名前端静默变 0** |

---

## 第 9 章 · 附录

### 9.1 后端接口全清单（按文件）

| 文件 | 前缀 | 接口 |
|---|---|---|
| `api/auth.py` | `/api/auth` | `POST /login`、`GET /me`、`POST /bootstrap` |
| `api/directory.py` | `/api/directory` | brands / entities / landlords / landlords/{id}/owners / shareholders / introducers / entity-brands / platform-users / third-party-configs（各 CRUD）+ `POST /third-party-configs/test` |
| `api/stations.py` | `/api/stations` | `GET /landlord-locations`、`GET /landlord/{id}/meter-view` |
| `api/meters.py` | `/api/meters` | `POST /import`、`GET ""`、`GET /{id}`、`POST`、`PUT /{id}`、`DELETE /{id}` |
| `api/cabinets.py` | `/api/cabinets` | `GET`、`POST`、`PUT /{id}`、`DELETE /{id}` |
| `api/meter_energy.py` | `/api/meter-energy` | `GET /daily`、`/hourly`、`/monthly`、`POST /readings`、`GET /shared-allocations`、`GET /shared-cabinet-usage`、`POST /shared-allocations`、`GET /sync-logs`、`POST /sync` |
| `api/electricity.py` | `/api/electricity` | `GET ""`、`GET /periods`、`PUT /{id}/status`、`GET /reading-detail`、`GET /{id}`、`POST`、`PUT /{id}`、`DELETE /{id}`、`POST /generate`、`GET /monthly-ledger`、`GET /export` |
| `api/rent.py` | `/api/rent` | `GET/POST /expenses`、`DELETE /expenses/{id}`、`GET /excel-data`（废弃）、`GET /monthly-ledger`、`GET /yearly-payment-schedule` |
| `api/contracts.py` | `/api/contracts` | `GET`、`POST`、`POST /import`、`PUT /{id}`、`DELETE /{id}`、`GET /{id}/audit` |
| `api/contract_schedules.py` | `/api/contract-schedules` | `POST`、`GET /payment`、`GET /income`、`PUT /{id}`、`DELETE /{id}` |
| `api/dividends.py` | `/api/dividends` | `GET/POST/DELETE /configs/shareholder`、`GET/POST/DELETE /configs/introducer`、`POST /calculate`、`POST /refresh`、`GET`、`GET /{id}`、`POST`、`POST /{id}/submit`、`POST /{id}/settle`、`DELETE /{id}`、`GET /summary/shareholder`、`GET /summary/introducer` |
| `api/approvals.py` | `/api/approvals` | `GET/POST /flows`、`GET`、`GET /{id}`、`POST`、`POST /{id}/act`、`GET /stats/overview`、`GET /by-dividend/{dividend_id}` |
| `api/overview.py` | `/api/overview` | `GET ""`、`/monthly-detail`、`/station-board`、`/landlord-trends`、`/landlord-station-monthly`、`/shareholder-board`、`/entity-monthly` |
| `api/alerts.py` | `/api/alerts` | `GET/PUT /config`、`GET ""`、`POST /contracts/{id}/handle` |
| `api/system_config.py` | `/api/system-config` | `GET`、`PUT`；小程序版 `GET /mp/config` |
| `main.py` | — | `GET /api/health`、`GET /api/scheduler/status`、`POST /api/sync/trigger`、`GET /api/sync/monthly-kwh/status`、`GET /api/meter-monthly`、`POST /api/meters/import-from-third-party` |

**小程序端 `/mp/*`**（独立子应用，`main.py:96-110`）

| 接口 | 用途 | 主要表 |
|---|---|---|
| `POST /mp/auth/login` / `logout` / `GET /me` | 小程序认证（**无密码**） | `platform_users` |
| `GET /mp/snapshot` | 首页/地图/站点/利润/审批共用快照 | `meters` `meter_monthly` `electricity_records` `contracts` `landlords` `brands` `entities` `cabinets` `rent_income_schedule` `approval_*` |
| `GET /mp/finance/stations` / `brands` / `entities` / `landlords` / `shareholders` | 各维度财务 | 同上 |
| `GET/POST /mp/approvals`、`POST /{id}/approve|reject|transfer` | 审批列表/建单/通过/驳回/转办 | `approval_*` |
| `POST /mp/ai/chat` | DeepSeek 经营助手（历史截断 10 条） | 外部 DeepSeek API |
| `GET /mp/config` | 读系统配置（mapKey / deepseekApiKey） | `system_configs` |

### 9.2 数据库对象清单

**表（32）**：
`brands` `entities` `landlords` `landlord_owners` `shareholders` `introducers` `entity_brands` `platform_users`
`meters` `cabinets` `meter_entity_changes`
`third_party_configs` `meter_devices` `meter_collectors` `meter_status_cache` `meter_monthly` `meter_shared_allocations` `meter_daily` `meter_hourly` `meter_yearly` `meter_warnings_cache` `sync_logs`
`contracts` `contract_audit_log` `rent_payment_schedule` `rent_income_schedule`
`electricity_records` `electricity_meter_details` `operating_expenses` `dividend_records` `dividend_shares`
`landlord_shareholder_configs` `landlord_introducer_configs`
`approval_flows` `approval_requests` `approval_records` `approval_dividend_records`

**运行时/迁移脚本建的表（不在 `database_init.sql`）**：
`alert_configs`（`migrations/2026_08_alert_configs.sql`）、`system_configs`（`system_config.py:31`）

**视图（3）**：
`landlord_site_summary`（场地实时聚合：租金成本/收入/合同清单）
`landlord_monthly_summary`（场地月度经营汇总，各源预聚合防笛卡尔积）
`dividend_settlement_schedule`（受益人 × 周期的下次结算期 + 待结算/已结算金额）

**关键唯一键 / 表达式索引**：
- `uq_elec_records_group`：`electricity_records (landlord_id, COALESCE(brand_id,0), COALESCE(entity_id,0), period)`
- `uq_contracts_venue`：`contracts (landlord_id, start_date, end_date) WHERE contract_type='场地合同'`
- `uq_contracts_brand_split`：`contracts (landlord_id, COALESCE(brand_id,0), COALESCE(entity_id,0), start_date, end_date) WHERE contract_type='品牌方合同'`
- `uq_lsh_conf_whole` / `uq_lsh_conf_brand` / `uq_lin_conf_whole` / `uq_lin_conf_brand`：分红配置（含生效期）
- `meter_monthly`：`UNIQUE(address, month_period)`
- `meter_shared_allocations`：`UNIQUE(address, month_period, brand_id)`
- `rent_payment_schedule` / `rent_income_schedule`：`UNIQUE(contract_id, seq)`

**⚠️ 循环外键（导库时必看）**：`approval_requests.dividend_record_id ↔ dividend_records.approval_id`。用 Navicat 等工具同步时**不能勾「创建前删除目标对象」**（逐表 DROP 必被挡），需先摘这 6 条外键再灌数据。

### 9.3 关键文件地图

**后端**

| 职责 | 文件 |
|---|---|
| 应用入口 / 鉴权中间件 / 启动动作 | `backend/app/main.py` |
| 响应 camelCase 基类 | `backend/app/api/base.py` |
| 看板（6 个接口） | `backend/app/api/overview.py` |
| 电费台账 + 生成器 | `backend/app/api/electricity.py` |
| 电表能耗 / 共享分摊录入 | `backend/app/api/meter_energy.py` |
| 电表档案 | `backend/app/api/meters.py` |
| 场租台账 | `backend/app/api/rent.py` |
| 合同 + Excel 导入 | `backend/app/api/contracts.py` |
| 合同分期 | `backend/app/api/contract_schedules.py` |
| 分红接口 | `backend/app/api/dividends.py` |
| 审批 | `backend/app/api/approvals.py` |
| 预警 | `backend/app/api/alerts.py` |
| 基础档案 CRUD | `backend/app/api/directory.py` |
| 系统配置 | `backend/app/api/system_config.py` |
| **分红计算引擎** | `backend/app/domain/dividend_calc.py` |
| **电价匹配规则** | `backend/app/domain/electricity_pricing.py` |
| 分红重算 | `backend/app/domain/dividend_refresh.py` |
| 共享表柜数仓储 | `backend/app/repositories/shared_allocation_repo.py` |
| 合同仓储（含实时柜数） | `backend/app/repositories/contract_repo.py` |
| 自动拆期算法 | `backend/app/repositories/contract_schedule_repo.py` |
| 审批仓储（含回写逻辑） | `backend/app/repositories/approval_repo.py` |
| 天雀同步 | `backend/app/jobs/sync_meters.py` |
| 定时任务 | `backend/app/jobs/scheduler.py` |
| 天雀 API 客户端 | `backend/app/infra/meter_api.py` |
| 数据隔离 | `backend/app/infra/auth_scope.py` |
| Token | `backend/app/middleware/mp_auth.py` |
| 建表 / 增量 DDL | `backend/app/database_init.sql` / `backend/app/schema_sync.sql` |
| 手工迁移 | `backend/app/migrations/*.sql` |

**前端**

| 职责 | 文件 |
|---|---|
| 路由 / 股东页面拦截 | `src/App.tsx` |
| 菜单 / 角色标签 | `src/components/Layout.tsx` |
| axios 客户端（baseURL `/api`，401 跳登录） | `src/api/client.ts` |
| 各页 API 封装 | `src/api/*.ts` |
| 柜数口径工具 | `src/lib/alloc.ts` |
| 主体分组配色 / 分组逻辑 | `src/lib/groupColors.ts` |
| 月份工具 | `src/lib/period.ts` |
| 合同预警卡片 | `src/components/ContractAlertCard.tsx` |
| 分期管理组件 | `src/components/ContractSchedule.tsx` |
| 分红表单 | `src/components/DividendForm.tsx` |
| 登录态 Provider | `src/providers/auth.tsx` |

### 9.4 数据库连接（本机 / 远程）

| 环境 | 连接方式 |
|---|---|
| 本机 | 容器 `postgres-quant`（用户 **`quant`**，非 postgres），库 `huandian_v2`。宿主机无 psql，一律 `docker exec postgres-quant psql -U quant -d huandian_v2 -c "..."` |
| 本机后端 | 容器 `battery-swap-v2-backend`（3001，有 volume，改 py 自动 reload） |
| 本机前端 | 容器 `battery-swap-v2-frontend`（8085:80，**无 volume**，改代码必须 rebuild） |
| 远程生产库 | `121.43.104.161:5432`，**公网关闭、SSH 免密不通** → 只能 Navicat 拉取，**绝不写远程库** |

> 关于容器 rebuild / 部署的完整坑清单（构建耗时判据、镜像源、服务器出网不可用、`docker save/load` 搬运等），见项目记忆文件 `.workbuddy/memory/MEMORY.md`，本手册不重复。

---

## 索引锚点对照表（HTML 锚点速查）

| 章节 | 锚点 |
|---|---|
| 1.1 页面总览索引 | `#11-页面总览索引` |
| 1.2 业务名词反查索引 | `#12-业务名词反查索引核心` |
| 1.3 数据表正反向索引 | `#13-数据表正反向索引` |
| 4.3 电量口径三条铁律 | `#43-电量口径三条铁律必背` |
| 4.4 柜数三来源优先级 | `#44-柜数三来源优先级必背` |
| 5.1 经营总览 | `#51-经营总览-dashboard-` |
| 5.3 电费台账 | `#53-电费台账-electricity-electricity` |
| 5.8 股东分红 | `#58-股东分红-shareholders-shareholders` |
| 5.11 智慧电表 | `#511-智慧电表-meters-meters` |
| 6.1 台账生成器 | `#61-电费台账生成器-electricitygenerate` |
| 6.2 分红计算引擎 | `#62-分红计算引擎-dividend_calc` |
| 6.4 共享电表机制 | `#64-共享电表机制全系统最高复杂度` |
| 8.2 时序/覆盖风险 | `#82-️-时序--覆盖风险最容易造成数字被改掉` |
| 8.3 隐性依赖与半成品 | `#83-隐性依赖与半成品功能` |
| 8.4 命名误导清单 | `#84-命名误导清单` |

---

*本手册基于工作区当前源码静态分析生成，覆盖 `backend/app/**`（约 16.7k 行）与 `src/**`（约 15.7k 行）全部业务代码。所有行号对应当前工作副本。*
