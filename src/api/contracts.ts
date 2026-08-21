import client from "./client";

export const listContracts = (params?: { brandId?: number; landlordId?: number; contractType?: string; keyword?: string }) =>
  client.get("/contracts", { params }).then(r => r.data);

export const createContract = (data: any) =>
  client.post("/contracts", data).then(r => r.data);

export const updateContract = (id: number, data: any) =>
  client.put(`/contracts/${id}`, data).then(r => r.data);

export const deleteContract = (id: number) =>
  client.delete(`/contracts/${id}`).then(r => r.data);

// ─── 合同收付款分期 ───
export const listPaymentSchedules = (contractId?: number) =>
  client.get("/contract-schedules/payment", { params: contractId ? { contractId } : {} }).then(r => r.data);

export const listIncomeSchedules = (contractId?: number) =>
  client.get("/contract-schedules/income", { params: contractId ? { contractId } : {} }).then(r => r.data);

export const createSchedule = (data: { contractId: number; side: string; periodStart?: string; periodEnd?: string; amount?: number; status?: string; payDate?: string; invoice?: string; remark?: string }) =>
  client.post("/contract-schedules", data).then(r => r.data);

export const updateSchedule = (id: number, data: any) =>
  client.put(`/contract-schedules/${id}`, data).then(r => r.data);

export const markScheduleDone = (id: number, side: "payment" | "income") => {
  const status = side === "payment" ? "已付款" : "已到账";
  const today = new Date().toISOString().slice(0, 10);
  return updateSchedule(id, { status, payDate: today, side });
};
