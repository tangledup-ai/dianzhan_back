import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOverview, getMonthlyDetail } from "@/api/overview";
import { getAlerts } from "@/api/alerts";
import { ContractAlertCard } from "@/components/ContractAlertCard";
import { StatCard } from "@/components/Stat";
import { MonthPicker } from "@/components/MonthPicker";
import { fmtMoney, fmtNum } from "@/lib/format";
import { Building2, Zap, Home, TrendingUp, FileWarning, Wallet, Clock, Users, Tag, Landmark, MapPin, ChevronDown, ChevronRight } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { Link } from "react-router";
import { useAuth } from "@/providers/auth";

// 首页合同预警板块（默认展开，可点击收起）
function DashboardAlertSection({ title, caption, items, side }: { title: string; caption: string; items: any[]; side: "pay" | "income" }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" className="mb-2 flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
        <span className="text-xs font-semibold text-slate-700">{title}</span>
        <span className="text-[11px] text-slate-400">{caption}</span>
        <span className="ml-auto text-[11px] text-slate-400">{items.length} 份</span>
      </button>
      {open && <ContractAlertCard items={items} side={side} brief linkTo="/alerts?tab=contract" />}
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const tagScope = user?.meterTagScope || "";
  // 默认选中当月
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [selectedMonth, setSelectedMonth] = useState(defaultMonth);

  const { data, isLoading } = useQuery({ queryKey: ["overview"], queryFn: getOverview });
  // 合同预警（与预警页同源：应付/应收 + 逾期分期，按公司主体分组）
  const alertsQ = useQuery({ queryKey: ["alerts", "monthly", 3], queryFn: () => getAlerts({ granularity: "monthly", days: 3 }), enabled: !tagScope });
  const alertPay = alertsQ.data?.contractPayments ?? [];
  const alertInc = alertsQ.data?.contractCollections ?? [];
  // 首页只展示「未处理」的预警；已处理的在预警页可见
  const openAlertPay = alertPay.filter((i: any) => i.handleStatus !== "已处理");
  const openAlertInc = alertInc.filter((i: any) => i.handleStatus !== "已处理");
  const expiringCount = [...openAlertPay, ...openAlertInc].filter((i: any) => i.status === "临期").length;
  const overdueOnlyCount = [...openAlertPay, ...openAlertInc].filter((i: any) => i.status !== "临期" && i.status !== "已到期").length;
  const monthlyDetail = useQuery({
    queryKey: ["monthlyDetail", selectedMonth],
    queryFn: () => getMonthlyDetail(selectedMonth),
  });

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded((p) => ({ ...p, [key]: !p[key] }));

  if (isLoading || !data) return <div className="py-20 text-center text-slate-400">🚀 正在加载数据...</div>;

  // 到期预警列表：只显示临期（未过期）合同；已到期/提前结束（剩余天数 0）的不展示，避免堆积
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
          <div className="text-sm font-semibold text-slate-800">{tagScope ? `${tagScope}经营总览` : "月度运营情况"}</div>
          <div className="text-xs text-slate-400">{tagScope ? "仅统计已关联场地的本类别电表；场租及场地级损耗不计入本类别利润" : "选择月份查看该月整体经营数据，点击卡片可展开明细"}</div>
        </div>
        <MonthPicker value={selectedMonth} onChange={setSelectedMonth} />
      </div>

      {/* 月度运营情况 */}
      {md && (
        <div className={`grid gap-4 ${tagScope ? "lg:grid-cols-1" : "lg:grid-cols-2"}`}>
          {/* 电费收支 */}
          {!tagScope && <ExpandRow
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
          </ExpandRow>}

          {/* 场租收支 */}
          {!tagScope && <ExpandRow
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
                  <div className="border-b bg-emerald-50/50 px-2 py-1 font-medium text-emerald-700">收入明细（按公司主体汇总）</div>
                  {md.rent.incomeDetails.length === 0 && <div className="py-4 text-center text-slate-400">该月暂无场租收入</div>}
                  {md.rent.incomeDetails.map((d: any, i: number) => (
                    <div key={i} className="flex items-center justify-between border-b px-2 py-1 last:border-0">
                      <span>
                        {d.entityName}
                        <span className="ml-1 text-[10px] text-slate-400">{d.contractCount} 份合同</span>
                      </span>
                      <span className="tabular-nums">{fmtMoney(d.amount)}</span>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border">
                  <div className="border-b bg-rose-50/50 px-2 py-1 font-medium text-rose-700">成本明细（按公司主体汇总）</div>
                  {md.rent.costDetails.length === 0 && <div className="py-4 text-center text-slate-400">该月暂无场租成本</div>}
                  {md.rent.costDetails.map((d: any, i: number) => (
                    <div key={i} className="flex items-center justify-between border-b px-2 py-1 last:border-0">
                      <span>
                        {d.entityName}
                        <span className="ml-1 text-[10px] text-slate-400">{d.contractCount} 份合同</span>
                      </span>
                      <span className="tabular-nums">{fmtMoney(d.amount)}/月</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </ExpandRow>}

          {/* 电量与运营费 */}
          {!tagScope && <ExpandRow
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
          </ExpandRow>}

          {/* 分红 */}
          {!tagScope && <ExpandRow
            open={expanded.div} onToggle={() => toggleExpand("div")}
            title="分红情况"
            summary={`分红总额 ${fmtMoney(md.dividend.total)} · 未结算 ${md.dividend.pending} 条`}
          >
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg bg-emerald-50 p-2"><div className="text-[10px] text-emerald-600">分红总额</div><div className="text-sm font-bold text-emerald-700">{fmtMoney(md.dividend.total)}</div></div>
              <div className="rounded-lg bg-amber-50 p-2"><div className="text-[10px] text-amber-600">未结算</div><div className="text-sm font-bold text-amber-700">{md.dividend.pending} 条</div></div>
            </div>
            <div className="mt-2 text-[10px] text-slate-400">分红明细请到「股东分红」页查看</div>
          </ExpandRow>}
        </div>
      )}

      {/* 核心指标（全量累计） */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="品牌组合" value={`${data.stationCount}`} sub={`运营中 ${data.activeStations} · 电表 ${data.meterCount}`} icon={Building2} tone="blue" />
        <StatCard label={tagScope ? "本类别电费利润（元）" : "净利润（元）"} value={fmtMoney(totalProfit)} sub={tagScope ? "授权类别电表收款（不含税）－付款" : "电费+租金(已扣税)-运营费用"} icon={TrendingUp} tone="green" />
        <StatCard label="电费差价利润（元）" value={fmtMoney(data.elecProfit)} sub={`收款(不含税) ${fmtMoney(data.elecCollect)} / 付款 ${fmtMoney(data.elecPay)}`} icon={Zap} />
        {!tagScope && <StatCard label="场租差价利润（元）" value={fmtMoney(data.rentProfitTotal ?? (data.rentIncomeTotal - data.rentCostTotal))} sub={`收入 ${fmtMoney(data.rentIncomeTotal)} / 成本 ${fmtMoney(data.rentCostTotal)}（已扣税 ${fmtMoney(data.rentTaxTotal ?? 0)}）`} icon={Home} />}
      </div>

      {/* 费用与预警 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {!tagScope && <StatCard label="运营费用（元）" value={fmtMoney(data.opExpenseTotal)} icon={Wallet} />}
        <StatCard label="待收款项（元）" value={fmtMoney(data.elecUncollected + (tagScope ? 0 : data.rentUncollected))} sub={tagScope ? `电费 ${fmtMoney(data.elecUncollected)}` : `电费 ${fmtMoney(data.elecUncollected)} · 租金 ${fmtMoney(data.rentUncollected)}`} icon={Clock} tone="amber" />
        <StatCard label="待付款项（元）" value={fmtMoney(data.elecUnpaid)} icon={Wallet} tone="red" />
        {/* 预警口径：只计「未处理」的 临期 + 逾期分期；已到期（0天）与已处理的不计数，明细见预警页 */}
        {!tagScope && <Link to="/alerts?tab=contract" className="block rounded-xl transition-transform hover:scale-[1.02]">
          <StatCard
            label="合同预警"
            value={`${expiringCount + overdueOnlyCount}`}
            sub={`临期 ${expiringCount} · 逾期分期 ${overdueOnlyCount}`}
            icon={FileWarning}
            tone="red"
          />
        </Link>}
      </div>

      {/* 维度看板入口 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Link to="/brands" className="rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-100 p-2"><Tag className="h-5 w-5 text-blue-600" /></div>
            <div><div className="text-sm font-semibold text-slate-700">品牌方看板</div><div className="text-xs text-slate-400">{data.brandCount} 个品牌方</div></div>
          </div>
        </Link>
        {!tagScope && <Link to="/entities" className="rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-100 p-2"><Landmark className="h-5 w-5 text-purple-600" /></div>
            <div><div className="text-sm font-semibold text-slate-700">公司主体看板</div><div className="text-xs text-slate-400">{data.entityCount} 个主体</div></div>
          </div>
        </Link>}
        <Link to="/landlords" className="rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-100 p-2"><MapPin className="h-5 w-5 text-amber-600" /></div>
            <div><div className="text-sm font-semibold text-slate-700">场地方看板</div><div className="text-xs text-slate-400">{data.landlordCount} 个场地方</div></div>
          </div>
        </Link>
        {!tagScope && <Link to="/shareholders" className="rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-100 p-2"><Users className="h-5 w-5 text-emerald-600" /></div>
            <div><div className="text-sm font-semibold text-slate-700">股东分红</div><div className="text-xs text-slate-400">{data.shareholderCount} 个股东 · {data.introducerCount} 个介绍人</div></div>
          </div>
        </Link>}
      </div>

      {/* 图表与预警 */}
      <div className={`grid gap-6 ${tagScope ? "lg:grid-cols-1" : "lg:grid-cols-3"}`}>
        <div className="rounded-xl border bg-white p-5 shadow-sm lg:col-span-2 flex flex-col min-w-0">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">电费收付月度趋势</h3>
          <div className="min-h-[18rem] flex-1">
            <ResponsiveContainer width="100%" height="100%" debounce={200}>
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

        {/* 合同预警：与预警页同源（应付/应收 + 逾期分期），按公司主体分组 */}
        {!tagScope && <div className="rounded-xl border bg-white p-5 shadow-sm min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <FileWarning className="h-4 w-4 text-rose-500" /> 合同预警
            </h3>
            <Link to="/alerts?tab=contract" className="text-xs text-emerald-600 hover:underline">预警详情 →</Link>
          </div>
          <div className="max-h-[28rem] space-y-4 overflow-y-auto pr-1">
            {openAlertPay.length === 0 && openAlertInc.length === 0 && (
              <div className="py-8 text-center text-xs text-slate-400">暂无未处理的合同预警（临期 / 逾期分期合同将显示在这里）</div>
            )}
            <DashboardAlertSection title="场地合同 · 应付预警" caption="公司 → 场地方" items={openAlertPay} side="pay" />
            <DashboardAlertSection title="品牌方合同 · 应收预警" caption="品牌方 → 公司" items={openAlertInc} side="income" />
          </div>
        </div>}
      </div>
    </div>
  );
}
