from ..infra.database import get_connection, get_dict_cursor


def list_records(station_id: int = None, period: str = None, landlord_id: int = None, brand_id: int = None):
    """v3：支持按 场地/品牌/月份 过滤（station_id 参数保留签名兼容，列已删除忽略）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if landlord_id:
            conditions.append("e.landlord_id = %s"); values.append(landlord_id)
        if brand_id:
            conditions.append("e.brand_id = %s"); values.append(brand_id)
        if period:
            conditions.append("e.period = %s"); values.append(period)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT e.*, l.name as landlord_name, b.name as brand_name, ent.name as entity_name
            FROM electricity_records e
            LEFT JOIN landlords l ON e.landlord_id = l.id
            LEFT JOIN brands b ON e.brand_id = b.id
            LEFT JOIN entities ent ON e.entity_id = ent.id
            {where}
            ORDER BY l.name, e.period DESC, e.brand_id
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
            SELECT e.*, l.name as landlord_name, b.name as brand_name, ent.name as entity_name
            FROM electricity_records e
            LEFT JOIN landlords l ON e.landlord_id = l.id
            LEFT JOIN brands b ON e.brand_id = b.id
            LEFT JOIN entities ent ON e.entity_id = ent.id
            WHERE e.id = %s
        """, (record_id,))
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def get_record_by_station_period(station_id: int, period: str):
    """v3：station_id 列已删除，此函数保留签名但按 landlord 查询（调用方已不传 station_id）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "SELECT * FROM electricity_records WHERE period = %s AND id = -1",
            (period,)
        )
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def get_record_by_landlord_brand_period(landlord_id: int, brand_id, period: str, entity_id=None):
    """按 场地×品牌×主体×月 取台账记录（None 匹配对应列为空的共享/未指定主体记录）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions = ["landlord_id = %s", "period = %s"]
        values = [landlord_id, period]
        if brand_id is None:
            conditions.append("brand_id IS NULL")
        else:
            conditions.append("brand_id = %s"); values.append(brand_id)
        if entity_id is None:
            conditions.append("entity_id IS NULL")
        else:
            conditions.append("entity_id = %s"); values.append(entity_id)
        cur.execute(
            f"SELECT * FROM electricity_records WHERE {' AND '.join(conditions)}",
            values
        )
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def list_records_by_landlord_brand_period(landlord_id: int, brand_id, period: str):
    """按 场地×品牌×月 取全部台账行（v3.1 主体拆行：同键按主体一行，跨主体时返回多行）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        if brand_id is None:
            cur.execute(
                "SELECT * FROM electricity_records WHERE landlord_id = %s AND brand_id IS NULL AND period = %s ORDER BY entity_id NULLS FIRST",
                (landlord_id, period)
            )
        else:
            cur.execute(
                "SELECT * FROM electricity_records WHERE landlord_id = %s AND brand_id = %s AND period = %s ORDER BY entity_id NULLS FIRST",
                (landlord_id, brand_id, period)
            )
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def get_meter_details(electricity_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT d.*, m.meter_no, m.meter_name, m.brand_id, m.landlord_id, m.entity_id,
                   b.name as brand_name, ent.name as entity_name
            FROM electricity_meter_details d
            LEFT JOIN meters m ON d.meter_id = m.id
            LEFT JOIN brands b ON m.brand_id = b.id
            LEFT JOIN entities ent ON m.entity_id = ent.id
            WHERE d.electricity_id = %s
        """, (electricity_id,))
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_record(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO electricity_records
            (landlord_id, brand_id, entity_id, period, pay_start_date, pay_start_reading, pay_end_date, pay_end_reading,
             pay_kwh, pay_unit_price, pay_amount, pay_status,
             collect_start_date, collect_start_reading, collect_end_date, collect_end_reading,
             collect_kwh, collect_unit_price, collect_amount, tax_rate, collect_net, collect_status,
             profit, remark, data_source)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'manual')
            RETURNING *
        """, (
            data.get("landlordId"), data.get("brandId"), data.get("entityId"), data.get("period"),
            data.get("payStartDate"), data.get("payStartReading"),
            data.get("payEndDate"), data.get("payEndReading"),
            data.get("payKwh"), data.get("payUnitPrice"), data.get("payAmount"),
            data.get("payStatus", "未付款"),
            data.get("collectStartDate"), data.get("collectStartReading"),
            data.get("collectEndDate"), data.get("collectEndReading"),
            data.get("collectKwh"), data.get("collectUnitPrice"), data.get("collectAmount"),
            data.get("taxRate"), data.get("collectNet"),
            data.get("collectStatus", "未到账"),
            data.get("profit"), data.get("remark")
        ))
        record = cur.fetchone()
        conn.commit()
        return record
    finally:
        cur.close()
        conn.close()


def update_status(record_id: int, pay_status: str = None, collect_status: str = None):
    """仅更新付款/收款状态（不动金额与 data_source 标记）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        updates, values = [], []
        if pay_status is not None:
            updates.append("pay_status = %s"); values.append(pay_status)
        if collect_status is not None:
            updates.append("collect_status = %s"); values.append(collect_status)
        if not updates:
            return None
        values.append(record_id)
        cur.execute(f"UPDATE electricity_records SET {', '.join(updates)}, updated_at = NOW() WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_record(record_id: int, data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        field_map = {
            "period": "period",
            "landlordId": "landlord_id", "brandId": "brand_id", "entityId": "entity_id",
            "payStartDate": "pay_start_date", "payStartReading": "pay_start_reading",
            "payEndDate": "pay_end_date", "payEndReading": "pay_end_reading",
            "payKwh": "pay_kwh", "payUnitPrice": "pay_unit_price",
            "payAmount": "pay_amount", "payStatus": "pay_status",
            "collectStartDate": "collect_start_date", "collectStartReading": "collect_start_reading",
            "collectEndDate": "collect_end_date", "collectEndReading": "collect_end_reading",
            "collectKwh": "collect_kwh", "collectUnitPrice": "collect_unit_price",
            "collectAmount": "collect_amount", "taxRate": "tax_rate",
            "collectNet": "collect_net", "collectStatus": "collect_status",
            "profit": "profit", "remark": "remark",
            "dataSource": "data_source"
        }
        updates, values = [], []
        for key, db_field in field_map.items():
            if key in data and data[key] is not None:
                updates.append(f"{db_field} = %s")
                values.append(data[key])
        if not updates:
            return None
        values.append(record_id)
        cur.execute(f"UPDATE electricity_records SET {', '.join(updates)}, updated_at = NOW() WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_record(record_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM electricity_meter_details WHERE electricity_id = %s", (record_id,))
        cur.execute("DELETE FROM electricity_records WHERE id = %s", (record_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def create_meter_detail(electricity_id: int, meter_id: int, data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO electricity_meter_details
            (electricity_id, meter_id, start_reading, end_reading, kwh,
             pay_unit_price, pay_amount, collect_unit_price, collect_amount, collect_net)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            electricity_id, meter_id,
            data.get("startReading"), data.get("endReading"), data.get("kwh"),
            data.get("payUnitPrice"), data.get("payAmount"),
            data.get("collectUnitPrice"), data.get("collectAmount"), data.get("collectNet")
        ))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_meter_details(electricity_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM electricity_meter_details WHERE electricity_id = %s", (electricity_id,))
        conn.commit()
    finally:
        cur.close()
        conn.close()


def list_periods():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT DISTINCT period FROM electricity_records ORDER BY period DESC")
        return [r["period"] for r in cur.fetchall()]
    finally:
        cur.close()
        conn.close()
