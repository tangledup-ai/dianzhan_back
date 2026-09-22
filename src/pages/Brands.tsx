import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listBrands } from "@/api/directory";
import { listContracts } from "@/api/contracts";
import { listMeters } from "@/api/meters";
import { listCabinets } from "@/api/cabinets";
import { getSharedCabinetUsage } from "@/api/meterEnergy";
import { buildSharedCabIndex } from "@/lib/alloc";
import { listElectricity } from "@/api/electricity";
import { getMonthlyLedger } from "@/api/rent";
import { StatusBadge, Money } from "@/components/Stat";
import { inputCls } from "@/components/fields";
import { toCompact, toDisplay } from "@/lib/period";
import { fmtMoney, fmtNum, fmtDate } from "@/lib/format";
import {
  Search, ChevronDown, ChevronRight, Zap,
  Building2, ArrowDownCircle, ArrowUpCircle, Receipt,
} from "lucide-react";

// ─── 类型 ───
interface SiteData {
  landlordId: number;
  landlordName: string;
  brandContract: any | null;   // 品牌方合同（收入侧）
  venueContract: any | null;   // 场地合同（成本侧）
  // 电表
  meters: any[];
  cabinetCount: number;
  // 电费
  elecPayKwh: number;
  elecPayAmount: number;
  elecCollectKwh: number;
  elecCollectAmount: number;
  elecCollectNet: number;
  elecProfit: number;
  elecPayStatus: string;
  elecCollectStatus: string;
  // 租金收入
  rentIncome: any | null;
  // 场地成本平摊（Rent 页口径）：品牌当月平摊场地成本 / 整场地月租 / 租金税费
  venueCostMonth: number | null;
  venueMonthlyRent: number;
  rentTax: number;
  rentProfit: number;
  netProfit: number;
}

export default function Brands() {
  const currentYear = new Date().getFullYear();
  const [keyword, setKeyword] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [year, setYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  // ─── 数据加载 ───
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands });
  const contracts = useQuery({ queryKey: ["contracts"], queryFn: () => listContracts() });
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters() });
  const cabinets = useQuery({ queryKey: ["allCabinets"], queryFn: () => listCabinets() });
  // 共享电表（场地总表）按品牌录入的柜数：品牌方在这类表下没有自己的电表，本地「数电表」取不到
  const sharedCabsQ = useQuery({ queryKey: ["sharedCabinetUsage"], queryFn: () => getSharedCabinetUsage() });
  const sharedCabIndex = useMemo(() => buildSharedCabIndex(sharedCabsQ.data?.meters), [sharedCabsQ.data]);
  const electricity = useQuery({
    queryKey: ["electricity", selectedMonth],
    queryFn: () => listElectricity({ period: selectedMonth || undefined }),
  });
  const rentIncomeList = useMemo(() => {
    // v3：品牌租金收入 = 品牌方合同月租（contracts 主源）
    return (contracts.data ?? [])
      .filter((c: any) => c.contractType === "品牌方合同")
      .map((c: any) => ({ brandId: c.brandId, landlordId: c.landlordId, monthlyRent: Number(c.monthlyRent || 0) }));
  }, [contracts.data]);

  // 场地费分摊（Rent 页同一口径）：品牌平摊场地成本（当月）/ 整场地月租 / 租金税费
  const rentLedger = useQuery({
    queryKey: ["rentMonthlyLedger", selectedMonth],
    queryFn: () => getMonthlyLedger(selectedMonth, "brand"),
  });
  const ledgerMap = useMemo(() => {
    const map = new Map<string, any>();
    for (const g of rentLedger.data?.rows ?? []) {
      for (const it of g.contracts ?? []) {
        if (it.contractType === "品牌方合同" && it.brandId != null && it.landlordId != null) {
          map.set(`${it.brandId}-${it.landlordId}`, it);
        }
      }
    }
    return map;
  }, [rentLedger.data]);

  // ─── 年份选项 ───
  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    for (let y = currentYear - 5; y <= currentYear + 5; y++) years.add(y);
    for (const c of contracts.data ?? []) {
      if (c.startDate) years.add(new Date(c.startDate).getFullYear());
      if (c.endDate) years.add(new Date(c.endDate).getFullYear());
    }
    return [...years].sort((a, b) => b - a);
  }, [contracts.data, currentYear]);

  // ─── 品牌聚合 ───
  const brandData = useMemo(() => {
    const brandList = brands.data ?? [];
    const contractList = contracts.data ?? [];
    const meterList = meters.data ?? [];
    const cabinetList = cabinets.data ?? [];
    const elecList = electricity.data ?? [];
    const incomeList = rentIncomeList;

    return brandList
      .filter((b: any) => !keyword || b.name?.includes(keyword))
      .map((brand: any) => {
        // 该品牌的合同
        const brandContracts = contractList.filter((c: any) => c.brandId === brand.id && c.contractType === "品牌方合同");
        const venueContracts = contractList.filter((c: any) => c.contractType === "场地合同");

        // 按年份过滤合同
        const yearBrandContracts = brandContracts.filter((c: any) => {
          if (!year) return true;
          const start = c.startDate ? new Date(c.startDate) : null;
          const end = c.earlyEndDate ? new Date(c.earlyEndDate) : (c.endDate ? new Date(c.endDate) : null);
          if (!start || !end) return true;
          return start.getFullYear() <= year && end.getFullYear() >= year;
        });

        // 该品牌的电表（v3：只统计关联了场地的"实表"，与 Meters 页口径一致；未关联场地的空表不计入）
        const brandMeters = meterList.filter((m: any) => m.brandId === brand.id && m.landlordId != null);
        const meterIds = new Set(brandMeters.map((m: any) => m.id));
        const brandCabinets = cabinetList.filter((c: any) => meterIds.has(c.meterId));

        // 该品牌的租金收入（v3：contracts 品牌方合同月租）
        const brandIncomes = incomeList.filter((i: any) => i.brandId === brand.id);

        // ─── 按场地方分组 ───
        const siteMap = new Map<number, SiteData>();

        // 从电表收集场地
        for (const m of brandMeters) {
          const lid = m.landlordId || 0;
          if (!siteMap.has(lid)) {
            siteMap.set(lid, {
              landlordId: lid,
              landlordName: m.landlordName || "未关联场地",
              brandContract: null,
              venueContract: null,
              meters: [],
              cabinetCount: 0,
              elecPayKwh: 0, elecPayAmount: 0,
              elecCollectKwh: 0, elecCollectAmount: 0, elecCollectNet: 0, elecProfit: 0,
              elecPayStatus: "", elecCollectStatus: "",
              rentIncome: null,
              venueCostMonth: null, venueMonthlyRent: 0, rentTax: 0, rentProfit: 0, netProfit: 0,
            });
          }
          const site = siteMap.get(lid)!;
          site.meters.push(m);
          // 柜子数
          site.cabinetCount += brandCabinets.filter((c: any) => c.meterId === m.id).length;
        }

        // 从合同补充场地（可能有合同但没电表的场地）
        for (const c of yearBrandContracts) {
          const lid = c.landlordId || 0;
          if (!siteMap.has(lid)) {
            siteMap.set(lid, {
              landlordId: lid,
              landlordName: c.landlordName || "未关联场地",
              brandContract: null,
              venueContract: null,
              meters: [],
              cabinetCount: 0,
              elecPayKwh: 0, elecPayAmount: 0,
              elecCollectKwh: 0, elecCollectAmount: 0, elecCollectNet: 0, elecProfit: 0,
              elecPayStatus: "", elecCollectStatus: "",
              rentIncome: null,
              venueCostMonth: null, venueMonthlyRent: 0, rentTax: 0, rentProfit: 0, netProfit: 0,
            });
          }
        }

        // 填充合同、电费、租金
        for (const site of siteMap.values()) {
          // 品牌方合同（按 landlord_id 匹配）
          site.brandContract = yearBrandContracts.find((c: any) => c.landlordId === site.landlordId) || null;
          // 场地合同（成本侧）
          site.venueContract = venueContracts.find((c: any) => c.landlordId === site.landlordId) || null;
          // 租金收入（v3：品牌方合同月租，按 landlord 匹配）
          site.rentIncome = brandIncomes.find((i: any) => i.landlordId === site.landlordId) || null;

          // 电费数据（v3：台账按 场地×品牌 存储，直接匹配 landlordId+brandId）
          const elecRecord = elecList.find((e: any) =>
            Number(e.landlordId) === site.landlordId && Number(e.brandId) === Number(brand.id)
          );
          if (elecRecord) {
            site.elecPayKwh += Number(elecRecord.payKwh ?? 0);
            site.elecPayAmount += Number(elecRecord.payAmount ?? 0);
            site.elecCollectKwh += Number(elecRecord.collectKwh ?? 0);
            site.elecCollectAmount += Number(elecRecord.collectAmount ?? 0);
            site.elecCollectNet += Number(elecRecord.collectNet ?? 0);
            if (elecRecord.payStatus) site.elecPayStatus = elecRecord.payStatus;
            if (elecRecord.collectStatus) site.elecCollectStatus = elecRecord.collectStatus;
          }
          site.elecProfit = Math.round((site.elecCollectNet - site.elecPayAmount) * 100) / 100;

          // 场地成本平摊（Rent 页同一口径：场地月租 × 品牌柜数 ÷ 该月在期品牌总柜数）
          const ledger = ledgerMap.get(`${brand.id}-${site.landlordId}`);
          site.venueCostMonth = ledger?.venueShareMonth ?? null;
          site.venueMonthlyRent = ledger?.venueContract?.monthlyRent ?? site.venueContract?.monthlyRent ?? 0;
          site.rentTax = ledger?.rentTax ?? 0;
          const rentIncomeAmt = Number(site.rentIncome?.monthlyRent) || 0;
          site.rentProfit = Math.round((rentIncomeAmt - (site.venueCostMonth ?? 0) - site.rentTax) * 100) / 100;
          site.netProfit = Math.round((site.elecProfit + site.rentProfit) * 100) / 100;

          // 共享电表（场地总表）按品牌录入的柜数：该品牌在此场地没有自己的电表，本地「数电表」取不到
          for (const it of sharedCabIndex.get(site.landlordId) ?? []) {
            if (!it.managedByAlloc) continue;
            site.cabinetCount += Number(it.brandCabs?.[String(brand.id)] || 0);
          }
        }

        // 只展示有电表关联的场地（合同补充的无电表场地不显示）；
        // ⚠️ 共享电表（场地总表）下品牌方没有自己的电表 → site.meters 为空，
        //    但该品牌确实在此场地经营（有品牌方合同 + 共享表按品牌录了柜数）→ 这类场地必须保留，
        //    否则整个场地会从列表里消失（品牌 11/13/20 在龙泉路就是这种情况）。
        const sites = [...siteMap.values()]
          .filter((s: any) => s.meters.length > 0 || s.cabinetCount > 0)
          .sort((a, b) => a.landlordName.localeCompare(b.landlordName));

        // 该品牌在共享电表（场地总表）上按品牌录入的柜数合计：品牌方在这类表下没有自己的电表，
        // 电表数恒为 0，柜数只能从这里来（否则该品牌会被下面的 meterCount 过滤掉，整条看不见）
        let sharedCabCount = 0;
        for (const items of sharedCabIndex.values()) {
          for (const it of items) {
            if (!it.managedByAlloc) continue;
            sharedCabCount += Number(it.brandCabs?.[String(brand.id)] || 0);
          }
        }

        // 品牌汇总
        const summary = {
          siteCount: sites.length,
          meterCount: brandMeters.length,
          cabinetCount: brandCabinets.length + sharedCabCount,
          sharedCabCount,
          contractCount: yearBrandContracts.length,
          totalMonthlyRent: yearBrandContracts.reduce((s: number, c: any) => s + (Number(c.monthlyRent) || 0), 0),
          totalElecPayKwh: sites.reduce((s, g) => s + g.elecPayKwh, 0),
          totalElecPayAmount: sites.reduce((s, g) => s + g.elecPayAmount, 0),
          totalElecCollectKwh: sites.reduce((s, g) => s + g.elecCollectKwh, 0),
          totalElecCollectAmount: sites.reduce((s, g) => s + g.elecCollectAmount, 0),
          totalElecCollectNet: sites.reduce((s, g) => s + g.elecCollectNet, 0),
          totalElecProfit: sites.reduce((s, g) => s + g.elecProfit, 0),
          totalRentIncome: sites.reduce((s, g) => s + (Number(g.rentIncome?.monthlyRent) || 0), 0),
          // 场地成本平摊合计（当月）+ 租金税费 + 净利润（电费利润 + 租金利润）
          totalVenueCost: sites.reduce((s, g) => s + (g.venueCostMonth ?? 0), 0),
          totalRentTax: sites.reduce((s, g) => s + g.rentTax, 0),
          totalNetProfit: sites.reduce((s, g) => s + g.netProfit, 0),
        };

        return { ...brand, sites, summary };
      })
      // 只显示在 meters 中关联了电表（实表）的品牌，或仅通过共享电表（场地总表）经营的品牌
      // （品牌方在这类表下没有自己的电表，meterCount=0 但确实在经营，不能过滤掉）
      .filter((b: any) => b.summary.meterCount > 0 || b.summary.sharedCabCount > 0);
  }, [brands.data, contracts.data, meters.data, cabinets.data, electricity.data, rentIncomeList, ledgerMap, sharedCabIndex, keyword, year]);

  const toggleExpand = (id: number) => setExpandedId(prev => prev === id ? null : id);

  const th = "px-3 py-2 text-left text-xs font-medium text-slate-500 whitespace-nowrap";
  const thR = "px-3 py-2 text-right text-xs font-medium text-slate-500 whitespace-nowrap";
  const td = "px-3 py-2 text-xs";
  const tdR = "px-3 py-2 text-xs text-right tabular-nums";

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className={`${inputCls} w-56 pl-8`} placeholder="搜索品牌名称…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <select className={`${inputCls} w-28`} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {yearOptions.map((y) => <option key={y} value={y}>{y}年</option>)}
        </select>
        <input type="month" className={inputCls + " w-40"}
          value={selectedMonth ? toDisplay(selectedMonth) : ""}
          onChange={e => setSelectedMonth(e.target.value ? toCompact(e.target.value) : "")} />
      </div>

      {/* 品牌列表 */}
      <div className="space-y-4">
        {brandData.map((brand: any) => {
          const isExpanded = expandedId === brand.id;
          const s = brand.summary;

          return (
            <div key={brand.id} className="rounded-xl border bg-white shadow-sm">
              {/* 品牌头部 */}
              <div
                className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-slate-50/60"
                onClick={() => toggleExpand(brand.id)}
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
                  <div>
                    <div className="font-semibold text-slate-800">{brand.name}</div>
                    {brand.contact && <div className="text-xs text-slate-400">联系人：{brand.contact}</div>}
                  </div>
                </div>
                <div className="flex items-center gap-6 text-xs">
                  <span className="text-slate-500">{s.siteCount} 场地</span>
                  <span className="text-slate-500">{s.meterCount} 电表</span>
                  <span className="text-slate-500">{s.cabinetCount} 柜子</span>
                  <span className="text-rose-600">付款 <b className="tabular-nums">{fmtMoney(s.totalElecPayAmount)}</b></span>
                  <span className="text-emerald-600">收款 <b className="tabular-nums">{fmtMoney(s.totalElecCollectNet)}</b></span>
                  <span className="text-amber-600">场地成本 <b className="tabular-nums">{fmtMoney(s.totalVenueCost)}</b></span>
                  <span className={s.totalNetProfit >= 0 ? "text-emerald-600" : "text-rose-600"}>
                    利润 <b className="tabular-nums">{fmtMoney(s.totalNetProfit)}</b>
                  </span>
                </div>
              </div>

              {/* 展开内容 */}
              {isExpanded && (
                <div className="border-t px-5 py-4 space-y-4">
                  {/* 品牌概览卡片 */}
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-8">
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">场地数量</div>
                      <div className="text-lg font-semibold tabular-nums">{s.siteCount}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">电表 / 柜子</div>
                      <div className="text-lg font-semibold tabular-nums">{s.meterCount} / {s.cabinetCount}</div>
                    </div>
                    <div className="rounded-lg border bg-rose-50 px-3 py-2">
                      <div className="text-[10px] text-rose-500">电费付款</div>
                      <div className="text-lg font-semibold tabular-nums text-rose-600">{fmtMoney(s.totalElecPayAmount)}</div>
                    </div>
                    <div className="rounded-lg border bg-emerald-50 px-3 py-2">
                      <div className="text-[10px] text-emerald-600">电费收款（不含税）</div>
                      <div className="text-lg font-semibold tabular-nums text-emerald-700">{fmtMoney(s.totalElecCollectNet)}</div>
                    </div>
                    <div className="rounded-lg border bg-blue-50 px-3 py-2">
                      <div className="text-[10px] text-blue-600">月租金收入</div>
                      <div className="text-lg font-semibold tabular-nums text-blue-700">{fmtMoney(s.totalRentIncome || s.totalMonthlyRent)}</div>
                    </div>
                    <div className="rounded-lg border bg-amber-50 px-3 py-2">
                      <div className="text-[10px] text-amber-600">场地成本（当月平摊）</div>
                      <div className="text-lg font-semibold tabular-nums text-amber-700">{fmtMoney(s.totalVenueCost)}</div>
                    </div>
                    <div className={`rounded-lg border px-3 py-2 ${s.totalElecProfit >= 0 ? "bg-emerald-50" : "bg-rose-50"}`}>
                      <div className={`text-[10px] ${s.totalElecProfit >= 0 ? "text-emerald-600" : "text-rose-500"}`}>电费利润</div>
                      <div className={`text-lg font-semibold tabular-nums ${s.totalElecProfit >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{fmtMoney(s.totalElecProfit)}</div>
                    </div>
                    <div className={`rounded-lg border px-3 py-2 ${s.totalNetProfit >= 0 ? "bg-emerald-50" : "bg-rose-50"}`}>
                      <div className={`text-[10px] ${s.totalNetProfit >= 0 ? "text-emerald-600" : "text-rose-500"}`}>净利润（含租金-场地成本）</div>
                      <div className={`text-lg font-semibold tabular-nums ${s.totalNetProfit >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{fmtMoney(s.totalNetProfit)}</div>
                    </div>
                  </div>

                  {/* 按场地展示 */}
                  {brand.sites.map((site: SiteData) => (
                    <div key={site.landlordId} className="rounded-xl border overflow-hidden">
                      {/* 场地标题 */}
                      <div className="flex items-center justify-between bg-slate-50 px-4 py-2.5 border-b">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-emerald-600" />
                          <span className="text-sm font-semibold text-slate-700">{site.landlordName}</span>
                          <span className="text-xs text-slate-400">{site.meters.length} 电表 · {site.cabinetCount} 柜子</span>
                        </div>
                        <div className="flex items-center gap-4 text-xs">
                          <span className="text-rose-600">付款 {fmtMoney(site.elecPayAmount)}</span>
                          <span className="text-emerald-600">收款 {fmtMoney(site.elecCollectNet)}</span>
                          <span className="text-amber-600">场地成本 {fmtMoney(site.venueCostMonth ?? 0)}</span>
                          <span className={site.netProfit >= 0 ? "text-emerald-600" : "text-rose-600"}>利润 {fmtMoney(site.netProfit)}</span>
                        </div>
                      </div>

                      <div className="p-4 space-y-3">
                        {/* 合同信息 */}
                        <div className="grid grid-cols-2 gap-3">
                          {/* 品牌方合同（收入侧） */}
                          <div className="rounded-lg border">
                            <div className="flex items-center gap-1.5 bg-emerald-50/50 px-3 py-1.5 border-b">
                              <ArrowUpCircle className="h-3.5 w-3.5 text-emerald-500" />
                              <span className="text-[11px] font-semibold text-emerald-600">品牌方合同（收入）</span>
                            </div>
                            {site.brandContract ? (
                              <div className="px-3 py-2 space-y-1 text-xs">
                                <div className="flex justify-between"><span className="text-slate-500">电费单价</span><span className="font-medium">{site.brandContract.electricityPrice ? `${fmtNum(site.brandContract.electricityPrice)} 元/度` : "-"}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">计费柜数</span><span className="font-medium">{site.brandContract.liveCabinetsCount ?? site.brandContract.cabinetsCount ?? "-"}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">月租金</span><span className="font-medium">{site.brandContract.monthlyRent ? fmtMoney(site.brandContract.monthlyRent) : "-"}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">付款方式</span><span>{site.brandContract.payMethod ?? "-"}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">合同期限</span><span>{fmtDate(site.brandContract.startDate)} ~ {fmtDate(site.brandContract.endDate)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">状态</span><StatusBadge status={site.brandContract.status} /></div>
                              </div>
                            ) : (
                              <div className="px-3 py-4 text-center text-xs text-slate-400">暂无品牌方合同</div>
                            )}
                          </div>

                          {/* 场地合同（成本侧） */}
                          <div className="rounded-lg border">
                            <div className="flex items-center gap-1.5 bg-rose-50/50 px-3 py-1.5 border-b">
                              <ArrowDownCircle className="h-3.5 w-3.5 text-rose-500" />
                              <span className="text-[11px] font-semibold text-rose-600">场地合同（成本）</span>
                            </div>
                            {site.venueContract ? (
                              <div className="px-3 py-2 space-y-1 text-xs">
                                <div className="flex justify-between"><span className="text-slate-500">电费单价</span><span className="font-medium">{site.venueContract.electricityPrice ? `${fmtNum(site.venueContract.electricityPrice)} 元/度` : "-"}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">月租金</span><span className="font-medium">{site.venueContract.monthlyRent ? fmtMoney(site.venueContract.monthlyRent) : "-"}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">平摊场地成本（当月）</span><span className="font-medium text-rose-600">{site.venueCostMonth != null ? fmtMoney(site.venueCostMonth) : "-"}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">付款方式</span><span>{site.venueContract.payMethod ?? "-"}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">合同期限</span><span>{fmtDate(site.venueContract.startDate)} ~ {fmtDate(site.venueContract.endDate)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">状态</span><StatusBadge status={site.venueContract.status} /></div>
                              </div>
                            ) : (
                              <div className="px-3 py-4 text-center text-xs text-slate-400">暂无场地合同</div>
                            )}
                          </div>
                        </div>

                        {/* 电费收支 */}
                        <div className="rounded-lg border">
                          <div className="flex items-center gap-1.5 bg-amber-50/50 px-3 py-1.5 border-b">
                            <Zap className="h-3.5 w-3.5 text-amber-500" />
                            <span className="text-[11px] font-semibold text-amber-600">电费收支（{selectedMonth ? toDisplay(selectedMonth) : "当月"}）</span>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-slate-50">
                                  <th className={th}>项目</th>
                                  <th className={thR}>度数</th>
                                  <th className={thR}>单价</th>
                                  <th className={thR}>金额</th>
                                  <th className={thR}>不含税收入</th>
                                  <th className={th}>状态</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr className="border-t">
                                  <td className={`${td} font-medium text-rose-600`}>付款（成本）</td>
                                  <td className={tdR}>{fmtNum(site.elecPayKwh)}</td>
                                  <td className={tdR}>{site.brandContract?.electricityPrice ? fmtNum(site.venueContract?.electricityPrice || 0) : "-"}</td>
                                  <td className={tdR}><Money v={site.elecPayAmount} /></td>
                                  <td className={tdR}>-</td>
                                  <td className={td}>{site.elecPayStatus ? <StatusBadge status={site.elecPayStatus} /> : "-"}</td>
                                </tr>
                                <tr className="border-t">
                                  <td className={`${td} font-medium text-emerald-600`}>收款（收入）</td>
                                  <td className={tdR}>{fmtNum(site.elecCollectKwh)}</td>
                                  <td className={tdR}>{site.brandContract?.electricityPrice ? fmtNum(site.brandContract.electricityPrice) : "-"}</td>
                                  <td className={tdR}><Money v={site.elecCollectAmount} /></td>
                                  <td className={tdR}><Money v={site.elecCollectNet} /></td>
                                  <td className={td}>{site.elecCollectStatus ? <StatusBadge status={site.elecCollectStatus} /> : "-"}</td>
                                </tr>
                                <tr className="border-t bg-slate-50 font-semibold">
                                  <td className={td}>利润</td>
                                  <td className={tdR}>-</td>
                                  <td className={tdR}>-</td>
                                  <td className={tdR}>-</td>
                                  <td className={tdR}><Money v={site.elecProfit} strong /></td>
                                  <td className={td}>-</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* 租金收入 */}
                        {(site.rentIncome || site.brandContract?.monthlyRent) && (
                          <div className="rounded-lg border">
                            <div className="flex items-center gap-1.5 bg-blue-50/50 px-3 py-1.5 border-b">
                              <Receipt className="h-3.5 w-3.5 text-blue-500" />
                              <span className="text-[11px] font-semibold text-blue-600">租金收入</span>
                            </div>
                            <div className="px-3 py-2 grid grid-cols-4 gap-4 text-xs">
                              <div><span className="text-slate-500">单柜月租</span><div className="font-medium">{(site.rentIncome?.unitMonthlyRent || site.brandContract?.unitMonthlyRent) ? fmtMoney(site.rentIncome?.unitMonthlyRent || site.brandContract?.unitMonthlyRent) : "-"}</div></div>
                              <div><span className="text-slate-500">柜数</span><div className="font-medium">{site.brandContract?.liveCabinetsCount ?? (site.rentIncome?.cabinetsCount || site.brandContract?.cabinetsCount || site.cabinetCount || "-")}</div></div>
                              <div><span className="text-slate-500">月租金</span><div className="font-medium text-blue-700">{(site.rentIncome?.monthlyRent || site.brandContract?.monthlyRent) ? fmtMoney(site.rentIncome?.monthlyRent || site.brandContract?.monthlyRent) : "-"}</div></div>
                              <div><span className="text-slate-500">年收入</span><div className="font-medium text-blue-700">{(site.rentIncome?.annualIncome || site.brandContract?.rentAmount) ? fmtMoney(site.rentIncome?.annualIncome || site.brandContract?.rentAmount) : "-"}</div></div>
                            </div>
                          </div>
                        )}

                        {/* 电表明细 */}
                        {site.meters.length > 0 && (
                          <div className="rounded-lg border">
                            <div className="flex items-center gap-1.5 bg-slate-50 px-3 py-1.5 border-b">
                              <Zap className="h-3.5 w-3.5 text-slate-400" />
                              <span className="text-[11px] font-semibold text-slate-500">电表明细（{site.meters.length} 块）</span>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="bg-slate-50">
                                    <th className={th}>电表编号</th>
                                    <th className={th}>电表名称</th>
                                    <th className={th}>场地方</th>
                                    <th className={thR}>柜子数</th>
                                    <th className={th}>状态</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {site.meters.map((m: any) => {
                                    const mc = cabinets.data?.filter((c: any) => c.meterId === m.id).length ?? 0;
                                    return (
                                      <tr key={m.id} className="border-t">
                                        <td className={`${td} font-mono`}>{m.meterNo}</td>
                                        <td className={td}>{m.meterName ?? "-"}</td>
                                        <td className={td}>{m.landlordName ?? "-"}</td>
                                        <td className={tdR}>{mc}</td>
                                        <td className={td}><StatusBadge status={m.status} /></td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {brand.sites.length === 0 && (
                    <div className="py-6 text-center text-sm text-slate-400">暂无关联数据，请先在电表管理中关联品牌</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {brandData.length === 0 && (
          <div className="rounded-xl border border-dashed py-16 text-center text-slate-400">
            {brands.isLoading ? "加载中…" : "暂无品牌数据"}
          </div>
        )}
      </div>
    </div>
  );
}
