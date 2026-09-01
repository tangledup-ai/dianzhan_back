import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listMeters, createMeter, updateMeter, deleteMeter, importMetersExcel } from "@/api/meters";
import { listCabinets, createCabinet, updateCabinet, deleteCabinet } from "@/api/cabinets";
import { listBrands, listLandlords, listEntities } from "@/api/directory";
import { generateElectricity } from "@/api/electricity";
import { triggerSync, saveMeterReading, getMeterReadings } from "@/api/meterEnergy";
import { StatusBadge } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Field, NumInput, TextInput, SelectInput, inputCls } from "@/components/fields";
import { exportXlsx } from "@/lib/export";
import { fmtNum } from "@/lib/format";
import { toCompact, toDisplay } from "@/lib/period";
import { Download, Search, Plus, Pencil, Trash2, Gauge, ChevronDown, ChevronRight, RefreshCw, BookOpen, Upload } from "lucide-react";
import { toast } from "sonner";

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
  const [keyword, setKeyword] = useState("");
  const [landlordId, setLandlordId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [tag, setTag] = useState("");
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
    if (landlord) setLandlordId(landlord);
    if (brand) setBrandId(brand);
    if (highlight === "cabinet") {
      setHighlightCabinet(true);
      // 5秒后取消高亮
      setTimeout(() => setHighlightCabinet(false), 5000);
    }
    // 清除 URL 参数
    if (landlord || brand || highlight) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const queryClient = useQueryClient();
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters() });
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords });
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands });

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
        <select className={`${inputCls} w-40`} value={landlordId} onChange={(e) => setLandlordId(e.target.value)}>
          <option value="">全部场地方</option>
          {(landlords.data ?? []).map((l: any) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
        </select>
        <select className={`${inputCls} w-40`} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">全部品牌方</option>
          <option value="shared">共享电表（全品牌）</option>
          {(brands.data ?? []).map((b: any) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
        </select>
        <select className={`${inputCls} w-36`} value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">全部标签</option>
          <option value="合作商电表">合作商电表</option>
          <option value="民用电表">民用电表</option>
          <option value="共享电表">共享电表</option>
        </select>
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
function MeterCard({ meter, isExpanded, onToggle, onEdit, onDelete, onReading, highlightCabinet }: {
  meter: any; isExpanded: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void; onReading: () => void; highlightCabinet?: boolean;
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
  const blank = { brandId: "", landlordId: "", entityId: "", meterNo: "", meterName: "", collectorId: "", transformerRatio: "", tag: "合作商电表", remark: "" };
  const [f, setF] = useState(blank);
  const queryClient = useQueryClient();
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords, enabled: open });
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands, enabled: open });
  const entities = useQuery({ queryKey: ["entities"], queryFn: listEntities, enabled: open });

  useEffect(() => {
    if (!open) return;
    if (record) {
      setF({
        brandId: record.brandId ? String(record.brandId) : "",
        landlordId: record.landlordId ? String(record.landlordId) : "",
        entityId: record.entityId ? String(record.entityId) : "",
        meterNo: record.meterNo ?? "", meterName: record.meterName ?? "",
        collectorId: record.collectorId ?? "", transformerRatio: String(record.transformerRatio ?? ""),
        tag: record.tag ?? "合作商电表", remark: record.remark ?? "",
      });
    } else setF(blank);
  }, [open, record]);

  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  // 全品牌共享：标签=共享电表 即视为共享，开关与「标签」下拉双向联动
  const isShared = f.tag === "共享电表";
  const toggleShared = (on: boolean) => {
    setF((p) => ({
      ...p,
      tag: on ? "共享电表" : (p.tag === "共享电表" ? "合作商电表" : p.tag),
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
    onError: (e: any) => toast.error(e.message),
  });

  const submit = () => {
    if (!f.meterNo.trim()) { toast.error("请填写电表编号"); return; }
    save.mutate({
      brandId: !isShared && f.brandId ? Number(f.brandId) : null,
      landlordId: f.landlordId ? Number(f.landlordId) : null,
      entityId: f.entityId ? Number(f.entityId) : null,
      meterNo: f.meterNo.trim(),
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
            <SelectInput value={f.landlordId} onChange={set("landlordId")}
              options={[{ value: "", label: "请选择场地方" }, ...(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))]} />
          </Field>
          <div className="-mt-2 text-[11px] text-slate-400">
            v3：电表直接归属场地方 + 品牌方（不再经站点）。
          </div>
          {/* 全品牌共享开关：场地内所有品牌共用一块电表时开启，无需选择品牌方 */}
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <Switch checked={isShared} onCheckedChange={toggleShared} />
            <div>
              <div className="text-sm text-slate-700">所有品牌共用此电表</div>
              <div className="text-[11px] text-slate-400">
                开启后无需选择品牌方（标签自动记为「共享电表」），适用于场地内各品牌共用的总表
              </div>
            </div>
          </div>
          <Field label="品牌方">
            {isShared ? (
              <div className="rounded-md border border-purple-200 bg-purple-50 px-2.5 py-1.5 text-sm text-purple-700">
                全部品牌方共用（无需选择）
              </div>
            ) : (
              <SelectInput value={f.brandId} onChange={set("brandId")}
                options={[{ value: "", label: "未指定" }, ...(brands.data ?? []).map((b: any) => ({ value: String(b.id), label: b.name }))]} />
            )}
          </Field>
          <Field label="报税公司主体">
            <SelectInput value={f.entityId} onChange={set("entityId")}
              options={[{ value: "", label: "未指定" }, ...(entities.data ?? []).map((e: any) => ({ value: String(e.id), label: e.name }))]} />
          </Field>
          <Field label="电表编号 *"><TextInput value={f.meterNo} onChange={set("meterNo")} /></Field>
          <Field label="电表名称"><TextInput value={f.meterName} onChange={set("meterName")} /></Field>
          <Field label="标签">
            <SelectInput value={f.tag} onChange={set("tag")}
              options={[
                { value: "合作商电表", label: "合作商电表" },
                { value: "民用电表", label: "民用电表" },
                { value: "共享电表", label: "共享电表" },
              ]} />
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

  // 加载该电表已有的读数
  const readings = useQuery({
    queryKey: ["meterReadings", meter?.meterNo],
    queryFn: () => getMeterReadings(meter.meterNo),
    enabled: open && !!meter?.meterNo,
  });

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
    if (open) setMonthPeriod(defaultPeriod);
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

  // 已有读数的月份列表（用于高亮显示）

  const save = useMutation({
    mutationFn: () => saveMeterReading({
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
    }),
    onSuccess: async () => {
      toast.success("读数已保存");
      try {
        // v3：台账按场地×品牌全量重算该月
        await generateElectricity({ period: monthPeriod, landlordId: meter.landlordId || undefined });
        queryClient.invalidateQueries({ queryKey: ["electricity"] });
      } catch {}
      onClose();
    },
    onError: (e: any) => toast.error(e.message || "保存失败"),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-blue-600" />
            录入电表读数
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div>表号：<span className="font-mono font-medium">{meter?.meterNo}</span></div>
            <div>名称：{meter?.meterName ?? "-"}</div>
          </div>

          <Field label="月份">
            <input type="month" className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm"
              value={monthPeriod ? toDisplay(monthPeriod) : ""}
              onChange={(e) => setMonthPeriod(e.target.value ? toCompact(e.target.value) : "")} />
          </Field>

          {/* 已有读数的月份提示 */}
          {readings.data && readings.data.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {readings.data.map((r: any) => (
                <button key={r.monthPeriod}
                  className={`rounded-full px-2 py-0.5 text-[10px] ${r.monthPeriod === monthPeriod ? "bg-blue-100 text-blue-700 font-medium" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
                  onClick={() => setMonthPeriod(r.monthPeriod)}>
                  {toDisplay(r.monthPeriod)} ({r.kwh}){r.actualKwh != null ? " ★" : ""}
                </button>
              ))}
            </div>
          )}

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

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button className="bg-blue-600 hover:bg-blue-700" disabled={save.isPending || (!kwh && !prevReading && !currReading)} onClick={() => save.mutate()}>
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
