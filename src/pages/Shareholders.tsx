import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { listShareholders, listIntroducers, createShareholder, listEntities } from "@/api/directory";
import { getStationBoard } from "@/api/overview";
import { listDividends, listShareholderConfigs, listIntroducerConfigs, deleteShareholderConfig, deleteIntroducerConfig, calculateDividend, createDividend, refreshDividends, shareholderSummary, saveShareholderConfig, saveIntroducerConfig, submitDividend } from "@/api/dividends";
import { listExpenses, saveExpense, deleteExpense } from "@/api/rent";
import { exportXlsxWithTitle, exportXlsxWithTitles } from "@/lib/export";
import { MonthPicker } from "@/components/MonthPicker";
import { fmtMoney } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { inputCls, SearchSelect } from "@/components/fields";
import { groupByEntity } from "@/lib/groupColors";
import { Users, MapPin, X, Trash2, UserPlus, Wallet, Settings, Pencil, Search, Landmark, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

// ════════════════════════════════════════════════════════════════
// 分红管理（v3 重设计）：
//   - 配置好分红比例/分红人（股东/介绍人）后，页面自动计算预估分红
//   - 顶部月份切换：任意月份的分红预估
//   - 左侧列表：按场地方 / 按股东 查看
//   - 分红周期：月/季度/半年/年；未到结算月金额累加（周期内待结算），到结算月才生成记录
// ════════════════════════════════════════════════════════════════

// ─── 新增股东弹窗 ───
function AddShareholderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [remark, setRemark] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("股东名称不能为空");
      return createShareholder({ name: name.trim(), phone: phone.trim() || undefined, remark: remark.trim() || undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
      toast.success("股东添加成功");
      onClose();
      setName(""); setPhone(""); setRemark("");
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "添加失败"),
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

// ─── 配置分红弹窗（股东/介绍人；品牌范围 + 模式 + 周期 + 生效期；支持编辑已有配置）───
function ConfigDividendDialog({ open, onClose, type, landlordId, brands, entities, editingConfig }: { open: boolean; onClose: () => void; type: "shareholder" | "introducer"; landlordId?: number; brands?: any[]; entities?: any[]; editingConfig?: any | null }) {
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState<number | null>(null);
  const [brandId, setBrandId] = useState<number | "">("");
  const [entityId, setEntityId] = useState<number | "">("");
  const [mode, setMode] = useState("利润分红");
  const [ratio, setRatio] = useState("");
  const [fixedAmount, setFixedAmount] = useState("");
  const [countAsCost, setCountAsCost] = useState(false);
  const [dividendPeriod, setDividendPeriod] = useState("月");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // 打开编辑时预填表单
  useEffect(() => {
    if (open && editingConfig) {
      setTargetId(editingConfig.shareholderId ?? editingConfig.introducerId ?? null);
      setBrandId(editingConfig.brandId ?? "");
      setEntityId(editingConfig.entityId ?? "");
      setMode(editingConfig.mode || "利润分红");
      setRatio(editingConfig.mode !== "固定金额" ? String(Math.round((editingConfig.ratio || 0) * 10000) / 100) : "");
      setFixedAmount(editingConfig.mode === "固定金额" ? String(editingConfig.fixedAmount ?? "") : "");
      setCountAsCost(!!editingConfig.countAsCost);
      setDividendPeriod(editingConfig.settlementPeriod || "月");
      setStartDate(editingConfig.startDate ? String(editingConfig.startDate).slice(0, 10) : "");
      setEndDate(editingConfig.endDate ? String(editingConfig.endDate).slice(0, 10) : "");
    } else if (open) {
      setTargetId(null); setBrandId(""); setEntityId(""); setMode("利润分红"); setRatio("");
      setFixedAmount(""); setCountAsCost(false); setDividendPeriod("月");
      setStartDate(""); setEndDate("");
    }
  }, [open, editingConfig]);

  const { data: shareholders } = useQuery({ queryKey: ["shareholders"], queryFn: () => listShareholders(), enabled: type === "shareholder" });
  const { data: introducers } = useQuery({ queryKey: ["introducers"], queryFn: () => listIntroducers(), enabled: type === "introducer" });

  const targets = type === "shareholder" ? shareholders : introducers;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!landlordId) throw new Error("请先选择场地方");
      if (!targetId) throw new Error(type === "shareholder" ? "请选择股东" : "请选择介绍人");
      if (mode !== "固定金额" && !ratio) throw new Error("请输入比例");
      if (mode === "固定金额" && !fixedAmount) throw new Error("请输入固定金额");
      const body: any = type === "shareholder"
        ? { landlordId, shareholderId: targetId, brandId: brandId || null, entityId: entityId || null, mode, ratio: mode !== "固定金额" ? Number(ratio) / 100 : null, fixedAmount: mode === "固定金额" ? Number(fixedAmount) : null, settlementPeriod: dividendPeriod, startDate: startDate || null, endDate: endDate || null }
        : { landlordId, introducerId: targetId, brandId: brandId || null, entityId: entityId || null, mode, ratio: mode !== "固定金额" ? Number(ratio) / 100 : null, fixedAmount: mode === "固定金额" ? Number(fixedAmount) : null, countAsCost, settlementPeriod: dividendPeriod, startDate: startDate || null, endDate: endDate || null };
      if (editingConfig?.id) body.configId = editingConfig.id;
      return type === "shareholder" ? saveShareholderConfig(body) : saveIntroducerConfig(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholderConfigs"] });
      qc.invalidateQueries({ queryKey: ["introducerConfigs"] });
      qc.invalidateQueries({ queryKey: ["allShareholderConfigs"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      qc.invalidateQueries({ queryKey: ["stationBoard"] });
      toast.success(editingConfig ? "配置已更新" : "配置成功");
      onClose();
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "配置失败"),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-800">{editingConfig ? `编辑${type === "shareholder" ? "股东分红" : "商务分红"}` : `配置${type === "shareholder" ? "股东分红" : "商务分红"}`}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <div className="mb-1 block text-xs text-slate-500">{type === "shareholder" ? "选择股东" : "选择介绍人"} <span className="text-rose-500">*</span></div>
            <SearchSelect
              value={targetId ? String(targetId) : ""}
              onChange={(v) => setTargetId(v ? Number(v) : null)}
              placeholder={type === "shareholder" ? "请选择股东（可搜索）" : "请选择介绍人（可搜索）"}
              clearable={false}
              options={(targets ?? []).map((t: any) => ({ value: String(t.id), label: t.name }))}
            />
          </div>
          <div>
            <div className="mb-1 block text-xs text-slate-500">品牌范围</div>
            <SearchSelect
              value={brandId === "" ? "" : String(brandId)}
              onChange={(v) => setBrandId(v ? Number(v) : "")}
              placeholder="整个场地（全部品牌）"
              options={(brands ?? []).map((b: any) => ({ value: String(b.id), label: b.name }))}
            />
            <div className="mt-1 text-[10px] text-slate-400">选择品牌则只参与该品牌的分红；留空参与场地全部分红</div>
          </div>
          <div>
            <div className="mb-1 block text-xs text-slate-500">主体范围</div>
            <SearchSelect
              value={entityId === "" ? "" : String(entityId)}
              onChange={(v) => setEntityId(v ? Number(v) : "")}
              placeholder="不按主体（默认）"
              options={(entities ?? []).map((en: any) => ({ value: String(en.id), label: en.name }))}
            />
            <div className="mt-1 text-[10px] text-slate-400">
              选择主体则分红基数 = 该主体在本场地的收入/利润（跨品牌归集）；与品牌同时选择时按品牌优先
            </div>
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
            {mutation.isPending ? "保存中…" : editingConfig ? "保存修改" : "确认配置"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 新增分红月结弹窗（到结算期才生成记录）───
function AddDividendDialog({ open, onClose, landlordId, defaultPeriod, estimatePreview }: { open: boolean; onClose: () => void; landlordId?: number; defaultPeriod?: string; estimatePreview?: any }) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(defaultPeriod || new Date().toISOString().slice(0, 7));
  const [type, setType] = useState("股东分红");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!landlordId || !period) throw new Error("请先选择场地方和月份");
      return createDividend({ landlordId, period: toCompact(period), type });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dividends"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      toast.success("分红月结创建成功");
      onClose();
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
            <input type="month" className={inputCls} value={period} onChange={e => e.target.value && setPeriod(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">分红类型</label>
            <select className={inputCls} value={type} onChange={e => setType(e.target.value)}>
              <option value="股东分红">股东分红</option>
              <option value="商务分红">商务分红</option>
            </select>
          </div>
          {estimatePreview && (
            <div className="rounded-lg border bg-slate-50 p-3 space-y-1 text-xs">
              <div className="font-semibold text-slate-700">该月分红预估</div>
              <div className="flex justify-between"><span className="text-slate-500">利润</span><span className="font-medium tabular-nums">{fmtMoney(estimatePreview.profit)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">股东分红</span><span className="font-medium tabular-nums text-emerald-600">{fmtMoney(estimatePreview.summary?.totalShareholderDividend)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">商务分红</span><span className="font-medium tabular-nums text-emerald-600">{fmtMoney(estimatePreview.summary?.totalBusinessDividend)}</span></div>
            </div>
          )}
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            仅在该分红类型的结算月份生成记录；非结算月请勿生成（金额会累计到结算月一并核算）。
          </div>
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

// ─── 分红核算明细弹窗（逐月构成 + 电表级明细，供分红人员核对）───
// monthDatas[i] 对应 months[i] 的 calculate(estimate) 响应
function DividendDetailDialog({ open, onClose, landlordName, personName, months, monthDatas, personKey, personId }: {
  open: boolean; onClose: () => void;
  landlordName?: string; personName?: string;
  months: string[]; monthDatas: any[];
  personKey: "shareholderId" | "introducerId"; personId?: number | null;
}) {
  const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
  const fmt = (n: number) => fmtMoney(r2(n));

  // 该人的分红配置（可能多条：全场 + 品牌）
  const configs = useMemo(() => {
    const first = monthDatas.find((d) =>
      d && (d.shareholderDividends ?? []).some((x: any) => x[personKey] === personId) ||
      d && (d.bizDividends ?? []).some((x: any) => x[personKey] === personId)
    );
    if (!first) return [];
    const list = personKey === "shareholderId" ? first.shareholderDividends ?? [] : first.bizDividends ?? [];
    return list.filter((x: any) => x[personKey] === personId);
  }, [monthDatas, personKey, personId]);

  // 逐月行（品牌股东用品牌 P&L，全场股东用整场地）
  const rows = useMemo(() => {
    const out: any[] = [];
    months.forEach((m, i) => {
      const est = monthDatas[i];
      if (!est) return;
      const list = personKey === "shareholderId" ? est.shareholderDividends ?? [] : est.bizDividends ?? [];
      const mine = list.filter((x: any) => x[personKey] === personId);
      if (mine.length === 0) return;
      const cfg = mine[0];
      const isBrand = cfg?.brandId != null;
      const b = isBrand ? (est.brandBreakdown ?? []).find((x: any) => x.brandId === cfg.brandId) : null;
      out.push({
        month: m,
        scope: isBrand ? (cfg.brandName || `品牌#${cfg.brandId}`) : "全场",
        mode: cfg.mode,
        ratio: cfg.ratio,
        fixedAmount: cfg.fixedAmount,
        settlementPeriod: cfg.settlementPeriod,
        isSettlement: mine.some((x: any) => x.isSettlementMonth),
        elecIncome: isBrand ? (b?.elecIncome ?? 0) : (est.income?.elecIncome?.total ?? 0),
        rentIncome: isBrand ? (b?.rentIncome ?? 0) : (est.income?.rentIncome?.total ?? 0),
        elecCost: isBrand ? (b?.elecCost ?? 0) : (est.cost?.elecCost ?? 0),
        venueCost: isBrand ? (b?.venueCost ?? 0) : (est.cost?.rentCost ?? 0),
        opExpense: isBrand ? (b?.opExpense ?? 0) : (est.cost?.opExpense ?? 0),
        elecTax: isBrand ? (b?.elecTax ?? 0) : (est.cost?.elecTax ?? 0),
        rentTax: isBrand ? (b?.rentTax ?? 0) : (est.cost?.rentTax ?? 0),
        profit: isBrand ? (b?.profit ?? 0) : (est.profit ?? 0),
        amount: r2(mine.reduce((s: number, x: any) => s + Number(x.amount || 0), 0)),
      });
    });
    return out;
  }, [months, monthDatas, personKey, personId, r2]);

  const totals = useMemo(() => {
    const t: any = { elecIncome: 0, rentIncome: 0, elecCost: 0, venueCost: 0, opExpense: 0, elecTax: 0, rentTax: 0, profit: 0, amount: 0 };
    for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k] || 0;
    for (const k of Object.keys(t)) t[k] = r2(t[k]);
    return t;
  }, [rows, r2]);

  // 电费收入明细（表级，逐月）
  const elecIncomeRows = useMemo(() => {
    const out: any[] = [];
    months.forEach((m, i) => {
      const est = monthDatas[i];
      if (!est) return;
      const list = personKey === "shareholderId" ? est.shareholderDividends ?? [] : est.bizDividends ?? [];
      const cfg = list.find((x: any) => x[personKey] === personId);
      const isBrand = cfg?.brandId != null;
      const taxMap = new Map<string, any>((est.cost?.details?.elecTax?.details ?? []).map((t: any) => [t.meterNo, t] as [string, any]));
      for (const d of est.income?.elecIncome?.details ?? []) {
        if (isBrand && d.brandName !== cfg.brandName) continue;
        const gross = r2((d.kwh || 0) * (d.unitPrice || 0));
        const tax = r2(taxMap.get(d.meterNo)?.amount ?? 0);
        out.push({ month: m, meterNo: d.meterNo, brandName: d.brandName || "", kwh: d.kwh || 0, unitPrice: d.unitPrice || 0, gross, tax, net: r2(gross - tax) });
      }
    });
    return out;
  }, [months, monthDatas, personKey, personId, r2]);

  // 租金收入明细（品牌级，逐月）
  const rentIncomeRows = useMemo(() => {
    const out: any[] = [];
    months.forEach((m, i) => {
      const est = monthDatas[i];
      if (!est) return;
      const list = personKey === "shareholderId" ? est.shareholderDividends ?? [] : est.bizDividends ?? [];
      const cfg = list.find((x: any) => x[personKey] === personId);
      const isBrand = cfg?.brandId != null;
      for (const d of est.income?.rentIncome?.details ?? []) {
        if (isBrand && d.brandId !== cfg?.brandId) continue;
        out.push({ month: m, brandName: d.brandName || "未指定", cabinets: d.cabinets || 0, preTax: d.preTaxRent ?? 0, postTax: d.postTaxRent ?? d.amount ?? 0, amount: d.amount ?? 0 });
      }
    });
    return out;
  }, [months, monthDatas, personKey, personId]);

  // 电费成本明细（表级，逐月；品牌模式按表号反查归属）
  const elecCostRows = useMemo(() => {
    const out: any[] = [];
    months.forEach((m, i) => {
      const est = monthDatas[i];
      if (!est) return;
      const list = personKey === "shareholderId" ? est.shareholderDividends ?? [] : est.bizDividends ?? [];
      const cfg = list.find((x: any) => x[personKey] === personId);
      const isBrand = cfg?.brandId != null;
      for (const d of est.cost?.details?.electricity ?? []) {
        if (isBrand) {
          const inc = (est.income?.elecIncome?.details ?? []).find((x: any) => x.meterNo === d.meterNo);
          if (!inc || inc.brandName !== cfg.brandName) continue;
        }
        out.push({ month: m, meterNo: d.meterNo, kwh: d.kwh || 0, unitPrice: d.unitPrice || 0, amount: d.amount || 0 });
      }
    });
    return out;
  }, [months, monthDatas, personKey, personId]);

  // 场地成本（合同级）+ 运营费用（逐月）
  const venueRows = useMemo(() => {
    const out: any[] = [];
    months.forEach((m, i) => {
      const est = monthDatas[i];
      if (!est) return;
      for (const d of est.cost?.details?.rent ?? []) out.push({ month: m, name: d.landlordName || "场地合同", amount: d.monthlyRent || 0 });
      const op = est.cost?.details?.operatingExpense;
      if (op && Number(op.amount || 0) > 0) out.push({ month: m, name: `运营费用${op.remark ? `（${op.remark}）` : ""}`, amount: op.amount });
    });
    return out;
  }, [months, monthDatas]);

  // 税费明细
  const taxRows = useMemo(() => {
    const out: any[] = [];
    months.forEach((m, i) => {
      const est = monthDatas[i];
      if (!est) return;
      for (const t of est.cost?.details?.elecTax?.details ?? []) {
        out.push({ month: m, kind: "电费税费", name: `${t.brandName} ${t.meterNo}`, rate: t.preTaxPrice && t.postTaxPrice ? `${((1 - Number(t.postTaxPrice) / Number(t.preTaxPrice)) * 100).toFixed(1)}%` : "", amount: t.amount });
      }
      for (const t of est.cost?.details?.rentTax?.details ?? []) {
        out.push({ month: m, kind: "租金税费", name: t.brandName, rate: `${((t.taxRate || 0) * 100).toFixed(1)}%`, amount: t.amount });
      }
    });
    return out;
  }, [months, monthDatas]);

  const copyText = () => {
    const L: string[] = [];
    L.push("【分红核算明细】");
    L.push(`场地：${landlordName || "-"}    分红人：${personName || "-"}    区间：${toDisplay(months[0])} ~ ${toDisplay(months[months.length - 1])}`);
    if (configs.length) {
      const c = configs[0];
      L.push(`参与范围：${c.brandName ? `仅 ${c.brandName}` : "全场"}    模式：${c.mode === "固定金额" ? `固定金额 ${fmtMoney(c.fixedAmount)}/月` : `${c.mode} ${((c.ratio || 0) * 100).toFixed(2)}%`}    周期：${c.settlementPeriod}分红`);
    }
    L.push("");
    L.push("【区间合计】");
    L.push(`总收入(不含税)：${fmt(totals.elecIncome + totals.rentIncome)}（电费收入 ${fmt(totals.elecIncome)} + 租金收入 ${fmt(totals.rentIncome)}）`);
    L.push(`总成本：${fmt(totals.elecCost + totals.venueCost + totals.opExpense)}（电费成本 ${fmt(totals.elecCost)} + 场地成本 ${fmt(totals.venueCost)} + 运营费用 ${fmt(totals.opExpense)}）`);
    L.push(`税费：${fmt(totals.elecTax + totals.rentTax)}（电费税费 ${fmt(totals.elecTax)} + 租金税费 ${fmt(totals.rentTax)}，税费不参与利润）`);
    L.push(`净利润：${fmt(totals.profit)}`);
    L.push(`分红金额：${fmt(totals.amount)}`);
    L.push("");
    L.push("【逐月构成】");
    L.push("月份 | 电费收入 | 租金收入 | 电费成本 | 场地成本 | 运营费用 | 税费 | 净利润 | 分红");
    for (const r of rows) {
      L.push(`${r.month} | ${fmt(r.elecIncome)} | ${fmt(r.rentIncome)} | ${fmt(r.elecCost)} | ${fmt(r.venueCost)} | ${fmt(r.opExpense)} | ${fmt(r.elecTax + r.rentTax)} | ${fmt(r.profit)} | ${fmt(r.amount)}${r.isSettlement ? "（结算月）" : ""}`);
    }
    L.push("");
    L.push("【电费收入明细（不含税）】");
    L.push("月份 | 表号 | 品牌 | 度数 | 含税单价 | 含税金额 | 税费 | 不含税金额");
    for (const r of elecIncomeRows) L.push(`${r.month} | ${r.meterNo} | ${r.brandName} | ${r.kwh} | ${r.unitPrice} | ${fmt(r.gross)} | ${fmt(r.tax)} | ${fmt(r.net)}`);
    L.push("");
    L.push("【租金收入明细（不含税）】");
    L.push("月份 | 品牌 | 柜数 | 含税月租 | 税后月租 | 不含税金额");
    for (const r of rentIncomeRows) L.push(`${r.month} | ${r.brandName} | ${r.cabinets} | ${fmt(r.preTax)} | ${fmt(r.postTax)} | ${fmt(r.amount)}`);
    L.push("");
    L.push("【电费成本明细】");
    L.push("月份 | 表号 | 度数 | 成本单价 | 金额");
    for (const r of elecCostRows) L.push(`${r.month} | ${r.meterNo} | ${r.kwh} | ${r.unitPrice} | ${fmt(r.amount)}`);
    L.push("");
    L.push("【场地成本 / 运营费用】");
    L.push("月份 | 项目 | 金额");
    for (const r of venueRows) L.push(`${r.month} | ${r.name} | ${fmt(r.amount)}`);
    L.push("");
    L.push("【税费明细】");
    L.push("月份 | 类型 | 项目 | 税率 | 金额");
    for (const r of taxRows) L.push(`${r.month} | ${r.kind} | ${r.name} | ${r.rate} | ${fmt(r.amount)}`);
    navigator.clipboard.writeText(L.join("\n")).then(() => toast.success("明细已复制，可粘贴发给分红人员")).catch(() => toast.error("复制失败"));
  };

  if (!open) return null;

  const th = "px-2 py-1.5 text-left font-medium text-slate-500";
  const thR = "px-2 py-1.5 text-right font-medium text-slate-500";
  const td = "px-2 py-1.5 border-t border-slate-100";
  const tdR = "px-2 py-1.5 border-t border-slate-100 text-right tabular-nums";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[920px] max-w-[96vw] max-h-[88vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-800">分红核算明细</h3>
          <div className="flex items-center gap-2">
            <button onClick={copyText} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100">复制文本（发分红人员）</button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* 头部信息 */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-blue-50 px-2 py-1 font-medium text-blue-700">{landlordName || "-"}</span>
          <span className="rounded-lg bg-emerald-50 px-2 py-1 font-medium text-emerald-700">{personName || "-"}</span>
          {configs.length > 0 && (
            <>
              <span className={`rounded-full px-2 py-0.5 font-medium ${configs[0].brandName ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                {configs[0].brandName ? `仅参与 ${configs[0].brandName}` : "参与全场"}
              </span>
              <span className="text-slate-500">{configs[0].mode === "固定金额" ? `固定 ${fmtMoney(configs[0].fixedAmount)}/月` : `${configs[0].mode} ${((configs[0].ratio || 0) * 100).toFixed(2)}%`}</span>
              <span className="text-slate-500">{configs[0].settlementPeriod}分红</span>
              {rows.some((r: any) => r.isSettlement) && <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">区间内含结算月</span>}
            </>
          )}
        </div>

        {/* 区间合计 */}
        <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-5">
          <div className="rounded-lg border bg-emerald-50 px-3 py-2">
            <div className="text-[10px] text-emerald-600">总收入（不含税）</div>
            <div className="text-sm font-semibold tabular-nums text-emerald-700">{fmt(totals.elecIncome + totals.rentIncome)}</div>
            <div className="text-[10px] text-slate-400">电费 {fmt(totals.elecIncome)} + 租金 {fmt(totals.rentIncome)}</div>
          </div>
          <div className="rounded-lg border bg-rose-50 px-3 py-2">
            <div className="text-[10px] text-rose-600">总成本</div>
            <div className="text-sm font-semibold tabular-nums text-rose-700">{fmt(totals.elecCost + totals.venueCost + totals.opExpense)}</div>
            <div className="text-[10px] text-slate-400">电费 {fmt(totals.elecCost)} + 场地 {fmt(totals.venueCost)} + 运营 {fmt(totals.opExpense)}</div>
          </div>
          <div className="rounded-lg border bg-amber-50 px-3 py-2">
            <div className="text-[10px] text-amber-600">税费（不含利润）</div>
            <div className="text-sm font-semibold tabular-nums text-amber-700">{fmt(totals.elecTax + totals.rentTax)}</div>
            <div className="text-[10px] text-slate-400">电费 {fmt(totals.elecTax)} + 租金 {fmt(totals.rentTax)}</div>
          </div>
          <div className="rounded-lg border bg-blue-50 px-3 py-2">
            <div className="text-[10px] text-blue-600">净利润（分红基数）</div>
            <div className="text-sm font-semibold tabular-nums text-blue-700">{fmt(totals.profit)}</div>
            <div className="text-[10px] text-slate-400">{configs[0]?.mode === "收入分红" ? "收入分红按总收入计" : "利润分红按净利润计"}</div>
          </div>
          <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-2">
            <div className="text-[10px] text-emerald-600">分红金额</div>
            <div className="text-sm font-bold tabular-nums text-emerald-700">{fmt(totals.amount)}</div>
            <div className="text-[10px] text-slate-400">预估口径（不乘周期倍数）</div>
          </div>
        </div>

        {/* 逐月构成 */}
        <div className="mb-4 rounded-lg border overflow-hidden">
          <div className="border-b bg-slate-50 px-3 py-1.5 text-[11px] font-semibold text-slate-600">逐月构成（{rows.length} 个月 · 参与范围：{rows[0]?.scope ?? "-"}）</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th}>月份</th>
                  <th className={thR}>电费收入</th>
                  <th className={thR}>租金收入</th>
                  <th className={thR}>电费成本</th>
                  <th className={thR}>场地成本</th>
                  <th className={thR}>运营费用</th>
                  <th className={thR}>税费</th>
                  <th className={thR}>净利润</th>
                  <th className={thR}>分红</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.month}>
                    <td className={td}>{toDisplay(r.month)}{r.isSettlement ? <span className="ml-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">结算</span> : null}</td>
                    <td className={tdR}>{fmt(r.elecIncome)}</td>
                    <td className={tdR}>{fmt(r.rentIncome)}</td>
                    <td className={tdR}>{fmt(r.elecCost)}</td>
                    <td className={tdR}>{fmt(r.venueCost)}</td>
                    <td className={tdR}>{fmt(r.opExpense)}</td>
                    <td className={tdR}>{fmt(r.elecTax + r.rentTax)}</td>
                    <td className={`${tdR} font-medium`}>{fmt(r.profit)}</td>
                    <td className={`${tdR} font-semibold text-emerald-700`}>{fmt(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 电费收入明细 */}
        <div className="mb-4 rounded-lg border overflow-hidden">
          <div className="border-b bg-slate-50 px-3 py-1.5 text-[11px] font-semibold text-slate-600">电费收入明细（{elecIncomeRows.length} 行 · 不含税）</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th}>月份</th><th className={th}>表号</th><th className={th}>品牌</th>
                  <th className={thR}>度数</th><th className={thR}>含税单价</th><th className={thR}>含税金额</th>
                  <th className={thR}>税费</th><th className={thR}>不含税金额</th>
                </tr>
              </thead>
              <tbody>
                {elecIncomeRows.map((r, idx) => (
                  <tr key={idx}>
                    <td className={td}>{toDisplay(r.month)}</td>
                    <td className={`${td} font-mono text-[11px]`}>{r.meterNo}</td>
                    <td className={td}>{r.brandName}</td>
                    <td className={tdR}>{r.kwh}</td>
                    <td className={tdR}>{r.unitPrice}</td>
                    <td className={tdR}>{fmt(r.gross)}</td>
                    <td className={tdR}>{fmt(r.tax)}</td>
                    <td className={`${tdR} font-medium`}>{fmt(r.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 租金收入明细 */}
        <div className="mb-4 rounded-lg border overflow-hidden">
          <div className="border-b bg-slate-50 px-3 py-1.5 text-[11px] font-semibold text-slate-600">租金收入明细（{rentIncomeRows.length} 行 · 不含税）</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th}>月份</th><th className={th}>品牌</th><th className={thR}>柜数</th>
                  <th className={thR}>含税月租</th><th className={thR}>税后月租</th><th className={thR}>不含税金额</th>
                </tr>
              </thead>
              <tbody>
                {rentIncomeRows.map((r, idx) => (
                  <tr key={idx}>
                    <td className={td}>{toDisplay(r.month)}</td>
                    <td className={td}>{r.brandName}</td>
                    <td className={tdR}>{r.cabinets}</td>
                    <td className={tdR}>{fmt(r.preTax)}</td>
                    <td className={tdR}>{fmt(r.postTax)}</td>
                    <td className={`${tdR} font-medium`}>{fmt(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 电费成本明细 */}
        <div className="mb-4 rounded-lg border overflow-hidden">
          <div className="border-b bg-slate-50 px-3 py-1.5 text-[11px] font-semibold text-slate-600">电费成本明细（{elecCostRows.length} 行）</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th}>月份</th><th className={th}>表号</th>
                  <th className={thR}>度数</th><th className={thR}>成本单价</th><th className={thR}>金额</th>
                </tr>
              </thead>
              <tbody>
                {elecCostRows.map((r, idx) => (
                  <tr key={idx}>
                    <td className={td}>{toDisplay(r.month)}</td>
                    <td className={`${td} font-mono text-[11px]`}>{r.meterNo}</td>
                    <td className={tdR}>{r.kwh}</td>
                    <td className={tdR}>{r.unitPrice}</td>
                    <td className={`${tdR} font-medium`}>{fmt(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 场地成本 / 运营费用 + 税费 */}
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg border overflow-hidden">
            <div className="border-b bg-slate-50 px-3 py-1.5 text-[11px] font-semibold text-slate-600">场地成本 / 运营费用（{venueRows.length} 行）</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th}>月份</th><th className={th}>项目</th><th className={thR}>金额</th>
                </tr>
              </thead>
              <tbody>
                {venueRows.map((r, idx) => (
                  <tr key={idx}>
                    <td className={td}>{toDisplay(r.month)}</td>
                    <td className={td}>{r.name}</td>
                    <td className={tdR}>{fmt(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-lg border overflow-hidden">
            <div className="border-b bg-slate-50 px-3 py-1.5 text-[11px] font-semibold text-slate-600">税费明细（{taxRows.length} 行）</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className={th}>月份</th><th className={th}>类型</th><th className={th}>项目</th>
                  <th className={thR}>税率</th><th className={thR}>金额</th>
                </tr>
              </thead>
              <tbody>
                {taxRows.map((r, idx) => (
                  <tr key={idx}>
                    <td className={td}>{toDisplay(r.month)}</td>
                    <td className={td}>{r.kind}</td>
                    <td className={td}>{r.name}</td>
                    <td className={tdR}>{r.rate}</td>
                    <td className={tdR}>{fmt(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-3 text-[10px] text-slate-400">
          * 口径说明：收入为不含税（电费按价内税拆分，租金用税后月租）；税费单独展示，不参与净利润；净利润 = 总收入 − 总成本。
          品牌参与人只统计该品牌收入/成本（场地成本按柜数分摊）；分红金额为预估口径（每月基数 × 比例，结算月生成记录时按周期倍数核算累计金额）。
        </div>
      </div>
    </div>
  );
}

// ─── 主页面 ───
export default function Shareholders() {
  const qc = useQueryClient();
  const now = new Date();
  const initialMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [periodStart, setPeriodStart] = useState(initialMonth);
  const [periodEnd, setPeriodEnd] = useState(initialMonth);
  // 结束月 = "当前选中月"（单月查看时 起始=结束）
  const selectedMonth = periodEnd;
  const isRange = periodStart !== periodEnd;
  const periodLabel = isRange ? `${toDisplay(periodStart)} ~ ${toDisplay(periodEnd)}` : toDisplay(selectedMonth);
  const [viewMode, setViewMode] = useState<"landlord" | "shareholder">("landlord");
  const [selectedLandlordId, setSelectedLandlordId] = useState<number | null>(null);
  const [selectedShareholderId, setSelectedShareholderId] = useState<number | null>(null);
  const [addShareholderOpen, setAddShareholderOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState<{ open: boolean; type: "shareholder" | "introducer"; config?: any | null }>({ open: false, type: "shareholder", config: null });
  const [addDividendOpen, setAddDividendOpen] = useState(false);
  const [detail, setDetail] = useState<{ open: boolean; personKey: "shareholderId" | "introducerId"; personId: number | null; personName: string; landlordName: string; months: string[]; monthDatas: any[] } | null>(null);

  // 快捷区间
  const quickRange = (months: number) => {
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    setPeriodStart(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`);
    setPeriodEnd(`${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}`);
  };

  // 区间内所有月份（YYYY-MM）
  const monthsInRange = useMemo(() => {
    const out: string[] = [];
    if (!periodStart || !periodEnd) return out;
    let [y, m] = [Number(periodStart.slice(0, 4)), Number(periodStart.slice(5))];
    const [ey, em] = [Number(periodEnd.slice(0, 4)), Number(periodEnd.slice(5))];
    let guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard < 60) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m++; if (m > 12) { m = 1; y++; }
      guard++;
    }
    return out;
  }, [periodStart, periodEnd]);

  // ── 场地看板（左侧列表 + 场地经营数据）──
  const board = useQuery({
    queryKey: ["stationBoard", selectedMonth],
    queryFn: () => getStationBoard({ period: selectedMonth }),
  });
  const landlords = useMemo(() => board.data ?? [], [board.data]);

  // 股东列表 + 汇总（区间）
  const shareholders = useQuery({ queryKey: ["shareholders"], queryFn: () => listShareholders() });
  const shSummary = useQuery({
    queryKey: ["shareholderSummary", periodStart, periodEnd],
    queryFn: () => shareholderSummary({ periodStart: toCompact(periodStart), periodEnd: toCompact(periodEnd) }),
  });

  // ── 选中场地：逐月分红预估（estimate 模式）并聚合 ──
  const selectedLandlord = useMemo(
    () => landlords.find((r: any) => r.landlord.id === selectedLandlordId) || null,
    [landlords, selectedLandlordId]
  );
  const landlordId = selectedLandlord?.landlord?.id ?? null;

  // 场地方列表：搜索（场地名称/公司主体模糊匹配）+ 按公司主体分块
  const [landlordKeyword, setLandlordKeyword] = useState("");
  // 公司主体分组展开状态：点击公司主体展开/收起场地方明细
  const [openEntityGroups, setOpenEntityGroups] = useState<Set<string>>(new Set());
  const toggleEntityGroup = (name: string) => {
    setOpenEntityGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const filteredLandlords = useMemo(() => {
    const kw = landlordKeyword.trim();
    if (!kw) return landlords;
    return landlords.filter((r: any) =>
      (r.landlord?.name || "").includes(kw) || (r.entityName || "").includes(kw));
  }, [landlords, landlordKeyword]);
  const filteredLandlordGroups = useMemo(() => groupByEntity(filteredLandlords), [filteredLandlords]);

  const previewQueries = useQueries({
    queries: monthsInRange.map((m) => ({
      queryKey: ["dividendPreview", landlordId, m],
      queryFn: () => calculateDividend({ landlordId: landlordId!, period: m, estimate: true }),
      enabled: viewMode === "landlord" && landlordId != null && monthsInRange.length > 0,
    })),
  });
  // 结束月（单月）的预估数据，供"生成分红记录"预览
  const endMonthPreview = previewQueries[monthsInRange.length - 1]?.data ?? null;
  // 区间聚合：收入/成本/税费/净利/分红合计 求和；受益人按人×品牌合并金额
  const preview = useMemo(() => {
    const datas = previewQueries.map((q) => q.data).filter(Boolean) as any[];
    if (datas.length === 0) return null;
    const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
    const sum = (f: (d: any) => number) => r2(datas.reduce((s, d) => s + (f(d) || 0), 0));
    const merge = (kind: "shareholderDividends" | "bizDividends", idKey: string) => {
      const map = new Map<string, any>();
      for (const d of datas) {
        for (const b of d[kind] ?? []) {
          const k = `${b[idKey]}-${b.brandId ?? ""}`;
          const prev = map.get(k);
          if (!prev) map.set(k, { ...b, amount: r2(b.amount || 0) });
          else {
            prev.amount = r2(prev.amount + (b.amount || 0));
            prev.isSettlementMonth = prev.isSettlementMonth || b.isSettlementMonth;
          }
        }
      }
      return [...map.values()];
    };
    return {
      landlordId: datas[0].landlordId,
      landlordName: datas[0].landlordName,
      period: periodEnd.replace("-", ""),
      income: { totalIncome: sum((d) => d.income?.totalIncome) },
      cost: { totalCost: sum((d) => d.cost?.totalCost), elecTax: sum((d) => d.cost?.elecTax), rentTax: sum((d) => d.cost?.rentTax) },
      profit: sum((d) => d.profit),
      summary: {
        totalShareholderDividend: sum((d) => d.summary?.totalShareholderDividend),
        totalBusinessDividend: sum((d) => d.summary?.totalBusinessDividend),
      },
      shareholderDividends: merge("shareholderDividends", "shareholderId"),
      bizDividends: merge("bizDividends", "introducerId"),
    };
  }, [previewQueries, periodEnd]);

  const shConfigs = useQuery({
    queryKey: ["shareholderConfigs", landlordId],
    queryFn: () => listShareholderConfigs({ landlordId: landlordId! }),
    enabled: viewMode === "landlord" && landlordId != null,
  });
  const intConfigs = useQuery({
    queryKey: ["introducerConfigs", landlordId],
    queryFn: () => listIntroducerConfigs({ landlordId: landlordId! }),
    enabled: viewMode === "landlord" && landlordId != null,
  });

  const dividends = useQuery({
    queryKey: ["dividends", landlordId],
    queryFn: () => listDividends({ landlordId: landlordId! }),
    enabled: viewMode === "landlord" && landlordId != null,
  });
  // 按区间过滤记录（period 为 YYYYMM）
  const filteredDividends = useMemo(() => {
    const s = toCompact(periodStart), e = toCompact(periodEnd);
    return (dividends.data ?? []).filter((r: any) => r.period >= s && r.period <= e);
  }, [dividends.data, periodStart, periodEnd]);

  // 品牌列表（场地下的品牌，用于配置弹窗）
  const brandsOfLandlord = useCallback((lid: number) => {
    const r = landlords.find((x: any) => x.landlord.id === lid);
    const seen = new Map<number, string>();
    for (const cb of r?.contractBreakdown ?? []) {
      if (cb.type === "品牌方合同" && cb.brandId) seen.set(cb.brandId, cb.brandName || `品牌#${cb.brandId}`);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [landlords]);
  const landlordBrands = useMemo(() => (landlordId != null ? brandsOfLandlord(landlordId) : []), [landlordId, brandsOfLandlord]);

  // ── 选中股东：所有场地配置 + 各场地预估 ──
  const allShConfigs = useQuery({
    queryKey: ["allShareholderConfigs"],
    queryFn: () => listShareholderConfigs(),
    enabled: viewMode === "shareholder",
  });
  const selectedShareholder = useMemo(() => {
    if (viewMode !== "shareholder" || !selectedShareholderId) return null;
    return (shareholders.data ?? []).find((s: any) => s.id === selectedShareholderId) || null;
  }, [viewMode, selectedShareholderId, shareholders.data]);

  // 该股东涉及的所有场地（去重）
  const shareholderLandlordIds = useMemo(() => {
    if (!selectedShareholderId) return [];
    const ids = (allShConfigs.data ?? [])
      .filter((c: any) => c.shareholderId === selectedShareholderId)
      .map((c: any) => c.landlordId)
      .filter(Boolean);
    return [...new Set(ids)] as number[];
  }, [allShConfigs.data, selectedShareholderId]);

  // 各场地的名称（从 board 匹配）
  const shareholderLandlords = useMemo(
    () => shareholderLandlordIds.map((lid) => landlords.find((r: any) => r.landlord.id === lid) || null).filter(Boolean),
    [shareholderLandlordIds, landlords]
  );

  // 该股东在各场地的区间预估（estimate 模式，按股东过滤；逐场地 × 逐月）
  const shareholderEstimateQueries = useQueries({
    queries: shareholderLandlordIds.flatMap((lid) => monthsInRange.map((m) => ({
      queryKey: ["dividendPreview", lid, m],
      queryFn: () => calculateDividend({ landlordId: lid, period: m, estimate: true }),
      enabled: viewMode === "shareholder" && shareholderLandlordIds.length > 0 && monthsInRange.length > 0,
    }))),
  });
  const shareholderEstimateByLandlord = useMemo(() => {
    const map: Record<number, number> = {};
    shareholderLandlordIds.forEach((lid, li) => {
      monthsInRange.forEach((_m, mi) => {
        const est = shareholderEstimateQueries[li * monthsInRange.length + mi]?.data;
        if (!est) return;
        const mine = (est.shareholderDividends ?? []).filter((d: any) => d.shareholderId === selectedShareholderId);
        map[lid] = Math.round(((map[lid] || 0) + mine.reduce((s: number, d: any) => s + Number(d.amount || 0), 0)) * 100) / 100;
      });
    });
    return map;
  }, [shareholderLandlordIds, monthsInRange, shareholderEstimateQueries, selectedShareholderId]);

  const configMutations = useMutation({
    mutationFn: ({ type, id }: { type: "shareholder" | "introducer"; id: number }) =>
      type === "shareholder" ? deleteShareholderConfig(id) : deleteIntroducerConfig(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholderConfigs"] });
      qc.invalidateQueries({ queryKey: ["introducerConfigs"] });
      qc.invalidateQueries({ queryKey: ["allShareholderConfigs"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      toast.success("配置已删除");
    },
    onError: () => toast.error("删除失败"),
  });

  // 提交分红审核
  const submitMutation = useMutation({
    mutationFn: (recordId: number) => submitDividend(recordId, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dividends"] });
      toast.success("已提交审批，可在「审批」页查看处理进度");
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "提交失败"),
  });

  // 手动重算：按最新上游数据（合同/电表/柜子/台账/运营费用）重算当前场地的分红记录（所有状态）
  const refreshMutation = useMutation({
    mutationFn: () => refreshDividends({ landlordId: landlordId! }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["dividends"] });
      qc.invalidateQueries({ queryKey: ["dividendPreview"] });
      toast.success(`已重算 ${r?.refreshed ?? 0} 条分红记录`);
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "重算失败"),
  });

  // ── 运营费用（当前选中月 = periodEnd；可按主体录入，空 = 整场地公共）──
  const expenses = useQuery({
    queryKey: ["opExpenses", landlordId, periodEnd],
    queryFn: () => listExpenses({ landlordId: landlordId!, period: toCompact(periodEnd) }),
    enabled: viewMode === "landlord" && landlordId != null,
  });
  const entitiesQ = useQuery({
    queryKey: ["entities"],
    queryFn: listEntities,
    enabled: viewMode === "landlord" && landlordId != null,
  });
  const [expenseEntityId, setExpenseEntityId] = useState(""); // ""=整场地公共
  const expenseRows = (expenses.data ?? []) as any[];
  const expenseTotal = expenseRows.reduce((s: number, x: any) => s + (Number(x.amount) || 0), 0);
  const selectedExpenseRow = useMemo(
    () => expenseRows.find((x: any) => (x.entityId ?? null) === (expenseEntityId ? Number(expenseEntityId) : null)) || null,
    [expenseRows, expenseEntityId]
  );
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseRemark, setExpenseRemark] = useState("");
  const expenseKeyRef = useRef("");
  useEffect(() => {
    const key = `${landlordId}-${periodEnd}-${expenseEntityId}`;
    if (expenseKeyRef.current !== key) {
      expenseKeyRef.current = key;
      setExpenseAmount(selectedExpenseRow ? String(selectedExpenseRow.amount ?? "") : "");
      setExpenseRemark(selectedExpenseRow?.remark ?? "");
    }
  }, [landlordId, periodEnd, expenseEntityId, selectedExpenseRow]);
  const invalidateOpExpense = () => {
    qc.invalidateQueries({ queryKey: ["opExpenses"] });
    qc.invalidateQueries({ queryKey: ["dividendPreview"] });
    qc.invalidateQueries({ queryKey: ["stationBoard"] });
  };
  const saveExpenseMutation = useMutation({
    mutationFn: async () => {
      if (!landlordId) throw new Error("请先选择场地方");
      const amount = Number(expenseAmount);
      if (expenseAmount === "" || isNaN(amount) || amount < 0) throw new Error("请输入有效的运营费用金额");
      return saveExpense({ landlordId, period: toCompact(periodEnd), amount, remark: expenseRemark.trim() || null, entityId: expenseEntityId ? Number(expenseEntityId) : null });
    },
    onSuccess: () => {
      invalidateOpExpense();
      toast.success(`已保存 ${toDisplay(periodEnd)} 运营费用`);
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "保存失败"),
  });
  const deleteExpenseMutation = useMutation({
    mutationFn: (id: number) => deleteExpense(id),
    onSuccess: () => {
      invalidateOpExpense();
      toast.success("运营费用已删除");
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || e.message || "删除失败"),
  });

  // ── 导出 Excel ──
  const r2x = (n: any) => (n == null || isNaN(Number(n)) ? "" : Math.round(Number(n) * 100) / 100);
  // 按场地方导出：每个场地一个 sheet，月份为行（参考"XX超级换电站分红"格式）
  const doExportByLandlord = async () => {
    if (landlords.length === 0) { toast.error("暂无场地数据"); return; }
    const tid = toast.loading("正在生成导出数据…");
    try {
      const sheets: { name: string; title: string; headers: string[]; rows: unknown[][] }[] = [];
      for (const r of landlords) {
        const lid = r.landlord.id;
        const datas: any[] = [];
        for (const m of monthsInRange) {
          datas.push(await calculateDividend({ landlordId: lid, period: m, estimate: true }));
        }
        // 分红人列（股东 + 商务，跨月并集）
        const personCols: string[] = [];
        const personMap = new Map<string, "shareholderId" | "introducerId">();
        for (const d of datas) {
          for (const x of d?.shareholderDividends ?? []) if (!personMap.has(x.shareholderName)) { personMap.set(x.shareholderName, "shareholderId"); }
          for (const x of d?.bizDividends ?? []) if (!personMap.has(x.introducerName)) { personMap.set(x.introducerName, "introducerId"); }
        }
        personCols.push(...personMap.keys());
        const headers = ["分红月份", "电量", "付款单价", "付款金额", "收款电费含税", "电费不含税", "收款租金含税", "租金不含税", "电费租金收款合计", "利润", ...personCols, "备注"];
        const rows: unknown[][] = [];
        const totals: Record<string, number> = { 电量: 0, 付款金额: 0, 收款电费含税: 0, 电费不含税: 0, 收款租金含税: 0, 租金不含税: 0, 电费租金收款合计: 0, 利润: 0 };
        monthsInRange.forEach((m, i) => {
          const d = datas[i];
          if (!d) return;
          const kwh = (d.income?.elecIncome?.details ?? []).reduce((s: number, x: any) => s + (x.kwh || 0), 0);
          const elecGross = (d.income?.elecIncome?.details ?? []).reduce((s: number, x: any) => s + (x.kwh || 0) * (x.unitPrice || 0), 0);
          const rentGross = (d.income?.rentIncome?.details ?? []).reduce((s: number, x: any) => s + (x.preTaxRent || 0), 0);
          const payPrice = d.cost?.details?.electricity?.[0]?.unitPrice;
          const row: unknown[] = [
            toDisplay(m),
            r2x(kwh),
            r2x(payPrice),
            r2x(d.cost?.elecCost),
            r2x(elecGross),
            r2x(d.income?.elecIncome?.total),
            r2x(rentGross),
            r2x(d.income?.rentIncome?.total),
            r2x(d.income?.totalIncome),
            r2x(d.profit),
          ];
          personCols.forEach((name) => {
            const kind = personMap.get(name)!;
            const list = kind === "shareholderId" ? d.shareholderDividends ?? [] : d.bizDividends ?? [];
            const amt = list.filter((x: any) => (kind === "shareholderId" ? x.shareholderName : x.introducerName) === name)
              .reduce((s: number, x: any) => s + (x.amount || 0), 0);
            row.push(r2x(amt));
            totals[name] = (totals[name] || 0) + (amt || 0);
          });
          row.push("");
          rows.push(row);
          totals.电量 += kwh; totals.付款金额 += (d.cost?.elecCost || 0);
          totals.收款电费含税 += elecGross; totals.电费不含税 += (d.income?.elecIncome?.total || 0);
          totals.收款租金含税 += rentGross; totals.租金不含税 += (d.income?.rentIncome?.total || 0);
          totals.电费租金收款合计 += (d.income?.totalIncome || 0); totals.利润 += (d.profit || 0);
        });
        // 合计行
        const sumRow: unknown[] = ["合计", r2x(totals.电量), "", r2x(totals.付款金额), r2x(totals.收款电费含税), r2x(totals.电费不含税), r2x(totals.收款租金含税), r2x(totals.租金不含税), r2x(totals.电费租金收款合计), r2x(totals.利润)];
        personCols.forEach((name) => sumRow.push(r2x(totals[name])));
        sumRow.push("");
        rows.push(sumRow);
        // 无数据检测：除首列（月份/合计）外所有数值全为 0/空 → 该场地该区间无台账数据
        const hasData = rows.some((r) => r.slice(1, 10).some((v) => typeof v === "number" && v !== 0));
        if (!hasData) {
          toast.dismiss(tid);
          toast.warning(`${r.landlord.name}：所选月份区间（${periodLabel}）无台账数据，导出已跳过该场地`);
          continue;
        }
        sheets.push({ name: r.landlord.name, title: `${periodLabel} ${r.landlord.name} 分红明细表`, headers, rows });
      }
      if (sheets.length === 0) {
        toast.dismiss(tid);
        toast.error("所选月份区间无任何台账数据，请调整月份后重试");
        return;
      }
      exportXlsxWithTitles(`分红明细_${periodLabel.replace(/[~年]/g, "")}`, sheets);
      toast.dismiss(tid);
      toast.success("已导出 Excel");
    } catch (e: any) {
      toast.dismiss(tid);
      toast.error(`导出失败：${e?.response?.data?.detail || e?.message || "未知错误"}`);
    }
  };
  // 按股东导出：该股东涉及场地为列，指标为行（参考"刘洋分红表"格式）
  const doExportByShareholder = async () => {
    const lids = shareholderLandlordIds;
    if (!selectedShareholder || lids.length === 0) { toast.error("该股东暂无分红配置"); return; }
    const tid = toast.loading("正在生成导出数据…");
    try {
      const aggRows: { name: string; agg: any }[] = [];
      const totals = { kwh: 0, pay: 0, collectNet: 0, profit: 0, biz: 0, mine: 0 };
      for (const lid of lids) {
        const agg = { kwh: 0, pay: 0, collectNet: 0, profit: 0, biz: 0, mine: 0 };
        for (const m of monthsInRange) {
          const d = await calculateDividend({ landlordId: lid, period: m, estimate: true });
          agg.kwh += (d.income?.elecIncome?.details ?? []).reduce((s: number, x: any) => s + (x.kwh || 0), 0);
          agg.pay += d.cost?.elecCost || 0;
          agg.collectNet += d.income?.totalIncome || 0;
          agg.profit += d.profit || 0;
          agg.biz += (d.bizDividends ?? []).reduce((s: number, x: any) => s + (x.amount || 0), 0);
          agg.mine += (d.shareholderDividends ?? []).filter((x: any) => x.shareholderId === selectedShareholder.id)
            .reduce((s: number, x: any) => s + (x.amount || 0), 0);
        }
        aggRows.push({ name: landlords.find((x: any) => x.landlord.id === lid)?.landlord?.name || `场地#${lid}`, agg });
        for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += agg[k];
      }
      const headers = ["指标", ...aggRows.map((x) => x.name), "合计"];
      const mkRow = (label: string, pick: (a: any) => number) => [
        label, ...aggRows.map((x) => r2x(pick(x.agg))), r2x(pick(totals)),
      ];
      const rows: unknown[][] = [
        mkRow("用电度数", (a) => a.kwh),
        mkRow("付款金额（电费成本）", (a) => a.pay),
        mkRow("收款金额（不含税）", (a) => a.collectNet),
        mkRow("利润", (a) => a.profit),
        mkRow("商务分红（介绍人）", (a) => a.biz),
        mkRow(`${selectedShareholder.name} 应分红金额`, (a) => a.mine),
      ];
      const hasData = aggRows.some((x) => Object.values(x.agg).some((v) => Number(v) !== 0));
      if (!hasData) {
        toast.dismiss(tid);
        toast.warning(`所选月份区间（${periodLabel}）无台账数据，请调整月份后重试`);
        return;
      }
      exportXlsxWithTitle(`分红表_${selectedShareholder.name}_${periodLabel.replace(/[~年]/g, "")}`, {
        sheetName: "分红明细",
        title: `${periodLabel} ${selectedShareholder.name} 分红表（按股东）`,
        headers,
        rows,
      });
      toast.dismiss(tid);
      toast.success("已导出 Excel");
    } catch (e: any) {
      toast.dismiss(tid);
      toast.error(`导出失败：${e?.response?.data?.detail || e?.message || "未知错误"}`);
    }
  };

  // 渲染：受益人预估行
  const openBeneficiaryDetail = (d: any, kind: "股东" | "介绍人") => {
    setDetail({
      open: true,
      personKey: kind === "股东" ? "shareholderId" : "introducerId",
      personId: kind === "股东" ? (d.shareholderId ?? null) : (d.introducerId ?? null),
      personName: d.shareholderName || d.introducerName || "",
      landlordName: selectedLandlord?.landlord?.name || "",
      months: monthsInRange,
      monthDatas: previewQueries.map((q) => q.data),
    });
  };
  const renderBeneficiary = (d: any, kind: "股东" | "介绍人") => {
    const isSettlement = d.isSettlementMonth;
    return (
      <div key={`${kind}-${d.shareholderId ?? d.introducerId}-${d.brandId ?? "all"}`}
        className="flex items-center justify-between border-b last:border-0 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-700">{d.shareholderName || d.introducerName}</span>
          {d.brandName && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{d.brandName}</span>}
          {!d.brandName && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">全场</span>}
          <span className="text-slate-400">{d.mode === "固定金额" ? `固定 ${fmtMoney(d.fixedAmount)}/月` : `${d.mode} ${(d.ratio * 100).toFixed(1)}%`}</span>
          <span className="text-slate-400">{d.settlementPeriod}分红</span>
          {d.countAsCost && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">计入成本</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-slate-500">{isRange ? "区间预估" : "本月预估"} <b className="tabular-nums text-slate-700">{fmtMoney(d.amount)}</b></span>
          {isSettlement ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700">{isRange ? "含结算月" : "结算月"}</span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700">{isRange ? "未到结算月" : "累计中"}</span>
          )}
          <button onClick={() => openBeneficiaryDetail(d, kind)} className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] text-blue-700 hover:bg-blue-100">核算明细</button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-[calc(100vh-120px)] gap-0">
      {/* ─── 左侧面板 ─── */}
      <div className="w-64 shrink-0 flex flex-col border-r bg-white rounded-l-xl overflow-visible relative z-20">
        <div className="border-b p-3 space-y-2">
          <div className="flex items-center justify-between">
            <select
              className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1 focus:outline-none"
              value={viewMode}
              onChange={(e) => { setViewMode(e.target.value as any); setSelectedLandlordId(null); setSelectedShareholderId(null); }}
            >
              <option value="landlord">按场地方</option>
              <option value="shareholder">按股东</option>
            </select>
            {viewMode === "shareholder" && (
              <button onClick={() => setAddShareholderOpen(true)} className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700">
                <UserPlus className="h-3 w-3" />新增
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="w-11 shrink-0 text-[10px] text-slate-400">起始月</span>
              <MonthPicker value={periodStart} onChange={setPeriodStart} className="flex-1" align="right" />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-11 shrink-0 text-[10px] text-slate-400">结束月</span>
              <MonthPicker value={periodEnd} onChange={setPeriodEnd} className="flex-1" align="right" />
            </div>
            <div className="flex gap-1 pt-1">
              <button onClick={() => quickRange(1)} className="rounded-md border border-slate-200 px-2 py-1 text-[10px] text-slate-500 hover:border-emerald-400 hover:text-emerald-600">本月</button>
              <button onClick={() => quickRange(3)} className="rounded-md border border-slate-200 px-2 py-1 text-[10px] text-slate-500 hover:border-emerald-400 hover:text-emerald-600">近3月</button>
              <button onClick={() => quickRange(6)} className="rounded-md border border-slate-200 px-2 py-1 text-[10px] text-slate-500 hover:border-emerald-400 hover:text-emerald-600">近6月</button>
              {isRange && <span className="ml-auto self-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-600">区间 {monthsInRange.length} 个月</span>}
            </div>
          </div>
        </div>

        {/* 场地方视图：搜索框（按场地名称/公司主体模糊匹配） */}
        {viewMode === "landlord" && (
          <div className="border-b border-slate-100 px-3 pb-2">
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
              <input
                className={inputCls + " w-full pl-7 text-xs"}
                placeholder="搜索场地方 / 公司主体…"
                value={landlordKeyword}
                onChange={(e) => setLandlordKeyword(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {viewMode === "landlord" ? (
            filteredLandlordGroups.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">
                {landlords.data?.length ? "没有匹配的场地方 / 公司主体" : "暂无场地"}
              </div>
            ) : (
              filteredLandlordGroups.map((grp: any) => {
                const isOpen = openEntityGroups.has(grp.entityName);
                const profitSum = grp.rows.reduce((s: number, r: any) => s + (Number(r.totalProfit) || 0), 0);
                return (
                  <div key={grp.entityName} className={grp.color.bg}>
                    <button
                      type="button"
                      onClick={() => toggleEntityGroup(grp.entityName)}
                      className="sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-white/95 px-3 py-2 text-left text-xs font-semibold text-slate-600 backdrop-blur hover:bg-slate-50"
                    >
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
                      <Landmark className={`h-3.5 w-3.5 ${grp.color.icon} rounded p-0.5 text-white`} />
                      <span>公司主体：{grp.entityName}</span>
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">{grp.rows.length} 个场地方</span>
                      <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-normal tabular-nums ${profitSum >= 0 ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}>
                        {isRange ? "区间利润" : "总利润"} {fmtMoney(profitSum)}
                      </span>
                    </button>
                    {isOpen && grp.rows.map((r: any) => (
                      <button
                        key={r.landlord.id}
                        onClick={() => setSelectedLandlordId(r.landlord.id)}
                        className={`flex w-full items-center gap-2 border-b px-3 py-2.5 pl-6 text-left text-xs transition-colors ${selectedLandlordId === r.landlord.id ? "bg-emerald-50 border-l-2 border-l-emerald-500" : "hover:bg-slate-50"}`}
                      >
                        <MapPin className="h-4 w-4 shrink-0 text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-slate-800 truncate">{r.landlord.name}</div>
                          <div className="text-[11px] text-slate-400">
                            {isRange ? "末月利润" : "总利润"} <span className={r.totalProfit >= 0 ? "text-emerald-600" : "text-rose-600"}>{fmtMoney(r.totalProfit)}</span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                );
              })
            )
          ) : (
            (shareholders.data ?? []).length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">暂无股东</div>
            ) : (
              (shareholders.data ?? []).map((sh: any) => {
                const sum = (shSummary.data ?? []).find((s: any) => s.shareholderId === sh.id);
                return (
                  <button
                    key={sh.id}
                    onClick={() => setSelectedShareholderId(sh.id)}
                    className={`flex w-full items-center gap-2 border-b px-3 py-2.5 text-left text-xs transition-colors ${selectedShareholderId === sh.id ? "bg-emerald-50 border-l-2 border-l-emerald-500" : "hover:bg-slate-50"}`}
                  >
                    <Users className="h-4 w-4 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-800 truncate">{sh.name}</div>
                      <div className="text-[11px] text-slate-400">
                        {sum ? `${isRange ? "区间分红" : "本月分红"} ${fmtMoney(sum.totalAmount)}` : "暂无分红"}
                      </div>
                    </div>
                  </button>
                );
              })
            )
          )}
        </div>
      </div>

      {/* ─── 右侧详情 ─── */}
      <div className="flex-1 overflow-y-auto rounded-r-xl bg-slate-50 p-4">
        {viewMode === "landlord" ? (
          !selectedLandlord ? (
            <div className="flex h-full flex-col items-center justify-center text-slate-400">
              <MapPin className="h-10 w-10 mb-2 text-slate-300" />
              <div className="text-sm">请从左侧选择场地方</div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 场地方信息 + 经营汇总 */}
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
                  <div className="ml-auto text-xs text-slate-400">{periodLabel} 经营</div>
                </div>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <div className="rounded-lg border bg-slate-50 px-3 py-2">
                    <div className="text-[10px] text-slate-400">电费利润</div>
                    <div className={`text-sm font-semibold tabular-nums ${selectedLandlord.elecProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(selectedLandlord.elecProfit)}</div>
                  </div>
                  <div className="rounded-lg border bg-slate-50 px-3 py-2">
                    <div className="text-[10px] text-slate-400">场地利润</div>
                    <div className={`text-sm font-semibold tabular-nums ${selectedLandlord.rentProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(selectedLandlord.rentProfit)}</div>
                  </div>
                  <div className="rounded-lg border bg-slate-50 px-3 py-2">
                    <div className="text-[10px] text-slate-400">运营费用</div>
                    <div className="text-sm font-semibold tabular-nums text-amber-600">{fmtMoney(selectedLandlord.opExpense)}</div>
                  </div>
                  <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-2">
                    <div className="text-[10px] text-emerald-600 font-medium">总利润（分红基数）</div>
                    <div className={`text-sm font-bold tabular-nums ${selectedLandlord.totalProfit >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{fmtMoney(selectedLandlord.totalProfit)}</div>
                  </div>
                </div>
              </div>

              {/* 运营费用（当前选中月，可按主体录入） */}
              <div className="rounded-xl border bg-white p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                    <Wallet className="h-3.5 w-3.5 text-amber-600" />
                    运营费用（{toDisplay(periodEnd)}）
                  </div>
                  {expenseRows.length > 0 && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                      该月已录 {expenseRows.length} 笔，合计 ¥{fmtMoney(expenseTotal)}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <div className="w-44" title="该笔费用归属：整场地公共（按柜数分摊到主体）或某主体专属">
                    <SearchSelect
                      value={expenseEntityId}
                      onChange={setExpenseEntityId}
                      placeholder="整场地公共（分摊）"
                      options={(entitiesQ.data ?? []).map((en: any) => ({ value: String(en.id), label: `${en.name}（专属）` }))}
                    />
                  </div>
                  <input
                    className={`${inputCls} w-36`}
                    type="number"
                    min="0"
                    step="0.01"
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    placeholder="运营费用（元）"
                  />
                  <input
                    className={`${inputCls} w-44`}
                    value={expenseRemark}
                    onChange={(e) => setExpenseRemark(e.target.value)}
                    placeholder="备注（可选）"
                  />
                  <button
                    onClick={() => saveExpenseMutation.mutate()}
                    disabled={saveExpenseMutation.isPending}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
                  >保存</button>
                  {selectedExpenseRow && (
                    <button
                      onClick={() => deleteExpenseMutation.mutate(selectedExpenseRow.id)}
                      disabled={deleteExpenseMutation.isPending}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:border-rose-300 hover:text-rose-600"
                    >删除{expenseEntityId ? "该主体费用" : "公共费用"}</button>
                  )}
                </div>
                {expenseRows.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {expenseRows.map((x: any) => (
                      <button key={x.id}
                        onClick={() => setExpenseEntityId(x.entityId ? String(x.entityId) : "")}
                        className={`rounded-full px-2 py-0.5 text-[10px] ${((x.entityId ?? null) === (expenseEntityId ? Number(expenseEntityId) : null)) ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                        {x.entityId ? `${x.entityName ?? "主体"}：¥${fmtMoney(x.amount)}` : `公共：¥${fmtMoney(x.amount)}`}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[10px] text-slate-400">
                  运营费用计入该月总成本（分红基数 = 总收入 − 总成本）；「整场地公共」在主体损益中按柜数分摊，「主体专属」全额归该主体。保存后分红预估、核算明细自动更新。
                </div>
              </div>

              {/* 分红预估 */}
              <div className="rounded-xl border bg-white overflow-hidden">
                <div className="flex items-center justify-between border-b bg-slate-50 px-4 py-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                    <Wallet className="h-3.5 w-3.5 text-emerald-600" />
                    分红预估（{periodLabel}）
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => doExportByLandlord()} className="rounded-md bg-blue-600 px-2 py-1 text-[11px] text-white hover:bg-blue-700">
                      导出 Excel
                    </button>
                    <button onClick={() => setConfigOpen({ open: true, type: "shareholder" })} className="rounded-md bg-blue-50 border border-blue-200 px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-100">
                      + 股东分红
                    </button>
                    <button onClick={() => setConfigOpen({ open: true, type: "introducer" })} className="rounded-md bg-purple-50 border border-purple-200 px-2 py-1 text-[11px] text-purple-700 hover:bg-purple-100">
                      + 商务分红
                    </button>
                    <button onClick={() => setAddDividendOpen(true)} className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700">
                      生成分红记录
                    </button>
                    <button
                      onClick={() => { if (!landlordId) { toast.error("请先选择场地方"); return; } refreshMutation.mutate(); }}
                      disabled={refreshMutation.isPending}
                      className="rounded-md bg-amber-50 border border-amber-200 px-2 py-1 text-[11px] text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                      title="按最新的合同、电表、台账数据重算本场地的分红记录（所有状态）"
                    >
                      {refreshMutation.isPending ? "重算中…" : "重算记录"}
                    </button>
                  </div>
                </div>
                <div className="p-3">
                  {previewQueries.some((q) => q.isLoading) ? (
                    <div className="py-6 text-center text-xs text-slate-400">计算中…</div>
                  ) : !preview ? (
                    <div className="py-6 text-center text-xs text-slate-400">该区间暂无分红数据</div>
                  ) : (
                    <div className="space-y-4">
                      {/* 收支汇总 */}
                      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                        <div className="rounded-lg bg-emerald-50 px-3 py-2">
                          <div className="text-[10px] text-emerald-600">总收入（不含税）</div>
                          <div className="text-sm font-semibold tabular-nums text-emerald-700">{fmtMoney(preview.income?.totalIncome)}</div>
                        </div>
                        <div className="rounded-lg bg-rose-50 px-3 py-2">
                          <div className="text-[10px] text-rose-600">总成本</div>
                          <div className="text-sm font-semibold tabular-nums text-rose-700">{fmtMoney(preview.cost?.totalCost)}</div>
                        </div>
                        <div className="rounded-lg bg-amber-50 px-3 py-2">
                          <div className="text-[10px] text-amber-600">税费</div>
                          <div className="text-sm font-semibold tabular-nums text-amber-700">{fmtMoney((preview.cost?.elecTax || 0) + (preview.cost?.rentTax || 0))}</div>
                        </div>
                        <div className="rounded-lg bg-blue-50 px-3 py-2">
                          <div className="text-[10px] text-blue-600">净利润</div>
                          <div className="text-sm font-semibold tabular-nums text-blue-700">{fmtMoney(preview.profit)}</div>
                        </div>
                        <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-2">
                          <div className="text-[10px] text-emerald-600">分红合计</div>
                          <div className="text-sm font-bold tabular-nums text-emerald-700">
                            {fmtMoney((preview.summary?.totalShareholderDividend || 0) + (preview.summary?.totalBusinessDividend || 0))}
                          </div>
                        </div>
                      </div>

                      {/* 股东分红明细 */}
                      <div className="rounded-lg border">
                        <div className="border-b bg-blue-50/50 px-3 py-1.5 text-[11px] font-semibold text-blue-700">股东分红</div>
                        {(preview.shareholderDividends ?? []).length > 0 ? (
                          preview.shareholderDividends.map((d: any) => renderBeneficiary(d, "股东"))
                        ) : (
                          <div className="py-4 text-center text-xs text-slate-400">暂无股东分红配置</div>
                        )}
                      </div>

                      {/* 商务分红明细 */}
                      <div className="rounded-lg border">
                        <div className="border-b bg-purple-50/50 px-3 py-1.5 text-[11px] font-semibold text-purple-700">商务分红（介绍人）</div>
                        {(preview.bizDividends ?? []).length > 0 ? (
                          preview.bizDividends.map((d: any) => renderBeneficiary(d, "介绍人"))
                        ) : (
                          <div className="py-4 text-center text-xs text-slate-400">暂无商务分红配置</div>
                        )}
                      </div>

                      <div className="text-[10px] text-slate-400">
                        * 分红周期：月分红每月结算；季度分红在 3/6/9/12 月结算（非结算月金额累计）；半年分红在 6/12 月结算；年分红在 12 月结算。
                        {isRange
                          ? "区间预估 = 区间内各月预估之和（每月按 当月基数 × 比例 估算，不乘周期倍数）；到结算月生成记录时按周期倍数核算累计金额。"
                          : "本月预估 = 当月基数 × 比例（不乘周期倍数）；到结算月生成记录时按周期倍数核算累计金额。"}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* 分红配置（股东/介绍人） */}
              <div className="rounded-xl border bg-white overflow-hidden">
                <div className="flex items-center justify-between border-b bg-slate-50 px-4 py-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                    <Settings className="h-3.5 w-3.5 text-slate-500" />
                    分红配置
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setConfigOpen({ open: true, type: "shareholder" })} className="rounded-md bg-blue-50 border border-blue-200 px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-100">+ 股东分红</button>
                    <button onClick={() => setConfigOpen({ open: true, type: "introducer" })} className="rounded-md bg-purple-50 border border-purple-200 px-2 py-1 text-[11px] text-purple-700 hover:bg-purple-100">+ 商务分红</button>
                  </div>
                </div>
                <div className="divide-y">
                  {/* 股东配置 */}
                  <div>
                    <div className="px-4 pt-2 pb-1 text-[11px] font-semibold text-blue-700">股东分红配置</div>
                    {(shConfigs.data ?? []).length === 0 ? (
                      <div className="px-4 pb-3 text-[11px] text-slate-400">暂无股东分红配置，点击右上角「+ 股东分红」添加</div>
                    ) : (
                      <div className="space-y-1 px-3 pb-3">
                        {(shConfigs.data ?? []).map((c: any) => (
                          <div key={c.id} className="flex items-center justify-between rounded border bg-slate-50/60 px-3 py-1.5 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-slate-700">{c.shareholderName}</span>
                              {c.brandName ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{c.brandName}</span> : <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">全场</span>}
                              <span className="text-slate-600">{c.mode === "固定金额" ? `固定 ${fmtMoney(c.fixedAmount)}/月` : `${c.mode} ${((c.ratio || 0) * 100).toFixed(1)}%`}</span>
                              <span className="text-slate-400">{c.settlementPeriod}分红</span>
                              {c.startDate && <span className="text-[10px] text-slate-400">起 {String(c.startDate).slice(0, 10)}</span>}
                              {c.endDate && <span className="text-[10px] text-slate-400">止 {String(c.endDate).slice(0, 10)}</span>}
                            </div>
                            <div className="flex items-center gap-1">
                              <button onClick={() => setConfigOpen({ open: true, type: "shareholder", config: c })} className="text-slate-400 hover:text-blue-600" title="编辑">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button onClick={() => configMutations.mutate({ type: "shareholder", id: c.id })} className="text-slate-400 hover:text-rose-500">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 介绍人配置 */}
                  <div>
                    <div className="px-4 pt-2 pb-1 text-[11px] font-semibold text-purple-700">商务分红配置（介绍人）</div>
                    {(intConfigs.data ?? []).length === 0 ? (
                      <div className="px-4 pb-3 text-[11px] text-slate-400">暂无商务分红配置，点击右上角「+ 商务分红」添加</div>
                    ) : (
                      <div className="space-y-1 px-3 pb-3">
                        {(intConfigs.data ?? []).map((c: any) => (
                          <div key={c.id} className="flex items-center justify-between rounded border bg-slate-50/60 px-3 py-1.5 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-slate-700">{c.introducerName}</span>
                              {c.brandName ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{c.brandName}</span> : <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">全场</span>}
                              <span className="text-slate-600">{c.mode === "固定金额" ? `固定 ${fmtMoney(c.fixedAmount)}/月` : `${c.mode} ${((c.ratio || 0) * 100).toFixed(1)}%`}</span>
                              <span className="text-slate-400">{c.settlementPeriod}分红</span>
                              {c.countAsCost && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">计入成本</span>}
                            </div>
                            <div className="flex items-center gap-1">
                              <button onClick={() => setConfigOpen({ open: true, type: "introducer", config: c })} className="text-slate-400 hover:text-blue-600" title="编辑">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button onClick={() => configMutations.mutate({ type: "introducer", id: c.id })} className="text-slate-400 hover:text-rose-500">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 已生成分红记录 */}
              <div className="rounded-xl border bg-white overflow-hidden">
                <div className="border-b bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">分红记录（{periodLabel}）</div>
                {filteredDividends.length > 0 ? (
                  <div className="divide-y">
                    {filteredDividends.map((r: any) => (
                      <div key={r.id} className="flex items-center justify-between px-4 py-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.type === "股东分红" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>{r.type}</span>
                          <span className="font-medium text-slate-700">{r.period}</span>
                          {r.brandName && <span className="text-slate-400">{r.brandName}</span>}
                          <span className="text-slate-500">利润 {fmtMoney(r.profit)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums text-emerald-600">{fmtMoney(r.shares?.reduce((s: number, sh: any) => s + Number(sh.amount || 0), 0))}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.status === "已结算" ? "bg-emerald-100 text-emerald-700" : r.status === "已通过" ? "bg-blue-100 text-blue-700" : r.status === "申报中" ? "bg-amber-100 text-amber-700" : r.status === "已驳回" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{r.status}</span>
                          {r.status === "未结算" && (
                            <button
                              onClick={() => submitMutation.mutate(r.id)}
                              disabled={submitMutation.isPending}
                              className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                            >提交审核</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-6 text-center text-xs text-slate-400">该区间暂无分红记录</div>
                )}
              </div>
            </div>
          )
        ) : (
          // ─── 股东视图 ───
          !selectedShareholder ? (
            <div className="flex h-full flex-col items-center justify-center text-slate-400">
              <Users className="h-10 w-10 mb-2 text-slate-300" />
              <div className="text-sm">请从左侧选择股东</div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 股东信息卡 */}
              <div className="rounded-xl border bg-white p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                    <Users className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{selectedShareholder.name}</div>
                    {selectedShareholder.phone && <div className="text-xs text-slate-400">{selectedShareholder.phone}</div>}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <button onClick={() => doExportByShareholder()} className="rounded-md bg-blue-600 px-2 py-1 text-[11px] text-white hover:bg-blue-700">
                      导出 Excel
                    </button>
                    <span className="text-xs text-slate-400">{periodLabel} 分红</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2">
                    <div className="text-[10px] text-blue-600">本月分红</div>
                    <div className="text-sm font-semibold tabular-nums text-blue-700">
                      {fmtMoney((shSummary.data ?? []).find((s: any) => s.shareholderId === selectedShareholder.id)?.totalAmount || 0)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">
                    <div className="text-[10px] text-emerald-600">已结算</div>
                    <div className="text-sm font-semibold tabular-nums text-emerald-700">
                      {fmtMoney((shSummary.data ?? []).find((s: any) => s.shareholderId === selectedShareholder.id)?.settledAmount || 0)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-amber-50 border border-amber-100 px-3 py-2">
                    <div className="text-[10px] text-amber-600">待结算</div>
                    <div className="text-sm font-semibold tabular-nums text-amber-700">
                      {fmtMoney((shSummary.data ?? []).find((s: any) => s.shareholderId === selectedShareholder.id)?.pendingAmount || 0)}
                    </div>
                  </div>
                </div>
              </div>

              {/* 该股东在各场地的分红配置与预估 */}
              <div className="rounded-xl border bg-white overflow-hidden">
                <div className="border-b bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
                  该股东涉及场地（{shareholderLandlords.length} 个 · {periodLabel}）
                </div>
                {shareholderLandlords.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-400">
                    该股东暂无分红配置，请到「按场地方」视图配置
                  </div>
                ) : (
                  <div className="divide-y">
                    {shareholderLandlords.map((r: any) => {
                      const lid = r.landlord.id;
                      const configs = (allShConfigs.data ?? []).filter((c: any) => c.shareholderId === selectedShareholder.id && c.landlordId === lid);
                      return (
                        <div key={lid} className="px-4 py-3">
                          <div className="flex items-center gap-2 mb-2">
                            <MapPin className="h-3.5 w-3.5 text-emerald-600" />
                            <span className="text-xs font-semibold text-slate-700">{r.landlord.name}</span>
                            <span className="text-[11px] text-slate-400">总利润 {fmtMoney(r.totalProfit)}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] ${(shareholderEstimateByLandlord[lid] ?? 0) > 0 ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>
                              {isRange ? "区间预估" : "本月预估"} {fmtMoney(shareholderEstimateByLandlord[lid] ?? 0)}
                            </span>
                            <button
                              onClick={() => setDetail({
                                open: true,
                                personKey: "shareholderId",
                                personId: selectedShareholderId,
                                personName: selectedShareholder?.name || "",
                                landlordName: r.landlord.name,
                                months: monthsInRange,
                                monthDatas: monthsInRange.map((_m, mi) => shareholderEstimateQueries[shareholderLandlordIds.indexOf(lid) * monthsInRange.length + mi]?.data ?? null),
                              })}
                              className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] text-blue-700 hover:bg-blue-100"
                            >核算明细</button>
                          </div>
                          <div className="space-y-1">
                            {configs.map((c: any) => (
                              <div key={c.id} className="flex items-center justify-between rounded border bg-slate-50/50 px-3 py-1.5 text-xs">
                                <div className="flex items-center gap-2">
                                  {c.brandName ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{c.brandName}</span> : <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">全场</span>}
                                  <span className="text-slate-600">{c.mode === "固定金额" ? `固定 ${fmtMoney(c.fixedAmount)}/月` : `${c.mode} ${(c.ratio * 100).toFixed(1)}%`}</span>
                                  <span className="text-slate-400">{c.settlementPeriod}分红</span>
                                  {c.startDate && <span className="text-[10px] text-slate-400">起 {c.startDate.slice(0, 10)}</span>}
                                  {c.endDate && <span className="text-[10px] text-slate-400">止 {c.endDate.slice(0, 10)}</span>}
                                </div>
                                <div className="flex items-center gap-1">
                                  <button onClick={() => setConfigOpen({ open: true, type: "shareholder", config: c })} className="text-slate-400 hover:text-blue-600" title="编辑">
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button onClick={() => configMutations.mutate({ type: "shareholder", id: c.id })} className="text-slate-400 hover:text-rose-500">
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            ))}
                            {configs.length === 0 && <div className="text-[11px] text-slate-400">该场地暂无配置</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* ─── 弹窗 ─── */}
      <AddShareholderDialog open={addShareholderOpen} onClose={() => setAddShareholderOpen(false)} />
      <ConfigDividendDialog open={configOpen.open} onClose={() => setConfigOpen({ ...configOpen, open: false, config: null })} type={configOpen.type} editingConfig={configOpen.config} landlordId={configOpen.config?.landlordId ?? landlordId ?? undefined} brands={configOpen.config?.landlordId ? brandsOfLandlord(configOpen.config.landlordId) : landlordBrands} entities={entitiesQ.data ?? []} />
      <AddDividendDialog open={addDividendOpen} onClose={() => setAddDividendOpen(false)} landlordId={landlordId ?? undefined} defaultPeriod={periodEnd} estimatePreview={endMonthPreview} />
      {detail && <DividendDetailDialog open={detail.open} onClose={() => setDetail(null)} landlordName={detail.landlordName} personName={detail.personName} months={detail.months} monthDatas={detail.monthDatas} personKey={detail.personKey} personId={detail.personId} />}
    </div>
  );
}
