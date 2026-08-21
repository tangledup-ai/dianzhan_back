"""异常提醒聚合接口 — 电量异常 + 合同缴费/收款提醒"""
from fastapi import APIRouter
from ..infra.database import get_connection, get_dict_cursor
from datetime import date, timedelta
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/alerts", tags=["异常提醒"], default_response_class=CamelJSONResponse)


@router.get("")
async def get_alerts(
    dailyThreshold: float = 2.0,
    monthlyThreshold: float = 1.5,
):
    """聚合异常提醒：电量异常激增/激减 + 合同缴费/收款提醒"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        elec_anomalies = _detect_elec_anomalies(cur, dailyThreshold, monthlyThreshold)
        contract_payments = _get_contract_alerts(cur, "场地合同")
        contract_collections = _get_contract_alerts(cur, "品牌方合同")

        return {
            "elecAnomalies": elec_anomalies,
            "contractPayments": contract_payments,
            "contractCollections": contract_collections,
        }
    finally:
        cur.close()
        conn.close()


def _detect_elec_anomalies(cur, daily_threshold: float, monthly_threshold: float):
    """电量异常检测"""
    anomalies = []

    # ── 日激增检测 ──
    # 最近7天每个电表的日均用电量
    cur.execute("""
        SELECT d.address, m.meter_name, l.name as station_name, m.landlord_id,
               d.day_date, d.kwh,
               AVG(d.kwh) OVER (PARTITION BY d.address) as avg_kwh
        FROM meter_daily d
        JOIN meters m ON m.meter_no = d.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
        LEFT JOIN landlords l ON m.landlord_id = l.id
        WHERE d.day_date >= to_char(CURRENT_DATE - INTERVAL '7 days', 'YYYYMMDD')
          AND d.kwh > 0
        ORDER BY d.day_date DESC
    """)
    rows = cur.fetchall()

    seen = set()  # 去重：同一电表同一天只报一次
    for r in rows:
        kwh = float(r["kwh"] or 0)
        avg = float(r["avg_kwh"] or 0)
        if avg <= 0 or kwh <= 0:
            continue
        ratio = round(kwh / avg, 2)
        if ratio >= daily_threshold:
            key = (r["address"], r["day_date"])
            if key in seen:
                continue
            seen.add(key)
            anomalies.append({
                "type": "daily",
                "stationName": r.get("station_name") or "",
                "meterNo": r["address"],
                "current": kwh,
                "avg": round(avg, 2),
                "ratio": ratio,
                "date": r["day_date"],
            })

    # ── 月激增检测 ──
    cur.execute("""
        SELECT m.meter_no, m.meter_name, l.name as station_name, m.landlord_id,
               mm.month_period, mm.kwh,
               AVG(mm.kwh) OVER (PARTITION BY mm.address) as avg_kwh
        FROM meter_monthly mm
        JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
        LEFT JOIN landlords l ON m.landlord_id = l.id
        WHERE mm.month_period >= to_char(CURRENT_DATE - INTERVAL '6 months', 'YYYYMM')
          AND mm.kwh > 0
        ORDER BY mm.month_period DESC
    """)
    rows = cur.fetchall()

    # 只取最近一个月的异常
    latest_month = None
    for r in rows:
        if latest_month is None:
            latest_month = r["month_period"]
        if r["month_period"] != latest_month:
            continue

        kwh = float(r["kwh"] or 0)
        avg = float(r["avg_kwh"] or 0)
        if avg <= 0 or kwh <= 0:
            continue
        ratio = round(kwh / avg, 2)
        if ratio >= monthly_threshold:
            anomalies.append({
                "type": "monthly",
                "stationName": r.get("station_name") or "",
                "meterNo": r["meter_no"],
                "current": kwh,
                "avg": round(avg, 2),
                "ratio": ratio,
                "period": r["month_period"],
            })

    # 排序：倍率高的排前面
    anomalies.sort(key=lambda x: x["ratio"], reverse=True)
    return anomalies


def _get_contract_alerts(cur, contract_type: str):
    """合同到期提醒（缴费或收款）"""
    today = date.today()
    cur.execute("""
        SELECT c.id, c.partner, c.contract_type,
               c.monthly_rent, c.end_date,
               COALESCE(l.name, '') as landlord_name,
               COALESCE(b.name, '') as brand_name
        FROM contracts c
        LEFT JOIN landlords l ON c.landlord_id = l.id
        LEFT JOIN brands b ON c.brand_id = b.id
        WHERE c.contract_type = %s
        ORDER BY c.end_date ASC NULLS LAST
    """, (contract_type,))
    rows = cur.fetchall()

    result = []
    for r in rows:
        end = r.get("end_date")
        days_left = None
        status = "未知"
        if end:
            days_left = (end - today).days
            if days_left < 0:
                status = "已到期"
            elif days_left <= 30:
                status = "临期"
            elif days_left <= 90:
                status = "即将到期"
            else:
                status = "正常"

        partner = r.get("partner") or ""
        if not partner:
            if contract_type == "场地合同":
                partner = r.get("landlord_name") or ""
            else:
                partner = r.get("brand_name") or ""

        result.append({
            "contractId": r["id"],
            "stationName": r.get("landlord_name") or r.get("brand_name") or "",
            "partner": partner,
            "contractType": r.get("contract_type") or contract_type,
            "monthlyRent": float(r.get("monthly_rent") or 0),
            "endDate": str(end) if end else "",
            "daysLeft": days_left,
            "status": status,
        })

    return result
