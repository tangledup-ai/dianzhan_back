from ..infra.database import get_connection, get_dict_cursor


# ─── 分红配置 ───────────────────────────────────────────────

def list_shareholder_configs(landlord_id: int = None, brand_id: int = None):
    """v3：查 landlord_shareholder_configs（场地级分红配置）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if landlord_id:
            conditions.append("c.landlord_id = %s"); values.append(landlord_id)
        if brand_id:
            conditions.append("c.brand_id = %s"); values.append(brand_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT c.*, sh.name as shareholder_name, l.name as landlord_name,
                   b.name as brand_name
            FROM landlord_shareholder_configs c
            LEFT JOIN shareholders sh ON c.shareholder_id = sh.id
            LEFT JOIN landlords l ON c.landlord_id = l.id
            LEFT JOIN brands b ON c.brand_id = b.id
            {where}
            ORDER BY c.id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def save_shareholder_config(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        brand_id = data.get("brandId")
        landlord_id = data.get("landlordId")
        shareholder_id = data.get("shareholderId")
        # v3：按 (场地, 股东, 品牌, 生效期) 匹配；start_date 为空视为 1970-01-01
        cur.execute("""
            SELECT id FROM landlord_shareholder_configs
            WHERE landlord_id = %s AND shareholder_id = %s
              AND COALESCE(brand_id, 0) = COALESCE(%s, 0)
              AND COALESCE(start_date, DATE '1970-01-01') = COALESCE(%s::date, DATE '1970-01-01')
        """, (landlord_id, shareholder_id, brand_id, data.get("startDate")))
        existing = cur.fetchone()

        fields = (
            data.get("mode"), data.get("ratio"),
            data.get("fixedAmount"), data.get("settlementPeriod", "月"),
            data.get("startDate"), data.get("endDate"),
            data.get("remark")
        )
        if existing:
            cur.execute("""
                UPDATE landlord_shareholder_configs SET
                    mode = %s, ratio = %s, fixed_amount = %s,
                    settlement_period = %s, start_date = %s, end_date = %s,
                    remark = %s
                WHERE id = %s
                RETURNING *
            """, (*fields, existing["id"]))
        else:
            cur.execute("""
                INSERT INTO landlord_shareholder_configs
                (landlord_id, shareholder_id, brand_id, mode, ratio, fixed_amount, settlement_period, start_date, end_date, remark)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
            """, (landlord_id, shareholder_id, brand_id, *fields))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_shareholder_config(config_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM landlord_shareholder_configs WHERE id = %s", (config_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def list_introducer_configs(landlord_id: int = None, brand_id: int = None):
    """v3：查 landlord_introducer_configs（场地级商务分红配置）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if landlord_id:
            conditions.append("c.landlord_id = %s"); values.append(landlord_id)
        if brand_id:
            conditions.append("c.brand_id = %s"); values.append(brand_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT c.*, i.name as introducer_name, l.name as landlord_name,
                   b.name as brand_name
            FROM landlord_introducer_configs c
            LEFT JOIN introducers i ON c.introducer_id = i.id
            LEFT JOIN landlords l ON c.landlord_id = l.id
            LEFT JOIN brands b ON c.brand_id = b.id
            {where}
            ORDER BY c.id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def save_introducer_config(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        brand_id = data.get("brandId")
        landlord_id = data.get("landlordId")
        introducer_id = data.get("introducerId")
        # v3：按 (场地, 介绍人, 品牌, 生效期) 匹配；start_date 为空视为 1970-01-01
        cur.execute("""
            SELECT id FROM landlord_introducer_configs
            WHERE landlord_id = %s AND introducer_id = %s
              AND COALESCE(brand_id, 0) = COALESCE(%s, 0)
              AND COALESCE(start_date, DATE '1970-01-01') = COALESCE(%s::date, DATE '1970-01-01')
        """, (landlord_id, introducer_id, brand_id, data.get("startDate")))
        existing = cur.fetchone()

        fields = (
            data.get("mode"), data.get("ratio"),
            data.get("fixedAmount"), data.get("settlementPeriod", "月"),
            data.get("countAsCost", False),
            data.get("startDate"), data.get("endDate"),
            data.get("remark")
        )
        if existing:
            cur.execute("""
                UPDATE landlord_introducer_configs SET
                    mode = %s, ratio = %s, fixed_amount = %s,
                    settlement_period = %s, count_as_cost = %s,
                    start_date = %s, end_date = %s, remark = %s
                WHERE id = %s
                RETURNING *
            """, (*fields, existing["id"]))
        else:
            cur.execute("""
                INSERT INTO landlord_introducer_configs
                (landlord_id, introducer_id, brand_id, mode, ratio, fixed_amount, settlement_period, count_as_cost, start_date, end_date, remark)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
            """, (landlord_id, introducer_id, brand_id, *fields))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_introducer_config(config_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM landlord_introducer_configs WHERE id = %s", (config_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


# ─── 分红记录 ───────────────────────────────────────────────

def list_records(station_id: int = None, period: str = None, type_: str = None, status: str = None,
                 landlord_id: int = None, brand_id: int = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        # v3：以 landlord_id/brand_id 为维度过滤（station_id 参数保留签名兼容，列已删除忽略）
        if landlord_id:
            conditions.append("d.landlord_id = %s"); values.append(landlord_id)
        if brand_id:
            conditions.append("d.brand_id = %s"); values.append(brand_id)
        if period:
            conditions.append("d.period = %s"); values.append(period)
        if type_:
            conditions.append("d.type = %s"); values.append(type_)
        if status:
            conditions.append("d.status = %s"); values.append(status)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT d.*, l.name as landlord_name, b.name as brand_name
            FROM dividend_records d
            LEFT JOIN landlords l ON d.landlord_id = l.id
            LEFT JOIN brands b ON d.brand_id = b.id
            {where}
            ORDER BY d.period DESC, d.landlord_id NULLS LAST, d.brand_id NULLS LAST
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def get_record(record_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT d.*, l.name as landlord_name, b.name as brand_name
            FROM dividend_records d
            LEFT JOIN landlords l ON d.landlord_id = l.id
            LEFT JOIN brands b ON d.brand_id = b.id
            WHERE d.id = %s
        """, (record_id,))
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def get_shares(dividend_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT ds.*, sh.name as shareholder_name, i.name as introducer_name,
                   b.name as brand_name
            FROM dividend_shares ds
            LEFT JOIN shareholders sh ON ds.shareholder_id = sh.id
            LEFT JOIN introducers i ON ds.introducer_id = i.id
            LEFT JOIN brands b ON ds.brand_id = b.id
            WHERE ds.dividend_id = %s
        """, (dividend_id,))
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_record(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cols = ["period", "type", "elec_income", "rent_income", "total_income",
                "elec_cost", "rent_cost", "op_expense", "biz_dividend_cost", "total_cost",
                "profit", "status", "settlement_date", "remark"]
        vals = [
            data.get("period"), data.get("type"),
            data.get("elecIncome"), data.get("rentIncome"), data.get("totalIncome"),
            data.get("elecCost"), data.get("rentCost"), data.get("opExpense"),
            data.get("bizDividendCost"), data.get("totalCost"),
            data.get("profit"), data.get("status", "未结算"),
            data.get("settlementDate"), data.get("remark")
        ]
        # v3：写入 landlord_id/brand_id（stationId 兼容忽略，列已删除）
        if data.get("landlordId") is not None:
            cols.append("landlord_id"); vals.append(data.get("landlordId"))
        if data.get("brandId") is not None:
            cols.append("brand_id"); vals.append(data.get("brandId"))
        col_sql = ", ".join(cols)
        placeholders = ", ".join(["%s"] * len(cols))
        cur.execute(f"""
            INSERT INTO dividend_records
            ({col_sql})
            VALUES ({placeholders})
            RETURNING *
        """, vals)
        record = cur.fetchone()
        conn.commit()
        return record
    finally:
        cur.close()
        conn.close()


def create_share(dividend_id: int, data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO dividend_shares
            (dividend_id, introducer_id, shareholder_id, brand_id, mode, ratio, fixed_amount, amount, remark)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            dividend_id,
            data.get("introducerId"), data.get("shareholderId"), data.get("brandId"),
            data.get("mode"), data.get("ratio"),
            data.get("fixedAmount"), data.get("amount"), data.get("remark")
        ))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_status(record_id: int, status: str):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE dividend_records SET status = %s, updated_at = NOW() WHERE id = %s",
            (status, record_id)
        )
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def update_record(record_id: int, data: dict):
    """更新分红记录的财务数据"""
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            UPDATE dividend_records SET
                elec_income = %s, rent_income = %s, total_income = %s,
                elec_cost = %s, rent_cost = %s, op_expense = %s,
                biz_dividend_cost = %s, total_cost = %s, profit = %s,
                updated_at = NOW()
            WHERE id = %s
        """, (
            data.get("elecIncome"), data.get("rentIncome"), data.get("totalIncome"),
            data.get("elecCost"), data.get("rentCost"), data.get("opExpense"),
            data.get("bizDividendCost"), data.get("totalCost"), data.get("profit"),
            record_id
        ))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def delete_shares(record_id: int):
    """删除分红记录的所有分红明细"""
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM dividend_shares WHERE dividend_id = %s", (record_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def delete_record(record_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM dividend_shares WHERE dividend_id = %s", (record_id,))
        cur.execute("DELETE FROM dividend_records WHERE id = %s", (record_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def get_shareholder_summary(shareholder_id: int = None, period: str = None, period_start: str = None, period_end: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions = ["ds.shareholder_id IS NOT NULL"]
        values = []
        if shareholder_id:
            conditions.append("ds.shareholder_id = %s"); values.append(shareholder_id)
        # 范围过滤：period_start/period_end 优先；无范围时兼容单月 period
        if period_start and period_end:
            conditions.append("d.period >= %s AND d.period <= %s")
            values.extend([period_start, period_end])
        elif period:
            conditions.append("d.period = %s"); values.append(period)
        where = f"WHERE {' AND '.join(conditions)}"
        cur.execute(f"""
            SELECT ds.shareholder_id, sh.name as shareholder_name, d.period,
                   d.landlord_id, l.name as landlord_name, d.type, d.status, d.settlement_date,
                   ds.brand_id, b.name as brand_name,
                   ds.mode, ds.ratio, ds.fixed_amount, ds.amount
            FROM dividend_shares ds
            JOIN dividend_records d ON ds.dividend_id = d.id
            LEFT JOIN shareholders sh ON ds.shareholder_id = sh.id
            LEFT JOIN landlords l ON d.landlord_id = l.id
            LEFT JOIN brands b ON ds.brand_id = b.id
            {where}
            ORDER BY d.period DESC, d.landlord_id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def get_introducer_summary(introducer_id: int = None, period: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions = ["ds.introducer_id IS NOT NULL"]
        values = []
        if introducer_id:
            conditions.append("ds.introducer_id = %s"); values.append(introducer_id)
        if period:
            conditions.append("d.period = %s"); values.append(period)
        where = f"WHERE {' AND '.join(conditions)}"
        cur.execute(f"""
            SELECT ds.introducer_id, i.name as introducer_name, d.period,
                   d.landlord_id, l.name as landlord_name, d.type, d.status,
                   ds.brand_id, b.name as brand_name,
                   ds.mode, ds.ratio, ds.fixed_amount, ds.amount
            FROM dividend_shares ds
            JOIN dividend_records d ON ds.dividend_id = d.id
            LEFT JOIN introducers i ON ds.introducer_id = i.id
            LEFT JOIN landlords l ON d.landlord_id = l.id
            LEFT JOIN brands b ON ds.brand_id = b.id
            {where}
            ORDER BY d.period DESC, d.landlord_id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()
