import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getMonthlyLedger } from "@/api/rent";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/fields";
import { fmtMoney } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { Building2, Tag, ChevronDown, ChevronRight } from "lucide-react";

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
                            {toDisplay(m.period)} · 按{dim === "landlord" ? "场地方" : "品牌方"}明细（点击可展开合同）
                          </div>
                          {(m.rows ?? []).map((g: any) => {
                            const rKey = `r-${m.period}-${dim}-${g.key}`;
                            const rOpen = expanded.has(rKey);
                            return (
                              <Fragment key={rKey}>
                                <div className="flex cursor-pointer items-center gap-x-4 rounded-md border bg-white px-3 py-1.5 text-xs hover:bg-slate-50" onClick={() => toggle(rKey)}>
                                  <span className="text-slate-400">{rOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
                                  <span className="w-40 font-medium text-slate-700">{g.name}</span>
                                  <span className="text-emerald-600 tabular-nums">收 {fmtMoney(g.rentIncome)}</span>
                                  {dim === "landlord" && <span className="text-rose-600 tabular-nums">成 {fmtMoney(g.rentCost)}</span>}
                                  <span className="text-slate-400 tabular-nums">税 {fmtMoney(g.rentTax)}</span>
                                  <span className="text-slate-700 tabular-nums">利 {fmtMoney(g.rentProfit)}</span>
                                  <span className="ml-auto text-slate-500 tabular-nums">已{fmtMoney(g.paidAmount)} / 未{fmtMoney(g.pendingAmount)}</span>
                                </div>
                                {rOpen && (
                                  <div className="ml-6 space-y-1 border-l pl-3">
                                    {(g.contracts ?? []).map((c: any) => (
                                      <div key={c.contractId} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-white px-3 py-1.5 text-xs">
                                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                          c.contractType === "品牌方合同" ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}>
                                          {c.contractType}
                                        </span>
                                        {c.brandName && <span className="font-medium text-slate-700">{c.brandName}</span>}
                                        <span className="text-slate-500">月租 <b className="tabular-nums">{fmtMoney(c.monthlyRent)}</b></span>
                                        {c.rentTax > 0 && <span className="text-slate-400">税费 {fmtMoney(c.rentTax)}</span>}
                                        {c.payMethod && <span className="text-slate-400">{c.payMethod}</span>}
                                        {c.startDate && <span className="text-slate-400">{c.startDate} ~ {c.endDate ?? ""}</span>}
                                        <span className="ml-auto flex gap-3 tabular-nums">
                                          <span className="text-emerald-600">已{c.contractType === "品牌方合同" ? "收" : "付"} {fmtMoney(c.paidAmount)}</span>
                                          <span className="text-amber-600">未{c.contractType === "品牌方合同" ? "收" : "付"} {fmtMoney(c.pendingAmount)}</span>
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </Fragment>
                            );
                          })}
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
