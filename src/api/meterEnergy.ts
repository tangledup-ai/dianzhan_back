import client from "./client";

// 获取日用电量
export const getDailyKwh = (params?: { meterNo?: string; startDate?: string; endDate?: string }) =>
  client.get("/meter-energy/daily", { params }).then(r => r.data);

// 获取小时用电量
export const getHourlyKwh = (params?: { meterNo?: string; startTime?: string; endTime?: string }) =>
  client.get("/meter-energy/hourly", { params }).then(r => r.data);

// 获取月用电量
export const getMonthlyKwh = (params?: { meterNo?: string; startMonth?: string; endMonth?: string }) =>
  client.get("/meter-energy/monthly", { params }).then(r => r.data);

// 获取指定电表的所有月度读数
export const getMeterReadings = (meterNo: string) =>
  client.get("/meter-energy/monthly", { params: { meterNo } }).then(r => r.data);

// 获取同步日志
export const getSyncLogs = (limit?: number) =>
  client.get("/meter-energy/sync-logs", { params: { limit } }).then(r => r.data);

// 手动触发同步
export const triggerSync = (type: string) =>
  client.post("/meter-energy/sync", null, { params: { type } }).then(r => r.data);

// 手动录入电表月度读数
export interface MeterReadingData {
  address: string;
  monthPeriod: string;
  kwh?: number;
  actualKwh?: number;
  prevActualReading?: number;
  currActualReading?: number;
  prevReadingDate?: string;
  prevReading?: number;
  currReadingDate?: string;
  currReading?: number;
}

export const saveMeterReading = (data: MeterReadingData) =>
  client.post("/meter-energy/readings", data).then(r => r.data);
