import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Landmark } from "lucide-react";
import { StatusBadge } from "@/components/Stat";
import { fmtMoney, fmtDate } from "@/lib/format";
import { groupByEntity } from "@/lib/groupColors";
import { handleContractAlert } from "@/api/alerts";
import { toast } from "sonner";

// ─── 合同预警卡片（应收/应付）：按公司主体分组，Alerts 页与首页共用 ───
// brief=false（默认）：完整模式，点击卡片展开分期明细，可「标记已处理」
// brief=true（首页）：概要模式，只显示关键徽章，点击整卡跳转 linkTo 查看详情
export function ContractAlertCard({ items, side, brief = false, linkTo = "/alerts?tab=contract" }: {
  items: any[]; side: "pay" | "income"; brief?: boolean; linkTo?: string;
}) {
  const queryClient = useQueryClient();
  // 标记已处理：记录当时的预警特征，特征未变化前不再提醒（出现新逾期/状态变化会再次预警）
  const handleAlert = useMutation({
    mutationFn: (contractId: number) => handleContractAlert(contractId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      toast.success("已标记为已处理；预警情况变化时会重新变为未处理");
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message || "操作失败"),
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (items.length === 0) {
    return <div className="rounded-xl border bg-white py-10 text-center text-sm text-slate-400">暂无{side === "pay" ? "应付" : "应收"}预警合同</div>;
  }

  const label = side === "pay" ? "应付" : "应收";
  const doneWord = side === "pay" ? "已付" : "已收";
  const pendingWord = side === "pay" ? "未付" : "未收";

  return (
    <div className="space-y-4">
      {groupByEntity(items).map((grp) => (
        <div key={grp.entityName} className={`space-y-3 rounded-xl border p-3 ${grp.color.border} ${grp.color.bg}`}>
          <div className="flex items-center gap-2 px-1">
            <div className={`flex h-6 w-6 items-center justify-center rounded-md ${grp.color.icon}`}>
              <Landmark className="h-3.5 w-3.5 text-white" />
            </div>
            <span className={`text-xs font-semibold ${grp.color.text}`}>{grp.entityName}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${grp.color.chip}`}>{grp.rows.length} 份预警合同</span>
          </div>
          {grp.rows.map((c: any) => {
        const open = expanded.has(c.contractId);
        const overdue = c.overdueCount > 0;
        const handled = c.handleStatus === "已处理";
        const statusBadge = c.status === "已到期" ? "已到期" : c.status === "临期" ? `临期(${c.daysLeft}天)` : "";
        return (
          <div key={c.contractId} className={`rounded-xl border bg-white shadow-sm overflow-hidden ${c.status === "已到期" ? "border-rose-200" : overdue ? "border-amber-200" : ""}`}>
            {/* 合同摘要（brief 模式：点击整卡跳转预警页查看详情） */}
            <div
              className={`cursor-pointer border-b bg-slate-50/60 px-4 py-3 ${brief ? "hover:bg-slate-100/70" : ""}`}
              onClick={() => { if (brief) { window.location.href = linkTo; } else { toggle(c.contractId); } }}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {!brief && <span className="text-slate-400">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>}
                <span className="font-semibold text-slate-800">
                  {c.landlordName || c.partner}
                </span>
                {side === "income" && (
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                    {c.brandName || "全品牌共享"}
                  </span>
                )}
                <span className="text-xs text-slate-500">{c.contractType}</span>
                {statusBadge && <StatusBadge status={statusBadge} />}
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${handled ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}
                  title={handled && c.handledAt ? `处理时间：${String(c.handledAt).slice(0, 16).replace("T", " ")}` : "待审核处理"}
                >
                  {handled ? "已处理" : "未处理"}
                </span>
                {overdue && (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                    ⚠ 逾期 {c.overdueCount} 期 {fmtMoney(c.overdueAmount)}
                  </span>
                )}
                {c.payMethod && <span className="text-[11px] text-slate-400">{c.payMethod}</span>}
                <span className="ml-auto text-[11px] text-slate-400">合同期 {fmtDate(c.startDate)} ~ {fmtDate(c.endDate)}</span>
                {!brief && !handled && (
                  <button
                    className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 disabled:opacity-50"
                    title="审核确认后标记为已处理；预警情况变化（新的逾期、临期→已到期）时会重新变为未处理"
                    disabled={handleAlert.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm("确认该合同预警已处理？\n标记后状态变为「已处理」，预警情况变化（如新的逾期分期）时会重新变为未处理。")) {
                        handleAlert.mutate(c.contractId);
                      }
                    }}
                  >
                    标记已处理
                  </button>
                )}
              </div>
              {!brief && (
              <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 pl-8 text-xs">
                <span className="text-slate-500">月租 <b className="text-slate-700">{fmtMoney(c.monthlyRent)}</b></span>
                <span className="text-slate-500">总{label} <b className="text-slate-700">{fmtMoney(c.totalAmount)}</b></span>
                <span className="text-emerald-600">{doneWord} <b>{fmtMoney(c.paidAmount)}</b>（{c.paidCount}/{c.totalCount}期）</span>
                <span className="text-rose-600">{pendingWord} <b>{fmtMoney(c.pendingAmount)}</b>（{c.pendingCount}期）</span>
                <span className="text-slate-400">收付率 {(c.paidRatio * 100).toFixed(0)}%</span>
                {c.landlordContact && <span className="text-slate-400">联系人 {c.landlordContact}{c.landlordPhone ? ` ${c.landlordPhone}` : ""}</span>}
                {c.brandContact && <span className="text-slate-400">联系人 {c.brandContact}</span>}
              </div>
              )}
            </div>

            {/* 分期明细（brief 模式不展开，点击跳转预警页查看） */}
            {!brief && open && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-[11px]">
                  <thead>
                    <tr className="border-b bg-slate-100 text-left text-[10px] text-slate-500">
                      <th className="px-3 py-1.5">期</th>
                      <th className="px-3 py-1.5">区间</th>
                      <th className="px-3 py-1.5 text-right">金额</th>
                      <th className="px-3 py-1.5">状态</th>
                      <th className="px-3 py-1.5">实收/付日期</th>
                      <th className="px-3 py-1.5">发票号</th>
                      <th className="px-3 py-1.5">备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(c.schedules ?? []).map((s: any) => {
                      const sDone = side === "pay" ? s.status === "已付款" : s.status === "已到账";
                      const sOverdue = !sDone && s.periodEnd && String(s.periodEnd) < new Date().toISOString().slice(0, 10);
                      return (
                        <tr key={s.seq} className={`border-b last:border-0 ${sOverdue ? "bg-rose-50/40" : sDone ? "" : "hover:bg-slate-50/50"}`}>
                          <td className="px-3 py-1.5 text-slate-500">#{s.seq}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">
                            {fmtDate(s.periodStart)} ~ {fmtDate(s.periodEnd)}
                            {sOverdue && <span className="ml-1.5 rounded bg-rose-100 px-1 py-0.5 text-[9px] text-rose-600">逾期</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-medium text-slate-700">{fmtMoney(s.amount)}</td>
                          <td className="px-3 py-1.5">
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${sDone ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                              {s.status || "—"}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 tabular-nums text-slate-500">{s.payDate ? fmtDate(s.payDate) : "—"}</td>
                          <td className="px-3 py-1.5 font-mono text-slate-500">{s.invoice || "—"}</td>
                          <td className="px-3 py-1.5 text-slate-400">{s.remark || ""}</td>
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
      ))}
    </div>
  );
}
