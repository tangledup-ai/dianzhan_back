// ── 公司主体分摊公共口径（合同页 / 主体页共用）──

// 每块电表的计费柜数：max(1, 实际柜子记录数)。
// 第三方平台同步/未录柜子的电表按 1 柜计；手动添加 N 台柜按 N 计
// （与后端 GREATEST(1, cab_cnt) 同口径）
export function cabinetCounter(cabinets: { meterId: number }[]): (meterId: number) => number {
  const count = new Map<number, number>();
  for (const cab of cabinets) {
    count.set(cab.meterId, (count.get(cab.meterId) || 0) + 1);
  }
  return (meterId: number) => Math.max(1, count.get(meterId) || 0);
}

export type Alloc = { entityId: number; ratio: number };

// ── 共享电表（场地总表）柜数：场地内各品牌没有自己的电表，「数电表」数不到它们的柜数 ──
// 柜数只能取分摊行人工录入值（meter_shared_allocations.cabinet_count，按月）。
// 与后端 contract_repo / dividend_calc / shared_allocation_repo 同口径：
//   managedByAlloc=true  该表已按品牌录柜数 → 用 brandCabs，整表读数式的计数必须停用（否则双算）
//   managedByAlloc=false 完全没录过 → 退回「整表 max(1, 柜子数)」= fallbackCabs，归共享组
export type SharedCabItem = {
  meterId: number;
  landlordId?: number | null;
  entityId: number | null;
  managedByAlloc: boolean;
  brandCabs: Record<string, number>;
  brandEntity: Record<string, number>;
  fallbackCabs: number;
};

export function buildSharedCabIndex(items: any[] | undefined): Map<number, SharedCabItem[]> {
  const out = new Map<number, SharedCabItem[]>();
  for (const it of items ?? []) {
    if (it?.landlordId == null) continue;
    const arr = out.get(it.landlordId) ?? [];
    arr.push(it as SharedCabItem);
    out.set(it.landlordId, arr);
  }
  return out;
}

export const sumObj = (o: Record<string, number> | undefined): number =>
  Object.values(o ?? {}).reduce((s: number, v: any) => s + Number(v || 0), 0);

/** 共享表按品牌录入的柜数：brandId=null 表示「全品牌/共享组」→ 各品牌录入值之和。
 *  未录柜数的共享表不在这里统计（由「整表 max(1,柜数)」口径覆盖），避免双算。 */
export function sharedCabsOf(items: SharedCabItem[] | undefined, brandId: number | null): number {
  let n = 0;
  for (const it of items ?? []) {
    if (!it.managedByAlloc) continue;
    n += brandId == null ? sumObj(it.brandCabs) : Number(it.brandCabs?.[String(brandId)] || 0);
  }
  return n;
}

/** 已按品牌录柜数的共享表 id：这些表不能再按「整表 max(1,柜数)」计数 */
export function allocManagedMeterIds(items: SharedCabItem[] | undefined): Set<number> {
  const s = new Set<number>();
  for (const it of items ?? []) if (it.managedByAlloc) s.add(it.meterId);
  return s;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// 合同金额按主体分片：每片舍入到分，尾差（其余主体按比例舍入后的差额）归占比最大的主体，
// 保证各片之和恒等于总额
export function splitByAllocs(amount: number, allocs: Alloc[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!allocs || allocs.length === 0) return out;
  const total = round2(amount);
  if (allocs.length === 1) {
    out.set(allocs[0].entityId, total);
    return out;
  }
  const biggest = allocs.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  let rest = total;
  for (const a of allocs) {
    if (a.entityId === biggest.entityId) continue;
    const share = round2(amount * a.ratio);
    out.set(a.entityId, share);
    rest = round2(rest - share);
  }
  out.set(biggest.entityId, rest);
  return out;
}
