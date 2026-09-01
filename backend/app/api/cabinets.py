from fastapi import APIRouter, HTTPException
from ..repositories import cabinet_repo, meter_repo
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


@router.get("")
async def list_cabinets(meterId: int = None):
    return cabinet_repo.list_cabinets(meter_id=meterId)


@router.post("", status_code=201)
async def create_cabinet(data: dict):
    result = cabinet_repo.create_cabinet(data)
    _refresh_dividends_for_meter(result.get("meter_id") or data.get("meterId"))
    return result


@router.put("/{cabinet_id}")
async def update_cabinet(cabinet_id: int, data: dict):
    old = cabinet_repo.get_cabinet(cabinet_id)
    result = cabinet_repo.update_cabinet(cabinet_id, data)
    if not result:
        raise HTTPException(404, "柜子不存在")
    # 换挂电表会同时影响新旧两个场地的分摊
    _refresh_dividends_for_meter(old.get("meter_id") if old else None)
    _refresh_dividends_for_meter(result.get("meter_id"))
    return result


@router.delete("/{cabinet_id}")
async def delete_cabinet(cabinet_id: int):
    old = cabinet_repo.get_cabinet(cabinet_id)
    cabinet_repo.delete_cabinet(cabinet_id)
    _refresh_dividends_for_meter(old.get("meter_id") if old else None)
    return {"ok": True}
