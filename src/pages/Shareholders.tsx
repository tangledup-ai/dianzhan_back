import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient, useQueries } from "@tanstack/react-query";
import { listShareholders, listIntroducers, listPlatformUsers } from "@/api/directory";
import { getStationBoard } from "@/api/overview";
import { shareholderSummary, listDividends, listShareholderConfigs, listIntroducerConfigs, deleteShareholderConfig, deleteIntroducerConfig, calculateDividend, createDividend } from "@/api/dividends";
import { submitDividendApproval } from "@/api/approvals";
import { listExpenses, saveExpense, deleteExpense } from "@/api/rent";
import { listContracts } from "@/api/contracts";
import { listMeters } from "@/api/meters";
import { getMonthlyKwh } from "@/api/meterEnergy";
import { MonthPicker } from "@/components/MonthPicker";
import { fmtMoney, fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { inputCls } from "@/components/fields";
import { Users, MapPin, X, Trash2, UserPlus, Settings, DollarSign, ChevronDown, ChevronRight, Download } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

// ─── 新增股东弹窗 ───
function AddShareholderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [remark, setRemark] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("股东名称不能为空");
      const res = await fetch("/api/directory/shareholders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() || undefined, remark: remark.trim() || undefined }),
      });
      if (!res.ok) throw new Error("创建失败");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
      toast.success("股东添加成功");
      onClose();
      setName(""); setPhone(""); setRemark("");
    },
    onError: (e: any) => toast.error(e.message || "添加失败"),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-800">新增股东</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">股东名称 <span className="text-rose-500">*</span></label>
            <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="请输入股东名称" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">联系电话</label>
            <input className={inputCls} value={phone} onChange={e => setPhone(e.target.value)} placeholder="请输入联系电话" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">备注</label>
            <input className={inputCls} value={remark} onChange={e => setRemark(e.target.value)} placeholder="备注信息" />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">取消</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50">
            {mutation.isPending ? "添加中…" : "确认添加"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 配置分红弹窗（v3：按场地 landlordId）───
function ConfigDividendDialog({ open, onClose, type, landlordId, brands }: { open: boolean; onClose: () => void; type: "shareholder" | "introducer"; landlordId?: number; brands?: any[] }) {
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState<number | null>(null);
  const [brandId, setBrandId] = useState<number | "">("");
  const [mode, setMode] = useState("利润分红");
  const [ratio, setRatio] = useState("");
  const [fixedAmount, setFixedAmount] = useState("");
  const [countAsCost, setCountAsCost] = useState(false);
  const [dividendPeriod, setDividendPeriod] = useState("月");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const { data: shareholders } = useQuery({ queryKey: ["shareholders"], queryFn: () => listShareholders(), enabled: type === "shareholder" });
  const { data: introducers } = useQuery({ queryKey: ["introducers"], queryFn: () => listIntroducers(), enabled: type === "introducer" });

  const targets = type === "shareholder" ? shareholders : introducers;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!landlordId) throw new Error("请先选择场地方");
      if (!targetId) throw new Error(type === "shareholder" ? "请选择股东" : "请选择介绍人");
      if (mode !== "固定金额" && !ratio) throw new Error("请输入比例");
      if (mode === "固定金额" && !fixedAmount) throw new Error("请输入固定金额");
      const endpoint = type === "shareholder" ? "/api/dividends/configs/shareholder" : "/api/dividends/configs/introducer";
      const body: any = type === "shareholder"
        ? { landlordId, shareholderId: targetId, brandId: brandId || null, mode, ratio: mode !== "固定金额" ? Number(ratio) / 100 : null, fixedAmount: mode === "固定金额" ? Number(fixedAmount) : null, settlementPeriod: dividendPeriod, startDate: startDate || null, endDate: endDate || null }
        : { landlordId, introducerId: targetId, brandId: brandId || null, mode, ratio: mode !== "固定金额" ? Number(ratio) / 100 : null, fixedAmount: mode === "固定金额" ? Number(fixedAmount) : null, countAsCost, settlementPeriod: dividendPeriod, startDate: startDate || null, endDate: endDate || null };
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("配置失败");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholderConfigs"] });
      qc.invalidateQueries({ queryKey: ["introducerConfigs"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      qc.invalidateQueries({ queryKey: ["stationBoard"] });
      toast.success("配置成功");
      onClose();
    },
    onError: (e: any) => toast.error(e.message || "配置失败"),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-800">{type === "shareholder" ? "配置股东分红" : "配置商务分红"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">{type === "shareholder" ? "选择股东" : "选择介绍人"} <span className="text-rose-500">*</span></label>
            <select className={inputCls} value={targetId || ""} onChange={e => setTargetId(Number(e.target.value) || null)}>
              <option value="">{type === "shareholder" ? "请选择股东" : "请选择介绍人"}</option>
              {targets?.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">品牌范围</label>
            <select className={inputCls} value={brandId} onChange={e => setBrandId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">整个场地（全部品牌）</option>
              {brands?.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <div className="mt-1 text-[10px] text-slate-400">选择品牌则只参与该品牌的分红；留空参与场地全部分红</div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">分红模式</label>
            <select className={inputCls} value={mode} onChange={e => setMode(e.target.value)}>
              <option value="收入分红">收入分红（按总收入比例）</option>
              <option value="利润分红">利润分红（按净利润比例）</option>
              <option value="固定金额">固定金额</option>
            </select>
          </div>
          {mode === "收入分红" && (
            <div>
              <label className="mb-1 block text-xs text-slate-500">收入分红比例 (%)</label>
              <input className={inputCls} type="number" value={ratio} onChange={e => setRatio(e.target.value)} placeholder="如：10 表示 10%" step="0.1" min="0" max="100" />
              <div className="mt-1 text-[10px] text-slate-400">分红基数 = 电费收款 + 租金收款</div>
            </div>
          )}
          {mode === "利润分红" && (
            <div>
              <label className="mb-1 block text-xs text-slate-500">利润分红比例 (%)</label>
              <input className={inputCls} type="number" value={ratio} onChange={e => setRatio(e.target.value)} placeholder="如：30 表示 30%" step="0.1" min="0" max="100" />
              <div className="mt-1 text-[10px] text-slate-400">分红基数 = 净利润（总收入 - 总成本）</div>
            </div>
          )}
          {mode === "固定金额" && (
            <div>
              <label className="mb-1 block text-xs text-slate-500">固定金额 (元/月)</label>
              <input className={inputCls} type="number" value={fixedAmount} onChange={e => setFixedAmount(e.target.value)} placeholder="如：5000" />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs text-slate-500">分红周期</label>
            <select className={inputCls} value={dividendPeriod} onChange={e => setDividendPeriod(e.target.value)}>
              <option value="月">月分红</option>
              <option value="季度">季度分红</option>
              <option value="半年">半年分红</option>
              <option value="年">年分红</option>
            </select>
            <div className="mt-1 text-[10px] text-slate-400">
              {dividendPeriod === "月" && "每月分红一次"}
              {dividendPeriod === "季度" && "每季度分红一次（3个月）"}
              {dividendPeriod === "半年" && "每半年分红一次（6个月）"}
              {dividendPeriod === "年" && "每年分红一次（12个月）"}
            </div>
          </div>
          {type === "introducer" && (
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <input type="checkbox" id="countAsCost" checked={countAsCost} onChange={e => setCountAsCost(e.target.checked)} className="rounded border-slate-300" />
              <label htmlFor="countAsCost" className="text-xs text-slate-600 cursor-pointer">商务分红计入成本（影响股东分红基数）</label>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-slate-500">生效日期</label>
              <input className={inputCls} type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">失效日期</label>
              <input className={inputCls} type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
              <div className="mt-1 text-[10px] text-slate-400">不填则长期有效</div>
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">取消</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50">
            {mutation.isPending ? "配置中…" : "确认配置"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 新增分红月结弹窗（v3：按场地 landlordId）───
function AddDividendDialog({ open, onClose, landlordId }: { open: boolean; onClose: () => void; landlordId?: number }) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [type, setType] = useState("股东分红");
  const [preview, setPreview] = useState<any>(null);

  const handlePreview = async () => {
    if (!landlordId || !period) { toast.error("请先选择场地方和月份"); return; }
    try {
      const result = await calculateDividend({ landlordId, period });
      setPreview(result);
    } catch (e: any) { toast.error(e.message || "计算失败"); }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (!landlordId || !period) throw new Error("请先选择场地方和月份");
      return createDividend({ landlordId, period, type });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dividends"] });
      qc.invalidateQueries({ queryKey: ["stationDividends"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      qc.invalidateQueries({ queryKey: ["shareholderSummary"] });
      toast.success("分红月结创建成功");
      onClose();
      setPreview(null);
    },
    onError: (e: any) => toast.error(e.message || "创建失败"),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[480px] rounded-xl bg-white p-5 shadow-xl max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-800">新增分红月结</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">选择月份 <span className="text-rose-500">*</span></label>
            <MonthPicker value={period} onChange={setPeriod} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">分红类型</label>
            <select className={inputCls} value={type} onChange={e => setType(e.target.value)}>
              <option value="股东分红">股东分红</option>
              <option value="商务分红">商务分红</option>
            </select>
          </div>
          <button onClick={handlePreview} className="w-full rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 hover:bg-emerald-100">
            预览分红计算
          </button>
          {preview && (
            <div className="rounded-lg border bg-slate-50 p-3 space-y-2 text-xs">
              <div className="font-semibold text-slate-700">分红预览</div>
              <div className="grid grid-cols-2 gap-2">
                <div><span className="text-slate-400">总收入：</span><span className="font-medium">{fmtMoney(preview.income?.totalIncome)}</span></div>
                <div><span className="text-slate-400">总成本：</span><span className="font-medium">{fmtMoney(preview.cost?.totalCost)}</span></div>
                <div><span className="text-slate-400">利润：</span><span className={`font-medium ${preview.profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(preview.profit)}</span></div>
              </div>
              {preview.shareholderDividends?.length > 0 && (
                <div>
                  <div className="font-semibold text-slate-600 mt-2">股东分红明细：</div>
                  {preview.shareholderDividends.map((d: any, i: number) => (
                    <div key={i} className="flex justify-between py-0.5">
                      <span>{d.shareholderName}{d.brandName ? <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-600">{d.brandName}</span> : null}</span>
                      <span className="font-medium">{fmtMoney(d.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
              {preview.bizDividends?.length > 0 && (
                <div>
                  <div className="font-semibold text-slate-600 mt-2">商务分红明细：</div>
                  {preview.bizDividends.map((d: any, i: number) => (
                    <div key={i} className="flex justify-between py-0.5">
                      <span>{d.introducerName}{d.brandName ? <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-600">{d.brandName}</span> : null}</span>
                      <span className="font-medium">{fmtMoney(d.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">取消</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50">
            {mutation.isPending ? "创建中…" : "确认创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 提交审批弹窗 ───
function SubmitApprovalDialog({ open, onClose, dividends, onSuccess }: { open: boolean; onClose: () => void; dividends: any[]; onSuccess: () => void }) {
  const [applicant, setApplicant] = useState("");
  const [supervisor, setSupervisor] = useState("");
  const [boss, setBoss] = useState("");

  const { data: platformUsers } = useQuery({
    queryKey: ["platformUsers"],
    queryFn: listPlatformUsers,
    enabled: open,
  });

  const supervisors = (platformUsers ?? []).filter((u: any) => u.role === "finance_supervisor");
  const bosses = (platformUsers ?? []).filter((u: any) => u.role === "boss");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!applicant.trim()) throw new Error("请填写操作人");
      if (!supervisor && !boss) throw new Error("请至少选择一位审批人");
      if (!dividends?.length) throw new Error("请选择要审批的分红记录");
      const first = dividends[0];
      const landlordName = first.landlordName || `场地#${first.landlordId}`;
      // 月份范围描述（如 202607 ~ 202608）
      const periods = dividends.map((d: any) => d.period).sort();
      const periodLabel = periods.length > 1 ? `${periods[0]} ~ ${periods[periods.length - 1]}` : (periods[0] || "");
      const totalAmount = dividends.reduce((s: number, d: any) => s + (d.shares?.reduce((x: number, sh: any) => x + Number(sh.amount || 0), 0) || 0), 0);
      return submitDividendApproval({
        dividendRecordId: first.id,
        dividendRecordIds: dividends.map((d: any) => d.id),
        landlordName,
        period: periodLabel,
        amount: totalAmount,
        applicant: applicant.trim(),
        approvers: { finance_supervisor: supervisor || undefined, boss: boss || undefined },
      });
    },
    onSuccess: () => { toast.success("已提交审批"); onSuccess(); onClose(); },
    onError: (e: any) => toast.error(e.message || "提交失败"),
  });

  if (!open || !dividends?.length) return null;

  const first = dividends[0];
  const landlordName = first.landlordName || `场地#${first.landlordId}`;
  const periods = dividends.map((d: any) => d.period).sort();
  const periodLabel = periods.length > 1 ? `${periods[0]} ~ ${periods[periods.length - 1]}` : (periods[0] || "");
  const totalProfit = dividends.reduce((s: number, d: any) => s + Number(d.profit || 0), 0);
  const totalAmount = dividends.reduce((s: number, d: any) => s + (d.shares?.reduce((x: number, sh: any) => x + Number(sh.amount || 0), 0) || 0), 0);

  // 构建审批流程预览
  const flowSteps = [applicant || "提交人"];
  if (supervisor) flowSteps.push(supervisor);
  if (boss) flowSteps.push(boss);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[420px] rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-800">提交分红审批</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>

        {/* 分红信息（多记录） */}
        <div className="rounded-lg border bg-slate-50 p-3 mb-4 space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-slate-500">场地</span><span className="font-medium text-slate-700">{landlordName}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">审批月份</span><span className="font-medium text-slate-700">{periodLabel}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">月份数</span><span className="font-medium text-slate-700">{dividends.length} 个月</span></div>
          <div className="flex justify-between"><span className="text-slate-500">利润合计</span><span className={`font-semibold tabular-nums ${totalProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(totalProfit)}</span></div>
          <div className="flex justify-between border-t pt-1"><span className="text-slate-500">分红总额</span><span className="font-semibold tabular-nums text-blue-600">{fmtMoney(totalAmount)}</span></div>
          {/* 各月明细 */}
          {dividends.map((d: any) => (
            <div key={d.id} className="border-t border-slate-200/60 pt-1 mt-1">
              <div className="flex justify-between">
                <span className="text-slate-500">{d.period} · {d.type}</span>
                <span className="tabular-nums text-slate-600">{fmtMoney(d.shares?.reduce((x: number, sh: any) => x + Number(sh.amount || 0), 0) || 0)}</span>
              </div>
              {d.shares?.map((s: any, i: number) => (
                <div key={i} className="flex justify-between pl-3">
                  <span className="text-slate-400">{s.shareholderName || s.introducerName || "-"}{s.brandName ? <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-600">{s.brandName}</span> : null}</span>
                  <span className="tabular-nums text-slate-600">{fmtMoney(s.amount)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* 审批人选择 */}
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">操作人（提交人）<span className="text-rose-500">*</span></label>
            <input className={inputCls} value={applicant} onChange={(e) => setApplicant(e.target.value)} placeholder="您的姓名" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">财务主管审核</label>
            <select className={inputCls} value={supervisor} onChange={(e) => setSupervisor(e.target.value)}>
              <option value="">不经过财务主管</option>
              {supervisors.map((u: any) => <option key={u.id} value={u.name}>{u.name}{u.phone ? ` (${u.phone})` : ""}</option>)}
            </select>
            {supervisors.length === 0 && <div className="mt-1 text-[10px] text-slate-400">如需添加，请在「Directory → 平台人员」中设置</div>}
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">老板审批</label>
            <select className={inputCls} value={boss} onChange={(e) => setBoss(e.target.value)}>
              <option value="">不经过老板</option>
              {bosses.map((u: any) => <option key={u.id} value={u.name}>{u.name}{u.phone ? ` (${u.phone})` : ""}</option>)}
            </select>
            {bosses.length === 0 && <div className="mt-1 text-[10px] text-slate-400">如需添加，请在「Directory → 平台人员」中设置</div>}
          </div>
          {!supervisor && !boss && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
              请至少选择一位审批人
            </div>
          )}
        </div>

        {/* 审批流程预览 */}
        {(supervisor || boss) && (
          <div className="mt-4 rounded-lg border bg-blue-50/50 p-3">
            <div className="text-[10px] font-semibold text-blue-600 mb-2">审批流程预览</div>
            <div className="flex items-center gap-1 text-[11px]">
              {flowSteps.map((step, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-slate-400">→</span>}
                  <span className={`rounded px-1.5 py-0.5 ${i === 0 ? "bg-blue-100 text-blue-700" : i === flowSteps.length - 1 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{step}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">取消</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || (!supervisor && !boss)} className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50">
            {mutation.isPending ? "提交中…" : "确认提交审批"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 导出日期范围弹窗 ───
function ExportDateDialog({ open, onClose, onConfirm, hint }: { open: boolean; onClose: () => void; onConfirm: (start: string, end: string) => void; hint?: string }) {
  const [start, setStart] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-01`;
  });
  const [end, setEnd] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-80 rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-800">选择导出日期范围</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        {hint && (
          <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-700">
            {hint}
          </div>
        )}
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">起始月份</label>
            <input type="month" className={inputCls} value={start} onChange={e => setStart(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">截止月份</label>
            <input type="month" className={inputCls} value={end} onChange={e => setEnd(e.target.value)} />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">取消</button>
          <button onClick={() => { if (start > end) { toast.error("起始月份不能大于截止月份"); return; } onConfirm(start, end); }} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs text-white hover:bg-emerald-700">
            确认导出
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 主页面 ───
export default function Shareholders() {
  const qc = useQueryClient();
  const [viewMode, setViewMode] = useState<"shareholder" | "station">("shareholder");
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  // 场地汇总视图的日期粒度：月 / 季度 / 半年
  const [stationGranularity, setStationGranularity] = useState<"month" | "quarter" | "halfYear">("month");
  // 股东汇总视图的月份范围（起止月，场地汇总仍用 selectedMonth 单月）
  const [summaryStartMonth, setSummaryStartMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [summaryEndMonth, setSummaryEndMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // 股东汇总期间快捷范围：本月 / 本季度 / 本半年（自动设置起止月）
  const setSummaryRange = (g: "month" | "quarter" | "halfYear") => {
    const anchor = summaryEndMonth || new Date().toISOString().slice(0, 7);
    const [y, m] = anchor.split("-").map(Number);
    const pad = (n: number) => String(n).padStart(2, "0");
    if (g === "month") {
      setSummaryStartMonth(`${y}-${pad(m)}`);
      setSummaryEndMonth(`${y}-${pad(m)}`);
    } else if (g === "quarter") {
      const qs = Math.floor((m - 1) / 3) * 3 + 1;
      setSummaryStartMonth(`${y}-${pad(qs)}`);
      setSummaryEndMonth(`${y}-${pad(qs + 2)}`);
    } else {
      const hs = m <= 6 ? 1 : 7;
      setSummaryStartMonth(`${y}-${pad(hs)}`);
      setSummaryEndMonth(`${y}-${pad(hs + 5)}`);
    }
  };
  const summaryPresetActive = (g: "month" | "quarter" | "halfYear"): boolean => {
    if (!summaryStartMonth || !summaryEndMonth) return false;
    const anchor = summaryEndMonth;
    const [y, m] = anchor.split("-").map(Number);
    const pad = (n: number) => String(n).padStart(2, "0");
    let s = "", e = "";
    if (g === "month") { s = `${y}-${pad(m)}`; e = s; }
    else if (g === "quarter") { const qs = Math.floor((m - 1) / 3) * 3 + 1; s = `${y}-${pad(qs)}`; e = `${y}-${pad(qs + 2)}`; }
    else { const hs = m <= 6 ? 1 : 7; s = `${y}-${pad(hs)}`; e = `${y}-${pad(hs + 5)}`; }
    return summaryStartMonth === s && summaryEndMonth === e;
  };

  // 弹窗状态
  const [addShareholderOpen, setAddShareholderOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState<{ open: boolean; type: "shareholder" | "introducer"; landlordId?: number }>({ open: false, type: "shareholder" });
  const [addDividendOpen, setAddDividendOpen] = useState<{ open: boolean; landlordId?: number }>({ open: false });
  const [expandedShareholderId, setExpandedShareholderId] = useState<number | null>(null);
  const [expandedBrandId, setExpandedBrandId] = useState<number | null>(null);
  const [exportDateOpen, setExportDateOpen] = useState(false);
  const [exportHint, setExportHint] = useState<string | undefined>();

  // ─── 数据查询 ───
  const { data: shareholders } = useQuery({ queryKey: ["shareholders"], queryFn: () => listShareholders() });

  const { data: shareholderSummaryData, isLoading: shLoading } = useQuery({
    queryKey: ["shareholderSummary", summaryStartMonth, summaryEndMonth],
    queryFn: () => shareholderSummary({
      periodStart: summaryStartMonth ? summaryStartMonth.replace("-", "") : undefined,
      periodEnd: summaryEndMonth ? summaryEndMonth.replace("-", "") : undefined,
    }),
    enabled: viewMode === "shareholder",
  });

  // 获取所有股东分红配置（用于显示股东关联的场地）
  const { data: allShConfigs } = useQuery({
    queryKey: ["shareholderConfigs"],
    queryFn: () => listShareholderConfigs(),
    enabled: viewMode === "shareholder",
  });

  // 场地汇总数据（用于股东汇总中显示各场地经营数据）
  const { data: stationBoardForSH } = useQuery({
    queryKey: ["stationBoard", selectedMonth],
    queryFn: () => getStationBoard({ period: selectedMonth }),
    enabled: viewMode === "shareholder",
  });

  // ─── 场地汇总：日期粒度（月/季度/半年）────────────────────
  // 由锚点月份推导出所选粒度覆盖的月份列表（季度=该季度3个月，半年=上半年/下半年6个月）
  const stationPeriodMonths = useMemo(() => {
    if (viewMode !== "station") return [];
    // 未选月份时保持原行为：拉取一次不带 period 的全场看板
    if (!selectedMonth) return [""];
    const [y, m] = selectedMonth.split("-").map(Number);
    if (!y || !m) return [];
    if (stationGranularity === "quarter") {
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      return [0, 1, 2].map((i) => `${y}-${String(qStart + i).padStart(2, "0")}`);
    }
    if (stationGranularity === "halfYear") {
      const hStart = m <= 6 ? 1 : 7;
      return Array.from({ length: 6 }, (_, i) => `${y}-${String(hStart + i).padStart(2, "0")}`);
    }
    return [selectedMonth];
  }, [viewMode, stationGranularity, selectedMonth]);

  // 场地汇总期间展示标签（如 2026年8月 / 2026年第3季度 / 2026年上半年）
  const stationPeriodLabel = useMemo(() => {
    if (viewMode !== "station" || !selectedMonth) return selectedMonth || "";
    const [y, m] = selectedMonth.split("-").map(Number);
    if (!y || !m) return selectedMonth;
    if (stationGranularity === "quarter") return `${y}年第${Math.floor((m - 1) / 3) + 1}季度`;
    if (stationGranularity === "halfYear") return `${y}年${m <= 6 ? "上" : "下"}半年`;
    return `${y}年${m}月`;
  }, [viewMode, stationGranularity, selectedMonth]);

  // 场地汇总：按所选粒度（月/季度/半年）逐月拉取场地看板，再按场地方聚合
  const stationBoardQueries = useQueries({
    queries: stationPeriodMonths.map((month) => ({
      queryKey: ["stationBoard", month],
      queryFn: () => getStationBoard({ period: month }),
      enabled: viewMode === "station",
    })),
  });
  const stLoading = stationBoardQueries.some((q) => q.isPending);
  const stationBoard = useMemo(() => {
    if (viewMode !== "station") return [];
    const boards = stationBoardQueries.map((q) => q.data ?? []).filter(Array.isArray);
    if (boards.length === 0) return [];
    // 数值科目按月累加；静态信息（电表/场地/合同）取首个可用月份
    const NUMERIC = ["totalKwh", "elecPay", "elecCollect", "elecProfit", "rentCost", "rentIncome", "rentProfit", "opExpense", "totalProfit"] as const;
    const map = new Map<number, any>();
    for (const board of boards) {
      for (const row of board) {
        const lid = row?.landlord?.id;
        if (lid == null) continue;
        if (!map.has(lid)) map.set(lid, { ...row });
        const cur = map.get(lid);
        for (const k of NUMERIC) cur[k] = Math.round(((cur[k] || 0) + (row[k] || 0)) * 100) / 100;
      }
    }
    return [...map.values()];
  }, [viewMode, stationBoardQueries]);

  // ─── 股东汇总：合并所有股东（含没有分红记录的）───
  const allShareholders = useMemo(() => {
    const map = new Map<number, any>();
    if (shareholders) {
      for (const sh of shareholders) {
        map.set(sh.id, { id: sh.id, name: sh.name, phone: sh.phone, totalAmount: 0, settledAmount: 0, pendingAmount: 0, details: [], hasRecords: false });
      }
    }
    if (shareholderSummaryData) {
      for (const s of shareholderSummaryData) {
        const existing = map.get(s.shareholderId);
        if (existing) {
          existing.totalAmount = s.totalAmount;
          existing.settledAmount = s.settledAmount;
          existing.pendingAmount = s.pendingAmount;
          existing.details = s.details;
          existing.hasRecords = true;
        } else {
          map.set(s.shareholderId, { id: s.shareholderId, name: s.shareholderName, totalAmount: s.totalAmount, settledAmount: s.settledAmount, pendingAmount: s.pendingAmount, details: s.details, hasRecords: true });
        }
      }
    }
    return Array.from(map.values());
  }, [shareholders, shareholderSummaryData]);

  // 分红配置是否在所选月份生效（start_date/end_date 为空视为长期有效）
  const isConfigActiveForMonth = useCallback((cfg: any, month: string) => {
    if (!month) return true;
    const start = cfg?.startDate ? String(cfg.startDate).slice(0, 7) : "";
    const end = cfg?.endDate ? String(cfg.endDate).slice(0, 7) : "";
    if (start && start > month) return false;
    if (end && end < month) return false;
    return true;
  }, []);

  // 分红配置是否在所选范围内任一月份生效（起止月范围内有交集）
  const isConfigActiveForRange = useCallback((cfg: any, startMonth: string, endMonth: string) => {
    const start = cfg?.startDate ? String(cfg.startDate).slice(0, 7) : "";
    const end = cfg?.endDate ? String(cfg.endDate).slice(0, 7) : "";
    // 配置生效期 [start,end] 与查询范围 [startMonth,endMonth] 有交集
    const cfgStart = start || "0000-00";
    const cfgEnd = end || "9999-12";
    const queryStart = startMonth || "0000-00";
    const queryEnd = endMonth || "9999-12";
    return cfgStart <= queryEnd && cfgEnd >= queryStart;
  }, []);

  const selectedShareholder = useMemo(() => {
    if (viewMode !== "shareholder" || !selectedId) return null;
    return allShareholders.find(s => s.id === selectedId) || null;
  }, [viewMode, selectedId, allShareholders]);

  // 选中股东的分红配置（仅显示所选月份生效的）
  const shareholderConfigs = useMemo(() => {
    if (!selectedId || !allShConfigs) return [];
    return allShConfigs.filter((c: any) => c.shareholderId === selectedId && isConfigActiveForRange(c, summaryStartMonth, summaryEndMonth));
  }, [selectedId, allShConfigs, summaryStartMonth, summaryEndMonth, isConfigActiveForRange]);

  // 股东涉及场地的完整分红记录（用于新增月结/提交审批；v3：配置已挂 landlord_id）
  const shareholderLandlordIds = useMemo(() => {
    const ids = shareholderConfigs.map((c: any) => c.landlordId).filter(Boolean);
    return [...new Set(ids)] as number[];
  }, [shareholderConfigs]);

  const shareholderLandlordDividends = useQueries({
    queries: shareholderLandlordIds.map((lid: number) => ({
      queryKey: ["landlordDividends", lid],
      queryFn: () => listDividends({ landlordId: lid }),
      enabled: viewMode === "shareholder",
    })),
  });
  const landlordDividendsMap = useMemo(() => {
    const map = new Map<number, any[]>();
    shareholderLandlordDividends.forEach((q, i) => {
      const lid = shareholderLandlordIds[i];
      if (lid && q.data) map.set(lid, q.data);
    });
    return map;
  }, [shareholderLandlordDividends, shareholderLandlordIds]);

  // ─── 场地汇总：复用场地看板数据（按场地方分组）───
  const stationRows = useMemo(() => stationBoard ?? [], [stationBoard]);

  const selectedLandlord = useMemo(() => {
    if (viewMode !== "station" || !selectedId) return null;
    return stationRows.find((r: any) => r.landlord.id === selectedId) || null;
  }, [viewMode, selectedId, stationRows]);

  // 选中场地 ID（v3：直接以 landlord.id 作为分红维度）
  const landlordId = useMemo(() => selectedLandlord?.landlord?.id ?? null, [selectedLandlord]);

  // 该场地下的品牌列表：从 contracts 品牌方合同提取（品牌 = 公司租给哪些品牌放柜）
  const landlordBrands = useMemo(() => {
    if (!selectedLandlord?.contractBreakdown) return [];
    const seen = new Map<number, string>();
    for (const cb of selectedLandlord.contractBreakdown ?? []) {
      if (cb.type === "品牌方合同" && cb.brandId) {
        seen.set(cb.brandId, cb.brandName || `品牌#${cb.brandId}`);
      }
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [selectedLandlord]);

  const { data: shConfigs } = useQuery({
    queryKey: ["shareholderConfigs", landlordId],
    queryFn: () => listShareholderConfigs({ landlordId: landlordId! }),
    enabled: viewMode === "station" && landlordId !== null,
  });
  // 场地汇总：仅显示所选期间生效的股东分红配置（月=单月生效；季度/半年=期间有交集）
  const activeShConfigs = useMemo(() => {
    const configs = shConfigs ?? [];
    if (stationGranularity === "month") {
      return configs.filter((c: any) => isConfigActiveForMonth(c, selectedMonth));
    }
    const start = stationPeriodMonths[0];
    const end = stationPeriodMonths[stationPeriodMonths.length - 1];
    if (!start || !end) return configs;
    return configs.filter((c: any) => isConfigActiveForRange(c, start, end));
  }, [shConfigs, stationGranularity, selectedMonth, stationPeriodMonths, isConfigActiveForMonth, isConfigActiveForRange]);

  const { data: intConfigs } = useQuery({
    queryKey: ["introducerConfigs", landlordId],
    queryFn: () => listIntroducerConfigs({ landlordId: landlordId! }),
    enabled: viewMode === "station" && landlordId !== null,
  });

  // 选中场地方的分红记录（月=单月；季度/半年=合并期间各月记录）
  const stationDividendQueries = useQueries({
    queries: stationPeriodMonths.map((month) => ({
      queryKey: ["stationDividends", landlordId, month],
      queryFn: () => listDividends({ landlordId: landlordId!, period: month || undefined }),
      enabled: viewMode === "station" && landlordId !== null,
    })),
  });
  const stationDividends = useMemo(() => {
    const merged: any[] = [];
    for (const q of stationDividendQueries) {
      if (q.data) merged.push(...q.data);
    }
    return merged;
  }, [stationDividendQueries]);

  // 期间分红汇总（季度/半年时）：按类型合计 + 按股东/介绍人聚合整期金额
  const stationDividendSummary = useMemo(() => {
    if (stationGranularity === "month") return null;
    const byType = { 股东分红: 0, 商务分红: 0 } as Record<string, number>;
    const byPerson = new Map<string, { name: string; brandName?: string; amount: number }>();
    for (const r of stationDividends) {
      const typeSum = (r.shares ?? []).reduce((s: number, sh: any) => s + Number(sh.amount || 0), 0);
      if (typeSum) byType[r.type === "商务分红" ? "商务分红" : "股东分红"] = (byType[r.type === "商务分红" ? "商务分红" : "股东分红"] || 0) + typeSum;
      for (const sh of r.shares ?? []) {
        const name = sh.shareholderName || sh.introducerName || "-";
        const key = `${name}|${sh.brandName || ""}`;
        const cur = byPerson.get(key) || { name, brandName: sh.brandName, amount: 0 };
        cur.amount += Number(sh.amount || 0);
        byPerson.set(key, cur);
      }
    }
    return {
      total: byType["股东分红"] + byType["商务分红"],
      byType,
      persons: [...byPerson.values()].sort((a, b) => b.amount - a.amount),
    };
  }, [stationDividends, stationGranularity]);

  // 分红预估计算（月=单月；季度/半年=逐月计算后按股东/品牌/收支科目加总）
  const stationPreviewQueries = useQueries({
    queries: stationPeriodMonths.map((month) => ({
      queryKey: ["dividendPreview", landlordId, month],
      queryFn: async () => {
        try {
          return await calculateDividend({ landlordId: landlordId!, period: month });
        } catch {
          return null;
        }
      },
      enabled: viewMode === "station" && landlordId !== null && !!month,
    })),
  });
  const dividendPreview = useMemo(() => {
    const items = stationPreviewQueries.map((q) => q.data).filter(Boolean);
    if (items.length === 0) return null;
    // 单月：直接返回原始结果（保留电表/合同等明细）
    if (items.length === 1) return items[0];
    const agg: any = {
      income: { totalIncome: 0, elecIncome: { total: 0 }, rentIncome: { total: 0 } },
      cost: { totalCost: 0, elecCost: 0, rentCost: 0, opExpense: 0, elecTax: 0, rentTax: 0, rentRefund: 0, bizDividendCost: 0 },
      profit: 0,
      brandBreakdown: [],
      shareholderDividends: [],
      bizDividends: [],
    };
    const brandMap = new Map<number, any>();
    const shMap = new Map<number, any>();
    const bizMap = new Map<number, any>();
    const round2 = (n: number) => Math.round((n || 0) * 100) / 100;
    for (const d of items) {
      agg.income.totalIncome += d.income?.totalIncome || 0;
      agg.income.elecIncome.total += d.income?.elecIncome?.total || 0;
      agg.income.rentIncome.total += d.income?.rentIncome?.total || 0;
      agg.cost.totalCost += d.cost?.totalCost || 0;
      agg.cost.elecCost += d.cost?.elecCost || 0;
      agg.cost.rentCost += d.cost?.rentCost || 0;
      agg.cost.opExpense += d.cost?.opExpense || 0;
      agg.cost.elecTax += d.cost?.elecTax || 0;
      agg.cost.rentTax += d.cost?.rentTax || 0;
      agg.cost.rentRefund += d.cost?.rentRefund || 0;
      agg.cost.bizDividendCost += d.cost?.bizDividendCost || 0;
      agg.profit += d.profit || 0;
      // 品牌收支按品牌加总
      for (const b of d.brandBreakdown ?? []) {
        const cur = brandMap.get(b.brandId) || { brandId: b.brandId, brandName: b.brandName, income: 0, rentIncome: 0, elecIncome: 0, venueCost: 0, elecCost: 0, elecTax: 0, rentTax: 0, profit: 0 };
        cur.income += b.income || 0; cur.rentIncome += b.rentIncome || 0; cur.elecIncome += b.elecIncome || 0;
        cur.venueCost += b.venueCost || 0; cur.elecCost += b.elecCost || 0; cur.elecTax += b.elecTax || 0; cur.rentTax += b.rentTax || 0;
        cur.profit += b.profit || 0;
        brandMap.set(b.brandId, cur);
      }
      // 股东分红按股东加总（元数据保留首月）
      for (const sh of d.shareholderDividends ?? []) {
        const cur = shMap.get(sh.shareholderId) || { ...sh, amount: 0, baseAmount: 0 };
        cur.amount += sh.amount || 0;
        cur.baseAmount = (cur.baseAmount || 0) + (sh.baseAmount || 0);
        shMap.set(sh.shareholderId, cur);
      }
      // 商务分红按介绍人加总
      for (const bz of d.bizDividends ?? []) {
        const cur = bizMap.get(bz.introducerId) || { ...bz, amount: 0, baseAmount: 0 };
        cur.amount += bz.amount || 0;
        cur.baseAmount = (cur.baseAmount || 0) + (bz.baseAmount || 0);
        bizMap.set(bz.introducerId, cur);
      }
    }
    agg.income.totalIncome = round2(agg.income.totalIncome);
    agg.income.elecIncome.total = round2(agg.income.elecIncome.total);
    agg.income.rentIncome.total = round2(agg.income.rentIncome.total);
    agg.cost.totalCost = round2(agg.cost.totalCost);
    agg.cost.elecCost = round2(agg.cost.elecCost);
    agg.cost.rentCost = round2(agg.cost.rentCost);
    agg.cost.opExpense = round2(agg.cost.opExpense);
    agg.cost.elecTax = round2(agg.cost.elecTax);
    agg.cost.rentTax = round2(agg.cost.rentTax);
    agg.cost.rentRefund = round2(agg.cost.rentRefund);
    agg.cost.bizDividendCost = round2(agg.cost.bizDividendCost);
    agg.profit = round2(agg.profit);
    for (const b of brandMap.values()) {
      for (const k of ["income", "rentIncome", "elecIncome", "venueCost", "elecCost", "elecTax", "rentTax", "profit"]) b[k] = round2(b[k]);
    }
    for (const sh of shMap.values()) sh.amount = round2(sh.amount);
    for (const bz of bizMap.values()) bz.amount = round2(bz.amount);
    agg.brandBreakdown = [...brandMap.values()];
    agg.shareholderDividends = [...shMap.values()];
    agg.bizDividends = [...bizMap.values()];
    return agg;
  }, [stationPreviewQueries]);

  // 股东汇总：为「品牌范围」配置的场地拉取各自的分红预估（按品牌口径计算）
  const shareholderPreviewLandlords = useMemo(() => {
    if (viewMode !== "shareholder") return [];
    const ids = shareholderConfigs.map((c: any) => c.landlordId).filter(Boolean);
    return [...new Set(ids)] as number[];
  }, [viewMode, shareholderConfigs]);

  // 股东汇总范围内月份列表（如 2026-07 ~ 2026-08 → ['2026-07','2026-08']）
  const summaryMonths = useMemo(() => {
    if (!summaryStartMonth || !summaryEndMonth) return [summaryEndMonth || summaryStartMonth].filter(Boolean);
    if (summaryStartMonth > summaryEndMonth) return [summaryStartMonth];
    const months: string[] = [];
    let [y, m] = summaryStartMonth.split("-").map(Number);
    const [ey, em] = summaryEndMonth.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return months;
  }, [summaryStartMonth, summaryEndMonth]);

  // 股东汇总的期间展示标签（起止相同则显示单月）
  const summaryRangeLabel = useMemo(() => {
    if (!summaryStartMonth || !summaryEndMonth) return summaryEndMonth || summaryStartMonth || "";
    return summaryStartMonth === summaryEndMonth ? summaryStartMonth : `${summaryStartMonth} ~ ${summaryEndMonth}`;
  }, [summaryStartMonth, summaryEndMonth]);

  // 对每个场地 × 范围内每月拉 calculateDividend，按场地加总
  const shareholderPreviewPairs = useMemo(() => {
    const pairs: { lid: number; month: string }[] = [];
    for (const lid of shareholderPreviewLandlords) {
      for (const month of summaryMonths) {
        pairs.push({ lid, month });
      }
    }
    return pairs;
  }, [shareholderPreviewLandlords, summaryMonths]);

  const shareholderPreviews = useQueries({
    queries: shareholderPreviewPairs.map(({ lid, month }: { lid: number; month: string }) => ({
      queryKey: ["dividendPreview", lid, month],
      queryFn: async () => {
        try {
          return { lid, month, data: await calculateDividend({ landlordId: lid, period: month }) };
        } catch {
          return null;
        }
      },
      enabled: viewMode === "shareholder" && !!month,
    })),
  });

  // 按场地聚合范围内各月分红（收入/成本/净利润/品牌明细加总）
  const shareholderPreviewMap = useMemo(() => {
    const map = new Map<number, any>();
    for (const q of shareholderPreviews) {
      const item = q.data as { lid?: number; month?: string; data?: any } | null | undefined;
      if (!item || !item.lid || !item.data) continue;
      const lid = item.lid;
      const d = item.data;
      const cur = map.get(lid) || { income: { totalIncome: 0, elecIncome: { total: 0 }, rentIncome: { total: 0 } }, cost: { totalCost: 0, elecCost: 0, rentCost: 0, opExpense: 0, elecTax: 0, rentTax: 0, rentRefund: 0, bizDividendCost: 0 }, profit: 0, brandBreakdown: new Map() };
      cur.income.totalIncome += d.income?.totalIncome || 0;
      cur.income.elecIncome.total += d.income?.elecIncome?.total || 0;
      cur.income.rentIncome.total += d.income?.rentIncome?.total || 0;
      cur.cost.totalCost += d.cost?.totalCost || 0;
      cur.cost.elecCost += d.cost?.elecCost || 0;
      cur.cost.rentCost += d.cost?.rentCost || 0;
      cur.cost.opExpense += d.cost?.opExpense || 0;
      cur.cost.elecTax += d.cost?.elecTax || 0;
      cur.cost.rentTax += d.cost?.rentTax || 0;
      cur.cost.rentRefund += d.cost?.rentRefund || 0;
      cur.cost.bizDividendCost += d.cost?.bizDividendCost || 0;
      cur.profit += d.profit || 0;
      // 品牌明细加总（按 brandId 累加收入/利润）
      for (const b of d.brandBreakdown ?? []) {
        const bcur = cur.brandBreakdown.get(b.brandId) || { brandId: b.brandId, brandName: b.brandName, income: 0, profit: 0 };
        bcur.income += b.income || 0;
        bcur.profit += b.profit || 0;
        cur.brandBreakdown.set(b.brandId, bcur);
      }
      map.set(lid, cur);
    }
    // 把 Map 转回数组（便于前端 .find）
    for (const [, v] of map) {
      v.brandBreakdown = [...v.brandBreakdown.values()];
    }
    return map;
  }, [shareholderPreviews]);

  // 运营费用（月=单月；季度/半年=合并期间各月；v3：按场地 landlordId）
  const expenseQueries = useQueries({
    queries: stationPeriodMonths.map((month) => ({
      queryKey: ["expenses", landlordId, month],
      queryFn: () => listExpenses({ landlordId: landlordId!, period: month }),
      enabled: viewMode === "station" && landlordId !== null && !!month,
    })),
  });
  const expenses = useMemo(() => {
    const merged: any[] = [];
    for (const q of expenseQueries) {
      if (q.data) merged.push(...q.data);
    }
    return merged;
  }, [expenseQueries]);

  // 长周期（季度/半年）下：由已拉取的各月数据组成「按月明细」，供下钻查看
  const stationMonthlyRows = useMemo(() => {
    if (viewMode !== "station" || stationGranularity === "month") return [];
    const lid = selectedLandlord?.landlord?.id;
    return stationPeriodMonths.map((month, i) => {
      const board = stationBoardQueries[i]?.data ?? [];
      const row = (Array.isArray(board) ? board : []).find((r: any) => r.landlord?.id === lid);
      const records = stationDividendQueries[i]?.data ?? [];
      const preview = stationPreviewQueries[i]?.data ?? null;
      const shAmount = (preview?.shareholderDividends ?? []).reduce((s: number, d: any) => s + (d.amount || 0), 0);
      const bizAmount = (preview?.bizDividends ?? []).reduce((s: number, d: any) => s + (d.amount || 0), 0);
      const recordedAmount = (Array.isArray(records) ? records : []).reduce(
        (s: number, r: any) => s + (r.shares?.reduce((x: number, sh: any) => x + Number(sh.amount || 0), 0) || 0),
        0
      );
      return {
        month,
        totalKwh: row?.totalKwh || 0,
        elecCollect: row?.elecCollect || 0,
        elecPay: row?.elecPay || 0,
        rentIncome: row?.rentIncome || 0,
        rentCost: row?.rentCost || 0,
        opExpense: row?.opExpense || 0,
        totalProfit: row?.totalProfit || 0,
        shAmount,
        bizAmount,
        recordedAmount,
      };
    });
  }, [viewMode, stationGranularity, stationPeriodMonths, selectedLandlord, stationBoardQueries, stationDividendQueries, stationPreviewQueries]);

  const [expenseDraft, setExpenseDraft] = useState({ amount: "", remark: "" });
  const [editExpenseId, setEditExpenseId] = useState<number | null>(null);
  const [editExpenseDraft, setEditExpenseDraft] = useState({ amount: "", remark: "" });

  const saveExpenseMut = useMutation({
    mutationFn: (data: any) => saveExpense(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      qc.invalidateQueries({ queryKey: ["stationBoard"] });
      setExpenseDraft({ amount: "", remark: "" });
      toast.success("已保存");
    },
    onError: (e: any) => toast.error(e.message || "保存失败"),
  });

  const deleteExpenseMut = useMutation({
    mutationFn: (id: number) => deleteExpense(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      qc.invalidateQueries({ queryKey: ["stationBoard"] });
      toast.success("已删除");
    },
    onError: () => toast.error("删除失败"),
  });

  // 审批相关
  const [submitApprovalDiv, setSubmitApprovalDiv] = useState<any>(null);
  // 股东汇总分红记录的多选（待批量提交审批的未结算记录 id）
  const [selectedApprovalIds, setSelectedApprovalIds] = useState<number[]>([]);
  const toggleApprovalSelect = useCallback((id: number) => {
    setSelectedApprovalIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }, []);
  const openBatchApproval = useCallback((dividends: any[]) => {
    setSubmitApprovalDiv(dividends);
  }, []);

  const deleteConfigMut = useMutation({
    mutationFn: async ({ type, id }: { type: "shareholder" | "introducer"; id: number }) => {
      if (type === "shareholder") return deleteShareholderConfig(id);
      return deleteIntroducerConfig(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholderConfigs"] });
      qc.invalidateQueries({ queryKey: ["introducerConfigs"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      qc.invalidateQueries({ queryKey: ["stationBoard"] });
      toast.success("配置已删除");
    },
    onError: () => toast.error("删除失败"),
  });

  const isLoading = viewMode === "shareholder" ? shLoading : stLoading;

  // ─── 导出表格 ───
  const doExport = useCallback(async () => {
    if (viewMode === "shareholder") {
      if (!selectedShareholder) { toast.error("请先选择股东"); return; }
      const configs = shareholderConfigs;
      if (!configs || configs.length === 0) { toast.error("该股东暂无分红配置"); return; }
      // 从配置中提取分红周期作为提示
      const periods = [...new Set(configs.map((c: any) => c.settlementPeriod || "月"))];
      const periodText = periods.length === 1
        ? periods[0] === "月" ? "每月" : periods[0] === "季度" ? "每季度" : periods[0] === "半年" ? "每半年" : "每年"
        : periods.join("、");
      setExportHint(`该股东的分红周期为${periodText}，请选择对应的时间段导出`);
      setExportDateOpen(true);
    } else {
      // ── 场地汇总导出：弹窗选择日期范围 ──
      if (!selectedLandlord) { toast.error("请先选择场地方"); return; }
      setExportHint(undefined);
      setExportDateOpen(true);
    }
  }, [viewMode, selectedShareholder, shareholderConfigs, selectedLandlord]);

  // 股东汇总导出（日期范围确认后）
  const doShareholderExport = useCallback(async (startMonth: string, endMonth: string) => {
    if (!selectedShareholder) return;
    setExportDateOpen(false);

    const configs = shareholderConfigs;

    const [startY, startM] = startMonth.split("-").map(Number);
    const [endY, endM] = endMonth.split("-").map(Number);
    const numMonths = (endY - startY) * 12 + (endM - startM) + 1;

    // 生成时间段标签
    let periodLabel: string;
    if (numMonths === 1) {
      periodLabel = `${startY}年${startM}月`;
    } else if (numMonths === 3 && startM % 3 === 1) {
      const quarter = Math.floor((startM - 1) / 3) + 1;
      periodLabel = `${startY}年第${quarter}季度`;
    } else if (numMonths === 6 && (startM === 1 || startM === 7)) {
      periodLabel = `${startY}年${startM === 1 ? "上" : "下"}半年`;
    } else if (numMonths === 12 && startM === 1 && endM === 12) {
      periodLabel = `${startY}年`;
    } else {
      periodLabel = `${startMonth}至${endMonth}`;
    }

    // 生成月份列表
    const months: string[] = [];
    let y = startY, m = startM;
    while (y < endY || (y === endY && m <= endM)) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }

    try {
      // 按月查询场地看板数据
      const monthlyBoards = await Promise.all(
        months.map(period => getStationBoard({ period }).catch(() => []))
      );

      // 找到股东的占股比例
      const shRatio = configs[0]?.ratio ?? 0;

      const header1 = [
        "项目", "场地名称", "收付款情况", "", "", "", "", "", "",
        "分红明细", "",
      ];
      const header2 = [
        "", "", "柜子\n数量", "收款周期", "单柜月收入", "年租金\n收入", "月租金", `${numMonths}个月租金`, "商务分红（流水10%）",
        "应分红金额", selectedShareholder.name,
      ];

      const allRows: any[][] = [];

      for (const cfg of configs) {
        // 从任意一个月的 board 中取场地基本信息（这些跨月不变；v3：board 已按场地方分组）
        let stationData: any = null;
        for (const board of monthlyBoards) {
          stationData = (board ?? []).find((r: any) => r.landlord?.id === cfg.landlordId);
          if (stationData) break;
        }
        const stationName = cfg.landlordName || stationData?.landlord?.name || `场地#${cfg.landlordId}`;
        const brandContract = stationData?.contractBreakdown?.find((c: any) => c.type === "品牌方合同");
        const partner = brandContract?.partner || stationData?.landlord?.name || "";
        const cabinets = brandContract?.cabinetsCount || stationData?.meterCount || 0;
        const monthlyRent = brandContract?.monthlyRent || stationData?.rentIncome || 0;


        // 汇总所选月数的租金
        const periodRent = monthlyRent * numMonths;
        const annualRent = monthlyRent * 12;
        const bizDividend = Math.round(periodRent * 0.1 * 100) / 100;
        const netDividend = Math.round((periodRent - bizDividend) * 100) / 100;
        const shAmount = Math.round(netDividend * shRatio * 100) / 100;

        allRows.push([
          partner,
          cfg.brandName ? `${stationName}（${cfg.brandName}）` : stationName,
          cabinets, "", monthlyRent, annualRent, monthlyRent, periodRent, bizDividend,
          netDividend, shAmount,
        ]);
      }

      // 合计行
      const sumCabinets = allRows.reduce((s, r) => s + (Number(r[2]) || 0), 0);
      const sumMonthly = allRows.reduce((s, r) => s + (Number(r[4]) || 0), 0);
      const sumAnnual = allRows.reduce((s, r) => s + (Number(r[5]) || 0), 0);
      const sumPeriodRent = allRows.reduce((s, r) => s + (Number(r[7]) || 0), 0);
      const sumBiz = allRows.reduce((s, r) => s + (Number(r[8]) || 0), 0);
      const sumNet = allRows.reduce((s, r) => s + (Number(r[9]) || 0), 0);
      const sumSH = allRows.reduce((s, r) => s + (Number(r[10]) || 0), 0);
      allRows.push(["合计", "", sumCabinets, "", sumMonthly, sumAnnual, sumMonthly, sumPeriodRent, sumBiz, sumNet, sumSH]);

      // 备注和签名行
      allRows.push(["备注："]);
      allRows.push(["集冠科技负责人：", "", "", "", "", "", "", "", "", "", "来换电负责人："]);

      const aoa = [
        [`集冠科技&来换电合作场地${periodLabel}租金分红表`],
        header1,
        header2,
        ...allRows,
      ];

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }, // 标题
        { s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }, // 项目
        { s: { r: 1, c: 1 }, e: { r: 2, c: 1 } }, // 场地名称
        { s: { r: 1, c: 2 }, e: { r: 1, c: 8 } }, // 收付款情况
        { s: { r: 1, c: 9 }, e: { r: 1, c: 10 } }, // 分红明细
        { s: { r: 3 + allRows.length - 3, c: 0 }, e: { r: 3 + allRows.length - 3, c: 1 } }, // 合计
        { s: { r: 3 + allRows.length - 1, c: 0 }, e: { r: 3 + allRows.length - 1, c: 8 } }, // 备注
      ];
      ws["!cols"] = [
        { wch: 14 }, { wch: 18 }, { wch: 8 }, { wch: 14 }, { wch: 12 },
        { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 12 },
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "分红表");
      XLSX.writeFile(wb, `${periodLabel}${selectedShareholder.name}分红表.xlsx`);
      toast.success("导出成功");
    } catch (e: any) {
      toast.error("导出失败：" + (e.message || "未知错误"));
    }
  }, [selectedShareholder, shareholderConfigs]);

  // 场地汇总导出（日期范围确认后）
  const doStationExport = useCallback(async (startMonth: string, endMonth: string) => {
    if (!selectedLandlord) return;
    setExportDateOpen(false);

    const [startY, startM] = startMonth.split("-").map(Number);
    const [endY, endM] = endMonth.split("-").map(Number);

    // 生成月份列表
    const months: string[] = [];
    let y = startY, m = startM;
    while (y < endY || (y === endY && m <= endM)) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }

    // 获取所有股东（从 configs 中提取）
    const lid = landlordId;
    if (!lid) { toast.error("请先选择场地方"); return; }

    const configs = shConfigs ?? [];
    const shareholders = configs.map((c: any) => ({
      id: c.shareholderId,
      name: c.shareholderName,
      ratio: c.ratio || 0,
      brandName: c.brandName || "",
    }));

    if (shareholders.length === 0) { toast.error("暂无股东分红配置"); return; }

    try {
      // 获取合同信息
      const contracts = await listContracts({ landlordId: selectedLandlord.landlord.id });
      // 场地合同（付款方）
      const siteContract = contracts.find((c: any) => c.contractType === "场地合同");
      const payUnitPrice = siteContract ? Number(siteContract.electricityPrice || 0) : 0;
      // 品牌方合同（收款方）
      const brandContracts = contracts.filter((c: any) => c.contractType === "品牌方合同");
      const collectUnitPrice = brandContracts.length > 0 ? Number(brandContracts[0].electricityPrice || 0) : 0;

      // 获取场地下所有电表的 meter_no（v3：按 landlordId 查电表）
      const meters = await listMeters({ landlordId: lid });
      const meterNos = (Array.isArray(meters) ? meters : meters?.meters || []).map((m: any) => m.meterNo || m.meter_no).filter(Boolean);

      // 并行获取所有月份的分红数据、场地看板数据和电表读数
      const [monthlyResults, monthlyBoardResults, ...meterReadings] = await Promise.all([
        Promise.all(months.map(period => listDividends({ landlordId: lid, period }))),
        Promise.all(months.map(period => getStationBoard({ period }))),
        // 每个电表的月度读数
        ...meterNos.map((meterNo: string) => getMonthlyKwh({ meterNo, startMonth: toCompact(months[0]), endMonth: toCompact(months[months.length - 1]) })),
      ]);

      // 处理每月数据
      const monthlyData = months.map((period, idx) => {
        const records = monthlyResults[idx] || [];
        const boardData = monthlyBoardResults[idx] || [];
        const shAmounts: Record<number, number> = {};

        // 从电表读数获取该月总度数
        const monthPeriod = toCompact(period); // YYYY-MM -> YYYYMM
        let totalKwh = 0;
        for (const readings of meterReadings) {
          if (Array.isArray(readings)) {
            const monthReading = readings.find((r: any) => r.monthPeriod === monthPeriod);
            if (monthReading) {
              totalKwh += Number(monthReading.kwh || 0);
            }
          }
        }

        // 付款金额 = 度数 × 场地合同电费单价
        const payAmount = Math.round(totalKwh * payUnitPrice * 100) / 100;

        // 收款电费含税金额 = 度数 × 品牌方合同电费单价
        const collectAmount = Math.round(totalKwh * collectUnitPrice * 100) / 100;
        // 电费不含税金额 = 收款电费含税 / 1.01
        const collectNet = Math.round(collectAmount / 1.01 * 100) / 100;

        // 从分红记录获取股东分红金额
        for (const r of records) {
          for (const s of r.shares || []) {
            if (s.shareholderId) {
              shAmounts[s.shareholderId] = (shAmounts[s.shareholderId] || 0) + Number(s.amount || 0);
            }
          }
        }

        // 租金数据从每月的 stationBoard 获取（按场地方匹配）
        let rentAmount = 0, rentNet = 0;
        const landlordBoard = boardData.find((b: any) => b.landlord?.id === selectedLandlord.landlord.id);
        if (landlordBoard && records.length > 0) {
          rentAmount = landlordBoard.rentIncome || 0;
          rentNet = Math.round(rentAmount / 1.01 * 100) / 100;
        }

        // 电费租金收款合计 = 电费不含税 + 租金不含税 - 500（陈俊文垫付）
        const totalCollect = Math.round((collectNet + rentNet - 500) * 100) / 100;
        const profit = Math.round((totalCollect - payAmount) * 100) / 100;

        return { totalKwh, payUnitPrice, payAmount, collectAmount, collectNet, rentAmount, rentNet, totalCollect, profit, shAmounts };
      });

      // 构建 Excel - 参照参考文件格式
      const title = `${months[0].split("-")[0]}年${selectedLandlord.landlord.name}项目分红明细表`;
      const numSH = shareholders.length;
      // 第1行：标题
      const titleRow = [title];
      // 第2行：分组标题
      const header1 = [
        "分红月份", "付款情况", "", "", "收款情况", "", "", "", "", "利润", "分红明细",
        ...shareholders.map(() => ""), "备注",
      ];
      // 第3行：细分列标题
      const header2 = [
        "", "电量", "付款单价（元/度）", "付款金额（元）",
        "收款电费含税金额（元）", "电费不含税金额1%（元）", "收款租金含税金额（元）", "收款租金不含税金额1%（元）", "电费租金收款合计",
        "", "",
        ...shareholders.map((s: any) => (s.brandName ? `${s.name}（${s.brandName}）` : s.name)), "",
      ];
      // 第4行：分红比例
      const header3 = [
        "", "", "", "", "", "", "", "", "",
        "", "",
        ...shareholders.map((s: any) => s.ratio), "",
      ];

      const allRows: any[][] = [];
      let sumKwh = 0, sumPay = 0, sumCollect = 0, sumCollectNet = 0, sumRent = 0, sumRentNet = 0, sumTotal = 0;
      const sumSH: Record<number, number> = {};

      for (let i = 0; i < months.length; i++) {
        const d = monthlyData[i];
        const monthLabel = `${months[i].split("-")[1]}月`;
        allRows.push([
          monthLabel, d.totalKwh || "", d.payUnitPrice || "", d.payAmount || "",
          d.collectAmount || "", d.collectNet || "", d.rentAmount || "", d.rentNet || "", d.totalCollect || "",
          d.profit || "",
          "", // 分红明细空列（K列）
          ...shareholders.map((s: any) => d.shAmounts[s.id] || ""), "",
        ]);
        sumKwh += d.totalKwh; sumPay += d.payAmount; sumCollect += d.collectAmount;
        sumCollectNet += d.collectNet; sumRent += d.rentAmount; sumRentNet += d.rentNet; sumTotal += d.totalCollect;
        for (const s of shareholders) {
          sumSH[s.id] = (sumSH[s.id] || 0) + (d.shAmounts[s.id] || 0);
        }
      }

      // 合计行
      allRows.push([
        "合计", sumKwh || "", "", sumPay || "",
        sumCollect || "", sumCollectNet || "", sumRent || "", sumRentNet || "", sumTotal || "",
        "", "",
        ...shareholders.map((s: any) => sumSH[s.id] || ""), "",
      ]);

      // 构建 aoa：标题行 + 3行表头 + 数据行
      const aoa = [titleRow, header1, header2, header3, ...allRows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // 列索引：A=0,B=1,...,J=9,K=10,L=11,...,P=11+numSH
      const lastSHCol = 10 + numSH; // 最后一个股东列
      const remarkCol = lastSHCol + 1; // 备注列
      ws["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: remarkCol } }, // 标题合并整行
        { s: { r: 1, c: 0 }, e: { r: 3, c: 0 } }, // 分红月份（A2:A4）
        { s: { r: 1, c: 1 }, e: { r: 1, c: 3 } }, // 付款情况（B2:D2）
        { s: { r: 1, c: 4 }, e: { r: 1, c: 8 } }, // 收款情况（E2:I2）
        { s: { r: 1, c: 9 }, e: { r: 3, c: 9 } }, // 利润（J2:J4）
        { s: { r: 1, c: 10 }, e: { r: 3, c: 10 } }, // 分红明细空列（K2:K4）
        { s: { r: 1, c: 11 }, e: { r: 1, c: lastSHCol } }, // 分红明细（L2:O2）
        { s: { r: 1, c: remarkCol }, e: { r: 3, c: remarkCol } }, // 备注（P2:P4）
        { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } }, // 电量（B3:B4）
        { s: { r: 2, c: 2 }, e: { r: 3, c: 2 } }, // 付款单价（C3:C4）
        { s: { r: 2, c: 3 }, e: { r: 3, c: 3 } }, // 付款金额（D3:D4）
        { s: { r: 2, c: 4 }, e: { r: 3, c: 4 } }, // 收款电费含税（E3:E4）
        { s: { r: 2, c: 5 }, e: { r: 3, c: 5 } }, // 电费不含税（F3:F4）
        { s: { r: 2, c: 6 }, e: { r: 3, c: 6 } }, // 收款租金含税（G3:G4）
        { s: { r: 2, c: 7 }, e: { r: 3, c: 7 } }, // 收款租金不含税（H3:H4）
        { s: { r: 2, c: 8 }, e: { r: 3, c: 8 } }, // 电费租金收款合计（I3:I4）
      ];
      // 每个股东名字列单独不合并（第3行是名字，第4行是比例）
      ws["!cols"] = [
        { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 14 },
        { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 20 }, { wch: 18 },
        { wch: 12 }, { wch: 10 },
        ...shareholders.map(() => ({ wch: 14 })), { wch: 30 },
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "分红明细汇总");
      XLSX.writeFile(wb, `${months[0].split("-")[0]}年${selectedLandlord.landlord.name}分红明细表.xlsx`);
      toast.success("导出成功");
    } catch (e: any) {
      toast.error("导出失败：" + (e.message || "未知错误"));
    }
  }, [selectedLandlord, landlordId, shConfigs]);

  return (
    <div className="flex h-[calc(100vh-120px)] gap-0">
      {/* ─── 左侧面板 ─── */}
      <div className="w-64 shrink-0 flex flex-col border-r bg-white rounded-l-xl overflow-hidden">
        {/* 顶部操作栏 */}
        <div className="border-b p-3 space-y-2">
          <div className="flex items-center justify-between">
            <select
              className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1 focus:outline-none"
              value={viewMode}
              onChange={(e) => { setViewMode(e.target.value as any); setSelectedId(null); }}
            >
              <option value="shareholder">股东汇总</option>
              <option value="station">场地汇总</option>
            </select>
            {viewMode === "shareholder" && (
              <button onClick={() => setAddShareholderOpen(true)} className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700">
                <UserPlus className="h-3 w-3" />
                新增
              </button>
            )}
          </div>
          {viewMode === "shareholder" ? (
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium text-slate-400">分红期间（起~止）</div>
              {/* 快捷范围：本月/本季度/本半年 */}
              <div className="flex gap-1 rounded-md bg-slate-100 p-0.5">
                {(["month", "quarter", "halfYear"] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setSummaryRange(g)}
                    className={`flex-1 rounded px-1 py-0.5 text-[10px] font-medium transition-colors ${summaryPresetActive(g) ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                  >
                    {g === "month" ? "本月" : g === "quarter" ? "本季度" : "本半年"}
                  </button>
                ))}
              </div>
              <div className="space-y-1">
                <MonthPicker value={summaryStartMonth} onChange={setSummaryStartMonth} className="w-full" />
                <MonthPicker value={summaryEndMonth} onChange={setSummaryEndMonth} className="w-full" />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex gap-1 rounded-md bg-slate-100 p-0.5">
                {(["month", "quarter", "halfYear"] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setStationGranularity(g)}
                    className={`flex-1 rounded px-1 py-0.5 text-[10px] font-medium transition-colors ${stationGranularity === g ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                  >
                    {g === "month" ? "月" : g === "quarter" ? "季度" : "半年"}
                  </button>
                ))}
              </div>
              <MonthPicker value={selectedMonth} onChange={setSelectedMonth} className="w-full" />
              {stationGranularity !== "month" && selectedMonth && (
                <div className="text-[10px] font-medium text-slate-400">
                  {stationPeriodLabel}（{stationPeriodMonths[0]} ~ {stationPeriodMonths[stationPeriodMonths.length - 1]}）
                </div>
              )}
            </div>
          )}
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto">
          {viewMode === "shareholder" ? (
            allShareholders.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">暂无股东</div>
            ) : (
              allShareholders.map((sh) => (
                <button
                  key={sh.id}
                  onClick={() => setSelectedId(sh.id)}
                  className={`flex w-full items-center gap-2 border-b px-3 py-2.5 text-left text-xs transition-colors ${selectedId === sh.id ? "bg-emerald-50 border-l-2 border-l-emerald-500" : "hover:bg-slate-50"}`}
                >
                  <Users className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-slate-800 truncate">{sh.name}</div>
                    {sh.hasRecords ? (
                      <div className="text-[11px] text-slate-400">{fmtMoney(sh.totalAmount)} · {sh.details?.length || 0} 条记录</div>
                    ) : (
                      <div className="text-[11px] text-slate-300">暂无分红</div>
                    )}
                  </div>
                </button>
              ))
            )
          ) : (
            stationRows.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">暂无场地</div>
            ) : (
              stationRows.map((r: any) => (
                <button
                  key={r.landlord.id}
                  onClick={() => setSelectedId(r.landlord.id)}
                  className={`flex w-full items-center gap-2 border-b px-3 py-2.5 text-left text-xs transition-colors ${selectedId === r.landlord.id ? "bg-emerald-50 border-l-2 border-l-emerald-500" : "hover:bg-slate-50"}`}
                >
                  <MapPin className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-slate-800 truncate">{r.landlord.name}</div>
                    <div className="text-[11px] text-slate-400">
                      {r.meterCount > 0 ? (
                        <>电表 {r.meterCount} · 总利润 <span className={r.totalProfit >= 0 ? "text-emerald-600" : "text-rose-600"}>{fmtMoney(r.totalProfit)}</span></>
                      ) : (
                        <span className="text-slate-300">暂无数据</span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )
          )}
        </div>
      </div>

      {/* ─── 右侧详情面板 ─── */}
      <div className="flex-1 overflow-y-auto rounded-r-xl bg-slate-50 p-4">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">加载中…</div>
        ) : viewMode === "shareholder" ? (
          // ─── 股东汇总详情 ───
          !selectedShareholder ? (
            <div className="flex h-full flex-col items-center justify-center text-slate-400">
              <Users className="h-10 w-10 mb-2 text-slate-300" />
              <div className="text-sm">请从左侧选择股东</div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 导出按钮 */}
              <div className="flex justify-end">
                <button onClick={doExport} className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-100 transition-colors">
                  <Download className="h-3.5 w-3.5" />
                  导出表格
                </button>
              </div>
              {/* 股东信息卡片 */}
              <div className="rounded-xl border bg-white p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                    <Users className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{selectedShareholder.name}</div>
                    {selectedShareholder.phone && <div className="text-xs text-slate-400">{selectedShareholder.phone}</div>}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2">
                    <div className="text-[10px] text-blue-600">总分红</div>
                    <div className="text-sm font-semibold tabular-nums text-blue-700">{fmtMoney(selectedShareholder.totalAmount)}</div>
                  </div>
                  <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">
                    <div className="text-[10px] text-emerald-600">已结算</div>
                    <div className="text-sm font-semibold tabular-nums text-emerald-700">{fmtMoney(selectedShareholder.settledAmount)}</div>
                  </div>
                  <div className="rounded-lg bg-amber-50 border border-amber-100 px-3 py-2">
                    <div className="text-[10px] text-amber-600">待结算</div>
                    <div className="text-sm font-semibold tabular-nums text-amber-700">{fmtMoney(selectedShareholder.pendingAmount)}</div>
                  </div>
                </div>
              </div>

              {/* 各场地分红详情 */}
              {shareholderConfigs.length > 0 && (
                <div className="space-y-3">
                  {shareholderConfigs.map((c: any) => {
                    const isStationExpanded = expandedShareholderId === c.landlordId;
                    // 从stationBoard中找到该场地的经营数据（v3：board 已按场地方分组）
                    const stationData = (stationBoardForSH ?? []).find((r: any) =>
                      r.landlord?.id === c.landlordId
                    );
                    // 该场地的历史分红记录
                    const stationRecords = (selectedShareholder.details ?? []).filter((d: any) => d.landlordId === c.landlordId);
                    // 分红口径经营数据（calculate 结果：含税费/退款/商务分红）
                    const preview = shareholderPreviewMap.get(c.landlordId);
                    // 该配置若指定品牌，取该品牌的分红预估基数（按品牌口径）
                    const brandBreakdown = c.brandId
                      ? (preview?.brandBreakdown ?? []).find((b: any) => b.brandId === c.brandId)
                      : null;
                    const estIncomeBase = brandBreakdown ? brandBreakdown.income : (preview?.income?.totalIncome || 0);
                    const estProfitBase = brandBreakdown ? brandBreakdown.profit : (preview?.profit || 0);

                    return (
                      <div key={c.id} className="rounded-xl border bg-white overflow-hidden">
                        {/* 场地头部 */}
                        <div
                          className={`flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-slate-50/60 ${isStationExpanded ? "bg-blue-50/30" : ""}`}
                          onClick={() => setExpandedShareholderId(isStationExpanded ? null : c.landlordId)}
                        >
                          <div className="flex items-center gap-2">
                            {isStationExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
                            <MapPin className="h-4 w-4 text-emerald-500" />
                            <span className="text-sm font-semibold text-slate-800">{c.landlordName || `场地#${c.landlordId}`}</span>
                            {c.brandName && (
                              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{c.brandName}</span>
                            )}
                            {!c.brandName && (
                              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">全场</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-slate-500">
                              {c.mode === "固定金额" ? `固定 ${fmtMoney(c.fixedAmount)}` : `${c.mode} ${(c.ratio * 100).toFixed(1)}%`}
                            </span>
                            {stationRecords.length > 0 && (
                              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600">{stationRecords.length} 条记录</span>
                            )}
                          </div>
                        </div>

                        {/* 展开内容 */}
                        {isStationExpanded && (
                          <div className="border-t px-4 py-3 space-y-3 bg-slate-50/30">
                            {/* 分红配置 */}
                            <div className="rounded-lg border bg-white p-3">
                              <div className="text-[11px] font-semibold text-slate-600 mb-2">分红配置</div>
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div><span className="text-slate-400">分红模式：</span><span className="font-medium text-slate-700">{c.mode}</span></div>
                                {c.mode !== "固定金额" && (
                                  <div><span className="text-slate-400">分红比例：</span><span className="font-medium text-slate-700">{(c.ratio * 100).toFixed(1)}%</span></div>
                                )}
                                {c.mode === "固定金额" && (
                                  <div><span className="text-slate-400">固定金额：</span><span className="font-medium text-slate-700">{fmtMoney(c.fixedAmount)}/月</span></div>
                                )}
                                <div><span className="text-slate-400">品牌范围：</span><span className="font-medium text-slate-700">{c.brandName || "整个场地"}</span></div>
                              </div>
                            </div>

                            {/* 场地经营数据 */}
                            {stationData && (
                              <div className="rounded-lg border bg-white overflow-hidden">
                                <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-600 bg-slate-50 border-b">
                                  场地经营数据（{summaryRangeLabel}）
                                </div>
                                <div className="p-3 space-y-3">
                                  {/* 收入构成 */}
                                  <div>
                                    <div className="text-[11px] font-semibold text-emerald-600 mb-1.5">收入构成</div>
                                    <div className="space-y-1 text-xs">
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">电费收入</span>
                                        <span className="tabular-nums text-slate-700">{fmtMoney(preview?.income?.elecIncome?.total || 0)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">租金收入（品牌方合同）</span>
                                        <span className="tabular-nums text-slate-700">{fmtMoney(preview?.income?.rentIncome?.total || 0)}</span>
                                      </div>
                                      <div className="flex justify-between font-semibold border-t pt-1">
                                        <span className="text-slate-700">总收入</span>
                                        <span className="tabular-nums text-emerald-600">{fmtMoney(preview?.income?.totalIncome || 0)}</span>
                                      </div>
                                    </div>
                                  </div>

                                  {/* 成本构成 */}
                                  <div>
                                    <div className="text-[11px] font-semibold text-rose-600 mb-1.5">成本构成</div>
                                    <div className="space-y-1 text-xs">
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">电费成本</span>
                                        <span className="tabular-nums text-slate-700">{fmtMoney(preview?.cost?.elecCost || 0)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">场地租金</span>
                                        <span className="tabular-nums text-slate-700">{fmtMoney(preview?.cost?.rentCost || 0)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">运营费用</span>
                                        <span className="tabular-nums text-slate-700">{fmtMoney(preview?.cost?.opExpense || 0)}</span>
                                      </div>
                                      {preview?.cost?.elecTax > 0 && (
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">电费税费</span>
                                          <span className="tabular-nums text-amber-600">{fmtMoney(preview.cost.elecTax)}</span>
                                        </div>
                                      )}
                                      {preview?.cost?.rentTax > 0 && (
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">场地税费</span>
                                          <span className="tabular-nums text-amber-600">{fmtMoney(preview.cost.rentTax)}</span>
                                        </div>
                                      )}
                                      {preview?.cost?.rentRefund > 0 && (
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">场地费退款</span>
                                          <span className="tabular-nums text-rose-600">{fmtMoney(preview.cost.rentRefund)}</span>
                                        </div>
                                      )}
                                      {preview?.cost?.bizDividendCost > 0 && (
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">商务分红（计入成本）</span>
                                          <span className="tabular-nums text-slate-700">{fmtMoney(preview.cost.bizDividendCost)}</span>
                                        </div>
                                      )}
                                      <div className="flex justify-between font-semibold border-t pt-1">
                                        <span className="text-slate-700">总成本</span>
                                        <span className="tabular-nums text-rose-600">{fmtMoney(preview?.cost?.totalCost || 0)}</span>
                                      </div>
                                    </div>
                                  </div>

                                  {/* 利润和分红计算 */}
                                  <div className="rounded-lg bg-slate-50 p-2.5 space-y-1.5">
                                    <div className="flex justify-between text-xs">
                                      <span className="text-slate-500">净利润</span>
                                      <span className={`font-semibold tabular-nums ${(preview?.profit || 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(preview?.profit || 0)}</span>
                                    </div>
                                    {/* 净利润公式 */}
                                    <div className="rounded bg-white/60 border border-slate-100 px-2 py-1.5 text-[10px] text-slate-500 leading-relaxed">
                                      <div>净利润 = 总收入 − 总成本</div>
                                      <div>
                                        {fmtMoney(preview?.income?.elecIncome?.total || 0)}（电费）+ {fmtMoney(preview?.income?.rentIncome?.total || 0)}（场地费）
                                        − {fmtMoney(preview?.cost?.elecCost || 0)}（电费成本）− {fmtMoney(preview?.cost?.rentCost || 0)}（场地租金）− {fmtMoney(preview?.cost?.opExpense || 0)}（运营费）− {fmtMoney(preview?.cost?.elecTax || 0)}（电费税）− {fmtMoney(preview?.cost?.rentTax || 0)}（场地税）− {fmtMoney(preview?.cost?.rentRefund || 0)}（退款）− {fmtMoney(preview?.cost?.bizDividendCost || 0)}（商务分红）
                                      </div>
                                    </div>
                                    <div className="border-t pt-1.5">
                                      <div className="flex justify-between text-xs">
                                        <span className="text-slate-500">分红模式</span>
                                        <span className="font-medium text-slate-700">{c.mode}</span>
                                      </div>
                                      {c.mode === "收入分红" && (
                                        <div className="flex justify-between text-xs">
                                          <span className="text-slate-500">计算公式</span>
                                          <span className="text-slate-600">总收入 {fmtMoney(preview?.income?.totalIncome || 0)} × {(c.ratio * 100).toFixed(1)}%</span>
                                        </div>
                                      )}
                                      {c.mode === "利润分红" && (
                                        <div className="flex justify-between text-xs">
                                          <span className="text-slate-500">计算公式</span>
                                          <span className="text-slate-600">净利润 {fmtMoney(preview?.profit || 0)} × {(c.ratio * 100).toFixed(1)}%</span>
                                        </div>
                                      )}
                                      {c.mode === "固定金额" && (
                                        <div className="flex justify-between text-xs">
                                          <span className="text-slate-500">计算公式</span>
                                          <span className="text-slate-600">固定金额 {fmtMoney(c.fixedAmount)}/月</span>
                                        </div>
                                      )}
                                    </div>
                                    <div className="border-t pt-1.5">
                                      <div className="flex justify-between text-sm font-semibold">
                                        <span className="text-slate-700">期间预估分红</span>
                                        <span className="tabular-nums text-emerald-600">
                                          {fmtMoney(
                                            c.mode === "收入分红" ? estIncomeBase * c.ratio :
                                            c.mode === "利润分红" ? estProfitBase * c.ratio :
                                            Number(c.fixedAmount || 0)
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* 分红记录 + 新增月结 + 提交审批 */}
                            <div className="rounded-lg border bg-white overflow-hidden">
                              <div className="flex items-center justify-between border-b bg-slate-50 px-3 py-1.5">
                                <span className="text-[11px] font-semibold text-slate-600">分红记录</span>
                                <button
                                  onClick={() => setAddDividendOpen({ open: true, landlordId: c.landlordId })}
                                  className="rounded-md bg-emerald-600 px-2 py-1 text-[10px] text-white hover:bg-emerald-700"
                                >
                                  新增月结
                                </button>
                              </div>
                              {(() => {
                                const fullRecords = landlordDividendsMap.get(c.landlordId) ?? [];
                                if (fullRecords.length === 0) {
                                  return <div className="py-4 text-center text-xs text-slate-400">该场地暂无分红记录</div>;
                                }
                                // 可选中的未结算记录
                                const selectable = fullRecords.filter((r: any) => r.status === "未结算");
                                const selectedInStation = fullRecords.filter((r: any) => selectedApprovalIds.includes(r.id));
                                return (
                                  <>
                                    {selectable.length > 0 && (
                                      <div className="flex items-center justify-between border-b bg-blue-50/40 px-3 py-1.5">
                                        <span className="text-[10px] text-slate-500">已选 {selectedApprovalIds.length} 条</span>
                                        <button
                                          onClick={() => openBatchApproval(selectedInStation)}
                                          disabled={selectedInStation.length === 0}
                                          className="rounded-md bg-blue-600 px-2 py-0.5 text-[10px] text-white hover:bg-blue-700 disabled:opacity-40"
                                        >
                                          批量提交审批（{selectedInStation.length}）
                                        </button>
                                      </div>
                                    )}
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="border-b bg-slate-50/50 text-left text-slate-500">
                                          <th className="w-8 px-2 py-1.5"></th>
                                          <th className="px-2.5 py-1.5 font-medium">月份</th>
                                          <th className="px-2.5 py-1.5 font-medium">类型</th>
                                          <th className="px-2.5 py-1.5 text-right font-medium">利润</th>
                                          <th className="px-2.5 py-1.5 font-medium">状态</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {fullRecords.map((r: any) => (
                                          <tr key={r.id} className="border-b last:border-0">
                                            <td className="px-2 py-1.5 text-center">
                                              {r.status === "未结算" && (
                                                <input
                                                  type="checkbox"
                                                  className="rounded border-slate-300"
                                                  checked={selectedApprovalIds.includes(r.id)}
                                                  onChange={() => toggleApprovalSelect(r.id)}
                                                />
                                              )}
                                            </td>
                                            <td className="px-2.5 py-1.5 text-slate-600">{r.period}</td>
                                            <td className="px-2.5 py-1.5">
                                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.type === "股东分红" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>{r.type}</span>
                                            </td>
                                            <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-700">{fmtMoney(r.profit)}</td>
                                            <td className="px-2.5 py-1.5">
                                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.status === "已结算" ? "bg-emerald-100 text-emerald-700" : r.status === "已通过" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>{r.status}</span>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {shareholderConfigs.length === 0 && (
                <div className="rounded-xl border border-dashed bg-white py-12 text-center text-sm text-slate-400">
                  该股东暂无分红配置，请在「场地汇总」中配置
                </div>
              )}
            </div>
          )
        ) : (
          // ─── 场地汇总详情 ───
          !selectedLandlord ? (
            <div className="flex h-full flex-col items-center justify-center text-slate-400">
              <MapPin className="h-10 w-10 mb-2 text-slate-300" />
              <div className="text-sm">请从左侧选择场地方</div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 导出按钮 */}
              <div className="flex justify-end">
                <button onClick={doExport} className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-100 transition-colors">
                  <Download className="h-3.5 w-3.5" />
                  导出表格
                </button>
              </div>
              {/* 场地方信息卡片 */}
              <div className="rounded-xl border bg-white p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-600">
                    <MapPin className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{selectedLandlord.landlord.name}</div>
                    <div className="text-xs text-slate-400">
                      {selectedLandlord.landlord.contact ? `联系人：${selectedLandlord.landlord.contact}` : ""}
                      {selectedLandlord.landlord.phone ? ` · ${selectedLandlord.landlord.phone}` : ""}
                      {landlordBrands.length > 0 && ` · ${landlordBrands.length} 个品牌`}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <div className="rounded-lg border bg-slate-50 px-3 py-2">
                    <div className="text-[10px] text-slate-400">电表数</div>
                    <div className="text-sm font-semibold tabular-nums">{selectedLandlord.meterCount}</div>
                  </div>
                  <div className="rounded-lg border bg-slate-50 px-3 py-2">
                    <div className="text-[10px] text-slate-400">总度数</div>
                    <div className="text-sm font-semibold tabular-nums">{fmtNum(selectedLandlord.totalKwh)} <span className="text-[10px] font-normal text-slate-400">度</span></div>
                  </div>
                  <div className="rounded-lg border bg-rose-50 px-3 py-2">
                    <div className="text-[10px] text-rose-500">电费成本</div>
                    <div className="text-sm font-semibold tabular-nums text-rose-600">{fmtMoney(selectedLandlord.elecPay)}</div>
                  </div>
                  <div className="rounded-lg border bg-emerald-50 px-3 py-2">
                    <div className="text-[10px] text-emerald-500">电费收入</div>
                    <div className="text-sm font-semibold tabular-nums text-emerald-600">{fmtMoney(selectedLandlord.elecCollect)}</div>
                  </div>
                  <div className="rounded-lg border bg-slate-50 px-3 py-2">
                    <div className="text-[10px] text-slate-400">电费利润</div>
                    <div className={`text-sm font-semibold tabular-nums ${selectedLandlord.elecProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(selectedLandlord.elecProfit)}</div>
                  </div>
                  <div className="rounded-lg border bg-rose-50 px-3 py-2">
                    <div className="text-[10px] text-rose-500">租金成本</div>
                    <div className="text-sm font-semibold tabular-nums text-rose-600">{fmtMoney(selectedLandlord.rentCost)}</div>
                  </div>
                  <div className="rounded-lg border bg-emerald-50 px-3 py-2">
                    <div className="text-[10px] text-emerald-500">租金收入</div>
                    <div className="text-sm font-semibold tabular-nums text-emerald-600">{fmtMoney(selectedLandlord.rentIncome)}</div>
                  </div>
                  <div className="rounded-lg border bg-blue-50 px-3 py-2">
                    <div className="text-[10px] text-blue-500">总利润</div>
                    <div className={`text-sm font-semibold tabular-nums ${selectedLandlord.totalProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(selectedLandlord.totalProfit)}</div>
                  </div>
                </div>
              </div>

              {/* 按月明细：长周期（季度/半年）下展示构成该周期的各月数据，点击可下钻 */}
              {stationGranularity !== "month" && stationMonthlyRows.length > 0 && (
                <div className="rounded-xl border bg-white overflow-hidden">
                  <div className="flex items-center justify-between border-b bg-slate-50 px-4 py-2">
                    <div className="text-xs font-semibold text-slate-600">按月明细（{stationPeriodLabel}）</div>
                    <span className="text-[10px] text-slate-400">点击月份行可下钻查看该月详情</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs whitespace-nowrap">
                      <thead>
                        <tr className="border-b bg-slate-50/50 text-left text-slate-500">
                          <th className="px-2.5 py-1.5 font-medium">月份</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">总度数</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">电费收入</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">电费成本</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">租金收入</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">租金成本</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">运营费</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">总利润</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">预估分红</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">已记录分红</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stationMonthlyRows.map((r) => (
                          <tr
                            key={r.month}
                            onClick={() => { setSelectedMonth(r.month); setStationGranularity("month"); }}
                            className="border-b last:border-0 cursor-pointer hover:bg-emerald-50/40 transition-colors"
                            title={`查看 ${r.month} 明细`}
                          >
                            <td className="px-2.5 py-1.5 font-medium text-slate-700">{r.month}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtNum(r.totalKwh)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(r.elecCollect)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(r.elecPay)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(r.rentIncome)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(r.rentCost)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(r.opExpense)}</td>
                            <td className={`px-2.5 py-1.5 text-right tabular-nums font-medium ${r.totalProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(r.totalProfit)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-blue-600">{fmtMoney(r.shAmount + r.bizAmount)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-600">{fmtMoney(r.recordedAmount)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t bg-slate-50 font-medium">
                          <td className="px-2.5 py-1.5">合计</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtNum(stationMonthlyRows.reduce((s, r) => s + r.totalKwh, 0))}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(stationMonthlyRows.reduce((s, r) => s + r.elecCollect, 0))}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(stationMonthlyRows.reduce((s, r) => s + r.elecPay, 0))}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(stationMonthlyRows.reduce((s, r) => s + r.rentIncome, 0))}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(stationMonthlyRows.reduce((s, r) => s + r.rentCost, 0))}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(stationMonthlyRows.reduce((s, r) => s + r.opExpense, 0))}</td>
                          <td className={`px-2.5 py-1.5 text-right tabular-nums ${stationMonthlyRows.reduce((s, r) => s + r.totalProfit, 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(stationMonthlyRows.reduce((s, r) => s + r.totalProfit, 0))}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-blue-600">{fmtMoney(stationMonthlyRows.reduce((s, r) => s + r.shAmount + r.bizAmount, 0))}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-600">{fmtMoney(stationMonthlyRows.reduce((s, r) => s + r.recordedAmount, 0))}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* 品牌列表：该场地下各品牌方的收支（按月） */}
              {landlordBrands.length > 0 && (
                <div className="rounded-xl border bg-white overflow-hidden">
                  <div className="border-b bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
                    品牌（{landlordBrands.length} 个 · {stationPeriodLabel}）
                  </div>
                  <div className="divide-y">
                    {landlordBrands.map((b: { id: number; name: string }) => {
                      const isBrandExpanded = expandedBrandId === b.id;
                      const brandData = (dividendPreview?.brandBreakdown ?? []).find((x: any) => x.brandId === b.id);
                      const rentIncome = brandData?.rentIncome || 0;
                      const elecIncome = brandData?.elecIncome || 0;
                      const elecCost = brandData?.elecCost || 0;
                      const venueCost = brandData?.venueCost || 0;
                      const elecTax = brandData?.elecTax || 0;
                      const rentTax = brandData?.rentTax || 0;
                      const profit = brandData?.profit ?? null;
                      return (
                        <div key={b.id}>
                          <button
                            className="flex w-full items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors"
                            onClick={() => setExpandedBrandId(isBrandExpanded ? null : b.id)}
                          >
                            <div className="flex items-center gap-2 text-xs">
                              {isBrandExpanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-300" />}
                              <MapPin className="h-3.5 w-3.5 text-emerald-500" />
                              <span className="font-medium text-slate-700">{b.name}</span>
                            </div>
                            <div className="flex items-center gap-3 text-[11px]">
                              <span className="text-slate-400">收入 {fmtMoney(rentIncome + elecIncome)}</span>
                              {profit !== null && (
                                <span className={`font-medium tabular-nums ${profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                                  利润 {fmtMoney(profit)}
                                </span>
                              )}
                            </div>
                          </button>
                          {/* 品牌展开：收支明细 */}
                          {isBrandExpanded && (
                            <div className="bg-slate-50/50 border-t px-4 py-3">
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="rounded-lg border bg-white p-2.5">
                                  <div className="mb-1 text-[10px] font-semibold text-emerald-600">收入</div>
                                  <div className="flex justify-between"><span className="text-slate-500">电费收入</span><span className="tabular-nums">{fmtMoney(elecIncome)}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-500">场地费收入</span><span className="tabular-nums">{fmtMoney(rentIncome)}</span></div>
                                </div>
                                <div className="rounded-lg border bg-white p-2.5">
                                  <div className="mb-1 text-[10px] font-semibold text-rose-600">支出</div>
                                  <div className="flex justify-between"><span className="text-slate-500">电费成本</span><span className="tabular-nums">{fmtMoney(elecCost)}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-500">承担场地成本</span><span className="tabular-nums">{fmtMoney(venueCost)}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-500">电费税费</span><span className="tabular-nums">{fmtMoney(elecTax)}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-500">场地税费</span><span className="tabular-nums">{fmtMoney(rentTax)}</span></div>
                                </div>
                              </div>
                              {profit !== null && (
                                <div className="mt-2 flex justify-between text-xs font-semibold">
                                  <span className="text-slate-700">品牌利润</span>
                                  <span className={`tabular-nums ${profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(profit)}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 分红配置（v3：按场地） */}
              {landlordId && (
                <div className="rounded-xl border bg-white overflow-hidden">
                  <div className="flex items-center justify-between border-b bg-slate-50 px-4 py-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                      <Settings className="h-3.5 w-3.5" />
                      分红配置
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => setConfigOpen({ open: true, type: "shareholder", landlordId })} className="rounded-md bg-blue-50 border border-blue-200 px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-100">
                        + 股东分红
                      </button>
                      <button onClick={() => setConfigOpen({ open: true, type: "introducer", landlordId })} className="rounded-md bg-purple-50 border border-purple-200 px-2 py-1 text-[11px] text-purple-700 hover:bg-purple-100">
                        + 商务分红
                      </button>
                    </div>
                  </div>

                  {activeShConfigs && activeShConfigs.length > 0 && (
                    <div className="border-b">
                      <div className="px-4 py-1.5 text-[11px] font-semibold text-slate-500 bg-blue-50/50">股东分红配置</div>
                      {activeShConfigs.map((c: any) => {
                        const isExpanded = expandedShareholderId === c.shareholderId;
                        // 获取该股东在当前场地的分红记录
                        const shareholderRecords = (stationDividends ?? []).flatMap((r: any) => {
                          const shares = (r.shares ?? []).filter((s: any) => s.shareholderId === c.shareholderId);
                          if (shares.length === 0) return [];
                          return [{ ...r, shares }];
                        });
                        // 获取该股东的预估分红
                        const estimatedDividend = dividendPreview?.shareholderDividends?.find(
                          (d: any) => d.shareholderId === c.shareholderId
                        );
                        const hasEstimate = !!estimatedDividend;
                        // 该配置若指定品牌，取该品牌的分红基数（按品牌口径展示公式）
                        const brandPreview = c.brandId
                          ? (dividendPreview?.brandBreakdown ?? []).find((b: any) => b.brandId === c.brandId)
                          : null;
                        const formulaIncome = brandPreview ? brandPreview.income : (dividendPreview?.income?.totalIncome || 0);
                        const formulaProfit = brandPreview ? brandPreview.profit : (dividendPreview?.profit || 0);
                        // 汇总视图（季度/半年）下基数已含多月累加，不再叠加周期倍数
                        const formulaMultiplier = stationGranularity === "month" && (estimatedDividend?.settlementPeriod || "月") !== "月"
                          ? (estimatedDividend?.settlementPeriod === "季度" ? 3 : estimatedDividend?.settlementPeriod === "半年" ? 6 : 12)
                          : 0;
                        return (
                          <div key={c.id}>
                            <div className={`flex items-center justify-between border-b last:border-0 px-4 py-2 hover:bg-slate-50/50 ${isExpanded ? "bg-blue-50/30" : ""}`}>
                              <div className="flex items-center gap-2 text-xs">
                                <Users className="h-3.5 w-3.5 text-blue-500" />
                                <button
                                  onClick={() => setExpandedShareholderId(isExpanded ? null : c.shareholderId)}
                                  className="font-medium text-slate-700 hover:text-blue-600 transition-colors cursor-pointer"
                                >
                                  {c.shareholderName}
                                </button>
                                {c.brandName && (
                                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{c.brandName}</span>
                                )}
                                {!c.brandName && (
                                  <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">全场</span>
                                )}
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-500">{c.mode === "固定金额" ? `固定 ${fmtMoney(c.fixedAmount)}` : `${c.mode} ${(c.ratio * 100).toFixed(1)}%`}</span>
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-500">{c.settlementPeriod || "月"}分红</span>
                                {hasEstimate && (
                                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 font-medium">预估 {fmtMoney(estimatedDividend.amount)}</span>
                                )}
                                {shareholderRecords.length > 0 && (
                                  <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600">{shareholderRecords.length} 条记录</span>
                                )}
                              </div>
                              <button onClick={() => deleteConfigMut.mutate({ type: "shareholder", id: c.id })} className="text-slate-400 hover:text-rose-500 transition-colors">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {/* 展开的分红详情 */}
                            {isExpanded && (
                              <div className="bg-blue-50/20 border-b px-4 py-3 space-y-3">
                                {/* 分红配置信息 */}
                                <div className="rounded-lg border bg-white p-3">
                                  <div className="text-[11px] font-semibold text-slate-600 mb-2">分红配置</div>
                                  <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div><span className="text-slate-400">分红模式：</span><span className="font-medium text-slate-700">{c.mode}</span></div>
                                    {c.mode !== "固定金额" && (
                                      <div><span className="text-slate-400">分红比例：</span><span className="font-medium text-slate-700">{(c.ratio * 100).toFixed(1)}%</span></div>
                                    )}
                                    {c.mode === "固定金额" && (
                                      <div><span className="text-slate-400">固定金额：</span><span className="font-medium text-slate-700">{fmtMoney(c.fixedAmount)}/月</span></div>
                                    )}
                                  </div>
                                </div>

                                {/* 预估分红计算明细 */}
                                {hasEstimate && dividendPreview && (
                                  <div className="rounded-lg border bg-white overflow-hidden">
                                    <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-600 bg-slate-50 border-b">
                                      预估分红计算明细（{stationPeriodLabel}）
                                    </div>
                                    <div className="p-3 space-y-3">
                                      {/* 收入明细 */}
                                      <div>
                                        <div className="text-[11px] font-semibold text-emerald-600 mb-1.5">收入构成</div>
                                        <table className="w-full text-xs">
                                          <tbody>
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">电费收入</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.income?.elecIncome?.total || 0)}</td>
                                            </tr>
                                            {dividendPreview.income?.elecIncome?.details?.length > 0 && dividendPreview.income.elecIncome.details.map((d: any, i: number) => (
                                              <tr key={i} className="text-[10px]">
                                                <td className="py-0.5 pl-4 text-slate-400">
                                                  {d.meterNo}（{d.brandName}）{d.kwh}度 × {d.unitPrice}元/度
                                                  {d.postTaxPrice && <span className="ml-1 text-amber-600">（税后 {d.postTaxPrice}元/度）</span>}
                                                </td>
                                                <td className="py-0.5 text-right tabular-nums text-slate-500">{fmtMoney(d.amount)}</td>
                                              </tr>
                                            ))}
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">租金收入（品牌方合同）</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.income?.rentIncome?.total || 0)}</td>
                                            </tr>
                                            {dividendPreview.income?.rentIncome?.details?.length > 0 && dividendPreview.income.rentIncome.details.map((d: any, i: number) => (
                                              <tr key={i} className="text-[10px]">
                                                <td className="py-0.5 pl-4 text-slate-400">
                                                  {d.brandName} {d.isFirstMonth ? "首月场地租金" : `${d.cabinets}柜 × ${fmtMoney(d.unitMonthlyRent)}/柜`}
                                                  {d.postTaxRent && <span className="ml-1 text-amber-600">（税后 {fmtMoney(d.postTaxRent)}元/月）</span>}
                                                </td>
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

                                      {/* 成本明细 */}
                                      <div>
                                        <div className="text-[11px] font-semibold text-rose-600 mb-1.5">成本构成</div>
                                        <table className="w-full text-xs">
                                          <tbody>
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">电费成本</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.elecCost || 0)}</td>
                                            </tr>
                                            {dividendPreview.cost?.details?.electricity?.length > 0 && dividendPreview.cost.details.electricity.map((d: any, i: number) => (
                                              <tr key={i} className="text-[10px]">
                                                <td className="py-0.5 pl-4 text-slate-400">{d.meterNo} {d.kwh}度 × {d.unitPrice}元/度</td>
                                                <td className="py-0.5 text-right tabular-nums text-slate-500">{fmtMoney(d.amount)}</td>
                                              </tr>
                                            ))}
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">场地租金</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.rentCost || 0)}</td>
                                            </tr>
                                            {dividendPreview.cost?.details?.rent?.length > 0 && dividendPreview.cost.details.rent.map((d: any, i: number) => (
                                              <tr key={i} className="text-[10px]">
                                                <td className="py-0.5 pl-4 text-slate-400">{d.landlordName}</td>
                                                <td className="py-0.5 text-right tabular-nums text-slate-500">{fmtMoney(d.monthlyRent)}</td>
                                              </tr>
                                            ))}
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">运营费用</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.opExpense || 0)}</td>
                                            </tr>
                                            {dividendPreview.cost?.elecTax > 0 && (
                                              <>
                                                <tr className="border-b">
                                                  <td className="py-1 text-slate-500">电费税收</td>
                                                  <td className="py-1 text-right tabular-nums text-amber-600">{fmtMoney(dividendPreview.cost.elecTax)}</td>
                                                </tr>
                                                {dividendPreview.cost?.details?.elecTax?.details?.length > 0 && dividendPreview.cost.details.elecTax.details.map((d: any, i: number) => (
                                                  <tr key={i} className="text-[10px]">
                                                    <td className="py-0.5 pl-4 text-slate-400">{d.meterNo}（{d.brandName}）{d.kwh}度 × ({d.preTaxPrice} - {d.postTaxPrice})元/度</td>
                                                    <td className="py-0.5 text-right tabular-nums text-amber-500">{fmtMoney(d.amount)}</td>
                                                  </tr>
                                                ))}
                                              </>
                                            )}
                                            {dividendPreview.cost?.rentTax > 0 && (
                                              <>
                                                <tr className="border-b">
                                                  <td className="py-1 text-slate-500">场地税收</td>
                                                  <td className="py-1 text-right tabular-nums text-amber-600">{fmtMoney(dividendPreview.cost.rentTax)}</td>
                                                </tr>
                                                {dividendPreview.cost?.details?.rentTax?.details?.length > 0 && dividendPreview.cost.details.rentTax.details.map((d: any, i: number) => (
                                                  <tr key={i} className="text-[10px]">
                                                    <td className="py-0.5 pl-4 text-slate-400">{d.brandName} {fmtMoney(d.preTaxPrice)}元/月 × {(d.taxRate * 100).toFixed(0)}%</td>
                                                    <td className="py-0.5 text-right tabular-nums text-amber-500">{fmtMoney(d.amount)}</td>
                                                  </tr>
                                                ))}
                                              </>
                                            )}
                                            {dividendPreview.cost?.rentRefund > 0 && (
                                              <tr className="border-b">
                                                <td className="py-1 text-slate-500">场地费退款</td>
                                                <td className="py-1 text-right tabular-nums text-rose-600">{fmtMoney(dividendPreview.cost.rentRefund)}</td>
                                              </tr>
                                            )}
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
                                          </tbody>
                                        </table>
                                      </div>

                                      {/* 按品牌 P&L */}
                                      {dividendPreview.brandBreakdown?.length > 0 && (
                                        <div>
                                          <div className="text-[11px] font-semibold text-blue-600 mb-1.5">按品牌经营数据</div>
                                          <table className="w-full text-xs">
                                            <tbody>
                                              {dividendPreview.brandBreakdown.map((b: any, i: number) => (
                                                <tr key={i} className="border-b last:border-0">
                                                  <td className="py-1 text-slate-500 font-medium">{b.brandName}</td>
                                                  <td className="py-1 text-right tabular-nums text-slate-600">
                                                    收入 {fmtMoney(b.income)} · 承担场地成本 {fmtMoney(b.venueCost)} · 利润
                                                    <span className={`ml-1 font-medium ${b.profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(b.profit)}</span>
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      )}

                                      {/* 利润和分红计算 */}
                                      <div className="rounded-lg bg-slate-50 p-2.5 space-y-1.5">
                                        <div className="flex justify-between text-xs">
                                          <span className="text-slate-500">净利润</span>
                                          <span className={`font-semibold tabular-nums ${(dividendPreview.profit || 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(dividendPreview.profit || 0)}</span>
                                        </div>
                                        {/* 净利润公式 */}
                                        <div className="rounded bg-white/60 border border-slate-100 px-2 py-1.5 text-[10px] text-slate-500 leading-relaxed">
                                          <div>净利润 = 总收入 − 总成本</div>
                                          <div>
                                            {fmtMoney(dividendPreview?.income?.elecIncome?.total || 0)}（电费）+ {fmtMoney(dividendPreview?.income?.rentIncome?.total || 0)}（场地费）
                                            − {fmtMoney(dividendPreview?.cost?.elecCost || 0)}（电费成本）− {fmtMoney(dividendPreview?.cost?.rentCost || 0)}（场地租金）− {fmtMoney(dividendPreview?.cost?.opExpense || 0)}（运营费）− {fmtMoney(dividendPreview?.cost?.elecTax || 0)}（电费税）− {fmtMoney(dividendPreview?.cost?.rentTax || 0)}（场地税）− {fmtMoney(dividendPreview?.cost?.rentRefund || 0)}（退款）− {fmtMoney(dividendPreview?.cost?.bizDividendCost || 0)}（商务分红）
                                          </div>
                                        </div>
                                        <div className="border-t pt-1.5">
                                          <div className="flex justify-between text-xs">
                                            <span className="text-slate-500">分红模式</span>
                                            <span className="font-medium text-slate-700">{estimatedDividend.mode}</span>
                                          </div>
                                          <div className="flex justify-between text-xs">
                                            <span className="text-slate-500">分红周期</span>
                                            <span className="font-medium text-slate-700">{estimatedDividend.settlementPeriod || "月"}分红</span>
                                          </div>
                                          {estimatedDividend.mode === "收入分红" && (
                                            <div className="flex justify-between text-xs">
                                              <span className="text-slate-500">计算公式</span>
                                              <span className="text-slate-600">{brandPreview ? `${brandPreview.brandName}收入` : "总收入"} {fmtMoney(formulaIncome)} × {(estimatedDividend.ratio * 100).toFixed(1)}%{formulaMultiplier > 0 ? ` × ${formulaMultiplier}` : ""}</span>
                                            </div>
                                          )}
                                          {estimatedDividend.mode === "利润分红" && (
                                            <div className="flex justify-between text-xs">
                                              <span className="text-slate-500">计算公式</span>
                                              <span className="text-slate-600">{brandPreview ? `${brandPreview.brandName}利润` : "净利润"} {fmtMoney(formulaProfit)} × {(estimatedDividend.ratio * 100).toFixed(1)}%{formulaMultiplier > 0 ? ` × ${formulaMultiplier}` : ""}</span>
                                            </div>
                                          )}
                                          {estimatedDividend.mode === "固定金额" && (
                                            <div className="flex justify-between text-xs">
                                              <span className="text-slate-500">计算公式</span>
                                              <span className="text-slate-600">固定金额 {fmtMoney(estimatedDividend.fixedAmount)}/月{formulaMultiplier > 0 ? ` × ${formulaMultiplier}` : ""}</span>
                                            </div>
                                          )}
                                        </div>
                                        <div className="border-t pt-1.5">
                                          <div className="flex justify-between text-sm font-semibold">
                                            <span className="text-slate-700">预估分红金额</span>
                                            <span className="tabular-nums text-emerald-600">{fmtMoney(estimatedDividend.amount)}</span>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* 历史分红记录 */}
                                {shareholderRecords.length > 0 ? (
                                  <div className="rounded-lg border bg-white overflow-hidden">
                                    <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-600 bg-slate-50 border-b">历史分红记录</div>
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="border-b bg-slate-50/50 text-left text-slate-500">
                                          <th className="px-2.5 py-1.5 font-medium">月份</th>
                                          <th className="px-2.5 py-1.5 font-medium">类型</th>
                                          <th className="px-2.5 py-1.5 text-right font-medium">分红金额</th>
                                          <th className="px-2.5 py-1.5 font-medium">状态</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {shareholderRecords.map((r: any) => (
                                          <tr key={r.id} className="border-b last:border-0">
                                            <td className="px-2.5 py-1.5 text-slate-600">{r.period}</td>
                                            <td className="px-2.5 py-1.5">
                                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.type === "股东分红" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>{r.type}</span>
                                            </td>
                                            <td className="px-2.5 py-1.5 text-right font-medium text-emerald-600 tabular-nums">
                                              {fmtMoney(r.shares.reduce((sum: number, s: any) => sum + Number(s.amount || 0), 0))}
                                            </td>
                                            <td className="px-2.5 py-1.5">
                                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.status === "已结算" ? "bg-emerald-100 text-emerald-700" : r.status === "已通过" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>{r.status}</span>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                      <tfoot>
                                        <tr className="border-t bg-slate-50 font-medium">
                                          <td colSpan={2} className="px-2.5 py-1.5">合计</td>
                                          <td className="px-2.5 py-1.5 text-right text-emerald-600 tabular-nums">
                                            {fmtMoney(shareholderRecords.reduce((sum: number, r: any) => sum + r.shares.reduce((s: number, sh: any) => s + Number(sh.amount || 0), 0), 0))}
                                          </td>
                                          <td></td>
                                        </tr>
                                      </tfoot>
                                    </table>
                                  </div>
                                ) : !hasEstimate ? (
                                  <div className="py-4 text-center text-xs text-slate-400">暂无分红记录和预估数据</div>
                                ) : null}

                                {/* 提示信息 */}
                                {shareholderRecords.length === 0 && hasEstimate && (
                                  <div className="text-[10px] text-slate-400 text-center">
                                    提示：点击「新增月结」可创建实际分红记录
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {intConfigs && intConfigs.length > 0 && (
                    <div>
                      <div className="px-4 py-1.5 text-[11px] font-semibold text-slate-500 bg-purple-50/50">商务分红配置</div>
                      {intConfigs.map((c: any) => {
                        const isIntExpanded = expandedShareholderId === -c.introducerId; // 用负数区分介绍人
                        // 获取该介绍人在当前场地的分红记录
                        const introducerRecords = (stationDividends ?? []).flatMap((r: any) => {
                          const shares = (r.shares ?? []).filter((s: any) => s.introducerId === c.introducerId);
                          if (shares.length === 0) return [];
                          return [{ ...r, shares }];
                        });
                        // 获取该介绍人的预估分红
                        const estimatedBizDividend = dividendPreview?.bizDividends?.find(
                          (d: any) => d.introducerId === c.introducerId
                        );
                        const hasBizEstimate = !!estimatedBizDividend;
                        // 汇总视图（季度/半年）下基数已含多月累加，不再叠加周期倍数
                        const bizFormulaMultiplier = stationGranularity === "month" && (estimatedBizDividend?.settlementPeriod || "月") !== "月"
                          ? (estimatedBizDividend?.settlementPeriod === "季度" ? 3 : estimatedBizDividend?.settlementPeriod === "半年" ? 6 : 12)
                          : 0;
                        return (
                          <div key={c.id}>
                            <div className={`flex items-center justify-between border-b last:border-0 px-4 py-2 hover:bg-slate-50/50 ${isIntExpanded ? "bg-purple-50/30" : ""}`}>
                              <div className="flex items-center gap-2 text-xs">
                                <UserPlus className="h-3.5 w-3.5 text-purple-500" />
                                <button
                                  onClick={() => setExpandedShareholderId(isIntExpanded ? null : -c.introducerId)}
                                  className="font-medium text-slate-700 hover:text-purple-600 transition-colors cursor-pointer"
                                >
                                  {c.introducerName}
                                </button>
                                {c.brandName && (
                                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{c.brandName}</span>
                                )}
                                {!c.brandName && (
                                  <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">全场</span>
                                )}
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-500">{c.mode === "固定金额" ? `固定 ${fmtMoney(c.fixedAmount)}` : `${c.mode} ${(c.ratio * 100).toFixed(1)}%`}</span>
                                <span className="text-slate-400">·</span>
                                <span className="text-slate-500">{c.settlementPeriod || "月"}分红</span>
                                {c.countAsCost && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">计入成本</span>}
                                {hasBizEstimate && (
                                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 font-medium">预估 {fmtMoney(estimatedBizDividend.amount)}</span>
                                )}
                              </div>
                              <button onClick={() => deleteConfigMut.mutate({ type: "introducer", id: c.id })} className="text-slate-400 hover:text-rose-500 transition-colors">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {/* 展开的分红详情 */}
                            {isIntExpanded && (
                              <div className="bg-purple-50/20 border-b px-4 py-3 space-y-3">
                                {/* 分红配置信息 */}
                                <div className="rounded-lg border bg-white p-3">
                                  <div className="text-[11px] font-semibold text-slate-600 mb-2">商务分红配置</div>
                                  <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div><span className="text-slate-400">分红模式：</span><span className="font-medium text-slate-700">{c.mode}</span></div>
                                    {c.mode !== "固定金额" && (
                                      <div><span className="text-slate-400">分红比例：</span><span className="font-medium text-slate-700">{(c.ratio * 100).toFixed(1)}%</span></div>
                                    )}
                                    {c.mode === "固定金额" && (
                                      <div><span className="text-slate-400">固定金额：</span><span className="font-medium text-slate-700">{fmtMoney(c.fixedAmount)}/月</span></div>
                                    )}
                                    <div><span className="text-slate-400">计入成本：</span><span className={`font-medium ${c.countAsCost ? "text-amber-600" : "text-slate-500"}`}>{c.countAsCost ? "是" : "否"}</span></div>
                                  </div>
                                </div>

                                {/* 预估分红计算明细 */}
                                {hasBizEstimate && dividendPreview && (
                                  <div className="rounded-lg border bg-white overflow-hidden">
                                    <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-600 bg-slate-50 border-b">
                                      预估商务分红计算明细（{stationPeriodLabel}）
                                    </div>
                                    <div className="p-3 space-y-3">
                                      {/* 收入明细 */}
                                      <div>
                                        <div className="text-[11px] font-semibold text-emerald-600 mb-1.5">收入构成</div>
                                        <table className="w-full text-xs">
                                          <tbody>
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">电费收入</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.income?.elecIncome?.total || 0)}</td>
                                            </tr>
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">租金收入（品牌方合同）</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.income?.rentIncome?.total || 0)}</td>
                                            </tr>
                                            <tr className="font-semibold">
                                              <td className="py-1 text-slate-700">总收入</td>
                                              <td className="py-1 text-right tabular-nums text-emerald-600">{fmtMoney(dividendPreview.income?.totalIncome || 0)}</td>
                                            </tr>
                                          </tbody>
                                        </table>
                                      </div>

                                      {/* 成本明细 */}
                                      <div>
                                        <div className="text-[11px] font-semibold text-rose-600 mb-1.5">成本构成</div>
                                        <table className="w-full text-xs">
                                          <tbody>
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">电费成本</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.elecCost || 0)}</td>
                                            </tr>
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">场地租金</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.rentCost || 0)}</td>
                                            </tr>
                                            <tr className="border-b">
                                              <td className="py-1 text-slate-500">运营费用</td>
                                              <td className="py-1 text-right tabular-nums text-slate-700">{fmtMoney(dividendPreview.cost?.opExpense || 0)}</td>
                                            </tr>
                                            <tr className="font-semibold">
                                              <td className="py-1 text-slate-700">基础成本</td>
                                              <td className="py-1 text-right tabular-nums text-rose-600">{fmtMoney((dividendPreview.cost?.elecCost || 0) + (dividendPreview.cost?.rentCost || 0) + (dividendPreview.cost?.opExpense || 0))}</td>
                                            </tr>
                                          </tbody>
                                        </table>
                                      </div>

                                      {/* 分红计算 */}
                                      <div className="rounded-lg bg-slate-50 p-2.5 space-y-1.5">
                                        <div className="flex justify-between text-xs">
                                          <span className="text-slate-500">分红周期</span>
                                          <span className="font-medium text-slate-700">{estimatedBizDividend.settlementPeriod || "月"}分红</span>
                                        </div>
                                        {estimatedBizDividend.mode === "利润分红" && c.countAsCost && (
                                          <>
                                            <div className="flex justify-between text-xs">
                                              <span className="text-slate-500">分红基数（总收入 - 基础成本）</span>
                                              <span className="font-medium tabular-nums text-slate-700">{fmtMoney(estimatedBizDividend.baseAmount)}</span>
                                            </div>
                                            <div className="flex justify-between text-xs">
                                              <span className="text-slate-500">计算公式</span>
                                              <span className="text-slate-600">{fmtMoney(estimatedBizDividend.baseAmount)} × {(estimatedBizDividend.ratio * 100).toFixed(1)}%{bizFormulaMultiplier > 0 ? ` × ${bizFormulaMultiplier}` : ""}</span>
                                            </div>
                                          </>
                                        )}
                                        {estimatedBizDividend.mode === "利润分红" && !c.countAsCost && (
                                          <>
                                            <div className="flex justify-between text-xs">
                                              <span className="text-slate-500">净利润</span>
                                              <span className={`font-medium tabular-nums ${(dividendPreview.profit || 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(dividendPreview.profit || 0)}</span>
                                            </div>
                                            <div className="flex justify-between text-xs">
                                              <span className="text-slate-500">计算公式</span>
                                              <span className="text-slate-600">净利润 {fmtMoney(dividendPreview.profit)} × {(estimatedBizDividend.ratio * 100).toFixed(1)}%{bizFormulaMultiplier > 0 ? ` × ${bizFormulaMultiplier}` : ""}</span>
                                            </div>
                                          </>
                                        )}
                                        {estimatedBizDividend.mode === "收入分红" && (
                                          <div className="flex justify-between text-xs">
                                            <span className="text-slate-500">计算公式</span>
                                            <span className="text-slate-600">总收入 {fmtMoney(dividendPreview.income?.totalIncome)} × {(estimatedBizDividend.ratio * 100).toFixed(1)}%{bizFormulaMultiplier > 0 ? ` × ${bizFormulaMultiplier}` : ""}</span>
                                          </div>
                                        )}
                                        {estimatedBizDividend.mode === "固定金额" && (
                                          <div className="flex justify-between text-xs">
                                            <span className="text-slate-500">计算公式</span>
                                            <span className="text-slate-600">固定金额 {fmtMoney(estimatedBizDividend.fixedAmount)}/月{bizFormulaMultiplier > 0 ? ` × ${bizFormulaMultiplier}` : ""}</span>
                                          </div>
                                        )}
                                        <div className="border-t pt-1.5">
                                          <div className="flex justify-between text-sm font-semibold">
                                            <span className="text-slate-700">预估商务分红</span>
                                            <span className="tabular-nums text-emerald-600">{fmtMoney(estimatedBizDividend.amount)}</span>
                                          </div>
                                          {c.countAsCost && (
                                            <div className="text-[10px] text-amber-600 mt-1">此金额将计入成本，影响股东分红基数</div>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* 历史分红记录 */}
                                {introducerRecords.length > 0 ? (
                                  <div className="rounded-lg border bg-white overflow-hidden">
                                    <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-600 bg-slate-50 border-b">历史分红记录</div>
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="border-b bg-slate-50/50 text-left text-slate-500">
                                          <th className="px-2.5 py-1.5 font-medium">月份</th>
                                          <th className="px-2.5 py-1.5 text-right font-medium">分红金额</th>
                                          <th className="px-2.5 py-1.5 font-medium">状态</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {introducerRecords.map((r: any) => (
                                          <tr key={r.id} className="border-b last:border-0">
                                            <td className="px-2.5 py-1.5 text-slate-600">{r.period}</td>
                                            <td className="px-2.5 py-1.5 text-right font-medium text-emerald-600 tabular-nums">
                                              {fmtMoney(r.shares.reduce((sum: number, s: any) => sum + Number(s.amount || 0), 0))}
                                            </td>
                                            <td className="px-2.5 py-1.5">
                                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.status === "已结算" ? "bg-emerald-100 text-emerald-700" : r.status === "已通过" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>{r.status}</span>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                      <tfoot>
                                        <tr className="border-t bg-slate-50 font-medium">
                                          <td className="px-2.5 py-1.5">合计</td>
                                          <td className="px-2.5 py-1.5 text-right text-emerald-600 tabular-nums">
                                            {fmtMoney(introducerRecords.reduce((sum: number, r: any) => sum + r.shares.reduce((s: number, sh: any) => s + Number(sh.amount || 0), 0), 0))}
                                          </td>
                                          <td></td>
                                        </tr>
                                      </tfoot>
                                    </table>
                                  </div>
                                ) : !hasBizEstimate ? (
                                  <div className="py-4 text-center text-xs text-slate-400">暂无分红记录和预估数据</div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(!activeShConfigs || activeShConfigs.length === 0) && (!intConfigs || intConfigs.length === 0) && (
                    <div className="px-4 py-6 text-center text-xs text-slate-400">暂无分红配置，请点击上方按钮添加</div>
                  )}
                </div>
              )}

              {/* 运营费用（v3：按场地） */}
              {landlordId && (
                <div className="rounded-xl border bg-white overflow-hidden">
                  <div className="flex items-center justify-between border-b bg-slate-50 px-4 py-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                      <DollarSign className="h-3.5 w-3.5" />
                      运营费用（{stationPeriodLabel}）
                    </div>
                  </div>
                  <div className="p-3">
                    {/* 新增行（汇总视图下禁用，提示切换为按月） */}
                    {stationGranularity === "month" ? (
                      <div className="flex items-center gap-2 mb-2">
                        <input className={`${inputCls} w-24 text-[11px]`} type="number" placeholder="金额" value={expenseDraft.amount}
                          onChange={(e) => setExpenseDraft((p) => ({ ...p, amount: e.target.value }))} />
                        <input className={`${inputCls} flex-1 text-[11px]`} placeholder="备注（如：维护费、保险费）" value={expenseDraft.remark}
                          onChange={(e) => setExpenseDraft((p) => ({ ...p, remark: e.target.value }))} />
                        <button className="rounded bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700"
                          onClick={() => {
                            if (!expenseDraft.amount) { toast.error("请填写金额"); return; }
                            saveExpenseMut.mutate({ landlordId, period: selectedMonth, amount: Number(expenseDraft.amount), remark: expenseDraft.remark || null });
                          }}>添加</button>
                      </div>
                    ) : (
                      <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[10px] text-amber-700">
                        当前为{stationPeriodLabel}汇总视图，如需新增运营费用请切换为「月」粒度
                      </div>
                    )}
                    {/* 列表 */}
                    {expenses && expenses.length > 0 ? (
                      <div className="space-y-1">
                        {expenses.map((e: any) => (
                          <div key={e.id} className="flex items-center justify-between rounded border px-2 py-1.5 text-[11px] hover:bg-slate-50">
                            {editExpenseId === e.id ? (
                              <>
                                <input className={`${inputCls} w-20 text-[11px]`} type="number" value={editExpenseDraft.amount}
                                  onChange={(ev) => setEditExpenseDraft((p) => ({ ...p, amount: ev.target.value }))} />
                                <input className={`${inputCls} flex-1 mx-2 text-[11px]`} value={editExpenseDraft.remark}
                                  onChange={(ev) => setEditExpenseDraft((p) => ({ ...p, remark: ev.target.value }))} />
                                <button className="text-emerald-600 mr-1" onClick={() => {
                                  saveExpenseMut.mutate({ id: e.id, landlordId, period: e.period || selectedMonth, amount: Number(editExpenseDraft.amount), remark: editExpenseDraft.remark || null });
                                  setEditExpenseId(null);
                                }}>保存</button>
                                <button className="text-slate-400" onClick={() => setEditExpenseId(null)}>取消</button>
                              </>
                            ) : (
                              <>
                                <span className="font-medium text-slate-700 tabular-nums">{fmtMoney(e.amount)}</span>
                                {stationGranularity !== "month" && (
                                  <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-[9px] text-slate-500">{toDisplay(e.period)}</span>
                                )}
                                <span className="flex-1 mx-2 text-slate-500 truncate">{e.remark || "-"}</span>
                                <button className="text-slate-400 hover:text-emerald-600 mr-1" onClick={() => {
                                  setEditExpenseId(e.id);
                                  setEditExpenseDraft({ amount: String(e.amount), remark: e.remark || "" });
                                }}>编辑</button>
                                <button className="text-slate-400 hover:text-rose-500" onClick={() => {
                                  if (window.confirm("删除该费用？")) deleteExpenseMut.mutate(e.id);
                                }}>删除</button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="py-3 text-center text-[11px] text-slate-400">暂无运营费用</div>
                    )}
                  </div>
                </div>
              )}

              {/* 分红记录（v3：按场地） */}
              {landlordId && (
                <div className="rounded-xl border bg-white overflow-hidden">
                  <div className="flex items-center justify-between border-b bg-slate-50 px-4 py-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                      <DollarSign className="h-3.5 w-3.5" />
                      分红记录
                      {stationGranularity !== "month" && stationDividends?.length > 0 && (
                        <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                          {stationDividends.length} 条 · 合计 {fmtMoney(stationDividends.reduce((sum: number, r: any) => sum + (r.shares?.reduce((s: number, sh: any) => s + Number(sh.amount || 0), 0) || 0), 0))}
                        </span>
                      )}
                    </div>
                    <button onClick={() => setAddDividendOpen({ open: true, landlordId })} className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700">
                      新增月结
                    </button>
                  </div>

                  {/* 期间分红汇总（季度/半年粒度） */}
                  {stationDividendSummary && (
                    <div className="border-b bg-emerald-50/40 px-4 py-3 space-y-2">
                      <div className="text-[11px] font-semibold text-slate-600">{stationPeriodLabel}分红汇总</div>
                      <div className="grid grid-cols-2 gap-2">
                        {(["股东分红", "商务分红"] as const).map((t) => (
                          <div key={t} className="flex items-center justify-between rounded border bg-white px-2.5 py-1.5 text-[11px]">
                            <span className="text-slate-500">{t}</span>
                            <span className="font-semibold tabular-nums text-emerald-700">{fmtMoney(stationDividendSummary.byType[t] || 0)}</span>
                          </div>
                        ))}
                      </div>
                      {stationDividendSummary.persons.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] text-slate-400">按股东/介绍人合计</div>
                          {stationDividendSummary.persons.map((p: any, i: number) => (
                            <div key={i} className="flex items-center justify-between text-[11px]">
                              <span className="text-slate-600">
                                {p.name}
                                {p.brandName && <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-600">{p.brandName}</span>}
                              </span>
                              <span className="font-medium tabular-nums text-slate-700">{fmtMoney(p.amount)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {stationDividends && stationDividends.length > 0 ? (
                    <div className="divide-y">
                      {stationDividends.map((r: any) => (
                        <div key={r.id} className="px-4 py-3">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-slate-700">{r.period}</span>
                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.type === "股东分红" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>{r.type}</span>
                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.status === "已结算" ? "bg-emerald-100 text-emerald-700" : r.status === "已通过" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>{r.status}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className={`text-sm font-semibold tabular-nums ${r.profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>利润 {fmtMoney(r.profit)}</div>
                              {r.status === "未结算" && (
                                <button
                                  onClick={() => setSubmitApprovalDiv(r)}
                                  className="rounded-md bg-blue-600 px-2 py-1 text-[11px] text-white hover:bg-blue-700"
                                >
                                  提交审批
                                </button>
                              )}
                              {r.status === "审批中" && (
                                <span className="text-[10px] text-amber-600">审批中…</span>
                              )}
                            </div>
                          </div>
                          {r.shares && r.shares.length > 0 && (
                            <div className="ml-4 space-y-1">
                              {r.shares.map((s: any, i: number) => (
                                <div key={i} className="flex items-center justify-between text-[11px]">
                                  <span className="text-slate-500">
                                    {s.shareholderName || s.introducerName || "-"}
                                    {s.brandName && <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-600">{s.brandName}</span>}
                                  </span>
                                  <span className="font-medium tabular-nums text-slate-700">{fmtMoney(s.amount)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-8 text-center text-xs text-slate-400">暂无分红记录</div>
                  )}
                </div>
              )}
            </div>
          )
        )}
      </div>

      {/* ─── 弹窗 ─── */}
      <AddShareholderDialog open={addShareholderOpen} onClose={() => setAddShareholderOpen(false)} />
      <ConfigDividendDialog open={configOpen.open} onClose={() => setConfigOpen({ ...configOpen, open: false })} type={configOpen.type} landlordId={configOpen.landlordId} brands={landlordBrands} />
      <AddDividendDialog open={addDividendOpen.open} onClose={() => setAddDividendOpen({ ...addDividendOpen, open: false })} landlordId={addDividendOpen.landlordId} />
      <SubmitApprovalDialog
        open={!!submitApprovalDiv}
        onClose={() => { setSubmitApprovalDiv(null); setSelectedApprovalIds([]); }}
        dividends={Array.isArray(submitApprovalDiv) ? submitApprovalDiv : (submitApprovalDiv ? [submitApprovalDiv] : [])}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ["stationDividends"] });
          qc.invalidateQueries({ queryKey: ["approvals"] });
        }}
      />
      <ExportDateDialog
        open={exportDateOpen}
        onClose={() => setExportDateOpen(false)}
        onConfirm={viewMode === "shareholder" ? doShareholderExport : doStationExport}
        hint={exportHint}
      />
    </div>
  );
}
