import { Fragment, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getMonthlyLedger, getYearlyPaymentSchedule } from "@/api/rent";
import { updateSchedule } from "@/api/contracts";
import { submitStationApproval } from "@/api/approvals";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, TextInput, SearchSelect, inputCls } from "@/components/fields";
import { fmtMoney, fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { exportXlsxWithTitle } from "@/lib/export";
import { Building2, ChevronDown, ChevronRight, Download, CalendarCheck, Clock, CheckCircle2, AlertCircle, Send, FileText, Landmark } from "lucide-react";
import { toast } from "sonner";
import "@/components/excel-table.css";   // ★ Excel 风表格样式（仅本页/电费台账/智慧电表使用）

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

// ─── 收/付款周期 → 动态标题前缀：不同合同应付周期不同（季付 → 「本季度场地费应付」）───
const CYCLE_PREFIX: Record<string, string> = {
  "月付": "本月", "季付": "本季度", "半年付": "本半年度", "年付": "本年度", "年收": "本年度",
};

function cyclePrefix(method?: string | null): string | null {
  return CYCLE_PREFIX[String(method ?? "").trim()] ?? null;
}

// 从一个月的合同行中提取统一的收/付款周期前缀；周期混合时返回 null（回退通用标题）
function monthCyclePrefixes(rows: any[]): { income: string | null; pay: string | null } {
  const income = new Set<string>();
  const pay = new Set<string>();
  for (const g of rows ?? []) {
    for (const c of g.contracts ?? []) {
      const p = cyclePrefix(c.payMethod);
      // 只统计该月有分期覆盖的合同（有应付/应收金额才有「周期」语义）
      const hasSched = (Number(c.paidAmount) || 0) + (Number(c.unpaidAmount) || 0) > 0;
      if (!p || !hasSched) continue;
      (c.contractType === "场地合同" ? pay : income).add(p);
    }
  }
  return {
    income: income.size === 1 ? (Array.from(income)[0] ?? null) : null,
    pay: pay.size === 1 ? (Array.from(pay)[0] ?? null) : null,
  };
}

// 单个场地方/品牌方行的周期标签：该行各自的场地合同（付）/品牌合同（收）周期统一时显示
function rowCyclePrefixes(contracts: any[]): { income: string | null; pay: string | null } {
  const income = new Set<string>();
  const pay = new Set<string>();
  for (const c of contracts ?? []) {
    const p = cyclePrefix(c.payMethod);
    const hasSched = (Number(c.paidAmount) || 0) + (Number(c.unpaidAmount) || 0) > 0;
    if (!p || !hasSched) continue;
    (c.contractType === "场地合同" ? pay : income).add(p);
  }
  return {
    income: income.size === 1 ? (Array.from(income)[0] ?? null) : null,
    pay: pay.size === 1 ? (Array.from(pay)[0] ?? null) : null,
  };
}

// ─── 整年场地收支表（框外展示）：按 公司主体 → 场地×品牌 分组，付款信息=场地合同，收款信息=品牌方合同 ───
function YearlyTable({ yearlyRows, yearLabels }: { yearlyRows: any[]; yearLabels: string[] }) {
  // 按公司主体分组（与年度付款计划一致；entityName 由后端按 合同主体→电表主体 归属链给出）
  const entityGroups = useMemo(() => groupByEntity(yearlyRows), [yearlyRows]);
  return (
    <div className="space-y-4">
      {entityGroups.map((g) => {
        const c = g.color;
        return (
          <div key={g.entityName} className={`space-y-3 rounded-xl border p-3 ${c.border} ${c.bg}`}>
            <div className="flex items-center gap-2 px-1">
              <div className={`flex h-6 w-6 items-center justify-center rounded-md ${c.icon}`}>
                <Landmark className="h-3.5 w-3.5 text-white" />
              </div>
              <span className={`text-xs font-semibold ${c.text}`}>{g.entityName}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${c.chip}`}>{g.rows.length} 个场地方</span>
            </div>
            {g.rows.map((gy: any) => {
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
                    <th className="border-x bg-rose-50/70 px-2 py-1.5 text-center" colSpan={7 + yearLabels.length}>付款信息（场地合同）</th>
                    <th className="border-x bg-emerald-50/70 px-2 py-1.5 text-center" colSpan={9 + yearLabels.length}>收款信息（品牌方合同）</th>
                  </tr>
                  <tr className="border-b bg-slate-100 text-[10px] text-slate-500">
                    <th className="border-x px-2 py-1">负责人</th>
                    <th className="px-2 py-1">租期</th>
                    <th className="px-2 py-1">合作年限</th>
                    <th className="px-2 py-1">租金成本/年</th>
                    <th className="px-2 py-1">付款方式</th>
                    {yearLabels.map((yl) => (
                      <th key={yl} className="px-2 py-1">{yl}年付款情况</th>
                    ))}
                    <th className="px-2 py-1">单台成本/年</th>
                    <th className="px-2 py-1">押金</th>
                    <th className="border-x px-2 py-1">合同日期</th>
                    {yearLabels.map((yl) => (
                      <th key={`i-${yl}`} className="px-2 py-1">{yl}年到账情况</th>
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
                    const cabinets = Number(c.liveCabinetsCount ?? c.cabinetsCount ?? 0);
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
                          {/* 付款信息（场地合同）：租金成本/年 = 场地合同年租金（固定金额，Excel 导入值） */}
                          {(venue.annualRent ?? venue.rentAmount) != null ? fmtMoney(venue.annualRent ?? venue.rentAmount) : "—"}
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
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-700">{(c.liveCabinetsCount ?? c.cabinetsCount) != null ? `${fmtNum(c.liveCabinetsCount ?? c.cabinetsCount)} 柜` : "—"}</td>
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
      })}
    </div>
  );
}

// ─── 付款审批提交弹窗 ───
function PayApprovalDialog({
  open, onClose, landlordId, landlordName, schedule, year, venueContract, paidCount, totalCount, paidAmount,
}: {
  open: boolean; onClose: () => void;
  landlordId: number; landlordName: string;
  schedule: { id: number; seq: number; periodStart: string; periodEnd?: string; amount: number; monthIncome?: number; monthElecIncome?: number } | null;
  year: string;
  venueContract?: any; paidCount?: number; totalCount?: number; paidAmount?: number;
}) {
  const [applicant, setApplicant] = useState("");
  const [extraNote, setExtraNote] = useState("");
  const queryClient = useQueryClient();

  // 当前系统月份（YYYYMM）
  const nowYM = (() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  // 该期的付款周期（月范围）：periodStart ~ periodEnd 覆盖的月份
  const cycleStartYM = schedule?.periodStart?.slice(0, 7).replace("-", "") ?? "";
  const cycleEndYM = schedule?.periodEnd?.slice(0, 7).replace("-", "") ?? "";
  // 周期状态：current=应付周期内 / overdue=已逾期（可补提交）/ future=未到期（不可提交）
  const cycleState = !cycleStartYM || !cycleEndYM
    ? "current"
    : nowYM < cycleStartYM ? "future"
    : nowYM <= cycleEndYM ? "current"
    : "overdue";
  const canSubmit = cycleState !== "future";

  // 公共计算
  const vc = venueContract || {};
  const seq = schedule?.seq ?? 0;
  const amount = schedule?.amount ?? 0;
  const monthly = vc.monthlyRent ?? 0;
  const annual = vc.annualRent ?? 0;
  const payMethod = vc.payMethod || "—";
  const monthsPerTerm = payMethod === "月付" ? 1 : payMethod === "季付" ? 3 : payMethod === "半年付" ? 6 : payMethod === "年付" ? 12 : null;
  const termsPerYear = monthly && monthsPerTerm ? Math.round((annual || 0) / (monthly * monthsPerTerm)) || 0 : 0;
  const period = schedule?.periodStart?.slice(0, 7) || `${year}-01`;
  const remain = Math.round(((annual || 0) - (paidAmount ?? 0)) * 100) / 100;
  const payCount = paidCount ?? 0;
  const totalCountN = totalCount ?? 0;

  // 生成随审批单提交的文本依据
  const buildReason = (): string => {
    const lines = [
      `【场地费付款审批】${landlordName} 第${seq}期`,
      `期次：${schedule?.periodStart?.slice(0, 10) || "—"} ~ ${schedule?.periodEnd?.slice(0, 10) || "—"}`,
      `应付金额：${amount} 元`,
      "",
      "【合同依据】",
      `合同租期：${vc.startDate || "—"} ~ ${vc.endDate || "—"}`,
      `付款方式：${payMethod}${monthsPerTerm ? `（每年 ${termsPerYear || "—"} 期，每期 ${monthsPerTerm} 个月）` : ""}`,
      `月租金：${monthly} 元/月`,
      `年租金：${annual} 元/年`,
      monthsPerTerm ? `勾稽：${amount} 元 = ${monthly} 元/月 × ${monthsPerTerm} 个月（本期 ${monthsPerTerm} 个月）` : "",
      "",
      `【付款进度】已付 ${payCount}/${totalCountN} 期，已付金额 ${paidAmount ?? 0} 元，剩余待付 ${remain} 元`,
      "",
      `【经营佐证（${period}）】`,
      `场地租金收入（品牌方合同）：${schedule?.monthIncome ?? 0} 元/月`,
      `电费收入（台账不含税）：${schedule?.monthElecIncome ?? 0} 元`,
    ];
    if (extraNote.trim()) {
      lines.push("", `【补充说明】${extraNote.trim()}`);
    }
    return lines.join("\n");
  };

  const mut = useMutation({
    mutationFn: () => {
      if (!schedule) throw new Error("无分期信息");
      // 付款周期校验：未到期的期次不可提交（应付周期内 + 已逾期的可提交）
      if (!canSubmit) {
        throw new Error(`当前月份（${toDisplay(nowYM)}）未到该期的付款月份（应付 ${schedule.periodStart?.slice(0, 10) || "—"} 开始），请到付款周期内再提交`);
      }
      return submitStationApproval({
        landlordId,
        landlordName,
        period,
        approvalType: "场地费付款",
        rentAmount: schedule.amount,
        totalAmount: schedule.amount,
        applicant: applicant.trim() || "经办人",
        title: `${landlordName} ${period} 场地费付款（第${schedule.seq}期）`,
        reason: buildReason(),
      });
    },
    onSuccess: () => {
      toast.success("付款审批已提交");
      queryClient.invalidateQueries({ queryKey: ["yearly-payment-schedule"] });
      onClose();
      setApplicant("");
      setExtraNote("");
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "提交失败"),
  });

  const EvRow = ({ k, v, span }: { k: string; v: string; span?: boolean }) => (
    <div className={`flex items-baseline justify-between gap-2 ${span ? "col-span-2" : ""}`}>
      <span className="shrink-0 text-slate-400">{k}</span>
      <span className="text-right font-medium tabular-nums text-slate-700">{v}</span>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 text-white">
                <Send className="h-4 w-4" />
              </span>
              <div>
                <div>提交付款审批</div>
                <div className="mt-0.5 text-[11px] font-normal text-slate-400">场地费付款 · 提交后按审批流程流转</div>
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>
        {schedule && (
          <div className="space-y-3">
            {/* 付款周期提示 */}
            <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${cycleState === "future" ? "border-amber-100 bg-amber-50 text-amber-700" : "border-emerald-100 bg-emerald-50 text-emerald-700"}`}>
              <Clock className="h-3.5 w-3.5 shrink-0" />
              {cycleState === "current" && (
                <>当前月份（{toDisplay(nowYM)}）在该期付款周期内，可以提交审批</>
              )}
              {cycleState === "overdue" && (
                <>当前月份（{toDisplay(nowYM)}）已超过该期付款周期（应付 {schedule.periodStart?.slice(0, 10) || "—"} ~ {schedule.periodEnd?.slice(0, 10) || "—"}），可补提交</>
              )}
              {cycleState === "future" && (
                <>当前月份（{toDisplay(nowYM)}）未到该期付款周期（应付 {schedule.periodStart?.slice(0, 10) || "—"} 开始），暂不能提交</>
              )}
            </div>

            {/* 审核依据（结构化排版） */}
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <div className="flex items-center gap-1.5 border-b bg-indigo-50/60 px-3 py-2">
                <FileText className="h-3.5 w-3.5 text-indigo-600" />
                <span className="text-[11px] font-semibold text-indigo-700">审核依据（将随审批单提交）</span>
              </div>
              <div className="space-y-3 p-3">
                {/* 本期信息 */}
                <div className="rounded-lg bg-slate-50 px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-slate-700">{landlordName} · 第{seq}期</div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        {schedule.periodStart?.slice(0, 10) || "—"} ~ {schedule.periodEnd?.slice(0, 10) || "—"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-slate-400">应付金额</div>
                      <div className="text-base font-bold tabular-nums text-indigo-600">{fmtMoney(amount)}</div>
                    </div>
                  </div>
                </div>

                {/* 合同依据 */}
                <div>
                  <div className="mb-1.5 text-[10px] font-semibold text-slate-500">合同依据</div>
                  <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[11px]">
                    <EvRow k="合同租期" v={`${vc.startDate || "—"} ~ ${vc.endDate || "—"}`} span />
                    <EvRow k="付款方式" v={monthsPerTerm ? `${payMethod} · 每年 ${termsPerYear || "—"} 期` : payMethod} />
                    <EvRow k="月租金" v={`${monthly} 元/月`} />
                    <EvRow k="年租金" v={`${annual} 元/年`} />
                    {monthsPerTerm && <EvRow k="勾稽验证" v={`${amount} = ${monthly} × ${monthsPerTerm} 个月`} span />}
                  </div>
                </div>

                {/* 付款进度 */}
                <div className="rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2 text-[11px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-slate-500">付款进度：已付 <b className="tabular-nums text-slate-700">{payCount}/{totalCountN}</b> 期 · 已付 {fmtMoney(paidAmount ?? 0)}</span>
                    <span className="text-slate-500">剩余待付 <b className="tabular-nums text-amber-600">{fmtMoney(remain)}</b></span>
                  </div>
                </div>

                {/* 经营佐证 */}
                <div>
                  <div className="mb-1.5 text-[10px] font-semibold text-slate-500">经营佐证（{period}）</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-emerald-100 bg-emerald-50/40 px-2.5 py-2">
                      <div className="text-[9px] text-emerald-600">场地租金收入 / 月</div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-emerald-700">{fmtMoney(schedule.monthIncome ?? 0)}</div>
                    </div>
                    <div className="rounded-lg border border-blue-100 bg-blue-50/40 px-2.5 py-2">
                      <div className="text-[9px] text-blue-600">电费收入（不含税）</div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-blue-700">{fmtMoney(schedule.monthElecIncome ?? 0)}</div>
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
              <textarea className={`${inputCls} w-full`} rows={2} value={extraNote} onChange={(e) => setExtraNote(e.target.value)} placeholder="如：发票已开、押金抵扣等补充情况…" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button
                className="bg-emerald-600 hover:bg-emerald-700"
                disabled={mut.isPending || !canSubmit}
                onClick={() => mut.mutate()}
              >
                <Send className="mr-1.5 h-4 w-4" />{canSubmit ? "提交审批" : "未到付款周期"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── 年度付款计划模块 ───
function RentPaymentSchedule({ landlordId, landlordName, year, color }: { landlordId: number; landlordName: string; year: string; color: GroupColor }) {
  /* ★重设计：付款计划要「一目了然」，所以 ——
     ① 去掉「收款 / 付款」页签：两侧并排、同时可见，不用来回点
     ② 去掉大号进度卡：换成一行文字 + 一条细进度线 + 「下期应付/下次应收」一眼看到下一次的钱和时间
     ③ 逐期做成紧凑表（26px 行高、可滚动、表头吸顶），逾期未付/未收直接标红
     ④ 操作（提交审批 / 标记付款·到账 / 修改）留在每一期的行尾，不跳页 */
  const [payDialog, setPayDialog] = useState<{ id: number; seq: number; periodStart: string; periodEnd?: string; amount: number; monthIncome?: number; monthElecIncome?: number } | null>(null);
  const queryClient = useQueryClient();
  // 标记付款/到账：直接更新分期状态与实际日期（与合同管理页「标记付款」同一接口）
  const [markingId, setMarkingId] = useState<number | null>(null);
  const [markDate, setMarkDate] = useState("");
  const markDone = useMutation({
    mutationFn: ({ id, status, payDate, side: markSide }: { id: number; status: string; payDate: string; side: "payment" | "income" }) =>
      updateSchedule(id, { status, payDate, side: markSide }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["yearly-payment-schedule"] });
      queryClient.invalidateQueries({ queryKey: ["paymentSchedules"] });
      queryClient.invalidateQueries({ queryKey: ["incomeSchedules"] });
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      toast.success("状态已更新");
      setMarkingId(null);
      setMarkDate("");
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message || "操作失败"),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["yearly-payment-schedule", landlordId, year],
    queryFn: () => getYearlyPaymentSchedule(landlordId, year),
    enabled: !!landlordId && !!year,
  });

  // → 收款侧数据（场地费收款：品牌方合同 rent_income_schedule，品牌方 → 公司）
  // 以下 hooks 必须位于组件的提前 return 之前（Rules of Hooks）
  const incomeContracts = data?.incomeContracts ?? [];
  const incomeTotal = data?.incomeTotalAmount ?? 0;
  const incomePaid = data?.incomePaidAmount ?? 0;
  const incomePaidCount = data?.incomePaidCount ?? 0;
  const incomeTotalCount = data?.incomeTotalCount ?? 0;
  const incomeProgress = incomeTotal > 0 ? Math.min(100, Math.round((incomePaid / incomeTotal) * 100)) : 0;
  const incomeRows = incomeContracts
    .flatMap((ic: any) => (ic.schedules ?? []).map((s: any) => ({ ...s, brandName: ic.brandName })))
    .sort((a: any, b: any) => String(a.periodStart ?? "").localeCompare(String(b.periodStart ?? "")) || String(a.brandName).localeCompare(String(b.brandName)));

  // 收款侧按品牌分组（品牌方一行汇总：应收/已到账/待收/下次应收；点「期次」看逐期）
  const [incomeBrandOpen, setIncomeBrandOpen] = useState<string | null>(null);
  const incomeBrands = useMemo(() => {
    const map = new Map<string, { brandName: string; rows: any[]; totalAmount: number; paidAmount: number; paidCount: number; totalCount: number; nextDue: any | null }>();
    for (const s of incomeRows) {
      const key = s.brandName || "全品牌共享";
      if (!map.has(key)) map.set(key, { brandName: key, rows: [], totalAmount: 0, paidAmount: 0, paidCount: 0, totalCount: 0, nextDue: null });
      const g = map.get(key)!;
      g.rows.push(s);
      g.totalAmount += Number(s.amount || 0);
      if (s.status === "已到账") { g.paidAmount += Number(s.amount || 0); g.paidCount += 1; }
      g.totalCount += 1;
    }
    for (const g of map.values()) {
      const unpaid = g.rows
        .filter((s: any) => s.status !== "已到账")
        .sort((a: any, b: any) => String(a.periodStart ?? "").localeCompare(String(b.periodStart ?? "")));
      g.nextDue = unpaid[0] ?? null;
    }
    return [...map.values()];
  }, [incomeRows]);

  if (isLoading) {
    return <div className="rounded border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] text-slate-400">加载付款计划中…</div>;
  }
  if (!data || !data.venueContract) {
    return <div className="rounded border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] text-slate-400">该场地在 {year} 年没有有效场地合同，无法生成付款计划</div>;
  }

  const vc = data.venueContract;
  const schedules = data.schedules ?? [];
  const totalAmount = data.totalAmount || 0;
  const paidAmount = data.paidAmount || 0;
  const paidCount = data.paidCount || 0;
  const totalCount = data.totalCount || 0;
  const progress = totalAmount > 0 ? Math.min(100, Math.round((paidAmount / totalAmount) * 100)) : 0;
  const firstAmount = schedules[0]?.amount ?? 0;
  const today = new Date().toISOString().slice(0, 10);
  const remainPay = Math.round((totalAmount - paidAmount) * 100) / 100;
  const remainIncome = Math.round((incomeTotal - incomePaid) * 100) / 100;
  // 下一次要付的钱（未付款且期间最早的）
  const nextPay = schedules
    .filter((s: any) => s.status !== "已付款")
    .sort((a: any, b: any) => String(a.periodStart ?? "").localeCompare(String(b.periodStart ?? "")))[0] ?? null;
  const isOverdue = (s: any) => s.status !== "已付款" && !!s.periodEnd && String(s.periodEnd).slice(0, 10) < today;
  const isOverdueIncome = (s: any) => s.status !== "已到账" && !!s.periodEnd && String(s.periodEnd).slice(0, 10) < today;

  const startMark = (id: number, date?: string) => { setMarkingId(id); setMarkDate((date || new Date().toISOString().slice(0, 10)).slice(0, 10)); };
  const cancelMark = () => { setMarkingId(null); setMarkDate(""); };
  const markBtns = (s: any, opts: { side: "payment" | "income"; paidStatus: string; undoStatus: string; label: string }) => (
    <div className="flex items-center justify-center gap-1">
      <input type="date" className="h-6 w-[104px] rounded border border-slate-200 px-1 text-[11px]"
        value={markDate} onChange={(e) => setMarkDate(e.target.value)} />
      <button type="button" className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-emerald-700"
        disabled={markDone.isPending}
        onClick={() => {
          if (!markDate) { toast.error(`请选择${opts.label}日期`); return; }
          markDone.mutate({ id: s.id, status: opts.paidStatus, payDate: markDate, side: opts.side });
        }}>保存</button>
      {opts.undoStatus !== "" && (
        <button type="button" className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600 hover:bg-amber-100"
          disabled={markDone.isPending}
          onClick={() => markDone.mutate({ id: s.id, status: opts.undoStatus, payDate: markDate, side: opts.side })}>撤销</button>
      )}
      <button type="button" className="px-1 text-[10px] text-slate-400 hover:text-slate-600" onClick={cancelMark}>取消</button>
    </div>
  );

  return (
    <div className="space-y-2">
      {/* ── 场地合同信息条：一行看完合同底线（期间 / 付款方式 / 年成本 / 期数） ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-[11px] text-slate-600">
        <span className="inline-flex items-center gap-1">
          <CalendarCheck className="h-3.5 w-3.5 text-indigo-500" />
          场地合同 <b className="font-medium text-slate-700">{String(vc.startDate || "—").slice(0, 10)} ~ {String(vc.endDate || "—").slice(0, 10)}</b>
        </span>
        <span>付款方式 <b className="font-medium text-slate-700">{vc.payMethod || "—"}</b></span>
        <span>年租金成本 <b className="font-semibold text-slate-800">{fmtMoney(totalAmount)}</b></span>
        <span>共 <b className="font-medium text-slate-700">{totalCount}</b> 期{schedules.length > 0 && <> · 每期约 <b className="font-medium text-slate-700">{fmtMoney(firstAmount)}</b></>}</span>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* ══ 付款侧（我们 → 场地方）══ */}
        <div className="xl-sec">
          <div className="xl-sec-head is-pay">
            <span>付款情况（付场地方）</span>
            <span className="tag">已付 {paidCount}/{totalCount} 期 · {fmtMoney(paidAmount)} / {fmtMoney(totalAmount)}</span>
            <span className={`ml-auto font-medium ${remainPay > 0 ? "text-rose-600" : "text-emerald-600"}`}>
              {remainPay > 0 ? `待付 ${fmtMoney(remainPay)}` : "已付清"}
            </span>
          </div>
          <div className="xl-bar mb-1.5">
            <i className={progress >= 100 ? "bg-emerald-500" : "bg-rose-400"} style={{ width: `${progress}%` }} />
          </div>
          <div className="mb-1.5 text-[11px] text-slate-500">
            {nextPay
              ? <>下期应付：<b className="font-medium text-slate-700">{String(nextPay.periodStart || "").slice(0, 10)} ~ {String(nextPay.periodEnd || "").slice(0, 10)}</b> · <b className="font-medium text-rose-600">{fmtMoney(nextPay.amount)}</b>
                {isOverdue(nextPay) && <span className="ml-1 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">已逾期</span>}</>
              : <span className="text-emerald-600">本年度付款已全部结清</span>}
          </div>
          <div className="xl-dwrap" style={{ maxHeight: 264 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 44 }}>期数</th>
                  <th style={{ width: 176 }}>应付期间</th>
                  <th style={{ width: 92 }}>应付金额</th>
                  <th style={{ width: 78 }}>状态</th>
                  <th style={{ width: 88 }}>实际付款</th>
                  <th style={{ width: 168 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {schedules.length === 0 && (
                  <tr><td colSpan={6} className="ctr" style={{ color: "#94a3b8", padding: 10 }}>暂无付款分期（请先在「合同管理」生成分期）</td></tr>
                )}
                {schedules.map((s: any) => {
                  const paid = s.status === "已付款";
                  const overdue = isOverdue(s);
                  const ap = (s.approvals ?? [])[0] ?? null;
                  return (
                    <tr key={s.id} className={paid ? "bg-emerald-50/40" : overdue ? "bg-rose-50/40" : undefined}>
                      <td className="ctr text-slate-500">{s.seq}</td>
                      <td className="ctr text-slate-500">{String(s.periodStart || "").slice(0, 10)} ~ {String(s.periodEnd || "").slice(0, 10)}</td>
                      <td className="num font-medium">{fmtMoney(s.amount)}</td>
                      <td className="ctr">
                        {paid ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" />已付款
                          </span>
                        ) : ap?.status === "审批中" ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                            <Clock className="h-3 w-3" />审批中
                          </span>
                        ) : ap?.status === "已驳回" ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
                            <AlertCircle className="h-3 w-3" />已驳回
                          </span>
                        ) : overdue ? (
                          <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700" title={`应付截止 ${String(s.periodEnd).slice(0, 10)}，已逾期`}>逾期</span>
                        ) : (
                          <span className="rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500">未付款</span>
                        )}
                      </td>
                      <td className="ctr tabular-nums text-emerald-600">{paid && s.payDate ? String(s.payDate).slice(0, 10) : <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                      <td className="ctr">
                        {markingId === s.id ? markBtns(s, { side: "payment", paidStatus: "已付款", undoStatus: paid ? "未付款" : "", label: "付款" })
                          : paid ? (
                            <div className="flex items-center justify-center gap-1">
                              <button type="button" className="rounded px-1.5 py-0.5 text-[10px] text-rose-600 hover:underline" onClick={() => startMark(s.id, s.payDate)}>修改</button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-center gap-1">
                              <button type="button"
                                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${color.btnOutline}`}
                                title="按本期生成应付电费/场地费审批单"
                                onClick={() => setPayDialog({ id: s.id, seq: s.seq, periodStart: s.periodStart, periodEnd: s.periodEnd, amount: s.amount, monthIncome: s.monthIncome, monthElecIncome: s.monthElecIncome })}>
                                <Send className="mr-0.5 inline h-3 w-3" />提交审批
                              </button>
                              <button type="button" className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-100"
                                onClick={() => startMark(s.id)}>标记付款</button>
                            </div>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ══ 收款侧（品牌方 → 我们）══ */}
        <div className="xl-sec">
          <div className="xl-sec-head is-income">
            <span>收款情况（收品牌方）</span>
            <span className="tag">已到账 {incomePaidCount}/{incomeTotalCount} 期 · {fmtMoney(incomePaid)} / {fmtMoney(incomeTotal)}</span>
            <span className={`ml-auto font-medium ${remainIncome > 0 ? "text-amber-600" : "text-emerald-600"}`}>
              {remainIncome > 0 ? `待收 ${fmtMoney(remainIncome)}` : "已收齐"}
            </span>
          </div>
          <div className="xl-bar mb-1.5">
            <i className={incomeProgress >= 100 ? "bg-emerald-500" : "bg-amber-400"} style={{ width: `${incomeProgress}%` }} />
          </div>
          <div className="mb-1.5 text-[11px] text-slate-500">
            {incomeBrands.length === 0
              ? <span>暂无收款分期（品牌方合同生成分期后显示）</span>
              : <>按品牌方汇总 · 点「期次」看逐期到账情况</>}
          </div>
          <div className="xl-dwrap" style={{ maxHeight: 264 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 132 }}>品牌方</th>
                  <th style={{ width: 92 }}>应收合计</th>
                  <th style={{ width: 92 }}>已到账</th>
                  <th style={{ width: 92 }}>待收</th>
                  <th style={{ width: 172 }}>下次应收</th>
                  <th style={{ width: 72 }}>期数</th>
                  <th style={{ width: 56 }}></th>
                </tr>
              </thead>
              <tbody>
                {incomeBrands.length === 0 && (
                  <tr><td colSpan={7} className="ctr" style={{ color: "#94a3b8", padding: 10 }}>暂无收款分期</td></tr>
                )}
                {incomeBrands.map((b) => {
                  const open = incomeBrandOpen === b.brandName;
                  const allPaid = b.totalCount > 0 && b.paidCount >= b.totalCount;
                  const dueLeft = Math.round((b.totalAmount - b.paidAmount) * 100) / 100;
                  return (
                    <Fragment key={b.brandName}>
                      <tr className={allPaid ? "bg-emerald-50/40" : undefined}>
                        <td className="truncate font-medium text-slate-700" title={b.brandName}>{b.brandName}</td>
                        <td className="num">{fmtMoney(b.totalAmount)}</td>
                        <td className="num text-emerald-600">{fmtMoney(b.paidAmount)}</td>
                        <td className={"num " + (dueLeft > 0 ? "font-medium text-amber-600" : "")}>{dueLeft > 0 ? fmtMoney(dueLeft) : <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                        <td className="ctr text-slate-500">
                          {b.nextDue ? (
                            <span className={isOverdueIncome(b.nextDue) ? "font-medium text-rose-600" : ""}>
                              {String(b.nextDue.periodStart || "").slice(0, 10)} ~ {String(b.nextDue.periodEnd || "").slice(0, 10)}
                              <span className="ml-1 tabular-nums">{fmtMoney(b.nextDue.amount)}</span>
                              {isOverdueIncome(b.nextDue) && <span className="ml-1 rounded bg-rose-100 px-1 py-0.5 text-[10px]">逾期</span>}
                            </span>
                          ) : <span className="text-emerald-600">已收齐</span>}
                        </td>
                        <td className="ctr">
                          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${allPaid ? "bg-emerald-100 text-emerald-700" : "bg-amber-50 text-amber-600"}`}>
                            {b.paidCount}/{b.totalCount}
                          </span>
                        </td>
                        <td className="ctr">
                          <button type="button" className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100"
                            onClick={() => setIncomeBrandOpen(open ? null : b.brandName)}>{open ? "收起" : "期次"}</button>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={7} className="p-0" style={{ background: "#fafafa" }}>
                            <div className="xl-dwrap" style={{ border: "none" }}>
                              <table>
                                <thead>
                                  <tr>
                                    <th style={{ width: 52 }}>期数</th>
                                    <th style={{ width: 176 }}>应收期间</th>
                                    <th style={{ width: 92 }}>应收金额</th>
                                    <th style={{ width: 78 }}>状态</th>
                                    <th style={{ width: 88 }}>实际到账</th>
                                    <th style={{ width: 168 }}>操作</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {b.rows.map((s: any) => {
                                    const paid = s.status === "已到账";
                                    const overdue = isOverdueIncome(s);
                                    return (
                                      <tr key={s.id} className={paid ? "bg-emerald-50/40" : overdue ? "bg-rose-50/40" : undefined}>
                                        <td className="ctr text-slate-500">{s.seq}</td>
                                        <td className="ctr text-slate-500">{String(s.periodStart || "").slice(0, 10)} ~ {String(s.periodEnd || "").slice(0, 10)}</td>
                                        <td className="num font-medium">{fmtMoney(s.amount)}</td>
                                        <td className="ctr">
                                          {paid ? (
                                            <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                              <CheckCircle2 className="h-3 w-3" />已到账
                                            </span>
                                          ) : overdue ? (
                                            <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">逾期</span>
                                          ) : (
                                            <span className="rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500">未到账</span>
                                          )}
                                        </td>
                                        <td className="ctr tabular-nums text-emerald-600">{paid && s.payDate ? String(s.payDate).slice(0, 10) : <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                                        <td className="ctr">
                                          {markingId === s.id ? markBtns(s, { side: "income", paidStatus: "已到账", undoStatus: paid ? "未到账" : "", label: "到账" })
                                            : paid ? (
                                              <button type="button" className="rounded px-1.5 py-0.5 text-[10px] text-rose-600 hover:underline" onClick={() => startMark(s.id, s.payDate)}>修改</button>
                                            ) : (
                                              <button type="button" className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 hover:bg-emerald-100"
                                                onClick={() => startMark(s.id)}>标记到账</button>
                                            )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 提交审批弹窗 */}
      <PayApprovalDialog
        open={payDialog !== null}
        onClose={() => setPayDialog(null)}
        landlordId={landlordId}
        landlordName={landlordName}
        schedule={payDialog}
        year={year}
        venueContract={data.venueContract}
        paidCount={data.paidCount}
        totalCount={data.totalCount}
        paidAmount={data.paidAmount}
      />
    </div>
  );
}

// 公司主体分组配色与分组逻辑见 src/lib/groupColors.ts（与 Electricity 页共用）
import { groupByEntity, GROUP_COLOR_NEUTRAL, type GroupColor } from "@/lib/groupColors";

export default function Rent() {
  const [startPeriod, setStartPeriod] = useState(CUR_MONTH);
  const [endPeriod, setEndPeriod] = useState(CUR_MONTH);
  /* ★重设计：原来顶部是「按场地方 / 按品牌方」两个维度按钮（同一批数据的两种分组），
     现在改为在同一张平铺台账表上用筛选条件定位：月份区间 / 场地方 / 品牌方 / 公司主体 / 收付状态 / 关键词。 */
  const [fLandlord, setFLandlord] = useState("");
  const [fBrand, setFBrand] = useState("");
  const [fEntity, setFEntity] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reconcileRow, setReconcileRow] = useState<any>(null);
  // 行内「整年收支」小节：默认展开（信息就在那儿），按行可收起（记 row.key）
  const [yearHidden, setYearHidden] = useState<Set<string>>(new Set());
  // ★「年度付款计划」「整年场地收支」已合并进台账每一行的展开区 —— 不再需要页面级折叠开关与搜索框：
  //   点行首 ▶ 就能同时看到 ①本月合同明细 ②该场地年度付款计划（分期/审批/标记）③该场地整年收支。
  //   要找某个场地方/品牌，直接用上面的筛选条件（场地方 / 品牌方 / 关键词）。

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
    queryKey: ["rent-monthly-ledger-range", startPeriod, endPeriod],
    queryFn: async () => {
      // ★固定用「场地方」维度拉取：它一次带回 场地方 + 主体 + 合同快照（含品牌方合同），
      // 足够拼出任何筛选视角（品牌/主体筛选在前端做），不用再按维度重复请求。
      const results = await Promise.all(monthRange.map((p) => getMonthlyLedger(p, "landlord")));
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

  // ── 平铺台账行：一行 = 场地方 × 主体 × 月份 ──
  //   数字与旧版「月份 → 场地/品牌」明细完全一致，只是把两层展开压平成一张可筛选的台账。
  const flatRows = useMemo(() => {
    const out: any[] = [];
    for (const m of months) {
      for (const g of (m.rows ?? []) as any[]) {
        const contracts = (g.contracts ?? []) as any[];
        const brandContracts = contracts.filter((c) => c.contractType === "品牌方合同");
        const brands = [...new Set(brandContracts.map((c) => c.brandName).filter(Boolean))] as string[];
        const brandIds = [...new Set(brandContracts.map((c) => c.brandId).filter((x) => x != null))] as number[];
        const cabinets = brandContracts.reduce((s, c) => s + Number(c.liveCabinetsCount ?? c.cabinetsCount ?? 0), 0);
        out.push({
          key: `${m.period}|${g.key}|${g.entityId ?? "x"}`,
          period: m.period,
          landlordKey: g.key,
          landlordName: g.name,
          entityId: g.entityId ?? null,
          entityName: g.entityName ?? "未指定主体",
          brands, brandIds,
          cabinets: Math.round(cabinets * 100) / 100,
          cyc: rowCyclePrefixes(contracts),
          rentIncome: Number(g.rentIncome ?? 0),
          rentCost: Number(g.rentCost ?? 0),
          rentTax: Number(g.rentTax ?? 0),
          rentProfit: Number(g.rentProfit ?? 0),
          collectedAmount: Number(g.collectedAmount ?? 0),
          uncollectedAmount: Number(g.uncollectedAmount ?? 0),
          paidAmount: Number(g.paidAmount ?? 0),
          unpaidAmount: Number(g.unpaidAmount ?? 0),
          contracts,
          rowG: g,
        });
      }
    }
    return out;
  }, [months]);

  // 筛选项候选值（从已取到的数据派生，天然受账号数据范围约束）
  const landlordOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of flatRows) seen.set(String(r.landlordKey), r.landlordName ?? "");
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [flatRows]);
  const brandOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of flatRows) {
      for (const c of r.contracts) if (c.contractType === "品牌方合同" && c.brandId != null) seen.set(String(c.brandId), c.brandName ?? "");
    }
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
      if (fStatus === "uncollected" && !(r.uncollectedAmount > 0)) return false;
      if (fStatus === "unpaid" && !(r.unpaidAmount > 0)) return false;
      if (kw && !`${r.landlordName} ${r.entityName} ${r.brands.join(" ")}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [flatRows, fLandlord, fBrand, fEntity, fStatus, keyword]);

  // 总览表头：区间内收/付款周期统一时用动态标题（如 本季度场地费应付）；混合周期回退通用标题
  const rangeCycles = useMemo(() => {
    const income = new Set<string>();
    const pay = new Set<string>();
    for (const m of months) {
      const cp = monthCyclePrefixes(m.rows ?? []);
      if (cp.income) income.add(cp.income);
      if (cp.pay) pay.add(cp.pay);
    }
    return {
      income: income.size === 1 ? (Array.from(income)[0] ?? null) : null,
      pay: pay.size === 1 ? (Array.from(pay)[0] ?? null) : null,
    };
  }, [months]);

  // 整年场地收支的年份列：只展示当前选中年份（startPeriod 所在年），不列出合同覆盖的全部年份
  const yearLabels = useMemo(() => [(startPeriod || CUR_MONTH).slice(0, 4)], [startPeriod]);

  // 整年场地收支（框外）：取第一个月的 yearlyRows（后端按该年全年合同构建）
  const yearlyRows: any[] = useMemo(() => (months[0]?.yearlyRows ?? []), [months]);
  const yearLabel = useMemo(() => (startPeriod || CUR_MONTH).slice(0, 4) + "年", [startPeriod]);

  // 场地方 → 整年收支行（展开行里显示「这个场地」的整年收支）
  const yearlyByLandlord = useMemo(() => {
    const m = new Map<number, any>();
    for (const y of yearlyRows) m.set(Number(y.landlordId), y);
    return m;
  }, [yearlyRows]);

  // 主体 → 配色（与旧版年度付款计划的配色一致）
  const entityColor = useMemo(() => {
    const m = new Map<string, GroupColor>();
    for (const g of groupByEntity(flatRows)) m.set(g.entityName, g.color);
    return m;
  }, [flatRows]);

  // 合计：跟随筛选结果（与表尾合计、顶部总览卡一致）
  const totals = useMemo(() => {
    const t = { cabinets: 0, rentIncome: 0, rentCost: 0, rentTax: 0, paidAmount: 0, unpaidAmount: 0, collectedAmount: 0, uncollectedAmount: 0, rentProfit: 0 };
    for (const r of rows) {
      t.cabinets += r.cabinets;
      t.rentIncome += r.rentIncome;
      t.rentCost += r.rentCost;
      t.rentTax += r.rentTax;
      t.paidAmount += r.paidAmount;
      t.unpaidAmount += r.unpaidAmount;
      t.collectedAmount += r.collectedAmount;
      t.uncollectedAmount += r.uncollectedAmount;
    }
    t.rentProfit = t.rentIncome - t.rentCost - t.rentTax;
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] = Math.round(t[k] * 100) / 100;
    return t;
  }, [rows]);

  const quick = (n: number) => {
    setEndPeriod(CUR_MONTH);
    setStartPeriod(shift(CUR_MONTH, -(n - 1)));
  };

  // ── 导出 Excel（参考美团场租台账格式：每 场地×品牌 一行，整年口径）──
  // 收款公司 = 该行品牌方合同自身关联的公司主体（缺失时回退场地合同主体）
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
        const cabinets = Number(c.liveCabinetsCount ?? c.cabinetsCount ?? 0);
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
          c.entityName || gy.entityName || "未指定主体", // 收款公司 = 该行品牌合同关联的公司主体
          "", // 占股（暂无数据）
          gy.landlordName,
          c.brandName || "",
          cabinets,
          venue.landlordContact || venue.landlordName || "",
          costStart ? `${String(costStart).slice(0, 10)} ~ ${costEnd ? String(costEnd).slice(0, 10) : ""}` : "",
          years != null ? `${years}年` : "",
          (venue.annualRent ?? venue.rentAmount) != null ? Math.round((venue.annualRent ?? venue.rentAmount) * 100) / 100 : "",
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
      {/* ── 顶部：月份区间 + ★筛选条件（不再切换维度） ── */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">场地费台账</h2>
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
        <input className={`${inputCls} w-44`} placeholder="搜索场地方 / 品牌方 / 主体…"
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <div className="w-36">
          <SearchSelect value={fLandlord} onChange={setFLandlord} placeholder="全部场地方" options={landlordOptions} />
        </div>
        <div className="w-36">
          <SearchSelect value={fBrand} onChange={setFBrand} placeholder="全部品牌方" options={brandOptions} />
        </div>
        <div className="w-36">
          <SearchSelect value={fEntity} onChange={setFEntity} placeholder="全部主体" options={entityOptions} />
        </div>
        <select className={`${inputCls} w-32`} value={fStatus} onChange={(e) => setFStatus(e.target.value)}
          title="按合同周期口径：未收/未付 = 该月覆盖期次还没到账 / 还没付款">
          <option value="">收付：全部</option>
          <option value="uncollected">仅未收（应收未到账）</option>
          <option value="unpaid">仅未付（应付未付款）</option>
        </select>
        <button type="button"
          onClick={() => { setFLandlord(""); setFBrand(""); setFEntity(""); setFStatus(""); setKeyword(""); }}
          className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:text-slate-600">清空筛选</button>
        <span className="text-xs text-slate-400">
          {toDisplay(startPeriod)} ~ {toDisplay(endPeriod)} · {rows.length} / {flatRows.length} 行 · 仅场地费（不含电费）
        </span>
        <Button size="sm" className="ml-auto bg-blue-600 hover:bg-blue-700" onClick={doExport}>
          <Download className="mr-1 h-3.5 w-3.5" />导出 Excel
        </Button>
      </div>

      {/* ── 合计总览（跟随筛选条件） ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="场地费收入" value={totals.rentIncome} tone="emerald" />
        <StatCard label="场地费成本" value={totals.rentCost} tone="rose" />
        <StatCard label="税费" value={totals.rentTax} />
        <StatCard label="利润" value={totals.rentProfit} tone="blue" />
        <StatCard label="已收" value={totals.collectedAmount} tone="emerald" />
        <StatCard label="未收" value={totals.uncollectedAmount} />
        <StatCard label="已付" value={totals.paidAmount} />
        <StatCard label="未付" value={totals.unpaidAmount} tone="rose" />
      </div>

      {/* ── 场地费台账平铺明细（★重设计：一行 = 场地方 × 主体 × 月份；筛选条件定位，不再按月份分层展开）
             展开行 = 一处看全：本月合同明细 + 该场地年度付款计划（分期/审批/标记）+ 该场地整年收支 ── */}
      <div className="xl-wrap xl-wrap-scroll rounded-xl shadow-sm">
        <table className="xl-table" style={{ minWidth: 1290 }}>
          <thead>
            <tr>
              <th className="xl-freeze xl-ctr" style={{ left: 0, width: 30 }}></th>
              <th className="xl-freeze" style={{ left: 30, width: 78 }}>月份</th>
              <th className="xl-freeze" style={{ left: 108, width: 110 }}>场地方</th>
              <th style={{ width: 96 }}>主体</th>
              <th style={{ width: 110 }}>品牌方</th>
              <th className="xl-num" style={{ width: 56 }} title="该场地当月计费柜数（品牌方合同柜数合计）">柜数</th>
              <th className="xl-num" style={{ width: 104 }}>场地费收入(月)</th>
              <th className="xl-num" style={{ width: 104 }}>场地费成本(月)</th>
              <th className="xl-num" style={{ width: 80 }}>税费(月)</th>
              <th className="xl-num" style={{ width: 90 }}>利润(月)</th>
              <th className="xl-num" style={{ width: 104 }}>{rangeCycles.income ? `${rangeCycles.income}场地费已收` : "已收(按周期)"}</th>
              <th className="xl-num" style={{ width: 104 }}>{rangeCycles.income ? `${rangeCycles.income}场地费未收` : "未收(按周期)"}</th>
              <th className="xl-num" style={{ width: 104 }}>{rangeCycles.pay ? `${rangeCycles.pay}场地费已付` : "已付(按周期)"}</th>
              <th className="xl-num" style={{ width: 104 }}>{rangeCycles.pay ? `${rangeCycles.pay}场地费应付` : "未付(按周期)"}</th>
              <th className="xl-ctr" style={{ width: 72 }}>核对</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={15} className="xl-ctr xl-muted" style={{ padding: "28px 8px" }}>
                  {q.isLoading ? "加载中…" : "所选筛选条件下没有场地费台账数据"}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const open = expanded.has(r.key);
              const canExpand = (r.contracts?.length ?? 0) > 0;
              // 年度付款计划按「该行月份」的年份取（跨年区间不会串年）；整年收支用起始月年份（后端按该年构建）
              const rowYear = (r.period || CUR_MONTH).slice(0, 4);
              return (
                <Fragment key={r.key}>
                  <tr className={open ? "xl-open" : ""}>
                    <td className="xl-freeze xl-ctr" style={{ left: 0 }}>
                      {canExpand ? (
                        <button className="text-slate-400 hover:text-slate-600" onClick={() => toggle(r.key)} title="展开该场地当月的合同明细（场地合同 / 品牌方合同）">
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span className="text-slate-200">·</span>
                      )}
                    </td>
                    <td className="xl-freeze font-medium text-slate-700" style={{ left: 30 }}>{toDisplay(r.period)}</td>
                    <td className="xl-freeze truncate" style={{ left: 108 }} title={r.landlordName}>{r.landlordName ?? "未指定场地"}</td>
                    <td className="truncate text-slate-600" title={r.entityName}>{r.entityName}</td>
                    <td className="truncate" title={r.brands.join("、")}>
                      {r.brands.length === 0
                        ? <span className="xl-muted">—</span>
                        : r.brands.length === 1
                          ? r.brands[0]
                          : <span className="font-medium text-blue-600">{r.brands.length} 个品牌</span>}
                    </td>
                    <td className="xl-num">{r.cabinets ? fmtNum(r.cabinets) : <span className="xl-muted">—</span>}</td>
                    <td className="xl-num text-emerald-600">{fmtMoney(r.rentIncome)}</td>
                    <td className="xl-num xl-neg">{fmtMoney(r.rentCost)}</td>
                    <td className="xl-num text-slate-500">{fmtMoney(r.rentTax)}</td>
                    <td className="xl-num font-medium text-slate-700">{fmtMoney(r.rentProfit)}</td>
                    <td className="xl-num text-emerald-600" title={r.cyc.income ? `该行合同周期：${r.cyc.income}` : undefined}>
                      {!rangeCycles.income && r.cyc.income && <span className="mr-1 text-[9px] text-slate-400">{r.cyc.income}</span>}
                      {fmtMoney(r.collectedAmount)}
                    </td>
                    <td className="xl-num text-amber-600" title={r.cyc.income ? `该行合同周期：${r.cyc.income}` : undefined}>
                      {!rangeCycles.income && r.cyc.income && <span className="mr-1 text-[9px] text-slate-400">{r.cyc.income}</span>}
                      {fmtMoney(r.uncollectedAmount)}
                    </td>
                    <td className="xl-num text-slate-600" title={r.cyc.pay ? `该行合同周期：${r.cyc.pay}` : undefined}>
                      {!rangeCycles.pay && r.cyc.pay && <span className="mr-1 text-[9px] text-slate-400">{r.cyc.pay}</span>}
                      {fmtMoney(r.paidAmount)}
                    </td>
                    <td className="xl-num xl-neg" title={r.cyc.pay ? `该行合同周期：${r.cyc.pay}` : undefined}>
                      {!rangeCycles.pay && r.cyc.pay && <span className="mr-1 text-[9px] text-slate-400">{r.cyc.pay}</span>}
                      {fmtMoney(r.unpaidAmount)}
                    </td>
                    <td className="xl-ctr">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setReconcileRow(r)}>
                        <CheckCircle2 className="mr-1 h-3 w-3" />核对
                      </Button>
                    </td>
                  </tr>
                  {open && canExpand && (
                    <tr className="xl-detail">
                      <td colSpan={15} className="p-0">
                        <div className="p-2 pt-1.5">

                          {/* ① 本月口径指标条：这个月的钱一眼看完（口径与上方主表列一致） */}
                          <div className="xl-summary xl-summary-sm">
                            <div>
                              <div className="lbl">{toDisplay(r.period)} 场地费收入</div>
                              <div className="val text-emerald-600">{fmtMoney(r.rentIncome)}</div>
                            </div>
                            <div>
                              <div className="lbl">场地费成本</div>
                              <div className="val text-rose-600">{fmtMoney(r.rentCost)}</div>
                            </div>
                            <div>
                              <div className="lbl">税费</div>
                              <div className="val text-slate-500">{fmtMoney(r.rentTax)}</div>
                            </div>
                            <div>
                              <div className="lbl">利润</div>
                              <div className="val text-slate-800">{fmtMoney(r.rentProfit)}</div>
                            </div>
                            <div>
                              <div className="lbl">{r.cyc.income ? `${r.cyc.income}已收` : "已收(按周期)"}</div>
                              <div className="val text-emerald-600">{fmtMoney(r.collectedAmount)}</div>
                            </div>
                            <div>
                              <div className="lbl">{r.cyc.income ? `${r.cyc.income}未收` : "未收(按周期)"}</div>
                              <div className="val text-amber-600">{fmtMoney(r.uncollectedAmount)}</div>
                            </div>
                            <div>
                              <div className="lbl">{r.cyc.pay ? `${r.cyc.pay}已付` : "已付(按周期)"}</div>
                              <div className="val text-slate-600">{fmtMoney(r.paidAmount)}</div>
                            </div>
                            <div>
                              <div className="lbl">{r.cyc.pay ? `${r.cyc.pay}应付` : "未付(按周期)"}</div>
                              <div className="val text-rose-600">{fmtMoney(r.unpaidAmount)}</div>
                            </div>
                            <div>
                              <div className="lbl">计费柜数</div>
                              <div className="val text-slate-700">{r.cabinets ? fmtNum(r.cabinets) : "—"}</div>
                            </div>
                          </div>

                          {/* ② 年度付款计划（通栏：它内部本身就是「付款 / 收款」双栏并排）*/}
                          <div className="xl-sec mt-2.5">
                            <div className="xl-sec-head is-plan">
                              <CalendarCheck className="h-3.5 w-3.5 text-indigo-600" />
                              {r.landlordName} · {rowYear} 年付款计划
                              <span className="tag">左=付款（我们→场地方）· 右=收款（品牌方→我们）· 逾期标红 · 每期可提交审批 / 标记</span>
                            </div>
                            <RentPaymentSchedule
                              landlordId={Number(r.landlordKey)}
                              landlordName={r.landlordName}
                              year={rowYear}
                              color={entityColor.get(r.entityName) ?? GROUP_COLOR_NEUTRAL}
                            />
                          </div>

                          {/* ③ 本月合同明细（通栏：11 列，铺开更清楚） */}
                          <div className="xl-sec mt-2.5">
                            <div className="xl-sec-head is-contract">
                              <FileText className="h-3.5 w-3.5 text-sky-600" />
                              本月合同明细
                              <span className="tag">{toDisplay(r.period)} · {r.contracts.length} 份 · 成本=场地合同 / 收入=品牌方合同</span>
                            </div>
                            <div className="xl-dwrap" style={{ maxHeight: 260 }}>
                                <table>
                                  <thead>
                                    <tr>
                                      <th style={{ width: 96 }}>合同类型</th>
                                      <th style={{ width: 130 }}>品牌方</th>
                                      <th style={{ width: 120 }}>主体</th>
                                      <th style={{ width: 56 }}>柜数</th>
                                      <th style={{ width: 100 }}>月租(含税)</th>
                                      <th style={{ width: 90 }}>单台月租</th>
                                      <th style={{ width: 60 }}>税率</th>
                                      <th style={{ width: 96 }}>已收/已付</th>
                                      <th style={{ width: 96 }}>未收/应付</th>
                                      <th style={{ width: 176 }}>租期</th>
                                      <th style={{ width: 88 }}>付款方式</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {r.contracts.map((c: any, i: number) => {
                                      const isVenue = c.contractType !== "品牌方合同";
                                      const cabs = Number(c.liveCabinetsCount ?? c.cabinetsCount ?? 0);
                                      return (
                                        <tr key={`${r.key}-${c.contractId ?? i}`}>
                                          <td className={isVenue ? "font-medium text-rose-600" : "font-medium text-emerald-600"}>
                                            {isVenue ? "场地合同（成本）" : "品牌方合同（收入）"}
                                          </td>
                                          <td>{c.brandName || <span style={{ color: "#94a3b8" }}>—</span>}</td>
                                          <td className="truncate text-slate-600" title={c.entityName}>{c.entityName || "—"}</td>
                                          <td className="num">{cabs ? fmtNum(cabs) : "—"}</td>
                                          <td className="num">{fmtMoney(c.monthlyRent)}</td>
                                          <td className="num">{c.unitMonthlyRent != null ? fmtNum(c.unitMonthlyRent) : "—"}</td>
                                          <td className="num">{c.rentTaxRate ? `${(Number(c.rentTaxRate) * 100).toFixed(0)}%` : "—"}</td>
                                          <td className="num">{fmtMoney(isVenue ? c.paidAmount : c.collectedAmount)}</td>
                                          <td className="num">{fmtMoney(isVenue ? c.unpaidAmount : c.uncollectedAmount)}</td>
                                          <td className="ctr text-slate-500">
                                            {c.startDate ? `${String(c.startDate).slice(0, 10)} ~ ${c.endDate ? String(c.endDate).slice(0, 10) : ""}` : "—"}
                                          </td>
                                          <td className="ctr text-slate-500">{c.payMethod || "—"}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>

                          {/* ④ 通栏：该场地整年收支（宽表，默认展开，可收起） */}
                          <div className="xl-sec mt-2.5">
                            <div className="xl-sec-head is-year">
                              <Building2 className="h-3.5 w-3.5 text-emerald-600" />
                              {yearLabel} 整年收支
                              <span className="tag">付款信息 = 场地合同 · 收款信息 = 品牌方合同 · 按合同周期计</span>
                              <button
                                type="button"
                                onClick={() => setYearHidden((prev) => {
                                  const n = new Set(prev);
                                  if (n.has(r.key)) n.delete(r.key); else n.add(r.key);
                                  return n;
                                })}
                                className="ml-auto text-[11px] font-normal text-slate-400 hover:text-slate-600"
                              >
                                {yearHidden.has(r.key) ? "展开" : "收起"}
                              </button>
                            </div>
                            {!yearHidden.has(r.key) && (yearlyByLandlord.get(Number(r.landlordKey)) ? (
                              <YearlyTable yearlyRows={[yearlyByLandlord.get(Number(r.landlordKey))]} yearLabels={yearLabels} />
                            ) : (
                              <div className="rounded-md bg-slate-50 px-3 py-3 text-[11px] text-slate-400">
                                该场地在 {yearLabel} 没有可用合同数据
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td className="xl-freeze xl-ctr" style={{ left: 0 }}></td>
                <td className="xl-freeze" style={{ left: 30 }} colSpan={4}>
                  合计 · {rows.length} 行 / {new Set(rows.map((r) => r.landlordKey)).size} 个场地方 × {new Set(rows.map((r) => r.period)).size} 个月
                </td>
                <td className="xl-num">{fmtNum(totals.cabinets)}</td>
                <td className="xl-num text-emerald-600">{fmtMoney(totals.rentIncome)}</td>
                <td className="xl-num xl-neg">{fmtMoney(totals.rentCost)}</td>
                <td className="xl-num text-slate-500">{fmtMoney(totals.rentTax)}</td>
                <td className="xl-num font-medium">{fmtMoney(totals.rentProfit)}</td>
                <td className="xl-num text-emerald-600">{fmtMoney(totals.collectedAmount)}</td>
                <td className="xl-num text-amber-600">{fmtMoney(totals.uncollectedAmount)}</td>
                <td className="xl-num text-slate-600">{fmtMoney(totals.paidAmount)}</td>
                <td className="xl-num xl-neg">{fmtMoney(totals.unpaidAmount)}</td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        口径：收入/成本/税费/利润 均为当月口径（收入=品牌方合同月租·覆盖该月；成本=场地合同月租；利润=当月收入−成本−税费）；
        已收/未收/已付/应付 = 该月覆盖期次的到账/付款状态，金额按合同周期计（季付=整季分期金额，非单月）：
        当月周期统一时列标题随之显示（如「本季度场地费应付」），周期混合时每行金额前标注该行合同的周期。不含电费。编辑合同请到「合同管理」页。
      </p>

      <p className="text-[11px] text-slate-400">
        · 点行首 ▶ 展开：<b>本月指标条</b> → <b>年度付款计划</b>（左付款 / 右收款，并排 · 逾期标红 · 每期可提交审批或标记）→ <b>本月合同明细</b> → <b>整年收支</b>。
        <br />· 「年度付款计划」按该行月份的年份取数；「整年收支」按起始月所处年份构建，其「逐年」列只显示该年。
      </p>

      <Dialog open={!!reconcileRow} onOpenChange={(open) => !open && setReconcileRow(null)}>
        <DialogContent className="!max-w-4xl">
          <DialogHeader>
            <DialogTitle>场地费核对 · {reconcileRow?.landlordName} · {reconcileRow ? toDisplay(reconcileRow.period) : ""}</DialogTitle>
          </DialogHeader>
          {reconcileRow && <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="品牌方应收（月）" value={reconcileRow.rentIncome} tone="emerald" />
              <StatCard label="场地方应付（月）" value={reconcileRow.rentCost} tone="rose" />
              <StatCard label="税费（月）" value={reconcileRow.rentTax} />
              <StatCard label="经营差额（月）" value={reconcileRow.rentProfit} tone="blue" />
              <StatCard label="已收（合同周期）" value={reconcileRow.collectedAmount} tone="emerald" />
              <StatCard label="待收（合同周期）" value={reconcileRow.uncollectedAmount} />
              <StatCard label="已付（合同周期）" value={reconcileRow.paidAmount} />
              <StatCard label="待付（合同周期）" value={reconcileRow.unpaidAmount} tone="rose" />
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[760px] text-xs">
                <thead><tr className="border-b bg-slate-50 text-left text-slate-500">
                  <th className="px-3 py-2">收/付方向</th><th className="px-3 py-2">合同/品牌</th>
                  <th className="px-3 py-2">公司主体</th><th className="px-3 py-2 text-right">本月应收/应付</th>
                  <th className="px-3 py-2 text-right">已收/已付</th><th className="px-3 py-2 text-right">待收/待付</th>
                  <th className="px-3 py-2">合同周期</th>
                </tr></thead>
                <tbody>{(reconcileRow.contracts ?? []).map((c: any, i: number) => {
                  const venue = c.contractType === "场地合同";
                  const paid = venue ? c.paidAmount : c.collectedAmount;
                  const unpaid = venue ? c.unpaidAmount : c.uncollectedAmount;
                  return <tr key={`${c.contractId ?? i}`} className="border-b last:border-0">
                    <td className={venue ? "px-3 py-2 text-rose-600" : "px-3 py-2 text-emerald-600"}>{venue ? "我方应付场地方" : "品牌方应付我方"}</td>
                    <td className="px-3 py-2">{c.brandName || (venue ? reconcileRow.landlordName : "全品牌合同")}</td>
                    <td className="px-3 py-2">{c.entityName || "未指定主体"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(c.monthlyRent)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(paid)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(unpaid)}</td>
                    <td className="px-3 py-2">{c.startDate ? `${String(c.startDate).slice(0, 10)} ~ ${c.endDate ? String(c.endDate).slice(0, 10) : "长期"}` : "未设置"}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-400">应收/应付为所选月份合同口径；已收/待收/已付/待付按合同付款周期展示。此核对窗仅供与双方财务核对，不会修改账单或状态。</p>
          </div>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
