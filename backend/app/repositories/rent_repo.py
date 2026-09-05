from ..infra.database import get_connection, get_dict_cursor


# ─── 运营费用（v3：挂 landlord_id）──────────────────────────

def list_expenses(station_id: int = None, landlord_id: int = None, period: str = None):
    """v3.2：按 场地/月份 过滤（station_id 参数保留签名兼容，列已删除忽略）；含主体归属"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if landlord_id:
            conditions.append("o.landlord_id = %s"); values.append(landlord_id)
        if period:
            conditions.append("o.period = %s"); values.append(period)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT o.*, l.name as landlord_name, ent.name as entity_name
            FROM operating_expenses o
            LEFT JOIN landlords l ON o.landlord_id = l.id
            LEFT JOIN entities ent ON o.entity_id = ent.id
            {where}
            ORDER BY o.period DESC, o.landlord_id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def get_expense_by_landlord(landlord_id: int, period: str):
    """v3.2：按场地查该月运营费用**合计**（公共 + 各主体专属全部计入，分红口径不变）。

    Returns:
        {"landlord_id", "period", "amount": 合计, "remark": 备注并集, "details": 各主体明细行}
        无记录时返回 None（调用方兼容）。
    """
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT o.*, ent.name as entity_name
            FROM operating_expenses o
            LEFT JOIN entities ent ON o.entity_id = ent.id
            WHERE o.landlord_id = %s AND o.period = %s
            ORDER BY o.entity_id NULLS FIRST
        """, (landlord_id, str(period).replace("-", "")))
        rows = cur.fetchall()
    finally:
        cur.close()
        conn.close()
    if not rows:
        return None
    total = round(sum(float(r.get("amount") or 0) for r in rows), 2)
    remarks = [r["remark"] for r in rows if r.get("remark")]
    return {
        "landlord_id": landlord_id,
        "period": str(period).replace("-", ""),
        "amount": total,
        "remark": "；".join(remarks) if remarks else None,
        "details": rows,
    }


def save_expense(landlord_id: int = None, period: str = None, amount: float = None,
                 remark: str = None, entity_id=None):
    """v3.2：运营费用挂 场地×主体（entity_id=None=场地公共）。

    按 (场地, 月, 主体) upsert：同一主体同月重复保存为更新，公共与各主体专属可并存。
    """
    period = str(period or "").replace("-", "")
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        if entity_id is None:
            cur.execute(
                "SELECT id FROM operating_expenses WHERE landlord_id = %s AND period = %s AND entity_id IS NULL",
                (landlord_id, period))
        else:
            cur.execute(
                "SELECT id FROM operating_expenses WHERE landlord_id = %s AND period = %s AND entity_id = %s",
                (landlord_id, period, entity_id))
        existing = cur.fetchone()
        if existing:
            cur.execute(
                "UPDATE operating_expenses SET amount = %s, remark = %s, updated_at = NOW() WHERE id = %s RETURNING *",
                (amount, remark, existing["id"]))
        else:
            cur.execute(
                "INSERT INTO operating_expenses (landlord_id, entity_id, period, amount, remark) VALUES (%s, %s, %s, %s, %s) RETURNING *",
                (landlord_id, entity_id, period, amount, remark))
        row = cur.fetchone()
        conn.commit()
        return row
    finally:
        cur.close()
        conn.close()


def delete_expense(expense_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM operating_expenses WHERE id = %s", (expense_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def get_expense_by_id(expense_id: int):
    """根据ID获取运营费用"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM operating_expenses WHERE id = %s", (expense_id,))
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()
