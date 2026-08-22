"""异常提醒聚合接口 — 电量同比异常 + 合同到期/应收应付预警

- 电量异常（月级）：本月用电量 vs 去年同期，上涨比例超过配置阈值（alert_configs.elec_yoy_ratio）
- 合同预警：
  - 场地合同（付款）：到期提醒 + 应付分期明细（rent_payment_schedule）
  - 品牌方合同（收款）：到期提醒 + 应收分期明细（rent_income_schedule）
  - 提前天数在「基础档案 → 预警设置」配置（contract_expire_days_venue / _brand）
"""
from fastapi import APIRouter, HTTPException
from ..infra.database import get_connection, get_dict_cursor
from datetime import date, timedelta
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/alerts", tags=["异常提醒"], default_response_class=CamelJSONResponse)


def _get_config(cur) -> dict:
    """读取预警配置（key-value），带默认值"""
    cur.execute("SELECT key, value FROM alert_configs")
    cfg = {r["key"]: r["value"] for r in cur.fetchall()}
    return {
        "elecYoyRatio": float(cfg.get("elec_yoy_ratio", "1.5")),
        "expireDaysVenue": int(cfg.get("contract_expire_days_venue", "30")),
        "expireDaysBrand": int(cfg.get("contract_expire_days_brand", "30")),
    }


@router.get("/config")
async def get_alert_config():
    """预警配置（供基础档案页展示/修改）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        return _get_config(cur)
    finally:
        cur.close()
        conn.close()


@router.put("/config")
async def update_alert_config(data: dict):
    """保存预警配置"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        field_map = {
            "elecYoyRatio": ("elec_yoy_ratio", "电量同比上涨阈值"),
            "expireDaysVenue": ("contract_expire_days_venue", "场地合同到期提前天数"),
            "expireDaysBrand": ("contract_expire_days_brand", "品牌方合同到期提前天数"),
        }
        for key, (db_key, _label) in field_map.items():
            if key in data and data[key] is not None:
                cur.execute(
                    "INSERT INTO alert_configs (key, value, remark, updated_at) VALUES (%s, %s, '', NOW()) "
                    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
                    (db_key, str(data[key])),
                )
        conn.commit()
        return _get_config(cur)
    finally:
        cur.close()
        conn.close()


@router.get("")
async def get_alerts(granularity: str = "monthly", days: int = 3):
    """聚合异常提醒：电量异常（可按日/按月对比）+ 合同到期/应收应付预警

    granularity: daily=最近 N 天日均 vs 前 7 天日均（N 由 days 指定，默认 3 天）；
                 monthly=最近月份 vs 去年同月
    """
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cfg = _get_config(cur)
        if granularity == "daily":
            elec_anomalies = _detect_elec_daily(cur, cfg["elecYoyRatio"], days)
            eff_granularity = "daily"
        else:
            elec_anomalies = _detect_elec_yoy(cur, cfg["elecYoyRatio"])
            eff_granularity = "monthly"
        contract_payments = _get_contract_alerts(cur, "场地合同", cfg["expireDaysVenue"], "pay")
        contract_collections = _get_contract_alerts(cur, "品牌方合同", cfg["expireDaysBrand"], "income")

        return {
            "config": cfg,
            "granularity": eff_granularity,
            "days": days,
            "elecAnomalies": elec_anomalies,
            "contractPayments": contract_payments,
            "contractCollections": contract_collections,
        }
    finally:
        cur.close()
        conn.close()


def _detect_elec_daily(cur, ratio_threshold: float, days: int = 3):
    """电量异常检测（日级，按天聚合）：最近 N 天日均 vs 前 7 天日均（不含最近 N 天）。

    平滑单日波动：把最近 N 天（默认 3 天）的用电量合并对比，比值 = 近 N 天日均 ÷ 前 7 天日均。
    返回按上涨幅度降序。
    """
    days = max(1, min(int(days or 3), 14))
    # 最新一个有数据的一天
    cur.execute("""
        SELECT MAX(day_date) AS latest FROM meter_daily
        WHERE kwh IS NOT NULL AND kwh > 0
    """)
    latest = (cur.fetchone() or {}).get("latest")
    if not latest:
        return []

    # 每电表：近 N 天日均 + 前 7 天日均（基准期 = 最近 N 天之前连续的 7 天）
    cur.execute(f"""
        WITH latest_day AS (
            SELECT MAX(day_date) AS d FROM meter_daily
            WHERE kwh IS NOT NULL AND kwh > 0
        ),
        recent AS (
            SELECT address, day_date, kwh
            FROM meter_daily d, latest_day ld
            WHERE d.day_date > to_char(ld.d::date - INTERVAL '{days} days', 'YYYYMMDD')
              AND d.day_date <= ld.d
              AND d.kwh IS NOT NULL AND d.kwh > 0
        ),
        baseline AS (
            SELECT address, day_date, kwh
            FROM meter_daily d, latest_day ld
            WHERE d.day_date > to_char(ld.d::date - INTERVAL '{days + 7} days', 'YYYYMMDD')
              AND d.day_date <= to_char(ld.d::date - INTERVAL '{days} days', 'YYYYMMDD')
              AND d.kwh IS NOT NULL AND d.kwh > 0
        )
        SELECT
            m.meter_no, m.meter_name, l.name AS station_name, m.landlord_id, m.brand_id,
            b.name AS brand_name,
            ROUND(rec.avg_kwh::numeric, 2) AS cur_kwh,
            ROUND(avg_base.avg_kwh::numeric, 2) AS avg_kwh,
            CASE WHEN avg_base.avg_kwh IS NULL OR avg_base.avg_kwh = 0 THEN NULL
                 ELSE ROUND((rec.avg_kwh::numeric / avg_base.avg_kwh)::numeric, 2) END AS ratio,
            rec.days AS cur_days, avg_base.base_days
        FROM (
            SELECT address, AVG(kwh) AS avg_kwh, COUNT(*) AS days
            FROM recent GROUP BY address
        ) rec
        JOIN meters m ON m.meter_no = rec.address
        LEFT JOIN landlords l ON m.landlord_id = l.id
        LEFT JOIN brands b ON m.brand_id = b.id
        LEFT JOIN (
            SELECT address, AVG(kwh) AS avg_kwh, COUNT(*) AS base_days
            FROM baseline GROUP BY address
        ) avg_base ON avg_base.address = rec.address
        WHERE m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
          AND m.meter_no NOT LIKE 'TEST%%'
    """)
    rows = cur.fetchall()

    anomalies = []
    for r in rows:
        ratio = r.get("ratio")
        if ratio is None:
            continue  # 无基准数据，跳过
        if ratio >= ratio_threshold:
            anomalies.append({
                "stationName": r.get("station_name") or "",
                "brandName": r.get("brand_name") or "",
                "meterNo": r.get("meter_no") or "",
                "meterName": r.get("meter_name") or "",
                "period": latest,
                "prevPeriod": f"近{r.get('base_days') or 7}天日均",
                "currentKwh": round(float(r["cur_kwh"] or 0), 2),
                "prevKwh": round(float(r["avg_kwh"] or 0), 2),
                "ratio": float(ratio),
                "growthPct": round((float(ratio) - 1) * 100, 1),
                "days": r.get("cur_days") or days,
            })

    anomalies.sort(key=lambda x: x["ratio"], reverse=True)
    return anomalies


def _detect_elec_yoy(cur, yoy_ratio: float):
    """电量同比异常检测（月级）：本月 vs 去年同期。

    对比口径：上月（最近一个有完整读数的月份）用电量 vs 去年同月用电量。
    返回上涨比例 ≥ 阈值 的电表（按上涨幅度降序）。
    """
    # 最近一个有数据的月份 = 上月（当月可能不完整）
    cur.execute("""
        SELECT MAX(month_period) AS latest FROM meter_monthly
        WHERE kwh IS NOT NULL AND kwh > 0
    """)
    latest = (cur.fetchone() or {}).get("latest")
    if not latest:
        return []
    y, m = int(latest[:4]), int(latest[4:6])
    # 去年同期：去年同月
    prev_y = y - 1
    prev_period = f"{prev_y:04d}{m:02d}"

    cur.execute("""
        SELECT
            m.meter_no, m.meter_name, l.name AS station_name, m.landlord_id, m.brand_id,
            b.name AS brand_name,
            cur.kwh AS cur_kwh,
            prv.kwh AS prev_kwh,
            CASE WHEN prv.kwh IS NULL OR prv.kwh = 0 THEN NULL
                 ELSE ROUND((cur.kwh::numeric / prv.kwh)::numeric, 2) END AS ratio
        FROM meter_monthly cur
        JOIN meters m ON m.meter_no = cur.address
        LEFT JOIN landlords l ON m.landlord_id = l.id
        LEFT JOIN brands b ON m.brand_id = b.id
        LEFT JOIN meter_monthly prv
               ON prv.address = cur.address AND prv.month_period = %s
        WHERE cur.month_period = %s
          AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
          AND m.meter_no NOT LIKE 'TEST%%'
          AND cur.kwh IS NOT NULL AND cur.kwh > 0
    """, (prev_period, latest))
    rows = cur.fetchall()

    anomalies = []
    for r in rows:
        ratio = r.get("ratio")
        if ratio is None:
            continue  # 无去年同期数据，跳过（无法同比）
        if ratio >= yoy_ratio:
            anomalies.append({
                "stationName": r.get("station_name") or "",
                "brandName": r.get("brand_name") or "",
                "meterNo": r.get("meter_no") or "",
                "meterName": r.get("meter_name") or "",
                "period": latest,
                "prevPeriod": prev_period,
                "currentKwh": round(float(r["cur_kwh"] or 0), 2),
                "prevKwh": round(float(r["prev_kwh"] or 0), 2),
                "ratio": float(ratio),
                "growthPct": round((float(ratio) - 1) * 100, 1),
            })

    anomalies.sort(key=lambda x: x["ratio"], reverse=True)
    return anomalies


def _get_contract_alerts(cur, contract_type: str, expire_days: int, side: str):
    """合同到期 + 应收/付明细预警。

    - 场地合同（side=pay）：我们付给场地方 → 应付分期 rent_payment_schedule
    - 品牌方合同（side=income）：品牌方付给我们 → 应收分期 rent_income_schedule
    返回：到期提醒（剩余天数）+ 分期明细（区间/金额/状态/实付日期/发票）+ 汇总
    """
    today = date.today()
    sched_table = "rent_payment_schedule" if side == "pay" else "rent_income_schedule"
    done_status = ("已付款",) if side == "pay" else ("已到账",)

    cur.execute(f"""
        SELECT
            c.id, c.contract_type, c.partner,
            c.monthly_rent, c.rent_amount, c.pay_method,
            c.start_date, c.end_date, COALESCE(c.early_end_date, c.end_date) AS effective_end,
            COALESCE(l.name, '') AS landlord_name,
            COALESCE(b.name, '') AS brand_name,
            l.contact AS landlord_contact, l.phone AS landlord_phone,
            b.contact AS brand_contact,
            s.seq, s.period_start, s.period_end, s.amount, s.status,
            s.pay_date, s.invoice, s.remark AS sched_remark
        FROM contracts c
        LEFT JOIN landlords l ON c.landlord_id = l.id
        LEFT JOIN brands b ON c.brand_id = b.id
        LEFT JOIN {sched_table} s ON s.contract_id = c.id
        WHERE c.contract_type = %s
        ORDER BY c.id, s.seq
    """, (contract_type,))
    rows = cur.fetchall()

    # 按合同聚合
    contracts = {}
    for r in rows:
        cid = r["id"]
        if cid not in contracts:
            effective_end = r.get("effective_end")
            days_left = None
            status = "未知"
            if effective_end:
                days_left = (effective_end - today).days
                if days_left < 0:
                    status = "已到期"
                elif days_left <= expire_days:
                    status = "临期"
                else:
                    status = "正常"

            contracts[cid] = {
                "contractId": cid,
                "contractType": r.get("contract_type") or contract_type,
                "landlordName": r.get("landlord_name") or "",
                "brandName": r.get("brand_name") or "",
                "landlordContact": r.get("landlord_contact") or "",
                "landlordPhone": r.get("landlord_phone") or "",
                "brandContact": r.get("brand_contact") or "",
                "partner": r.get("partner") or (r.get("landlord_name") or r.get("brand_name") or ""),
                "monthlyRent": float(r.get("monthly_rent") or 0),
                "rentAmount": float(r.get("rent_amount") or 0),
                "payMethod": r.get("pay_method") or "",
                "startDate": str(r.get("start_date"))[:10] if r.get("start_date") else "",
                "endDate": str(r.get("effective_end"))[:10] if r.get("effective_end") else "",
                "daysLeft": days_left,
                "status": status,
                "schedules": [],
                # 汇总
                "totalAmount": 0.0,
                "paidAmount": 0.0,
                "pendingAmount": 0.0,
                "totalCount": 0,
                "paidCount": 0,
                "pendingCount": 0,
                # 逾期（区间已结束仍未收/付）
                "overdueAmount": 0.0,
                "overdueCount": 0,
            }
        c = contracts[cid]
        if r.get("seq") is None:
            continue  # 合同无分期
        amt = float(r.get("amount") or 0)
        is_done = r.get("status") in done_status
        sched = {
            "seq": r["seq"],
            "periodStart": str(r.get("period_start"))[:10] if r.get("period_start") else "",
            "periodEnd": str(r.get("period_end"))[:10] if r.get("period_end") else "",
            "amount": amt,
            "status": r.get("status") or "",
            "payDate": str(r.get("pay_date"))[:10] if r.get("pay_date") else "",
            "invoice": r.get("invoice") or "",
            "remark": r.get("sched_remark") or "",
        }
        c["schedules"].append(sched)
        c["totalAmount"] += amt
        c["totalCount"] += 1
        if is_done:
            c["paidAmount"] += amt
            c["paidCount"] += 1
        else:
            c["pendingAmount"] += amt
            c["pendingCount"] += 1
            # 逾期：分期结束日期早于今天仍未收/付
            period_end = r.get("period_end")
            if period_end and period_end < today:
                c["overdueAmount"] += amt
                c["overdueCount"] += 1

    result = []
    for c in contracts.values():
        # 应收/付比例（用于快速核对）
        total = c["totalAmount"]
        c["paidRatio"] = round(c["paidAmount"] / total, 4) if total else 0.0
        c["overdueAmount"] = round(c["overdueAmount"], 2)
        # 只返回「有提醒价值」的合同：临期 / 已到期 / 有逾期未收未付分期
        if c["status"] in ("已到期", "临期") or c["overdueCount"] > 0:
            result.append(c)

    # 排序：已到期 > 临期（剩余天数少的在前）> 逾期金额大的在前
    result.sort(key=lambda x: (
        -1 if x["status"] == "已到期" else 0,
        x["daysLeft"] if x["daysLeft"] is not None else 9999,
        -x["overdueAmount"],
    ))
    return result
