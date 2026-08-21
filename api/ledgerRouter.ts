import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb, isMockMode } from "./queries/connection";
import { stations, stationShares } from "@db/schema";
import * as Q from "./queries/ledger";
import * as mock from "./queries/mock";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const n2 = (v: number) => Math.round(v * 100) / 100;

// ═══ 看板聚合辅助 ═══
async function boardBy(key: "brandId" | "entityId" | "landlordId") {
  const elec = await Q.listElectricity();
  const rent = await Q.listRentView();
  const stationsList = await Q.listStations();
  const map = new Map<number, {
    id: number; name: string; stationCount: number;
    elecPay: number; elecCollect: number; elecProfit: number; elecUnpaid: number; elecUncollected: number;
    rentCost: number; rentIncome: number; rentProfit: number; rentUncollected: number;
    totalProfit: number;
  }>();
  const ensure = (id: number | null, name: string | null) => {
    if (!id) return null;
    if (!map.has(id)) {
      map.set(id, { id, name: name ?? "-", stationCount: 0, elecPay: 0, elecCollect: 0, elecProfit: 0, elecUnpaid: 0, elecUncollected: 0, rentCost: 0, rentIncome: 0, rentProfit: 0, rentUncollected: 0, totalProfit: 0 });
    }
    return map.get(id)!;
  };
  for (const st of stationsList) {
    const id = key === "brandId" ? st.station.brandId : key === "entityId" ? st.station.entityId : st.station.landlordId;
    const name = key === "brandId" ? st.brandName : key === "entityId" ? st.entityName : st.landlordName;
    const b = ensure(id, name);
    if (b) b.stationCount++;
  }
  for (const r of elec) {
    const b = ensure(r[key], key === "brandId" ? r.brandName : key === "entityId" ? r.entityName : r.landlordName);
    if (!b) continue;
    b.elecPay += num(r.record.payAmount); b.elecCollect += num(r.record.collectAmount);
    b.elecProfit += num(r.record.profit);
    if (r.record.payStatus === "未付款") b.elecUnpaid += num(r.record.payAmount);
    if (r.record.collectStatus === "未到账") b.elecUncollected += num(r.record.collectAmount);
  }
  for (const l of rent.leases) {
    const b = ensure(l[key], key === "brandId" ? l.brandName : key === "entityId" ? l.entityName : l.landlordName);
    if (b) b.rentCost += num(l.lease.annualRent);
  }
  for (const i of rent.incomes) {
    const b = ensure(i[key], key === "brandId" ? i.brandName : key === "entityId" ? i.entityName : i.landlordName);
    if (!b) continue;
    b.rentIncome += num(i.income.annualIncome);
    b.rentProfit += num(i.income.profit);
    b.rentUncollected += i.receipts.filter((rc) => rc.status === "未到账").reduce((t, rc) => t + num(rc.amount), 0);
  }
  for (const b of map.values()) {
    b.totalProfit = b.elecProfit + b.rentProfit;
    for (const k of Object.keys(b) as (keyof typeof b)[]) if (typeof b[k] === "number" && k !== "id" && k !== "stationCount") (b[k] as number) = n2(b[k] as number);
  }
  return [...map.values()].sort((a, b) => b.totalProfit - a.totalProfit);
}

async function shareholderBoard() {
  if (isMockMode()) {
    const holders = await Q.listShareholders();
    const stationsList = await Q.listStations();
    const stationMap = new Map(stationsList.map(s => [s.station.id, s.station.name]));
    const shares = mock.mockStationShares.map(sh => ({
      share: sh,
      stationName: stationMap.get(sh.stationId) ?? "",
    }));
    const dividends = await Q.listDividends();
    return holders.map((h) => {
      const myStations = shares.filter((sh) => sh.share.shareholderId === h.id)
        .map((sh) => ({ stationId: sh.share.stationId, stationName: sh.stationName, ratio: num(sh.share.ratio) }));
      const myDivs: { period: string; stationName: string; ratio: number; amount: number; status: string }[] = [];
      let total = 0, settled = 0;
      for (const d of dividends) {
        for (const sh of d.shares) {
          if (sh.shareholderId !== h.id) continue;
          const amt = num(sh.amount);
          total += amt;
          if (d.record.status === "已结算") settled += amt;
          myDivs.push({ period: d.record.period, stationName: d.stationName, ratio: num(sh.ratio), amount: amt, status: d.record.status });
        }
      }
      myDivs.sort((a, b) => b.period.localeCompare(a.period));
      return { id: h.id, name: h.name, phone: h.phone, remark: h.remark, stations: myStations, dividends: myDivs, totalAmount: n2(total), settledAmount: n2(settled), pendingAmount: n2(total - settled) };
    });
  }
  const db = getDb();
  const holders = await Q.listShareholders();
  const shares = await db
    .select({ share: stationShares, stationName: stations.name })
    .from(stationShares)
    .innerJoin(stations, eq(stationShares.stationId, stations.id));
  const dividends = await Q.listDividends();
  return holders.map((h) => {
    const myStations = shares.filter((sh) => sh.share.shareholderId === h.id)
      .map((sh) => ({ stationId: sh.share.stationId, stationName: sh.stationName, ratio: num(sh.share.ratio) }));
    const myDivs: { period: string; stationName: string; ratio: number; amount: number; status: string }[] = [];
    let total = 0, settled = 0;
    for (const d of dividends) {
      for (const sh of d.shares) {
        if (sh.shareholderId !== h.id) continue;
        const amt = num(sh.amount);
        total += amt;
        if (d.record.status === "已结算") settled += amt;
        myDivs.push({ period: d.record.period, stationName: d.stationName, ratio: num(sh.ratio), amount: amt, status: d.record.status });
      }
    }
    myDivs.sort((a, b) => b.period.localeCompare(a.period));
    return { id: h.id, name: h.name, phone: h.phone, remark: h.remark, stations: myStations, dividends: myDivs, totalAmount: n2(total), settledAmount: n2(settled), pendingAmount: n2(total - settled) };
  }).filter((h) => h.stations.length > 0 || h.dividends.length > 0 || true);
}

// ═══ 路由 ═══
export const ledgerRouter = createRouter({
  // ── 档案 ──
  brands: publicQuery.query(() => Q.listBrands()),
  entities: publicQuery.query(() => Q.listEntities()),
  landlords: publicQuery.query(() => Q.listLandlords()),
  shareholders: publicQuery.query(() => Q.listShareholders()),

  // ── 总览 ──
  overview: publicQuery.query(() => Q.overview()),

  // ── 站点 ──
  stations: publicQuery
    .input(z.object({ brandId: z.number().optional(), entityId: z.number().optional(), landlordId: z.number().optional(), keyword: z.string().optional() }).optional())
    .query(({ input }) => Q.listStations(input)),
  stationDetail: publicQuery.input(z.object({ id: z.number() })).query(({ input }) => Q.stationDetail(input.id)),

  // ── 电费 ──
  electricity: publicQuery
    .input(z.object({ period: z.string().optional(), stationId: z.number().optional(), brandId: z.number().optional(), entityId: z.number().optional(), landlordId: z.number().optional() }).optional())
    .query(({ input }) => Q.listElectricity(input)),
  electricityPeriods: publicQuery.query(async () => {
    const rows = await Q.listElectricity();
    return [...new Set(rows.map((r) => r.record.period))].sort().reverse();
  }),

  // ── 场租 ──
  rent: publicQuery
    .input(z.object({ brandId: z.number().optional(), entityId: z.number().optional(), landlordId: z.number().optional() }).optional())
    .query(({ input }) => Q.listRentView(input)),

  // ── 合同 ──
  contracts: publicQuery
    .input(z.object({ brandId: z.number().optional(), keyword: z.string().optional() }).optional())
    .query(({ input }) => Q.listContracts(input)),

  // ── 分红 ──
  dividends: publicQuery
    .input(z.object({ stationId: z.number().optional(), shareholderId: z.number().optional(), period: z.string().optional() }).optional())
    .query(({ input }) => Q.listDividends(input)),

  // ── 电表 ──
  meterReadings: publicQuery
    .input(z.object({ stationId: z.number().optional(), meterNo: z.string().optional() }).optional())
    .query(({ input }) => Q.listMeterReadings(input)),

  // ── 看板 ──
  brandBoard: publicQuery.query(() => boardBy("brandId")),
  entityBoard: publicQuery.query(() => boardBy("entityId")),
  landlordBoard: publicQuery.query(() => boardBy("landlordId")),
  shareholderBoard: publicQuery.query(() => shareholderBoard()),

  // ── 电量汇总（悬浮球看板）──
  kwhSummary: publicQuery.query(async () => {
    const rows = await Q.listElectricity();
    const periods = [...new Set(rows.map((r) => r.record.period))].sort();
    if (periods.length === 0) return null;
    const latest = periods[periods.length - 1];
    const [y, m] = latest.split("-").map(Number);
    const qStart = Math.floor((m - 1) / 3) * 3 + 1;
    const qNo = Math.floor((m - 1) / 3) + 1;
    const inQuarter = (p: string) => {
      const [py, pm] = p.split("-").map(Number);
      return py === y && pm >= qStart && pm < qStart + 3;
    };
    const sumKwh = (f: (p: string) => boolean) =>
      n2(rows
        .filter((r) => f(r.record.period))
        .reduce((t, r) => t + (Number(r.record.collectKwh ?? 0) || Number(r.record.payKwh ?? 0)), 0));
    const monthKwh = sumKwh((p) => p === latest);
    const quarterKwh = sumKwh(inQuarter);
    const yearKwh = sumKwh((p) => p.startsWith(String(y)));
    const byMonth = new Map<string, number>();
    for (const r of rows) {
      byMonth.set(r.record.period, (byMonth.get(r.record.period) ?? 0) + (Number(r.record.collectKwh ?? 0) || Number(r.record.payKwh ?? 0)));
    }
    const monthly = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([period, kwh]) => ({ period, kwh: n2(kwh) }));
    return {
      month: { label: latest, kwh: monthKwh },
      quarter: { label: `${y} Q${qNo}`, kwh: quarterKwh },
      year: { label: `${y}年`, kwh: yearKwh },
      monthly,
    };
  }),

  stationBoard: publicQuery
    .input(z.object({ brandId: z.number().optional(), entityId: z.number().optional(), landlordId: z.number().optional(), keyword: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const stationsList = await Q.listStations(input);
      const elec = await Q.listElectricity(input ?? undefined);
      const rent = await Q.listRentView({ brandId: input?.brandId, entityId: input?.entityId, landlordId: input?.landlordId });
      return stationsList.map((st) => {
        const id = st.station.id;
        const eRows = elec.filter((r) => r.record.stationId === id);
        const lRows = rent.leases.filter((l) => l.lease.stationId === id);
        const iRows = rent.incomes.filter((i) => i.income.stationId === id);
        const elecProfit = eRows.reduce((t, r) => t + num(r.record.profit), 0);
        const elecPay = eRows.reduce((t, r) => t + num(r.record.payAmount), 0);
        const elecCollect = eRows.reduce((t, r) => t + num(r.record.collectAmount), 0);
        const rentCost = lRows.reduce((t, l) => t + num(l.lease.annualRent), 0);
        const rentIncome = iRows.reduce((t, i) => t + num(i.income.annualIncome ?? i.income.monthlyRent), 0);
        const rentProfit = iRows.reduce((t, i) => t + num(i.income.profit), 0);
        const rentReceived = iRows.flatMap((i) => i.receipts).filter((rc) => rc.status === "已到账").reduce((t, rc) => t + num(rc.amount), 0);
        const rentPending = iRows.flatMap((i) => i.receipts).filter((rc) => rc.status === "未到账").reduce((t, rc) => t + num(rc.amount), 0);
        return {
          ...st, elecPay: n2(elecPay), elecCollect: n2(elecCollect), elecProfit: n2(elecProfit),
          rentCost: n2(rentCost), rentIncome: n2(rentIncome), rentProfit: n2(rentProfit),
          rentReceived: n2(rentReceived), rentPending: n2(rentPending),
          totalProfit: n2(elecProfit + rentProfit),
          periods: [...new Set(eRows.map((r) => r.record.period))].sort().reverse(),
        };
      });
    }),

  // ── 站点电费明细（维度看板展开用）──
  stationElecDetail: publicQuery
    .input(z.object({ brandId: z.number().optional(), entityId: z.number().optional(), landlordId: z.number().optional() }))
    .query(({ input }) => Q.stationElecDetail(input)),

  // ── 品牌方详情（付款+收款）──
  brandDetail: publicQuery
    .input(z.object({ brandId: z.number() }))
    .query(({ input }) => Q.brandDetail(input.brandId)),

  // ── 场地方详情（支出明细）──
  landlordDetail: publicQuery
    .input(z.object({ landlordId: z.number() }))
    .query(({ input }) => Q.landlordDetail(input.landlordId)),
});
