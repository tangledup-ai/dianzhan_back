# 换电站经营管理平台 - 页面数据关联关系梳理

> 基于当前代码（React 19 前端 + FastAPI/PostgreSQL 后端）梳理。
> 核心结论：这是一个以 **站点(stations)** 为枢纽、以 **meters / contracts 为输入**、以 **dividend_records 为最终产出** 的财务系统。
> 所有页面最终都在回答同一个等式：

```
电表度数 × 合同单价 − 场地租金 − 运营费用 = 利润 → 按股东/介绍人配置分红
```

---

## 一、数据血缘全景图

```
                         ┌──────────── 基础档案（Directory 维护）────────────┐
                         │  brands   entities   landlords   shareholders    │
                         │                     introducers  platform_users  │
                         └────────────────────────┬────────────────────────┘
                                                  │ id 引用
        ┌─────────meters(电表)─────────┐          │          ┌─contracts(合同)─────────┐
        │ station_id ─┐                │          │          │ landlord_id ────────┐   │
        │ brand_id    │                │          │          │ brand_id           │   │
        │ landlord_id ├─►stations(站点)├──────────┼──────────► contract_type       │   │
        │ entity_id   │  (landlord_id) │          │          │ electricity_price   │   │
        │ meter_no    │                │          │          │ monthly_rent        │   │
        └─────┬───────┘                │          │          │ cabinets_count      │   │
              │ meter_no=address       │          │          │ tax_rate            │   │
              ▼                        │          │          │ first_month_rent    │   │
        meter_monthly(第三方表码)        │          │          │ rent_refund         │   │
        (kwh 按 电表号×月份 存储)         │          │          └─────────────────────┘
              │                        │          │                     │
              │  ① 电费生成(generate)   │          │                     │
              └───────────┬────────────┴──────────┴─────────────────────┘
                          ▼
              electricity_records          rent_leases / rent_incomes
              + electricity_meter_details  (Rent 页独立台账)
                          │                         │
                          ▼                         ▼
              ┌───────────────────────────────────────────────────┐
              │  dividend_calculator.calculate(station, period)   │
              │  = 电费收入 + 租金收入 - 电费成本 - 场地租金        │
              │    - 运营费用 - 税费 - 商务分红                     │
              │  ←── station_shareholder_configs ←── shareholders │
              │  ←── station_introducer_configs ←── introducers   │
              └───────────────────────────────────────────────────┘
                          ▼
                  dividend_records + dividend_shares
                          ▼
                  approval_requests（审批）→ 已通过/已结算
```

---

## 二、三棵「数据源大树」

### ① meters（电表）— 提供「物理量：度数」

| 字段 | 引用方 |
|---|---|
| `meter_no` | **全局身份**，是 meter_monthly 的 `address`，是电费、分红、看板计算的匹配键 |
| `station_id` | 归属站点 |
| `brand_id` | 电表对应的品牌方（**1 电表 = 1 品牌方**，派生收款单价） |
| `landlord_id` | 归属场地方（**注意：电表直接存了 landlord_id**，不止靠站点） |
| `entity_id` | 报税公司主体 |
| `transformer_ratio` | 互感器倍数，generate 时 `实际度数 = 表码 × 倍数` |

由 meters 派生但**不落库**的还有：`meter_monthly`（同步/录入的表码）、`meter_daily/hourly/yearly`（第三方能耗）、`meter_status_cache`、`cabinets`（柜子，挂在 meter 下）。**cabinets 又反过来被 contracts 表单引用算柜数**（见「跨页数据流」）。

### ② contracts（合同）— 提供「商务量：单价与租金」

| 字段 | 用途 |
|---|---|
| `contract_type` | **场地合同=成本**（公司付业主）/ **品牌方合同=收入**（品牌方付公司），全系统按此分流 |
| `electricity_price` | 付款单价（场地合同）/ 收款单价（品牌方合同）——电费台账与分红的核心乘数 |
| `monthly_rent` / `unit_monthly_rent` / `cabinets_count` | 租金收入与成本 |
| `tax_rate` / `post_tax_electricity_price` / `rent_tax_rate` / `post_tax_rent_price` | 含税→不含税换算 |
| `first_month_rent` / `rent_refund` / `early_end_date` | 合同首月租金、提前结束退款（分红计算有专门分支） |
| `venue_cost`（动态算） | 品牌方合同「承担场地成本」，按场地合同月租金分摊 |

### ③ shareholders（股东）+ introducers（介绍人）— 提供「分配规则」

- `shareholders` → `station_shareholder_configs`（每个站点给每个股东：`mode`=收入/利润/固定，`ratio`，`fixed_amount`，`settlement_period` 月/季/半年/年，`start_date`/`end_date` 生效期）
- `introducers` → `station_introducer_configs`（同上，多一个 `count_as_cost` 是否计入成本）
- 这两张 config 表是 **分红计算器的参数表**，直接决定 dividend_shares 的金额。

---

## 三、中间汇合层（页面之间的「账本」）

- **electricity_records（电费月台账）+ electricity_meter_details（分表明细）**
  - 由 `POST /api/electricity/generate` 从 `meter_monthly`（度数）× `contracts`（单价）自动生成
  - **匹配链路（backend/app/api/electricity.py:139-230）**：`meters.station_id → stations.landlord_id → contracts.landlord_id`，再按 `contract_type` 取 场地合同=付款单价 / 品牌方合同=收款单价
- **rent_leases（付款）/ rent_incomes（收款）/ rent_receipts（分期）/ operating_expenses（运营费用）**
  - 独立台账，与 contracts 表**数据不打通**（两个系统各自记录租金）
- **dividend_records（分红月结）+ dividend_shares（分红明细）**
  - 由 `dividend_calculator.calculate()` 生成：收入=电费+租金；成本=电费+场地租金+运营费用+税费+退款+商务分红；再按 configs 分摊

---

## 四、逐页面数据消费清单

| 页面 | 直接数据源 | 与 meters/contracts/shareholders 的关系 |
|---|---|---|
| **Meters** 电表 | meters、cabinets、meterEnergy(同步) | **数据源头之一**。新增电表/录入读数后**自动调 generateElectricity** 刷新电费台账 |
| **Contracts** 合同 | contracts、brands、landlords | **数据源头之二**。表单内**实时从 meters+cabinets 反推计费柜数**，可跳转 `/meters?landlord=..&brand=..` 去改柜子 |
| **Electricity** 电费台账 | electricity_records、meter_monthly(读数)、meters(entity_name) | meters×contracts 的**产品页**；导出 Excel 用 meter_monthly 的起始/抄表度数 |
| **Shareholders** 股东分红 | shareholders、configs、stationBoard、calculateDividend、expenses、contracts、getStationEnergy+getMonthlyKwh(导出时) | 全链路最深的页面：**同时直读 meters(电表)、meter_monthly(度数)、contracts(单价)** 重算每站分红；改运营费用→后端自动重算分红记录 |
| **Dashboard** 总览 | overview(聚合)、contracts | 间接：meterCount、月度利润全部来自 electricity_records 与 meters 聚合 |
| **Stations** 站点 | stationBoard、landlordStationMonthly、stationMeterView | **强间接**：三个接口都在聚合 meters+meter_monthly+contracts+rent_*；含站点电费/场地费审批 |
| **Rent** 场租 | contracts、rent_*、**美团Excel台账(excel-data)** | **唯一不碰 meters 的页面**：柜子数取 `contracts.cabinets_count` 而非电表下的柜子；并混有外部 Excel 数据源 |
| **Brands** 品牌方 | brands、contracts、meters、cabinets、electricity、rentIncomes | 直读 meters/contracts/electricity 组装品牌视图 |
| **Entities** 公司主体 | entities、contracts、meters、cabinets、stations | 直读，按 `meters.entity_id` 与 `contracts.pay_entity` 关联；含"关联电表"弹窗调 updateMeter |
| **Landlords** 场地方 | landlords、contracts、meters、stations | 直读，按 landlord_id 分组 |
| **Approvals** 审批 | approval_requests、approval_flows | 消费 dividend 审批单；通过后回写 dividend_records 状态 |
| **Directory** 档案 | 六张档案表 + stations | 纯档案源，喂给上面所有页面 |
| **StationMap** 地图 | stations(经纬度) | 只读 stations |

> 注：`DimensionBoard.tsx` 是**孤儿组件**（未被 App.tsx 路由引用）；Brands/Entities/Landlords 是独立页面，不是它的 kind 变体。`Home.tsx` 也是孤儿文件。

---

## 五、跨页数据流（改一处，牵动哪些页面）

1. **Meters 新增/录读数 → 电费台账自动重算**：`Meters.tsx` 保存电表后 `generateElectricity({period})`；`ReadingForm` 保存读数后也调 generate → 刷新 `["electricity"]`。**影响 Electricity、Dashboard、Stations、Shareholders、Brands**。
2. **Meters 手动同步**：更新 meter_monthly，需再点「自动生成」或录读数才落到电费台账（**不会自动重算**）。
3. **Contracts 保存**：`queryClient.invalidateQueries()` 全清 → 刷新 Dashboard、Rent、Brands、Entities、Landlords 共享的 `["contracts"]`。
4. **Contracts 表单 ↔ Meters**：品牌方合同按 `landlord_id+brand_id` 匹配电表、数柜子算 `cabinets_count`（`Contracts.tsx`），改柜子跳转电表页。
5. **Shareholders 改运营费用**：后端 `rent.py:_update_dividend_records` **同步重算该站该月分红记录**；前端同时 invalidate `["stationBoard"]`（波及 Stations、DimensionBoard）。
6. **Shareholders 提交分红 → Approvals**：`submitDividendApproval` 建审批单并关联 `dividend_record_id`；Approvals 通过 → 分红状态流转「未结算→申报中→已通过→已结算」。

---

## 六、需要留意的数据口径差异（对账时容易踩坑）

1. **两条不同的「电表→合同」匹配路径**：
   - 电费生成走 `meters.station_id → stations.landlord_id → contracts.landlord_id`（electricity.py）
   - 分红计算走 `meters.landlord_id → contracts.landlord_id`（dividend_calc.py）
   - **若某电表只有 station_id 没 landlord_id（或反之），两个页面算出的度数/利润会不一致。** 建议保证建电表时 landlord_id 与站点一致。
2. **单价取「第一个」合同**：电费生成和分红计算都只取 `brand_contracts[0].electricity_price` / `landlord_contracts[0]`。若同一场地方有多份品牌方合同且单价不同，**所有电表会被套用同一个收款单价**。这是当前实现的已知简化。
3. **Rent 页与 contracts 表是两个租金口径**：Rent 独立维护 `rent_leases/rent_incomes`，Contracts 页的 `monthly_rent` 是另一套；同时 Rent 还混入了美团 Excel 台账（`excel-data`）。导出/对账时三方金额可能对不上。
4. **税费计算不一致**：电费台账 generate 用 `collect_amount/(1+tax_rate)` 算不含税；分红计算对启用了税后单价的品牌用 `kwh×(税前-税后)` 单算 elecTax。两条链路口径不同。

---

## 七、关键技术文件索引

| 文件 | 内容 |
|---|---|
| `backend/app/api/electricity.py` | 电费台账 CRUD + `generate`（电表度数×合同单价） |
| `backend/app/domain/dividend_calc.py` | 分红计算器（直读 meters、meter_monthly、contracts、configs） |
| `backend/app/api/meters.py` / `repositories/meter_repo.py` | 电表联表（station/brand/landlord/entity 名称） |
| `backend/app/api/meter_energy.py` | 第三方能耗数据 + 手动录读数（写 meter_monthly） |
| `backend/app/api/overview.py` | 看板聚合（Dashboard/Stations/Shareholders 共用） |
| `backend/app/api/rent.py` | 场租台账 + 美团 Excel 台账 + 运营费用触发分红重算 |
| `src/pages/Meters.tsx` | 电表维护 + 同步 + 录读数（保存后触发电费生成） |
| `src/pages/Contracts.tsx` | 合同维护（表单反查电表柜数） |
| `src/pages/Shareholders.tsx` | 分红配置/预览/记录/审批/导出（最深层数据消费） |
