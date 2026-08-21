import { eq, desc, asc, and, like } from "drizzle-orm";
import { getDb, isMockMode } from "./connection";
import {
  brands, entities, landlords, shareholders, stations, stationShares,
  electricityRecords, meterReadings, rentLeases, rentIncomes, rentReceipts,
  contracts, dividendRecords, dividendShares,
} from "@db/schema";
import * as mock from "./mock";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ─── 档案 ────────────────────────────────────────────────────
export const listBrands = () => isMockMode()
  ? Promise.resolve(mock.mockBrands)
  : getDb().select().from(brands).orderBy(asc(brands.id));

export const listEntities = () => isMockMode()
  ? Promise.resolve(mock.mockEntities)
  : getDb().select().from(entities).orderBy(asc(entities.id));

export const listLandlords = () => isMockMode()
  ? Promise.resolve(mock.mockLandlords)
  : getDb().select().from(landlords).orderBy(asc(landlords.id));

export const listShareholders = () => isMockMode()
  ? Promise.resolve(mock.mockShareholders)
  : getDb().select().from(shareholders).orderBy(asc(shareholders.id));

// ─── 站点 ────────────────────────────────────────────────────
export async function listStations(filter?: { brandId?: number; entityId?: number; landlordId?: number; keyword?: string }) {
  if (isMockMode()) {
    const brandMap = new Map(mock.mockBrands.map(b => [b.id, b.name]));
    const entityMap = new Map(mock.mockEntities.map(e => [e.id, e.name]));
    const landlordMap = new Map(mock.mockLandlords.map(l => [l.id, l.name]));
    return mock.mockStations
      .filter(s => {
        if (filter?.brandId && s.brandId !== filter.brandId) return false;
        if (filter?.entityId && s.entityId !== filter.entityId) return false;
        if (filter?.landlordId && s.landlordId !== filter.landlordId) return false;
        if (filter?.keyword && !s.name.includes(filter.keyword)) return false;
        return true;
      })
      .map(s => ({
        station: s,
        brandName: s.brandId ? brandMap.get(s.brandId) ?? null : null,
        entityName: s.entityId ? entityMap.get(s.entityId) ?? null : null,
        landlordName: s.landlordId ? landlordMap.get(s.landlordId) ?? null : null,
      }));
  }
  const db = getDb();
  const rows = await db
    .select({
      station: stations,
      brandName: brands.name,
      entityName: entities.name,
      landlordName: landlords.name,
    })
    .from(stations)
    .leftJoin(brands, eq(stations.brandId, brands.id))
    .leftJoin(entities, eq(stations.entityId, entities.id))
    .leftJoin(landlords, eq(stations.landlordId, landlords.id))
    .orderBy(asc(stations.id));
  return rows.filter((r) => {
    if (filter?.brandId && r.station.brandId !== filter.brandId) return false;
    if (filter?.entityId && r.station.entityId !== filter.entityId) return false;
    if (filter?.landlordId && r.station.landlordId !== filter.landlordId) return false;
    if (filter?.keyword && !r.station.name.includes(filter.keyword)) return false;
    return true;
  });
}

export async function stationDetail(id: number) {
  if (isMockMode()) {
    const brandMap = new Map(mock.mockBrands.map(b => [b.id, b.name]));
    const entityMap = new Map(mock.mockEntities.map(e => [e.id, e.name]));
    const landlordMap = new Map(mock.mockLandlords.map(l => [l.id, l.name]));
    const shareholderMap = new Map(mock.mockShareholders.map(s => [s.id, s.name]));
    const st = mock.mockStations.find(s => s.id === id);
    if (!st) return null;
    return {
      station: st,
      brandName: st.brandId ? brandMap.get(st.brandId) ?? null : null,
      entityName: st.entityId ? entityMap.get(st.entityId) ?? null : null,
      landlordName: st.landlordId ? landlordMap.get(st.landlordId) ?? null : null,
      electricity: mock.mockElectricityRecords.filter(e => e.stationId === id),
      leases: mock.mockRentLeases.filter(l => l.stationId === id),
      incomes: mock.mockRentIncomes
        .filter(i => i.stationId === id)
        .map(i => ({ ...i, receipts: mock.mockRentReceipts.filter(r => r.rentIncomeId === i.id) })),
      shares: mock.mockStationShares
        .filter(s => s.stationId === id)
        .map(s => ({ ...s, shareholderName: shareholderMap.get(s.shareholderId) ?? null })),
      readings: mock.mockMeterReadings.filter(r => r.stationId === id),
      dividends: mock.mockDividendRecords.filter(d => d.stationId === id),
    };
  }
  const db = getDb();
  const [row] = await db
    .select({ station: stations, brandName: brands.name, entityName: entities.name, landlordName: landlords.name })
    .from(stations)
    .leftJoin(brands, eq(stations.brandId, brands.id))
    .leftJoin(entities, eq(stations.entityId, entities.id))
    .leftJoin(landlords, eq(stations.landlordId, landlords.id))
    .where(eq(stations.id, id));
  if (!row) return null;
  const elec = await db.select().from(electricityRecords).where(eq(electricityRecords.stationId, id)).orderBy(desc(electricityRecords.period));
  const leases = await db.select().from(rentLeases).where(eq(rentLeases.stationId, id));
  const incomes = await db.select().from(rentIncomes).where(eq(rentIncomes.stationId, id));
  const incomeIds = incomes.map((i) => i.id);
  const receipts = incomeIds.length
    ? await db.select().from(rentReceipts).orderBy(asc(rentReceipts.seq))
    : [];
  const shares = await db
    .select({ share: stationShares, shareholderName: shareholders.name })
    .from(stationShares)
    .leftJoin(shareholders, eq(stationShares.shareholderId, shareholders.id))
    .where(eq(stationShares.stationId, id));
  const readings = await db.select().from(meterReadings).where(eq(meterReadings.stationId, id)).orderBy(desc(meterReadings.readingAt)).limit(30);
  const dividends = await db.select().from(dividendRecords).where(eq(dividendRecords.stationId, id)).orderBy(desc(dividendRecords.period));
  return {
    ...row, electricity: elec, leases,
    incomes: incomes.map((i) => ({ ...i, receipts: receipts.filter((rc) => rc.rentIncomeId === i.id) })),
    shares: shares.map((sh) => ({ ...sh.share, shareholderName: sh.shareholderName })),
    readings, dividends,
  };
}

// ─── 电费 ────────────────────────────────────────────────────
export async function listElectricity(filter?: { period?: string; stationId?: number; brandId?: number; entityId?: number; landlordId?: number }) {
  if (isMockMode()) {
    const stationMap = new Map(mock.mockStations.map(s => [s.id, s]));
    const brandMap = new Map(mock.mockBrands.map(b => [b.id, b.name]));
    const entityMap = new Map(mock.mockEntities.map(e => [e.id, e.name]));
    const landlordMap = new Map(mock.mockLandlords.map(l => [l.id, l.name]));
    return mock.mockElectricityRecords
      .filter(r => {
        if (filter?.period && r.period !== filter.period) return false;
        if (filter?.stationId && r.stationId !== filter.stationId) return false;
        if (filter?.brandId) {
          const st = stationMap.get(r.stationId);
          if (!st || st.brandId !== filter.brandId) return false;
        }
        if (filter?.entityId) {
          const st = stationMap.get(r.stationId);
          if (!st || st.entityId !== filter.entityId) return false;
        }
        if (filter?.landlordId) {
          const st = stationMap.get(r.stationId);
          if (!st || st.landlordId !== filter.landlordId) return false;
        }
        return true;
      })
      .map(r => {
        const st = stationMap.get(r.stationId)!;
        return {
          record: r,
          stationName: st.name,
          brandId: st.brandId, entityId: st.entityId, landlordId: st.landlordId,
          brandName: st.brandId ? brandMap.get(st.brandId) ?? null : null,
          entityName: st.entityId ? entityMap.get(st.entityId) ?? null : null,
          landlordName: st.landlordId ? landlordMap.get(st.landlordId) ?? null : null,
          meterNo: st.meterNo, region: st.region,
        };
      });
  }
  const db = getDb();
  const rows = await db
    .select({
      record: electricityRecords,
      stationName: stations.name,
      brandId: stations.brandId, entityId: stations.entityId, landlordId: stations.landlordId,
      brandName: brands.name, entityName: entities.name, landlordName: landlords.name,
      meterNo: stations.meterNo, region: stations.region,
    })
    .from(electricityRecords)
    .innerJoin(stations, eq(electricityRecords.stationId, stations.id))
    .leftJoin(brands, eq(stations.brandId, brands.id))
    .leftJoin(entities, eq(stations.entityId, entities.id))
    .leftJoin(landlords, eq(stations.landlordId, landlords.id))
    .orderBy(desc(electricityRecords.period), asc(stations.id));
  return rows.filter((r) => {
    if (filter?.period && r.record.period !== filter.period) return false;
    if (filter?.stationId && r.record.stationId !== filter.stationId) return false;
    if (filter?.brandId && r.brandId !== filter.brandId) return false;
    if (filter?.entityId && r.entityId !== filter.entityId) return false;
    if (filter?.landlordId && r.landlordId !== filter.landlordId) return false;
    return true;
  });
}

// ─── 场租 ────────────────────────────────────────────────────
export async function listRentView(filter?: { brandId?: number; entityId?: number; landlordId?: number }) {
  if (isMockMode()) {
    const stationMap = new Map(mock.mockStations.map(s => [s.id, s]));
    const brandMap = new Map(mock.mockBrands.map(b => [b.id, b.name]));
    const entityMap = new Map(mock.mockEntities.map(e => [e.id, e.name]));
    const landlordMap = new Map(mock.mockLandlords.map(l => [l.id, l.name]));
    const ok = (st: typeof mock.mockStations[0]) => {
      if (filter?.brandId && st.brandId !== filter.brandId) return false;
      if (filter?.entityId && st.entityId !== filter.entityId) return false;
      if (filter?.landlordId && st.landlordId !== filter.landlordId) return false;
      return true;
    };
    const leases = mock.mockRentLeases
      .filter(l => { const st = stationMap.get(l.stationId); return st && ok(st); })
      .map(l => {
        const st = stationMap.get(l.stationId)!;
        return {
          lease: l, stationName: st.name,
          brandId: st.brandId, entityId: st.entityId, landlordId: st.landlordId,
          brandName: st.brandId ? brandMap.get(st.brandId) ?? null : null,
          entityName: st.entityId ? entityMap.get(st.entityId) ?? null : null,
          landlordName: st.landlordId ? landlordMap.get(st.landlordId) ?? null : null,
          cabinets: st.cabinets, region: st.region,
        };
      });
    const incomes = mock.mockRentIncomes
      .filter(i => { const st = stationMap.get(i.stationId); return st && ok(st); })
      .map(i => {
        const st = stationMap.get(i.stationId)!;
        return {
          income: i, stationName: st.name,
          brandId: st.brandId, entityId: st.entityId, landlordId: st.landlordId,
          brandName: st.brandId ? brandMap.get(st.brandId) ?? null : null,
          entityName: st.entityId ? entityMap.get(st.entityId) ?? null : null,
          landlordName: st.landlordId ? landlordMap.get(st.landlordId) ?? null : null,
          region: st.region,
          receipts: mock.mockRentReceipts.filter(r => r.rentIncomeId === i.id),
        };
      });
    return { leases, incomes };
  }
  const db = getDb();
  const leaseRows = await db
    .select({
      lease: rentLeases, stationName: stations.name,
      brandId: stations.brandId, entityId: stations.entityId, landlordId: stations.landlordId,
      brandName: brands.name, entityName: entities.name, landlordName: landlords.name,
      cabinets: stations.cabinets, region: stations.region,
    })
    .from(rentLeases)
    .innerJoin(stations, eq(rentLeases.stationId, stations.id))
    .leftJoin(brands, eq(stations.brandId, brands.id))
    .leftJoin(entities, eq(stations.entityId, entities.id))
    .leftJoin(landlords, eq(stations.landlordId, landlords.id))
    .orderBy(asc(rentLeases.id));
  const incomeRows = await db
    .select({
      income: rentIncomes, stationName: stations.name,
      brandId: stations.brandId, entityId: stations.entityId, landlordId: stations.landlordId,
      brandName: brands.name, entityName: entities.name, landlordName: landlords.name,
      region: stations.region,
    })
    .from(rentIncomes)
    .innerJoin(stations, eq(rentIncomes.stationId, stations.id))
    .leftJoin(brands, eq(stations.brandId, brands.id))
    .leftJoin(entities, eq(stations.entityId, entities.id))
    .leftJoin(landlords, eq(stations.landlordId, landlords.id))
    .orderBy(asc(rentIncomes.id));
  const receipts = await db.select().from(rentReceipts).orderBy(asc(rentReceipts.rentIncomeId), asc(rentReceipts.seq));
  const ok = (r: { brandId: number | null; entityId: number | null; landlordId: number | null }) => {
    if (filter?.brandId && r.brandId !== filter.brandId) return false;
    if (filter?.entityId && r.entityId !== filter.entityId) return false;
    if (filter?.landlordId && r.landlordId !== filter.landlordId) return false;
    return true;
  };
  return {
    leases: leaseRows.filter(ok),
    incomes: incomeRows.filter(ok).map((r) => ({ ...r, receipts: receipts.filter((rc) => rc.rentIncomeId === r.income.id) })),
  };
}

// ─── 合同 ────────────────────────────────────────────────────
export async function listContracts(filter?: { brandId?: number; keyword?: string }) {
  if (isMockMode()) {
    const brandMap = new Map(mock.mockBrands.map(b => [b.id, b.name]));
    const today = new Date();
    return mock.mockContracts
      .filter(c => {
        if (filter?.brandId && c.brandId !== filter.brandId) return false;
        if (filter?.keyword && !c.stationName.includes(filter.keyword) && !(c.partner ?? "").includes(filter.keyword)) return false;
        return true;
      })
      .map(c => {
        const end = c.endDate ? new Date(c.endDate) : null;
        const daysLeft = end ? Math.ceil((end.getTime() - today.getTime()) / 86400000) : null;
        const status = daysLeft === null ? "未知" : daysLeft < 0 ? "已到期" : daysLeft <= 90 ? "临期" : "正常";
        return { ...c, brandName: c.brandId ? brandMap.get(c.brandId) ?? null : null, daysLeft, status };
      });
  }
  const db = getDb();
  const rows = await db
    .select({ contract: contracts, brandName: brands.name })
    .from(contracts)
    .leftJoin(brands, eq(contracts.brandId, brands.id))
    .orderBy(asc(contracts.endDate));
  const today = new Date();
  return rows
    .filter((r) => {
      if (filter?.brandId && r.contract.brandId !== filter.brandId) return false;
      if (filter?.keyword && !r.contract.stationName.includes(filter.keyword) && !(r.contract.partner ?? "").includes(filter.keyword)) return false;
      return true;
    })
    .map((r) => {
      const end = r.contract.endDate ? new Date(r.contract.endDate) : null;
      const daysLeft = end ? Math.ceil((end.getTime() - today.getTime()) / 86400000) : null;
      const status = daysLeft === null ? "未知" : daysLeft < 0 ? "已到期" : daysLeft <= 90 ? "临期" : "正常";
      return { ...r.contract, brandName: r.brandName, daysLeft, status };
    });
}

// ─── 分红 ────────────────────────────────────────────────────
export async function listDividends(filter?: { stationId?: number; shareholderId?: number; period?: string }) {
  if (isMockMode()) {
    const stationMap = new Map(mock.mockStations.map(s => [s.id, s]));
    const brandMap = new Map(mock.mockBrands.map(b => [b.id, b.name]));
    const shareholderMap = new Map(mock.mockShareholders.map(s => [s.id, s.name]));
    return mock.mockDividendRecords
      .filter(r => {
        if (filter?.period && r.period !== filter.period) return false;
        if (filter?.stationId && r.stationId !== filter.stationId) return false;
        if (filter?.shareholderId) {
          const shares = mock.mockDividendShares.filter(sh => sh.dividendId === r.id);
          if (!shares.some(sh => sh.shareholderId === filter.shareholderId)) return false;
        }
        return true;
      })
      .map(r => {
        const st = stationMap.get(r.stationId)!;
        return {
          record: r,
          stationName: st.name,
          brandId: st.brandId,
          brandName: st.brandId ? brandMap.get(st.brandId) ?? null : null,
          shares: mock.mockDividendShares
            .filter(sh => sh.dividendId === r.id)
            .map(sh => ({ ...sh, shareholderName: shareholderMap.get(sh.shareholderId) ?? null })),
        };
      });
  }
  const db = getDb();
  const records = await db
    .select({ record: dividendRecords, stationName: stations.name, brandId: stations.brandId, brandName: brands.name })
    .from(dividendRecords)
    .innerJoin(stations, eq(dividendRecords.stationId, stations.id))
    .leftJoin(brands, eq(stations.brandId, brands.id))
    .orderBy(desc(dividendRecords.period));
  const shares = await db
    .select({ share: dividendShares, shareholderName: shareholders.name })
    .from(dividendShares)
    .leftJoin(shareholders, eq(dividendShares.shareholderId, shareholders.id));
  return records
    .filter((r) => {
      if (filter?.period && r.record.period !== filter.period) return false;
      if (filter?.stationId && r.record.stationId !== filter.stationId) return false;
      if (filter?.shareholderId && !shares.some((sh) => sh.share.dividendId === r.record.id && sh.share.shareholderId === filter.shareholderId)) return false;
      return true;
    })
    .map((r) => ({
      ...r,
      shares: shares.filter((sh) => sh.share.dividendId === r.record.id).map((sh) => ({ ...sh.share, shareholderName: sh.shareholderName })),
    }));
}

// ─── 电表 ────────────────────────────────────────────────────
export async function listMeterReadings(filter?: { stationId?: number; meterNo?: string }) {
  if (isMockMode()) {
    const stationMap = new Map(mock.mockStations.map(s => [s.id, s.name]));
    return mock.mockMeterReadings
      .filter(r => {
        if (filter?.stationId && r.stationId !== filter.stationId) return false;
        if (filter?.meterNo && !r.meterNo.includes(filter.meterNo)) return false;
        return true;
      })
      .map(r => ({ reading: r, stationName: stationMap.get(r.stationId) ?? "" }));
  }
  const db = getDb();
  const conds = [];
  if (filter?.stationId) conds.push(eq(meterReadings.stationId, filter.stationId));
  if (filter?.meterNo) conds.push(like(meterReadings.meterNo, `%${filter.meterNo}%`));
  return db
    .select({ reading: meterReadings, stationName: stations.name })
    .from(meterReadings)
    .innerJoin(stations, eq(meterReadings.stationId, stations.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(meterReadings.readingAt))
    .limit(500);
}

// ─── 看板聚合 ────────────────────────────────────────────────
export async function overview() {
  if (isMockMode()) {
    const elec = mock.mockElectricityRecords;
    const leases = mock.mockRentLeases;
    const incomes = mock.mockRentIncomes;
    const receipts = mock.mockRentReceipts;
    const allStations = mock.mockStations;
    const contractRows = mock.mockContracts;
    const today = new Date();
    const expiring = contractRows.filter((c) => {
      if (!c.endDate) return false;
      const d = Math.ceil((new Date(c.endDate).getTime() - today.getTime()) / 86400000);
      return d >= 0 && d <= 90;
    }).length;
    const expired = contractRows.filter((c) => c.endDate && new Date(c.endDate) < today).length;

    const elecProfit = elec.reduce((t, r) => t + num(r.profit), 0);
    const elecPay = elec.reduce((t, r) => t + num(r.payAmount), 0);
    const elecCollect = elec.reduce((t, r) => t + num(r.collectAmount), 0);
    const elecUnpaid = elec.filter((r) => r.payStatus === "未付款").reduce((t, r) => t + num(r.payAmount), 0);
    const elecUncollected = elec.filter((r) => r.collectStatus === "未到账").reduce((t, r) => t + num(r.collectAmount), 0);
    const rentIncomeTotal = incomes.reduce((t, r) => t + num(r.annualIncome), 0);
    const rentCostTotal = leases.reduce((t, r) => t + num(r.annualRent), 0);
    const rentProfit = incomes.reduce((t, r) => t + num(r.profit), 0);
    const rentUncollected = receipts.filter((r) => r.status === "未到账").reduce((t, r) => t + num(r.amount), 0);

    const byMonth = new Map<string, { pay: number; collect: number; profit: number }>();
    for (const r of elec) {
      const m = byMonth.get(r.period) ?? { pay: 0, collect: 0, profit: 0 };
      m.pay += num(r.payAmount); m.collect += num(r.collectAmount); m.profit += num(r.profit);
      byMonth.set(r.period, m);
    }
    const monthly = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({ period, ...v }));

    return {
      stationCount: allStations.length,
      activeStations: allStations.filter((st) => st.status === "运营中").length,
      elecProfit, elecPay, elecCollect, elecUnpaid, elecUncollected,
      rentIncomeTotal, rentCostTotal, rentProfit, rentUncollected,
      totalProfit: elecProfit + rentProfit,
      contractCount: contractRows.length, expiringContracts: expiring, expiredContracts: expired,
      monthly,
    };
  }
  const db = getDb();
  const allStations = await db.select().from(stations);
  const elec = await db.select().from(electricityRecords);
  const leases = await db.select().from(rentLeases);
  const incomes = await db.select().from(rentIncomes);
  const receipts = await db.select().from(rentReceipts);
  const contractRows = await db.select().from(contracts);
  const today = new Date();
  const expiring = contractRows.filter((c) => {
    if (!c.endDate) return false;
    const d = Math.ceil((new Date(c.endDate).getTime() - today.getTime()) / 86400000);
    return d >= 0 && d <= 90;
  }).length;
  const expired = contractRows.filter((c) => c.endDate && new Date(c.endDate) < today).length;

  const elecProfit = elec.reduce((t, r) => t + num(r.profit), 0);
  const elecPay = elec.reduce((t, r) => t + num(r.payAmount), 0);
  const elecCollect = elec.reduce((t, r) => t + num(r.collectAmount), 0);
  const elecUnpaid = elec.filter((r) => r.payStatus === "未付款").reduce((t, r) => t + num(r.payAmount), 0);
  const elecUncollected = elec.filter((r) => r.collectStatus === "未到账").reduce((t, r) => t + num(r.collectAmount), 0);
  const rentIncomeTotal = incomes.reduce((t, r) => t + num(r.annualIncome), 0);
  const rentCostTotal = leases.reduce((t, r) => t + num(r.annualRent), 0);
  const rentProfit = incomes.reduce((t, r) => t + num(r.profit), 0);
  const rentUncollected = receipts.filter((r) => r.status === "未到账").reduce((t, r) => t + num(r.amount), 0);

  // 月度趋势
  const byMonth = new Map<string, { pay: number; collect: number; profit: number }>();
  for (const r of elec) {
    const m = byMonth.get(r.period) ?? { pay: 0, collect: 0, profit: 0 };
    m.pay += num(r.payAmount); m.collect += num(r.collectAmount); m.profit += num(r.profit);
    byMonth.set(r.period, m);
  }
  const monthly = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([period, v]) => ({ period, ...v }));

  return {
    stationCount: allStations.length,
    activeStations: allStations.filter((st) => st.status === "运营中").length,
    elecProfit, elecPay, elecCollect, elecUnpaid, elecUncollected,
    rentIncomeTotal, rentCostTotal, rentProfit, rentUncollected,
    totalProfit: elecProfit + rentProfit,
    contractCount: contractRows.length, expiringContracts: expiring, expiredContracts: expired,
    monthly,
  };
}

// ─── 站点电费明细（供维度看板展开用）──────────────────────────
export async function stationElecDetail(filter: { brandId?: number; entityId?: number; landlordId?: number }) {
  if (isMockMode()) {
    const brandMap = new Map(mock.mockBrands.map(b => [b.id, b.name]));
    const entityMap = new Map(mock.mockEntities.map(e => [e.id, e.name]));
    const landlordMap = new Map(mock.mockLandlords.map(l => [l.id, l.name]));
    const filteredStations = mock.mockStations.filter(s => {
      if (filter.brandId && s.brandId !== filter.brandId) return false;
      if (filter.entityId && s.entityId !== filter.entityId) return false;
      if (filter.landlordId && s.landlordId !== filter.landlordId) return false;
      return true;
    });
    return filteredStations.map(st => {
      const elec = mock.mockElectricityRecords
        .filter(e => e.stationId === st.id)
        .sort((a, b) => b.period.localeCompare(a.period));
      const latest = elec[0] ?? null;
      return {
        station: { id: st.id, name: st.name, meterNo: st.meterNo, transformerRatio: st.transformerRatio, companyShare: st.companyShare },
        brandName: st.brandId ? brandMap.get(st.brandId) ?? null : null,
        entityName: st.entityId ? entityMap.get(st.entityId) ?? null : null,
        landlordName: st.landlordId ? landlordMap.get(st.landlordId) ?? null : null,
        latestElec: latest,
      };
    });
  }
  const db = getDb();
  const conds = [];
  if (filter.brandId) conds.push(eq(stations.brandId, filter.brandId));
  if (filter.entityId) conds.push(eq(stations.entityId, filter.entityId));
  if (filter.landlordId) conds.push(eq(stations.landlordId, filter.landlordId));
  const stRows = await db
    .select({ station: stations, brandName: brands.name, entityName: entities.name, landlordName: landlords.name })
    .from(stations)
    .leftJoin(brands, eq(stations.brandId, brands.id))
    .leftJoin(entities, eq(stations.entityId, entities.id))
    .leftJoin(landlords, eq(stations.landlordId, landlords.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(stations.id));
  return Promise.all(stRows.map(async (row) => {
    const [latest] = await db.select().from(electricityRecords)
      .where(eq(electricityRecords.stationId, row.station.id))
      .orderBy(desc(electricityRecords.period))
      .limit(1);
    return { ...row, latestElec: latest ?? null };
  }));
}

// ─── 品牌方详情（付款+收款，供品牌看板展开用）────────────────
export async function brandDetail(brandId: number) {
  if (isMockMode()) {
    const brandMap = new Map(mock.mockBrands.map(b => [b.id, b]));
    const landlordMap = new Map(mock.mockLandlords.map(l => [l.id, l.name]));
    const filteredStations = mock.mockStations.filter(s => s.brandId === brandId);
    const brand = brandMap.get(brandId);
    return filteredStations.map(st => {
      const leases = mock.mockRentLeases.filter(l => l.stationId === st.id);
      const incomes = mock.mockRentIncomes
        .filter(i => i.stationId === st.id)
        .map(i => ({ ...i, receipts: mock.mockRentReceipts.filter(r => r.rentIncomeId === i.id) }));
      return {
        station: { id: st.id, name: st.name, code: st.code, cabinets: st.cabinets, storageCabinets: st.storageCabinets, companyShare: st.companyShare },
        landlordName: st.landlordId ? landlordMap.get(st.landlordId) ?? null : null,
        brandContact: brand?.contact ?? null,
        leases, incomes,
      };
    });
  }
  const db = getDb();
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
  const stRows = await db
    .select({ station: stations, landlordName: landlords.name })
    .from(stations)
    .leftJoin(landlords, eq(stations.landlordId, landlords.id))
    .where(eq(stations.brandId, brandId))
    .orderBy(asc(stations.id));
  return Promise.all(stRows.map(async (row) => {
    const leaseRows = await db.select().from(rentLeases).where(eq(rentLeases.stationId, row.station.id));
    const incomeRows = await db.select().from(rentIncomes).where(eq(rentIncomes.stationId, row.station.id));
    const incomeIds = incomeRows.map(i => i.id);
    const receiptRows = incomeIds.length
      ? await db.select().from(rentReceipts).orderBy(asc(rentReceipts.seq))
      : [];
    return {
      station: row.station,
      landlordName: row.landlordName,
      brandContact: brand?.contact ?? null,
      leases: leaseRows,
      incomes: incomeRows.map(i => ({ ...i, receipts: receiptRows.filter(rc => rc.rentIncomeId === i.id) })),
    };
  }));
}

// ─── 场地方详情（支出明细，供场地方看板展开用）────────────────
export async function landlordDetail(landlordId: number) {
  if (isMockMode()) {
    const landlordMap = new Map(mock.mockLandlords.map(l => [l.id, l.name]));
    const filteredStations = mock.mockStations.filter(s => s.landlordId === landlordId);
    return filteredStations.map(st => {
      const lease = mock.mockRentLeases.find(l => l.stationId === st.id) ?? null;
      const elecRecords = mock.mockElectricityRecords
        .filter(e => e.stationId === st.id)
        .sort((a, b) => b.period.localeCompare(a.period));
      const latestElec = elecRecords[0] ?? null;
      return {
        station: { id: st.id, name: st.name, code: st.code, meterNo: st.meterNo, cabinets: st.cabinets, storageCabinets: st.storageCabinets },
        landlordName: landlordMap.get(landlordId) ?? null,
        lease,
        latestElec,
      };
    });
  }
  const db = getDb();
  const stRows = await db
    .select({ station: stations })
    .from(stations)
    .where(eq(stations.landlordId, landlordId))
    .orderBy(asc(stations.id));
  return Promise.all(stRows.map(async (row) => {
    const [lease] = await db.select().from(rentLeases)
      .where(eq(rentLeases.stationId, row.station.id))
      .limit(1);
    const [latestElec] = await db.select().from(electricityRecords)
      .where(eq(electricityRecords.stationId, row.station.id))
      .orderBy(desc(electricityRecords.period))
      .limit(1);
    return {
      station: row.station,
      landlordName: null, // 由调用方补充
      lease: lease ?? null,
      latestElec: latestElec ?? null,
    };
  }));
}
