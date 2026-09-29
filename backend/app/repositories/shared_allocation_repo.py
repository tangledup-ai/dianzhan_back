"""共享电表品牌分摊仓储（「所有品牌共用此电表」按品牌录入应付电费）

表：meter_shared_allocations（电表 × 月份 × 品牌 一行）
- collect_amount = 品牌方付给我方的电费（收款/收入，含税）
- unit_price     = 倒推用电量用的单价；NULL = 生成台账时取该品牌方合同单价
- 用电量 kwh     = collect_amount ÷ unit_price（不落库，生成台账/分红时实时算）
"""
from ..infra.database import get_connection, get_dict_cursor


# ══════════════════════════════════════════════════════════════
# ★V5：共享表的「品牌绑定清单」（meter_shared_brand_bindings）
# 语义：这块共享表由哪几个品牌共享。动态月度 + 默认继承上月 + 变动当月生效。
#   start_period = 从哪个月起算；end_period 为空 = 仍有效（=> 自动沿袭上月，历史可复现）
# 用途：① 录入分摊时**知道该填哪几个品牌**；② **已绑定但某月漏录 ⇒ 告警**（不自动补）
# ══════════════════════════════════════════════════════════════

def bind_brands(cur, meter_id: int, month_period: str, brand_ids: list) -> int:
    """把品牌绑定到该表（幂等：已存在同 (表,品牌,起始月) 就跳过）。调用方负责 commit。"""
    n = 0
    for bid in brand_ids or []:
        if not bid:
            continue
        cur.execute(
            """
            INSERT INTO meter_shared_brand_bindings (meter_id, brand_id, start_period, data_source)
            VALUES (%s, %s, %s, 'manual')
            ON CONFLICT (meter_id, brand_id, start_period) DO NOTHING
            """,
            (meter_id, int(bid), month_period),
        )
        n += cur.rowcount or 0
    return n


def bound_brands(meter_id: int, month_period: str) -> list:
    """该表在 month_period 这个月**有效**的绑定品牌（start<=月 且 (end 为空或 end>=月)）。"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            """
            SELECT b.brand_id, b.start_period, b.end_period, br.name AS brand_name
            FROM meter_shared_brand_bindings b
            LEFT JOIN brands br ON br.id = b.brand_id
            WHERE b.meter_id = %s
              AND b.start_period <= %s
              AND (b.end_period IS NULL OR b.end_period >= %s)
            ORDER BY b.brand_id
            """,
            (meter_id, month_period, month_period),
        )
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def list_allocations(address: str = None, month_period: str = None, brand_id: int = None):
    """按条件查分摊行（带品牌名），供录入表单回填与核对展示"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if address:
            conditions.append("a.address = %s"); values.append(address)
        if month_period:
            conditions.append("a.month_period = %s"); values.append(month_period)
        if brand_id:
            conditions.append("a.brand_id = %s"); values.append(brand_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT a.*, b.name AS brand_name, ent.name AS entity_name
            FROM meter_shared_allocations a
            LEFT JOIN brands b ON a.brand_id = b.id
            LEFT JOIN entities ent ON a.entity_id = ent.id
            {where}
            ORDER BY b.name, a.brand_id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def list_allocations_by_period(month_period: str) -> dict:
    """取某月**有应收电费**的分摊行，按电表号分组：{address: [row, ...]}

    供台账生成一次查询使用（避免逐表查询）。

    ★只取 collect_amount 非空的行：分摊行现在允许「只录柜数/主体、不录应收电费」
      （共享表的柜数独立于电费，见 save_shared_allocations）。这类行**不参与电费拆分**，
      否则会为它生成一条 0 元的电费台账行；其柜数由 shared_meter_cabinets 单独取。
      未录金额的月份照旧回退「整表读数 × 合同单价」口径。
    """
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT a.address, a.brand_id, a.entity_id, a.collect_amount, a.unit_price, a.remark,
                   b.name AS brand_name
            FROM meter_shared_allocations a
            LEFT JOIN brands b ON a.brand_id = b.id
            WHERE a.month_period = %s AND a.collect_amount IS NOT NULL
            ORDER BY a.address, a.brand_id
        """, (month_period,))
        out = {}
        for r in cur.fetchall():
            out.setdefault(r["address"], []).append(r)
        return out
    finally:
        cur.close()
        conn.close()


def replace_allocations(address: str, month_period: str, rows: list) -> int:
    """整体替换某电表某月的品牌分摊行（删除后重建，空列表 = 清空该月分摊）。

    rows: [{brandId, entityId, collectAmount, unitPrice, cabinetCount, remark}]
    返回写入行数。
    """
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "DELETE FROM meter_shared_allocations WHERE address = %s AND month_period = %s",
            (address, month_period),
        )
        cur.execute(
            """
            SELECT id FROM meters
            WHERE meter_no = %s OR device_address = %s
            ORDER BY (meter_no = %s) DESC NULLS LAST, id
            LIMIT 1
            """,
            (address, address, address),
        )
        meter = cur.fetchone()
        meter_id = meter["id"] if meter else None
        if meter_id is None and rows:
            raise ValueError(f"电表 {address} 不存在，无法保存品牌分摊")

        for r in rows:
            cur.execute("""
                INSERT INTO meter_shared_allocations
                (meter_id, address, month_period, brand_id, entity_id, collect_amount, unit_price, cabinet_count, remark)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                meter_id, address, month_period, r["brandId"], r.get("entityId"),
                r["collectAmount"], r.get("unitPrice"), r.get("cabinetCount"), r.get("remark"),
            ))
        if meter_id is not None:
            # ★V5：录入分摊 = 顺带把「这个品牌从这个月起算在这块共享表上」，写入品牌绑定清单。
            #   这样财务不需要单独维护一份绑定表；绑定清单只增不减（默认继承上月），
            #   下次录入时系统就能告诉财务「这个月该填哪几个品牌、漏了谁」。
            bind_brands(cur, meter_id, month_period, [r["brandId"] for r in rows if r.get("brandId")])
        conn.commit()
        return len(rows)
    finally:
        cur.close()
        conn.close()


def delete_allocations(address: str, month_period: str = None) -> int:
    """删除某电表（可选限定月份）的全部分摊行"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        if month_period:
            cur.execute(
                "DELETE FROM meter_shared_allocations WHERE address = %s AND month_period = %s",
                (address, month_period),
            )
        else:
            cur.execute("DELETE FROM meter_shared_allocations WHERE address = %s", (address,))
        conn.commit()
        return cur.rowcount
    finally:
        cur.close()
        conn.close()


def latest_cabinet_counts(address: str, before_period: str = None) -> dict:
    """该电表各品牌「最近一次填过的电柜数量」：{brand_id: {count, monthPeriod}}

    用于录入表单预填：柜数逐月可动态调整，某月留空时默认沿用最近一次填写值；
    某月调整后，其后月份的默认值随之变为新值。
    - 优先取 `before_period`（不含）之前最近一条 —— 「历史沿用」语义；
    - 该品牌在目标月份之前从未填过时，回退到全表最近一条（向后兜底），避免留空。
    """
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        out = {}
        cur.execute("""
            SELECT DISTINCT ON (brand_id) brand_id, cabinet_count, month_period
            FROM meter_shared_allocations
            WHERE address = %s AND cabinet_count IS NOT NULL
            ORDER BY brand_id, month_period DESC
        """, (address,))
        for r in cur.fetchall():
            out[int(r["brand_id"])] = {"count": r["cabinet_count"], "monthPeriod": r["month_period"]}

        if before_period:
            cur.execute("""
                SELECT DISTINCT ON (brand_id) brand_id, cabinet_count, month_period
                FROM meter_shared_allocations
                WHERE address = %s AND cabinet_count IS NOT NULL AND month_period < %s
                ORDER BY brand_id, month_period DESC
            """, (address, before_period))
            for r in cur.fetchall():
                out[int(r["brand_id"])] = {"count": r["cabinet_count"], "monthPeriod": r["month_period"]}
        return out
    finally:
        cur.close()
        conn.close()


def list_periods_for_meter(address: str) -> list:
    """该电表已录入分摊的月份列表（供录入表单高亮）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "SELECT DISTINCT month_period FROM meter_shared_allocations WHERE address = %s ORDER BY month_period DESC",
            (address,),
        )
        return [r["month_period"] for r in cur.fetchall()]
    finally:
        cur.close()
        conn.close()


def _pick_cabinet(hist: list, period: str = None):
    """从 [(month_period, cabs), ...] 里按「当月 → 该月之前最近 → 全表最近」取值

    hist 需按 month_period 升序。period 为空时直接取最近一次。
    """
    if not hist:
        return None
    if not period:
        return hist[-1][1]
    exact = [c for mp, c in hist if mp == period]
    if exact:
        return exact[-1]
    before = [c for mp, c in hist if mp < period]
    return before[-1] if before else hist[-1][1]


def cabinet_records(landlord_id: int = None, address: str = None) -> dict:
    """共享电表柜数录入原始记录（未按月份取值）

    Returns:
        {address: {"landlordId": int|None, "entityId": int|None,
                   "brands": {brand_id: [(month_period, cabs), ...] 升序}}}
    """
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if landlord_id:
            conditions.append("m.landlord_id = %s"); values.append(landlord_id)
        if address:
            conditions.append("a.address = %s"); values.append(address)
        where = f"AND {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT a.address, a.brand_id, a.month_period, a.cabinet_count,
                   m.landlord_id, m.entity_id
            FROM meter_shared_allocations a
            JOIN meters m ON m.id = a.meter_id
            WHERE a.cabinet_count IS NOT NULL
              AND m.is_shared = TRUE AND m.brand_id IS NULL
              AND m.meter_no NOT LIKE 'TEST%%'
              {where}
            ORDER BY a.address, a.brand_id, a.month_period
        """, values)
        rows = cur.fetchall()
    finally:
        cur.close()
        conn.close()

    out = {}
    for r in rows:
        addr = r["address"]
        entry = out.setdefault(addr, {
            "landlordId": r.get("landlord_id"),
            "entityId": r.get("entity_id"),
            "brands": {},
        })
        entry["brands"].setdefault(int(r["brand_id"]), []).append(
            (str(r["month_period"]), int(r["cabinet_count"]))
        )
    return out


def cabinet_usage_by_month(landlord_id: int = None, periods=None) -> dict:
    """共享电表按品牌的柜数，**逐月**取值：{landlord_id: {period: {brand_id: cabs}}}

    用于 Rent 页「承担场地成本」这类需要按月分摊的场景（柜数逐月可调）。
    periods 为 None 时取各表已录入月份的并集（即只有真正有柜数的月份会出现）。
    """
    records = cabinet_records(landlord_id=landlord_id)
    if not records:
        return {}
    wanted = None
    if periods is not None:
        wanted = [str(p).replace("-", "")[:6] for p in periods]

    out = {}
    for addr, entry in records.items():
        lid = entry.get("landlordId")
        months = sorted({mp for hist in entry["brands"].values() for mp, _ in hist})
        targets = wanted if wanted is not None else months
        for period in targets:
            for bid, hist in entry["brands"].items():
                cabs = _pick_cabinet(hist, period)
                if cabs is None:
                    continue
                out.setdefault(lid, {}).setdefault(period, {})
                out[lid][period][bid] = out[lid][period].get(bid, 0) + cabs
    return out


def cabinet_usage_by_meter(landlord_id: int = None, address: str = None, period: str = None) -> dict:
    """共享电表按品牌录入的**有效**电柜数量（按月取值）。

    场地总表（tag='共享电表' 且 brand_id 为空）下各品牌没有自己的电表，
    「数电表」那套柜数统计根本数不到它们；柜数只能靠分摊行人工录入。
    本函数把这批录入值取出来，供场地成本（场地月租 / 运营费）按柜数分摊使用。

    取值优先级（逐「电表 × 品牌」判定，与录入界面的默认值语义一致）：
      1) period 当月的填写值
      2) period 之前最近一次的填写值（历史沿用）
      3) 全表最近一次的填写值（向后兜底：先把后面的月份补了也能用）
    period 为 None 时直接用 3)。

    Returns:
        {address: {"entityId": int|None, "brands": {brand_id: cabs}}}
        只包含真正取到柜数的「表 × 品牌」。整块表不在返回值里 = 该表没录过柜数（调用方需兜底）；
        entityId 是共享表自身的主体，供品牌无法从合同判定主体时兜底。
    """
    records = cabinet_records(landlord_id=landlord_id, address=address)
    out = {}
    for addr, rec in records.items():
        for bid, hist in rec["brands"].items():
            chosen = _pick_cabinet(hist, period)
            if chosen is None:
                continue
            entry = out.setdefault(addr, {"entityId": rec.get("entityId"), "brands": {}})
            entry["brands"][bid] = int(chosen)
    return out


def cabinet_totals_by_brand(landlord_id: int = None, period: str = None) -> dict:
    """场地内共享电表按品牌汇总的电柜数量：{brand_id: cabs}（按月取值，见上面口径）"""
    out = {}
    for _addr, entry in cabinet_usage_by_meter(landlord_id=landlord_id, period=period).items():
        for bid, cabs in (entry.get("brands") or {}).items():
            out[bid] = out.get(bid, 0) + cabs
    return out


def shared_meter_cabinets(landlord_id: int = None, period: str = None) -> list:
    """共享电表（tag='共享电表' 且无品牌）的柜数明细，供「合同页/分红」按场地取柜数。

    每块表返回一行：
      - managedByAlloc=True  → 该表已按品牌录入柜数，`brandCabs={brand_id: cabs}`（按月取值）；
        `fallbackCabs` 此时无意义（调用方不得再用整表读数式计数，否则与品牌柜数双算）。
      - managedByAlloc=False → 完全没录过柜数，只能退回「整表至少 1 柜」= `fallbackCabs`。
      - `brandEntity={brand_id: entity_id}`：分摊行人工指定的报税主体（未指定则不在字典里）。

    口径与 `cabinet_usage_by_meter` / `cabinet_records` 完全一致（同一 `_pick_cabinet`）。
    """
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [
            "m.is_shared = TRUE", "m.brand_id IS NULL",
            "m.landlord_id IS NOT NULL", "m.meter_no NOT LIKE 'TEST%%'",
        ], []
        if landlord_id:
            conditions.append("m.landlord_id = %s"); values.append(landlord_id)
        cur.execute(f"""
            SELECT m.id, m.meter_no, m.landlord_id, m.entity_id,
                   GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id)) AS fallback_cabs
            FROM meters m
            WHERE {' AND '.join(conditions)}
            ORDER BY m.id
        """, values)
        meters = cur.fetchall()

        ac, av = ["a.cabinet_count IS NOT NULL"], []
        if landlord_id:
            ac.append("m2.landlord_id = %s"); av.append(landlord_id)
        cur.execute(f"""
            SELECT a.address, a.brand_id, a.month_period, a.cabinet_count, a.entity_id
            FROM meter_shared_allocations a
            JOIN meters m2 ON m2.id = a.meter_id
            WHERE m2.is_shared = TRUE AND m2.brand_id IS NULL
              AND m2.meter_no NOT LIKE 'TEST%%'
              AND {' AND '.join(ac)}
            ORDER BY a.address, a.brand_id, a.month_period
        """, av)
        alloc_rows = cur.fetchall()
    finally:
        cur.close()
        conn.close()

    hist, entity_by_brand = {}, {}
    for r in alloc_rows:
        addr = r["address"]
        hist.setdefault(addr, {}).setdefault(int(r["brand_id"]), []).append(
            (str(r["month_period"]), int(r["cabinet_count"]))
        )
        if r.get("entity_id") is not None:
            entity_by_brand.setdefault(addr, {})[int(r["brand_id"])] = r["entity_id"]

    out = []
    for m in meters:
        addr = m["meter_no"]
        brand_cabs = {}
        for bid, h in (hist.get(addr) or {}).items():
            chosen = _pick_cabinet(h, period)
            if chosen is not None:
                brand_cabs[bid] = int(chosen)
        out.append({
            "meterId": m["id"],
            "meterNo": addr,
            "landlordId": m.get("landlord_id"),
            "entityId": m.get("entity_id"),
            "managedByAlloc": bool(brand_cabs),
            "brandCabs": brand_cabs,
            "brandEntity": entity_by_brand.get(addr) or {},
            "fallbackCabs": int(m.get("fallback_cabs") or 1),
        })
    return out


def cabinet_entity_by_brand(landlord_id: int = None, period: str = None) -> dict:
    """共享电表分摊行人工指定的报税主体：{landlord_id: {brand_id: entity_id}}

    未指定主体的分摊行不出现（调用方按「品牌方合同主体 → 共享表自身主体」兜底）。
    """
    out = {}
    for item in shared_meter_cabinets(landlord_id=landlord_id, period=period):
        lid = item.get("landlordId")
        for bid, eid in (item.get("brandEntity") or {}).items():
            out.setdefault(lid, {})[bid] = eid
    return out
