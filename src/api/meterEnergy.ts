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

// ─── 共享电表品牌分摊（「所有品牌共用此电表」按品牌录入应收电费）───
// 录入值 = 品牌方付给我方的电费（收款/收入，含税）；用电量 = 金额 ÷ 单价 倒推。

export interface SharedAllocationBrandOption {
  brandId: number;
  brandName: string;
  unitPrice: number | null;
  taxRate?: number;
  taxEnabled?: boolean;
  hasContract?: boolean;
}

export interface SharedAllocationRow {
  brandId: number;
  brandName?: string;
  /** 应收电费；null = 本月该品牌不计电费（可只录柜数/主体） */
  collectAmount: number | null;
  unitPrice?: number | null;
  /** 该品牌当月在此共享表下投放的电柜数量（逐月可调；留空 = 未填） */
  cabinetCount?: number | null;
  /** 该品牌电柜的报税公司主体；留空 = 默认（整场地口径，取共享电表自身主体） */
  entityId?: number | null;
  remark?: string | null;
}

export interface SharedAllocationBrandEntity {
  entityId: number;
  entityName: string;
  entityFullName?: string;
}

export interface SharedAllocationForm {
  monthPeriod: string;
  displayPeriod: string;
  meter: any;
  isShared: boolean;
  payPrice: number | null;
  sharedPrice: number | null;
  brands: SharedAllocationBrandOption[];
  allBrands: { brandId: number; brandName: string }[];
  /** 可选报税主体列表 */
  allEntities?: SharedAllocationBrandEntity[];
  /** 默认报税主体 = 整场地口径（共享电表自身主体） */
  defaultEntityId?: number | null;
  allocations: {
    brandId: number;
    brandName: string;
    /** null = 本月该品牌只录了柜数/主体，未计电费 */
    collectAmount: number | null;
    unitPrice: number | null;
    effectiveUnitPrice: number | null;
    taxRate: number;
    taxEnabled: boolean;
    kwh: number | null;
    collectNet: number | null;
    cabinetCount: number | null;
    entityId?: number | null;
    entityName?: string | null;
    remark?: string | null;
  }[];
  /** ★V5：该月这块共享表**应当**由哪几个品牌共享（品牌绑定清单：动态月度、默认继承上月） */
  bindings?: {
    brandId: number;
    brandName: string;
    startPeriod?: string;
    endPeriod?: string | null;
    /** 本月是否已录分摊 */
    hasAllocation?: boolean;
  }[];
  /** ★V5：已绑定但本月尚未录分摊的品牌（漏录告警；系统不自动补） */
  missingBrands?: { brandId: number; brandName: string }[];
  periods: string[];
  /** 电柜数量默认值：该品牌最近一次填写值，键为 brandId 字符串 */
  cabinetDefaults?: Record<string, { count: number; monthPeriod: string }>;
}

// 共享电表柜数明细（合同页实时计算计费柜数用）
export interface SharedCabinetUsageItem {
  meterId: number;
  meterNo: string;
  landlordId: number | null;
  entityId: number | null;
  /** true = 该表已按品牌录入柜数；false = 完全没录过，只能按整表兜底（max(1, 柜子数)） */
  managedByAlloc: boolean;
  /** brandId(字符串键经 JSON 后) → 柜数 */
  brandCabs: Record<string, number>;
  /** brandId → 分摊行人工指定的报税主体 */
  brandEntity: Record<string, number>;
  fallbackCabs: number;
}

// 共享电表柜数明细（不传 landlordId 返回全部）
export const getSharedCabinetUsage = (params?: { landlordId?: number; period?: string }):
  Promise<{ period: string | null; meters: SharedCabinetUsageItem[] }> =>
  client.get<{ period: string | null; meters: SharedCabinetUsageItem[] }>(
    "/meter-energy/shared-cabinet-usage", { params }).then(r => r.data);


// 共享电表品牌分摊录入数据（电表信息 + 候选品牌单价 + 已录入分摊）
export const getSharedAllocationForm = (params: { meterNo: string; monthPeriod: string }) =>
  client.get<SharedAllocationForm>("/meter-energy/shared-allocations", { params }).then(r => r.data);

// 保存某共享电表某月的品牌分摊（整体替换；rows 为空 = 清空该月分摊），并自动重算该月台账
export const saveSharedAllocations = (data: { address: string; monthPeriod: string; rows: SharedAllocationRow[] }) =>
  client.post("/meter-energy/shared-allocations", data).then(r => r.data);

