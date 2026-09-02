import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAlerts } from "@/api/alerts";
import { StatusBadge } from "@/components/Stat";
import { inputCls } from "@/components/fields";
import { fmtMoney, fmtNum, fmtDate } from "@/lib/format";
import { Zap, ChevronDown, ChevronRight, AlertTriangle, ArrowDownCircle, ArrowUpCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

// ─── 统计卡片 ───
function StatCard({ label, value, sub, icon: Icon, tone }: { label: string; value: any; sub?: string; icon: any; tone: "rose" | "amber" | "blue" | "emerald" }) {
  const color = { rose: "text-rose-600", amber: "text-amber-600", blue: "text-blue-600", emerald: "text-emerald-600" }[tone];
  const bg = { rose: "bg-rose-50", amber: "bg-amber-50", blue: "bg-blue-50", emerald: "bg-emerald-50" }[tone];
  return (
    <div className="rounded-xl border bg-white p-3 shadow-sm">
      <div className={`mb-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${bg} ${color}`}>
        <Icon className="h-3 w-3" />{label}
      </div>
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

// ─── 电量异常表 ───
function ElecAnomalyTable({ items, granularity }: { items: any[]; granularity: "daily" | "monthly" }) {
  const isDaily = granularity === "daily";
  const curLabel = isDaily ? "近N天日均" : "本月度数";
  const prevLabel = isDaily ? "基准日均" : "去年同期";
  if (items.length === 0) {
    return <div className="rounded-xl border bg-white py-14 text-center text-sm text-slate-400">✅ 暂无电量异常</div>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
      <table className="w-full min-w-[800px] text-xs">
        <thead>
          <tr className="border-b bg-slate-50 text-left text-[11px] text-slate-500">
            <th className="px-3 py-2.5 font-medium">场地方</th>
            <th className="px-3 py-2.5 font-medium">品牌</th>
            <th className="px-3 py-2.5 font-medium">电表</th>
            <th className="px-3 py-2.5 text-right font-medium">{curLabel}</th>
            <th className="px-3 py-2.5 text-right font-medium">{prevLabel}</th>
            <th className="px-3 py-2.5 text-right font-medium">上涨</th>
            <th className="px-3 py-2.5 text-center font-medium">严重度</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a: any, i: number) => {
            const sev = a.ratio >= 3 ? "严重" : a.ratio >= 2 ? "较高" : "关注";
            const sevColor = a.ratio >= 3 ? "bg-rose-100 text-rose-700" : a.ratio >= 2 ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700";
            return (
              <tr key={i} className="border-b last:border-0 hover:bg-slate-50/60">
                <td className="px-3 py-2.5 font-medium text-slate-700">{a.stationName}</td>
                <td className="px-3 py-2.5 text-slate-600">{a.brandName}</td>
                <td className="px-3 py-2.5">
                  <div className="font-mono text-[11px] text-slate-500">{a.meterNo}</div>
                  <div className="text-[11px] text-slate-400">{a.meterName}</div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {fmtNum(a.currentKwh)} {isDaily ? "度/日" : "度"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                  {fmtNum(a.prevKwh)} {isDaily ? "度/日" : "度"}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span className="font-bold tabular-nums text-rose-600">+{a.growthPct}%</span>
                  <span className="ml-1 text-[10px] text-slate-400">({fmtNum(a.ratio)}×)</span>
                </td>
                <td className="px-3 py-2.5 text-center">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${sevColor}`}>{sev}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── 合同预警卡片（应收/应付）───
function ContractAlertCard({ items, side }: { items: any[]; side: "pay" | "income" }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (items.length === 0) {
    return <div className="rounded-xl border bg-white py-10 text-center text-sm text-slate-400">暂无{side === "pay" ? "应付" : "应收"}预警合同</div>;
  }

  const label = side === "pay" ? "应付" : "应收";
  const doneWord = side === "pay" ? "已付" : "已收";
  const pendingWord = side === "pay" ? "未付" : "未收";

  return (
    <div className="space-y-3">
      {items.map((c: any) => {
        const open = expanded.has(c.contractId);
        const overdue = c.overdueCount > 0;
        const statusBadge = c.status === "已到期" ? "已到期" : c.status === "临期" ? `临期(${c.daysLeft}天)` : "";
        return (
          <div key={c.contractId} className={`rounded-xl border bg-white shadow-sm overflow-hidden ${c.status === "已到期" ? "border-rose-200" : overdue ? "border-amber-200" : ""}`}>
            {/* 合同摘要 */}
            <div className="cursor-pointer border-b bg-slate-50/60 px-4 py-3" onClick={() => toggle(c.contractId)}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-slate-400">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
                <span className="font-semibold text-slate-800">
                  {side === "pay" ? (c.landlordName || c.partner) : (c.brandName || c.partner)}
                </span>
                <span className="text-xs text-slate-500">{c.contractType}</span>
                {statusBadge && <StatusBadge status={statusBadge} />}
                {overdue && (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                    ⚠ 逾期 {c.overdueCount} 期 {fmtMoney(c.overdueAmount)}
                  </span>
                )}
                {c.payMethod && <span className="text-[11px] text-slate-400">{c.payMethod}</span>}
                <span className="ml-auto text-[11px] text-slate-400">合同期 {fmtDate(c.startDate)} ~ {fmtDate(c.endDate)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 pl-8 text-xs">
                <span className="text-slate-500">月租 <b className="text-slate-700">{fmtMoney(c.monthlyRent)}</b></span>
                <span className="text-slate-500">总{label} <b className="text-slate-700">{fmtMoney(c.totalAmount)}</b></span>
                <span className="text-emerald-600">{doneWord} <b>{fmtMoney(c.paidAmount)}</b>（{c.paidCount}/{c.totalCount}期）</span>
                <span className="text-rose-600">{pendingWord} <b>{fmtMoney(c.pendingAmount)}</b>（{c.pendingCount}期）</span>
                <span className="text-slate-400">收付率 {(c.paidRatio * 100).toFixed(0)}%</span>
                {c.landlordContact && <span className="text-slate-400">联系人 {c.landlordContact}{c.landlordPhone ? ` ${c.landlordPhone}` : ""}</span>}
                {c.brandContact && <span className="text-slate-400">联系人 {c.brandContact}</span>}
              </div>
            </div>

            {/* 分期明细 */}
            {open && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-[11px]">
                  <thead>
                    <tr className="border-b bg-slate-100 text-left text-[10px] text-slate-500">
                      <th className="px-3 py-1.5">期</th>
                      <th className="px-3 py-1.5">区间</th>
                      <th className="px-3 py-1.5 text-right">金额</th>
                      <th className="px-3 py-1.5">状态</th>
                      <th className="px-3 py-1.5">实收/付日期</th>
                      <th className="px-3 py-1.5">发票号</th>
                      <th className="px-3 py-1.5">备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(c.schedules ?? []).map((s: any) => {
                      const sDone = side === "pay" ? s.status === "已付款" : s.status === "已到账";
                      const sOverdue = !sDone && s.periodEnd && String(s.periodEnd) < new Date().toISOString().slice(0, 10);
                      return (
                        <tr key={s.seq} className={`border-b last:border-0 ${sOverdue ? "bg-rose-50/40" : sDone ? "" : "hover:bg-slate-50/50"}`}>
                          <td className="px-3 py-1.5 text-slate-500">#{s.seq}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">
                            {fmtDate(s.periodStart)} ~ {fmtDate(s.periodEnd)}
                            {sOverdue && <span className="ml-1.5 rounded bg-rose-100 px-1 py-0.5 text-[9px] text-rose-600">逾期</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-medium text-slate-700">{fmtMoney(s.amount)}</td>
                          <td className="px-3 py-1.5">
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${sDone ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                              {s.status || "—"}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 tabular-nums text-slate-500">{s.payDate ? fmtDate(s.payDate) : "—"}</td>
                          <td className="px-3 py-1.5 font-mono text-slate-500">{s.invoice || "—"}</td>
                          <td className="px-3 py-1.5 text-slate-400">{s.remark || ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── 主页面 ───
export default function Alerts() {
  const [tab, setTab] = useState<"elec" | "contract">("elec");
  const [granularity, setGranularity] = useState<"daily" | "monthly">("monthly");
  const [days, setDays] = useState(3);

  // 支持从其他页面跳转直达：/alerts?tab=contract（用完即清除参数）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t === "contract" || t === "elec") setTab(t);
    if (t) window.history.replaceState({}, "", window.location.pathname);
  }, []);
  // 合同预警两个板块的展开/收起（默认收起，点击小标题切换）
  const [payOpen, setPayOpen] = useState(false);
  const [incOpen, setIncOpen] = useState(false);
  const q = useQuery({
    queryKey: ["alerts", granularity, days],
    queryFn: () => getAlerts({ granularity, days }),
  });
  const data = q.data ?? {};

  const elec = data.elecAnomalies ?? [];
  const pay = data.contractPayments ?? [];
  const inc = data.contractCollections ?? [];

  return (
    <div className="space-y-4">
      {/* 顶部 */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">异常预警</h2>
        <div className="flex gap-1">
          <button onClick={() => setTab("elec")}
            className={`rounded-md px-4 py-1.5 text-sm ${tab === "elec" ? "bg-amber-500 text-white" : "bg-white text-slate-600 border hover:bg-slate-50"}`}>
            电量异常
          </button>
          <button onClick={() => setTab("contract")}
            className={`rounded-md px-4 py-1.5 text-sm ${tab === "contract" ? "bg-rose-500 text-white" : "bg-white text-slate-600 border hover:bg-slate-50"}`}>
            合同预警
          </button>
        </div>
        <button
          onClick={() => { q.refetch(); toast.success("已刷新"); }}
          className="ml-auto flex items-center gap-1 rounded-md border bg-white px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />刷新
        </button>
      </div>

      {/* ── 电量异常 ── */}
      {tab === "elec" && (
        <div className="space-y-4">
          {/* 对比方式切换：按日 / 按月 */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex overflow-hidden rounded-lg border bg-white">
              <button
                onClick={() => setGranularity("monthly")}
                className={`px-3 py-1.5 text-xs font-medium ${granularity === "monthly" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
              >
                按月对比
              </button>
              <button
                onClick={() => setGranularity("daily")}
                className={`px-3 py-1.5 text-xs font-medium ${granularity === "daily" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
              >
                按日对比
              </button>
            </div>
            {granularity === "daily" && (
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <span>合并最近</span>
                <select className={`${inputCls} w-20`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {[2, 3, 5, 7].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <span>天对比（平滑单日波动）</span>
              </div>
            )}
            <span className="text-[11px] text-slate-400">
              {granularity === "monthly" ? "本月 vs 去年同月" : `近${days}天日均 vs 前7天日均`} · 阈值 ×{data.config?.elecYoyRatio ?? 1.5}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <StatCard label="电量异常" value={elec.length} sub={`阈值 ×${data.config?.elecYoyRatio ?? 1.5}（基础档案可调）`} icon={Zap} tone="amber" />
            <StatCard label="严重（≥3倍）" value={elec.filter((a: any) => a.ratio >= 3).length} icon={AlertTriangle} tone="rose" />
            <StatCard label="较高（≥2倍）" value={elec.filter((a: any) => a.ratio >= 2 && a.ratio < 3).length} icon={AlertTriangle} tone="blue" />
          </div>
          <div className="rounded-lg border bg-white px-4 py-2.5 text-[11px] text-slate-500">
            {granularity === "monthly" ? (
              <>口径：<b>最近月份</b>（{elec[0]?.period ?? "—"}）用电量 ÷ <b>去年同期</b>（{elec[0]?.prevPeriod ?? "—"}）；上涨比例 = 本月/去年同月 − 1。
              仅统计已关联场地+品牌的电表；无去年同期数据的电表不参与（无法同比）。</>
            ) : (
              <>口径：<b>最近 {elec[0]?.days ?? days} 天日均</b>（截至 {elec[0]?.period ?? "—"}）÷ <b>{elec[0]?.prevPeriod ?? "前7天"}日均</b>；把最近几天合并对比，减少单日波动误报。</>
            )}
          </div>
          <ElecAnomalyTable items={elec} granularity={granularity} />
        </div>
      )}

      {/* ── 合同预警 ── */}
      {tab === "contract" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="场地合同应付" value={pay.length} sub={`提前 ${data.config?.expireDaysVenue ?? 30} 天提醒`} icon={ArrowDownCircle} tone="rose" />
            <StatCard label="品牌方合同应收" value={inc.length} sub={`提前 ${data.config?.expireDaysBrand ?? 30} 天提醒`} icon={ArrowUpCircle} tone="emerald" />
          </div>
          <div className="rounded-lg border bg-white px-4 py-2.5 text-[11px] text-slate-500">
            提醒规则：合同<b>已到期</b> 或 <b>临期</b>（剩余天数 ≤ 配置提前天数）或 <b>有逾期未收/付分期</b>（分期结束日期已过仍未收/付）。
            点合同展开可核对每期应收/付明细（区间、金额、状态、实付日期、发票号）。提前天数与电量阈值在「基础档案 → 预警设置」中调整。
          </div>
          <div>
            <div
              className="mb-2 -mx-2 flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100/70"
              onClick={() => setPayOpen((o) => !o)}
              title={payOpen ? "点击收起" : "点击展开"}
            >
              {payOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
              <ArrowDownCircle className="h-4 w-4 text-rose-500" />
              <h3 className="text-sm font-semibold text-slate-700">场地合同 · 应付预警</h3>
              <span className="text-[11px] text-slate-400">公司 → 场地方</span>
              <span className="ml-auto text-[11px] text-slate-400">{pay.length} 份</span>
            </div>
            {payOpen && <ContractAlertCard items={pay} side="pay" />}
          </div>
          <div>
            <div
              className="mb-2 -mx-2 flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100/70"
              onClick={() => setIncOpen((o) => !o)}
              title={incOpen ? "点击收起" : "点击展开"}
            >
              {incOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
              <ArrowUpCircle className="h-4 w-4 text-emerald-500" />
              <h3 className="text-sm font-semibold text-slate-700">品牌方合同 · 应收预警</h3>
              <span className="text-[11px] text-slate-400">品牌方 → 公司</span>
              <span className="ml-auto text-[11px] text-slate-400">{inc.length} 份</span>
            </div>
            {incOpen && <ContractAlertCard items={inc} side="income" />}
          </div>
        </div>
      )}
    </div>
  );
}
