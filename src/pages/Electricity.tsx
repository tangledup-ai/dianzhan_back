import { Fragment, useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getElectricityMonthlyLedger, exportElectricityLedger, getReadingDetail, updateElectricityStatus, getLandlordMonthlyElec, saveLandlordMonthlyElec } from "@/api/electricity";
import { listLandlords } from "@/api/directory";
import { submitStationApproval } from "@/api/approvals";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, TextInput, SearchSelect, inputCls } from "@/components/fields";
import { fmtMoney, fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { ChevronDown, ChevronRight, Download, Send, FileText, Zap } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import "@/components/excel-table.css";   // ★ Excel 风表格样式（仅本页/场租台账/智慧电表使用）

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

// ─── 台账明细按「电表」分组 ───
// 共享电表（「所有品牌共用此电表」）下一块表有多条品牌明细，但**付给场地方只有一整笔**
// （= 整表读数 × 场地合同单价，亏空按电量比例摊在各品牌上）。
// 因此付款信息只在电表分组的第一行展示（rowSpan 跨该表全部品牌行），品牌行只保留各自的收款。
// 普通电表一块表对应一条明细，分组后行数不变，展示与改造前一致。
function groupDetailsByMeter(details: any[]) {
  const groups: any[][] = [];
  const index = new Map<string, number>();
  details.forEach((d, i) => {
    // 无电表编号时各自成组，避免被误并成「一整笔」
    const k = d.meterNo ? `no:${d.meterNo}` : `idx:${i}`;
    if (!index.has(k)) { index.set(k, groups.length); groups.push([]); }
    groups[index.get(k)!].push(d);
  });
  return groups.map((rows) => {
    const sum = (f: (r: any) => number) => Math.round(rows.reduce((s, r) => s + f(r), 0) * 100) / 100;
    const priceRow = rows.find((r) => r.payUnitPrice != null && Number(r.payUnitPrice) > 0);
    const paidCount = rows.filter((r) => r.payStatus === "已付款").length;
    return {
      rows,
      kwh: sum((r) => Number(r.kwh ?? r.payKwh ?? 0)),
      payAmount: sum((r) => Number(r.payAmount ?? 0)),
      payUnitPrice: priceRow ? Number(priceRow.payUnitPrice) : (rows[0]?.payUnitPrice ?? null),
      recordIds: rows.map((r) => r.recordId).filter((x) => x != null) as number[],
      payStatus: paidCount === 0 ? "未付款" : paidCount === rows.length ? "已付款" : "部分已付款",
      shared: rows.length > 1,
    };
  });
}

// ─── 抄表核对详情弹窗（发给场地方/品牌方老板核对）───
function ReadingDetailDialog({ target, onClose }: { target: { meterNo: string; period: string } | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["reading-detail", target?.meterNo, target?.period],
    queryFn: () => getReadingDetail(target!.meterNo, target!.period),
    enabled: !!target,
  });
  const mtr = (q.data?.meter ?? {}) as any;
  const rd = (q.data?.reading ?? {}) as any;
  const lg = (q.data?.ledger ?? null) as any;
  // 共享电表按品牌分摊后，同一块表同一月有多条台账明细（每个品牌一条）
  const ledgerRows = ((q.data?.ledgerRows ?? (lg ? [lg] : [])) as any[]);
  const allocations = ((q.data?.allocations ?? []) as any[]);
  const prev = q.data?.prevMonth ?? null;
  const ratio = Number(mtr.transformerRatio ?? 1);

  // 共享电表：付给场地方只有**一整笔**（整表读数 × 场地合同单价），品牌分摊只是把收款拆成几行
  const sharedKwh = Math.round(ledgerRows.reduce((s: number, r: any) => s + Number(r.ledgerKwh ?? 0), 0) * 100) / 100;
  const sharedPayAmount = Math.round(ledgerRows.reduce((s: number, r: any) => s + Number(r.payAmount ?? 0), 0) * 100) / 100;
  const sharedPayPrice = Number((ledgerRows.find((r: any) => Number(r.payUnitPrice ?? 0) > 0) ?? {}).payUnitPrice ?? 0);
  const sharedPaidCount = ledgerRows.filter((r: any) => r.payStatus === "已付款").length;
  const sharedPayStatus = sharedPaidCount === 0 ? "未付款"
    : sharedPaidCount === ledgerRows.length ? "已付款" : "部分已付款";

  const copyText = async () => {
    const usage = ledgerRows.length > 1 ? sharedKwh : Number(lg?.ledgerKwh ?? (Number(rd.kwh ?? 0) * ratio));
    const lines = [
      `【电费抄表核对】${mtr.landlordName ?? ""}（${mtr.brandName || "全品牌共享"}）`,
      `电表：${mtr.meterNo ?? target?.meterNo}${mtr.meterName ? `（${mtr.meterName}）` : ""}`,
      `上月抄表：${rd.prevReadingDate ?? "—"}　表盘读数 ${rd.prevReading ?? "—"}`,
      `本月抄表：${rd.currReadingDate ?? "—"}　表盘读数 ${rd.currReading ?? "—"}`,
      `区间度数：${rd.kwh ?? "—"} × 倍数 ${ratio} = 计费用量 ${usage.toFixed(2)} 度`,
      ...(ledgerRows.length > 1
        ? [
            `【付场地方（整表）】${fmtNum(sharedKwh)} 度 × ${fmtMoney(sharedPayPrice)} 元/度 = ` +
            `${fmtMoney(sharedPayAmount)} 元（${sharedPayStatus}）`,
            "【品牌分摊明细】各品牌只承担自己用电量对应的成本（损耗我方承担，不摊品牌）：",
            ...ledgerRows.map((r: any) =>
              `${r.brandName || "全品牌共享"}：应收（品牌方支付）${fmtMoney(Number(r.collectAmount ?? 0))} 元` +
              `（不含税 ${fmtMoney(Number(r.collectNet ?? 0))}）`
            ),
          ]
        : [
            `应付电费（付场地方）：${fmtMoney(Number(lg?.payAmount ?? 0))} 元（单价 ${fmtMoney(Number(lg?.payUnitPrice ?? 0))} 元/度）`,
            `应收电费（品牌方支付）：${fmtMoney(Number(lg?.collectAmount ?? 0))} 元（单价 ${fmtMoney(Number(lg?.collectUnitPrice ?? 0))} 元/度，不含税 ${fmtMoney(Number(lg?.collectNet ?? 0))}）`,
          ]),
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(lines);
      toast.success("已复制，可直接发给场地方/品牌方核对");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = lines;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast.success("已复制，可直接发给场地方/品牌方核对");
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-xl">
        <DialogHeader>
          <DialogTitle>抄表核对详情 — {mtr.meterName || target?.meterNo || ""}</DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <div className="py-6 text-center text-xs text-slate-400">加载中…</div>
        ) : q.data ? (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 px-3 py-2 text-slate-600">
              <div>场地方：{mtr.landlordName ?? "—"}</div>
              <div>品牌方：{mtr.brandName || "全品牌共享"}</div>
              <div>电表编号：{mtr.meterNo}</div>
              <div>倍数：{ratio}</div>
            </div>
            <table className="w-full rounded-md border text-xs">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-2 py-1.5 font-medium">项目</th>
                  <th className="px-2 py-1.5 font-medium">抄表日期</th>
                  <th className="px-2 py-1.5 text-right font-medium">表盘读数</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <td className="px-2 py-1.5">上月抄表</td>
                  <td className="px-2 py-1.5">{rd.prevReadingDate ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{rd.prevReading ?? "—"}</td>
                </tr>
                <tr className="border-t">
                  <td className="px-2 py-1.5">本月抄表</td>
                  <td className="px-2 py-1.5">{rd.currReadingDate ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{rd.currReading ?? "—"}</td>
                </tr>
              </tbody>
            </table>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-slate-200 px-3 py-2">
                <div className="text-[10px] text-slate-400">区间度数（表盘差）</div>
                <div className="text-sm font-semibold tabular-nums text-slate-700">{fmtNum(rd.kwh)} 度</div>
              </div>
              <div className="rounded-md border border-slate-200 px-3 py-2">
                <div className="text-[10px] text-slate-400">计费用量（×倍数{ledgerRows.length > 1 ? " · 品牌分摊倒推合计" : ""}）</div>
                <div className="text-sm font-semibold tabular-nums text-slate-700">
                  {ledgerRows.length > 1
                    ? fmtNum(ledgerRows.reduce((s: number, r: any) => s + Number(r.ledgerKwh ?? 0), 0))
                    : fmtNum(lg?.ledgerKwh ?? (Number(rd.kwh ?? 0) * ratio))} 度
                </div>
              </div>
            </div>
            {ledgerRows.length > 1 ? (
              <div className="space-y-2">
                {/* 共享电表：付给场地方按整表（整表读数 × 场地单价）；各品牌只承担自己用电量那部分成本 */}
                <div className="rounded-md border border-rose-100 bg-rose-50/50 px-3 py-2">
                  <div className="text-[10px] text-rose-500">应付电费（付场地方 · 整表）· {sharedPayStatus}</div>
                  <div className="font-semibold tabular-nums text-rose-600">{fmtMoney(sharedPayAmount)} 元</div>
                  <div className="text-[10px] text-slate-400">
                    = 整表 {fmtNum(sharedKwh)} 度 × {fmtMoney(sharedPayPrice)} 元/度
                    （各品牌只承担自己用电量对应的成本；未分摊差额由我方承担，不摊品牌）
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-semibold text-purple-600">
                    品牌分摊明细（{ledgerRows.length} 个品牌 · 应收电费按品牌录入，用量 = 金额 ÷ 单价 倒推）
                  </div>
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="bg-slate-50 text-left text-slate-500">
                          <th className="px-2 py-1.5 font-medium">品牌方</th>
                          <th className="px-2 py-1.5 text-right font-medium">应收电量(度)</th>
                          <th className="px-2 py-1.5 text-right font-medium">收款单价</th>
                          <th className="px-2 py-1.5 text-right font-medium">应收(元)</th>
                          <th className="px-2 py-1.5 text-right font-medium">不含税</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledgerRows.map((r: any, i: number) => (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-1.5 font-medium text-slate-700">{r.brandName || "全品牌共享"}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">
                              {Number(r.collectUnitPrice ?? 0) > 0
                                ? fmtNum(Math.round((Number(r.collectAmount ?? 0) / Number(r.collectUnitPrice)) * 100) / 100)
                                : "—"}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(Number(r.collectUnitPrice ?? 0))}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(Number(r.collectAmount ?? 0))}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(Number(r.collectNet ?? 0))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : lg ? (
              <div className="grid grid-cols-2 gap-2 text-slate-600">
                <div className="rounded-md border border-rose-100 bg-rose-50/50 px-3 py-2">
                  <div className="text-[10px] text-rose-500">应付电费（付场地方）· {lg.payStatus}</div>
                  <div className="font-semibold tabular-nums text-rose-600">{fmtMoney(Number(lg.payAmount ?? 0))} 元</div>
                  <div className="text-[10px] text-slate-400">单价 {fmtMoney(Number(lg.payUnitPrice ?? 0))} 元/度</div>
                </div>
                <div className="rounded-md border border-emerald-100 bg-emerald-50/50 px-3 py-2">
                  <div className="text-[10px] text-emerald-500">应收电费（品牌方支付）· {lg.collectStatus}</div>
                  <div className="font-semibold tabular-nums text-emerald-600">{fmtMoney(Number(lg.collectAmount ?? 0))} 元</div>
                  <div className="text-[10px] text-slate-400">单价 {fmtMoney(Number(lg.collectUnitPrice ?? 0))} 元/度 · 不含税 {fmtMoney(Number(lg.collectNet ?? 0))}</div>
                </div>
              </div>
            ) : null}
            {allocations.length > 0 && ledgerRows.length === 0 && (
              <div className="rounded-md border border-purple-100 bg-purple-50/50 px-3 py-2 text-[11px] text-purple-700">
                <div className="font-semibold">已录入品牌分摊（该月台账未生成）</div>
                {allocations.map((a: any, i: number) => (
                  <div key={i} className="mt-0.5 flex items-center justify-between">
                    <span>{a.brandName ?? `品牌${a.brandId}`}</span>
                    <span className="tabular-nums">
                      应收 {fmtMoney(Number(a.collectAmount ?? 0))} 元
                      {a.unitPrice != null ? ` · 单价 ${fmtMoney(Number(a.unitPrice))}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {prev && Number(prev.kwh ?? 0) > 0 && (
              <div className="text-[11px] text-slate-400">上月同期（{toDisplay(prev.month_period)}）用量：{fmtNum(prev.kwh)} 度</div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={copyText}>复制核对文本</Button>
              <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={onClose}>关闭</Button>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-slate-400">未找到该电表的抄表数据</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── 应付电费审批提交弹窗（电费付款：我方付给场地方）───
function PayElectricityDialog({ open, onClose, landlordId, landlordName, period, g }: {
  open: boolean; onClose: () => void;
  landlordId: number; landlordName: string; period: string;
  g: { kwh: number; payAmount: number; collectNet: number; profit: number; details?: any[] } | null;
}) {
  const [applicant, setApplicant] = useState("");
  const [extraNote, setExtraNote] = useState("");
  const queryClient = useQueryClient();
  const periodDisplay = period.length === 6 ? `${period.slice(0, 4)}-${period.slice(4)}` : period;
  // 当前系统月份（YYYYMM）；电费按月应付，只有当月台账在付款周期内
  const nowYM = (() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  // 电费按月应付：当月=付款周期内；历史月=已逾期可补提交；未来月（早于台账月）不可提交
  const isCurrentMonth = period.length === 6 && nowYM === period;
  const isOverdue = period.length === 6 && nowYM > period;
  const canSubmit = period.length === 6 && nowYM >= period;

  const payUnitPrice = g?.details?.[0]?.payUnitPrice;
  const amount = g?.payAmount ?? 0;
  const kwh = g?.kwh ?? 0;
  const details = g?.details ?? [];

  // 场地方档案：当前业主（收款人）与电话
  const landlordsQ = useQuery({ queryKey: ["landlords"], queryFn: listLandlords, enabled: open });
  const landlordRow = (landlordsQ.data ?? []).find((l: any) => l.id === landlordId) ?? null;

  // 申请人默认当前登录人
  useEffect(() => {
    if (open) {
      setApplicant("");
      setExtraNote("");
      try { setApplicant(JSON.parse(localStorage.getItem("dsh_user") || "{}").name || ""); } catch { /* ignore */ }
    }
  }, [open, landlordId, period]);

  const buildReason = () => {
    const lines = [
      `【电费付款审批】${landlordName} ${periodDisplay}`,
      `应付金额（电费成本）：${amount} 元`,
      "",
      "【电费依据】",
      `电表数量：${details.length} 块`,
      `用电度数：${kwh} 度`,
      `付款单价：${payUnitPrice ?? "—"} 元/度`,
      payUnitPrice ? `勾稽：${Math.round(amount * 100) / 100} = ${kwh} 度 × ${payUnitPrice} 元/度` : "",
      "",
      `【收款方】场地方当前业主：${landlordRow?.contact || "—"}${landlordRow?.phone ? `（${landlordRow.phone}）` : ""}`,
      "",
      `【经营佐证（${periodDisplay}）】`,
      `电费收款（不含税）：${g?.collectNet ?? 0} 元`,
      `电费利润：${g?.profit ?? 0} 元`,
    ];
    if (extraNote.trim()) lines.push("", `【补充说明】${extraNote.trim()}`);
    return lines.join("\n");
  };

  const mut = useMutation({
    mutationFn: () => {
      if (!g) throw new Error("无电费数据");
      // 付款周期校验：当月及历史月（逾期）可提交
      if (!canSubmit) {
        throw new Error(`当前月份（${toDisplay(nowYM)}）早于 ${periodDisplay}，该月电费尚未到期，请到付款周期内再提交`);
      }
      return submitStationApproval({
        landlordId,
        landlordName,
        period: periodDisplay,
        approvalType: "电费付款",
        electricityAmount: amount,
        totalAmount: amount,
        applicant: applicant.trim() || "经办人",
        title: `${landlordName} ${periodDisplay} 电费付款`,
        reason: buildReason(),
      });
    },
    onSuccess: () => {
      toast.success("电费付款审批已提交");
      queryClient.invalidateQueries({ queryKey: ["electricity-monthly"] });
      onClose();
      setApplicant("");
      setExtraNote("");
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "提交失败"),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-rose-600 text-white">
                <Send className="h-4 w-4" />
              </span>
              <div>
                <div>提交应付电费审批</div>
                <div className="mt-0.5 text-[11px] font-normal text-slate-400">电费付款 · 我方付给场地方</div>
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>
        {g && (
          <div className="space-y-3">
            {/* 付款周期提示 */}
            <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${canSubmit ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-amber-100 bg-amber-50 text-amber-700"}`}>
              <Send className="h-3.5 w-3.5 shrink-0" />
              {isCurrentMonth && (
                <>当前月份（{toDisplay(nowYM)}）为该月电费付款周期，可以提交审批</>
              )}
              {isOverdue && (
                <>当前月份（{toDisplay(nowYM)}）已超过 {periodDisplay} 的付款周期，可补提交</>
              )}
              {!canSubmit && (
                <>当前月份（{toDisplay(nowYM)}）早于 {periodDisplay}，该月电费尚未到期，暂不能提交</>
              )}
            </div>

            {/* 审核依据 */}
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <div className="flex items-center gap-1.5 border-b bg-rose-50/60 px-3 py-2">
                <FileText className="h-3.5 w-3.5 text-rose-600" />
                <span className="text-[11px] font-semibold text-rose-700">审核依据（将随审批单提交）</span>
              </div>
              <div className="space-y-3 p-3">
                <div className="rounded-lg bg-slate-50 px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-slate-700">{landlordName} · {toDisplay(period)}</div>
                      <div className="mt-0.5 text-[10px] text-slate-400">电费付款（我方付给场地方）</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-slate-400">应付金额</div>
                      <div className="text-base font-bold tabular-nums text-rose-600">{fmtMoney(amount)}</div>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 text-[10px] font-semibold text-slate-500">电费依据</div>
                  <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[11px]">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="shrink-0 text-slate-400">用电度数</span>
                      <span className="font-medium tabular-nums text-slate-700">{fmtNum(kwh)} 度</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="shrink-0 text-slate-400">付款单价</span>
                      <span className="font-medium tabular-nums text-slate-700">{payUnitPrice != null ? `${payUnitPrice} 元/度` : "—"}</span>
                    </div>
                    {payUnitPrice ? (
                      <div className="col-span-2 flex items-baseline justify-between gap-2">
                        <span className="shrink-0 text-slate-400">勾稽验证</span>
                        <span className="font-medium tabular-nums text-slate-700">{Math.round(amount * 100) / 100} = {fmtNum(kwh)} 度 × {payUnitPrice} 元/度</span>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* 收款方（场地方当前业主） */}
                <div className="rounded-lg border border-slate-200 px-3 py-2 text-[11px]">
                  <div className="flex items-baseline justify-between">
                    <span className="shrink-0 text-slate-400">收款方（场地方当前业主）</span>
                    <span className="font-medium text-slate-700">{landlordRow?.contact || "—"}</span>
                  </div>
                  {landlordRow?.phone && (
                    <div className="mt-0.5 flex items-baseline justify-between">
                      <span className="shrink-0 text-slate-400">联系电话</span>
                      <span className="text-slate-700">{landlordRow.phone}</span>
                    </div>
                  )}
                </div>

                {/* 电表明细（逐表核对） */}
                {details.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[10px] font-semibold text-slate-500">电表明细（{details.length} 块）</div>
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="bg-slate-50 text-slate-500">
                            <th className="px-2 py-1.5 text-left font-medium">电表</th>
                            <th className="px-2 py-1.5 text-left font-medium">品牌方</th>
                            <th className="px-2 py-1.5 text-right font-medium">用量(度)</th>
                            <th className="px-2 py-1.5 text-right font-medium">单价</th>
                            <th className="px-2 py-1.5 text-right font-medium">应付(元)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {details.map((d: any, i: number) => (
                            <tr key={i} className="border-t">
                              <td className="px-2 py-1.5">
                                <div className="font-medium text-slate-700">{d.meterName ?? "—"}</div>
                                <div className="font-mono text-[10px] text-slate-400">{d.meterNo}</div>
                              </td>
                              <td className="px-2 py-1.5 text-slate-600">{d.brandName || "全品牌共享"}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{fmtNum(d.kwh)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{d.payUnitPrice != null ? fmtNum(d.payUnitPrice) : "—"}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-700">{fmtMoney(d.payAmount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div>
                  <div className="mb-1.5 text-[10px] font-semibold text-slate-500">经营佐证（{toDisplay(period)}）</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-emerald-100 bg-emerald-50/40 px-2.5 py-2">
                      <div className="text-[9px] text-emerald-600">电费收款（不含税）</div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-emerald-700">{fmtMoney(g.collectNet ?? 0)}</div>
                    </div>
                    <div className="rounded-lg border border-blue-100 bg-blue-50/40 px-2.5 py-2">
                      <div className="text-[9px] text-blue-600">电费利润</div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-blue-700">{fmtMoney(g.profit ?? 0)}</div>
                    </div>
                  </div>
                </div>

                {extraNote.trim() && (
                  <div className="rounded-lg border border-amber-100 bg-amber-50/50 px-3 py-2 text-[11px] text-amber-700">
                    <span className="font-semibold">补充说明：</span>{extraNote.trim()}
                  </div>
                )}
              </div>
            </div>

            <Field label="申请人 *">
              <TextInput value={applicant} onChange={setApplicant} placeholder="经办人姓名" />
            </Field>
            <Field label="补充说明（可选）">
              <textarea className={`${inputCls} w-full`} rows={2} value={extraNote} onChange={(e) => setExtraNote(e.target.value)} placeholder="如：发票情况、收款方账户等…" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={mut.isPending || !canSubmit} onClick={() => mut.mutate()}>
                <Send className="mr-1.5 h-4 w-4" />{canSubmit ? "提交审批" : "未到付款周期"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
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

// ─── ★V5 场地级月度电费对账弹窗（损耗的唯一录入口）───
// 参考电量（系统算 = Σ场地所有表）→ 财务填「最终付给场地方的电量/金额」→ 损耗 = 差额（我方承担）
// 保存后后端自动重算该月台账（品牌行 + 损耗行）。
function LandlordMonthlyDialog({ open, period: initialPeriod, onClose }: { open: boolean; period: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState(initialPeriod);
  useEffect(() => { if (open) setPeriod(initialPeriod); }, [open, initialPeriod]);

  const q = useQuery({
    queryKey: ["landlord-monthly-elec", period],
    queryFn: () => getLandlordMonthlyElec(period),
    enabled: open && !!period,
  });
  // 行内编辑态：landlordId → { finalKwh, finalAmount }
  const [edits, setEdits] = useState<Record<number, { kwh: string; amount: string }>>({});
  useEffect(() => { setEdits({}); }, [period, open]);

  const save = useMutation({
    mutationFn: (r: any) => {
      const e = edits[r.landlordId] ?? {};
      const kwh = e.kwh?.trim() === "" ? null : Number(e.kwh);
      const amount = e.amount?.trim() === "" ? null : Number(e.amount);
      if (kwh == null && amount == null) throw new Error("请至少填写最终电量或最终金额");
      if (kwh != null && isNaN(kwh)) throw new Error("最终电量必须是数字");
      if (amount != null && isNaN(amount)) throw new Error("最终金额必须是数字");
      return saveLandlordMonthlyElec(r.landlordId, { period, finalKwh: kwh, finalAmount: amount });
    },
    onSuccess: () => {
      toast.success("已保存，台账已按新值重算");
      queryClient.invalidateQueries({ queryKey: ["landlord-monthly-elec"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-monthly-ledger-range"] });
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "保存失败"),
  });

  const rows = (q.data?.rows ?? []) as any[];
  // 有参考电量（= 本月有读数的场地）的排前面
  const sorted = [...rows].sort((a, b) => (b.refKwh ?? 0) - (a.refKwh ?? 0));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>场地级电费对账（{toDisplay(period)}）</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>对账月份</span>
            <input type="month" className={`${inputCls} w-36`} value={toDisplay(period)}
              onChange={(e) => e.target.value && setPeriod(toCompact(e.target.value))} />
            <span className="text-slate-400">
              参考电量 = Σ场地内所有表的实际用电量（系统算）；填「最终电量/金额」后，差额即<b className="mx-0.5 text-amber-700">损耗</b>（我方承担，不摊给品牌）
            </span>
          </div>
          {q.isLoading ? (
            <div className="py-10 text-center text-sm text-slate-400">加载中…</div>
          ) : sorted.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">该月没有电表数据</div>
          ) : (
            <div className="xl-wrap rounded-md">
              <table className="xl-table min-w-[860px]">
                <thead>
                  <tr>
                    <th className="xl-ctr" style={{ minWidth: 140 }}>场地方</th>
                    <th className="xl-num">参考电量(度)</th>
                    <th className="xl-num">场地单价</th>
                    <th className="xl-num">最终电量(度) ✏️</th>
                    <th className="xl-num">最终金额(元) ✏️</th>
                    <th className="xl-num">损耗(度)</th>
                    <th className="xl-num">损耗金额</th>
                    <th className="xl-ctr"></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const e = edits[r.landlordId] ?? { kwh: r.finalKwh != null ? String(r.finalKwh) : "", amount: r.finalAmount != null ? String(r.finalAmount) : "" };
                    const dirty = r.landlordId in edits;
                    const loss = r.lossKwh ?? 0;
                    return (
                      <tr key={r.landlordId} className={loss !== 0 ? "bg-amber-50/60" : ""}>
                        <td className="px-2 py-1 font-medium">{r.landlordName}</td>
                        <td className="xl-num text-slate-600">{r.refKwh != null ? fmtNum(r.refKwh) : "—"}</td>
                        <td className="xl-num text-slate-500">{r.unitPrice != null ? r.unitPrice : "—"}</td>
                        <td className="px-1 py-1">
                          <input type="number" step="0.01" min="0" className={`${inputCls} h-7 w-24 text-xs`}
                            placeholder={r.refKwh != null ? String(r.refKwh) : "—"}
                            title="最终付给场地方老板的电量（默认 = 参考电量）"
                            value={e.kwh}
                            onChange={(ev) => setEdits((p) => ({ ...p, [r.landlordId]: { ...e, kwh: ev.target.value } }))} />
                        </td>
                        <td className="px-1 py-1">
                          <input type="number" step="0.01" min="0" className={`${inputCls} h-7 w-24 text-xs`}
                            placeholder="账单金额"
                            title="账单只给钱不给度数时直接填金额（系统按场地单价反推电量）"
                            value={e.amount}
                            onChange={(ev) => setEdits((p) => ({ ...p, [r.landlordId]: { ...e, amount: ev.target.value } }))} />
                        </td>
                        <td className={`xl-num font-medium ${loss > 0 ? "text-amber-700" : loss < 0 ? "text-rose-600" : "text-slate-400"}`}>
                          {r.lossKwh != null ? fmtNum(r.lossKwh) : "—"}
                        </td>
                        <td className={`xl-num ${loss > 0 ? "text-amber-700" : "text-slate-400"}`}>
                          {r.lossAmount != null ? fmtMoney(r.lossAmount) : "—"}
                        </td>
                        <td className="xl-ctr">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]"
                            disabled={!dirty || save.isPending}
                            onClick={() => save.mutate(r)}>
                            {save.isPending ? "保存中…" : "保存"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-slate-400">
            · 只填电量或只填金额都可以：只填金额时系统按「场地合同单价」反推电量。<br />
            · 保存后该月台账自动重算：各品牌行的付款金额<b>不变</b>（品牌不承担损耗），差额进独立的<b className="text-amber-700">「损耗行」</b>（利润 = −损耗金额）。<br />
            · 没填的场地按「最终 = 参考」处理（损耗 0）。已保存过的行会在下次生成时保留人工值（不被同步覆盖）。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Electricity() {
  /* ══ 筛选条件（★重设计）══
     原来顶部是「按场地方 / 按品牌方 / 按公司主体」三个维度按钮 —— 其实那是**同一批台账数据的三种分组方式**，
     每次切换都要重新请求、还看不到明细。现在改为在同一张平铺台账表上用筛选条件定位：
     月份区间 / 场地方 / 品牌方 / 公司主体 / 行类型 / 付款情况 / 到账情况 / 关键词。
     （「报税主体」不再作为分组维度，改成普通的一列 + 一个筛选项。） */
  const [startPeriod, setStartPeriod] = useState(CUR_MONTH);
  const [endPeriod, setEndPeriod] = useState(CUR_MONTH);
  const [fLandlord, setFLandlord] = useState("");
  const [fBrand, setFBrand] = useState("");
  const [fEntity, setFEntity] = useState("");
  const [fRowType, setFRowType] = useState("");
  const [fPay, setFPay] = useState("");
  const [fCollect, setFCollect] = useState("");
  const [keyword, setKeyword] = useState("");
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
    queryKey: ["electricity-monthly-ledger-range", startPeriod, endPeriod],
    queryFn: async () => {
      // ★固定用「场地方」维度拉取：它一次就带回 场地方 + 主体 + 行类型 + 电表明细，
      // 足够拼出任何筛选视角（品牌/主体筛选在前端做），不用再按维度重复请求。
      const results = await Promise.all(monthRange.map((p) => getElectricityMonthlyLedger(p, "landlord")));
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

  // ── 平铺台账行：一行 = 一块电表 × 月份 ──
  //   共用表：付款只有一整笔（整表读数 × 场地单价）、收款按品牌分摊。
  //   ★场地级损耗（row_type=loss：我方承担、不归主体、不摊品牌）**不再单独成行**，
  //     而是并入「该场地当月的第一行」—— 因为那一行代表的是"这块表付给场地方的钱"，
  //     损耗正是这笔钱里品牌没承担的那一段 ⇒ 合并后 电量 / 付款 / 利润 才是"付场地方"的真实口径。
  //     损耗仅在行内用小字标注（含损耗 XX 度 / XX 元），展开行里也仍能看到明细。
  const flatRows = useMemo(() => {
    const out: any[] = [];
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const lossByGroup = new Map<string, { kwh: number; pay: number; rows: any[] }>();
    const firstIdxOfGroup = new Map<string, number>();   // `${月份}|${场地}` → 该组第一行在 out 的下标

    for (const m of months) {
      for (const g of (m.rows ?? []) as any[]) {
        const rowType = g.rowType || "normal";
        const gk = `${m.period}|${g.key}`;
        const mgs = groupDetailsByMeter(g.details ?? []);
        const base = {
          period: m.period,
          landlordKey: g.key,
          landlordName: g.name,
          entityId: g.entityId ?? null,
          entityName: g.entityName ?? "未指定主体",
          rowType,
          isLoss: rowType === "loss",
          lossKwh: 0,
          lossPay: 0,
          hasLoss: false,
          rowG: g,
        };
        if (mgs.length === 0) {
          if (rowType === "loss") {
            // 场地级损耗：暂存，稍后并入同场地同月第一行
            const cur = lossByGroup.get(gk) ?? { kwh: 0, pay: 0, rows: [] as any[] };
            cur.kwh = r2(cur.kwh + Number(g.kwh ?? 0));
            cur.pay = r2(cur.pay + Number(g.payAmount ?? 0));
            cur.rows.push(g);
            lossByGroup.set(gk, cur);
            continue;
          }
          out.push({
            ...base,
            key: `${m.period}|row|${g.key}|${g.entityId ?? "x"}|${rowType}`,
            meterNo: "",
            meterName: "（无电表明细）",
            transformerRatio: null,
            brands: [] as string[],
            brandIds: [] as number[],
            kwh: g.kwh, payUnitPrice: null, payAmount: g.payAmount, payStatus: g.payStatus,
            collectUnitPrice: null, collectAmount: g.collectAmount, collectNet: g.collectNet,
            elecTax: g.elecTax, profit: g.profit, collectStatus: null, dataSource: null,
            recordIds: [] as number[], details: [] as any[],
          });
          continue;
        }
        for (const mg of mgs) {
          const d0 = mg.rows[0] ?? {};
          const sum = (f: (d: any) => number) => r2(mg.rows.reduce((s, d) => s + f(d), 0));
          const collectAmount = sum((d) => Number(d.collectAmount ?? 0));
          const collectNet = sum((d) => Number(d.collectNet ?? 0));
          const doneCollected = mg.rows.filter((d) => d.collectStatus === "已到账").length;
          const priceRow = mg.rows.find((d) => Number(d.collectUnitPrice ?? 0) > 0);
          if (!firstIdxOfGroup.has(gk)) firstIdxOfGroup.set(gk, out.length);
          out.push({
            ...base,
            key: `${m.period}|${d0.meterNo ?? "x"}|${g.key}|${g.entityId ?? "x"}`,
            meterNo: d0.meterNo ?? "",
            meterName: d0.meterName ?? "",
            transformerRatio: d0.transformerRatio ?? null,
            brands: [...new Set(mg.rows.map((d) => d.brandName).filter(Boolean))] as string[],
            brandIds: [...new Set(mg.rows.map((d) => d.brandId).filter((x) => x != null))] as number[],
            kwh: mg.kwh, payUnitPrice: mg.payUnitPrice, payAmount: mg.payAmount, payStatus: mg.payStatus,
            collectUnitPrice: priceRow ? Number(priceRow.collectUnitPrice) : null,
            collectAmount, collectNet, elecTax: r2(collectAmount - collectNet),
            profit: r2(collectNet - Number(mg.payAmount ?? 0)),
            collectStatus: collectAmount <= 0 ? null
              : doneCollected === mg.rows.length ? "已到账"
                : doneCollected > 0 ? "部分到账" : "未到账",
            dataSource: d0.dataSource ?? null,
            recordIds: mg.recordIds,
            details: mg.rows,
          });
        }
      }
    }

    // 把场地级损耗并进「该场地当月第一行」：电量/付款加上它、利润扣掉它（只算一次）
    for (const [gk, L] of lossByGroup) {
      const idx = firstIdxOfGroup.get(gk);
      if (idx == null) {
        // 极端情况：该场地当月只有损耗、没有任何电表行 → 退化成独立一行（否则这笔成本就丢了）
        const g0 = L.rows[0];
        out.push({
          period: (gk.split("|")[0]) || g0.period,
          landlordKey: g0.key, landlordName: g0.name,
          entityId: null, entityName: "—（我方承担）",
          rowType: "loss", isLoss: true, lossKwh: L.kwh, lossPay: L.pay, hasLoss: true, rowG: g0,
          key: `${gk}|loss-only`, meterNo: "", meterName: "场地级损耗（我方承担）",
          transformerRatio: null, brands: [], brandIds: [],
          kwh: L.kwh, payUnitPrice: null, payAmount: L.pay, payStatus: g0.payStatus,
          collectUnitPrice: null, collectAmount: 0, collectNet: 0, elecTax: 0,
          profit: r2(-L.pay), collectStatus: null, dataSource: null,
          recordIds: [], details: [],
        });
        continue;
      }
      const row = out[idx];
      row.hasLoss = true;
      row.lossKwh = L.kwh;
      row.lossPay = L.pay;
      row.kwh = r2(Number(row.kwh ?? 0) + L.kwh);
      row.payAmount = r2(Number(row.payAmount ?? 0) + L.pay);
      row.profit = r2(Number(row.profit ?? 0) - L.pay);
    }
    return out;
  }, [months]);

  // ── 筛选项候选值（从已取到的数据派生，天然受账号数据范围约束）──
  const landlordOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of flatRows) seen.set(String(r.landlordKey), r.landlordName ?? "");
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [flatRows]);
  const brandOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of flatRows) for (const d of r.details) if (d.brandId != null) seen.set(String(d.brandId), d.brandName ?? "");
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [flatRows]);
  const entityOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of flatRows) seen.set(String(r.entityId ?? "none"), r.entityName ?? "未指定主体");
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [flatRows]);

  // ── 筛选 ──
  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return flatRows.filter((r) => {
      if (fLandlord && String(r.landlordKey) !== fLandlord) return false;
      if (fBrand && !r.brandIds.includes(Number(fBrand))) return false;
      if (fEntity && String(r.entityId ?? "none") !== fEntity) return false;
      // 「含场地损耗」筛的是并入了损耗的那一行（损耗已不再单独成行）
      if (fRowType === "loss") { if (!r.hasLoss) return false; }
      else if (fRowType && r.rowType !== fRowType) return false;
      if (fPay === "unpaid" && !(Number(r.payAmount ?? 0) > 0 && r.payStatus !== "已付款")) return false;
      if (fPay === "paid" && r.payStatus !== "已付款") return false;
      if (fCollect === "uncollected" && !(Number(r.collectAmount ?? 0) > 0 && r.collectStatus !== "已到账")) return false;
      if (fCollect === "collected" && r.collectStatus !== "已到账") return false;
      if (kw && !`${r.meterNo} ${r.meterName} ${r.landlordName} ${r.entityName}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [flatRows, fLandlord, fBrand, fEntity, fRowType, fPay, fCollect, keyword]);

  /* ══ 两级聚合（★多月份改造）══
     L1 月级行：一行 = 场地 × 主体 × 类型 × 月份（把「电表×月」级行合并；损耗已并入其中的品牌行）
     L0 场地块：一行 = 场地 × 主体 × 类型，数值 = 所选区间合计，展开后是各月（L1）
     筛选在「电表×月」级先做（rows），所以聚合后天然只含命中筛选的月份。 */
  const periodRows = useMemo(() => {
    const map = new Map<string, any>();
    const r2 = (x: number) => Math.round(x * 100) / 100;
    for (const r of rows) {
      const k = `${r.landlordKey}|${r.entityId ?? "x"}|${r.rowType}|${r.period}`;
      let g = map.get(k);
      if (!g) {
        g = {
          key: `L1|${k}`,
          period: r.period,
          landlordKey: r.landlordKey, landlordName: r.landlordName,
          entityId: r.entityId ?? null, entityName: r.entityName,
          rowType: r.rowType, isLoss: !!r.isLoss, rowG: r.rowG,
          kwh: 0, payAmount: 0, collectAmount: 0, collectNet: 0, elecTax: 0, profit: 0,
          lossKwh: 0, lossPay: 0, hasLoss: false,
          details: [] as any[],
          _payPrices: new Set<number>(), _collectPrices: new Set<number>(), _ratios: new Set<number>(),
          _payStatus: new Set<string>(), _collectStatus: new Set<string>(),
          _sources: new Set<string>(),
          brands: new Set<string>(), brandIds: new Set<number>(),
          recordIds: new Set<number>(), meterNos: new Set<string>(),
          _meterNames: [] as string[],
        };
        map.set(k, g);
      }
      g.kwh = r2(g.kwh + Number(r.kwh ?? 0));
      g.payAmount = r2(g.payAmount + Number(r.payAmount ?? 0));
      g.collectAmount = r2(g.collectAmount + Number(r.collectAmount ?? 0));
      g.collectNet = r2(g.collectNet + Number(r.collectNet ?? 0));
      g.elecTax = r2(g.elecTax + Number(r.elecTax ?? 0));
      g.profit = r2(g.profit + Number(r.profit ?? 0));
      if (Number(r.payUnitPrice ?? 0) > 0) g._payPrices.add(Number(r.payUnitPrice));
      if (Number(r.collectUnitPrice ?? 0) > 0) g._collectPrices.add(Number(r.collectUnitPrice));
      if (r.transformerRatio != null) g._ratios.add(Number(r.transformerRatio));
      g._payStatus.add(r.payStatus ?? "");
      g._collectStatus.add(r.collectStatus ?? "");
      if (r.dataSource) g._sources.add(r.dataSource);
      for (const b of r.brands ?? []) g.brands.add(b);
      for (const b of r.brandIds ?? []) g.brandIds.add(b);
      for (const id of r.recordIds ?? []) g.recordIds.add(id);
      for (const d of r.details ?? []) g.details.push(d);
      if (r.meterNo) g.meterNos.add(r.meterNo);
      if (r.meterName) g._meterNames.push(r.meterName);
      if (r.hasLoss) {
        g.hasLoss = true;
        g.lossKwh = r2(g.lossKwh + Number(r.lossKwh ?? 0));
        g.lossPay = r2(g.lossPay + Number(r.lossPay ?? 0));
      }
    }
    return [...map.values()].map((g) => ({
      ...g,
      brands: [...g.brands] as string[],
      brandIds: [...g.brandIds] as number[],
      recordIds: [...g.recordIds] as number[],
      meterCount: g.meterNos.size,
      meterNo: g.meterNos.size === 1 ? [...g.meterNos][0] : "",
      meterName: g._meterNames.length === 1 ? g._meterNames[0] : `${g.meterNos.size} 块电表`,
      payUnitPrice: g._payPrices.size === 1 ? [...g._payPrices][0] : null,
      collectUnitPrice: g._collectPrices.size === 1 ? [...g._collectPrices][0] : null,
      transformerRatio: g._ratios.size === 1 ? [...g._ratios][0] : null,
      payStatus: g._payStatus.size === 1 ? [...g._payStatus][0] : "部分已付款",
      collectStatus: g._collectStatus.size === 1 ? [...g._collectStatus][0] : "部分到账",
      dataSource: g._sources.size === 1 ? [...g._sources][0] : (g._sources.size > 1 ? "mixed" : null),
    }));
  }, [rows]);

  const landlordRows = useMemo(() => {
    const map = new Map<string, any>();
    const r2 = (x: number) => Math.round(x * 100) / 100;
    for (const p of periodRows) {
      const k = `L0|${p.landlordKey}|${p.entityId ?? "x"}|${p.rowType}`;
      let g = map.get(k);
      if (!g) {
        g = {
          key: k,
          landlordKey: p.landlordKey, landlordName: p.landlordName,
          entityId: p.entityId, entityName: p.entityName,
          rowType: p.rowType, isLoss: p.isLoss,
          kwh: 0, payAmount: 0, collectAmount: 0, collectNet: 0, elecTax: 0, profit: 0,
          lossKwh: 0, lossPay: 0, hasLoss: false,
          months: [] as any[],
          brands: new Set<string>(), meterNos: new Set<string>(),
          paid: 0, paidTotal: 0, collected: 0, collectedTotal: 0,
          _sources: new Set<string>(),
        };
        map.set(k, g);
      }
      g.kwh = r2(g.kwh + Number(p.kwh ?? 0));
      g.payAmount = r2(g.payAmount + Number(p.payAmount ?? 0));
      g.collectAmount = r2(g.collectAmount + Number(p.collectAmount ?? 0));
      g.collectNet = r2(g.collectNet + Number(p.collectNet ?? 0));
      g.elecTax = r2(g.elecTax + Number(p.elecTax ?? 0));
      g.profit = r2(g.profit + Number(p.profit ?? 0));
      if (p.hasLoss) {
        g.hasLoss = true;
        g.lossKwh = r2(g.lossKwh + Number(p.lossKwh ?? 0));
        g.lossPay = r2(g.lossPay + Number(p.lossPay ?? 0));
      }
      for (const b of p.brands ?? []) g.brands.add(b);
      for (const n of p.meterNos ?? []) g.meterNos.add(n);
      for (const s of p._sources ?? []) if (s) g._sources.add(s);
      if (Number(p.payAmount ?? 0) > 0) { g.paidTotal += 1; if (p.payStatus === "已付款") g.paid += 1; }
      if (Number(p.collectAmount ?? 0) > 0) { g.collectedTotal += 1; if (p.collectStatus === "已到账") g.collected += 1; }
      g.months.push(p);
    }
    return [...map.values()].map((g) => ({
      ...g,
      brands: [...g.brands] as string[],
      meterCount: g.meterNos.size,
      dataSource: g._sources.size === 1 ? [...g._sources][0] : (g._sources.size > 1 ? "mixed" : null),
      // 近月在上（与 Meters 展开行一致）
      months: (g.months as any[]).sort((a, b) => String(b.period).localeCompare(String(a.period))),
    }));
  }, [periodRows]);

  // 区间内付款/到账状态汇总（多月不一致时给「已付 1/2」并标黄提醒）
  const paySummary = (g: any) => {
    if (g.paidTotal === 0) return g.paid > 0 ? "已付款" : "—";
    if (g.paid === 0) return "未付款";
    if (g.paid === g.paidTotal) return g.paidTotal > 1 ? `${g.paidTotal} 个月均已付` : "已付款";
    return `已付 ${g.paid}/${g.paidTotal}`;
  };
  const collectSummary = (g: any) => {
    if (g.collectedTotal === 0) return g.collected > 0 ? "已到账" : "—";
    if (g.collected === 0) return "未到账";
    if (g.collected === g.collectedTotal) return g.collectedTotal > 1 ? `${g.collectedTotal} 个月均已到账` : "已到账";
    return `已到账 ${g.collected}/${g.collectedTotal}`;
  };

  // 区间只有一个月：场地块默认展开，省掉一次点击（多选月份时默认收起）
  const singleMonth = monthRange.length === 1;
  useEffect(() => {
    if (!singleMonth) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const g of landlordRows) next.add(g.key);
      return next;
    });
  }, [singleMonth, landlordRows]);

  // 合计：跟随筛选结果（与表尾合计一致）
  const totals = useMemo(() => {
    const t = { kwh: 0, payAmount: 0, collectAmount: 0, collectNet: 0, elecTax: 0, profit: 0 };
    for (const r of rows) {
      t.kwh += Number(r.kwh ?? 0);
      t.payAmount += Number(r.payAmount ?? 0);
      t.collectAmount += Number(r.collectAmount ?? 0);
      t.collectNet += Number(r.collectNet ?? 0);
      t.elecTax += Number(r.elecTax ?? 0);
      t.profit += Number(r.profit ?? 0);
    }
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] = Math.round(t[k] * 100) / 100;
    return t;
  }, [rows]);

  const quick = (n: number) => {
    setEndPeriod(CUR_MONTH);
    setStartPeriod(shift(CUR_MONTH, -(n - 1)));
  };

  const [exporting, setExporting] = useState(false);
  // 应付电费审批弹窗（电费付款：我方付给场地方）
  const [payElec, setPayElec] = useState<{ landlordId: number; landlordName: string; period: string; g: any } | null>(null);
  // 抄表核对详情弹窗
  const [readingTarget, setReadingTarget] = useState<{ meterNo: string; period: string } | null>(null);
  // ★V5 场地级月度电费对账弹窗
  const [lmeOpen, setLmeOpen] = useState(false);
  // 付款/收款状态行内编辑（可反复修改）
  // key = 正在编辑的单元格；recordIds = 一起改的台账行（共享电表给场地方是一整笔付款，多品牌行同改）
  const [statusEdit, setStatusEdit] = useState<{ key: string; recordIds: number[]; field: "pay" | "collect" } | null>(null);
  const queryClient = useQueryClient();
  const updateStatusMut = useMutation({
    mutationFn: (p: { recordIds: number[]; payStatus?: string; collectStatus?: string }) => {
      const ids = (p.recordIds ?? []).filter((x) => x != null);
      if (ids.length === 0) throw new Error("台账记录ID缺失，请刷新页面后重试");
      return Promise.all(ids.map((id) => updateElectricityStatus(id, { payStatus: p.payStatus, collectStatus: p.collectStatus })));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["electricity-monthly-ledger-range"] });
      setStatusEdit(null);
      toast.success("状态已更新");
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "更新失败"),
  });

  const doExport = async () => {
    if (monthRange.length === 0) { toast.error("请选择有效的月份区间"); return; }
    setExporting(true);
    try {
      const wb = XLSX.utils.book_new();
      let sheetCount = 0;
      for (const p of monthRange) {
        const data = await exportElectricityLedger(p, "landlord");
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
      {/* ── 顶部：月份区间 + ★筛选条件（不再切换维度） ── */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">电费台账</h2>
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <input type="month" className={`${inputCls} w-36`} value={toDisplay(startPeriod)}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              setStartPeriod(toCompact(v));
              if (toCompact(v) > endPeriod) setEndPeriod(toCompact(v));
            }} title="起始月" />
          <span>~</span>
          <input type="month" className={`${inputCls} w-36`} value={toDisplay(endPeriod)}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              setEndPeriod(toCompact(v));
              if (toCompact(v) < startPeriod) setStartPeriod(toCompact(v));
            }} title="结束月" />
        </div>
        <div className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0.5">
          {([["本月", 1], ["近3月", 3], ["近6月", 6], ["近12月", 12]] as const).map(([label, n]) => (
            <button key={label} type="button" onClick={() => quick(n)}
              className="rounded px-1.5 py-1 text-[11px] text-slate-600 transition-colors hover:bg-slate-100 hover:text-blue-600">
              {label}
            </button>
          ))}
        </div>
        <input className={`${inputCls} w-44`} placeholder="搜索电表编号 / 名称 / 场地…"
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <div className="w-36">
          <SearchSelect value={fLandlord} onChange={setFLandlord} placeholder="全部场地方"
            options={landlordOptions} />
        </div>
        <div className="w-36">
          <SearchSelect value={fBrand} onChange={setFBrand} placeholder="全部品牌方"
            options={brandOptions} />
        </div>
        <div className="w-36">
          <SearchSelect value={fEntity} onChange={setFEntity} placeholder="全部主体"
            options={entityOptions} />
        </div>
        <select className={`${inputCls} w-28`} value={fRowType} onChange={(e) => setFRowType(e.target.value)}
          title="行类型：品牌行 / 民用电表（只付场地、无收款）/ 场地级损耗（我方承担）">
          <option value="">全部类型</option>
          <option value="normal">品牌行</option>
          <option value="civil">民用电表</option>
          <option value="loss">含场地损耗</option>
        </select>
        <select className={`${inputCls} w-28`} value={fPay} onChange={(e) => setFPay(e.target.value)}>
          <option value="">付款：全部</option>
          <option value="unpaid">仅未付款</option>
          <option value="paid">仅已付款</option>
        </select>
        <select className={`${inputCls} w-28`} value={fCollect} onChange={(e) => setFCollect(e.target.value)}>
          <option value="">到账：全部</option>
          <option value="uncollected">仅未到账</option>
          <option value="collected">仅已到账</option>
        </select>
        <button type="button"
          onClick={() => { setFLandlord(""); setFBrand(""); setFEntity(""); setFRowType(""); setFPay(""); setFCollect(""); setKeyword(""); }}
          className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:text-slate-600">清空筛选</button>
        <span className="text-xs text-slate-400">
          {toDisplay(startPeriod)} ~ {toDisplay(endPeriod)} · {landlordRows.length} 个场地块（{rows.length} / {flatRows.length} 行明细）
        </span>
        {/* ★V5：场地级对账（录「最终付给场地方的电量/金额」→ 损耗） */}
        <Button size="sm" variant="outline" className="border-amber-300 text-amber-700 hover:bg-amber-50"
          onClick={() => setLmeOpen(true)}>
          <Zap className="mr-1 h-3.5 w-3.5" />场地级对账（损耗）
        </Button>
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

      {/* ── 台账平铺明细（★重设计：一行 = 一块电表 × 月份；筛选条件定位，不再按主体分层展开） ── */}
      <div className="xl-wrap xl-wrap-scroll rounded-xl shadow-sm">
        <table className="xl-table" style={{ minWidth: 1650 }}>
          <thead>
            <tr>
              <th className="xl-freeze xl-ctr" style={{ left: 0, width: 30 }}></th>
              <th className="xl-freeze" style={{ left: 30, width: 78 }}>月份</th>
              <th className="xl-freeze" style={{ left: 108, width: 104 }}>场地方</th>
              <th style={{ width: 96 }}>主体</th>
              <th style={{ width: 150 }}>电表</th>
              <th style={{ width: 104 }}>品牌方</th>
              <th className="xl-ctr" style={{ width: 58 }} title="品牌行 / 民用电表（无收款对象）；带「含损耗」= 该行已并入场地级损耗（我方承担）">类型</th>
              <th className="xl-num" style={{ width: 52 }}>倍数</th>
              <th className="xl-num" style={{ width: 86 }} title="付给场地方的电量（含场地级损耗那一段）">电量(度)</th>
              <th className="xl-num" style={{ width: 74 }}>付款单价</th>
              <th className="xl-num" style={{ width: 92 }} title="付给场地方的钱（含场地级损耗；损耗由我方承担、不摊品牌、不归主体）">付款金额</th>
              <th className="xl-ctr" style={{ width: 84 }}>付款情况</th>
              <th className="xl-num" style={{ width: 74 }}>收款单价</th>
              <th className="xl-num" style={{ width: 92 }}>收款(含税)</th>
              <th className="xl-num" style={{ width: 88 }}>不含税</th>
              <th className="xl-num" style={{ width: 74 }}>税费</th>
              <th className="xl-num" style={{ width: 86 }}>利润</th>
              <th className="xl-ctr" style={{ width: 84 }}>到账情况</th>
              <th className="xl-ctr" style={{ width: 60 }}>来源</th>
              <th className="xl-ctr xl-freeze-r" style={{ width: 78 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={20} className="xl-ctr xl-muted" style={{ padding: "28px 8px" }}>
                  {q.isLoading ? "加载中…" : "所选筛选条件下没有电费台账数据"}
                </td>
              </tr>
            )}
            {landlordRows.map((L0) => {
              const open0 = expanded.has(L0.key);
              const payMixed = L0.paidTotal > 1 && L0.paid > 0 && L0.paid < L0.paidTotal;
              const colMixed = L0.collectedTotal > 1 && L0.collected > 0 && L0.collected < L0.collectedTotal;
              return (
                <Fragment key={L0.key}>
                  {/* ── L0：场地 × 主体 × 类型（数值 = 所选区间合计；展开看逐月）── */}
                  <tr className={`${open0 ? "xl-open" : ""} font-medium`}>
                    <td className="xl-freeze xl-ctr" style={{ left: 0 }}>
                      <button className="text-slate-500 hover:text-slate-700" onClick={() => toggle(L0.key)} title="展开该场地在该区间内的各月份">
                        {open0 ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                    <td className="xl-freeze text-slate-700" style={{ left: 30 }}>
                      {L0.months.length === 1 ? toDisplay(L0.months[0].period) : `${L0.months.length} 个月`}
                    </td>
                    <td className="xl-freeze truncate" style={{ left: 108 }} title={L0.landlordName}>{L0.landlordName ?? "未指定场地"}</td>
                    <td className="truncate text-slate-600" title={L0.entityName}>{L0.entityName}</td>
                    <td className="truncate text-slate-500">
                      {L0.meterCount > 0 ? `${L0.meterCount} 块电表` : <span className="xl-muted">—</span>}
                    </td>
                    <td className="truncate text-slate-500" title={L0.brands.join("、")}>
                      {L0.brands.length === 0
                        ? <span className="xl-muted">—</span>
                        : L0.brands.length === 1
                          ? L0.brands[0]
                          : <span className="font-medium text-purple-600">{L0.brands.length} 个品牌</span>}
                    </td>
                    <td className="xl-ctr">
                      {L0.isLoss ? (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">损耗</span>
                      ) : L0.rowType === "civil" ? (
                        <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                          title="民用电表：无品牌归属、无收款对象，只有付给场地方的成本">民用</span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">品牌行</span>
                      )}
                      {L0.hasLoss && !L0.isLoss && (
                        <span className="ml-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                          title={`区间内已并入场地级损耗 ${fmtNum(L0.lossKwh)} 度 / ${fmtMoney(L0.lossPay)}（我方承担：不归主体、不摊品牌）`}>
                          含损耗
                        </span>
                      )}
                    </td>
                    <td className="xl-num"><span className="xl-muted">—</span></td>
                    <td className="xl-num text-slate-700">
                      {fmtNum(L0.kwh)}
                      {L0.hasLoss && !L0.isLoss && (
                        <div className="text-[9px] font-normal text-amber-600" title="付给场地方的电量 = 各品牌分摊电量 + 场地级损耗">含损耗 {fmtNum(L0.lossKwh)}</div>
                      )}
                    </td>
                    <td className="xl-num"><span className="xl-muted">—</span></td>
                    <td className="xl-num xl-neg">
                      {fmtMoney(L0.payAmount)}
                      {L0.hasLoss && !L0.isLoss && (
                        <div className="text-[9px] font-normal text-amber-600" title="场地级损耗（我方承担）：最终付场地方电量 − 已入台账的各品牌电量">含损耗 {fmtMoney(L0.lossPay)}</div>
                      )}
                    </td>
                    <td className="xl-ctr">
                      <span title="付款状态按月记账（主表只汇总，点开逐月查看/修改）"
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          L0.paidTotal > 0 && L0.paid === L0.paidTotal ? "bg-emerald-100 text-emerald-700"
                            : payMixed ? "bg-amber-100 text-amber-700"
                            : "border border-slate-200 bg-white text-slate-500"}`}>
                        {paySummary(L0)}
                      </span>
                    </td>
                    <td className="xl-num"><span className="xl-muted">—</span></td>
                    <td className="xl-num">{fmtMoney(L0.collectAmount)}</td>
                    <td className="xl-num text-emerald-600">{fmtMoney(L0.collectNet)}</td>
                    <td className="xl-num text-slate-500">{fmtMoney(L0.elecTax)}</td>
                    <td className="xl-num text-slate-700">{fmtMoney(L0.profit)}</td>
                    <td className="xl-ctr">
                      <span title="到账状态按月记账（主表只汇总，点开逐月查看/修改）"
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          L0.collectedTotal > 0 && L0.collected === L0.collectedTotal ? "bg-emerald-100 text-emerald-700"
                            : colMixed ? "bg-amber-100 text-amber-700"
                            : "border border-slate-200 bg-white text-slate-500"}`}>
                        {collectSummary(L0)}
                      </span>
                    </td>
                    <td className="xl-ctr text-[10px] text-slate-400" title={L0.dataSource === "manual" ? "人工修正" : L0.dataSource === "synced" ? "第三方同步" : L0.dataSource === "mixed" ? "部分月人工、部分月第三方" : ""}>
                      {L0.dataSource === "manual" ? "人工" : L0.dataSource === "synced" ? "第三方" : L0.dataSource === "mixed" ? "混合" : "—"}
                    </td>
                    <td className="xl-ctr xl-freeze-r">
                      <button className="text-[10px] text-slate-400 hover:text-slate-600" onClick={() => toggle(L0.key)}>
                        {open0 ? "收起" : `展开 ${L0.months.length} 个月`}
                      </button>
                    </td>
                  </tr>
                  {open0 && L0.months.map((r: any) => {
                    const open = expanded.has(r.key);
                    // 可展开：多品牌明细，或该月并入了场地级损耗（展开里能看到损耗那一笔）
                    const canExpand = (r.details?.length ?? 0) > 1 || r.hasLoss;
                    const showApproval = Number(r.payAmount ?? 0) > 0 && r.payStatus !== "已付款";
                    const payKey = `pay-${r.key}`;
                    const collectKey = `collect-${r.key}`;
                    return (
                      <Fragment key={r.key}>
                        <tr className={`xl-l1 ${open ? "xl-open" : ""} ${r.isLoss ? "bg-amber-50/60" : ""}`}>
                    <td className="xl-freeze xl-ctr" style={{ left: 0 }}>
                      <div className="pl-3">
                        {canExpand ? (
                          <button className="text-slate-400 hover:text-slate-600" onClick={() => toggle(r.key)} title="展开该月各品牌的品牌分摊明细">
                            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        ) : (
                          <span className="text-slate-200">·</span>
                        )}
                      </div>
                    </td>
                    <td className="xl-freeze text-slate-600" style={{ left: 30 }}>{toDisplay(r.period)}</td>
                    <td className="xl-freeze text-slate-300" style={{ left: 108 }} title={r.landlordName}>〃</td>
                    <td className="text-slate-300" title={r.entityName}>〃</td>
                    <td className="truncate" title={r.meterNo ? `${r.meterName ?? ""} ${r.meterNo}` : r.meterName}>
                      {r.meterCount > 1 ? (
                        <span className="text-slate-500">{r.meterCount} 块电表</span>
                      ) : r.meterNo ? (
                        <>
                          <span className="text-slate-700">{r.meterName || "—"}</span>
                          <div className="font-mono text-[10px] text-slate-400">{r.meterNo}</div>
                        </>
                      ) : (
                        <span className={r.isLoss ? "font-medium text-amber-700" : "text-slate-400"}>{r.meterName}</span>
                      )}
                    </td>
                    <td className="truncate" title={r.brands.join("、")}>
                      {r.brands.length === 0
                        ? <span className="xl-muted">—</span>
                        : r.brands.length === 1
                          ? r.brands[0]
                          : <span className="font-medium text-purple-600">{r.brands.length} 个品牌</span>}
                    </td>
                    <td className="xl-ctr">
                      {r.isLoss ? (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                          title="该场地当月只有损耗、没有电表行（退化显示）">
                          损耗
                        </span>
                      ) : r.rowType === "civil" ? (
                        <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                          title="民用电表：无品牌归属、无收款对象，只有付给场地方的成本">民用</span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">品牌行</span>
                      )}
                      {r.hasLoss && !r.isLoss && (
                        <span className="ml-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                          title={`本行已并入场地级损耗 ${fmtNum(r.lossKwh)} 度 / ${fmtMoney(r.lossPay)}（我方承担：不归主体、不摊品牌）`}>
                          含损耗
                        </span>
                      )}
                    </td>
                    <td className="xl-num">{r.transformerRatio != null ? fmtNum(r.transformerRatio) : <span className="xl-muted">—</span>}</td>
                    <td className="xl-num text-slate-600">
                      {r.kwh != null ? fmtNum(r.kwh) : <span className="xl-muted">—</span>}
                      {r.hasLoss && !r.isLoss && (
                        <div className="text-[9px] font-normal text-amber-600" title="付给场地方的电量 = 各品牌分摊电量 + 场地级损耗">含损耗 {fmtNum(r.lossKwh)}</div>
                      )}
                    </td>
                    <td className="xl-num">{Number(r.payUnitPrice ?? 0) > 0 ? fmtNum(r.payUnitPrice) : <span className="xl-muted">—</span>}</td>
                    <td className="xl-num xl-neg" title={Number(r.payUnitPrice ?? 0) > 0 ? undefined : "场地合同未填电费单价（付款金额按 0 计）"}>
                      {fmtMoney(r.payAmount)}
                      {r.hasLoss && !r.isLoss && (
                        <div className="text-[9px] font-normal text-amber-600" title="场地级损耗（我方承担）：最终付场地方电量 − 已入台账的各品牌电量">含损耗 {fmtMoney(r.lossPay)}</div>
                      )}
                    </td>
                    <td className="xl-ctr">
                      {statusEdit?.key === payKey && statusEdit.field === "pay" ? (
                        <div className="flex flex-wrap items-center justify-center gap-1">
                          <button type="button" className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-200"
                            onClick={() => updateStatusMut.mutate({ recordIds: r.recordIds, payStatus: "已付款" })}>已付款</button>
                          <button type="button" className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
                            onClick={() => updateStatusMut.mutate({ recordIds: r.recordIds, payStatus: "未付款" })}>未付款</button>
                          <button type="button" className="rounded px-1 text-[10px] text-slate-400 hover:text-slate-600"
                            onClick={() => setStatusEdit(null)}>取消</button>
                        </div>
                      ) : (
                        <button type="button"
                          title={r.recordIds.length > 0 ? "点击修改付款状态（共用表：整表一笔，全部品牌一起改）" : "台账记录ID缺失，请刷新页面后重试"}
                          disabled={r.recordIds.length === 0}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${r.payStatus === "已付款" ? "bg-emerald-100 text-emerald-700" : "border border-slate-200 bg-white text-slate-500"} hover:border-sky-300 disabled:cursor-not-allowed disabled:opacity-60`}
                          onClick={() => { if (r.recordIds.length > 0) setStatusEdit({ key: payKey, recordIds: r.recordIds, field: "pay" }); }}>
                          {r.payStatus}
                        </button>
                      )}
                    </td>
                    <td className="xl-num">{r.collectUnitPrice != null ? fmtNum(r.collectUnitPrice) : <span className="xl-muted">—</span>}</td>
                    <td className="xl-num">{fmtMoney(r.collectAmount)}</td>
                    <td className="xl-num text-emerald-600">{fmtMoney(r.collectNet)}</td>
                    <td className="xl-num text-slate-500">{fmtMoney(r.elecTax)}</td>
                    <td className="xl-num font-medium text-slate-700">{fmtMoney(r.profit)}</td>
                    <td className="xl-ctr">
                      {statusEdit?.key === collectKey && statusEdit.field === "collect" ? (
                        <div className="flex items-center justify-center gap-1">
                          <button type="button" className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-200"
                            onClick={() => updateStatusMut.mutate({ recordIds: r.recordIds, collectStatus: "已到账" })}>已到账</button>
                          <button type="button" className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
                            onClick={() => updateStatusMut.mutate({ recordIds: r.recordIds, collectStatus: "未到账" })}>未到账</button>
                          <button type="button" className="rounded px-1 text-[10px] text-slate-400 hover:text-slate-600"
                            onClick={() => setStatusEdit(null)}>取消</button>
                        </div>
                      ) : (
                        <button type="button"
                          title={r.recordIds.length > 0 ? "点击修改收款到账状态" : "台账记录ID缺失，请刷新页面后重试"}
                          disabled={r.recordIds.length === 0}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${r.collectStatus === "已到账" ? "bg-emerald-100 text-emerald-700" : r.collectStatus === "部分到账" ? "bg-amber-100 text-amber-700" : "border border-slate-200 bg-white text-slate-500"} hover:border-sky-300 disabled:cursor-not-allowed disabled:opacity-60`}
                          onClick={() => { if (r.recordIds.length > 0) setStatusEdit({ key: collectKey, recordIds: r.recordIds, field: "collect" }); }}>
                          {r.collectStatus ?? "—"}
                        </button>
                      )}
                    </td>
                    <td className="xl-ctr text-[10px] text-slate-400" title={r.dataSource === "manual" ? "人工修正" : r.dataSource === "synced" ? "第三方同步" : r.dataSource === "mixed" ? "部分月人工、部分月第三方" : ""}>
                      {r.dataSource === "manual" ? "人工" : r.dataSource === "synced" ? "第三方" : r.dataSource === "mixed" ? "混合" : "—"}
                    </td>
                    <td className="xl-ctr xl-freeze-r">
                      <div className="flex items-center justify-center gap-1">
                        {r.meterNo && (
                          <button className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-50"
                            title="抄表核对：上月/本月读数、日期、区间度数（可复制文本发给对方核对）"
                            onClick={() => setReadingTarget({ meterNo: r.meterNo, period: r.period })}>
                            核对
                          </button>
                        )}
                        {showApproval && (
                          <button className="rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 hover:bg-rose-100"
                            title="按「场地 + 主体 + 月份」提交应付电费审批"
                            onClick={() => setPayElec({ landlordId: Number(r.landlordKey), landlordName: r.landlordName, period: r.period, g: r.rowG })}>
                            提交审批
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {open && canExpand && (
                    <tr className="xl-detail">
                      <td colSpan={20} className="p-0">
                        <div className="xl-dtitle">
                          {toDisplay(r.period)} · {r.landlordName} · {r.meterCount > 1 ? `${r.meterCount} 块电表` : (r.meterName || r.meterNo)} · 品牌分摊明细
                          <span className="sub">
                            共用表：付给场地方只有一整笔（{fmtMoney(r.payAmount)}），各品牌只出自己的收款
                          </span>
                        </div>
                        <div className="xl-dwrap">
                          <table>
                            <thead>
                              <tr>
                                <th style={{ width: 150 }}>品牌方</th>
                                <th style={{ width: 96 }}>度数(kWh)</th>
                                <th style={{ width: 92 }}>付款单价</th>
                                <th style={{ width: 110 }}>付款金额</th>
                                <th style={{ width: 88 }}>收款单价</th>
                                <th style={{ width: 110 }}>收款(含税)</th>
                                <th style={{ width: 106 }}>不含税</th>
                                <th style={{ width: 92 }}>利润</th>
                                <th style={{ width: 88 }}>到账</th>
                                <th style={{ width: 64 }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {/* ★每个品牌各自承担自己的付款成本（付款金额 = 本品牌用电量 × 场地单价），
                                  不再只把整表一笔画在第一行上 —— 否则看起来像"成本全归了第一个品牌"。 */}
                              {r.details.map((d: any, i: number) => (
                                <tr key={`${r.key}-${i}`}>
                                  <td className={!d.brandName ? "font-medium text-purple-600" : ""}>{d.brandName ?? "全品牌共享（未分摊）"}</td>
                                  <td className="num">{fmtNum(d.kwh)}</td>
                                  <td className="num">{Number(d.payUnitPrice ?? 0) > 0 ? fmtNum(d.payUnitPrice) : "—"}</td>
                                  <td className="num">{fmtMoney(d.payAmount)}</td>
                                  <td className="num">{d.collectUnitPrice != null ? fmtNum(d.collectUnitPrice) : "—"}</td>
                                  <td className="num">{fmtMoney(d.collectAmount)}</td>
                                  <td className="num">{fmtMoney(d.collectNet)}</td>
                                  <td className="num">{fmtMoney(Number(d.collectNet ?? 0) - Number(d.payAmount ?? 0))}</td>
                                  <td className="ctr">{d.collectStatus ?? "—"}</td>
                                  <td className="ctr">
                                    {d.meterNo && (
                                      <button className="text-[10px] text-blue-600 hover:underline"
                                        onClick={() => setReadingTarget({ meterNo: d.meterNo, period: r.period })}>核对</button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                              {r.hasLoss && !r.isLoss && (
                                <tr className="bg-amber-50/70">
                                  <td className="font-medium text-amber-700"
                                    title="场地级损耗 = 最终付场地方电量 − 已入台账的各品牌电量。由我方承担：不摊给品牌、不归报税主体（已并入本行付款金额，不单独占一行）">
                                    场地级损耗（我方承担）
                                  </td>
                                  <td className="num">{fmtNum(r.lossKwh)}</td>
                                  <td className="num">{Number(r.payUnitPrice ?? 0) > 0 ? fmtNum(r.payUnitPrice) : ""}</td>
                                  <td className="num">{fmtMoney(r.lossPay)}</td>
                                  <td className="num">—</td>
                                  <td className="num">—</td>
                                  <td className="num">—</td>
                                  <td className="num">{fmtMoney(-Number(r.lossPay ?? 0))}</td>
                                  <td className="ctr">—</td>
                                  <td className="ctr"></td>
                                </tr>
                              )}
                              {/* 合计 = 各品牌明细 + 场地级损耗，应与主表该行的 电量/付款/收款/利润 完全一致 */}
                              <tr className="xl-dtotal">
                                <td>合计（{r.brands.length || 1} 个品牌{r.hasLoss && !r.isLoss ? " + 损耗" : ""}）</td>
                                <td className="num">{fmtNum(r.kwh)}</td>
                                <td className="num"></td>
                                <td className="num">{fmtMoney(r.payAmount)}</td>
                                <td className="num"></td>
                                <td className="num">{fmtMoney(r.collectAmount)}</td>
                                <td className="num">{fmtMoney(r.collectNet)}</td>
                                <td className="num">{fmtMoney(r.profit)}</td>
                                <td className="ctr"></td>
                                <td className="ctr"></td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td className="xl-freeze xl-ctr" style={{ left: 0 }}></td>
                <td className="xl-freeze" style={{ left: 30 }} colSpan={2}>
                  合计 · {landlordRows.length} 个场地块 / {periodRows.length} 个场地·月 / {new Set(rows.map((r) => r.meterNo).filter(Boolean)).size} 块表
                  {rows.some((r) => r.hasLoss) && (
                    <span className="ml-1 font-normal text-amber-600" title="电量 / 付款金额 已包含场地级损耗（我方承担，不摊品牌）">
                      （电量/付款含场地损耗）
                    </span>
                  )}
                </td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td className="xl-num">{fmtNum(totals.kwh)}</td>
                <td></td>
                <td className="xl-num xl-neg">{fmtMoney(totals.payAmount)}</td>
                <td></td>
                <td></td>
                <td className="xl-num">{fmtMoney(totals.collectAmount)}</td>
                <td className="xl-num text-emerald-600">{fmtMoney(totals.collectNet)}</td>
                <td className="xl-num text-slate-500">{fmtMoney(totals.elecTax)}</td>
                <td className="xl-num font-medium">{fmtMoney(totals.profit)}</td>
                <td></td>
                <td></td>
                <td className="xl-freeze-r"></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        口径：电费付款=实际度数×场地合同单价；电费收款=实际度数×品牌方合同单价（按电表品牌匹配）；
        税费=含税收款−不含税收款；利润=不含税收款−付款。<br />
        <b>场地级损耗（我方承担）</b>：= 最终付场地方电量 − 已入台账的各品牌电量（在「场地级对账（损耗）」里录最终电量/金额）。
        它<b>不单独占一行</b>，而是并入该场地当月那一行的<b>电量 / 付款金额</b>里（行内以橙色小字标注「含损耗」，
        展开行里能看到这一笔），所以不摊给品牌、也不归任何报税主体。台账由「电表归属/合同/读数」变更自动生成。<br />
        <b>多月份视图</b>：主表一行 = <b>一个场地 × 主体 × 类型</b>（数值为所选区间合计），点开逐月一行（L1），
        再点开看该月的品牌分摊明细（L2）；区间只选一个月时默认自动展开。付款/到账状态按月记账，主表只汇总（「已付 1/2」即区间内有月份未付）。
      </p>

      {/* 应付电费审批弹窗 */}
      <PayElectricityDialog
        open={payElec !== null}
        onClose={() => setPayElec(null)}
        landlordId={payElec?.landlordId ?? 0}
        landlordName={payElec?.landlordName ?? ""}
        period={payElec?.period ?? ""}
        g={payElec?.g ?? null}
      />
      <ReadingDetailDialog target={readingTarget} onClose={() => setReadingTarget(null)} />
      {/* ★V5 场地级月度电费对账（录最终电量/金额 → 损耗） */}
      <LandlordMonthlyDialog open={lmeOpen} period={endPeriod} onClose={() => setLmeOpen(false)} />
    </div>
  );
}
