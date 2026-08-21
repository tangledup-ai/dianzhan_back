import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getStationBoard } from "@/api/overview";
import { StatCard, Money } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { exportXlsx } from "@/lib/export";
import { fmtMoney } from "@/lib/format";
import { Download, Building2, Zap, Home, TrendingUp, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

type Kind = "brand" | "entity" | "landlord";
const KIND_LABEL: Record<Kind, string> = { brand: "品牌方", entity: "公司主体", landlord: "场地方" };

export default function DimensionBoard({ kind }: { kind: Kind }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const board = useQuery({
    queryKey: ["stationBoard"],
    queryFn: () => getStationBoard(),
  });

  const rows = useMemo(() => {
    const data = board.data ?? [];
    // 按 kind 分组
    const groups = new Map<number, any>();
    for (const r of data) {
      const id = kind === "landlord" ? r.station.landlordId : 0;
      if (!id) continue;
      if (!groups.has(id)) {
        groups.set(id, {
          id,
          name: r.landlordName ?? "未指定",
          stationCount: 0,
          elecPay: 0, elecCollect: 0, elecProfit: 0,
          rentCost: 0, rentIncome: 0, rentProfit: 0, totalProfit: 0,
        });
      }
      const g = groups.get(id);
      g.stationCount++;
      g.elecPay += r.elecPay;
      g.elecCollect += r.elecCollect;
      g.elecProfit += r.elecProfit;
      g.rentCost += r.rentCost;
      g.rentIncome += r.rentIncome;
      g.rentProfit += r.rentProfit;
      g.totalProfit += r.totalProfit;
    }
    return [...groups.values()].sort((a, b) => b.totalProfit - a.totalProfit);
  }, [board.data, kind]);

  const totals = useMemo(() => rows.reduce(
    (t: any, r: any) => ({
      stationCount: t.stationCount + r.stationCount, elecPay: t.elecPay + r.elecPay, elecCollect: t.elecCollect + r.elecCollect,
      elecProfit: t.elecProfit + r.elecProfit, rentCost: t.rentCost + r.rentCost, rentIncome: t.rentIncome + r.rentIncome,
      rentProfit: t.rentProfit + r.rentProfit, totalProfit: t.totalProfit + r.totalProfit,
    }),
    { stationCount: 0, elecPay: 0, elecCollect: 0, elecProfit: 0, rentCost: 0, rentIncome: 0, rentProfit: 0, totalProfit: 0 },
  ), [rows]);

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const doExport = () => {
    if (rows.length === 0) { toast.error("暂无数据可导出"); return; }
    exportXlsx(`${KIND_LABEL[kind]}看板_${new Date().toISOString().slice(0, 10)}`, [{
      name: `${KIND_LABEL[kind]}看板`,
      rows: rows.map((r: any) => ({
        [KIND_LABEL[kind]]: r.name, 覆盖场地: r.stationCount,
        电费付款: r.elecPay, 电费收款: r.elecCollect, 电费利润: r.elecProfit,
        年租金成本: r.rentCost, 年租金收入: r.rentIncome, 租金利润: r.rentProfit,
        总利润: r.totalProfit,
      })),
    }]);
    toast.success("已导出 Excel");
  };

  const th = "px-3 py-2.5 text-left text-xs font-medium text-slate-500 whitespace-nowrap";
  const thR = "px-3 py-2.5 text-right text-xs font-medium text-slate-500 whitespace-nowrap";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={`${KIND_LABEL[kind]}数量`} value={`${rows.length}`} sub={`覆盖场地 ${totals.stationCount} 个`} icon={Building2} tone="blue" />
        <StatCard label="电费差价利润（元）" value={fmtMoney(totals.elecProfit)} icon={Zap} />
        <StatCard label="场租差价利润（元）" value={fmtMoney(totals.rentProfit)} icon={Home} />
        <StatCard label="总利润（元）" value={fmtMoney(totals.totalProfit)} icon={TrendingUp} tone="green" />
      </div>

      <div className="flex justify-end">
        <Button variant="outline" onClick={doExport}><Download className="mr-1.5 h-4 w-4" />导出表格</Button>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        <table className="w-full min-w-[1000px] text-sm">
          <thead><tr className="border-b bg-slate-50">
            <th className="w-8 px-1 py-2.5"></th>
            <th className={th}>{KIND_LABEL[kind]}</th>
            <th className={thR}>覆盖场地</th>
            <th className={thR}>电费付款</th><th className={thR}>电费收款</th><th className={thR}>电费利润</th>
            <th className={thR}>年租金成本</th><th className={thR}>年租金收入</th><th className={thR}>租金利润</th>
            <th className={thR}>总利润</th>
          </tr></thead>
          <tbody>
            {rows.map((r: any) => {
              const isExpanded = expandedId === r.id;
              return (
                <>
                  <tr key={r.id} className={`cursor-pointer border-b hover:bg-emerald-50/40 ${isExpanded ? "bg-emerald-50/60" : ""}`}
                    onClick={() => toggleExpand(r.id)}>
                    <td className="px-1 py-2.5 text-center">
                      {isExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-slate-800">{r.name}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.stationCount}</td>
                    <td className="px-3 py-2.5 text-right"><Money v={r.elecPay} /></td>
                    <td className="px-3 py-2.5 text-right"><Money v={r.elecCollect} /></td>
                    <td className="px-3 py-2.5 text-right"><Money v={r.elecProfit} strong /></td>
                    <td className="px-3 py-2.5 text-right"><Money v={r.rentCost} /></td>
                    <td className="px-3 py-2.5 text-right"><Money v={r.rentIncome} /></td>
                    <td className="px-3 py-2.5 text-right"><Money v={r.rentProfit} strong /></td>
                    <td className="px-3 py-2.5 text-right"><Money v={r.totalProfit} strong /></td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${r.id}-expanded`}>
                      <td colSpan={10} className="border-b bg-white px-6 py-4">
                        <div className="text-sm text-slate-600">展开详情功能开发中…</div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={10} className="py-16 text-center text-slate-400">{board.isLoading ? "加载中…" : "暂无数据"}</td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot><tr className="border-t bg-emerald-50/50 text-xs font-semibold text-slate-700">
              <td className="px-3 py-2.5" colSpan={2}>合计</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{totals.stationCount}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.elecPay)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.elecCollect)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.elecProfit)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.rentCost)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.rentIncome)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.rentProfit)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(totals.totalProfit)}</td>
            </tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
