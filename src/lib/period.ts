// period 统一格式化：全系统用 6 位 YYYYMM（与后端 meter_monthly.month_period 一致）

/** '2026-08' → '202608'；已是 '202608' 则原样返回 */
export function toCompact(period: string | null | undefined): string {
  if (!period) return "";
  return String(period).replace(/-/g, "");
}

/** '202608' → '2026-08'；已是 '2026-08' 则原样返回 */
export function toDisplay(period: string | null | undefined): string {
  if (!period) return "";
  if (period.includes("-")) return period;
  if (period.length === 6) return `${period.slice(0, 4)}-${period.slice(4)}`;
  return period;
}
