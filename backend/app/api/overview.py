from fastapi import APIRouter, Request
from ..infra.database import get_connection, get_dict_cursor
from datetime import date
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/overview", tags=["看板"], default_response_class=CamelJSONResponse)


@router.get("")
async def overview(request: Request):
    """经营总览 API（股东账号只统计其关联场地的数据）- 热重载测试"""
    from ..infra.auth_scope import scope_landlord_ids
    allowed = scope_landlord_ids(request)
    user = getattr(request.state, "current_user", None)
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 品牌组合统计（v3：站点 → 场地×品牌 组合数；active = 组合内有正常电表）
        if allowed is not None:
            cur.execute("""
                SELECT COUNT(*) as total,
                       COUNT(*) FILTER (WHERE EXISTS (
                           SELECT 1 FROM meters m2
                           WHERE m2.landlord_id = t.landlord_id AND m2.brand_id = t.brand_id
                             AND m2.status = '正常' AND m2.meter_no NOT LIKE 'TEST%'
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
                             AND m2.status = '正常' AND m2.meter_no NOT LIKE 'TEST%'
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

        # 总电量（真实表码度数，从 meter_monthly 汇总；v3：电表挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as total_kwh
                FROM meter_monthly mm
                JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                WHERE m.meter_no NOT LIKE 'TEST%' AND m.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as total_kwh
                FROM meter_monthly mm
                JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
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
                           SELECT SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2)))
                           FROM meter_monthly mm
                           JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
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
                           SELECT SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2)))
                           FROM meter_monthly mm
                           JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
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
    from ..infra.auth_scope import scope_landlord_ids
    allowed = scope_landlord_ids(request)
    if not period:
        from datetime import date
        today = date.today()
        period = today.strftime("%Y-%m")
    month_compact = period.replace("-", "")

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 1) 总电量（v3：电表挂 landlord_id）
        if allowed is not None:
            cur.execute("""
                SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as kwh
                FROM meter_monthly mm
                JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                WHERE mm.month_period = %s AND m.meter_no NOT LIKE 'TEST%%' AND m.landlord_id = ANY(%s::int[])
            """, (month_compact, allowed))
        else:
            cur.execute("""
                SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as kwh
                FROM meter_monthly mm
                JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
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
                    LEFT JOIN brands b ON m.brand_id = b.id
                    WHERE er.period = %s AND er.landlord_id = ANY(%s::int[])
                """, (month_compact, allowed))
            else:
                cur.execute("""
                    SELECT d.electricity_id, m.meter_no, b.name as brand_name,
                           d.kwh, d.pay_amount, d.collect_amount, d.collect_net
                    FROM electricity_meter_details d
                    LEFT JOIN electricity_records er ON d.electricity_id = er.id
                    LEFT JOIN meters m ON d.meter_id = m.id
                    LEFT JOIN brands b ON m.brand_id = b.id
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
                SELECT c.brand_id, b.name as brand_name, c.monthly_rent,
                       c.start_date, c.end_date, c.early_end_date, c.first_month_rent, c.rent_refund,
                       c.rent_tax_enabled, c.post_tax_rent_price
                FROM contracts c LEFT JOIN brands b ON c.brand_id = b.id
                WHERE c.contract_type = '品牌方合同' AND c.landlord_id = ANY(%s::int[])
            """, (allowed,))
            rent_income_contracts = cur.fetchall()
            cur.execute("""
                SELECT c.landlord_id, l.name as landlord_name, c.monthly_rent
                FROM contracts c LEFT JOIN landlords l ON c.landlord_id = l.id
                WHERE c.contract_type = '场地合同' AND c.landlord_id = ANY(%s::int[])
            """, (allowed,))
        else:
            cur.execute("""
                SELECT c.brand_id, b.name as brand_name, c.monthly_rent,
                       c.start_date, c.end_date, c.early_end_date, c.first_month_rent, c.rent_refund,
                       c.rent_tax_enabled, c.post_tax_rent_price
                FROM contracts c LEFT JOIN brands b ON c.brand_id = b.id
                WHERE c.contract_type = '品牌方合同'
            """)
            rent_income_contracts = cur.fetchall()
            cur.execute("""
                SELECT c.landlord_id, l.name as landlord_name, c.monthly_rent
                FROM contracts c LEFT JOIN landlords l ON c.landlord_id = l.id
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
                "incomeDetails": [{ "brandName": c["brand_name"] or "未指定", "monthlyRent": float(c["monthly_rent"] or 0) } for c in rent_income_contracts],
                "costDetails": [{ "landlordName": c["landlord_name"] or "未指定", "monthlyRent": float(c["monthly_rent"] or 0) } for c in rent_cost_contracts],
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

        result = []
        for landlord in landlords:
            lid = landlord["id"]

            # 获取该场地方下的所有电表（排除测试电表）
            cur.execute("""
                SELECT m.id, m.meter_no, m.meter_name, m.brand_id, b.name as brand_name,
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
            from ..domain.electricity_pricing import resolve_prices, split_tax
            rent_cost = 0       # 场地合同月租金合计（= 该场地所有合同金额加和 = 成本）
            for c in contracts:
                if c["contract_type"] == "场地合同" and c["monthly_rent"]:
                    rent_cost += float(c["monthly_rent"])
            pricing = resolve_prices(contracts)
            elec_pay_price = pricing["pay_price"] or 0   # 场地合同唯一付款单价

            # 从电表月度数据计算总度数（按 品牌 拆分，供按品牌计收；v3：不再按站点）
            meter_nos = [m["meter_no"] for m in meters if m.get("meter_no")]
            total_kwh = 0
            station_breakdown = []  # 按品牌拆分的数据（含各品牌度数）
            if meter_nos and period:
                month_period = period.replace("-", "")
                placeholders = ",".join(["%s"] * len(meter_nos))
                cur.execute(f"""
                    SELECT m.brand_id, b.name as brand_name,
                           COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as kwh,
                           COUNT(DISTINCT m.id) as meter_count
                    FROM meter_monthly mm
                    JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                    LEFT JOIN brands b ON m.brand_id = b.id
                    WHERE mm.address IN ({placeholders}) AND mm.month_period = %s
                    GROUP BY m.brand_id, b.name
                    ORDER BY kwh DESC
                """, (*meter_nos, month_period))
                rows = cur.fetchall()
                # 品牌聚合（保留各品牌度数）
                for r in rows:
                    bid = r["brand_id"]
                    station_breakdown.append({
                        "brand_id": bid,
                        "brand_name": r["brand_name"] or f"品牌#{bid}",
                        "kwh": float(r["kwh"] or 0),
                        "meter_count": int(r["meter_count"] or 0),
                    })
                station_breakdown.sort(key=lambda x: -x["kwh"])
                total_kwh = sum(float(a["kwh"]) for a in station_breakdown)

            # 电费成本 = 度数 × 场地合同电费单价
            elec_pay = total_kwh * elec_pay_price if elec_pay_price else 0

            # 电费收入（#2 统一口径：按品牌各算各的——品牌度数 × 该品牌方合同单价；
            # 收入统一为不含税（启用税率的品牌 split_tax 拆分），税费独立展示，不混入利润，与台账/分红一致）
            def _station_collect(sb):
                bid = sb.get("brand_id")
                info = pricing["brand_prices"].get(int(bid)) if bid is not None else None
                if not info:
                    return 0.0
                gross = round(float(sb.get("kwh") or 0) * float(info.get("price") or 0), 2)
                if info.get("tax_enabled") and info.get("post_tax"):
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
        pricing = resolve_prices(contracts)
        elec_pay_price = pricing["pay_price"] or 0
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
                   COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as kwh
            FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
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
            ep = round(kwh * elec_pay_price, 2)
            ec = round(sum(
                float(kwh_b) * (pricing["brand_prices"].get(bid, {}).get("price") or 0)
                for bid, kwh_b in row.get("brand_kwh", {}).items()
            ), 2)
            eprofit = round(ec - ep, 2)
            # #6：租金收入按当月口径（首月用 first_month_rent，提前结束月扣退款），与分红一致
            rent_income_m = sum(rent_income_for_period(c, row["month_period"]) for c in brand_contracts)
            rent_refund_m = sum(rent_refund_for_period(c, row["month_period"]) for c in brand_contracts)
            rprofit = round((rent_income_m - rent_refund_m) - rent_cost, 2)
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
                "rentCost": round(rent_cost, 2),
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

        # 获取合同（含租金首月/退款字段，供按月度口径计算）
        cur.execute("""
            SELECT contract_type, electricity_price, monthly_rent, brand_id,
                   start_date, end_date, early_end_date, first_month_rent, rent_refund
            FROM contracts WHERE landlord_id = %s
        """, (landlordId,))
        contracts = cur.fetchall()

        # #2 统一口径：付款=场地合同唯一单价；收款=按品牌各自单价（无对应品牌合同 → 收入 0）
        from ..domain.electricity_pricing import resolve_prices, rent_income_for_period, rent_refund_for_period
        pricing = resolve_prices(contracts)
        elec_pay_price = pricing["pay_price"] or 0
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
                   COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as kwh
            FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
            GROUP BY m.brand_id, mm.month_period
            ORDER BY mm.month_period DESC
        """, (landlordId,))
        all_rows = cur.fetchall()

        # 按月分组：月 → 品牌 → {kwh}
        month_map: dict = {}
        for r in all_rows:
            mp = r["month_period"]
            bid = r["brand_id"]
            if mp not in month_map:
                month_map[mp] = {}
            cell = month_map[mp].setdefault(bid, {"kwh": 0.0})
            cell["kwh"] += float(r["kwh"] or 0)

        recent_months = sorted(month_map.keys(), reverse=True)[:months]
        recent_months.reverse()

        # 构建结果（#6：租金收入按当月口径——首月/退款与分红一致；租金利润按场地整体展示在"整场地"）
        result = []
        brand_count = len(brands) or 1

        for mp in recent_months:
            period = f"{mp[:4]}-{mp[4:]}" if len(mp) == 6 else mp
            brand_data = month_map.get(mp, {})
            rent_income_m = sum(rent_income_for_period(c, mp) for c in brand_contracts)
            rent_refund_m = sum(rent_refund_for_period(c, mp) for c in brand_contracts)
            rent_profit_total = (rent_income_m - rent_refund_m) - rent_cost
            brand_profits = []
            for b in brands:
                bid = b["brand_id"]
                cell = brand_data.get(bid, {"kwh": 0.0})
                kwh = float(cell["kwh"])
                ep = round(kwh * elec_pay_price, 2)
                ec = round(
                    float(kwh) * (pricing["brand_prices"].get(int(bid), {}).get("price") or 0),
                    2
                )
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
