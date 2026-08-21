"""股东数据隔离：从 request.state.current_user 读取允许的场地范围"""


def scope_landlord_ids(request) -> list or None:
    """返回当前用户允许的 landlord_id 列表；None 表示不限制（老板/财务/财务主管）。

    股东（role=shareholder）只能查看 platform_users.landlord_ids 中关联的场地。
    """
    user = getattr(request.state, "current_user", None)
    if not user:
        return None
    role = user.get("role")
    if role in ("boss", "finance", "finance_supervisor"):
        return None
    lids = user.get("landlord_ids") or []
    return [int(x) for x in lids if x is not None]
