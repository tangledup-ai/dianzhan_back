from fastapi import APIRouter, Request
from ..infra.database import get_connection, get_dict_cursor
from datetime import date
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/overview", tags=["看板"], default_response_class=CamelJSONResponse)


def _entity_group_name(c: dict) -> str:
    """合同归属公司主体名：优先 entity_id 外键，旧数据回退 pay_entity 文本（与公司主体看板口径一致）"""
    return c.get("entity_name") or (c.get("pay_entity") or "").strip() or "未指定主体"


def _meter_category_overview(cur, tag_scope: str) -> dict:
    """财务类别账号的电表范围总览；只按已关联场地的授权类别电表明细汇总。"""
    from ..infra.period import to_display
    tag_to_code = {"合作商电表": "partner", "民用电表": "civil", "共享电表": "shared"}
    code = tag_to_code[tag_scope]
    cur.execute("""
        SELECT COUNT(*) AS meter_count,
               COUNT(DISTINCT (m.landlord_id, COALESCE(m.brand_id, 0))) AS station_count,
               COUNT(DISTINCT m.landlord_id) AS landlord_count,
               COUNT(DISTINCT m.brand_id) FILTER (WHERE m.brand_id IS NOT NULL) AS brand_count,
               COALESCE(SUM(GREATEST(1, cab.cnt)), 0) AS cabinet_count,
               COUNT(DISTINCT (m.landlord_id, COALESCE(m.brand_id, 0))) FILTER (WHERE m.status = 'active') AS active_station_count
        FROM meters m
        LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM cabinets c WHERE c.meter_id = m.id) cab ON TRUE
        WHERE m.tag = %s AND m.landlord_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%%'
    """, (tag_scope,))
    counts = cur.fetchone() or {}

    cur.execute("""
        SELECT e.period, e.pay_status, e.collect_status, b.name AS brand_name,
               d.kwh, d.pay_amount, d.collect_net
        FROM electricity_meter_details d
        JOIN meters m ON m.id = d.meter_id AND m.landlord_id IS NOT NULL
        JOIN electricity_records e ON e.id = d.electricity_id AND e.landlord_id = m.landlord_id
        LEFT JOIN brands b ON b.id = COALESCE(e.brand_id, m.brand_id)
        WHERE m.tag = %s AND m.meter_no NOT LIKE 'TEST%%' AND COALESCE(d.row_type, 'normal') <> 'loss'
    """, (tag_scope,))
    ledger_rows = cur.fetchall()
    pay = sum(float(r.get("pay_amount") or 0) for r in ledger_rows)
    collect = sum(float(r.get("collect_net") or 0) for r in ledger_rows)
    unpaid = sum(float(r.get("pay_amount") or 0) for r in ledger_rows if r.get("pay_status") == "未付款")
    uncollected = sum(float(r.get("collect_net") or 0) for r in ledger_rows if r.get("collect_status") == "未到账")
    by_month = {}
    by_brand_pay, by_brand_collect = {}, {}
    for r in ledger_rows:
        mp = str(r.get("period") or "")
        brand = r.get("brand_name") or "未指定品牌"
        month = by_month.setdefault(mp, {"period": mp, "kwh": 0.0, "pay": 0.0, "collect": 0.0})
        month["kwh"] += float(r.get("kwh") or 0)
        month["pay"] += float(r.get("pay_amount") or 0)
        month["collect"] += float(r.get("collect_net") or 0)
        bp = by_brand_pay.setdefault(brand, {"count": 0, "amount": 0.0})
        bc = by_brand_collect.setdefault(brand, {"count": 0, "amount": 0.0})
        if r.get("pay_status") == "未付款" and float(r.get("pay_amount") or 0) > 0:
            bp["count"] += 1; bp["amount"] += float(r["pay_amount"])
        if r.get("collect_status") == "未到账" and float(r.get("collect_net") or 0) > 0:
            bc["count"] += 1; bc["amount"] += float(r["collect_net"])

    cur.execute("""
        SELECT COALESCE(SUM(COALESCE(mm.actual_kwh,
                   ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) AS kwh
        FROM meter_readings mm JOIN meters m ON m.id = mm.meter_id
        WHERE m.tag = %s AND m.landlord_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%%'
    """, (tag_scope,))
    total_kwh = float((cur.fetchone() or {}).get("kwh") or 0)
    months = []
    for mp, val in sorted(by_month.items(), reverse=True)[:12]:
        months.append({"period": to_display(mp) if len(mp) == 6 else mp,
                       "kwh": val["kwh"], "elecPay": val["pay"], "elecCollect": val["collect"],
                       "elecProfit": val["collect"] - val["pay"]})

    def bill_group(items):
        rows = [{"brand": k, "count": v["count"], "amount": round(v["amount"], 2)} for k, v in items.items()]
        return {"count": sum(r["count"] for r in rows), "amount": round(sum(r["amount"] for r in rows), 2),
                "byBrand": sorted(rows, key=lambda r: -r["amount"])}

    return {
        "scopeMode": True, "scopeLabel": tag_scope,
        "stationCount": int(counts.get("station_count") or 0),
        "activeStations": int(counts.get("active_station_count") or 0),
        "meterCount": int(counts.get("meter_count") or 0), "cabinetCount": int(counts.get("cabinet_count") or 0),
        "brandCount": int(counts.get("brand_count") or 0), "entityCount": 0,
        "landlordCount": int(counts.get("landlord_count") or 0), "shareholderCount": 0, "introducerCount": 0,
        "bills": {"payable": {"elec": bill_group(by_brand_pay), "site": bill_group({})},
                  "receivable": {"elec": bill_group(by_brand_collect), "site": bill_group({})}},
        "elecPay": round(pay, 2), "elecCollect": round(collect, 2), "elecProfit": round(collect - pay, 2),
        "elecUnpaid": round(unpaid, 2), "elecUncollected": round(uncollected, 2),
        "rentCostTotal": 0, "rentIncomeTotal": 0, "rentTaxTotal": 0, "rentProfitTotal": 0,
        "netProfitTotal": round(collect - pay, 2), "rentUncollected": 0, "opExpenseTotal": 0,
        "pendingDividends": 0, "bizDividendTotal": 0, "shareholderDividendTotal": 0,
        "contractCount": 0, "expiringContracts": 0, "expiredContracts": 0, "overdueContracts": 0,
        "pendingApprovals": 0, "totalKwh": total_kwh, "monthly": months,
    }


def _meter_category_monthly_detail(cur, tag_scope: str, period: str) -> dict:
    from ..infra.period import to_compact
    mp = to_compact(period)
    cur.execute("""
        SELECT d.kwh, d.pay_amount, d.collect_amount, d.collect_net,
               m.meter_no, b.name AS brand_name, l.name AS landlord_name
        FROM electricity_meter_details d
        JOIN meters m ON m.id = d.meter_id AND m.landlord_id IS NOT NULL
        JOIN electricity_records e ON e.id = d.electricity_id AND e.landlord_id = m.landlord_id
        LEFT JOIN landlords l ON l.id = m.landlord_id
        LEFT JOIN brands b ON b.id = COALESCE(e.brand_id, m.brand_id)
        WHERE m.tag = %s AND e.period = %s AND m.meter_no NOT LIKE 'TEST%%'
          AND COALESCE(d.row_type, 'normal') <> 'loss'
    """, (tag_scope, mp))
    rows = cur.fetchall()
    income = sum(float(r.get("collect_net") or 0) for r in rows)
    cost = sum(float(r.get("pay_amount") or 0) for r in rows)
    details = [{"landlordName": r.get("landlord_name") or "", "brandName": r.get("brand_name"),
                "meterNo": r.get("meter_no"), "kwh": float(r.get("kwh") or 0),
                "payAmount": float(r.get("pay_amount") or 0), "collectAmount": float(r.get("collect_amount") or 0),
                "collectNet": float(r.get("collect_net") or 0)} for r in rows]
    cur.execute("""
        SELECT COALESCE(SUM(COALESCE(mm.actual_kwh,
                   ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) AS kwh
        FROM meter_readings mm JOIN meters m ON m.id = mm.meter_id
        WHERE m.tag = %s AND m.landlord_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%%' AND mm.period = %s
    """, (tag_scope, mp))
    total_kwh = float((cur.fetchone() or {}).get("kwh") or 0)
    return {"period": period, "scopeMode": True, "totalKwh": total_kwh,
            "elec": {"income": round(income, 2), "cost": round(cost, 2),
                     "profit": round(income - cost, 2), "details": details},
            "rent": {"income": 0, "cost": 0, "profit": 0, "incomeDetails": [], "costDetails": []},
            "opExpense": {"total": 0, "details": []}, "dividend": {"total": 0, "pending": 0}}


def _shared_cab_weights(period: str, brand_entity_map: dict = None, allowed=None) -> tuple:
    """共享电表「已按品牌录柜数」的柜数权重：((landlord, brand) -> {entity_id: cabs}, landlord -> {entity_id: cabs})

    场地总表（tag='共享电表' 且 brand_id 为空）下各品牌没有自己的电表，「数电表」数不到它们，
    柜数只能取分摊行人工录入值（`meter_shared_allocations.cabinet_count`，按月取值、逐月可调）。

    ⚠️ 调用方在统计整场地柜数时**必须排除**这些已录柜数的共享表，否则整表计数会与品牌柜数双算。

    归属主体优先级：分摊行指定 → 品牌方合同主体（brand_entity_map）→ 共享表自身主体。
    """
    from ..repositories import shared_allocation_repo
    from ..infra.period import to_compact

    period6 = to_compact(period) if period else None
    if not period6:
        return {}, {}
    brand_entity_map = brand_entity_map or {}
    wb, wl = {}, {}
    for item in shared_allocation_repo.shared_meter_cabinets(period=period6):
        lid = item.get("landlordId")
        if lid is None or (allowed is not None and lid not in allowed):
            continue
        if not item.get("managedByAlloc"):
            continue  # 完全没录过柜数 → 由 SQL 侧按「整表至少 1 柜」兜底
        brand_entity = item.get("brandEntity") or {}
        for bid, cabs in (item.get("brandCabs") or {}).items():
            eid = brand_entity.get(bid) or brand_entity_map.get((lid, bid)) or item.get("entityId")
            wb.setdefault((lid, bid), {})
            wb[(lid, bid)][eid] = wb[(lid, bid)].get(eid, 0.0) + float(cabs)
            wl.setdefault(lid, {})
            wl[lid][eid] = wl[lid].get(eid, 0.0) + float(cabs)
    return wb, wl


@router.get("")
async def overview(request: Request):
    """经营总览 API（股东账号只统计其关联场地的数据）- 热重载测试"""
    from ..infra.auth_scope import scope_landlord_ids, scope_meter_tag
    allowed = scope_landlord_ids(request)
    tag_scope = scope_meter_tag(request)
    user = getattr(request.state, "current_user", None)
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        if tag_scope:
            return _meter_category_overview(cur, tag_scope)
        # 品牌组合统计（v3：站点 → 场地×品牌 组合数；active = 组合内有正常电表）
        if allowed is not None:
            cur.execute("""
                SELECT COUNT(*) as total,
                       COUNT(*) FILTER (WHERE EXISTS (
                           SELECT 1 FROM meters m2
                           WHERE m2.landlord_id = t.landlord_id AND m2.brand_id = t.brand_id
                             AND m2.status = 'active' AND m2.meter_no NOT LIKE 'TEST%'
                       )) as active
                FROM (SELECT DISTINCT landlord_id, brand_id FROM meters
                      WHERE landlord_id IS NOT NULL AND brand_id IS NOT NULL AND meter_no NOT LIKE 'TEST%') t
                WHERE t.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT COUNT(*) as total,
                       COUNT(*) FILTER (WHERE EXISTS (
                           SELECT 1 FROM meters m2
                           WHERE m2.landlord_id = t.landlord_id AND m2.brand_id = t.brand_id
                             AND m2.status = 'active' AND m2.meter_no NOT LIKE 'TEST%'
                       )) as active
                FROM (SELECT DISTINCT landlord_id, brand_id FROM meters
                      WHERE landlord_id IS NOT NULL AND brand_id IS NOT NULL AND meter_no NOT LIKE 'TEST%') t
            """)
        station_stats = cur.fetchone()

        # 电表数量 / 总换电柜数量（v3：电表直接挂 landlord_id，不再经 stations）
        # 柜数口径：每块电表至少 1 柜（max(1, 实际柜子数)），与合同/分红一致
        if allowed is not None:
            cur.execute("SELECT COUNT(*) as total FROM meters WHERE landlord_id = ANY(%s::int[]) AND meter_no NOT LIKE 'TEST%'", (allowed,))
            meter_count = cur.fetchone()["total"]
            cur.execute("""
                SELECT COALESCE(SUM(GREATEST(1, cab_cnt)), 0) as total FROM (
                    SELECT m.id, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id) AS cab_cnt
                    FROM meters m
                    WHERE m.landlord_id = ANY(%s::int[]) AND m.meter_no NOT LIKE 'TEST%'
                ) t
            """, (allowed,))
        else:
            cur.execute("SELECT COUNT(*) as total FROM meters WHERE meter_no NOT LIKE 'TEST%'")
            meter_count = cur.fetchone()["total"]
            cur.execute("""
                SELECT COALESCE(SUM(GREATEST(1, cab_cnt)), 0) as total FROM (
                    SELECT m.id, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id) AS cab_cnt
                    FROM meters m WHERE m.meter_no NOT LIKE 'TEST%'
                ) t
            """)
        cabinet_count = cur.fetchone()["total"]

        # 品牌方、公司主体、场地方、股东、介绍人数量
        counts = {}
        if allowed is not None:
            cur.execute("SELECT COUNT(*) as total FROM landlords WHERE id = ANY(%s::int[])", (allowed,))
            counts["landlords"] = cur.fetchone()["total"]
        else:
            cur.execute("SELECT COUNT(*) as total FROM landlords")
            counts["landlords"] = cur.fetchone()["total"]
        for table in ["brands", "entities", "introducers"]:
            cur.execute(f"SELECT COUNT(*) as total FROM {table}")
            counts[table] = cur.fetchone()["total"]
        if user and user.get("role") == "shareholder" and user.get("shareholder_id"):
            counts["shareholders"] = 1
        else:
            cur.execute("SELECT COUNT(*) as total FROM shareholders")
            counts["shareholders"] = cur.fetchone()["total"]

        # 电费统计（v3：台账挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT
                    COALESCE(SUM(e.pay_amount), 0) as total_pay,
                    COALESCE(SUM(e.collect_net), 0) as total_collect,
                    COALESCE(SUM(e.profit), 0) as total_profit,
                    COALESCE(SUM(CASE WHEN e.pay_status = '未付款' THEN e.pay_amount ELSE 0 END), 0) as unpaid,
                    COALESCE(SUM(CASE WHEN e.collect_status = '未到账' THEN e.collect_net ELSE 0 END), 0) as uncollected
                FROM electricity_records e
                WHERE e.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT
                    COALESCE(SUM(pay_amount), 0) as total_pay,
                    COALESCE(SUM(collect_net), 0) as total_collect,
                    COALESCE(SUM(profit), 0) as total_profit,
                    COALESCE(SUM(CASE WHEN pay_status = '未付款' THEN pay_amount ELSE 0 END), 0) as unpaid,
                    COALESCE(SUM(CASE WHEN collect_status = '未到账' THEN collect_net ELSE 0 END), 0) as uncollected
                FROM electricity_records
            """)
        elec = cur.fetchone()

        # 总电量（真实表码度数，从 meter_readings 汇总；v3：电表挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) as total_kwh
                FROM meter_readings mm
                JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                WHERE m.meter_no NOT LIKE 'TEST%' AND m.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) as total_kwh
                FROM meter_readings mm
                JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                WHERE m.meter_no NOT LIKE 'TEST%'
            """)
        total_kwh = cur.fetchone()["total_kwh"]

        # 租金统计（contracts：品牌方合同月租=收入，场地合同月租=成本）
        if allowed is not None:
            cur.execute("SELECT COALESCE(SUM(monthly_rent), 0) as total FROM contracts WHERE contract_type = '品牌方合同' AND landlord_id = ANY(%s::int[])", (allowed,))
            rent_income = cur.fetchone()["total"]
            cur.execute("SELECT COALESCE(SUM(monthly_rent), 0) as total FROM contracts WHERE contract_type = '场地合同' AND landlord_id = ANY(%s::int[])", (allowed,))
            rent_cost = cur.fetchone()["total"]
            # 租金应收未到账（v3：品牌方合同收款分期未到账）
            cur.execute("""
                SELECT COALESCE(SUM(CASE WHEN rs.status = '未到账' THEN rs.amount ELSE 0 END), 0) as uncollected
                FROM rent_income_schedule rs
                JOIN contracts c ON rs.contract_id = c.id
                WHERE c.contract_type = '品牌方合同' AND c.landlord_id = ANY(%s::int[])
            """, (allowed,))
            rent_uncollected = cur.fetchone()["uncollected"]
            # 租金税费（品牌方合同启用税率：含税月租 − 税后月租；租金利润扣税，与 Rent 页一致）
            cur.execute("""
                SELECT COALESCE(SUM(monthly_rent - post_tax_rent_price), 0) as tax
                FROM contracts
                WHERE contract_type = '品牌方合同' AND rent_tax_enabled = TRUE
                  AND post_tax_rent_price IS NOT NULL AND landlord_id = ANY(%s::int[])
            """, (allowed,))
            rent_tax_total = cur.fetchone()["tax"]
        else:
            cur.execute("SELECT COALESCE(SUM(monthly_rent), 0) as total FROM contracts WHERE contract_type = '品牌方合同'")
            rent_income = cur.fetchone()["total"]
            cur.execute("SELECT COALESCE(SUM(monthly_rent), 0) as total FROM contracts WHERE contract_type = '场地合同'")
            rent_cost = cur.fetchone()["total"]
            cur.execute("""
                SELECT COALESCE(SUM(CASE WHEN status = '未到账' THEN amount ELSE 0 END), 0) as uncollected
                FROM rent_income_schedule
            """)
            rent_uncollected = cur.fetchone()["uncollected"]
            cur.execute("""
                SELECT COALESCE(SUM(monthly_rent - post_tax_rent_price), 0) as tax
                FROM contracts
                WHERE contract_type = '品牌方合同' AND rent_tax_enabled = TRUE
                  AND post_tax_rent_price IS NOT NULL
            """)
            rent_tax_total = cur.fetchone()["tax"]

        # 运营费用（v3：挂 landlord_id）
        if allowed is not None:
            cur.execute("SELECT COALESCE(SUM(amount), 0) as total FROM operating_expenses WHERE landlord_id = ANY(%s::int[])", (allowed,))
        else:
            cur.execute("SELECT COALESCE(SUM(amount), 0) as total FROM operating_expenses")
        op_total = cur.fetchone()["total"]

        # 分红统计（v3：挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE d.status = '未结算') as pending,
                    COALESCE(SUM(CASE WHEN d.type = '商务分红' THEN d.profit ELSE 0 END), 0) as biz_total,
                    COALESCE(SUM(CASE WHEN d.type = '股东分红' THEN d.profit ELSE 0 END), 0) as shareholder_total
                FROM dividend_records d
                WHERE d.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE status = '未结算') as pending,
                    COALESCE(SUM(CASE WHEN type = '商务分红' THEN profit ELSE 0 END), 0) as biz_total,
                    COALESCE(SUM(CASE WHEN type = '股东分红' THEN profit ELSE 0 END), 0) as shareholder_total
                FROM dividend_records
            """)
        div_stats = cur.fetchone()

        # 合同统计（口径与「异常预警 → 合同预警」页一致：到期日=COALESCE(early_end_date,end_date)、
        # 临期窗口读预警配置、含逾期未收/付分期；区别于旧的 end_date + 固定90天简化统计）
        from .alerts import _get_config, _get_contract_alerts
        cfg = _get_config(cur)
        contract_alerts = (
            _get_contract_alerts(cur, "场地合同", cfg["expireDaysVenue"], "pay")
            + _get_contract_alerts(cur, "品牌方合同", cfg["expireDaysBrand"], "income")
        )
        if allowed is not None:
            allowed_set = set(allowed)
            contract_alerts = [c for c in contract_alerts if c.get("landlordId") in allowed_set]
        expired = sum(1 for c in contract_alerts if c["status"] == "已到期")
        expiring = sum(1 for c in contract_alerts if c["status"] == "临期")
        overdue_only = sum(1 for c in contract_alerts if c["status"] not in ("已到期", "临期"))
        if allowed is not None:
            cur.execute("SELECT COUNT(*) as total FROM contracts WHERE landlord_id = ANY(%s::int[])", (allowed,))
            contract_total = cur.fetchone()["total"]
        else:
            cur.execute("SELECT COUNT(*) as total FROM contracts")
            contract_total = cur.fetchone()["total"]

        # 审批统计（v3：审批单挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT COUNT(*) as total FROM approval_requests
                WHERE status = '审批中' AND landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("SELECT COUNT(*) as total FROM approval_requests WHERE status = '审批中'")
        pending_approvals = cur.fetchone()["total"]

        # 月度趋势（电费台账 + 真实表码度数；v3：台账挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT e.period,
                       COALESCE(SUM(e.pay_amount), 0) as pay,
                       COALESCE(SUM(e.collect_net), 0) as collect,
                       COALESCE(SUM(e.profit), 0) as profit,
                       COALESCE((
                           SELECT SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2)))
                           FROM meter_readings mm
                           JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                           WHERE mm.month_period = e.period AND m.meter_no NOT LIKE 'TEST%' AND m.landlord_id = ANY(%s::int[])
                       ), 0) as kwh
                FROM electricity_records e
                WHERE e.landlord_id = ANY(%s::int[])
                GROUP BY e.period
                ORDER BY e.period DESC
                LIMIT 12
            """, (allowed, allowed))
        else:
            cur.execute("""
                SELECT e.period,
                       COALESCE(SUM(e.pay_amount), 0) as pay,
                       COALESCE(SUM(e.collect_net), 0) as collect,
                       COALESCE(SUM(e.profit), 0) as profit,
                       COALESCE((
                           SELECT SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2)))
                           FROM meter_readings mm
                           JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                           WHERE mm.month_period = e.period AND m.meter_no NOT LIKE 'TEST%'
                       ), 0) as kwh
                FROM electricity_records e
                GROUP BY e.period
                ORDER BY e.period DESC
                LIMIT 12
            """)
        monthly = cur.fetchall()

        # ── 账单统计（应付/应收 × 电费/场地费，按品牌方区分；v3：台账/合同已挂 landlord_id）──
        # 电费应付（未付款）：按台账记录的品牌归集（brand_id 空 = 整场地）
        if allowed is not None:
            cur.execute("""
                SELECT e.brand_id, b.name as brand_name, e.pay_amount, e.pay_status, e.collect_net, e.collect_status
                FROM electricity_records e
                LEFT JOIN brands b ON e.brand_id = b.id
                WHERE e.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT e.brand_id, b.name as brand_name, e.pay_amount, e.pay_status, e.collect_net, e.collect_status
                FROM electricity_records e
                LEFT JOIN brands b ON e.brand_id = b.id
            """)
        elec_rows = cur.fetchall()

        # 场地费应付（场地合同未付款；以分期推导为准——无分期或存在未付款分期视为应付）
        if allowed is not None:
            cur.execute("""
                SELECT c.monthly_rent, l.name as landlord_name
                FROM contracts c
                LEFT JOIN landlords l ON c.landlord_id = l.id
                WHERE c.contract_type = '场地合同' AND c.landlord_id = ANY(%s::int[])
                  AND NOT (
                        EXISTS (SELECT 1 FROM rent_payment_schedule s WHERE s.contract_id = c.id)
                    AND NOT EXISTS (SELECT 1 FROM rent_payment_schedule s WHERE s.contract_id = c.id AND s.status <> '已付款')
                  )
            """, (allowed,))
        else:
            cur.execute("""
                SELECT c.monthly_rent, l.name as landlord_name
                FROM contracts c
                LEFT JOIN landlords l ON c.landlord_id = l.id
                WHERE c.contract_type = '场地合同'
                  AND NOT (
                        EXISTS (SELECT 1 FROM rent_payment_schedule s WHERE s.contract_id = c.id)
                    AND NOT EXISTS (SELECT 1 FROM rent_payment_schedule s WHERE s.contract_id = c.id AND s.status <> '已付款')
                  )
            """)
        site_pay_rows = cur.fetchall()

        # 场地费应收（品牌方合同收款分期未到账；v3：rent_income_schedule）
        if allowed is not None:
            cur.execute("""
                SELECT rs.amount, b.name as brand_name
                FROM rent_income_schedule rs
                JOIN contracts c ON rs.contract_id = c.id
                LEFT JOIN brands b ON c.brand_id = b.id
                WHERE rs.status = '未到账' AND c.contract_type = '品牌方合同' AND c.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT rs.amount, b.name as brand_name
                FROM rent_income_schedule rs
                JOIN contracts c ON rs.contract_id = c.id
                LEFT JOIN brands b ON c.brand_id = b.id
                WHERE rs.status = '未到账' AND c.contract_type = '品牌方合同'
            """)
        site_recv_rows = cur.fetchall()

        # 汇总（byBrand 以金额降序）
        def empty_bills_group():
            return {"count": 0, "amount": 0.0, "byBrand": {}}

        def add_to_group(group, brand, amount):
            group["count"] += 1
            group["amount"] += amount
            bg = group["byBrand"].setdefault(brand, {"count": 0, "amount": 0.0})
            bg["count"] += 1
            bg["amount"] += amount

        payable_elec = empty_bills_group()
        receivable_elec = empty_bills_group()
        for r in elec_rows:
            brand = r.get("brand_name") or "整场地"
            pay_amt = float(r["pay_amount"] or 0)
            recv_amt = float(r["collect_net"] or 0)
            if r["pay_status"] == "未付款" and pay_amt > 0:
                add_to_group(payable_elec, brand, pay_amt)
            if r["collect_status"] == "未到账" and recv_amt > 0:
                add_to_group(receivable_elec, brand, recv_amt)

        payable_site = empty_bills_group()
        for r in site_pay_rows:
            add_to_group(payable_site, r["landlord_name"] or "未指定", float(r["monthly_rent"] or 0))

        receivable_site = empty_bills_group()
        for r in site_recv_rows:
            add_to_group(receivable_site, r["brand_name"] or "未指定", float(r["amount"] or 0))

        def fmt_group(group):
            brands = sorted(
                ({"brand": k, "count": v["count"], "amount": round(v["amount"], 2)} for k, v in group["byBrand"].items()),
                key=lambda x: -x["amount"],
            )
            return {"count": group["count"], "amount": round(group["amount"], 2), "byBrand": brands}

        bills = {
            "payable": {
                "elec": fmt_group(payable_elec),
                "site": fmt_group(payable_site),
            },
            "receivable": {
                "elec": fmt_group(receivable_elec),
                "site": fmt_group(receivable_site),
            },
        }

        return {
            "stationCount": station_stats["total"],
            "activeStations": station_stats["active"],
            "meterCount": meter_count,
            "cabinetCount": cabinet_count,
            "bills": bills,
            "brandCount": counts["brands"],
            "entityCount": counts["entities"],
            "landlordCount": counts["landlords"],
            "shareholderCount": counts["shareholders"],
            "introducerCount": counts["introducers"],
            "elecPay": float(elec["total_pay"]),
            "elecCollect": float(elec["total_collect"]),
            "elecProfit": float(elec["total_profit"]),
            "elecUnpaid": float(elec["unpaid"]),
            "elecUncollected": float(elec["uncollected"]),
            "rentCostTotal": float(rent_cost),
            "rentIncomeTotal": float(rent_income),
            "rentTaxTotal": float(rent_tax_total),
            "rentProfitTotal": round(float(rent_income) - float(rent_cost) - float(rent_tax_total), 2),
            "netProfitTotal": round(float(elec["total_profit"]) + float(rent_income) - float(rent_cost) - float(rent_tax_total) - float(op_total), 2),
            "rentUncollected": float(rent_uncollected),
            "opExpenseTotal": float(op_total),
            "pendingDividends": div_stats["pending"],
            "bizDividendTotal": float(div_stats["biz_total"]),
            "shareholderDividendTotal": float(div_stats["shareholder_total"]),
            "contractCount": contract_total,
            "expiringContracts": expiring,
            "expiredContracts": expired,
            "overdueContracts": overdue_only,
            "pendingApprovals": pending_approvals,
            "totalKwh": float(total_kwh),
            "monthly": [{
                "period": r["period"][:4] + "-" + r["period"][4:] if len(r["period"]) == 6 else r["period"],
                "kwh": float(r["kwh"]),
                "elecPay": float(r["pay"]),
                "elecCollect": float(r["collect"]),
                "elecProfit": float(r["profit"]),
            } for r in monthly],
        }
    finally:
        cur.close()
        conn.close()


@router.get("/monthly-detail")
async def monthly_detail(request: Request, period: str = None):
    """某月的运营情况明细（电费/场租/电量/运营费/分红），供首页月份选择器使用"""
    from ..infra.auth_scope import scope_landlord_ids, scope_meter_tag
    allowed = scope_landlord_ids(request)
    tag_scope = scope_meter_tag(request)
    if not period:
        from datetime import date
        today = date.today()
        period = today.strftime("%Y-%m")
    month_compact = period.replace("-", "")

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        if tag_scope:
            return _meter_category_monthly_detail(cur, tag_scope, period)
        # 1) 总电量（v3：电表挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) as kwh
                FROM meter_readings mm
                JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                WHERE mm.month_period = %s AND m.meter_no NOT LIKE 'TEST%%' AND m.landlord_id = ANY(%s::int[])
            """, (month_compact, allowed))
        else:
            cur.execute("""
                SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) as kwh
                FROM meter_readings mm
                JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                WHERE mm.month_period = %s AND m.meter_no NOT LIKE 'TEST%%'
            """, (month_compact,))
        total_kwh = cur.fetchone()["kwh"]

        # 2) 电费台账明细（v3：台账挂 landlord_id，直接取 landlord_name）
        if allowed is not None:
            cur.execute("""
                SELECT e.id, e.landlord_id, l.name as landlord_name, b.name as brand_name,
                       e.pay_amount, e.collect_net, e.profit
                FROM electricity_records e
                LEFT JOIN landlords l ON e.landlord_id = l.id
                LEFT JOIN brands b ON e.brand_id = b.id
                WHERE e.period = %s AND e.landlord_id = ANY(%s::int[])
            """, (month_compact, allowed))
        else:
            cur.execute("""
                SELECT e.id, e.landlord_id, l.name as landlord_name, b.name as brand_name,
                       e.pay_amount, e.collect_net, e.profit
                FROM electricity_records e
                LEFT JOIN landlords l ON e.landlord_id = l.id
                LEFT JOIN brands b ON e.brand_id = b.id
                WHERE e.period = %s
            """, (month_compact,))
        elec_records = cur.fetchall()
        elec_income = sum(float(r["collect_net"] or 0) for r in elec_records)
        elec_cost = sum(float(r["pay_amount"] or 0) for r in elec_records)
        elec_profit = sum(float(r["profit"] or 0) for r in elec_records)

        # 电费分表明细（每台电表，JOIN meters/brands 取名；v3：按台账 landlord 过滤）
        elec_details = []
        if elec_records:
            if allowed is not None:
                cur.execute("""
                    SELECT d.electricity_id, m.meter_no, b.name as brand_name,
                           d.kwh, d.pay_amount, d.collect_amount, d.collect_net
                    FROM electricity_meter_details d
                    LEFT JOIN electricity_records er ON d.electricity_id = er.id
                    LEFT JOIN meters m ON d.meter_id = m.id
                    LEFT JOIN brands b ON COALESCE(er.brand_id, m.brand_id) = b.id
                    WHERE er.period = %s AND er.landlord_id = ANY(%s::int[])
                """, (month_compact, allowed))
            else:
                cur.execute("""
                    SELECT d.electricity_id, m.meter_no, b.name as brand_name,
                           d.kwh, d.pay_amount, d.collect_amount, d.collect_net
                    FROM electricity_meter_details d
                    LEFT JOIN electricity_records er ON d.electricity_id = er.id
                    LEFT JOIN meters m ON d.meter_id = m.id
                    LEFT JOIN brands b ON COALESCE(er.brand_id, m.brand_id) = b.id
                    WHERE er.period = %s
                """, (month_compact,))
            detail_rows = cur.fetchall()
            landlord_of = {r["id"]: r["landlord_name"] for r in elec_records}
            for d in detail_rows:
                ld = landlord_of.get(d["electricity_id"], "")
                elec_details.append({
                    "landlordName": ld,
                    "brandName": d["brand_name"],
                    "meterNo": d["meter_no"],
                    "kwh": float(d["kwh"] or 0),
                    "payAmount": float(d["pay_amount"] or 0),
                    "collectAmount": float(d["collect_amount"] or 0),
                    "collectNet": float(d["collect_net"] or 0),
                })

        # 3) 场租收支（contracts：品牌方合同=收入，场地合同=成本；#6 收入按当月口径：首月/退款与分红一致）
        from ..domain.electricity_pricing import rent_income_for_period, rent_refund_for_period
        if allowed is not None:
            cur.execute("""
                SELECT c.brand_id, c.landlord_id, b.name as brand_name, c.monthly_rent,
                       c.start_date, c.end_date, c.early_end_date, c.first_month_rent, c.rent_refund,
                       c.rent_tax_enabled, c.post_tax_rent_price,
                       c.entity_id, e.name as entity_name, c.pay_entity
                FROM contracts c LEFT JOIN brands b ON c.brand_id = b.id
                LEFT JOIN entities e ON c.entity_id = e.id
                WHERE c.contract_type = '品牌方合同' AND c.landlord_id = ANY(%s::int[])
            """, (allowed,))
            rent_income_contracts = cur.fetchall()
            cur.execute("""
                SELECT c.landlord_id, l.name as landlord_name, c.monthly_rent,
                       c.entity_id, e.name as entity_name, c.pay_entity
                FROM contracts c LEFT JOIN landlords l ON c.landlord_id = l.id
                LEFT JOIN entities e ON c.entity_id = e.id
                WHERE c.contract_type = '场地合同' AND c.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT c.brand_id, c.landlord_id, b.name as brand_name, c.monthly_rent,
                       c.start_date, c.end_date, c.early_end_date, c.first_month_rent, c.rent_refund,
                       c.rent_tax_enabled, c.post_tax_rent_price,
                       c.entity_id, e.name as entity_name, c.pay_entity
                FROM contracts c LEFT JOIN brands b ON c.brand_id = b.id
                LEFT JOIN entities e ON c.entity_id = e.id
                WHERE c.contract_type = '品牌方合同'
            """)
            rent_income_contracts = cur.fetchall()
            cur.execute("""
                SELECT c.landlord_id, l.name as landlord_name, c.monthly_rent,
                       c.entity_id, e.name as entity_name, c.pay_entity
                FROM contracts c LEFT JOIN landlords l ON c.landlord_id = l.id
                LEFT JOIN entities e ON c.entity_id = e.id
                WHERE c.contract_type = '场地合同'
            """)
        rent_cost_contracts = cur.fetchall()
        rent_income = round(sum(rent_income_for_period(c, month_compact) for c in rent_income_contracts)
                            - sum(rent_refund_for_period(c, month_compact) for c in rent_income_contracts), 2)
        rent_cost = sum(float(c["monthly_rent"] or 0) for c in rent_cost_contracts)
        # 租金税费（品牌方合同启用租金税率时：含税月租 − 税后月租）；租金利润扣税（与 Rent 页一致）
        rent_tax = sum(
            (float(c["monthly_rent"] or 0) - float(c["post_tax_rent_price"]))
            for c in rent_income_contracts
            if c.get("rent_tax_enabled") and c.get("post_tax_rent_price")
        )
        rent_profit = round(rent_income - rent_cost - rent_tax, 2)

        # 电表柜数权重（主体归属：与主体损益表同口径；每块计费电表至少 1 柜）
        # 已按品牌录柜数的共享电表必须排除（其柜数按品牌/主体归属，见下方叠加），否则整表计数双算
        cur.execute(f"""
            SELECT m.landlord_id, m.entity_id, m.brand_id,
                   COALESCE(SUM(GREATEST(1, cab.cnt)), 0) AS cabs
            FROM meters m
            LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM cabinets cab WHERE cab.meter_id = m.id) cab ON TRUE
            WHERE m.landlord_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%%'
              AND (m.brand_id IS NOT NULL
                   OR (m.is_shared = TRUE AND m.brand_id IS NULL AND NOT EXISTS (
                         SELECT 1 FROM meter_shared_allocations sa
                         WHERE sa.meter_id = m.id AND sa.cabinet_count IS NOT NULL)))
              {'AND m.landlord_id = ANY(%s::int[])' if allowed is not None else ''}
            GROUP BY m.landlord_id, m.entity_id, m.brand_id
        """, (allowed,) if allowed is not None else ())
        weights_brand: dict = {}   # (landlord, brand) -> {entity_id: 柜数}
        weights_ll: dict = {}      # landlord -> {entity_id: 柜数}
        for r in cur.fetchall():
            cabs = float(r["cabs"] or 0)
            weights_brand.setdefault((r["landlord_id"], r["brand_id"]), {}).setdefault(r["entity_id"], 0.0)
            weights_brand[(r["landlord_id"], r["brand_id"])][r["entity_id"]] += cabs
            weights_ll.setdefault(r["landlord_id"], {}).setdefault(r["entity_id"], 0.0)
            weights_ll[r["landlord_id"]][r["entity_id"]] += cabs

        # 共享电表按品牌录入的柜数：归到「品牌 → 报税主体」，与合同页/分红同口径
        brand_entity_of = {}
        for c in rent_income_contracts:
            _lid, _bid, _eid = c.get("landlord_id"), c.get("brand_id"), c.get("entity_id")
            if _bid is not None and _eid is not None:
                brand_entity_of.setdefault((_lid, _bid), _eid)
        _wb, _wl = _shared_cab_weights(month_compact, brand_entity_of, allowed)
        for _k, _emap in _wb.items():
            weights_brand.setdefault(_k, {})
            for _eid, _c in _emap.items():
                weights_brand[_k][_eid] = weights_brand[_k].get(_eid, 0.0) + _c
        for _lid, _emap in _wl.items():
            weights_ll.setdefault(_lid, {})
            for _eid, _c in _emap.items():
                weights_ll[_lid][_eid] = weights_ll[_lid].get(_eid, 0.0) + _c
        cur.execute("SELECT id, name FROM entities")
        entity_names = {r["id"]: r["name"] for r in cur.fetchall()}

        def _split_by_cabs(amount: float, wmap: dict) -> list:
            """按柜数权重把金额拆到主体；无权重时整笔归未指定（None）。
            每片舍入到分，尾差归占比最大的主体，保证各片合计等于总额"""
            total_w = sum(w for w in wmap.values() if w > 0)
            if total_w <= 0:
                return [(None, round(amount, 2))]
            amount = round(amount, 2)
            eids = [e for e in wmap if wmap[e] > 0]
            if len(eids) == 1:
                return [(eids[0], amount)]
            biggest = max(eids, key=lambda e: wmap[e])
            out, rest = [], amount
            for eid in eids:
                if eid == biggest:
                    continue
                share = round(amount * wmap[eid] / total_w, 2)
                out.append((eid, share))
                rest = round(rest - share, 2)
            out.append((biggest, rest))
            return out

        def _group_name(eid) -> str:
            return (entity_names.get(eid) if eid is not None else None) or "未指定主体"

        # 明细按公司主体汇总（收入含首月/退款当月口径，成本为月租金合计）。
        # 所有合同一律按电表柜数分摊到各主体（收入按场地+品牌电表，场地成本按场地全部计费电表）；
        # contracts.entity_id 仅作电表默认报税主体（新表跟随值），不参与分摊。
        income_groups: dict = {}
        for c in rent_income_contracts:
            amount = rent_income_for_period(c, month_compact) - rent_refund_for_period(c, month_compact)
            allocs = _split_by_cabs(amount, weights_brand.get((c.get("landlord_id"), c.get("brand_id")), {}))
            for eid, share in allocs:
                name = _group_name(eid)
                g = income_groups.setdefault(name, {"entityName": name, "contractCount": 0, "amount": 0.0})
                g["contractCount"] += 1
                g["amount"] += share
        cost_groups: dict = {}
        for c in rent_cost_contracts:
            amount = float(c["monthly_rent"] or 0)
            allocs = _split_by_cabs(amount, weights_ll.get(c.get("landlord_id"), {}))
            for eid, share in allocs:
                name = _group_name(eid)
                g = cost_groups.setdefault(name, {"entityName": name, "contractCount": 0, "amount": 0.0})
                g["contractCount"] += 1
                g["amount"] += share
        rent_income_details = sorted(income_groups.values(), key=lambda g: -g["amount"])
        rent_cost_details = sorted(cost_groups.values(), key=lambda g: -g["amount"])

        # 4) 运营费用（v3：挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT o.landlord_id, l.name as landlord_name, o.amount, o.remark
                FROM operating_expenses o LEFT JOIN landlords l ON o.landlord_id = l.id
                WHERE o.period = %s AND o.landlord_id = ANY(%s::int[])
            """, (month_compact, allowed))
        else:
            cur.execute("""
                SELECT o.landlord_id, l.name as landlord_name, o.amount, o.remark
                FROM operating_expenses o LEFT JOIN landlords l ON o.landlord_id = l.id
                WHERE o.period = %s
            """, (month_compact,))
        op_expenses = cur.fetchall()
        op_total = sum(float(o["amount"] or 0) for o in op_expenses)

        # 5) 分红（v3：挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT COALESCE(SUM(d.profit), 0) as total,
                       COUNT(*) FILTER (WHERE d.status = '未结算') as pending
                FROM dividend_records d
                WHERE d.period = %s AND d.landlord_id = ANY(%s::int[])
            """, (month_compact, allowed))
        else:
            cur.execute("""
                SELECT COALESCE(SUM(profit), 0) as total,
                       COUNT(*) FILTER (WHERE status = '未结算') as pending
                FROM dividend_records WHERE period = %s
            """, (month_compact,))
        div = cur.fetchone()

        return {
            "period": period,
            "totalKwh": float(total_kwh),
            "elec": {
                "income": round(elec_income, 2),
                "cost": round(elec_cost, 2),
                "profit": round(elec_profit, 2),
                "details": elec_details,
            },
            "rent": {
                "income": round(rent_income, 2),
                "cost": round(rent_cost, 2),
                "profit": rent_profit,
                "incomeDetails": [{**g, "amount": round(g["amount"], 2)} for g in rent_income_details],
                "costDetails": [{**g, "amount": round(g["amount"], 2)} for g in rent_cost_details],
            },
            "opExpense": {
                "total": round(op_total, 2),
                "details": [{ "landlordName": o["landlord_name"] or "未指定", "amount": float(o["amount"] or 0), "remark": o["remark"] } for o in op_expenses],
            },
            "dividend": {
                "total": round(float(div["total"] or 0), 2),
                "pending": div["pending"],
            },
        }
    finally:
        cur.close()
        conn.close()


@router.get("/station-board")
async def station_board(request: Request, landlordId: int = None, keyword: str = None, period: str = None):
    """站点看板（按场地方分组）"""
    from ..infra.auth_scope import scope_landlord_ids
    allowed = scope_landlord_ids(request)
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 获取所有场地方（股东：只看关联场地）
        conditions = []
        values = []
        if landlordId:
            conditions.append("l.id = %s")
            values.append(landlordId)
        if keyword:
            conditions.append("l.name ILIKE %s")
            values.append(f"%{keyword}%")
        if allowed is not None:
            conditions.append("l.id = ANY(%s::int[])")
            values.append(allowed)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        cur.execute(f"""
            SELECT l.id, l.name, l.contact, l.phone
            FROM landlords l
            {where}
            ORDER BY l.id
        """, values)
        landlords = cur.fetchall()

        # 公司主体名称（归属链：场地合同主体 → 其他合同主体 → 电表主体[按电表数取多数]）
        # ——前端按主体分块展示；合同未选主体时回退电表主体，避免全部落「未指定主体」
        cur.execute("""
            SELECT DISTINCT ON (k) k, entity_name FROM (
                SELECT c.landlord_id AS k, ent.name AS entity_name, 0 AS pri, 1 AS w
                FROM contracts c JOIN entities ent ON ent.id = c.entity_id
                WHERE c.contract_type = '场地合同'
                UNION ALL
                SELECT c.landlord_id AS k, ent.name AS entity_name, 1 AS pri, 1 AS w
                FROM contracts c JOIN entities ent ON ent.id = c.entity_id
                WHERE c.contract_type <> '场地合同'
                UNION ALL
                SELECT m.landlord_id AS k, ent.name AS entity_name, 2 AS pri, COUNT(*) AS w
                FROM meters m JOIN entities ent ON ent.id = m.entity_id
                WHERE m.landlord_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%%'
                GROUP BY m.landlord_id, ent.name
            ) t WHERE k = ANY(%s::int[])
            ORDER BY k, pri ASC, w DESC, entity_name ASC
        """, ([l["id"] for l in landlords],))
        entity_map = {r["k"]: r["entity_name"] for r in cur.fetchall()}

        result = []
        for landlord in landlords:
            lid = landlord["id"]
            entity_name = entity_map.get(lid)

            # 获取该场地方下的所有电表（排除测试电表）
            cur.execute("""
            SELECT m.id, m.meter_no, m.meter_name, m.brand_id, m.brand_contract_id, b.name as brand_name,
                       m.transformer_ratio, m.status
                FROM meters m
                LEFT JOIN brands b ON m.brand_id = b.id
                WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
                  AND m.brand_id IS NOT NULL
                ORDER BY m.id
            """, (lid,))
            meters = cur.fetchall()

            # 获取该场地方的合同
            cur.execute("""
                SELECT id, contract_type, electricity_price, monthly_rent, cabinets_count, partner, brand_id,
                       tax_rate, tax_enabled, post_tax_electricity_price,
                       start_date, end_date, early_end_date, first_month_rent, rent_refund,
                       rent_tax_enabled, post_tax_rent_price
                FROM contracts
                WHERE landlord_id = %s
            """, (lid,))
            contracts = cur.fetchall()

            # 获取品牌名称
            brand_ids = [c["brand_id"] for c in contracts if c.get("brand_id")]
            brand_names = {}
            if brand_ids:
                placeholders = ",".join(["%s"] * len(brand_ids))
                cur.execute(f"SELECT id, name FROM brands WHERE id IN ({placeholders})", brand_ids)
                for b in cur.fetchall():
                    brand_names[b["id"]] = b["name"]

            # 从合同计算场地成本（租金 = Σ 场地合同月租）和电费单价（#2 统一口径）
            from ..domain.electricity_pricing import resolve_prices, split_tax, brand_price_for
            rent_cost = 0       # 场地合同月租金合计（= 该场地所有合同金额加和 = 成本）
            for c in contracts:
                if c["contract_type"] == "场地合同" and c["monthly_rent"]:
                    rent_cost += float(c["monthly_rent"])
            pricing = resolve_prices(contracts, period)
            elec_pay_price = pricing["pay_price"] or 0   # 场地合同唯一付款单价

            # 从电表月度数据计算总度数（按 品牌 拆分，供按品牌计收；v3：不再按站点）
            meter_ids = [m["id"] for m in meters]
            total_kwh = 0
            station_breakdown = []  # 按品牌拆分的数据（含各品牌度数）
            if meter_ids and period:
                month_period = period.replace("-", "")
                placeholders = ",".join(["%s"] * len(meter_ids))
                cur.execute(f"""
                SELECT m.brand_id, m.brand_contract_id, m.entity_id, b.name as brand_name,
                           COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) as kwh,
                           COUNT(DISTINCT m.id) as meter_count
                    FROM meter_readings mm
                    JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                    LEFT JOIN brands b ON m.brand_id = b.id
                    WHERE mm.meter_id IN ({placeholders}) AND mm.period = %s
                    GROUP BY m.brand_id, m.brand_contract_id, m.entity_id, b.name
                    ORDER BY kwh DESC
                """, (*meter_ids, month_period))
                rows = cur.fetchall()
                # 品牌聚合（保留各品牌度数）
                for r in rows:
                    bid = r["brand_id"]
                    station_breakdown.append({
                        "brand_id": bid,
                        "brand_contract_id": r.get("brand_contract_id"),
                        "entity_id": r.get("entity_id"),
                        "brand_name": r["brand_name"] or f"品牌#{bid}",
                        "kwh": float(r["kwh"] or 0),
                        "meter_count": int(r["meter_count"] or 0),
                    })
                station_breakdown.sort(key=lambda x: -x["kwh"])
                total_kwh = sum(float(a["kwh"]) for a in station_breakdown)

            # ── 共享电表（场地总表）并入电费口径 ──────────────────────────────
            # 品牌方在这类表下没有自己的电表，「数电表」取不到它们的电量，必须单独补上：
            #   付款侧：付场地方 = 整表读数 × 场地单价（亏空/线损由我方承担，与台账/分红同口径）
            #   收款侧：已录品牌分摊 → 人工录入应收电费；未录分摊 → 整表读数 × 全品牌合同单价
            # 同一品牌若既有自有电表又在共享表有分摊，两处电量合并成一行，不产生重复品牌行。
            _sb_index = {(a.get("brand_id"), a.get("brand_contract_id"), a.get("entity_id")): a for a in station_breakdown}

            def _merge_brand_row(bid, brand_name, entity_id, kwh_add, alloc_amount=None, brand_contract_id=None):
                row_key = (bid, brand_contract_id, entity_id)
                row = _sb_index.get(row_key)
                if row is None:
                    row = {
                        "brand_id": bid,
                        "brand_name": brand_name or (f"品牌#{bid}" if bid is not None else "全品牌共享"),
                        "entity_id": entity_id,
                        "kwh": 0.0,
                        "meter_count": 0,
                        "alloc_amount": None,
                        "brand_contract_id": brand_contract_id,
                    }
                    station_breakdown.append(row)
                    _sb_index[row_key] = row
                row["kwh"] = round(float(row["kwh"]) + float(kwh_add), 2)
                if alloc_amount is not None:
                    row["alloc_amount"] = round(float(row.get("alloc_amount") or 0) + float(alloc_amount), 2)

            if period:
                from ..repositories import shared_allocation_repo as _shared_repo
                _month_period = period.replace("-", "")
                cur.execute("""
                    SELECT m.id, m.meter_no, m.entity_id,
                           COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2)) AS kwh
                    FROM meters m
                    LEFT JOIN meter_readings mm ON mm.meter_id = m.id AND mm.month_period = %s
                    WHERE m.landlord_id = %s AND m.is_shared = TRUE AND m.brand_id IS NULL
                      AND m.meter_no NOT LIKE 'TEST%%'
                    ORDER BY m.id
                """, (_month_period, lid))
                _alloc_by_meter = _shared_repo.list_allocations_by_period(_month_period)
                for sm in cur.fetchall():
                    full = float(sm["kwh"] or 0)      # 整表实际用电量 = 付款口径
                    total_kwh += full
                    allocs = _alloc_by_meter.get(sm["meter_no"]) or []
                    if allocs:
                        # ★V5：各品牌只承担【自己倒推的电量】——不再乘损耗系数
                        #   （场地级的损耗已包含在上面 total_kwh × 单价 的成本里，不摊给品牌）
                        picked = []
                        for a in allocs:
                            eid_a = a.get("entity_id") or sm.get("entity_id")
                            price_a = a.get("unit_price")
                            if price_a is None:
                                info_a = brand_price_for(pricing, a["brand_id"], eid_a, a.get("brand_contract_id"))
                                price_a = info_a["price"] if info_a else None
                            kwh_a = round(float(a.get("collect_amount") or 0) / float(price_a), 2) if price_a else 0.0
                            picked.append((a, eid_a, kwh_a))
                        for a, eid_a, kwh_a in picked:
                            _merge_brand_row(a["brand_id"], a.get("brand_name"), eid_a,
                                             kwh_a,
                                             float(a.get("collect_amount") or 0), a.get("brand_contract_id"))
                    else:
                        # 未录分摊：整表电量归「全品牌共享」行，收款走全品牌合同单价
                        _merge_brand_row(None, "全品牌共享", sm.get("entity_id"), full)
                station_breakdown.sort(key=lambda x: -float(x.get("kwh") or 0))

            # 电费成本 = 付款口径总电量（含共用表整表读数）× 场地合同电费单价
            # ★V5：加上场地级损耗（final − Σ表；我方承担）—— 与分红/台账口径一致
            _loss_amt = 0.0
            cur.execute(
                "SELECT loss_amount FROM landlord_monthly_elec WHERE landlord_id = %s AND period = %s",
                (lid, str(period).replace("-", "")),
            )
            _lr = cur.fetchone()
            if _lr and _lr.get("loss_amount") is not None:
                _loss_amt = float(_lr["loss_amount"])
            elec_pay = round((total_kwh * elec_pay_price if elec_pay_price else 0) + _loss_amt, 2)

            # 电费收入（#2 统一口径：品牌各算各的；共享表品牌分摊以人工录入金额为准，
            # 收入统一为不含税（启用税率的品牌 split_tax 拆分），与台账/分红一致）
            def _station_collect(sb):
                eid = sb.get("entity_id")
                bid = sb.get("brand_id")
                info = brand_price_for(pricing, bid, eid, sb.get("brand_contract_id"))
                if sb.get("alloc_amount") is not None:
                    gross = round(float(sb["alloc_amount"]), 2)
                else:
                    if not info or info.get("price") is None:
                        return 0.0
                    gross = round(float(sb.get("kwh") or 0) * float(info["price"]), 2)
                if info and info.get("tax_enabled") and info.get("post_tax"):
                    _, net = split_tax(gross, info.get("tax_rate"))
                    return round(net, 2)
                return gross

            elec_collect = round(sum(_station_collect(sb) for sb in station_breakdown), 2)
            elec_profit = round(elec_collect - elec_pay, 2)

            # 场地收入（品牌方合同月租金；#6 与分红同口径：首月用 first_month_rent，提前结束月扣退款）
            from ..domain.electricity_pricing import rent_income_for_period, rent_refund_for_period
            rent_income = 0
            rent_refund = 0
            for c in contracts:
                if c["contract_type"] == "品牌方合同":
                    if period:
                        rent_income += rent_income_for_period(c, period)
                        rent_refund += rent_refund_for_period(c, period)
                    elif c["monthly_rent"]:
                        rent_income += float(c["monthly_rent"])
            rent_income = round(rent_income - rent_refund, 2)

            # 租金税费（品牌方合同启用租金税率时：含税月租 − 税后月租）；租金利润扣税（与 Rent 页一致）
            rent_tax_cost = sum(
                (float(c["monthly_rent"] or 0) - float(c["post_tax_rent_price"]))
                for c in contracts
                if c["contract_type"] == "品牌方合同"
                and c.get("rent_tax_enabled") and c.get("post_tax_rent_price")
            )
            rent_profit = round(rent_income - rent_cost - rent_tax_cost, 2)

            # 运营费用（按月份筛选；v3：挂 landlord_id）
            op_period = period.replace("-", "") if period else None
            op_expense = 0
            if op_period:
                cur.execute("SELECT COALESCE(SUM(amount), 0) as total FROM operating_expenses WHERE landlord_id = %s AND period = %s", (lid, op_period))
            else:
                cur.execute("SELECT COALESCE(SUM(amount), 0) as total FROM operating_expenses WHERE landlord_id = %s", (lid,))
            op_expense = float(cur.fetchone()["total"] or 0)

            # 合同
            cur.execute("""
                SELECT COUNT(*) as total,
                       COUNT(*) FILTER (WHERE end_date IS NOT NULL AND end_date < CURRENT_DATE) as expired,
                       COUNT(*) FILTER (WHERE end_date IS NOT NULL AND end_date >= CURRENT_DATE AND end_date <= CURRENT_DATE + INTERVAL '90 days') as expiring
                FROM contracts
                WHERE landlord_id = %s
            """, (lid,))
            contract_stats = cur.fetchone()

            # 计算每个品牌的电费成本和收入（#2：收款=品牌度数 × 该品牌单价）
            for sb in station_breakdown:
                kwh = float(sb["kwh"] or 0)
                sb["elecPay"] = round(kwh * elec_pay_price, 2) if elec_pay_price else 0
                sb["elecCollect"] = _station_collect(sb)
                sb["elecProfit"] = round(sb["elecCollect"] - sb["elecPay"], 2)

            # 按品牌统计电表柜数（每电表至少 1 柜，即 max(1, 实际柜子数)）
            brand_cabinet_count = {}
            if meters:
                meter_ids = [m["id"] for m in meters if m.get("id")]
                placeholders = ",".join(["%s"] * len(meter_ids))
                cur.execute(f"""
                    SELECT meter_id, COUNT(*) as cnt
                    FROM cabinets
                    WHERE meter_id IN ({placeholders})
                    GROUP BY meter_id
                """, meter_ids)
                cab_by_meter = {r["meter_id"]: max(1, int(r["cnt"] or 0)) for r in cur.fetchall()}
                for m in meters:
                    bid = m.get("brand_id")
                    if bid:
                        brand_cabinet_count[bid] = brand_cabinet_count.get(bid, 0) + cab_by_meter.get(m["id"], 1)

            # 共享电表（各品牌共用一块总表）：品牌名下没有电表，「数电表」数不到它们，
            # 柜数取分摊行人工录入值（按月，逐月可调）
            from ..repositories import shared_allocation_repo as _shared_repo
            for _bid, _cabs in _shared_repo.cabinet_totals_by_brand(
                    landlord_id=lid,
                    period=(period.replace("-", "") if period else None)).items():
                brand_cabinet_count[_bid] = brand_cabinet_count.get(_bid, 0) + _cabs

            # 合同拆分数据
            contract_breakdown = []
            for c in contracts:
                ct = c["contract_type"]
                monthly = float(c["monthly_rent"] or 0)
                price = float(c["electricity_price"] or 0)
                brand_name = brand_names.get(c["brand_id"], "") if c.get("brand_id") else ""
                partner = c.get("partner") or brand_name or ""
                # 场地合同没有partner时，使用场地方名称
                if ct == "场地合同" and not partner:
                    partner = landlord["name"]
                contract_breakdown.append({
                    "id": c["id"],
                    "type": ct,
                    "brandId": c.get("brand_id"),
                    "brandName": brand_name,
                    "partner": partner,
                    "monthlyRent": monthly,
                    "elecPrice": price,
                    "taxRate": float(c.get("tax_rate") or 0),
                    "taxEnabled": bool(c.get("tax_enabled")),
                    # 柜数以 meters 下柜子数为准（每电表至少 1 柜）
                    "cabinetsCount": brand_cabinet_count.get(c.get("brand_id")) if c.get("brand_id") else None,
                })

            # 计算税费（电费税费 + 场地费税费）
            elec_tax = 0
            rent_tax = 0
            for c in contracts:
                ct = c["contract_type"]
                tax_rate = float(c.get("tax_rate") or 0)
                tax_enabled = bool(c.get("tax_enabled"))
                if not tax_enabled or tax_rate <= 0:
                    continue
                if ct == "品牌方合同":
                    # 电费税费 = 电费收入 × 税率
                    brand_id = c.get("brand_id")
                    if brand_id:
                        brand_kwh = sum(
                            float(sb.get("kwh") or 0)
                            for sb in station_breakdown
                            if int(sb.get("brand_id") or 0) == int(brand_id)
                        )
                        brand_price = float(c.get("electricity_price") or 0)
                        brand_collect = brand_kwh * brand_price
                        elec_tax += brand_collect * tax_rate
                    # 场地费税费 = 场地收入 × 税率
                    rent_income_for_contract = float(c.get("monthly_rent") or 0)
                    if period:
                        rent_income_for_contract = rent_income_for_period(c, period) - rent_refund_for_period(c, period)
                    rent_tax += rent_income_for_contract * tax_rate

            elec_tax = round(elec_tax, 2)
            rent_tax = round(rent_tax, 2)

            # 分红（按月份筛选；v3：挂 landlord_id）
            dividend = 0
            if op_period:
                cur.execute("SELECT COALESCE(SUM(profit), 0) as total FROM dividend_records WHERE landlord_id = %s AND period = %s", (lid, op_period))
            else:
                cur.execute("SELECT COALESCE(SUM(profit), 0) as total FROM dividend_records WHERE landlord_id = %s", (lid,))
            dividend = float(cur.fetchone()["total"] or 0)

            result.append({
                "landlord": {
                    "id": lid,
                    "name": landlord["name"],
                    "contact": landlord["contact"],
                    "phone": landlord["phone"],
                },
                "entityName": entity_name,
                "meters": meters,
                "meterCount": len(meters),
                "totalKwh": round(total_kwh, 2),
                "elecPay": round(elec_pay, 2),
                "elecCollect": round(elec_collect, 2),
                "elecProfit": round(elec_profit, 2),
                "elecTax": elec_tax,
                "rentCost": round(rent_cost, 2),
                "rentIncome": round(rent_income, 2),
                "rentProfit": round(rent_profit, 2),
                "rentTax": rent_tax,
                "opExpense": round(op_expense, 2),
                "dividend": round(dividend, 2),
                "totalProfit": round(elec_profit + rent_profit - op_expense - dividend, 2),
                "contractCount": contract_stats["total"],
                "expiredContracts": contract_stats["expired"],
                "expiringContracts": contract_stats["expiring"],
                "stationBreakdown": station_breakdown,
                "contractBreakdown": contract_breakdown,
            })

        return result
    finally:
        cur.close()
        conn.close()


@router.get("/landlord-trends")
async def landlord_trends(request: Request, landlordId: int, months: int = 6):
    """某场地方近N个月利润趋势"""
    from ..infra.auth_scope import scope_landlord_ids
    allowed = scope_landlord_ids(request)
    if allowed is not None and landlordId not in allowed:
        return []
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 获取该场地方的合同
        cur.execute("""
            SELECT contract_type, electricity_price, monthly_rent, brand_id,
                   start_date, end_date, early_end_date, first_month_rent, rent_refund
            FROM contracts WHERE landlord_id = %s
        """, (landlordId,))
        contracts = cur.fetchall()

        # #2 统一口径：付款=场地合同唯一单价；收款=按品牌各自单价（无对应品牌合同 → 收入 0）
        from ..domain.electricity_pricing import resolve_prices, rent_income_for_period, rent_refund_for_period
        pricing_cache = {}
        def _pricing_for_month(month):
            key = str(month).replace("-", "")[:6]
            if key not in pricing_cache:
                pricing_cache[key] = resolve_prices(contracts, key)
            return pricing_cache[key]
        rent_cost = 0
        brand_contracts = []
        for c in contracts:
            ct = c["contract_type"]
            if ct == "场地合同":
                if c["monthly_rent"]:
                    rent_cost += float(c["monthly_rent"])
            elif ct == "品牌方合同":
                brand_contracts.append(c)

        # 从meter_monthly获取按月度数（按 月×品牌 拆分，供按品牌计收）
        cur.execute("""
            SELECT mm.month_period, m.brand_id,
                   COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) as kwh
            FROM meter_readings mm
            JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
            GROUP BY mm.month_period, m.brand_id
            ORDER BY mm.month_period DESC
            LIMIT %s
        """, (landlordId, months * 10))
        rows = cur.fetchall()
        # 聚合：月 → {total_kwh, brand_kwh}
        from collections import defaultdict
        month_agg = defaultdict(lambda: {"kwh": 0.0, "brand_kwh": {}})
        for r in rows:
            mp = r["month_period"]
            agg = month_agg[mp]
            agg["kwh"] += float(r["kwh"] or 0)
            bid = r.get("brand_id")
            if bid is not None:
                agg["brand_kwh"][int(bid)] = agg["brand_kwh"].get(int(bid), 0) + float(r["kwh"] or 0)
        monthly_kwh = [{"month_period": mp, **agg} for mp, agg in month_agg.items()]
        monthly_kwh.sort(key=lambda x: x["month_period"], reverse=True)
        monthly_kwh = monthly_kwh[:months]
        monthly_kwh.reverse()  # 升序

        # 运营费用按月（v3：挂 landlord_id）
        cur.execute("""
            SELECT period, COALESCE(SUM(amount), 0) as total
            FROM operating_expenses
            WHERE landlord_id = %s
            GROUP BY period
        """, (landlordId,))
        op_map = {r["period"]: float(r["total"]) for r in cur.fetchall()}

        trends = []
        for row in monthly_kwh:
            kwh = float(row["kwh"])
            month_pricing = resolve_prices(contracts, row["month_period"])
            month_pay_price = month_pricing["pay_price"] or 0
            month_rent_cost = sum(float(c["monthly_rent"] or 0) for c in contracts
                                  if c["contract_type"] == "场地合同"
                                  and (not c.get("start_date") or str(c["start_date"])[:7].replace("-", "") <= row["month_period"])
                                  and (not (c.get("early_end_date") or c.get("end_date")) or str(c.get("early_end_date") or c.get("end_date"))[:7].replace("-", "") >= row["month_period"]))
            ep = round(kwh * month_pay_price, 2)
            ec = round(sum(
                float(kwh_b) * (month_pricing["brand_prices"].get(bid, {}).get("price") or 0)
                for bid, kwh_b in row.get("brand_kwh", {}).items()
            ), 2)
            eprofit = round(ec - ep, 2)
            # #6：租金收入按当月口径（首月用 first_month_rent，提前结束月扣退款），与分红一致
            rent_income_m = sum(rent_income_for_period(c, row["month_period"]) for c in brand_contracts)
            rent_refund_m = sum(rent_refund_for_period(c, row["month_period"]) for c in brand_contracts)
            rprofit = round((rent_income_m - rent_refund_m) - month_rent_cost, 2)
            period = row["month_period"]
            # 格式化period: "202607" -> "2026-07"
            if len(period) == 6:
                period = f"{period[:4]}-{period[4:]}"
            # 运营费用按 6 位 YYYYMM 匹配（operating_expenses.period 存储格式）
            op = op_map.get(row["month_period"], 0)
            trends.append({
                "period": period,
                "kwh": round(kwh, 2),
                "elecPay": ep,
                "elecCollect": ec,
                "elecProfit": eprofit,
                "rentCost": round(month_rent_cost, 2),
                "rentIncome": round(rent_income_m - rent_refund_m, 2),
                "rentProfit": rprofit,
                "opExpense": round(op, 2),
                "totalProfit": round(eprofit + rprofit - op, 2),
            })

        return trends
    finally:
        cur.close()
        conn.close()


@router.get("/landlord-station-monthly")
async def landlord_station_monthly(request: Request, landlordId: int, months: int = 6):
    """某场地方近N个月按品牌分月利润趋势（v3：站点 → 品牌维度）"""
    from ..infra.auth_scope import scope_landlord_ids
    allowed = scope_landlord_ids(request)
    if allowed is not None and landlordId not in allowed:
        return []
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 获取该场地方下的品牌（按电表品牌去重）
        cur.execute("""
            SELECT DISTINCT m.brand_id, b.name as brand_name
            FROM meters m
            LEFT JOIN brands b ON m.brand_id = b.id
            WHERE m.landlord_id = %s AND m.brand_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%%'
            ORDER BY m.brand_id
        """, (landlordId,))
        brands = cur.fetchall()

        # 共享电表品牌分摊行里出现的品牌也要进趋势图：该品牌方在这类表下没有自己的电表，
        # 「数电表」不会把它带出来，但它在共享表上有分摊份额（否则趋势图会漏掉整个品牌）。
        cur.execute("""
            SELECT DISTINCT a.brand_id, b.name AS brand_name
            FROM meter_shared_allocations a
            JOIN meters m ON m.id = a.meter_id
            LEFT JOIN brands b ON b.id = a.brand_id
            WHERE m.landlord_id = %s AND m.is_shared = TRUE AND m.brand_id IS NULL
              AND a.brand_id IS NOT NULL
        """, (landlordId,))
        _known_bids = {b["brand_id"] for b in brands}
        for r in cur.fetchall():
            if r["brand_id"] not in _known_bids:
                brands.append(r)
                _known_bids.add(r["brand_id"])
        brands.sort(key=lambda x: (x["brand_id"] is None, x["brand_id"] or 0))

        # 获取合同（含租金首月/退款字段，供按月度口径计算）
        cur.execute("""
            SELECT contract_type, electricity_price, monthly_rent, brand_id,
                   start_date, end_date, early_end_date, first_month_rent, rent_refund
            FROM contracts WHERE landlord_id = %s
        """, (landlordId,))
        contracts = cur.fetchall()

        # #2 统一口径：付款=场地合同唯一单价；收款=按品牌各自单价（无对应品牌合同 → 收入 0）
        from ..domain.electricity_pricing import resolve_prices, rent_income_for_period, rent_refund_for_period
        pricing_cache = {}
        def _pricing_for_month(month):
            key = str(month).replace("-", "")[:6]
            if key not in pricing_cache:
                pricing_cache[key] = resolve_prices(contracts, key)
            return pricing_cache[key]
        rent_cost = 0
        brand_contracts = []
        for c in contracts:
            ct = c["contract_type"]
            if ct == "场地合同":
                if c["monthly_rent"]:
                    rent_cost += float(c["monthly_rent"])
            elif ct == "品牌方合同":
                brand_contracts.append(c)

        # 获取近N个月的度数（按 品牌×月 拆分，供按品牌计收）
        cur.execute("""
            SELECT m.brand_id, mm.month_period,
                   COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2))), 0) as kwh
            FROM meter_readings mm
            JOIN meters m ON m.id = mm.meter_id AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
            GROUP BY m.brand_id, mm.month_period
            ORDER BY mm.month_period DESC
        """, (landlordId,))
        all_rows = cur.fetchall()

        # 按月分组：月 → 品牌 → {kwh, own_kwh, alloc_amount}
        #   kwh          = 付款口径电量（自有电表 + 共享表品牌分摊摊入的整表电量）
        #   own_kwh      = 自有电表电量（收款口径基准）
        #   alloc_amount = 共享表品牌分摊人工录入的应收电费（含税）
        month_map: dict = {}
        for r in all_rows:
            mp = r["month_period"]
            bid = r["brand_id"]
            cell = month_map.setdefault(mp, {}).setdefault(
                bid, {"kwh": 0.0, "own_kwh": 0.0, "alloc_amount": None})
            cell["kwh"] += float(r["kwh"] or 0)
            cell["own_kwh"] += float(r["kwh"] or 0)

        # ── 共用表（所有品牌共用一个表）并入：品牌方在这类表下没有自己的电表，电量只能取分摊行倒推。
        #    ★V5：品牌付款电量 = 自己倒推的电量（**不摊损耗**）；损耗是场地级的，由我方承担，
        #    已包含在场地级成本（Σ场地所有表读数 × 场地单价）里，见电费台账的「损耗行」。
        from ..repositories import shared_allocation_repo as _shared_repo
        from ..domain.electricity_pricing import brand_price_for as _brand_price_for
        cur.execute("""
            SELECT m.meter_no, m.entity_id, mm.month_period,
                   COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(mm.transformer_ratio_snapshot, m.transformer_ratio, 1), 2)) AS kwh
            FROM meters m
            LEFT JOIN meter_readings mm ON mm.meter_id = m.id
            WHERE m.landlord_id = %s AND m.is_shared = TRUE AND m.brand_id IS NULL
              AND m.meter_no NOT LIKE 'TEST%%'
        """, (landlordId,))
        shared_full: dict = {}   # (meter_no, month_period) -> 整表实际用电量
        shared_meta: dict = {}   # meter_no -> 共享表自身主体
        for r in cur.fetchall():
            shared_meta[r["meter_no"]] = r.get("entity_id")
            if r["month_period"]:
                shared_full[(r["meter_no"], str(r["month_period"]))] = float(r["kwh"] or 0)
        if shared_meta:
            alloc_by_meter_month: dict = {}
            for a in _shared_repo.list_allocations():
                if a["address"] in shared_meta:
                    alloc_by_meter_month.setdefault(
                        (a["address"], str(a["month_period"])), []).append(a)
            for (addr, mp), allocs in alloc_by_meter_month.items():
                picked = []
                for a in allocs:
                    eid_a = a.get("entity_id") or shared_meta.get(addr)
                    info_a = _brand_price_for(_pricing_for_month(mp), a["brand_id"], eid_a, a.get("brand_contract_id"))
                    price_a = a.get("unit_price") or (info_a["price"] if info_a else None)
                    kwh_a = round(float(a.get("collect_amount") or 0) / float(price_a), 2) if price_a else 0.0
                    picked.append((a, kwh_a))
                # ★V5：品牌成本只按【自己倒推的电量】计，不再乘损耗系数（损耗由我方承担，不摊给品牌）
                for a, kwh_a in picked:
                    cell = month_map.setdefault(mp, {}).setdefault(
                        a["brand_id"], {"kwh": 0.0, "own_kwh": 0.0, "alloc_amount": None})
                    cell["kwh"] += kwh_a
                    cell["alloc_amount"] = round(
                        float(cell["alloc_amount"] or 0) + float(a.get("collect_amount") or 0), 2)

        recent_months = sorted(month_map.keys(), reverse=True)[:months]
        recent_months.reverse()

        # 构建结果（#6：租金收入按当月口径——首月/退款与分红一致；租金利润按场地整体展示在"整场地"）
        result = []
        brand_count = len(brands) or 1

        for mp in recent_months:
            period = f"{mp[:4]}-{mp[4:]}" if len(mp) == 6 else mp
            month_pricing = _pricing_for_month(mp)
            elec_pay_price = month_pricing["pay_price"] or 0
            brand_data = month_map.get(mp, {})
            rent_income_m = sum(rent_income_for_period(c, mp) for c in brand_contracts)
            rent_refund_m = sum(rent_refund_for_period(c, mp) for c in brand_contracts)
            rent_profit_total = (rent_income_m - rent_refund_m) - rent_cost
            brand_profits = []
            for b in brands:
                bid = b["brand_id"]
                cell = brand_data.get(bid) or {"kwh": 0.0, "own_kwh": 0.0, "alloc_amount": None}
                kwh = float(cell.get("kwh") or 0)          # 付款口径电量（含共享表摊入）
                own_kwh = float(cell.get("own_kwh") or 0)  # 自有电表电量
                ep = round(kwh * elec_pay_price, 2)
                own_price = (month_pricing["brand_prices"].get(int(bid)) or {}).get("price") if bid is not None else None
                ec = round(own_kwh * float(own_price or 0), 2)
                if cell.get("alloc_amount") is not None:
                    # 共享表品牌分摊：收入以人工录入应收为准（与台账一致）
                    ec = round(ec + float(cell["alloc_amount"]), 2)
                eprofit = round(ec - ep, 2)
                # 租金利润按品牌均摊（场地合同是整场地成本，品牌方合同按品牌归属）
                rent_profit_per_brand = round(rent_profit_total / brand_count, 2)
                brand_profits.append({
                    "brandId": bid,
                    "brandName": b["brand_name"] or f"品牌#{bid}",
                    "elecProfit": eprofit,
                    "rentProfit": rent_profit_per_brand,
                    "totalProfit": round(eprofit + rent_profit_per_brand, 2),
                })
            result.append({"period": period, "brands": brand_profits})

        return result
    finally:
        cur.close()
        conn.close()


@router.get("/shareholder-board")
async def shareholder_board(request: Request):
    """股东看板"""
    from ..repositories import dividend_repo, directory_repo
    from ..infra.auth_scope import scope_landlord_ids

    allowed = scope_landlord_ids(request)
    shareholders = directory_repo.list_shareholders()
    summaries = dividend_repo.get_shareholder_summary()
    # 股东账号：只看自己 + 只统计关联场地的分红（v3：summary 已含 landlord_id）
    user = getattr(request.state, "current_user", None)
    if user and user.get("role") == "shareholder":
        shareholders = [sh for sh in shareholders if sh["id"] == user.get("shareholder_id")]
        if allowed is not None:
            summaries = [s for s in summaries if s.get("landlord_id") in allowed]

    # 按股东聚合
    holder_map = {}
    for sh in shareholders:
        holder_map[sh["id"]] = {
            "id": sh["id"],
            "name": sh["name"],
            "phone": sh.get("phone"),
            "totalAmount": 0,
            "settledAmount": 0,
            "pendingAmount": 0,
            "details": [],
        }

    for s in summaries:
        hid = s["shareholder_id"]
        if hid in holder_map:
            amount = float(s.get("amount") or 0)
            holder_map[hid]["totalAmount"] += amount
            if s.get("status") == "已结算":
                holder_map[hid]["settledAmount"] += amount
            else:
                holder_map[hid]["pendingAmount"] += amount
            holder_map[hid]["details"].append(s)

    return list(holder_map.values())


# ─── 公司主体月度损益（二期：运营归属主体口径）────────────────────
# 归属原则（ENTITY_LINE_DESIGN.md §3）：
#   电费     = 台账按 meters.entity_id 生成时已带 entity_id，直接聚合；
#   品牌租金 = 品牌方合同覆盖该月：合同指定主体 → 全额归；否则按该 (场地,品牌) 电表柜数占比拆分；
#   场地租   = 场地合同覆盖该月：合同指定主体 → 全额归；否则按该场地电表柜数占比分摊；
#   运营费用 = 按主体录入的直接归；场地公共的按柜数分摊；
#   净利润   = 电费利润 + (租金收入 − 租金税费) − 场地租分摊 − 运营费分摊（分红不扣，与 landlord_monthly_summary 一致）。

def _covers_period(c: dict, period: str) -> bool:
    """合同是否覆盖 YYYYMM 月：start <= 月末 且 (early_end 或 end) >= 月初（无日期=长期有效）"""
    s = str(c.get("start_date") or "")[:10].replace("-", "")
    e = str(c.get("early_end_date") or c.get("end_date") or "")[:10].replace("-", "")
    ms, me = period + "01", period + "31"
    if s and s > me:
        return False
    if e and e < ms:
        return False
    return True


@router.get("/entity-monthly")
async def entity_monthly(request: Request, period: str = None):
    """公司主体 × 月度损益表（报表口径，非收付款口径；未指定主体单独成行）"""
    from ..infra.auth_scope import scope_landlord_ids
    from ..infra.period import to_compact
    from ..domain.electricity_pricing import rent_income_for_period, rent_refund_for_period
    from datetime import date as _date

    if not period:
        now = _date.today()
        period = f"{now.year}{now.month:02d}"
    period = to_compact(period)
    if len(period) != 6 or not period.isdigit():
        from fastapi import HTTPException
        raise HTTPException(400, "月份格式错误，应为 YYYY-MM 或 YYYYMM")

    allowed = scope_landlord_ids(request)
    scope_cond, scope_vals = "", []
    if allowed is not None:
        scope_cond = " AND landlord_id = ANY(%s::int[])"
        scope_vals = [allowed]

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        def bucket(eid):
            return {
                "kwh": 0.0, "elecPay": 0.0, "elecCollect": 0.0, "elecNet": 0.0,
                "rentIncome": 0.0, "rentTax": 0.0, "venueCost": 0.0, "opExpense": 0.0,
            }

        acc: dict = {}

        # 1) 电费（台账行自带 entity_id）
        #    ★V5：损耗行（row_type='loss'）**不归任何主体** —— 主体视图只看收入报税，
        #    成本里的损耗属于整个场地，不能摊进某个主体（否则主体成本虚高）
        cur.execute(f"""
            SELECT COALESCE(entity_id, 0) AS eid_key, entity_id,
                   COALESCE(SUM(pay_kwh), 0) AS kwh,
                   COALESCE(SUM(pay_amount), 0) AS pay_amount,
                   COALESCE(SUM(collect_amount), 0) AS collect_amount,
                   COALESCE(SUM(collect_net), 0) AS collect_net
            FROM electricity_records
            WHERE period = %s AND COALESCE(row_type, 'normal') <> 'loss'{scope_cond}
            GROUP BY entity_id
        """, (period, *scope_vals))
        elec_rows = cur.fetchall()

        # 2) 柜数权重：每块计费电表至少 1 柜（与分红分摊同口径）
        # 已按品牌录柜数的共享电表排除整表计数（其柜数按品牌/主体归属，见下方叠加）
        cur.execute(f"""
            SELECT m.landlord_id, m.entity_id, m.brand_id,
                   COALESCE(SUM(GREATEST(1, cab.cnt)), 0) AS cabs
            FROM meters m
            LEFT JOIN LATERAL (SELECT COUNT(*) AS cnt FROM cabinets cab WHERE cab.meter_id = m.id) cab ON TRUE
            WHERE m.landlord_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%%'
              AND (m.brand_id IS NOT NULL
                   OR (m.is_shared = TRUE AND m.brand_id IS NULL AND NOT EXISTS (
                         SELECT 1 FROM meter_shared_allocations sa
                         WHERE sa.meter_id = m.id AND sa.cabinet_count IS NOT NULL))){scope_cond.replace('landlord_id', 'm.landlord_id')}
            GROUP BY m.landlord_id, m.entity_id, m.brand_id
        """, tuple(scope_vals))
        weight_rows = cur.fetchall()
        weights_ll: dict = {}    # (landlord) -> {entity_id: cabs}
        weights_brand: dict = {} # (landlord, brand) -> {entity_id: cabs}
        for r in weight_rows:
            lid, eid, bid, cabs = r["landlord_id"], r["entity_id"], r["brand_id"], float(r["cabs"] or 0)
            weights_ll.setdefault(lid, {}).setdefault(eid, 0.0)
            weights_ll[lid][eid] += cabs
            weights_brand.setdefault((lid, bid), {}).setdefault(eid, 0.0)
            weights_brand[(lid, bid)][eid] += cabs

        # 3) 合同（覆盖该月）
        cur.execute("""
            SELECT c.*, l.name AS landlord_name
            FROM contracts c
            LEFT JOIN landlords l ON c.landlord_id = l.id
            WHERE c.landlord_id IS NOT NULL
        """)
        contracts = [c for c in cur.fetchall() if _covers_period(c, period)
                     and (allowed is None or c["landlord_id"] in allowed)]

        # 2.5) 共享电表按品牌录入的柜数 → 归到「品牌 → 报税主体」（与合同页/分红同口径）
        _brand_entity_of = {}
        for _c in contracts:
            _lid, _bid, _eid = _c.get("landlord_id"), _c.get("brand_id"), _c.get("entity_id")
            if _bid is not None and _eid is not None:
                _brand_entity_of.setdefault((_lid, _bid), _eid)
        _wb, _wl = _shared_cab_weights(period, _brand_entity_of, allowed)
        for _k, _emap in _wb.items():
            weights_brand.setdefault(_k, {})
            for _eid, _c_ in _emap.items():
                weights_brand[_k][_eid] = weights_brand[_k].get(_eid, 0.0) + _c_
        for _lid, _emap in _wl.items():
            weights_ll.setdefault(_lid, {})
            for _eid, _c_ in _emap.items():
                weights_ll[_lid][_eid] = weights_ll[_lid].get(_eid, 0.0) + _c_

        # 4) 运营费用（该月全部行）
        cur.execute(f"""
            SELECT o.*, ent.name AS entity_name
            FROM operating_expenses o
            LEFT JOIN entities ent ON o.entity_id = ent.id
            WHERE o.period = %s{scope_cond}
        """, (period, *scope_vals))
        op_rows = cur.fetchall()
    finally:
        cur.close()
        conn.close()

    def split_by_weights(amount: float, wmap: dict, force_entity=None) -> list:
        """按权重把金额拆到主体；权重为空/为 0 时整笔归 force_entity（或未指定）。
        每片舍入到分，尾差归占比最大的主体，保证各片合计等于总额"""
        total_w = sum(w for w in wmap.values() if w > 0)
        if total_w <= 0:
            return [(force_entity, round(amount, 2))]
        amount = round(amount, 2)
        eids = [e for e in wmap if wmap[e] > 0]
        if len(eids) == 1:
            return [(eids[0], amount)]
        biggest = max(eids, key=lambda e: wmap[e])
        out, rest = [], amount
        for eid in eids:
            if eid == biggest:
                continue
            share = round(amount * wmap[eid] / total_w, 2)
            out.append((eid, share))
            rest = round(rest - share, 2)
        out.append((biggest, rest))
        return out

    # ── 电费直接归集 ──
    for r in elec_rows:
        eid = r["entity_id"]
        b = acc.setdefault(eid, bucket(eid))
        b["kwh"] += float(r["kwh"] or 0)
        b["elecPay"] += float(r["pay_amount"] or 0)
        b["elecCollect"] += float(r["collect_amount"] or 0)
        b["elecNet"] += float(r["collect_net"] or 0)

    # ── 合同租金（收入=品牌方合同 / 成本=场地合同），一律按电表柜数拆分到主体
    #    （contracts.entity_id 仅作电表默认报税主体，不参与分摊）──
    for c in contracts:
        lid = c["landlord_id"]
        if c["contract_type"] == "场地合同":
            amount = round(float(c.get("monthly_rent") or 0), 2)
            allocations = split_by_weights(amount, weights_ll.get(lid, {}))
            for eid, share in allocations:
                acc.setdefault(eid, bucket(eid))["venueCost"] += share
        elif c["contract_type"] == "品牌方合同":
            amount = round(rent_income_for_period(c, period) - rent_refund_for_period(c, period), 2)
            tax = 0.0
            if c.get("rent_tax_enabled") and c.get("post_tax_rent_price") is not None:
                tax = round(float(c.get("monthly_rent") or 0) - float(c["post_tax_rent_price"]), 2)
            wmap = weights_brand.get((lid, c.get("brand_id")), {})
            inc_allocs = split_by_weights(amount, wmap)
            tax_map = dict(split_by_weights(tax, wmap)) if tax > 0 else {}
            allocs = [(eid, share, tax_map.get(eid, 0.0)) for eid, share in inc_allocs]
            for eid, share, tshare in allocs:
                b = acc.setdefault(eid, bucket(eid))
                b["rentIncome"] += share
                b["rentTax"] += tshare

    # ── 运营费用 ──
    for o in op_rows:
        lid = o.get("landlord_id")
        amount = float(o.get("amount") or 0)
        if o.get("entity_id") is not None:
            allocations = [(o["entity_id"], amount)]
        else:
            allocations = split_by_weights(amount, weights_ll.get(lid, {}))
        for eid, share in allocations:
            acc.setdefault(eid, bucket(eid))["opExpense"] += share

   

    # ── 主体名 ──
    eids = [e for e in acc.keys() if e is not None]
    if eids:
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("SELECT id, name FROM entities WHERE id = ANY(%s::int[])", (eids,))
            ent_names = {r["id"]: r["name"] for r in cur.fetchall()}
        finally:
            cur.close()
            conn.close()
    else:
        ent_names = {}

    rows = []
    for eid, b in acc.items():
        elec_profit = round(b["elecNet"] - b["elecPay"], 2)
        net_profit = round(elec_profit + b["rentIncome"] - b["rentTax"] - b["venueCost"] - b["opExpense"], 2)
        rows.append({
            "entityId": eid,
            "entityName": ent_names.get(eid) if eid is not None else None,
            "kwh": round(b["kwh"], 2),
            "elecPay": round(b["elecPay"], 2),
            "elecCollect": round(b["elecCollect"], 2),
            "elecNet": round(b["elecNet"], 2),
            "elecTax": round(b["elecCollect"] - b["elecNet"], 2),
            "elecProfit": elec_profit,
            "rentIncome": round(b["rentIncome"], 2),
            "rentTax": round(b["rentTax"], 2),
            "venueCost": round(b["venueCost"], 2),
            "opExpense": round(b["opExpense"], 2),
            "netProfit": net_profit,
        })
    rows.sort(key=lambda r: (r["entityId"] is None, -(r["elecProfit"] + r["rentIncome"])))

    totals = {
        "kwh": round(sum(r["kwh"] for r in rows), 2),
        "elecPay": round(sum(r["elecPay"] for r in rows), 2),
        "elecCollect": round(sum(r["elecCollect"] for r in rows), 2),
        "elecNet": round(sum(r["elecNet"] for r in rows), 2),
        "elecTax": round(sum(r["elecTax"] for r in rows), 2),
        "elecProfit": round(sum(r["elecProfit"] for r in rows), 2),
        "rentIncome": round(sum(r["rentIncome"] for r in rows), 2),
        "rentTax": round(sum(r["rentTax"] for r in rows), 2),
        "venueCost": round(sum(r["venueCost"] for r in rows), 2),
        "opExpense": round(sum(r["opExpense"] for r in rows), 2),
        "netProfit": round(sum(r["netProfit"] for r in rows), 2),
    }
    for r in rows:
        r["entityName"] = r["entityName"] or "未指定主体"

    return {"period": period, "rows": rows, "totals": totals}

    # ── 主体名 ──
    eids = [e for e in acc.keys() if e is not None]
    if eids:
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("SELECT id, name FROM entities WHERE id = ANY(%s::int[])", (eids,))
            ent_names = {r["id"]: r["name"] for r in cur.fetchall()}
        finally:
            cur.close()
            conn.close()
    else:
        ent_names = {}

    rows = []
    for eid, b in acc.items():
        elec_profit = round(b["elecNet"] - b["elecPay"], 2)
        net_profit = round(elec_profit + b["rentIncome"] - b["rentTax"] - b["venueCost"] - b["opExpense"], 2)
        rows.append({
            "entityId": eid,
            "entityName": ent_names.get(eid) if eid is not None else None,
            "kwh": round(b["kwh"], 2),
            "elecPay": round(b["elecPay"], 2),
            "elecCollect": round(b["elecCollect"], 2),
            "elecNet": round(b["elecNet"], 2),
            "elecTax": round(b["elecCollect"] - b["elecNet"], 2),
            "elecProfit": elec_profit,
            "rentIncome": round(b["rentIncome"], 2),
            "rentTax": round(b["rentTax"], 2),
            "venueCost": round(b["venueCost"], 2),
            "opExpense": round(b["opExpense"], 2),
            "netProfit": net_profit,
        })
    rows.sort(key=lambda r: (r["entityId"] is None, -(r["elecProfit"] + r["rentIncome"])))

    totals = {
        "kwh": round(sum(r["kwh"] for r in rows), 2),
        "elecPay": round(sum(r["elecPay"] for r in rows), 2),
        "elecCollect": round(sum(r["elecCollect"] for r in rows), 2),
        "elecNet": round(sum(r["elecNet"] for r in rows), 2),
        "elecTax": round(sum(r["elecTax"] for r in rows), 2),
        "elecProfit": round(sum(r["elecProfit"] for r in rows), 2),
        "rentIncome": round(sum(r["rentIncome"] for r in rows), 2),
        "rentTax": round(sum(r["rentTax"] for r in rows), 2),
        "venueCost": round(sum(r["venueCost"] for r in rows), 2),
        "opExpense": round(sum(r["opExpense"] for r in rows), 2),
        "netProfit": round(sum(r["netProfit"] for r in rows), 2),
    }
    for r in rows:
        r["entityName"] = r["entityName"] or "未指定主体"

    return {"period": period, "rows": rows, "totals": totals}
