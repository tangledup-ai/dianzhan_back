# 三条数据主线 — 表结构治理总纲

> 状态：**✅ 三条主线设计全部完成，已升级为《数据库全量重设计 v2》**（v2 把所有表收口为一条主链：场地方→站点→电表→合同→分红；重点重构智慧电表第三方接入）
> 目标：整个系统的数据来源只有三处，其余全部是由这三处数据做**加减乘除**派生出来的。
> 本文是总纲，逐条主线的详细设计与建表 SQL 见各主线文档。

---

## 一、为什么只有三条主线

系统里每个页面看到的数据，追根溯源只有三个来源：

| # | 数据源 | 谁能写 | 特点 | 对应文档 |
|---|---|---|---|---|
| ① | **智慧电表数据** | 只能从第三方平台 **GET** 同步（不能 POST/PUT） | 提供"物理量"：表码、度数、倍率、实时状态 | `METER_LINE_DESIGN.md` + `2026_08_meter_line_clean.sql` |
| ② | **合同信息** | 系统内人工新建/编辑 | 提供"商务量"：单价、月租、税、柜数、首月租/退款 | `CONTRACT_LINE_DESIGN.md` + `2026_08_contract_line_clean.sql` |
| ③ | **股东分红基础信息** | 系统内人工配置 | 提供"分配规则"：分润比例、分润方式、结算周期、生效期 | `DIVIDEND_LINE_DESIGN.md` + `2026_08_dividend_line_clean.sql` |

**一句话**：电表给"度数"，合同给"单价/租金"，分红配置给"怎么分"；其余所有表（电费台账、分红月结、看板聚合……）都是这三者的乘积与加减。

---

## 二、三层数据模型（全系统统一视角）

```
┌─ 源头层（只有这三处数据能进来）─────────────────────────────┐
│  ① 电表线: third_party_configs →(GET 同步)→ meter_* 缓存    │
│             → meters 业务档案（挂站点/品牌/场地/主体）        │
│  ② 合同线: contracts（场地合同=成本 / 品牌方合同=收入）       │
│  ③ 分红线: shareholders/introducers + station_*_configs      │
└──────────────────────────┬──────────────────────────────────┘
                           │ 唯一输入
┌─ 派生层（加减乘除，不产生新数据源）──────────────────────────┐
│  electricity_records(+details) = 表码 × 倍数 × 合同单价       │
│  dividend_records(+shares)    = 收入 − 成本，按分红配置分摊    │
│  overview / station-board / brand-board … 全部为聚合视图       │
└───────────────────────────────────────────────────────────────┘
```

### 派生关系的两个铁律

1. **源头表只能被源头写**：电表缓存只由同步任务写；合同/分红配置只由人工维护界面写。
2. **派生表不允许人工直改源头字段**：改电费台账里的单价/度数，应当回去改源头（meters 读数、contracts 单价）再重新生成，而不是在派生表上直接改数字。

---

## 三、现状问题（治理要解决的问题）

| 类别 | 问题 | 详情 |
|---|---|---|
| 电表线 | 电表存在**两套实现** | 业务 `meters` 表（electricity/dividend/overview 在用）与 `meter_repo_v2` 直读 `meter_devices`（Meters 页在用），两者互不相通，Meters 页看不到站点/品牌/场地 |
| 电表线 | `meter_monthly` **schema 漂移** | `database_init.sql` 定义 `UNIQUE(address, month_period)`，`sync_meters.py` 写 `device_id/year_month` 并按 `(device_id, year_month)` 冲突更新，`meter_repo_v2` 还读一个不在任何建表脚本里的 `d0` 列 |
| 电表线 | period 格式双轨 | 同步写 6 位 `202608`，手工入口可能写 7 位 `2026-08` |
| 电表线 | `meters.landlord_id` 双源 | 电表直接存一份、站点再存一份；已用迁移 #10 收敛为"以站点为准"，模型上仍需固化说明 |
| 合同线 | 租金三处记录互不打通 | `contracts.monthly_rent` / `rent_leases|rent_incomes|rent_receipts` / 美团 Excel（待 ② 处理） |
| 分红线 | 配置表 schema 漂移 | `station_shareholder_configs` 的生效期列此前缺失，UNIQUE 语义与生效期矛盾（待 ③ 处理） |
| 全局 | 派生值混存 | 如 `contracts.venue_cost`（应实时算）、`rent_incomes.profit`（落库没人读） |

> 详细核验证据见 `DATA_GOVERNANCE.md` 与 `DATA_RELATIONSHIPS.md`。

---

## 四、推进计划（一条一条来）

### ✅ ① 智慧电表线（已完成）

- **文档**：`METER_LINE_DESIGN.md`
- **建表 SQL**：`backend/app/migrations/2026_08_meter_line_clean.sql`
- 范围：`third_party_configs` / `meter_devices` / `meters` / `meter_monthly|daily|hourly|yearly` / `meter_status_cache` / `meter_warnings_cache` / `meter_collectors` / `sync_logs` / `cabinets`
- 本轮只定表结构，**不改业务代码与 mock 数据**。

### ✅ ② 合同信息线（已完成）

- **文档**：`CONTRACT_LINE_DESIGN.md`
- **建表 SQL**：`backend/app/migrations/2026_08_contract_line_clean.sql`
- 范围：`contracts`（六组字段 + 注释）+ `rent_payment_schedule` / `rent_income_schedule`
- 已解决：合同类型两分法口径（`场地合同/品牌方合同`）、租金唯一主源定为 contracts、柜数唯一源（meters→cabinets 实时统计）、venue_cost / pay_status 不落库、防重复唯一索引、废弃列标注（station_name / partner / rent_* 台账）。
- 本轮只定表结构，**不改业务代码与 mock 数据**。

### ✅ ③ 股东分红基础信息线（已完成）

- **文档**：`DIVIDEND_LINE_DESIGN.md`
- **建表 SQL**：`backend/app/migrations/2026_08_dividend_line_clean.sql`
- 范围：`shareholders` / `introducers` / `station_shareholder_configs` / `station_introducer_configs`
- 已解决：生效期列落地 + 唯一键含生效期（同一受益人同站可配多段不重叠生效期）、mode 三值枚举、结算周期统一 `月/季度/半年/年`、ratio/fixed_amount 与 mode 联动 CHECK、brand_id 整站/品牌配置语义、count_as_cost 口径、配置表补审计列、生效期重叠核对 + 可选排除约束。
- 本轮只定表结构，**不改业务代码与 mock 数据**。

---

## 四·五、全量重设计 v2（当前总览）

> 三条主线分治后，用户决定**把所有表统一重设计**。最终设计见：

| 文件 | 内容 |
|---|---|
| `DATABASE_REDESIGN_V2.md` | **全量重设计 v2**：一条主链（场地方→站点→电表→合同→分红）、分域表结构、唯一派生口径、第三方电表接入专项、迁移策略 |
| `backend/app/migrations/2026_08_full_redesign.sql` | **全部 37 表 + 1 视图**的幂等建表 SQL（权威字段定义，含存量对齐/核对/破坏性段） |

## 四·六、实施轮（设计落地，非本轮）

1. 用 `2026_08_full_redesign.sql` 替换 `database_init.sql`（消除双源漂移）。
2. 代码适配：`meter_repo_v2` 切回读 `meters`、`sync_meters.py` 冲突键切 `(address, 周期)`、合同旧类型/旧表单统一两分法、Rent 页改读 contracts、审批通过回写台账/分期状态、period 全系统 6 位。
3. Mock 数据按新结构重写（`src/mocks/index.ts`）。
4. 对账回归：任意站月「电费台账利润 == 分红预览净利润」，抽查 ≥5 站 × ≥3 月。

---

## 五、三线如何汇合成派生层（预览）

```
电表线 ── 表码×倍数 ──► 度数 ──┐
                              ├─(乘)合同单价/月租──► electricity_records / 租金台账
合同线 ── 单价/月租/税/退款 ──► ┘
                              ├─(加)收入  (减)成本 ──► dividend_records 利润
分红线 ── 比例/模式/结算周期 ──► └──────────────────► dividend_shares 分润明细
```

---

## 六、文档索引

| 文件 | 内容 |
|---|---|
| `DATABASE_REDESIGN_V2.md` | **全量重设计 v2（总览）**：一条主链 + 分域设计 + 唯一口径 |
| `backend/app/migrations/2026_08_full_redesign.sql` | **全量重设计 v2**：39 表 + 1 视图幂等建表 SQL（权威字段定义） |
| `THREE_SOURCE_LINES.md` | 本文，三数据源总纲 |
| `METER_LINE_DESIGN.md` | ① 电表线：逐表字段/关系/口径规则（结论已并入 v2） |
| `backend/app/migrations/2026_08_meter_line_clean.sql` | ① 电表线：幂等建表 SQL（结论已并入 v2 全量 SQL） |
| `CONTRACT_LINE_DESIGN.md` | ② 合同线：contracts 六组字段/口径规则/过渡表处置（结论已并入 v2） |
| `backend/app/migrations/2026_08_contract_line_clean.sql` | ② 合同线：幂等建表 SQL（结论已并入 v2 全量 SQL） |
| `DIVIDEND_LINE_DESIGN.md` | ③ 分红线：受益人档案 + 分配规则表/枚举/生效期（结论已并入 v2） |
| `backend/app/migrations/2026_08_dividend_line_clean.sql` | ③ 分红线：幂等建表 SQL（结论已并入 v2 全量 SQL） |
| `DATA_RELATIONSHIPS.md` | 全系统页面 ↔ 数据关联关系梳理 |
| `DATA_GOVERNANCE.md` | 历史问题清单（P1-P8 + E/R/C 组） |
