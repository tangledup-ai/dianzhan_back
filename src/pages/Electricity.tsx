import { Fragment, useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getElectricityMonthlyLedger, exportElectricityLedger, getReadingDetail, updateElectricityStatus, type ElecLedgerDim } from "@/api/electricity";
import { listLandlords } from "@/api/directory";
import { submitStationApproval } from "@/api/approvals";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, TextInput, inputCls } from "@/components/fields";
import { fmtMoney, fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { Building2, Tag, ChevronDown, ChevronRight, Download, Send, FileText, Landmark } from "lucide-react";
import { groupByEntity, GROUP_COLOR_NEUTRAL } from "@/lib/groupColors";
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

  const copyText = async () => {
    const usage = Number(lg?.ledgerKwh ?? (Number(rd.kwh ?? 0) * ratio));
    const lines = [
      `【电费抄表核对】${mtr.landlordName ?? ""}（${mtr.brandName || "全品牌共享"}）`,
      `电表：${mtr.meterNo ?? target?.meterNo}${mtr.meterName ? `（${mtr.meterName}）` : ""}`,
      `上月抄表：${rd.prevReadingDate ?? "—"}　表盘读数 ${rd.prevReading ?? "—"}`,
      `本月抄表：${rd.currReadingDate ?? "—"}　表盘读数 ${rd.currReading ?? "—"}`,
      `区间度数：${rd.kwh ?? "—"} × 倍数 ${ratio} = 计费用量 ${usage.toFixed(2)} 度`,
      ...(ledgerRows.length > 1
        ? [
            "【品牌分摊明细】",
            ...ledgerRows.map((r: any) =>
              `${r.brandName || "全品牌共享"}：用量 ${fmtNum(Number(r.ledgerKwh ?? 0))} 度，` +
              `应付（付场地方）${fmtMoney(Number(r.payAmount ?? 0))} 元，` +
              `应收（品牌方支付）${fmtMoney(Number(r.collectAmount ?? 0))} 元（不含税 ${fmtMoney(Number(r.collectNet ?? 0))}）`
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
              <div>
                <div className="mb-1 text-[10px] font-semibold text-purple-600">
                  品牌分摊明细（{ledgerRows.length} 个品牌 · 应付电费按品牌录入，用量 = 金额 ÷ 单价 倒推）
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="bg-slate-50 text-left text-slate-500">
                        <th className="px-2 py-1.5 font-medium">品牌方</th>
                        <th className="px-2 py-1.5 text-right font-medium">用量(度)</th>
                        <th className="px-2 py-1.5 text-right font-medium">付款单价</th>
                        <th className="px-2 py-1.5 text-right font-medium">应付(元)</th>
                        <th className="px-2 py-1.5 text-right font-medium">收款单价</th>
                        <th className="px-2 py-1.5 text-right font-medium">应收(元)</th>
                        <th className="px-2 py-1.5 text-right font-medium">不含税</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledgerRows.map((r: any, i: number) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1.5 font-medium text-slate-700">{r.brandName || "全品牌共享"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(Number(r.ledgerKwh ?? 0))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(Number(r.payUnitPrice ?? 0))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(Number(r.payAmount ?? 0))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(Number(r.collectUnitPrice ?? 0))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(Number(r.collectAmount ?? 0))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(Number(r.collectNet ?? 0))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                      应付 {fmtMoney(Number(a.collectAmount ?? 0))} 元
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

export default function Electricity() {
  const [startPeriod, setStartPeriod] = useState(CUR_MONTH);
  const [endPeriod, setEndPeriod] = useState(CUR_MONTH);
  const [dim, setDim] = useState<ElecLedgerDim>("landlord");
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
  // 应付电费审批弹窗（电费付款：我方付给场地方）
  const [payElec, setPayElec] = useState<{ landlordId: number; landlordName: string; period: string; g: any } | null>(null);
  // 抄表核对详情弹窗
  const [readingTarget, setReadingTarget] = useState<{ meterNo: string; period: string } | null>(null);
  // 付款/收款状态行内编辑（可反复修改）
  const [statusEdit, setStatusEdit] = useState<{ recordId: number; field: "pay" | "collect" } | null>(null);
  const queryClient = useQueryClient();
  const updateStatusMut = useMutation({
    mutationFn: (p: { recordId: number; payStatus?: string; collectStatus?: string }) => {
      if (!p.recordId) throw new Error("台账记录ID缺失，请刷新页面后重试");
      return updateElectricityStatus(p.recordId, p);
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
          <Button size="sm" variant={dim === "entity" ? "default" : "ghost"}
            className={dim === "entity" ? "bg-indigo-600 hover:bg-indigo-700" : ""}
            onClick={() => setDim("entity")}>
            <Landmark className="mr-1 h-3.5 w-3.5" />按公司主体
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
                            {toDisplay(m.period)} · 按{dim === "landlord" ? "场地方" : dim === "entity" ? "公司主体" : "品牌方"}明细（点击展开电表）
                          </div>
                          {(dim === "brand"
                            ? [{ entityName: "", color: GROUP_COLOR_NEUTRAL, rows: m.rows ?? [] }]
                            : groupByEntity(m.rows ?? [])
                          ).map((grp, gi) => {
                            const grpKey = `grp-${m.period}-${dim}-${gi}`;
                            return (
                            <div key={grpKey} className={dim !== "brand" ? `space-y-1.5 rounded-lg border p-2 ${grp.color.border} ${grp.color.bg}` : "space-y-1"}>
                            {dim !== "brand" && (
                              <div className="flex items-center gap-2 px-1">
                                <div className={`flex h-5 w-5 items-center justify-center rounded ${grp.color.icon}`}>
                                  <Landmark className="h-3 w-3 text-white" />
                                </div>
                                <span className={`text-[11px] font-semibold ${grp.color.text}`}>{grp.entityName}</span>
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${grp.color.chip}`}>{grp.rows.length} {dim === "landlord" ? "个场地方" : "条台账"}</span>
                              </div>
                            )}
                            {grp.rows.map((g: any) => {
                            // 同场地跨主体会拆成多行，行键需带主体区分
                            const rKey = `r-${m.period}-${dim}-${g.key}-${g.entityId ?? "x"}`;
                            const rOpen = expanded.has(rKey);
                            const hasTransformerRatio = (g.details ?? []).some((d: any) => d.transformerRatio && d.transformerRatio !== 1);
                            const hasBrandDimension = (g.details ?? []).some((d: any) => d.brandName);
                            return (
                              <Fragment key={rKey}>
                                <div
                                  className="grid cursor-pointer items-center gap-x-3 rounded-md border bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                                  style={{ gridTemplateColumns: "minmax(0, 1fr) 100px 120px 120px 90px 110px auto" }}
                                  onClick={() => toggle(rKey)}
                                >
                                  <span className="flex min-w-0 items-center gap-1">
                                    <span className="shrink-0 text-slate-400">{rOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
                                    <span className="truncate font-medium text-slate-700" title={g.name}>{g.name}</span>
                                  </span>
                                  <span className="text-right text-slate-500 tabular-nums">{fmtNum(g.kwh)} 度</span>
                                  <span className="text-right tabular-nums text-rose-600">付 {fmtMoney(g.payAmount)}</span>
                                  <span className="text-right tabular-nums text-emerald-600">收 {fmtMoney(g.collectNet)}</span>
                                  <span className="text-right tabular-nums text-slate-400">税 {fmtMoney(g.elecTax)}</span>
                                  <span className="text-right tabular-nums font-medium text-slate-700">利 {fmtMoney(g.profit)}</span>
                                  {dim === "landlord" && g.payStatus === "未付款" && g.payAmount > 0 && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setPayElec({ landlordId: Number(g.key), landlordName: g.name, period: m.period, g }); }}
                                      className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] font-medium text-rose-600 hover:border-rose-300 hover:bg-rose-100"
                                    >
                                      <Send className="mr-1 inline h-3 w-3" />提交应付电费审批
                                    </button>
                                  )}
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
                                              {dim === "entity" && d.landlordName && (
                                                <div className="text-[10px] text-slate-400">场地：{d.landlordName}</div>
                                              )}
                                              {d.dataSource === "manual" && (
                                                <span className="mt-0.5 inline-block rounded bg-amber-100 px-1 text-[10px] text-amber-700">已人工修改</span>
                                              )}
                                              <button type="button" className="mt-0.5 block text-[11px] text-rose-600 hover:text-rose-700"
                                                onClick={(e) => { e.stopPropagation(); setReadingTarget({ meterNo: d.meterNo, period: m.period }); }}>
                                                详细
                                              </button>
                                            </td>
                                            {hasBrandDimension && (
                                              <td className={`px-2 py-1.5 tabular-nums ${!d.brandName ? "font-medium text-purple-600" : ""}`}>
                                                {d.brandName ?? "全品牌共享"}
                                              </td>
                                            )}
                                            {hasTransformerRatio && <td className="px-2 py-1.5 tabular-nums">{fmtNum(d.transformerRatio)}</td>}
                                            <td className="px-2 py-1.5 tabular-nums">{fmtNum(d.kwh ?? d.payKwh)}</td>
                                            <td className="border-x px-2 py-1.5 text-right tabular-nums">{d.payUnitPrice != null ? fmtNum(d.payUnitPrice) : "—"}</td>
                                            <td className="px-2 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(d.payAmount)}</td>
                                            <td className="px-2 py-1.5 text-center">
                                              {statusEdit && d.recordId != null && statusEdit.recordId === d.recordId && statusEdit.field === "pay" ? (
                                                <div className="flex items-center justify-center gap-1">
                                                  <button type="button" className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-200"
                                                    onClick={(e) => { e.stopPropagation(); updateStatusMut.mutate({ recordId: d.recordId, payStatus: "已付款" }); }}>已付款</button>
                                                  <button type="button" className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
                                                    onClick={(e) => { e.stopPropagation(); updateStatusMut.mutate({ recordId: d.recordId, payStatus: "未付款" }); }}>未付款</button>
                                                  <button type="button" className="rounded px-1 text-[10px] text-slate-400 hover:text-slate-600"
                                                    onClick={(e) => { e.stopPropagation(); setStatusEdit(null); }}>取消</button>
                                                </div>
                                              ) : (
                                                <button type="button" title={d.recordId != null ? "点击修改付款状态" : "台账记录ID缺失，请刷新页面后重试"}
                                                  disabled={d.recordId == null}
                                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${d.payStatus === "已付款" ? "bg-emerald-100 text-emerald-700" : "border border-slate-200 bg-white text-slate-500"} hover:border-sky-300 disabled:cursor-not-allowed disabled:opacity-60`}
                                                  onClick={(e) => { e.stopPropagation(); if (d.recordId != null) setStatusEdit({ recordId: d.recordId, field: "pay" }); }}>
                                                  {d.payStatus ?? "—"}
                                                </button>
                                              )}
                                            </td>
                                            <td className="border-x px-2 py-1.5 text-right tabular-nums">{d.collectUnitPrice != null ? fmtNum(d.collectUnitPrice) : "—"}</td>
                                            <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(d.collectAmount)}</td>
                                            <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(d.collectNet)}</td>
                                            <td className="px-2 py-1.5 text-center">
                                              {statusEdit && d.recordId != null && statusEdit.recordId === d.recordId && statusEdit.field === "collect" ? (
                                                <div className="flex items-center justify-center gap-1">
                                                  <button type="button" className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-200"
                                                    onClick={(e) => { e.stopPropagation(); updateStatusMut.mutate({ recordId: d.recordId, collectStatus: "已到账" }); }}>已到账</button>
                                                  <button type="button" className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
                                                    onClick={(e) => { e.stopPropagation(); updateStatusMut.mutate({ recordId: d.recordId, collectStatus: "未到账" }); }}>未到账</button>
                                                  <button type="button" className="rounded px-1 text-[10px] text-slate-400 hover:text-slate-600"
                                                    onClick={(e) => { e.stopPropagation(); setStatusEdit(null); }}>取消</button>
                                                </div>
                                              ) : (
                                                <button type="button" title={d.recordId != null ? "点击修改收款状态" : "台账记录ID缺失，请刷新页面后重试"}
                                                  disabled={d.recordId == null}
                                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${d.collectStatus === "已到账" ? "bg-emerald-100 text-emerald-700" : "border border-slate-200 bg-white text-slate-500"} hover:border-sky-300 disabled:cursor-not-allowed disabled:opacity-60`}
                                                  onClick={(e) => { e.stopPropagation(); if (d.recordId != null) setStatusEdit({ recordId: d.recordId, field: "collect" }); }}>
                                                  {d.collectStatus ?? "—"}
                                                </button>
                                              )}
                                            </td>
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
    </div>
  );
}
