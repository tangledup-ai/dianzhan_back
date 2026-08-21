import { z } from "zod";
import { eq, desc as desc2 } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb, isMockMode } from "./queries/connection";
import {
  brands, entities, landlords, shareholders, stations, stationShares,
  electricityRecords, meterReadings, rentLeases, rentIncomes, rentReceipts,
  contracts, dividendRecords, dividendShares,
} from "@db/schema";

const n = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));
const s = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : v);
const d = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : v);
const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const nn = z.number().nullish();
const ns = z.string().nullish();

// 自动计算电费利润字段
function calcElec<T extends { collectNet?: number | null; payAmount?: number | null; opExpense?: number | null; companyShare?: number | null }>(v: T) {
  const profit = v.collectNet != null || v.payAmount != null ? r2(num(v.collectNet) - num(v.payAmount)) : null;
  const profitAfterOp = profit !== null ? r2(profit - num(v.opExpense)) : null;
  const companyNetProfit = profitAfterOp !== null && v.companyShare != null ? r2(profitAfterOp * v.companyShare) : null;
  return { profit, profitAfterOp, companyNetProfit };
}

const elecInput = z.object({
  stationId: z.number(),
  period: z.string().regex(/^\d{4}-\d{2}$/, "期间格式为 YYYY-MM"),
  payStartDate: ns, payStartReading: nn, payEndDate: ns, payEndReading: nn,
  payKwh: nn, payUnitPrice: nn, payAmount: nn,
  payStatus: z.enum(["未付款", "已付款"]).default("未付款"),
  collectStartDate: ns, collectStartReading: nn, collectEndDate: ns, collectEndReading: nn,
  collectKwh: nn, collectUnitPrice: nn, collectAmount: nn,
  taxRate: nn, collectNet: nn,
  collectStatus: z.enum(["未到账", "已到账"]).default("未到账"),
  opExpense: nn, companyShare: nn, remark: ns,
});

// Mock 模式下写操作返回成功（类型兼容 MySqlRawQueryResult）
const mockOk = { ok: true } as any;

export const mutationRouter = createRouter({
  // ── 档案 CRUD ──
  createBrand: publicQuery.input(z.object({ name: z.string().min(1), contact: ns, remark: ns }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().insert(brands).values([{ name: input.name, contact: s(input.contact), remark: s(input.remark) }])),
  updateBrand: publicQuery.input(z.object({ id: z.number(), name: z.string().min(1), contact: ns, remark: ns }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().update(brands).set({ name: input.name, contact: s(input.contact), remark: s(input.remark) }).where(eq(brands.id, input.id))),
  deleteBrand: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(brands).where(eq(brands.id, input.id))),

  createEntity: publicQuery.input(z.object({ name: z.string().min(1), shortName: ns, remark: ns }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().insert(entities).values([{ name: input.name, shortName: s(input.shortName), remark: s(input.remark) }])),
  updateEntity: publicQuery.input(z.object({ id: z.number(), name: z.string().min(1), shortName: ns, remark: ns }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().update(entities).set({ name: input.name, shortName: s(input.shortName), remark: s(input.remark) }).where(eq(entities.id, input.id))),
  deleteEntity: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(entities).where(eq(entities.id, input.id))),

  createLandlord: publicQuery.input(z.object({ name: z.string().min(1), contact: ns, phone: ns, remark: ns }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().insert(landlords).values([{ name: input.name, contact: s(input.contact), phone: s(input.phone), remark: s(input.remark) }])),
  updateLandlord: publicQuery.input(z.object({ id: z.number(), name: z.string().min(1), contact: ns, phone: ns, remark: ns }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().update(landlords).set({ name: input.name, contact: s(input.contact), phone: s(input.phone), remark: s(input.remark) }).where(eq(landlords.id, input.id))),
  deleteLandlord: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(landlords).where(eq(landlords.id, input.id))),

  createShareholder: publicQuery.input(z.object({ name: z.string().min(1), phone: ns, remark: ns }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().insert(shareholders).values([{ name: input.name, phone: s(input.phone), remark: s(input.remark) }])),
  updateShareholder: publicQuery.input(z.object({ id: z.number(), name: z.string().min(1), phone: ns, remark: ns }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().update(shareholders).set({ name: input.name, phone: s(input.phone), remark: s(input.remark) }).where(eq(shareholders.id, input.id))),
  deleteShareholder: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(shareholders).where(eq(shareholders.id, input.id))),

  // ── 站点 ──
  createStation: publicQuery.input(z.object({
    name: z.string().min(1), code: ns, region: ns, address: ns,
    brandId: nn, entityId: nn, landlordId: nn,
    meterNo: ns, transformerRatio: nn, cabinets: nn, storageCabinets: nn,
    companyShare: nn, status: z.enum(["运营中", "筹建中", "已关停"]).default("运营中"), remark: ns,
  })).mutation(({ input }) => isMockMode() ? mockOk : getDb().insert(stations).values([{
    name: input.name, code: s(input.code), region: s(input.region), address: s(input.address),
    brandId: input.brandId ?? undefined, entityId: input.entityId ?? undefined, landlordId: input.landlordId ?? undefined,
    meterNo: s(input.meterNo), transformerRatio: n(input.transformerRatio),
    cabinets: n(input.cabinets), storageCabinets: n(input.storageCabinets),
    companyShare: n(input.companyShare), status: input.status, remark: s(input.remark),
  }])),
  updateStation: publicQuery.input(z.object({
    id: z.number(), name: z.string().min(1), code: ns, region: ns, address: ns,
    brandId: nn, entityId: nn, landlordId: nn,
    meterNo: ns, transformerRatio: nn, cabinets: nn, storageCabinets: nn,
    companyShare: nn, status: z.enum(["运营中", "筹建中", "已关停"]), remark: ns,
  })).mutation(({ input }) => isMockMode() ? mockOk : getDb().update(stations).set({
    name: input.name, code: s(input.code), region: s(input.region), address: s(input.address),
    brandId: input.brandId ?? null, entityId: input.entityId ?? null, landlordId: input.landlordId ?? null,
    meterNo: s(input.meterNo), transformerRatio: n(input.transformerRatio),
    cabinets: n(input.cabinets), storageCabinets: n(input.storageCabinets),
    companyShare: n(input.companyShare), status: input.status, remark: s(input.remark),
  }).where(eq(stations.id, input.id))),
  deleteStation: publicQuery.input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (isMockMode()) return mockOk;
      const db = getDb();
      await db.delete(electricityRecords).where(eq(electricityRecords.stationId, input.id));
      await db.delete(rentLeases).where(eq(rentLeases.stationId, input.id));
      const incomes = await db.select().from(rentIncomes).where(eq(rentIncomes.stationId, input.id));
      for (const i of incomes) await db.delete(rentReceipts).where(eq(rentReceipts.rentIncomeId, i.id));
      await db.delete(rentIncomes).where(eq(rentIncomes.stationId, input.id));
      await db.delete(stationShares).where(eq(stationShares.stationId, input.id));
      await db.delete(meterReadings).where(eq(meterReadings.stationId, input.id));
      const divs = await db.select().from(dividendRecords).where(eq(dividendRecords.stationId, input.id));
      for (const dv of divs) await db.delete(dividendShares).where(eq(dividendShares.dividendId, dv.id));
      await db.delete(dividendRecords).where(eq(dividendRecords.stationId, input.id));
      await db.delete(stations).where(eq(stations.id, input.id));
    }),

  // 站点股东占股
  setStationShares: publicQuery.input(z.object({
    stationId: z.number(),
    shares: z.array(z.object({ shareholderId: z.number(), ratio: z.number(), remark: ns })),
  })).mutation(async ({ input }) => {
    if (isMockMode()) return mockOk;
    const db = getDb();
    await db.delete(stationShares).where(eq(stationShares.stationId, input.stationId));
    for (const sh of input.shares) {
      await db.insert(stationShares).values([{ stationId: input.stationId, shareholderId: sh.shareholderId, ratio: String(sh.ratio), remark: s(sh.remark) }]);
    }
  }),

  // ── 电费月结 ──
  createElectricity: publicQuery.input(elecInput).mutation(({ input }) => {
    if (isMockMode()) return mockOk;
    const calc = calcElec(input);
    return getDb().insert(electricityRecords).values([{
      stationId: input.stationId, period: input.period,
      payStartDate: d(input.payStartDate), payStartReading: n(input.payStartReading),
      payEndDate: d(input.payEndDate), payEndReading: n(input.payEndReading),
      payKwh: n(input.payKwh), payUnitPrice: n(input.payUnitPrice), payAmount: n(input.payAmount),
      payStatus: input.payStatus,
      collectStartDate: d(input.collectStartDate), collectStartReading: n(input.collectStartReading),
      collectEndDate: d(input.collectEndDate), collectEndReading: n(input.collectEndReading),
      collectKwh: n(input.collectKwh), collectUnitPrice: n(input.collectUnitPrice),
      collectAmount: n(input.collectAmount), taxRate: n(input.taxRate), collectNet: n(input.collectNet),
      collectStatus: input.collectStatus,
      profit: n(calc.profit), opExpense: n(input.opExpense),
      profitAfterOp: n(calc.profitAfterOp), companyShare: n(input.companyShare),
      companyNetProfit: n(calc.companyNetProfit), remark: s(input.remark), source: "manual",
    }]);
  }),
  updateElectricity: publicQuery.input(elecInput.extend({ id: z.number() })).mutation(({ input }) => {
    if (isMockMode()) return mockOk;
    const calc = calcElec(input);
    return getDb().update(electricityRecords).set({
      stationId: input.stationId, period: input.period,
      payStartDate: d(input.payStartDate), payStartReading: n(input.payStartReading),
      payEndDate: d(input.payEndDate), payEndReading: n(input.payEndReading),
      payKwh: n(input.payKwh), payUnitPrice: n(input.payUnitPrice), payAmount: n(input.payAmount),
      payStatus: input.payStatus,
      collectStartDate: d(input.collectStartDate), collectStartReading: n(input.collectStartReading),
      collectEndDate: d(input.collectEndDate), collectEndReading: n(input.collectEndReading),
      collectKwh: n(input.collectKwh), collectUnitPrice: n(input.collectUnitPrice),
      collectAmount: n(input.collectAmount), taxRate: n(input.taxRate), collectNet: n(input.collectNet),
      collectStatus: input.collectStatus,
      profit: n(calc.profit), opExpense: n(input.opExpense),
      profitAfterOp: n(calc.profitAfterOp), companyShare: n(input.companyShare),
      companyNetProfit: n(calc.companyNetProfit), remark: s(input.remark),
    }).where(eq(electricityRecords.id, input.id));
  }),
  deleteElectricity: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(electricityRecords).where(eq(electricityRecords.id, input.id))),

  // ── 场租付款合同 ──
  saveLease: publicQuery.input(z.object({
    id: z.number().optional(), stationId: z.number(),
    contractStart: ns, contractEnd: ns, annualRent: nn, payMethod: ns, payAmount: nn,
    deposit: nn, payDeadline: ns, payStatus: z.enum(["未付款", "已付款"]).default("未付款"),
    invoiceType: ns, remark: ns,
  })).mutation(({ input }) => {
    if (isMockMode()) return mockOk;
    const values = {
      stationId: input.stationId, contractStart: d(input.contractStart), contractEnd: d(input.contractEnd),
      annualRent: n(input.annualRent), payMethod: s(input.payMethod), payAmount: n(input.payAmount),
      deposit: n(input.deposit), payDeadline: d(input.payDeadline), payStatus: input.payStatus,
      invoiceType: s(input.invoiceType), remark: s(input.remark),
    };
    return input.id
      ? getDb().update(rentLeases).set(values).where(eq(rentLeases.id, input.id))
      : getDb().insert(rentLeases).values(values);
  }),
  deleteLease: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(rentLeases).where(eq(rentLeases.id, input.id))),

  // ── 场租收款合同 ──
  saveRentIncome: publicQuery.input(z.object({
    id: z.number().optional(), stationId: z.number(),
    contractStart: ns, contractEnd: ns, unitMonthlyRent: nn, cabinetsCount: nn,
    annualIncome: nn, monthlyRent: nn, taxRate: nn, annualIncomeNet: nn, inputCost: nn,
    dividendAmount: nn, signStatus: ns, remark: ns,
  })).mutation(({ input }) => {
    if (isMockMode()) return mockOk;
    const profit = input.annualIncomeNet != null || input.inputCost != null || input.annualIncome != null
      ? r2(num(input.annualIncomeNet ?? input.annualIncome) - num(input.inputCost)) : null;
    const profitAfterDividend = profit !== null ? r2(profit - num(input.dividendAmount)) : null;
    const values = {
      stationId: input.stationId, contractStart: d(input.contractStart), contractEnd: d(input.contractEnd),
      unitMonthlyRent: n(input.unitMonthlyRent), cabinetsCount: n(input.cabinetsCount),
      annualIncome: n(input.annualIncome), monthlyRent: n(input.monthlyRent), taxRate: n(input.taxRate),
      annualIncomeNet: n(input.annualIncomeNet), inputCost: n(input.inputCost),
      profit: n(profit), dividendAmount: n(input.dividendAmount),
      profitAfterDividend: n(profitAfterDividend), signStatus: s(input.signStatus), remark: s(input.remark),
    };
    return input.id
      ? getDb().update(rentIncomes).set(values).where(eq(rentIncomes.id, input.id))
      : getDb().insert(rentIncomes).values(values);
  }),
  deleteRentIncome: publicQuery.input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (isMockMode()) return mockOk;
      const db = getDb();
      await db.delete(rentReceipts).where(eq(rentReceipts.rentIncomeId, input.id));
      await db.delete(rentIncomes).where(eq(rentIncomes.id, input.id));
    }),

  // ── 租金分期收款 ──
  saveReceipt: publicQuery.input(z.object({
    id: z.number().optional(), rentIncomeId: z.number(), seq: z.number(),
    periodStart: ns, periodEnd: ns, amount: nn,
    status: z.enum(["未到账", "已到账"]).default("未到账"), remark: ns,
  })).mutation(({ input }) => {
    if (isMockMode()) return mockOk;
    const values = {
      rentIncomeId: input.rentIncomeId, seq: String(input.seq),
      periodStart: d(input.periodStart), periodEnd: d(input.periodEnd),
      amount: n(input.amount), status: input.status, remark: s(input.remark),
    };
    return input.id
      ? getDb().update(rentReceipts).set(values).where(eq(rentReceipts.id, input.id))
      : getDb().insert(rentReceipts).values(values);
  }),
  deleteReceipt: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(rentReceipts).where(eq(rentReceipts.id, input.id))),

  // ── 合同 ──
  saveContract: publicQuery.input(z.object({
    id: z.number().optional(), brandId: nn, stationId: nn,
    stationName: z.string().min(1), address: ns, payEntity: ns, partner: ns,
    contractType: z.enum(["场租付款", "场租收款", "电费", "合作", "其他"]).default("合作"),
    startDate: ns, endDate: ns, remark: ns,
  })).mutation(({ input }) => {
    if (isMockMode()) return mockOk;
    const values = {
      brandId: input.brandId ?? null, stationId: input.stationId ?? null,
      stationName: input.stationName, address: s(input.address), payEntity: s(input.payEntity),
      partner: s(input.partner), contractType: input.contractType,
      startDate: d(input.startDate), endDate: d(input.endDate), remark: s(input.remark),
    };
    return input.id
      ? getDb().update(contracts).set(values).where(eq(contracts.id, input.id))
      : getDb().insert(contracts).values(values);
  }),
  deleteContract: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(contracts).where(eq(contracts.id, input.id))),

  // ── 分红 ──
  saveDividend: publicQuery.input(z.object({
    id: z.number().optional(), stationId: z.number(), period: z.string().regex(/^\d{4}-\d{2}$/),
    kwh: nn, payUnitPrice: nn, payAmount: nn,
    elecIncomeTax: nn, elecIncomeNet: nn, rentIncomeTax: nn, rentIncomeNet: nn,
    status: z.enum(["未结算", "已结算"]).default("未结算"), remark: ns,
    shares: z.array(z.object({ shareholderId: z.number(), ratio: z.number() })).default([]),
  })).mutation(async ({ input }) => {
    if (isMockMode()) return mockOk;
    const db = getDb();
    const totalIncome = input.elecIncomeNet != null || input.rentIncomeNet != null
      ? r2(num(input.elecIncomeNet) + num(input.rentIncomeNet)) : null;
    const profit = totalIncome !== null || input.payAmount != null
      ? r2(num(totalIncome) - num(input.payAmount)) : null;
    const values = {
      stationId: input.stationId, period: input.period,
      kwh: n(input.kwh), payUnitPrice: n(input.payUnitPrice), payAmount: n(input.payAmount),
      elecIncomeTax: n(input.elecIncomeTax), elecIncomeNet: n(input.elecIncomeNet),
      rentIncomeTax: n(input.rentIncomeTax), rentIncomeNet: n(input.rentIncomeNet),
      totalIncome: n(totalIncome), profit: n(profit), status: input.status, remark: s(input.remark),
    };
    let dividendId: number;
    if (input.id) {
      await db.update(dividendRecords).set(values).where(eq(dividendRecords.id, input.id));
      dividendId = input.id;
      await db.delete(dividendShares).where(eq(dividendShares.dividendId, dividendId));
    } else {
      const [r] = await db.insert(dividendRecords).values(values).$returningId();
      dividendId = r.id;
    }
    for (const sh of input.shares) {
      const amount = profit !== null ? r2(profit * sh.ratio) : null;
      await db.insert(dividendShares).values([{
        dividendId, shareholderId: sh.shareholderId, ratio: String(sh.ratio), amount: n(amount),
      }]);
    }
  }),
  deleteDividend: publicQuery.input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (isMockMode()) return mockOk;
      const db = getDb();
      await db.delete(dividendShares).where(eq(dividendShares.dividendId, input.id));
      await db.delete(dividendRecords).where(eq(dividendRecords.id, input.id));
    }),

  // ── 智慧电表 ──
  addMeterReading: publicQuery.input(z.object({
    stationId: z.number(), meterNo: z.string().min(1),
    reading: z.number(), readingAt: z.string(),
  })).mutation(({ input }) => {
    if (isMockMode()) return mockOk;
    return getDb().insert(meterReadings).values([{
      stationId: input.stationId, meterNo: input.meterNo,
      reading: String(input.reading), readingAt: new Date(input.readingAt), source: "manual",
    }]);
  }),
  deleteMeterReading: publicQuery.input(z.object({ id: z.number() }))
    .mutation(({ input }) => isMockMode() ? mockOk : getDb().delete(meterReadings).where(eq(meterReadings.id, input.id))),
  ingestMeterReading: publicQuery.input(z.object({
    apiKey: z.string().min(1),
    meterNo: z.string().min(1),
    reading: z.number(),
    readingAt: z.string().optional(),
  })).mutation(async ({ input }) => {
    if (isMockMode()) return { ok: true, stationId: 1, stationName: "演示站" };
    if (input.apiKey !== "BWT-METER-2026") throw new Error("API Key 无效");
    const db = getDb();
    const [st] = await db.select().from(stations).where(eq(stations.meterNo, input.meterNo));
    if (!st) throw new Error(`未找到电表编号 ${input.meterNo} 对应的站点`);
    await db.insert(meterReadings).values([{
      stationId: st.id, meterNo: input.meterNo,
      reading: String(input.reading),
      readingAt: input.readingAt ? new Date(input.readingAt) : new Date(), source: "api",
    }]);
    return { ok: true, stationId: st.id, stationName: st.name };
  }),
  simulateMeterPush: publicQuery.mutation(async () => {
    if (isMockMode()) return { ok: true, count: 3 };
    const db = getDb();
    const rows = await db.select().from(stations);
    let count = 0;
    for (const st of rows.filter((x) => x.meterNo)) {
      const [last] = await db.select().from(meterReadings)
        .where(eq(meterReadings.stationId, st.id))
        .orderBy(desc2(meterReadings.readingAt)).limit(1);
      const base = last ? Number(last.reading) : 1000;
      const next = r2(base + Math.random() * 300 + 20);
      await db.insert(meterReadings).values([{
        stationId: st.id, meterNo: st.meterNo!, reading: String(next), readingAt: new Date(), source: "api",
      }]);
      count++;
    }
    return { ok: true, count };
  }),
});
