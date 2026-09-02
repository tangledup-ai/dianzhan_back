import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOverview, getMonthlyDetail } from "@/api/overview";
import { listContracts } from "@/api/contracts";
import { StatCard } from "@/components/Stat";
import { MonthPicker } from "@/components/MonthPicker";
import { fmtMoney, fmtNum } from "@/lib/format";
import { Building2, Zap, Home, TrendingUp, AlertTriangle, FileWarning, Wallet, Clock, Users, Tag, Landmark, MapPin, ChevronDown, ChevronRight } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { Link } from "react-router";

export default function Dashboard() {
  // 默认选中当月
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [selectedMonth, setSelectedMonth] = useState(defaultMonth);

  const { data, isLoading } = useQuery({ queryKey: ["overview"], queryFn: getOverview });
  const contracts = useQuery({ queryKey: ["contracts"], queryFn: () => listContracts() });
  const monthlyDetail = useQuery({
    queryKey: ["monthlyDetail", selectedMonth],
    queryFn: () => getMonthlyDetail(selectedMonth),
  });

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded((p) => ({ ...p, [key]: !p[key] }));

  if (isLoading || !data) return <div className="py-20 text-center text-slate-400">🚀 正在加载数据...</div>;

  const expiring = (contracts.data ?? []).filter((c: any) => c.status === "临期" || c.status === "已到期");
  const md = monthlyDetail.data;
  const totalProfit = data.netProfitTotal ?? (data.elecProfit + data.rentIncomeTotal - data.rentCostTotal - data.opExpenseTotal);

  // 明细展开行组件
  const ExpandRow = ({ open, onToggle, title, summary, children }: any) => (
    <div className="rounded-xl border bg-white shadow-sm">
      <button className="flex w-full items-center justify-between px-4 py-3 hover:bg-slate-50" onClick={onToggle}>
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
          <span className="text-sm font-semibold text-slate-700">{title}</span>
        </div>
        <span className="text-xs font-medium text-slate-500">{summary}</span>
      </button>
      {open && <div className="border-t px-4 py-3">{children}</div>}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* 顶部：月份选择器 */}
      <div className="flex items-center justify-between rounded-xl border bg-white p-4 shadow-sm">
        <div>
          <div className="text-sm font-semibold text-slate-800">月度运营情况</div>
          <div className="text-xs text-slate-400">选择月份查看该月整体经营数据，点击卡片可展开明细</div>
        </div>
        <MonthPicker value={selectedMonth} onChange={setSelectedMonth} />
      </div>

      {/* 月度运营情况 */}
      {md && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* 电费收支 */}
          <ExpandRow
            open={expanded.elec} onToggle={() => toggleExpand("elec")}
            title="电费收支"
            summary={`收入 ${fmtMoney(md.elec.income)} · 成本 ${fmtMoney(md.elec.cost)} · 利润 ${fmtMoney(md.elec.profit)}`}
          >
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-emerald-50 p-2"><div className="text-[10px] text-emerald-600">电费收入</div><div className="text-sm font-bold text-emerald-700">{fmtMoney(md.elec.income)}</div></div>
                <div className="rounded-lg bg-rose-50 p-2"><div className="text-[10px] text-rose-600">电费成本</div><div className="text-sm font-bold text-rose-700">{fmtMoney(md.elec.cost)}</div></div>
                <div className="rounded-lg bg-blue-50 p-2"><div className="text-[10px] text-blue-600">电费利润</div><div className="text-sm font-bold text-blue-700">{fmtMoney(md.elec.profit)}</div></div>
              </div>
              {md.elec.details.length > 0 && (
                <div className="max-h-64 overflow-y-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b bg-slate-50 text-left text-slate-500">
                      <th className="px-2 py-1.5 font-medium">电表</th><th className="px-2 py-1.5 font-medium">品牌</th>
                      <th className="px-2 py-1.5 text-right font-medium">度数</th><th className="px-2 py-1.5 text-right font-medium">付款</th>
                      <th className="px-2 py-1.5 text-right font-medium">收款(不含税)</th>
                    </tr></thead>
                    <tbody>
                      {md.elec.details.map((d: any, i: number) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="px-2 py-1.5 font-mono">{d.meterNo}</td>
                          <td className="px-2 py-1.5">{d.brandName || "-"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(d.kwh)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-rose-600">{fmtMoney(d.payAmount)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{fmtMoney(d.collectNet)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {md.elec.details.length === 0 && <div className="py-4 text-center text-xs text-slate-400">该月暂无电费台账明细</div>}
            </div>
          </ExpandRow>

          {/* 场租收支 */}
          <ExpandRow
            open={expanded.rent} onToggle={() => toggleExpand("rent")}
            title="场租收支"
            summary={`收入 ${fmtMoney(md.rent.income)} · 成本 ${fmtMoney(md.rent.cost)} · 利润 ${fmtMoney(md.rent.profit)}`}
          >
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-emerald-50 p-2"><div className="text-[10px] text-emerald-600">场租收入</div><div className="text-sm font-bold text-emerald-700">{fmtMoney(md.rent.income)}</div></div>
                <div className="rounded-lg bg-rose-50 p-2"><div className="text-[10px] text-rose-600">场租成本</div><div className="text-sm font-bold text-rose-700">{fmtMoney(md.rent.cost)}</div></div>
                <div className="rounded-lg bg-blue-50 p-2"><div className="text-[10px] text-blue-600">场租利润</div><div className="text-sm font-bold text-blue-700">{fmtMoney(md.rent.profit)}</div></div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border">
                  <div className="border-b bg-emerald-50/50 px-2 py-1 font-medium text-emerald-700">收入明细（品牌方合同）</div>
                  {md.rent.incomeDetails.map((d: any, i: number) => (
                    <div key={i} className="flex justify-between border-b px-2 py-1 last:border-0">
                      <span>{d.brandName}</span><span className="tabular-nums">{fmtMoney(d.monthlyRent)}/月</span>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border">
                  <div className="border-b bg-rose-50/50 px-2 py-1 font-medium text-rose-700">成本明细（场地合同）</div>
                  {md.rent.costDetails.map((d: any, i: number) => (
                    <div key={i} className="flex justify-between border-b px-2 py-1 last:border-0">
                      <span>{d.landlordName}</span><span className="tabular-nums">{fmtMoney(d.monthlyRent)}/月</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </ExpandRow>

          {/* 电量与运营费 */}
          <ExpandRow
            open={expanded.op} onToggle={() => toggleExpand("op")}
            title="电量与运营费"
            summary={`电量 ${fmtNum(md.totalKwh)} 度 · 运营费 ${fmtMoney(md.opExpense.total)}`}
          >
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-lg bg-amber-50 p-2"><div className="text-[10px] text-amber-600">总电量</div><div className="text-sm font-bold text-amber-700">{fmtNum(md.totalKwh)} 度</div></div>
                <div className="rounded-lg bg-slate-50 p-2"><div className="text-[10px] text-slate-500">运营费用</div><div className="text-sm font-bold text-slate-700">{fmtMoney(md.opExpense.total)}</div></div>
              </div>
              {md.opExpense.details.length > 0 && (
                <div className="rounded-lg border">
                  {md.opExpense.details.map((d: any, i: number) => (
                    <div key={i} className="flex justify-between border-b px-2 py-1 text-xs last:border-0">
                      <span>{d.landlordName}{d.remark ? `（${d.remark}）` : ""}</span><span className="tabular-nums text-rose-600">{fmtMoney(d.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
              {md.opExpense.details.length === 0 && <div className="py-3 text-center text-xs text-slate-400">该月暂无运营费用</div>}
            </div>
          </ExpandRow>

          {/* 分红 */}
          <ExpandRow
            open={expanded.div} onToggle={() => toggleExpand("div")}
            title="分红情况"
            summary={`分红总额 ${fmtMoney(md.dividend.total)} · 未结算 ${md.dividend.pending} 条`}
          >
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg bg-emerald-50 p-2"><div className="text-[10px] text-emerald-600">分红总额</div><div className="text-sm font-bold text-emerald-700">{fmtMoney(md.dividend.total)}</div></div>
              <div className="rounded-lg bg-amber-50 p-2"><div className="text-[10px] text-amber-600">未结算</div><div className="text-sm font-bold text-amber-700">{md.dividend.pending} 条</div></div>
            </div>
            <div className="mt-2 text-[10px] text-slate-400">分红明细请到「股东分红」页查看</div>
          </ExpandRow>
        </div>
      )}

      {/* 核心指标（全量累计） */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="品牌组合" value={`${data.stationCount}`} sub={`运营中 ${data.activeStations} · 电表 ${data.meterCount}`} icon={Building2} tone="blue" />
        <StatCard label="净利润（元）" value={fmtMoney(totalProfit)} sub="电费+租金(已扣税)-运营费用" icon={TrendingUp} tone="green" />
        <StatCard label="电费差价利润（元）" value={fmtMoney(data.elecProfit)} sub={`收款(不含税) ${fmtMoney(data.elecCollect)} / 付款 ${fmtMoney(data.elecPay)}`} icon={Zap} />
        <StatCard label="场租差价利润（元）" value={fmtMoney(data.rentProfitTotal ?? (data.rentIncomeTotal - data.rentCostTotal))} sub={`收入 ${fmtMoney(data.rentIncomeTotal)} / 成本 ${fmtMoney(data.rentCostTotal)}（已扣税 ${fmtMoney(data.rentTaxTotal ?? 0)}）`} icon={Home} />
      </div>

      {/* 费用与预警 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="运营费用（元）" value={fmtMoney(data.opExpenseTotal)} icon={Wallet} />
        <StatCard label="待收款项（元）" value={fmtMoney(data.elecUncollected + data.rentUncollected)} sub={`电费 ${fmtMoney(data.elecUncollected)} · 租金 ${fmtMoney(data.rentUncollected)}`} icon={Clock} tone="amber" />
        <StatCard label="待付款项（元）" value={fmtMoney(data.elecUnpaid)} icon={Wallet} tone="red" />
        {/* 与「异常预警 → 合同预警」同口径；点击直达该页 */}
        <Link to="/alerts?tab=contract" className="block rounded-xl transition-transform hover:scale-[1.02]">
          <StatCard
            label="合同预警"
            value={`${data.expiredContracts + data.expiringContracts + (data.overdueContracts ?? 0)}`}
            sub={`已到期 ${data.expiredContracts} · 临期 ${data.expiringContracts} · 逾期分期 ${data.overdueContracts ?? 0}`}
            icon={FileWarning}
            tone="red"
          />
        </Link>
      </div>

      {/* 维度看板入口 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Link to="/brands" className="rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-100 p-2"><Tag className="h-5 w-5 text-blue-600" /></div>
            <div><div className="text-sm font-semibold text-slate-700">品牌方看板</div><div className="text-xs text-slate-400">{data.brandCount} 个品牌方</div></div>
          </div>
        </Link>
        <Link to="/entities" className="rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-100 p-2"><Landmark className="h-5 w-5 text-purple-600" /></div>
            <div><div className="text-sm font-semibold text-slate-700">公司主体看板</div><div className="text-xs text-slate-400">{data.entityCount} 个主体</div></div>
          </div>
        </Link>
        <Link to="/landlords" className="rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-100 p-2"><MapPin className="h-5 w-5 text-amber-600" /></div>
            <div><div className="text-sm font-semibold text-slate-700">场地方看板</div><div className="text-xs text-slate-400">{data.landlordCount} 个场地方</div></div>
          </div>
        </Link>
        <Link to="/shareholders" className="rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-100 p-2"><Users className="h-5 w-5 text-emerald-600" /></div>
            <div><div className="text-sm font-semibold text-slate-700">股东分红</div><div className="text-xs text-slate-400">{data.shareholderCount} 个股东 · {data.introducerCount} 个介绍人</div></div>
          </div>
        </Link>
      </div>

      {/* 图表与预警 */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border bg-white p-5 shadow-sm lg:col-span-2">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">电费收付月度趋势</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="period" fontSize={12} />
                <YAxis fontSize={12} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}万`} />
                <Tooltip formatter={(v: any) => fmtMoney(v)} />
                <Legend />
                <Bar dataKey="elecCollect" name="电费收款" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="elecPay" name="电费付款" fill="#f43f5e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="elecProfit" name="电费利润" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> 合同到期预警
            </h3>
            <Link to="/contracts" className="text-xs text-emerald-600 hover:underline">全部合同 →</Link>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {expiring.length === 0 && <div className="py-10 text-center text-xs text-slate-400">暂无临期或到期合同</div>}
            {expiring.map((c: any) => (
              <div key={c.id} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-700">{c.landlordName || c.stationName || "-"}</span>
                  <span className={`text-[11px] font-semibold ${c.status === "已到期" ? "text-rose-600" : "text-amber-600"}`}>
                    {c.status === "已到期" ? `已逾期 ${-c.days_left} 天` : `剩 ${c.days_left} 天`}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {c.brandName ?? "未关联品牌"} · 至 {c.endDate ?? "-"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
