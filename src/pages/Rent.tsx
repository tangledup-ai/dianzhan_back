import { Fragment, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getMonthlyLedger, getYearlyPaymentSchedule } from "@/api/rent";
import { updateSchedule } from "@/api/contracts";
import { submitStationApproval } from "@/api/approvals";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, TextInput, inputCls } from "@/components/fields";
import { fmtMoney, fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { exportXlsxWithTitle } from "@/lib/export";
import { Building2, Tag, ChevronDown, ChevronRight, Download, CalendarCheck, Clock, CheckCircle2, AlertCircle, Send, FileText, Search, Landmark } from "lucide-react";
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
  const [payDialog, setPayDialog] = useState<{ id: number; seq: number; periodStart: string; periodEnd?: string; amount: number; monthIncome?: number; monthElecIncome?: number } | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  // 展开后默认显示收款情况，可切换到付款情况（避免两块同时铺开信息过多）
  const [side, setSide] = useState<"income" | "pay">("income");
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

  // 收款侧（场地费收款：品牌方合同 rent_income_schedule，品牌方 → 公司）
  // 注意：以下 hooks 必须位于组件的提前 return 之前（Rules of Hooks）
  const incomeContracts = data?.incomeContracts ?? [];
  const incomeTotal = data?.incomeTotalAmount ?? 0;
  const incomePaid = data?.incomePaidAmount ?? 0;
  const incomePaidCount = data?.incomePaidCount ?? 0;
  const incomeTotalCount = data?.incomeTotalCount ?? 0;
  const incomeProgress = incomeTotal > 0 ? Math.min(100, Math.round((incomePaid / incomeTotal) * 100)) : 0;
  const incomeRows = incomeContracts
    .flatMap((ic: any) => (ic.schedules ?? []).map((s: any) => ({ ...s, brandName: ic.brandName })))
    .sort((a: any, b: any) => String(a.periodStart ?? "").localeCompare(String(b.periodStart ?? "")) || String(a.brandName).localeCompare(String(b.brandName)));

  // 收款侧按品牌分组：先列品牌方，点击品牌方再展开该品牌的收款分期
  const [incomeBrandOpen, setIncomeBrandOpen] = useState<string | null>(null);
  const incomeBrands = useMemo(() => {
    const map = new Map<string, { brandName: string; rows: any[]; totalAmount: number; paidAmount: number; paidCount: number; totalCount: number }>();
    for (const s of incomeRows) {
      const key = s.brandName || "全品牌共享";
      if (!map.has(key)) map.set(key, { brandName: key, rows: [], totalAmount: 0, paidAmount: 0, paidCount: 0, totalCount: 0 });
      const g = map.get(key)!;
      g.rows.push(s);
      g.totalAmount += Number(s.amount || 0);
      if (s.status === "已到账") { g.paidAmount += Number(s.amount || 0); g.paidCount += 1; }
      g.totalCount += 1;
    }
    return [...map.values()];
  }, [incomeRows]);

  if (isLoading) {
    return (
      <div className="rounded-xl border bg-white p-4 text-center text-xs text-slate-400">
        加载付款计划中…
      </div>
    );
  }

  if (!data || !data.venueContract) {
    return null;
  }

  const vc = data.venueContract;
  const schedules = data.schedules ?? [];
  const totalAmount = data.totalAmount || 0;
  const paidAmount = data.paidAmount || 0;
  const paidCount = data.paidCount || 0;
  const totalCount = data.totalCount || 0;
  const progress = totalAmount > 0 ? Math.min(100, Math.round((paidAmount / totalAmount) * 100)) : 0;
  const firstAmount = schedules[0]?.amount ?? 0;

  return (
    <div className="overflow-hidden rounded-2xl border border-indigo-100/80 bg-white shadow-sm">
      {/* 标题栏（点击展开/收起） */}
      <button
        type="button"
        onClick={() => { if (!collapsed) setIncomeBrandOpen(null); setCollapsed((c) => !c); }}
        className={`flex w-full flex-wrap items-center gap-3 border-b border-slate-100 bg-gradient-to-r ${color.head} px-5 py-4 text-left transition-colors hover:bg-slate-50/70`}
      >
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color.iconGrad} text-white shadow-sm`}>
          <CalendarCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-800">{landlordName}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${color.badge}`}>年度付款计划 · {year}年</span>
            {schedules.length > 0 && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">共 {totalCount} 期</span>
            )}
            {schedules.length > 0 && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${paidCount >= totalCount && totalCount > 0 ? "bg-emerald-100 text-emerald-700" : "bg-amber-50 text-amber-600"}`}>
                已付 {paidCount}/{totalCount}
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            合同 {vc.startDate || "—"} ~ {vc.endDate || "—"} · {vc.payMethod || "—"}付款
            {schedules.length > 0 && <> · 每期 {fmtMoney(firstAmount)}</>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] text-slate-400">年租金成本</div>
            <div className="text-lg font-bold tabular-nums text-slate-800">{fmtMoney(totalAmount)}</div>
          </div>
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          )}
        </div>
      </button>

      {!collapsed && (
        <>
      {/* 收款 / 付款 切换 */}
      <div className="border-b border-slate-100 px-5 py-3">
        <div className="flex items-center justify-between">
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setSide("income")}
              className={`px-3.5 py-1.5 text-xs font-medium transition-colors ${side === "income" ? `${color.btn} text-white` : "bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              收款情况
            </button>
            <button
              type="button"
              onClick={() => setSide("pay")}
              className={`px-3.5 py-1.5 text-xs font-medium transition-colors ${side === "pay" ? `${color.btn} text-white` : "bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              付款情况
            </button>
          </div>
          <span className="text-[10px] text-slate-400">
            {side === "income" ? `付款 ${paidCount}/${totalCount} 期` : `收款 ${incomePaidCount}/${incomeTotalCount} 期`}
          </span>
        </div>
      </div>

      {side === "pay" && (
        <>
      {/* 付款进度 */}
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="font-medium">付款进度</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${progress >= 100 ? "bg-emerald-100 text-emerald-700" : color.chipPay}`}>
              {paidCount}/{totalCount} 期 · {progress}%
            </span>
          </div>
          <span className="text-[10px] text-slate-400">{paidAmount > 0 ? `已付 ${fmtMoney(paidAmount)}` : "尚未付款"}</span>
        </div>
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full bg-gradient-to-r ${color.bar} transition-all duration-500`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <div className="text-[10px] text-slate-400">已付金额</div>
            <div className="mt-0.5 text-sm font-bold tabular-nums text-emerald-600">{fmtMoney(paidAmount)}</div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <div className="text-[10px] text-slate-400">待付金额</div>
            <div className="mt-0.5 text-sm font-bold tabular-nums text-amber-600">{fmtMoney(totalAmount - paidAmount)}</div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <div className="text-[10px] text-slate-400">付款方式</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-700">{vc.payMethod || "—"}</div>
          </div>
        </div>
      </div>
        </>
      )}

      {side === "income" && (
        <>
      {/* 收款进度（场地费收款：品牌方合同分期，品牌方 → 公司） */}
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="font-medium">收款进度</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${incomeTotalCount > 0 && incomePaidCount >= incomeTotalCount ? "bg-emerald-100 text-emerald-700" : color.chipPay}`}>
              {incomePaidCount}/{incomeTotalCount} 期 · {incomeProgress}%
            </span>
          </div>
          <span className="text-[10px] text-slate-400">{incomePaid > 0 ? `已收 ${fmtMoney(incomePaid)}` : "尚未收款"}</span>
        </div>
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full bg-gradient-to-r ${color.bar} transition-all duration-500`}
            style={{ width: `${incomeProgress}%` }}
          />
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <div className="text-[10px] text-slate-400">已收金额</div>
            <div className="mt-0.5 text-sm font-bold tabular-nums text-emerald-600">{fmtMoney(incomePaid)}</div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <div className="text-[10px] text-slate-400">待收金额</div>
            <div className="mt-0.5 text-sm font-bold tabular-nums text-amber-600">{fmtMoney(incomeTotal - incomePaid)}</div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <div className="text-[10px] text-slate-400">收款合同</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-700">{incomeContracts.length} 份品牌合同</div>
          </div>
        </div>
        {incomeTotalCount === 0 && (
          <div className="mt-2 text-[10px] text-slate-400">暂无收款分期数据（品牌方合同生成分期后显示）</div>
        )}
      </div>
        </>
      )}

      {side === "pay" && (
        <>
      {/* 分期表格 */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
              <th className="px-5 py-2.5 font-medium">期数</th>
              <th className="px-4 py-2.5 font-medium">应付时间</th>
              <th className="px-4 py-2.5 text-right font-medium">应付金额</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">实际付款时间</th>
              <th className="px-4 py-2.5 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 && (
              <tr><td colSpan={6} className="py-10 text-center text-slate-400">
                暂无付款分期数据（请先在合同管理中生成分期）
              </td></tr>
            )}
            {schedules.map((s: any) => {
              const isPaid = s.status === "已付款";
              const isPending = !isPaid;
              const hasApproval = (s.approvals ?? []).length > 0;
              const latestApproval = hasApproval ? s.approvals[0] : null;
              return (
                <tr key={s.id} className={`border-t border-slate-50 transition-colors hover:bg-slate-50/50 ${isPaid ? "bg-emerald-50/20" : ""}`}>
                  <td className="px-5 py-3">
                    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${isPaid ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{s.seq}</span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                    {s.periodStart?.slice(0, 10) || "—"} ~ {s.periodEnd?.slice(0, 10) || "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-700">{fmtMoney(s.amount)}</td>
                  <td className="px-4 py-3">
                    {isPaid ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        <CheckCircle2 className="h-3 w-3" />已付款
                      </span>
                    ) : hasApproval && latestApproval?.status === "审批中" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        <Clock className="h-3 w-3" />审批中
                      </span>
                    ) : hasApproval && latestApproval?.status === "已驳回" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                        <AlertCircle className="h-3 w-3" />已驳回
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500">
                        未付款
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isPaid && s.payDate ? (
                      <span className="tabular-nums text-emerald-600">{s.payDate}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {markingId === s.id ? (
                      <div className="flex items-center justify-center gap-1">
                        <input
                          type="date"
                          className="w-32 rounded-md border border-slate-200 px-2 py-1 text-xs"
                          value={markDate}
                          onChange={(e) => setMarkDate(e.target.value)}
                        />
                        <Button
                          size="sm"
                          className="h-7 rounded-lg bg-emerald-600 px-2.5 text-xs text-white hover:bg-emerald-700"
                          disabled={markDone.isPending}
                          onClick={() => {
                            if (!markDate) { toast.error("请选择付款日期"); return; }
                            markDone.mutate({ id: s.id, status: "已付款", payDate: markDate, side: "payment" });
                          }}
                        >
                          保存
                        </Button>
                        {isPaid && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 rounded-lg border-amber-200 bg-amber-50/60 px-2.5 text-xs font-medium text-amber-600 hover:bg-amber-100"
                            disabled={markDone.isPending}
                            onClick={() => markDone.mutate({ id: s.id, status: "未付款", payDate: markDate, side: "payment" })}
                          >
                            撤销付款
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-7 rounded-lg px-2.5 text-xs" onClick={() => { setMarkingId(null); setMarkDate(""); }}>取消</Button>
                      </div>
                    ) : isPending ? (
                      <div className="flex items-center justify-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className={`h-7 rounded-lg px-2.5 text-xs font-medium ${color.btnOutline}`}
                          onClick={() => setPayDialog({ id: s.id, seq: s.seq, periodStart: s.periodStart, periodEnd: s.periodEnd, amount: s.amount, monthIncome: s.monthIncome, monthElecIncome: s.monthElecIncome })}
                        >
                          <Send className="mr-1 h-3 w-3" />提交审批
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 rounded-lg border-blue-200 bg-blue-50/60 px-2.5 text-xs font-medium text-blue-600 hover:border-blue-300 hover:bg-blue-100"
                          onClick={() => { setMarkingId(s.id); setMarkDate(new Date().toISOString().slice(0, 10)); }}
                        >
                          标记付款
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-[11px] text-rose-600 hover:text-rose-700"
                        onClick={() => { setMarkingId(s.id); setMarkDate(s.payDate || new Date().toISOString().slice(0, 10)); }}
                      >
                        修改
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

        </>
      )}

      {side === "income" && (
        <>
      {/* 收款分期明细（按品牌分组：点击品牌方展开该品牌的收款分期） */}
      <div className={`border-t border-slate-100 ${color.bg} px-5 py-2.5`}>
        <span className={`text-[11px] font-medium ${color.text}`}>收款分期明细（场地费收款 · 品牌方 → 公司 · 点击品牌方展开）</span>
      </div>
      <div className="px-5 py-3">
        {incomeBrands.length === 0 && (
          <div className="rounded-md bg-slate-50 px-3 py-4 text-center text-xs text-slate-400">
            暂无收款分期数据（品牌方合同生成分期后显示）
          </div>
        )}
        <div className="space-y-2">
          {incomeBrands.map((b) => {
            const isOpen = incomeBrandOpen === b.brandName;
            const allPaid = b.totalCount > 0 && b.paidCount >= b.totalCount;
            return (
              <div key={b.brandName} className="overflow-hidden rounded-lg border border-slate-200">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 bg-slate-50/60 px-3 py-2.5 text-left text-xs hover:bg-slate-100/70"
                  onClick={() => setIncomeBrandOpen(isOpen ? null : b.brandName)}
                >
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                  <span className="font-medium text-slate-700">{b.brandName}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${allPaid ? "bg-emerald-100 text-emerald-700" : "bg-amber-50 text-amber-600"}`}>
                    已到账 {b.paidCount}/{b.totalCount} 期
                  </span>
                  <span className="ml-auto text-right tabular-nums">
                    <span className="text-[10px] text-slate-400">已收 </span>
                    <span className="font-medium text-emerald-600">{fmtMoney(b.paidAmount)}</span>
                    <span className="mx-1 text-slate-300">/</span>
                    <span className="text-slate-600">{fmtMoney(b.totalAmount)} 元</span>
                  </span>
                </button>
                {isOpen && (
                  <div className="overflow-x-auto border-t">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
                          <th className="px-5 py-2.5 font-medium">期数</th>
                          <th className="px-4 py-2.5 font-medium">应收时间</th>
                          <th className="px-4 py-2.5 text-right font-medium">应收金额</th>
                          <th className="px-4 py-2.5 font-medium">状态</th>
                          <th className="px-4 py-2.5 font-medium">实际到账时间</th>
                          <th className="px-4 py-2.5 text-center font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.rows.length === 0 && (
                          <tr><td colSpan={6} className="py-6 text-center text-slate-400">暂无分期</td></tr>
                        )}
                        {b.rows.map((s: any) => {
                          const isPaid = s.status === "已到账";
                          return (
                            <tr key={s.id} className={`border-t border-slate-50 transition-colors hover:bg-slate-50/50 ${isPaid ? "bg-emerald-50/20" : ""}`}>
                              <td className="px-5 py-3">
                                <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${isPaid ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{s.seq}</span>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                                {s.periodStart?.slice(0, 10) || "—"} ~ {s.periodEnd?.slice(0, 10) || "—"}
                              </td>
                              <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-700">{fmtMoney(s.amount)}</td>
                              <td className="px-4 py-3">
                                {isPaid ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                                    <CheckCircle2 className="h-3 w-3" />已到账
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500">
                                    未到账
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {isPaid && s.payDate ? (
                                  <span className="tabular-nums text-emerald-600">{s.payDate}</span>
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-center">
                                {markingId === s.id ? (
                                  <div className="flex items-center justify-center gap-1">
                                    <input
                                      type="date"
                                      className="w-32 rounded-md border border-slate-200 px-2 py-1 text-xs"
                                      value={markDate}
                                      onChange={(e) => setMarkDate(e.target.value)}
                                    />
                                    <Button
                                      size="sm"
                                      className="h-7 rounded-lg bg-emerald-600 px-2.5 text-xs text-white hover:bg-emerald-700"
                                      disabled={markDone.isPending}
                                      onClick={() => {
                                        if (!markDate) { toast.error("请选择到账日期"); return; }
                                        markDone.mutate({ id: s.id, status: "已到账", payDate: markDate, side: "income" });
                                      }}
                                    >
                                      保存
                                    </Button>
                                    {isPaid && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 rounded-lg border-amber-200 bg-amber-50/60 px-2.5 text-xs font-medium text-amber-600 hover:bg-amber-100"
                                        disabled={markDone.isPending}
                                        onClick={() => markDone.mutate({ id: s.id, status: "未到账", payDate: markDate, side: "income" })}
                                      >
                                        撤销到账
                                      </Button>
                                    )}
                                    <Button size="sm" variant="outline" className="h-7 rounded-lg px-2.5 text-xs" onClick={() => { setMarkingId(null); setMarkDate(""); }}>取消</Button>
                                  </div>
                                ) : isPaid ? (
                                  <div className="flex items-center justify-center gap-1">
                                    <span className="tabular-nums text-emerald-600">{s.payDate || ""}</span>
                                    <button
                                      type="button"
                                      className="rounded px-1.5 py-0.5 text-[11px] text-rose-600 hover:text-rose-700"
                                      onClick={() => { setMarkingId(s.id); setMarkDate(s.payDate || new Date().toISOString().slice(0, 10)); }}
                                    >
                                      修改
                                    </button>
                                  </div>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 rounded-lg border-emerald-200 bg-emerald-50/60 px-2.5 text-xs font-medium text-emerald-600 hover:border-emerald-300 hover:bg-emerald-100"
                                    onClick={() => { setMarkingId(s.id); setMarkDate(new Date().toISOString().slice(0, 10)); }}
                                  >
                                    标记到账
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
        </>
      )}
      {/* 提交审批弹窗 */}
        </>
      )}
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
import { groupByEntity, type GroupColor } from "@/lib/groupColors";

export default function Rent() {
  const [startPeriod, setStartPeriod] = useState(CUR_MONTH);
  const [endPeriod, setEndPeriod] = useState(CUR_MONTH);
  const [dim, setDim] = useState<"landlord" | "brand">("landlord");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 整年场地收支模块：默认收起（点击标题展开），置于页面末尾
  const [yearlyOpen, setYearlyOpen] = useState(false);
  // 年度付款计划模块：默认收起（点击标题展开）+ 场地方/品牌模糊搜索
  const [payOpen, setPayOpen] = useState(false);
  const [payKeyword, setPayKeyword] = useState("");

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

  // 年度付款计划：按场地方名称 / 品牌方名称 模糊过滤
  const filteredPayRows = useMemo(() => {
    const kw = payKeyword.trim();
    if (!kw) return yearlyRows;
    return yearlyRows.filter((gy: any) =>
      (gy.landlordName || "").includes(kw)
      || (gy.brands ?? []).some((b: any) => (b.brandName || "").includes(kw))
    );
  }, [yearlyRows, payKeyword]);

  // 年度付款计划：按场地方关联的公司主体分组（同一主体的场地方放在一起；未指定主体排最后）
  const payGroups = useMemo(() => groupByEntity(filteredPayRows), [filteredPayRows]);

  // 区间合计（总览）
  const totals = useMemo(() => {
    const t = { rentIncome: 0, rentCost: 0, rentTax: 0, paidAmount: 0, unpaidAmount: 0, collectedAmount: 0, uncollectedAmount: 0, rentProfit: 0 };
    for (const m of months) {
      const mt = m.totals ?? {};
      t.rentIncome += mt.rentIncome ?? 0;
      t.rentCost += mt.rentCost ?? 0;
      t.rentTax += mt.rentTax ?? 0;
      t.paidAmount += mt.paidAmount ?? 0;
      t.unpaidAmount += mt.unpaidAmount ?? 0;
      t.collectedAmount += mt.collectedAmount ?? 0;
      t.uncollectedAmount += mt.uncollectedAmount ?? 0;
    }
    t.rentProfit = t.rentIncome - t.rentCost - t.rentTax;
    return t;
  }, [months]);

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
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="区间场地费收入" value={totals.rentIncome} tone="emerald" />
        {dim === "landlord" && <StatCard label="区间场地费成本" value={totals.rentCost} tone="rose" />}
        <StatCard label="区间税费" value={totals.rentTax} />
        <StatCard label="区间利润" value={totals.rentProfit} tone="blue" />
        <StatCard label="区间已收" value={totals.collectedAmount} tone="emerald" />
        <StatCard label="区间未收" value={totals.uncollectedAmount} />
        {dim === "landlord" && <StatCard label="区间已付" value={totals.paidAmount} />}
        {dim === "landlord" && <StatCard label="区间未付" value={totals.unpaidAmount} tone="rose" />}
      </div>

      {/* ── 年度付款计划（默认收起，可搜索场地方/品牌） ── */}
      {yearlyRows.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm">
          <button className="flex w-full items-center gap-2.5 px-4 py-3 text-left" onClick={() => setPayOpen((o) => !o)}>
            {payOpen ? <ChevronDown className="h-4 w-4 text-indigo-600" /> : <ChevronRight className="h-4 w-4 text-indigo-600" />}
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
              <CalendarCheck className="h-4 w-4" />
            </span>
            <h3 className="text-sm font-semibold text-slate-700">年度付款计划（{yearLabel}）</h3>
            <span className="hidden rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 md:inline">场地费付款分期 + 收款进度 · 提交审批</span>
            <span className="ml-auto text-[11px] text-slate-400">{payOpen ? "收起" : "展开"}</span>
          </button>
          {payOpen && (
            <div className="border-t px-4 py-3">
              <div className="mb-3 flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
                  <input
                    className={inputCls + " w-64 pl-7 text-xs"}
                    placeholder="模糊搜索场地方 / 品牌方…"
                    value={payKeyword}
                    onChange={(e) => setPayKeyword(e.target.value)}
                  />
                </div>
                <span className="text-[11px] text-slate-400">
                  {filteredPayRows.length}/{yearlyRows.length} 个场地方
                </span>
              </div>
              <div className="space-y-4">
                {payGroups.map((g) => {
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
                    {g.rows.map((gy: any) => (
                      <RentPaymentSchedule
                        key={gy.landlordId}
                        landlordId={gy.landlordId}
                        landlordName={gy.landlordName}
                        year={(startPeriod || CUR_MONTH).slice(0, 4)}
                        color={c}
                      />
                    ))}
                  </div>
                  );
                })}
                {filteredPayRows.length === 0 && (
                  <div className="rounded-md bg-slate-50 px-3 py-4 text-center text-xs text-slate-400">
                    没有匹配「{payKeyword.trim()}」的场地方 / 品牌方
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 按月总览表 ── */}
      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-xs">
          <thead>
            <tr className="border-b bg-slate-50 text-left text-[11px] text-slate-500">
              <th className="w-8 px-2 py-2.5"></th>
              <th className="px-3 py-2.5 font-medium">月份</th>
              <th className="px-3 py-2.5 text-right font-medium">场地费收入(月)</th>
              {dim === "landlord" && <th className="px-3 py-2.5 text-right font-medium">场地费成本(月)</th>}
              <th className="px-3 py-2.5 text-right font-medium">税费(月)</th>
              <th className="px-3 py-2.5 text-right font-medium">利润(月)</th>
              <th className="px-3 py-2.5 text-right font-medium">{rangeCycles.income ? `${rangeCycles.income}场地费已收` : "已收(按周期)"}</th>
              <th className="px-3 py-2.5 text-right font-medium">{rangeCycles.income ? `${rangeCycles.income}场地费未收` : "未收(按周期)"}</th>
              {dim === "landlord" && <th className="px-3 py-2.5 text-right font-medium">{rangeCycles.pay ? `${rangeCycles.pay}场地费已付` : "已付(按周期)"}</th>}
              {dim === "landlord" && <th className="px-3 py-2.5 text-right font-medium">{rangeCycles.pay ? `${rangeCycles.pay}场地费应付` : "未付(按周期)"}</th>}
            </tr>
          </thead>
          <tbody>
            {months.length === 0 && (
              <tr><td colSpan={dim === "landlord" ? 10 : 6} className="px-3 py-8 text-center text-slate-400">
                {q.isLoading ? "加载中…" : "请选择有效的月份区间"}
              </td></tr>
            )}
            {months.map((m) => {
              const mt = m.totals ?? {};
              const cyc = monthCyclePrefixes(m.rows ?? []);
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
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{fmtMoney(mt.collectedAmount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-amber-600">{fmtMoney(mt.uncollectedAmount)}</td>
                    {dim === "landlord" && <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmtMoney(mt.paidAmount)}</td>}
                    {dim === "landlord" && <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{fmtMoney(mt.unpaidAmount)}</td>}
                  </tr>
                  {mOpen && (
                    <tr className="border-b bg-slate-50/40">
                      <td colSpan={dim === "landlord" ? 10 : 6} className="px-6 py-3">
                        <div className="space-y-3">
                          <div className="text-[11px] font-medium text-slate-400">
                            {toDisplay(m.period)} · 按{dim === "landlord" ? "场地方" : "品牌方"}明细（点击卡片展开合同：付款/收款信息）
                          </div>
                          {(dim === "landlord"
                            ? groupByEntity(m.rows ?? [])
                            : [{ entityName: "", color: null, rows: m.rows ?? [] }]
                          ).map((grp: any, gi: number) => (
                            <div key={`grp-${m.period}-${gi}`} className={dim === "landlord" ? "space-y-1.5 rounded-lg border border-indigo-100 bg-indigo-50/30 p-2" : "space-y-1.5"}>
                              {dim === "landlord" && (
                                <div className="flex items-center gap-2 px-1">
                                  <span className="text-[11px] font-semibold text-indigo-700">公司主体：{grp.entityName}</span>
                                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{grp.rows.length} 个场地方</span>
                                </div>
                              )}
                              {(grp.rows ?? []).length > 0 && (
                              <div className="overflow-x-auto rounded-lg border bg-white">
                              <table className="w-full min-w-[640px] text-[11px]">
                                <thead>
                                  <tr className="border-b bg-slate-100 text-left text-[10px] text-slate-500">
                                    <th className="w-72 px-2 py-1">{dim === "landlord" ? "场地方" : "品牌方"}</th>
                                    <th className="px-2 py-1 text-right">场地费收入(月)</th>
                                    {dim === "landlord" && <th className="px-2 py-1 text-right">场地费成本(月)</th>}
                                    <th className="px-2 py-1 text-right">税费(月)</th>
                                    <th className="px-2 py-1 text-right">利润(月)</th>
                                    <th className="px-2 py-1 text-right">{cyc.income ? `${cyc.income}场地费已收` : "已收(按周期)"}</th>
                                    <th className="px-2 py-1 text-right">{cyc.income ? `${cyc.income}场地费未收` : "未收(按周期)"}</th>
                                    {dim === "landlord" && <th className="px-2 py-1 text-right">{cyc.pay ? `${cyc.pay}场地费已付` : "已付(按周期)"}</th>}
                                    {dim === "landlord" && <th className="px-2 py-1 text-right">{cyc.pay ? `${cyc.pay}场地费应付` : "未付(按周期)"}</th>}
                                  </tr>
                                </thead>
                                <tbody>
                                  {(grp.rows ?? []).map((g: any) => {
                                    const tags = rowCyclePrefixes(g.contracts);
                                    return (
                                    <tr key={g.key} className="border-b last:border-0">
                                      <td className="px-2 py-1.5 font-medium text-slate-700">{g.name}</td>
                                      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(g.rentIncome)}</td>
                                      {dim === "landlord" && <td className="px-2 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(g.rentCost)}</td>}
                                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{fmtMoney(g.rentTax)}</td>
                                      <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-700">{fmtMoney(g.rentProfit)}</td>
                                      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">
                                        {!cyc.income && tags.income && <span className="mr-1 text-[9px] text-slate-400">{tags.income}</span>}
                                        {fmtMoney(g.collectedAmount)}
                                      </td>
                                      <td className="px-2 py-1.5 text-right tabular-nums text-amber-600">
                                        {!cyc.income && tags.income && <span className="mr-1 text-[9px] text-slate-400">{tags.income}</span>}
                                        {fmtMoney(g.uncollectedAmount)}
                                      </td>
                                      {dim === "landlord" && <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                                        {!cyc.pay && tags.pay && <span className="mr-1 text-[9px] text-slate-400">{tags.pay}</span>}
                                        {fmtMoney(g.paidAmount)}
                                      </td>}
                                      {dim === "landlord" && <td className="px-2 py-1.5 text-right tabular-nums text-rose-600">
                                        {!cyc.pay && tags.pay && <span className="mr-1 text-[9px] text-slate-400">{tags.pay}</span>}
                                        {fmtMoney(g.unpaidAmount)}
                                      </td>}
                                    </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                              </div>
                              )}
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
                <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{fmtMoney(totals.collectedAmount)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-amber-600">{fmtMoney(totals.uncollectedAmount)}</td>
                {dim === "landlord" && <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmtMoney(totals.paidAmount)}</td>}
                {dim === "landlord" && <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{fmtMoney(totals.unpaidAmount)}</td>}
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

      {/* ── 整年场地收支（页面末尾，默认收起，点击展开） ── */}
      {yearlyRows.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm">
          <button className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setYearlyOpen((o) => !o)}>
            {yearlyOpen ? <ChevronDown className="h-4 w-4 text-emerald-600" /> : <ChevronRight className="h-4 w-4 text-emerald-600" />}
            <Building2 className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-slate-700">整年场地收支（{yearLabel}）</h3>
            <span className="hidden text-[11px] text-slate-400 md:inline">付款信息=场地合同 · 收款信息=品牌方合同 · 按合同周期计算</span>
            <span className="ml-auto text-[11px] text-slate-400">{yearlyOpen ? "收起" : "展开"}</span>
          </button>
          {yearlyOpen && (
            <div className="border-t px-4 py-3">
              <YearlyTable yearlyRows={yearlyRows} yearLabels={yearLabels} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
