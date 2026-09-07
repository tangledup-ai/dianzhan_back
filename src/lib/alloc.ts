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
