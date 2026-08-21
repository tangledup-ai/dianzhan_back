// ─── Mock 数据（无数据库时演示用）────────────────────────────────
// 使用 as any 绕过 Drizzle 严格类型，仅用于前端演示

const now = new Date();

// 品牌
export const mockBrands: any[] = [
  { id: 1, name: "美团", contact: "张经理", remark: "全国合作品牌", createdAt: now },
  { id: 2, name: "哈啰", contact: "李经理", remark: null, createdAt: now },
  { id: 3, name: "青桔", contact: "王经理", remark: "滴滴旗下", createdAt: now },
];

// 公司主体
export const mockEntities: any[] = [
  { id: 1, name: "云南来换电新能源有限公司", shortName: "来换电", remark: null, createdAt: now },
  { id: 2, name: "昆明绿能科技有限公司", shortName: "绿能科技", remark: null, createdAt: now },
];

// 场地方/业主
export const mockLandlords: any[] = [
  { id: 1, name: "五华区物业管理有限公司", contact: "赵主任", phone: "13800001111", remark: null, createdAt: now },
  { id: 2, name: "盘龙区商业广场", contact: "钱经理", phone: "13800002222", remark: null, createdAt: now },
  { id: 3, name: "官渡区社区服务中心", contact: "孙站长", phone: "13800003333", remark: null, createdAt: now },
];

// 股东
export const mockShareholders: any[] = [
  { id: 1, name: "陈总", phone: "13900001111", remark: "大股东", createdAt: now },
  { id: 2, name: "刘总", phone: "13900002222", remark: null, createdAt: now },
  { id: 3, name: "周总", phone: "13900003333", remark: null, createdAt: now },
];

// 站点
export const mockStations: any[] = [
  { id: 1, name: "五华站A", code: "WH-001", region: "五华区", address: "五华区人民路100号", brandId: 1, entityId: 1, landlordId: 1, meterNo: "M-001", transformerRatio: "60", cabinets: "4", storageCabinets: "1", companyShare: "0.6", status: "运营中", remark: null, createdAt: now },
  { id: 2, name: "盘龙站B", code: "PL-002", region: "盘龙区", address: "盘龙区东风路200号", brandId: 2, entityId: 1, landlordId: 2, meterNo: "M-002", transformerRatio: "80", cabinets: "6", storageCabinets: "2", companyShare: "0.5", status: "运营中", remark: null, createdAt: now },
  { id: 3, name: "官渡站C", code: "GD-003", region: "官渡区", address: "官渡区关上路300号", brandId: 3, entityId: 2, landlordId: 3, meterNo: "M-003", transformerRatio: "40", cabinets: "3", storageCabinets: "1", companyShare: "0.7", status: "运营中", remark: "新建站点", createdAt: now },
  { id: 4, name: "西山站D", code: "XS-004", region: "西山区", address: "西山区滇池路400号", brandId: 1, entityId: 2, landlordId: null, meterNo: null, transformerRatio: null, cabinets: "2", storageCabinets: null, companyShare: "0.5", status: "筹建中", remark: null, createdAt: now },
];

// 站点-股东占股
export const mockStationShares: any[] = [
  { id: 1, stationId: 1, shareholderId: 1, ratio: "0.4", remark: null },
  { id: 2, stationId: 1, shareholderId: 2, ratio: "0.2", remark: null },
  { id: 3, stationId: 2, shareholderId: 1, ratio: "0.3", remark: null },
  { id: 4, stationId: 2, shareholderId: 3, ratio: "0.2", remark: null },
  { id: 5, stationId: 3, shareholderId: 2, ratio: "0.3", remark: null },
];

// 电费月台账
export const mockElectricityRecords: any[] = [
  { id: 1, stationId: 1, period: "2026-06", payStartDate: "2026-06-01", payStartReading: "1000.00", payEndDate: "2026-06-30", payEndReading: "3500.00", payKwh: "2500.00", payUnitPrice: "0.65", payAmount: "1625.00", payStatus: "已付款", collectStartDate: "2026-06-01", collectStartReading: "1000.00", collectEndDate: "2026-06-30", collectEndReading: "3500.00", collectKwh: "2500.00", collectUnitPrice: "1.20", collectAmount: "3000.00", taxRate: "0.01", collectNet: "2970.30", collectStatus: "已到账", profit: "1345.30", opExpense: "200.00", profitAfterOp: "1145.30", companyShare: "0.6000", companyNetProfit: "687.18", source: "manual", remark: null, createdAt: now, updatedAt: now },
  { id: 2, stationId: 2, period: "2026-06", payStartDate: "2026-06-01", payStartReading: "2000.00", payEndDate: "2026-06-30", payEndReading: "5800.00", payKwh: "3800.00", payUnitPrice: "0.60", payAmount: "2280.00", payStatus: "已付款", collectStartDate: "2026-06-01", collectStartReading: "2000.00", collectEndDate: "2026-06-30", collectEndReading: "5800.00", collectKwh: "3800.00", collectUnitPrice: "1.10", collectAmount: "4180.00", taxRate: "0.01", collectNet: "4138.20", collectStatus: "已到账", profit: "1858.20", opExpense: "300.00", profitAfterOp: "1558.20", companyShare: "0.5000", companyNetProfit: "779.10", source: "manual", remark: null, createdAt: now, updatedAt: now },
  { id: 3, stationId: 3, period: "2026-06", payStartDate: "2026-06-01", payStartReading: "500.00", payEndDate: "2026-06-30", payEndReading: "1700.00", payKwh: "1200.00", payUnitPrice: "0.70", payAmount: "840.00", payStatus: "未付款", collectStartDate: "2026-06-01", collectStartReading: "500.00", collectEndDate: "2026-06-30", collectEndReading: "1700.00", collectKwh: "1200.00", collectUnitPrice: "1.30", collectAmount: "1560.00", taxRate: "0.05", collectNet: "1485.71", collectStatus: "未到账", profit: "645.71", opExpense: "150.00", profitAfterOp: "495.71", companyShare: "0.7000", companyNetProfit: "347.00", source: "manual", remark: null, createdAt: now, updatedAt: now },
  { id: 4, stationId: 1, period: "2026-05", payStartDate: "2026-05-01", payStartReading: "800.00", payEndDate: "2026-05-31", payEndReading: "1000.00", payKwh: "2200.00", payUnitPrice: "0.65", payAmount: "1430.00", payStatus: "已付款", collectStartDate: "2026-05-01", collectStartReading: "800.00", collectEndDate: "2026-05-31", collectEndReading: "1000.00", collectKwh: "2200.00", collectUnitPrice: "1.20", collectAmount: "2640.00", taxRate: "0.01", collectNet: "2613.86", collectStatus: "已到账", profit: "1183.86", opExpense: "180.00", profitAfterOp: "1003.86", companyShare: "0.6000", companyNetProfit: "602.32", source: "manual", remark: null, createdAt: now, updatedAt: now },
  { id: 5, stationId: 2, period: "2026-05", payStartDate: "2026-05-01", payStartReading: "1800.00", payEndDate: "2026-05-31", payEndReading: "2000.00", payKwh: "3500.00", payUnitPrice: "0.60", payAmount: "2100.00", payStatus: "已付款", collectStartDate: "2026-05-01", collectStartReading: "1800.00", collectEndDate: "2026-05-31", collectEndReading: "2000.00", collectKwh: "3500.00", collectUnitPrice: "1.10", collectAmount: "3850.00", taxRate: "0.01", collectNet: "3811.88", collectStatus: "已到账", profit: "1711.88", opExpense: "280.00", profitAfterOp: "1431.88", companyShare: "0.5000", companyNetProfit: "715.94", source: "manual", remark: null, createdAt: now, updatedAt: now },
];

// 场地租金（付款）
export const mockRentLeases: any[] = [
  { id: 1, stationId: 1, contractStart: "2025-01-01", contractEnd: "2027-12-31", annualRent: "12000.00", payMethod: "季付", payAmount: "3000.00", deposit: "5000.00", payDeadline: "2026-04-01", payStatus: "已付款", invoiceType: "对公", remark: null, createdAt: now },
  { id: 2, stationId: 2, contractStart: "2025-06-01", contractEnd: "2026-05-31", annualRent: "18000.00", payMethod: "半年付", payAmount: "9000.00", deposit: "8000.00", payDeadline: "2026-06-01", payStatus: "未付款", invoiceType: "对私", remark: "合同即将到期", createdAt: now },
  { id: 3, stationId: 3, contractStart: "2026-01-01", contractEnd: "2028-12-31", annualRent: "9600.00", payMethod: "年付", payAmount: "9600.00", deposit: "3000.00", payDeadline: "2027-01-01", payStatus: "已付款", invoiceType: "对公", remark: null, createdAt: now },
];

// 场地租金（收款）
export const mockRentIncomes: any[] = [
  { id: 1, stationId: 1, contractStart: "2025-01-01", contractEnd: "2027-12-31", unitMonthlyRent: "500.00", cabinetsCount: "4", annualIncome: "24000.00", monthlyRent: "2000.00", taxRate: "0.01", annualIncomeNet: "23762.38", inputCost: "5000.00", profit: "18762.38", dividendAmount: "8000.00", profitAfterDividend: "10762.38", signStatus: "已签约已开票", remark: null, createdAt: now },
  { id: 2, stationId: 2, contractStart: "2025-06-01", contractEnd: "2026-05-31", unitMonthlyRent: "400.00", cabinetsCount: "6", annualIncome: "28800.00", monthlyRent: "2400.00", taxRate: "0.01", annualIncomeNet: "28514.85", inputCost: "6000.00", profit: "22514.85", dividendAmount: "10000.00", profitAfterDividend: "12514.85", signStatus: "已签约", remark: null, createdAt: now },
];

// 租金分期收款
export const mockRentReceipts: any[] = [
  { id: 1, rentIncomeId: 1, seq: "1", periodStart: "2025-01-01", periodEnd: "2025-06-30", amount: "12000.00", status: "已到账", remark: null },
  { id: 2, rentIncomeId: 1, seq: "2", periodStart: "2025-07-01", periodEnd: "2025-12-31", amount: "12000.00", status: "已到账", remark: null },
  { id: 3, rentIncomeId: 1, seq: "3", periodStart: "2026-01-01", periodEnd: "2026-06-30", amount: "12000.00", status: "未到账", remark: null },
  { id: 4, rentIncomeId: 2, seq: "1", periodStart: "2025-06-01", periodEnd: "2025-11-30", amount: "14400.00", status: "已到账", remark: null },
  { id: 5, rentIncomeId: 2, seq: "2", periodStart: "2025-12-01", periodEnd: "2026-05-31", amount: "14400.00", status: "未到账", remark: null },
];

// 合同
export const mockContracts: any[] = [
  { id: 1, brandId: 1, stationId: 1, stationName: "五华站A", address: "五华区人民路100号", payEntity: "云南来换电新能源有限公司", partner: "美团", contractType: "合作", startDate: "2025-01-01", endDate: "2027-12-31", remark: null, createdAt: now },
  { id: 2, brandId: 2, stationId: 2, stationName: "盘龙站B", address: "盘龙区东风路200号", payEntity: "云南来换电新能源有限公司", partner: "哈啰", contractType: "场租收款", startDate: "2025-06-01", endDate: "2026-05-31", remark: "即将到期需续签", createdAt: now },
  { id: 3, brandId: 3, stationId: 3, stationName: "官渡站C", address: "官渡区关上路300号", payEntity: "昆明绿能科技有限公司", partner: "青桔", contractType: "电费", startDate: "2026-01-01", endDate: "2028-12-31", remark: null, createdAt: now },
];

// 分红记录
export const mockDividendRecords: any[] = [
  { id: 1, stationId: 1, period: "2026-06", kwh: "2500.00", payUnitPrice: "0.650000", payAmount: "1625.00", elecIncomeTax: "3000.00", elecIncomeNet: "2970.30", rentIncomeTax: "2000.00", rentIncomeNet: "1980.20", totalIncome: "4950.50", profit: "3325.50", status: "已结算", remark: null, createdAt: now },
  { id: 2, stationId: 2, period: "2026-06", kwh: "3800.00", payUnitPrice: "0.600000", payAmount: "2280.00", elecIncomeTax: "4180.00", elecIncomeNet: "4138.20", rentIncomeTax: "2400.00", rentIncomeNet: "2376.24", totalIncome: "6514.44", profit: "4234.44", status: "未结算", remark: null, createdAt: now },
  { id: 3, stationId: 1, period: "2026-05", kwh: "2200.00", payUnitPrice: "0.650000", payAmount: "1430.00", elecIncomeTax: "2640.00", elecIncomeNet: "2613.86", rentIncomeTax: "2000.00", rentIncomeNet: "1980.20", totalIncome: "4594.06", profit: "3164.06", status: "已结算", remark: null, createdAt: now },
  { id: 4, stationId: 3, period: "2026-06", kwh: "1200.00", payUnitPrice: "0.700000", payAmount: "840.00", elecIncomeTax: "1560.00", elecIncomeNet: "1485.71", rentIncomeTax: "800.00", rentIncomeNet: "792.08", totalIncome: "2277.79", profit: "1437.79", status: "已结算", remark: null, createdAt: now },
  { id: 5, stationId: 2, period: "2026-05", kwh: "3500.00", payUnitPrice: "0.600000", payAmount: "2100.00", elecIncomeTax: "3850.00", elecIncomeNet: "3811.88", rentIncomeTax: "2400.00", rentIncomeNet: "2376.24", totalIncome: "6188.12", profit: "4088.12", status: "已结算", remark: null, createdAt: now },
  { id: 6, stationId: 1, period: "2026-04", kwh: "2100.00", payUnitPrice: "0.650000", payAmount: "1365.00", elecIncomeTax: "2520.00", elecIncomeNet: "2495.05", rentIncomeTax: "2000.00", rentIncomeNet: "1980.20", totalIncome: "4475.25", profit: "3110.25", status: "已结算", remark: null, createdAt: now },
];

// 分红明细
export const mockDividendShares: any[] = [
  { id: 1, dividendId: 1, shareholderId: 1, ratio: "0.4000", amount: "1330.20" },
  { id: 2, dividendId: 1, shareholderId: 2, ratio: "0.2000", amount: "665.10" },
  { id: 3, dividendId: 2, shareholderId: 1, ratio: "0.3000", amount: "1270.33" },
  { id: 4, dividendId: 2, shareholderId: 3, ratio: "0.2000", amount: "846.89" },
  { id: 5, dividendId: 3, shareholderId: 1, ratio: "0.4000", amount: "1265.62" },
  { id: 6, dividendId: 3, shareholderId: 2, ratio: "0.2000", amount: "632.81" },
  { id: 7, dividendId: 4, shareholderId: 2, ratio: "0.3000", amount: "431.34" },
  { id: 8, dividendId: 5, shareholderId: 1, ratio: "0.3000", amount: "1226.44" },
  { id: 9, dividendId: 5, shareholderId: 3, ratio: "0.2000", amount: "817.62" },
  { id: 10, dividendId: 6, shareholderId: 1, ratio: "0.4000", amount: "1244.10" },
  { id: 11, dividendId: 6, shareholderId: 2, ratio: "0.2000", amount: "622.05" },
];

// 电表抄表（含激增/激减模式演示）
export const mockMeterReadings: any[] = [
  // 五华站A — 平稳正常
  { id: 1, stationId: 1, meterNo: "M-001", reading: "1000.00", readingAt: new Date("2026-06-01T00:00:00"), source: "manual", createdAt: now },
  { id: 2, stationId: 1, meterNo: "M-001", reading: "2200.00", readingAt: new Date("2026-06-10T12:00:00"), source: "api", createdAt: now },
  { id: 3, stationId: 1, meterNo: "M-001", reading: "3500.00", readingAt: new Date("2026-06-20T12:00:00"), source: "api", createdAt: now },
  { id: 4, stationId: 1, meterNo: "M-001", reading: "4800.00", readingAt: new Date("2026-06-30T23:59:00"), source: "api", createdAt: now },
  // 盘龙站B — 激增（6月20日后用量暴增）
  { id: 5, stationId: 2, meterNo: "M-002", reading: "2000.00", readingAt: new Date("2026-06-01T00:00:00"), source: "manual", createdAt: now },
  { id: 6, stationId: 2, meterNo: "M-002", reading: "2500.00", readingAt: new Date("2026-06-10T12:00:00"), source: "api", createdAt: now },
  { id: 7, stationId: 2, meterNo: "M-002", reading: "6800.00", readingAt: new Date("2026-06-20T12:00:00"), source: "api", createdAt: now },
  { id: 8, stationId: 2, meterNo: "M-002", reading: "11000.00", readingAt: new Date("2026-06-30T23:59:00"), source: "api", createdAt: now },
  // 官渡站C — 激减（6月20日后用量骤降）
  { id: 9, stationId: 3, meterNo: "M-003", reading: "800.00", readingAt: new Date("2026-06-01T00:00:00"), source: "manual", createdAt: now },
  { id: 10, stationId: 3, meterNo: "M-003", reading: "2000.00", readingAt: new Date("2026-06-10T12:00:00"), source: "api", createdAt: now },
  { id: 11, stationId: 3, meterNo: "M-003", reading: "2600.00", readingAt: new Date("2026-06-20T12:00:00"), source: "api", createdAt: now },
  { id: 12, stationId: 3, meterNo: "M-003", reading: "2700.00", readingAt: new Date("2026-06-30T23:59:00"), source: "api", createdAt: now },
];

// 审批
export const mockApprovalRequests: any[] = [
  { id: 1, bizType: "电费付款", title: "五华站A 2026年6月电费", reason: "6月用电量2500度", amount: "1625.00", applicant: "张三", attachments: "[]", flowNodes: JSON.stringify([{ name: "经办人", approver: "经办人" }, { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 }, { name: "总经理审批", approver: "陈总", timeoutHours: 48 }, { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 }]), currentNode: 2, status: "审批中", urgeCount: 0, createdAt: new Date("2026-07-20T09:00:00"), finishedAt: null },
  { id: 2, bizType: "租金付款", title: "盘龙站B 场地租金", reason: "半年付租金", amount: "9000.00", applicant: "李四", attachments: "[]", flowNodes: JSON.stringify([{ name: "经办人", approver: "经办人" }, { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 }, { name: "总经理审批", approver: "陈总", timeoutHours: 48 }, { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 }]), currentNode: 3, status: "审批中", urgeCount: 1, createdAt: new Date("2026-07-18T14:00:00"), finishedAt: null },
  { id: 3, bizType: "费用报销", title: "办公用品采购", reason: "采购打印纸、文具等", amount: "580.00", applicant: "王五", attachments: "[]", flowNodes: JSON.stringify([{ name: "经办人", approver: "经办人" }, { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 }, { name: "总经理审批", approver: "陈总", timeoutHours: 48 }, { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 }]), currentNode: 4, status: "已通过", urgeCount: 0, createdAt: new Date("2026-07-15T10:00:00"), finishedAt: new Date("2026-07-17T16:00:00") },
];

export const mockApprovalRecords: any[] = [
  { id: 1, requestId: 1, nodeIndex: 0, nodeName: "经办人", approver: "张三", action: "提交", comment: "6月用电量2500度", createdAt: new Date("2026-07-20T09:00:00") },
  { id: 2, requestId: 1, nodeIndex: 1, nodeName: "部门负责人", approver: "部门负责人", action: "通过", comment: "同意", createdAt: new Date("2026-07-21T10:00:00") },
  { id: 3, requestId: 2, nodeIndex: 0, nodeName: "经办人", approver: "李四", action: "提交", comment: "半年付租金", createdAt: new Date("2026-07-18T14:00:00") },
  { id: 4, requestId: 2, nodeIndex: 1, nodeName: "部门负责人", approver: "部门负责人", action: "通过", comment: null, createdAt: new Date("2026-07-19T09:00:00") },
  { id: 5, requestId: 2, nodeIndex: 2, nodeName: "总经理审批", approver: "陈总", action: "通过", comment: "同意", createdAt: new Date("2026-07-20T11:00:00") },
];

// 审批流程配置
export const mockApprovalFlows: any[] = [
  { id: 1, bizType: "电费付款", nodes: JSON.stringify([{ name: "经办人", approver: "经办人" }, { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 }, { name: "总经理审批", approver: "陈总", timeoutHours: 48 }, { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 }]), updatedAt: now },
  { id: 2, bizType: "租金付款", nodes: JSON.stringify([{ name: "经办人", approver: "经办人" }, { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 }, { name: "总经理审批", approver: "陈总", timeoutHours: 48 }, { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 }]), updatedAt: now },
  { id: 3, bizType: "股东分红", nodes: JSON.stringify([{ name: "经办人", approver: "经办人" }, { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 }, { name: "总经理审批", approver: "陈总", timeoutHours: 48 }, { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 }]), updatedAt: now },
  { id: 4, bizType: "费用报销", nodes: JSON.stringify([{ name: "经办人", approver: "经办人" }, { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 }, { name: "总经理审批", approver: "陈总", timeoutHours: 48 }, { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 }]), updatedAt: now },
  { id: 5, bizType: "其他", nodes: JSON.stringify([{ name: "经办人", approver: "经办人" }, { name: "总经理审批", approver: "陈总", timeoutHours: 48 }]), updatedAt: now },
];
