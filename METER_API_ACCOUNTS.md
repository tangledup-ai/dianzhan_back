# 第三方接口配置（多账户）+ 电表类型 —— 分析设计方案

> 状态：**已确认，已实施**（2026-08-09）
> 日期：2026-08-09
> 背景：meters 页面自动从第三方平台拉取电表基础信息，目前只有一个账户（api1 + 5ec0b6bf）。用户还有其他账户：不同账户除「请求地址 + 授权码 + 电表类型」外，其余（含返回数据结构）完全一致。

## 1. 现状（单账户）

```
第三方 API (TQ_API_URL=api1 + TQ_AUTH_CODE=5ec0b6bf)
  │ sync_devices()/sync_collectors()/sync_status()/能耗/报警    每 6h/10min/… 定时
  ▼
meter_devices 缓存表 (64 条) + meter_collectors + meter_status_cache + meter_hourly/daily/monthly/yearly + meter_warnings_cache
  │ import_meters_from_third_party()   (main.py:166，手动触发)
  ▼
meters 表 (65 块，tag=合作商电表)
```

- 同步全部走**全局单例** `tq_client = TQMeterClient()`（`meter_api.py:161`），URL/auth 来自 `config.py` 环境变量，**无法按账户区分**。
- `meter_devices` 表无「账户/类型」列，导入 meters 时 tag 固定写死/留空。

## 2. 需求

1. **Directory 新增「第三方接口配置」档案**：可新增/编辑/删除，字段：
   - 账户名称（如：合作商账户、民用账户）
   - 接口地址（base_url，如 `https://api1.tqdianbiao.com` / `https://api2.tqdianbiao.com`）
   - 授权码（auth_code）
   - 电表类型（= meters 表的 tag：合作商电表 / 民用电表 / 共享电表）
   - 备注
2. **多账户同步**：同步逻辑遍历所有配置账户，每个账户用各自的 URL/auth 拉设备；导入 meters 时自动带上该账户的「电表类型」标签。

## 3. 设计方案

### 3.1 存储

**新表 `third_party_configs`**：

```sql
CREATE TABLE IF NOT EXISTS third_party_configs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,          -- 账户名称
    base_url VARCHAR(200) NOT NULL,      -- 接口地址
    auth_code VARCHAR(100) NOT NULL,     -- 授权码
    meter_tag VARCHAR(20) DEFAULT '合作商电表',  -- 电表类型（与 meters.tag 同义）
    remark TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

**`meter_devices` 加一列**（记录设备来源账户 → 导入时映射电表类型）：

```sql
ALTER TABLE meter_devices ADD COLUMN IF NOT EXISTS config_id INTEGER REFERENCES third_party_configs(id);
```

### 3.2 后端改造

| 文件 | 改动 |
|---|---|
| `database_init.sql` | 加 `third_party_configs` 建表 + `meter_devices.config_id` |
| `config.py` | `TQ_API_URL/TQ_AUTH_CODE` 保留作为**兜底默认**（配置表为空时用），不删 |
| `infra/meter_api.py` | `TQMeterClient.__init__` 支持传 `base_url`/`auth_code` 参数，默认回退 config |
| `repositories/directory_repo.py` | `list/create/update/delete` 第三方配置 CRUD（参照 brand/entity 写法） |
| `api/directory.py` | 挂 `/api/directory/third-party-configs` CRUD 路由 |
| `jobs/sync_meters.py` | **所有同步函数遍历配置**：从 `third_party_configs` 读全部账户 → 每个账户新建 client 拉数据；`sync_devices` 写 meter_devices 时带 `config_id` |
| `jobs/scheduler.py` | 同步逻辑已包在 sync_* 内，遍历自动生效，无需改调度 |
| `main.py` | `import_meters_from_third_party`：导入时按 `config_id → meter_tag` 写 `meters.tag` |
| `meter_energy.py` | `trigger_sync` 无需改（走 sync_* 函数） |

**关键点**：能耗/状态/报警同步（hourly/daily/monthly/yearly/status/collectors/warnings）也遍历账户，否则只有第一个账户有能耗数据。

### 3.3 前端改造

| 文件 | 改动 |
|---|---|
| `src/api/directory.ts` | 加 `listThirdPartyConfigs/createThirdPartyConfig/updateThirdPartyConfig/deleteThirdPartyConfig` |
| `src/pages/Directory.tsx` | 新增 Tab「第三方接口配置」；因含**下拉（电表类型）**，写一个专用子组件（复用 CrudTable 的话列需支持 select） |

### 3.4 数据准备

- **预置一条默认账户**：名称「默认-合作商电表」，base_url=api1，auth=5ec0b6bf，tag=合作商电表（幂等插入）。
- 已有 64 条 `meter_devices` 的 `config_id` 回填到该默认账户。

## 4. 已确认决策（2026-08-09 用户拍板）

- **Q9-1 加「测试连接」按钮**：Directory 配置旁加「测试」按钮，调该账户 `/Api/Meter` 验证 URL/auth 是否连通，失败提示原因。
- **Q9-2 预置默认账户**：自动预置「默认-合作商电表」（api1+5ec0b6bf），存量 meter_devices 回填归属。

## 4.1 待确认（实施前可补）

- 无（本次范围已确认：完整多账户同步 + 名称字段 + 测试按钮）

## 5. 影响面

- 新增表/列：`third_party_configs`、`meter_devices.config_id`
- 同步与导入是**增量不破坏**：配置表为空 → 回退到 config.py 默认（旧行为）；有配置 → 遍历所有账户。
- `meters.tag` 已在上一需求落地，本次只是把它和账户绑定。

## 6. 实施结果（已落地）

- **schema**：`third_party_configs` 表 + `meter_devices.config_id` 列（已建 + database_init.sql 更新）；预置「默认-合作商电表」账户（api1+5ec0b6bf），存量 64 条设备回填 config_id。
- **后端**：
  - `meter_api.py`：`TQMeterClient(base_url, auth_code)` 参数化，默认回退 config；
  - `directory.py` + `directory_repo.py`：`/api/directory/third-party-configs` CRUD + `/test` 测试连接（调该账户 `/Api/Meter`）；
  - `sync_meters.py`：新增 `get_account_configs()`，所有同步函数（devices/collectors/status/hourly/daily/monthly/yearly/warnings）遍历所有账户，sync_devices 写 config_id；
  - `main.py import_meters_from_third_party`：按 config_id → meter_tag 写 `meters.tag`。
- **前端**：`directory.ts` 加配置 API；`Directory.tsx` 加「第三方接口配置」Tab（账户名称/接口地址/授权码/电表类型下拉/备注 + 测试连接按钮 + 编辑/删除）。
- **验证**（2026-08-09 真机）：
  - py_compile / tsc 通过；前后端容器已重建重启。
  - 配置 CRUD 正常；「测试连接」对正确 token 返回 49 台设备、错误 token 返回 HTTP 400「连接失败: 授权码为空」。
  - 多账户同步：触发 devices 同步遍历 2 个账户，meter_devices = 64(账户1) + 49(账户2) = 113 条。
  - 导入：49 台民用设备导入 meters（tag=民用电表），新增 48 个站点（原 65→113 个站点，由 import 自动建站）。最终 meters = 65 合作商 + 49 民用。
  - 配置列表：[1] 默认-合作商电表(api1) / [2] 民用账户(api2, 民用电表)。
  - 用户已确认：api2 的 49 台设备 + 48 个新站点为**真实数据**（电表属性为民用电表），**保留**。
