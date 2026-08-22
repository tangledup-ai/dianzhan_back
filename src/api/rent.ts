import client from "./client";

// 场地费月台账（Rent 页核心，v2）：按场地方/品牌方 × 月份 汇总+明细（仅场地费，不含电费）
export const getMonthlyLedger = (period: string, dim: "landlord" | "brand" = "landlord") =>
  client.get("/rent/monthly-ledger", { params: { period, dim } }).then(r => r.data);

// 运营费用（v3：按场地 landlordId）
export const listExpenses = (params?: { landlordId?: number; period?: string }) =>
  client.get("/rent/expenses", { params }).then(r => r.data);

export const saveExpense = (data: any) =>
  client.post("/rent/expenses", data).then(r => r.data);

export const deleteExpense = (id: number) =>
  client.delete(`/rent/expenses/${id}`).then(r => r.data);

// 年度付款计划（Rent 页底部模块）
export const getYearlyPaymentSchedule = (landlordId: number, year: string) =>
  client.get("/rent/yearly-payment-schedule", { params: { landlordId, year } }).then(r => r.data);
