# ① 智慧电表线 — 表结构设计文档

> 状态：**设计完成**（2026-08，本轮只定表结构；不涉及业务代码与 mock 改动）
> 配套建表 SQL：`backend/app/migrations/2026_08_meter_line_clean.sql`
> 关联文档：`THREE_SOURCE_LINES.md`（总纲）、`ELECTRICITY_RATIO.md`（倍率口径）、`METER_API_ACCOUNTS.md`（多账户）、`METER_TAG.md`（标签）

---

## 一、主线定位

**智慧电表线是整个系统的"物理量"来源**：提供每块电表的表码、度数、倍率、实时状态。电费台账、分红、看板的"电量"全部来自这条线。

**关键约束**：第三方平台（天雀 TQ）的接口**只能 GET**，不能 POST/PUT。
→ 系统对第三方永远是"拉"：定时同步 + 手动触发同步，把数据落到**本地缓存表**；业务计算只读本地，不依赖第三方在线可用性。

### 数据流全景

```
天雀 API（只读 GET）
  │  get_devices / get_collectors / get_status / get_electricity_by_hour|day|month|year / get_warnings
  ▼  定时同步（sync_meters.py，遍历 third_party_configs 多账户）
┌────────────────────────────── 缓存层（B，只写不读业务）──────────────────────────────┐
│  meter_devices（设备快照）  meter_collectors（采集器）  meter_status_cache（实时状态） │
│  meter_hourly / meter_daily / meter_monthly / meter_yearly（能耗，原始表码度数）      │
│  meter_warnings_cache（报警）  sync_logs（同步日志）                                  │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │ 导入 / 手工建档（import_meters_from_third_party / Meters 页）
                                       ▼
┌────────────────────────────── 业务档案层（C，业务计算唯一入口）───────────────────────┐
│  meters（电表档案：站点/品牌/场地/主体/倍率/标签）  cabinets（柜子，挂电表下）        │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │ 唯一数据入口（表码×倍率×合同单价 → 电费台账等）
                                       ▼
                              派生层（electricity_records、dividend_records、看板）
```

---

## 二、现状问题核验（本线要解决的"杂乱"）

| # | 问题 | 证据 | 本设计如何处理 |
|---|---|---|---|
| M1 | **电表两套实现**：业务 `meters` 表（electricity/dividend/overview/meter_energy 在用）与 `meter_repo_v2` 直读 `meter_devices`（Meters 页在用）并存；v2 的 station/brand/landlord/entity 全为 NULL | `api/meters.py:2` 引用 `meter_repo_v2`；`meter_repo_v2.py` 全部从 `meter_devices` 读取 | 明确**三层结构**：缓存层与业务档案层分离，Meters 页也应读 `meters`（含业务关联），缓存层只作同步落点 |
| M2 | **`meter_monthly` schema 漂移**：`database_init.sql` 定义 `UNIQUE(address, month_period)`；`sync_meters.py` 写 `device_id/year_month` 并按 `(device_id, year_month)` 冲突更新；`meter_repo_v2.py` 读不存在的 `d0` 列 | 三个文件三套列 | 统一为下方"目标表结构"：**业务唯一键 = (address, month_period)**，`device_id` 仅作溯源列；`year_month`/`d0` 废弃 |
| M3 | **period 格式双轨**：同步写 6 位 `202608`，部分分支/手工入口可能写 7 位 `2026-08` | `sync_meters.py:431` 与 `meter_energy.py:224` | **全系统统一 6 位 `YYYYMM`**；建表加 `CHECK (month_period ~ '^\d{6}$')` 防呆，存量数据迁移见 SQL 对齐段 |
| M4 | **`meters.landlord_id` 双源**：电表存一份、站点存一份 | `DATA_GOVERNANCE.md` P2；迁移 `2026_08_meter_landlord_converge.sql` 已做单次回填 | 固化规则：**`stations.landlord_id` 是唯一真相**，`meters.landlord_id` 是"跟随站点"的冗余列（建/改电表时由站点带出，见 `meter_repo.py:70-78`），不允许与站点不一致 |
| M5 | **原始度数 vs 实际度数**：第三方返回的是表码侧度数，需 ×互感器倍数 才是实际用电量 | `ELECTRICITY_RATIO.md` 全篇 | 规则见 §四.4：缓存表存**原始表码**，`meters.transformer_ratio` 存倍数，业务计算统一"原始 × 倍数"；`actual_kwh` 支持人工修正 |
| M6 | **第三方 `rate` 与业务倍率**：`meter_devices.rate`（第三方 CT 变比）导入为 `meters.transformer_ratio` | `main.py:278` | 两列同义，`rate` 是同步原始值，`transformer_ratio` 是业务侧可人工修正的倍数；导入时复制 |
| M7 | **`meter_daily` 出现未建表列 `date`**：sync 写入 `(device_id, address, date, day_date, ...)` | `sync_meters.py:331` | 统一只用 `day_date VARCHAR(8)`，废弃 `date` |

---

## 三、目标表结构（三层）

> 类型均为 PostgreSQL。金额/度数统一 `NUMERIC`，杜绝浮点误差。
> 通用审计列：`created_at`；同步类表带 `synced_at`（第三方数据最近同步时间）。

### 层 A：第三方接入配置（账户）

#### `third_party_configs` — 第三方接口账户

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| name | VARCHAR(100) NOT NULL | 账户名称（如"默认-合作商电表"） |
| base_url | VARCHAR(200) NOT NULL | 接口地址（api1/api2…） |
| auth_code | VARCHAR(100) NOT NULL | 授权码 |
| meter_tag | VARCHAR(20) NOT NULL DEFAULT '合作商电表' | 该账户设备的电表类型（合作商/民用/共享），导入 meters 时写入 `meters.tag` |
| remark | TEXT | |
| created_at | TIMESTAMP DEFAULT NOW() | |

> 只存账户信息，不存业务数据。同步任务遍历此表逐账户拉取。

### 层 B：第三方数据缓存（同步写入，业务只读）

> 本层所有表**只能由同步任务/手动同步写**；业务代码只 SELECT。
> 缓存表存**第三方原始值**，不做倍率换算（换算在读取/计算处统一做，见 §四.4）。

#### `meter_devices` — 设备快照（电表基础信息）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| device_id | VARCHAR(50) | 第三方内部设备 ID |
| collector_id | VARCHAR(50) | 所属采集器 ID |
| address | VARCHAR(100) **UNIQUE NOT NULL** | **设备地址 = 业务电表号**（与 `meters.meter_no` 一一对应） |
| description | VARCHAR(200) | 设备描述（含品牌信息，如"台铃-xxx"） |
| rate | NUMERIC(10,2) | 第三方互感器倍率（CT 变比） |
| config_id | INTEGER FK → third_party_configs(id) | 来源账户；导入时据此写 `meters.tag` |
| meter_id | INTEGER FK → meters(id) | 已导入业务档案的关联（可空） |
| synced_at | TIMESTAMP | 最近同步时间 |

> 唯一身份 = `address`。同步用 `ON CONFLICT (address) DO UPDATE` 覆盖。

#### `meter_collectors` — 采集器快照

| 字段 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(50) PK | 第三方采集器 ID |
| collector_id | VARCHAR(50) | 采集器编号 |
| description | VARCHAR(200) | |
| device_count | INTEGER DEFAULT 0 | 挂载设备数 |
| raw_data | JSONB | 原始响应（审计/排障） |
| synced_at | TIMESTAMP | |

#### `meter_status_cache` — 实时状态（覆盖式缓存）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| device_id | VARCHAR(50) **UNIQUE NOT NULL** | 第三方设备 ID |
| address | VARCHAR(100) | 设备地址 |
| c0 | NUMERIC(14,2) | 总电量（尖峰平谷合计，第三方口径） |
| c1 / c2 / c3 / c4 | NUMERIC(14,2) | 峰/尖/平/谷分时电量 |
| remain_money | NUMERIC(14,2) | 剩余金额 |
| synced_at | TIMESTAMP | |

> 每 10 分钟覆盖式同步，只保留最新快照。

#### `meter_monthly` — 月度读数（**电费/分红源头，最重要**）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| device_id | VARCHAR(50) | 第三方设备 ID（溯源用，不参与唯一键） |
| address | VARCHAR(100) **NOT NULL** | 设备地址 = `meters.meter_no` |
| month_period | VARCHAR(6) **NOT NULL** | 月份，**统一 6 位 `YYYYMM`**（CHECK 约束） |
| kwh | NUMERIC(14,2) | **原始表码度数**（第三方返回，未乘倍数；同步覆盖） |
| actual_kwh | NUMERIC(14,2) | **本月实际用电量**（人工修正，同步不覆盖；NULL = 按 `kwh × transformer_ratio` 计算） |
| prev_actual_reading | NUMERIC(14,2) | **上月实际电表读数**（人工修正，同步不覆盖；第三方错漏时填真实读数） |
| curr_actual_reading | NUMERIC(14,2) | **本月实际电表读数**（人工修正，同步不覆盖） |
| prev_reading_date | DATE | 起始抄表时间（第三方原始） |
| prev_reading | NUMERIC(14,2) | 起始度数（上月读数，第三方原始，同步覆盖） |
| curr_reading_date | DATE | 本月抄表时间（第三方原始） |
| curr_reading | NUMERIC(14,2) | 抄表度数（本月读数，第三方原始，同步覆盖） |
| raw_data | JSONB | 第三方原始响应 |
| synced_at | TIMESTAMP | |

- **UNIQUE(address, month_period)**：业务唯一键（手动录读数按此键 UPSERT）。
- 辅助索引 `(device_id, month_period)`：同步按设备维度去重查询。
- **人工修正字段不随第三方同步覆盖**：`actual_kwh / prev_actual_reading / curr_actual_reading` 只由人工录读数写入；填了实际读数且未填实际用电量时，系统自动按「本月−上月」计算 `actual_kwh`。
- **废弃列**：`year_month`（与 month_period 重复）、`d0`（早期残留），存量库按 SQL 对齐段处理。

#### `meter_daily` / `meter_hourly` / `meter_yearly` — 能耗统计

| 表 | 周期字段（VARCHAR） | 唯一键 |
|---|---|---|
| meter_daily | `day_date` `YYYYMMDD` | UNIQUE(address, day_date) |
| meter_hourly | `hour_time` `YYYYMMDDHH` | UNIQUE(address, hour_time) |
| meter_yearly | `year_period` `YYYY` | UNIQUE(address, year_period) |

公共列（每张表相同）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| device_id | VARCHAR(50) | 第三方设备 ID（溯源） |
| address | VARCHAR(100) NOT NULL | 设备地址 = `meters.meter_no` |
| kwh | NUMERIC(14,2) | 原始表码度数 |
| raw_data | JSONB | 原始响应 |
| synced_at | TIMESTAMP | |

> `meter_daily` 废弃列：`date`（与 day_date 重复）。

#### `meter_warnings_cache` — 报警缓存（覆盖式）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| device_type | INTEGER | 0=电表, 1=水表, 9=采集器 |
| device_id | VARCHAR(50) | |
| device_address | VARCHAR(100) | |
| warning_def_id | INTEGER | |
| start_time | TIMESTAMP | |
| msg | TEXT | |
| synced_at | TIMESTAMP | |

> 每次同步先清空再写入（现网行为）。辅助索引 `(device_address, start_time)`。

#### `sync_logs` — 同步日志

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| sync_type | VARCHAR(50) NOT NULL | devices/collectors/status/hourly/daily/monthly/yearly/warnings/full |
| status | VARCHAR(20) NOT NULL | success/failed |
| records_synced | INTEGER DEFAULT 0 | |
| error_message | TEXT | |
| started_at | TIMESTAMP DEFAULT NOW() | |
| completed_at | TIMESTAMP | |

### 层 C：业务电表档案（业务计算唯一入口）

#### `meters` — 电表档案

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| meter_no | VARCHAR(100) **UNIQUE NOT NULL** | 电表号 = 第三方设备 `address`（全局身份） |
| meter_name | VARCHAR(200) | 电表名称 |
| collector_id | VARCHAR(100) | 采集器号 |
| transformer_ratio | NUMERIC(10,2) NOT NULL DEFAULT 1 | **互感器倍数**：实际用电量 = 表码 × 倍数 |
| station_id | INTEGER **FK → stations(id) NOT NULL** | 归属站点 |
| brand_id | INTEGER FK → brands(id) | 品牌方（1 电表 = 1 品牌方，派生收款单价） |
| landlord_id | INTEGER FK → landlords(id) | 场地方（**跟随站点单源**，见 §四.3） |
| entity_id | INTEGER FK → entities(id) | 报税公司主体 |
| tag | VARCHAR(20) NOT NULL DEFAULT '合作商电表' | 合作商电表/民用电表/共享电表 |
| status | VARCHAR(20) NOT NULL DEFAULT '正常' | 正常/停用等 |
| remark | TEXT | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | 审计列（原表缺失，本设计补齐） |

> 索引：`(station_id)`、`(landlord_id)`、`(brand_id)`、`(entity_id)` 各建普通索引，支撑按维度联表。
> 来源：① 第三方设备导入（`import_meters_from_third_party`）；② 手工建档（Meters 页）。两条路径都要求 `meter_no` 全局唯一。

#### `cabinets` — 柜子（物理资产，挂在电表下）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | |
| meter_id | INTEGER **FK → meters(id) NOT NULL** | 所属电表 |
| cabinet_no | VARCHAR(100) | 柜号 |
| cabinet_type | VARCHAR(50) DEFAULT '普通柜' | 充电柜/储电柜等 |
| brand_id | INTEGER FK → brands(id) | 品牌（可空） |
| remark | TEXT | |
| created_at | TIMESTAMP DEFAULT NOW() | |

> 柜数是"合同线"的派生输入（品牌方合同计费柜数 = 实时统计 `meters→cabinets`，见总纲 ② 线计划）。

---

## 四、口径规则（本线核心约定）

### 4.1 电表全局身份
- `meters.meter_no` 是电表的**全局唯一身份**，恒等于第三方设备 `meter_devices.address`。
- 所有缓存表都以 `address` 关联业务电表：`cache.address = meters.meter_no`。
- 手工新增电表也必须满足 meter_no 唯一；第三方设备导入时按 `address NOT IN meters.meter_no` 增量导入（`main.py:230` 现逻辑保留）。

### 4.2 三层职责与写入权限
| 层 | 表 | 谁能写 | 谁能读 |
|---|---|---|---|
| A 配置 | third_party_configs | 人工（Directory 页） | 同步任务 |
| B 缓存 | meter_* / sync_logs | 仅同步任务（GET 拉取） | 业务只读 |
| C 档案 | meters / cabinets | 人工 + 设备导入 | 所有业务计算 |

> 业务代码**禁止**绕过 `meters` 直接读缓存表做金额计算（M1 的修复方向）。

### 4.3 landlord 单源（M4）
- **唯一真相**：`stations.landlord_id`。
- `meters.landlord_id` 是冗余便捷列：建/改电表时由站点带出并强制写入（站点已配场地方时，表单传什么都没用）。
- 校验 SQL（应恒为 0 行）：
  ```sql
  SELECT m.id, m.meter_no FROM meters m
  JOIN stations s ON m.station_id = s.id
  WHERE s.landlord_id IS NOT NULL
    AND m.landlord_id IS DISTINCT FROM s.landlord_id;
  ```

### 4.4 度数口径（M5/M6）：原始表码 vs 实际度数
```
实际用电量 = 表码度数 × transformer_ratio
```
- `meter_monthly.kwh`（及 daily/hourly/yearly）**永远存原始表码度数**，不做换算。
- `meters.transformer_ratio` 存倍数（第三方导入时复制 `meter_devices.rate`，人工可修正）。
- 业务计算统一规则（与 `ELECTRICITY_RATIO.md` 已实施口径一致）：
  1. `actual_kwh IS NOT NULL` → 用 `actual_kwh`（人工修正优先）；
  2. 否则 → `kwh × transformer_ratio`。
- 手动录读数（`meter_energy.py /readings`）：写原始 `kwh`（由起止表码相减），如用户直接填实际度数则写 `actual_kwh`。

### 4.5 period 统一 6 位（M3）
- 所有月份字段（`meter_monthly.month_period`、后续 `electricity_records.period`、`dividend_records.period`、`operating_expenses.period`）**统一 `YYYYMM`**。
- 建表加 `CHECK (month_period ~ '^\d{6}$')`；存量 7 位数据按 SQL 对齐段清洗。

### 4.6 只 GET 的同步纪律
- 第三方接口只能 GET：系统**不向第三方回写任何数据**（不写读数、不控闸）。
- 读数是**本地** meter_monthly 的字段，人工录读数 = 改本地缓存，与第三方无关（第三方下次同步会覆盖同键行，属预期）。

---

## 五、与派生表的衔接（本线数据去向）

| 派生表/接口 | 读本线哪些表 | 公式 |
|---|---|---|
| `electricity_records` + `electricity_meter_details`（电费台账） | meters（station/brand/landlord/entity/倍数）、meter_monthly（度数） | 度数 × 合同单价（合同线） |
| `dividend_records`（分红月结） | meters（landlord 匹配）、meter_monthly（度数） | 收入 − 成本，按分红配置（③ 线） |
| 看板聚合（overview / station-board / brand-board） | meters、meter_monthly/daily | SUM(度数 × 倍数) |
| 站点详情用电（Stations meter-view） | meters、meter_daily/monthly | 同上 |
| 合同表单柜数（② 线） | meters → cabinets | COUNT(cabinets) |

> 所有派生消费点只依赖 §三 的目标结构；本线改造后派生代码**无需感知缓存层**。

---

## 六、建表 SQL 说明

- 文件：`backend/app/migrations/2026_08_meter_line_clean.sql`
- **建表顺序**：因 `meter_devices` 外键引用 `meters`，SQL 内按 层A(配置) → 层C(档案) → 层B(缓存) 排列（层 B 缓存表之间无外键，顺序不影响）。
- **全新安装**：直接执行（`CREATE TABLE IF NOT EXISTS` 幂等），可作为 `database_init.sql` 电表线部分的替代/基准。
- **存量库对齐**：SQL 后半段提供非破坏性 `ALTER TABLE ADD COLUMN IF NOT EXISTS` + 数据清洗（period 去横线、倍率回填等）；破坏性废弃列（`year_month`/`d0`/`date`）给出**核对 + 迁移**脚本，确认无引用后执行。
- 执行顺序：先备份 → 执行 SQL → 跑核对 SQL → 确认 0 异常。

## 七、遗留（本轮不动，后续线处理）

1. Meters 页读 `meter_repo_v2`（直读缓存层）→ 应在实施轮切到读 `meters` 业务档案（M1 落地）。
2. `sync_meters.py` 的 `ON CONFLICT (device_id, year_month)` → 切到 `(address, month_period)`（M2 落地）。
3. `database_init.sql` 电表线段落 → 用本文件替换为基准（避免双源漂移再次发生）。
