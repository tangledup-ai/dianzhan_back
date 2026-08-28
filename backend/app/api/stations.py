from fastapi import APIRouter, HTTPException, Request
from ..repositories import meter_repo, electricity_repo, cabinet_repo
from ..repositories.contract_schedule_repo import payment_due_months
from ..infra.auth_scope import scope_landlord_ids
from collections import defaultdict
from .base import CamelJSONResponse

# v3：站点层已移除，本路由仅保留 场地(landlord) 维度接口。
router = APIRouter(prefix="/api/stations", tags=["场地电表"], default_response_class=CamelJSONResponse)


@router.get("/landlord-locations")
async def get_landlord_locations():
    """v3：获取所有场地方的位置信息（用于地图标注）

    坐标来源优先级：场地方的场地合同地图选点（contracts.latitude/longitude）
    > landlords.latitude/longitude。合同上选了点，该场地及其电表均用该坐标。
    """
    from ..infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT l.id, l.name,
                   COALESCE(c.latitude, l.latitude) AS latitude,
                   COALESCE(c.longitude, l.longitude) AS longitude,
                   COALESCE(c.address, l.address) AS address
            FROM landlords l
            LEFT JOIN LATERAL (
                SELECT latitude, longitude, address
                FROM contracts
                WHERE landlord_id = l.id AND contract_type = '场地合同'
                ORDER BY id DESC LIMIT 1
            ) c ON TRUE
            WHERE COALESCE(c.latitude, l.latitude) IS NOT NULL
              AND COALESCE(c.longitude, l.longitude) IS NOT NULL
            ORDER BY l.id
        """)
        rows = cur.fetchall()
        # 状态派生：有正常电表 → 运营中；有电表 → 筹建中；否则已关停
        for r in rows:
            cur.execute("""
                SELECT COUNT(*) FILTER (WHERE status = '正常') as active, COUNT(*) as total
                FROM meters WHERE landlord_id = %s AND meter_no NOT LIKE 'TEST%%'
            """, (r["id"],))
            m = cur.fetchone()
            r["status"] = "运营中" if m["active"] > 0 else ("筹建中" if m["total"] > 0 else "已关停")
            r["code"] = r.get("code") or ""
            r["region"] = ""
        return rows
    finally:
        cur.close()
        conn.close()


@router.get("/landlord/{landlord_id}/meter-view")
async def get_landlord_meter_view(landlord_id: int, period: str = None, request: Request = None):
    """v3：按场地方查看该场地所有电表（按品牌分组），台账按 场地×品牌 取状态"""
    # 股东：只能查看关联场地的数据
    allowed = scope_landlord_ids(request) if request is not None else None
    if allowed is not None and landlord_id not in allowed:
        raise HTTPException(403, "无权查看该场地")

    # 如果未指定月份，默认当月
    if not period:
        from datetime import date
        today = date.today()
        period = today.strftime("%Y-%m")

    # period 统一为 6 位 YYYYMM（electricity_records / meter_monthly 均用 6 位）
    from ..infra.period import to_compact
    elec_period = to_compact(period)

    # 获取该场地所有电表（排除测试电表 + 空表：未关联 landlord/brand 的电表不参与计算）
    meters = [m for m in meter_repo.list_landlord_meters(landlord_id)
              if not str(m.get("meter_no", "")).startswith("TEST")
              and m.get("landlord_id") and m.get("brand_id")]
    meter_ids = [m["id"] for m in meters]

    # 获取每个电表的柜子
    cabinets_by_meter = {}
    for mid in meter_ids:
        cabinets = cabinet_repo.list_cabinets(meter_id=mid)
        cabinets_by_meter[mid] = cabinets

    # 台账状态：按 场地×品牌×月 取记录（v3：electricity_records 按 landlord_id+brand_id+period 存储）
    brand_ids = {m.get("brand_id") for m in meters if m.get("brand_id")}
    records_by_brand = {}
    meter_detail_map = {}
    prev_meter_detail_map = {}
    y, m = int(period[:4]), int(period[5:7])
    prev_m, prev_y = (m - 1, y) if m > 1 else (12, y - 1)
    prev_period = f"{prev_y:04d}{prev_m:02d}"
    for bid in brand_ids:
        rec = electricity_repo.get_record_by_landlord_brand_period(landlord_id, bid, elec_period)
        if rec:
            records_by_brand[int(bid)] = rec
            for d in electricity_repo.get_meter_details(rec["id"]):
                meter_detail_map[d["meter_id"]] = d
        prev_rec = electricity_repo.get_record_by_landlord_brand_period(landlord_id, bid, prev_period)
        if prev_rec:
            for d in electricity_repo.get_meter_details(prev_rec["id"]):
                prev_meter_detail_map[d["meter_id"]] = d

    # 获取合同价格（场地合同=付款单价，品牌方合同=收款单价；按品牌各算各的）
    from ..repositories import contract_repo
    from ..domain.electricity_pricing import resolve_prices, split_tax
    contracts = contract_repo.list_contracts(landlord_id=landlord_id) or []
    pricing = resolve_prices(contracts)
    pay_price = pricing["pay_price"]  # 场地合同唯一付款单价
    brand_prices = pricing["brand_prices"]  # brand_id -> {price, tax_rate, tax_enabled, post_tax}

    # 获取能耗数据（日用电量 + 月用电量）
    from ..infra.database import get_connection, get_dict_cursor
    meter_nos = [m.get("meter_no") for m in meters if m.get("meter_no")]
    daily_energy = []
    monthly_energy = []
    if meter_nos:
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            placeholders = ",".join(["%s"] * len(meter_nos))
            start_d = f"{y}{m:02d}01"
            if m == 12:
                end_d = f"{y + 1}0101"
            else:
                end_d = f"{y}{m + 1:02d}01"
            cur.execute(f"""
                SELECT address, day_date, kwh
                FROM meter_daily
                WHERE address IN ({placeholders}) AND day_date >= %s AND day_date < %s
                ORDER BY day_date
            """, (*meter_nos, start_d, end_d))
            daily_energy = cur.fetchall()

            cur.execute(f"""
                SELECT address, month_period, kwh, actual_kwh
                FROM meter_monthly
                WHERE address IN ({placeholders})
                ORDER BY month_period DESC
                LIMIT 30
            """, meter_nos)
            monthly_energy = cur.fetchall()
        finally:
            cur.close()
            conn.close()

    # 租金数据（v3 主源：contracts；品牌方合同按场地内品牌过滤）
    station_brand_ids = set(m.get("brand_id") for m in meters if m.get("brand_id"))

    # 场地合同（付款侧）
    leases = []
    for c in contracts:
        if c.get("contract_type") != "场地合同":
            continue
        leases.append({
            "id": c.get("id"),
            "landlord_id": c.get("landlord_id"),
            "contract_start": c.get("start_date"),
            "contract_end": c.get("end_date"),
            "annual_rent": c.get("rent_amount"),
            "pay_method": c.get("pay_method"),
            "pay_amount": c.get("rent_amount"),
            "deposit": c.get("deposit"),
            "pay_status": c.get("pay_status"),
            "monthly_rent": c.get("monthly_rent"),
        })

    # 租金收款（品牌方合同 → 收款分期，筛选覆盖该月的）
    from ..repositories import contract_schedule_repo
    rent_receipts = []
    for c in contracts:
        if c.get("contract_type") != "品牌方合同":
            continue
        if c.get("brand_id") and c["brand_id"] not in station_brand_ids:
            continue
        for r in contract_schedule_repo.list_income_schedules(contract_id=c["id"]):
            ps = str(r.get("period_start", ""))[:7]
            pe = str(r.get("period_end", ""))[:7]
            if ps <= period <= pe:
                r["income_id"] = c["id"]
                r["brand_id"] = c.get("brand_id")
                r["brand_name"] = c.get("brand_name")
                rent_receipts.append(r)

    contract_rent = {"cost": [], "income": []}
    for c in contracts:
        if c.get("contract_type") == "场地合同":
            contract_rent["cost"].append({
                "id": c.get("id"),
                "partner": c.get("partner") or c.get("landlord_name"),
                "annualRent": float(c["rent_amount"]) if c.get("rent_amount") else None,
                "monthlyRent": float(c["monthly_rent"]) if c.get("monthly_rent") else None,
                "payMethod": c.get("pay_method"),
                "rentAdvanceDays": int(c.get("rent_advance_days") or 0),
                "startDate": str(c.get("start_date", ""))[:10] if c.get("start_date") else None,
                "endDate": str(c.get("end_date", ""))[:10] if c.get("end_date") else None,
                "payStatus": c.get("pay_status"),
                "allowedMonths": payment_due_months(
                    c.get("start_date"),
                    c.get("early_end_date") or c.get("end_date"),
                    c.get("pay_method"),
                    c.get("rent_advance_days"),
                ),
            })
        elif c.get("contract_type") == "品牌方合同":
            if c.get("brand_id") and c["brand_id"] not in station_brand_ids:
                continue
            # 收款分期（contracts 中已有：按 pay_method 拆期）
            income_scheds = contract_schedule_repo.list_income_schedules(contract_id=c["id"])
            paid_count = sum(1 for s in income_scheds if s.get("status") == "已到账")
            total_count = len(income_scheds)
            # 覆盖所选月份的收款分期区间（如 2026-02-12 ~ 2026-03-11）
            cur_period_sched = None
            for s in income_scheds:
                ps = str(s.get("period_start", ""))[:7]
                pe = str(s.get("period_end", ""))[:7]
                if ps <= period <= pe:
                    cur_period_sched = s
                    break
            contract_rent["income"].append({
                "id": c.get("id"),
                "brandId": c.get("brand_id"),
                "brandName": c.get("brand_name"),
                "annualRent": float(c["rent_amount"]) if c.get("rent_amount") else None,
                "monthlyRent": float(c["monthly_rent"]) if c.get("monthly_rent") else None,
                "payMethod": c.get("pay_method"),
                "startDate": str(c.get("start_date", ""))[:10] if c.get("start_date") else None,
                "endDate": str(c.get("end_date", ""))[:10] if c.get("end_date") else None,
                "payStatus": c.get("pay_status"),
                # 场地收款期间（覆盖所选月的分期区间）与 租金收款情况（已到账 X/Y 期）
                "periodStart": str(cur_period_sched.get("period_start", ""))[:10] if cur_period_sched else None,
                "periodEnd": str(cur_period_sched.get("period_end", ""))[:10] if cur_period_sched else None,
                "paidCount": paid_count,
                "totalCount": total_count,
            })

    # 按品牌分组电表
    brand_groups = defaultdict(list)
    for meter in meters:
        brand_name = meter.get("brand_name") or "未指定品牌"
        brand_groups[brand_name].append(meter)

    # 构建结果
    result_groups = []
    for brand_name in sorted(brand_groups.keys()):
        group_meters = []
        for meter in brand_groups[brand_name]:
            mid = meter["id"]
            md = meter_detail_map.get(mid)
            prev_md = prev_meter_detail_map.get(mid)
            cab_list = cabinets_by_meter.get(mid, [])
            cabinet_nos = [c.get("cabinet_no", "") for c in cab_list if c.get("cabinet_no")]
            cabinet_count = max(1, len(cab_list))

            meter_no = meter.get("meter_no")
            meter_daily = [d for d in daily_energy if d.get("address") == meter_no]
            meter_monthly_data = [d for d in monthly_energy if d.get("address") == meter_no]

            ratio = float(meter.get("transformer_ratio") or 1)
            daily_display = [
                {**d, "kwh": round(float(d["kwh"]) * ratio, 2)} for d in meter_daily if d.get("kwh") is not None
            ]
            monthly_display = []
            for m_ in meter_monthly_data:
                if m_.get("kwh") is None and m_.get("actual_kwh") is None:
                    continue
                if m_.get("actual_kwh") is not None:
                    v = round(float(m_["actual_kwh"]), 2)
                else:
                    v = round(float(m_["kwh"]) * ratio, 2)
                monthly_display.append({**m_, "kwh": v})

            month_period = period.replace("-", "")
            this_month_kwh = None
            prev_month_kwh = None
            for mm in monthly_display:
                if mm.get("month_period") == month_period:
                    this_month_kwh = float(mm["kwh"])
                if mm.get("month_period") == prev_period:
                    prev_month_kwh = float(mm["kwh"])

            meter_brand_id = meter.get("brand_id")
            meter_receipts = [r for r in rent_receipts if r.get("brand_id") == meter_brand_id]

            pay_kwh = this_month_kwh
            collect_kwh = this_month_kwh
            brand_info = brand_prices.get(int(meter_brand_id)) if meter_brand_id is not None else None
            collect_price = float(brand_info["price"]) if brand_info and brand_info.get("price") is not None else None
            tax_enabled_m = bool(brand_info["tax_enabled"]) if brand_info else False
            tax_rate_m = float(brand_info["tax_rate"]) if brand_info else None
            post_tax_m = brand_info.get("post_tax") if brand_info else None
            pay_amount = round(pay_kwh * pay_price, 2) if pay_kwh and pay_price else None
            collect_amount = round(collect_kwh * collect_price, 2) if collect_kwh and collect_price else None
            if collect_amount is not None and tax_enabled_m and tax_rate_m:
                _, collect_net = split_tax(collect_amount, tax_rate_m)
            else:
                collect_net = collect_amount or 0

            brand_record = records_by_brand.get(int(meter_brand_id)) if meter_brand_id is not None else None

            group_meters.append({
                "meterId": mid,
                "meterNo": meter.get("meter_no"),
                "meterName": meter.get("meter_name"),
                "brandName": brand_name,
                "cabinetCount": cabinet_count,
                "cabinetNos": ", ".join(cabinet_nos) if cabinet_nos else "-",
                "prevEndReading": prev_month_kwh,
                "startReading": None,
                "endReading": this_month_kwh,
                "payKwh": pay_kwh,
                "payUnitPrice": pay_price,
                "payAmount": pay_amount,
                "payStatus": brand_record.get("pay_status") if brand_record else "未付款",
                "collectStartDate": None,
                "collectEndDate": None,
                "collectUnitPrice": collect_price,
                "collectAmount": collect_amount,
                "collectStatus": brand_record.get("collect_status") if brand_record else "未到账",
                "collectNet": collect_net,
                "taxRate": tax_rate_m,
                "taxEnabled": tax_enabled_m,
                "postTaxPrice": post_tax_m if (tax_enabled_m and post_tax_m is not None) else collect_price,
                "rentReceipts": meter_receipts,
                "dailyEnergy": daily_display,
                "monthlyEnergy": monthly_display,
            })

        result_groups.append({
            "brandName": brand_name,
            "meters": group_meters,
        })

    # 汇总数据
    total_pay_amount = 0
    total_collect_amount = 0
    total_collect_net = 0
    total_kwh = 0
    total_elec_profit = 0
    total_rent_cost = 0
    total_rent_income = 0
    total_rent_profit = 0

    for group in result_groups:
        for meter in group.get("meters", []):
            if meter.get("payAmount"):
                total_pay_amount += float(meter["payAmount"])
            if meter.get("collectAmount"):
                total_collect_amount += float(meter["collectAmount"])
            if meter.get("collectNet"):
                total_collect_net += float(meter["collectNet"])
            if meter.get("payKwh"):
                total_kwh += float(meter["payKwh"])

    for c in contract_rent.get("cost", []):
        if c.get("monthlyRent"):
            total_rent_cost += float(c["monthlyRent"])
    for c in contract_rent.get("income", []):
        if c.get("monthlyRent"):
            total_rent_income += float(c["monthlyRent"])

    # 租金税费（品牌方合同启用税率：含税月租 − 税后月租），利润扣税，与 Rent 页/分红一致
    rent_tax = 0.0
    for c in contracts:
        if c.get("contract_type") == "品牌方合同" and c.get("brand_id") in station_brand_ids:
            if c.get("rent_tax_enabled") and c.get("post_tax_rent_price"):
                rent_tax += float(c.get("monthly_rent") or 0) - float(c["post_tax_rent_price"])

    total_elec_profit = total_collect_net - total_pay_amount
    total_rent_profit = round(total_rent_income - total_rent_cost - rent_tax, 2)

    landlord_name = None
    if meters and meters[0].get("landlord_name"):
        landlord_name = meters[0]["landlord_name"]

    return {
        "landlordId": landlord_id,
        "landlordName": landlord_name,
        "period": period,
        "brandGroups": result_groups,
        "leases": leases,
        "elecRecords": list(records_by_brand.values()),
        "contractRent": contract_rent,
        "summary": {
            "totalKwh": total_kwh,
            "totalPayAmount": total_pay_amount,
            "totalCollectAmount": total_collect_amount,
            "totalCollectNet": total_collect_net,
            "totalElecProfit": total_elec_profit,
            "totalRentCost": total_rent_cost,
            "totalRentIncome": total_rent_income,
            "totalRentTax": round(rent_tax, 2),
            "totalRentProfit": total_rent_profit,
        },
    }
