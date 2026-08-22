import client from "./client";

// 分红配置（v3：挂场地 landlord_id；brand_id 空=整场地 / 非空=指定品牌）
export const listShareholderConfigs = (params?: { landlordId?: number; brandId?: number }) =>
  client.get("/dividends/configs/shareholder", { params }).then(r => r.data);

export const saveShareholderConfig = (data: any) =>
  client.post("/dividends/configs/shareholder", data).then(r => r.data);

export const deleteShareholderConfig = (id: number) =>
  client.delete(`/dividends/configs/shareholder/${id}`).then(r => r.data);

export const listIntroducerConfigs = (params?: { landlordId?: number; brandId?: number }) =>
  client.get("/dividends/configs/introducer", { params }).then(r => r.data);

export const saveIntroducerConfig = (data: any) =>
  client.post("/dividends/configs/introducer", data).then(r => r.data);

export const deleteIntroducerConfig = (id: number) =>
  client.delete(`/dividends/configs/introducer/${id}`).then(r => r.data);

// 分红计算（v3：按场地 landlordId + 可选品牌 brandId；estimate=true 返回本月预估 + 周期信息）
export const calculateDividend = (data: { landlordId: number; brandId?: number | null; period: string; estimate?: boolean }) =>
  client.post("/dividends/calculate", data).then(r => r.data);

// 分红记录
export const listDividends = (params?: { landlordId?: number; brandId?: number; period?: string; type?: string; status?: string }) =>
  client.get("/dividends", { params }).then(r => r.data);

export const getDividend = (id: number) =>
  client.get(`/dividends/${id}`).then(r => r.data);

export const createDividend = (data: any) =>
  client.post("/dividends", data).then(r => r.data);

export const submitDividend = (id: number, data: any) =>
  client.post(`/dividends/${id}/submit`, data).then(r => r.data);

export const approveDividend = (id: number, data: any) =>
  client.post(`/dividends/${id}/approve`, data).then(r => r.data);

export const rejectDividend = (id: number, data: any) =>
  client.post(`/dividends/${id}/reject`, data).then(r => r.data);

export const settleDividend = (id: number, data: any) =>
  client.post(`/dividends/${id}/settle`, data).then(r => r.data);

export const deleteDividend = (id: number) =>
  client.delete(`/dividends/${id}`).then(r => r.data);

// 分红汇总
export const shareholderSummary = (params?: { shareholderId?: number; period?: string; periodStart?: string; periodEnd?: string }) =>
  client.get("/dividends/summary/shareholder", { params }).then(r => r.data);

export const introducerSummary = (params?: { introducerId?: number; period?: string }) =>
  client.get("/dividends/summary/introducer", { params }).then(r => r.data);
