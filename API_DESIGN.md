# 换电站经营管理平台 - 接口设计文档

> 后端：Python FastAPI，基础路径 `/api`
> 数据库：PostgreSQL（Docker 容器 `postgres-quant`）

## 目录

1. [基础档案管理](#1-基础档案管理)
2. [电表管理](#2-电表管理)
3. [站点管理](#3-站点管理)
4. [合同管理](#4-合同管理)
5. [电费台账管理](#5-电费台账管理)
6. [场地租金管理](#6-场地租金管理)
7. [分红配置与计算](#7-分红配置与计算)
8. [审批管理](#8-审批管理)
9. [看板与汇总](#9-看板与汇总)

---

## 1. 基础档案管理

### 1.1 品牌方

#### 获取品牌方列表
```
GET /api/directory/brands
```

#### 创建品牌方
```
POST /api/directory/brands
```
```json
{ "name": "美团", "contact": "张经理", "remark": "备注" }
```

#### 更新品牌方
```
PUT /api/directory/brands/{id}
```
```json
{ "name": "美团", "contact": "张经理", "remark": "更新备注" }
```

#### 删除品牌方
```
DELETE /api/directory/brands/{id}
```

---

### 1.2 公司主体

#### 获取列表
```
GET /api/directory/entities
```

#### 创建
```
POST /api/directory/entities
```
```json
{ "name": "云南来换电新能源有限公司", "shortName": "来换电", "remark": null }
```

#### 更新
```
PUT /api/directory/entities/{id}
```

#### 删除
```
DELETE /api/directory/entities/{id}
```

---

### 1.3 场地方/业主

#### 获取列表
```
GET /api/directory/landlords
```

#### 创建
```
POST /api/directory/landlords
```
```json
{ "name": "五华区物业", "contact": "赵主任", "phone": "13800001111", "remark": null }
```

#### 更新
```
PUT /api/directory/landlords/{id}
```

#### 删除
```
DELETE /api/directory/landlords/{id}
```

---

### 1.4 股东

#### 获取列表
```
GET /api/directory/shareholders
```

#### 创建
```
POST /api/directory/shareholders
```
```json
{ "name": "陈总", "phone": "13900001111", "remark": "大股东" }
```

#### 更新
```
PUT /api/directory/shareholders/{id}
```

#### 删除
```
DELETE /api/directory/shareholders/{id}
```

---

### 1.5 介绍人

#### 获取列表
```
GET /api/directory/introducers
```

#### 创建
```
POST /api/directory/introducers
```
```json
{ "name": "张介绍", "phone": "13800001234", "remark": "负责五华区" }
```

#### 更新
```
PUT /api/directory/introducers/{id}
```

#### 删除
```
DELETE /api/directory/introducers/{id}
```

---

### 1.6 平台使用人员

#### 获取列表
```
GET /api/directory/platform-users
```

**响应：**
```json
[
  {
    "id": 1,
    "name": "张三",
    "role": "boss",
    "shareholder_id": null,
    "shareholder_name": null,
    "phone": "13900001111",
    "remark": null
  },
  {
    "id": 2,
    "name": "李四",
    "role": "finance_supervisor",
    "shareholder_id": null,
    "shareholder_name": null,
    "phone": null,
    "remark": null
  },
  {
    "id": 3,
    "name": "陈总",
    "role": "shareholder",
    "shareholder_id": 1,
    "shareholder_name": "陈总",
    "phone": "13900002222",
    "remark": null
  }
]
```

#### 创建
```
POST /api/directory/platform-users
```
```json
{ "name": "张三", "role": "boss", "shareholderId": null, "phone": "13900001111", "remark": null }
```

**角色值：**
- `boss` — 老板
- `finance` — 财务
- `finance_supervisor` — 财务主管
- `shareholder` — 股东（需指定 `shareholderId`）

#### 更新
```
PUT /api/directory/platform-users/{id}
```

#### 删除
```
DELETE /api/directory/platform-users/{id}
```

---

### 1.7 公司主体-品牌方关联

#### 获取关联列表
```
GET /api/directory/entity-brands?entityId=1
```

#### 创建关联
```
POST /api/directory/entity-brands
```
```json
{ "entityId": 1, "brandId": 1, "remark": null }
```

#### 删除关联
```
DELETE /api/directory/entity-brands/{id}
```

---

## 2. 电表管理

### 获取电表列表
```
GET /api/meters?stationId=1&brandId=1
```

### 获取电表详情
```
GET /api/meters/{id}
```

### 创建电表
```
POST /api/meters
```
```json
{
  "stationId": 1,
  "brandId": 1,
  "meterNo": "260319554845",
  "meterName": "美团1号电表",
  "transformerRatio": 1,
  "landlordId": 4,
  "entityId": 1,
  "remark": null
}
```

### 更新电表
```
PUT /api/meters/{id}
```

### 删除电表
```
DELETE /api/meters/{id}
```

### 电表读数同步
```
POST /api/meter-energy/sync
```
```json
{ "meterIds": [1, 2, 3] }
```

---

## 3. 站点管理

### 获取站点列表
```
GET /api/stations?brandId=1&landlordId=1&keyword=五华
```

### 获取站点详情
```
GET /api/stations/{id}
```

### 创建站点
```
POST /api/stations
```
```json
{
  "name": "五华站A",
  "landlordId": 1,
  "companyShare": 0.6,
  "status": "运营中",
  "remark": null
}
```

### 更新站点
```
PUT /api/stations/{id}
```

### 删除站点
```
DELETE /api/stations/{id}
```

### 获取站点位置（小程序地图标注用）
```
GET /api/stations/locations?status=运营中
```

**参数：**
- `status` (可选) — 筛选站点状态：`运营中`、`筹建中`、`已关停`

**响应：**
```json
[
  {
    "id": 1,
    "name": "五华站A",
    "code": "WH001",
    "region": "五华区",
    "address": "昆明市五华区XX路",
    "status": "运营中",
    "latitude": 25.0389,
    "longitude": 102.7183
  }
]
```

**说明：**
- 仅返回已设置经纬度的站点
- 小程序端可使用此数据在地图上标注站点位置
- 支持按状态筛选，便于显示不同状态的站点

---

## 4. 合同管理

### 获取合同列表
```
GET /api/contracts?brandId=1&landlordId=1&keyword=五华
```

**响应字段：**
- `contract_type` — `场地合同` 或 `品牌方合同`
- `electricity_price` — 电费单价（元/度）
- `monthly_rent` — 月租金
- `cabinets_count` — 柜子数量
- `unit_monthly_rent` — 每柜月租金

### 创建合同
```
POST /api/contracts
```
```json
{
  "brandId": 1,
  "stationName": "五华站A",
  "landlordId": 1,
  "contractType": "品牌方合同",
  "electricityPrice": 1.5,
  "monthlyRent": 1000,
  "cabinetsCount": 4,
  "unitMonthlyRent": 500,
  "startDate": "2025-01-01",
  "endDate": "2027-12-31",
  "payEntity": "云南来换电",
  "remark": null
}
```

### 更新合同
```
PUT /api/contracts/{id}
```

### 删除合同
```
DELETE /api/contracts/{id}
```

---

## 5. 电费台账管理

### 获取电费列表
```
GET /api/electricity?stationId=1&period=202605
```

**响应：**
```json
[
  {
    "id": 1,
    "station_id": 2,
    "station_name": "台铃-螺狮湾站",
    "landlord_name": "螺蛳湾",
    "period": "202605",
    "pay_kwh": 80.00,
    "pay_unit_price": 0.65,
    "pay_amount": 1052.00,
    "pay_status": "未付款",
    "collect_kwh": 80.00,
    "collect_unit_price": 1.50,
    "collect_amount": 2120.00,
    "collect_net": 2099.01,
    "collect_status": "未到账",
    "profit": 1066.81,
    "meterDetails": [...]
  }
]
```

### 获取电费详情
```
GET /api/electricity/{id}
```

### 获取已有月份列表
```
GET /api/electricity/periods
```

### 自动生成电费台账
```
POST /api/electricity/generate
```
```json
{ "period": "202605" }
```

**说明：** 从 `meter_monthly`（电表读数）+ `contracts`（合同价格）自动生成。匹配链路：电表(`station_id`) → 站点(`landlord_id`) → 合同(`landlord_id`)。

**响应：**
```json
{ "created": 4, "skipped": 60, "period": "202605", "detail": "生成 4 条，跳过 60 条（已存在）" }
```

### 手动创建电费记录
```
POST /api/electricity
```
```json
{
  "stationId": 1,
  "period": "202607",
  "payUnitPrice": 0.65,
  "collectUnitPrice": 1.20,
  "taxRate": 0.01,
  "meterDetails": [
    { "meterId": 1, "startReading": 10000, "endReading": 12500 }
  ]
}
```

### 更新电费记录
```
PUT /api/electricity/{id}
```

### 删除电费记录
```
DELETE /api/electricity/{id}
```

---

## 6. 场地租金管理

### 获取租金付款（公司→业主）
```
GET /api/rent/leases?stationId=1
```

### 保存租金付款
```
POST /api/rent/leases
```

### 获取租金收款（品牌方→公司）
```
GET /api/rent/incomes?stationId=1&brandId=1
```

### 保存租金收款
```
POST /api/rent/incomes
```

### 保存租金分期收款
```
POST /api/rent/receipts
```

---

## 7. 分红配置与计算

### 7.1 股东分红配置

#### 获取配置
```
GET /api/dividends/configs/shareholder?stationId=1
```

#### 保存配置
```
POST /api/dividends/configs/shareholder
```
```json
{
  "stationId": 1,
  "shareholderId": 1,
  "mode": "利润分红",
  "ratio": 0.3,
  "fixedAmount": null
}
```

**分红模式：**
- `收入分红` — 分红基数 = 电费收款 + 租金收款
- `利润分红` — 分红基数 = 净利润（总收入 - 总成本）
- `固定金额` — 直接填写固定金额

#### 删除配置
```
DELETE /api/dividends/configs/shareholder/{id}
```

---

### 7.2 商务分红配置

#### 获取配置
```
GET /api/dividends/configs/introducer?stationId=1
```

#### 保存配置
```
POST /api/dividends/configs/introducer
```
```json
{
  "stationId": 1,
  "introducerId": 1,
  "mode": "利润分红",
  "ratio": 0.1,
  "fixedAmount": null,
  "countAsCost": true
}
```

**`countAsCost`** — 是否将商务分红计入成本（影响股东分红基数）

#### 删除配置
```
DELETE /api/dividends/configs/introducer/{id}
```

---

### 7.3 分红计算

#### 预览分红（不入库）
```
POST /api/dividends/calculate
```
```json
{ "stationId": 2, "period": "202605" }
```

**响应：**
```json
{
  "stationId": 2,
  "period": "202605",
  "income": {
    "elecIncome": { "total": 2120.00, "details": [...] },
    "rentIncome": { "total": 1000.00, "details": [...] },
    "totalIncome": 3120.00
  },
  "cost": {
    "elecCost": 1052.00,
    "rentCost": 1000.00,
    "opExpense": 0,
    "bizDividendCost": 0,
    "totalCost": 2052.00
  },
  "profit": 1068.00,
  "shareholderDividends": [
    { "shareholderId": 1, "shareholderName": "陈总", "mode": "利润分红", "ratio": 0.3, "amount": 320.40 }
  ],
  "bizDividends": [...]
}
```

---

### 7.4 分红记录

#### 获取分红列表
```
GET /api/dividends?stationId=1&period=202605
```

#### 创建分红月结
```
POST /api/dividends
```
```json
{ "stationId": 2, "period": "202605", "type": "股东分红" }
```

#### 删除分红记录
```
DELETE /api/dividends/{id}
```

---

### 7.5 股东汇总

#### 按股东汇总
```
GET /api/dividends/shareholder-summary?period=202605
```

#### 按介绍人汇总
```
GET /api/dividends/introducer-summary?period=202605
```

---

## 8. 审批管理

### 获取审批流程配置
```
GET /api/approvals/flows
```

### 保存审批流程配置
```
POST /api/approvals/flows
```
```json
{
  "bizType": "分红审批",
  "nodes": [
    { "name": "财务主管审核", "approver": "李四" },
    { "name": "老板审批", "approver": "张三" }
  ]
}
```

### 创建审批单
```
POST /api/approvals
```
```json
{
  "bizType": "分红审批",
  "title": "螺蛳湾 202605 分红审批",
  "applicant": "王财务",
  "amount": 320.40,
  "reason": "螺蛳湾 202605 分红，金额 320.40 元",
  "dividendRecordId": 1,
  "approvers": {
    "finance_supervisor": "李四",
    "boss": "张三"
  }
}
```

**`approvers` 说明（仅分红审批）：**
- `finance_supervisor` — 指定财务主管审批人（可选）
- `boss` — 指定老板审批人（可选）
- 两者至少选一个，流程动态构建

**审批流程示例：**
- 只选财务主管 → `提交人 → 李四`
- 只选老板 → `提交人 → 张三`
- 两个都选 → `提交人 → 李四 → 张三`

### 获取审批列表
```
GET /api/approvals?bizType=分红审批&status=审批中&applicant=王财务
```

**响应含分红关联信息：**
- `dividend_record_id` — 关联的分红记录ID
- `dividend_period` — 分红月份
- `station_name` — 站点名称

### 获取审批详情
```
GET /api/approvals/{id}
```

### 查询分红记录的审批单
```
GET /api/approvals/by-dividend/{dividend_id}
```

### 审批操作
```
POST /api/approvals/{id}/act
```

**通过：**
```json
{ "action": "通过", "approver": "张三", "comment": "同意" }
```

**驳回：**
```json
{ "action": "驳回", "approver": "张三", "comment": "金额有误" }
```

**转办：**
```json
{ "action": "转办", "approver": "张三", "comment": "转给副总", "targetApprover": "副总" }
```

**加签：**
```json
{ "action": "加签", "approver": "张三", "comment": "需要财务确认", "extraNode": { "name": "财务确认", "approver": "财务负责人" } }
```

**催办：**
```json
{ "action": "催办", "approver": "张三" }
```

**说明：** 审批通过后，如果关联了分红记录（`dividend_record_id`），分红记录状态自动更新为「已通过」。

### 审批统计
```
GET /api/approvals/stats/overview
```

---

## 9. 看板与汇总

### 经营总览
```
GET /api/overview
```

### 站点看板（按场地方分组）
```
GET /api/overview/station-board?keyword=螺蛳湾&period=2026-08
```

**响应：**
```json
[
  {
    "landlord": { "id": 4, "name": "螺蛳湾", "contact": null, "phone": null },
    "stations": [
      { "id": 2, "name": "台铃-螺狮湾站", "company_share": 0.6, "status": "运营中" },
      { "id": 20, "name": "八维通-螺蛳湾站点", "company_share": null, "status": "运营中" }
    ],
    "meters": [...],
    "meterCount": 3,
    "totalKwh": 80.00,
    "elecPay": 1052.00,
    "elecCollect": 2120.00,
    "elecProfit": 1068.00,
    "rentCost": 1000.00,
    "rentIncome": 2000.00,
    "rentProfit": 1000.00,
    "totalProfit": 2068.00
  }
]
```

---

## 附录：枚举值说明

### 角色（platform_users.role）
| 值 | 说明 |
|---|---|
| `boss` | 老板 |
| `finance` | 财务 |
| `finance_supervisor` | 财务主管 |
| `shareholder` | 股东 |

### 合同类型（contracts.contract_type）
| 值 | 说明 |
|---|---|
| `场地合同` | 公司→场地方，成本类 |
| `品牌方合同` | 品牌方→公司，收入类 |

### 分红模式
| 值 | 说明 |
|---|---|
| `收入分红` | 分红基数 = 电费收款 + 租金收款 |
| `利润分红` | 分红基数 = 净利润（总收入 - 总成本） |
| `固定金额` | 直接填写固定金额 |

### 分红类型
| 值 | 说明 |
|---|---|
| `股东分红` | 给股东的分红 |
| `商务分红` | 给介绍人的分红 |

### 分红状态（dividend_records.status）
| 值 | 说明 |
|---|---|
| `未结算` | 系统已计算，未提交审批 |
| `审批中` | 已提交审批，等待处理 |
| `已通过` | 审批通过，可打款 |
| `已驳回` | 审批驳回 |
| `已结算` | 已完成打款 |

### 审批状态（approval_requests.status）
| 值 | 说明 |
|---|---|
| `审批中` | 等待审批 |
| `已通过` | 审批通过 |
| `已驳回` | 审批驳回 |

### 审批操作
| 值 | 说明 |
|---|---|
| `提交` | 发起审批 |
| `通过` | 审批通过 |
| `驳回` | 审批驳回 |
| `转办` | 转给他人处理 |
| `加签` | 增加审批节点 |
| `催办` | 催促审批 |

### 站点状态
| 值 | 说明 |
|---|---|
| `运营中` | 正常运营 |
| `筹建中` | 建设中 |
| `已关停` | 已停止运营 |

### 电费付款/收款状态
| 值 | 说明 |
|---|---|
| `未付款` / `未到账` | 待处理 |
| `已付款` / `已到账` | 已完成 |

---

## 附录：计算公式

### 电费利润
```
电费利润 = 电费收款（不含税） - 电费付款
```

### 租金利润
```
租金利润 = 租金收款 - 场地租金成本
```

### 商务分红（计入成本时）
```
分红基数 = 总收入 - 电费成本 - 场地租金 - 运营费用
商务分红金额 = 分红基数 × 比例（或固定金额）
总成本 = 电费成本 + 场地租金 + 运营费用 + 商务分红金额
```

### 商务分红（不计入成本时）
```
总成本 = 电费成本 + 场地租金 + 运营费用
净利润 = 总收入 - 总成本
商务分红金额 = 净利润 × 比例（或固定金额）
```

### 股东分红
```
收入分红：分红金额 = 总收入 × 比例
利润分红：分红金额 = 净利润 × 比例
固定金额：分红金额 = 固定金额
```
