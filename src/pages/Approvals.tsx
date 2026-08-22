import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listApprovals, createApproval, actOnApproval, getApprovalStats, listFlows, getApproval } from "@/api/approvals";
import { calculateDividend } from "@/api/dividends";
import { StatCard, Money, StatusBadge } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, NumInput, TextInput, SelectInput, inputCls } from "@/components/fields";
import { exportXlsx } from "@/lib/export";
import { fmtMoney, fmtDateTime, numOrNull, strOrNull } from "@/lib/format";
import {
  Plus, FileCheck2, Clock, CheckCircle2, XCircle, Download, Bell,
  ChevronDown, ChevronRight, Check, X, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";

// ─── 审批操作弹窗 ───
function ActDialog(props: {
  open: boolean; onClose: () => void; req: any | null;
  action: "通过" | "驳回" | "转办" | "加签"; approver: string;
}) {
  const [comment, setComment] = useState("");
  const [target, setTarget] = useState("");
  const [extraName, setExtraName] = useState("加签审批");
  const [extraApprover, setExtraApprover] = useState("");
  const queryClient = useQueryClient();

  const act = useMutation({
    mutationFn: (data: any) => actOnApproval(props.req?.id, data),
    onSuccess: () => {
      toast.success(`${props.action}成功`);
      queryClient.invalidateQueries();
      setComment(""); setTarget(""); setExtraApprover("");
      props.onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const submit = () => {
    if (!props.req) return;
    if (props.action === "转办" && !target.trim()) { toast.error("请填写转办人"); return; }
    if (props.action === "加签" && !extraApprover.trim()) { toast.error("请填写加签人"); return; }
    act.mutate({
      action: props.action, approver: props.approver,
      comment: strOrNull(comment),
      targetApprover: props.action === "转办" ? target.trim() : undefined,
      extraNode: props.action === "加签" ? { name: extraName.trim() || "加签审批", approver: extraApprover.trim() } : undefined,
    });
  };

  const tone = props.action === "通过" ? "bg-emerald-600 hover:bg-emerald-700" : props.action === "驳回" ? "bg-rose-600 hover:bg-rose-700" : "bg-slate-700 hover:bg-slate-800";

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{props.action} · {props.req?.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {props.action === "转办" && (
            <Field label="转办给 *"><TextInput value={target} onChange={setTarget} placeholder="新审批人姓名" /></Field>
          )}
          {props.action === "加签" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="节点名称"><TextInput value={extraName} onChange={setExtraName} /></Field>
              <Field label="加签人 *"><TextInput value={extraApprover} onChange={setExtraApprover} /></Field>
            </div>
          )}
          <Field label="审批意见">
            <textarea className={`${inputCls} w-full`} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="可填写审批意见…" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={props.onClose}>取消</Button>
            <Button className={tone} disabled={act.isPending} onClick={submit}>确认{props.action}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── 审批流程可视化 ───
function FlowTimeline({ flowNodes, records, status, currentNode }: { flowNodes: any[]; records: any[]; status: string; currentNode: number }) {
  return (
    <div className="space-y-0">
      {flowNodes.map((node: any, i: number) => {
        const record = records?.find((r: any) => r.node_index === i && r.action !== "提交");
        const submitRecord = records?.find((r: any) => r.node_index === i && r.action === "提交");
        const isCompleted = i < currentNode || (status === "已通过");
        const isCurrent = i === currentNode && status === "审批中";
        const isRejected = records?.some((r: any) => r.action === "驳回" && r.node_index === i);

        return (
          <div key={i} className="flex gap-3">
            {/* 时间线节点 */}
            <div className="flex flex-col items-center">
              <div className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold ${
                isRejected ? "bg-rose-100 text-rose-600 border-2 border-rose-300" :
                isCompleted ? "bg-emerald-100 text-emerald-600 border-2 border-emerald-300" :
                isCurrent ? "bg-blue-100 text-blue-600 border-2 border-blue-400 animate-pulse" :
                "bg-slate-100 text-slate-400 border-2 border-slate-200"
              }`}>
                {isRejected ? <X className="h-3.5 w-3.5" /> :
                 isCompleted ? <Check className="h-3.5 w-3.5" /> :
                 isCurrent ? <ArrowRight className="h-3.5 w-3.5" /> :
                 <span>{i + 1}</span>}
              </div>
              {i < flowNodes.length - 1 && (
                <div className={`w-0.5 h-8 ${isCompleted ? "bg-emerald-300" : "bg-slate-200"}`} />
              )}
            </div>
            {/* 节点内容 */}
            <div className="flex-1 pb-4">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold ${isCurrent ? "text-blue-700" : isCompleted ? "text-emerald-700" : "text-slate-500"}`}>
                  {node.name}
                </span>
                <span className="text-[10px] text-slate-400">审批人: {node.approver}</span>
              </div>
              {submitRecord && i === 0 && (
                <div className="mt-1 text-[10px] text-slate-500">
                  <span className="text-slate-400">{submitRecord.approver}</span> 提交于 {fmtDateTime(submitRecord.createdAt)}
                  {submitRecord.comment && <span className="ml-1 text-slate-400">· "{submitRecord.comment}"</span>}
                </div>
              )}
              {record && (
                <div className="mt-1 text-[10px]">
                  <span className={record.action === "通过" ? "text-emerald-600" : record.action === "驳回" ? "text-rose-600" : "text-slate-600"}>
                    {record.approver} {record.action}
                  </span>
                  <span className="text-slate-400 ml-1">{fmtDateTime(record.createdAt)}</span>
                  {record.comment && <span className="ml-1 text-slate-400">· "{record.comment}"</span>}
                </div>
              )}
              {isCurrent && !record && (
                <div className="mt-1 text-[10px] text-blue-500">等待审批…</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── 费用审批详情（电费/场地费；v3：按场地）───
function StationApprovalDetail({ req }: { req: any }) {
  // 从 reason 中解析明细信息（如果有的话）
  const reason = req.reason || "";

  return (
    <div className="space-y-3">
      {/* 基本信息 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-slate-50 px-3 py-2">
          <div className="text-[10px] text-slate-400">场地</div>
          <div className="text-xs font-semibold text-slate-700">{req.landlordName || req.stationName || `场地#${req.landlordId}`}</div>
        </div>
        <div className="rounded-lg border bg-slate-50 px-3 py-2">
          <div className="text-[10px] text-slate-400">费用月份</div>
          <div className="text-xs font-semibold text-slate-700">{req.period || "-"}</div>
        </div>
        <div className="rounded-lg border bg-blue-50 px-3 py-2">
          <div className="text-[10px] text-blue-500">审批总金额</div>
          <div className="text-sm font-bold text-blue-700 tabular-nums">{fmtMoney(req.amount)}</div>
        </div>
      </div>

      {/* 费用类型标签 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">审批类型：</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          req.bizType === "电费付款" ? "bg-amber-100 text-amber-700" :
          req.bizType === "场地费付款" ? "bg-orange-100 text-orange-700" :
          "bg-blue-100 text-blue-700"
        }`}>
          {req.bizType}
        </span>
      </div>

      {/* 费用构成明细 */}
      {(req.electricityAmount || req.rentAmount) && (
        <div className="rounded-lg border overflow-hidden">
          <div className="bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600 border-b">费用构成</div>
          <div className="p-3 space-y-2">
            {req.electricityAmount && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-amber-400"></div>
                  <span className="text-xs text-slate-600">电费成本</span>
                </div>
                <span className="text-xs font-semibold text-rose-600 tabular-nums">{fmtMoney(req.electricityAmount)}</span>
              </div>
            )}
            {req.rentAmount && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-orange-400"></div>
                  <span className="text-xs text-slate-600">场地租金</span>
                </div>
                <span className="text-xs font-semibold text-rose-600 tabular-nums">{fmtMoney(req.rentAmount)}</span>
              </div>
            )}
            <div className="border-t pt-2 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700">合计</span>
              <span className="text-sm font-bold text-blue-600 tabular-nums">{fmtMoney(req.amount)}</span>
            </div>
          </div>
        </div>
      )}

      {/* 详细说明 */}
      {reason && (
        <div className="rounded-lg border bg-white px-3 py-2">
          <div className="text-[10px] text-slate-400 mb-1">详细说明</div>
          <div className="text-xs text-slate-600 whitespace-pre-wrap">{reason}</div>
        </div>
      )}
    </div>
  );
}

// ─── 分红审批详情（v3：按场地 landlordId）───
function DividendDetail({ req }: { req: any }) {
  const { data: dividendPreview, isLoading } = useQuery({
    queryKey: ["dividendPreview", req.landlordId, req.dividendPeriod],
    queryFn: async () => {
      try {
        return await calculateDividend({ landlordId: req.landlordId, period: req.dividendPeriod });
      } catch {
        return null;
      }
    },
    enabled: !!req.landlordId && !!req.dividendPeriod,
  });

  if (isLoading) return <div className="py-4 text-center text-xs text-slate-400">加载分红数据中…</div>;

  return (
    <div className="space-y-3">
      {/* 基本信息 */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg border bg-slate-50 px-3 py-2">
          <div className="text-[10px] text-slate-400">场地</div>
          <div className="text-xs font-semibold text-slate-700">{req.landlordName || `场地#${req.landlordId}`}</div>
        </div>
        <div className="rounded-lg border bg-slate-50 px-3 py-2">
          <div className="text-[10px] text-slate-400">分红月份</div>
          <div className="text-xs font-semibold text-slate-700">{req.dividendPeriod}</div>
        </div>
        <div className="rounded-lg border bg-blue-50 px-3 py-2">
          <div className="text-[10px] text-blue-500">分红金额</div>
          <div className="text-xs font-semibold text-blue-700 tabular-nums">{fmtMoney(req.amount)}</div>
        </div>
        <div className="rounded-lg border bg-slate-50 px-3 py-2">
          <div className="text-[10px] text-slate-400">分红对象</div>
          <div className="text-xs font-semibold text-slate-700">
            {dividendPreview ? (
              <div className="space-y-0.5">
                {dividendPreview.shareholderDividends?.map((d: any, i: number) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="inline-block rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] text-blue-700">股东</span>
                    <span>{d.shareholderName} <span className="text-blue-600 tabular-nums">{fmtMoney(d.amount)}</span></span>
                  </div>
                ))}
                {dividendPreview.bizDividends?.map((d: any, i: number) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="inline-block rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] text-purple-700">商务</span>
                    <span>{d.introducerName} <span className="text-purple-600 tabular-nums">{fmtMoney(d.amount)}</span></span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-slate-400">-</span>
            )}
          </div>
        </div>
      </div>

      {/* 经营数据明细 */}
      {dividendPreview && (
        <>
          {/* 收入构成 */}
          <div className="rounded-lg border bg-white overflow-hidden">
            <div className="px-3 py-1.5 text-[11px] font-semibold text-emerald-600 bg-emerald-50/50 border-b">收入构成</div>
            <div className="p-3">
              <table className="w-full text-xs">
                <tbody>
                  <tr className="border-b">
                    <td className="py-1 text-slate-500">电费收入</td>
                    <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.income?.elecIncome?.total || 0)}</td>
                  </tr>
                  {dividendPreview.income?.elecIncome?.details?.map((d: any, i: number) => (
                    <tr key={i} className="text-[10px]">
                      <td className="py-0.5 pl-4 text-slate-400">{d.meterNo}（{d.brandName}）{d.kwh}度 × {d.unitPrice}元/度</td>
                      <td className="py-0.5 text-right tabular-nums text-slate-500">{fmtMoney(d.amount)}</td>
                    </tr>
                  ))}
                  <tr className="border-b">
                    <td className="py-1 text-slate-500">租金收入（品牌方合同）</td>
                    <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.income?.rentIncome?.total || 0)}</td>
                  </tr>
                  {dividendPreview.income?.rentIncome?.details?.map((d: any, i: number) => (
                    <tr key={i} className="text-[10px]">
                      <td className="py-0.5 pl-4 text-slate-400">{d.brandName} {d.cabinets}柜 × {fmtMoney(d.unitMonthlyRent)}/柜</td>
                      <td className="py-0.5 text-right tabular-nums text-slate-500">{fmtMoney(d.amount)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-1 text-slate-700">总收入</td>
                    <td className="py-1 text-right tabular-nums text-emerald-600">{fmtMoney(dividendPreview.income?.totalIncome || 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* 成本构成 */}
          <div className="rounded-lg border bg-white overflow-hidden">
            <div className="px-3 py-1.5 text-[11px] font-semibold text-rose-600 bg-rose-50/50 border-b">成本构成</div>
            <div className="p-3">
              <table className="w-full text-xs">
                <tbody>
                  <tr className="border-b">
                    <td className="py-1 text-slate-500">电费成本</td>
                    <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.elecCost || 0)}</td>
                  </tr>
                  {dividendPreview.cost?.details?.electricity?.map((d: any, i: number) => (
                    <tr key={i} className="text-[10px]">
                      <td className="py-0.5 pl-4 text-slate-400">{d.meterNo} {d.kwh}度 × {d.unitPrice}元/度</td>
                      <td className="py-0.5 text-right tabular-nums text-slate-500">{fmtMoney(d.amount)}</td>
                    </tr>
                  ))}
                  <tr className="border-b">
                    <td className="py-1 text-slate-500">场地租金</td>
                    <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.rentCost || 0)}</td>
                  </tr>
                  {dividendPreview.cost?.details?.rent?.map((d: any, i: number) => (
                    <tr key={i} className="text-[10px]">
                      <td className="py-0.5 pl-4 text-slate-400">{d.landlordName}</td>
                      <td className="py-0.5 text-right tabular-nums text-slate-500">{fmtMoney(d.monthlyRent)}</td>
                    </tr>
                  ))}
                  <tr className="border-b">
                    <td className="py-1 text-slate-500">运营费用</td>
                    <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.opExpense || 0)}</td>
                  </tr>
                  {dividendPreview.cost?.bizDividendCost > 0 && (
                    <tr className="border-b">
                      <td className="py-1 text-slate-500">商务分红（计入成本）</td>
                      <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost.bizDividendCost)}</td>
                    </tr>
                  )}
                  <tr className="font-semibold">
                    <td className="py-1 text-slate-700">总成本</td>
                    <td className="py-1 text-right tabular-nums text-rose-600">{fmtMoney(dividendPreview.cost?.totalCost || 0)}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-1 text-slate-500">电费税费</td>
                    <td className="py-1 text-right tabular-nums text-slate-500">{fmtMoney(dividendPreview.cost?.elecTax || 0)}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-1 text-slate-500">租金税费</td>
                    <td className="py-1 text-right tabular-nums text-slate-500">{fmtMoney(dividendPreview.cost?.rentTax || 0)}</td>
                  </tr>
                  <tr>
                    <td colSpan={2} className="py-1 text-[10px] text-slate-400">税费单独核算展示，不参与净利润（避免与不含税收入双扣）</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* 利润与分红明细 */}
          <div className="rounded-lg border bg-white overflow-hidden">
            <div className="px-3 py-1.5 text-[11px] font-semibold text-blue-600 bg-blue-50/50 border-b">分红明细</div>
            <div className="p-3 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">净利润</span>
                <span className={`font-semibold tabular-nums ${(dividendPreview.profit || 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(dividendPreview.profit || 0)}</span>
              </div>

              {dividendPreview.shareholderDividends?.length > 0 && (
                <div className="border-t pt-2">
                  <div className="text-[10px] font-semibold text-slate-500 mb-1">股东分红：</div>
                  {dividendPreview.shareholderDividends.map((d: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-[11px] py-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-600">{d.shareholderName}</span>
                        <span className="text-[10px] text-slate-400">
                          {d.mode === "收入分红" ? `总收入 × ${(d.ratio * 100).toFixed(1)}%` :
                           d.mode === "利润分红" ? `净利润 × ${(d.ratio * 100).toFixed(1)}%` :
                           `固定 ${fmtMoney(d.fixedAmount)}`}
                        </span>
                      </div>
                      <span className="font-medium tabular-nums text-blue-600">{fmtMoney(d.amount)}</span>
                    </div>
                  ))}
                </div>
              )}

              {dividendPreview.bizDividends?.length > 0 && (
                <div className="border-t pt-2">
                  <div className="text-[10px] font-semibold text-slate-500 mb-1">商务分红：</div>
                  {dividendPreview.bizDividends.map((d: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-[11px] py-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-600">{d.introducerName}</span>
                        <span className="text-[10px] text-slate-400">
                          {d.mode === "收入分红" ? `总收入 × ${(d.ratio * 100).toFixed(1)}%` :
                           d.mode === "利润分红" ? `净利润 × ${(d.ratio * 100).toFixed(1)}%` :
                           `固定 ${fmtMoney(d.fixedAmount)}`}
                          {d.countAsCost && " · 计入成本"}
                        </span>
                      </div>
                      <span className="font-medium tabular-nums text-purple-600">{fmtMoney(d.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {!dividendPreview && (
        <div className="rounded-lg border bg-slate-50 p-4 text-center text-xs text-slate-400">
          无法加载分红计算明细
        </div>
      )}
    </div>
  );
}

// ─── 审批详情展开内容 ───
function ApprovalDetail({ req }: { req: any }) {
  const { data: detail, isLoading } = useQuery({
    queryKey: ["approvalDetail", req.id],
    queryFn: () => getApproval(req.id),
    enabled: !!req.id,
  });

  if (isLoading) return <div className="py-4 text-center text-xs text-slate-400">加载中…</div>;

  const flowNodes = detail?.flow_nodes || req.flow_nodes || [];
  const records = detail?.records || req.records || [];

  return (
    <div className="space-y-4">
      {/* 基本信息 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-lg border bg-white px-3 py-2">
          <div className="text-[10px] text-slate-400">审批编号</div>
          <div className="text-xs font-semibold text-slate-700">AP-{String(req.id).padStart(5, "0")}</div>
        </div>
        <div className="rounded-lg border bg-white px-3 py-2">
          <div className="text-[10px] text-slate-400">业务类型</div>
          <div className="text-xs font-semibold text-slate-700">{req.bizType}</div>
        </div>
        <div className="rounded-lg border bg-white px-3 py-2">
          <div className="text-[10px] text-slate-400">申请人</div>
          <div className="text-xs font-semibold text-slate-700">{req.applicant}</div>
        </div>
        <div className="rounded-lg border bg-white px-3 py-2">
          <div className="text-[10px] text-slate-400">申请时间</div>
          <div className="text-xs font-semibold text-slate-700">{fmtDateTime(req.createdAt)}</div>
        </div>
        {req.amount && (
          <div className="rounded-lg border bg-blue-50 px-3 py-2">
            <div className="text-[10px] text-blue-500">审批金额</div>
            <div className="text-sm font-bold text-blue-700 tabular-nums">{fmtMoney(req.amount)}</div>
          </div>
        )}
        <div className="rounded-lg border bg-white px-3 py-2 col-span-2">
          <div className="text-[10px] text-slate-400">审批事由</div>
          <div className="text-xs font-medium text-slate-700">{req.title}</div>
        </div>
        {req.reason && (
          <div className="rounded-lg border bg-white px-3 py-2 col-span-2">
            <div className="text-[10px] text-slate-400">事由说明</div>
            <div className="text-xs text-slate-600 whitespace-pre-wrap">{req.reason}</div>
          </div>
        )}
      </div>

      {/* 费用审批详情（电费/场地费） */}
      {(req.bizType === "电费付款" || req.bizType === "场地费付款" || req.bizType === "电费+场地费") && (
        <StationApprovalDetail req={req} />
      )}

      {/* 分红审批特有详情 */}
      {req.bizType === "分红审批" && req.dividendRecordId && (
        <DividendDetail req={req} />
      )}

      {/* 审批流程 */}
      <div className="rounded-lg border bg-white overflow-hidden">
        <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-600 bg-slate-50 border-b">审批流程</div>
        <div className="p-3">
          <FlowTimeline flowNodes={flowNodes} records={records} status={req.status} currentNode={req.currentNode} />
        </div>
      </div>
    </div>
  );
}

// ─── 主页面 ───
export default function Approvals() {
  const [tab, setTab] = useState<"submit" | "todo" | "ledger">("todo");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const stats = useQuery({ queryKey: ["approvalStats"], queryFn: getApprovalStats });
  const flows = useQuery({ queryKey: ["approvalFlows"], queryFn: listFlows });

  // 提交表单
  const blank = { bizType: "电费付款", title: "", amount: "", applicant: "", reason: "", attachmentNames: "" };
  const [form, setForm] = useState(blank);
  const create = useMutation({
    mutationFn: createApproval,
    onSuccess: () => { toast.success("审批单已提交"); setForm(blank); queryClient.invalidateQueries(); setTab("todo"); },
    onError: (e: any) => toast.error(e.message),
  });

  // 台账筛选
  const [filter, setFilter] = useState({ bizType: "", status: "", applicant: "" });
  const list = useQuery({
    queryKey: ["approvals", filter],
    queryFn: () => listApprovals({
      bizType: filter.bizType || undefined,
      status: filter.status || undefined,
      applicant: filter.applicant || undefined,
    }),
  });
  const todoList = useQuery({
    queryKey: ["approvals", "todo"],
    queryFn: () => listApprovals({ status: "审批中" }),
  });

  // 操作弹窗
  const [actState, setActState] = useState<{ req: any; action: "通过" | "驳回" | "转办" | "加签" } | null>(null);
  const [operator, setOperator] = useState("陈总");
  const urge = useMutation({
    mutationFn: (data: any) => actOnApproval(data.requestId, data),
    onSuccess: () => { toast.success("已催办"); queryClient.invalidateQueries(); },
  });

  const doExport = () => {
    const rows = list.data ?? [];
    if (rows.length === 0) { toast.error("暂无数据可导出"); return; }
    exportXlsx(`审批台账_${new Date().toISOString().slice(0, 10)}`, [{
      name: "审批台账",
      rows: rows.map((r: any) => ({
        编号: `AP-${String(r.id).padStart(5, "0")}`, 业务类型: r.bizType, 审批事由: r.title,
        金额: r.amount ?? "", 申请人: r.applicant, 申请时间: fmtDateTime(r.createdAt, ""),
        状态: r.status,
      })),
    }]);
    toast.success("已导出 Excel");
  };

  const bizTypes = (flows.data ?? []).map((f: any) => f.bizType);

  const tabs = [
    { key: "todo", label: `待办审批` },
    { key: "submit", label: "提交审批" },
    { key: "ledger", label: "审批台账" },
  ] as const;

  const ReqTable = ({ rows, actionable }: { rows: any[]; actionable: boolean }) => (
    <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
      <table className="w-full min-w-[1000px] text-xs">
        <thead><tr className="border-b bg-slate-50 text-left text-slate-500">
          <th className="px-3 py-2.5 font-medium w-8"></th>
          <th className="px-3 py-2.5 font-medium">编号</th><th className="px-3 py-2.5 font-medium">类型</th>
          <th className="px-3 py-2.5 font-medium">审批事由</th><th className="px-3 py-2.5 text-right font-medium">金额</th>
          <th className="px-3 py-2.5 font-medium">申请人</th><th className="px-3 py-2.5 font-medium">申请时间</th>
          <th className="px-3 py-2.5 font-medium">状态</th><th className="px-3 py-2.5 text-center font-medium">操作</th>
        </tr></thead>
        <tbody>
          {rows.map((r: any) => {
            const isExpanded = expandedId === r.id;
            return (
              <>
                <tr key={r.id} className={`border-b hover:bg-slate-50/60 cursor-pointer ${isExpanded ? "bg-blue-50/30" : ""}`}
                  onClick={() => setExpandedId(isExpanded ? null : r.id)}>
                  <td className="px-3 py-2.5 text-center">
                    {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-300" />}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-slate-400">AP-{String(r.id).padStart(5, "0")}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.bizType === "分红审批" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>{r.bizType}</span>
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2.5 font-medium" title={r.title}>
                    {r.title}
                    {r.landlordName && <span className="ml-1 text-[10px] text-slate-400">({r.landlordName})</span>}
                    {!r.landlordName && r.stationName && <span className="ml-1 text-[10px] text-slate-400">({r.stationName})</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right"><Money v={r.amount} /></td>
                  <td className="px-3 py-2.5">{r.applicant}</td>
                  <td className="px-3 py-2.5 text-slate-500">{fmtDateTime(r.createdAt)}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={r.status} /></td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap justify-center gap-1">
                      {actionable && r.status === "审批中" && (
                        <>
                          <Button size="sm" className="h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700" onClick={() => setActState({ req: r, action: "通过" })}>通过</Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-rose-600" onClick={() => setActState({ req: r, action: "驳回" })}>驳回</Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-amber-600" title="催办"
                            onClick={() => urge.mutate({ requestId: r.id, action: "催办", approver: operator || "系统" })}>
                            <Bell className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={9} className="bg-slate-50/30 px-6 py-4">
                      <ApprovalDetail req={r} />
                    </td>
                  </tr>
                )}
              </>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={9} className="py-14 text-center text-slate-400">暂无审批单</td></tr>}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="待审批" value={`${stats.data?.pending ?? 0}`} icon={Clock} tone="amber" />
        <StatCard label="已通过" value={`${stats.data?.approved ?? 0}`} icon={CheckCircle2} tone="green" />
        <StatCard label="已驳回" value={`${stats.data?.rejected ?? 0}`} icon={XCircle} tone="red" />
        <StatCard label="累计审批单" value={`${stats.data?.total ?? 0}`} icon={FileCheck2} tone="blue" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border bg-white p-1">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`rounded-md px-4 py-1.5 text-sm ${tab === t.key ? "bg-emerald-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          当前操作人：
          <input className={`${inputCls} w-28`} value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="审批人姓名" />
        </div>
      </div>

      {tab === "todo" && <ReqTable rows={todoList.data ?? []} actionable />}

      {tab === "submit" && (
        <div className="max-w-3xl rounded-xl border bg-white p-6 shadow-sm">
          <div className="grid grid-cols-2 gap-4">
            <Field label="业务类型 *">
              <SelectInput value={form.bizType} onChange={(v) => setForm((p) => ({ ...p, bizType: v }))}
                options={bizTypes.map((b: string) => ({ value: b, label: b }))} />
            </Field>
            <Field label="申请人 *"><TextInput value={form.applicant} onChange={(v) => setForm((p) => ({ ...p, applicant: v }))} placeholder="经办人姓名" /></Field>
            <Field label="审批事由 *" span><TextInput value={form.title} onChange={(v) => setForm((p) => ({ ...p, title: v }))} placeholder="如：XX场地6月电费付款" /></Field>
            <Field label="金额（元）"><NumInput value={form.amount} onChange={(v) => setForm((p) => ({ ...p, amount: v }))} /></Field>
            <Field label="事由说明" span>
              <textarea className={`${inputCls} w-full`} rows={4} value={form.reason} onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))} placeholder="付款依据、合同条款、计算过程等…" />
            </Field>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-500">
            提交后按「{form.bizType}」配置的审批流程逐级流转
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={create.isPending}
              onClick={() => {
                if (!form.title.trim() || !form.applicant.trim()) { toast.error("请填写审批事由和申请人"); return; }
                create.mutate({
                  bizType: form.bizType, title: form.title.trim(), applicant: form.applicant.trim(),
                  amount: numOrNull(form.amount), reason: strOrNull(form.reason),
                });
              }}>
              <Plus className="mr-1.5 h-4 w-4" />提交审批
            </Button>
          </div>
        </div>
      )}

      {tab === "ledger" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select className={`${inputCls} w-32`} value={filter.bizType} onChange={(e) => setFilter((p) => ({ ...p, bizType: e.target.value }))}>
              <option value="">全部类型</option>
              {bizTypes.map((b: string) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select className={`${inputCls} w-32`} value={filter.status} onChange={(e) => setFilter((p) => ({ ...p, status: e.target.value }))}>
              <option value="">全部状态</option>
              {["审批中", "已通过", "已驳回"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input className={`${inputCls} w-32`} placeholder="申请人" value={filter.applicant} onChange={(e) => setFilter((p) => ({ ...p, applicant: e.target.value }))} />
            <Button variant="outline" className="ml-auto" onClick={doExport}><Download className="mr-1.5 h-4 w-4" />导出 Excel</Button>
          </div>
          <ReqTable rows={list.data ?? []} actionable={false} />
        </div>
      )}

      <ActDialog open={actState !== null} onClose={() => setActState(null)}
        req={actState?.req ?? null} action={actState?.action ?? "通过"} approver={operator || "未指定"} />
    </div>
  );
}
