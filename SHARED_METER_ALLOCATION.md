# 共享电表「品牌分摊」— 设计说明（2026-09）

> 适用场景：`meters` 中被设为 **「所有品牌共用此电表」** 的电表（`tag = '共享电表'` 且 `brand_id IS NULL`）。
> 关联文档：[METER_LINE_DESIGN.md](./METER_LINE_DESIGN.md)（电表线表结构）、[ELECTRICITY_RATIO.md](./ELECTRICITY_RATIO.md)（度数口径）

---

## 一、要解决的问题

原来所有电费都由 **电表读数 × 合同单价** 算出：

```
付款（付场地方）= 实际用电量 × 场地合同单价
收款（向品牌方收）= 实际用电量 × 品牌方合同单价
```

共享电表是一块**场地总表**，没有品牌归属，旧口径只能整场地出一行
（`brand_id IS NULL`），收款按「全品牌合同」单价算 —— 无法把电费落到各品牌头上。

**新口径**：共享电表可以通过「录入度数」按钮，**按品牌录入指定月份的应付电费**，
不再用「某品牌用电量 × 单价」反推；反过来用 **应付金额 ÷ 单价** 倒推用电量。

---

## 二、口径（用户 2026-09 确认）

| 项 | 规则 |
|---|---|
| 录入值 `collect_amount` | **品牌方付给我方的电费（收款/收入，含税）** |
| 倒推单价 | 默认取该品牌方合同 `electricity_price`；表单里可人工覆盖（`unit_price`） |
| 用电量 | **金额 ÷ 单价**（不落库，生成台账时实时算） |
| 付款给场地方 | 倒推出的用电量 × 场地合同单价（口径不变） |
| 税费 | 沿用既有价内税口径：税 = 含税收入 × 税率（按品牌合同 `tax_rate`/`tax_enabled`） |
| 兜底 | 某表某月**没有任何分摊行** → 完全维持原口径（读数 × 合同单价），整场地出一行 |

**为什么付款也按倒推电量算**：共享电表某月录了分摊后，该表的电费就以人工录入的金额为准
（用户明确"不需要通过单价×用电量计算了"），因此
`Σ(各品牌倒推电量) × 场地单价 = 该场地该月电费成本`。电表读数仍照常保存，仅作核对留档。

---

## 三、数据模型

新增表 `meter_shared_allocations`（电表 × 月份 × 品牌 一行）：

| 字段 | 说明 |
|---|---|
| `meter_id` / `address` | 电表（`address = meters.meter_no`） |
| `month_period` | 月份，统一 6 位 `YYYYMM` |
| `brand_id` | 承担该笔电费的品牌方 |
| `entity_id` | 冗余留痕（生成台账时以电表的 `entity_id` 为准） |
| `collect_amount` | 品牌方付给我方的电费（收款/收入，含税） |
| `unit_price` | 倒推单价（元/度）；**NULL = 用该品牌方合同单价** |
| 唯一键 | `(address, month_period, brand_id)` —— 同表同月同品牌只能一行 |

用电量与不含税金额**不落库**，始终按当前合同/覆盖单价实时计算，避免合同改价后数据陈旧。

建表位置：
- 全新安装：`backend/app/database_init.sql`
- 存量库自动补表：`backend/app/schema_sync.sql`（第 17 节，后端启动自动执行）
- 手工迁移：`backend/app/migrations/2026_09_meter_shared_allocation.sql`

---

## 四、台账生成（`POST /api/electricity/generate`）

1. 读该月全部分摊行（一次查询，按电表号分组）。
2. 分组时：**有分摊行的电表**不再自己成组，而是按 `(场地, 分摊品牌, 电表主体)` 拆成多条明细；
   没有分摊行的电表维持原分组。
3. 每条分摊明细：
   - `collect_amount` = 录入金额（原样，不再乘单价）
   - `kwh` = 录入金额 ÷ 单价
   - `pay_amount` = `kwh` × 场地合同单价
   - `collect_net` = 税后收入
4. 分摊品牌的单价取不到（既无合同单价又未手填）→ 跳过该行并回写 `warnings`，不静默丢数据。
5. 清理段：旧的「共享电表整场地 auto 行」因分组消失会被自动删除，**不会与品牌明细双算**。
6. `auto_generate_for_meter / auto_generate_for_landlord / generate_all_ledger` 的重算月份集合
   已并入 `meter_shared_allocations` 的月份（只录了分摊、没录读数的月份也会被重算）。

---

## 五、录入入口（Meters 页「录入度数」）

`src/pages/Meters.tsx` 的 `ReadingForm`：电表为共享电表时，弹窗顶部多出
**「品牌分摊（各品牌应付电费）」** 区块：

- 品牌下拉：默认列出**该场地方已签品牌方合同**的品牌（带合同价），其余品牌可手动添加；
- 三列输入：`应付电费(元)` / `单价(元/度，留空=合同价，placeholder 显示合同价)` / 只读的 `用电量(度)`；
- 底部实时合计应付电费与合计用电量；缺单价的行会标红并阻止保存；
- 金额留空的行不保存；清空全部金额 = 取消分摊，台账退回原口径；
- 只录分摊、不填读数时不会产生一条 0 度读数行；
- 保存后：先存读数（若有输入），再整体替换该月分摊，后端保存时**自动重算该月台账**。

接口：
- `GET /api/meter-energy/shared-allocations?meterNo=&monthPeriod=` → 表单数据（电表信息、候选品牌+合同单价、已录入分摊、付款单价）
- `POST /api/meter-energy/shared-allocations` → `{address, monthPeriod, rows:[{brandId, collectAmount, unitPrice?, remark?}]}`（整体替换；写后自动重算台账）

---

## 六、下游口径同步

台账的品牌归属改为 **`COALESCE(electricity_records.brand_id, meters.brand_id)`**，
使共享电表的品牌分摊行能正确出现在各品牌名下：

| 位置 | 文件 |
|---|---|
| 电费月台账（按品牌/场地/主体三视图的明细） | `backend/app/api/electricity.py`（`monthly_ledger`） |
| 电费收付明细导出 | `backend/app/api/electricity.py`（`export_ledger`） |
| 台账记录的电表明细 | `backend/app/repositories/electricity_repo.py`（`get_meter_details`） |
| 看板电费明细 | `backend/app/api/overview.py` |
| 抄表核对 | `backend/app/api/electricity.py`（`reading_detail`，额外返回 `ledgerRows` / `allocations`） |
| 分红 | `backend/app/domain/dividend_calc.py`（`_get_meter_kwh` 按分摊拆明细；`_gross_of` 以人工金额为收入） |

**分红口径**：共享电表分摊行的 **收入 = 人工录入金额**（与台账完全一致），
用电量 = 金额 ÷ 单价，成本 = 倒推电量 × 场地单价；指定品牌分红
（`calculate(landlord, brand, period)`）只取该品牌的分摊行。

---

## 七、验证记录（本地开发库，验证后已清理）

| 验证项 | 结果 |
|---|---|
| 分摊 → 台账 | 品牌 11 录 1100 元 / 合同价 1.1 → 用量 1000 度、收款 1100、单价 1.1 ✓ |
| 人工覆盖单价 | 品牌 7 录 900 元 / 手填 0.9 → 用量 1000 度、收款 900 ✓ |
| 原整场地行清理 | 生成时 `deleted=1`（旧 `brand_id IS NULL` 行），无双算 ✓ |
| 分红 | 整场地电费收入 2000 = 1100 + 900；按品牌分别为 1100 / 900 ✓ |
| 回归（无分摊） | 全量重算 9 个月：台账 111 行、明细 111 行**内容完全一致** ✓ |
| 清理 | 删除临时分摊后重算，恢复为原始整场地一行（`pay_kwh = 109584`）✓ |

---

## 八、已知边界

1. **无品牌方合同的品牌**：可以手填单价录入分摊（台账、核对都正确），但该品牌没有品牌方合同，
   分红不会为它单独出「按品牌 P&L」行（其收入仍计入整场地总收入）。建议仍补签品牌方合同。
2. **柜数分摊**：共享电表的柜子仍按 `brand_id = NULL` 计入「全品牌共享」组参与场地成本/运营费分摊
   （本次未改动该口径，与电费收入口径相互独立）。
3. **`POST /api/electricity`（手工新增台账）** 的旧路径未接入分摊（前端已无入口）。
4. 共享电表按分摊拆行后，其**电费成本**以「Σ倒推电量 × 场地单价」为准；
   若录入金额与电表实际读数严重不符，成本会与电表读数脱节 —— 这是"以人工录入为准"的预期结果，
   抄表核对弹窗同时展示电表读数与分摊合计，供人工比对。
