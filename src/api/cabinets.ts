import client from "./client";

export const listCabinets = (params?: { meterId?: number }) =>
  client.get("/cabinets", { params }).then(r => r.data);

export const createCabinet = (data: any) =>
  client.post("/cabinets", data).then(r => r.data);

export const updateCabinet = (id: number, data: any) =>
  client.put(`/cabinets/${id}`, data).then(r => r.data);

export const deleteCabinet = (id: number) =>
  client.delete(`/cabinets/${id}`).then(r => r.data);
