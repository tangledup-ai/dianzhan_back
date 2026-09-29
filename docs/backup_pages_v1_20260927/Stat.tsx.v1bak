import type { LucideIcon } from "lucide-react";

export function StatCard(props: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  tone?: "default" | "green" | "red" | "amber" | "blue";
}) {
  const tones = {
    default: "text-slate-800",
    green: "text-emerald-600",
    red: "text-rose-600",
    amber: "text-amber-600",
    blue: "text-sky-600",
  };
  const Icon = props.icon;
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">{props.label}</div>
        {Icon && <Icon className="h-4 w-4 text-slate-300" />}
      </div>
      <div className={`mt-1.5 text-xl font-bold tabular-nums ${tones[props.tone ?? "default"]}`}>{props.value}</div>
      {props.sub && <div className="mt-1 text-[11px] text-slate-400">{props.sub}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    已付款: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    已到账: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    未付款: "bg-rose-50 text-rose-700 ring-rose-200",
    未到账: "bg-rose-50 text-rose-700 ring-rose-200",
    正常: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    临期: "bg-amber-50 text-amber-700 ring-amber-200",
    已到期: "bg-rose-50 text-rose-700 ring-rose-200",
    提前结束: "bg-violet-50 text-violet-700 ring-violet-200",
    已结算: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    未结算: "bg-amber-50 text-amber-700 ring-amber-200",
    运营中: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    筹建中: "bg-sky-50 text-sky-700 ring-sky-200",
    已关停: "bg-slate-100 text-slate-500 ring-slate-200",
    api: "bg-sky-50 text-sky-700 ring-sky-200",
    manual: "bg-slate-100 text-slate-600 ring-slate-200",
    meter_api: "bg-sky-50 text-sky-700 ring-sky-200",
  };
  const label = status === "api" || status === "meter_api" ? "电表API" : status === "manual" ? "手工" : status;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${map[status] ?? "bg-slate-100 text-slate-600 ring-slate-200"}`}>
      {label}
    </span>
  );
}

export function Money({ v, strong }: { v: unknown; strong?: boolean }) {
  const n = v === null || v === undefined || v === "" ? null : Number(v);
  if (n === null || Number.isNaN(n)) return <span className="text-slate-300">-</span>;
  return (
    <span className={`tabular-nums ${strong ? "font-semibold" : ""} ${n < 0 ? "text-rose-600" : ""}`}>
      {n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}
