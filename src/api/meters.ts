import client from "./client";

// v3：按场地（landlordId）查询电表
export const listMeters = (params?: { landlordId?: number; stationId?: number; brandId?: number }) =>
  client.get("/meters", { params }).then(r => r.data);

export const getMeter = (id: number) =>
  client.get(`/meters/${id}`).then(r => r.data);

export const createMeter = (data: any) =>
  client.post("/meters", data).then(r => r.data);

export const updateMeter = (id: number, data: any) =>
  client.put(`/meters/${id}`, data).then(r => r.data);

export const deleteMeter = (id: number) =>
  client.delete(`/meters/${id}`).then(r => r.data);
