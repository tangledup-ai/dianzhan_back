import client from "./client";

// 场地费月台账（Rent 页核心，v2）：按场地方/品牌方 × 月份 汇总+明细（仅场地费，不含电费）
export const getMonthlyLedger = (period: string, dim: "landlord" | "brand" = "landlord") =>
  client.get("/rent/monthly-ledger", { params: { period, dim } }).then(r => r.data);

// 场租付款合同
export const listLeases = (params?: { stationId?: number }) =>
  client.get("/rent/leases", { params }).then(r => r.data);

export const createLease = (data: any) =>
  client.post("/rent/leases", data).then(r => r.data);

export const updateLease = (id: number, data: any) =>
  client.put(`/rent/leases/${id}`, data).then(r => r.data);

export const deleteLease = (id: number) =>
  client.delete(`/rent/leases/${id}`).then(r => r.data);

// 场租收款合同
export const listIncomes = (params?: { stationId?: number; brandId?: number }) =>
  client.get("/rent/incomes", { params }).then(r => r.data);

export const createIncome = (data: any) =>
  client.post("/rent/incomes", data).then(r => r.data);

export const updateIncome = (id: number, data: any) =>
  client.put(`/rent/incomes/${id}`, data).then(r => r.data);

export const deleteIncome = (id: number) =>
  client.delete(`/rent/incomes/${id}`).then(r => r.data);

// 租金分期收款
export const listReceipts = (params?: { rentIncomeId?: number }) =>
  client.get("/rent/receipts", { params }).then(r => r.data);

export const createReceipt = (data: any) =>
  client.post("/rent/receipts", data).then(r => r.data);

export const updateReceipt = (id: number, data: any) =>
  client.put(`/rent/receipts/${id}`, data).then(r => r.data);

export const deleteReceipt = (id: number) =>
  client.delete(`/rent/receipts/${id}`).then(r => r.data);

// 美团台账Excel数据
export const getExcelData = (stationName?: string) =>
  client.get("/rent/excel-data", { params: stationName ? { stationName } : {} }).then(r => r.data);

// 付款记录（年度付款情况、发票）
export const listPaymentRecords = (params?: { stationName?: string; brandId?: number }) =>
  client.get("/rent/payment-records", { params }).then(r => r.data);

export const upsertPaymentRecord = (data: any) =>
  client.post("/rent/payment-records", data).then(r => r.data);

export const deletePaymentRecord = (id: number) =>
  client.delete(`/rent/payment-records/${id}`).then(r => r.data);

// 收款记录（年度收款情况、进项成本）
export const listIncomeRecords = (params?: { stationName?: string; brandId?: number }) =>
  client.get("/rent/income-records", { params }).then(r => r.data);

export const upsertIncomeRecord = (data: any) =>
  client.post("/rent/income-records", data).then(r => r.data);

export const deleteIncomeRecord = (id: number) =>
  client.delete(`/rent/income-records/${id}`).then(r => r.data);

// 运营费用（v3：按场地 landlordId）
export const listExpenses = (params?: { landlordId?: number; period?: string }) =>
  client.get("/rent/expenses", { params }).then(r => r.data);

export const saveExpense = (data: any) =>
  client.post("/rent/expenses", data).then(r => r.data);

export const deleteExpense = (id: number) =>
  client.delete(`/rent/expenses/${id}`).then(r => r.data);
