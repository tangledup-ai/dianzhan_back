/* eslint-disable */
// 导出小程序数据快照 v2
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

const n2 = (x) => Math.round(x * 100) / 100;
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

const REGION_POS = {
  "五华": [25.043, 102.707], "盘龙": [25.116, 102.752], "官渡": [24.985, 102.743],
  "西山": [25.038, 102.664], "呈贡": [24.885, 102.822], "宣威": [26.219, 104.097],
};
function jitter(id) {
  const h = parseInt(crypto.createHash("md5").update(String(id)).digest("hex").slice(0, 8), 16);
  return [((h % 1000) / 1000 - 0.5) * 0.05, (((h / 1000) | 0) % 1000 / 1000 - 0.5) * 0.05];
}

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  const c = await mysql.createConnection({
    host: url.hostname, port: url.port, user: url.username,
    password: url.password, database: url.pathname.slice(1), ssl: {},
  });

  const [stations] = await c.query(
    `SELECT s.id, s.name, s.region, s.status, s.meter_no, s.cabinets, s.company_share,
            b.name AS brand, e.name AS entity, l.name AS landlord
     FROM stations s
     LEFT JOIN brands b ON s.brand_id=b.id
     LEFT JOIN entities e ON s.entity_id=e.id
     LEFT JOIN landlords l ON s.landlord_id=l.id ORDER BY s.id`);
  const [elec] = await c.query(
    `SELECT station_id, period, pay_kwh, pay_unit_price, pay_amount, pay_status,
            collect_kwh, collect_unit_price, collect_amount, collect_net, collect_status, profit
     FROM electricity_records ORDER BY station_id, period`);
  const [leases] = await c.query(
    `SELECT station_id, contract_start, contract_end, annual_rent, pay_method, pay_amount, deposit, pay_status FROM rent_leases`);
  const [incomes] = await c.query(
    `SELECT id, station_id, contract_start, contract_end, unit_monthly_rent, cabinets_count,
            annual_income, monthly_rent, annual_income_net, profit FROM rent_incomes`);
  const [receipts] = await c.query(
    `SELECT rent_income_id, seq, period_start, period_end, amount, status FROM rent_receipts ORDER BY rent_income_id, seq`);
  const [contracts] = await c.query(
    `SELECT c.station_name, c.partner, c.end_date, b.name AS brand FROM contracts c LEFT JOIN brands b ON c.brand_id=b.id`);
  const [shares] = await c.query(
    `SELECT ss.station_id, ss.ratio, sh.name AS shareholder FROM station_shares ss JOIN shareholders sh ON ss.shareholder_id=sh.id`);
  const [dividends] = await c.query(
    `SELECT d.station_id, d.period, d.pay_amount, d.total_income, d.profit, d.status, s.name AS station
     FROM dividend_records d JOIN stations s ON d.station_id=s.id`);
  const [divShares] = await c.query(
    `SELECT ds.dividend_id, ds.ratio, ds.amount, sh.name AS shareholder
     FROM dividend_shares ds JOIN shareholders sh ON ds.shareholder_id=sh.id
     JOIN dividend_records d ON ds.dividend_id=d.id ORDER BY ds.dividend_id`);
  const [divIds] = await c.query(`SELECT id, station_id, period FROM dividend_records`);

  await c.end();

  // ── 电量汇总 ──
  const periods = [...new Set(elec.map((e) => e.period))].sort();
  const latest = periods[periods.length - 1];
  const [y, m] = latest.split("-").map(Number);
  const qStart = ((m - 1) / 3 | 0) * 3 + 1;
  const kwhOf = (e) => num(e.collect_kwh) || num(e.pay_kwh);
  const sumKwh = (f) => n2(elec.filter((e) => f(e.period)).reduce((t, e) => t + kwhOf(e), 0));
  const byMonth = {};
  elec.forEach((e) => { byMonth[e.period] = (byMonth[e.period] || 0) + kwhOf(e); });
  const kwh = {
    month: { label: latest, kwh: sumKwh((p) => p === latest) },
    quarter: { label: `${y} Q${(m - 1) / 3 + 1 | 0}`, kwh: sumKwh((p) => p.startsWith(String(y)) && +p.slice(5) >= qStart && +p.slice(5) < qStart + 3) },
    year: { label: `${y}年`, kwh: sumKwh((p) => p.startsWith(String(y))) },
    monthly: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([period, v]) => ({ period, kwh: n2(v) })),
  };

  // ── 站点聚合 ──
  const today = new Date();
  const stationRows = stations.map((s) => {
    const rows = elec.filter((e) => e.station_id === s.id);
    const byP = {};
    rows.forEach((e) => { byP[e.period] = (byP[e.period] || 0) + kwhOf(e); });
    const ps = Object.keys(byP).sort();
    const latestKwh = ps.length ? byP[ps[ps.length - 1]] : 0;
    const prev = ps.slice(0, -1);
    const avgPrev = prev.length ? prev.reduce((t, p) => t + byP[p], 0) / prev.length : null;
    const abnormal = avgPrev !== null && avgPrev > 0 && Math.abs(latestKwh - avgPrev) / avgPrev > 0.3;
    const elecPay = rows.reduce((t, e) => t + num(e.pay_amount), 0);
    const elecCollect = rows.reduce((t, e) => t + num(e.collect_amount), 0);
    const elecProfit = rows.reduce((t, e) => t + num(e.profit), 0);
    const myLeases = leases.filter((l) => l.station_id === s.id);
    const myIncomes = incomes.filter((i) => i.station_id === s.id);
    const rentCost = myLeases.reduce((t, l) => t + num(l.annual_rent), 0);
    const rentIncome = myIncomes.reduce((t, i) => t + num(i.annual_income) || num(i.monthly_rent), 0);
    const rentProfit = myIncomes.reduce((t, i) => t + num(i.profit), 0);
    const cost = elecPay + rentCost;
    const totalProfit = elecProfit + rentProfit;
    let base = null;
    for (const [k, v] of Object.entries(REGION_POS)) {
      if ((s.region || "").includes(k) || s.name.includes(k)) { base = v; break; }
    }
    if (!base) base = s.name.includes("宣威") ? REGION_POS["宣威"] : [25.02, 102.71];
    const [dj1, dj2] = jitter(s.id);
    return {
      id: s.id, name: s.name, region: s.region || "", brand: s.brand || "", entity: s.entity || "",
      landlord: s.landlord || "", status: s.status, meterNo: s.meter_no || "",
      cabinets: num(s.cabinets) || null, companyShare: num(s.company_share) || null,
      latestKwh: n2(latestKwh), avgKwh: avgPrev === null ? null : n2(avgPrev), abnormal,
      kwhTotal: n2(Object.values(byP).reduce((t, v) => t + v, 0)),
      elecPay: n2(elecPay), elecCollect: n2(elecCollect), elecProfit: n2(elecProfit),
      rentCost: n2(rentCost), rentIncome: n2(rentIncome), rentProfit: n2(rentProfit),
      totalProfit: n2(totalProfit), roi: cost > 0 ? Math.round((totalProfit / cost) * 1000) / 10 : null,
      lat: +(base[0] + dj1).toFixed(6), lng: +(base[1] + dj2).toFixed(6),
    };
  });

  // ── 站点明细（详情页用）──
  const stationDetail = {};
  stations.forEach((s) => {
    stationDetail[s.id] = {
      elec: elec.filter((e) => e.station_id === s.id).map((e) => ({
        period: e.period, payKwh: num(e.pay_kwh), payUnitPrice: num(e.pay_unit_price), payAmount: num(e.pay_amount),
        payStatus: e.pay_status, collectKwh: num(e.collect_kwh), collectUnitPrice: num(e.collect_unit_price),
        collectAmount: num(e.collect_amount), collectNet: num(e.collect_net), collectStatus: e.collect_status,
        profit: num(e.profit),
      })),
      leases: leases.filter((l) => l.station_id === s.id).map((l) => ({
        start: l.contract_start, end: l.contract_end, annualRent: num(l.annual_rent),
        payMethod: l.pay_method || "", payAmount: num(l.pay_amount), deposit: num(l.deposit), payStatus: l.pay_status,
      })),
      incomes: incomes.filter((i) => i.station_id === s.id).map((i) => ({
        start: i.contract_start, end: i.contract_end, unitMonthlyRent: num(i.unit_monthly_rent),
        cabinets: num(i.cabinets_count), annualIncome: num(i.annual_income), monthlyRent: num(i.monthly_rent),
        profit: num(i.profit),
        receipts: receipts.filter((r) => r.rent_income_id === i.id).map((r) => ({
          seq: num(r.seq), start: r.period_start, end: r.period_end, amount: num(r.amount), status: r.status,
        })),
      })),
      shares: shares.filter((sh) => sh.station_id === s.id).map((sh) => ({ name: sh.shareholder, ratio: num(sh.ratio) })),
    };
  });

  // ── 五维度报表 ──
  const agg = (key) => {
    const map = {};
    stationRows.forEach((s) => {
      const k = s[key] || "未指定";
      const d = map[k] || (map[k] = { name: k, stationCount: 0, elecPay: 0, elecCollect: 0, elecProfit: 0, rentCost: 0, rentIncome: 0, rentProfit: 0, totalProfit: 0 });
      d.stationCount++;
      d.elecPay += s.elecPay; d.elecCollect += s.elecCollect; d.elecProfit += s.elecProfit;
      d.rentCost += s.rentCost; d.rentIncome += s.rentIncome; d.rentProfit += s.rentProfit;
      d.totalProfit += s.totalProfit;
    });
    return Object.values(map).sort((a, b) => b.totalProfit - a.totalProfit)
      .map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "number" && k !== "stationCount" ? n2(v) : v])));
  };

  const divByStation = divIds.map((d) => ({
    id: d.id, stationId: d.station_id, period: d.period,
    station: (dividends.find((x) => x.station_id === d.station_id && x.period === d.period) || {}).station || "",
    profit: num((dividends.find((x) => x.station_id === d.station_id && x.period === d.period) || {}).profit),
    status: (dividends.find((x) => x.station_id === d.station_id && x.period === d.period) || {}).status || "",
    shares: divShares.filter((s) => s.dividend_id === d.id).map((s) => ({ name: s.shareholder, ratio: num(s.ratio), amount: num(s.amount) })),
  }));
  const shareholderMap = {};
  shares.forEach((sh) => {
    const st = stations.find((x) => x.id === sh.station_id);
    const d = shareholderMap[sh.shareholder] || (shareholderMap[sh.shareholder] = { name: sh.shareholder, stations: [], dividends: [], totalAmount: 0, settledAmount: 0 });
    d.stations.push({ station: st ? st.name : "", ratio: num(sh.ratio) });
  });
  divByStation.forEach((dv) => {
    dv.shares.forEach((s) => {
      const d = shareholderMap[s.name] || (shareholderMap[s.name] = { name: s.name, stations: [], dividends: [], totalAmount: 0, settledAmount: 0 });
      d.dividends.push({ period: dv.period, station: dv.station, ratio: s.ratio, amount: s.amount, status: dv.status });
      d.totalAmount += s.amount;
      if (dv.status === "已结算") d.settledAmount += s.amount;
    });
  });
  const shareholders = Object.values(shareholderMap).map((d) => ({
    ...d, totalAmount: n2(d.totalAmount), settledAmount: n2(d.settledAmount), pendingAmount: n2(d.totalAmount - d.settledAmount),
    dividends: d.dividends.sort((a, b) => b.period.localeCompare(a.period)),
  })).sort((a, b) => b.totalAmount - a.totalAmount);

  // ── 异常提醒 ──
  const contractReminders = contracts.map((ct) => {
    const daysLeft = ct.end_date ? Math.ceil((new Date(ct.end_date) - today) / 86400000) : null;
    return { station: ct.station_name, brand: ct.brand || "", partner: ct.partner || "", endDate: ct.end_date, daysLeft };
  }).filter((ct) => ct.daysLeft !== null && ct.daysLeft <= 30)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const elecUnpaid = [];
  const elecUncollected = [];
  stationRows.forEach((s) => {
    elec.filter((e) => e.station_id === s.id).forEach((e) => {
      if (e.pay_status === "未付款" && num(e.pay_amount) > 0) elecUnpaid.push({ station: s.name, period: e.period, amount: n2(num(e.pay_amount)) });
      if (e.collect_status === "未到账" && num(e.collect_amount) > 0) elecUncollected.push({ station: s.name, period: e.period, amount: n2(num(e.collect_amount)) });
    });
  });
  const rentPending = [];
  incomes.forEach((i) => {
    const st = stations.find((x) => x.id === i.station_id);
    receipts.filter((r) => r.rent_income_id === i.id && r.status === "未到账").forEach((r) => {
      rentPending.push({ station: st ? st.name : "", seq: num(r.seq), amount: n2(num(r.amount)), periodEnd: r.period_end });
    });
  });

  // ── ROI 前20 ──
  const roiTop20 = stationRows
    .filter((s) => s.elecPay + s.rentCost > 0 || s.totalProfit !== 0)
    .sort((a, b) => (b.roi ?? -9999) - (a.roi ?? -9999))
    .slice(0, 20)
    .map((s, i) => ({ rank: i + 1, id: s.id, name: s.name, entity: s.entity, roi: s.roi, totalProfit: s.totalProfit, elecProfit: s.elecProfit, rentProfit: s.rentProfit, cost: n2(s.elecPay + s.rentCost) }));

  const overview = {
    stationCount: stations.length,
    elecProfit: n2(stationRows.reduce((t, s) => t + s.elecProfit, 0)),
    rentProfit: n2(stationRows.reduce((t, s) => t + s.rentProfit, 0)),
    totalProfit: n2(stationRows.reduce((t, s) => t + s.totalProfit, 0)),
    abnormalCount: stationRows.filter((s) => s.abnormal).length,
  };

  const entities = [...new Set(stationRows.map((s) => s.entity).filter(Boolean))];

  const snapshot = {
    generatedAt: "2026-07-23",
    kwh, overview, entities,
    stations: stationRows, stationDetail,
    finance: { station: stationRows, brand: agg("brand"), entity: agg("entity"), landlord: agg("landlord"), shareholder: shareholders },
    reminders: { contracts: contractReminders, elecUnpaid, elecUncollected, rentPending },
    roiTop20,
  };

  const js = "// 数据快照 v2（后台数据库导出 " + snapshot.generatedAt + "，更新数据替换本文件即可）\nconst snapshot = " +
    JSON.stringify(snapshot) + ";\n\nmodule.exports = snapshot;\n";
  fs.mkdirSync("/mnt/agents/output/miniprogram/data", { recursive: true });
  fs.writeFileSync("/mnt/agents/output/miniprogram/data/snapshot.js", js);
  console.log("snapshot written:", Math.round(js.length / 1024) + "KB",
    "| stations:", stationRows.length, "| contracts<=30d:", contractReminders.length,
    "| abnormal:", overview.abnormalCount, "| shareholders:", shareholders.length);
}

main().catch((e) => { console.error(e); process.exit(1); });
