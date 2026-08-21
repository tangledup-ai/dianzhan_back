from fastapi import APIRouter, HTTPException
from ..repositories import contract_schedule_repo
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/contract-schedules", tags=["合同收付款分期"], default_response_class=CamelJSONResponse)


@router.post("")
async def create_schedule(data: dict):
    contract_id = data.get("contractId")
    side = data.get("side")
    if not contract_id:
        raise HTTPException(400, "contractId 必填")
    if side not in ("payment", "income"):
        raise HTTPException(400, "side 必须是 payment 或 income")
    return contract_schedule_repo.create_schedule(contract_id, side, data)


@router.get("/payment")
async def list_payment(contractId: int = None):
    return contract_schedule_repo.list_payment_schedules(contract_id=contractId)


@router.get("/income")
async def list_income(contractId: int = None):
    return contract_schedule_repo.list_income_schedules(contract_id=contractId)


@router.put("/{schedule_id}")
async def update_schedule(schedule_id: int, data: dict):
    side = data.get("side")
    if side not in ("payment", "income"):
        raise HTTPException(400, "side 必须是 payment 或 income")
    result = contract_schedule_repo.update_schedule(schedule_id, side, data)
    if not result:
        raise HTTPException(404, "分期记录不存在")
    return result
