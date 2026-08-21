from fastapi import APIRouter, HTTPException, Request
from ..repositories import meter_repo
from ..infra.auth_scope import scope_landlord_ids
from ..infra.meter_api import tq_client
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/meters", tags=["电表管理"], default_response_class=CamelJSONResponse)


@router.get("")
async def list_meters(request: Request, stationId: int = None, brandId: int = None, landlordId: int = None):
    # 股东：只能看到关联场地的电表
    allowed = scope_landlord_ids(request)
    return meter_repo.list_meters(station_id=stationId, brand_id=brandId, landlord_id=landlordId,
                                  allowed_landlord_ids=allowed)


@router.get("/{meter_id}")
async def get_meter(meter_id: int):
    meter = meter_repo.get_meter(meter_id)
    if not meter:
        raise HTTPException(404, "电表不存在")

    # 获取实时状态（从新数据库的 meter_status_cache 表读取）
    status = meter_repo.get_meter_status(meter["meter_no"])

    # 获取月度用电量（从新数据库的 meter_monthly 表读取）
    monthly = meter_repo.get_meter_monthly_usage(meter["meter_no"])

    realtime = None
    if status:
        realtime = {
            "totalKwh": float(status.get("total_kwh") or 0),
            "peakKwh": float(status.get("peak_kwh") or 0),
            "sharpKwh": float(status.get("sharp_kwh") or 0),
            "flatKwh": float(status.get("flat_kwh") or 0),
            "valleyKwh": float(status.get("valley_kwh") or 0),
            "remainingAmount": float(status.get("remain_money") or 0),
            "syncedAt": str(status.get("updated_at") or ""),
        }

    # 互感器倍数：实际用电量 = 表码度数 × 倍数（actual_kwh 人工修正优先，v2 口径）
    ratio = float(meter.get("transformer_ratio") or 1)
    usage = {
        "monthly": []
    }
    for m in monthly:
        if m.get("actual_kwh") is not None:
            kwh = round(float(m["actual_kwh"]), 2)
        else:
            kwh = round(float(m.get("kwh") or 0) * ratio, 2)
        usage["monthly"].append({"period": m.get("period"), "kwh": kwh})

    return {**meter, "realtime": realtime, "usage": usage}


@router.post("", status_code=201)
async def create_meter(data: dict):
    try:
        return meter_repo.create_meter(data)
    except Exception as e:
        import logging
        logging.error(f"create_meter error: {e}, data={data}")
        raise HTTPException(400, str(e))


@router.put("/{meter_id}")
async def update_meter(meter_id: int, data: dict):
    try:
        result = meter_repo.update_meter(meter_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not result:
        raise HTTPException(404, "电表不存在")
    # 动态生成：电表归属（landlord/brand）变更后，自动生成其有读数月份的台账
    from .electricity import auto_generate_for_meter
    try:
        await auto_generate_for_meter(result.get("meter_no") or data.get("meterNo"))
    except Exception:
        pass  # 自动生成失败不影响电表保存（可手动点「自动生成」）
    return result


@router.delete("/{meter_id}")
async def delete_meter(meter_id: int):
    meter_repo.delete_meter(meter_id)
    return {"ok": True}
