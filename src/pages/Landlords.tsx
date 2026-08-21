import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listLandlords } from "@/api/directory";
import { listContracts } from "@/api/contracts";
import { listMeters } from "@/api/meters";
import { StatusBadge } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/fields";
import { exportXlsx } from "@/lib/export";
import { fmtMoney, fmtNum, fmtDate, fmtPct } from "@/lib/format";
import { Download, Search, ChevronDown, ChevronRight, MapPin, Zap, FileText, DollarSign, Building2 } from "lucide-react";
import { toast } from "sonner";

export default function Landlords() {
  const [keyword, setKeyword] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords });
  const contracts = useQuery({ queryKey: ["contracts"], queryFn: () => listContracts() });
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters() });

  const landlordData = useMemo(() => {
    const landlordList = landlords.data ?? [];
    const contractList = contracts.data ?? [];
    const meterList = meters.data ?? [];

    return landlordList
      .filter((l: any) => !keyword || l.name?.includes(keyword))
      .map((landlord: any) => {
        // 该场地方的合同
        const landlordContracts = contractList.filter((c: any) => c.landlordId === landlord.id);
        const costContracts = landlordContracts.filter((c: any) => c.contractType === "场地合同");
        const incomeContracts = landlordContracts.filter((c: any) => c.contractType === "品牌方合同");

        // 该场地方的电表
        const landlordMeters = meterList.filter((m: any) => m.landlordId === landlord.id);

        // 该场地方的品牌（v3：按电表品牌去重）
        const landlordBrands = [...new Map(
          landlordMeters.filter((m: any) => m.brandId).map((m: any) => [m.brandId, { id: m.brandId, name: m.brandName || `品牌#${m.brandId}` }])
        ).values()];

        // 汇总数据
        const totalRentCost = costContracts.reduce((sum: number, c: any) => sum + (Number(c.monthlyRent) || 0), 0);
        const totalRentIncome = incomeContracts.reduce((sum: number, c: any) => sum + (Number(c.monthlyRent) || 0), 0);
        const rentProfit = totalRentIncome - totalRentCost;

        // 按品牌分组电表
        const metersByBrand = new Map<number, any>();
        for (const m of landlordMeters) {
          const bid = m.brandId || 0;
          if (!metersByBrand.has(bid)) {
            metersByBrand.set(bid, {
              brandId: bid,
              brandName: m.brandName || "未指定品牌",
              meters: [],
            });
          }
          metersByBrand.get(bid).meters.push(m);
        }

        return {
          ...landlord,
          contracts: landlordContracts,
          costContracts,
          incomeContracts,
          meters: landlordMeters,
          brands: landlordBrands,
          metersByBrand: [...metersByBrand.values()],
          meterCount: landlordMeters.length,
          brandCount: landlordBrands.length,
          contractCount: landlordContracts.length,
          totalRentCost,
          totalRentIncome,
          rentProfit,
        };
      });
  }, [landlords.data, contracts.data, meters.data, keyword]);

  const toggleExpand = (id: number) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  const doExport = () => {
    if (landlordData.length === 0) { toast.error("暂无数据可导出"); return; }
    exportXlsx(`场地方管理_${new Date().toISOString().slice(0, 10)}`, [{
      name: "场地方管理",
      rows: landlordData.map((l: any) => ({
        场地方: l.name,
        联系人: l.contact ?? "",
        电话: l.phone ?? "",
        品牌数: l.brandCount,
        电表数: l.meterCount,
        合同数: l.contractCount,
        场地成本: l.totalRentCost,
        场地收入: l.totalRentIncome,
        场地利润: l.rentProfit,
        备注: l.remark ?? "",
      })),
    }]);
    toast.success("已导出 Excel");
  };

  const th = "px-3 py-2 text-left text-xs font-medium text-slate-500";

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className={`${inputCls} w-56 pl-8`} placeholder="搜索场地方名称…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <input type="month" className={inputCls + " w-40"} value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} />
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={doExport}><Download className="mr-1.5 h-4 w-4" />导出表格</Button>
        </div>
      </div>

      {/* 场地方列表 */}
      <div className="space-y-4">
        {landlordData.map((landlord: any) => {
          const isExpanded = expandedId === landlord.id;

          return (
            <div key={landlord.id} className="rounded-xl border bg-white shadow-sm">
              {/* 场地方头部 */}
              <div
                className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-slate-50/60"
                onClick={() => toggleExpand(landlord.id)}
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
                  <div>
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-emerald-600" />
                      <span className="font-semibold text-slate-800">{landlord.name}</span>
                    </div>
                    {(landlord.contact || landlord.phone) && (
                      <div className="text-xs text-slate-400 ml-6">
                        {landlord.contact && `联系人：${landlord.contact}`}
                        {landlord.contact && landlord.phone && " · "}
                        {landlord.phone}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-6 text-xs">
                  <div className="flex items-center gap-1">
                    <Building2 className="h-3.5 w-3.5 text-blue-500" />
                    <span className="tabular-nums">{landlord.brandCount}</span> 品牌
                  </div>
                  <div className="flex items-center gap-1">
                    <Zap className="h-3.5 w-3.5 text-amber-500" />
                    <span className="tabular-nums">{landlord.meterCount}</span> 电表
                  </div>
                  <div className="flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="tabular-nums">{landlord.contractCount}</span> 合同
                  </div>
                  <div className="flex items-center gap-1">
                    <DollarSign className="h-3.5 w-3.5 text-rose-500" />
                    场地利润 <span className={`tabular-nums font-medium ${landlord.rentProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(landlord.rentProfit)}</span>
                  </div>
                </div>
              </div>

              {/* 展开内容 */}
              {isExpanded && (
                <div className="border-t px-5 py-4 space-y-4">
                  {/* 汇总数据 */}
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">品牌数量</div>
                      <div className="text-lg font-semibold tabular-nums">{landlord.brandCount}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">电表数量</div>
                      <div className="text-lg font-semibold tabular-nums">{landlord.meterCount}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">场地成本</div>
                      <div className="text-lg font-semibold tabular-nums text-rose-600">{fmtMoney(landlord.totalRentCost)}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">场地收入</div>
                      <div className="text-lg font-semibold tabular-nums text-emerald-600">{fmtMoney(landlord.totalRentIncome)}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">场地利润</div>
                      <div className={`text-lg font-semibold tabular-nums ${landlord.rentProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(landlord.rentProfit)}</div>
                    </div>
                  </div>

                  {/* 品牌列表（v3：站点 → 品牌） */}
                  {landlord.brands.length > 0 && (
                    <div>
                      <h4 className="mb-2 text-xs font-semibold text-slate-600">品牌（{landlord.brands.length} 个）</h4>
                      <div className="flex flex-wrap gap-2">
                        {landlord.brands.map((s: any) => (
                          <div key={s.id} className="flex items-center gap-2 rounded-lg border bg-blue-50 px-3 py-1.5">
                            <Building2 className="h-3.5 w-3.5 text-blue-500" />
                            <span className="text-xs font-medium text-blue-700">{s.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 电表列表（按品牌分组） */}
                  {landlord.metersByBrand.length > 0 && (
                    <div>
                      <h4 className="mb-2 text-xs font-semibold text-slate-600">电表（{landlord.meterCount} 块）</h4>
                      <div className="space-y-3">
                        {landlord.metersByBrand.map((group: any) => (
                          <div key={group.brandId} className="rounded-lg border overflow-hidden">
                            <div className="flex items-center gap-2 bg-slate-50 px-3 py-2 border-b">
                              <Zap className="h-3.5 w-3.5 text-amber-500" />
                              <span className="text-xs font-semibold text-slate-600">{group.brandName}</span>
                              <span className="text-[10px] text-slate-400">（{group.meters.length} 块电表）</span>
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b bg-white">
                                  <th className={th}>电表编号</th>
                                  <th className={th}>电表名称</th>
                                  <th className={th}>品牌</th>
                                  <th className={th}>报税主体</th>
                                  <th className={th}>状态</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.meters.map((m: any) => (
                                  <tr key={m.id} className="border-b last:border-0">
                                    <td className="px-3 py-2 font-mono font-medium">{m.meterNo}</td>
                                    <td className="px-3 py-2">{m.meterName ?? "-"}</td>
                                    <td className="px-3 py-2">{m.brandName ?? "-"}</td>
                                    <td className="px-3 py-2">{m.entityName ?? "-"}</td>
                                    <td className="px-3 py-2"><StatusBadge status={m.status} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 合同列表 */}
                  {landlord.contracts.length > 0 && (
                    <div>
                      <h4 className="mb-2 text-xs font-semibold text-slate-600">合同（{landlord.contractCount} 份）</h4>
                      <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b bg-slate-50">
                              <th className={th}>合同类型</th>
                              <th className={th}>品牌方</th>
                              <th className={th}>电费单价</th>
                              <th className={th}>场地月租金</th>
                              <th className={th}>计费柜数</th>
                              <th className={th}>付款方式</th>
                              <th className={th}>合同期限</th>
                              <th className={th}>状态</th>
                            </tr>
                          </thead>
                          <tbody>
                            {landlord.contracts.map((c: any) => (
                              <tr key={c.id} className="border-b last:border-0">
                                <td className="px-3 py-2">
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${c.contractType === "场地合同" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                                    {c.contractType}
                                  </span>
                                </td>
                                <td className="px-3 py-2 font-medium">{c.brandName ?? "-"}</td>
                                <td className="px-3 py-2 tabular-nums">{c.electricityPrice ? `${fmtNum(c.electricityPrice)} 元/度` : "-"}</td>
                                <td className="px-3 py-2 tabular-nums">{c.monthlyRent ? fmtMoney(c.monthlyRent) : "-"}</td>
                                <td className="px-3 py-2 tabular-nums">{c.liveCabinetsCount ?? c.cabinetsCount ?? "-"}</td>
                                <td className="px-3 py-2">{c.payMethod ?? "-"}</td>
                                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(c.startDate)} ~ {fmtDate(c.endDate)}</td>
                                <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {landlord.meters.length === 0 && landlord.contracts.length === 0 && (
                    <div className="py-6 text-center text-sm text-slate-400">
                      暂无关联数据
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {landlordData.length === 0 && (
          <div className="rounded-xl border border-dashed py-16 text-center text-slate-400">
            {landlords.isLoading ? "加载中…" : "暂无场地方数据"}
          </div>
        )}
      </div>
    </div>
  );
}
