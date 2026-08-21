import {
  mysqlTable,
  mysqlEnum,
  serial,
  bigint,
  varchar,
  text,
  decimal,
  date,
  timestamp,
} from "drizzle-orm/mysql-core";

// ─── 基础档案 ────────────────────────────────────────────────

// 品牌方（美团 / 哈啰 / 青桔 / 八维通 / 台铃 / 民用柜各品牌等）
export const brands = mysqlTable("brands", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  contact: varchar("contact", { length: 100 }),
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 公司主体（收款/付款公司，如 云南来换电新能源有限公司）
export const entities = mysqlTable("entities", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 150 }).notNull().unique(),
  shortName: varchar("short_name", { length: 50 }),
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 场地方 / 业主
export const landlords = mysqlTable("landlords", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 150 }).notNull().unique(),
  contact: varchar("contact", { length: 100 }),
  phone: varchar("phone", { length: 50 }),
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 股东
export const shareholders = mysqlTable("shareholders", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  phone: varchar("phone", { length: 50 }),
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── 站点 ────────────────────────────────────────────────────

export const stations = mysqlTable("stations", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  code: varchar("code", { length: 50 }), // 站点号
  region: varchar("region", { length: 50 }), // 区域：五华/盘龙/官渡/西山/呈贡…
  address: varchar("address", { length: 300 }),
  brandId: bigint("brand_id", { mode: "number", unsigned: true }),
  entityId: bigint("entity_id", { mode: "number", unsigned: true }),
  landlordId: bigint("landlord_id", { mode: "number", unsigned: true }),
  meterNo: varchar("meter_no", { length: 100 }), // 电表编号（智慧电表API以此关联）
  transformerRatio: decimal("transformer_ratio", { precision: 10, scale: 2 }),
  cabinets: decimal("cabinets", { precision: 8, scale: 2 }), // 换电柜数量
  storageCabinets: decimal("storage_cabinets", { precision: 8, scale: 2 }), // 储电/防爆柜数量
  companyShare: decimal("company_share", { precision: 5, scale: 4 }), // 公司占股
  status: mysqlEnum("status", ["运营中", "筹建中", "已关停"]).notNull().default("运营中"),
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 站点-股东占股（分红比例）
export const stationShares = mysqlTable("station_shares", {
  id: serial("id").primaryKey(),
  stationId: bigint("station_id", { mode: "number", unsigned: true }).notNull(),
  shareholderId: bigint("shareholder_id", { mode: "number", unsigned: true }).notNull(),
  ratio: decimal("ratio", { precision: 6, scale: 4 }).notNull(), // 0.3 等
  remark: varchar("remark", { length: 200 }),
});

// ─── 电费月台账（站点 × 月份）────────────────────────────────
// 付款侧：向业主/电网按付款单价结算；收款侧：向品牌方按收款单价结算
export const electricityRecords = mysqlTable("electricity_records", {
  id: serial("id").primaryKey(),
  stationId: bigint("station_id", { mode: "number", unsigned: true }).notNull(),
  period: varchar("period", { length: 7 }).notNull(), // 2026-06
  // 付款侧
  payStartDate: date("pay_start_date", { mode: "string" }),
  payStartReading: decimal("pay_start_reading", { precision: 14, scale: 2 }),
  payEndDate: date("pay_end_date", { mode: "string" }),
  payEndReading: decimal("pay_end_reading", { precision: 14, scale: 2 }),
  payKwh: decimal("pay_kwh", { precision: 14, scale: 2 }), // 区间度数（含互感器倍数换算后）
  payUnitPrice: decimal("pay_unit_price", { precision: 8, scale: 4 }),
  payAmount: decimal("pay_amount", { precision: 14, scale: 2 }),
  payStatus: mysqlEnum("pay_status", ["未付款", "已付款"]).notNull().default("未付款"),
  // 收款侧
  collectStartDate: date("collect_start_date", { mode: "string" }),
  collectStartReading: decimal("collect_start_reading", { precision: 14, scale: 2 }),
  collectEndDate: date("collect_end_date", { mode: "string" }),
  collectEndReading: decimal("collect_end_reading", { precision: 14, scale: 2 }),
  collectKwh: decimal("collect_kwh", { precision: 14, scale: 2 }),
  collectUnitPrice: decimal("collect_unit_price", { precision: 8, scale: 4 }),
  collectAmount: decimal("collect_amount", { precision: 14, scale: 2 }),
  taxRate: decimal("tax_rate", { precision: 5, scale: 4 }), // 0.01 / 0.05 等
  collectNet: decimal("collect_net", { precision: 14, scale: 2 }), // 不含税收入
  collectStatus: mysqlEnum("collect_status", ["未到账", "已到账"]).notNull().default("未到账"),
  // 利润
  profit: decimal("profit", { precision: 14, scale: 2 }), // collectNet - payAmount
  opExpense: decimal("op_expense", { precision: 14, scale: 2 }), // 运营费用
  profitAfterOp: decimal("profit_after_op", { precision: 14, scale: 2 }),
  companyShare: decimal("company_share", { precision: 5, scale: 4 }), // 公司占股快照
  companyNetProfit: decimal("company_net_profit", { precision: 14, scale: 2 }),
  source: mysqlEnum("source", ["manual", "meter_api"]).notNull().default("manual"),
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ─── 智慧电表抄表记录（API 自动录入 + 手工补录）──────────────
export const meterReadings = mysqlTable("meter_readings", {
  id: serial("id").primaryKey(),
  stationId: bigint("station_id", { mode: "number", unsigned: true }).notNull(),
  meterNo: varchar("meter_no", { length: 100 }).notNull(),
  reading: decimal("reading", { precision: 14, scale: 2 }).notNull(), // 表码
  readingAt: timestamp("reading_at").notNull(),
  source: mysqlEnum("source", ["api", "manual"]).notNull().default("api"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── 场地租金 ────────────────────────────────────────────────
// 付款合同：公司向业主租场地
export const rentLeases = mysqlTable("rent_leases", {
  id: serial("id").primaryKey(),
  stationId: bigint("station_id", { mode: "number", unsigned: true }).notNull(),
  contractStart: date("contract_start", { mode: "string" }),
  contractEnd: date("contract_end", { mode: "string" }),
  annualRent: decimal("annual_rent", { precision: 12, scale: 2 }), // 年租金成本
  payMethod: varchar("pay_method", { length: 50 }), // 年付/半年付/季付
  payAmount: decimal("pay_amount", { precision: 12, scale: 2 }), // 每期付款金额
  deposit: decimal("deposit", { precision: 12, scale: 2 }), // 押金
  payDeadline: date("pay_deadline", { mode: "string" }), // 付款截止时间
  payStatus: mysqlEnum("pay_status", ["未付款", "已付款"]).notNull().default("未付款"),
  invoiceType: varchar("invoice_type", { length: 20 }), // 对公/对私
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 收款合同：品牌方向公司付场地租金
export const rentIncomes = mysqlTable("rent_incomes", {
  id: serial("id").primaryKey(),
  stationId: bigint("station_id", { mode: "number", unsigned: true }).notNull(),
  contractStart: date("contract_start", { mode: "string" }),
  contractEnd: date("contract_end", { mode: "string" }),
  unitMonthlyRent: decimal("unit_monthly_rent", { precision: 10, scale: 2 }), // 单柜月租金（含税）
  cabinetsCount: decimal("cabinets_count", { precision: 8, scale: 2 }), // 计费柜数
  annualIncome: decimal("annual_income", { precision: 12, scale: 2 }), // 年租金收入（含税）
  monthlyRent: decimal("monthly_rent", { precision: 12, scale: 2 }), // 月租金
  taxRate: decimal("tax_rate", { precision: 5, scale: 4 }),
  annualIncomeNet: decimal("annual_income_net", { precision: 12, scale: 2 }), // 不含税
  inputCost: decimal("input_cost", { precision: 12, scale: 2 }), // 进项成本
  profit: decimal("profit", { precision: 12, scale: 2 }), // 租金利润
  dividendAmount: decimal("dividend_amount", { precision: 12, scale: 2 }), // 分红金额
  profitAfterDividend: decimal("profit_after_dividend", { precision: 12, scale: 2 }),
  signStatus: varchar("sign_status", { length: 100 }), // 签约/开票/到账情况
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 租金分期收款
export const rentReceipts = mysqlTable("rent_receipts", {
  id: serial("id").primaryKey(),
  rentIncomeId: bigint("rent_income_id", { mode: "number", unsigned: true }).notNull(),
  seq: decimal("seq", { precision: 3, scale: 0 }).notNull(), // 第几次收款
  periodStart: date("period_start", { mode: "string" }),
  periodEnd: date("period_end", { mode: "string" }),
  amount: decimal("amount", { precision: 12, scale: 2 }),
  status: mysqlEnum("status", ["未到账", "已到账"]).notNull().default("未到账"),
  remark: varchar("remark", { length: 200 }),
});

// ─── 合同管理 ────────────────────────────────────────────────
export const contracts = mysqlTable("contracts", {
  id: serial("id").primaryKey(),
  brandId: bigint("brand_id", { mode: "number", unsigned: true }),
  stationId: bigint("station_id", { mode: "number", unsigned: true }),
  stationName: varchar("station_name", { length: 200 }).notNull(),
  address: varchar("address", { length: 300 }),
  payEntity: varchar("pay_entity", { length: 150 }), // 付款主体
  partner: varchar("partner", { length: 150 }), // 合作方
  contractType: mysqlEnum("contract_type", ["场租付款", "场租收款", "电费", "合作", "其他"]).notNull().default("合作"),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── 股东分红月结 ────────────────────────────────────────────
export const dividendRecords = mysqlTable("dividend_records", {
  id: serial("id").primaryKey(),
  stationId: bigint("station_id", { mode: "number", unsigned: true }).notNull(),
  period: varchar("period", { length: 7 }).notNull(), // 2026-01
  kwh: decimal("kwh", { precision: 14, scale: 2 }), // 电量
  payUnitPrice: decimal("pay_unit_price", { precision: 8, scale: 6 }),
  payAmount: decimal("pay_amount", { precision: 14, scale: 2 }), // 电费付款金额
  elecIncomeTax: decimal("elec_income_tax", { precision: 14, scale: 2 }), // 收款电费含税
  elecIncomeNet: decimal("elec_income_net", { precision: 14, scale: 2 }), // 电费不含税
  rentIncomeTax: decimal("rent_income_tax", { precision: 14, scale: 2 }), // 收款租金含税
  rentIncomeNet: decimal("rent_income_net", { precision: 14, scale: 2 }), // 租金不含税
  totalIncome: decimal("total_income", { precision: 14, scale: 2 }), // 电费租金收款合计
  profit: decimal("profit", { precision: 14, scale: 2 }), // 利润
  status: mysqlEnum("status", ["未结算", "已结算"]).notNull().default("未结算"),
  remark: text("remark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 分红明细（股东 × 比例 × 金额）
export const dividendShares = mysqlTable("dividend_shares", {
  id: serial("id").primaryKey(),
  dividendId: bigint("dividend_id", { mode: "number", unsigned: true }).notNull(),
  shareholderId: bigint("shareholder_id", { mode: "number", unsigned: true }).notNull(),
  ratio: decimal("ratio", { precision: 6, scale: 4 }).notNull(),
  amount: decimal("amount", { precision: 14, scale: 2 }),
});

// ─── 审批流 ──────────────────────────────────────────────────
import { int } from "drizzle-orm/mysql-core";

// 审批流程配置（按业务类型自定义节点）
export const approvalFlows = mysqlTable("approval_flows", {
  id: serial("id").primaryKey(),
  bizType: varchar("biz_type", { length: 50 }).notNull().unique(), // 电费付款/租金付款/股东分红/费用报销/其他
  nodes: text("nodes").notNull(), // JSON: [{name, approver, timeoutHours}]
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// 审批单
export const approvalRequests = mysqlTable("approval_requests", {
  id: serial("id").primaryKey(),
  bizType: varchar("biz_type", { length: 50 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(), // 审批事由
  reason: text("reason"),
  amount: decimal("amount", { precision: 14, scale: 2 }),
  applicant: varchar("applicant", { length: 100 }).notNull(),
  attachments: text("attachments"), // JSON: [{name, size}]
  flowNodes: text("flow_nodes").notNull(), // 提交时的流程快照
  currentNode: int("current_node").notNull().default(0),
  status: mysqlEnum("status", ["审批中", "已通过", "已驳回"]).notNull().default("审批中"),
  urgeCount: int("urge_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

// 审批记录（全程留痕）
export const approvalRecords = mysqlTable("approval_records", {
  id: serial("id").primaryKey(),
  requestId: bigint("request_id", { mode: "number", unsigned: true }).notNull(),
  nodeIndex: int("node_index").notNull(),
  nodeName: varchar("node_name", { length: 100 }),
  approver: varchar("approver", { length: 100 }),
  action: varchar("action", { length: 20 }).notNull(), // 提交/通过/驳回/转办/加签/催办
  comment: text("comment"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
