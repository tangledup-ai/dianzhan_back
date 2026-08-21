# 电表「标签」属性 —— 分析

> 状态：**已确认，已实施并验证**（2026-08-09）
> 日期：2026-08-09

## 1. 需求

> 当前 meters 页面获取到的电表都是「合作商电表」。需要给每块电表增加一个「标签」属性，可下拉选择，包含三种：
> 1. **合作商电表**（现状，默认）
> 2. **民用电表**
> 3. **共享电表**

## 2. 现状检查

- `meters` 表（65 行）无任何类型/标签字段；所有电表本质都是「合作商电表」。
- 现有相关字段：`status VARCHAR(20) DEFAULT '正常'`、`transformer_ratio`、`meter_name` 等。
- 前端 `Meters.tsx`：`MeterForm`（新增/编辑弹窗）有场地方/站点/品牌/报税主体/编号/名称/采集器号/倍数/备注，**无标签选择**；`MeterCard` 头部显示 `meterNo + brandName + StatusBadge`，**无标签展示**。
- 后端 `meter_repo.py`：`create_meter` 固定 INSERT 列，`update_meter` 用 `field_map` 白名单映射，`list_meters/get_meter` 用 `SELECT m.*`（新列自动带出）。

## 3. 设计

### 3.1 存储（建议）

在 `meters` 表加一列：

```sql
ALTER TABLE meters ADD COLUMN IF NOT EXISTS tag VARCHAR(20) DEFAULT '合作商电表';
```

- 值直接存中文标签（与 `status='正常'`、`cabinetType='充电柜/储电柜'` 的既有习惯一致），下拉三选：`合作商电表 / 民用电表 / 共享电表`。
- `DEFAULT '合作商电表'`：存量 65 块全部默认归为合作商电表，无需逐条刷数据。

### 3.2 后端改动

| 文件 | 改动 |
|---|---|
| `backend/app/repositories/meter_repo.py` | `create_meter` INSERT 加 `tag`；`update_meter` field_map 加 `"tag": "tag"` |
| `database_init.sql` | `meters` CREATE TABLE 加 `tag VARCHAR(20) DEFAULT '合作商电表'` |

> `list_meters/get_meter` 用 `SELECT m.*`，新列自动返回，前端 camelCase 转换后为 `tag`。

### 3.3 前端改动

| 文件 | 改动 |
|---|---|
| `src/pages/Meters.tsx` | `MeterForm` 加「标签」下拉（三选，默认合作商电表）；`MeterCard` 头部在品牌名旁显示标签徽标；表单 blank/回填/提交带 `tag` |
| `src/pages/Meters.tsx`（导出） | 导出 Excel 加「标签」列 |

## 4. 已确认决策（2026-08-09 用户拍板）

- **Q8-1 标签仅作信息属性**：不参与台账/分红/看板计算，所有电表照常参与计算。
- **Q8-2 页面加「按标签筛选」下拉**：meters 页顶部加标签筛选。

## 5. 实施结果（已落地并验证）

- **schema**：`meters.tag VARCHAR(20) DEFAULT '合作商电表'`（已 ALTER + 更新 database_init.sql），存量 65 块默认归「合作商电表」。
- **后端**：`meter_repo.py` create_meter INSERT 加 tag（默认合作商电表）、update_meter field_map 加 tag；list/get 用 `SELECT m.*` 自动返回。
- **前端** `Meters.tsx`：
  - MeterForm 新增「标签」下拉（合作商电表/民用电表/共享电表，默认合作商电表），新增/编辑/提交均带 tag；
  - MeterCard 头部在品牌名旁显示标签徽标（合作商=蓝 / 民用=黄 / 共享=紫）；
  - 页面顶部加「全部标签」筛选下拉；
  - 导出 Excel 加「标签」列。
- **验证**：tsc --noEmit 通过；前端容器重建后生效。
