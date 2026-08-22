import { Fragment, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getStationBoard, getLandlordStationMonthly } from "@/api/overview";
import { getLandlordMeterView } from "@/api/stations";
import { submitStationApproval } from "@/api/approvals";
import { Money, StatusBadge } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, TextInput, SelectInput, inputCls } from "@/components/fields";
import { MonthPicker } from "@/components/MonthPicker";
import { fmtMoney, fmtNum, fmtDate } from "@/lib/format";
import * as XLSX from "xlsx";
import { Download, Search, ChevronDown, ChevronRight, ChevronLeft, MapPin, Gauge, ArrowLeft, Zap, Battery, Receipt, TrendingUp, Home, DollarSign, Activity, BarChart3, FileCheck2 } from "lucide-react";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell } from "recharts";

// ─── 信息行 ───
function InfoRow({ label, value }: { label: string; value: any }) {
  return (
    <div className="flex items-center gap-1">
      <span className="shrink-0 text-slate-400">{label}：</span>
      <span className="font-medium text-slate-700">{value ?? "-"}</span>
    </div>
  );
}

// ─── 区块卡片 ───
function SectionCard({ icon: Icon, title, color, children }: { icon: any; title: string; color: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-white">
      <div className={`flex items-center gap-1.5 border-b px-3 py-1.5 ${color}`}>
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold">{title}</span>
      </div>
      <div className="px-3 py-2">{children}</div>
    </div>
  );
}

// ─── 提交审核对话框（v3：按场地 landlordId）───
function SubmitApprovalDialog({ open, onClose, landlordId, landlordName, period, mv }: {
  open: boolean; onClose: () => void; landlordId: number; landlordName: string; period: string; mv: any;
}) {
  const queryClient = useQueryClient();
  const [approvalType, setApprovalType] = useState<"电费付款" | "场地费付款" | "电费+场地费">("电费+场地费");
  const [applicant, setApplicant] = useState("");
  const [reason, setReason] = useState("");

  const s = mv?.summary || {};
  const contractRent = mv?.contractRent || {};
  const brandGroups = mv?.brandGroups || [];

  // 计算电费金额
  const electricityAmount = s.totalPayAmount || 0;

  // 计算场地费金额
  const rentContracts = contractRent.cost || [];
  const rentAmount = rentContracts.reduce((sum: number, c: any) => sum + (c.monthlyRent || 0), 0);

  // 场地租金可提交审核的月份集合（后端按合同时间 + 付款方式 + 提前支付天数算出）
  const allowedRentMonths = useMemo(() => {
    const set = new Set<string>();
    rentContracts.forEach((c: any) => (c.allowedMonths || []).forEach((m: string) => set.add(m)));
    return [...set].sort();
  }, [rentContracts]);
  // 涉及场地费（含"电费+场地费"）时，所选月份必须是某份场地合同的付款月份
  const rentGateBlocks = rentContracts.length > 0 && approvalType !== "电费付款" && !allowedRentMonths.includes(period);

  // 根据选择计算总金额
  const totalAmount = approvalType === "电费付款" ? electricityAmount
    : approvalType === "场地费付款" ? rentAmount
    : electricityAmount + rentAmount;

  // 构建电费明细
  const electricityDetails: any[] = [];
  brandGroups.forEach((group: any) => {
    group.meters?.forEach((meter: any) => {
      if (meter.payAmount) {
        electricityDetails.push({
          brandName: group.brandName,
          meterNo: meter.meterNo,
          meterName: meter.meterName,
          payKwh: meter.payKwh,
          payUnitPrice: meter.payUnitPrice,
          payAmount: meter.payAmount,
        });
      }
    });
  });

  const save = useMutation({
    mutationFn: submitStationApproval,
    onSuccess: () => {
      toast.success("审批单已提交");
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message || "提交失败"),
  });

  const submit = () => {
    if (!applicant.trim()) { toast.error("请填写申请人"); return; }
    if (totalAmount <= 0) { toast.error("审批金额必须大于0"); return; }
    if (rentGateBlocks) {
      toast.error(`所选月份 ${period} 不在场地租金付款月份内。可提交月份：${allowedRentMonths.join("、") || "无"}`);
      return;
    }

    // 构建详细的审批理由
    let detailReason = reason || "";
    if (!detailReason) {
      const parts = [];
      if (approvalType !== "场地费付款" && electricityDetails.length > 0) {
        const meterList = electricityDetails.map(d => `${d.meterNo}(${fmtMoney(d.payAmount)})`).join("、");
        parts.push(`电费明细：${meterList}`);
      }
      if (approvalType !== "电费付款" && rentContracts.length > 0) {
        const contractList = rentContracts.map((c: any) => `${c.partner || "场地"}(${fmtMoney(c.monthlyRent)})`).join("、");
        parts.push(`场地费明细：${contractList}`);
      }
      detailReason = parts.join("；");
    }

    save.mutate({
      landlordId,
      landlordName,
      period,
      approvalType,
      electricityAmount: approvalType !== "场地费付款" ? electricityAmount : undefined,
      rentAmount: approvalType !== "电费付款" ? rentAmount : undefined,
      totalAmount,
      applicant: applicant.trim(),
      reason: detailReason,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCheck2 className="h-5 w-5 text-blue-600" />
            提交审核
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div>场地：<span className="font-medium">{landlordName}</span></div>
            <div>月份：<span className="font-medium">{period}</span></div>
          </div>

          <Field label="审批类型">
            <SelectInput value={approvalType} onChange={(v) => setApprovalType(v as any)}
              options={[
                { value: "电费+场地费", label: "电费 + 场地费" },
                { value: "电费付款", label: "仅电费" },
                { value: "场地费付款", label: "仅场地费" },
              ]} />
          </Field>

          {/* 电费明细 */}
          {(approvalType === "电费付款" || approvalType === "电费+场地费") && (
            <div className="rounded-lg border">
              <div className="flex items-center justify-between border-b bg-rose-50 px-3 py-1.5">
                <span className="text-xs font-semibold text-rose-700">电费成本明细</span>
                <span className="text-xs font-bold text-rose-600">{fmtMoney(electricityAmount)}</span>
              </div>
              <div className="px-3 py-2">
                {electricityDetails.length > 0 ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="pb-1 text-left font-medium">品牌/电表</th>
                        <th className="pb-1 text-right font-medium">度数</th>
                        <th className="pb-1 text-right font-medium">单价</th>
                        <th className="pb-1 text-right font-medium">金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {electricityDetails.map((d, i) => (
                        <tr key={i} className="border-t border-dashed">
                          <td className="py-1">
                            <div className="font-medium text-slate-700">{d.brandName}</div>
                            <div className="text-[10px] text-slate-400">{d.meterNo} {d.meterName || ""}</div>
                          </td>
                          <td className="py-1 text-right tabular-nums">{fmtNum(d.payKwh)}</td>
                          <td className="py-1 text-right tabular-nums">{d.payUnitPrice ? `${fmtNum(d.payUnitPrice)}元` : "-"}</td>
                          <td className="py-1 text-right font-medium text-rose-600 tabular-nums">{fmtMoney(d.payAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="py-2 text-center text-xs text-slate-400">暂无电费数据</div>
                )}
              </div>
            </div>
          )}

          {/* 场地费明细 */}
          {(approvalType === "场地费付款" || approvalType === "电费+场地费") && (
            <div className="rounded-lg border">
              <div className="flex items-center justify-between border-b bg-orange-50 px-3 py-1.5">
                <span className="text-xs font-semibold text-orange-700">场地费明细</span>
                <span className="text-xs font-bold text-orange-600">{fmtMoney(rentAmount)}</span>
              </div>
              {rentGateBlocks && (
                <div className="border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                  当前月份 {period} 不在场地租金付款月份内，无法提交场地费。可提交月份：{allowedRentMonths.join("、") || "无"}
                </div>
              )}
              <div className="px-3 py-2">
                {rentContracts.length > 0 ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="pb-1 text-left font-medium">场地方</th>
                        <th className="pb-1 text-right font-medium">年租金</th>
                        <th className="pb-1 text-right font-medium">月租金</th>
                        <th className="pb-1 text-right font-medium">付款方式</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rentContracts.map((c: any) => (
                        <tr key={c.id} className="border-t border-dashed">
                          <td className="py-1 font-medium text-slate-700">{c.partner || "-"}</td>
                          <td className="py-1 text-right tabular-nums">{c.annualRent ? fmtMoney(c.annualRent) : "-"}</td>
                          <td className="py-1 text-right font-medium text-orange-600 tabular-nums">{c.monthlyRent ? fmtMoney(c.monthlyRent) : "-"}</td>
                          <td className="py-1 text-right text-slate-500">{c.payMethod || "-"}{c.rentAdvanceDays ? `（提前${c.rentAdvanceDays}天）` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="py-2 text-center text-xs text-slate-400">暂无场地费数据</div>
                )}
              </div>
            </div>
          )}

          {/* 总计 */}
          <div className="rounded-lg border-2 border-blue-200 bg-blue-50 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-blue-800">审批总金额</span>
              <span className="text-lg font-bold text-blue-600">{fmtMoney(totalAmount)}</span>
            </div>
          </div>

          <Field label="申请人 *">
            <TextInput value={applicant} onChange={setApplicant} placeholder="请输入申请人姓名" />
          </Field>

          <Field label="备注">
            <textarea className={`${inputCls} w-full`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="可填写审批说明（不填则自动生成明细）…" />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button className="bg-blue-600 hover:bg-blue-700" disabled={save.isPending} onClick={submit}>
              {save.isPending ? "提交中…" : "提交审核"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── 场地方电表详情（v3：按场地 landlordId 查看全部电表，按品牌分组）───
function LandlordMeterDetail({ landlordId, period, onBack, landlordName }: { landlordId: number; period: string; onBack: () => void; landlordName?: string }) {
  const { data: mv, isLoading } = useQuery({
    queryKey: ["landlordMeterView", landlordId, period],
    queryFn: () => getLandlordMeterView(landlordId, period),
  });

  const [approvalOpen, setApprovalOpen] = useState(false);

  if (isLoading) return <div className="py-10 text-center text-slate-400">加载中…</div>;
  if (!mv) return <div className="py-10 text-center text-slate-400">加载失败</div>;

  const s = mv.summary || {};

  return (
    <div className="space-y-3">
      {/* 返回按钮 + 场地名 + 提交审核 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="flex items-center gap-1 text-xs text-slate-500 hover:text-emerald-600 transition-colors">
            <ArrowLeft className="h-3.5 w-3.5" />
            返回场地列表
          </button>
          <span className="text-sm font-semibold text-slate-800">{landlordName || mv.landlordName || `场地#${landlordId}`}</span>
          <span className="text-xs text-slate-400">· {period}</span>
        </div>
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => setApprovalOpen(true)}>
          <FileCheck2 className="mr-1 h-3.5 w-3.5" />提交审核
        </Button>
      </div>

      {/* 提交审核对话框 */}
      <SubmitApprovalDialog
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        landlordId={landlordId}
        landlordName={landlordName || mv.landlordName || `场地#${landlordId}`}
        period={period}
        mv={mv}
      />

      {/* 场地汇总数据 */}
      {s.totalKwh != null && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <div className="rounded-lg border bg-white px-3 py-2">
            <div className="text-[10px] text-slate-400">总度数</div>
            <div className="text-sm font-semibold tabular-nums">{fmtNum(s.totalKwh)} <span className="text-[10px] font-normal text-slate-400">度</span></div>
          </div>
          <div className="rounded-lg border bg-white px-3 py-2">
            <div className="text-[10px] text-slate-400">总电费成本</div>
            <div className="text-sm font-semibold tabular-nums text-rose-600">{fmtMoney(s.totalPayAmount)}</div>
          </div>
          <div className="rounded-lg border bg-white px-3 py-2">
            <div className="text-[10px] text-slate-400">总电费收入</div>
            <div className="text-sm font-semibold tabular-nums text-emerald-600">{fmtMoney(s.totalCollectNet)}</div>
          </div>
          <div className="rounded-lg border bg-white px-3 py-2">
            <div className="text-[10px] text-slate-400">总电费利润</div>
            <div className={`text-sm font-semibold tabular-nums ${s.totalElecProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(s.totalElecProfit)}</div>
          </div>
        </div>
      )}

      {mv.brandGroups && mv.brandGroups.length === 0 && (
        <div className="rounded-lg border border-dashed py-8 text-center text-sm text-slate-400">
          暂无电表数据，请先在「电表管理」中添加电表
        </div>
      )}

      {mv.brandGroups && mv.brandGroups.map((group: any) => (
        <div key={group.brandName} className="space-y-2.5">
          {/* 品牌分隔 */}
          <div className="flex items-center gap-2">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="shrink-0 text-xs font-bold text-slate-500 bg-slate-50 px-3 py-1 rounded-full border">
              {group.brandName}
            </span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          {group.meters.map((meter: any) => (
            <div key={meter.meterId} className="rounded-xl border border-slate-200 bg-slate-50/50 overflow-hidden">
              {/* 电表标题 */}
              <div className="flex items-center gap-2 bg-white border-b px-4 py-2">
                <Zap className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold text-slate-800">
                  {meter.meterNo || meter.meterName || `电表#${meter.meterId}`}
                </span>
                {meter.meterName && meter.meterNo && (
                  <span className="text-xs text-slate-400">({meter.meterName})</span>
                )}
              </div>

              <div className="p-3 space-y-2">
                {/* 1. 品牌配置 */}
                <SectionCard icon={Battery} title="品牌配置" color="text-violet-600 bg-violet-50 border-violet-100">
                  <div className="grid grid-cols-3 gap-x-6 gap-y-1 text-xs">
                    <InfoRow label="电表品牌" value={meter.brandName} />
                    <InfoRow label="柜子数量" value={`${meter.cabinetCount} 个`} />
                    <InfoRow label="柜子编号" value={meter.cabinetNos} />
                  </div>
                </SectionCard>

                {/* 2. 电费付款情况 */}
                <SectionCard icon={Zap} title="电费付款情况" color="text-amber-600 bg-amber-50 border-amber-100">
                  <div className="grid grid-cols-4 gap-x-6 gap-y-1.5 text-xs">
                    <InfoRow label="电表编号" value={meter.meterNo} />
                    <InfoRow label="上月抄表度数" value={meter.prevEndReading != null ? fmtNum(meter.prevEndReading) : "-"} />
                    <InfoRow label="本月抄表度数" value={meter.endReading != null ? fmtNum(meter.endReading) : "-"} />
                    <InfoRow label="付款度数" value={meter.payKwh != null ? fmtNum(meter.payKwh) : "-"} />
                    <InfoRow label="付款单价" value={meter.payUnitPrice != null ? `${fmtNum(meter.payUnitPrice)} 元/度` : "-"} />
                    <InfoRow label="付款金额" value={meter.payAmount != null ? <Money v={meter.payAmount} /> : "-"} />
                    <div className="flex items-center gap-1">
                      <span className="shrink-0 text-slate-400">电费付款情况：</span>
                      {meter.payStatus ? <StatusBadge status={meter.payStatus} /> : <span className="text-slate-300">-</span>}
                    </div>
                  </div>
                </SectionCard>

                {/* 3. 电费收款情况 */}
                <SectionCard icon={Receipt} title="电费收款情况" color="text-emerald-600 bg-emerald-50 border-emerald-100">
                  <div className="grid grid-cols-4 gap-x-6 gap-y-1.5 text-xs">
                    <InfoRow
                      label="电费收款区间"
                      value={
                        meter.collectStartDate && meter.collectEndDate
                          ? `${fmtDate(meter.collectStartDate)} ~ ${fmtDate(meter.collectEndDate)}`
                          : "-"
                      }
                    />
                    <InfoRow label="收款度数" value={meter.payKwh != null ? fmtNum(meter.payKwh) : "-"} />
                    <InfoRow label="电费收款单价" value={meter.collectUnitPrice != null ? `${fmtNum(meter.collectUnitPrice)} 元/度` : "-"} />
                    {meter.taxEnabled && meter.postTaxPrice != null && (
                      <InfoRow label="税后单价" value={<span className="text-emerald-600 font-medium">{fmtNum(meter.postTaxPrice)} 元/度</span>} />
                    )}
                    <InfoRow label="电费收入（含税）" value={meter.collectAmount != null ? <Money v={meter.collectAmount} /> : "-"} />
                    <div className="flex items-center gap-1">
                      <span className="shrink-0 text-slate-400">电费收款情况：</span>
                      {meter.collectStatus ? <StatusBadge status={meter.collectStatus} /> : <span className="text-slate-300">-</span>}
                    </div>
                  </div>
                </SectionCard>

                {/* 4. 电费利润明细 */}
                <SectionCard icon={TrendingUp} title="电费利润明细" color="text-blue-600 bg-blue-50 border-blue-100">
                  <div className="grid grid-cols-3 gap-x-6 gap-y-1 text-xs">
                    <InfoRow label="税率" value={meter.taxEnabled && meter.taxRate != null ? `${(meter.taxRate * 100).toFixed(1)}%` : "-"} />
                    <InfoRow label="收入单价（不含税）" value={meter.postTaxPrice != null ? `${fmtNum(meter.postTaxPrice)} 元/度` : "-"} />
                    <InfoRow label="电费收入（不含税）" value={meter.collectNet != null ? <Money v={meter.collectNet} /> : "-"} />
                  </div>
                </SectionCard>

                {/* 5. 场地租金付款情况（来自合同） */}
                {mv.contractRent && mv.contractRent.cost && mv.contractRent.cost.length > 0 && (
                  <SectionCard icon={Home} title="场地租金付款情况" color="text-orange-600 bg-orange-50 border-orange-100">
                    <div className="space-y-2">
                      {mv.contractRent.cost.map((c: any) => (
                        <div key={c.id} className="grid grid-cols-4 gap-x-6 gap-y-1 text-xs">
                          <InfoRow label="场地方" value={c.partner || "-"} />
                          <InfoRow label="年租金" value={c.annualRent != null ? <Money v={c.annualRent} /> : "-"} />
                          <InfoRow label="月租金" value={c.monthlyRent != null ? <Money v={c.monthlyRent} /> : "-"} />
                          <InfoRow label="付款方式" value={c.payMethod || "-"} />
                          <InfoRow label="合同期限" value={c.startDate && c.endDate ? `${c.startDate} ~ ${c.endDate}` : "-"} />
                          <div className="flex items-center gap-1">
                            <span className="shrink-0 text-slate-400">付款状态：</span>
                            {c.payStatus ? <StatusBadge status={c.payStatus} /> : <span className="text-slate-300">-</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </SectionCard>
                )}

                {/* 5.6 品牌方租金收款情况（来自合同） */}
                {mv.contractRent && mv.contractRent.income && mv.contractRent.income.length > 0 && (
                  <SectionCard icon={Home} title="品牌方租金收款情况" color="text-emerald-600 bg-emerald-50 border-emerald-100">
                    <div className="space-y-2">
                      {mv.contractRent.income.map((c: any) => (
                        <div key={c.id} className="grid grid-cols-4 gap-x-6 gap-y-1 text-xs">
                          <InfoRow label="品牌方" value={c.brandName || "-"} />
                          <InfoRow label="年租金" value={c.annualRent != null ? <Money v={c.annualRent} /> : "-"} />
                          <InfoRow label="月租金" value={c.monthlyRent != null ? <Money v={c.monthlyRent} /> : "-"} />
                          <InfoRow label="付款方式" value={c.payMethod || "-"} />
                          <InfoRow label="合同期限" value={c.startDate && c.endDate ? `${c.startDate} ~ ${c.endDate}` : "-"} />
                          <div className="flex items-center gap-1">
                            <span className="shrink-0 text-slate-400">收款状态：</span>
                            {c.payStatus ? <StatusBadge status={c.payStatus} /> : <span className="text-slate-300">-</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </SectionCard>
                )}

                {/* 6. 用电量趋势 */}
                {meter.monthlyEnergy?.length > 0 && (
                  <SectionCard icon={Zap} title="用电量数据" color="text-teal-600 bg-teal-50 border-teal-100">
                    <div className="space-y-3">
                      {/* 月用电量 */}
                      {meter.monthlyEnergy && meter.monthlyEnergy.length > 0 && (
                        <div>
                          <div className="mb-1 text-[11px] font-semibold text-slate-500">近6个月用电量</div>
                          <div className="flex gap-1">
                            {meter.monthlyEnergy.slice(0, 6).reverse().map((m: any) => (
                              <div key={m.monthPeriod} className="flex-1 rounded bg-white border px-1 py-1 text-center">
                                <div className="text-[10px] text-slate-400">{m.monthPeriod.slice(4)}月</div>
                                <div className="text-[11px] font-medium text-slate-700">{fmtNum(m.kwh)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </SectionCard>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── 展开行详情组件（v3：按 场地×品牌 展示电表）───
function ExpandedDetail({ landlordId, meters, period, summary, landlordName }: { landlordId: number; meters: any[]; period: string; summary?: any; landlordName?: string }) {
  const [expandedBrand, setExpandedBrand] = useState<string | null>(null);
  const [expandedMetric, setExpandedMetric] = useState<string | null>(null);

  // 按品牌分组电表（v3：直接以 meters.brandName 分组）
  const brandGroups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const m of meters ?? []) {
      const brand = m.brandName || "未指定品牌";
      if (!map.has(brand)) map.set(brand, []);
      map.get(brand)!.push(m);
    }
    return [...map.entries()].map(([brandName, list]) => ({ brandName, meters: list }));
  }, [meters]);

  const toggleMetric = (key: string) => {
    setExpandedMetric(prev => prev === key ? null : key);
  };

  const breakdown = summary?.stationBreakdown || [];
  const contractBreakdown = summary?.contractBreakdown || [];

  return (
    <div className="space-y-4 text-sm">
      {/* 场地总览 */}
      {summary && (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <button onClick={() => toggleMetric("kwh")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "kwh" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">总度数</div>
              <div className="text-sm font-semibold tabular-nums">{fmtNum(summary.totalKwh || 0)} <span className="text-[10px] font-normal text-slate-400">度</span></div>
            </button>
            <button onClick={() => toggleMetric("elecPay")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "elecPay" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">电费成本</div>
              <div className="text-sm font-semibold tabular-nums text-rose-600">{fmtMoney(summary.elecPay)}</div>
            </button>
            <button onClick={() => toggleMetric("elecCollect")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "elecCollect" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">电费收入（不含税）</div>
              <div className="text-sm font-semibold tabular-nums text-emerald-600">{fmtMoney(summary.elecCollect)}</div>
            </button>
            <button onClick={() => toggleMetric("elecProfit")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "elecProfit" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">电费利润</div>
              <div className={`text-sm font-semibold tabular-nums ${summary.elecProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(summary.elecProfit)}</div>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <button onClick={() => toggleMetric("rentCost")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "rentCost" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">场地成本</div>
              <div className="text-sm font-semibold tabular-nums text-rose-600">{fmtMoney(summary.rentCost)}</div>
            </button>
            <button onClick={() => toggleMetric("rentIncome")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "rentIncome" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">场地收入</div>
              <div className="text-sm font-semibold tabular-nums text-emerald-600">{fmtMoney(summary.rentIncome)}</div>
            </button>
            <button onClick={() => toggleMetric("rentProfit")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "rentProfit" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">场地利润</div>
              <div className={`text-sm font-semibold tabular-nums ${summary.rentProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(summary.rentProfit)}</div>
            </button>
            <button onClick={() => toggleMetric("opExpense")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "opExpense" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">运营费用</div>
              <div className="text-sm font-semibold tabular-nums text-amber-600">{fmtMoney(summary.opExpense)}</div>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <button onClick={() => toggleMetric("elecTax")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "elecTax" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">电费税费</div>
              <div className="text-sm font-semibold tabular-nums text-purple-600">{fmtMoney(summary.elecTax || 0)}</div>
            </button>
            <button onClick={() => toggleMetric("rentTax")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "rentTax" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">场地费税费</div>
              <div className="text-sm font-semibold tabular-nums text-purple-600">{fmtMoney(summary.rentTax || 0)}</div>
            </button>
            <button onClick={() => toggleMetric("dividend")} className={`rounded-lg border bg-white px-3 py-2 text-left transition-colors hover:border-emerald-400 ${expandedMetric === "dividend" ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
              <div className="text-[10px] text-slate-400">场地分红</div>
              <div className="text-sm font-semibold tabular-nums text-blue-600">{fmtMoney(summary.dividend || 0)}</div>
            </button>
            <button className={`rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-2 text-left`}>
              <div className="text-[10px] text-emerald-600 font-medium">总利润</div>
              <div className={`text-sm font-bold tabular-nums ${summary.totalProfit >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{fmtMoney(summary.totalProfit)}</div>
            </button>
          </div>

          {/* 场地成本/利润拆分详情 */}
          {expandedMetric === "rentCost" && contractBreakdown.filter((c: any) => c.type === "场地合同").length > 0 && (
            <div className="rounded-lg border bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">场地成本构成</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="px-2.5 py-1.5 text-left font-medium text-slate-500">场地方</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">场地月租金</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">电费单价</th>
                  </tr>
                </thead>
                <tbody>
                  {contractBreakdown.filter((c: any) => c.type === "场地合同").map((c: any) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="px-2.5 py-1.5 font-medium">{c.partner || "-"}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-rose-600">{c.monthlyRent ? fmtMoney(c.monthlyRent) : "-"}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{c.elecPrice ? `${fmtNum(c.elecPrice)} 元/度` : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {expandedMetric === "rentProfit" && contractBreakdown.length > 0 && (
            <div className="rounded-lg border bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">场地利润构成</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="px-2.5 py-1.5 text-left font-medium text-slate-500">合同类型</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">场地月租金</th>
                  </tr>
                </thead>
                <tbody>
                  {contractBreakdown.map((c: any) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="px-2.5 py-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] ${c.type === "场地合同" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                          {c.type}
                        </span>
                      </td>
                      <td className={`px-2.5 py-1.5 text-right tabular-nums ${c.type === "场地合同" ? "text-rose-600" : "text-emerald-600"}`}>{c.monthlyRent ? fmtMoney(c.monthlyRent) : "-"}</td>
                    </tr>
                  ))}
                  <tr className="border-t bg-slate-50 font-medium">
                    <td className="px-2.5 py-1.5">场地利润</td>
                    <td className={`px-2.5 py-1.5 text-right tabular-nums ${(summary?.rentProfit || 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(summary?.rentProfit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* 场地收入详情 */}
          {expandedMetric === "rentIncome" && contractBreakdown.filter((c: any) => c.type === "品牌方合同").length > 0 && (
            <div className="rounded-lg border bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">场地收入构成（品牌方合同）</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="px-2.5 py-1.5 text-left font-medium text-slate-500">品牌方</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">月租金</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">电费单价</th>
                  </tr>
                </thead>
                <tbody>
                  {contractBreakdown.filter((c: any) => c.type === "品牌方合同").map((c: any) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="px-2.5 py-1.5 font-medium">{c.brandName || c.partner || "-"}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-emerald-600">{c.monthlyRent ? fmtMoney(c.monthlyRent) : "-"}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{c.elecPrice ? `${fmtNum(c.elecPrice)} 元/度` : "-"}</td>
                    </tr>
                  ))}
                  <tr className="border-t bg-slate-50 font-medium">
                    <td className="px-2.5 py-1.5">合计</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(summary?.rentIncome)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* 运营费用详情 */}
          {expandedMetric === "opExpense" && (
            <div className="rounded-lg border bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">运营费用明细</div>
              <div className="text-xs text-slate-500">
                <div className="flex items-center justify-between py-1.5 border-b">
                  <span>运营费用合计</span>
                  <span className="font-medium text-amber-600">{fmtMoney(summary?.opExpense)}</span>
                </div>
                <div className="mt-2 text-[10px] text-slate-400">
                  * 运营费用包括人工、维护、水电等日常开支
                </div>
              </div>
            </div>
          )}

          {/* 电费税费详情 */}
          {expandedMetric === "elecTax" && (
            <div className="rounded-lg border bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">电费税费明细</div>
              <div className="text-xs text-slate-500">
                <div className="flex items-center justify-between py-1.5 border-b">
                  <span>电费收入（含税）</span>
                  <span className="font-medium">{fmtMoney((summary?.elecCollect || 0) + (summary?.elecTax || 0))}</span>
                </div>
                <div className="flex items-center justify-between py-1.5 border-b">
                  <span>电费税费</span>
                  <span className="font-medium text-purple-600">{fmtMoney(summary?.elecTax || 0)}</span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span>电费收入（不含税）</span>
                  <span className="font-medium text-emerald-600">{fmtMoney(summary?.elecCollect)}</span>
                </div>
                <div className="mt-2 text-[10px] text-slate-400">
                  * 税费 = 含税收入 × 税率（来自品牌方合同配置）
                </div>
              </div>
            </div>
          )}

          {/* 场地费税费详情 */}
          {expandedMetric === "rentTax" && (
            <div className="rounded-lg border bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">场地费税费明细</div>
              <div className="text-xs text-slate-500">
                <div className="flex items-center justify-between py-1.5 border-b">
                  <span>场地收入（含税）</span>
                  <span className="font-medium">{fmtMoney(summary?.rentIncome)}</span>
                </div>
                <div className="flex items-center justify-between py-1.5 border-b">
                  <span>场地费税费</span>
                  <span className="font-medium text-purple-600">{fmtMoney(summary?.rentTax || 0)}</span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span>场地收入（不含税）</span>
                  <span className="font-medium text-emerald-600">{fmtMoney((summary?.rentIncome || 0) - (summary?.rentTax || 0))}</span>
                </div>
                <div className="mt-2 text-[10px] text-slate-400">
                  * 税费 = 含税收入 × 税率（来自品牌方合同配置）
                </div>
              </div>
            </div>
          )}

          {/* 分红详情 */}
          {expandedMetric === "dividend" && (
            <div className="rounded-lg border bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">场地分红明细</div>
              <div className="text-xs text-slate-500">
                <div className="flex items-center justify-between py-1.5 border-b">
                  <span>场地分红合计</span>
                  <span className="font-medium text-blue-600">{fmtMoney(summary?.dividend || 0)}</span>
                </div>
                <div className="mt-2 text-[10px] text-slate-400">
                  * 分红包括商务分红和股东分红
                </div>
              </div>
            </div>
          )}

          {expandedMetric && expandedMetric !== "rentCost" && expandedMetric !== "rentProfit" && expandedMetric !== "rentIncome" && expandedMetric !== "opExpense" && expandedMetric !== "elecTax" && expandedMetric !== "rentTax" && expandedMetric !== "dividend" && breakdown.length > 0 && (

            <div className="rounded-lg border bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">
                {expandedMetric === "kwh" && "各品牌用电量"}
                {expandedMetric === "elecPay" && "各品牌电费成本"}
                {expandedMetric === "elecCollect" && "各品牌电费收入（不含税）"}
                {expandedMetric === "elecProfit" && "各品牌电费利润"}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="px-2.5 py-1.5 text-left font-medium text-slate-500">品牌</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">电表数</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">用电量（度）</th>
                    {(expandedMetric === "elecPay" || expandedMetric === "elecProfit") && (
                      <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">电费成本</th>
                    )}
                    {(expandedMetric === "elecCollect" || expandedMetric === "elecProfit") && (
                      <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">电费收入</th>
                    )}
                    {expandedMetric === "elecProfit" && (
                      <th className="px-2.5 py-1.5 text-right font-medium text-slate-500">电费利润</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((sb: any) => (
                    <tr key={sb.brandId ?? sb.stationId} className="border-b last:border-0">
                      <td className="px-2.5 py-1.5 font-medium">{sb.brandName || sb.stationName || "未分配品牌"}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{sb.meterCount}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtNum(sb.kwh)}</td>
                      {(expandedMetric === "elecPay" || expandedMetric === "elecProfit") && (
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(sb.elecPay)}</td>
                      )}
                      {(expandedMetric === "elecCollect" || expandedMetric === "elecProfit") && (
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(sb.elecCollect)}</td>
                      )}
                      {expandedMetric === "elecProfit" && (
                        <td className={`px-2.5 py-1.5 text-right tabular-nums font-medium ${sb.elecProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(sb.elecProfit)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* 品牌列表（v3：该场地各品牌的电表） */}
      {brandGroups.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-slate-700">品牌电表（{brandGroups.length} 个品牌 · {meters?.length ?? 0} 台电表）</h4>
          <div className="space-y-1.5">
            {brandGroups.map((g: any) => {
              const isOpen = expandedBrand === g.brandName;
              return (
                <div key={g.brandName} className="overflow-hidden rounded-lg border bg-white">
                  <button
                    onClick={() => setExpandedBrand(isOpen ? null : g.brandName)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-300" />}
                      <span className="font-medium text-slate-700">{g.brandName}</span>
                      <span className="text-[11px] text-slate-400">{g.meters.length} 台电表</span>
                    </div>
                    <span className="text-[11px] text-slate-400">{landlordName || "查看电表明细"}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t bg-slate-50/50 px-3 py-3">
                      <LandlordMeterDetail
                        landlordId={landlordId}
                        period={period}
                        landlordName={landlordName}
                        onBack={() => setExpandedBrand(null)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {meters && meters.length === 0 && (
        <div className="rounded-lg border border-dashed py-6 text-center text-xs text-slate-400">
          暂无实表数据（需为电表关联场地方和品牌）
        </div>
      )}
    </div>
  );
}

// ─── 单个场地方可视化面板 ───
const ELEC_PROFIT_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6", "#ec4899", "#14b8a6"];
const RENT_PROFIT_COLORS = ["#f97316", "#6366f1", "#eab308", "#e11d48", "#0891b2", "#7c3aed", "#db2777", "#0d9488"];
const TREND_COLORS = ["#10b981", "#6366f1", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6", "#ec4899", "#14b8a6"];

function SingleLandlordPanel({ row }: { row: any }) {
  const r = row;
  const { data: monthlyData, isLoading } = useQuery({
    queryKey: ["landlordStationMonthly", r.landlord.id],
    queryFn: () => getLandlordStationMonthly(r.landlord.id, 6),
  });

  const breakdown = r.stationBreakdown || [];

  // 饼图数据：各品牌电费利润贡献率（v3：按月趋势的品牌维度；无趋势时用 meters 按品牌分组兜底）
  const latestBrands = monthlyData && monthlyData.length > 0 ? (monthlyData[monthlyData.length - 1].brands || []) : [];
  const elecProfitPie = (latestBrands.length > 0 ? latestBrands : breakdown.map((s: any) => ({ brandName: s.stationName || "未分配", elecProfit: s.elecProfit || 0 })))
    .map((s: any) => ({ name: s.brandName || "未分配", value: Math.abs(s.elecProfit || 0) }))
    .filter((d: any) => d.value > 0);

  // 饼图数据：各品牌场地利润贡献率（均摊）
  const brandCount = (latestBrands.length > 0 ? latestBrands.length : breakdown.length) || 1;
  const rentProfitPerBrand = (r.rentProfit || 0) / brandCount;
  const rentProfitPie = (latestBrands.length > 0 ? latestBrands : breakdown.map((s: any) => ({ brandName: s.stationName || "未分配" })))
    .map((s: any) => ({ name: s.brandName || "未分配", value: Math.abs(rentProfitPerBrand) }))
    .filter((d: any) => d.value > 0);

  // 柱状图数据：近半年各品牌利润（堆叠）
  const barData = (monthlyData || []).map((m: any) => {
    const entry: any = { period: m.period.replace(/^\d{4}-/, "") };
    let total = 0;
    (m.brands || []).forEach((s: any) => {
      entry[s.brandName] = s.totalProfit;
      total += s.totalProfit;
    });
    entry._total = total;
    return entry;
  });

  // 收集所有品牌名（用于堆叠柱状图）
  const stationNames: string[] = Array.from(new Set((monthlyData || []).flatMap((m: any) => (m.brands || []).map((s: any) => s.brandName))));

  const kpis = [
    { label: "电费利润", value: r.elecProfit, icon: Zap, color: r.elecProfit >= 0 ? "text-emerald-600" : "text-rose-600", bg: r.elecProfit >= 0 ? "bg-emerald-50" : "bg-rose-50" },
    { label: "场地利润", value: r.rentProfit, icon: Home, color: r.rentProfit >= 0 ? "text-emerald-600" : "text-rose-600", bg: r.rentProfit >= 0 ? "bg-emerald-50" : "bg-rose-50" },
    { label: "运营费用", value: r.opExpense, icon: Activity, color: "text-amber-600", bg: "bg-amber-50" },
    { label: "总利润", value: r.totalProfit, icon: DollarSign, color: r.totalProfit >= 0 ? "text-emerald-700" : "text-rose-700", bg: r.totalProfit >= 0 ? "bg-emerald-100" : "bg-rose-100" },
  ];

  const tooltipFmt = (v: number) => fmtMoney(v);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border bg-emerald-50 px-3 py-2">
        <MapPin className="h-4 w-4 text-emerald-600" />
        <span className="text-xs font-semibold text-emerald-800">{r.landlord.name}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {kpis.map((k) => (
          <div key={k.label} className={`rounded-lg border px-3 py-2 ${k.bg}`}>
            <div className="flex items-center gap-1.5">
              <k.icon className={`h-3.5 w-3.5 ${k.color}`} />
              <span className="text-[10px] text-slate-500">{k.label}</span>
            </div>
            <div className={`text-base font-bold tabular-nums ${k.color}`}>{fmtMoney(k.value)}</div>
          </div>
        ))}
      </div>

      {/* 电费利润贡献率饼图 */}
      {elecProfitPie.length > 0 && (
        <div className="rounded-lg border bg-white p-3">
          <div className="mb-1 text-xs font-semibold text-slate-600">各品牌电费利润贡献率</div>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={elecProfitPie} cx="50%" cy="45%" innerRadius={30} outerRadius={55} paddingAngle={3} dataKey="value" label={({ name, percent }) => `${name.length > 8 ? name.slice(0, 8) + '…' : name} ${(percent * 100).toFixed(0)}%`} labelLine={{ stroke: '#94a3b8', strokeWidth: 1 }}>
                {elecProfitPie.map((_: any, i: number) => <Cell key={i} fill={ELEC_PROFIT_COLORS[i % ELEC_PROFIT_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={tooltipFmt} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 场地利润贡献率饼图 */}
      {rentProfitPie.length > 0 && (
        <div className="rounded-lg border bg-white p-3">
          <div className="mb-1 text-xs font-semibold text-slate-600">各品牌场地利润贡献率</div>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={rentProfitPie} cx="50%" cy="45%" innerRadius={30} outerRadius={55} paddingAngle={3} dataKey="value" label={({ name, percent }) => `${name.length > 8 ? name.slice(0, 8) + '…' : name} ${(percent * 100).toFixed(0)}%`} labelLine={{ stroke: '#94a3b8', strokeWidth: 1 }}>
                {rentProfitPie.map((_: any, i: number) => <Cell key={i} fill={RENT_PROFIT_COLORS[i % RENT_PROFIT_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={tooltipFmt} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 近半年利润趋势（堆叠柱状图，按品牌分色） */}
      {barData.length > 0 && (
        <div className="rounded-lg border bg-white p-3">
          <div className="mb-2 text-xs font-semibold text-slate-700">近半年利润趋势</div>
          {isLoading ? (
            <div className="py-6 text-center text-xs text-slate-400">加载中…</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={barData} margin={{ left: 0, right: 10, top: 5, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={(v: number) => v >= 10000 ? `${(v / 10000).toFixed(1)}w` : String(v)} tick={{ fontSize: 10 }} />
                <Tooltip formatter={tooltipFmt} labelStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {stationNames.map((name: string, i: number) => (
                  <Bar key={name} dataKey={name} stackId="profit" fill={TREND_COLORS[i % TREND_COLORS.length]} radius={i === stationNames.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]} barSize={24} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 可视化面板 ───
function VisualizationPanel({ rows, expandedRow, collapsed, onToggle }: { rows: any[]; expandedRow: any; collapsed: boolean; onToggle: () => void }) {
  if (collapsed) {
    return (
      <div className="relative flex justify-center pt-4">
        <button
          onClick={onToggle}
          className="flex h-10 w-5 items-center justify-center rounded-l-md border border-r-0 bg-white text-slate-400 shadow-sm hover:bg-slate-50 hover:text-slate-600 transition-colors"
          title="展开可视化面板"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* 收起按钮 */}
      <button
        onClick={onToggle}
        className="absolute -left-5 top-4 z-10 flex h-10 w-5 items-center justify-center rounded-l-md border border-r-0 bg-white text-slate-400 shadow-sm hover:bg-slate-50 hover:text-slate-600 transition-colors"
        title="收起可视化面板"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      {rows.length > 0 ? <ComparisonPanel rows={rows} /> : expandedRow ? <SingleLandlordPanel row={expandedRow} /> : null}
    </div>
  );
}

// ─── 对比面板（选中场地方） ───
function ComparisonPanel({ rows }: { rows: any[] }) {
  const profitData = rows
    .map((r: any) => ({
      name: r.landlord.name,
      电费利润: r.elecProfit,
      场地利润: r.rentProfit,
      总利润: r.totalProfit,
    }))
    .sort((a: any, b: any) => b.总利润 - a.总利润);

  const costIncomeData = rows
    .map((r: any) => ({
      name: r.landlord.name,
      电费付款: r.elecPay,
      "电费收款（不含税）": r.elecCollect,
      场地成本: r.rentCost,
      场地收入: r.rentIncome,
    }))
    .sort((a: any, b: any) => (b["电费收款（不含税）"] + b.场地收入) - (a["电费收款（不含税）"] + a.场地收入));

  const selTotals = rows.reduce(
    (t: any, r: any) => ({
      elecProfit: t.elecProfit + r.elecProfit,
      rentProfit: t.rentProfit + r.rentProfit,
      opExpense: t.opExpense + r.opExpense,
      totalProfit: t.totalProfit + r.totalProfit,
    }),
    { elecProfit: 0, rentProfit: 0, opExpense: 0, totalProfit: 0 },
  );

  const kpis = [
    { label: "电费利润", value: selTotals.elecProfit, icon: Zap, color: selTotals.elecProfit >= 0 ? "text-emerald-600" : "text-rose-600", bg: selTotals.elecProfit >= 0 ? "bg-emerald-50" : "bg-rose-50" },
    { label: "场地利润", value: selTotals.rentProfit, icon: Home, color: selTotals.rentProfit >= 0 ? "text-emerald-600" : "text-rose-600", bg: selTotals.rentProfit >= 0 ? "bg-emerald-50" : "bg-rose-50" },
    { label: "运营费用", value: selTotals.opExpense, icon: Activity, color: "text-amber-600", bg: "bg-amber-50" },
    { label: "总利润", value: selTotals.totalProfit, icon: DollarSign, color: selTotals.totalProfit >= 0 ? "text-emerald-700" : "text-rose-700", bg: selTotals.totalProfit >= 0 ? "bg-emerald-100" : "bg-rose-100" },
  ];

  const tooltipFmt = (v: number) => fmtMoney(v);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border bg-blue-50 px-3 py-2">
        <BarChart3 className="h-4 w-4 text-blue-600" />
        <span className="text-xs font-semibold text-blue-800">已选 {rows.length} 个场地方对比</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {kpis.map((k) => (
          <div key={k.label} className={`rounded-lg border px-3 py-2 ${k.bg}`}>
            <div className="flex items-center gap-1.5">
              <k.icon className={`h-3.5 w-3.5 ${k.color}`} />
              <span className="text-[10px] text-slate-500">{k.label}</span>
            </div>
            <div className={`text-base font-bold tabular-nums ${k.color}`}>{fmtMoney(k.value)}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-white p-3">
        <div className="mb-2 text-xs font-semibold text-slate-700">利润对比</div>
        <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 40)}>
          <BarChart data={profitData} layout="vertical" margin={{ left: 0, right: 10, top: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" tickFormatter={(v: number) => v >= 10000 ? `${(v / 10000).toFixed(1)}w` : String(v)} tick={{ fontSize: 10 }} />
            <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 11 }} />
            <Tooltip formatter={tooltipFmt} labelStyle={{ fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="电费利润" fill="#10b981" radius={[0, 2, 2, 0]} barSize={8} />
            <Bar dataKey="场地利润" fill="#6366f1" radius={[0, 2, 2, 0]} barSize={8} />
            <Bar dataKey="总利润" fill="#f59e0b" radius={[0, 2, 2, 0]} barSize={8} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="rounded-lg border bg-white p-3">
        <div className="mb-2 text-xs font-semibold text-slate-700">收入 vs 成本</div>
        <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 40)}>
          <BarChart data={costIncomeData} layout="vertical" margin={{ left: 0, right: 10, top: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" tickFormatter={(v: number) => v >= 10000 ? `${(v / 10000).toFixed(1)}w` : String(v)} tick={{ fontSize: 10 }} />
            <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 11 }} />
            <Tooltip formatter={tooltipFmt} labelStyle={{ fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="电费付款" fill="#ef4444" radius={[0, 2, 2, 0]} barSize={6} />
            <Bar dataKey="电费收款（不含税）" fill="#10b981" radius={[0, 2, 2, 0]} barSize={6} />
            <Bar dataKey="场地成本" fill="#f97316" radius={[0, 2, 2, 0]} barSize={6} />
            <Bar dataKey="场地收入" fill="#06b6d4" radius={[0, 2, 2, 0]} barSize={6} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── 场地方专属面板 ───
// ─── 主页面 ───
export default function Stations() {
  const [keyword, setKeyword] = useState("");
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  const [selectedLandlordIds, setSelectedLandlordIds] = useState<Set<number>>(new Set());

  const board = useQuery({
    queryKey: ["stationBoard", keyword, selectedMonth],
    queryFn: () => getStationBoard({ keyword: keyword || undefined, period: selectedMonth }),
  });

  const rows = useMemo(() => board.data ?? [], [board.data]);
  const selectedRows = useMemo(() => rows.filter((r: any) => selectedLandlordIds.has(r.landlord.id)), [rows, selectedLandlordIds]);
  const expandedRow = useMemo(() => expandedId != null ? rows.find((r: any) => r.landlord.id === expandedId) : null, [rows, expandedId]);
  const totals = useMemo(() => rows.reduce(
    (t: any, r: any) => ({
      elecPay: t.elecPay + r.elecPay, elecCollect: t.elecCollect + r.elecCollect, elecProfit: t.elecProfit + r.elecProfit,
      rentCost: t.rentCost + r.rentCost, rentIncome: t.rentIncome + r.rentIncome, rentProfit: t.rentProfit + r.rentProfit,
      opExpense: t.opExpense + r.opExpense,
      totalProfit: t.totalProfit + r.totalProfit,
    }),
    { elecPay: 0, elecCollect: 0, elecProfit: 0, rentCost: 0, rentIncome: 0, rentProfit: 0, opExpense: 0, totalProfit: 0 },
  ), [rows]);

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => {
      const next = prev === id ? null : id;
      // 展开时自动打开右侧面板（如果没有勾选的话）
      if (next !== null && selectedLandlordIds.size === 0) setPanelCollapsed(false);
      if (next === null && selectedLandlordIds.size === 0) setPanelCollapsed(true);
      return next;
    });
  };

  const toggleLandlordSelect = (id: number) => {
    setSelectedLandlordIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // 有选中时自动展开面板
      setPanelCollapsed(next.size === 0);
      return next;
    });
  };

  const doExport = async () => {
    const exportRows = selectedLandlordIds.size > 0 ? selectedRows : rows;
    if (exportRows.length === 0) { toast.error("暂无数据可导出"); return; }

    const tid = toast.loading("正在准备导出数据…");
    try {
      // 按场地拉取电表视图（v3：landlord 维度）
      const landlordMeterViews = await Promise.all(
        exportRows.map((r: any) => getLandlordMeterView(r.landlord.id, selectedMonth))
      );
      const mvByLandlord = exportRows.map((_: any, i: number) => [landlordMeterViews[i]]);

      // 每个场地方的付款汇总 + 租金（来自board，场地方级）
      const landlordPayMap = exportRows.map((r: any) => {
        const cb = r.contractBreakdown || [];
        const payContract = cb.find((c: any) => c.type === "场地合同");
        const payStatuses = new Set<string>();
        return {
          payKwh: r.totalKwh ?? 0,
          payUnitPrice: payContract?.elecPrice ?? 0,
          payAmount: r.elecPay ?? 0,
          payStatuses,
          rentCost: r.rentCost ?? 0,
          rentIncome: r.rentIncome ?? 0,
        };
      });
      // 收集付款状态
      for (let li = 0; li < mvByLandlord.length; li++) {
        for (const mv of mvByLandlord[li]) {
          for (const group of (mv.brandGroups || [])) {
            for (const meter of (group.meters || [])) {
              if (meter.payStatus) landlordPayMap[li].payStatuses.add(meter.payStatus);
            }
          }
        }
      }

      // ── 构建参考 Excel 格式（便民换电柜经营收入台账）──
      // 第1行标题、第2行分组表头、第3行明细表头、之后数据行（每站点分组 + 合计）
      const HEADERS_GROUP = ["序号", "站点名称", "站点配置", "", "", "电费付款情况", "", "", "", "电费收款情况", "", "", "", "", "电费利润明细", "", "场地租金收款情况", "", ""];
      const HEADERS_DETAIL = ["", "", "品牌", "数量", "柜子编号", "付款度数", "付款单价", "付款金额", "付款情况", "电费收款区间", "收款度数", "收入单价\n（含税）", "收入（含税）", "电费收款情况", "收入单价\n（不含税）", "电费收入\n（不含税）", "场地\n收款期间", "场地租金", "租金\n收款情况"];
      // 参考 Excel 列宽：B=24、E=18.2、J=15.2、Q=14.6，其余默认
      const COLS = [5, 24, 10, 6, 18.2, 10, 9, 11, 9, 15.2, 10, 10, 11, 9, 11, 11, 14.6, 9, 9];

      const aoa: any[][] = [["便民换电柜经营收入台账"], HEADERS_GROUP, HEADERS_DETAIL];
      const merges: XLSX.Range[] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 18 } },          // 标题 A1:S1
        { s: { r: 1, c: 2 }, e: { r: 1, c: 4 } },           // 站点配置 C:E
        { s: { r: 1, c: 5 }, e: { r: 1, c: 8 } },           // 电费付款情况 F:I
        { s: { r: 1, c: 9 }, e: { r: 1, c: 13 } },          // 电费收款情况 J:N
        { s: { r: 1, c: 14 }, e: { r: 1, c: 15 } },         // 电费利润明细 O:P
        { s: { r: 1, c: 16 }, e: { r: 1, c: 18 } },         // 场地租金收款情况 Q:S
      ];

      for (let li = 0; li < exportRows.length; li++) {
        const r = exportRows[li];
        const pay = landlordPayMap[li];
        const payStatusStr = pay.payStatuses.size === 1 ? [...pay.payStatuses][0] : pay.payStatuses.size > 1 ? "部分付款" : "";

        // 收集该场地所有电表 + 品牌方合同租金
        const mv = mvByLandlord[li][0];
        const allMeters: any[] = [];
        for (const group of (mv?.brandGroups || [])) {
          for (const meter of (group.meters || [])) allMeters.push({ ...meter, brandName: meter.brandName || group.brandName });
        }
        const incomeContracts = mv?.contractRent?.income || [];

        let landCollectKwh = 0, landCollectAmount = 0, landCollectNet = 0, landMeterCount = 0, landRentIncome = 0;
        for (const m of allMeters) {
          landCollectKwh += m.payKwh || 0;
          landCollectAmount += m.collectAmount || 0;
          landCollectNet += m.collectNet || 0;
          landMeterCount += 1;
          const brandIncome = incomeContracts.find((c: any) => Number(c.brandId) === Number(m.brandId));
          landRentIncome += brandIncome?.monthlyRent ?? 0;
        }

        // 站点分组起始行（数据从第4行开始，1-based = aoa.length+1）
        const startRow = aoa.length; // 0-based 行号
        const brandContractMap = new Map<number, any>();
        for (const c of incomeContracts) brandContractMap.set(Number(c.brandId), c);

        // J 电费收款区间 = 用户当前选择的月份自然月区间（如 2026-08 → 2026-08-01 ~ 2026-08-31）
        const [selY, selM] = selectedMonth.split("-").map(Number);
        const monthStart = `${selY}-${String(selM).padStart(2, "0")}-01`;
        const lastDay = new Date(selY, selM, 0).getDate();
        const monthEnd = `${selY}-${String(selM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
        const elecCollectRange = `${monthStart} ~ ${monthEnd}`;

        allMeters.forEach((m, idx) => {
          const brandIncome = brandContractMap.get(Number(m.brandId));
          const isFirst = idx === 0;
          // Q 场地收款期间 = 该品牌合同覆盖所选月的收款分期区间（contracts 中已有）
          const rentRange = brandIncome?.periodStart && brandIncome?.periodEnd
            ? `${brandIncome.periodStart} ~ ${brandIncome.periodEnd}`
            : "";
          // S 租金收款情况 = 已到账 X/Y 期（参考 Rent 页面的收款情况）
          const rentStatus = brandIncome?.totalCount
            ? `已到账 ${brandIncome.paidCount ?? 0}/${brandIncome.totalCount} 期`
            : "";
          aoa.push([
            isFirst ? li + 1 : "",                                   // A 序号（整组首行）
            isFirst ? r.landlord.name : "",                          // B 站点名称（整组首行）
            m.brandName ?? "",                                       // C 品牌
            m.cabinetCount ?? "",                                    // D 数量
            m.cabinetNos ?? "",                                      // E 柜子编号
            isFirst ? pay.payKwh : "",                               // F 付款度数（整组首行）
            isFirst ? pay.payUnitPrice : "",                         // G 付款单价（整组首行）
            isFirst ? pay.payAmount : "",                            // H 付款金额（整组首行）
            isFirst ? payStatusStr : "",                             // I 付款情况（整组首行）
            isFirst ? elecCollectRange : "",                         // J 电费收款区间（当前选择月份，整组首行）
            m.payKwh ?? "",                                          // K 收款度数
            m.collectUnitPrice ?? "",                                // L 收入单价（含税）
            m.collectAmount ?? "",                                   // M 收入（含税）
            m.collectStatus ?? "",                                   // N 电费收款情况
            m.postTaxPrice ?? "",                                    // O 收入单价（不含税）
            m.collectNet ?? "",                                      // P 电费收入（不含税）
            rentRange,                                               // Q 场地收款期间（合同收款分期区间）
            brandIncome?.monthlyRent ?? "",                          // R 场地租金
            rentStatus,                                              // S 租金收款情况（已到账 X/Y 期）
          ]);
        });
        const endRow = aoa.length - 1; // 0-based 该组末行
        // 站点分组合并：A、B 整组合并；F~I 付款整组合并（只首行有值）
        if (endRow > startRow) {
          merges.push({ s: { r: startRow, c: 0 }, e: { r: endRow, c: 0 } });
          merges.push({ s: { r: startRow, c: 1 }, e: { r: endRow, c: 1 } });
          merges.push({ s: { r: startRow, c: 5 }, e: { r: endRow, c: 5 } });
          merges.push({ s: { r: startRow, c: 6 }, e: { r: endRow, c: 6 } });
          merges.push({ s: { r: startRow, c: 7 }, e: { r: endRow, c: 7 } });
          merges.push({ s: { r: startRow, c: 8 }, e: { r: endRow, c: 8 } });
        }

        // 场地合计行
        aoa.push([
          "", "", "合计", landMeterCount, "",
          pay.payKwh, "", pay.payAmount, "",
          "", landCollectKwh, "", landCollectAmount, "",
          "", landCollectNet, "", landRentIncome, "",
        ]);
      }

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!merges"] = merges;
      ws["!cols"] = COLS.map((w) => ({ wch: w }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, selectedMonth.replace("-", "").slice(0, 31) || "台账");
      XLSX.writeFile(wb, `便民换电柜经营收入台账_${selectedMonth}.xlsx`);
      toast.dismiss(tid);
      toast.success("已导出 Excel");
    } catch (e) {
      toast.dismiss(tid);
      toast.error("导出失败，请重试");
      console.error(e);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className={`${inputCls} w-56 pl-8`} placeholder="搜索场地方名称…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <MonthPicker value={selectedMonth} onChange={setSelectedMonth} />
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={doExport}>
            <Download className="mr-1.5 h-4 w-4" />
            {selectedLandlordIds.size > 0 ? `导出选中（${selectedLandlordIds.size}）` : "导出全部"}
          </Button>
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${panelCollapsed ? "lg:grid-cols-[1fr_40px]" : "lg:grid-cols-[1fr_400px]"}`}>
        {/* 左侧：数据表格 */}
        <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b bg-slate-50 text-left text-xs text-slate-500">
                <th className="w-8 px-1 py-2.5"></th>
                <th className="w-8 px-1 py-2.5">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={selectedLandlordIds.size > 0 && selectedLandlordIds.size === rows.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedLandlordIds(new Set(rows.map((r: any) => r.landlord.id)));
                        setPanelCollapsed(false);
                      } else {
                        setSelectedLandlordIds(new Set());
                        setPanelCollapsed(true);
                      }
                    }}
                  />
                </th>
                <th className="px-3 py-2.5 font-medium">场地方</th>
                <th className="px-3 py-2.5 text-center font-medium">电表数</th>
                <th className="px-3 py-2.5 text-right font-medium">电费付款</th>
                <th className="px-3 py-2.5 text-right font-medium">电费收款（不含税）</th>
                <th className="px-3 py-2.5 text-right font-medium">电费利润</th>
                <th className="px-3 py-2.5 text-right font-medium">租金成本</th>
                <th className="px-3 py-2.5 text-right font-medium">租金收入</th>
                <th className="px-3 py-2.5 text-right font-medium">运营费用</th>
                <th className="px-3 py-2.5 text-right font-medium">总利润</th>
                <th className="px-3 py-2.5 text-center font-medium">合同</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any) => {
                const isExpanded = expandedId === r.landlord.id;
                return (
                  <Fragment key={r.landlord.id}>
                    <tr className={`border-b hover:bg-slate-50/60 ${isExpanded ? "bg-slate-50/80" : ""}`}>
                      <td className="px-1 py-2.5 text-center cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}>
                        {isExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
                      </td>
                      <td className="px-1 py-2.5 text-center">
                        <input
                          type="checkbox"
                          className="rounded border-slate-300"
                          checked={selectedLandlordIds.has(r.landlord.id)}
                          onChange={() => toggleLandlordSelect(r.landlord.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-3 py-2.5 cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}>
                        <div className="flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-emerald-600" />
                          <div>
                            <div className="font-medium text-slate-800">{r.landlord.name}</div>
                            <div className="text-[11px] text-slate-400">
                              {r.landlord.contact ? `联系人：${r.landlord.contact}` : ""}
                              {r.landlord.phone ? ` · ${r.landlord.phone}` : ""}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}>
                        <div className="flex items-center justify-center gap-1">
                          <Gauge className="h-3.5 w-3.5 text-slate-400" />
                          <span className="tabular-nums">{r.meterCount}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}><Money v={r.elecPay} /></td>
                      <td className="px-3 py-2.5 text-right cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}><Money v={r.elecCollect} /></td>
                      <td className="px-3 py-2.5 text-right cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}><Money v={r.elecProfit} strong /></td>
                      <td className="px-3 py-2.5 text-right cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}><Money v={r.rentCost} /></td>
                      <td className="px-3 py-2.5 text-right cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}><Money v={r.rentIncome} /></td>
                      <td className="px-3 py-2.5 text-right cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}><Money v={r.opExpense} /></td>
                      <td className="px-3 py-2.5 text-right cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}><Money v={r.totalProfit} strong /></td>
                      <td className="px-3 py-2.5 text-center cursor-pointer" onClick={() => toggleExpand(r.landlord.id)}>
                        <div className="text-xs">
                          <span className="text-slate-500">{r.contractCount} 份</span>
                          {r.expiredContracts > 0 && <span className="ml-1 text-rose-600">({r.expiredContracts}到期)</span>}
                          {r.expiringContracts > 0 && <span className="ml-1 text-amber-600">({r.expiringContracts}临期)</span>}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${r.landlord.id}-expanded`}>
                        <td colSpan={12} className="border-b bg-white px-6 py-4">
                          <ExpandedDetail landlordId={r.landlord.id} meters={r.meters} period={selectedMonth} landlordName={r.landlord.name} summary={{ totalKwh: r.totalKwh, elecPay: r.elecPay, elecCollect: r.elecCollect, elecProfit: r.elecProfit, elecTax: r.elecTax, rentCost: r.rentCost, rentIncome: r.rentIncome, rentProfit: r.rentProfit, rentTax: r.rentTax, opExpense: r.opExpense, dividend: r.dividend, totalProfit: r.totalProfit, stationBreakdown: r.stationBreakdown, contractBreakdown: r.contractBreakdown }} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={12} className="py-16 text-center text-slate-400">{board.isLoading ? "加载中…" : "暂无场地数据"}</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t bg-emerald-50/50 text-xs font-semibold text-slate-700">
                  <td className="px-3 py-2.5" colSpan={3}>合计（{rows.length} 个场地方）</td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{rows.reduce((t: number, r: any) => t + r.meterCount, 0)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.elecPay)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.elecCollect)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.elecProfit)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.rentCost)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.rentIncome)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.opExpense)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.totalProfit)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* 右侧：可视化面板 */}
        <div className="hidden lg:block">
          <VisualizationPanel rows={selectedRows} expandedRow={expandedRow} collapsed={panelCollapsed} onToggle={() => setPanelCollapsed(p => !p)} />
        </div>
      </div>
    </div>
  );
}
