# 换电站经营管理平台 - 数据结构治理清单

> 状态：**只列问题与改法，未动任何代码。**
> 依据代码核验得出，每条给出：现状 → 证据位置 → 影响 → 改法(含推荐与权衡) → 验收标准 → 影响面。
> 严重度标注：🔴 高（影响账目正确性）｜🟠 中（数据口径不一）｜🟡 低（结构/维护成本）｜⚪ 观感。

---

## 零、先做的三件事（不需要改代码，先掌握实情）

治理前先把底数摸清，这几步只读、可回滚：

1. **核验分红配置表结构**（P6 相关，已发现代码与建表脚本矛盾）：
   ```sql
   \d station_shareholder_configs        -- 看有没有 start_date/end_date 列
   \d station_introducer_configs
   ```
   若没有这两列 → 现网「配置分红」功能一直在报错或字段被静默丢弃，需先补列。
2. **找出 landlord 不一致的电表**（P2 相关）：
   ```sql
   SELECT m.id, m.meter_no, m.landlord_id AS meter_landlord, s.landlord_id AS station_landlord
   FROM meters m JOIN stations s ON m.station_id = s.id
   WHERE m.landlord_id IS DISTINCT FROM s.landlord_id;
   ```
3. **对同一站月，比对电费台账 vs 分红预览**（P1 相关）：在页面里选一个月，电费页的利润 与 分红页预览的净利润 是否一致，把不一致的站点记下来。

---

## 一、🔴 高优先级（影响账目正确性）

### P1. 利润有两套计算引擎，税费规则还不一致

| 项 | 内容 |
|---|---|
| **现状** | `electricity.py` 的 generate 生成 `electricity_records`（台账）；`dividend_calc.py` **不读台账、从 meter_monthly + contracts 重新算一遍**利润。两处税费算法不同：台账用 `collect_amount/(1+tax_rate)`；分红对启用税后单价的品牌用 `kwh×(税前−税后)` 另算 `elecTax`。 |
| **证据** | `backend/app/domain/dividend_calc.py:90-117`；`backend/app/api/electricity.py:261-270` |
| **影响** | 同一站月，电费页与分红页的电费收入/利润可能对不上；对外对账单与对内分红是两套数。 |
| **改法** | **推荐：** 让 `dividend_calc` 优先读 `electricity_records` + `electricity_meter_details`（台账缺失时才实时兜底计算），并统一税费口径为一种。**备选：** 维持两套引擎，但把税费算法收敛成同一个公共函数，两侧都调用。 |
| **权衡** | 改计算引擎会影响**未来**的分红预览/生成；历史 `dividend_records` 快照已落库不受影响。改动后需回归：任意站月台账利润 == 分红预览净利润。 |
| **验收** | 抽查 ≥5 个站点 × ≥3 个月，分红预览中 `elecIncome/elecCost/elecTax` 与电费台账完全一致。 |
| **影响面** | Shareholders 页（预览/生成）、Electricity 页、Stations 页、导出 Excel。 |

### P2. 「电表→场地」关系双源，两条匹配路径会算岔

| 项 | 内容 |
|---|---|
| **现状** | `meters.landlord_id` 直接存一份；`meters.station_id → stations.landlord_id` 又是一份。电费生成走 `meter.station_id → station.landlord_id`（electricity.py:216-231），分红计算走 `meters.landlord_id`（dividend_calc.py:292-301）。 |
| **影响** | 电表若只填了站点没填 landlord（或反了），两个页面取到不同度数。 |
| **改法** | **推荐：** 收敛为单一路径——以 `meters.station_id → stations.landlord_id` 为准，建/改电表时由站点带出 landlord_id 强制写入，并加应用层校验。**或** 反向：删 `stations.landlord_id` 依赖，全走 `meters.landlord_id`。选一条，删另一条。 |
| **验收** | 第「零」节 SQL 查出 0 条不一致；两条路径算同一结果。 |
| **影响面** | Meters 表单、electricity/generate、dividend_calc、overview/station-board、station meter-view。 |

### P3. 柜子数两套来源（手填 vs 电表反推）

| 项 | 内容 |
|---|---|
| **现状** | `contracts.cabinets_count` 手填一份；`meters→cabinets` 能数出第二份。合同表单已会自动用后者**覆盖**前者（Contracts.tsx 的 `autoCabinetCount`），但合同仍落库存 `cabinets_count`。 |
| **影响** | 品牌方合同计费柜数与电表实挂柜数可能不一致 → 租金对不上。 |
| **改法** | **推荐：** 合同不再持久化 `cabinets_count`（只存 `unit_monthly_rent`），计费柜数一律实时从 `meters→cabinets` 统计；历史值做一次性对齐。**备选：** 保留存储字段，但增加「两处不一致」的校验/告警。 |
| **验收** | Contracts 表单自动柜数与任何页面看到的柜数恒一致。 |
| **影响面** | ContractForm、Rent 页、Brands/Entities 页、导出。 |

---

## 二、🟠 中优先级（数据口径不一）

### P4. 一套租金，三处记录，互不打通

| 项 | 内容 |
|---|---|
| **现状** | 租金散落在：① `contracts.monthly_rent`；② `rent_leases` / `rent_incomes` / `rent_receipts`；③ **硬编码路径的 Excel** `backend/app/api/rent.py:163` 的 `2026-2027美团场租.xlsx`（运行时解析）。另有年度台账表 `rent_payment_records` / `rent_income_records`（migrations/add_rent_records.sql）。 |
| **影响** | 同一场地租金在多个页面看到不同数字；Excel 缺失/路径变更即接口报错；生产财务数据躺在 Excel 里。 |
| **改法** | **推荐：** 定 `contracts` 为租金主源；把美团 Excel **一次性导入** `rent_incomes`（带 source 标记），之后删除运行时解析；Rent 页改为读库。**备选：** 若 Excel 就是业务真相，则反向把它入库并让 contracts 反查它。 |
| **权衡** | Excel 导入是一次性数据工程，需要人工核对口径（含税/不含税、扣款 500 等）。 |
| **验收** | Rent 页展示的所有数字均来自数据库；`getExcelData` 不再被生产页面依赖。 |
| **影响面** | Rent 页、rent_repo、导出。 |

### P5. 合同表字段有机增长，存储值与派生值混存

| 项 | 内容 |
|---|---|
| **现状** | `contracts` 单表堆了 `venue_cost`（计算值）、`first_month_rent`、`rent_refund`、`early_end_date`、`rent_tax_*`、`deposit`、`post_tax_*` 等一批后补字段。 |
| **影响** | 维护成本高，派生字段容易被改脏（如 venue_cost 与场地合同不同步）。 |
| **改法** | 区分「存储字段」与「派生字段」：`venue_cost` 改为前端实时计算，不落库；税后价、首月租金等保留但加注释说明口径。 |
| **验收** | contracts 表字段按「基础/税务/租金/期次」分组有文档；无重复派生字段落库。 |
| **影响面** | ContractForm、Contracts 页、Brands/Entities 导出。 |

---

## 三、🟡 低优先级（结构/维护成本）

### P6. 分红配置表 schema 漂移 + UNIQUE 语义矛盾（已实锤）

| 项 | 内容 |
|---|---|
| **现状** | `database_init.sql:74-85` 建 `station_shareholder_configs` 时**没有 `start_date/end_date` 列**，且带 `UNIQUE(station_id, shareholder_id)`。但 `dividend_repo.py:50-59` 插入/更新这两列，并 `ON CONFLICT (station_id, shareholder_id) DO UPDATE`；`dividend_calc.py:352-371` 用 `start_date/end_date` 过滤生效期。migrations 目录里**没有任何**给这两张表补列的脚本。 |
| **影响** | ① 若现网列确实不存在，配置分红功能长期在报错/丢字段；② 即使补了列，UNIQUE + DO UPDATE 意味着**同一股东同一站永远只能有一条配置**，UI 的「生效期起止」功能形同虚设。 |
| **改法** | 写迁移补 `start_date/end_date`（NOT NULL DEFAULT / 可空）；把 UNIQUE 改为 `UNIQUE(station_id, shareholder_id, start_date)`（或去掉唯一约束，靠生效期去重）；`ON CONFLICT` 目标随之调整。 |
| **验收** | 能配置同一股东同一站两段不重叠的生效期，且各自参与分红计算。 |
| **影响面** | Shareholders 配置弹窗、dividend_calc、分红生成。 |

### P7. 孤儿代码与脆弱的共享 queryKey

| 项 | 内容 |
|---|---|
| **现状** | `DimensionBoard.tsx`、`Home.tsx` 未被 App.tsx 路由引用（孤儿）；DimensionBoard 里 `listElectricity/listLeases/listIncomes` 导入未用；`["stationBoard"]` queryKey 被 Shareholders/Stations/（孤儿）DimensionBoard 共用，一处 invalidate 全连带刷新。 |
| **影响** | 死代码误导排查；跨页共享 key 造成无谓重刷。 |
| **改法** | 删除或接入孤儿组件；清未用 import；给跨页共享 key 加明确语义（或按页面前缀化）。 |
| **影响面** | 无业务风险，纯清理。 |

---

## 四、⚪ 观感

### P8. 项目文档停留在旧技术栈

| 项 | 内容 |
|---|---|
| **现状** | `PROJECT_UNDERSTANDING.md` 描述 Hono + tRPC + MySQL + Drizzle，实际是 FastAPI + PostgreSQL；`README.md` 部分内容同样过时。`API_DESIGN.md` 是新的、可用。 |
| **改法** | 用本文档 + API_DESIGN.md 更新 PROJECT_UNDERSTANDING.md 的技术栈、页面路由、数据模型章节。 |

---

## 四·五、第二步新增实锤问题（2026-08-07，来自 PAGE_DATA_INVENTORY.md 第二步梳理）

> 分三组：E=电费主线特有、R=场地费主线特有、C=跨线共用。带 ✅ 的为已用运行库数据验证。

### E 组（电费主线）

| 编号 | 问题 | 证据 | 影响 |
|---|---|---|---|
| E1 ✅ | **period 格式双轨**：generate 写 `electricity_records.period="202608"`(6位)，ElecForm 手工新增写 `"2026-08"`(7位)；`stations.py:62`/`dividends.py:79` 按 7 位查 6 位记录匹配不上 | `electricity.py:308` / `ElecForm.tsx:21` | 见下文「period 双轨影响面分析」 |
| E2 | 手工新增电费全写 0：create_electricity 读 `meterDetails`，ElecForm 提交没有该字段 → 金额全 0，入口是坏的 | `electricity.py:46-51` / `ElecForm.tsx:84-94` | 手工建电费记录不可用 |
| E3 | 互感器倍数只有 generate 一处生效：dividend/station-board/station-view 都不乘 → 看板/分红度数可能差一个倍数 | `electricity.py:239-240` vs `dividend_calc.py:371-376` | 台账度数 vs 看板/分红度数不一致 |
| E4 | 品牌单价"取第一个"且无 ORDER BY：generate/station-board 取第一个、station-view 取最后一个、dividend 每品牌——互相矛盾 | `electricity.py:227-228` / `overview.py:232-235` / `stations.py:93` | 多品牌共址时算错品牌收入（Q3 已确认要按品牌匹配） |
| E5 | 租金混进电费台账金额：pay_amount=电费+场地租、collect_amount=电费+品牌租，但 details 只有电费 → 明细合计≠记录合计 | `electricity.py:266-268` | 导出明细与合计对不上 |
| E6 | 行内编辑不同步明细：saveInline 只改 record 不改 electricity_meter_details | `Electricity.tsx:250-270` | 改完度数明细与记录不一致 |
| E7 | 设备导入把第三方 rate(费率档位) 当互感器倍数写 meters.transformer_ratio | `main.py:217-219` | 互感器倍数可能存错 |

### R 组（场地费主线）

| 编号 | 问题 | 证据 | 影响 |
|---|---|---|---|
| R1 | 成本/收入双源：contracts vs rent_leases/rent_incomes 台账，无同步 | `overview.py:41-45` vs `:197-245` | 同一站点两套数 |
| R2 | venue_cost 两种分摊：contract_repo 用实际柜数、dividend_calc 用合同 cabinets_count | `contract_repo.py:75-76` vs `dividend_calc.py:255` | 实际柜≠合同柜时页面与分红对不上 |
| R3 | 首月租只算收入不算成本：品牌方首月用 first_month_rent，场地合同永远 monthly_rent | `dividend_calc.py:76-79` | 首月盈利错配 |
| R4 | 硬编码 Excel 路径：6 层 `..` 指到工作区外，部署即失效 | `rent.py:163-164` | 生产环境 Excel 接口报错 |
| R5 | Excel 站名模糊匹配：双向 includes 可能串台 | `Rent.tsx:242-243` | 相似站名数据串台 |
| R6 | rent_incomes.profit 口径另类：`annual_income_net − input_cost`（进项成本），无页面用 | `rent_repo.py:121` | 落库但没人读 |

### C 组（跨线共用）

| 编号 | 问题 | 证据 | 影响 |
|---|---|---|---|
| C1 | totalCost 覆盖 bug：先算含税费/退款，又被覆盖成不含 → 税费退款从利润消失 | `dividend_calc.py:195` vs `:280-282` | 预估明细"税费行"与"净利润"对不上 |
| C2 | rent_refund 语义可能反了：退款当正成本加入、随后被覆盖丢弃 | `dividend_calc.py:81-88,193-195` | 退款不进利润 |
| C3 | 合同匹配链路不同源：generate 走 station→station.landlord_id→contracts；dividend 走 meters.landlord_id→contracts | `electricity.py:172-176` vs `dividend_calc.py:344-350` | P-D 双源 landlord 的直接后果 |
| C4 | sync_monthly_data 格式不统一：dict 分支直接用 period_key 写 month_period（可能带横线） | `sync_meters.py:336,348` | meter_monthly 可能混入带横线值 |
| C5 | doShareholderExport 列语义错位：把总月租填进"单柜月收入"列 | `Shareholders.tsx:805-814` | 导出表头与数据不符 |
| C6 ✅ | **审批不联动台账状态**：业务规则是「台账付款状态看 approvals 审批了没」，但审批通过只回写 `dividend_records.status`（approval_repo.py:179），**不写** `electricity_records.pay_status`/`contracts.pay_status`/rent 表状态；台账状态目前只来自 generate 默认"未付款" + 手工编辑 | `approval_repo.py:156-181` / `electricity.py:303-305` / `electricity_repo.py:119` | 电费/场地费审批通过后台账仍显示"未付款"，业务上「审批即付款状态」没实现 |

---

### period 双轨影响面分析（E1 实锤验证，2026-08-07）

**运行库实测结果：**

| 表 | 格式 | 实测数量 | 自洽性 |
|---|---|---|---|
| electricity_records | 6位 `202608` | 320 条 | 全 6 位，内部一致 |
| meter_monthly | 6位 `202608` | 225 条 | 全 6 位，内部一致 |
| dividend_records | 7位 `2026-08` | 2 条 | 全 7 位，内部一致 |
| operating_expenses | 7位 `2026-07` | 1 条 | 全 7 位，内部一致 |

**跨表匹配实测：**
- `dividend_records`（7位）直连 `electricity_records`（6位）按 period 匹配 → **2/2 全部落空**（elec_id 为空）
- 用 `replace(period,'-','')` 转换后再匹配 → **2/2 全部命中**（elec_id=905/841）

**影响链：**
1. `dividends.py:79` `get_record_by_station_period(record_id, record["period"])` → 分红记录详情 `dataSources.electricity` **恒为空**（除非 future 恰好 7 位）
2. `stations.py:62` 站点 meter-view 按 7 位查 → 拿不到 generate 写的 6 位台账 → 站点详情付款/收款状态显示默认"未付款/未到账"
3. **同一站点同一月可同时存在 6 位和 7 位两条重复记录**（`database_init.sql:112,135` 有 `UNIQUE(station_id, period)`，但格式不同不算重复）——当前库暂无此情况，一旦 ElecForm 手工入口被用就会产生
4. 前端页面自身分裂：Electricity/Brands/Meters 传 6 位，Stations/Shareholders 传 7 位

**修复方向（推荐）：** 统一为 6 位 `YYYYMM`（与 meter_monthly 天然一致，generate/dividend 都内部转换过了）；建迁移把 dividend_records/operating_expenses 存量转 6 位；代码层收敛为单一格式化函数（前端 MonthPicker 输出、后端入参校验都用它）。备选：全改 7 位，但需改 sync/generate/dividend 三处转换，改动面更大。

---

## 五、建议推进顺序（止血 → 收敛 → 清理）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **第一优先（止血）** | 先跑「零」的三步核验；然后 P2（收敛 landlord 单源）、P1（统一税费/计算引擎）、**E1（period 双轨，已实测影响所有跨表关联）**。这三项直接决定「账对不对」。 | 无 |
| **第二优先（收敛）** | P4（Excel 落库 + 租金定主源）、P3（柜数唯一源）、P6（补列 + 改 UNIQUE）、**E2（修手工新增电费入口）**、**R1（租金双源定主源）**。 | 依赖 P2 选定的 landlord 路径 |
| **第三优先（清理）** | P5（contracts 字段归类）、P7（孤儿代码）、P8（文档）、**E3-E7（电费口径收敛）**、**R2-R6（场地费口径收敛）**、**C1-C5（跨线计算统一）**。 | 依赖 P1 定的统一引擎 |

> 注意顺序：P1/P2/E1 是「先定口径」，P3/P4/R1 是「定主源」，都在动数据语义；建议**每完成一项就回归一次对账**（台账利润 vs 分红净利润），避免多线并发改动后无法定位是谁引入的差异。
>
> 新增的 E/R/C 组建议挂在 P1 之后一起做：**先修 E1(period) → 再修 C1(totalCost 覆盖) → 再修 E4/Q3(按品牌匹配单价)**，这三件是「同一笔账对不上」的最直接原因；E2 顺手可修（单个入口）。

---

## 六、一句话结论

核心逻辑健康，但存在**两套利润计算引擎、同一关系多处存储、租金三处记录**这三大类问题。按本清单先「零核验 → P1 → P2 → P4」，就能把「同一笔账不同入口看到不同数字」的问题先压下去；P6 属于隐藏较深的实锤 bug，建议尽早处理。
