# 互感器倍数（transformer_ratio）应用规则 —— 影响面分析

> 状态：**业务规则已确认，改动范围 B+C+D 已实施并验证完成**
> 日期：2026-08-09

## 1. 业务规则（用户已确认）

> **实际用电量 = 表码度数（meter_monthly.kwh / meter_daily.kwh） × 互感器倍数（transformer_ratio）**

第三方平台（天雀）返回的是**表码侧度数**（`d[0]`，未折算），同时每台设备带 `rate` 字段 = 互感器倍率（CT 变比）。

### 真实数据（本机库 2026-08 查询）

| 表 | 总数 | 互感器倍数分布 |
|---|---|---|
| `meter_devices`（第三方同步） | 64 | 全部 ≠ 1：47×40、15×50、1×80、1×100 |
| `meters`（业务电表） | 66 | 1 台 = 1；48×40、15×50、1×80、1×100；**TEST-001 也被填了 40** |

- 66 台中 **65 台倍数 ≠ 1**，意味着不用倍数直接算，电费会差 **40~100 倍**。
- `meters.transformer_ratio` 与第三方 `meter_devices.rate` 一致的有 64/66 台。
- `meters.transformer_ratio` 的写入来源：
  - 第三方设备自动导入 `main.py:218-220`（`INSERT ... transformer_ratio ... VALUES (..., d["rate"])`）
  - 电表管理页手动填 `Meters.tsx:547`（默认 1）

## 2. 当前各消费点的处理情况

### A. 已经乘了倍数（正确，勿动）
| 位置 | 说明 |
|---|---|
| `api/electricity.py:239-241`（generate 自动生成台账） | `actual_kwh = round(kwh * ratio, 2)` ✅ 台账方向是对的 |

### B. 没乘倍数 → 涉及电费/分红金额计算，**必须改**
| 位置 | 影响 |
|---|---|
| `api/overview.py:351-363, 366, 374`（station-board） | **Stations 主表** 总度数/各站度数、电费付款/收款 → 差 40~100 倍 |
| `api/stations.py:228, 230, 237-240, 266, 301`（meter-view） | **Stations 站点详情** 本月/上月抄表度数、付款/收款金额 |
| `api/overview.py:520-528`（landlord-trends） | 场地方近 N 月趋势（电费收支/利润） |
| `api/overview.py:610-617`（landlord-station-monthly） | 场地方分月分站利润 |
| `domain/dividend_calc.py:393-401`（_get_meter_kwh） | **分红计算** 电费收入/成本/税 → 直接影响股东/商务分红金额 |

### C. 没乘倍数 → 总览/展示，建议一并改（跟"总电量"口径统一）
| 位置 | 说明 |
|---|---|
| `api/overview.py:42`（/overview） | 首页/看板 总电量 total_kwh |
| `api/overview.py:97-100`（/overview） | 首页 月度趋势 kwh |
| `api/overview.py:160`（/monthly-detail） | 首页 某月明细 total_kwh |
| `api/mp_snapshot.py:51-59, 74-102, 151-167, 204-246` | 小程序 月/季/年电量、站点电量、异常判断 |

### D. 没乘倍数 → 原始能耗展示（**需决策**：保持原始表码，还是也乘成实际度数）
| 位置 | 说明 |
|---|---|
| `api/meter_energy.py:33, 105, 150-168` | 电表能耗查询（日/月，图表用） |
| `api/meters.py:34, 57` | 单表月度读数 |
| `api/stations.py:273-274` | 站点详情里的"用电量数据"卡片（日用电量、近 6 个月） |

### E. 无需改（比值不变，乘不乘结果一样）
| 位置 | 说明 |
|---|---|
| `api/alerts.py:41-58, 77-100` | 异常判断 current/avg，分子分母同乘同倍率，约掉 |

### F. 前端导出（间接受影响，依赖后端返回值）
| 位置 | 说明 |
|---|---|
| `src/pages/Entities.tsx:369, 388` | 导出只把 `transformerRatio` 当列显示，度数直接取 meter-view 返回值；**改了后端后自动正确** |
| `src/pages/Electricity.tsx:309-363` | 导出度数取台账 kwh（已乘），正确 |

## 3. 建议方案

**原则：`meter_monthly`/`meter_daily` 保持存原始表码度数不动，在各业务读取/计算处统一乘 `transformer_ratio`**（与 generate 台账现做法一致，避免二次相乘）。

改造方式（统一收口）：
- `overview.py` 各 SQL：`SUM(mm.kwh)` → `SUM(mm.kwh * COALESCE(m.transformer_ratio, 1))`（这几个 SQL 都已 JOIN meters m，字段现成）
- `stations.py` meter-view：`this_month_kwh = float(mm["kwh"]) * meter.transformer_ratio`（per-meter，meters 已含该字段）
- `dividend_calc.py` `_get_meter_kwh`：meters 查询补 `transformer_ratio`，kwh × ratio
- 如做 C/D：Dashboard 与小程序、能耗展示同样乘，口径统一

## 4. 实施结果（2026-08-09 已完成）

**已确认范围：B + C + D 全改；generate 排除 TEST。**

改动清单（实际用电量 = 表码 × `transformer_ratio`，`meter_monthly`/`meter_daily` 仍存原始表码）：

| 文件 | 改动 |
|---|---|
| `api/overview.py` | station-board 总度数/各站度数、landlord-trends、landlord-station-monthly、/overview 总电量+月度趋势、/monthly-detail：`SUM(mm.kwh)` → `SUM(ROUND(mm.kwh × ratio, 2))`，排除 TEST |
| `api/stations.py` | meter-view：`this_month_kwh`/`prev_month_kwh` × ratio；`dailyEnergy`/`monthlyEnergy` 展示同步 × ratio |
| `domain/dividend_calc.py` | `_get_meter_kwh`：补 `transformer_ratio`，kwh × ratio，排除 TEST |
| `api/meter_energy.py` | daily/hourly/monthly/station 返回实际度数；**/monthly 额外返回 `raw_kwh` 供读数编辑回填**，避免二次相乘 |
| `api/meters.py` | `/meters/{id}` usage.monthly 实际度数 |
| `api/mp_snapshot.py` | 小程序月/季/年电量、月度趋势、站点电量、异常判断全部 × ratio，排除 TEST |
| `api/electricity.py` | generate 排除 TEST 电表（原有 × ratio 不变） |
| `src/pages/Meters.tsx` | 读数编辑表单改用 `rawKwh` 回填 |

**验证**（202608 台账月，Stations 口径 vs 台账 pay_kwh）：
- 量级已完全对齐：原始 1394.5 → ×40 = 69725 = 台账 pay。
- 少量站点仍有微小差异（如 92208 vs 92176），原因：**台账是生成时的快照**，`meter_monthly` 在生成后被每日同步更新（如站点 29 台账用 2569×100=256900，最新同步 2570×100=257000）。**与代码无关**，重跑「自动生成」后即对齐。

## 5. 遗留说明

- **台账快照性**：Electricity 页显示的是生成时刻的值；要保证和 Stations 实时一致，每次同步/改读数后需重跑「自动生成」。
- `Entities.tsx` 导出中 `区间度数 = endReading - prevEndReading` 语义仍存疑（两月消耗相减），未在本次范围内处理。
- TEST-001 电表被填了倍数 40 且未挂在正式站点下；generate 现已排除 TEST。
