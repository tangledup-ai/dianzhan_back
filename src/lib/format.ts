export function fmtMoney(v: unknown, dash = "-"): string {
  if (v === null || v === undefined || v === "") return dash;
  const n = Number(v);
  if (Number.isNaN(n)) return dash;
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtNum(v: unknown, dash = "-"): string {
  if (v === null || v === undefined || v === "") return dash;
  const n = Number(v);
  if (Number.isNaN(n)) return dash;
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function fmtPct(v: unknown, dash = "-"): string {
  if (v === null || v === undefined || v === "") return dash;
  const n = Number(v);
  if (Number.isNaN(n)) return dash;
  return `${(n * 100).toFixed(n * 100 % 1 === 0 ? 0 : 2)}%`;
}

export function fmtDate(v: unknown, dash = "-"): string {
  if (v === null || v === undefined || v === "") return dash;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.slice(0, 10) || dash;
}

export function fmtDateTime(v: unknown, dash = "-"): string {
  if (v === null || v === undefined || v === "") return dash;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return dash;
  return d.toLocaleString("zh-CN", { hour12: false });
}

export const numOrNull = (s: unknown): number | null => {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
};

export const strOrNull = (s: unknown): string | null => {
  if (s === null || s === undefined) return null;
  const str = String(s).trim();
  return str === "" ? null : str;
};
