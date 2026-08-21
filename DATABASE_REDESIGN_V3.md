# 数据库改造 v3 — 去掉「站点」层，场地直挂电表

> 状态：**进行中**（用户确认方案 B：场地方 → 智慧电表 直挂，无站点层）
> 原则：每阶段先备份、可验证、不破坏 Meters 第三方数据（meter_devices/meter_monthly/能耗缓存/meters 本体不动）。

---

## 一、目标模型（v2 → v3）

```
v2：场地方(landlord) → 站点(station，= 场地×品牌) → 电表(meters)
v3：场地方(landlord) ───────────────────────────────→ 电表(meters)   ← 电表直挂 landlord_id + brand_id
        ├── 合同(contracts.landlord_id)
        ├── 电费台账(electricity_records.landlord_id + brand_id)      ← 每 场地×品牌×月 一条
        ├── 运营费用(operating_expenses.landlord_id)
        ├── 分红记录(dividend_records.landlord_id + brand_id)         ← brand_id 空=整场地分红，非空=品牌分红
        └── 分红配置(landlord_shareholder_configs / landlord_introducer_configs.landlord_id + brand_id)
```

关键语义（用户确认）：
- **每个智慧电表关联唯一场地**（meters.landlord_id，已存在）。
- **分红分两种**：① 分整个场地（brand_id 为空）；② 分到某个品牌（brand_id 非空）——与现有 configs 的 brand_id 语义一致，只是挂载点从站点换成场地。

---

## 二、表结构变更清单

| 表 | 变更 |
|---|---|
| `meters` | **表不变**（landlord_id/brand_id 已有）；后端不再用 station_id |
| `electricity_records` | 加 `landlord_id` + `brand_id`；唯一键改 `(landlord_id, brand_id, period)`；station_id 待后端改完后删 |
| `electricity_meter_details` | 不变（电表级） |
| `operating_expenses` | 加 `landlord_id`；唯一键改 `(landlord_id, period)` |
| `dividend_records` | 加 `landlord_id` + `brand_id`（空=整场地，非空=品牌） |
| `dividend_shares` | 不变（有 brand_id） |
| `station_shareholder_configs` → **`landlord_shareholder_configs`** | station_id → landlord_id；brand_id 保留；唯一键改 landlord |
| `station_introducer_configs` → **`landlord_introducer_configs`** | 同上（+count_as_cost） |
| `approval_requests` | 加 `landlord_id`（station_id 保留过渡） |
| `stations` | 废弃（阶段 4 删除） |
| 视图 | `landlord_monthly_summary` 改用 landlord/brand 直连（阶段 2 改） |

---

## 三、数据迁移映射（5 个实站 → 场地+品牌）

| 站点 | station_id | 场地 landlord | 品牌 brand |
|---|---|---|---|
| 台铃-螺狮湾站 | 2 | 螺蛳湾(4) | 台铃(2) |
| 八维通-871文创园站 | 3 | 文创园(7) | 八维通(3) |
| 台铃-官南大道站 | 13 | 官南大道(5) | 台铃(2) |
| 八维通-螺蛳湾站点 | 20 | 螺蛳湾(4) | 八维通(3) |
| 八维通-官南大道站 | 26 | 官南大道(5) | 八维通(3) |

映射规则：`station → stations.landlord_id`；品牌 = 该站实表电表的品牌（5 站单一品牌，SQL 取 MIN 防多品牌）。

迁移对象：electricity_records / operating_expenses / dividend_records / 两张配置表 / approval_requests。

---

## 四、分阶段实施计划

| 阶段 | 内容 | 验证 |
|---|---|---|
| **① 表结构 + 数据迁移**（已完成） | 备份 → 加列 → 迁移数据 → 建 landlord_* 配置表并迁移 → 改唯一键 | 行数核对、映射正确 |
| **② 后端改造**（已完成） | generate / dividend_calc / electricity / dividends / rent / approval / overview 已 landlord 化；mp_snapshot / mp_finance 进行中 | py_compile + 台账重算 + 实库验证 |
| **③ 前端改造**（已完成主要） | Shareholders 页已按场地；Stations 页已改「场地→品牌电表」视图；其余页面显示层已适配 landlord | tsc 通过 |
| **④ 收尾**（待做） | 删 stations 表、删 station_id 残留列、清理 StationForm/StationDrawer/ElecForm/RentForms 站点表单、更新文档 | 全量编译 |

---

## 五、风险与保护

1. **每阶段先备份**（受影响表 dump 成 SQL）。
2. Meters 第三方数据（meter_devices / meter_monthly / 能耗缓存 / meters 本体）**全程不动**。
3. 表结构先"加列 + 迁移"，**station_id 列和 stations 表保留到后端/前端改完再删**（避免中途断链）。
4. 配置表用"建新表 + 迁移 + 删旧表"，改名立即可见。
