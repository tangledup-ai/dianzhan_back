import { useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listContracts, createContract, updateContract, deleteContract, importContractsExcel, getContractAudit } from "@/api/contracts";
import { createApproval } from "@/api/approvals";
import { listBrands, listLandlords, listEntities } from "@/api/directory";
import { listMeters } from "@/api/meters";
import { listCabinets } from "@/api/cabinets";
import { StatusBadge } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Field, NumInput, TextInput, DateInput, SelectInput, SearchSelect, inputCls } from "@/components/fields";
import { MapPicker } from "@/components/MapPicker";
import * as XLSX from "xlsx";
import { fmtMoney, fmtNum, fmtDate, numOrNull } from "@/lib/format";
import { Download, Plus, Search, Pencil, Trash2, AlertTriangle, FileText, ArrowDownCircle, ArrowUpCircle, ExternalLink, ChevronDown, ChevronRight, Upload, Landmark } from "lucide-react";
import { groupByEntity } from "@/lib/groupColors";
import { ContractSchedule } from "@/components/ContractSchedule";
import { toast } from "sonner";

// ── 拆期预检（与后端 contract_schedule_repo._split_periods 同一算法：按合同周年日推进）──
const PERIOD_MONTHS: Record<string, number> = { "月付": 1, "季付": 3, "半年付": 6, "年付": 12 };

function addMonths(d: Date, months: number): Date {
  const total = d.getFullYear() * 12 + d.getMonth() + months;
  const y = Math.floor(total / 12), m0 = total % 12;
  const last = new Date(y, m0 + 1, 0).getDate();
  const isLastDay = d.getDate() === new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return new Date(y, m0, isLastDay ? last : Math.min(d.getDate(), last));
}

function splitPeriodsPreview(startDate: string, endDate: string, payMethod: string) {
  const months = PERIOD_MONTHS[payMethod] || 1;
  const s = new Date(startDate + "T00:00:00");
  const e = new Date(endDate + "T00:00:00");
  const periods: { ps: Date; pe: Date; nominalEnd: Date }[] = [];
  let k = 0;
  let cur = new Date(s);
  while (cur <= e) {
    const next = addMonths(s, (k + 1) * months);
    const nominalEnd = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
    const pe = nominalEnd > e ? new Date(e) : nominalEnd;
    periods.push({ ps: new Date(cur), pe, nominalEnd });
    cur = next;
    k++;
  }
  return periods;
}

const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

export default function Contracts() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [keyword, setKeyword] = useState("");
  const [brandId, setBrandId] = useState("");
  const [landlordId, setLandlordId] = useState("");
  const [contractType] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [formType, setFormType] = useState("场地合同");
  // 展开查看付款分期的合同 id（场地合同）
  const [expandedContractId, setExpandedContractId] = useState<number | null>(null);

  const queryClient = useQueryClient();
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands });
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords });
  const entitiesQ = useQuery({ queryKey: ["entities"], queryFn: listEntities });
  const metersQ = useQuery({ queryKey: ["meters"], queryFn: () => listMeters() });
  const list = useQuery({
    queryKey: ["contracts", keyword, brandId, landlordId, contractType],
    queryFn: () => listContracts({
      keyword: keyword || undefined,
      brandId: brandId ? Number(brandId) : undefined,
      landlordId: landlordId ? Number(landlordId) : undefined,
      contractType: contractType || undefined,
    }),
  });

  const del = useMutation({
    mutationFn: deleteContract,
    onSuccess: () => { toast.success("已删除"); queryClient.invalidateQueries({ queryKey: ["contracts"] }); },
  });

  // 场地费退款审批（品牌方合同提前终止且填了退款金额的行可见）
  const [refundTarget, setRefundTarget] = useState<any>(null);
  const handleRefundApproval = (p: { rentRefund: number; depositRefund: number; applicant: string; remark: string }) => {
    if (!refundTarget) return;
    createApproval({
      bizType: "场地费退款",
      title: `${refundTarget.landlordName ?? ""} ${refundTarget.brandName ?? ""} 提前终止退款`.trim(),
      applicant: p.applicant,
      amount: p.rentRefund + p.depositRefund,
      reason: `品牌方合同提前于 ${fmtDate(refundTarget.earlyEndDate || refundTarget.endDate)} 结束；场地费退款 ${p.rentRefund} 元，押金退还 ${p.depositRefund} 元${p.remark ? `；备注：${p.remark}` : ""}`,
      landlordId: refundTarget.landlordId,
      rentAmount: p.rentRefund,
      contractId: refundTarget.id,
    }).then(() => {
      toast.success("退款审批已提交，可在「审批中心」查看进度");
      setRefundTarget(null);
    }).catch((e: any) => toast.error(e.response?.data?.detail || e.message || "提交失败"));
  };

  // ── Excel 导入合同 ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const res = await importContractsExcel(file);
      setImportResult(res);
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || err?.message || "导入失败");
    } finally {
      setImporting(false);
    }
  };

  // 年份选项：当前年 ±5 年，再合并合同数据中出现的年份
  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    for (let y = currentYear - 5; y <= currentYear + 5; y++) years.add(y);
    for (const c of list.data ?? []) {
      if (c.startDate) years.add(new Date(c.startDate).getFullYear());
      if (c.endDate) years.add(new Date(c.endDate).getFullYear());
    }
    return [...years].sort((a, b) => b - a);
  }, [list.data, currentYear]);

  const rows = useMemo(() => {
    let data = list.data ?? [];
    // 按年份过滤：合同有效期与所选年份有交集
    if (year) {
      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year, 11, 31);
      data = data.filter((c: any) => {
        const start = c.startDate ? new Date(c.startDate) : null;
        const end = c.earlyEndDate ? new Date(c.earlyEndDate) : (c.endDate ? new Date(c.endDate) : null);
        if (!start || !end) return true; // 没有日期的合同始终显示
        return start <= yearEnd && end >= yearStart;
      });
    }
    if (statusFilter) data = data.filter((c: any) => c.status === statusFilter);
    return data;
  }, [list.data, year, statusFilter]);

  const counts = useMemo(() => {
    const all = list.data ?? [];
    return {
      total: all.length,
      normal: all.filter((c: any) => c.status === "正常").length,
      expiring: all.filter((c: any) => c.status === "临期").length,
      expired: all.filter((c: any) => c.status === "已到期").length,
      earlyTerminated: all.filter((c: any) => c.status === "提前结束").length,
    };
  }, [list.data]);

  // 按场地方分组，并分离场地合同和品牌方合同
  const groupedByLandlord = useMemo(() => {
    const groups = new Map<number, any>();
    for (const r of rows) {
      const lid = r.landlordId || 0;
      if (!groups.has(lid)) {
        groups.set(lid, {
          landlordId: lid,
          landlordName: r.landlordName || "未关联场地方",
          costContracts: [],   // 场地合同
          incomeContracts: [], // 品牌方合同
        });
      }
      const group = groups.get(lid);
      if (r.contractType === "品牌方合同") {
        group.incomeContracts.push(r);
      } else {
        group.costContracts.push(r);
      }
    }
    return [...groups.values()];
  }, [rows]);

  // 公司主体分组：同主体同色、点击展开场地方详情，未指定主体排最后
  const [openEntities, setOpenEntities] = useState<Set<string>>(new Set());
  const toggleEntity = (name: string) => {
    setOpenEntities((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const entityGroups = useMemo(() => {
    // 每个场地方的主体：合同 entity_id 优先，其次该场地方电表的报税主体（与 Entities 页口径一致），都没有归「未指定主体」
    const entityNameById = new Map<number, string>((entitiesQ.data ?? []).map((e: any) => [e.id, e.name] as [number, string]));
    const meterEntityByLandlord = new Map<number, string>();
    for (const m of metersQ.data ?? []) {
      if (m.landlordId && m.entityId && !meterEntityByLandlord.has(m.landlordId)) {
        const name = entityNameById.get(m.entityId);
        if (name) meterEntityByLandlord.set(m.landlordId, name);
      }
    }
    const withEntity = groupedByLandlord.map((g: any) => ({
      ...g,
      entityName: (g.costContracts.find((c: any) => c.entityName) || g.incomeContracts.find((c: any) => c.entityName))?.entityName
        || meterEntityByLandlord.get(g.landlordId) || "未指定主体",
    }));
    return groupByEntity(withEntity);
  }, [groupedByLandlord, metersQ.data, entitiesQ.data]);

  const doExport = () => {
    // 导出全部合同（按当前筛选），样式参考"共享合同监控表"：按合同类型分 sheet
    if (rows.length === 0) { toast.error("暂无合同可导出"); return; }

    const headers = ["序号", "付款主体", "站点名称", "站点地址", "合作方", "合同类型", "开始日期", "结束日期", "剩余天数", "状态", "备注"];
    const addrOf = new Map((landlords.data ?? []).map((l: any) => [l.id, l.address]));
    const groups: { name: string; title: string; list: any[] }[] = [
      { name: "场地合同", title: "场地合同监控表", list: rows.filter((c: any) => c.contractType === "场地合同") },
      { name: "品牌方合同", title: "品牌方合同监控表", list: rows.filter((c: any) => c.contractType === "品牌方合同") },
    ];

    const wb = XLSX.utils.book_new();
    for (const g of groups) {
      if (g.list.length === 0) continue;
      const aoa: unknown[][] = [[g.title], headers];
      g.list.forEach((c: any, i: number) => {
        aoa.push([
          i + 1,
          c.payEntity ?? "",
          c.landlordName || "",
          c.address || addrOf.get(c.landlordId) || "",
          c.contractType === "品牌方合同" ? (c.brandName || "全部品牌共享") : (c.partner || c.landlordName || ""),
          c.contractType,
          fmtDate(c.startDate, ""),
          fmtDate(c.earlyEndDate || c.endDate, ""),
          c.days_left ?? "",
          c.status,
          c.remark ?? "",
        ]);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
      ws["!cols"] = headers.map((h, ci) => ({
        wch: Math.max(h.length * 2, ...aoa.slice(2).map((r) => String(r[ci] ?? "").length * 1.9), 8),
      }));
      XLSX.utils.book_append_sheet(wb, ws, g.name.slice(0, 31));
    }
    XLSX.writeFile(wb, `合同监控表_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast.success("已导出 Excel");
  };

  const openCreate = (type: string) => {
    setFormType(type);
    setEditing(null);
    setFormOpen(true);
  };

  const th = "px-3 py-2.5 text-left text-xs font-medium text-slate-500 whitespace-nowrap";
  const thR = "px-3 py-2.5 text-right text-xs font-medium text-slate-500 whitespace-nowrap";

  return (
    <div className="space-y-4">
      {/* 统计卡片 */}
      <div className="grid grid-cols-5 gap-4">
        {[
          { label: "合同总数", value: counts.total, cls: "text-slate-800", filter: "" },
          { label: "正常", value: counts.normal, cls: "text-emerald-600", filter: "正常" },
          { label: "临期（90天内）", value: counts.expiring, cls: "text-amber-600", filter: "临期" },
          { label: "已到期", value: counts.expired, cls: "text-rose-600", filter: "已到期" },
          { label: "提前结束", value: counts.earlyTerminated, cls: "text-violet-600", filter: "提前结束" },
        ].map((c) => (
          <button key={c.label} onClick={() => setStatusFilter(statusFilter === c.filter ? "" : c.filter)}
            className={`rounded-xl border bg-white p-4 text-left shadow-sm transition-colors hover:border-emerald-300 ${statusFilter === c.filter && c.filter ? "border-emerald-500 ring-1 ring-emerald-500" : ""}`}>
            <div className="text-xs text-slate-500">{c.label}</div>
            <div className={`mt-1 text-2xl font-bold tabular-nums ${c.cls}`}>{c.value}</div>
          </button>
        ))}
      </div>

      {(counts.expiring > 0 || counts.expired > 0 || counts.earlyTerminated > 0) && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
          <AlertTriangle className="h-4 w-4" />
          有 {counts.expiring} 份合同 90 天内到期、{counts.expired} 份已到期、{counts.earlyTerminated} 份提前结束。
        </div>
      )}

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputCls} w-28`} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions.map((y) => <option key={y} value={y}>{y}年</option>)}
        </select>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className={`${inputCls} w-48 pl-8`} placeholder="搜索场地方 / 品牌方…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <select className={`${inputCls} w-40`} value={landlordId} onChange={(e) => setLandlordId(e.target.value)}>
          <option value="">全部场地方</option>
          {(landlords.data ?? []).map((l: any) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
        </select>
        <select className={`${inputCls} w-40`} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">全部品牌方</option>
          {(brands.data ?? []).map((b: any) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
        </select>
        <div className="ml-auto flex gap-2">
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={doExport}><Download className="mr-1.5 h-4 w-4" />导出表格</Button>
          <Button variant="outline" className="text-blue-600" disabled={importing} onClick={() => fileRef.current?.click()}>
            <Upload className="mr-1.5 h-4 w-4" />{importing ? "导入中…" : "导入 Excel"}
          </Button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} />
          <Button variant="outline" className="text-rose-600" onClick={() => openCreate("场地合同")}>
            <Plus className="mr-1 h-4 w-4" />场地合同
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => openCreate("品牌方合同")}>
            <Plus className="mr-1 h-4 w-4" />品牌方合同
          </Button>
        </div>
      </div>

      {/* 按公司主体分组展示（同主体同色，点击展开场地方详情） */}
      <div className="space-y-4">
        {entityGroups.map((eg) => {
          const isOpen = openEntities.has(eg.entityName);
          const contractCount = eg.rows.reduce((t: number, g: any) => t + g.costContracts.length + g.incomeContracts.length, 0);
          return (
            <div key={eg.entityName} className={`rounded-xl border p-3 ${eg.color.border} ${eg.color.bg}`}>
              <button type="button" className="flex w-full items-center gap-2 px-1 text-left" onClick={() => toggleEntity(eg.entityName)}>
                {isOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                <div className={`flex h-6 w-6 items-center justify-center rounded-md ${eg.color.icon}`}>
                  <Landmark className="h-3.5 w-3.5 text-white" />
                </div>
                <span className={`text-sm font-semibold ${eg.color.text}`}>{eg.entityName}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${eg.color.chip}`}>{eg.rows.length} 个场地方</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${eg.color.chip}`}>{contractCount} 份合同</span>
                <span className="ml-auto text-[10px] text-slate-400">{isOpen ? "点击收起" : "点击展开"}</span>
              </button>
              {isOpen && (
              <div className="mt-3 space-y-6">
        {eg.rows.map((group: any) => {
          const totalCost = group.costContracts.reduce((t: number, c: any) => t + (c.monthlyRent ? Number(c.monthlyRent) : 0), 0);
          const totalIncome = group.incomeContracts.reduce((t: number, c: any) => t + (c.monthlyRent ? Number(c.monthlyRent) : 0), 0);

          return (
            <div key={group.landlordId} className="rounded-xl border bg-white shadow-sm">
              {/* 场地方头部 */}
              <div className="border-b px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-emerald-600" />
                  <span className="text-sm font-semibold text-slate-700">{group.landlordName}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-rose-600">月成本 <b className="tabular-nums">{fmtMoney(totalCost)}</b></span>
                  <span className="text-emerald-600">月收入 <b className="tabular-nums">{fmtMoney(totalIncome)}</b></span>
                  <span className="text-slate-600">月利润 <b className="tabular-nums">{fmtMoney(totalIncome - totalCost)}</b></span>
                </div>
              </div>

              {/* 成本合同（场地合同） */}
              <div className="border-b">
                <div className="flex items-center gap-2 bg-rose-50/50 px-5 py-2">
                  <ArrowDownCircle className="h-4 w-4 text-rose-500" />
                  <span className="text-xs font-semibold text-rose-600">场地合同（{group.costContracts.length} 份）</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b bg-slate-50">
                      <th className={th}></th>
                      <th className={th}>合同类型</th>
                      <th className={th}>场地方</th>
                      <th className={thR}>电费单价</th>
                      <th className={thR}>年租金</th>
                      <th className={thR}>月租金</th>
                      <th className={thR}>押金</th>
                      <th className={th}>场地租金付款方式</th>
                      <th className={th}>合同期限</th>
                      <th className={thR}>剩余天数</th>
                      <th className={th}>状态</th>
                      <th className={th}>备注</th>
                      <th className={`${th} text-center`}>操作</th>
                    </tr></thead>
                    <tbody>
                      {(() => {
                        // 到期拆分：未过期合同在上，已到期/提前结束在下（剩余天数按 0 显示）
                        const expiredCost = group.costContracts.filter((c: any) => c.status === "已到期" || c.status === "提前结束");
                        const seqCost: any[] = group.costContracts.filter((c: any) => c.status !== "已到期" && c.status !== "提前结束");
                        if (expiredCost.length > 0) seqCost.push({ divider: `已到期 / 提前结束（${expiredCost.length} 份）` }, ...expiredCost);
                        return seqCost.map((c: any, ci: number) => {
                        if (c.divider) {
                          return (
                            <tr key={`cost-divider-${ci}`} className="bg-slate-100/80">
                              <td colSpan={13} className="px-3 py-1 text-[10px] font-medium text-slate-500">⬇ {c.divider}</td>
                            </tr>
                          );
                        }
                        const isExpanded = expandedContractId === c.id;
                        return (
                          <>
                            <tr key={c.id} onClick={() => setExpandedContractId(isExpanded ? null : c.id)} className={`cursor-pointer border-b last:border-0 hover:bg-slate-50/60 ${c.status === "已到期" ? "bg-rose-50/30" : c.status === "临期" ? "bg-amber-50/30" : c.status === "提前结束" ? "bg-violet-50/30" : ""}`}>
                              <td className="px-3 py-2.5">
                                <button className="rounded p-0.5 text-slate-400 hover:text-emerald-600" title="查看付款情况">
                                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                </button>
                              </td>
                              <td className="px-3 py-2.5 font-medium">{c.contractType}</td>
                              <td className="px-3 py-2.5 text-slate-600">{c.landlordName ?? "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.electricityPrice ? fmtNum(c.electricityPrice) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.rentAmount ? fmtMoney(c.rentAmount) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.monthlyRent ? fmtMoney(c.monthlyRent) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.deposit ? fmtMoney(c.deposit) : "-"}</td>
                              <td className="px-3 py-2.5">{c.payMethod ?? "-"}</td>
                              <td className="whitespace-nowrap px-3 py-2.5">{fmtDate(c.startDate)} ~ {fmtDate(c.endDate)}</td>
                              <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${c.status === "已到期" || c.status === "提前结束" ? "text-rose-600" : c.status === "临期" ? "text-amber-600" : "text-slate-600"}`}>
                                {c.days_left ?? "-"}
                              </td>
                              <td className="px-3 py-2.5"><StatusBadge status={c.status} /></td>
                              <td className="max-w-[120px] truncate px-3 py-2.5 text-slate-500" title={c.remark ?? ""}>{c.remark ?? "-"}</td>
                              <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                                <div className="flex justify-center gap-0.5">
                                  <button className="rounded p-1 text-slate-400 hover:text-emerald-600" onClick={() => { setEditing(c); setFormType(c.contractType); setFormOpen(true); }}><Pencil className="h-3.5 w-3.5" /></button>
                                  <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => window.confirm("删除？") && del.mutate(c.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                                </div>
                              </td>
                            </tr>
                            {/* 展开：付款情况（可编辑） */}
                            {isExpanded && (
                              <tr key={`${c.id}-exp`} className="bg-slate-50/50">
                                <td colSpan={13} className="px-4 py-3">
                                  <ContractSchedule contractId={c.id} side="payment" title={`${c.landlordName || ""} 场地费 付款情况`} editable />
                                </td>
                              </tr>
                            )}
                          </>
                        );
                        });
                      })()}
                      {group.costContracts.length === 0 && (
                        <tr><td colSpan={13} className="py-4 text-center text-slate-400">暂无成本合同</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 收入合同（品牌方合同） */}
              <div>
                <div className="flex items-center gap-2 bg-emerald-50/50 px-5 py-2">
                  <ArrowUpCircle className="h-4 w-4 text-emerald-500" />
                  <span className="text-xs font-semibold text-emerald-600">收入合同（{group.incomeContracts.length} 份）</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b bg-slate-50">
                      <th className={th}></th>
                      <th className={th}>品牌方</th>
                      <th className={thR}>单柜场地月租</th>
                      <th className={thR}>计费柜数</th>
                      <th className={thR}>场地月租金</th>
                      <th className={thR}>承担场地成本</th>
                      <th className={thR}>电费单价（税前）</th>
                      <th className={thR}>电费单价（税后）</th>
                      <th className={thR}>押金</th>
                      <th className={thR}>首月场地租金</th>
                      <th className={thR}>场地费退款</th>
                      <th className={th}>场地租金付款方式</th>
                      <th className={th}>合同期限</th>
                      <th className={thR}>剩余天数</th>
                      <th className={th}>状态</th>
                      <th className={th}>备注</th>
                      <th className={`${th} text-center`}>操作</th>
                    </tr></thead>
                    <tbody>
                      {(() => {
                        // 到期拆分：未过期合同在上，已到期/提前结束在下（剩余天数按 0 显示）
                        const expiredInc = group.incomeContracts.filter((c: any) => c.status === "已到期" || c.status === "提前结束");
                        const seqInc: any[] = group.incomeContracts.filter((c: any) => c.status !== "已到期" && c.status !== "提前结束");
                        if (expiredInc.length > 0) seqInc.push({ divider: `已到期 / 提前结束（${expiredInc.length} 份）` }, ...expiredInc);
                        return seqInc.map((c: any, ci: number) => {
                        if (c.divider) {
                          return (
                            <tr key={`income-divider-${ci}`} className="bg-slate-100/80">
                              <td colSpan={17} className="px-3 py-1 text-[10px] font-medium text-slate-500">⬇ {c.divider}</td>
                            </tr>
                          );
                        }
                        const isExpanded = expandedContractId === c.id;
                        return (
                          <>
                            <tr key={c.id} onClick={() => setExpandedContractId(isExpanded ? null : c.id)} className={`cursor-pointer border-b last:border-0 hover:bg-slate-50/60 ${c.status === "已到期" ? "bg-rose-50/30" : c.status === "临期" ? "bg-amber-50/30" : c.status === "提前结束" ? "bg-violet-50/30" : ""}`}>
                              <td className="px-3 py-2.5">
                                <button className="rounded p-0.5 text-slate-400 hover:text-emerald-600" title="查看收款情况">
                                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                </button>
                              </td>
                              <td className="px-3 py-2.5 font-medium">
                                {c.brandName || <span className="text-purple-600">全部品牌共享</span>}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.unitMonthlyRent ? fmtMoney(c.unitMonthlyRent) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{(c.liveCabinetsCount ?? c.cabinetsCount) ? fmtNum(c.liveCabinetsCount ?? c.cabinetsCount) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.monthlyRent ? fmtMoney(c.monthlyRent) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-amber-600">{c.venueCost ? fmtMoney(c.venueCost) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.electricityPrice ? fmtNum(c.electricityPrice) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">
                                {c.taxEnabled && c.postTaxElectricityPrice
                                  ? <span className="text-emerald-600 font-medium">{fmtNum(c.postTaxElectricityPrice)}</span>
                                  : "-"}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.deposit ? fmtMoney(c.deposit) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.firstMonthRent ? fmtMoney(c.firstMonthRent) : "-"}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{c.rentRefund ? `-${fmtMoney(c.rentRefund)}` : "-"}</td>
                              <td className="px-3 py-2.5">{c.payMethod ?? "-"}</td>
                              <td className="whitespace-nowrap px-3 py-2.5">
                                {fmtDate(c.startDate)} ~ {fmtDate(c.earlyEndDate || c.endDate)}
                                {c.earlyEndDate && <span className="ml-1 text-[10px] text-rose-500">(提前结束)</span>}
                              </td>
                              <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${c.status === "已到期" || c.status === "提前结束" ? "text-rose-600" : c.status === "临期" ? "text-amber-600" : "text-slate-600"}`}>
                                {c.days_left ?? "-"}
                              </td>
                              <td className="px-3 py-2.5"><StatusBadge status={c.status} /></td>
                              <td className="max-w-[120px] truncate px-3 py-2.5 text-slate-500" title={c.remark ?? ""}>{c.remark ?? "-"}</td>
                              <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                                <div className="flex justify-center gap-0.5">
                                  {Number(c.rentRefund) > 0 && (
                                    <button className="rounded p-1 text-slate-400 hover:text-sky-600" title="提交场地费退款审批" onClick={() => setRefundTarget(c)}><FileText className="h-3.5 w-3.5" /></button>
                                  )}
                                  <button className="rounded p-1 text-slate-400 hover:text-emerald-600" onClick={() => { setEditing(c); setFormType("品牌方合同"); setFormOpen(true); }}><Pencil className="h-3.5 w-3.5" /></button>
                                  <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => window.confirm("删除？") && del.mutate(c.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                                </div>
                              </td>
                            </tr>
                            {/* 展开：收款情况（可编辑） */}
                            {isExpanded && (
                              <tr key={`${c.id}-exp`} className="bg-slate-50/50">
                                <td colSpan={17} className="px-4 py-3">
                                  <ContractSchedule contractId={c.id} side="income" title={`${c.brandName || "全部品牌共享"} 场地费 收款情况`} editable />
                                </td>
                              </tr>
                            )}
                          </>
                        );
                        });
                      })()}
                      {group.incomeContracts.length === 0 && (
                        <tr><td colSpan={17} className="py-4 text-center text-slate-400">暂无收入合同</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        })}
              </div>
              )}
            </div>
          );
        })}
        {entityGroups.length === 0 && (
          <div className="rounded-xl border border-dashed py-16 text-center text-slate-400">
            {list.isLoading ? "加载中…" : "暂无合同数据"}
          </div>
        )}
      </div>

      <ContractForm open={formOpen} onClose={() => { setFormOpen(false); setEditing(null); }} record={editing} defaultType={formType} />

      {/* 场地费退款审批弹窗（列表行入口） */}
      <RefundApprovalDialog
        open={!!refundTarget}
        onClose={() => setRefundTarget(null)}
        info={refundTarget ? {
          landlordName: refundTarget.landlordName ?? "",
          brandName: refundTarget.brandName ?? "",
          endDate: fmtDate(refundTarget.earlyEndDate || refundTarget.endDate),
          rentRefund: Number(refundTarget.rentRefund) || 0,
          deposit: Number(refundTarget.deposit) || 0,
        } : null}
        onConfirm={handleRefundApproval}
      />

      {/* Excel 导入结果 */}
      <Dialog open={importResult !== null} onOpenChange={(o) => !o && setImportResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Excel 导入结果</DialogTitle></DialogHeader>
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-700">成功导入 {importResult?.imported ?? 0} 条</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600">跳过 {importResult?.skipped ?? 0} 条</span>
            </div>
            {((importResult?.created_landlords ?? []).length > 0 || (importResult?.created_brands ?? []).length > 0 || (importResult?.created_entities ?? []).length > 0) && (
              <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
                <div className="mb-1 font-medium text-amber-700">自动新建（Excel 中不存在的基础档案）</div>
                <div className="text-slate-600">
                  {(importResult?.created_entities ?? []).length > 0 && <>公司主体：{importResult.created_entities.join("、")}<br /></>}
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
              (importResult?.imported ?? 0) === 0 && (
                <div className="text-slate-500">未导入新合同（可能全部已存在或数据为空）</div>
              )
            )}
            <div className="text-[10px] text-slate-400">导入自动按 Excel 中的场地方/品牌方名称匹配，不存在的会自动新建。</div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={() => setImportResult(null)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── 合同表单分区 ───
function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="h-3 w-1 rounded-full bg-emerald-500" />
        <span className="text-xs font-semibold text-slate-600">{title}</span>
      </div>
      <div className="grid grid-cols-4 items-end gap-3">{children}</div>
    </div>
  );
}

// ─── 场地费退款审批弹窗 ───
function RefundApprovalDialog({ open, onClose, info, onConfirm, saving }: {
  open: boolean;
  onClose: () => void;
  info: { landlordName: string; brandName: string; endDate: string; rentRefund: number; deposit: number } | null;
  onConfirm: (p: { rentRefund: number; depositRefund: number; applicant: string; remark: string }) => void;
  saving?: boolean;
}) {
  const [rentRefund, setRentRefund] = useState("");
  const [depositRefund, setDepositRefund] = useState("");
  const [applicant, setApplicant] = useState("");
  const [remark, setRemark] = useState("");
  useEffect(() => {
    if (open && info) {
      setRentRefund(String(info.rentRefund ?? 0));
      setDepositRefund(String(info.deposit ?? 0));
      setRemark("");
      try { setApplicant(JSON.parse(localStorage.getItem("dsh_user") || "{}").name || ""); } catch { setApplicant(""); }
    }
  }, [open, info]);
  const total = (Number(rentRefund) || 0) + (Number(depositRefund) || 0);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-lg">
        <DialogHeader><DialogTitle>提交场地费退款审批</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div>场地方 / 品牌方：{info?.landlordName || "-"} · {info?.brandName || "-"}</div>
            <div>合同提前结束日期：{info?.endDate || "—"}</div>
            <div>合同押金：{info ? fmtMoney(info.deposit) : "-"}（默认全额退还，可按协商结果修改）</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="场地费退款（元）"><NumInput value={rentRefund} onChange={setRentRefund} placeholder="0" /></Field>
            <Field label="押金退还（元）"><NumInput value={depositRefund} onChange={setDepositRefund} placeholder="0" /></Field>
          </div>
          <Field label="合计退款（元）">
            <div className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold tabular-nums text-slate-700">{fmtMoney(total)}</div>
          </Field>
          <Field label="经办人"><TextInput value={applicant} onChange={setApplicant} placeholder="经办人姓名" /></Field>
          <Field label="备注（供审核人员参考）">
            <textarea
              className={inputCls + " w-full"}
              rows={3}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="如：退租原因、扣款说明、协商结果等"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={saving || total <= 0}
              onClick={() => onConfirm({ rentRefund: Number(rentRefund) || 0, depositRefund: Number(depositRefund) || 0, applicant: applicant.trim() || "经办人", remark: remark.trim() })}>
              提交审批
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── 合同表单 ───
function ContractForm({ open, onClose, record, defaultType }: { open: boolean; onClose: () => void; record?: any; defaultType?: string }) {
  const blank = {
    landlordId: "", brandId: "", contractType: defaultType || "场地合同",
    electricityPrice: "", rentAmount: "", cabinetsCount: "", unitMonthlyRent: "", monthlyRent: "",
    rentCalcMethod: defaultType === "品牌方合同" ? "按柜子数量" : "固定价格", payMethod: "", rentAdvanceDays: "0",
    region: "", address: "", latitude: "", longitude: "", payEntity: "", entityId: "",
    startDate: "", endDate: "",
    taxEnabled: false, taxRate: "0.01", postTaxElectricityPrice: "",
    deposit: "", firstMonthRent: "", rentRefund: "", earlyEndDate: "",
    rentTaxEnabled: false, rentTaxRate: "0.01", postTaxRentPrice: "",
    remark: "",
  };
  const [f, setF] = useState(blank);
  const queryClient = useQueryClient();
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands, enabled: open });
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords, enabled: open });
  const entities = useQuery({ queryKey: ["entities"], queryFn: listEntities, enabled: open });
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters(), enabled: open });
  const cabinets = useQuery({ queryKey: ["allCabinets"], queryFn: () => listCabinets(), enabled: open });
  const contracts = useQuery({ queryKey: ["contracts"], queryFn: () => listContracts(), enabled: open });
  const audit = useQuery({
    queryKey: ["contractAudit", record?.id],
    queryFn: () => getContractAudit(record.id),
    enabled: open && !!record?.id,
  });

  // 计费柜数自动计算：匹配(场地方+品牌方)的电表，每块电表至少 1 柜（max(1, 实际柜子数)），
  // 排除 TEST 前缀电表——与后端 live_cabinets_count 口径一致；
  // 收入合同不指定品牌（空 / "shared"）= 全品牌合同，匹配该场地的共享电表（无品牌且标签=共享电表）
  const autoCabinetCount = useMemo(() => {
    if (!f.landlordId || f.contractType !== "品牌方合同") return null;
    const isShared = !f.brandId || f.brandId === "shared";
    // 找到匹配的电表
    const matchedMeters = (meters.data ?? []).filter((m: any) =>
      m.landlordId === Number(f.landlordId)
      && (isShared ? (!m.brandId && m.tag === "共享电表") : m.brandId === Number(f.brandId))
      && !String(m.meterNo || "").startsWith("TEST")
    );
    const meterIds = new Set(matchedMeters.map((m: any) => m.id));
    // 这些电表下的实际柜子数
    const cabByMeter = new Map<number, number>();
    (cabinets.data ?? []).forEach((c: any) => {
      if (meterIds.has(c.meterId)) cabByMeter.set(c.meterId, (cabByMeter.get(c.meterId) || 0) + 1);
    });
    // 每块电表至少计 1 柜
    return matchedMeters.reduce((sum: number, m: any) => sum + Math.max(1, cabByMeter.get(m.id) || 0), 0);
  }, [f.landlordId, f.brandId, f.contractType, meters.data, cabinets.data]);

  // 该场地下所有收入合同（品牌方合同）的计费柜数总和（实时：与品牌方合同行同口径，
  // 优先后端实时统计 liveCabinetsCount，电表归属变更后自动跟随；存储 cabinetsCount 仅兜底）
  const incomeCabinetsTotal = useMemo(() => {
    if (!f.landlordId) return 0;
    return (contracts.data ?? [])
      .filter((c: any) => c.landlordId === Number(f.landlordId) && c.contractType === "品牌方合同")
      .reduce((sum: number, c: any) => sum + (Number(c.liveCabinetsCount ?? c.cabinetsCount) || 0), 0);
  }, [f.landlordId, contracts.data]);

  // 当自动计算的柜子数变化时，更新表单
  useEffect(() => {
    if (autoCabinetCount !== null && autoCabinetCount > 0) {
      setF((prev) => ({ ...prev, cabinetsCount: String(autoCabinetCount) }));
    }
  }, [autoCabinetCount]);

  // 承担场地成本实时计算：场地合同月租金总和 ÷ 该场地所有计费柜数总和 × 本合同计费柜数
  // 口径与后端 contract_repo live_cabinets_count/total_brand_cabinets 一致：
  // 每块电表按 1 柜计（即 GREATEST(1,柜数)），仅排除 TEST 前缀电表；
  // 场地总柜数含共享电表，全品牌合同（不指定品牌）按共享电表计
  const venueCostLive = useMemo(() => {
    if (!f.landlordId || f.contractType !== "品牌方合同") return null;
    const landlordId = Number(f.landlordId);
    const isShared = !f.brandId || f.brandId === "shared";
    const brandId = isShared ? null : Number(f.brandId);

    // 1) 该场地方所有「场地合同」月租金之和
    const venueMonthlyRent = (contracts.data ?? [])
      .filter((c: any) => c.landlordId === landlordId && c.contractType === "场地合同")
      .reduce((sum: number, c: any) => sum + Number(c.monthlyRent || 0), 0);
    if (!venueMonthlyRent) return null;

    // 2) 该场地下已归属品牌的电表 + 共享电表（排除 TEST 前缀，与后端 NOT LIKE 'TEST%' 一致）
    const siteMeters = (meters.data ?? []).filter(
      (m: any) => m.landlordId === landlordId && (m.brandId != null || m.tag === "共享电表") && !String(m.meterNo || "").startsWith("TEST")
    );

    // 3) 本合同覆盖电表数 / 该场地总电表数（每表计 1 柜）
    const liveCabs = isShared
      ? siteMeters.filter((m: any) => !m.brandId).length
      : siteMeters.filter((m: any) => m.brandId === brandId).length;
    const totalCabs = siteMeters.length;
    if (!totalCabs) return null;

    return Math.round((venueMonthlyRent / totalCabs) * liveCabs * 100) / 100;
  }, [f.landlordId, f.brandId, f.contractType, contracts.data, meters.data]);

  // 当使用"按柜子数量"方式时，自动计算场地月租金，并同步年租金 = 月租金 × 12
  useEffect(() => {
    if (f.rentCalcMethod === "按柜子数量" && f.unitMonthlyRent && f.cabinetsCount) {
      const calculated = Number(f.unitMonthlyRent) * Number(f.cabinetsCount);
      setF((prev) => ({
        ...prev,
        monthlyRent: String(calculated),
        rentAmount: String(Math.round(calculated * 12 * 100) / 100),
      }));
    }
  }, [f.rentCalcMethod, f.unitMonthlyRent, f.cabinetsCount]);

  // 场地合同「按柜子数量」：每柜场地成本 × 该场地下收入合同计费柜数总和（动态）
  useEffect(() => {
    if (f.contractType === "场地合同" && f.rentCalcMethod === "按柜子数量" && f.unitMonthlyRent && incomeCabinetsTotal > 0) {
      const calculated = Number(f.unitMonthlyRent) * incomeCabinetsTotal;
      setF((prev) => ({
        ...prev,
        monthlyRent: String(calculated),
        rentAmount: String(Math.round(calculated * 12 * 100) / 100),
      }));
    }
  }, [f.contractType, f.rentCalcMethod, f.unitMonthlyRent, incomeCabinetsTotal]);

  // 年租金和月租金互算（在输入时直接计算，避免循环依赖）
  const handleMonthlyRentChange = (v: string) => {
    setF((prev) => {
      const updates: any = { monthlyRent: v };
      if (v) {
        updates.rentAmount = String(Math.round(Number(v) * 12 * 100) / 100);
      }
      return { ...prev, ...updates };
    });
  };

  const handleRentAmountChange = (v: string) => {
    setF((prev) => {
      const updates: any = { rentAmount: v };
      if (v) {
        updates.monthlyRent = String(Math.round((Number(v) / 12) * 100) / 100);
      }
      return { ...prev, ...updates };
    });
  };

  useEffect(() => {
    if (!open) return;
    if (record) {
      setF({
        landlordId: record.landlordId ? String(record.landlordId) : "",
        // 品牌方合同未指定品牌 = 全品牌合同（覆盖场地内共享电表），下拉首项即此选项
        brandId: record.brandId ? String(record.brandId) : "",
        contractType: record.contractType ?? "场地合同",
        electricityPrice: record.electricityPrice ? String(record.electricityPrice) : "", rentAmount: record.rentAmount ? String(record.rentAmount) : "",
        cabinetsCount: record.cabinetsCount ? String(record.cabinetsCount) : "", unitMonthlyRent: record.unitMonthlyRent ? String(record.unitMonthlyRent) : "",
        rentCalcMethod: record.rent_calc_method || (record.contractType === "品牌方合同" ? "按柜子数量" : "固定价格"),
        monthlyRent: record.monthlyRent ? String(record.monthlyRent) : "", payMethod: record.payMethod ?? "",
        rentAdvanceDays: record.rentAdvanceDays != null ? String(record.rentAdvanceDays) : "0",
        region: record.region ?? "", address: record.address ?? "",
        latitude: record.latitude != null ? String(record.latitude) : "",
        longitude: record.longitude != null ? String(record.longitude) : "",
        payEntity: record.payEntity ?? "",
        entityId: record.entityId ? String(record.entityId) : "",
        startDate: record.startDate ? String(record.startDate).slice(0, 10) : "", endDate: record.endDate ? String(record.endDate).slice(0, 10) : "",
        taxEnabled: record.taxEnabled ?? false, taxRate: record.taxRate ? String(record.taxRate) : "0.01",
        postTaxElectricityPrice: record.postTaxElectricityPrice ? String(record.postTaxElectricityPrice) : "",
        deposit: record.deposit ? String(record.deposit) : "",
        firstMonthRent: record.firstMonthRent ? String(record.firstMonthRent) : "",
        rentRefund: record.rentRefund ? String(record.rentRefund) : "",
        earlyEndDate: record.earlyEndDate ? String(record.earlyEndDate).slice(0, 10) : "",
        rentTaxEnabled: record.rentTaxEnabled ?? false,
        rentTaxRate: record.rentTaxRate ? String(record.rentTaxRate) : "0.01",
        postTaxRentPrice: record.postTaxRentPrice ? String(record.postTaxRentPrice) : "",
        remark: record.remark ?? "",
      });
    } else {
      setF({ ...blank, contractType: defaultType || "场地合同" });
    }
  }, [open, record]);

  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: (data: any) => record ? updateContract(record.id, data) : createContract(data),
    onSuccess: () => { toast.success("合同已保存"); queryClient.invalidateQueries(); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  const submit = (afterSave?: () => void) => {
    if (!f.landlordId) { toast.error("请选择场地方"); return; }
    if (f.contractType === "品牌方合同" && !f.landlordId) { toast.error("品牌方合同必须关联场地方"); return; }
    // 唯一场地合同校验：同一个场地方只能有一个场地合同
    if (f.contractType === "场地合同") {
      const dup = (contracts.data ?? []).find((c: any) =>
        c.landlordId === Number(f.landlordId) && c.contractType === "场地合同" && c.id !== record?.id
      );
      if (dup) {
        toast.error(`该场地方已存在场地合同（${dup.landlordName || ""}），一个场地方只能有一份场地合同`);
        return;
      }
    }
    // 计算税后电费单价（统一口径：税费 = 收入 × 税率 → 税后单价 = 税前单价 × (1 − 税率)）
    const taxEnabled = f.taxEnabled;
    const taxRate = taxEnabled ? Number(f.taxRate) : null;
    const elecPrice = f.electricityPrice ? Number(f.electricityPrice) : null;
    const postTaxPrice = taxEnabled && elecPrice && taxRate !== null
      ? Math.round((elecPrice * (1 - taxRate)) * 100) / 100
      : null;

    // 计算税后场地租金单价（同上口径）
    const rentTaxEnabled = f.rentTaxEnabled;
    const rentTaxRate = rentTaxEnabled ? Number(f.rentTaxRate) : null;
    const monthlyRent = f.monthlyRent ? Number(f.monthlyRent) : null;
    const postTaxRentPrice = rentTaxEnabled && monthlyRent && rentTaxRate !== null
      ? Math.round((monthlyRent * (1 - rentTaxRate)) * 100) / 100
      : null;

    // 填了提前结束日期必须同时填写场地费退款金额（后端同样校验）
    if (f.earlyEndDate && !(f.rentRefund && Number(f.rentRefund) > 0)) {
      toast.error("填写了合同提前结束日期，必须同时填写场地费退款金额");
      return;
    }

    // 拆期预检：合同期限不足以凑成完整付款周期时提醒（尾期金额留空，由用户手动填写）
    const effEnd = f.earlyEndDate || f.endDate;
    if (f.payMethod && f.startDate && effEnd) {
      const periods = splitPeriodsPreview(f.startDate, effEnd, f.payMethod);
      const shortOnes = periods.filter(p => p.pe < p.nominalEnd);
      if (shortOnes.length > 0) {
        const last = shortOnes[shortOnes.length - 1];
        const dayLen = Math.round((last.pe.getTime() - last.ps.getTime()) / 86400000) + 1;
        const okGo = window.confirm(
          `合同期限与「${f.payMethod}」周期不匹配：\n` +
          `最后一期 ${ymd(last.ps)} ~ ${ymd(last.pe)} 只有 ${dayLen} 天，不足一个完整的${f.payMethod}周期。\n\n` +
          `该期金额将留空，保存后请在合同详情的分期列表中点「填金额」手动录入。确定这样拆期吗？`
        );
        if (!okGo) return;
      }
    }

    save.mutate({
      landlordId: f.landlordId ? Number(f.landlordId) : null,
      brandId: f.brandId && f.brandId !== "shared" ? Number(f.brandId) : null,
      contractType: f.contractType,
      electricityPrice: elecPrice,
      rentAmount: f.rentAmount ? Number(f.rentAmount) : null,
      // cabinetsCount 已退役（2026-09）：计费柜数唯一源=实时统计，不再写入存储快照
      unitMonthlyRent: f.unitMonthlyRent ? Number(f.unitMonthlyRent) : null,
      rentCalcMethod: f.rentCalcMethod,
      monthlyRent: f.monthlyRent ? Number(f.monthlyRent) : null,
      payMethod: f.payMethod || null,
      rentAdvanceDays: f.rentAdvanceDays === "" ? 0 : Number(f.rentAdvanceDays),
      region: f.region || null,
      address: f.address || null,
      latitude: numOrNull(f.latitude),
      longitude: numOrNull(f.longitude),
      payEntity: f.payEntity || null,
      // 主体归属：场地合同可选（默认继承来源）；品牌方合同以电表主体为准，不再携带
      entityId: f.contractType === "场地合同" ? (f.entityId ? Number(f.entityId) : null) : null,
      startDate: f.startDate || null,
      endDate: f.endDate || null,
      taxEnabled,
      taxRate,
      postTaxElectricityPrice: postTaxPrice,
      deposit: f.deposit ? Number(f.deposit) : null,
      firstMonthRent: f.firstMonthRent ? Number(f.firstMonthRent) : null,
      rentRefund: f.rentRefund ? Number(f.rentRefund) : null,
      earlyEndDate: f.earlyEndDate || (f.rentRefund && Number(f.rentRefund) > 0 ? new Date().toISOString().slice(0, 10) : null),
      rentTaxEnabled,
      rentTaxRate,
      postTaxRentPrice,
      remark: f.remark || null,
    }, { onSuccess: () => { afterSave?.(); } });
  };

  // 弹窗内：保存当前合同并提交场地费退款审批（仅已保存的合同可用）
  const [refundApprovalOpen, setRefundApprovalOpen] = useState(false);
  const handleRefundApprovalConfirm = (p: { rentRefund: number; depositRefund: number; applicant: string; remark: string }) => {
    submit(() => {
      const landlordName = (landlords.data ?? []).find((l: any) => l.id === Number(f.landlordId))?.name ?? "";
      const brandName = (brands.data ?? []).find((b: any) => b.id === Number(f.brandId))?.name ?? "";
      createApproval({
        bizType: "场地费退款",
        title: `${landlordName} ${brandName} 提前终止退款`.trim(),
        applicant: p.applicant,
        amount: p.rentRefund + p.depositRefund,
        reason: `品牌方合同提前于 ${fmtDate(f.earlyEndDate || f.endDate)} 结束；场地费退款 ${p.rentRefund} 元，押金退还 ${p.depositRefund} 元${p.remark ? `；备注：${p.remark}` : ""}`,
        landlordId: Number(f.landlordId),
        rentAmount: p.rentRefund,
        contractId: record.id,
      }).then(() => {
        toast.success("退款审批已提交，可在「审批中心」查看进度");
        setRefundApprovalOpen(false);
      }).catch((e: any) => toast.error(e.response?.data?.detail || e.message || "提交失败"));
    });
  };

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-7xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{record ? "编辑合同" : "新增合同"}</DialogTitle></DialogHeader>
        <div className="space-y-5">
          <FormSection title="基本信息">
            <Field label="合同类型 *">
              <SelectInput value={f.contractType} onChange={set("contractType")}
                options={[{ value: "场地合同", label: "场地合同" }, { value: "品牌方合同", label: "品牌方合同" }]} />
            </Field>

            {f.contractType === "场地合同" && (
              <Field label="场地方 *">
                <SearchSelect value={f.landlordId} onChange={set("landlordId")}
                  placeholder="请选择或搜索场地方"
                  options={[{ value: "", label: "请选择场地方" }, ...(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))]} />
              </Field>
            )}

            {f.contractType === "品牌方合同" && (
              <>
                <Field label="关联场地 *">
                  <SearchSelect value={f.landlordId} onChange={set("landlordId")}
                    placeholder="请选择或搜索场地方"
                    options={[{ value: "", label: "请选择场地方" }, ...(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))]} />
                </Field>
                <Field label="品牌方">
                  <SelectInput value={f.brandId} onChange={set("brandId")}
                    options={[
                      // 首项即默认：不指定品牌 = 全品牌合同，计费柜数/电费收款按场地内共享电表计算
                      { value: "", label: "全部品牌（共享电表）" },
                      ...(brands.data ?? []).map((b: any) => ({ value: String(b.id), label: b.name })),
                    ]} />
                </Field>
                <Field label="计费方式">
                  <SelectInput value={f.rentCalcMethod} onChange={set("rentCalcMethod")}
                    options={[{ value: "按柜子数量", label: "按柜子数量" }, { value: "固定价格", label: "固定价格" }]} />
                </Field>
              </>
            )}
            {f.contractType === "场地合同" && (
              <Field label="收付款主体">
                <SearchSelect value={f.entityId} onChange={set("entityId")}
                  placeholder="未指定（可搜索公司主体）"
                  options={(entities.data ?? []).map((e: any) => ({ value: String(e.id), label: e.name }))} />
                <div className="-mt-1.5 text-[11px] text-slate-400">
                  场地成本默认全额归该主体；不指定时按柜数分摊到场地内各主体
                </div>
              </Field>
            )}
            {f.contractType === "品牌方合同" && (
              <div className="rounded border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 text-[11px] leading-5 text-slate-500 md:col-span-2">
                报税主体以电表关联为准（在「智慧电表」页为每块电表设置）：租金收入会按该场地该品牌电表的柜数自动分摊到各主体，无需在此选择。
              </div>
            )}
          </FormSection>

          {f.contractType === "场地合同" && (
            <FormSection title="场地位置">
              <Field label="区域"><TextInput value={f.region} onChange={set("region")} placeholder="如：官渡" /></Field>
              <Field label="地址"><TextInput value={f.address} onChange={set("address")} /></Field>
              <div className="col-span-4">
                <Field label="场地位置（地图）">
                  <MapPicker
                    latitude={f.latitude ? parseFloat(f.latitude) : null}
                    longitude={f.longitude ? parseFloat(f.longitude) : null}
                    onLocationChange={(lat, lng) => setF((p) => ({ ...p, latitude: String(lat), longitude: String(lng) }))}
                  />
                </Field>
              </div>
            </FormSection>
          )}

          <FormSection title="租金与费用">
            {f.contractType === "场地合同" && (
              <>
                <Field label="场地租金计费方式">
                  <SelectInput value={f.rentCalcMethod} onChange={set("rentCalcMethod")}
                    options={[{ value: "固定价格", label: "固定金额" }, { value: "按柜子数量", label: "按柜子数量（收入合同柜数×每柜成本）" }]} />
                </Field>
                {f.rentCalcMethod === "按柜子数量" && (
                  <>
                    <Field label="每柜场地成本（元/月）">
                      <NumInput value={f.unitMonthlyRent} onChange={set("unitMonthlyRent")} placeholder="如：300" />
                    </Field>
                    <div>
                      <span className="mb-1 block text-xs font-medium text-slate-500">
                        计费柜数（来自收入合同）
                        <span className="block text-[10px] font-normal text-slate-400">= 该场地下品牌方合同覆盖品牌的电表实时统计（电表管理里关联后自动跟随）</span>
                      </span>
                      <div className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold tabular-nums text-slate-700">
                        {incomeCabinetsTotal > 0 ? `${incomeCabinetsTotal} 柜` : (f.landlordId ? "0 柜（暂无收入合同，或电表未关联到该场地的品牌）" : "请先选择场地方")}
                      </div>
                    </div>
                  </>
                )}
                <Field label={f.rentCalcMethod === "按柜子数量" ? "月租金（元）" : "月租金（元）"}>
                  <NumInput
                    value={f.monthlyRent}
                    onChange={handleMonthlyRentChange}
                    disabled={f.rentCalcMethod === "按柜子数量"}
                    placeholder={f.rentCalcMethod === "按柜子数量" ? `每柜成本 × ${incomeCabinetsTotal} 柜 = 自动计算` : "请输入"}
                  />
                </Field>
                <Field label="年租金（元）">
                  <NumInput
                    value={f.rentAmount}
                    onChange={handleRentAmountChange}
                    disabled={f.rentCalcMethod === "按柜子数量"}
                    placeholder={f.rentCalcMethod === "按柜子数量" ? "自动计算（月租 × 12）" : "请输入"}
                  />
                </Field>
                <Field label="电费单价（元/度）"><NumInput value={f.electricityPrice} onChange={set("electricityPrice")} placeholder="0.65" /></Field>
                <Field label="场地租金付款方式">
                  <SelectInput value={f.payMethod} onChange={set("payMethod")}
                    options={[{ value: "", label: "请选择" }, { value: "月付", label: "月付" }, { value: "季付", label: "季付" }, { value: "半年付", label: "半年付" }, { value: "年付", label: "年付" }]} />
                </Field>
                {f.payMethod && f.startDate && (f.earlyEndDate || f.endDate) && (
                  <div className="rounded border border-amber-200 bg-amber-50/60 px-2.5 py-1.5 text-[11px] leading-5 text-amber-800 md:col-span-2">
                    将拆成 {splitPeriodsPreview(f.startDate, f.earlyEndDate || f.endDate, f.payMethod).length} 期：
                    {splitPeriodsPreview(f.startDate, f.earlyEndDate || f.endDate, f.payMethod).map((p, i) => (
                      <span key={i} className="mr-2">
                        第{i + 1}期 {ymd(p.ps)}~{ymd(p.pe)}{p.pe < p.nominalEnd ? "（不足整期，金额留空待手填）" : ""}
                      </span>
                    ))}
                  </div>
                )}
                <Field label="押金（元）"><NumInput value={f.deposit} onChange={set("deposit")} placeholder="0" /></Field>
                <Field label="场地租金提前支付（天）"><NumInput value={f.rentAdvanceDays} onChange={set("rentAdvanceDays")} placeholder="0" /></Field>
              </>
            )}

            {f.contractType === "品牌方合同" && (
              <>
                {f.rentCalcMethod === "按柜子数量" && (
                  <>
                    <Field label="单柜场地月租金（元）"><NumInput value={f.unitMonthlyRent} onChange={set("unitMonthlyRent")} /></Field>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">计费柜数</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        className="w-16 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-600 text-center cursor-not-allowed"
                        value={autoCabinetCount ?? f.cabinetsCount ?? ""}
                        readOnly
                        placeholder="-"
                      />
                      {autoCabinetCount !== null && (
                        <div className="flex items-center gap-1 text-xs text-slate-500">
                          <span>（来自电表管理）</span>
                          <button
                            type="button"
                            className="inline-flex items-center gap-0.5 text-emerald-600 hover:text-emerald-700 hover:underline"
                            onClick={() => { onClose(); window.location.href = `/meters?landlord=${f.landlordId}&brand=${f.brandId || "shared"}&highlight=cabinet`; }}
                          >
                            去修改 <ExternalLink className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                      {autoCabinetCount === null && !f.cabinetsCount && (
                        <span className="text-xs text-slate-400">请先选择场地方</span>
                      )}
                    </div>
                  </div>
                </>
              )}
              <Field label="场地月租金（元）">
                <NumInput
                  value={f.monthlyRent}
                  onChange={handleMonthlyRentChange}
                  disabled={f.rentCalcMethod === "按柜子数量"}
                  placeholder={f.rentCalcMethod === "按柜子数量" ? "自动计算" : "请输入"}
                />
              </Field>
              <Field label="年租金（元）">
                <NumInput
                  value={f.rentAmount}
                  disabled
                  placeholder="自动计算"
                  onChange={() => {}}
                />
              </Field>
              <div>
                <span className="mb-1 block text-xs font-medium text-slate-500">
                  承担场地成本（元/月）
                  <span className="block text-[10px] font-normal text-slate-400">根据场地合同月租金和所有品牌方计费柜数自动计算，不可编辑</span>
                </span>
                <div className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-amber-600 font-semibold tabular-nums">
                  {venueCostLive != null ? fmtMoney(venueCostLive) : (record?.venueCost ? fmtMoney(record.venueCost) : "暂无场地合同")}
                </div>
              </div>
              <Field label="电费收款单价（税前·元/度）"><NumInput value={f.electricityPrice} onChange={set("electricityPrice")} placeholder="1.20" /></Field>
              <Field label="场地租金收款方式">
                <SelectInput value={f.payMethod} onChange={set("payMethod")}
                  options={[{ value: "", label: "请选择" }, { value: "月付", label: "月收" }, { value: "季付", label: "季收" }, { value: "半年付", label: "半年收" }, { value: "年付", label: "年收" }]} />
              </Field>
              {f.payMethod && f.startDate && (f.earlyEndDate || f.endDate) && (
                <div className="rounded border border-amber-200 bg-amber-50/60 px-2.5 py-1.5 text-[11px] leading-5 text-amber-800 md:col-span-2">
                  将拆成 {splitPeriodsPreview(f.startDate, f.earlyEndDate || f.endDate, f.payMethod).length} 期：
                  {splitPeriodsPreview(f.startDate, f.earlyEndDate || f.endDate, f.payMethod).map((p, i) => (
                    <span key={i} className="mr-2">
                      第{i + 1}期 {ymd(p.ps)}~{ymd(p.pe)}{p.pe < p.nominalEnd ? "（不足整期，金额留空待手填）" : ""}
                    </span>
                  ))}
                </div>
              )}
              <Field label="押金（元）"><NumInput value={f.deposit} onChange={set("deposit")} placeholder="0" />
                {!!Number(record?.depositRefundAmount) && (
                  <span className="mt-0.5 block text-[11px] text-rose-600">
                    已退押金 {fmtMoney(record.depositRefundAmount)} 元（{fmtDate(record.depositRefundDate)}）
                  </span>
                )}
              </Field>
              <div className="col-span-4 grid grid-cols-3 items-end gap-3">
                <Field label="首月场地租金（元）"><NumInput value={f.firstMonthRent} onChange={set("firstMonthRent")} placeholder="按整月算则留空" /></Field>
                <Field label="场地费退款（元）"><NumInput value={f.rentRefund} onChange={set("rentRefund")} placeholder="0" /></Field>
                <Field label="合同提前结束日期">
                  <DateInput
                    value={f.earlyEndDate || ""}
                    onChange={set("earlyEndDate")}
                  />
                </Field>
              </div>
              {!!record?.id && Number(f.rentRefund) > 0 && (
                <button type="button" onClick={() => setRefundApprovalOpen(true)}
                  className="col-span-4 -mt-2 text-right text-[11px] font-medium text-sky-600 hover:text-sky-700">
                  提交场地费退款审批（保存合同并送审批）→
                </button>
              )}
            </>
          )}
          </FormSection>

          {f.contractType === "品牌方合同" && (
          <FormSection title="税费计算">
            <div className="col-span-4">
              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                <Switch checked={f.taxEnabled} onCheckedChange={(v) => setF((p) => ({ ...p, taxEnabled: v }))} />
                  <span className="text-sm text-slate-700">计算税后电费单价</span>
                  {f.taxEnabled && (
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-xs text-slate-500">税率</span>
                      <select
                        className="rounded border border-slate-200 px-2 py-1 text-sm"
                        value={f.taxRate}
                        onChange={(e) => set("taxRate")(e.target.value)}
                      >
                        <option value="0.01">1%</option>
                        <option value="0.03">3%</option>
                        <option value="0.05">5%</option>
                        <option value="0.06">6%</option>
                        <option value="0.09">9%</option>
                        <option value="0.13">13%</option>
                      </select>
                      <span className="text-xs text-slate-500">或自定义</span>
                      <input
                        type="number"
                        className="w-20 rounded border border-slate-200 px-2 py-1 text-sm"
                        placeholder="0.01"
                        value={f.taxRate}
                        onChange={(e) => set("taxRate")(e.target.value)}
                        step="0.01"
                        min="0"
                        max="1"
                      />
                      {f.electricityPrice && (
                        <span className="ml-2 text-sm font-medium text-emerald-600">
                          税后单价 ≈ {fmtNum(Math.round((Number(f.electricityPrice) * (1 - Number(f.taxRate))) * 100) / 100)} 元/度
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-4">
                <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <Switch checked={f.rentTaxEnabled} onCheckedChange={(v) => setF((p) => ({ ...p, rentTaxEnabled: v }))} />
                  <span className="text-sm text-slate-700">计算税后场地租金单价</span>
                  {f.rentTaxEnabled && (
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-xs text-slate-500">税率</span>
                      <select
                        className="rounded border border-slate-200 px-2 py-1 text-sm"
                        value={f.rentTaxRate}
                        onChange={(e) => set("rentTaxRate")(e.target.value)}
                      >
                        <option value="0.01">1%</option>
                        <option value="0.03">3%</option>
                        <option value="0.05">5%</option>
                        <option value="0.06">6%</option>
                        <option value="0.09">9%</option>
                        <option value="0.13">13%</option>
                      </select>
                      <span className="text-xs text-slate-500">或自定义</span>
                      <input
                        type="number"
                        className="w-20 rounded border border-slate-200 px-2 py-1 text-sm"
                        placeholder="0.01"
                        value={f.rentTaxRate}
                        onChange={(e) => set("rentTaxRate")(e.target.value)}
                        step="0.01"
                        min="0"
                        max="1"
                      />
                      {f.monthlyRent && (
                        <span className="ml-2 text-sm font-medium text-emerald-600">
                          税后月租金 ≈ {fmtMoney(Math.round((Number(f.monthlyRent) * (1 - Number(f.rentTaxRate))) * 100) / 100)} 元
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </FormSection>
          )}

          <FormSection title="合同信息">
            <Field label="开始日期"><DateInput value={f.startDate} onChange={set("startDate")} /></Field>
            <Field label="结束日期"><DateInput value={f.endDate} onChange={set("endDate")} /></Field>
            <Field label="备注"><TextInput value={f.remark} onChange={set("remark")} /></Field>
          </FormSection>

          {/* 变更审计：谁在什么时候改了什么 */}
          {record?.id && (
            <FormSection title="变更记录">
              <div className="col-span-4 max-h-40 space-y-1 overflow-y-auto rounded-md bg-slate-50/70 p-2 text-xs">
                {(audit.data ?? []).length === 0 && <div className="text-slate-400">暂无变更记录</div>}
                {(audit.data ?? []).map((a: any) => (
                  <div key={a.id} className="leading-5">
                    <span className="text-slate-400">{fmtDate((a.createdAt || "").slice(0, 10))} {(a.createdAt || "").slice(11, 16)}</span>
                    <span className="mx-1 font-medium text-slate-600">{a.operator || "—"}</span>
                    <span className={`rounded px-1 ${a.action === "create" ? "bg-emerald-100 text-emerald-700" : a.action === "delete" ? "bg-rose-100 text-rose-700" : "bg-blue-100 text-blue-700"}`}>
                      {a.action === "create" ? "新建" : a.action === "delete" ? "删除" : "修改"}
                    </span>
                    {a.action === "update" && a.changes && (
                      <span className="ml-1 text-slate-600">
                        {Object.entries(a.changes).map(([k, v]: any) => `${k}: ${v?.from ?? "空"} → ${v?.to ?? "空"}`).join("；")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </FormSection>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={save.isPending} onClick={() => submit()}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
    <RefundApprovalDialog
      open={refundApprovalOpen}
      onClose={() => setRefundApprovalOpen(false)}
      info={{
        landlordName: (landlords.data ?? []).find((l: any) => l.id === Number(f.landlordId))?.name ?? "",
        brandName: (brands.data ?? []).find((b: any) => b.id === Number(f.brandId))?.name ?? "",
        endDate: fmtDate(f.earlyEndDate || f.endDate),
        rentRefund: Number(f.rentRefund) || 0,
        deposit: Number(record?.deposit ?? 0),
      }}
      saving={save.isPending}
      onConfirm={handleRefundApprovalConfirm}
    />
    </>
  );
}
