# 数据库重设计参考文档

> 换电站经营管理平台 - 数据库重设计参考
> 整理时间：2026-08-20
> 业务逻辑：基本不变，仅数据库重新设计

---

## 一、系统概述

这是一个**换电站经营管理平台**，核心功能是：
- 记录每个换电站的电费收支和利润
- 记录场地租金收支和利润
- 按股东占股比例计算分红

**一句话概括：这是一个"算清楚每个站赚不赚钱、该给谁分多少钱"的财务系统。**

---

## 二、用户角色

| 角色 | 权限范围 |
|---|---|
| **老板 (boss)** | 全部功能 |
| **财务 (finance)** | 全部功能 |
| **财务主管 (finance_supervisor)** | 全部功能 |
| **股东 (shareholder)** | 仅可查看股东分红页，其他页面被拦截跳转 |

---

## 三、页面数据需求分析

### 1. 经营总览看板 (Dashboard)

**功能**: 各站收入/成本/利润的汇总看板

**需要的数据**:
- 所有站点列表（id、名称、状态）
- 每个站点的电费月台账汇总（付款金额、收款金额、利润）
- 每个站点的租金台账汇总（付款金额、收款金额、利润）
- 按月份统计的汇总数据
- 按品牌方统计的汇总数据
- 按公司主体统计的汇总数据
- 按区域统计的汇总数据

---

### 2. 站点数据管理 (Stations)

**功能**: 站点 CRUD、地图展示、股东占股配置

**需要的数据**:
- 站点基础信息（id、名称、站点号、区域、地址、状态）
- 关联的品牌方（brandId）
- 关联的公司主体（entityId）
- 关联的场地方（landlordId）
- 电表编号（meterNo）
- 互感器倍数（transformerRatio）
- 换电柜数量（cabinets）
- 储电/防爆柜数量（storageCabinets）
- 公司占股比例（companyShare）
- 站点-股东占股配置（stationShares: shareholderId, ratio）
- 备注信息

---

### 3. 电费月台账 (Electricity)

**功能**: 电费月台账（付款/收款/利润），支持手动录入和 API 自动拉取

**需要的数据**:
- 站点信息（stationId、站点名称）
- 月份周期（period: 2026-06）
- **付款侧**:
  - 抄表起止日期（payStartDate、payEndDate）
  - 起止表码（payStartReading、payEndReading）
  - 区间度数（payKwh）- 含互感器倍数换算后
  - 付款单价（payUnitPrice）
  - 付款金额（payAmount）
  - 付款状态（payStatus: 未付款/已付款）
- **收款侧**:
  - 抄表起止日期（collectStartDate、collectEndDate）
  - 起止表码（collectStartReading、collectEndReading）
  - 区间度数（collectKwh）
  - 收款单价（collectUnitPrice）
  - 收款金额（collectAmount）
  - 税率（taxRate）
  - 不含税收入（collectNet）
  - 到账状态（collectStatus: 未到账/已到账）
- **利润计算**:
  - 利润（profit = collectNet - payAmount）
  - 运营费用（opExpense）
  - 扣除运营费用后利润（profitAfterOp）
  - 公司占股快照（companyShare）
  - 公司净利润（companyNetProfit）
- 数据来源（source: manual/meter_api）
- 备注信息

---

### 4. 场租台账 (Rent)

**功能**: 场地租金台账（付给业主 vs 品牌方付给公司）

**需要的数据**:

#### 4.1 付款合同 (rentLeases) - 公司向业主租场地
- 站点信息（stationId）
- 合同期限（contractStart、contractEnd）
- 年租金成本（annualRent）
- 付款方式（payMethod: 年付/半年付/季付）
- 每期付款金额（payAmount）
- 押金（deposit）
- 付款截止时间（payDeadline）
- 付款状态（payStatus: 未付款/已付款）
- 发票类型（invoiceType: 对公/对私）
- 备注信息

#### 4.2 收款合同 (rentIncomes) - 品牌方向公司付场地租金
- 站点信息（stationId）
- 合同期限（contractStart、contractEnd）
- 单柜月租金含税（unitMonthlyRent）
- 计费柜数（cabinetsCount）
- 年租金收入含税（annualIncome）
- 月租金（monthlyRent）
- 税率（taxRate）
- 年租金收入不含税（annualIncomeNet）
- 进项成本（inputCost）
- 租金利润（profit）
- 分红金额（dividendAmount）
- 扣除分红后利润（profitAfterDividend）
- 签约/开票/到账情况（signStatus）
- 备注信息

#### 4.3 租金分期收款 (rentReceipts)
- 关联的收款合同（rentIncomeId）
- 收款序号（seq）
- 收款周期（periodStart、periodEnd）
- 收款金额（amount）
- 到账状态（status: 未到账/已到账）
- 备注信息

---

### 5. 品牌方看板 (Brands)

**功能**: 按品牌方维度的财务看板

**需要的数据**:
- 品牌方列表（id、name、contact、remark）
- 每个品牌方关联的站点列表
- 每个站点的电费汇总（付款、收款、利润）
- 每个站点的租金汇总（付款、收款、利润）
- 按月份统计的汇总趋势

---

### 6. 公司主体看板 (Entities)

**功能**: 按公司主体维度的财务看板

**需要的数据**:
- 公司主体列表（id、name、shortName、remark）
- 每个公司主体关联的站点列表
- 每个站点的电费汇总（付款、收款、利润）
- 每个站点的租金汇总（付款、收款、利润）
- 按月份统计的汇总趋势

---

### 7. 场地方看板 (Landlords)

**功能**: 按场地方维度的财务看板

**需要的数据**:
- 场地方列表（id、name、contact、phone、remark）
- 每个场地方关联的站点列表
- 每个站点的租金付款合同信息
- 租金付款汇总（年租金、付款状态）

---

### 8. 股东分红 (Shareholders)

**功能**: 按占股比例计算分红，支持收入/利润/固定金额三种模式

**需要的数据**:
- 股东列表（id、name、phone、remark）
- 站点-股东占股配置（stationId、shareholderId、ratio）
- 分红月结记录（dividendRecords）:
  - 站点信息（stationId）
  - 月份周期（period）
  - 电量（kwh）
  - 付款单价（payUnitPrice）
  - 电费付款金额（payAmount）
  - 收款电费含税（elecIncomeTax）
  - 电费不含税（elecIncomeNet）
  - 收款租金含税（rentIncomeTax）
  - 租金不含税（rentIncomeNet）
  - 电费租金收款合计（totalIncome）
  - 利润（profit）
  - 结算状态（status: 未结算/已结算）
- 分红明细（dividendShares）:
  - 关联的分红记录（dividendId）
  - 股东信息（shareholderId）
  - 分红比例（ratio）
  - 分红金额（amount）

---

### 9. 合同管理 (Contracts)

**功能**: 场租付款/收款合同、电费合同、合作合同管理

**需要的数据**:
- 合同列表:
  - 关联品牌方（brandId）
  - 关联站点（stationId、stationName）
  - 地址（address）
  - 付款主体（payEntity）
  - 合作方（partner）
  - 合同类型（contractType: 场租付款/场租收款/电费/合作/其他）
  - 合同期限（startDate、endDate）
  - 备注信息

---

### 10. 审批中心 (Approvals)

**功能**: 多节点审批流（付款/分红等），支持小程序端审批

**需要的数据**:
- 审批流程配置（approvalFlows）:
  - 业务类型（bizType: 电费付款/租金付款/股东分红/费用报销/其他）
  - 审批节点（nodes: JSON [{name, approver, timeoutHours}]）
- 审批单（approvalRequests）:
  - 业务类型（bizType）
  - 审批事由（title、reason）
  - 金额（amount）
  - 申请人（applicant）
  - 附件（attachments: JSON [{name, size}]）
  - 流程节点快照（flowNodes: JSON）
  - 当前节点（currentNode）
  - 审批状态（status: 审批中/已通过/已驳回）
  - 催办次数（urgeCount）
  - 完成时间（finishedAt）
- 审批记录（approvalRecords）:
  - 关联审批单（requestId）
  - 节点索引（nodeIndex、nodeName）
  - 审批人（approver）
  - 审批动作（action: 提交/通过/驳回/转办/加签/催办）
  - 审批意见（comment）

---

### 11. 智慧电表 (Meters)

**功能**: 第三方电表 API 数据同步，抄表记录管理

**需要的数据**:
- 站点信息（stationId、meterNo）
- 电表抄表记录（meterReadings）:
  - 站点信息（stationId）
  - 电表编号（meterNo）
  - 表码读数（reading）
  - 抄表时间（readingAt）
  - 数据来源（source: api/manual）

---

### 12. 基础档案 (Directory)

**功能**: 品牌方/公司主体/场地方/股东的 CRUD

**需要的数据**:

#### 12.1 品牌方 (brands)
- id、name、contact、remark、createdAt

#### 12.2 公司主体 (entities)
- id、name、shortName、remark、createdAt

#### 12.3 场地方 (landlords)
- id、name、contact、phone、remark、createdAt

#### 12.4 股东 (shareholders)
- id、name、phone、remark、createdAt

---

### 13. 站点地图 (StationMap)

**功能**: 站点地图展示

**需要的数据**:
- 站点列表（id、name、address、status）
- 站点坐标（经纬度）- **当前数据库缺少此字段**

---

## 四、当前数据库结构 (MySQL + Drizzle ORM)

### 表结构总览（19张表）

#### 基础档案表（4张）

**1. brands - 品牌方**
```sql
CREATE TABLE brands (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  contact VARCHAR(100),
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**2. entities - 公司主体**
```sql
CREATE TABLE entities (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  short_name VARCHAR(50),
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**3. landlords - 场地方/业主**
```sql
CREATE TABLE landlords (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  contact VARCHAR(100),
  phone VARCHAR(50),
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**4. shareholders - 股东**
```sql
CREATE TABLE shareholders (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  phone VARCHAR(50),
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

#### 站点表（2张）

**5. stations - 站点**
```sql
CREATE TABLE stations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  code VARCHAR(50),                    -- 站点号
  region VARCHAR(50),                  -- 区域：五华/盘龙/官渡/西山/呈贡…
  address VARCHAR(300),
  brand_id BIGINT UNSIGNED,           -- 关联品牌方
  entity_id BIGINT UNSIGNED,          -- 关联公司主体
  landlord_id BIGINT UNSIGNED,        -- 关联场地方
  meter_no VARCHAR(100),              -- 电表编号（智慧电表API以此关联）
  transformer_ratio DECIMAL(10,2),    -- 互感器倍数
  cabinets DECIMAL(8,2),              -- 换电柜数量
  storage_cabinets DECIMAL(8,2),      -- 储电/防爆柜数量
  company_share DECIMAL(5,4),         -- 公司占股
  status ENUM('运营中','筹建中','已关停') NOT NULL DEFAULT '运营中',
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**6. station_shares - 站点-股东占股**
```sql
CREATE TABLE station_shares (
  id SERIAL PRIMARY KEY,
  station_id BIGINT UNSIGNED NOT NULL,
  shareholder_id BIGINT UNSIGNED NOT NULL,
  ratio DECIMAL(6,4) NOT NULL,        -- 0.3 等
  remark VARCHAR(200)
);
```

---

#### 电费表（2张）

**7. electricity_records - 电费月台账**
```sql
CREATE TABLE electricity_records (
  id SERIAL PRIMARY KEY,
  station_id BIGINT UNSIGNED NOT NULL,
  period VARCHAR(7) NOT NULL,          -- 2026-06

  -- 付款侧
  pay_start_date DATE,
  pay_start_reading DECIMAL(14,2),
  pay_end_date DATE,
  pay_end_reading DECIMAL(14,2),
  pay_kwh DECIMAL(14,2),              -- 区间度数（含互感器倍数换算后）
  pay_unit_price DECIMAL(8,4),
  pay_amount DECIMAL(14,2),
  pay_status ENUM('未付款','已付款') NOT NULL DEFAULT '未付款',

  -- 收款侧
  collect_start_date DATE,
  collect_start_reading DECIMAL(14,2),
  collect_end_date DATE,
  collect_end_reading DECIMAL(14,2),
  collect_kwh DECIMAL(14,2),
  collect_unit_price DECIMAL(8,4),
  collect_amount DECIMAL(14,2),
  tax_rate DECIMAL(5,4),              -- 0.01 / 0.05 等
  collect_net DECIMAL(14,2),          -- 不含税收入
  collect_status ENUM('未到账','已到账') NOT NULL DEFAULT '未到账',

  -- 利润
  profit DECIMAL(14,2),               -- collectNet - payAmount
  op_expense DECIMAL(14,2),           -- 运营费用
  profit_after_op DECIMAL(14,2),
  company_share DECIMAL(5,4),         -- 公司占股快照
  company_net_profit DECIMAL(14,2),

  source ENUM('manual','meter_api') NOT NULL DEFAULT 'manual',
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW()
);
```

**8. meter_readings - 智慧电表抄表记录**
```sql
CREATE TABLE meter_readings (
  id SERIAL PRIMARY KEY,
  station_id BIGINT UNSIGNED NOT NULL,
  meter_no VARCHAR(100) NOT NULL,
  reading DECIMAL(14,2) NOT NULL,     -- 表码
  reading_at TIMESTAMP NOT NULL,
  source ENUM('api','manual') NOT NULL DEFAULT 'api',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

#### 场地租金表（3张）

**9. rent_leases - 付款合同（公司向业主租场地）**
```sql
CREATE TABLE rent_leases (
  id SERIAL PRIMARY KEY,
  station_id BIGINT UNSIGNED NOT NULL,
  contract_start DATE,
  contract_end DATE,
  annual_rent DECIMAL(12,2),          -- 年租金成本
  pay_method VARCHAR(50),             -- 年付/半年付/季付
  pay_amount DECIMAL(12,2),           -- 每期付款金额
  deposit DECIMAL(12,2),              -- 押金
  pay_deadline DATE,                  -- 付款截止时间
  pay_status ENUM('未付款','已付款') NOT NULL DEFAULT '未付款',
  invoice_type VARCHAR(20),           -- 对公/对私
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**10. rent_incomes - 收款合同（品牌方向公司付场地租金）**
```sql
CREATE TABLE rent_incomes (
  id SERIAL PRIMARY KEY,
  station_id BIGINT UNSIGNED NOT NULL,
  contract_start DATE,
  contract_end DATE,
  unit_monthly_rent DECIMAL(10,2),    -- 单柜月租金（含税）
  cabinets_count DECIMAL(8,2),        -- 计费柜数
  annual_income DECIMAL(12,2),        -- 年租金收入（含税）
  monthly_rent DECIMAL(12,2),         -- 月租金
  tax_rate DECIMAL(5,4),
  annual_income_net DECIMAL(12,2),    -- 不含税
  input_cost DECIMAL(12,2),           -- 进项成本
  profit DECIMAL(12,2),               -- 租金利润
  dividend_amount DECIMAL(12,2),      -- 分红金额
  profit_after_dividend DECIMAL(12,2),
  sign_status VARCHAR(100),           -- 签约/开票/到账情况
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**11. rent_receipts - 租金分期收款**
```sql
CREATE TABLE rent_receipts (
  id SERIAL PRIMARY KEY,
  rent_income_id BIGINT UNSIGNED NOT NULL,
  seq DECIMAL(3,0) NOT NULL,          -- 第几次收款
  period_start DATE,
  period_end DATE,
  amount DECIMAL(12,2),
  status ENUM('未到账','已到账') NOT NULL DEFAULT '未到账',
  remark VARCHAR(200)
);
```

---

#### 合同表（1张）

**12. contracts - 合同台账**
```sql
CREATE TABLE contracts (
  id SERIAL PRIMARY KEY,
  brand_id BIGINT UNSIGNED,
  station_id BIGINT UNSIGNED,
  station_name VARCHAR(200) NOT NULL,
  address VARCHAR(300),
  pay_entity VARCHAR(150),            -- 付款主体
  partner VARCHAR(150),               -- 合作方
  contract_type ENUM('场租付款','场租收款','电费','合作','其他') NOT NULL DEFAULT '合作',
  start_date DATE,
  end_date DATE,
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

#### 分红表（2张）

**13. dividend_records - 分红月结**
```sql
CREATE TABLE dividend_records (
  id SERIAL PRIMARY KEY,
  station_id BIGINT UNSIGNED NOT NULL,
  period VARCHAR(7) NOT NULL,         -- 2026-01
  kwh DECIMAL(14,2),                  -- 电量
  pay_unit_price DECIMAL(8,6),
  pay_amount DECIMAL(14,2),           -- 电费付款金额
  elec_income_tax DECIMAL(14,2),      -- 收款电费含税
  elec_income_net DECIMAL(14,2),      -- 电费不含税
  rent_income_tax DECIMAL(14,2),      -- 收款租金含税
  rent_income_net DECIMAL(14,2),      -- 租金不含税
  total_income DECIMAL(14,2),         -- 电费租金收款合计
  profit DECIMAL(14,2),               -- 利润
  status ENUM('未结算','已结算') NOT NULL DEFAULT '未结算',
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**14. dividend_shares - 分红明细**
```sql
CREATE TABLE dividend_shares (
  id SERIAL PRIMARY KEY,
  dividend_id BIGINT UNSIGNED NOT NULL,
  shareholder_id BIGINT UNSIGNED NOT NULL,
  ratio DECIMAL(6,4) NOT NULL,
  amount DECIMAL(14,2)
);
```

---

#### 审批表（3张）

**15. approval_flows - 审批流程配置**
```sql
CREATE TABLE approval_flows (
  id SERIAL PRIMARY KEY,
  biz_type VARCHAR(50) NOT NULL UNIQUE, -- 电费付款/租金付款/股东分红/费用报销/其他
  nodes TEXT NOT NULL,                   -- JSON: [{name, approver, timeoutHours}]
  updated_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW()
);
```

**16. approval_requests - 审批单**
```sql
CREATE TABLE approval_requests (
  id SERIAL PRIMARY KEY,
  biz_type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,           -- 审批事由
  reason TEXT,
  amount DECIMAL(14,2),
  applicant VARCHAR(100) NOT NULL,
  attachments TEXT,                      -- JSON: [{name, size}]
  flow_nodes TEXT NOT NULL,              -- 提交时的流程快照
  current_node INT NOT NULL DEFAULT 0,
  status ENUM('审批中','已通过','已驳回') NOT NULL DEFAULT '审批中',
  urge_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP
);
```

**17. approval_records - 审批记录**
```sql
CREATE TABLE approval_records (
  id SERIAL PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  node_index INT NOT NULL,
  node_name VARCHAR(100),
  approver VARCHAR(100),
  action VARCHAR(20) NOT NULL,           -- 提交/通过/驳回/转办/加签/催办
  comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

## 五、表关系图

```
┌─────────────┐
│   brands    │
└──────┬──────┘
       │ 1:N
       ▼
┌─────────────┐      ┌─────────────────┐      ┌───────────────┐
│  stations   │◄─────│ station_shares  │─────►│ shareholders  │
└──────┬──────┘      └─────────────────┘      └───────────────┘
       │
       │ 1:N
       ├──────────────────────┬──────────────────────┬──────────────────────┐
       ▼                      ▼                      ▼                      ▼
┌─────────────┐      ┌─────────────────┐      ┌───────────────┐      ┌───────────────┐
│ electricity │      │   rent_leases   │      │ rent_incomes  │      │dividend_records│
│  _records   │      └─────────────────┘      └───────┬───────┘      └───────┬───────┘
└─────────────┘                                        │ 1:N                    │ 1:N
                                                       ▼                      ▼
                                               ┌───────────────┐      ┌───────────────┐
                                               │ rent_receipts │      │dividend_shares│
                                               └───────────────┘      └───────────────┘

┌─────────────────┐
│    contracts    │
└─────────────────┘

┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ approval_flows  │      │approval_requests│─────►│approval_records │
└─────────────────┘      └─────────────────┘      └─────────────────┘

┌─────────────────┐
│ meter_readings  │
└─────────────────┘
```

---

## 六、业务数据流

### 1. 电费业务流
```
站点 → 电费月台账（electricity_records）
  ├── 付款侧：向业主/电网付款
  │   ├── 手动录入抄表数据
  │   └── API自动拉取电表数据（meter_readings）
  └── 收款侧：向品牌方收款
      └── 按收款单价计算
```

### 2. 租金业务流
```
站点 → 租金台账
  ├── 付款合同（rent_leases）：公司向业主付租金
  │   └── 分期付款管理
  └── 收款合同（rent_incomes）：品牌方向公司付租金
      └── 分期收款管理（rent_receipts）
```

### 3. 分红业务流
```
站点 → 分红月结（dividend_records）
  ├── 电费利润
  ├── 租金利润
  └── 按股东占股比例计算分红（dividend_shares）
```

### 4. 审批业务流
```
审批流程配置（approval_flows）
  ↓
提交审批单（approval_requests）
  ↓
多节点审批（approval_records）
  ↓
审批完成（已通过/已驳回）
```

---

## 七、当前数据库问题分析

### 1. 数据冗余
- `contracts` 表中 `station_name` 和 `address` 是冗余字段，应该通过 `station_id` 关联查询

### 2. 缺少字段
- `stations` 表缺少经纬度字段（用于地图展示）
- `stations` 表缺少联系人字段

### 3. 枚举值硬编码
- 多处使用 ENUM 类型，不利于扩展（如状态、类型等）

### 4. JSON 字段
- `approval_flows.nodes`、`approval_requests.attachments`、`approval_requests.flow_nodes` 使用 TEXT 存储 JSON，查询不便

### 5. 缺少审计字段
- 部分表缺少 `updated_at` 字段
- 缺少操作人记录（created_by、updated_by）

---

## 八、重设计建议

### 1. 新增字段
- `stations` 表新增 `latitude`、`longitude`（经纬度）
- `stations` 表新增 `contact`、`phone`（联系人信息）
- 所有表统一添加 `created_by`、`updated_by` 审计字段

### 2. 优化枚举
- 将 ENUM 改为独立的配置表或使用整数编码
- 或使用 VARCHAR + 应用层校验

### 3. JSON 字段优化
- 考虑将 JSON 字段拆分为独立表（如审批节点配置表）
- 或使用 MySQL 5.7+ 的 JSON 类型

### 4. 索引优化
- 为常用查询字段添加索引（station_id、period、status 等）
- 复合索引优化查询性能

### 5. 数据完整性
- 添加外键约束（当前未定义）
- 添加唯一约束（如 station_id + period 组合唯一）

---

## 九、文档维护说明

本文档用于数据库重设计参考，业务逻辑基本不变。在重新设计数据库时，请参考：

1. **页面数据需求分析** - 了解每个页面需要哪些数据
2. **当前数据库结构** - 了解现有表结构和字段
3. **表关系图** - 了解表之间的关联关系
4. **业务数据流** - 了解数据的流向和处理逻辑
5. **问题分析** - 了解当前设计的问题
6. **重设计建议** - 参考优化方向

---

*文档版本: v1.0*
*最后更新: 2026-08-20*
