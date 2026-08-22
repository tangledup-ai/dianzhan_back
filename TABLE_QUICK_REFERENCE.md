# 数据库表速查手册（v2 全量重设计）

> 全部 **39 张表 + 3 个视图**，一句话说明每张表是干什么的（按功能域分组）。
> 字段级权威定义见 `backend/app/database_init.sql`（含字段注释）。

---

## 一、档案域（Directory 维护的"名字"，全系统引用）

| 表名 | 一句话说明 |
|---|---|
| `brands` | 品牌方（客户，如美团/哈啰/青桔） |
| `entities` | 公司主体（报税法人，收款/付款主体） |
| `landlords` | **场地方（业主）**——主链聚合根，合同/电表都直接挂它名下（v3 无站点层） |
| `shareholders` | 股东（投资人，分红受益人） |
| `introducers` | 介绍人（商务关系人，拿商务分红） |
| `entity_brands` | 公司主体和品牌方的归属关系（多对多） |
| `platform_users` | 平台登录用户（老板/财务/股东，股东限看关联场地） |

## 二、电表·接入域（第三方平台数据缓存，只能 GET 拉取）

| 表名 | 一句话说明 |
|---|---|
| `third_party_configs` | 第三方电表平台的账户配置（地址+授权码+电表类型） |
| `meter_devices` | 第三方设备快照（设备的"户口本"，address=业务电表号） |
| `meter_collectors` | 第三方采集器快照 |
| `meter_status_cache` | 电表实时状态缓存（总电量/分时电量/剩余金额） |
| `meter_monthly` | **月度读数（电费/分红的数据源头）**——每表每月一条；含人工实际读数（数据错漏时填，同步不覆盖） |
| `meter_daily` | 日用电量（原始表码） |
| `meter_hourly` | 小时用电量（原始表码） |
| `meter_yearly` | 年用电量（原始表码） |
| `meter_warnings_cache` | 电表报警缓存 |
| `sync_logs` | 第三方同步日志（审计：谁同步的、成功没、多少条） |

## 三、电表·档案域（业务计算的唯一入口）

| 表名 | 一句话说明 |
|---|---|
| `meters` | **电表档案**——第三方设备导入/人工建档后直接挂 场地(landlord_id)+品牌(brand_id) |
| `cabinets` | 柜子（挂在电表下的物理资产；计费柜数从这里实时数） |

## 四、合同域（商务量的唯一主源）

| 表名 | 一句话说明 |
|---|---|
| `contracts` | **合同台账**——场地合同=成本（付业主）、品牌方合同=收入（品牌方付公司），单价/月租/税都在这里；直挂 landlord_id（+brand_id） |
| `rent_payment_schedule` | 场地合同的付款分期（按付款方式拆期） |
| `rent_income_schedule` | 品牌方合同的收款分期（按付款方式拆期） |

## 五、分配规则域（分红怎么分；v3 按场地）

| 表名 | 一句话说明 |
|---|---|
| `landlord_shareholder_configs` | 股东分红配置（每场地每股东：按收入/利润/固定金额 + 比例 + 品牌范围 + 生效期） |
| `landlord_introducer_configs` | 介绍人商务分红配置（同上 + 是否计入成本） |

## 六、台账派生域（源头数据算出来的账本/快照）

| 表名 | 一句话说明 |
|---|---|
| `electricity_records` | 电费月台账（每场地×品牌×每月：付电费/收电费/利润；直挂 landlord_id+brand_id） |
| `electricity_meter_details` | 电费台账的分表明细（每块电表贡献多少） |
| `operating_expenses` | 运营费用（每场地每月手工填一笔，直挂 landlord_id） |
| `dividend_records` | 分红月结（每场地×品牌每月：收入-成本=利润，状态流转，直挂 landlord_id） |
| `dividend_shares` | 分红明细（每个股东/介绍人分到多少，含配置快照） |

## 七、审批域

| 表名 | 一句话说明 |
|---|---|
| `approval_flows` | 审批流程配置（什么业务走哪几个审批节点） |
| `approval_requests` | 审批单（电费/租金/分红等付款申请单；直挂 landlord_id） |
| `approval_records` | 审批流转记录（谁在哪个节点通过/驳回） |
| `approval_dividend_records` | 审批单和分红记录的关系（一张审批单可带多个月分红） |

## 八、视图（只读，实时聚合）

| 视图名 | 一句话说明 |
|---|---|
| `landlord_site_summary` | 场地维度实时汇总：租金成本/收入/合同清单（不落缓存列） |
| `landlord_monthly_summary` | **场地月度经营汇总**：某场地某月的电费收支/税费、租金收支/税费、运营费用、净利润、股东分红（按场地×月份一行） |
| `dividend_settlement_schedule` | **分红结算周期**：每个股东/介绍人 × 周期（月/季/半年/年）的下次分红时间 + 待结算/已结算金额 |

---

## 快速记忆（三句话）

1. **源头只有三处**：`meters`+`meter_monthly`（电表度数）→ `contracts`（单价/租金）→ `landlord_*_configs`（分红规则）。
2. **中间账本**：`electricity_records`（电费）、`operating_expenses`（运营费）、`dividend_records`+`dividend_shares`（分红）。
3. **支持设施**：`landlords`（聚合根，v3 无站点层）、`approval_*`（审批）、`meter_*` 缓存表（第三方数据中转站）。
