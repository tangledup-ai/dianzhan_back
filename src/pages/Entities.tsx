import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listEntities } from "@/api/directory";
import { listContracts } from "@/api/contracts";
import { listMeters } from "@/api/meters";
import { listCabinets } from "@/api/cabinets";
import { getLandlordMeterView } from "@/api/stations";
import { getEntityMonthly } from "@/api/overview";
import { StatusBadge } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/fields";
import * as XLSX from "xlsx";
import { fmtMoney, fmtNum, fmtDate } from "@/lib/format";
import { Download, Search, ChevronDown, ChevronRight, FileText, Building2, DollarSign, Landmark } from "lucide-react";
import { toast } from "sonner";

export default function Entities() {
  const [keyword, setKeyword] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"场租" | "电租" | "损益">("场租");
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const entities = useQuery({ queryKey: ["entities"], queryFn: listEntities });
  const contracts = useQuery({ queryKey: ["contracts"], queryFn: () => listContracts() });
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters() });
  const cabinets = useQuery({ queryKey: ["allCabinets"], queryFn: () => listCabinets() });

  const entityData = useMemo(() => {
    const entityList = entities.data ?? [];
    const contractList = contracts.data ?? [];
    const meterList = meters.data ?? [];
    const cabinetList = cabinets.data ?? [];

    // 合同主体归属（与主体损益表口径一致）：
    // - 有 entity_id：精确归属
    // - 无 entity_id：按「场地+品牌」的电表数比例分摊到相关主体（收入按品牌电表，场地成本按场地电表）
    // - 电表还没关联主体的合同：进入「未指定主体（待归属）」，关联后自动归位
    const contractAllocs = new Map<number, { entityId: number; ratio: number }[]>();
    const unattributedContracts: any[] = [];
    const weightIncome = new Map<string, Map<number, number>>();   // "场地:品牌" -> 主体 -> 电表数
    const weightLandlord = new Map<number, Map<number, number>>(); // 场地 -> 主体 -> 电表数
    for (const m of meterList) {
      if (!m.landlordId || m.entityId == null) continue;
      if (!(m.brandId != null || m.tag === "共享电表")) continue;
      const lk = weightLandlord.get(m.landlordId) ?? new Map<number, number>();
      lk.set(m.entityId, (lk.get(m.entityId) || 0) + 1);
      weightLandlord.set(m.landlordId, lk);
      const bkey = `${m.landlordId}:${m.brandId ?? "shared"}`;
      const bk = weightIncome.get(bkey) ?? new Map<number, number>();
      bk.set(m.entityId, (bk.get(m.entityId) || 0) + 1);
      weightIncome.set(bkey, bk);
    }
    for (const c of contractList) {
      if (c.entityId != null) {
        contractAllocs.set(c.id, [{ entityId: c.entityId, ratio: 1 }]);
        continue;
      }
      if (c.landlordId == null) { unattributedContracts.push(c); continue; }
      const wmap = c.contractType === "品牌方合同"
        ? weightIncome.get(`${c.landlordId}:${c.brandId ?? "shared"}`)
        : weightLandlord.get(c.landlordId);
      const entries = wmap ? [...wmap.entries()].filter(([, w]) => w > 0) : [];
      if (entries.length === 0) { unattributedContracts.push(c); continue; }
      const totalW = entries.reduce((s, [, w]) => s + w, 0);
      contractAllocs.set(c.id, entries.map(([eid, w]) => ({ entityId: eid, ratio: w / totalW })));
    }

    const mapped = entityList
      .filter((e: any) => !keyword || e.name?.includes(keyword) || e.shortName?.includes(keyword))
      .map((entity: any) => {
        // 该主体的电表（通过entity_id关联）
        const entityMeters = meterList.filter((m: any) => m.entityId === entity.id);

        // 该主体关联的场地ID集合（来自电表的landlord_id）
        // （entityLandlordIds 已由上方 weightLandlord/contractAllocs 的归属逻辑取代）

        // 该主体的合同：entity_id 精确归属 + 未指定主体的合同按电表数分摊（_ratio 为分摊比例）
        const entityContracts = contractList
          .filter((c: any) => (contractAllocs.get(c.id) ?? []).some((a: any) => a.entityId === entity.id))
          .map((c: any) => {
            const alloc = (contractAllocs.get(c.id) ?? []).find((a: any) => a.entityId === entity.id);
            return { ...c, _ratio: alloc ? alloc.ratio : 1 };
          });

        // 汇总数据
        const totalMonthlyRent = entityContracts.reduce((sum: number, c: any) => sum + (Number(c.monthlyRent) || 0) * (c._ratio ?? 1), 0);
        const totalAnnualRent = entityContracts.reduce((sum: number, c: any) => sum + (Number(c.rentAmount) || 0) * (c._ratio ?? 1), 0);
        const costContracts = entityContracts.filter((c: any) => c.contractType === "场地合同");
        const incomeContracts = entityContracts.filter((c: any) => c.contractType === "品牌方合同");

        // 按场地分组，再按品牌分组（v3：无站点层）
        const metersByLandlord = new Map<number, any>();
        for (const m of entityMeters) {
          const lid = m.landlordId || 0;
          if (!metersByLandlord.has(lid)) {
            metersByLandlord.set(lid, {
              landlordId: lid,
              landlordName: m.landlordName || "未设置场地方",
              meters: [],
              brands: new Map<number, any>(),
            });
          }
          const group = metersByLandlord.get(lid);
          group.meters.push(m);

          // 按品牌分组
          const bid = m.brandId || 0;
          if (!group.brands.has(bid)) {
            group.brands.set(bid, {
              brandId: bid,
              brandName: m.brandName || "未关联品牌",
              meters: [],
            });
          }
          group.brands.get(bid).meters.push(m);
        }

        // 为每个场地构建详细数据
        const landlordDetails = [...metersByLandlord.values()].map((group: any) => {
          // 该场地下的合同
          const landlordCostContracts = costContracts.filter((c: any) => c.landlordId === group.landlordId);
          const landlordIncomeContracts = incomeContracts.filter((c: any) => c.landlordId === group.landlordId);

          // 品牌详情
          const brandDetails = [...group.brands.values()].map((brand: any) => {
            // 该品牌的电表ID集合
            const meterIds = new Set(brand.meters.map((m: any) => m.id));

            // 该品牌的柜子
            const brandCabinets = cabinetList.filter((cab: any) => meterIds.has(cab.meterId));
            let chargeCabinets = brandCabinets.filter((cab: any) => cab.cabinetType === "充电柜").length;
            let storageCabinets = brandCabinets.filter((cab: any) => cab.cabinetType === "储电柜").length;
            // 没有添加柜子时，默认算1个充电柜
            if (brandCabinets.length === 0 && brand.meters.length > 0) {
              chargeCabinets = 1;
            }
            const totalCabinets = Math.max(1, brandCabinets.length);

            // 该品牌的品牌方合同（收款）
            const brandIncomeContracts = landlordIncomeContracts.filter((c: any) => {
              // 匹配品牌：合同的 brand_id = 品牌 id（外键关联，改名自动同步）
              return c.brandId != null && c.brandId === brand.brandId;
            });

            // 该场地的场地合同（付款）
            const brandCostContract = landlordCostContracts[0]; // 通常一个场地一份场地合同

            return {
              ...brand,
              chargeCabinets,
              storageCabinets,
              totalCabinets,
              costContract: brandCostContract,
              incomeContracts: brandIncomeContracts,
            };
          });

          return {
            ...group,
            brands: brandDetails,
            costContracts: landlordCostContracts,
            incomeContracts: landlordIncomeContracts,
          };
        });

        return {
          ...entity,
          meters: entityMeters,
          contracts: entityContracts,
          costContracts,
          incomeContracts,
          landlordDetails,
          meterCount: entityMeters.length,
          contractCount: entityContracts.length,
          totalMonthlyRent,
          totalAnnualRent,
        };
      });

    // 未归属主体：电表还没关联报税主体的合同集中到这里，关联后自动归位
    let result = mapped;
    if (unattributedContracts.length > 0) {
      const byLandlord = new Map<number, any>();
      for (const c of unattributedContracts) {
        const lid = c.landlordId || 0;
        if (!byLandlord.has(lid)) {
          byLandlord.set(lid, {
            landlordId: lid,
            landlordName: c.landlordName || "未设置场地方",
            meters: [],
            brands: [],
            costContracts: [],
            incomeContracts: [],
          });
        }
        const g = byLandlord.get(lid);
        (c.contractType === "品牌方合同" ? g.incomeContracts : g.costContracts).push({ ...c, _ratio: 1 });
      }
      result = [...mapped, {
        id: -1,
        name: "未指定主体（待归属）",
        shortName: "",
        contracts: unattributedContracts,
        costContracts: unattributedContracts.filter((c: any) => c.contractType === "场地合同"),
        incomeContracts: unattributedContracts.filter((c: any) => c.contractType === "品牌方合同"),
        landlordDetails: [...byLandlord.values()],
        meterCount: 0,
        contractCount: unattributedContracts.length,
        totalMonthlyRent: unattributedContracts.reduce((s: number, c: any) => s + (Number(c.monthlyRent) || 0), 0),
        totalAnnualRent: unattributedContracts.reduce((s: number, c: any) => s + (Number(c.rentAmount) || 0), 0),
        isUnattributed: true,
      }];
    }
    return result;
  }, [entities.data, contracts.data, meters.data, cabinets.data, keyword]);

  const toggleExpand = (id: number) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  const doExport = async () => {
    if (entityData.length === 0) { toast.error("暂无数据可导出"); return; }

    if (viewMode === "场租") {
      // ── 场租导出：完全参照 2026-2027美团场租.xlsx 格式 ──
      // Row 0: 标题 "美团租金台账" 合并全部列
      // Row 1: 一级表头（站点配置/付款信息/收款信息合并单元格）
      // Row 2: 二级明细表头
      // Row 3+: 数据行

      const header1 = [
        "序号", "收款公司", "占股", "品牌", "",
        "品牌配置", "", "",   // F-H
        "付款信息", "", "", "", "", "", "", "", "", "", "",   // I-S (cols 8-18)
        "收款信息", "", "", "", "", "", "", "", "", "", "", "",   // T-AE (cols 19-30)
      ];
      const header2 = [
        "", "", "", "", "",
        "充电柜", "储电柜", "合计",
        "负责人", "合同租期", "合作\n年限", "租金成本", "付款方式", "25年~26年\n付款情况", "26年~27年\n付款情况", "付款情况", "单台成本", "发票", "押金",
        "合同收款租期", "到账情况", "26-27收款信息\n签约/开票/到账情况", "单台月租金\n（含税）", "单台年收入（含税）", "租金收入\n（含税）", "税率", "租金收入\n（不含税）", "进项成本", "租金利润", "分红金额", "分红后\n租金利润",
      ];

      const allRows: any[][] = [];
      let seq = 0;

      for (const entity of entityData) {
        for (const landlord of entity.landlordDetails || []) {
          for (const station of landlord.brands || []) {
            seq++;
            const costContract = station.costContract;
            const inc = (station.incomeContracts || [])[0];

            const startDate = costContract?.startDate ? new Date(costContract.startDate) : null;
            const endDate = costContract?.endDate ? new Date(costContract.endDate) : null;
            const years = startDate && endDate
              ? Math.round((endDate.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000) * 10) / 10
              : "";
            const totalCabinets = station.totalCabinets || 1;
            const unitCost = costContract?.monthlyRent
              ? Math.round(Number(costContract.monthlyRent) / totalCabinets)
              : "";
            const monthlyRent = inc?.monthlyRent ? Number(inc.monthlyRent) : 0;
            const annualIncome = monthlyRent * 12;
            const taxRate = inc?.taxEnabled ? Number(inc.taxRate) || 0 : 0;
            const netIncome = taxRate > 0 ? Math.round(monthlyRent * (1 - taxRate) * 12 * 100) / 100 : annualIncome;
            const rentProfit = netIncome - (Number(costContract?.monthlyRent) || 0);

            allRows.push([
              seq,                          // A: 序号
              entity.name ?? "",            // B: 收款公司
              "",                           // C: 占股
              station.brandName,            // D: 品牌
              station.brandId ?? "",        // E: 品牌号
              station.chargeCabinets,       // F: 充电柜
              station.storageCabinets,      // G: 储电柜
              station.totalCabinets,        // H: 合计
              "",                           // I: 负责人
              costContract ? `${fmtDate(costContract.startDate)} ~ ${fmtDate(costContract.endDate)}` : "", // J: 合同租期
              years ? years + "年" : "",    // K: 合作年限
              costContract?.monthlyRent ?? "", // L: 租金成本
              costContract?.payMethod ?? "",   // M: 付款方式
              "",                           // N: 25年~26年付款情况
              "",                           // O: 26年~27年付款情况
              costContract?.payStatus ?? "",   // P: 付款情况
              unitCost,                     // Q: 单台成本
              costContract?.invoiceType ?? "", // R: 发票
              costContract?.deposit ?? "",  // S: 押金
              inc ? `${fmtDate(inc.startDate)} ~ ${fmtDate(inc.endDate)}` : "", // T: 合同收款租期
              inc?.payStatus ?? "",        // U: 到账情况
              "",                           // V: 26-27收款信息
              inc?.unitMonthlyRent ?? "", // W: 单台月租金含税
              inc?.unitMonthlyRent ? Number(inc.unitMonthlyRent) * 12 : "", // X: 单台年收入含税
              monthlyRent,                  // Y: 租金收入含税
              taxRate ? (taxRate * 100).toFixed(0) + "%" : "", // Z: 税率
              netIncome,                    // AA: 租金收入不含税
              "",                           // AB: 进项成本
              rentProfit,                   // AC: 租金利润
              "",                           // AD: 分红金额
              rentProfit,                   // AE: 分红后租金利润
            ]);
          }
        }
      }

      // 合计行
      const sumCharge = allRows.reduce((s, r) => s + (Number(r[5]) || 0), 0);
      const sumStorage = allRows.reduce((s, r) => s + (Number(r[6]) || 0), 0);
      const sumTotal = allRows.reduce((s, r) => s + (Number(r[7]) || 0), 0);
      const sumCost = allRows.reduce((s, r) => s + (Number(r[11]) || 0), 0);
      const sumUnitCost = sumTotal > 0 ? Math.round(sumCost / sumTotal) : "";
      const sumIncomeRent = allRows.reduce((s, r) => s + (Number(r[24]) || 0), 0);
      const sumNetIncome = allRows.reduce((s, r) => s + (Number(r[26]) || 0), 0);
      const sumProfit = allRows.reduce((s, r) => s + (Number(r[28]) || 0), 0);
      allRows.push([
        "", "合计", "", "", "",
        sumCharge, sumStorage, sumTotal,
        "", "", "", sumCost, "", "", "", "", sumUnitCost, "", "",
        "", "", "", "", "", sumIncomeRent, "", sumNetIncome, "", sumProfit, "", sumProfit,
      ]);

      const aoa = [["美团租金台账"], header1, header2, ...allRows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);

      // 合并单元格 — 完全参照原 Excel
      ws["!merges"] = [
        // 标题行：A1:AE1 (cols 0-30)
        { s: { r: 0, c: 0 }, e: { r: 0, c: 30 } },
        // 站点配置：F2:H2 (cols 5-7)
        { s: { r: 1, c: 5 }, e: { r: 1, c: 7 } },
        // 付款信息：I2:S2 (cols 8-18)
        { s: { r: 1, c: 8 }, e: { r: 1, c: 18 } },
        // 收款信息：T2:AE2 (cols 19-30)
        { s: { r: 1, c: 19 }, e: { r: 1, c: 30 } },
        // 一级表头跨行：序号、收款公司、占股、站名、站点号
        { s: { r: 1, c: 0 }, e: { r: 2, c: 0 } },
        { s: { r: 1, c: 1 }, e: { r: 2, c: 1 } },
        { s: { r: 1, c: 2 }, e: { r: 2, c: 2 } },
        { s: { r: 1, c: 3 }, e: { r: 2, c: 3 } },
        { s: { r: 1, c: 4 }, e: { r: 2, c: 4 } },
      ];

      ws["!cols"] = [
        { wch: 5 },   // A: 序号
        { wch: 20 },  // B: 收款公司
        { wch: 6 },   // C: 占股
        { wch: 14 },  // D: 站名
        { wch: 8 },   // E: 站点号
        { wch: 8 },   // F: 充电柜
        { wch: 8 },   // G: 储电柜
        { wch: 8 },   // H: 合计
        { wch: 10 },  // I: 负责人
        { wch: 22 },  // J: 合同租期
        { wch: 8 },   // K: 合作年限
        { wch: 12 },  // L: 租金成本
        { wch: 10 },  // M: 付款方式
        { wch: 14 },  // N: 25年~26年付款情况
        { wch: 14 },  // O: 26年~27年付款情况
        { wch: 10 },  // P: 付款情况
        { wch: 10 },  // Q: 单台成本
        { wch: 8 },   // R: 发票
        { wch: 8 },   // S: 押金
        { wch: 22 },  // T: 合同收款租期
        { wch: 10 },  // U: 到账情况
        { wch: 18 },  // V: 26-27收款信息
        { wch: 14 },  // W: 单台月租金含税
        { wch: 16 },  // X: 单台年收入含税
        { wch: 14 },  // Y: 租金收入含税
        { wch: 8 },   // Z: 税率
        { wch: 16 },  // AA: 租金收入不含税
        { wch: 10 },  // AB: 进项成本
        { wch: 14 },  // AC: 租金利润
        { wch: 10 },  // AD: 分红金额
        { wch: 14 },  // AE: 分红后租金利润
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "场租台账");
      XLSX.writeFile(wb, `场租台账_${selectedMonth}.xlsx`);
    } else {
      // 电租导出：需要异步获取电表数据
      toast.info("正在生成电租报表…");

      // 收集所有场地ID（v3）
      const landlordIds: number[] = [];
      for (const entity of entityData) {
        for (const landlord of entity.landlordDetails || []) {
          if (landlord.landlordId) landlordIds.push(landlord.landlordId);
        }
      }

      // 获取所有场地的电表详情（v3）
      const views: Record<number, any> = {};
      for (const lid of landlordIds) {
        try {
          views[lid] = await getLandlordMeterView(lid, selectedMonth);
        } catch { views[lid] = null; }
      }

      const meterList = meters.data ?? [];
      const allRows: any[][] = [];

      for (const entity of entityData) {
        // v3.2：同一场地可挂多个主体，场地电表视图只取本主体的电表
        const ownMeterNos = new Set((entity.meters ?? []).map((m: any) => m.meterNo));
        for (const landlord of entity.landlordDetails || []) {
          const landlordRows: any[][] = [];
          const mv = views[landlord.landlordId];
          if (mv) {
            for (const group of mv.brandGroups || []) {
              for (const meter of (group.meters || []).filter((m: any) => ownMeterNos.has(m.meterNo))) {
                const meterRecord = meterList.find((m: any) => m.meterNo === meter.meterNo);
                const transformerRatio = meterRecord?.transformerRatio ?? 1;

                const dailyEnergy = meter.dailyEnergy || [];
                const lastDay = dailyEnergy.length > 0 ? dailyEnergy[dailyEnergy.length - 1] : null;
                const readingTime = lastDay?.dayDate ? String(lastDay.dayDate).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : "";

                const prevReading = meter.prevEndReading || 0;
                const currReading = meter.endReading || 0;
                const intervalKwh = currReading - prevReading;
                const profit = (meter.collectNet || 0) - (meter.payAmount || 0);

                landlordRows.push([
                  landlord.landlordName,
                  meter.meterNo,
                  transformerRatio,
                  prevReading,
                  readingTime,
                  currReading,
                  intervalKwh > 0 ? intervalKwh : meter.payKwh || 0,
                  meter.payUnitPrice ?? "",
                  meter.payAmount ?? "",
                  meter.payStatus ?? "未付款",
                  meter.collectUnitPrice ?? "",
                  meter.collectAmount ?? "",
                  meter.collectNet ?? "",
                  meter.collectStatus ?? "未到账",
                  profit,
                ]);
              }
            }
          }

          if (landlordRows.length > 0) {
            // 场地标题行
            allRows.push([landlord.landlordName, "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
            allRows.push(...landlordRows);

            // 场地合计
            if (landlordRows.length > 1) {
              const tInterval = landlordRows.reduce((s, r) => s + (Number(r[6]) || 0), 0);
              const tPay = landlordRows.reduce((s, r) => s + (Number(r[8]) || 0), 0);
              const tCollect = landlordRows.reduce((s, r) => s + (Number(r[11]) || 0), 0);
              const tNet = landlordRows.reduce((s, r) => s + (Number(r[12]) || 0), 0);
              const tProfit = landlordRows.reduce((s, r) => s + (Number(r[14]) || 0), 0);
              allRows.push(["合计", "", "", "", "", "", tInterval, "", tPay, "", "", tCollect, tNet, "", tProfit]);
            }
            allRows.push([]); // 空行分隔
          }
        }
      }

      const header = ["场地方", "电表编号", "互感器倍数", "上月抄表度数", "抄表时间", "抄表度数", "区间度数", "付款单价", "付款金额", "付款情况", "收款单价", "收款金额", "不含税收入", "到账情况", "利润"];
      const aoa = [header, ...allRows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);

      // 自动列宽
      const colWidths = [24, 16, 10, 14, 20, 12, 12, 10, 12, 10, 10, 12, 12, 10, 12];
      ws["!cols"] = colWidths.map(w => ({ wch: w }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "电租台账");
      XLSX.writeFile(wb, `电租台账_${selectedMonth}.xlsx`);
    }

    toast.success("已导出 Excel");
  };

  const th = "px-3 py-2 text-left text-xs font-medium text-slate-500";

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className={`${inputCls} w-56 pl-8`} placeholder="搜索公司名称…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <input type="month" className={inputCls + " w-40"} value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} />
        <select className={`${inputCls} w-28`} value={viewMode} onChange={e => setViewMode(e.target.value as any)}>
          <option value="场租">场租</option>
          <option value="电租">电租</option>
          <option value="损益">损益</option>
        </select>
        <div className="ml-auto flex gap-2">
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={doExport}><Download className="mr-1.5 h-4 w-4" />导出表格</Button>
        </div>
      </div>

      {/* 主体列表（损益视图下由损益表替代） */}
      {viewMode !== "损益" && (
      <div className="space-y-4">
        {entityData.map((entity: any) => {
          const isExpanded = expandedId === entity.id;

          return (
            <div key={entity.id} className="rounded-xl border bg-white shadow-sm">
              {/* 主体头部 */}
              <div
                className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-slate-50/60"
                onClick={() => toggleExpand(entity.id)}
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
                <div>
                  <div className="font-semibold text-slate-800">{entity.name}</div>
                  {entity.shortName && <div className="text-xs text-slate-400">简称：{entity.shortName}</div>}
                  {entity.taxNo && (
                    <div className="text-[10px] text-slate-400">
                      税号：{entity.taxNo}{entity.taxpayerType ? ` · ${entity.taxpayerType}` : ""}
                      {entity.status && entity.status !== "启用" ? ` · ${entity.status}` : ""}
                    </div>
                  )}
                </div>
                </div>
                <div className="flex items-center gap-6 text-xs">
                  <div className="flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="tabular-nums">{entity.contractCount}</span> 合同
                  </div>
                  <div className="flex items-center gap-1">
                    <DollarSign className="h-3.5 w-3.5 text-rose-500" />
                    月租金 <span className="tabular-nums font-medium">{fmtMoney(entity.totalMonthlyRent)}</span>
                  </div>
                </div>
              </div>

              {/* 展开内容 */}
              {isExpanded && viewMode === "场租" && (
                <div className="border-t px-5 py-4 space-y-6">
                  {/* 汇总数据 */}
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">合同总数</div>
                      <div className="text-lg font-semibold tabular-nums">{entity.contractCount}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">成本合同</div>
                      <div className="text-lg font-semibold tabular-nums text-rose-600">{entity.costContracts.length}</div>
                    </div>
                    <div className="rounded-lg border bg-slate-50 px-3 py-2">
                      <div className="text-[10px] text-slate-400">收入合同</div>
                      <div className="text-lg font-semibold tabular-nums text-emerald-600">{entity.incomeContracts.length}</div>
                    </div>
                  </div>

                  {/* 按场地展示详细信息 */}
                  {entity.landlordDetails.map((landlord: any) => (
                    <div key={landlord.landlordId} className="rounded-xl border overflow-hidden">
                      {/* 场地标题 */}
                      <div className="flex items-center gap-2 bg-slate-50 px-4 py-2.5 border-b">
                        <Building2 className="h-4 w-4 text-emerald-600" />
                        <span className="text-sm font-semibold text-slate-700">{landlord.landlordName}</span>
                        <span className="text-xs text-slate-400">（场地合同 {landlord.costContracts.length} · 品牌合同 {landlord.incomeContracts.length}）</span>
                      </div>

                      {/* 付款信息表（场地合同） */}
                      {landlord.costContracts.length > 0 && (
                        <div className="px-4 py-3 border-t">
                          <h4 className="mb-2 text-xs font-semibold text-rose-600">付款信息（场地合同）</h4>
                          <div className="overflow-x-auto rounded-lg border">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b bg-rose-50/50">
                                  <th className={th}>合同租期</th>
                                  <th className={`${th} text-right`}>合作年限</th>
                                  <th className={`${th} text-right`}>租金成本</th>
                                  <th className={th}>付款方式</th>
                                  <th className={th}>付款情况</th>
                                  <th className={`${th} text-right`}>单台成本</th>
                                </tr>
                              </thead>
                              <tbody>
                                {landlord.costContracts.map((c: any) => {
                                  const startDate = c.startDate ? new Date(c.startDate) : null;
                                  const endDate = c.endDate ? new Date(c.endDate) : null;
                                  const years = startDate && endDate
                                    ? Math.round((endDate.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000) * 10) / 10
                                    : null;
                                  const totalCabinets = landlord.brands.reduce((s: number, st: any) => s + st.totalCabinets, 0) || 1;
                                  const unitCost = c.monthlyRent ? Math.round(Number(c.monthlyRent) / totalCabinets) : null;

                                  return (
                                    <tr key={c.id} className="border-b last:border-0">
                                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(c.startDate)} ~ {fmtDate(c.endDate)}</td>
                                      <td className="px-3 py-2 text-right tabular-nums">{years ? `${years}年` : "-"}</td>
                                      <td className="px-3 py-2 text-right tabular-nums font-medium">{c.monthlyRent ? fmtMoney(Math.round(Number(c.monthlyRent) * (c._ratio ?? 1) * 100) / 100) : "-"}</td>
                                      <td className="px-3 py-2">{c.payMethod ?? "-"}</td>
                                      <td className="px-3 py-2">
                                        <StatusBadge status={c.payStatus || "未付款"} />
                                      </td>
                                      <td className="px-3 py-2 text-right tabular-nums">{unitCost ? fmtMoney(unitCost) : "-"}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* 收款信息表（品牌方合同） */}
                      {landlord.incomeContracts.length > 0 && (
                        <div className="px-4 py-3 border-t">
                          <h4 className="mb-2 text-xs font-semibold text-emerald-600">收款信息（品牌方合同）</h4>
                          <div className="overflow-x-auto rounded-lg border">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b bg-emerald-50/50">
                                  <th className={th}>品牌方</th>
                                  <th className={th}>合同收款租期</th>
                                  <th className={`${th} text-right`}>单台月租金（含税）</th>
                                  <th className={`${th} text-right`}>单台年收入（含税）</th>
                                  <th className={`${th} text-right`}>租金收入（含税）</th>
                                  <th className={`${th} text-right`}>税率</th>
                                  <th className={`${th} text-right`}>租金收入（不含税）</th>
                                  <th className={th}>付款方式</th>
                                  <th className={th}>状态</th>
                                </tr>
                              </thead>
                              <tbody>
                                {landlord.incomeContracts.map((c: any) => {
                                  const monthlyRent = (Number(c.monthlyRent) || 0) * (c._ratio ?? 1);
                                  const annualIncome = monthlyRent * 12;
                                  const taxRate = c.taxEnabled ? Number(c.taxRate) || 0 : 0;
                                  const netIncome = taxRate > 0
                                    ? Math.round(monthlyRent * (1 - taxRate) * 12 * 100) / 100
                                    : annualIncome;

                                  return (
                                    <tr key={c.id} className="border-b last:border-0">
                                      <td className="px-3 py-2 font-medium">{c.brandName ?? "-"}{c._ratio != null && c._ratio < 1 ? <span className="ml-1 text-[10px] text-amber-600">（分摊 {(c._ratio * 100).toFixed(0)}%）</span> : null}</td>
                                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(c.startDate)} ~ {fmtDate(c.endDate)}</td>
                                      <td className="px-3 py-2 text-right tabular-nums">{c.unitMonthlyRent ? fmtMoney(Number(c.unitMonthlyRent)) : "-"}</td>
                                      <td className="px-3 py-2 text-right tabular-nums">{c.unitMonthlyRent ? fmtMoney(Number(c.unitMonthlyRent) * 12) : "-"}</td>
                                      <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtMoney(monthlyRent)}</td>
                                      <td className="px-3 py-2 text-right tabular-nums">{c.taxEnabled ? `${(taxRate * 100).toFixed(0)}%` : "-"}</td>
                                      <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{fmtMoney(netIncome)}</td>
                                      <td className="px-3 py-2">{c.payMethod ?? "-"}</td>
                                      <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                                    </tr>
                                  );
                                })}
                                {landlord.incomeContracts.length > 1 && (
                                  <tr className="bg-emerald-50/30 font-semibold">
                                    <td className="px-3 py-2">合计</td>
                                    <td className="px-3 py-2">-</td>
                                    <td className="px-3 py-2">-</td>
                                    <td className="px-3 py-2">-</td>
                                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(landlord.incomeContracts.reduce((s: number, c: any) => s + (Number(c.monthlyRent) || 0) * (c._ratio ?? 1), 0))}</td>
                                    <td className="px-3 py-2">-</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-emerald-600">
                                      {fmtMoney(landlord.incomeContracts.reduce((s: number, c: any) => {
                                        const mr = (Number(c.monthlyRent) || 0) * (c._ratio ?? 1);
                                        const tr = c.taxEnabled ? Number(c.taxRate) || 0 : 0;
                                        return s + (tr > 0 ? mr * (1 - tr) * 12 : mr * 12);
                                      }, 0))}
                                    </td>
                                    <td className="px-3 py-2">-</td>
                                    <td className="px-3 py-2">-</td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* 无合同提示 */}
                      {landlord.costContracts.length === 0 && landlord.incomeContracts.length === 0 && (
                        <div className="px-4 py-6 text-center text-sm text-slate-400">
                          该场地暂无合同数据
                        </div>
                      )}
                    </div>
                  ))}

                  {entity.landlordDetails.length === 0 && (
                    <div className="py-6 text-center text-sm text-slate-400">
                      该主体暂无场租数据（合同按电表主体自动归属：请在「智慧电表」页把该主体名下的电表关联到场地方并指定报税主体）
                    </div>
                  )}
                </div>
              )}

              {/* 电租视图 */}
              {isExpanded && viewMode === "电租" && (
                <ElectricityRentView
                  entity={entity}
                  period={selectedMonth}
                />
              )}
            </div>
          );
        })}
        {entityData.length === 0 && (
          <div className="rounded-xl border border-dashed py-16 text-center text-slate-400">
            {entities.isLoading ? "加载中…" : "暂无公司主体数据，请先在「基础档案」中添加"}
          </div>
        )}
      </div>
      )}

      {/* 主体月度损益（后端口径） */}
      {viewMode === "损益" && <EntityPnLPanel period={selectedMonth} />}
    </div>
  );
}


// ─── 主体月度损益面板（数据源：GET /api/overview/entity-monthly）───

function EntityPnLPanel({ period }: { period: string }) {
  const q = useQuery({
    queryKey: ["entity-monthly", period],
    queryFn: () => getEntityMonthly(period),
  });
  const thL = "px-2.5 py-2 text-left text-[11px] font-medium text-slate-500 whitespace-nowrap";
  const th = "px-2.5 py-2 text-right text-[11px] font-medium text-slate-500 whitespace-nowrap";

  if (q.isLoading) {
    return <div className="rounded-xl border bg-white py-10 text-center text-sm text-slate-400">加载主体损益中…</div>;
  }
  const rows = q.data?.rows ?? [];
  const t = q.data?.totals ?? {};

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b bg-slate-50 px-4 py-2.5">
        <Landmark className="h-4 w-4 text-indigo-600" />
        <span className="text-sm font-semibold text-slate-700">公司主体损益表（{period}）</span>
        <span className="text-[11px] text-slate-400">
          电费按电表主体归属；场地租/公共运营费按柜数分摊到主体；税费单列不重复扣
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1050px] text-xs">
          <thead>
            <tr className="border-b bg-slate-50">
              <th className={thL}>公司主体</th>
              <th className={th}>电量(度)</th>
              <th className={th}>电费付款</th>
              <th className={th}>收款(不含税)</th>
              <th className={th}>电费税费</th>
              <th className={th}>电费利润</th>
              <th className={th}>租金收入</th>
              <th className={th}>租金税费</th>
              <th className={th}>场地租(分摊)</th>
              <th className={th}>运营费(分摊)</th>
              <th className={th}>净利润</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">该月暂无主体经营数据</td></tr>
            )}
            {rows.map((r: any) => (
              <tr key={r.entityId ?? "none"} className="border-b last:border-0 hover:bg-slate-50/60">
                <td className={`${thL} font-medium text-slate-700`}>
                  {r.entityName}
                  {r.entityId == null && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">待归属</span>}
                </td>
                <td className={`${th} tabular-nums text-slate-600`}>{fmtNum(r.kwh)}</td>
                <td className={`${th} tabular-nums text-rose-600`}>{fmtMoney(r.elecPay)}</td>
                <td className={`${th} tabular-nums text-emerald-600`}>{fmtMoney(r.elecNet)}</td>
                <td className={`${th} tabular-nums text-slate-500`}>{fmtMoney(r.elecTax)}</td>
                <td className={`${th} tabular-nums font-medium ${r.elecProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(r.elecProfit)}</td>
                <td className={`${th} tabular-nums`}>{fmtMoney(r.rentIncome)}</td>
                <td className={`${th} tabular-nums text-slate-500`}>{fmtMoney(r.rentTax)}</td>
                <td className={`${th} tabular-nums text-rose-500`}>{fmtMoney(r.venueCost)}</td>
                <td className={`${th} tabular-nums text-rose-500`}>{fmtMoney(r.opExpense)}</td>
                <td className={`${th} tabular-nums font-bold ${r.netProfit >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{fmtMoney(r.netProfit)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t bg-slate-50 font-semibold">
                <td className={thL}>合计</td>
                <td className={`${th} tabular-nums`}>{fmtNum(t.kwh ?? 0)}</td>
                <td className={`${th} tabular-nums text-rose-600`}>{fmtMoney(t.elecPay ?? 0)}</td>
                <td className={`${th} tabular-nums text-emerald-600`}>{fmtMoney(t.elecNet ?? 0)}</td>
                <td className={`${th} tabular-nums text-slate-500`}>{fmtMoney(t.elecTax ?? 0)}</td>
                <td className={`${th} tabular-nums text-slate-700`}>{fmtMoney(t.elecProfit ?? 0)}</td>
                <td className={`${th} tabular-nums`}>{fmtMoney(t.rentIncome ?? 0)}</td>
                <td className={`${th} tabular-nums text-slate-500`}>{fmtMoney(t.rentTax ?? 0)}</td>
                <td className={`${th} tabular-nums text-rose-500`}>{fmtMoney(t.venueCost ?? 0)}</td>
                <td className={`${th} tabular-nums text-rose-500`}>{fmtMoney(t.opExpense ?? 0)}</td>
                <td className={`${th} tabular-nums ${((t.netProfit ?? 0) >= 0) ? "text-emerald-700" : "text-rose-700"}`}>{fmtMoney(t.netProfit ?? 0)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}


// ─── 电租视图组件 ───────────────────────────────────────────

function ElectricityRentView({ entity, period }: { entity: any; period: string }) {
  const meters = useQuery({ queryKey: ["meters"], queryFn: () => listMeters() });

  // 收集该主体下所有场地的ID（v3：按场地查电表视图）
  const landlordIds = useMemo(() => {
    const ids = new Set<number>();
    for (const landlord of entity.landlordDetails || []) {
      if (landlord.landlordId) ids.add(landlord.landlordId);
    }
    return [...ids];
  }, [entity]);

  // 为每个场地获取电表详情（v3：getLandlordMeterView）
  const meterViewQueries = useQuery({
    queryKey: ["entityLandlordViews", landlordIds, period],
    queryFn: async () => {
      const results: Record<number, any> = {};
      for (const lid of landlordIds) {
        try {
          results[lid] = await getLandlordMeterView(lid, period);
        } catch {
          results[lid] = null;
        }
      }
      return results;
    },
    enabled: landlordIds.length > 0,
  });

  const th = "px-2.5 py-2 text-left text-xs font-medium text-slate-500 whitespace-nowrap";
  const thR = "px-2.5 py-2 text-right text-xs font-medium text-slate-500 whitespace-nowrap";

  if (meterViewQueries.isLoading) {
    return <div className="border-t px-5 py-10 text-center text-slate-400">加载电租数据中…</div>;
  }

  const views = meterViewQueries.data || {};
  const meterList = meters.data ?? [];

  // 按场地方分组构建数据（v3：一个场地一个视图，无站点层级）
  // v3.2：同一场地可挂多个主体，场地电表视图只取本主体的电表
  const ownMeterNos = new Set((entity.meters ?? []).map((m: any) => m.meterNo));
  const landlordGroups = (entity.landlordDetails || []).map((landlord: any) => {
    const rows: any[] = [];
    const mv = views[landlord.landlordId];
    if (mv) {
      for (const group of mv.brandGroups || []) {
        for (const meter of (group.meters || []).filter((m: any) => ownMeterNos.has(m.meterNo))) {
          const meterRecord = meterList.find((m: any) => m.meterNo === meter.meterNo);
          const transformerRatio = meterRecord?.transformerRatio ?? 1;

          const dailyEnergy = meter.dailyEnergy || [];
          const lastDay = dailyEnergy.length > 0 ? dailyEnergy[dailyEnergy.length - 1] : null;
          const readingTime = lastDay?.dayDate ? String(lastDay.dayDate).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : "";

          const prevReading = meter.prevEndReading || 0;
          const currReading = meter.endReading || 0;
          const intervalKwh = currReading - prevReading;
          const profit = (meter.collectNet || 0) - (meter.payAmount || 0);

          rows.push({
            stationName: landlord.landlordName || "",
            meterNo: meter.meterNo,
            transformerRatio,
            prevReading,
            readingTime,
            currReading,
            intervalKwh: intervalKwh > 0 ? intervalKwh : meter.payKwh || 0,
            payUnitPrice: meter.payUnitPrice,
            payAmount: meter.payAmount,
            payStatus: meter.payStatus,
            collectUnitPrice: meter.collectUnitPrice,
            collectAmount: meter.collectAmount,
            collectNet: meter.collectNet,
            collectStatus: meter.collectStatus,
            profit,
          });
        }
      }
    }

    // 该场地的汇总
    const totals = rows.reduce((acc: any, r: any) => ({
      intervalKwh: (acc.intervalKwh || 0) + (r.intervalKwh || 0),
      payAmount: (acc.payAmount || 0) + (r.payAmount || 0),
      collectAmount: (acc.collectAmount || 0) + (r.collectAmount || 0),
      collectNet: (acc.collectNet || 0) + (r.collectNet || 0),
      profit: (acc.profit || 0) + (r.profit || 0),
    }), { intervalKwh: 0, payAmount: 0, collectAmount: 0, collectNet: 0, profit: 0 });

    return { landlord, rows, totals };
  });

  // 过滤掉没有数据的场地
  const validGroups = landlordGroups.filter((g: any) => g.rows.length > 0);

  if (validGroups.length === 0) {
    return (
      <div className="border-t px-5 py-10 text-center text-sm text-slate-400">
        暂无电租数据，请确保场地已关联电表并同步了用电数据
      </div>
    );
  }

  // 总汇总
  const grandTotals = validGroups.reduce((acc: any, g: any) => ({
    intervalKwh: (acc.intervalKwh || 0) + g.totals.intervalKwh,
    payAmount: (acc.payAmount || 0) + g.totals.payAmount,
    collectAmount: (acc.collectAmount || 0) + g.totals.collectAmount,
    collectNet: (acc.collectNet || 0) + g.totals.collectNet,
    profit: (acc.profit || 0) + g.totals.profit,
  }), { intervalKwh: 0, payAmount: 0, collectAmount: 0, collectNet: 0, profit: 0 });

  return (
    <div className="border-t px-5 py-4 space-y-4">
      <h4 className="text-xs font-semibold text-blue-600">电费明细（{period}）</h4>

      {validGroups.map(({ landlord, rows, totals }: any) => (
        <div key={landlord.landlordId} className="rounded-xl border overflow-hidden">
          {/* 场地标题 */}
          <div className="flex items-center gap-2 bg-blue-50/50 px-4 py-2.5 border-b">
            <Building2 className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-semibold text-slate-700">{landlord.landlordName}</span>
            <span className="text-xs text-slate-400">（{rows.length} 块电表）</span>
            <div className="ml-auto flex items-center gap-4 text-xs">
              <span className="text-rose-600">付款 <b className="tabular-nums">{fmtMoney(totals.payAmount)}</b></span>
              <span className="text-emerald-600">收款 <b className="tabular-nums">{fmtMoney(totals.collectNet)}</b></span>
              <span className={totals.profit >= 0 ? "text-emerald-600" : "text-rose-600"}>利润 <b className="tabular-nums">{fmtMoney(totals.profit)}</b></span>
            </div>
          </div>

          {/* 电费明细表 */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className={th}>场地方</th>
                  <th className={th}>电表编号</th>
                  <th className={thR}>互感器倍数</th>
                  <th className={thR}>上月抄表度数</th>
                  <th className={th}>抄表时间</th>
                  <th className={thR}>抄表度数</th>
                  <th className={thR}>区间度数</th>
                  <th className={thR}>付款单价</th>
                  <th className={thR}>付款金额</th>
                  <th className={th}>付款情况</th>
                  <th className={thR}>收款单价</th>
                  <th className={thR}>收款金额</th>
                  <th className={thR}>不含税收入</th>
                  <th className={th}>到账情况</th>
                  <th className={thR}>利润</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any, i: number) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-slate-50/60">
                    <td className="px-2.5 py-2 font-medium">{r.stationName}</td>
                    <td className="px-2.5 py-2 font-mono">{r.meterNo}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.transformerRatio}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{fmtNum(r.prevReading)}</td>
                    <td className="px-2.5 py-2 whitespace-nowrap text-[11px]">{r.readingTime || "-"}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{fmtNum(r.currReading)}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums font-medium">{fmtNum(r.intervalKwh)}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.payUnitPrice ? fmtNum(r.payUnitPrice) : "-"}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-rose-600">{r.payAmount ? fmtMoney(r.payAmount) : "-"}</td>
                    <td className="px-2.5 py-2"><StatusBadge status={r.payStatus || "未付款"} /></td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.collectUnitPrice ? fmtNum(r.collectUnitPrice) : "-"}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-emerald-600">{r.collectAmount ? fmtMoney(r.collectAmount) : "-"}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.collectNet ? fmtMoney(r.collectNet) : "-"}</td>
                    <td className="px-2.5 py-2"><StatusBadge status={r.collectStatus || "未到账"} /></td>
                    <td className={`px-2.5 py-2 text-right tabular-nums font-semibold ${r.profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(r.profit)}</td>
                  </tr>
                ))}
                {/* 场地合计行 */}
                {rows.length > 1 && (
                  <tr className="bg-blue-50/30 font-semibold">
                    <td className="px-2.5 py-2">合计</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{fmtNum(totals.intervalKwh)}</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-rose-600">{fmtMoney(totals.payAmount)}</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-emerald-600">{fmtMoney(totals.collectAmount)}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{fmtMoney(totals.collectNet)}</td>
                    <td className="px-2.5 py-2">-</td>
                    <td className={`px-2.5 py-2 text-right tabular-nums ${totals.profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtMoney(totals.profit)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* 总汇总 */}
      {validGroups.length > 1 && (
        <div className="rounded-lg border bg-blue-50/30 px-4 py-3">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-slate-700">总汇总</span>
            <div className="flex items-center gap-4">
              <span className="text-rose-600">总付款 {fmtMoney(grandTotals.payAmount)}</span>
              <span className="text-emerald-600">总收款 {fmtMoney(grandTotals.collectNet)}</span>
              <span className={grandTotals.profit >= 0 ? "text-emerald-600" : "text-rose-600"}>总利润 {fmtMoney(grandTotals.profit)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
