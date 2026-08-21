import client from "./client";

// v3：按场地（landlordId）查询电表视图（按品牌分组）
export const getLandlordMeterView = (landlordId: number, period?: string) =>
  client.get(`/stations/landlord/${landlordId}/meter-view`, { params: { period } }).then(r => r.data);

// v3：场地方地图标注（landlords.address/latitude/longitude）
export const getLandlordLocations = () =>
  client.get("/stations/landlord-locations").then(r => r.data);
