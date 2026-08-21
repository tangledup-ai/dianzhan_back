import { useMemo, useState, useEffect, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listContracts, createContract, updateContract, deleteContract } from "@/api/contracts";
import { listBrands, listLandlords } from "@/api/directory";
import { listMeters } from "@/api/meters";
import { listCabinets } from "@/api/cabinets";
import { StatusBadge } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Field, NumInput, TextInput, DateInput, SelectInput, inputCls } from "@/components/fields";
import { MapPicker } from "@/components/MapPicker";
import * as XLSX from "xlsx";
import { fmtMoney, fmtNum, fmtDate, numOrNull } from "@/lib/format";
import { Download, Plus, Search, Pencil, Trash2, AlertTriangle, FileText, ArrowDownCircle, ArrowUpCircle, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { ContractSchedule } from "@/components/ContractSchedule";
import { toast } from "sonner";

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

  const doExport = () => {
    // 只导出品牌方合同（品牌方付给公司），按品牌分组每个品牌一个 sheet
    const brandContracts = rows.filter((c: any) => c.contractType === "品牌方合同");
    if (brandContracts.length === 0) { toast.error("暂无品牌方合同可导出"); return; }

    // 按品牌分组
    const groups = new Map<string, any[]>();
    for (const c of brandContracts) {
      const key = c.brandName || "未指定品牌";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }

    const headers = ["序号", "付款主体", "场地方", "开始日期", "结束日期", "剩余天数", "状态", "备注"];
    const wb = XLSX.utils.book_new();
    for (const [brand, list] of groups) {
      const aoa: unknown[][] = [[`${brand}业务合同监控表`], headers];
      list.forEach((c: any, i: number) => {
        aoa.push([
          i + 1,
          c.brandName || "",
          c.landlordName || "",
          fmtDate(c.startDate, ""),
          fmtDate(c.endDate, ""),
          c.days_left ?? "",
          c.status,
          c.remark ?? "",
        ]);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
      // 数据从第3行起（0=标题, 1=表头, 2+=数据）
      const dataRows = aoa.slice(2);
      ws["!cols"] = headers.map((h, ci) => ({
        wch: Math.max(h.length * 2, ...dataRows.map((r) => String(r[ci] ?? "").length * 1.9), 8),
      }));
      XLSX.utils.book_append_sheet(wb, ws, brand.slice(0, 31));
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
          <Button variant="outline" onClick={doExport}><Download className="mr-1.5 h-4 w-4" />导出表格</Button>
          <Button variant="outline" className="text-rose-600" onClick={() => openCreate("场地合同")}>
            <Plus className="mr-1 h-4 w-4" />场地合同
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => openCreate("品牌方合同")}>
            <Plus className="mr-1 h-4 w-4" />品牌方合同
          </Button>
        </div>
      </div>

      {/* 按场地分组展示 */}
      <div className="space-y-6">
        {groupedByLandlord.map((group: any) => {
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
                      {group.costContracts.map((c: any) => {
                        const isExpanded = expandedContractId === c.id;
                        return (
                          <>
                            <tr key={c.id} className={`border-b last:border-0 hover:bg-slate-50/60 ${c.status === "已到期" ? "bg-rose-50/30" : c.status === "临期" ? "bg-amber-50/30" : c.status === "提前结束" ? "bg-violet-50/30" : ""}`}>
                              <td className="px-3 py-2.5">
                                <button className="rounded p-0.5 text-slate-400 hover:text-emerald-600" onClick={() => setExpandedContractId(isExpanded ? null : c.id)} title="查看付款情况">
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
                              <td className="px-3 py-2.5">
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
                                  <ContractSchedule contractId={c.id} side="payment" title={`${c.landlordName || ""} 付款情况`} editable />
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
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
                      {group.incomeContracts.map((c: any) => {
                        const isExpanded = expandedContractId === c.id;
                        return (
                          <>
                            <tr key={c.id} className={`border-b last:border-0 hover:bg-slate-50/60 ${c.status === "已到期" ? "bg-rose-50/30" : c.status === "临期" ? "bg-amber-50/30" : c.status === "提前结束" ? "bg-violet-50/30" : ""}`}>
                              <td className="px-3 py-2.5">
                                <button className="rounded p-0.5 text-slate-400 hover:text-emerald-600" onClick={() => setExpandedContractId(isExpanded ? null : c.id)} title="查看收款情况">
                                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                </button>
                              </td>
                              <td className="px-3 py-2.5 font-medium">{c.brandName ?? "-"}</td>
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
                              <td className="px-3 py-2.5">
                                <div className="flex justify-center gap-0.5">
                                  <button className="rounded p-1 text-slate-400 hover:text-emerald-600" onClick={() => { setEditing(c); setFormType("品牌方合同"); setFormOpen(true); }}><Pencil className="h-3.5 w-3.5" /></button>
                                  <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => window.confirm("删除？") && del.mutate(c.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                                </div>
                              </td>
                            </tr>
                            {/* 展开：收款情况（可编辑） */}
                            {isExpanded && (
                              <tr key={`${c.id}-exp`} className="bg-slate-50/50">
                                <td colSpan={17} className="px-4 py-3">
                                  <ContractSchedule contractId={c.id} side="income" title={`${c.brandName || ""} 收款情况`} editable />
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
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
        {groupedByLandlord.length === 0 && (
          <div className="rounded-xl border border-dashed py-16 text-center text-slate-400">
            {list.isLoading ? "加载中…" : "暂无合同数据"}
          </div>
        )}
      </div>

      <ContractForm open={formOpen} onClose={() => { setFormOpen(false); setEditing(null); }} record={editing} defaultType={formType} />
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

// ─── 合同表单 ───
function ContractForm({ open, onClose, record, defaultType }: { open: boolean; onClose: () => void; record?: any; defaultType?: string }) {
  const blank = {
    landlordId: "", brandId: "", contractType: defaultType || "场地合同",
    electricityPrice: "", rentAmount: "", cabinetsCount: "", unitMonthlyRent: "", monthlyRent: "",
    rentCalcMethod: "按柜子数量", payMethod: "", rentAdvanceDays: "0",
    region: "", address: "", latitude: "", longitude: "", payEntity: "",
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
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters(), enabled: open });
  const cabinets = useQuery({ queryKey: ["allCabinets"], queryFn: () => listCabinets(), enabled: open });
  const contracts = useQuery({ queryKey: ["contracts"], queryFn: () => listContracts(), enabled: open });

  // 根据选中的场地方和品牌方，自动计算柜子数量
  const autoCabinetCount = useMemo(() => {
    if (!f.landlordId || !f.brandId) return null;
    // 找到匹配的电表
    const matchedMeters = (meters.data ?? []).filter((m: any) =>
      m.landlordId === Number(f.landlordId) && m.brandId === Number(f.brandId)
    );
    const meterIds = new Set(matchedMeters.map((m: any) => m.id));
    // 计算这些电表下的柜子总数
    const cabinetCount = (cabinets.data ?? []).filter((c: any) => meterIds.has(c.meterId)).length;
    return cabinetCount;
  }, [f.landlordId, f.brandId, meters.data, cabinets.data]);

  // 当自动计算的柜子数变化时，更新表单
  useEffect(() => {
    if (autoCabinetCount !== null && autoCabinetCount > 0) {
      setF((prev) => ({ ...prev, cabinetsCount: String(autoCabinetCount) }));
    }
  }, [autoCabinetCount]);

  // 承担场地成本实时计算：场地合同月租金总和 ÷ 该场地所有品牌计费柜数总和 × 本品牌计费柜数
  // 与后端 contract_repo / dividend_calc 口径一致；分母含无合同品牌的电表柜数，不计 TEST 电表
  const venueCostLive = useMemo(() => {
    if (!f.landlordId || !f.brandId) return null;
    const landlordId = Number(f.landlordId);
    const brandId = Number(f.brandId);

    // 1) 该场地方所有「场地合同」月租金之和
    const venueMonthlyRent = (contracts.data ?? [])
      .filter((c: any) => c.landlordId === landlordId && c.contractType === "场地合同")
      .reduce((sum: number, c: any) => sum + Number(c.monthlyRent || 0), 0);
    if (!venueMonthlyRent) return null;

    // 2) 该场地下电表 → 柜子（排除 TEST 电表）
    const siteMeters = (meters.data ?? []).filter(
      (m: any) => m.landlordId === landlordId && !String(m.meterNo || "").toUpperCase().includes("TEST")
    );
    const meterById = new Map<number, any>(siteMeters.map((m: any) => [m.id, m]));
    const siteCabs = (cabinets.data ?? []).filter((c: any) => meterById.has(c.meterId));

    // 3) 本品牌柜数 / 该场地所有品牌电表柜数总和
    const liveCabs = siteCabs.filter((c: any) => meterById.get(c.meterId)?.brandId === brandId).length;
    const totalCabs = siteCabs.filter((c: any) => meterById.get(c.meterId)?.brandId != null).length;
    if (!totalCabs) return null;

    return Math.round((venueMonthlyRent / totalCabs) * liveCabs * 100) / 100;
  }, [f.landlordId, f.brandId, contracts.data, meters.data, cabinets.data]);

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
        landlordId: record.landlordId ? String(record.landlordId) : "", brandId: record.brandId ? String(record.brandId) : "",
        contractType: record.contractType ?? "场地合同",
        electricityPrice: record.electricityPrice ? String(record.electricityPrice) : "", rentAmount: record.rentAmount ? String(record.rentAmount) : "",
        cabinetsCount: record.cabinetsCount ? String(record.cabinetsCount) : "", unitMonthlyRent: record.unitMonthlyRent ? String(record.unitMonthlyRent) : "",
        rentCalcMethod: record.rent_calc_method || "按柜子数量",
        monthlyRent: record.monthlyRent ? String(record.monthlyRent) : "", payMethod: record.payMethod ?? "",
        rentAdvanceDays: record.rentAdvanceDays != null ? String(record.rentAdvanceDays) : "0",
        region: record.region ?? "", address: record.address ?? "",
        latitude: record.latitude != null ? String(record.latitude) : "",
        longitude: record.longitude != null ? String(record.longitude) : "",
        payEntity: record.payEntity ?? "",
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

  const submit = () => {
    if (!f.landlordId) { toast.error("请选择场地方"); return; }
    if (f.contractType === "品牌方合同" && !f.landlordId) { toast.error("品牌方合同必须关联场地方"); return; }
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

    save.mutate({
      landlordId: f.landlordId ? Number(f.landlordId) : null,
      brandId: f.brandId ? Number(f.brandId) : null,
      contractType: f.contractType,
      electricityPrice: elecPrice,
      rentAmount: f.rentAmount ? Number(f.rentAmount) : null,
      cabinetsCount: f.cabinetsCount ? Number(f.cabinetsCount) : null,
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
      startDate: f.startDate || null,
      endDate: f.endDate || null,
      taxEnabled,
      taxRate,
      postTaxElectricityPrice: postTaxPrice,
      deposit: f.deposit ? Number(f.deposit) : null,
      firstMonthRent: f.firstMonthRent ? Number(f.firstMonthRent) : null,
      rentRefund: f.rentRefund ? Number(f.rentRefund) : null,
      earlyEndDate: f.rentRefund && Number(f.rentRefund) > 0 ? (f.earlyEndDate || new Date().toISOString().slice(0, 10)) : null,
      rentTaxEnabled,
      rentTaxRate,
      postTaxRentPrice,
      remark: f.remark || null,
    });
  };

  return (
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
                <SelectInput value={f.landlordId} onChange={set("landlordId")}
                  options={[{ value: "", label: "请选择场地方" }, ...(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))]} />
              </Field>
            )}

            {f.contractType === "品牌方合同" && (
              <>
                <Field label="关联场地 *">
                  <SelectInput value={f.landlordId} onChange={set("landlordId")}
                    options={[{ value: "", label: "请选择场地方" }, ...(landlords.data ?? []).map((l: any) => ({ value: String(l.id), label: l.name }))]} />
                </Field>
                <Field label="品牌方">
                  <SelectInput value={f.brandId} onChange={set("brandId")}
                    options={[{ value: "", label: "请选择品牌方" }, ...(brands.data ?? []).map((b: any) => ({ value: String(b.id), label: b.name }))]} />
                </Field>
                <Field label="计费方式">
                  <SelectInput value={f.rentCalcMethod} onChange={set("rentCalcMethod")}
                    options={[{ value: "按柜子数量", label: "按柜子数量" }, { value: "固定价格", label: "固定价格" }]} />
                </Field>
              </>
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
                <Field label="年租金（元）"><NumInput value={f.rentAmount} onChange={handleRentAmountChange} /></Field>
                <Field label="月租金（元）"><NumInput value={f.monthlyRent} onChange={handleMonthlyRentChange} /></Field>
                <Field label="电费单价（元/度）"><NumInput value={f.electricityPrice} onChange={set("electricityPrice")} placeholder="0.65" /></Field>
                <Field label="场地租金付款方式">
                  <SelectInput value={f.payMethod} onChange={set("payMethod")}
                    options={[{ value: "", label: "请选择" }, { value: "月付", label: "月付" }, { value: "季付", label: "季付" }, { value: "半年付", label: "半年付" }, { value: "年付", label: "年付" }]} />
                </Field>
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
                            onClick={() => { onClose(); window.location.href = `/meters?landlord=${f.landlordId}&brand=${f.brandId}&highlight=cabinet`; }}
                          >
                            去修改 <ExternalLink className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                      {autoCabinetCount === null && !f.cabinetsCount && (
                        <span className="text-xs text-slate-400">请先选择场地和品牌</span>
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
                  options={[{ value: "", label: "请选择" }, { value: "月付", label: "月付" }, { value: "季付", label: "季付" }, { value: "半年付", label: "半年付" }, { value: "年付", label: "年付" }]} />
              </Field>
              <Field label="押金（元）"><NumInput value={f.deposit} onChange={set("deposit")} placeholder="0" /></Field>
              <Field label="首月场地租金（元）"><NumInput value={f.firstMonthRent} onChange={set("firstMonthRent")} placeholder="按整月算则留空" /></Field>
              <Field label="场地费退款（元）"><NumInput value={f.rentRefund} onChange={set("rentRefund")} placeholder="0" /></Field>
              {f.rentRefund && Number(f.rentRefund) > 0 && (
                <Field label="合同提前结束日期">
                  <DateInput
                    value={f.earlyEndDate || new Date().toISOString().slice(0, 10)}
                    onChange={set("earlyEndDate")}
                  />
                </Field>
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
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={save.isPending} onClick={submit}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
