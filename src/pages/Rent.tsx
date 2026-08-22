import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getMonthlyLedger } from "@/api/rent";
import { listEntities } from "@/api/directory";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/fields";
import { fmtMoney, fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { exportXlsxWithTitle } from "@/lib/export";
import { Building2, Tag, ChevronDown, ChevronRight, Download } from "lucide-react";
import { toast } from "sonner";

// 场地费月台账（v2 重设计）：只含场地费（不含电费）
// 支持：按场地方 / 按品牌方；选择任意月份区间（如 1-5 月、2-9 月）；
//       按月展示数据 + 区间总览（合计），点击月份行展开该月明细，再点展开合同明细。

function StatCard({ label, value, tone = "slate" }: { label: string; value?: number; tone?: "emerald" | "rose" | "blue" | "slate" }) {
  const color = tone === "emerald" ? "text-emerald-600" : tone === "rose" ? "text-rose-600" : tone === "blue" ? "text-blue-600" : "text-slate-700";
  return (
    <div className="rounded-xl border bg-white p-3 shadow-sm">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>{fmtMoney(value ?? 0)}</div>
    </div>
  );
}

const now = new Date();
const CUR_MONTH = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

function shift(period: string, offset: number): string {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4, 6), 10);
  const dt = new Date(y, m - 1 + offset, 1);
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}`;
}

// ─── 整年场地收支表（框外展示）：按场地×品牌，付款信息=场地合同，收款信息=品牌方合同 ───
function YearlyTable({ yearlyRows, yearLabels }: { yearlyRows: any[]; yearLabels: string[] }) {
  return (
    <div className="space-y-3">
      {yearlyRows.map((gy: any) => {
        const vc: any = gy.venue || {};
        const brands = (gy.brands ?? []).filter((b: any) => b.contractType === "品牌方合同");
        if (brands.length === 0) return null;
        const venue = vc;
        const costStart = venue.startDate;
        const costEnd = venue.endDate;
        const years = costStart && costEnd
          ? Math.round((new Date(costEnd).getTime() - new Date(costStart).getTime()) / (365.25 * 24 * 60 * 60 * 1000) * 10) / 10
          : null;
        return (
          <div key={gy.landlordId} className="rounded-xl border bg-white overflow-hidden">
            {/* 场地标题 */}
            <div className="flex items-center gap-2 border-b bg-blue-50/50 px-4 py-2">
              <Building2 className="h-4 w-4 text-blue-600" />
              <span className="text-sm font-semibold text-slate-700">{gy.landlordName}</span>
              <span className="text-xs text-slate-400">（{brands.length} 个品牌 · 整年场地收支）</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-[11px]">
                <thead>
                  <tr className="border-b bg-slate-100 text-left text-[10px] text-slate-500">
                    <th className="px-2 py-1.5" rowSpan={2}>品牌方</th>
                    <th className="border-x bg-rose-50/70 px-2 py-1.5 text-center" colSpan={10}>付款信息（场地合同）</th>
                    <th className="border-x bg-emerald-50/70 px-2 py-1.5 text-center" colSpan={12}>收款信息（品牌方合同）</th>
                  </tr>
                  <tr className="border-b bg-slate-100 text-[10px] text-slate-500">
                    <th className="border-x px-2 py-1">负责人</th>
                    <th className="px-2 py-1">租期</th>
                    <th className="px-2 py-1">合作年限</th>
                    <th className="px-2 py-1">租金成本/年</th>
                    <th className="px-2 py-1">付款方式</th>
                    {yearLabels.map((yl) => (
                      <th key={yl} className="px-2 py-1">{yl}付款情况</th>
                    ))}
                    <th className="px-2 py-1">单台成本/年</th>
                    <th className="px-2 py-1">押金</th>
                    <th className="border-x px-2 py-1">合同日期</th>
                    {yearLabels.map((yl) => (
                      <th key={`i-${yl}`} className="px-2 py-1">{yl}到账情况</th>
                    ))}
                    <th className="px-2 py-1">柜数</th>
                    <th className="px-2 py-1">单台月租金(含税)</th>
                    <th className="px-2 py-1">单台年收入(含税)</th>
                    <th className="px-2 py-1">场地租金收入(含税)/年</th>
                    <th className="px-2 py-1">场地税率</th>
                    <th className="px-2 py-1">租金收入(不含税)/年</th>
                    <th className="px-2 py-1">进项成本</th>
                    <th className="px-2 py-1">租金利润</th>
                  </tr>
                </thead>
                <tbody>
                  {brands.map((c: any, idx: number) => {
                    const cabinets = c.cabinetsCount != null ? Number(c.cabinetsCount) : 1;
                    const unitMonthly = c.unitMonthlyRent != null ? Number(c.unitMonthlyRent) : null;
                    const unitAnnual = unitMonthly != null ? Math.round(unitMonthly * 12 * 100) / 100 : null;
                    const taxRate = c.rentTaxRate != null ? c.rentTaxRate : 0;
                    const inputCost = c.inputCost != null ? Number(c.inputCost) : 0;
                    const venueRentGross = unitAnnual != null ? Math.round(unitAnnual * cabinets * 100) / 100 : null;
                    const rentIncomeNet = venueRentGross != null
                      ? (taxRate > 0 ? Math.round(venueRentGross * (1 - taxRate) * 100) / 100 : venueRentGross)
                      : null;
                    const unitCostAnnual = c.unitCostAnnual != null ? Number(c.unitCostAnnual) : null;
                    const rentCostAnnual = unitCostAnnual != null ? Math.round(unitCostAnnual * cabinets * 100) / 100 : null;
                    const rentProfit = (rentIncomeNet != null && rentCostAnnual != null)
                      ? Math.round((rentIncomeNet - rentCostAnnual - inputCost) * 100) / 100
                      : null;
                    const isFirstBrand = idx === 0;
                    return (
                      <tr key={c.contractId} className="border-b last:border-0 hover:bg-slate-50/50">
                        <td className="px-2 py-1.5 font-medium text-slate-700">{c.brandName || "—"}</td>
                        {/* 付款信息（场地合同） */}
                        <td className="border-x px-2 py-1.5">{venue.landlordContact || venue.landlordName || "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{costStart ? `${costStart.slice(0, 10)} ~ ${costEnd ? costEnd.slice(0, 10) : ""}` : "—"}</td>
                        <td className="px-2 py-1.5">{years != null ? `${years}年` : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-rose-600">
                          {rentCostAnnual != null ? fmtMoney(rentCostAnnual) : "—"}
                        </td>
                        <td className="px-2 py-1.5">{venue.payMethod || "—"}</td>
                        {yearLabels.map((yl) => {
                          const ys = (venue.yearStatus ?? []).find((y: any) => y.year === yl);
                          return (
                            <td key={yl} className="px-2 py-1.5 text-center tabular-nums">
                              {ys ? `${ys.paid}/${ys.total}` : "—"}
                            </td>
                          );
                        })}
                        <td className="px-2 py-1.5 text-right tabular-nums">{unitCostAnnual != null ? fmtMoney(unitCostAnnual) : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {isFirstBrand
                            ? (venue.deposit != null ? <span title="整个场地的押金">{fmtMoney(venue.deposit)} <span className="text-[9px] text-slate-400">(整场地)</span></span> : <span title="整个场地的押金">— <span className="text-[9px] text-slate-400">(整场地)</span></span>)
                            : ""}
                        </td>
                        {/* 收款信息（品牌方合同） */}
                        <td className="border-x px-2 py-1.5 whitespace-nowrap">{c.startDate ? `${c.startDate.slice(0, 10)} ~ ${c.endDate ? c.endDate.slice(0, 10) : ""}` : "—"}</td>
                        {yearLabels.map((yl) => {
                          const ys = (c.yearStatus ?? []).find((y: any) => y.year === yl);
                          return (
                            <td key={`i-${yl}`} className="px-2 py-1.5 text-center tabular-nums">
                              {ys ? `${ys.paid}/${ys.total}` : "—"}
                            </td>
                          );
                        })}
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-700">{c.cabinetsCount != null ? `${fmtNum(c.cabinetsCount)} 柜` : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{unitMonthly != null ? fmtMoney(unitMonthly) : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{unitAnnual != null ? fmtMoney(unitAnnual) : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{venueRentGross != null ? fmtMoney(venueRentGross) : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{taxRate > 0 ? `${(taxRate * 100).toFixed(0)}%` : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{rentIncomeNet != null ? fmtMoney(rentIncomeNet) : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{inputCost ? fmtMoney(inputCost) : "—"}</td>
                        <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${rentProfit != null && rentProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {rentProfit != null ? fmtMoney(rentProfit) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Rent() {
  const [startPeriod, setStartPeriod] = useState(CUR_MONTH);
  const [endPeriod, setEndPeriod] = useState(CUR_MONTH);
  const [dim, setDim] = useState<"landlord" | "brand">("landlord");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 区间内月份列表（限制最多 36 个月）
  const monthRange = useMemo(() => {
    const list: string[] = [];
    let p = startPeriod;
    let guard = 0;
    while (p <= endPeriod && guard < 36) {
      list.push(p);
      p = shift(p, 1);
      guard++;
    }
    return list;
  }, [startPeriod, endPeriod]);

  const q = useQuery({
    queryKey: ["rent-monthly-ledger-range", startPeriod, endPeriod, dim],
    queryFn: async () => {
      const results = await Promise.all(monthRange.map((p) => getMonthlyLedger(p, dim)));
      return monthRange.map((p, i) => ({ period: p, ...results[i] }));
    },
    enabled: monthRange.length > 0,
  });

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const months: any[] = q.data ?? [];

  // 逐年付款/到账的年份列：取当前月份所有合同分期覆盖的年份并集（升序）
  const yearLabels = useMemo(() => {
    const years = new Set<string>();
    for (const m of months) {
      for (const g of m.rows ?? []) {
        for (const c of g.contracts ?? []) {
          for (const ys of c.yearStatus ?? []) years.add(ys.year);
        }
      }
    }
    return [...years].sort();
  }, [months]);

  // 整年场地收支（框外）：取第一个月的 yearlyRows（后端按该年全年合同构建）
  const yearlyRows: any[] = useMemo(() => (months[0]?.yearlyRows ?? []), [months]);
  const yearLabel = useMemo(() => (startPeriod || CUR_MONTH).slice(0, 4) + "年", [startPeriod]);

  // 区间合计（总览）
  const totals = useMemo(() => {
    const t = { rentIncome: 0, rentCost: 0, rentTax: 0, paidAmount: 0, pendingAmount: 0, rentProfit: 0 };
    for (const m of months) {
      const mt = m.totals ?? {};
      t.rentIncome += mt.rentIncome ?? 0;
      t.rentCost += mt.rentCost ?? 0;
      t.rentTax += mt.rentTax ?? 0;
      t.paidAmount += mt.paidAmount ?? 0;
      t.pendingAmount += mt.pendingAmount ?? 0;
    }
    t.rentProfit = t.rentIncome - t.rentCost - t.rentTax;
    return t;
  }, [months]);

  const quick = (n: number) => {
    setEndPeriod(CUR_MONTH);
    setStartPeriod(shift(CUR_MONTH, -(n - 1)));
  };

  // 公司主体（导出"收款公司"列）
  const entities = useQuery({ queryKey: ["entities"], queryFn: listEntities });
  const collectCompany = useMemo(
    () => (entities.data ?? []).map((e: any) => e.name).join("、"),
    [entities.data]
  );

  // ── 导出 Excel（参考美团场租台账格式：每 场地×品牌 一行，整年口径）──
  const doExport = () => {
    if (yearlyRows.length === 0) { toast.error("暂无数据可导出"); return; }
    const rows: unknown[][] = [];
    let seq = 0;
    for (const gy of yearlyRows) {
      const venue: any = gy.venue || {};
      const brands = (gy.brands ?? []).filter((b: any) => b.contractType === "品牌方合同");
      const costStart = venue.startDate;
      const costEnd = venue.endDate;
      const years = costStart && costEnd
        ? Math.round((new Date(costEnd).getTime() - new Date(costStart).getTime()) / (365.25 * 24 * 60 * 60 * 1000) * 10) / 10
        : null;
      const payStatus = (venue.yearStatus ?? []).map((ys: any) => `${ys.year}:${ys.paid}/${ys.total}`).join(" ");
      brands.forEach((c: any, idx: number) => {
        seq++;
        const cabinets = c.cabinetsCount != null ? Number(c.cabinetsCount) : 1;
        const unitMonthly = c.unitMonthlyRent != null ? Number(c.unitMonthlyRent) : null;
        const unitAnnual = unitMonthly != null ? Math.round(unitMonthly * 12 * 100) / 100 : null;
        const taxRate = c.rentTaxRate != null ? c.rentTaxRate : 0;
        const inputCost = c.inputCost != null ? Number(c.inputCost) : 0;
        const venueRentGross = unitAnnual != null ? Math.round(unitAnnual * cabinets * 100) / 100 : null;
        const rentIncomeNet = venueRentGross != null
          ? (taxRate > 0 ? Math.round(venueRentGross * (1 - taxRate) * 100) / 100 : venueRentGross)
          : null;
        const unitCostAnnual = c.unitCostAnnual != null ? Number(c.unitCostAnnual) : null;
        const rentCostAnnual = unitCostAnnual != null ? Math.round(unitCostAnnual * cabinets * 100) / 100 : null;
        const rentProfit = (rentIncomeNet != null && rentCostAnnual != null)
          ? Math.round((rentIncomeNet - rentCostAnnual - inputCost) * 100) / 100
          : null;
        const incomeStatus = (c.yearStatus ?? []).map((ys: any) => `${ys.year}:${ys.paid}/${ys.total}`).join(" ");
        rows.push([
          seq,
          collectCompany, // 收款公司 = 公司主体
          "", // 占股（暂无数据）
          gy.landlordName,
          c.brandName || "",
          cabinets,
          venue.landlordContact || venue.landlordName || "",
          costStart ? `${String(costStart).slice(0, 10)} ~ ${costEnd ? String(costEnd).slice(0, 10) : ""}` : "",
          years != null ? `${years}年` : "",
          rentCostAnnual != null ? Math.round(rentCostAnnual * 100) / 100 : "",
          venue.payMethod || "",
          payStatus,
          unitCostAnnual != null ? Math.round(unitCostAnnual * 100) / 100 : "",
          idx === 0 && venue.deposit != null ? Math.round(venue.deposit * 100) / 100 : "",
          c.startDate ? `${String(c.startDate).slice(0, 10)} ~ ${c.endDate ? String(c.endDate).slice(0, 10) : ""}` : "",
          incomeStatus,
          unitMonthly != null ? Math.round(unitMonthly * 100) / 100 : "",
          unitAnnual != null ? Math.round(unitAnnual * 100) / 100 : "",
          venueRentGross != null ? Math.round(venueRentGross * 100) / 100 : "",
          taxRate > 0 ? `${(taxRate * 100).toFixed(0)}%` : "",
          rentIncomeNet != null ? Math.round(rentIncomeNet * 100) / 100 : "",
          inputCost ? Math.round(inputCost * 100) / 100 : "",
          rentProfit != null ? Math.round(rentProfit * 100) / 100 : "",
        ]);
      });
    }
    exportXlsxWithTitle(`场地费台账_${yearLabel.replace("年", "")}`, {
      sheetName: "场地费台账",
      title: `${yearLabel}场地费台账（整年口径 · 每 场地×品牌 一行）`,
      headers: [
        "序号", "收款公司", "占股", "站名", "品牌方", "柜数", "负责人", "合同租期", "合作年限",
        "租金成本/年", "付款方式", "付款情况", "单台成本/年", "押金", "合同收款租期", "到账情况",
        "单台月租金(含税)", "单台年收入(含税)", "租金收入(含税)/年", "税率", "租金收入(不含税)/年", "进项成本", "租金利润",
      ],
      rows,
    });
    toast.success("已导出 Excel");
  };

  return (
    <div className="space-y-4">
      {/* ── 顶部：月份区间 + 维度切换 ── */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">场地费月台账</h2>
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <span>从</span>
          <input type="month" className={`${inputCls} w-36`} value={toDisplay(startPeriod)}
            onChange={(e) => e.target.value && setStartPeriod(toCompact(e.target.value))} />
          <span>到</span>
          <input type="month" className={`${inputCls} w-36`} value={toDisplay(endPeriod)}
            onChange={(e) => e.target.value && setEndPeriod(toCompact(e.target.value))} />
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => { setStartPeriod(CUR_MONTH); setEndPeriod(CUR_MONTH); }}>本月</Button>
          <Button size="sm" variant="outline" onClick={() => quick(3)}>近3月</Button>
          <Button size="sm" variant="outline" onClick={() => quick(6)}>近6月</Button>
          <Button size="sm" variant="outline" onClick={() => quick(12)}>近12月</Button>
        </div>
        <div className="flex overflow-hidden rounded-lg border">
          <Button size="sm" variant={dim === "landlord" ? "default" : "ghost"}
            className={dim === "landlord" ? "bg-emerald-600 hover:bg-emerald-700" : ""}
            onClick={() => setDim("landlord")}>
            <Building2 className="mr-1 h-3.5 w-3.5" />按场地方
          </Button>
          <Button size="sm" variant={dim === "brand" ? "default" : "ghost"}
            className={dim === "brand" ? "bg-blue-600 hover:bg-blue-700" : ""}
            onClick={() => setDim("brand")}>
            <Tag className="mr-1 h-3.5 w-3.5" />按品牌方
          </Button>
        </div>
        <span className="text-xs text-slate-400">
          {toDisplay(startPeriod)} ~ {toDisplay(endPeriod)} · 仅场地费（不含电费）
        </span>
        <Button size="sm" className="ml-auto bg-blue-600 hover:bg-blue-700" onClick={doExport}>
          <Download className="mr-1 h-3.5 w-3.5" />导出 Excel
        </Button>
      </div>

      {/* ── 区间总览（合计核对） ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <StatCard label="区间场地费收入" value={totals.rentIncome} tone="emerald" />
        {dim === "landlord" && <StatCard label="区间场地费成本" value={totals.rentCost} tone="rose" />}
        <StatCard label="区间税费" value={totals.rentTax} />
        <StatCard label="区间利润" value={totals.rentProfit} tone="blue" />
        <StatCard label="区间已收/已付" value={totals.paidAmount} />
        <StatCard label="区间未收/未付" value={totals.pendingAmount} />
      </div>

      {/* ── 整年场地收支（框外：按场地×品牌，整年口径） ── */}
      {yearlyRows.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-slate-700">整年场地收支（{yearLabel}）</h3>
            <span className="text-[11px] text-slate-400">付款信息=场地合同 · 收款信息=品牌方合同 · 按合同周期计算</span>
          </div>
          <YearlyTable yearlyRows={yearlyRows} yearLabels={yearLabels} />
        </div>
      )}

      {/* ── 按月总览表 ── */}
      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-xs">
          <thead>
            <tr className="border-b bg-slate-50 text-left text-[11px] text-slate-500">
              <th className="w-8 px-2 py-2.5"></th>
              <th className="px-3 py-2.5 font-medium">月份</th>
              <th className="px-3 py-2.5 text-right font-medium">场地费收入</th>
              {dim === "landlord" && <th className="px-3 py-2.5 text-right font-medium">场地费成本</th>}
              <th className="px-3 py-2.5 text-right font-medium">税费</th>
              <th className="px-3 py-2.5 text-right font-medium">利润</th>
              <th className="px-3 py-2.5 text-right font-medium">已收/已付</th>
              <th className="px-3 py-2.5 text-right font-medium">未收/未付</th>
            </tr>
          </thead>
          <tbody>
            {months.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                {q.isLoading ? "加载中…" : "请选择有效的月份区间"}
              </td></tr>
            )}
            {months.map((m) => {
              const mt = m.totals ?? {};
              const mKey = `m-${m.period}`;
              const mOpen = expanded.has(mKey);
              return (
                <Fragment key={mKey}>
                  <tr className="cursor-pointer border-b hover:bg-slate-50/60" onClick={() => toggle(mKey)}>
                    <td className="px-2 py-2.5 text-slate-400">
                      {mOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-slate-700">{toDisplay(m.period)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{fmtMoney(mt.rentIncome)}</td>
                    {dim === "landlord" && <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{fmtMoney(mt.rentCost)}</td>}
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{fmtMoney(mt.rentTax)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-slate-700">{fmtMoney(mt.rentProfit)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmtMoney(mt.paidAmount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-amber-600">{fmtMoney(mt.pendingAmount)}</td>
                  </tr>
                  {mOpen && (
                    <tr className="border-b bg-slate-50/40">
                      <td colSpan={dim === "landlord" ? 8 : 7} className="px-6 py-3">
                        <div className="space-y-1">
                          <div className="text-[11px] font-medium text-slate-400">
                            {toDisplay(m.period)} · 按{dim === "landlord" ? "场地方" : "品牌方"}明细（点击展开合同：付款/收款信息）
                          </div>
                          {(m.rows ?? []).map((g: any) => (
                            <div key={g.key} className="overflow-x-auto rounded-lg border bg-white">
                              <table className="w-full min-w-[640px] text-[11px]">
                                <thead>
                                  <tr className="border-b bg-slate-100 text-left text-[10px] text-slate-500">
                                    <th className="px-2 py-1">{dim === "landlord" ? "场地方" : "品牌方"}</th>
                                    <th className="px-2 py-1 text-right">场地费收入</th>
                                    {dim === "landlord" && <th className="px-2 py-1 text-right">场地费成本</th>}
                                    <th className="px-2 py-1 text-right">税费</th>
                                    <th className="px-2 py-1 text-right">利润</th>
                                    <th className="px-2 py-1 text-right">已收/已付</th>
                                    <th className="px-2 py-1 text-right">未收/未付</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr className="border-b last:border-0">
                                    <td className="px-2 py-1.5 font-medium text-slate-700">{g.name}</td>
                                    <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(g.rentIncome)}</td>
                                    {dim === "landlord" && <td className="px-2 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(g.rentCost)}</td>}
                                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{fmtMoney(g.rentTax)}</td>
                                    <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-700">{fmtMoney(g.rentProfit)}</td>
                                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{fmtMoney(g.paidAmount)}</td>
                                    <td className="px-2 py-1.5 text-right tabular-nums text-amber-600">{fmtMoney(g.pendingAmount)}</td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          {months.length > 0 && (
            <tfoot>
              <tr className="border-t bg-slate-50 font-medium">
                <td className="px-2 py-2.5" colSpan={2}>区间合计（{months.length} 个月）</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{fmtMoney(totals.rentIncome)}</td>
                {dim === "landlord" && <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{fmtMoney(totals.rentCost)}</td>}
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{fmtMoney(totals.rentTax)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.rentProfit)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.paidAmount)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.pendingAmount)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        口径：收入=品牌方合同月租（覆盖该月）；成本=场地合同月租；税费=启用租金税率的品牌方合同（含税月租−税后月租）；
        已收/未收 = 该月覆盖期次的分期状态（品牌方=已到账/未到账，场地=已付款/未付款）。不含电费。编辑合同请到「合同管理」页。
      </p>
    </div>
  );
}
