import { readFileSync } from "node:fs";
import { getDb } from "../api/queries/connection";
import {
  brands, entities, landlords, shareholders, stations, stationShares,
  electricityRecords, meterReadings, rentLeases, rentIncomes, rentReceipts,
  contracts, dividendRecords, dividendShares,
} from "./schema";

type SeedStation = {
  name: string; brand?: string | null; entity?: string | null; landlord?: string | null;
  code?: string | null; region?: string | null; meterNo?: string | null;
  transformerRatio?: number | null; cabinets?: number | null; storageCabinets?: number | null;
  companyShare?: number | null; remark?: string | null;
  elec?: Record<string, unknown> | null;
  lease?: Record<string, unknown> | null;
  income?: Record<string, unknown> | null;
  receipts?: Array<Record<string, unknown>> | null;
  shareholders?: Array<{ name: string; ratio: number }> | null;
  civilMonths?: Array<Record<string, unknown>> | null;
};

const raw = JSON.parse(readFileSync(new URL("./seed-data.json", import.meta.url), "utf-8")) as {
  contracts: Array<Record<string, unknown>>;
  dividends: Array<Record<string, unknown>>;
  stations: SeedStation[];
};

const n = (v: unknown) => (v === null || v === undefined ? null : String(v));
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

async function seed() {
  const db = getDb();
  console.log("Seeding database...");

  // ── 基础档案 ──
  const brandNames = [...new Set(raw.stations.map((x) => x.brand).filter(Boolean))] as string[];
  brandNames.push(...["青桔", "台铃", "其他"].filter((b) => !brandNames.includes(b)));
  const brandIds = new Map<string, number>();
  for (const name of brandNames) {
    const [r] = await db.insert(brands).values([{ name }]).$returningId();
    brandIds.set(name, r.id);
  }

  const entityNames = [
    ...new Set(raw.stations.map((x) => x.entity).filter(Boolean)),
  ] as string[];
  const entityIds = new Map<string, number>();
  for (const name of entityNames) {
    const full = name.length <= 6 ? null : name;
    const [r] = await db
      .insert(entities)
      .values([{ name: full ?? name, shortName: full ? name.replace(/云南|新能源|有限公司/g, "") || name : null }])
      .$returningId();
    entityIds.set(name, r.id);
  }

  const landlordNames = [...new Set(raw.stations.map((x) => x.landlord).filter(Boolean))] as string[];
  const landlordIds = new Map<string, number>();
  for (const name of landlordNames) {
    const [r] = await db.insert(landlords).values([{ name }]).$returningId();
    landlordIds.set(name, r.id);
  }

  const shNames = new Set<string>();
  for (const st of raw.stations) st.shareholders?.forEach((x) => shNames.add(x.name));
  for (const d of raw.dividends) (d.shares as Array<{ name: string }>).forEach((x) => shNames.add(x.name));
  const shIds = new Map<string, number>();
  for (const name of shNames) {
    const [r] = await db.insert(shareholders).values([{ name }]).$returningId();
    shIds.set(name, r.id);
  }

  // ── 站点及关联数据 ──
  const stationIds = new Map<string, number>();
  for (const st of raw.stations) {
    const [r] = await db
      .insert(stations)
      .values([{
        name: st.name,
        code: s(st.code),
        region: s(st.region),
        brandId: st.brand ? brandIds.get(st.brand) : undefined,
        entityId: st.entity ? entityIds.get(st.entity) : undefined,
        landlordId: st.landlord ? landlordIds.get(st.landlord) : undefined,
        meterNo: s(st.meterNo),
        transformerRatio: n(st.transformerRatio),
        cabinets: n(st.cabinets),
        storageCabinets: n(st.storageCabinets),
        companyShare: n(st.companyShare),
        remark: s(st.remark),
      }])
      .$returningId();
    stationIds.set(st.name, r.id);

    // 股东占股
    for (const sh of st.shareholders ?? []) {
      await db.insert(stationShares).values([{
        stationId: r.id, shareholderId: shIds.get(sh.name)!, ratio: String(sh.ratio),
      }]);
    }

    // 八维通电费台账
    if (st.elec) {
      const e = st.elec as Record<string, unknown>;
      await db.insert(electricityRecords).values([{
        stationId: r.id, period: s(e.period)!,
        payStartDate: s(e.payStartDate), payStartReading: n(e.payStartReading),
        payEndDate: s(e.payEndDate), payEndReading: n(e.payEndReading),
        payKwh: n(e.payKwh), payUnitPrice: n(e.payUnitPrice), payAmount: n(e.payAmount),
        payStatus: s(e.payStatus) as "已付款" | "未付款",
        collectStartDate: s(e.collectStartDate), collectStartReading: n(e.collectStartReading),
        collectEndDate: s(e.collectEndDate), collectEndReading: n(e.collectEndReading),
        collectKwh: n(e.collectKwh), collectUnitPrice: n(e.collectUnitPrice),
        collectAmount: n(e.collectAmount), collectNet: n(e.collectNet),
        collectStatus: s(e.collectStatus) as "已到账" | "未到账",
        profit: n(e.profit), opExpense: n(e.opExpense), profitAfterOp: n(e.profitAfterOp),
        companyShare: n(e.companyShare), companyNetProfit: n(e.companyNetProfit),
        remark: s(e.remark), source: "manual",
      }]);
    }

    // 民用换电柜月度记录（电费 + 场租收款）
    for (const m of st.civilMonths ?? []) {
      const profit = m.collectNet != null || m.payAmount != null
        ? Number(m.collectNet ?? 0) - Number(m.payAmount ?? 0) : null;
      const [er] = await db.insert(electricityRecords).values([{
        stationId: r.id, period: s(m.period)!,
        payKwh: n(m.payKwh), payUnitPrice: n(m.payUnitPrice), payAmount: n(m.payAmount),
        payStatus: m.payStatus ? "已付款" : "未付款",
        collectKwh: n(m.collectKwh), collectUnitPrice: n(m.collectUnitPrice),
        collectAmount: n(m.collectAmount), collectNet: n(m.collectNet), taxRate: "0.01",
        collectStatus: m.collectStatus ? "已到账" : "未到账",
        profit: profit === null ? null : String(Math.round(profit * 100) / 100),
        source: "manual",
      }]).$returningId();
      if (Number(m.rent ?? 0) > 0) {
        const [ri] = await db.insert(rentIncomes).values([{
          stationId: r.id, monthlyRent: n(m.rent), taxRate: "0.01",
          remark: `民用柜月度场租收款（${s(m.period)}）`,
        }]).$returningId();
        const [y, mo] = s(m.period)!.split("-").map(Number);
        const lastDay = new Date(y, mo, 0).getDate();
        await db.insert(rentReceipts).values([{
          rentIncomeId: ri.id, seq: "1",
          periodStart: `${m.period}-01`, periodEnd: `${m.period}-${lastDay}`,
          amount: n(m.rent), status: m.rentStatus ? "已到账" : "未到账",
        }]);
      }
      void er;
    }

    // 场租付款合同
    if (st.lease) {
      const l = st.lease as Record<string, unknown>;
      await db.insert(rentLeases).values([{
        stationId: r.id,
        contractStart: s(l.contractStart), contractEnd: s(l.contractEnd),
        annualRent: n(l.annualRent), payMethod: s(l.payMethod), payAmount: n(l.payAmount),
        deposit: n(l.deposit), payDeadline: s(l.payDeadline),
        payStatus: s(l.payStatus) as "已付款" | "未付款",
        invoiceType: s(l.invoiceType),
      }]);
    }

    // 场租收款合同 + 分期
    if (st.income) {
      const ic = st.income as Record<string, unknown>;
      if (Object.values(ic).some((v) => v !== null && v !== undefined)) {
        const [ri] = await db.insert(rentIncomes).values([{
          stationId: r.id,
          contractStart: s(ic.contractStart), contractEnd: s(ic.contractEnd),
          unitMonthlyRent: n(ic.unitMonthlyRent),
          cabinetsCount: n(st.cabinets),
          annualIncome: n(ic.annualIncome), monthlyRent: n(ic.monthlyRent),
          taxRate: n(ic.taxRate), annualIncomeNet: n(ic.annualIncomeNet),
          inputCost: n(ic.inputCost), profit: n(ic.profit),
          dividendAmount: n(ic.dividendAmount), profitAfterDividend: n(ic.profitAfterDividend),
          signStatus: s(ic.signStatus),
        }]).$returningId();
        for (const rc of st.receipts ?? []) {
          await db.insert(rentReceipts).values([{
            rentIncomeId: ri.id, seq: String(rc.seq),
            periodStart: s(rc.periodStart), periodEnd: s(rc.periodEnd),
            amount: n(rc.amount), status: s(rc.status) as "已到账" | "未到账",
          }]);
        }
      }
    }

    // 智慧电表模拟抄表（有电表编号的站点）
    if (st.meterNo) {
      const base = Number(st.elec?.payEndReading ?? 0) || Math.floor(Math.random() * 5000);
      await db.insert(meterReadings).values([
        { stationId: r.id, meterNo: st.meterNo, reading: String(Math.max(base - 400, 0)), readingAt: new Date("2026-06-29T08:00:00"), source: "api" },
        { stationId: r.id, meterNo: st.meterNo, reading: String(base), readingAt: new Date("2026-06-30T08:00:00"), source: "api" },
      ]);
    }
  }

  // ── 合同监控 ──
  for (const c of raw.contracts) {
    await db.insert(contracts).values([{
      brandId: brandIds.get(s(c.brand) ?? "") ?? undefined,
      stationId: stationIds.get(s(c.stationName) ?? "") ?? undefined,
      stationName: s(c.stationName)!,
      address: s(c.address), payEntity: s(c.payEntity), partner: s(c.partner),
      startDate: s(c.startDate), endDate: s(c.endDate),
      contractType: "合作", remark: s(c.remark),
    }]);
  }

  // ── 分红 ──
  for (const d of raw.dividends) {
    const stationId = stationIds.get(s(d.station) ?? "");
    if (!stationId) continue;
    const [dr] = await db.insert(dividendRecords).values([{
      stationId, period: s(d.period)!,
      kwh: n(d.kwh), payUnitPrice: n(d.payUnitPrice), payAmount: n(d.payAmount),
      elecIncomeTax: n(d.elecIncomeTax), elecIncomeNet: n(d.elecIncomeNet),
      rentIncomeTax: n(d.rentIncomeTax), rentIncomeNet: n(d.rentIncomeNet),
      totalIncome: n(d.totalIncome), profit: n(d.profit),
      status: s(d.status) as "已结算" | "未结算", remark: s(d.remark),
    }]).$returningId();
    for (const sh of d.shares as Array<{ name: string; ratio: number; amount: number }>) {
      await db.insert(dividendShares).values([{
        dividendId: dr.id, shareholderId: shIds.get(sh.name)!,
        ratio: String(sh.ratio), amount: n(sh.amount),
      }]);
    }
  }

  console.log("Done. stations:", stationIds.size);
  process.exit(0);
}

seed().catch((e) => { console.error(e); process.exit(1); });
