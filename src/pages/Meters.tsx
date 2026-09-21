import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listMeters, createMeter, updateMeter, deleteMeter, importMetersExcel } from "@/api/meters";
import { listContracts } from "@/api/contracts";
import { listCabinets, createCabinet, updateCabinet, deleteCabinet } from "@/api/cabinets";
import { listBrands, listLandlords, listEntities } from "@/api/directory";
import { generateElectricity } from "@/api/electricity";
import { triggerSync, saveMeterReading, getMeterReadings, getSharedAllocationForm, saveSharedAllocations } from "@/api/meterEnergy";
import { StatusBadge } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Field, NumInput, TextInput, SelectInput, SearchSelect, inputCls } from "@/components/fields";
import { exportXlsx } from "@/lib/export";
import { fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { Download, Search, Plus, Pencil, Trash2, Gauge, ChevronDown, ChevronRight, RefreshCw, BookOpen, Upload } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/providers/auth";

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
  const [tag, setTag] = useState(tagScope);
  const [formOpen, setFormOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<any>(null);
  const [expandedMeterId, setExpandedMeterId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const [highlightCabinet, setHighlightCabinet] = useState(false);
  const [readingMeter, setReadingMeter] = useState<any>(null);
  const syncLimit = useSyncLimit();
  const lastClickRef = useRef(0);
  const cooldownRef = useRef(false);

  // 从 URL 参数读取跳转信息
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const landlord = params.get("landlord");
    const brand = params.get("brand");
    const highlight = params.get("highlight");
    const meter = params.get("meter");
    if (landlord) setLandlordId(landlord);
    if (brand) setBrandId(brand);
    if (highlight === "cabinet") {
      setHighlightCabinet(true);
      // 5秒后取消高亮
      setTimeout(() => setHighlightCabinet(false), 5000);
    }
    if (meter) setKeyword(meter); // 直达某块电表：预填搜索框
    // 清除 URL 参数
    if (landlord || brand || highlight || meter) {
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

  const del = useMutation({
    mutationFn: deleteMeter,
    onSuccess: () => { toast.success("已删除"); queryClient.invalidateQueries({ queryKey: ["meters"] }); },
  });

  const rows = useMemo(() => {
    let data = meters.data ?? [];
    if (keyword) data = data.filter((m: any) =>
      m.meterNo?.includes(keyword) || m.stationName?.includes(keyword) ||
      m.meterName?.includes(keyword) || m.landlordName?.includes(keyword)
    );
    if (landlordId) data = data.filter((m: any) => m.landlordId === Number(landlordId));
    if (brandId) data = brandId === "shared"
      ? data.filter((m: any) => m.tag === "共享电表")
      : data.filter((m: any) => m.brandId === Number(brandId));
    if (tag) data = data.filter((m: any) => m.tag === tag);
    return data;
  }, [meters.data, keyword, landlordId, brandId, tag]);

  // 按场地方分组
  const groupedByLandlord = useMemo(() => {
    const groups = new Map<number, any>();
    for (const r of rows) {
      const lid = r.landlordId || 0;
      if (!groups.has(lid)) {
        groups.set(lid, {
          landlordId: lid,
          landlordName: r.landlordName || "未设置场地方",
          meters: [],
        });
      }
      groups.get(lid).meters.push(r);
    }
    return [...groups.values()];
  }, [rows]);

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
        场地方: m.landlordName ?? "", 品牌方: m.brandName ?? (m.tag === "共享电表" ? "全品牌共享" : ""), 电表编号: m.meterNo,
        电表名称: m.meterName ?? "", 标签: m.tag ?? "合作商电表", 采集器号: m.collectorId ?? "",
        互感器倍数: fmtNum(m.transformerRatio), 状态: m.status,
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
          <input className={`${inputCls} w-56 pl-8`} placeholder="搜索电表编号 / 场地方…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <div className="w-40">
          <SearchSelect value={landlordId} onChange={setLandlordId} placeholder="全部场地方"
            options={(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))} />
        </div>
        <div className="w-40">
          <SearchSelect value={brandId} onChange={setBrandId} placeholder="全部品牌方"
            options={[
              { value: "shared", label: "共享电表（全品牌）" },
              ...(brands.data ?? []).map((b: any) => ({ value: String(b.id), label: b.name })),
            ]} />
        </div>
        {tagScope ? (
          <select className={`${inputCls} w-36`} value={tagScope} disabled title="当前账号的数据范围">
            <option value={tagScope}>{tagScope}</option>
          </select>
        ) : (
          <select className={`${inputCls} w-36`} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">全部标签</option>
            <option value="合作商电表">合作商电表</option>
            <option value="民用电表">民用电表</option>
            <option value="共享电表">共享电表</option>
          </select>
        )}
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

      {/* 按场地方分组展示 */}
      <div className="space-y-4">
        {groupedByLandlord.map((group: any) => {
          // 从 contracts 跳转过来时，自动展开第一个匹配的电表
          const isTargetGroup = highlightCabinet && landlordId && group.landlordId === Number(landlordId);
          if (isTargetGroup && expandedMeterId === null && group.meters.length > 0) {
            // 延迟展开，避免 setState during render
            setTimeout(() => setExpandedMeterId(group.meters[0].id), 100);
          }

          return (
            <div key={group.landlordId} className="rounded-xl border bg-white shadow-sm">
              <div className="border-b px-5 py-3 flex items-center gap-2">
                <Gauge className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-semibold text-slate-700">{group.landlordName}</span>
                <span className="text-xs text-slate-400">（{group.meters.length} 个电表）</span>
              </div>
              <div className="p-3 space-y-2">
                {group.meters.map((m: any) => (
                  <MeterCard
                    key={m.id}
                    meter={m}
                    isExpanded={expandedMeterId === m.id}
                    onToggle={() => toggleExpand(m.id)}
                    onEdit={() => { setEditRecord(m); setFormOpen(true); }}
                    onDelete={() => window.confirm("删除该电表？") && del.mutate(m.id)}
                    onReading={() => setReadingMeter(m)}
                    highlightCabinet={!!(isTargetGroup && expandedMeterId === m.id)}
                    entityMismatchHint={entityMismatchHint[m.id]}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {groupedByLandlord.length === 0 && (
          <div className="rounded-xl border border-dashed py-16 text-center text-slate-400">
            {meters.isLoading ? "加载中…" : "暂无电表数据"}
          </div>
        )}
      </div>

      <MeterForm open={formOpen} onClose={() => { setFormOpen(false); setEditRecord(null); }} record={editRecord} />

      {/* 录入读数弹窗 */}
      <ReadingForm open={!!readingMeter} onClose={() => setReadingMeter(null)} meter={readingMeter} />

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

// ─── 电表卡片组件 ───
function MeterCard({ meter, isExpanded, onToggle, onEdit, onDelete, onReading, highlightCabinet, entityMismatchHint }: {
  meter: any; isExpanded: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void; onReading: () => void; highlightCabinet?: boolean; entityMismatchHint?: string;
}) {
  const queryClient = useQueryClient();
  const cabinets = useQuery({
    queryKey: ["cabinets", meter.id],
    queryFn: () => listCabinets({ meterId: meter.id }),
    enabled: isExpanded,
  });

  const [cabinetFormOpen, setCabinetFormOpen] = useState(false);
  const [editCabinet, setEditCabinet] = useState<any>(null);

  const delCabinet = useMutation({
    mutationFn: deleteCabinet,
    onSuccess: () => { toast.success("已删除"); queryClient.invalidateQueries({ queryKey: ["cabinets"] }); },
  });

  return (
    <div className="rounded-lg border bg-slate-50/50">
      {/* 电表头部 */}
      <div
        className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-slate-100/50"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          {isExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-medium">{meter.meterNo}</span>
              <span className={`text-xs ${!meter.brandName && meter.tag === "共享电表" ? "font-medium text-purple-600" : "text-slate-500"}`}>
                {meter.brandName ?? (meter.tag === "共享电表" ? "全品牌共享" : "未设置品牌")}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${meter.tag === "民用电表" ? "bg-amber-100 text-amber-700" : meter.tag === "共享电表" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                {meter.tag ?? "合作商电表"}
              </span>
              {meter.source === "synced" && (
                <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] text-teal-700" title="已接入第三方电表平台（天雀）同步读数">第三方</span>
              )}
              <StatusBadge status={meter.status} />
            </div>
            <div className="text-[11px] text-slate-400">{meter.meterName ?? ""}</div>
            {entityMismatchHint && (
              <div className="text-[11px] text-amber-600">{entityMismatchHint}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">互感器倍数：{fmtNum(meter.transformerRatio)}</span>
          <span className="text-xs text-slate-400">柜数：{cabinets.data ? Math.max(1, cabinets.data.length) : 1}</span>
          <button className="rounded p-1 text-slate-400 hover:text-blue-600" onClick={(e) => { e.stopPropagation(); onReading(); }} title="录入读数"><BookOpen className="h-3.5 w-3.5" /></button>
          <button className="rounded p-1 text-slate-400 hover:text-emerald-600" onClick={(e) => { e.stopPropagation(); onEdit(); }}><Pencil className="h-3.5 w-3.5" /></button>
          <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {/* 展开内容：柜子列表 */}
      {isExpanded && (
        <div className="border-t px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-600">柜子列表（{Math.max(1, (cabinets.data ?? []).length)} 个）</span>
            <Button
              size="sm"
              variant="outline"
              className={highlightCabinet ? "ring-2 ring-rose-400 border-rose-400 text-rose-600 animate-breath" : ""}
              onClick={() => { setEditCabinet(null); setCabinetFormOpen(true); }}
            >
              <Plus className="mr-1 h-3 w-3" />添加柜子
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-white">
                  <th className="px-2.5 py-1.5 text-left font-medium text-slate-500">柜子编号</th>
                  <th className="px-2.5 py-1.5 text-left font-medium text-slate-500">柜子类型</th>
                  <th className="px-2.5 py-1.5 text-left font-medium text-slate-500">备注</th>
                  <th className="px-2.5 py-1.5 text-center font-medium text-slate-500">操作</th>
                </tr>
              </thead>
              <tbody>
                {(cabinets.data ?? []).map((c: any) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-white/50">
                    <td className="px-2.5 py-1.5 font-medium">{c.cabinetNo}</td>
                    <td className="px-2.5 py-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${c.cabinetType === "储电柜" ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"}`}>
                        {c.cabinetType}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-500">{c.remark ?? "-"}</td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex justify-center gap-0.5">
                        <button className="rounded p-1 text-slate-400 hover:text-emerald-600" onClick={() => { setEditCabinet(c); setCabinetFormOpen(true); }}><Pencil className="h-3 w-3" /></button>
                        <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => window.confirm("删除？") && delCabinet.mutate(c.id)}><Trash2 className="h-3 w-3" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {(cabinets.data ?? []).length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-slate-400">暂无柜子，点击"添加柜子"添加</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <CabinetForm
        open={cabinetFormOpen}
        onClose={() => { setCabinetFormOpen(false); setEditCabinet(null); }}
        meterId={meter.id}
        record={editCabinet}
      />
    </div>
  );
}

// ─── 电表表单 ───
function MeterForm({ open, onClose, record }: { open: boolean; onClose: () => void; record?: any }) {
  const { user } = useAuth();
  const tagScope = user?.meterTagScope || "";
  const blank = { brandId: "", landlordId: "", entityId: "", meterNo: "", meterName: "", collectorId: "", transformerRatio: "", tag: tagScope || "合作商电表", remark: "" };
  const [f, setF] = useState(blank);
  const queryClient = useQueryClient();
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords, enabled: open });
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands, enabled: open });
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
        landlordId: record.landlordId ? String(record.landlordId) : "",
        entityId: record.entityId ? String(record.entityId) : "",
        meterNo: record.meterNo ?? "", meterName: record.meterName ?? "",
        collectorId: record.collectorId ?? "", transformerRatio: String(record.transformerRatio ?? ""),
        tag: record.tag ?? (tagScope || "合作商电表"), remark: record.remark ?? "",
      });
      setRegenScope("all");
    } else setF(blank);
  }, [open, record]);

  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  // 全品牌共享：标签=共享电表 即视为共享，开关与「标签」下拉双向联动。
  // 数据范围限定为「共享电表」时开关锁定为开；限定其他类型时不可开启（无法建共享表）。
  const isShared = f.tag === "共享电表";
  const sharedLockedOn = tagScope === "共享电表";
  const sharedHidden = !!tagScope && tagScope !== "共享电表";
  const toggleShared = (on: boolean) => {
    setF((p) => ({
      ...p,
      tag: on ? "共享电表" : (p.tag === "共享电表" ? (tagScope || "合作商电表") : p.tag),
      brandId: on ? "" : p.brandId,
    }));
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
      tag: f.tag || "合作商电表",
      remark: f.remark.trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{record ? "编辑电表" : "新增电表"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="场地方 *">
            <SearchSelect value={f.landlordId} onChange={set("landlordId")} placeholder="请选择或搜索场地方"
              options={(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))} />
          </Field>
          <div className="-mt-2 text-[11px] text-slate-400">
            v3：电表直接归属场地方 + 品牌方（不再经站点）。
          </div>
          {/* 全品牌共享开关：场地内所有品牌共用一块电表时开启，无需选择品牌方 */}
          {!sharedHidden && (
            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <Switch checked={isShared} onCheckedChange={toggleShared} disabled={sharedLockedOn} />
              <div>
                <div className="text-sm text-slate-700">所有品牌共用此电表</div>
                <div className="text-[11px] text-slate-400">
                  {sharedLockedOn
                    ? "当前账号的数据范围限定为「共享电表」，此开关保持开启"
                    : "开启后无需选择品牌方（标签自动记为「共享电表」），适用于场地内各品牌共用的总表"}
                </div>
              </div>
            </div>
          )}
          <Field label="品牌方">
            {isShared ? (
              <div className="rounded-md border border-purple-200 bg-purple-50 px-2.5 py-1.5 text-sm text-purple-700">
                全部品牌方共用（无需选择）
              </div>
            ) : (
              <SearchSelect value={f.brandId} onChange={set("brandId")} placeholder="未指定（可搜索品牌方）"
                options={(brands.data ?? []).map((b: any) => ({ value: String(b.id), label: b.name }))} />
            )}
          </Field>
          <Field label="报税公司主体">
            <SearchSelect value={f.entityId} onChange={set("entityId")} placeholder="未指定（可搜索公司主体）"
              options={(entities.data ?? []).map((e: any) => ({ value: String(e.id), label: e.name }))} />
          </Field>
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
          <Field label="电表编号 *"><TextInput value={f.meterNo} onChange={set("meterNo")} /></Field>
          <Field label="电表名称"><TextInput value={f.meterName} onChange={set("meterName")} /></Field>
          <Field label="标签">
            {tagScope ? (
              <div className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-sm text-violet-700">
                {tagScope}（当前账号数据范围）
              </div>
            ) : (
              <SelectInput value={f.tag} onChange={set("tag")}
                options={[
                  { value: "合作商电表", label: "合作商电表" },
                  { value: "民用电表", label: "民用电表" },
                  { value: "共享电表", label: "共享电表" },
                ]} />
            )}
          </Field>
          <Field label="采集器号"><TextInput value={f.collectorId} onChange={set("collectorId")} /></Field>
          <Field label="互感器倍数"><NumInput value={f.transformerRatio} onChange={set("transformerRatio")} placeholder="1" /></Field>
          <Field label="备注"><TextInput value={f.remark} onChange={set("remark")} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={save.isPending} onClick={submit}>保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── 录入读数表单 ───
// 共享电表（「所有品牌共用此电表」）额外支持按品牌录入「应付电费」：
//   录入值 = 品牌方付给我方的电费（收款/收入，含税）；用电量 = 金额 ÷ 单价 倒推。
//   该表某月录了品牌分摊后，台账不再按「整表读数 × 合同单价」出一行，而是按品牌拆行。
function ReadingForm({ open, onClose, meter }: { open: boolean; onClose: () => void; meter: any }) {
  const now = new Date();
  const defaultPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [monthPeriod, setMonthPeriod] = useState(defaultPeriod);
  const [kwh, setKwh] = useState("");
  const [actualKwh, setActualKwh] = useState(""); // 实际值（可选，填了优先用）
  const [prevActualReading, setPrevActualReading] = useState(""); // 上月实际电表读数（人工填，同步不覆盖）
  const [currActualReading, setCurrActualReading] = useState(""); // 本月实际电表读数（人工填，同步不覆盖）
  const [prevReadingDate, setPrevReadingDate] = useState("");
  const [prevReading, setPrevReading] = useState("");
  const [currReadingDate, setCurrReadingDate] = useState("");
  const [currReading, setCurrReading] = useState("");
  const [calcKwh, setCalcKwh] = useState(true); // 是否自动计算区间度数
  const queryClient = useQueryClient();

  // 共享电表：标签为「共享电表」且未指定品牌方（=「所有品牌共用此电表」开关打开的状态）
  const isShared = !!meter && meter.tag === "共享电表" && !meter.brandId;
  // 品牌分摊行（unitPrice 留空 = 用该品牌方合同单价；cabinetCount 留空 = 本月未填柜数）
  const [allocRows, setAllocRows] = useState<
    { brandId: string; collectAmount: string; unitPrice: string; cabinetCount: string }[]
  >([]);
  // 整表度数手动补录（共享电表：第三方未同步，或需人工修正物理读数时用）
  const [editingTableKwh, setEditingTableKwh] = useState(false);
  const [manualKwh, setManualKwh] = useState("");

  // 加载该电表已有的读数
  const readings = useQuery({
    queryKey: ["meterReadings", meter?.meterNo],
    queryFn: () => getMeterReadings(meter.meterNo),
    // 共享电表也加载读数：输入区已隐藏，读数仅用于核对「整表度数 vs 分摊倒推合计」
    enabled: open && !!meter?.meterNo,
  });

  // 共享电表：加载品牌分摊表单数据（候选品牌 + 合同单价 + 已录入分摊）
  const allocForm = useQuery({
    queryKey: ["shared-allocations", meter?.meterNo, monthPeriod],
    queryFn: () => getSharedAllocationForm({ meterNo: meter.meterNo, monthPeriod }),
    enabled: open && isShared && !!meter?.meterNo && !!monthPeriod,
  });

  // 电柜数量默认值：该品牌最近一次填写值（柜数逐月可动态调整）
  // 仅在某月「尚无分摊记录」时用于预填；已录入月份严格回填已存值（清空就是清空）
  const cabinetDefaultOf = (brandId: string): { count: number; monthPeriod: string } | null => {
    const d = allocForm.data?.cabinetDefaults?.[String(brandId)];
    return d && d.count != null ? { count: Number(d.count), monthPeriod: d.monthPeriod } : null;
  };

  // 分摊数据回填：切换到已有分摊的月份 → 填已录入值；没有则预填该场地已签合同的品牌（金额留空）
  // 电柜数量：没有分摊记录的月份，用该品牌最近一次填写值预填（本月改了 → 下月默认就是新值）
  useEffect(() => {
    const d = allocForm.data;
    if (!open || !isShared || !d || d.monthPeriod !== monthPeriod) return;
    if ((d.allocations ?? []).length > 0) {
      setAllocRows(d.allocations.map((a: any) => ({
        brandId: String(a.brandId),
        collectAmount: a.collectAmount != null ? String(a.collectAmount) : "",
        // 只有「人工覆盖价」才回填输入框；合同价留在 placeholder 里动态取
        unitPrice: a.unitPrice != null ? String(a.unitPrice) : "",
        cabinetCount: a.cabinetCount != null ? String(a.cabinetCount) : "",
      })));
    } else {
      setAllocRows(((d.brands ?? []) as any[]).map((b) => {
        const def = cabinetDefaultOf(String(b.brandId));
        return {
          brandId: String(b.brandId), collectAmount: "", unitPrice: "",
          cabinetCount: def ? String(def.count) : "",
        };
      }));
    }
  }, [allocForm.data, monthPeriod, open, isShared]);

  // 切换月份时自动填充已有数据
  useEffect(() => {
    if (!readings.data || !monthPeriod) {
      setKwh("");
      setActualKwh("");
      setPrevActualReading("");
      setCurrActualReading("");
      setPrevReadingDate("");
      setPrevReading("");
      setCurrReadingDate("");
      setCurrReading("");
      return;
    }
    const existing = readings.data.find((r: any) => r.monthPeriod === monthPeriod);
    if (existing) {
      // 回填原始表码度数（kwh 已是实际度数 = 表码 × 倍数，编辑用 rawKwh 避免二次相乘）
      setKwh(existing.rawKwh != null ? String(existing.rawKwh) : existing.kwh ? String(existing.kwh) : "");
      setActualKwh(existing.actualKwh != null ? String(existing.actualKwh) : "");
      setPrevActualReading(existing.prevActualReading != null ? String(existing.prevActualReading) : "");
      setCurrActualReading(existing.currActualReading != null ? String(existing.currActualReading) : "");
      setPrevReadingDate(existing.prevReadingDate || "");
      setPrevReading(existing.prevReading ? String(existing.prevReading) : "");
      setCurrReadingDate(existing.currReadingDate || "");
      setCurrReading(existing.currReading ? String(existing.currReading) : "");
    } else {
      setKwh("");
      setActualKwh("");
      setPrevActualReading("");
      setCurrActualReading("");
      setPrevReadingDate("");
      setPrevReading("");
      setCurrReadingDate("");
      setCurrReading("");
    }
  }, [readings.data, monthPeriod]);

  useEffect(() => {
    if (open) {
      setMonthPeriod(defaultPeriod);
      setEditingTableKwh(false);
      setManualKwh("");
    }
  }, [open]);

  // 自动计算区间度数
  useEffect(() => {
    if (calcKwh && prevReading && currReading) {
      const diff = parseFloat(currReading) - parseFloat(prevReading);
      if (!isNaN(diff) && diff >= 0) {
        setKwh(String(diff));
      }
    }
  }, [prevReading, currReading, calcKwh]);

  // ── 品牌分摊辅助计算 ──
  const contractPriceOf = (brandId: string): number | null => {
    const b = (allocForm.data?.brands ?? []).find((x: any) => String(x.brandId) === String(brandId));
    return b?.unitPrice != null ? Number(b.unitPrice) : null;
  };
  const effectivePriceOf = (row: { brandId: string; unitPrice: string }): number | null => {
    if (row.unitPrice.trim() !== "") {
      const p = parseFloat(row.unitPrice);
      return !isNaN(p) && p > 0 ? p : null;
    }
    return contractPriceOf(row.brandId);
  };
  const kwhOfRow = (row: { brandId: string; collectAmount: string; unitPrice: string }): number | null => {
    const amount = parseFloat(row.collectAmount);
    const price = effectivePriceOf(row);
    if (isNaN(amount) || !price) return null;
    return Math.round((amount / price) * 100) / 100;
  };
  // 候选品牌：该场地已签品牌方合同的品牌在前，其余品牌可手动添加
  const brandOptions = useMemo(() => {
    const withContract = (allocForm.data?.brands ?? []).map((b: any) => ({
      value: String(b.brandId), label: b.unitPrice != null ? `${b.brandName}（合同价 ${b.unitPrice}）` : b.brandName,
    }));
    const used = new Set(withContract.map((o: { value: string }) => o.value));
    const rest = (allocForm.data?.allBrands ?? [])
      .filter((b: any) => !used.has(String(b.brandId)))
      .map((b: any) => ({ value: String(b.brandId), label: b.brandName }));
    return [...withContract, ...rest];
  }, [allocForm.data]);
  // 合计（行数很少，直接算，不走 memo）
  const allocTotals = (() => {
    let amount = 0, kwhSum = 0, missingPrice = 0, cabinets = 0, cabinetsFilled = 0;
    for (const r of allocRows) {
      const a = parseFloat(r.collectAmount);
      if (isNaN(a) || String(r.collectAmount).trim() === "") continue;
      amount += a;
      const k = kwhOfRow(r);
      if (k == null) missingPrice += 1;
      else kwhSum += k;
      const cc = parseInt(r.cabinetCount, 10);
      if (!isNaN(cc) && cc > 0) { cabinets += cc; cabinetsFilled += 1; }
    }
    return {
      amount: Math.round(amount * 100) / 100,
      kwh: Math.round(kwhSum * 100) / 100,
      missingPrice,
      cabinets,
      cabinetsFilled,
    };
  })();

  // ── 共享电表核对：第三方同步的整表月度实际度数 vs 品牌分摊倒推合计 ──
  // 台账按「倒推电量 × 场地单价」付场地方，若与物理整表读数不一致，
  // 差额（线损 / 公摊 / 漏报品牌）在账上无人承担，这里把它显性化。
  const tableRow = (isShared && monthPeriod)
    ? (readings.data ?? []).find((r: any) => r.monthPeriod === monthPeriod)
    : undefined;
  const tableKwhValue = tableRow?.kwh != null ? Number(tableRow.kwh) : null;
  const tableKwh = tableKwhValue != null && !isNaN(tableKwhValue) && tableKwhValue > 0 ? tableKwhValue : null;
  // actual_kwh 非空 = 人工补录/修正（该字段不随第三方同步覆盖）
  const tableKwhIsManual = tableRow?.actualKwh != null;
  // >0：整表多于分摊倒推（有电量没人认领）；<0：分摊倒推超出物理读数
  const kwhGap = tableKwh != null && allocTotals.amount > 0
    ? Math.round((tableKwh - allocTotals.kwh) * 100) / 100
    : null;

  // 切换月份：同时退出「整表读数补录」编辑态，避免残留上个月的输入
  const changeMonth = (p: string) => {
    setMonthPeriod(p);
    setEditingTableKwh(false);
    setManualKwh("");
  };

  const setAllocRow = (
    i: number,
    patch: Partial<{ brandId: string; collectAmount: string; unitPrice: string; cabinetCount: string }>,
  ) => setAllocRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addAllocRow = () => setAllocRows((prev) => [
    ...prev, { brandId: "", collectAmount: "", unitPrice: "", cabinetCount: "" },
  ]);
  const removeAllocRow = (i: number) => setAllocRows((prev) => prev.filter((_, idx) => idx !== i));

  // 是否有填了金额的分摊行（用于决定保存按钮可用性 / 是否需要调分摊接口）
  const allocAmountRows = allocRows.filter((r) => r.brandId && String(r.collectAmount).trim() !== "");
  const hasReadingInput = !!(kwh || actualKwh || prevReading || currReading || prevActualReading || currActualReading);
  // 共享电表读数区已隐藏，保存可用性只看分摊是否改动（含「清空全部金额」这种取消分摊的改动）
  const savedAllocKey = ((allocForm.data?.allocations ?? []) as any[])
    .map((a) => `${a.brandId}:${Number(a.collectAmount ?? 0).toFixed(2)}:`
      + `${a.cabinetCount != null ? Number(a.cabinetCount) : ""}`)
    .sort().join("|");
  const currentAllocKey = allocAmountRows
    .map((r) => `${r.brandId}:${parseFloat(r.collectAmount).toFixed(2)}:`
      + `${r.cabinetCount.trim() === "" ? "" : parseInt(r.cabinetCount, 10)}`)
    .sort().join("|");
  const allocDirty = currentAllocKey !== savedAllocKey;
  const canSave = isShared ? allocDirty : hasReadingInput;

  const save = useMutation({
    mutationFn: async () => {
      if (isShared) {
        // 单价校验：填了金额但取不到单价 → 无法倒推用电量
        const bad = allocAmountRows.find((r) => effectivePriceOf(r) == null);
        if (bad) {
          const name = brandOptions.find((o) => o.value === bad.brandId)?.label || "某品牌";
          throw new Error(`${name} 缺少单价，无法倒推用电量：请填写单价或先维护该品牌方合同的电费单价`);
        }
        // 电柜数量校验：留空 = 本月未填；填了必须是正整数
        const badCabinet = allocAmountRows.find((r) => {
          const t = r.cabinetCount.trim();
          if (t === "") return false;
          const n = Number(t);
          return !Number.isInteger(n) || n <= 0;
        });
        if (badCabinet) {
          const name = brandOptions.find((o) => o.value === badCabinet.brandId)?.label || "某品牌";
          throw new Error(`${name} 的电柜数量需为大于 0 的整数（留空表示本月未填）`);
        }
      }
      // 1) 有读数输入才写读数（共享电表不录读数；只录分摊时不产生 0 度读数）
      if (hasReadingInput && !isShared) {
        await saveMeterReading({
          address: meter.meterNo,
          monthPeriod,
          kwh: kwh ? parseFloat(kwh) : undefined,
          actualKwh: actualKwh ? parseFloat(actualKwh) : undefined,
          prevActualReading: prevActualReading ? parseFloat(prevActualReading) : undefined,
          currActualReading: currActualReading ? parseFloat(currActualReading) : undefined,
          prevReadingDate: prevReadingDate || undefined,
          prevReading: prevReading ? parseFloat(prevReading) : undefined,
          currReadingDate: currReadingDate || undefined,
          currReading: currReading ? parseFloat(currReading) : undefined,
        });
      }
      // 2) 共享电表：整体替换该月品牌分摊（含空 = 清空），后端保存后自动重算该月台账
      if (isShared) {
        await saveSharedAllocations({
          address: meter.meterNo,
          monthPeriod,
          rows: allocAmountRows.map((r) => ({
            brandId: Number(r.brandId),
            collectAmount: parseFloat(r.collectAmount),
            unitPrice: r.unitPrice.trim() === "" ? null : parseFloat(r.unitPrice),
            cabinetCount: r.cabinetCount.trim() === "" ? null : parseInt(r.cabinetCount, 10),
          })),
        });
      }
    },
    onSuccess: async () => {
      toast.success(isShared ? "品牌分摊已保存，台账已按分摊重算" : "读数已保存");
      try {
        if (!isShared && hasReadingInput) {
          // v3：台账按场地×品牌全量重算该月
          await generateElectricity({ period: monthPeriod, landlordId: meter.landlordId || undefined });
        }
        queryClient.invalidateQueries({ queryKey: ["electricity"] });
        queryClient.invalidateQueries({ queryKey: ["electricity-monthly-ledger-range"] });
        queryClient.invalidateQueries({ queryKey: ["shared-allocations"] });
        queryClient.invalidateQueries({ queryKey: ["meterReadings"] });
      } catch {}
      onClose();
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message || "保存失败"),
  });

  // 整表度数手动补录：写 meter_monthly.actual_kwh（该字段不随第三方同步覆盖）
  // 共享电表未录分摊的月份，台账会用这个度数；录了分摊的月份它只作核对基准
  const saveTableKwh = useMutation({
    mutationFn: async () => {
      const v = parseFloat(manualKwh);
      if (isNaN(v) || v <= 0) throw new Error("请填写大于 0 的整表实际度数");
      // 回传现有原始表码：后端 kwh 必填且 ON CONFLICT 覆盖，不传会把第三方原始读数冲成 0
      const rawKwh = tableRow?.rawKwh != null ? Number(tableRow.rawKwh) : undefined;
      await saveMeterReading({ address: meter.meterNo, monthPeriod, kwh: rawKwh, actualKwh: v });
    },
    onSuccess: async () => {
      setEditingTableKwh(false);
      setManualKwh("");
      queryClient.invalidateQueries({ queryKey: ["meterReadings"] });
      // 读数变了 → 重算该月台账（未录分摊的月份完全依赖它）
      try {
        await generateElectricity({ period: monthPeriod, landlordId: meter.landlordId || undefined });
      } catch {
        // 重算失败不影响读数已保存，用户可稍后在电费台账页手动重跑
      }
      queryClient.invalidateQueries({ queryKey: ["electricity"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-monthly-ledger-range"] });
      toast.success("整表读数已保存");
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || e.message || "保存失败"),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={`${isShared ? "!max-w-3xl" : "max-w-md"} max-h-[90vh] overflow-y-auto`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-blue-600" />
            {isShared ? "共享电表 · 品牌分摊（按应付电费倒推）" : "录入电表读数"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div>表号：<span className="font-mono font-medium">{meter?.meterNo}</span></div>
            <div>名称：{meter?.meterName ?? "-"}</div>
            {isShared && (
              <div className="mt-1 text-purple-600">所有品牌共用此电表（场地总表）</div>
            )}
          </div>

          <Field label="月份">
            <input type="month" className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm"
              value={monthPeriod ? toDisplay(monthPeriod) : ""}
              onChange={(e) => changeMonth(e.target.value ? toCompact(e.target.value) : "")} />
          </Field>

          {/* 月份快捷切换：共享电表看「已录分摊的月份」，普通电表看「已有读数的月份」 */}
          {isShared ? (
            (allocForm.data?.periods?.length ?? 0) > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-purple-600">已录分摊月份</span>
                {allocForm.data.periods.map((p: string) => (
                  <button key={p}
                    className={`rounded-full px-2 py-0.5 text-[10px] ${p === monthPeriod ? "bg-purple-100 font-medium text-purple-700" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
                    onClick={() => changeMonth(p)}>
                    {toDisplay(p)}
                  </button>
                ))}
              </div>
            )
          ) : readings.data && readings.data.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {readings.data.map((r: any) => (
                <button key={r.monthPeriod}
                  className={`rounded-full px-2 py-0.5 text-[10px] ${r.monthPeriod === monthPeriod ? "bg-blue-100 text-blue-700 font-medium" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
                  onClick={() => changeMonth(r.monthPeriod)}>
                  {toDisplay(r.monthPeriod)} ({r.kwh}){r.actualKwh != null ? " ★" : ""}
                </button>
              ))}
            </div>
          )}

          {/* ── 共享电表：品牌分摊录入（应付电费 → 倒推用电量）── */}
          {isShared && (
            <div className="rounded-lg border border-purple-200 bg-purple-50/40 p-3">
              <div className="mb-1 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-purple-800">品牌分摊（各品牌应付电费）</div>
                  <div className="text-[11px] text-purple-600">
                    录入各品牌该月应付电费 + 电柜数量 → 用电量 = 金额 ÷ 单价 自动倒推；付款给场地方 = 倒推电量 × 场地单价
                  </div>
                </div>
                <Button size="sm" variant="outline" className="shrink-0 border-purple-300 text-purple-700 hover:bg-purple-50"
                  onClick={addAllocRow} disabled={allocForm.isLoading}>
                  <Plus className="mr-1 h-3 w-3" />添加品牌
                </Button>
              </div>

              {allocForm.isLoading ? (
                <div className="py-3 text-center text-xs text-slate-400">加载品牌单价…</div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] text-purple-700">
                          <th className="py-1 pr-2 font-medium">品牌方</th>
                          <th className="py-1 pr-2 font-medium">电柜数量</th>
                          <th className="py-1 pr-2 font-medium">应付电费（元）</th>
                          <th className="py-1 pr-2 font-medium">单价（元/度）</th>
                          <th className="py-1 pr-2 font-medium">用电量（度）</th>
                          <th className="py-1 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {allocRows.map((row, i) => {
                          const contractPrice = contractPriceOf(row.brandId);
                          const k = kwhOfRow(row);
                          const hasAmount = String(row.collectAmount).trim() !== "";
                          const defCabinet = cabinetDefaultOf(row.brandId);
                          // 该行柜数 = 该品牌最近一次填写值，且来源不是本月 → 说明是「沿用」来的
                          const cabinetInherited = defCabinet != null
                            && String(defCabinet.count) === row.cabinetCount.trim()
                            && defCabinet.monthPeriod !== monthPeriod;
                          return (
                            <tr key={`${row.brandId}-${i}`} className="border-t border-purple-100">
                              <td className="py-1 pr-2">
                                <select className={`${inputCls} h-8 w-36 text-xs`} value={row.brandId}
                                  onChange={(e) => {
                                    const bid = e.target.value;
                                    const def = cabinetDefaultOf(bid);
                                    // 换品牌时带出该品牌最近一次的电柜数量（无记录则清空）
                                    setAllocRow(i, {
                                      brandId: bid, unitPrice: "",
                                      cabinetCount: def ? String(def.count) : "",
                                    });
                                  }}>
                                  <option value="">请选择品牌</option>
                                  {/* 已被其他行选中的品牌不再列出，避免同表同月重复（后端也会拦） */}
                                  {brandOptions
                                    .filter((o) => o.value === row.brandId
                                      || !allocRows.some((r2, j) => j !== i && r2.brandId === o.value))
                                    .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </td>
                              <td className="py-1 pr-2">
                                <div className="flex items-center gap-1">
                                  <input type="number" step="1" min="1"
                                    className={`${inputCls} h-8 w-16 text-xs`}
                                    placeholder="台"
                                    title={defCabinet
                                      ? `该品牌最近一次填写：${defCabinet.count} 台（${toDisplay(defCabinet.monthPeriod)}）`
                                      : "该品牌尚未填写过电柜数量"}
                                    value={row.cabinetCount}
                                    onChange={(e) => setAllocRow(i, { cabinetCount: e.target.value })} />
                                  <span className="text-[10px] text-purple-500">台</span>
                                  {cabinetInherited && defCabinet && (
                                    <span className="cursor-help text-[10px] text-purple-400"
                                      title={`沿用 ${toDisplay(defCabinet.monthPeriod)} 的填写值；本月调整后，下月默认即为新值`}>
                                      沿用
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-1 pr-2">
                                <input type="number" step="0.01" min="0"
                                  className={`${inputCls} h-8 w-24 text-xs`} placeholder="0.00"
                                  value={row.collectAmount}
                                  onChange={(e) => setAllocRow(i, { collectAmount: e.target.value })} />
                              </td>
                              <td className="py-1 pr-2">
                                <input type="number" step="0.0001" min="0"
                                  className={`${inputCls} h-8 w-24 text-xs`}
                                  placeholder={contractPrice != null ? String(contractPrice) : "无合同价"}
                                  value={row.unitPrice}
                                  onChange={(e) => setAllocRow(i, { unitPrice: e.target.value })} />
                              </td>
                              <td className="py-1 pr-2 tabular-nums text-slate-600">
                                {k != null ? k : (hasAmount ? <span className="text-rose-500">缺单价</span> : "—")}
                              </td>
                              <td className="py-1 text-right">
                                <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => removeAllocRow(i)} title="删除该品牌分摊">
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {allocRows.length === 0 && (
                          <tr><td colSpan={6} className="py-3 text-center text-slate-400">
                            暂无品牌分摊，点击「添加品牌」录入
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-purple-100 pt-2 text-[11px] text-purple-700">
                    <span>合计应付电费：<b className="tabular-nums">{fmtNum(allocTotals.amount)}</b> 元</span>
                    <span>合计用电量：<b className="tabular-nums">{fmtNum(allocTotals.kwh)}</b> 度</span>
                    {allocTotals.cabinetsFilled > 0 && (
                      <span>合计电柜：<b className="tabular-nums">{allocTotals.cabinets}</b> 台</span>
                    )}
                    {allocTotals.missingPrice > 0 && (
                      <span className="text-rose-600">{allocTotals.missingPrice} 行缺单价，无法倒推用电量</span>
                    )}
                  </div>

                  {/* 整表读数：第三方同步值；未同步时可手动补录（写 actual_kwh，不随同步覆盖） */}
                  <div className="mt-2 space-y-1 border-t border-purple-100 pt-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                      <span className="font-medium text-purple-800">整表读数</span>
                      {editingTableKwh ? (
                        <>
                          <input type="number" step="0.01" min="0" autoFocus
                            className={`${inputCls} h-8 w-32 text-xs`}
                            placeholder="含互感器倍数"
                            value={manualKwh}
                            onChange={(e) => setManualKwh(e.target.value)} />
                          <span className="text-purple-700">度</span>
                          <Button size="sm" variant="outline"
                            className="h-8 border-purple-300 text-purple-700 hover:bg-purple-50"
                            disabled={!manualKwh.trim() || saveTableKwh.isPending}
                            onClick={() => saveTableKwh.mutate()}>
                            {saveTableKwh.isPending ? "保存中…" : "保存"}
                          </Button>
                          <button className="text-slate-400 hover:text-slate-600"
                            onClick={() => { setEditingTableKwh(false); setManualKwh(""); }}>
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-purple-700">
                            {tableKwh != null
                              ? <><b className="tabular-nums">{fmtNum(tableKwh)}</b> 度（{tableKwhIsManual ? "人工补录" : "第三方同步"}）</>
                              : <span className="text-slate-400">未同步</span>}
                          </span>
                          <button className="text-purple-500 underline decoration-dotted hover:text-purple-700"
                            onClick={() => { setEditingTableKwh(true); setManualKwh(tableKwh != null ? String(tableKwh) : ""); }}>
                            {tableKwh != null ? "修改" : "手动补录"}
                          </button>
                        </>
                      )}
                    </div>

                    {editingTableKwh && (
                      <p className="text-[11px] text-slate-400">
                        填整表实际用电量（已含互感器倍数）。该值不随第三方同步覆盖；未录分摊的月份，台账按此度数 × 合同单价计算。
                      </p>
                    )}

                    {/* 核对条：整表物理读数 vs 分摊倒推合计 */}
                    {!editingTableKwh && allocTotals.amount > 0 && tableKwh != null && kwhGap != null && (() => {
                      const payPrice = allocForm.data?.payPrice != null ? Number(allocForm.data.payPrice) : null;
                      if (Math.abs(kwhGap) <= Math.max(1, tableKwh * 0.01)) {
                        return (
                          <p className="text-[11px] text-emerald-600">
                            整表 {fmtNum(tableKwh)} 度 ≈ 分摊倒推 {fmtNum(allocTotals.kwh)} 度，已对齐。
                          </p>
                        );
                      }
                      if (kwhGap > 0) {
                        return (
                          <p className="text-[11px] text-amber-600">
                            整表 {fmtNum(tableKwh)} 度 － 分摊倒推 {fmtNum(allocTotals.kwh)} 度 ={" "}
                            <b className="tabular-nums">{fmtNum(kwhGap)}</b> 度无人认领
                            {payPrice ? <>（按场地单价 {payPrice} 元/度约 <b className="tabular-nums">¥{(kwhGap * payPrice).toFixed(2)}</b> 需自负）</> : null}
                            ，请检查是否有漏报品牌或公摊电量。
                          </p>
                        );
                      }
                      return (
                        <p className="text-[11px] text-rose-600">
                          分摊倒推 {fmtNum(allocTotals.kwh)} 度 ＞ 整表 {fmtNum(tableKwh)} 度{" "}
                          <b className="tabular-nums">{fmtNum(Math.abs(kwhGap))}</b> 度，请检查品牌单价或应付电费金额是否偏高。
                        </p>
                      );
                    })()}

                    {!editingTableKwh && allocTotals.amount > 0 && tableKwh == null && (
                      <p className="text-[11px] text-slate-400">
                        该月暂无整表读数，无法与分摊倒推量核对；可点「手动补录」填入物理读数。
                      </p>
                    )}
                  </div>
                  {allocAmountRows.length === 0 && savedAllocKey !== "" && (
                    <p className="mt-1 text-[11px] text-rose-600">
                      当前未填任何金额 → 保存后将清空该月品牌分摊，台账退回「整表读数 × 合同单价」。
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-purple-600">
                    单价留空 = 自动取该品牌方合同单价；填了则以填写值为准（用于倒推用电量）。
                    电柜数量逐月可调，首次录入后下月自动沿用该品牌最近一次填写值（本月改了，下月默认即为新值）；
                    柜数留空表示本月未填。
                  </p>
                  <p className="mt-1 text-[11px] text-purple-600">
                    金额留空的行不会保存。清空全部金额 = 取消分摊，台账退回「整表读数 × 合同单价」。
                  </p>
                  <p className="mt-1 text-[11px] text-purple-500">
                    共享电表不按整表读数计费，此表单只录分摊；未录分摊的月份，台账按「第三方同步读数 × 合同单价」生成。
                  </p>
                </>
              )}
            </div>
          )}

          {/* 读数区：共享电表（所有品牌共用）不按读数计费，整块隐藏 */}
          {!isShared && (<>
          {/* 上月抄表信息 */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="上月抄表时间">
              <input type="date" className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm"
                value={prevReadingDate}
                onChange={(e) => setPrevReadingDate(e.target.value)} />
            </Field>
            <Field label="起始度数">
              <NumInput value={prevReading} onChange={setPrevReading} placeholder="上月读数" />
            </Field>
          </div>

          {/* 本月抄表信息 */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="本月抄表时间">
              <input type="date" className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm"
                value={currReadingDate}
                onChange={(e) => setCurrReadingDate(e.target.value)} />
            </Field>
            <Field label="抄表度数">
              <NumInput value={currReading} onChange={setCurrReading} placeholder="本月读数" />
            </Field>
          </div>

          {/* 区间度数 */}
          <Field label={
            <div className="flex items-center gap-2">
              <span>区间度数（kWh）</span>
              <label className="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
                <input type="checkbox" className="rounded" checked={calcKwh}
                  onChange={(e) => setCalcKwh(e.target.checked)} />
                自动计算
              </label>
            </div>
          }>
            <NumInput value={kwh} onChange={setKwh} placeholder="抄表度数 - 起始度数" disabled={calcKwh} />
          </Field>

          {/* 实际值（可选，填了优先用） */}
          <Field label="本月实际用电量（kWh）">
            <NumInput value={actualKwh} onChange={setActualKwh} placeholder="留空则按 区间度数×倍数 计算" />
          </Field>
          <p className="-mt-1 text-[11px] text-slate-400">
            填了实际值则各页面优先使用它（已含互感器倍数）；留空用「区间度数 × 互感器倍数」。
          </p>

          {/* 人工实际读数（第三方数据错漏时填写；不随同步覆盖） */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="上月实际读数">
              <NumInput value={prevActualReading} onChange={setPrevActualReading} placeholder="人工填真实读数" />
            </Field>
            <Field label="本月实际读数">
              <NumInput value={currActualReading} onChange={setCurrActualReading} placeholder="人工填真实读数" />
            </Field>
          </div>
          <p className="-mt-1 text-[11px] text-slate-400">
            第三方数据错漏时填真实电表读数（不随同步覆盖）；填了它且未填实际用电量时，自动按「本月−上月」计算。
          </p>

          {/* 提示信息 */}
          {calcKwh && prevReading && !currReading && (
            <p className="text-xs text-amber-500">请填写抄表度数，否则区间度数将为 0</p>
          )}
          {calcKwh && !prevReading && currReading && (
            <p className="text-xs text-amber-500">请填写起始度数，否则区间度数将为 0</p>
          )}

          {/* 显示计算结果 */}
          {calcKwh && prevReading && currReading && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              区间度数 = {currReading} - {prevReading} = <span className="font-semibold">{parseFloat(currReading) - parseFloat(prevReading)}</span> kWh
            </div>
          )}

          </>)}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button className="bg-blue-600 hover:bg-blue-700"
              disabled={save.isPending || !canSave || (isShared && allocForm.isLoading)}
              onClick={() => save.mutate()}>
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── 柜子表单 ───
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
