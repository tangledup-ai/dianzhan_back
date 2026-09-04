"""电表能耗数据 API"""
from fastapi import APIRouter, HTTPException, Query, Request
from ..infra.database import get_connection, get_dict_cursor
from ..infra.auth_scope import scope_landlord_ids, scope_meter_tag, ensure_meter_in_scope
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/meter-energy", tags=["电表能耗"], default_response_class=CamelJSONResponse)


def _scope_conditions(conditions: list, values: list, request, column: str):
    """能耗查询的数据隔离条件：m 为 JOIN 出的 meters 表别名"""
    allowed = scope_landlord_ids(request)
    if allowed is not None:
        conditions.append(f"{column}.landlord_id = ANY(%s::int[])")
        values.append(allowed)
    tag_scope = scope_meter_tag(request)
    if tag_scope:
        conditions.append(f"{column}.tag = %s")
        values.append(tag_scope)


@router.get("/daily")
async def get_daily_kwh(
    request: Request = None,
    meterNo: str = None,
    startDate: str = Query(None, description="开始日期 YYYYMMDD"),
    endDate: str = Query(None, description="结束日期 YYYYMMDD"),
):
    """获取日用电量"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if request is not None:
            _scope_conditions(conditions, values, request, "m")
        if meterNo:
            conditions.append("d.address = %s")
            values.append(meterNo)
        if startDate:
            conditions.append("d.day_date >= %s")
            values.append(startDate)
        if endDate:
            conditions.append("d.day_date <= %s")
            values.append(endDate)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        cur.execute(f"""
            SELECT d.*, m.meter_name, m.landlord_id, l.name as station_name, m.transformer_ratio
            FROM meter_daily d
            LEFT JOIN meters m ON m.meter_no = d.address
            LEFT JOIN landlords l ON m.landlord_id = l.id
            {where}
            ORDER BY d.day_date DESC, d.address
        """, values)
        rows = cur.fetchall()
        # 实际用电量 = 表码度数 × 互感器倍数
        for r in rows:
            if r.get("kwh") is not None:
                r["kwh"] = round(float(r["kwh"]) * float(r.get("transformer_ratio") or 1), 2)
        return rows
    finally:
        cur.close()
        conn.close()


@router.get("/hourly")
async def get_hourly_kwh(
    request: Request = None,
    meterNo: str = None,
    startTime: str = Query(None, description="开始时间 YYYYMMDDHH"),
    endTime: str = Query(None, description="结束时间 YYYYMMDDHH"),
):
    """获取小时用电量"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if request is not None:
            _scope_conditions(conditions, values, request, "m")
        if meterNo:
            conditions.append("h.address = %s")
            values.append(meterNo)
        if startTime:
            conditions.append("h.hour_time >= %s")
            values.append(startTime)
        if endTime:
            conditions.append("h.hour_time <= %s")
            values.append(endTime)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        cur.execute(f"""
            SELECT h.*, m.meter_name, m.landlord_id, l.name as station_name, m.transformer_ratio
            FROM meter_hourly h
            LEFT JOIN meters m ON m.meter_no = h.address
            LEFT JOIN landlords l ON m.landlord_id = l.id
            {where}
            ORDER BY h.hour_time DESC, h.address
        """, values)
        rows = cur.fetchall()
        # 实际用电量 = 表码度数 × 互感器倍数
        for r in rows:
            if r.get("kwh") is not None:
                r["kwh"] = round(float(r["kwh"]) * float(r.get("transformer_ratio") or 1), 2)
        return rows
    finally:
        cur.close()
        conn.close()


@router.get("/monthly")
async def get_monthly_kwh(
    request: Request = None,
    meterNo: str = None,
    startMonth: str = Query(None, description="开始月份 YYYYMM"),
    endMonth: str = Query(None, description="结束月份 YYYYMM"),
):
    """获取月用电量"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if request is not None:
            _scope_conditions(conditions, values, request, "m")
        if meterNo:
            conditions.append("mm.address = %s")
            values.append(meterNo)
        if startMonth:
            conditions.append("mm.month_period >= %s")
            values.append(startMonth)
        if endMonth:
            conditions.append("mm.month_period <= %s")
            values.append(endMonth)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        cur.execute(f"""
            SELECT mm.*, m.meter_name, m.landlord_id, l.name as station_name, m.transformer_ratio
            FROM meter_monthly mm
            LEFT JOIN meters m ON m.meter_no = mm.address
            LEFT JOIN landlords l ON m.landlord_id = l.id
            {where}
            ORDER BY mm.month_period DESC, mm.address
        """, values)
        rows = cur.fetchall()
        # 实际用电量 = actual_kwh（若有）否则 表码度数 × 互感器倍数
        # raw_kwh 保留原始表码度数，供「读数编辑表单」回填，避免读→编辑→写回导致二次相乘
        for r in rows:
            if r.get("kwh") is not None or r.get("actual_kwh") is not None:
                ratio = float(r.get("transformer_ratio") or 1)
                r["raw_kwh"] = float(r["kwh"]) if r.get("kwh") is not None else None
                if r.get("actual_kwh") is not None:
                    r["kwh"] = round(float(r["actual_kwh"]), 2)
                else:
                    r["kwh"] = round(float(r["kwh"]) * ratio, 2)
        return rows
    finally:
        cur.close()
        conn.close()


@router.post("/readings")
async def save_meter_reading(data: dict, request: Request = None):
    """手动录入/更新电表月度读数（人工实际读数不随第三方同步覆盖）"""
    address = data.get("address")
    month_period = data.get("monthPeriod")
    kwh = data.get("kwh")
    actual_kwh = data.get("actualKwh")
    prev_actual_reading = data.get("prevActualReading")
    curr_actual_reading = data.get("currActualReading")
    prev_reading_date = data.get("prevReadingDate")
    prev_reading = data.get("prevReading")
    curr_reading_date = data.get("currReadingDate")
    curr_reading = data.get("currReading")

    if not address or not month_period:
        raise HTTPException(400, "address 和 monthPeriod 必填")

    # 电表类型范围：受限账号只能写范围内电表的读数（地址不存在或范围外一律拒绝）
    if request is not None and (scope_meter_tag(request) or scope_landlord_ids(request) is not None):
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("SELECT tag, landlord_id FROM meters WHERE meter_no = %s", (address,))
            meter = cur.fetchone()
        finally:
            cur.close()
            conn.close()
        if not meter:
            raise HTTPException(403, "电表不存在，无法录入读数")
        ensure_meter_in_scope(request, meter.get("tag"), meter.get("landlord_id"))

    # 如果提供了起始度数和抄表度数，自动计算区间度数
    if kwh is None and prev_reading is not None and curr_reading is not None:
        kwh = float(curr_reading) - float(prev_reading)
    elif kwh is not None:
        kwh = float(kwh)
    else:
        kwh = 0

    # 人工实际值（已含倍数，非空则优先使用；空则保留 NULL，走「区间值×倍数」）
    actual_kwh = float(actual_kwh) if actual_kwh is not None and str(actual_kwh).strip() != "" else None
    # 人工实际读数（第三方同步不覆盖；填写时若未给实际用电量，可由 本月-上月 自动补）
    prev_actual_reading = float(prev_actual_reading) if prev_actual_reading is not None and str(prev_actual_reading).strip() != "" else None
    curr_actual_reading = float(curr_actual_reading) if curr_actual_reading is not None and str(curr_actual_reading).strip() != "" else None
    if actual_kwh is None and prev_actual_reading is not None and curr_actual_reading is not None:
        actual_kwh = round(curr_actual_reading - prev_actual_reading, 2)

    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO meter_monthly (address, month_period, kwh, actual_kwh, prev_actual_reading, curr_actual_reading,
                prev_reading_date, prev_reading, curr_reading_date, curr_reading, synced_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (address, month_period)
            DO UPDATE SET
                kwh = EXCLUDED.kwh,
                actual_kwh = EXCLUDED.actual_kwh,
                prev_actual_reading = EXCLUDED.prev_actual_reading,
                curr_actual_reading = EXCLUDED.curr_actual_reading,
                prev_reading_date = EXCLUDED.prev_reading_date,
                prev_reading = EXCLUDED.prev_reading,
                curr_reading_date = EXCLUDED.curr_reading_date,
                curr_reading = EXCLUDED.curr_reading,
                synced_at = NOW()
        """, (address, month_period, kwh, actual_kwh, prev_actual_reading, curr_actual_reading,
              prev_reading_date, prev_reading, curr_reading_date, curr_reading))
        conn.commit()
        return {
            "ok": True,
            "address": address,
            "monthPeriod": month_period,
            "kwh": kwh,
            "actualKwh": actual_kwh,
            "prevActualReading": prev_actual_reading,
            "currActualReading": curr_actual_reading,
            "prevReadingDate": prev_reading_date,
            "prevReading": prev_reading,
            "currReadingDate": curr_reading_date,
            "currReading": curr_reading,
        }
    finally:
        cur.close()
        conn.close()


@router.get("/sync-logs")
async def get_sync_logs(limit: int = 20):
    """获取同步日志"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT * FROM sync_logs
            ORDER BY started_at DESC
            LIMIT %s
        """, (limit,))
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


@router.post("/sync")
async def trigger_sync(type: str):
    """手动触发同步

    type: devices | collectors | status | hourly | daily | monthly | yearly | full
    """
    from ..jobs.sync_meters import (
        sync_devices, sync_collectors, sync_status,
        sync_hourly_data, sync_daily_data, sync_monthly_data, sync_yearly_data,
        full_sync,
    )

    sync_map = {
        "devices": sync_devices,
        "collectors": sync_collectors,
        "status": sync_status,
        "hourly": sync_hourly_data,
        "daily": sync_daily_data,
        "monthly": sync_monthly_data,
        "yearly": sync_yearly_data,
        "full": full_sync,
    }

    fn = sync_map.get(type)
    if not fn:
        raise HTTPException(400, f"未知同步类型: {type}，可选: {', '.join(sync_map.keys())}")

    result = await fn()
    return {"ok": True, "type": type, "result": result}
