from ..infra.database import get_connection, get_dict_cursor


def list_cabinets(meter_id: int = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if meter_id:
            conditions.append("c.meter_id = %s"); values.append(meter_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT c.*, m.meter_no, m.meter_name, b.name as brand_name
            FROM cabinets c
            LEFT JOIN meters m ON c.meter_id = m.id
            LEFT JOIN brands b ON c.brand_id = b.id
            {where}
            ORDER BY c.id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_cabinet(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO cabinets (meter_id, cabinet_no, cabinet_type, brand_id, remark)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
        """, (
            data.get("meterId"), data.get("cabinetNo"),
            data.get("cabinetType", "普通柜"), data.get("brandId"), data.get("remark")
        ))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_cabinet(cabinet_id: int, data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        field_map = {
            "meterId": "meter_id", "cabinetNo": "cabinet_no",
            "cabinetType": "cabinet_type", "brandId": "brand_id", "remark": "remark"
        }
        updates, values = [], []
        for key, db_field in field_map.items():
            if key in data and data[key] is not None:
                updates.append(f"{db_field} = %s"); values.append(data[key])
        if not updates:
            return None
        values.append(cabinet_id)
        cur.execute(f"UPDATE cabinets SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_cabinet(cabinet_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM cabinets WHERE id = %s", (cabinet_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()
