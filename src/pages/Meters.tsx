import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listMeters, createMeter, updateMeter, deleteMeter, importMetersExcel } from "@/api/meters";
import { listContracts } from "@/api/contracts";
import { listCabinets, createCabinet, updateCabinet, deleteCabinet } from "@/api/cabinets";
import { listBrands, listLandlords, listEntities } from "@/api/directory";
import { generateElectricity } from "@/api/electricity";
import { triggerSync, saveMeterReading, getMeterReadings, getMonthlyKwh, getSharedAllocationForm, saveSharedAllocations, getSharedCabinetUsage, type SharedCabinetUsageItem } from "@/api/meterEnergy";
import "@/components/excel-table.css";   // ★ Excel 风表格样式（仅本页/场租台账/电费台账使用）
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Field, NumInput, TextInput, SelectInput, SearchSelect, inputCls } from "@/components/fields";
import { exportXlsx } from "@/lib/export";
import { fmtNum, fmtMoney } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { Download, Search, Plus, Pencil, Trash2, ChevronDown, ChevronRight, RefreshCw, BookOpen, Upload } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/providers/auth";

// ─── ★V5：电表大类 与「是否所有品牌共用一个表」彻底解耦 ───
//   categoryCode = 电表大类（= 分给哪个财务管的标签，**不参与任何算法**）
//   isShared     = 表级属性：这块表是不是"所有品牌共用一个表"（**人工勾选，与大类无关**）
const CATEGORY_OPTIONS = [
  { value: "partner", label: "合作商电表" },
  { value: "civil", label: "民用电表" },
  { value: "shared", label: "共享电表" },
];
const CATEGORY_LABEL: Record<string, string> = {
  partner: "合作商电表", civil: "民用电表", shared: "共享电表",
};
const CATEGORY_BADGE: Record<string, string> = {
  partner: "bg-blue-100 text-blue-700",
  civil: "bg-amber-100 text-amber-700",
  shared: "bg-purple-100 text-purple-700",
};
// 兼容：老数据/老入参仍可能是中文 tag
const TAG_TO_CODE: Record<string, string> = {
  "合作商电表": "partner", "民用电表": "civil", "共享电表": "shared",
};
const codeOf = (m: any): string => m?.categoryCode || TAG_TO_CODE[m?.tag] || "partner";
const categoryLabelOf = (m: any): string => CATEGORY_LABEL[codeOf(m)] || "合作商电表";
/** 是不是「所有品牌共用一个电表」——只读表级 isShared，**绝不看大类** */
const isSharedOf = (m: any): boolean => !!m?.isShared;

/** 是否共享电表大类（= 是不是「电表大类」里的共享电表） */
const isSharedMeterRow = (m: any) => !!m?.isShared;

// ─── 倒计时格式化 ───
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ─── 刷新限制逻辑 ───
const SYNC_LIMIT_KEY = "meter_sync_limit";
const SYNC_MAX = 10;
const SYNC_RESET_HOURS = 24;

function getSyncState(): { count: number; resetAt: number } {
  try {
    const raw = localStorage.getItem(SYNC_LIMIT_KEY);
    if (!raw) return { count: 0, resetAt: 0 };
    const state = JSON.parse(raw);
    // 超过24小时重置
    if (Date.now() > state.resetAt) return { count: 0, resetAt: 0 };
    return state;
  } catch { return { count: 0, resetAt: 0 }; }
}

function useSyncLimit() {
  const [state, setState] = useState(getSyncState);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<any>(null);

  const remaining = Math.max(0, SYNC_MAX - state.count);
  const isLimit = remaining <= 0;

  // 重置倒计时
  useEffect(() => {
    if (isLimit && state.resetAt > Date.now()) {
      const tick = () => {
        const left = Math.max(0, Math.floor((state.resetAt - Date.now()) / 1000));
        setCountdown(left);
        if (left <= 0) setState({ count: 0, resetAt: 0 });
      };
      tick();
      timerRef.current = setInterval(tick, 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [isLimit, state.resetAt]);

  const consume = useCallback(() => {
    const cur = getSyncState();
    const next = {
      count: cur.count + 1,
      resetAt: cur.resetAt > Date.now() ? cur.resetAt : Date.now() + SYNC_RESET_HOURS * 3600 * 1000,
    };
    localStorage.setItem(SYNC_LIMIT_KEY, JSON.stringify(next));
    setState(next);
    return next.count;
  }, []);

  const resetTime = useMemo(() => {
    if (!isLimit) return "";
    const d = new Date(state.resetAt);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }, [isLimit, state.resetAt]);

  return { remaining, isLimit, countdown, resetTime, consume };
}

export default function Meters() {
  const { user } = useAuth();
  const tagScope = user?.meterTagScope || "";
  const [keyword, setKeyword] = useState("");
  const [landlordId, setLandlordId] = useState("");
  const [brandId, setBrandId] = useState("");
  // ★ 大类筛选：值改用**码值**（partner/civil/shared），与后端 category_code 对齐
  const [catFilter, setCatFilter] = useState(() => (tagScope ? (TAG_TO_CODE[tagScope] || tagScope) : ""));
  // ★ 表类型（"所有品牌共用" 是【表级属性】，不再混进品牌维度）
  const [meterKind, setMeterKind] = useState<"" | "shared" | "normal">("");
  // ★ 月份（V5 §10：筛选含月份；用于显示该月「平台值 / 实际值」）
  // ★ 月份区间（V5 §10：筛选含月份）
  //   · 默认「本月」= 单月，行为与之前完全一致
  //   · 选多个月时：展开行就显示这几个月的读数；主表「平台/实际电量」为区间合计
  //   · period = 区间末月（单月时就是所选月）：用于行内改实际电量、共用表品牌分摊的默认月份
  const currentMonth = () => new Date().toISOString().slice(0, 7);
  const [periodFrom, setPeriodFrom] = useState(currentMonth);
  const [periodTo, setPeriodTo] = useState(currentMonth);
  const period = periodTo;

  // 月份位移 / 区间快捷（本月 / 近 3 月 / 近 6 月 / 近 12 月 / 本年）
  const shiftMonth = (ym: string, delta: number) => {
    const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const applyPreset = (months: number | "year") => {
    const to = currentMonth();
    if (months === "year") { setPeriodFrom(`${to.slice(0, 4)}-01`); setPeriodTo(to); return; }
    setPeriodFrom(shiftMonth(to, -(months - 1)));
    setPeriodTo(to);
  };
  // ★ 只看本月无读数的表（漏录告警的落地）
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<any>(null);
  const [expandedMeterId, setExpandedMeterId] = useState<number | null>(null);
  // ★从合同页「计费柜数 · 去修改」跳来（?highlight=cabinet）：等列表出来自动展开目标表并滚到「品牌分摊」
  const [highlightCabinet, setHighlightCabinet] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const syncLimit = useSyncLimit();
  const lastClickRef = useRef(0);
  const cooldownRef = useRef(false);

  // 从 URL 参数读取跳转信息
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const landlord = params.get("landlord");
    const brand = params.get("brand");
    const meter = params.get("meter");
    const highlight = params.get("highlight");
    if (landlord) setLandlordId(landlord);
    // 兼容旧链接 ?brand=shared（以前把「全品牌共用」混在品牌下拉里）
    if (brand === "shared") setMeterKind("shared");
    else if (brand) setBrandId(brand);
    if (meter) setKeyword(meter); // 直达某块电表：预填搜索框
    if (highlight === "cabinet") setHighlightCabinet(true);
    // 清除 URL 参数
    if (landlord || brand || meter || highlight) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const queryClient = useQueryClient();
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters() });
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords });
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands });
  const contractsQ = useQuery({ queryKey: ["contracts"], queryFn: () => listContracts() });
  const entitiesQ = useQuery({ queryKey: ["entities"], queryFn: listEntities });

  // §5 一致性提示（只提示不拦截）：电表运营主体 ≠ 其品牌方合同收付款主体（合法场景：代收代付）
  const entityMismatchHint = useMemo(() => {
    const entName = new Map<number, string>((entitiesQ.data ?? []).map((e: any) => [e.id, e.shortName || e.name]));
    const brandContracts = (contractsQ.data ?? []).filter((c: any) => c.contractType === "品牌方合同" && c.entityId != null);
    const map: Record<number, string> = {};
    for (const m of meters.data ?? []) {
      if (!m.landlordId || !m.brandId || m.entityId == null) continue;
      const c = brandContracts
        .filter((x: any) => x.landlordId === m.landlordId && x.brandId === m.brandId)
        .sort((a: any, b: any) => String(b.startDate ?? "").localeCompare(String(a.startDate ?? "")))[0];
      if (c && c.entityId !== m.entityId) {
        map[m.id] = `收款主体「${entName.get(c.entityId) ?? c.entityId}」与电表运营主体「${entName.get(m.entityId) ?? m.entityId}」不一致，请核对`;
      }
    }
    return map;
  }, [meters.data, contractsQ.data, entitiesQ.data]);

  // ── ★ 区间读数（V5 §10：筛选含月份 + 「平台值 / 实际值」两列并排）──
  // /meter-energy/monthly 不传 meterNo 即返回区间内【全部电表】读数（受账号大类范围约束），
  // 一次请求就能把列表页需要的「平台值 / 实际值 / 来源」全部拿到。
  const periodCompact = period ? period.replace("-", "") : "";
  const fromCompact = periodFrom ? periodFrom.replace("-", "") : "";
  const toCompact = periodTo ? periodTo.replace("-", "") : "";
  const isSingleMonth = !!fromCompact && fromCompact === toCompact;
  // 区间展示名：单月 → 2026-09；多月 → 2026-04 ~ 2026-09
  const rangeLabel = !fromCompact
    ? "—"
    : isSingleMonth
      ? toDisplay(fromCompact)
      : `${toDisplay(fromCompact)} ~ ${toDisplay(toCompact)}`;
  const monthReadings = useQuery({
    queryKey: ["meterReadings", "month", fromCompact, toCompact],
    queryFn: () => getMonthlyKwh({ startMonth: fromCompact, endMonth: toCompact }),
    enabled: !!fromCompact && !!toCompact,
  });
  const readingsByNo = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const r of (monthReadings.data ?? []) as any[]) {
      if (!r?.address) continue;
      const k = String(r.address);
      const arr = map.get(k);
      if (arr) arr.push(r); else map.set(k, [r]);
    }
    return map;
  }, [monthReadings.data]);

  // 每块表在【所选区间】内的读数：
  //   平台值 = Σ(原始表码 × 互感器倍数)（接口返回的 raw_kwh 是第三方原始表码）
  //   实际值 = Σ人工补录值（actual_kwh，不随第三方同步覆盖）
  //   来源   = 人工修正 / 第三方 / 无读数（区间内任一月有人工值即视为「人工修正」）
  // 单月时区间合计 = 该月数值，与改造前完全一致。
  const readingInfoOf = useCallback((meter: any) => {
    const rows = readingsByNo.get(String(meter.meterNo)) ?? [];
    const empty = {
      has: false, platform: null as number | null, actual: null as number | null,
      raw: null as number | null, months: 0, manualMonths: 0, source: "none" as const,
    };
    if (rows.length === 0) return empty;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    let platform: number | null = null, actual: number | null = null, raw: number | null = null;
    let manualMonths = 0, months = 0;
    for (const r of rows) {
      const ratio = Number(r.transformer_ratio_snapshot ?? r.transformer_ratio ?? meter.transformerRatio ?? 1) || 1;
      if (r.raw_kwh != null) { const v = Number(r.raw_kwh); raw = round2((raw ?? 0) + v); platform = round2((platform ?? 0) + v * ratio); }
      if (r.actual_kwh != null) { actual = round2((actual ?? 0) + Number(r.actual_kwh)); manualMonths++; }
      if (r.raw_kwh != null || r.actual_kwh != null) months++;
    }
    return {
      has: platform != null || actual != null,
      platform, actual, raw, months, manualMonths,
      source: (manualMonths > 0 ? "manual" : platform != null ? "platform" : "none") as "manual" | "platform" | "none",
    };
  }, [readingsByNo]);

  // ★ 柜数：普通表 = 该表下 cabinets 记录数；共用表 = 分摊行人工录入的品牌柜数合计
  //   （原先主表读了一个不存在的字段，导致「柜数」列一直显示 —，这里补上）
  const allCabinets = useQuery({ queryKey: ["cabinets"], queryFn: () => listCabinets() });
  const sharedCabUsage = useQuery({
    queryKey: ["sharedCabinetUsage", "all"],
    queryFn: () => getSharedCabinetUsage(),
    staleTime: 60_000,
  });
  const cabinetCountOf = useCallback((m: any): number | null => {
    if (isSharedMeterRow(m)) {
      const it = (sharedCabUsage.data?.meters ?? []).find((s: SharedCabinetUsageItem) => s.meterId === m.id);
      if (!it) return null;
      if (it.managedByAlloc) {
        return Object.values(it.brandCabs ?? {}).reduce((s: number, v: number) => s + Number(v || 0), 0);
      }
      return Number(it.fallbackCabs || 0) || null;
    }
    if (!allCabinets.data) return null;
    return (allCabinets.data as any[]).filter((c: any) => c.meterId === m.id).length;
  }, [allCabinets.data, sharedCabUsage.data]);

  const del = useMutation({
    mutationFn: deleteMeter,
    onSuccess: () => { toast.success("已删除"); queryClient.invalidateQueries({ queryKey: ["meters"] }); },
  });

  // ★ 柜子搜索索引：把每块表挂的柜子（编号 / 类型 / 备注）拼成一段文本 —— 关键词能搜到电柜
  const cabinetTextByMeter = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of (allCabinets.data ?? []) as any[]) {
      if (c?.meterId == null) continue;
      const t = `${c.cabinetNo ?? ""} ${c.cabinetType ?? ""} ${c.remark ?? ""}`.trim();
      map.set(c.meterId, `${map.get(c.meterId) ?? ""} ${t}`.trim());
    }
    return map;
  }, [allCabinets.data]);

  // 过滤链：先出「基础结果」，再据此算本月读数覆盖度（漏录），最后才按「只看未录」收窄
  const baseRows = useMemo(() => {
    let data = meters.data ?? [];
    if (keyword) {
      // 关键词：电表编号 / 名称 / 场地方 / 柜子（编号·类型·备注），大小写不敏感
      const k = keyword.trim().toLowerCase();
      if (k) data = data.filter((m: any) =>
        `${m.meterNo ?? ""} ${m.stationName ?? ""} ${m.meterName ?? ""} ${m.landlordName ?? ""} ${cabinetTextByMeter.get(m.id) ?? ""}`
          .toLowerCase().includes(k)
      );
    }
    if (landlordId) data = data.filter((m: any) => m.landlordId === Number(landlordId));
    if (brandId) data = data.filter((m: any) => m.brandId === Number(brandId));
    if (catFilter) data = data.filter((m: any) => codeOf(m) === catFilter);
    if (meterKind === "shared") data = data.filter(isSharedMeterRow);
    if (meterKind === "normal") data = data.filter((m: any) => !isSharedMeterRow(m));
    return data;
  }, [meters.data, keyword, landlordId, brandId, catFilter, meterKind, cabinetTextByMeter]);

  // 本月无读数的表（V5 §3.5：某表某月无读数 ⇒ 跳过 + 告警）
  const missingRows = useMemo(
    () => baseRows.filter((m: any) => !readingInfoOf(m).has),
    [baseRows, readingInfoOf],
  );
  const rows = onlyMissing ? missingRows : baseRows;

  // ★合同页「计费柜数 · 去修改」跳来：列表出来后自动展开目标表（优先共用表，柜数在它的「品牌分摊」里），
  //   并滚到品牌分摊区块 —— 否则用户落在列表页还得自己找那块表
  useEffect(() => {
    if (!highlightCabinet || meters.isLoading || rows.length === 0) return;
    const target = rows.find((m: any) => isSharedMeterRow(m)) ?? rows[0];
    setExpandedMeterId(target.id);
    setHighlightCabinet(false);
    const timer = window.setTimeout(() => {
      document.getElementById("shared-alloc-section")?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [highlightCabinet, meters.isLoading, rows]);

  const openSyncConfirm = () => {
    // 节流：同步中、冷却中、达到上限都阻止
    if (syncing || syncLimit.isLimit || cooldownRef.current) return;

    // 防抖：2秒内重复点击忽略
    const now = Date.now();
    if (now - lastClickRef.current < 2000) {
      toast.warning("请勿频繁点击");
      return;
    }
    lastClickRef.current = now;

    setSyncConfirmOpen(true);
  };

  const doSync = async () => {
    setSyncConfirmOpen(false);

    // 冷却：同步完成后5秒内不能再次点击
    cooldownRef.current = true;
    setSyncing(true);
    syncLimit.consume();

    const steps = [
      { key: "devices", label: "设备列表" },
      { key: "collectors", label: "采集器" },
      { key: "status", label: "实时状态" },
      { key: "hourly", label: "小时用电量" },
      { key: "daily", label: "日用电量" },
      { key: "monthly", label: "月用电量" },
      { key: "warnings", label: "报警信息" },
    ];

    let ok = 0;
    let fail = 0;
    for (const step of steps) {
      setSyncProgress(`${step.label} (${ok + fail + 1}/${steps.length})`);
      try {
        await triggerSync(step.key);
        ok++;
      } catch {
        fail++;
      }
    }

    setSyncing(false);
    setSyncProgress("");
    queryClient.invalidateQueries({ queryKey: ["meters"] });
    toast.success(`同步完成：${ok} 成功${fail > 0 ? `，${fail} 失败` : ""}`);

    // 冷却5秒后才能再次点击
    setTimeout(() => { cooldownRef.current = false; }, 5000);
  };

  const doExport = () => {
    if (rows.length === 0) { toast.error("暂无数据可导出"); return; }
    exportXlsx(`电表台账_${new Date().toISOString().slice(0, 10)}`, [{
      name: "电表台账",
      rows: rows.map((m: any) => ({
        场地方: m.landlordName ?? "", 品牌方: m.brandName ?? (isSharedOf(m) ? "全品牌共享" : ""), 电表编号: m.meterNo,
        电表名称: m.meterName ?? "", 电表大类: categoryLabelOf(m),
        所有品牌共用: isSharedOf(m) ? "是" : "否", 设备地址: m.deviceAddress ?? "", 采集器号: m.collectorId ?? "",
        互感器倍数: fmtNum(m.transformerRatio),
      })),
    }]);
    toast.success("已导出 Excel");
  };

  // ── 电表读数 Excel 导入 ──
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const res = await importMetersExcel(file);
      setImportResult(res);
      queryClient.invalidateQueries({ queryKey: ["meters"] });
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || err?.message || "导入失败");
    } finally {
      setImporting(false);
    }
  };

  const toggleExpand = (id: number) => {
    setExpandedMeterId((prev) => (prev === id ? null : id));
  };


  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className={`${inputCls} w-64 pl-8`} placeholder="搜索 电表/电柜编号、场地、品牌…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <div className="w-40">
          <SearchSelect value={landlordId} onChange={setLandlordId} placeholder="全部场地方"
            options={(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))} />
        </div>
        <div className="w-40">
          <SearchSelect value={brandId} onChange={setBrandId} placeholder="全部品牌方"
            options={(brands.data ?? []).map((b: any) => ({ value: String(b.id), label: b.name }))} />
        </div>
        {/* ★ 表类型：把「所有品牌共用」从品牌维度里拆出来（它是【表级属性】，不是品牌） */}
        <select className={`${inputCls} w-32`} value={meterKind}
          onChange={(e) => setMeterKind(e.target.value as any)}
          title="表类型：这块表是不是「所有品牌共用一个电表」（与电表大类无关）">
          <option value="">全部表类型</option>
          <option value="shared">所有品牌共用</option>
          <option value="normal">普通电表</option>
        </select>
        {tagScope ? (
          <select className={`${inputCls} w-36`} value={catFilter || (TAG_TO_CODE[tagScope] || tagScope)} disabled
            title="当前账号的数据范围（按电表大类限定）">
            <option value={TAG_TO_CODE[tagScope] || tagScope}>{CATEGORY_LABEL[TAG_TO_CODE[tagScope] || tagScope] || tagScope}</option>
          </select>
        ) : (
          <select className={`${inputCls} w-36`} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
            title="电表大类 = 分给哪个财务管的职责分组（不参与任何算法）">
            <option value="">全部大类</option>
            {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {/* ★ 月份区间：单月（默认本月）→ 展开行就只看这个月；选多个月 → 展开行显示这几个月的读数 */}
        <div className="flex items-center gap-1">
          <input type="month" className={`${inputCls} w-[118px]`} value={periodFrom}
            max={periodTo}
            onChange={(e) => {
              const v = e.target.value;
              setPeriodFrom(v);
              if (v && periodTo && v > periodTo) setPeriodTo(v);   // 起始月超过结束月 ⇒ 顺延结束月
            }}
            title="起始月" />
          <span className="text-xs text-slate-400">~</span>
          <input type="month" className={`${inputCls} w-[118px]`} value={periodTo}
            min={periodFrom}
            onChange={(e) => {
              const v = e.target.value;
              setPeriodTo(v);
              if (v && periodFrom && v < periodFrom) setPeriodFrom(v); // 结束月早于起始月 ⇒ 前移起始月
            }}
            title="结束月（与起始月相同 = 只看这一个月）" />
        </div>
        <div className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0.5">
          {([["本月", 1], ["近3月", 3], ["近6月", 6], ["本年", "year"]] as const).map(([label, n]) => (
            <button key={label} type="button" onClick={() => applyPreset(n as any)}
              className="rounded px-1.5 py-1 text-[11px] text-slate-600 transition-colors hover:bg-slate-100 hover:text-blue-600">
              {label}
            </button>
          ))}
        </div>
        {/* ★ 区间读数覆盖度：一眼看出漏录，点一下只看未录的表 */}
        <button
          type="button"
          onClick={() => setOnlyMissing((v) => !v)}
          title={`所选区间（${rangeLabel}）内没有任何读数的电表会被跳过、不入台账。点击只看这些表。`}
          className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
            onlyMissing
              ? "border-rose-300 bg-rose-50 text-rose-700"
              : missingRows.length > 0
                ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                : "border-slate-200 bg-white text-slate-500"
          }`}
        >
          {rangeLabel} 读数 {baseRows.length - missingRows.length}/{baseRows.length}
          {missingRows.length > 0 && <span className="ml-1 font-medium">缺 {missingRows.length}</span>}
        </button>
        <div className="ml-auto flex gap-2">
          {/* 刷新按钮 */}
          <Button
            variant="outline"
            onClick={openSyncConfirm}
            disabled={syncing || syncLimit.isLimit || cooldownRef.current}
            className={`border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 ${syncLimit.isLimit ? "opacity-50" : ""}`}
            title={syncLimit.isLimit ? `已达今日上限，${syncLimit.resetTime} 重置` : `剩余 ${syncLimit.remaining} 次`}
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing
              ? syncProgress
              : syncLimit.isLimit
                ? `${formatCountdown(syncLimit.countdown)} 后重置`
                : `刷新电表数据 (${syncLimit.remaining})`
            }
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={doExport}><Download className="mr-1.5 h-4 w-4" />导出表格</Button>
          <Button variant="outline" className="text-blue-600" disabled={importing} onClick={() => importFileRef.current?.click()}>
            <Upload className="mr-1.5 h-4 w-4" />{importing ? "导入中…" : "导入 Excel"}
          </Button>
          <input ref={importFileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} />
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => { setEditRecord(null); setFormOpen(true); }}>
            <Plus className="mr-1.5 h-4 w-4" />新增电表
          </Button>
        </div>
      </div>

      {/* ★V5 结构重做（EXCEL_UI_SPEC §4.1）：一张主表，一行一块电表；点 ▶ 展开行内编辑（替代弹窗）
          ★X 轴：表格按各列声明宽度排布（约 1.18k px），超出可视区域才出横向滚动条；
            场地方/电表号两列冻结钉在左侧。minWidth 必须≈各列宽度之和，给大了会把窄列撑宽。 */}
      <div className="xl-wrap xl-wrap-scroll rounded-xl shadow-sm">
        <table className="xl-table" style={{ minWidth: 1180 }}>
          <thead>
            <tr>
              <th className="xl-freeze xl-ctr" style={{ left: 0, width: 30 }}></th>
              <th className="xl-freeze" style={{ left: 30, width: 92 }}>场地方</th>
              <th className="xl-freeze" style={{ left: 122, width: 112 }}>电表号</th>
              <th style={{ minWidth: 110 }}>名称</th>
              <th style={{ minWidth: 88 }}>品牌方</th>
              <th className="xl-ctr" style={{ width: 96 }} title="电表大类 = 分给哪个财务管的职责分组（不参与任何算法）">大类</th>
              <th className="xl-ctr" style={{ width: 56 }} title="所有品牌共用一个电表（表级属性，与大类无关）">共用</th>
              <th className="xl-num" style={{ width: 56 }}>倍数</th>
              <th className="xl-num" style={{ width: 56 }}>柜数</th>
              <th className="xl-num" style={{ width: 96 }} title={`${toDisplay(periodCompact)} 平台电量（第三方原始表码 × 倍数）`}>平台电量</th>
              <th className="xl-num" style={{ width: 96 }} title={`${toDisplay(periodCompact)} 实际电量（人工修正优先；点击可改）`}>实际电量 ✏️</th>
              <th className="xl-ctr" style={{ width: 70 }}>来源</th>
              <th className="xl-ctr xl-freeze-r" style={{ width: 70 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={13} className="xl-ctr xl-muted" style={{ padding: "28px 8px" }}>
                {meters.isLoading ? "加载中…" : "暂无电表数据"}
              </td></tr>
            )}
            {rows.map((m: any) => (
              <MeterRow
                key={m.id}
                meter={m}
                isExpanded={expandedMeterId === m.id}
                onToggle={() => toggleExpand(m.id)}
                onEdit={() => { setEditRecord(m); setFormOpen(true); }}
                onDelete={() => window.confirm("删除该电表？") && del.mutate(m.id)}
                entityMismatchHint={entityMismatchHint[m.id]}
                reading={readingInfoOf(m)}
                periodLabel={rangeLabel}
                period={periodCompact}
                periodFrom={fromCompact}
                periodTo={toCompact}
                cabinetCount={cabinetCountOf(m)}
              />
            ))}
          </tbody>
          {/* ★ 吸底合计行（Excel 风）：柜数 / 平台电量 / 实际电量 */}
          <tfoot>
            <tr>
              <td className="xl-freeze xl-ctr" style={{ left: 0 }}></td>
              <td className="xl-freeze" style={{ left: 30 }} colSpan={8}>
                合计 · {rows.length} 块电表
              </td>
              <td className="xl-num" title="柜数合计（共用表取品牌分摊录入值）">
                {fmtNum(rows.reduce((s: number, m: any) => s + (cabinetCountOf(m) || 0), 0))}
              </td>
              <td className="xl-num" title={`${rangeLabel} 平台电量合计`}>
                {fmtNum(Math.round(rows.reduce((s: number, m: any) => s + (readingInfoOf(m).platform || 0), 0) * 100) / 100)}
              </td>
              <td className="xl-num" title={`${rangeLabel} 实际电量合计（生效值：人工优先）`}>
                {fmtNum(Math.round(rows.reduce((s: number, m: any) => {
                  const r = readingInfoOf(m);
                  return s + (r.actual != null ? r.actual : (r.platform || 0));
                }, 0) * 100) / 100)}
              </td>
              <td className="xl-ctr"></td>
              <td className="xl-freeze-r"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <MeterForm open={formOpen} onClose={() => { setFormOpen(false); setEditRecord(null); }} record={editRecord} />

      {/* 刷新确认弹窗 */}
      <Dialog open={syncConfirmOpen} onOpenChange={(o) => !o && setSyncConfirmOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-600">
              <RefreshCw className="h-5 w-5" />
              确认刷新电表数据
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-800">
              <p className="font-semibold mb-1">⚠️ 注意次数限制</p>
              <p>每天最多刷新 <b>10 次</b>，24小时后重置。</p>
              <p className="mt-1">本次刷新后剩余 <b className="text-rose-600">{syncLimit.remaining - 1}</b> 次。</p>
            </div>
            <div className="text-xs text-slate-500">
              将同步以下数据：<br />
              设备列表、采集器、实时状态、小时/日/月用电量、报警信息
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setSyncConfirmOpen(false)}>取消</Button>
              <Button
                size="sm"
                className="bg-rose-600 hover:bg-rose-700"
                onClick={doSync}
              >
                确认刷新
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Excel 导入结果 */}
      <Dialog open={importResult !== null} onOpenChange={(o) => !o && setImportResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>电表导入结果</DialogTitle></DialogHeader>
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-700">成功处理 {importResult?.updated ?? 0} 行</span>
            </div>
            {((importResult?.created_landlords ?? []).length > 0 || (importResult?.created_brands ?? []).length > 0) && (
              <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
                <div className="mb-1 font-medium text-amber-700">自动关联：</div>
                <div className="text-slate-600">
                  {(importResult?.created_landlords ?? []).length > 0 && <>场地方：{importResult.created_landlords.join("、")}<br /></>}
                  {(importResult?.created_brands ?? []).length > 0 && <>品牌方：{importResult.created_brands.join("、")}</>}
                </div>
              </div>
            )}
            {(importResult?.errors ?? []).length > 0 ? (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-rose-100 bg-rose-50/60 px-3 py-2">
                <div className="mb-1 font-medium text-rose-700">提示 / 跳过原因：</div>
                {importResult.errors.map((e: string, i: number) => (
                  <div key={i} className="py-0.5 text-slate-600">· {e}</div>
                ))}
              </div>
            ) : (
              (importResult?.updated ?? 0) === 0 && (
                <div className="text-slate-500">未处理任何行（可能数据为空或全部是示例行）</div>
              )
            )}
            <div className="text-[10px] text-slate-400">
              已关联场地的电表保存了读数；未关联的电表已自动关联场地方并保存读数；电费台账已自动重新生成。
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={() => setImportResult(null)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── ★V5 主表行（EXCEL_UI_SPEC §4.1）：一行一块电表；大类/共用/倍数/实际电量 行内可改 ───
function MeterRow({ meter, isExpanded, onToggle, onEdit, onDelete, entityMismatchHint, reading, periodLabel, period, periodFrom, periodTo, cabinetCount }: {
  meter: any; isExpanded: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void; entityMismatchHint?: string;
  reading?: { has: boolean; platform: number | null; actual: number | null; raw: number | null; months: number; manualMonths: number; source: "manual" | "platform" | "none" };
  /** 区间展示名（单月 = 2026-09；多月 = 2026-04 ~ 2026-09） */
  periodLabel?: string; period?: string;
  /** 区间起止（YYYMM），下传给展开面板 */
  periodFrom?: string; periodTo?: string;
  /** 柜数：普通表 = 该表柜子数；共用表 = 品牌分摊录入的柜数合计（null = 未录） */
  cabinetCount?: number | null;
}) {
  const queryClient = useQueryClient();
  const isShared = isSharedOf(meter);
  const code = codeOf(meter);
  // 单月时可行内改「实际电量」；多个月时列表显示的是区间合计，逐月录入请展开
  const singleMonth = !!periodFrom && periodFrom === periodTo;
  // 区间总月数（YYYYMM 之差）
  const monthSpan = (periodFrom && periodTo)
    ? Math.max(0, (Number(periodTo.slice(0, 4)) - Number(periodFrom.slice(0, 4))) * 12
      + (Number(periodTo.slice(4, 6)) - Number(periodFrom.slice(4, 6))) + 1)
    : 0;
  const [editingCell, setEditingCell] = useState<"" | "ratio" | "actual">("");
  const [cellVal, setCellVal] = useState("");

  // 行内保存（大类 / 共用 / 倍数 / 实际电量）—— 失焦/回车触发
  const patch = useMutation({
    mutationFn: (data: any) => updateMeter(meter.id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["meters"] }); },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message || "保存失败"),
  });

  // 实际电量 → 写读数行（actual_kwh 人工值，同步不覆盖；保存后重算该月台账）
  const saveActual = useMutation({
    mutationFn: (v: number) => saveMeterReading({
      address: meter.meterNo,
      monthPeriod: period || "",
      kwh: reading?.raw ?? undefined,          // 回传原始表码，避免把平台值冲掉
      actualKwh: v,
    }),
    onSuccess: async () => {
      toast.success(`实际电量已保存（${toDisplay(period || "")}），台账已重算`);
      // ★ 顺序很重要：必须等台账重算【完成】再让界面失效重取。
      //   反过来的话，失效触发的 refetch 会在重算完成前拿到旧台账，
      //   页面上就表现为「保存后数字不动，要手动刷新浏览器才更新」。
      try { await generateElectricity({ period: period || "" }); } catch {}
      queryClient.invalidateQueries({ queryKey: ["meterReadings"] });
      queryClient.invalidateQueries({ queryKey: ["electricity"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-monthly-ledger-range"] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message || "保存失败"),
  });

  const commitCell = (kind: "ratio" | "actual") => {
    const v = cellVal.trim();
    setEditingCell("");
    if (v === "") return;
    const n = Number(v);
    if (isNaN(n) || n < 0) { toast.error("请输入非负数字"); return; }
    if (kind === "ratio") {
      if (n === Number(meter.transformerRatio ?? 1)) return;
      patch.mutate({ transformerRatio: n });
    } else {
      if (n === reading?.actual) return;
      saveActual.mutate(n);
    }
  };

  return (
    <>
      <tr className={isExpanded ? "xl-open" : undefined}>
        <td className="xl-freeze xl-ctr" style={{ left: 0 }}>
          <button className="text-slate-400 hover:text-slate-600" onClick={onToggle}>
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </td>
        <td className="xl-freeze truncate" style={{ left: 30 }} title={`${meter.landlordName ?? "未关联场地"}${entityMismatchHint ? ` · ${entityMismatchHint}` : ""}`}>
          {meter.landlordName ?? <span className="text-rose-500" title="未关联场地的电表不生成台账">未关联场地</span>}
        </td>
        <td className="xl-freeze font-mono text-[12px]" style={{ left: 122 }} title={meter.meterNo}>{meter.meterNo}</td>
        <td className="truncate" title={meter.meterName}>{meter.meterName ?? "—"}</td>
        <td className="truncate text-slate-600">
          {meter.brandName ?? (isShared ? <span className="font-medium text-purple-600">全品牌共享</span> : <span className="text-slate-400">未设置</span>)}
        </td>
        {/* 大类：行内下拉（财务分工标签，不参与算法） */}
        <td className="xl-ctr">
          <select
            className="rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-slate-600 hover:border-slate-300"
            value={code}
            title="电表大类（分给哪个财务管）——行内可直接改"
            onChange={(e) => patch.mutate({ categoryCode: e.target.value })}
          >
            {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        {/* 共用：行内开关（表级属性，与大类无关） */}
        <td className="xl-ctr">
          <Switch checked={isShared} onCheckedChange={(on) => patch.mutate({ isShared: on, brandId: on ? null : meter.brandId })}
            className="scale-90" title="所有品牌共用一个电表（人工勾选，与大类无关）" />
        </td>
        {/* 倍数：行内编辑 */}
        <td className="xl-num">
          {editingCell === "ratio" ? (
            <input autoFocus type="number" step="0.01" min="0" className={`${inputCls} h-6 w-14 px-1 text-xs`}
              value={cellVal} onChange={(e) => setCellVal(e.target.value)}
              onBlur={() => commitCell("ratio")}
              onKeyDown={(e) => e.key === "Enter" && commitCell("ratio")} />
          ) : (
            <span className="cursor-text rounded px-1 hover:bg-amber-50 tabular-nums"
              title="互感器倍数（实际电量 = 表码 × 倍数）——点击修改；历史月份按读数时的快照倍数算"
              onClick={() => { setEditingCell("ratio"); setCellVal(String(meter.transformerRatio ?? 1)); }}>
              {fmtNum(meter.transformerRatio ?? 1)}
            </span>
          )}
        </td>
        <td className={cabinetCount == null ? "xl-num xl-muted" : "xl-num"}
          title={isShared
            ? "共用表：录了品牌分摊柜数就按分摊算；没录则按该表挂的「柜子档案」数量算（至少 1 柜）。展开可增删柜子"
            : "该表下的柜子数（展开可增删）"}>
          {cabinetCount == null ? "—" : fmtNum(cabinetCount)}
        </td>
        {/* 平台电量（只读，区间合计） */}
        <td className="xl-num text-slate-600" title={`${periodLabel || ""} 第三方原始表码 × 倍数（区间合计）`}>
          {reading?.platform != null ? fmtNum(reading.platform) : <span className="xl-muted">—</span>}
        </td>
        {/* 实际电量：单月可行内编辑（人工修正，永不被同步覆盖）；多月显示区间合计（逐月改请展开） */}
        <td className="xl-num">
          {editingCell === "actual" ? (
            <input autoFocus type="number" step="0.01" min="0" className={`${inputCls} h-6 w-20 px-1 text-xs`}
              value={cellVal} onChange={(e) => setCellVal(e.target.value)}
              onBlur={() => commitCell("actual")}
              onKeyDown={(e) => e.key === "Enter" && commitCell("actual")} />
          ) : (
            <span
              className={`rounded px-1 tabular-nums ${singleMonth ? "cursor-text hover:bg-amber-50" : ""} ${reading?.actual != null ? "font-semibold text-emerald-700" : reading?.platform != null ? "text-slate-500" : "xl-muted"}`}
              title={singleMonth
                ? `${periodLabel || ""} 实际电量：填了优先用它（不会被同步覆盖）；留空按 平台电量 计。点击填写`
                : `${periodLabel || ""} 实际电量合计（${reading?.manualMonths || 0} 个月有人工值）。多选月份时不能行内改，点左侧 ▶ 展开逐月录入`}
              onClick={() => {
                if (!singleMonth) { onToggle(); return; }
                setEditingCell("actual"); setCellVal(reading?.actual != null ? String(reading.actual) : "");
              }}>
              {reading?.actual != null ? fmtNum(reading.actual)
                : reading?.platform != null ? <span className="text-slate-400">=平台</span>
                : "—"}
            </span>
          )}
        </td>
        <td className="xl-ctr">
          {reading?.source === "manual" && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">人工</span>}
          {reading?.source === "platform" && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700">第三方</span>}
          {(!reading || reading.source === "none") && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-600" title="所选区间内无读数 → 该表不入台账">缺</span>}
          {!singleMonth && (reading?.months || 0) > 0 && (
            <span className="ml-0.5 text-[10px] tabular-nums text-slate-400" title="所选区间内有读数的月份数 / 区间总月数">
              {reading?.months}/{monthSpan}
            </span>
          )}
        </td>
        <td className="xl-ctr xl-freeze-r">
          <div className="flex justify-center gap-0.5">
            <button className="rounded p-1 text-slate-400 hover:text-blue-600" onClick={onEdit} title="编辑档案（名称/归属/主体/设备地址等）"><Pencil className="h-3 w-3" /></button>
            <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={onDelete} title="删除电表"><Trash2 className="h-3 w-3" /></button>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="xl-detail"><td colSpan={13} className="p-0">
          <MeterExpandPanel meter={meter} period={period || ""} periodFrom={periodFrom} periodTo={periodTo} />
        </td></tr>
      )}
    </>
  );
}

// ─── ★V5 展开行（对齐原型 .detail/.dwrap）：迷你表格 + 单元格内联编辑，替代弹窗 ───
// 形态：一条 26px 行高的迷你表（月度读数 × 工具栏所选月份区间），共用表再挂一条品牌分摊迷你表。
// 交互：单元格本身就是输入框，失焦即存（存后自动重算该月台账）；已改未存的格子亮黄底。
function MeterExpandPanel({ meter, period, periodFrom, periodTo }: {
  meter: any;
  /** 区间末月（YYYMM）：品牌分摊默认月份、行内编辑目标月 */
  period: string;
  /** 工具栏所选月份区间（YYYMM）；展开行只显示这个区间内的月份 */
  periodFrom?: string; periodTo?: string;
}) {
  const queryClient = useQueryClient();
  const isShared = isSharedOf(meter);

  /* ══ 1. 月度读数迷你表（★只显示工具栏所选区间内的月份；单元格失焦即存）══ */
  const readings = useQuery({
    queryKey: ["meterReadings", meter?.meterNo],
    queryFn: () => getMeterReadings(meter.meterNo),
    enabled: !!meter?.meterNo,
  });
  // 区间内月份（降序，含「无读数」的月份）—— 与工具栏区间联动
  const rangeMonths = useMemo(() => {
    if (!periodFrom || !periodTo) return [] as string[];
    const list: string[] = [];
    let y = Number(periodFrom.slice(0, 4)), m = Number(periodFrom.slice(4, 6));
    const ey = Number(periodTo.slice(0, 4)), em = Number(periodTo.slice(4, 6));
    let guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard++ < 600) {
      list.push(`${y}${String(m).padStart(2, "0")}`);
      m++; if (m > 12) { m = 1; y++; }
    }
    return list.reverse();
  }, [periodFrom, periodTo]);
  const allReadingRows = (readings.data ?? []) as any[];
  // 区间外的月份不显示；区间内没有读数记录的月份补一条空行（直接填即可建档，存量表不用回到弹窗）
  const readingRows = useMemo(() => {
    if (rangeMonths.length === 0) return allReadingRows;
    const byMonth = new Map<string, any>();
    for (const r of allReadingRows) if (r?.monthPeriod) byMonth.set(String(r.monthPeriod), r);
    return rangeMonths.map((mp) => byMonth.get(mp) ?? { monthPeriod: mp, empty: true });
  }, [rangeMonths, allReadingRows]);
  const rangeLabelText = periodFrom && periodTo
    ? (periodFrom === periodTo
      ? toDisplay(periodFrom)
      : `${toDisplay(periodFrom)} ~ ${toDisplay(periodTo)}`)
    : "";
  // 品牌分摊的目标月份：区间内默认取【末月】，多个月时可用小标签切换
  const [allocPeriod, setAllocPeriod] = useState(period);
  useEffect(() => {
    if (!periodFrom || !periodTo) { setAllocPeriod(period); return; }
    setAllocPeriod((prev) => (prev && prev >= periodFrom && prev <= periodTo ? prev : period));
  }, [periodFrom, periodTo, period]);
  const allocMonths = rangeMonths;
  const [rd, setRd] = useState<Record<string, any>>({}); // monthPeriod → 草稿
  const savedOf = (r: any) => ({
    actual: r.actualKwh != null ? String(r.actualKwh) : "",
    prev: r.prevReading != null ? String(r.prevReading) : "",
    curr: r.currReading != null ? String(r.currReading) : "",
    prevA: r.prevActualReading != null ? String(r.prevActualReading) : "",
    currA: r.currActualReading != null ? String(r.currActualReading) : "",
    prevD: r.prevReadingDate || "",
    currD: r.currReadingDate || "",
  });
  const draftOf = (r: any) => rd[r.monthPeriod] ?? savedOf(r);
  const setCell = (r: any, k: string, v: string) =>
    setRd((p) => ({ ...p, [r.monthPeriod]: { ...draftOf(r), [k]: v } }));
  const dirtyCell = (r: any, k: string) =>
    !!rd[r.monthPeriod] && (rd[r.monthPeriod][k] ?? "") !== (savedOf(r)[k] ?? "");

  const saveReading = useMutation({
    mutationFn: (r: any) => {
      const d = draftOf(r);
      const kwh = d.prev !== "" && d.curr !== "" && !isNaN(Number(d.curr) - Number(d.prev))
        ? Math.round((Number(d.curr) - Number(d.prev)) * 100) / 100
        : (r.rawKwh != null ? Number(r.rawKwh) : undefined);
      return saveMeterReading({
        address: meter.meterNo, monthPeriod: r.monthPeriod, kwh,
        actualKwh: d.actual !== "" ? Number(d.actual) : undefined,
        prevActualReading: d.prevA !== "" ? Number(d.prevA) : undefined,
        currActualReading: d.currA !== "" ? Number(d.currA) : undefined,
        prevReadingDate: d.prevD || undefined,
        prevReading: d.prev !== "" ? Number(d.prev) : undefined,
        currReadingDate: d.currD || undefined,
        currReading: d.curr !== "" ? Number(d.curr) : undefined,
      });
    },
    onSuccess: async (_d: any, r: any) => {
      toast.success(`${toDisplay(r.monthPeriod)} 读数已保存，台账已重算`);
      setRd((p) => { const n = { ...p }; delete n[r.monthPeriod]; return n; });
      // ★ 顺序很重要：先等台账重算完成，再让界面失效重取（否则拿到重算前的旧值，
      //   表现为「改完要手动刷新浏览器数字才变」）。与上方 saveActual 同一处理。
      try { await generateElectricity({ period: r.monthPeriod }); } catch {}
      queryClient.invalidateQueries({ queryKey: ["meterReadings"] });
      queryClient.invalidateQueries({ queryKey: ["electricity"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-monthly-ledger-range"] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message || "保存失败"),
  });
  const commitRow = (r: any) => {
    const d = rd[r.monthPeriod];
    if (!d) return;
    const s = savedOf(r);
    if (Object.keys(s).every((k) => (d[k] ?? "") === (s[k] ?? ""))) {
      setRd((p) => { const n = { ...p }; delete n[r.monthPeriod]; return n; });
      return;
    }
    saveReading.mutate(r);
  };
  const cellInput = (r: any, k: string, extra: any = {}) => (
    <input
      {...extra}
      value={draftOf(r)[k] ?? ""}
      onChange={(e) => setCell(r, k, e.target.value)}
      onBlur={() => commitRow(r)}
      className={`xl-input ${extra.num ? "num" : ""}`}
    />
  );

  // ★ 抄表日期的合法边界（账期 = 自然月）：
  //   起始日期（上次抄表）∈ [上月末号, 当月月末] —— 上次抄表不会早于上月最后一天
  //   截止日期（本次抄表）∈ [起始日期, 次月1号]  —— 抄表偶尔会拖到次月 1 号
  const dateEdgesOf = (mp: string) => {
    const y = Number(String(mp).slice(0, 4)), m = Number(String(mp).slice(4, 6));
    const pad = (n: number) => String(n).padStart(2, "0");
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    return {
      prevMonthEnd: `${py}-${pad(pm)}-${pad(new Date(py, pm, 0).getDate())}`,
      monthEnd: `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`,
      nextMonthFirst: `${ny}-${pad(nm)}-01`,
    };
  };

  /* ══ 2. 品牌分摊迷你表（共用表；整体保存）—— 单月口径，月份默认取区间末月，可用小标签切换 ══ */
  const allocForm = useQuery({
    queryKey: ["shared-allocations", meter?.meterNo, allocPeriod],
    queryFn: () => getSharedAllocationForm({ meterNo: meter.meterNo, monthPeriod: allocPeriod }),
    enabled: isShared && !!meter?.meterNo && !!allocPeriod,
  });
  type AllocRow = { brandId: string; brandContractId: string; collectAmount: string; unitPrice: string; cabinetCount: string; entityId: string };
  const [allocRows, setAllocRows] = useState<AllocRow[]>([]);
  const bindings = (allocForm.data?.bindings ?? []) as any[];
  const missingBrands = (allocForm.data?.missingBrands ?? []) as any[];
  useEffect(() => {
    const d = allocForm.data;
    if (!isShared || !d || d.monthPeriod !== allocPeriod) return;
    const cabDefault = (bid: string) => {
      const x = d.cabinetDefaults?.[bid];
      return x && x.count != null ? String(x.count) : "";
    };
    if ((d.allocations ?? []).length > 0) {
      setAllocRows(d.allocations.map((a: any) => ({
        brandId: String(a.brandId),
        brandContractId: a.brandContractId != null ? String(a.brandContractId) : "",
        collectAmount: a.collectAmount != null ? String(a.collectAmount) : "",
        unitPrice: a.unitPrice != null ? String(a.unitPrice) : "",
        cabinetCount: a.cabinetCount != null ? String(a.cabinetCount) : "",
        entityId: a.entityId != null ? String(a.entityId) : "",
      })));
    } else {
      const src = (bindings.length > 0 ? bindings : (d.brands ?? [])) as any[];
      setAllocRows(src.map((b: any) => ({
        brandId: String(b.brandId), brandContractId: String(b.contracts?.length === 1 ? b.contracts[0].contractId : ""), collectAmount: "", unitPrice: "",
        cabinetCount: cabDefault(String(b.brandId)), entityId: "",
      })));
    }
  }, [allocForm.data, allocPeriod, isShared]);
  const setAllocRow = (i: number, patch: Partial<AllocRow>) =>
    setAllocRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const contractPriceOf = (bid: string) => {
    const b = ((allocForm.data?.brands ?? []) as any[]).find((x) => String(x.brandId) === bid);
    const selected = b?.contracts?.find((c: any) => String(c.contractId) === allocRows.find((r) => r.brandId === bid)?.brandContractId);
    return selected?.price ?? (b?.unitPrice != null ? Number(b.unitPrice) : null);
  };
  const priceOf = (r: AllocRow) => (r.unitPrice.trim() !== "" ? (parseFloat(r.unitPrice) || null) : contractPriceOf(r.brandId));
  const kwhOf = (r: AllocRow) => {
    const a = parseFloat(r.collectAmount); const pr = priceOf(r);
    return !isNaN(a) && pr ? Math.round((a / pr) * 100) / 100 : null;
  };
  // ★参与保存的行 = 填了「应收电费」/「柜数」/「报税主体」任一项
  //   （共享表的柜数独立于电费：财务常只录柜数，此前只认金额 → 只填柜数的品牌行被静默丢弃，
  //    导致合同页该品牌「计费柜数」一直是 0）
  const allocFilled = allocRows.filter((r) => r.brandId && (
    r.brandContractId.trim() !== "" || r.collectAmount.trim() !== "" || r.cabinetCount.trim() !== "" || r.entityId.trim() !== ""
  ));
  const allocTotals = (() => {
    let amount = 0, kwh = 0, missPrice = 0, cabs = 0;
    for (const r of allocFilled) {
      amount += parseFloat(r.collectAmount) || 0;
      const k = kwhOf(r); if (k == null) missPrice++; else kwh += k;
      const c = parseInt(r.cabinetCount, 10); if (!isNaN(c) && c > 0) cabs += c;
    }
    return { amount: Math.round(amount * 100) / 100, kwh: Math.round(kwh * 100) / 100, missPrice, cabs };
  })();
  const curRow = readingRows.find((r) => r.monthPeriod === allocPeriod);
  const tableKwh = curRow?.kwh != null ? Number(curRow.kwh) : null;
  const unAllocated = tableKwh != null && allocTotals.amount > 0 ? Math.round((tableKwh - allocTotals.kwh) * 100) / 100 : null;
  // 比较键：金额/柜数/主体统一规范化（空 = ""；金额保留 2 位），保证「只录柜数」的行也能判为已改动
  const allocKeyOf = (brandId: any, amount: any, cabinet: any, entity: any, contract: any, price: any) => {
    const amt = amount == null || String(amount).trim() === "" || isNaN(Number(amount)) ? "" : Number(amount).toFixed(2);
    const cab = cabinet == null || String(cabinet).trim() === "" ? "" : String(parseInt(String(cabinet), 10));
    const ent = entity == null || String(entity).trim() === "" ? "" : String(parseInt(String(entity), 10));
    const p = price == null || String(price).trim() === "" || isNaN(Number(price)) ? "" : Number(price).toFixed(4);
    return `${brandId}:${amt}:${cab}:${ent}:${contract || ""}:${p}`;
  };
  const savedAllocKey = ((allocForm.data?.allocations ?? []) as any[])
    .map((a) => allocKeyOf(a.brandId, a.collectAmount, a.cabinetCount, a.entityId, a.brandContractId, a.unitPrice)).sort().join("|");
  const allocDirty = allocFilled
    .map((r) => allocKeyOf(r.brandId, r.collectAmount, r.cabinetCount, r.entityId, r.brandContractId, r.unitPrice)).sort().join("|") !== savedAllocKey;
  const saveAlloc = useMutation({
    mutationFn: () => saveSharedAllocations({
      address: meter.meterNo, monthPeriod: allocPeriod,
      rows: allocFilled.map((r) => ({
        brandId: Number(r.brandId),
        brandContractId: r.brandContractId ? Number(r.brandContractId) : null,
        // 金额留空 → 传 null（后端存 NULL = 本月不计电费，只保留柜数/主体）
        collectAmount: r.collectAmount.trim() === "" ? null : parseFloat(r.collectAmount),
        unitPrice: r.unitPrice.trim() === "" ? null : parseFloat(r.unitPrice),
        cabinetCount: r.cabinetCount.trim() === "" ? null : parseInt(r.cabinetCount, 10),
        entityId: r.entityId.trim() === "" ? null : parseInt(r.entityId, 10),
      })),
    }),
    onSuccess: () => {
      toast.success("品牌分摊已保存，台账已重算");
      queryClient.invalidateQueries({ queryKey: ["shared-allocations"] });
      queryClient.invalidateQueries({ queryKey: ["electricity"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-monthly-ledger-range"] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message || "保存失败"),
  });
  const entityOptions = ((allocForm.data?.allEntities ?? []) as any[]).map((e) => ({
    value: String(e.entityId), label: e.entityName || e.entityFullName || `主体${e.entityId}`,
  }));
  const brandOptions = useMemo(() => {
    const withC = ((allocForm.data?.brands ?? []) as any[]).map((b) => ({
      value: String(b.brandId), label: b.unitPrice != null ? `${b.brandName}（${b.unitPrice}）` : b.brandName,
    }));
    const used = new Set(withC.map((o) => o.value));
    const rest = ((allocForm.data?.allBrands ?? []) as any[])
      .filter((b) => !used.has(String(b.brandId)))
      .map((b) => ({ value: String(b.brandId), label: b.brandName }));
    return [...withC, ...rest];
  }, [allocForm.data]);

  /* ══ 3. 柜子档案（普通表 / 共用表都可用）：单行胶囊 ══ */
  const cabinets = useQuery({
    queryKey: ["cabinets", meter.id],
    queryFn: () => listCabinets({ meterId: meter.id }),
    enabled: !!meter?.id,
  });
  const [cabinetFormOpen, setCabinetFormOpen] = useState(false);
  const [editCabinet, setEditCabinet] = useState<any>(null);
  const delCabinet = useMutation({
    mutationFn: deleteCabinet,
    onSuccess: () => { toast.success("已删除"); queryClient.invalidateQueries({ queryKey: ["cabinets"] }); },
  });

  return (
    <div>
      {/* ── 月度读数（★只显示工具栏所选月份区间，一行一月）── */}
      <div className="xl-dtitle">
        {meter.meterNo} · 月度读数
        <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-normal text-slate-600">
          仅显示工具栏所选月份：{rangeLabelText}（{readingRows.length} 个月）
        </span>
        <span className="sub">单元格直接改，失焦即存并重算台账 · 黄底 = 已改未存 · 绿底 = 品牌分摊对应月份</span>
      </div>
      <div className="xl-dwrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 64 }}>月份</th>
              <th style={{ width: 104 }}>平台电量</th>
              <th style={{ width: 104 }}>实际电量</th>
              <th style={{ width: 92 }}>起始度数</th>
              <th style={{ width: 92 }}>抄表度数</th>
              <th style={{ width: 100 }}>上月实际读数</th>
              <th style={{ width: 100 }}>本月实际读数</th>
              <th style={{ width: 118 }} title="上次抄表日期：不早于上月末号（账期为自然月）">起始日期</th>
              <th style={{ width: 118 }} title="本次抄表日期：不早于起始日期、不晚于次月1号（默认月底）">截止日期</th>
              <th style={{ width: 60 }}>来源</th>
            </tr>
          </thead>
          <tbody>
            {readingRows.map((r) => (
              <tr key={r.monthPeriod} className={r.monthPeriod === allocPeriod ? "bg-[#eef7f1]" : undefined}>
                <td className="ctr">{toDisplay(r.monthPeriod)}</td>
                <td className="num" title={r.rawKwh != null ? `原始表码 ${fmtNum(r.rawKwh)} × 倍数` : "未同步"}>
                  {r.kwh != null ? fmtNum(r.kwh) : <span className="text-slate-400">—</span>}
                </td>
                <td className={dirtyCell(r, "actual") ? "num xl-edited" : "num"}>
                  {cellInput(r, "actual", { type: "number", step: "0.01", num: true, placeholder: r.kwh != null ? String(r.kwh) : "" })}
                </td>
                <td className={dirtyCell(r, "prev") ? "num xl-edited" : "num"}>{cellInput(r, "prev", { type: "number", step: "0.01", num: true })}</td>
                <td className={dirtyCell(r, "curr") ? "num xl-edited" : "num"}>{cellInput(r, "curr", { type: "number", step: "0.01", num: true })}</td>
                <td className={dirtyCell(r, "prevA") ? "num xl-edited" : "num"}>{cellInput(r, "prevA", { type: "number", step: "0.01", num: true })}</td>
                <td className={dirtyCell(r, "currA") ? "num xl-edited" : "num"}>{cellInput(r, "currA", { type: "number", step: "0.01", num: true })}</td>
                <td className={dirtyCell(r, "prevD") ? "ctr xl-edited" : "ctr"}
                  title={`上次抄表日期（≥ 上月末号 ${dateEdgesOf(r.monthPeriod).prevMonthEnd}）`}>
                  {cellInput(r, "prevD", {
                    type: "date",
                    min: dateEdgesOf(r.monthPeriod).prevMonthEnd,
                    max: dateEdgesOf(r.monthPeriod).monthEnd,
                  })}
                </td>
                <td className={dirtyCell(r, "currD") ? "ctr xl-edited" : "ctr"}
                  title={`本次抄表日期（≥ 起始日期，≤ 次月1号 ${dateEdgesOf(r.monthPeriod).nextMonthFirst}；默认月底）`}>
                  {cellInput(r, "currD", {
                    type: "date",
                    min: draftOf(r).prevD || dateEdgesOf(r.monthPeriod).prevMonthEnd,
                    max: dateEdgesOf(r.monthPeriod).nextMonthFirst,
                  })}
                </td>
                <td className="ctr">
                  {r.actualKwh != null ? <span className="text-emerald-600">人工</span>
                    : r.kwh != null ? <span className="text-sky-600">第三方</span>
                    : <span className="text-rose-500">缺</span>}
                </td>
              </tr>
            ))}
            {readingRows.length === 0 && (
              <tr><td colSpan={10} className="ctr" style={{ color: "#94a3b8", padding: 10 }}>该表暂无月度读数</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── 品牌分摊（共用表；按月录入 —— 默认区间末月，多个月时用下面的小标签切换）── */}
      {isShared && (
        <>
          <div className="xl-dtitle" id="shared-alloc-section" style={{ marginTop: 10 }}>
            {meter.meterNo} · 品牌分摊 · {toDisplay(allocPeriod)}
            {/* 选了多个月：分摊是【单月口径】，给月份小标签切换 */}
            {allocMonths.length > 1 && (
              <span className="flex flex-wrap items-center gap-0.5 font-normal">
                {allocMonths.map((mp) => (
                  <button key={mp} type="button" onClick={() => setAllocPeriod(mp)}
                    title={`编辑 ${toDisplay(mp)} 的品牌分摊`}
                    className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                      mp === allocPeriod
                        ? "border-purple-400 bg-purple-50 font-medium text-purple-700"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                    }`}>
                    {toDisplay(mp)}
                  </button>
                ))}
              </span>
            )}
            {missingBrands.length > 0 && (
              <span className="rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-normal text-rose-700">
                漏录：{missingBrands.map((b) => b.brandName).join("、")}
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <button className="text-[11px] font-normal text-purple-600 hover:underline"
                onClick={() => setAllocRows((prev) => [...prev, { brandId: "", brandContractId: "", collectAmount: "", unitPrice: "", cabinetCount: "", entityId: "" }])}>
                + 添加品牌
              </button>
              {allocDirty && (
                <button className="rounded bg-purple-600 px-2 py-0.5 text-[11px] font-normal text-white hover:bg-purple-700"
                  disabled={saveAlloc.isPending} onClick={() => saveAlloc.mutate()}>
                  {saveAlloc.isPending ? "保存中…" : "保存分摊"}
                </button>
              )}
            </span>
          </div>
          <div className="xl-dwrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>品牌</th>
                  <th style={{ width: 210 }}>关联品牌合同</th>
                  <th style={{ width: 110 }}>应收电费</th>
                  <th style={{ width: 96 }}>单价</th>
                  <th style={{ width: 96 }}>应收电量</th>
                  <th style={{ width: 60 }}>柜数</th>
                  <th style={{ width: 130 }}>报税主体</th>
                  <th style={{ width: 32 }}></th>
                </tr>
              </thead>
              <tbody>
                {allocRows.map((r, i) => {
                  const k = kwhOf(r);
                  const cp = contractPriceOf(r.brandId);
                  return (
                    <tr key={`${r.brandId}-${i}`}>
                      <td>
                        <select value={r.brandId}
                          onChange={(e) => {
                            const bid = e.target.value;
                            const d = allocForm.data?.cabinetDefaults?.[bid];
                            const b = ((allocForm.data?.brands ?? []) as any[]).find((x) => String(x.brandId) === bid);
                            setAllocRow(i, { brandId: bid, brandContractId: b?.contracts?.length === 1 ? String(b.contracts[0].contractId) : "", unitPrice: "", cabinetCount: d && d.count != null ? String(d.count) : "", entityId: "" });
                          }}>
                          <option value="">选择品牌</option>
                          {brandOptions
                            .filter((o) => o.value === r.brandId || !allocRows.some((r2, j) => j !== i && r2.brandId === o.value))
                            .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={r.brandContractId}
                          onChange={(e) => setAllocRow(i, { brandContractId: e.target.value, unitPrice: "" })}>
                          <option value="">按品牌与主体自动匹配</option>
                          {(((allocForm.data?.brands ?? []) as any[]).find((b) => String(b.brandId) === r.brandId)?.contracts ?? []).map((c: any) => (
                            <option key={c.contractId} value={String(c.contractId)}>
                              {c.price ?? "未设电价"} 元/度 · {c.entityName || "未指定主体"}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="num">
                        <input type="number" step="0.01" min="0" className="xl-input num"
                          value={r.collectAmount} onChange={(e) => setAllocRow(i, { collectAmount: e.target.value })} />
                      </td>
                      <td className="num">
                        <input type="number" step="0.0001" min="0" className="xl-input num"
                          placeholder={cp != null ? String(cp) : "无合同价"} title="留空 = 品牌方合同单价"
                          value={r.unitPrice} onChange={(e) => setAllocRow(i, { unitPrice: e.target.value })} />
                      </td>
                      <td className="num">
                        {k != null ? <span className="xl-derived">{fmtNum(k)}</span>
                          : r.collectAmount ? <span className="text-rose-500">缺单价</span>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="num">
                        <input type="number" step="1" min="1" className="xl-input num"
                          value={r.cabinetCount} onChange={(e) => setAllocRow(i, { cabinetCount: e.target.value })} />
                      </td>
                      <td>
                        <select value={r.entityId} title="留空 = 默认（电表自身主体）"
                          onChange={(e) => setAllocRow(i, { entityId: e.target.value })}>
                          <option value="">默认</option>
                          {entityOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                      <td className="ctr">
                        <button className="text-slate-300 hover:text-rose-500" title="删除该行"
                          onClick={() => setAllocRows((prev) => prev.filter((_, idx) => idx !== i))}>
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {allocRows.length === 0 && (
                  <tr><td colSpan={8} className="ctr" style={{ color: "#94a3b8", padding: 10 }}>
                    暂无品牌分摊 —— 点右上「+ 添加品牌」录入（保存后自动更新品牌绑定）
                  </td></tr>
                )}
                <tr className="xl-dtotal">
                  <td>合计</td>
                  <td className="num">{fmtNum(allocTotals.amount)}</td>
                  <td></td>
                  <td className="num">{fmtNum(allocTotals.kwh)}</td>
                  <td className="num">{allocTotals.cabs || ""}</td>
                  <td colSpan={3}></td>
                </tr>
                {unAllocated != null && unAllocated !== 0 && (
                  <tr>
                    <td className="ctr" style={{ color: "#4f7a63" }}>表内未摊差额</td>
                    <td colSpan={2} className="ctr" style={{ color: "#94a3b8" }}>整表 {fmtNum(tableKwh!)} − 品牌合计 {fmtNum(allocTotals.kwh)}</td>
                    <td className="num xl-derived">{fmtNum(unAllocated)}</td>
                    <td colSpan={4} className="ctr" style={{ color: "#94a3b8" }}>我方承担，不摊给品牌</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── 柜子档案：普通表 / 共用表【都】可以录 ──
           · 普通表：这里的柜子数就是该表柜数
           · 共用表：没按品牌录分摊柜数时，系统就用这里的柜子数（后端按 cabinets 计数兜底，至少 1 柜）；
             按品牌录过分摊柜数的话，场地费平摊以分摊为准（避免双算） */}
      <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
        <span className="font-semibold text-slate-600">柜子（{(cabinets.data ?? []).length}）</span>
        {isShared ? (
          allocTotals.cabs > 0 ? (
            <span className="rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[10px] text-purple-700"
              title="该共用表本月品牌分摊里录了柜数 → 场地费/分红按分摊柜数算；下面的柜子档案作为台账明细保留">
              按品牌分摊已录 {allocTotals.cabs} 柜（场地费平摊以它为准）
            </span>
          ) : (
            <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
              title="共用表未按品牌录分摊柜数时，系统按这里挂的柜子数计费（至少 1 柜）">
              未按品牌录分摊柜数 → 以这里的柜子数为准
            </span>
          )
        ) : (
          <span className="text-slate-400">柜数只影响场地费平摊成本</span>
        )}
        {(cabinets.data ?? []).map((c: any) => (
          <span key={c.id} className="group flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600">
            {c.cabinetNo}
            <span className={c.cabinetType === "储电柜" ? "text-blue-500" : "text-emerald-500"}>{c.cabinetType}</span>
            <button className="text-slate-300 hover:text-emerald-600" title="编辑"
              onClick={() => { setEditCabinet(c); setCabinetFormOpen(true); }}><Pencil className="h-2.5 w-2.5" /></button>
            <button className="text-slate-300 hover:text-rose-500" title="删除"
              onClick={() => window.confirm("删除该柜子？") && delCabinet.mutate(c.id)}><Trash2 className="h-2.5 w-2.5" /></button>
          </span>
        ))}
        {(cabinets.data ?? []).length === 0 && <span className="text-slate-400">暂无柜子</span>}
        <button className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-emerald-400 hover:text-emerald-600"
          onClick={() => { setEditCabinet(null); setCabinetFormOpen(true); }}>+ 添加柜子</button>
        <CabinetForm
          open={cabinetFormOpen}
          onClose={() => { setCabinetFormOpen(false); setEditCabinet(null); }}
          meterId={meter.id}
          record={editCabinet}
        />
      </div>
    </div>
  );
}
function MeterForm({ open, onClose, record }: { open: boolean; onClose: () => void; record?: any }) {
  const { user } = useAuth();
  const tagScope = user?.meterTagScope || "";
  // ★V5：表单同时持有「大类（码值）」与「是否共用（布尔）」两个**互相独立**的字段
  const scopeCode = tagScope ? (TAG_TO_CODE[tagScope] || tagScope) : "";
  const blank = {
    brandId: "", brandContractId: "", landlordId: "", entityId: "", meterNo: "", meterName: "",
    collectorId: "", transformerRatio: "",
    categoryCode: scopeCode || "partner",   // 大类（码值）
    isShared: false,                        // 是不是"所有品牌共用一个表"
    deviceAddress: "", initialReading: "",
    remark: "",
  };
  const [f, setF] = useState(blank);
  const queryClient = useQueryClient();
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords, enabled: open });
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands, enabled: open });
  const contracts = useQuery({ queryKey: ["contracts"], queryFn: () => listContracts(), enabled: open });
  const entities = useQuery({ queryKey: ["entities"], queryFn: listEntities, enabled: open });
  // 编号唯一校验用（与列表页共用缓存，不额外发请求）
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters(), enabled: open });

  // 换主体确认：编辑时主体变了 → 列出有读数的月份，选择历史台账重算范围（生效月）
  const originalEntityId = record ? (record.entityId ? String(record.entityId) : "") : "";
  const [regenScope, setRegenScope] = useState<"all" | "current" | "period">("all");
  const [regenPeriod, setRegenPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const entityChanged = !!record && f.entityId !== originalEntityId;
  const affectedReadings = useQuery({
    queryKey: ["meterReadings", record?.meterNo],
    queryFn: () => getMeterReadings(record.meterNo),
    enabled: open && entityChanged && !!record?.meterNo,
  });
  const affectedPeriods: string[] = useMemo(
    () => ((affectedReadings.data ?? []) as any[]).map((r) => String(r.monthPeriod)).sort(),
    [affectedReadings.data]
  );

  useEffect(() => {
    if (!open) return;
    if (record) {
      setF({
        brandId: record.brandId ? String(record.brandId) : "",
        brandContractId: record.brandContractId ? String(record.brandContractId) : "",
        landlordId: record.landlordId ? String(record.landlordId) : "",
        entityId: record.entityId ? String(record.entityId) : "",
        meterNo: record.meterNo ?? "", meterName: record.meterName ?? "",
        collectorId: record.collectorId ?? "", transformerRatio: String(record.transformerRatio ?? ""),
        categoryCode: codeOf(record),
        isShared: isSharedOf(record),
        deviceAddress: record.deviceAddress ?? "",
        initialReading: record.initialReading != null ? String(record.initialReading) : "",
        remark: record.remark ?? "",
      });
      setRegenScope("all");
    } else setF(blank);
  }, [open, record]);

  const brandContracts = (contracts.data ?? []).filter((c: any) =>
    c.contractType === "品牌方合同" && c.landlordId === Number(f.landlordId) && c.brandId === Number(f.brandId)
  );
  useEffect(() => {
    if (!open || isShared || !f.landlordId || !f.brandId || brandContracts.length !== 1) return;
    if (f.brandContractId !== String(brandContracts[0].id)) setF((p) => ({ ...p, brandContractId: String(brandContracts[0].id) }));
  }, [open, isShared, f.landlordId, f.brandId, f.brandContractId, brandContracts]);

  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  // ★V5：「是否所有品牌共用一个表」= **表级属性**，与「电表大类」彻底解耦（不再联动）。
  // 由人工勾选，系统不做任何推导 —— 这正是「滇池两块被写错」的根治。
  const isShared = f.isShared;
  const toggleShared = (on: boolean) => {
    setF((p) => ({ ...p, isShared: on, brandId: on ? "" : p.brandId }));
  };

  const save = useMutation({
    mutationFn: (data: any) => record ? updateMeter(record.id, data) : createMeter(data),
    onSuccess: async () => {
      toast.success("电表已保存");
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      // 自动生成当月电费
      const period = toCompact(new Date().toISOString().slice(0, 7));
      generateElectricity({ period }).then(() => {
        queryClient.invalidateQueries({ queryKey: ["electricity"] });
      }).catch(() => {});
      onClose();
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message),
  });

  const submit = () => {
    const meterNo = f.meterNo.trim();
    if (!meterNo) { toast.error("请填写电表编号"); return; }
    // 编号唯一校验：已存在同号电表（编辑时排除自身）则不允许保存
    const dup = (meters.data ?? []).find((m: any) => m.meterNo === meterNo && m.id !== record?.id);
    if (dup) {
      const where = [dup.landlordName, dup.brandName].filter(Boolean).join(" · ") || "未关联场地";
      toast.error(`电表编号 ${meterNo} 已存在（${where}），不能重复使用`);
      return;
    }
    save.mutate({
      brandId: !isShared && f.brandId ? Number(f.brandId) : null,
      brandContractId: !isShared && f.brandContractId ? Number(f.brandContractId) : null,
      landlordId: f.landlordId ? Number(f.landlordId) : null,
      entityId: f.entityId ? Number(f.entityId) : null,
      ...(entityChanged ? {
        entityRegenerateFrom: regenScope,
        entityRegenerateFromPeriod: regenScope === "period" ? toCompact(regenPeriod) : undefined,
      } : {}),
      meterNo: meterNo,
      meterName: f.meterName.trim() || null,
      collectorId: f.collectorId.trim() || null,
      transformerRatio: f.transformerRatio ? Number(f.transformerRatio) : 1,
      // ★V5：大类走 categoryCode（码值）；「是否共用」是独立表级字段
      categoryCode: f.categoryCode || "partner",
      isShared: f.isShared,
      deviceAddress: f.deviceAddress.trim() || null,
      initialReading: f.initialReading.trim() === "" ? null : Number(f.initialReading),
      remark: f.remark.trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-4xl">
        <DialogHeader><DialogTitle>{record ? "编辑电表" : "新增电表"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {/* ── 第 1 行：归属（场地方 / 品牌 / 主体 / 大类）── */}
          <div className="grid grid-cols-4 gap-x-4 gap-y-3">
            <Field label="场地方 *">
              <SearchSelect value={f.landlordId} onChange={set("landlordId")} placeholder="选择 / 搜索场地方"
                options={(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))} />
            </Field>
            <Field label="品牌方">
              {isShared ? (
                <div className="rounded-md border border-purple-200 bg-purple-50 px-2.5 py-1.5 text-[13px] text-purple-700">
                  全部品牌方共用（无需选择）
                </div>
              ) : (
                <SearchSelect value={f.brandId} onChange={(v) => setF((p) => ({ ...p, brandId: v, brandContractId: "" }))} placeholder="未指定（可搜索）"
                  options={(brands.data ?? []).map((b: any) => ({ value: String(b.id), label: b.name }))} />
              )}
            </Field>
            <Field label="关联品牌合同">
              {isShared || !f.brandId ? (
                <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[12px] text-slate-400">共享表在品牌分摊中关联</div>
              ) : brandContracts.length === 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">该场地品牌暂无合同</div>
              ) : brandContracts.length === 1 ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[12px] text-emerald-700">
                  {brandContracts[0].contractName || `合同 #${brandContracts[0].id}`} · {brandContracts[0].electricityPrice ?? "未设电价"} 元/度（自动关联）
                </div>
              ) : (
                <SearchSelect value={f.brandContractId} onChange={set("brandContractId")} placeholder="选择该场地该品牌的合同"
                  options={brandContracts.map((c: any) => ({ value: String(c.id), label: `${c.startDate || "未设开始"} 至 ${c.earlyEndDate || c.endDate || "长期"} · ${c.electricityPrice ?? "未设电价"}元/度 · ${c.entityName || "未指定主体"}` }))} />
              )}
            </Field>
            <Field label="报税公司主体">
              <SearchSelect value={f.entityId} onChange={set("entityId")} placeholder="未指定（可搜索）"
                options={(entities.data ?? []).map((e: any) => ({ value: String(e.id), label: e.name }))} />
            </Field>
            <Field label="电表大类">
              {tagScope ? (
                <div className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[13px] text-violet-700">
                  {CATEGORY_LABEL[scopeCode] || tagScope}（账号范围）
                </div>
              ) : (
                <SelectInput value={f.categoryCode} onChange={set("categoryCode")}
                  options={CATEGORY_OPTIONS} />
              )}
            </Field>
          </div>

          {/* ── 共用开关（整行，紧凑单行）── */}
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <Switch checked={isShared} onCheckedChange={toggleShared} />
            <span className="text-[13px] font-medium text-slate-700">所有品牌共用此电表</span>
            <span className="text-[11px] text-slate-400">
              {isShared
                ? "「由哪几个品牌共享」在列表展开行 → 品牌分摊里录入"
                : "多个品牌共用同一块表（读数只有合计）时开启 · 与「电表大类」无关"}
            </span>
          </div>

          {/* ── 换主体提示（整行，仅在主体变化时出现）── */}
          {entityChanged && (
            <div className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
              <div className="font-semibold">更换公司主体将影响电费台账归属</div>
              {affectedReadings.isLoading ? (
                <div className="text-amber-600">正在检查该电表的历史读数…</div>
              ) : affectedPeriods.length > 0 ? (
                <div>
                  该电表有 {affectedPeriods.length} 个月读数（{affectedPeriods.slice(0, 4).map(toDisplay).join("、")}
                  {affectedPeriods.length > 4 ? " 等" : ""}），重算后这些月份的电费将按新主体归集
                </div>
              ) : (
                <div>该电表暂无历史读数，保存后不影响台账</div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-0.5">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" name="regenScope" className="accent-amber-600" checked={regenScope === "all"} onChange={() => setRegenScope("all")} />
                  全部历史重算（推荐）
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" name="regenScope" className="accent-amber-600" checked={regenScope === "current"} onChange={() => setRegenScope("current")} />
                  仅从本月起
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" name="regenScope" className="accent-amber-600" checked={regenScope === "period"} onChange={() => setRegenScope("period")} />
                  从指定月起
                </label>
                {regenScope === "period" && (
                  <input type="month" className="rounded border border-amber-300 px-2 py-0.5 text-[11px]"
                    value={regenPeriod} onChange={(e) => setRegenPeriod(e.target.value)} />
                )}
              </div>
            </div>
          )}

          {/* ── 第 2 行：编号 / 名称 / 采集器 / 设备地址 ── */}
          <div className="grid grid-cols-4 gap-x-4 gap-y-3">
            <Field label="电表编号 *"><TextInput value={f.meterNo} onChange={set("meterNo")} /></Field>
            <Field label="电表名称"><TextInput value={f.meterName} onChange={set("meterName")} /></Field>
            <Field label="采集器号"><TextInput value={f.collectorId} onChange={set("collectorId")} /></Field>
            <Field label="设备地址（第三方）">
              <TextInput value={f.deviceAddress} onChange={set("deviceAddress")} placeholder="留空 = 自建无设备" />
            </Field>
            <Field label="投运起始表码">
              <NumInput value={f.initialReading} onChange={set("initialReading")} placeholder="换表时新表起始读数" />
            </Field>
            <Field label="互感器倍数"><NumInput value={f.transformerRatio} onChange={set("transformerRatio")} placeholder="1" /></Field>
            <Field label="备注"><TextInput value={f.remark} onChange={set("remark")} /></Field>
          </div>

          <div className="-mt-1 text-[11px] leading-relaxed text-slate-400">
            读数同步按「设备地址」对上电表 —— <b>改电表编号不会丢读数</b>（编号是给人看的）；
            「大类」= 分给哪个财务管的职责分组，不参与任何计算；
            实际电量 = 表码 × 互感器倍数（历史月份按读数时的快照倍数算）。
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={save.isPending} onClick={submit}>保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CabinetForm({ open, onClose, meterId, record }: { open: boolean; onClose: () => void; meterId: number; record?: any }) {
  const blank = { cabinetNo: "", cabinetType: "充电柜", count: "1", remark: "" };
  const [f, setF] = useState(blank);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    if (record) {
      setF({
        cabinetNo: record.cabinetNo ?? "",
        cabinetType: record.cabinetType ?? "普通柜",
        count: "1",
        remark: record.remark ?? "",
      });
    } else setF(blank);
  }, [open, record]);

  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: async (data: any) => {
      if (record) {
        // 编辑模式：更新单个柜子
        return updateCabinet(record.id, data);
      } else {
        // 新增模式：批量创建柜子
        const count = parseInt(data.count) || 1;
        const baseNo = data.cabinetNo;
        const results = [];
        for (let i = 0; i < count; i++) {
          const cabinetNo = count === 1 ? baseNo : `${baseNo}-${String(i + 1).padStart(2, '0')}`;
          const result = await createCabinet({
            meterId: data.meterId,
            cabinetNo,
            cabinetType: data.cabinetType,
            remark: data.remark,
          });
          results.push(result);
        }
        return results;
      }
    },
    onSuccess: () => { toast.success("柜子已保存"); queryClient.invalidateQueries({ queryKey: ["cabinets"] }); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  const submit = () => {
    if (!f.cabinetNo.trim()) { toast.error("请填写柜子编号"); return; }
    save.mutate({
      meterId,
      cabinetNo: f.cabinetNo.trim(),
      cabinetType: f.cabinetType,
      count: f.count,
      remark: f.remark.trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{record ? "编辑柜子" : "添加柜子"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="柜子编号 *"><TextInput value={f.cabinetNo} onChange={set("cabinetNo")} placeholder="如：C001" /></Field>
          <Field label="柜子类型">
            <SelectInput value={f.cabinetType} onChange={set("cabinetType")}
              options={[{ value: "充电柜", label: "充电柜" }, { value: "储电柜", label: "储电柜" }]} />
          </Field>
          {!record && (
            <Field label="柜子数量"><NumInput value={f.count} onChange={set("count")} placeholder="1" /></Field>
          )}
          <Field label="备注"><TextInput value={f.remark} onChange={set("remark")} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={save.isPending} onClick={submit}>
              {record ? "保存" : `添加${parseInt(f.count) > 1 ? ` (${f.count}个)` : ""}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
