import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listPaymentSchedules, listIncomeSchedules, updateSchedule, createSchedule } from "@/api/contracts";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/fields";
import { fmtMoney } from "@/lib/format";
import { toast } from "sonner";

/**
 * 合同收付款分期列表（按 pay_method 拆期）
 * editable=true：可手动标记每期状态 + 手动添加一期
 * editable=false：只读展示
 */
export function ContractSchedule({ contractId, side, title, editable = true }: {
  contractId: number;
  side: "payment" | "income";
  title: string;
  editable?: boolean;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ periodStart: "", periodEnd: "", amount: "", remark: "" });
  const [markingId, setMarkingId] = useState<number | null>(null);
  const [markDate, setMarkDate] = useState("");
  const fetchFn = side === "payment" ? listPaymentSchedules : listIncomeSchedules;
  const queryKey = side === "payment" ? "paymentSchedules" : "incomeSchedules";
  const { data: schedules } = useQuery({
    queryKey: [queryKey, contractId],
    queryFn: () => fetchFn(contractId),
  });

  const doneStatus = side === "payment" ? "已付款" : "已到账";
  const undoneStatus = side === "payment" ? "未付款" : "未到账";
  const markDone = useMutation({
    mutationFn: ({ id, payDate, status }: { id: number; payDate: string; status?: string }) =>
      updateSchedule(id, { status: status ?? doneStatus, payDate, side }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKey] });
      toast.success(side === "payment" ? "已标记付款" : "已标记到账");
      setMarkingId(null);
      setMarkDate("");
    },
    onError: (e: any) => toast.error(e.message || "操作失败"),
  });

  const addOne = useMutation({
    mutationFn: () => createSchedule({
      contractId,
      side,
      periodStart: addForm.periodStart || undefined,
      periodEnd: addForm.periodEnd || undefined,
      amount: addForm.amount ? Number(addForm.amount) : undefined,
      remark: addForm.remark || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKey] });
      toast.success("已添加分期");
      setAdding(false);
      setAddForm({ periodStart: "", periodEnd: "", amount: "", remark: "" });
    },
    onError: (e: any) => toast.error(e.message || "添加失败"),
  });

  const rows = schedules ?? [];
  const paidCount = rows.filter((r: any) => r.status === doneStatus).length;

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="flex items-center justify-between bg-slate-50 px-3 py-1.5 border-b">
        <span className="text-[11px] font-semibold text-slate-600">{title}</span>
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <span className="text-[10px] text-slate-500">{paidCount}/{rows.length} 期已{side === "payment" ? "付" : "收"}</span>
          )}
          {editable && (
            <button
              onClick={() => { setAdding(!adding); setAddForm({ periodStart: "", periodEnd: "", amount: "", remark: "" }); }}
              className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-emerald-700"
            >
              + 添加一期
            </button>
          )}
        </div>
      </div>

      {/* 添加一期表单（仅编辑模式） */}
      {editable && adding && (
        <div className="flex flex-wrap items-end gap-2 border-b bg-slate-50/50 px-3 py-2">
          <div>
            <label className="mb-0.5 block text-[10px] text-slate-400">区间起</label>
            <input type="date" className={inputCls + " w-32 text-xs"} value={addForm.periodStart} onChange={(e) => setAddForm((p) => ({ ...p, periodStart: e.target.value }))} />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] text-slate-400">区间止</label>
            <input type="date" className={inputCls + " w-32 text-xs"} value={addForm.periodEnd} onChange={(e) => setAddForm((p) => ({ ...p, periodEnd: e.target.value }))} />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] text-slate-400">金额</label>
            <input type="number" className={inputCls + " w-24 text-xs"} value={addForm.amount} onChange={(e) => setAddForm((p) => ({ ...p, amount: e.target.value }))} />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] text-slate-400">备注</label>
            <input className={inputCls + " w-32 text-xs"} value={addForm.remark} onChange={(e) => setAddForm((p) => ({ ...p, remark: e.target.value }))} />
          </div>
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-[11px] h-7 px-3" disabled={addOne.isPending} onClick={() => addOne.mutate()}>
            保存
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="py-3 text-center text-xs text-slate-400">{editable ? "暂无分期，点「添加一期」补录" : "暂无分期"}</div>
      ) : (
      <div className="max-h-52 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-slate-50/50 text-left text-slate-500">
              <th className="px-2.5 py-1.5 font-medium">期</th>
              <th className="px-2.5 py-1.5 font-medium">区间</th>
              <th className="px-2.5 py-1.5 text-right font-medium">金额</th>
              <th className="px-2.5 py-1.5 font-medium">状态</th>
              {editable && <th className="px-2.5 py-1.5 text-center font-medium">操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => {
              const done = r.status === doneStatus;
              return (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="px-2.5 py-1.5 text-slate-500">{r.seq}</td>
                  <td className="px-2.5 py-1.5 text-slate-600 whitespace-nowrap">
                    {r.periodStart ? String(r.periodStart).slice(0, 10) : "-"} ~ {r.periodEnd ? String(r.periodEnd).slice(0, 10) : "-"}
                  </td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtMoney(r.amount)}</td>
                  <td className="px-2.5 py-1.5">
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                      {r.status}
                    </span>
                    {done && r.payDate && (
                      <span className="ml-1 text-[10px] text-slate-400">{String(r.payDate).slice(0, 10)}</span>
                    )}
                  </td>
                  {editable && (
                    <td className="px-2.5 py-1.5 text-center">
                      {markingId === r.id ? (
                        <div className="flex items-center justify-center gap-1">
                          <input
                            type="date"
                            className={inputCls + " w-32 text-xs"}
                            value={markDate}
                            onChange={(e) => setMarkDate(e.target.value)}
                          />
                          <button
                            onClick={() => {
                              if (!markDate) { toast.error("请选择日期"); return; }
                              markDone.mutate({ id: r.id, payDate: markDate, status: doneStatus });
                            }}
                            disabled={markDone.isPending}
                            className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-emerald-700 disabled:opacity-50"
                          >保存</button>
                          {done && (
                            <button
                              onClick={() => markDone.mutate({ id: r.id, payDate: markDate, status: undoneStatus })}
                              disabled={markDone.isPending}
                              className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 hover:bg-amber-100 disabled:opacity-50"
                            >撤销</button>
                          )}
                          <button
                            onClick={() => { setMarkingId(null); setMarkDate(""); }}
                            className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-300"
                          >取消</button>
                        </div>
                      ) : done ? (
                        <div className="flex items-center justify-center gap-1">
                          <span className="text-[10px] text-emerald-600">{doneStatus}</span>
                          <button
                            onClick={() => { setMarkingId(r.id); setMarkDate(r.payDate || new Date().toISOString().slice(0, 10)); }}
                            className="rounded px-1 text-[10px] text-rose-600 hover:text-rose-700"
                          >修改</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setMarkingId(r.id); setMarkDate(new Date().toISOString().slice(0, 10)); }}
                          className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-blue-700"
                        >
                          {side === "payment" ? "标记付款" : "标记到账"}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
