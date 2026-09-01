from ..infra.database import get_connection, get_dict_cursor


def list_meters(station_id: int = None, brand_id: int = None, landlord_id: int = None, allowed_landlord_ids: list = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        # v3：电表直挂 landlord，不再按站点过滤（station_id 参数保留兼容，忽略）
        if brand_id:
            conditions.append("m.brand_id = %s"); values.append(brand_id)
        if landlord_id:
            conditions.append("m.landlord_id = %s"); values.append(landlord_id)
        if allowed_landlord_ids is not None:
            conditions.append("m.landlord_id = ANY(%s::int[])"); values.append(allowed_landlord_ids)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT m.*, l.name as station_name, b.name as brand_name, l.name as landlord_name,
                   e.name as entity_name,
                   CASE WHEN EXISTS (SELECT 1 FROM meter_devices md WHERE md.address = m.meter_no)
                        THEN 'synced' ELSE 'manual' END AS source
            FROM meters m
            LEFT JOIN brands b ON m.brand_id = b.id
            LEFT JOIN landlords l ON m.landlord_id = l.id
            LEFT JOIN entities e ON m.entity_id = e.id
            {where}
            ORDER BY m.landlord_id, m.id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def get_meter(meter_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT m.*, l.name as station_name, b.name as brand_name, l.name as landlord_name,
                   e.name as entity_name
            FROM meters m
            LEFT JOIN brands b ON m.brand_id = b.id
            LEFT JOIN landlords l ON m.landlord_id = l.id
            LEFT JOIN entities e ON m.entity_id = e.id
            WHERE m.id = %s
        """, (meter_id,))
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def get_meter_by_no(meter_no: str):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM meters WHERE meter_no = %s", (meter_no,))
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def create_meter(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # v3：电表直挂 landlord/brand，不再经站点自动带 landlord（stationId 忽略）
        landlord_id = data.get("landlordId")

        cur.execute("""
            INSERT INTO meters (brand_id, landlord_id, entity_id, meter_no, meter_name, collector_id, transformer_ratio, tag, remark)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            data.get("brandId"), landlord_id,
            data.get("entityId"),
            data.get("meterNo"), data.get("meterName"), data.get("collectorId"),
            data.get("transformerRatio", 1), data.get("tag") or "合作商电表", data.get("remark")
        ))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_meter(meter_id: int, data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 一电表一主体校验：设置 entity_id 为非 null 时，若电表已关联到其他主体则拒绝
        # （允许解除关联：entity_id 设为 null）
        if data.get("entityId") is not None:
            cur.execute("SELECT entity_id FROM meters WHERE id = %s", (meter_id,))
            row = cur.fetchone()
            if row and row.get("entity_id") is not None and row["entity_id"] != data["entityId"]:
                raise ValueError("该电表已关联其他公司主体，请先解除关联后再关联")

        field_map = {
            "brandId": "brand_id", "landlordId": "landlord_id",
            "entityId": "entity_id",
            "meterNo": "meter_no", "meterName": "meter_name",
            "collectorId": "collector_id", "transformerRatio": "transformer_ratio",
            "tag": "tag", "status": "status", "remark": "remark"
        }
        updates, values = [], []
        for key, db_field in field_map.items():
            if key not in data:
                continue
            # entityId/brandId 允许显式 null（解除主体关联 / 开启「所有品牌共用」清空品牌）；
            # 其余字段 null 则跳过
            if key in ("entityId", "brandId"):
                updates.append(f"{db_field} = %s")
                values.append(data[key])
            elif data[key] is not None:
                updates.append(f"{db_field} = %s")
                values.append(data[key])
        if not updates:
            return None
        values.append(meter_id)
        cur.execute(f"UPDATE meters SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_meter(meter_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        # 修复 #9：按依赖顺序清理外键引用，避免带柜子/设备的电表删除报 500
        cur.execute("SELECT meter_no FROM meters WHERE id = %s", (meter_id,))
        row = cur.fetchone()
        meter_no = row[0] if row else None

        cur.execute("DELETE FROM electricity_meter_details WHERE meter_id = %s", (meter_id,))
        cur.execute("DELETE FROM cabinets WHERE meter_id = %s", (meter_id,))          # 柜子挂在电表下
        cur.execute("UPDATE meter_devices SET meter_id = NULL WHERE meter_id = %s", (meter_id,))  # 第三方设备解除关联
        if meter_no:
            cur.execute("DELETE FROM meter_monthly WHERE address = %s", (meter_no,))   # 清理孤儿月度读数
        cur.execute("DELETE FROM meters WHERE id = %s", (meter_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def list_landlord_meters(landlord_id: int):
    """获取场地方下的所有电表（含品牌名）"""
    return list_meters(landlord_id=landlord_id)


# ─── 实时状态 / 月度用量（读第三方缓存层，按 meters.meter_no = address 匹配）───

def get_meter_status(meter_no: str):
    """获取电表实时状态（读 meter_status_cache 缓存；按 address=meter_no 匹配，兼容 device_id）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT device_id, address,
                   c0 as total_kwh, c1 as peak_kwh, c2 as sharp_kwh,
                   c3 as flat_kwh, c4 as valley_kwh, remain_money, synced_at
            FROM meter_status_cache
            WHERE address = %s OR device_id = %s
            ORDER BY synced_at DESC NULLS LAST
            LIMIT 1
        """, (meter_no, meter_no))
        row = cur.fetchone()
        if row:
            row["updated_at"] = row["synced_at"]
        return row
    finally:
        cur.close()
        conn.close()


def get_meter_monthly_usage(meter_no: str, limit: int = 12):
    """获取电表月度用电量（读 meter_monthly，period 统一 6 位；返回原始度数+实际度数）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT address, month_period as period, kwh, actual_kwh
            FROM meter_monthly
            WHERE address = %s
            ORDER BY month_period DESC
            LIMIT %s
        """, (meter_no, limit))
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()
