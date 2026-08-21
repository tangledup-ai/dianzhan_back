# 手动录入用电量 + 「实际值」字段 —— 现状分析与设计

> 状态：**语义已确认，已实施并验证完成**
> 日期：2026-08-09

## 1. 需求 1：新建智慧电表 + 手动填用电量 —— 现状检查

### 当前已实现的链路
1. **新建电表**（`Meters.tsx` MeterForm）→ `POST /api/meters` → `meters` 表。字段：场地方/站点/品牌/报税主体/电表编号/名称/采集器号/**互感器倍数（默认1）**/备注。保存后自动生成当月电费。
2. **录入读数**（`Meters.tsx` ReadingForm）→ `POST /api/meter-energy/readings`（`meter_energy.py save_meter_reading`）→ upsert `meter_monthly`。字段：月份/区间度数 kwh/起始度数/抄表度数/起止时间。**kwh = 抄表 − 起始**（可自动计算）。
3. 录入保存后自动重算该站点当月台账。

### 关键语义（现状）
- `meter_monthly.kwh` 存的是**原始表码区间度数**（不乘倍数）；
- 实际用电量 = kwh × 互感器倍数，在**读取/计算处**统一乘（Stations/台账/分红/看板/小程序）。

### 检查发现的问题
| # | 问题 | 影响 |
|---|---|---|
| P1 | 手动录入的 kwh 是**原始区间度数**，要再乘倍数。表单占位符写「抄表度数-起始度数」，容易让用户误以为是最终电量 | 用户填了自认的"电量"，系统再×倍数 → 数值 40~100 倍放大。**这是需求 2 要解决的根因** |
| P2 | `save_meter_reading` 不校验电表是否存在，只按 address 写 | 输错编号会生成孤儿 meter_monthly 行，各页面 JOIN meters 取不到 |
| P3 | 新电表若挂在**无 landlord 的站点**，台账 generate 按 landlord 匹配合同拿不到单价 | 金额为 0/无记录（数据依赖，非代码 bug） |
| P4 | 建表/录读数保存都会**自动重算台账**，会覆盖用户手工改过的台账值 | 若用户手动调过台账金额，重算会覆盖 |

## 2. 需求 2：「实际值」字段设计

### 业务规则（用户提出）
> 每个电表增加一个「实际值」字段：为空 → 用现有的「区间值×倍数」计算；填写了 → 优先用实际值。

### 存储设计（建议）
- 实际值按**电表 × 月份**粒度存：`meter_monthly.actual_kwh NUMERIC(14,2) NULL`（不同月可以不同实际值）。
- 录入位置：**读数录入表单**（ReadingForm）增加一个「实际值（可选）」输入框，与月份对应。
- 语义：**实际值 = 最终用电量**（已含倍数口径）。填写后各计算处直接用它，不再 × 倍数。

### 优先级规则（各计算处统一）
```
最终用电量 = actual_kwh  若 actual_kwh 非空
           = round(kwh × transformer_ratio, 2)  否则（现状逻辑）
```

### 影响面（所有计算用电量的地方）
| 位置 | 改动 |
|---|---|
| `meter_monthly` 表 | 加列 `actual_kwh`（+ database_init.sql） |
| `meter_energy.py save_meter_reading` | 接受并保存 actualKwh |
| `meter_energy.py /monthly` | 返回 actualKwh（表单回填/展示） |
| `electricity.py generate` | kwh → `actual_kwh ?? round(kwh×ratio,2)` |
| `stations.py meter-view` | 本月/上月度数 → 同上 |
| `overview.py` 各接口 | SQL：`COALESCE(mm.actual_kwh, ROUND(mm.kwh×ratio,2))` |
| `dividend_calc.py` | kwh → 同上 |
| `mp_snapshot.py` | 同上 |
| `meters.py usage` | 同上 |
| `Meters.tsx ReadingForm` | 增加「实际值」输入框 + 保存 + 回填 |

## 3. 已确认决策（2026-08-09 用户拍板）
1. **实际值语义** = **已含倍数的最终电量**。填了就完全用它，不再 × 倍数。
2. **存储粒度** = **按电表×月份**，存 `meter_monthly.actual_kwh`，在读数录入表单里按月填。

## 4. 实施结果（已落地并验证）
- **schema**：`meter_monthly.actual_kwh NUMERIC(14,2) NULL`（已 ALTER + 更新 database_init.sql）。
- **后端**（优先级 = `actual_kwh ?? round(kwh×ratio,2)`）：
  - `meter_energy.py`：`save_meter_reading` 接受/保存 `actualKwh`；`/monthly` 与 `/station` 返回 actualKwh，kwh 用实际值优先；/monthly 仍返回 raw_kwh 供编辑回填。
  - `electricity.py generate`：有实际值直接用它。
  - `stations.py`、`overview.py`、`mp_snapshot.py`、`dividend_calc.py`、`meters.py`：全部 actual 优先。
- **前端**：`Meters.tsx` ReadingForm 增加「实际值（可选）」输入框，保存/回填；读数月份列表有实际值的月份打 ★；`meterEnergy.ts` MeterReadingData 加 actualKwh。
- **验证**（台铃表 7月 raw 7206.4×40=288256）：设 actual=300000 → generate/meter-view/station-board 全部用 300000；还原 NULL 后恢复 288256，无残留。

## 5. 注意事项
- 前端容器需重建才能看到新输入框：`docker compose up -d --build frontend`（或 rebuild + up）。
- 实际值只作用于「月」维度；日/小时能耗展示仍为「表码×倍数」，不受实际值影响。
- 录了实际值后，各计算处（台账/Stations/分红/看板/小程序）会优先用实际值；改回留空即恢复区间值×倍数。
