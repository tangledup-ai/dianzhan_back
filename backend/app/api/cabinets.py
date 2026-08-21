from fastapi import APIRouter, HTTPException
from ..repositories import cabinet_repo
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/cabinets", tags=["柜子管理"], default_response_class=CamelJSONResponse)


@router.get("")
async def list_cabinets(meterId: int = None):
    return cabinet_repo.list_cabinets(meter_id=meterId)


@router.post("", status_code=201)
async def create_cabinet(data: dict):
    return cabinet_repo.create_cabinet(data)


@router.put("/{cabinet_id}")
async def update_cabinet(cabinet_id: int, data: dict):
    result = cabinet_repo.update_cabinet(cabinet_id, data)
    if not result:
        raise HTTPException(404, "柜子不存在")
    return result


@router.delete("/{cabinet_id}")
async def delete_cabinet(cabinet_id: int):
    cabinet_repo.delete_cabinet(cabinet_id)
    return {"ok": True}
