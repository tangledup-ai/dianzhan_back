from ..infra.database import get_connection, get_dict_cursor


# ─── 运营费用（v3：挂 landlord_id）──────────────────────────

def list_expenses(station_id: int = None, landlord_id: int = None, period: str = None):
    """v3：按 场地/月份 过滤（station_id 参数保留签名兼容，列已删除忽略）"""
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
            SELECT o.*, l.name as landlord_name
            FROM operating_expenses o
            LEFT JOIN landlords l ON o.landlord_id = l.id
            {where}
            ORDER BY o.period DESC, o.landlord_id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def get_expense_by_landlord(landlord_id: int, period: str):
    """v3：按场地查运营费用（operating_expenses.landlord_id；period 统一 6 位）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "SELECT * FROM operating_expenses WHERE landlord_id = %s AND period = %s",
            (landlord_id, str(period).replace("-", ""))
        )
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def save_expense(landlord_id: int = None, period: str = None, amount: float = None, remark: str = None):
    """v3：运营费用挂场地（landlord_id）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO operating_expenses (landlord_id, period, amount, remark)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (landlord_id, period)
            DO UPDATE SET amount = EXCLUDED.amount, remark = EXCLUDED.remark, updated_at = NOW()
            RETURNING *
        """, (landlord_id, period, amount, remark))
        conn.commit()
        return cur.fetchone()
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
