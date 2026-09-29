# huandian_v2 → huandian_v5 迁移报告

> 执行时间：2026-09-26　　执行人：AI（主人睡觉期间，按 `METER_DOMAIN_V5.md` 口径自行判断）
> 脚本：`backend/app/migrate_v2_to_v5.sql`（幂等，可重复执行）
> 建库脚本：`backend/app/database_init_v5.sql`

---

## 0. 环境

| 项 | 值 |
|---|---|
| PG 容器 | `postgres-quant`（postgres:16-alpine） |
| 连接 | `postgresql://quant:***@127.0.0.1:5432/huandian_v5` |
| ⚠️ 注意 | 容器此前是**停止状态**，本次已启动（Up） |
| 源库 | `huandian_v2`（保持原样未改动） |

---

## 1. 迁移范围

### 1.1 ✅ 迁移（结构 + 真实数据）

| 域 | 表 | 行数 |
|---|---|---|
| 档案 | brands / entities / landlords / landlord_owners / shareholders / introducers / entity_brands / platform_users | 17 / 7 / 49 / 34 / 5 / 1 / 0 / 5 |
| 电表 | **meters** / **cabinets** / meter_entity_changes | **126** / **170** / 3 |
| 接入 | third_party_configs / meter_devices / meter_collectors / meter_status_cache | 2 / 127 / 127 / 127 |
| **读数** | **meter_readings**（原 meter_monthly） | **711**（743 中 32 行无法对应电表） |
| 缓存 | meter_daily / meter_hourly / meter_yearly / meter_warnings_cache / sync_logs | 9201 / 67124 / 153 / 1 / 3746 |
| 合同 | **contracts** / contract_audit_log | **19** / 212 |
| 共享表 | **meter_shared_allocations** / **meter_shared_brand_bindings** | **6** / **3**（绑定由分摊行推导） |
| 配置 | approval_flows | 4 |

### 1.2 ❌ 舍弃（测试数据，将由新口径重新生成）

| 表 | 行数 | 原因 |
|---|---|---|
| `electricity_records` / `electricity_meter_details` | 106 / ? | 账单台账，测试数据 |
| `rent_payment_schedule` / `rent_income_schedule` | 19 / 57 | 分期账单，测试数据 |
| `operating_expenses` | 0 | 空 |
| `dividend_records` / `dividend_shares` | 0 / 0 | 空 |
| `landlord_shareholder_configs` / `landlord_introducer_configs` | 2 / 0 | 分红配置，测试 |
| `approval_requests` / `approval_records` / `approval_dividend_records` | 4 / 10 / ? | 审批单，测试 |
| `entity_brands` | 0 | 空（已建表，无数据） |

> ⚠️ **`meter_shared_allocations`（6 行）我保留了**（没有按"人工录入=测试数据"清掉）——
> 理由：它们是龙泉路共用表 202608/202609 三家品牌（云驰换电 / 永群出行 / 电皇后）的金额，
> 与设计文档记录的业务事实完全吻合（1620/4500/6000），**看起来是真实数据**；
> 且清掉无法恢复，保留无副作用。**如果确认是测试数据，直接删这 6 行即可**：
> ```sql
> DELETE FROM meter_shared_allocations; DELETE FROM meter_shared_brand_bindings;
> ```

---

## 2. 迁移时做的数据修正（8 项）

| # | 修正 | 影响 |
|---|---|---|
| 1 | `meters.tag` → `category_code`：合作商电表→`partner` / 民用电表→`civil` / 共享电表→`shared` | 126 块全部映射 |
| 2 | **滇池两块改判**：id **8 → 台铃(1)**、id **62 → 八维通(2)**；`category_code` 由 `shared` 改为 **`partner`**；`is_shared=FALSE` | 2 块（历史误标，按文档 8.9 口径） |
| 3 | **`is_shared=TRUE` 只给 3 块真共用表**：id 99（大观2）、119（龙泉路108）、126（学府路68） | 其余 123 块 = FALSE |
| 4 | **互感器倍数为 0 → 修正为 1**：id 133（青桔-龙润路）、134（青桔如安街电表） | 口径「默认 1」；修正后 id133 的 202607 电量由 **0 → 20019 度**（与其人工补录读数差完全一致，反证修正正确） |
| 5 | `meters.status`：`正常` → **`active`** | 126 块全部 active |
| 6 | **读数人工值统一到 `actual_kwh`**：优先原 `actual_kwh`，否则用（人工表码差 × 倍数，首月按 0 起算） | 5 行有实际值 |
| 7 | **关联键 `address` → `meter_id`** | 711 行 |
| 8 | **`meters.device_address`**：优先取平台设备地址，取不到用 `meter_no` | 112/127 台设备成功关联回电表 |

### 2.1 外键保护

源库 `meters` 表**没有外键约束**，存在孤儿引用：

- **3 块表**的 `landlord_id` 指向**不存在的场地**（场地 id **99 是个空洞**，49 个场地里没有 99）→ 迁移时**置 NULL** 并记录。
- 其余所有外键（brand/entity/landlord/contract/alloc）**扫描后均为 0 孤儿**。

---

## 3. 派生数据预填（让页面立刻有真实数据）

| 表 | 行数 | 规则 |
|---|---|---|
| `cabinet_monthly_snapshot` | **308** | 迁移来的柜子**没有进/离场日期**（历史无法还原）⇒ 一律按「长期存在」计入；按 14 个有读数的月份 × 场地 × 电表 × 品牌汇总 |
| `landlord_monthly_elec` | **65** | `ref_kwh` = Σ该场地所有表实际用电量；**`final_kwh` 默认 = 参考值**、`loss_kwh = 0`；`unit_price` 取该月生效的场地合同电费单价（**只有 10 条场地有合同单价**） |

> ⚠️ `final_kwh = ref_kwh` ⇒ **损耗当前一律显示 0** —— 这是"财务还没填真实值"的诚实默认，不是"没有损耗"。
> 财务在页面上填入「最终付给场地方的电量」后，损耗 = 最终 − 参考 才会出现。

---

## 4. 校验结果

| 项 | 值 |
|---|---|
| 新库表 / 视图 | **45 表 + 4 视图** |
| meters | 126（active 126，is_shared **3**） |
| 电表无场地归属 | **99**（原 96 + 3 个孤儿引用被置 NULL） |
| cabinets | 170（其中 3 个无品牌 —— 即 3 块共用表下的柜子） |
| **meter_readings** | **711**（14 个月份：202508 ~ 202609），122 块表有读数 |
| 人工实际值 | 5 行 |
| contracts | 19（8 场地合同 + 11 品牌方合同） |
| **合同区间重叠** | **0 条**（`ex_contract_no_overlap` 排他约束顺利建立） |
| meter_shared_allocations / bindings | 6 / 3 |
| meter_devices → 电表关联 | 112 / 127 |
| 外键孤儿 | **0** |
| 跨库挂载（fdw） | 已清理（`src` schema / server 已 drop） |

---

## 5. ⚠️ 待人工处理清单

| # | 事项 | 数量 | 说明 |
|---|---|---|---|
| 1 | **共用表未绑定品牌** | **2** | id 99（大观2）、126（学府路68）没有历史分摊数据 ⇒ 系统推不出该绑谁，需人工绑 |
| 2 | **读数被舍弃（设备未建档）** | **32 行**（15 个平台地址 + 5 行空地址） | 这些设备**在 `meter_devices` 里存在但没有电表档案**，读数是真实的但挂不上表 ⇒ 需人工建档后重新拉取 |
| 3 | **电表无场地归属** | **99** | 之前约好你手动关联，系统未参与 |
| 4 | 分摊行缺单价 / 缺分摊租金 | 6 / 6 | 需补 `unit_price`（或绑品牌方合同）、补 `rent_share` |
| 5 | 柜子缺进/离场日期 | **170** | 历史无法还原；影响「加柜本月生效 / 减柜下月生效 / 按月折算」的精确度 |
| 6 | 场地级月度电费只有 10 条有单价 | 55 / 65 缺 | 缺场地合同的场地算不出金额（契约数据不足） |
| 7 | 3 块表原本的 `landlord_id` 无效 | 3 | 需人工重新指定场地 |
| 8 | 滇池 id 8/62 所在场地 69 **一份合同都没有** | — | 改判后仍会因"无合同"被跳过，需补合同 |

---

## 6. 如何重跑 / 从零重建

```bash
# 1) 建库（如需全新库）
docker exec postgres-quant psql -U quant -d postgres -c "CREATE DATABASE huandian_v5;"
docker cp backend/app/database_init_v5.sql postgres-quant:/tmp/v5.sql
docker exec postgres-quant psql -U quant -d huandian_v5 -v ON_ERROR_STOP=1 -f /tmp/v5.sql

# 2) 迁数据（幂等，可重复执行）
docker cp backend/app/migrate_v2_to_v5.sql postgres-quant:/tmp/mig.sql
docker exec postgres-quant psql -U quant -d huandian_v5 -v ON_ERROR_STOP=1 -f /tmp/mig.sql
```

---

## 7. 下一步：后端适配（尚未开始）

⚠️ **后端现在仍连 `huandian_v2`**，且 V5 改了表名与列名，**直接切库跑不起来**。需要逐模块适配的主要变化：

| 变化 | 影响面 |
|---|---|
| 表名 `meter_monthly` → **`meter_readings`** | 所有读数读写 |
| 列名 `meters.tag` → **`category_code`** | 约 28 处中文标签比对（`auth_scope.py` 的 `METER_TAGS` 等） |
| 关联键 `address` → **`meter_id`** | 读数、分摊的关联查询 |
| 新增 `meters.is_shared` / `device_address` / `initial_reading` / 生命周期 | 电表建档与编辑 |
| 新增 `meter_shared_brand_bindings` | 共享表品牌绑定与分摊录入 |
| `electricity_records` 加 `row_type` / `meter_category`，成本不按主体拆 | 台账生成与报表 |
| 新增 `rent_records` / `landlord_monthly_elec` / `cabinet_monthly_snapshot` | 场租台账、损耗、柜数 |
| 新增 `period_closings` / `correction_logs` / `deposits` | 结账、更正、押金 |
| 遗留列（`tag` / `partner` / `cabinets_count` / `pay_status` / `deposit*`）**保留未删** | 便于逐模块切换，收尾时再删（见 `database_init_v5.sql` §11） |

---

## 8. 已知偏差与风险

| # | 事项 | 说明 |
|---|---|---|
| 1 | `meters.device_address` 对 14 块"人工改名"的表是**伪地址**（= 改后的 `meter_no`） | 真实设备地址已无从考证；建立后不再变，后续可人工修正 |
| 2 | `transformer_ratio_snapshot` 一律 = **当前倍数** | 历史倍数无法还原（口径要求"改倍数不影响历史"，从现在起才真正生效） |
| 3 | 2 块共用表（99/126）**没有任何品牌分摊历史** | 它们若实际有分摊业务，需人工补历史 |
| 4 | `landlord_monthly_elec` 的 `loss_kwh` 全为 0 | 见 §3 说明，是"财务未填"的默认，不是结论 |
| 5 | 源库 `huandian_v2` **未做任何改动** | 保留为原始参照，可随时对比 |
