# 公司主体线设计（ENTITY_LINE_DESIGN.md）

> 定位：把「公司主体（entities）」升级为与「场地方（landlords）」并列的一等核算维度。
> 目标：任意月份，能直接出一张《公司主体月度损益表》——电费收支、场地费成本、运营费用、税费、净利润全部按主体归集。
>
> 现实约束（用户确认 2026-09）：
> - 所有主体都是自己的子公司（内部核算，无对外第三方主体）；
> - 同一场地方下可有多个品牌方（青桔/美团/哈啰…）；
> - 同一品牌方下的多块电表可关联**不同**主体（美团表1→A公司，美团表2→B公司）；
> - **一块电表只关联一个主体**（meters.entity_id 单列，已满足）。

---

## 1. 三个"主体"概念分清（本设计的地基）

现状系统里"主体"出现在三处，语义不同，必须显式分开：

| 概念 | 落点 | 决定什么 | 谁生效 |
|---|---|---|---|
| **运营归属主体**（电表主体） | `meters.entity_id` | 电量、电费收支、分摊成本算哪个主体的运营数据 | **唯一事实源**，一切计算以它为准 |
| **收付款主体**（合同主体） | `contracts.entity_id` | 合同的钱从哪个主体收/付、发票开给谁 | 仅收付款/开票口径，不参与运营归属 |
| **品牌主管主体**（参考） | `entity_brands` | 档案页展示"该品牌默认挂在哪个主体"，作为录入默认值 | 仅参考，**不参与任何计算** |

**原则 P1**：运营数据的主体归属一律取 `meters.entity_id`；合同主体只决定收付款口径。两者允许不一致（现实就是美团一份合同、电表分属两个主体），各自归口，互不覆盖。

**原则 P2**：一电表一主体（保持现状）；换主体 = 替换（2026-09 已确认），`entity_source`（manual/auto）机制保持。

**原则 P4**（2026-09 确认，后经二次清理彻底落实）：电表 ↔ 主体的归属**唯一维护入口是「智慧电表」页**；公司主体页（Entities）不再承担任何"主体关联电表"的角色——关联弹窗、头部电表数、电表数量卡片、品牌配置表均已移除，页面只呈现 合同（场租）/ 主体损益 / 电租明细（且电租明细只显示本主体自己的电表，防止同场地多主体串数据）。

**原则 P3**：场地级成本（场地租金、运营费用）天然横跨多主体，按**分摊规则**落到主体；合同显式指定主体时优先全额归属。

---

## 2. 数据模型改造

### 2.1 entities 档案补全（报税法人）

现在是 name/short_name/remark 三列，作为报税法人太薄。补：

```sql
ALTER TABLE entities ADD COLUMN IF NOT EXISTS tax_no VARCHAR(50);          -- 统一社会信用代码
ALTER TABLE entities ADD COLUMN IF NOT EXISTS taxpayer_type VARCHAR(20);   -- 一般纳税人/小规模纳税人
ALTER TABLE entities ADD COLUMN IF NOT EXISTS invoice_bank VARCHAR(200);   -- 开票-开户行
ALTER TABLE entities ADD COLUMN IF NOT EXISTS invoice_account VARCHAR(100);-- 开票-账号
ALTER TABLE entities ADD COLUMN IF NOT EXISTS invoice_address VARCHAR(300);-- 开票-地址
ALTER TABLE entities ADD COLUMN IF NOT EXISTS invoice_phone VARCHAR(50);   -- 开票-电话
ALTER TABLE entities ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT '启用'; -- 启用/停用
ALTER TABLE entities ADD COLUMN IF NOT EXISTS sort INTEGER DEFAULT 0;
```

停用主体不删除（历史台账外键还在），仅不再出现在新单据选项里。

### 2.2 电费台账加主体维度（核心改造）

`electricity_records` 加 `entity_id`，生成分组键从 `(landlord_id, brand_id)` → `(landlord_id, brand_id, entity_id)`：

```sql
ALTER TABLE electricity_records ADD COLUMN IF NOT EXISTS entity_id INTEGER REFERENCES entities(id);
CREATE INDEX IF NOT EXISTS idx_elec_records_entity ON electricity_records(entity_id);
-- 唯一键换成表达式索引（NULL 参与唯一键：brand_id/entity_id 可空，NULL≠NULL 拦不住重复）
CREATE UNIQUE INDEX IF NOT EXISTS uq_elec_records_group
    ON electricity_records (landlord_id, COALESCE(brand_id, 0), COALESCE(entity_id, 0), period);
```

- 同场地同品牌不同主体的电表 → 拆成多行台账，每行只含本主体电表的明细；
- 明细表 `electricity_meter_details` 已有 `meter_id` 可回溯主体，不改；
- 台账行 `entity_id` 在生成时从该组电表的 `meters.entity_id` 取（组内天然同主体）。

改动点：`electricity.py` 的 `generate_electricity` / `compute_landlord_ledger` / `auto_generate_for_meter` / `auto_generate_for_landlord` 中所有 `groups[(lid, bid)]` 与 `existing_map` 的键全部三元化；"分组已消失清理"逻辑同样按三元组比对。

### 2.3 运营费用支持按主体

`operating_expenses` 加 `entity_id`（可空）：

```sql
ALTER TABLE operating_expenses ADD COLUMN IF NOT EXISTS entity_id INTEGER REFERENCES entities(id);
-- entity_id 非空 = 该主体专属费用；NULL = 场地公共费用（按规则分摊）
```

- 录入端允许选主体；同一场地可录多笔（原 `UNIQUE(landlord_id, period)` 需同步换成含 `COALESCE(entity_id,0)` 的表达式唯一索引，或直接去掉唯一约束改为应用层防重——推荐后者，公共+专属并存本来就允许同月多笔）；
- 分红计算 `dividend_calc` 读场地费用时取该场地全部费用合计，口径不变。

### 2.4 合同（contracts）语义明确 + 演进选项

- `contracts.entity_id` 语义定死为**收付款主体**（页面文案从"报税主体"改为"收付款主体"更准确，报税口径以运营归属汇总为准）；
- 场地合同 `entity_id` 保留双重用途：①该付款合同的记账主体；②电表默认主体的来源之一（`_venue_entity_id` auto-follow 不变）；
- **二期选项**：品牌方合同唯一键放宽为 `(landlord_id, brand_id, entity_id, start_date, end_date)`，支持同场地同品牌按主体拆签合同。拆签后租金收入天然按主体归属，不再需要报表层拆分。本期不做，报表层先按比例拆（见 §3）。

### 2.5 分红（dividend_records）一期不动

分红受益人是股东/介绍人（老板内部事务），基数按场地/品牌，与法人核算维度正交。主体损益表中的"净利润"由主体台账直接算出（§3），不从 `dividend_records` 取。若未来要按主体出分红基数，再加 `dividend_records.entity_id` 与配置表 `entity_id`，口径同品牌分红。

---

## 3. 主体月度损益口径（新增 entity_monthly_summary）

按 **主体 × 月份** 一行，全部可从现有数据推导：

| 项目 | 口径 |
|---|---|
| 电费收入（不含税） | Σ 该主体电表明细 `collect_net`（按 `meters.entity_id` 归属） |
| 电费税费 | Σ 明细"含税收−不含税收"（启用税率的电表） |
| 电费成本 | Σ 该主体电表 `kwh × 所在场地场地合同单价` |
| 租金收入 | 品牌方合同月租（首月/退款/税后口径与 rent 页一致）。合同主体与电表主体一致 → 直接归；同 (场地，品牌) 跨主体 → **按柜数占比拆分**（与分红按品牌柜数分摊同口径），并提示"建议按主体拆签合同" |
| 场地租金成本 | 场地合同 `entity_id` 指定 → 全额归该主体；未指定或场地内电表跨主体 → **按柜数占比分摊**（`GREATEST(1,柜数)`，同 dividend_calc 现行规则） |
| 运营费用 | 按主体录入的直接归；场地公共的按柜数分摊 |
| 净利润 | 收入（不含税）− 成本 − 场地租分摊 − 运营费分摊（税费单独展示不双扣，同 landlord_monthly_summary 口径） |

实现：新建数据库视图 `entity_monthly_summary`（结构与 `landlord_monthly_summary` 平行，电费部分经 `electricity_records.entity_id` 或明细→电表回溯聚合，成本部分按上述分摊规则），首页/主体页直接读视图，**不再在前端 join 全量数据自行聚合**（`Entities.tsx` 现状是前端 join，口径易漂移，一并切换）。

---

## 4. 电表换主体的历史处理

现状：换主体 = 替换 + `auto_generate_for_meter` 对有读数的月份自动重算 → 历史台账整体搬到新主体。本设计沿用并补两件事：

1. **确认弹窗**：换主体时列出受影响月份（该电表有台账/读数的月份），让用户选"全部历史重算（推荐，数据整体搬家）"或"仅从本月起"；
2. **审计留痕**：新增轻量表 `meter_entity_changes(id, meter_id, from_entity_id, to_entity_id, changed_at, operator, remark)`，换主体时写一条，回答"这块表 3 月怎么算到 B 公司头上了"。

---

## 5. 一致性校验与提示（只提示，不拦截）

| 场景 | 处理 |
|---|---|
| 电表主体 ≠ 其品牌方合同主体 | 电表页/合同页黄色提示"收款主体与运营主体不一致"（合法：代收代付） |
| 场地合同主体 ≠ 场地内电表主体集合 | 合同页提示"场地成本将按柜数分摊到 N 个主体" |
| `entity_brands` 与电表实际主体分布冲突 | Entities 页提示；entity_brands 仅参考，不改数据 |
| 电表未指定主体 | 归入"未指定主体"组，主体报表单列展示，催补 |

---

## 6. API / 前端改造清单

**后端**
1. `electricity.py`：生成器三元分组（§2.2）；台账列表/月台账输出 `entityId/entityName`，`monthly_ledger` 支持 `dim=entity`；
2. 新增 `GET /api/overview/entity-monthly?period=`：读 `entity_monthly_summary` 视图，返回主体损益表；
3. `directory.py`：entities CRUD 带新档案列；`entity-brands` 接口标注"仅参考"；
4. `meters.py`：换主体接口返回受影响月份 + 写 `meter_entity_changes`；
5. `dividend_calc.py` / `rent_calc.py`：读 `operating_expenses` 时含按主体录入的行（合计口径不变）。

**前端**
1. `Entities.tsx`：主体卡片改读 `/api/overview/entity-monthly`；展示损益明细 + 开票档案；分块"未指定主体"。页面为**只读视图**——原「关联电表」按钮与弹窗已删除（2026-09），归属维护统一走智慧电表页；
2. `Electricity.tsx`：台账按 场地×品牌×主体 分组展示；
3. `Meters.tsx`：换主体确认弹窗（受影响月份选择）；
4. `Rent.tsx` / `Dashboard.tsx`：沿用 2274e12 的主体分块，数据源切到新口径。

---

## 7. 迁移步骤（幂等，并入 schema_sync.sql 启动自动同步）

1. entities / electricity_records / operating_expenses 补列（§2）；
2. **回填 electricity_records.entity_id**：
   - `data_source='auto'` 的台账：按新分组键直接重生成（幂等）；
   - `data_source='manual'` 的台账：按明细电表主体回填；同组明细跨主体的列清单人工确认后拆行；
3. 唯一索引切换：先跑查重 SQL（`(landlord, brand, entity, period)` 无重复）→ 建表达式唯一索引 → 删旧 UNIQUE 约束；
4. 视图 `entity_monthly_summary` 上线；
5. 核对 SQL（应 0 行）：
   - 各月"Σ主体电费收入 = Σ场地电费收入"（拆分不丢失）；
   - 各月"Σ主体分摊场地租 = Σ场地合同月租"（分摊闭合）；
   - 台账行 entity_id 与组内明细电表主体一致。

---

## 8. 决策点（默认取推荐值，可改）

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| D1 | 场地租/运营费跨主体分摊依据 | **柜数**（GREATEST(1,柜数)，与分红现行规则一致） | 电量占比 |
| D2 | 场地合同显式指定主体时 | **全额归该主体，不再分摊** | 一律分摊 |
| D3 | 电表换主体的历史数据 | **全量重算 + 审计表** | 从变更月起（需表级生效日，复杂） |
| D4 | 跨主体品牌方合同租金收入 | **报表层按柜数拆 + 提示拆签合同**；二期支持按主体拆签 | 一期就改合同唯一键 |
| D5 | entity_brands | **保留为参考/默认值，计算不依赖** | 下线 |

---

## 9. 分期建议

- **一期（数据正确性）**：§2.2 电费台账三元分组 + 回填 + schema_sync；§4 换主体审计；§6 后端 1/2 + 前端 2。做完后主体电费口径即正确。✅ **已实施（2026-09-05）**，见 §10。
- **二期（报表完整性）**：§2.3 运营费用按主体；§3 视图 + Entities.tsx 切换；§5 提示。
- **三期（可选）**：D4 拆签合同、按主体分红基数、电表主体生效日（时点维度）。

---

## 10. 一期实施记录（2026-09-05）**schema（database_init.sql + schema_sync.sql，幂等）**
- `electricity_records` 加 `entity_id`；存量按明细电表主体众数回填（只填空）；
- 旧「场地×品牌×月」二元唯一键（约束或唯一索引，各库名字不同）按**列组识别**后删除（DO 块）；
- 新唯一键：表达式索引 `uq_elec_records_group (landlord_id, COALESCE(brand_id,0), COALESCE(entity_id,0), period)`；
- 新表 `meter_entity_changes`（换主体审计）；
- 配套：`infra/database.py` 的 schema_sync 语句切分器支持 `$$...$$`（否则 DO 块启动即碎）。

**生成与接口**
- `generate_electricity` / `auto_generate_for_meter(from_period)`：按 场地×品牌×主体 三元分组生成、清理；换主体可选「仅从本月起」；
- `create_electricity`：主体缺省按该场地×品牌电表主体众数推导；查重按四元组；
- `monthly_ledger`：landlord 维度按 场地×主体 聚合（entity_name 直取台账行，不再反查合同）；新增 `dim=entity`；`export` 新增 entity 分组；
- `electricity_repo`：`list_records_by_landlord_brand_period`（取全部主体行）；查询带 entity_name；
- `stations.py` / `dividends.py`：同键多行逐行合并明细；电表收付状态取该电表所在行的状态；
- `mp_finance /entities`：从"全量组合交叉"占位改为按 `er.entity_id` 真实聚合。

**前端**
- `Electricity.tsx`：新增「按公司主体」维度；行键带主体防碰撞；主体分块头复用；
- `Meters.tsx`：换主体时列出有读数的月份，选择「全部历史重算（推荐）/ 仅从本月起」，提交 `entityRegenerateFrom`。

**验证（开发库 huandian_v2 实测）**
- schema_sync 34 条语句 0 失败，重跑幂等；
- 全部 11 个月重生成后各月 pay/collect 合计与拆分前**分毫不差**（拆分闭合 PASS）；
- 受控拆行实验：把组内一块电表临时换主体 → 该组拆成 2 行、合计不变 → 还原重生成后恢复 1 行（PASS）；
- `monthly_ledger` 三维度合计一致；`export` entity 分组正确；`tsc -b` 通过。

---

## 11. 二期实施记录（2026-09-05）

**schema（database_init.sql + schema_sync.sql 第 11/12 节，幂等）**
- `entities` 补报税法人档案：tax_no / taxpayer_type / invoice_bank / invoice_account / invoice_address / invoice_phone / status（启用/停用）/ sort；
- `operating_expenses` 加 `entity_id`（NULL=场地公共）；旧「场地×月」唯一键按列组识别删除（同列组手法），同月允许 公共+各主体 多笔并存，防重由应用层按 (场地,月,主体) upsert 承担。

**后端**
- `rent_repo.save_expense(entity_id)`：按 (场地,月,主体) upsert；`get_expense_by_landlord` 改为**合计口径**（公共+专属全计入，返回 amount/remark/details），分红计算口径不变；
- `rent.py /expenses` 透传 entityId；`electricity.py` 导出的运营费用 JOIN 改为预聚合子查询（防多行翻倍明细）；
- `directory_repo/api`：主体档案字段透传（驼峰+snake 兼容）；
- 新增 `GET /api/overview/entity-monthly?period=`：主体×月损益表——电费按台账主体直接归集；品牌租金按合同主体或 (场地,品牌) 柜数占比拆分（含首月/退款/税后口径）；场地租按合同主体或场地柜数分摊；公共运营费按柜数分摊；净利润 = 电费利润 + 租金收入 − 税费 − 场地租 − 运营费（分红不扣）；未指定主体单独成行（"待归属"）。

**前端**
- `Entities.tsx`：新增「损益」视图 = 主体损益表（含合计行与"待归属"标识）；主体头部展示税号/纳税人类型；
- `Shareholders.tsx`：运营费用卡片支持按主体录入（整场地公共/主体专属），多笔分行展示、逐行删除；
- `Directory.tsx`：公司主体档案表补开票档案与状态列（顺带修复 shortName 显示键）；
- `Meters.tsx`：电表卡显示「收款主体与运营主体不一致」黄色提示（§5，只提示不拦截）。

**验证（开发库 huandian_v2 实测）**
- schema_sync 46 条语句 0 失败、重跑幂等；
- 主体损益与源数据闭合：电费付/净收/税费、租金收入、场地租、运营费合计与 SQL 直查**分毫不差**（PASS）；
- 运营费用多主体：公共+专属并存、upsert 幂等、合计口径正确（PASS）；专属全额归主体、公共按柜数分摊（PASS）。

---

## 12. 三期实施记录（2026-09-05）

**D4：品牌方合同按主体拆签**
- schema：旧 (场地×品牌×租期) 唯一键按列组识别删除（列组含 brand_id，不会误删场地合同键）；新键 `uq_contracts_brand_split (landlord_id, COALESCE(brand_id,0), COALESCE(entity_id,0), start_date, end_date) WHERE contract_type='品牌方合同'`；
- 电价解析主体感知：`resolve_prices` 新增 `brand_price_options`（该品牌全部合同单价，含主体）与 `brand_price_for(pricing, brand_id, entity_id)`（电表主体精确匹配 → 未指定主体合同 → 第一份）；台账生成/抄表计算/站点详情全部按电表主体精确取价；
- 合同页：新增/编辑合同可选「收付款主体」（两类合同通用），拆签后租金收入按合同主体全额归集，报表层柜数拆分退为兜底。

**电表换主体生效月（时点维度）**
- `meter_entity_changes` 加 `effective_period`；换主体确认框三选一：全部历史重算（推荐）/ 仅从本月起 / **从指定月起**（月份选择器），后端 `auto_generate_for_meter(from_period)` 只重算生效月及以后，审计表记录生效月。

**按主体分红基数**
- 配置表（股东/介绍人）与 `dividend_shares` 加 `entity_id`；配置匹配键扩为 (场地, 受益人, 品牌, 主体, 生效期)；
- `dividend_calc` 新增场地内主体 P&L（entity_map）：电费按电表主体×各自合同单价计收入、场地租/公共运营费按柜数分摊、品牌租金按合同主体或品牌内柜数占比拆分——口径与 entity-monthly 一致；配置了主体的分红以该主体收入/利润为基数（与品牌同时配置时品牌优先）；拆签合同的品牌 P&L 改为逐合同聚合，每份合同只算其主体对应电表的电量；顺带清理了遗留的调试输出。

**验证（开发库 huandian_v2 实测）**
- schema_sync 52 条语句 0 失败、重跑幂等；
- 拆签：同场地同品牌两份合同（不同主体、不同电价）成功并存，`brand_price_for` 按电表主体精确取价（1.10/1.30 分别命中），测试数据已清理；
- 分红回归：全部 6 个场地的电费收入与台账 collect_net **分毫不差**（8006.88/9671.04/18360.0…），entityMap 电费收入合计与计算器口径一致；
- 按主体分红：配置主体 4 占收入 10% → 基数 9673.52（= 电费 8006.88 + 租金 1666.64）、分红 967.35 ✓，测试数据已清理。
