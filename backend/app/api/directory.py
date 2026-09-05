from fastapi import APIRouter, HTTPException, Request
from ..repositories import directory_repo
from ..infra.auth_scope import scope_landlord_ids, scope_meter_tag, METER_TAGS
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/directory", tags=["基础档案"], default_response_class=CamelJSONResponse)


# ─── 品牌方 ─────────────────────────────────────────────────

@router.get("/brands")
async def list_brands(request: Request = None):
    rows = directory_repo.list_brands()
    # 指定电表类型范围的账号：只看到拥有该类型电表的品牌
    tag_scope = scope_meter_tag(request) if request is not None else None
    if tag_scope:
        ids = directory_repo.ids_with_tag_meters("brand_id", tag_scope)
        rows = [r for r in rows if r["id"] in ids]
    return rows


@router.post("/brands", status_code=201)
async def create_brand(data: dict):
    return directory_repo.create_brand(
        name=data.get("name", ""),
        contact=data.get("contact"),
        remark=data.get("remark"),
    )


@router.put("/brands/{brand_id}")
async def update_brand(brand_id: int, data: dict):
    result = directory_repo.update_brand(brand_id, **data)
    if not result:
        raise HTTPException(404, "品牌方不存在")
    return result


@router.delete("/brands/{brand_id}")
async def delete_brand(brand_id: int):
    try:
        directory_repo.delete_brand(brand_id)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


# ─── 公司主体 ───────────────────────────────────────────────

@router.get("/entities")
async def list_entities(request: Request = None):
    rows = directory_repo.list_entities()
    # 指定电表类型范围的账号：只看到拥有该类型电表的公司主体
    tag_scope = scope_meter_tag(request) if request is not None else None
    if tag_scope:
        ids = directory_repo.ids_with_tag_meters("entity_id", tag_scope)
        rows = [r for r in rows if r["id"] in ids]
    return rows


# 主体档案字段：API 层统一接收驼峰（snake 兼容旧调用），repo 层用 snake
_ENTITY_ARCHIVE_CAMEL = {
    "taxNo": "tax_no", "tax_no": "tax_no",
    "taxpayerType": "taxpayer_type", "taxpayer_type": "taxpayer_type",
    "invoiceBank": "invoice_bank", "invoice_bank": "invoice_bank",
    "invoiceAccount": "invoice_account", "invoice_account": "invoice_account",
    "invoiceAddress": "invoice_address", "invoice_address": "invoice_address",
    "invoicePhone": "invoice_phone", "invoice_phone": "invoice_phone",
    "status": "status",
    "sort": "sort",
}


def _entity_archive_kwargs(data: dict) -> dict:
    out = {}
    for src, dst in _ENTITY_ARCHIVE_CAMEL.items():
        if src in data and data[src] is not None:
            out[dst] = data[src]
    return out


@router.post("/entities", status_code=201)
async def create_entity(data: dict):
    return directory_repo.create_entity(
        name=data.get("name", ""),
        short_name=data.get("shortName", data.get("short_name")),
        remark=data.get("remark"),
        **_entity_archive_kwargs(data),
    )


@router.put("/entities/{entity_id}")
async def update_entity(entity_id: int, data: dict):
    result = directory_repo.update_entity(
        entity_id,
        name=data.get("name"),
        short_name=data.get("shortName", data.get("short_name")),
        remark=data.get("remark"),
        **_entity_archive_kwargs(data),
    )
    if not result:
        raise HTTPException(404, "公司主体不存在")
    return result


@router.delete("/entities/{entity_id}")
async def delete_entity(entity_id: int):
    try:
        directory_repo.delete_entity(entity_id)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


# ─── 场地方 ─────────────────────────────────────────────────

@router.get("/landlords")
async def list_landlords(request: Request):
    rows = directory_repo.list_landlords()
    # 股东：只能看到自己关联的场地
    allowed = scope_landlord_ids(request)
    if allowed is not None:
        rows = [r for r in rows if r["id"] in allowed]
    return rows


@router.post("/landlords", status_code=201)
async def create_landlord(data: dict):
    return directory_repo.create_landlord(
        name=data.get("name", ""),
        contact=data.get("contact"),
        phone=data.get("phone"),
        remark=data.get("remark"),
    )


@router.put("/landlords/{landlord_id}")
async def update_landlord(landlord_id: int, data: dict):
    result = directory_repo.update_landlord(landlord_id, **data)
    if not result:
        raise HTTPException(404, "场地方不存在")
    return result


@router.delete("/landlords/{landlord_id}")
async def delete_landlord(landlord_id: int):
    directory_repo.delete_landlord(landlord_id)
    return {"ok": True}


@router.post("/landlords/{landlord_id}/owners", status_code=201)
async def add_landlord_owner(landlord_id: int, data: dict):
    result = directory_repo.add_landlord_owner(
        landlord_id,
        owner_name=data.get("ownerName", ""),
        phone=data.get("phone"),
        start_date=data.get("startDate"),
        remark=data.get("remark"),
    )
    if not result:
        raise HTTPException(404, "场地方不存在")
    return result


@router.put("/landlords/owners/{owner_id}")
async def update_landlord_owner(owner_id: int, data: dict):
    result = directory_repo.update_landlord_owner(
        owner_id,
        owner_name=data.get("ownerName", ""),
        phone=data.get("phone"),
        start_date=data.get("startDate"),
        remark=data.get("remark"),
    )
    if not result:
        raise HTTPException(404, "业主记录不存在")
    return result


@router.delete("/landlords/owners/{owner_id}")
async def delete_landlord_owner(owner_id: int):
    if not directory_repo.delete_landlord_owner(owner_id):
        raise HTTPException(404, "业主记录不存在")
    return {"ok": True}


# ─── 股东 ───────────────────────────────────────────────────

@router.get("/shareholders")
async def list_shareholders(request: Request):
    rows = directory_repo.list_shareholders()
    # 股东账号：只看到自己（避免看到其他股东档案）
    user = getattr(request.state, "current_user", None)
    if user and user.get("role") == "shareholder" and user.get("shareholder_id"):
        rows = [r for r in rows if r["id"] == user["shareholder_id"]]
    return rows


@router.post("/shareholders", status_code=201)
async def create_shareholder(data: dict):
    return directory_repo.create_shareholder(
        name=data.get("name", ""),
        phone=data.get("phone"),
        remark=data.get("remark"),
    )


@router.put("/shareholders/{shareholder_id}")
async def update_shareholder(shareholder_id: int, data: dict):
    result = directory_repo.update_shareholder(shareholder_id, **data)
    if not result:
        raise HTTPException(404, "股东不存在")
    return result


@router.delete("/shareholders/{shareholder_id}")
async def delete_shareholder(shareholder_id: int):
    directory_repo.delete_shareholder(shareholder_id)
    return {"ok": True}


# ─── 介绍人 ─────────────────────────────────────────────────

@router.get("/introducers")
async def list_introducers():
    return directory_repo.list_introducers()


@router.post("/introducers", status_code=201)
async def create_introducer(data: dict):
    return directory_repo.create_introducer(
        name=data.get("name", ""),
        phone=data.get("phone"),
        remark=data.get("remark"),
    )


@router.put("/introducers/{introducer_id}")
async def update_introducer(introducer_id: int, data: dict):
    result = directory_repo.update_introducer(introducer_id, **data)
    if not result:
        raise HTTPException(404, "介绍人不存在")
    return result


@router.delete("/introducers/{introducer_id}")
async def delete_introducer(introducer_id: int):
    directory_repo.delete_introducer(introducer_id)
    return {"ok": True}


# ─── 公司主体-品牌方关联 ─────────────────────────────────────

@router.get("/entity-brands")
async def list_entity_brands(entityId: int = None):
    return directory_repo.list_entity_brands(entity_id=entityId)


@router.post("/entity-brands", status_code=201)
async def create_entity_brand(data: dict):
    return directory_repo.create_entity_brand(
        entity_id=data.get("entityId"),
        brand_id=data.get("brandId"),
        remark=data.get("remark"),
    )


@router.delete("/entity-brands/{id}")
async def delete_entity_brand(id: int):
    directory_repo.delete_entity_brand(id)
    return {"ok": True}


# ─── 平台使用人员 ─────────────────────────────────────────────

def _validated_meter_tag_scope(data: dict) -> str or None:
    """校验并规整电表类型范围：空值 → None（不限制）；非法值报 400"""
    tag = data.get("meterTagScope")
    if tag in (None, ""):
        return None
    if tag not in METER_TAGS:
        raise HTTPException(400, f"无效的电表类型范围: {tag}，可选: 全部(空)/{'/'.join(METER_TAGS)}")
    return tag


def _sanitize_user(u: dict) -> dict:
    """去除密码哈希等敏感字段"""
    if u is None:
        return u
    u = dict(u)
    u.pop("password", None)
    return u


@router.get("/platform-users")
async def list_platform_users():
    return [_sanitize_user(u) for u in directory_repo.list_platform_users()]


@router.post("/platform-users", status_code=201)
async def create_platform_user(data: dict):
    return _sanitize_user(directory_repo.create_platform_user(
        name=data.get("name", ""),
        role=data.get("role", ""),
        shareholder_id=data.get("shareholderId"),
        phone=data.get("phone"),
        remark=data.get("remark"),
        password=data.get("password"),
        landlord_ids=data.get("landlordIds"),
        meter_tag_scope=_validated_meter_tag_scope(data),
    ))


@router.put("/platform-users/{user_id}")
async def update_platform_user(user_id: int, data: dict):
    result = directory_repo.update_platform_user(
        user_id,
        name=data.get("name"),
        role=data.get("role"),
        shareholder_id=data.get("shareholderId"),
        phone=data.get("phone"),
        remark=data.get("remark"),
        password=data.get("password"),
        landlord_ids=data.get("landlordIds"),
        meter_tag_scope=_validated_meter_tag_scope(data) if "meterTagScope" in data else directory_repo._UNSET,
    )
    if not result:
        raise HTTPException(404, "用户不存在")
    return _sanitize_user(result)


@router.delete("/platform-users/{user_id}")
async def delete_platform_user(user_id: int):
    directory_repo.delete_platform_user(user_id)
    return {"ok": True}


# ─── 第三方接口配置 ─────────────────────────────────────────────

@router.get("/third-party-configs")
async def list_third_party_configs():
    return directory_repo.list_third_party_configs()


@router.post("/third-party-configs", status_code=201)
async def create_third_party_config(data: dict):
    return directory_repo.create_third_party_config(
        name=data.get("name", ""),
        base_url=data.get("baseUrl", ""),
        auth_code=data.get("authCode", ""),
        meter_tag=data.get("meterTag", "合作商电表"),
        remark=data.get("remark"),
    )


@router.put("/third-party-configs/{config_id}")
async def update_third_party_config(config_id: int, data: dict):
    result = directory_repo.update_third_party_config(
        config_id,
        name=data.get("name"),
        base_url=data.get("baseUrl"),
        auth_code=data.get("authCode"),
        meter_tag=data.get("meterTag"),
        remark=data.get("remark"),
    )
    if not result:
        raise HTTPException(404, "配置不存在")
    return result


@router.delete("/third-party-configs/{config_id}")
async def delete_third_party_config(config_id: int):
    directory_repo.delete_third_party_config(config_id)
    return {"ok": True}


@router.post("/third-party-configs/test")
async def test_third_party_config(data: dict):
    """测试第三方接口连接：用该账户的 base_url + auth_code 调 /Api/Meter 验证"""
    from ..infra.meter_api import TQMeterClient
    base_url = data.get("baseUrl")
    auth_code = data.get("authCode")
    if not base_url or not auth_code:
        raise HTTPException(400, "接口地址和授权码必填")

    client = TQMeterClient(base_url=base_url, auth_code=auth_code)
    try:
        result = await client.get_devices()
        # 失败时第三方返回 {"status":0,"msg":"..."}，成功返回 {"status":1,"data":[...]} 或裸 list
        if isinstance(result, dict) and result.get("status") not in (1, None):
            msg = result.get("msg") or f"接口返回异常状态 {result.get('status')}"
            raise HTTPException(400, f"连接失败: {msg}")
        devices = result if isinstance(result, list) else result.get("data", []) if isinstance(result, dict) else []
        return {"ok": True, "message": f"连接成功，获取到 {len(devices)} 台设备", "deviceCount": len(devices)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"连接失败: {e}")
