import client from "./client";

export const listElectricity = (params?: { stationId?: number; period?: string }) =>
  client.get("/electricity", { params }).then(r => r.data);

export const getElectricity = (id: number) =>
  client.get(`/electricity/${id}`).then(r => r.data);

export const listPeriods = () =>
  client.get("/electricity/periods").then(r => r.data);

export const createElectricity = (data: any) =>
  client.post("/electricity", data).then(r => r.data);

export const updateElectricity = (id: number, data: any) =>
  client.put(`/electricity/${id}`, data).then(r => r.data);

export const deleteElectricity = (id: number) =>
  client.delete(`/electricity/${id}`).then(r => r.data);

// v3：台账按 场地×品牌 生成（不传 stationId；可选 landlordId 限定范围，空=全部场地）
export const generateElectricity = (data: { period: string; landlordId?: number }) =>
  client.post("/electricity/generate", data).then(r => r.data);

// 电费月台账（Electricity 页，v2）：按场地方/品牌方 × 月份 汇总+明细（只含电费）
export const getElectricityMonthlyLedger = (period: string, dim: "landlord" | "brand" = "landlord") =>
  client.get("/electricity/monthly-ledger", { params: { period, dim } }).then(r => r.data);

// 电费收付明细导出（参考 Excel 格式：每电表一行）
export const exportElectricityLedger = (period: string, dim: "landlord" | "brand" = "landlord") =>
  client.get("/electricity/export", { params: { period, dim } }).then(r => r.data);

// 单块电表的抄表核对详情（上月/本月抄表读数与日期、区间度数、台账费用）
export const getReadingDetail = (meterNo: string, period: string) =>
  client.get("/electricity/reading-detail", { params: { meterNo, period } }).then(r => r.data);

// 只更新付款/收款状态（点击状态徽章编辑；不影响金额与数据来源）
export const updateElectricityStatus = (id: number, data: { payStatus?: string; collectStatus?: string }) =>
  client.put(`/electricity/${id}/status`, data).then((r: any) => r.data);
