// ═══ 独立运行模式：拦截 tRPC API 请求，直接返回 Mock 数据 ═══
// 在 main.tsx 最顶部引入即可启用

import superjson from "superjson";
import * as mock from "../api/queries/mock";

// ─── 常量 ───
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const n2 = (v: number) => Math.round(v * 100) / 100;
const stationMap = new Map(mock.mockStations.map((s: any) => [s.id, s.name]));
const brandMap = new Map(mock.mockBrands.map((b: any) => [b.id, b.name]));
const entityMap = new Map(mock.mockEntities.map((e: any) => [e.id, e.name]));
const landlordMap = new Map(mock.mockLandlords.map((l: any) => [l.id, l.name]));
const shareholderMap = new Map(mock.mockShareholders.map((s: any) => [s.id, s.name]));

// ─── Mock 数据构建 ───

/** ledger.shareholderBoard */
function buildShareholderBoard() {
  const shares = mock.mockStationShares.map((sh: any) => {
    const st = mock.mockStations.find((s: any) => s.id === sh.stationId);
    return { share: sh, stationName: st?.name ?? "" };
  });
  const dividends = mock.mockDividendRecords.map((r: any) => {
    const st = mock.mockStations.find((s: any) => s.id === r.stationId);
    return {
      record: r,
      stationName: st?.name ?? "",
      brandName: st?.brandId ? brandMap.get(st.brandId) ?? null : null,
      shares: mock.mockDividendShares
        .filter((sh: any) => sh.dividendId === r.id)
        .map((sh: any) => ({ ...sh, shareholderName: shareholderMap.get(sh.shareholderId) ?? null })),
    };
  });
  return mock.mockShareholders.map((h: any) => {
    const myStations = shares
      .filter((sh: any) => sh.share.shareholderId === h.id)
      .map((sh: any) => ({ stationId: sh.share.stationId, stationName: sh.stationName, ratio: num(sh.share.ratio) }));
    const myDivs: any[] = [];
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
    myDivs.sort((a: any, b: any) => b.period.localeCompare(a.period));
    return {
      id: h.id, name: h.name, phone: h.phone, remark: h.remark,
      stations: myStations, dividends: myDivs,
      totalAmount: n2(total), settledAmount: n2(settled), pendingAmount: n2(total - settled),
    };
  });
}

/** ledger.stations / ledger.stationBoard */
function buildStations() {
  return mock.mockStations.map((st: any) => ({
    station: st,
    brandName: st.brandId ? brandMap.get(st.brandId) ?? null : null,
    entityName: st.entityId ? entityMap.get(st.entityId) ?? null : null,
    landlordName: st.landlordId ? landlordMap.get(st.landlordId) ?? null : null,
  }));
}

/** ledger.dividends({ shareholderId?, stationId?, period? }) */
function buildDividends(input: any) {
  const filter = input ?? {};
  return mock.mockDividendRecords
    .filter((r: any) => {
      if (filter.period && r.period !== filter.period) return false;
      if (filter.stationId && r.stationId !== filter.stationId) return false;
      if (filter.shareholderId) {
        const shs = mock.mockDividendShares.filter((sh: any) => sh.dividendId === r.id);
        if (!shs.some((sh: any) => sh.shareholderId === filter.shareholderId)) return false;
      }
      return true;
    })
    .map((r: any) => {
      const st = mock.mockStations.find((s: any) => s.id === r.stationId)!;
      return {
        record: r,
        stationName: st.name,
        brandId: st.brandId,
        brandName: st.brandId ? brandMap.get(st.brandId) ?? null : null,
        shares: mock.mockDividendShares
          .filter((sh: any) => sh.dividendId === r.id)
          .map((sh: any) => ({ ...sh, shareholderName: shareholderMap.get(sh.shareholderId) ?? null })),
      };
    });
}

/** ledger.meterReadings */
function buildMeterReadings(input: any) {
  const filter = input ?? {};
  return mock.mockMeterReadings
    .filter((r: any) => {
      if (filter.stationId && r.stationId !== filter.stationId) return false;
      if (filter.meterNo && !r.meterNo.includes(filter.meterNo)) return false;
      return true;
    })
    .map((r: any) => ({
      reading: r,
      stationName: stationMap.get(r.stationId) ?? "",
    }));
}

/** ledger.stationBoard — 同 stations 但追加财务汇总字段 */
function buildStationBoard() {
  const stationsList = buildStations();
  const elec = buildElectricity();
  const allLeases = mock.mockRentLeases;
  const allIncomes = mock.mockRentIncomes;
  const allReceipts = mock.mockRentReceipts;
  return stationsList.map((st: any) => {
    const id = st.station.id;
    const eRows = elec.filter((r: any) => r.record.stationId === id);
    const lRows = allLeases.filter((l: any) => l.stationId === id);
    const iRows = allIncomes.filter((i: any) => i.stationId === id).map((i: any) => ({
      ...i, receipts: allReceipts.filter((r: any) => r.rentIncomeId === i.id),
    }));
    return {
      ...st,
      elecPay: n2(eRows.reduce((t: number, r: any) => t + num(r.record.payAmount), 0)),
      elecCollect: n2(eRows.reduce((t: number, r: any) => t + num(r.record.collectAmount), 0)),
      elecProfit: n2(eRows.reduce((t: number, r: any) => t + num(r.record.profit), 0)),
      rentCost: n2(lRows.reduce((t: number, l: any) => t + num(l.annualRent), 0)),
      rentIncome: n2(iRows.reduce((t: number, i: any) => t + num(i.annualIncome ?? i.monthlyRent), 0)),
      rentProfit: n2(iRows.reduce((t: number, i: any) => t + num(i.profit), 0)),
      rentReceived: n2(iRows.flatMap((i: any) => i.receipts).filter((rc: any) => rc.status === "已到账").reduce((t: number, rc: any) => t + num(rc.amount), 0)),
      rentPending: n2(iRows.flatMap((i: any) => i.receipts).filter((rc: any) => rc.status === "未到账").reduce((t: number, rc: any) => t + num(rc.amount), 0)),
      totalProfit: n2(eRows.reduce((t: number, r: any) => t + num(r.record.profit), 0) + iRows.reduce((t: number, i: any) => t + num(i.profit), 0)),
      periods: [...new Set(eRows.map((r: any) => r.record.period))].sort().reverse(),
    };
  });
}

/** ledger.electricity */
function buildElectricity(input?: any) {
  const filter = input ?? {};
  return mock.mockElectricityRecords
    .filter((r: any) => {
      if (filter.period && r.period !== filter.period) return false;
      if (filter.stationId && r.stationId !== filter.stationId) return false;
      return true;
    })
    .map((r: any) => {
      const st = mock.mockStations.find((s: any) => s.id === r.stationId)!;
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

/** ledger.electricityPeriods */
function buildElecPeriods() {
  const rows = buildElectricity();
  return [...new Set(rows.map((r: any) => r.record.period))].sort().reverse();
}

/** ledger.overview */
function buildOverview() {
  const rows = buildElectricity();
  const elecProfit = rows.reduce((t: number, r: any) => t + num(r.record.profit), 0);
  const elecPay = rows.reduce((t: number, r: any) => t + num(r.record.payAmount), 0);
  const elecCollect = rows.reduce((t: number, r: any) => t + num(r.record.collectAmount), 0);
  const elecUnpaid = rows.filter((r: any) => r.record.payStatus === "未付款").reduce((t: number, r: any) => t + num(r.record.payAmount), 0);
  const elecUncollected = rows.filter((r: any) => r.record.collectStatus === "未到账").reduce((t: number, r: any) => t + num(r.record.collectAmount), 0);
  const incomes = mock.mockRentIncomes;
  const leases = mock.mockRentLeases;
  const receipts = mock.mockRentReceipts;
  const rentIncomeTotal = incomes.reduce((t: number, r: any) => t + num(r.annualIncome), 0);
  const rentCostTotal = leases.reduce((t: number, r: any) => t + num(r.annualRent), 0);
  const rentProfit = incomes.reduce((t: number, r: any) => t + num(r.profit), 0);
  const rentUncollected = receipts.filter((rc: any) => rc.status === "未到账").reduce((t: number, rc: any) => t + num(rc.amount), 0);
  return {
    stationCount: mock.mockStations.length,
    activeStations: mock.mockStations.filter((st: any) => st.status === "运营中").length,
    elecProfit: n2(elecProfit), elecPay: n2(elecPay), elecCollect: n2(elecCollect),
    elecUnpaid: n2(elecUnpaid), elecUncollected: n2(elecUncollected),
    rentIncomeTotal: n2(rentIncomeTotal), rentCostTotal: n2(rentCostTotal),
    rentProfit: n2(rentProfit), rentUncollected: n2(rentUncollected),
    totalProfit: n2(elecProfit + rentProfit),
    contractCount: mock.mockContracts.length,
    expiringContracts: 1, expiredContracts: 0,
    monthly: [],
  };
}

/** ledger.kwhSummary */
function buildKwhSummary() {
  const rows = buildElectricity();
  const periods = [...new Set(rows.map((r: any) => r.record.period))].sort();
  if (periods.length === 0) return null;
  const latest = periods[periods.length - 1];
  const sumKwh = (f: (p: string) => boolean) => n2(rows
    .filter((r: any) => f(r.record.period))
    .reduce((t: number, r: any) => t + (num(r.record.collectKwh ?? 0) || num(r.record.payKwh ?? 0)), 0));
  const monthKwh = sumKwh((p: string) => p === latest);
  const [y] = latest.split("-").map(Number);
  const yearKwh = sumKwh((p: string) => p.startsWith(String(y)));
  const byMonth = new Map<string, number>();
  for (const r of rows) {
    byMonth.set(r.record.period, (byMonth.get(r.record.period) ?? 0) + (num(r.record.collectKwh ?? 0) || num(r.record.payKwh ?? 0)));
  }
  const monthly = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([period, kwh]) => ({ period, kwh: n2(kwh) }));
  return {
    month: { label: latest, kwh: monthKwh },
    quarter: { label: `${y} Q2`, kwh: n2(monthKwh * 3) },
    year: { label: `${y}年`, kwh: yearKwh },
    monthly,
  };
}

/** ledger.brandBoard */
function buildBrandBoard() {
  return mock.mockBrands
    .filter((b: any) => mock.mockStations.some((s: any) => s.brandId === b.id))
    .map((b: any) => ({ id: b.id, name: b.name, stationCount: mock.mockStations.filter((s: any) => s.brandId === b.id).length }));
}

/** ledger.entityBoard */
function buildEntityBoard() {
  return mock.mockEntities
    .filter((e: any) => mock.mockStations.some((s: any) => s.entityId === e.id))
    .map((e: any) => ({ id: e.id, name: e.shortName ?? e.name, stationCount: mock.mockStations.filter((s: any) => s.entityId === e.id).length }));
}

/** ledger.landlordBoard */
function buildLandlordBoard() {
  return mock.mockLandlords
    .filter((l: any) => mock.mockStations.some((s: any) => s.landlordId === l.id))
    .map((l: any) => ({ id: l.id, name: l.name, stationCount: mock.mockStations.filter((s: any) => s.landlordId === l.id).length }));
}

/** ledger.rent */
function buildRent() {
  return {
    leases: mock.mockRentLeases.map((l: any) => ({
      lease: l,
      stationName: stationMap.get(l.stationId) ?? "",
      brandName: null, entityName: null, landlordName: null,
      brandId: null, entityId: null, landlordId: null,
      cabinets: null, region: null,
    })),
    incomes: mock.mockRentIncomes.map((i: any) => ({
      income: i,
      stationName: stationMap.get(i.stationId) ?? "",
      brandName: null, entityName: null, landlordName: null,
      brandId: null, entityId: null, landlordId: null,
      region: null,
      receipts: mock.mockRentReceipts.filter((r: any) => r.rentIncomeId === i.id),
    })),
  };
}

/** ledger.contracts */
function buildContracts() {
  return mock.mockContracts.map((c: any) => ({
    ...c,
    brandName: c.brandId ? brandMap.get(c.brandId) ?? null : null,
    daysLeft: c.endDate ? Math.ceil((new Date(c.endDate).getTime() - Date.now()) / 86400000) : null,
    status: c.endDate ? "正常" : "未知",
  }));
}

// ─── 路由表 ───
const handler: Record<string, (input: any) => any> = {
  "ledger.shareholderBoard": () => buildShareholderBoard(),
  "ledger.stations": () => buildStations(),
  "ledger.dividends": (input) => buildDividends(input),
  "ledger.meterReadings": (input) => buildMeterReadings(input),
  "ledger.stationBoard": () => buildStationBoard(),
  "ledger.electricity": (input) => buildElectricity(input),
  "ledger.electricityPeriods": () => buildElecPeriods(),
  "ledger.overview": () => buildOverview(),
  "ledger.kwhSummary": () => buildKwhSummary(),
  "ledger.rent": () => buildRent(),
  "ledger.contracts": () => buildContracts(),
  "ledger.brandBoard": () => buildBrandBoard(),
  "ledger.entityBoard": () => buildEntityBoard(),
  "ledger.landlordBoard": () => buildLandlordBoard(),
  "ledger.brandDetail": () => null,
  "ledger.landlordDetail": () => null,
  "ledger.stationElecDetail": () => null,
  "ledger.stationDetail": () => null,
};

// ─── 拦截 fetch ───
const originalFetch = window.fetch.bind(window);

window.fetch = function (url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

  // 仅拦截 /api/trpc/ 请求（支持 file:// 协议）
  if (!urlStr.includes("/api/trpc/")) {
    return originalFetch(url, options);
  }

  const match = urlStr.match(/\/api\/trpc\/([^?\s]+)/);
  const paths = match ? match[1].split(",").map(decodeURIComponent) : [];
  let bodyJson: Record<string, any> = {};
  try {
    if (options?.body) {
      bodyJson = JSON.parse(options.body as string);
    }
  } catch { /* empty */ }

  const responseBody: Record<string, any> = {};
  const keys = Object.keys(bodyJson);

  // 走 batch 格式
  for (const [key, val] of Object.entries(bodyJson)) {
    const idx = Number(key);
    const path = paths[idx] ?? paths[0] ?? "";
    const input = val?.json ?? {};

    if (path.startsWith("mut.")) {
      responseBody[key] = { result: { data: superjson.serialize({ success: true }) } };
      continue;
    }

    const h = handler[path];
    if (h) {
      try {
        const data = h(input);
        responseBody[key] = { result: { data: superjson.serialize(data) } };
      } catch (e: any) {
        console.error(`[Standalone Mock] Error handling ${path}:`, e);
        responseBody[key] = { result: { data: superjson.serialize([]) } };
      }
    } else {
      console.warn(`[Standalone Mock] Unknown path: ${path}`, input);
      responseBody[key] = { result: { data: superjson.serialize([]) } };
    }
  }

  // 无 body（非 batch 单条）时，从 URL 推断 path
  if (keys.length === 0 && paths.length === 1) {
    const path = paths[0];
    if (path.startsWith("mut.")) {
      responseBody["0"] = { result: { data: superjson.serialize({ success: true }) } };
    } else {
      const h = handler[path];
      try {
        const data = h ? h({}) : [];
        responseBody["0"] = { result: { data: superjson.serialize(data) } };
      } catch (e: any) {
        responseBody["0"] = { result: { data: superjson.serialize([]) } };
      }
    }
  }

  return Promise.resolve(new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
};

console.log("[Standalone] Mock API interceptor enabled — using embedded mock data");
