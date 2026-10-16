from fastapi import APIRouter, HTTPException, Request
from ..repositories import cabinet_repo, meter_repo
from ..infra.auth_scope import scope_landlord_ids, scope_meter_tag, ensure_meter_in_scope
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/cabinets", tags=["柜子管理"], default_response_class=CamelJSONResponse)


def _refresh_dividends_for_meter(meter_id):
    """柜子变动会影响实时计费柜数 → 重算该电表所属场地的分红记录（失败不影响柜子操作）"""
    if not meter_id:
        return
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        meter = meter_repo.get_meter(meter_id)
        refresh_dividend_records(meter.get("landlord_id") if meter else None)
    except Exception:
        pass


def _ensure_meter_writable(request: Request, meter_id):
    """电表类型范围：受限账号只能挂/改/删范围内电表下的柜子"""
    meter = meter_repo.get_meter(meter_id) if meter_id else None
    ensure_meter_in_scope(request,
                          meter.get("tag") if meter else None,
                          meter.get("landlord_id") if meter else None)


@router.get("")
async def list_cabinets(request: Request = None, meterId: int = None):
    allowed = scope_landlord_ids(request) if request is not None else None
    tag_scope = scope_meter_tag(request) if request is not None else None
    return cabinet_repo.list_cabinets(meter_id=meterId,
                                      allowed_landlord_ids=allowed, allowed_tag=tag_scope)


@router.post("", status_code=201)
async def create_cabinet(request: Request, data: dict):
    _ensure_meter_writable(request, data.get("meterId"))
    result = cabinet_repo.create_cabinet(data)
    _refresh_dividends_for_meter(result.get("meter_id") or data.get("meterId"))
    return result


@router.put("/{cabinet_id}")
async def update_cabinet(cabinet_id: int, request: Request, data: dict):
    old = cabinet_repo.get_cabinet(cabinet_id)
    if old:
        _ensure_meter_writable(request, old.get("meter_id"))
    # 先校验目标挂载电表，再落库；不能先完成跨范围换挂、之后才返回 403。
    target_meter_id = data.get("meterId", old.get("meter_id") if old else None)
    if target_meter_id:
        _ensure_meter_writable(request, target_meter_id)
    result = cabinet_repo.update_cabinet(cabinet_id, data)
    if not result:
        raise HTTPException(404, "柜子不存在")
    # 换挂电表会同时影响新旧两个场地的分摊
    _refresh_dividends_for_meter(old.get("meter_id") if old else None)
    _refresh_dividends_for_meter(result.get("meter_id"))
    return result


@router.delete("/{cabinet_id}")
async def delete_cabinet(cabinet_id: int, request: Request):
    old = cabinet_repo.get_cabinet(cabinet_id)
    if old:
        _ensure_meter_writable(request, old.get("meter_id"))
    cabinet_repo.delete_cabinet(cabinet_id)
    _refresh_dividends_for_meter(old.get("meter_id") if old else None)
    return {"ok": True}
