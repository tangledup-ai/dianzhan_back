"""★V5 柜数月度快照（cabinet_monthly_snapshot）

口径（用户 2026-09 确认）：
- 柜数【只影响「场地费平摊成本」这一个值】；
- **加柜本月生效**（本月平摊成本立刻变小）、**减柜下月生效**（本月不变）、同月"加了又退"仍按加了算
  ⇒ 统一规则：柜子的 [installed_at, removed_at] 与当月区间【相交】即计入
  （installed_at 为空 = 一直在；removed_at 为空 = 还没退）；
- 分母 = 所有有品牌归属的柜子（含共用表按品牌人工录入的柜数）；**无品牌归属的柜子不算**；
- 历史柜子没有进/离场日期（迁移而来）⇒ 一律按"长期存在"计入；
- 柜数逐月可调、默认继承上月（共用表分摊行的人工录入值由 latest_cabinet_counts 兜底沿袭）。

写入规则：source='auto' 的行每次刷新重建；source='manual'（人工改过）的行**不覆盖**。
"""
from datetime import date
from ..infra.database import get_connection, get_dict_cursor


def _month_bounds(period: str):
    y, m = int(period[:4]), int(period[4:6])
    start = date(y, m, 1)
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    end = date(ny, nm, 1)  # 当月最后一天 = 下月第一天 - 1，用半开区间比较即可
    return start, end


def refresh_cabinet_snapshots(period: str) -> int:
    """重算某月的柜数快照（source='auto' 的行；manual 行保留）。返回写入行数。"""
    period = str(period).replace("-", "")
    if len(period) != 6:
        return 0
    m_start, m_end = _month_bounds(period)
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 1) 清掉本月的 auto 行（manual 行保留）
        cur.execute(
            "DELETE FROM cabinet_monthly_snapshot WHERE period = %s AND source = 'auto'",
            (period,),
        )

        # 2) 普通电表：柜子按「品牌归属」（cabinets.brand_id 优先，回退电表品牌）计数。
        #    相交规则：installed_at < m_end AND (removed_at IS NULL OR removed_at >= m_start)
        cur.execute("""
            INSERT INTO cabinet_monthly_snapshot
                (period, landlord_id, meter_id, brand_id, cabinet_count, source)
            SELECT %s, m.landlord_id, m.id,
                   COALESCE(cab.brand_id, m.brand_id) AS brand_id,
                   COUNT(*)::int, 'auto'
            FROM cabinets cab
            JOIN meters m ON m.id = cab.meter_id
            WHERE m.landlord_id IS NOT NULL
              AND m.meter_no NOT LIKE 'TEST%%'
              AND (cab.installed_at IS NULL OR cab.installed_at < %s)
              AND (cab.removed_at IS NULL OR cab.removed_at >= %s)
              AND COALESCE(cab.brand_id, m.brand_id) IS NOT NULL   -- 无品牌归属的柜子不进分母
            GROUP BY m.landlord_id, m.id, COALESCE(cab.brand_id, m.brand_id)
        """, (period, m_end, m_start))
        n = cur.rowcount or 0

        # 3) 共用表（所有品牌共用一个电表）：柜数取分摊行人工录入值（该月没填则沿用最近一次）
        from ..repositories import shared_allocation_repo
        cur.execute("""
            SELECT m.id, m.meter_no, m.landlord_id FROM meters m
            WHERE m.is_shared = TRUE AND m.landlord_id IS NOT NULL
              AND m.meter_no NOT LIKE 'TEST%%'
        """)
        shared = cur.fetchall()
        for sm in shared:
            latest = shared_allocation_repo.latest_cabinet_counts(sm["meter_no"], before_period=period)
            # 该月实际录入的分摊行（当月填了用当月）
            cur.execute("""
                SELECT brand_id, cabinet_count FROM meter_shared_allocations
                WHERE meter_id = %s AND month_period = %s AND cabinet_count IS NOT NULL
            """, (sm["id"], period))
            for r in cur.fetchall():
                latest[int(r["brand_id"])] = {"count": int(r["cabinet_count"]), "monthPeriod": period}
            for bid, info in latest.items():
                cnt = int(info.get("count") or 0)
                if cnt <= 0:
                    continue
                cur.execute("""
                    INSERT INTO cabinet_monthly_snapshot
                        (period, landlord_id, meter_id, brand_id, cabinet_count, source)
                    VALUES (%s, %s, %s, %s, %s, 'auto')
                    ON CONFLICT (period, meter_id, COALESCE(brand_id, 0)) DO UPDATE
                        SET cabinet_count = EXCLUDED.cabinet_count
                """, (period, sm["landlord_id"], sm["id"], bid, cnt))
                n += 1
        conn.commit()
        return n
    finally:
        cur.close()
        conn.close()


def snapshot_cabinet_totals(period: str) -> dict:
    """某月「场地 → 品牌 → 柜数」的快照读数：{landlord_id: {brand_id: count}}。

    无快照行（该月从未生成）⇒ 返回空 dict，调用方自行回退实时口径。
    """
    period = str(period).replace("-", "")
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT landlord_id, brand_id, SUM(cabinet_count) AS cabs
            FROM cabinet_monthly_snapshot
            WHERE period = %s
            GROUP BY landlord_id, brand_id
        """, (period,))
        out: dict = {}
        for r in cur.fetchall():
            out.setdefault(r["landlord_id"], {})[r["brand_id"]] = float(r["cabs"] or 0)
        return out
    finally:
        cur.close()
        conn.close()
