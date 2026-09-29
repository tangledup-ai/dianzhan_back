from ..infra.database import get_connection, get_dict_cursor

# ★V5：电表大类。`category_code` 是权威列（码值）；遗留列 `tag` 仍写中文，
# 因为账号数据范围校验（auth_scope / 中间件）目前还在读它 —— 等 S1 切片统一后再停写。
CATEGORY_CODE_TO_TAG = {"partner": "合作商电表", "civil": "民用电表", "shared": "共享电表"}
CATEGORY_TAG_TO_CODE = {v: k for k, v in CATEGORY_CODE_TO_TAG.items()}


def normalize_category(code=None, tag=None) -> str:
    """大类入参归一化：优先码值 → 其次中文 tag → 兜底 partner。"""
    if code is not None and str(code).strip():
        c = str(code).strip()
        if c in CATEGORY_CODE_TO_TAG:
            return c
        if c in CATEGORY_TAG_TO_CODE:
            return CATEGORY_TAG_TO_CODE[c]
    if tag is not None and str(tag).strip() in CATEGORY_TAG_TO_CODE:
        return CATEGORY_TAG_TO_CODE[str(tag).strip()]
    return "partner"


def list_meters(station_id: int = None, brand_id: int = None, landlord_id: int = None,
                allowed_landlord_ids: list = None, allowed_tag: str = None):
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
        if allowed_tag:
            conditions.append("m.tag = %s"); values.append(allowed_tag)
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


def _check_meter_no_unique(cur, meter_no, exclude_id=None):
    """电表编号唯一校验（DB 也有唯一约束，这里提前给出可读的错误信息）"""
    if not meter_no:
        return
    if exclude_id is None:
        cur.execute("SELECT meter_no FROM meters WHERE meter_no = %s", (meter_no,))
    else:
        cur.execute("SELECT meter_no FROM meters WHERE meter_no = %s AND id != %s", (meter_no, exclude_id))
    row = cur.fetchone()
    if row:
        raise ValueError(f"电表编号 {meter_no} 已存在，不能重复使用")


def _venue_entity_id(cur, landlord_id) -> int | None:
    """场地方的默认公司主体 = 其最新一份场地合同的 entity_id（无场地合同或未指定主体 → None）"""
    cur.execute("""
        SELECT entity_id FROM contracts
        WHERE landlord_id = %s AND contract_type = '场地合同' AND entity_id IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
    """, (landlord_id,))
    row = cur.fetchone()
    return row["entity_id"] if row else None


def sync_landlord_meter_entities(landlord_id: int, entity_id: int | None) -> int:
    """场地合同主体保存/变更后级联：该场地下「默认跟随」的电表（非 manual）同步主体。

    entity_source='manual' 的电表是用户在 Entities 页/表单里显式设置的，不自动覆盖；
    entity_source IS NULL 的电表是尚未有主体可跟随的默认态，一并填充。
    """
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            UPDATE meters SET entity_id = %s, entity_source = 'auto'
            WHERE landlord_id = %s AND entity_source IS DISTINCT FROM 'manual'
        """, (entity_id, landlord_id))
        conn.commit()
        return cur.rowcount
    finally:
        cur.close()
        conn.close()


def create_meter(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # v3：电表直挂 landlord/brand，不再经站点自动带 landlord（stationId 忽略）
        landlord_id = data.get("landlordId")
        _check_meter_no_unique(cur, data.get("meterNo"))

        # 默认继承：未显式指定主体时，跟随场地方的公司主体（场地合同 entity_id）
        entity_id = data.get("entityId")
        entity_source = None
        if entity_id is not None:
            entity_source = "manual"
        elif landlord_id:
            entity_id = _venue_entity_id(cur, landlord_id)
            entity_source = "auto" if entity_id is not None else None

        # ★V5：「电表大类」（category_code）与「是否所有品牌共用一个表」（is_shared）彻底解耦，
        #   均由人工指定、互不推导。tag 作为遗留列同步写中文，供旧的范围校验继续可用。
        category_code = normalize_category(data.get("categoryCode"), data.get("tag"))
        is_shared = bool(data.get("isShared"))
        device_address = (str(data.get("deviceAddress")).strip() or None) if data.get("deviceAddress") else None

        cur.execute("""
            INSERT INTO meters (brand_id, landlord_id, entity_id, entity_source, meter_no, meter_name,
                                collector_id, transformer_ratio, tag, category_code, is_shared,
                                device_address, initial_reading, remark)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            data.get("brandId"), landlord_id,
            entity_id, entity_source,
            data.get("meterNo"), data.get("meterName"), data.get("collectorId"),
            data.get("transformerRatio", 1), CATEGORY_CODE_TO_TAG[category_code], category_code, is_shared,
            device_address, data.get("initialReading"), data.get("remark")
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
        cur.execute("SELECT landlord_id, entity_id, entity_source FROM meters WHERE id = %s", (meter_id,))
        cur_row = cur.fetchone()

        # 场地变更 → 电表默认跟随新场地的公司主体（场地合同 entity_id）。
        # 表单里显式选了别的主体（entityId 与当前不同且非空）则尊重用户选择。
        if data.get("landlordId") is not None and cur_row and cur_row.get("landlord_id") != data["landlordId"]:
            incoming = data.get("entityId")
            if "entityId" not in data or incoming is None or incoming == cur_row.get("entity_id"):
                inherited = _venue_entity_id(cur, data["landlordId"])
                data = {**data, "entityId": inherited, "entitySource": "auto"}

        # 一电表一主体：meters.entity_id 是单列，换主体 = 直接替换（仍是一电表一主体）。
        # 不做"已关联其他主体"拦截——否则编辑电表时无法切换报税主体（2026-09 用户确认按替换处理）。
        # 允许解除关联：entityId 显式传 null（下方 entityId/brandId 分支支持写 null）。

        # ⚠️ `tag` 不在此表：它改为由 categoryCode 镜像派生（见下方），
        #    否则同一次 UPDATE 会对同一列重复赋值（Postgres 直接报错）。
        field_map = {
            "brandId": "brand_id", "landlordId": "landlord_id",
            "entityId": "entity_id",
            "meterNo": "meter_no", "meterName": "meter_name",
            "collectorId": "collector_id", "transformerRatio": "transformer_ratio",
            "isShared": "is_shared", "deviceAddress": "device_address",
            "initialReading": "initial_reading",
            "status": "status", "remark": "remark"
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

        # ★V5：大类码值 → 写权威列 category_code，并镜像写遗留列 tag（旧范围校验仍读 tag）
        if "categoryCode" in data or "tag" in data:
            code = normalize_category(data.get("categoryCode"), data.get("tag"))
            updates.append("category_code = %s"); values.append(code)
            updates.append("tag = %s"); values.append(CATEGORY_CODE_TO_TAG[code])

        # 主体来源标记：值变了 → manual（用户显式设置）或 auto（场地变更自动跟随）；
        # 值没变 → 保持原标记（避免电表表单原样带回 entityId 把 auto 翻成 manual）
        if "entityId" in data:
            val = data.get("entityId")
            current_entity = cur_row.get("entity_id") if cur_row else None
            if data.get("entitySource") == "auto":
                new_source = "auto" if val is not None else None
            elif val != current_entity:
                new_source = "manual"
            else:
                new_source = cur_row.get("entity_source") if cur_row else None
            updates.append("entity_source = %s")
            values.append(new_source)

        if not updates:
            return None
        # 编号被修改时校验唯一（排除自身）
        if "meterNo" in data and data["meterNo"]:
            _check_meter_no_unique(cur, data["meterNo"], exclude_id=meter_id)
        values.append(meter_id)
        cur.execute(f"UPDATE meters SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        updated = cur.fetchone()
        # 换主体审计：entity_id 变更（含解除关联）写一条 meter_entity_changes，与电表更新同事务
        if updated and cur_row and updated.get("entity_id") != cur_row.get("entity_id"):
            cur.execute("""
                INSERT INTO meter_entity_changes
                (meter_id, meter_no, from_entity_id, to_entity_id, operator, remark, effective_period)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (
                meter_id, updated.get("meter_no"),
                cur_row.get("entity_id"), updated.get("entity_id"),
                data.get("operator"), data.get("entityChangeRemark"),
                data.get("entityEffectivePeriod"),
            ))
        conn.commit()
        return updated
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
        cur.execute("DELETE FROM meter_shared_allocations WHERE meter_id = %s", (meter_id,))  # 共享电表品牌分摊
        cur.execute("DELETE FROM cabinets WHERE meter_id = %s", (meter_id,))          # 柜子挂在电表下
        cur.execute("UPDATE meter_devices SET meter_id = NULL WHERE meter_id = %s", (meter_id,))  # 第三方设备解除关联
        if meter_no:
            cur.execute("DELETE FROM meter_readings WHERE address = %s", (meter_no,))   # 清理孤儿月度读数
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
    """获取电表月度用电量（读 meter_readings，period 统一 6 位；返回原始度数+实际度数）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT address, month_period as period, kwh, actual_kwh
            FROM meter_readings
            WHERE address = %s
            ORDER BY month_period DESC
            LIMIT %s
        """, (meter_no, limit))
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()
