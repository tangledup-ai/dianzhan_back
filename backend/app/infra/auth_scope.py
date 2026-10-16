"""数据隔离：从 request.state.current_user 读取当前用户的数据范围

两级隔离：
- 股东（role=shareholder）：platform_users.landlord_ids 限定可见场地；
- 财务/财务主管：platform_users.meter_tag_scope 限定可见的电表类型
  （合作商电表/民用电表/共享电表），场地级数据按「场地拥有该类型电表」派生。
"""

# 与 meters.tag 一致的合法电表类型
METER_TAGS = ("合作商电表", "民用电表", "共享电表")


def scope_meter_tag(request) -> str or None:
    """返回当前用户限定的电表类型；None 表示不限制。

    仅对 finance/finance_supervisor 生效；老板恒为全部（防止误配把自己锁死），
    股东沿用 landlord_ids 场地隔离，不走电表类型范围。
    """
    user = getattr(request.state, "current_user", None)
    if not user:
        return None
    if user.get("role") not in ("finance", "finance_supervisor"):
        return None
    tag = user.get("meter_tag_scope")
    return tag if tag in METER_TAGS else None


def _tag_landlord_ids(tag: str) -> list:
    """拥有指定类型电表的场地 id 列表（场地级数据隔离的可见范围）"""
    from .database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT DISTINCT landlord_id FROM meters
            WHERE tag = %s AND landlord_id IS NOT NULL
        """, (tag,))
        return [int(r["landlord_id"]) for r in cur.fetchall()]
    finally:
        cur.close()
        conn.close()


def ensure_meter_in_scope(request, tag, landlord_id, hide: bool = False):
    """校验电表（tag, landlord_id）是否在当前用户范围内，越界抛 HTTPException。

    hide=True 用于读路径（404，不暴露范围外电表的存在）；
    写路径 hide=False（403，提示越权原因）。
    """
    from fastapi import HTTPException
    tag_scope = scope_meter_tag(request)
    if tag_scope and (tag or "") != tag_scope:
        raise HTTPException(404 if hide else 403,
                            "电表不存在" if hide else "无权操作该类型的电表")
    allowed = scope_landlord_ids(request)
    if allowed is not None and (landlord_id is None or int(landlord_id) not in allowed):
        raise HTTPException(404 if hide else 403,
                            "电表不存在" if hide else "无权操作该场地下的电表")


def ensure_landlord_in_scope(request, landlord_id: int, hide: bool = False):
    """检查场地是否在用户范围内；类别受限用户仅能进入至少有该类表的场地。"""
    from fastapi import HTTPException
    if landlord_id is None:
        raise HTTPException(404 if hide else 403,
                            "场地不存在" if hide else "无权操作未关联场地的数据")
    allowed = scope_landlord_ids(request)
    if allowed is not None and int(landlord_id) not in set(allowed):
        raise HTTPException(404 if hide else 403,
                            "场地不存在" if hide else "无权操作该场地的数据")


def ensure_electricity_record_in_scope(request, record_id: int, hide: bool = False):
    """按账单下实际关联的电表校验权限，避免仅凭场地 ID 放行跨类别账单。"""
    from fastapi import HTTPException
    from .database import get_connection, get_dict_cursor

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT e.landlord_id, e.row_type,
                   COUNT(m.id) AS meter_count,
                   COUNT(m.id) FILTER (WHERE m.tag = %s) AS scoped_count
            FROM electricity_records e
            LEFT JOIN electricity_meter_details d ON d.electricity_id = e.id
            LEFT JOIN meters m ON m.id = d.meter_id
            WHERE e.id = %s
            GROUP BY e.id, e.landlord_id, e.row_type
        """, (scope_meter_tag(request) or "", record_id))
        row = cur.fetchone()
    finally:
        cur.close()
        conn.close()

    if not row:
        raise HTTPException(404, "电费记录不存在")
    ensure_landlord_in_scope(request, row.get("landlord_id"), hide=hide)
    tag_scope = scope_meter_tag(request)
    if tag_scope:
        # 场地级损耗是跨类别的整体结算值，不能暴露给只授权单一电表类别的账号。
        if row.get("row_type") == "loss" or int(row.get("meter_count") or 0) == 0 or int(row.get("meter_count") or 0) != int(row.get("scoped_count") or 0):
            raise HTTPException(404 if hide else 403,
                                "电费记录不存在" if hide else "该账单包含授权范围外的电表，不能操作")


def scope_landlord_ids(request) -> list or None:
    """返回当前用户允许的 landlord_id 列表；None 表示不限制。

    - 股东（role=shareholder）只能查看 platform_users.landlord_ids 中关联的场地；
    - 财务/财务主管设置了 meter_tag_scope 时，只能查看拥有该类型电表的场地。
    """
    user = getattr(request.state, "current_user", None)
    if not user:
        return None
    role = user.get("role")
    if role in ("boss", "finance", "finance_supervisor"):
        tag = scope_meter_tag(request)
        if tag:
            return _tag_landlord_ids(tag)
        return None
    lids = user.get("landlord_ids") or []
    return [int(x) for x in lids if x is not None]
