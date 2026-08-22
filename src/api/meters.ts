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

// 电表读数导入（模板：电表编号/电表名称/场地方/品牌方/月份/实际用电量/本月读数/上月读数/备注）
export const importMetersExcel = (file: File) => {
  const formData = new FormData();
  formData.append("file", file);
  return client.post("/meters/import", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  }).then(r => r.data);
};
