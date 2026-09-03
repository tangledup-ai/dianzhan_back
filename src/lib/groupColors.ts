// 公司主体分组配色（Rent 年度付款计划 / Electricity 电费月台账共用）
export type GroupColor = {
  border: string; bg: string; icon: string; text: string; chip: string;
  head: string; iconGrad: string; badge: string; bar: string; chipPay: string; btn: string; btnOutline: string;
};

export const UNSPECIFIED_ENTITY = "未指定主体";

export const GROUP_COLORS: GroupColor[] = [
  { border: "border-indigo-200/70", bg: "bg-indigo-50/40", icon: "bg-indigo-500", text: "text-indigo-700", chip: "bg-indigo-100 text-indigo-700",
    head: "from-indigo-50 via-white to-white", iconGrad: "from-indigo-500 to-indigo-600", badge: "bg-indigo-100 text-indigo-700",
    bar: "from-indigo-500 via-indigo-400 to-emerald-400", chipPay: "bg-indigo-50 text-indigo-600",
    btn: "bg-indigo-600 hover:bg-indigo-700", btnOutline: "border-indigo-200 bg-indigo-50/60 text-indigo-600 hover:border-indigo-300 hover:bg-indigo-100" },
  { border: "border-emerald-200/70", bg: "bg-emerald-50/40", icon: "bg-emerald-500", text: "text-emerald-700", chip: "bg-emerald-100 text-emerald-700",
    head: "from-emerald-50 via-white to-white", iconGrad: "from-emerald-500 to-emerald-600", badge: "bg-emerald-100 text-emerald-700",
    bar: "from-emerald-500 via-emerald-400 to-teal-400", chipPay: "bg-emerald-50 text-emerald-600",
    btn: "bg-emerald-600 hover:bg-emerald-700", btnOutline: "border-emerald-200 bg-emerald-50/60 text-emerald-600 hover:border-emerald-300 hover:bg-emerald-100" },
  { border: "border-amber-200/70", bg: "bg-amber-50/40", icon: "bg-amber-500", text: "text-amber-700", chip: "bg-amber-100 text-amber-700",
    head: "from-amber-50 via-white to-white", iconGrad: "from-amber-500 to-amber-600", badge: "bg-amber-100 text-amber-700",
    bar: "from-amber-500 via-amber-400 to-orange-400", chipPay: "bg-amber-50 text-amber-600",
    btn: "bg-amber-600 hover:bg-amber-700", btnOutline: "border-amber-200 bg-amber-50/60 text-amber-600 hover:border-amber-300 hover:bg-amber-100" },
  { border: "border-sky-200/70", bg: "bg-sky-50/40", icon: "bg-sky-500", text: "text-sky-700", chip: "bg-sky-100 text-sky-700",
    head: "from-sky-50 via-white to-white", iconGrad: "from-sky-500 to-sky-600", badge: "bg-sky-100 text-sky-700",
    bar: "from-sky-500 via-sky-400 to-cyan-400", chipPay: "bg-sky-50 text-sky-600",
    btn: "bg-sky-600 hover:bg-sky-700", btnOutline: "border-sky-200 bg-sky-50/60 text-sky-600 hover:border-sky-300 hover:bg-sky-100" },
  { border: "border-rose-200/70", bg: "bg-rose-50/40", icon: "bg-rose-500", text: "text-rose-700", chip: "bg-rose-100 text-rose-700",
    head: "from-rose-50 via-white to-white", iconGrad: "from-rose-500 to-rose-600", badge: "bg-rose-100 text-rose-700",
    bar: "from-rose-500 via-rose-400 to-pink-400", chipPay: "bg-rose-50 text-rose-600",
    btn: "bg-rose-600 hover:bg-rose-700", btnOutline: "border-rose-200 bg-rose-50/60 text-rose-600 hover:border-rose-300 hover:bg-rose-100" },
  { border: "border-violet-200/70", bg: "bg-violet-50/40", icon: "bg-violet-500", text: "text-violet-700", chip: "bg-violet-100 text-violet-700",
    head: "from-violet-50 via-white to-white", iconGrad: "from-violet-500 to-violet-600", badge: "bg-violet-100 text-violet-700",
    bar: "from-violet-500 via-violet-400 to-purple-400", chipPay: "bg-violet-50 text-violet-600",
    btn: "bg-violet-600 hover:bg-violet-700", btnOutline: "border-violet-200 bg-violet-50/60 text-violet-600 hover:border-violet-300 hover:bg-violet-100" },
  { border: "border-teal-200/70", bg: "bg-teal-50/40", icon: "bg-teal-500", text: "text-teal-700", chip: "bg-teal-100 text-teal-700",
    head: "from-teal-50 via-white to-white", iconGrad: "from-teal-500 to-teal-600", badge: "bg-teal-100 text-teal-700",
    bar: "from-teal-500 via-teal-400 to-cyan-400", chipPay: "bg-teal-50 text-teal-600",
    btn: "bg-teal-600 hover:bg-teal-700", btnOutline: "border-teal-200 bg-teal-50/60 text-teal-600 hover:border-teal-300 hover:bg-teal-100" },
  { border: "border-orange-200/70", bg: "bg-orange-50/40", icon: "bg-orange-500", text: "text-orange-700", chip: "bg-orange-100 text-orange-700",
    head: "from-orange-50 via-white to-white", iconGrad: "from-orange-500 to-orange-600", badge: "bg-orange-100 text-orange-700",
    bar: "from-orange-500 via-orange-400 to-amber-400", chipPay: "bg-orange-50 text-orange-600",
    btn: "bg-orange-600 hover:bg-orange-700", btnOutline: "border-orange-200 bg-orange-50/60 text-orange-600 hover:border-orange-300 hover:bg-orange-100" },
];

export const GROUP_COLOR_NEUTRAL: GroupColor = { border: "border-slate-200", bg: "bg-slate-50/40", icon: "bg-slate-400", text: "text-slate-600", chip: "bg-slate-100 text-slate-600",
  head: "from-slate-50 via-white to-white", iconGrad: "from-slate-400 to-slate-500", badge: "bg-slate-100 text-slate-600",
  bar: "from-slate-400 via-slate-300 to-slate-200", chipPay: "bg-slate-100 text-slate-600",
  btn: "bg-slate-500 hover:bg-slate-600", btnOutline: "border-slate-200 bg-slate-100/60 text-slate-600 hover:border-slate-300 hover:bg-slate-100" };

// 按公司主体分组：同名归组、按名称排序，「未指定主体」排最后并使用灰色
export function groupByEntity<T extends { entityName?: string | null }>(rows: T[]): { entityName: string; color: GroupColor; rows: T[] }[] {
  const named: { entityName: string; rows: T[] }[] = [];
  let unspecified: { entityName: string; rows: T[] } | null = null;
  const idx = new Map<string, number>();
  for (const r of rows) {
    const ent = r.entityName || UNSPECIFIED_ENTITY;
    if (ent === UNSPECIFIED_ENTITY) {
      if (!unspecified) unspecified = { entityName: ent, rows: [] };
      unspecified.rows.push(r);
      continue;
    }
    if (!idx.has(ent)) {
      idx.set(ent, named.length);
      named.push({ entityName: ent, rows: [] });
    }
    named[idx.get(ent)!].rows.push(r);
  }
  named.sort((a, b) => a.entityName.localeCompare(b.entityName, "zh"));
  const out = named.map((g, i) => ({ ...g, color: GROUP_COLORS[i % GROUP_COLORS.length] }));
  if (unspecified && unspecified.rows.length > 0) {
    out.push({ ...unspecified, color: GROUP_COLOR_NEUTRAL });
  }
  return out;
}
