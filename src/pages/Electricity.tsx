import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getElectricityMonthlyLedger, exportElectricityLedger } from "@/api/electricity";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/fields";
import { fmtMoney, fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { Building2, Tag, ChevronDown, ChevronRight, Download } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";

// 电费月台账（v2 重设计）：只显示电费经营信息
// 参考 Rent 页风格：月份区间 + 按场地方/品牌方 + 区间总览 + 按月展开明细
// 已移除「新增电费」「自动生成」按钮（台账由 电表归属/合同/读数 变更自动生成）

function StatCard({ label, value, suffix = "", tone = "slate" }: { label: string; value?: number; suffix?: string; tone?: "emerald" | "rose" | "blue" | "slate" }) {
  const color = tone === "emerald" ? "text-emerald-600" : tone === "rose" ? "text-rose-600" : tone === "blue" ? "text-blue-600" : "text-slate-700";
  return (
    <div className="rounded-xl border bg-white p-3 shadow-sm">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>{suffix === "kwh" ? fmtNum(value ?? 0) : fmtMoney(value ?? 0)}</div>
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

// ─── 电费收付明细台账导出（参考 Excel：28 列，按维度分组合并，冻结前3列+前2行）───
const LEDGER_HEADERS = [
  "序号", "收款公司", "站名", "业主方", "电表编号", "互感器倍数",
  "上月抄表时间", "起始度数", "抄表时间", "抄表度数", "区间度数",
  "付款单价", "付款金额", "付款情况",
  "起始度数", "抄表时间", "抄表度数", "区间度数",
  "收款单价", "收款金额", "不含税收入", "到账情况",
  "利润", "运营费用", "运营费用后利润", "公司占股", "公司净利润", "备注",
];
// 参考 Excel 列宽
const LEDGER_COLS = [5, 11, 16, 11.9, 14.2, 5.2, 7.4, 7, 9.1, 10.9, 11.7, 10, 11, 9, 11, 10, 9, 10, 13, 9, 11, 12, 10, 9, 11, 10, 11, 12];

function toRow(r: any, seq: number): any[] {
  return [
    seq,
    r.collectCompany ?? "",
    r.stationName ?? "",
    r.landlordName ?? "",
    r.meterNo ?? "",
    r.transformerRatio ?? 1,
    r.prevReadingDate ?? "",
    r.startReading ?? 0,
    r.readingDate ?? "",
    r.endReading ?? 0,
    r.kwh ?? 0,
    r.payUnitPrice ?? 0,
    r.payAmount ?? 0,
    r.payStatus ?? "",
    r.collectStartReading ?? 0,
    r.collectReadingDate ?? "",
    r.collectEndReading ?? 0,
    r.collectKwh ?? 0,
    r.collectUnitPrice ?? 0,
    r.collectAmount ?? 0,
    r.collectNet ?? 0,
    r.collectStatus ?? "",
    r.profit ?? 0,
    r.opExpense ?? 0,
    r.profitAfterOp ?? 0,
    r.companyShare ?? "",
    r.companyNetProfit ?? "",
    r.remark ?? "",
  ];
}

function buildLedgerSheet(data: any): XLSX.WorkSheet {
  const period = data.period ?? "";
  const rows = data.rows ?? [];
  // 按 groupKey 分组，保持顺序
  const groups: { key: string; name: string; rows: any[] }[] = [];
  const byKey = new Map<string, { key: string; name: string; rows: any[] }>();
  for (const r of rows) {
    let g = byKey.get(r.groupKey);
    if (!g) {
      g = { key: r.groupKey, name: r.group || r.collectCompany || "", rows: [] };
      byKey.set(r.groupKey, g);
      groups.push(g);
    }
    g.rows.push(r);
  }

  // 组装 aoa：标题 + 表头 + 数据（组内行 + 组合计）+ 总计
  const aoa: any[][] = [
    [`电费收付明细台账（${toDisplay(period)}）`],
    LEDGER_HEADERS,
  ];
  const merges: XLSX.Range[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: LEDGER_HEADERS.length - 1 } }];
  let seq = 0;

  const groupTotals = data.groupTotals ?? [];
  const totals = data.totals ?? {};

  for (const g of groups) {
    const startRow = aoa.length;
    for (const r of g.rows) {
      seq += 1;
      aoa.push(toRow(r, seq));
    }
    const endRow = aoa.length - 1;
    // 组内 B 列（收款公司）合并
    if (endRow >= startRow) {
      merges.push({ s: { r: startRow, c: 1 }, e: { r: endRow, c: 1 } });
    }
    // 组合计行（A:D 合并 + 金额合计）
    const gt = groupTotals.find((t: any) => t.group === g.name) ?? {};
    const sumRow = [
      "合计", "", "", "",
      "", "", "", "", "", "",
      gt.kwh ?? 0,
      "", gt.payAmount ?? 0, "",
      "", "", "", "",
      "", gt.collectAmount ?? 0, gt.collectNet ?? 0, "",
      gt.profit ?? 0, gt.opExpense ?? 0, gt.profitAfterOp ?? 0, "", gt.companyNetProfit ?? "", "",
    ];
    aoa.push(sumRow);
    merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: 3 } });
  }

  // 总计行
  const totalRow = [
    "总计", "", "", "",
    "", "", "", "", "", "",
    totals.kwh ?? 0,
    "", totals.payAmount ?? 0, "",
    "", "", "", "",
    "", totals.collectAmount ?? 0, totals.collectNet ?? 0, "",
    totals.profit ?? 0, totals.opExpense ?? 0, totals.profitAfterOp ?? 0, "", totals.companyNetProfit ?? "", "",
  ];
  aoa.push(totalRow);
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: 3 } });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  ws["!cols"] = LEDGER_COLS.map((w) => ({ wch: w }));
  // 冻结前 3 列 + 前 2 行（参考 Excel：D3）
  ws["!views"] = [{ state: "frozen", xSplit: 3, ySplit: 2, topLeftCell: "D3" }];
  return ws;
}

export default function Electricity() {
  const [startPeriod, setStartPeriod] = useState(CUR_MONTH);
  const [endPeriod, setEndPeriod] = useState(CUR_MONTH);
  const [dim, setDim] = useState<"landlord" | "brand">("landlord");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
    queryKey: ["electricity-monthly-ledger-range", startPeriod, endPeriod, dim],
    queryFn: async () => {
      const results = await Promise.all(monthRange.map((p) => getElectricityMonthlyLedger(p, dim)));
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
  const totals = useMemo(() => {
    const t = { kwh: 0, payAmount: 0, collectAmount: 0, collectNet: 0, elecTax: 0, profit: 0 };
    for (const m of months) {
      const mt = m.totals ?? {};
      t.kwh += mt.kwh ?? 0;
      t.payAmount += mt.payAmount ?? 0;
      t.collectAmount += mt.collectAmount ?? 0;
      t.collectNet += mt.collectNet ?? 0;
      t.elecTax += mt.elecTax ?? 0;
      t.profit += mt.profit ?? 0;
    }
    return t;
  }, [months]);

  const quick = (n: number) => {
    setEndPeriod(CUR_MONTH);
    setStartPeriod(shift(CUR_MONTH, -(n - 1)));
  };

  const [exporting, setExporting] = useState(false);

  const doExport = async () => {
    if (monthRange.length === 0) { toast.error("请选择有效的月份区间"); return; }
    setExporting(true);
    try {
      const wb = XLSX.utils.book_new();
      let sheetCount = 0;
      for (const p of monthRange) {
        const data = await exportElectricityLedger(p, dim);
        if (!data || !data.rows || data.rows.length === 0) continue;
        XLSX.utils.book_append_sheet(wb, buildLedgerSheet(data), toDisplay(p).replace("-", "").slice(0, 31) || "台账");
        sheetCount++;
      }
      if (sheetCount === 0) { toast.error("所选区间没有可导出的电费数据"); return; }
      const name = `电费收付明细台账_${toDisplay(startPeriod)}-${toDisplay(endPeriod)}`;
      XLSX.writeFile(wb, `${name}.xlsx`);
      toast.success(`已导出 ${sheetCount} 个月台账`);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "导出失败，请稍后重试");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── 顶部：月份区间 + 维度切换 ── */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">电费月台账</h2>
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
        <span className="text-xs text-slate-400">{toDisplay(startPeriod)} ~ {toDisplay(endPeriod)} · 电费经营信息</span>
        <Button size="sm" className="ml-auto bg-blue-600 hover:bg-blue-700" disabled={exporting} onClick={doExport}>
          <Download className="mr-1 h-3.5 w-3.5" />{exporting ? "导出中…" : "导出 Excel"}
        </Button>
      </div>

      {/* ── 区间总览 ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <StatCard label="区间电量（度）" value={totals.kwh} suffix="kwh" />
        <StatCard label="电费付款（成本）" value={totals.payAmount} tone="rose" />
        <StatCard label="电费收款（含税）" value={totals.collectAmount} />
        <StatCard label="电费收款（不含税）" value={totals.collectNet} tone="emerald" />
        <StatCard label="电费税费" value={totals.elecTax} />
        <StatCard label="电费利润" value={totals.profit} tone="blue" />
      </div>

      {/* ── 按月总览表 ── */}
      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        <table className="w-full min-w-[1000px] text-xs">
          <thead>
            <tr className="border-b bg-slate-50 text-left text-[11px] text-slate-500">
              <th className="w-8 px-2 py-2.5"></th>
              <th className="px-3 py-2.5 font-medium">月份</th>
              <th className="px-3 py-2.5 text-right font-medium">电量（度）</th>
              <th className="px-3 py-2.5 text-right font-medium">电费付款</th>
              <th className="px-3 py-2.5 text-right font-medium">收款含税</th>
              <th className="px-3 py-2.5 text-right font-medium">收款不含税</th>
              <th className="px-3 py-2.5 text-right font-medium">税费</th>
              <th className="px-3 py-2.5 text-right font-medium">利润</th>
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
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmtNum(mt.kwh)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{fmtMoney(mt.payAmount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{fmtMoney(mt.collectAmount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{fmtMoney(mt.collectNet)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{fmtMoney(mt.elecTax)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-slate-700">{fmtMoney(mt.profit)}</td>
                  </tr>
                  {mOpen && (
                    <tr className="border-b bg-slate-50/40">
                      <td colSpan={8} className="px-6 py-3">
                        <div className="space-y-1">
                          <div className="text-[11px] font-medium text-slate-400">
                            {toDisplay(m.period)} · 按{dim === "landlord" ? "场地方" : "品牌方"}明细（点击展开电表）
                          </div>
                          {(m.rows ?? []).map((g: any) => {
                            const rKey = `r-${m.period}-${dim}-${g.key}`;
                            const rOpen = expanded.has(rKey);
                            const hasTransformerRatio = (g.details ?? []).some((d: any) => d.transformerRatio && d.transformerRatio !== 1);
                            const hasBrandDimension = (g.details ?? []).some((d: any) => d.brandName);
                            return (
                              <Fragment key={rKey}>
                                <div className="flex cursor-pointer items-center gap-x-4 rounded-md border bg-white px-3 py-1.5 text-xs hover:bg-slate-50" onClick={() => toggle(rKey)}>
                                  <span className="text-slate-400">{rOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
                                  <span className="w-44 font-medium text-slate-700">{g.name}</span>
                                  <span className="text-slate-500 tabular-nums">{fmtNum(g.kwh)} 度</span>
                                  <span className="text-rose-600 tabular-nums">付 {fmtMoney(g.payAmount)}</span>
                                  <span className="text-emerald-600 tabular-nums">收 {fmtMoney(g.collectNet)}</span>
                                  <span className="text-slate-400 tabular-nums">税 {fmtMoney(g.elecTax)}</span>
                                  <span className="ml-auto text-slate-700 tabular-nums">利 {fmtMoney(g.profit)}</span>
                                </div>
                                {rOpen && (
                                  <div className="ml-6 overflow-x-auto rounded-lg border bg-white">
                                    <table className="w-full min-w-[920px] text-[11px]">
                                      <thead>
                                        <tr className="border-b bg-slate-100 text-left text-[10px] text-slate-500">
                                          <th className="px-2 py-1.5" rowSpan={2}>{dim === "landlord" ? "电表" : "电表"}</th>
                                          {hasBrandDimension && <th className="px-2 py-1.5" rowSpan={2}>品牌方</th>}
                                          {hasTransformerRatio && <th className="px-2 py-1.5" rowSpan={2}>互感器倍数</th>}
                                          <th className="px-2 py-1.5" rowSpan={2}>度数(kWh)</th>
                                          <th className="border-x bg-rose-50/70 px-2 py-1.5 text-center" colSpan={3}>付款信息</th>
                                          <th className="border-x bg-emerald-50/70 px-2 py-1.5 text-center" colSpan={4}>收款信息</th>
                                          <th className="px-2 py-1.5" rowSpan={2}>利润</th>
                                        </tr>
                                        <tr className="border-b bg-slate-100 text-[10px] text-slate-500">
                                          <th className="border-x px-2 py-1">单价</th>
                                          <th className="px-2 py-1">金额</th>
                                          <th className="px-2 py-1">情况</th>
                                          <th className="border-x px-2 py-1">单价</th>
                                          <th className="px-2 py-1">金额(含税)</th>
                                          <th className="px-2 py-1">不含税</th>
                                          <th className="px-2 py-1">到账</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {(g.details ?? []).map((d: any, i: number) => (
                                          <tr key={i} className="border-b last:border-0 hover:bg-slate-50/50">
                                            <td className="px-2 py-1.5">
                                              <div className="font-medium text-slate-700">{d.meterName ?? d.stationName ?? "—"}</div>
                                              <div className="font-mono text-[10px] text-slate-400">{d.meterNo}{d.meterName ? ` · ${d.meterName}` : ""}</div>
                                            </td>
                                            {hasBrandDimension && <td className="px-2 py-1.5 tabular-nums">{d.brandName ?? "—"}</td>}
                                            {hasTransformerRatio && <td className="px-2 py-1.5 tabular-nums">{fmtNum(d.transformerRatio)}</td>}
                                            <td className="px-2 py-1.5 tabular-nums">{fmtNum(d.kwh ?? d.payKwh)}</td>
                                            <td className="border-x px-2 py-1.5 text-right tabular-nums">{d.payUnitPrice != null ? fmtNum(d.payUnitPrice) : "—"}</td>
                                            <td className="px-2 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(d.payAmount)}</td>
                                            <td className="px-2 py-1.5">{d.payStatus ?? "—"}</td>
                                            <td className="border-x px-2 py-1.5 text-right tabular-nums">{d.collectUnitPrice != null ? fmtNum(d.collectUnitPrice) : "—"}</td>
                                            <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(d.collectAmount)}</td>
                                            <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(d.collectNet)}</td>
                                            <td className="px-2 py-1.5">{d.collectStatus ?? "—"}</td>
                                            <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-700">
                                              {fmtMoney(d.profit ?? (Number(d.collectNet ?? 0) - Number(d.payAmount ?? 0)))}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
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
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(totals.kwh)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{fmtMoney(totals.payAmount)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.collectAmount)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{fmtMoney(totals.collectNet)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.elecTax)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.profit)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        口径：电费付款=实际度数×场地合同单价；电费收款=实际度数×品牌方合同单价（按电表品牌匹配）；
        税费=含税收款−不含税收款；利润=不含税收款−付款。台账由「电表归属/合同/读数」变更自动生成，无需手动操作。
      </p>
    </div>
  );
}
