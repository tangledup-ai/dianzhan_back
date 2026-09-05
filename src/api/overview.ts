import client from "./client";

export const getOverview = () =>
  client.get("/overview").then(r => r.data);

export const getMonthlyDetail = (period: string) =>
  client.get("/overview/monthly-detail", { params: { period } }).then(r => r.data);

export const getStationBoard = (params?: { landlordId?: number; keyword?: string; period?: string }) =>
  client.get("/overview/station-board", { params }).then(r => r.data);

export const getShareholderBoard = () =>
  client.get("/overview/shareholder-board").then(r => r.data);

export const getLandlordTrends = (landlordId: number, months: number = 6) =>
  client.get("/overview/landlord-trends", { params: { landlordId, months } }).then(r => r.data);

export const getLandlordStationMonthly = (landlordId: number, months: number = 6) =>
  client.get("/overview/landlord-station-monthly", { params: { landlordId, months } }).then(r => r.data);

// 公司主体月度损益（二期：运营归属主体口径，跨主体场地成本按柜数分摊）
export const getEntityMonthly = (period: string) =>
  client.get("/overview/entity-monthly", { params: { period } }).then(r => r.data);
