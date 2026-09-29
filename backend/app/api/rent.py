from fastapi import APIRouter, HTTPException, Query, Request
from ..repositories import rent_repo, dividend_repo, shared_allocation_repo
from ..infra.auth_scope import scope_landlord_ids
from ..infra.period import to_compact
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/rent", tags=["场地租金"], default_response_class=CamelJSONResponse)


def _scope_rows(request: Request, rows: list) -> list:
    """股东：只保留关联场地（landlord）的行（rows 需含 landlord_id）"""
    allowed = scope_landlord_ids(request)
    if allowed is None:
        return rows
    return [r for r in rows if r.get("landlord_id") in allowed]



# ─── 运营费用 ───────────────────────────────────────────────

@router.get("/expenses")
async def list_expenses(request: Request, stationId: int = None, landlordId: int = None, period: str = None):
    # period 统一为 6 位 YYYYMM（与 operating_expenses.period 存储格式一致）
    if period:
        period = to_compact(period)
    return _scope_rows(request, rent_repo.list_expenses(station_id=stationId, landlord_id=landlordId, period=period))


@router.post("/expenses", status_code=201)
async def save_expense(data: dict):
    # period 统一为 6 位 YYYYMM 后入库，保证与分红计算（dividend_calc 用 6 位查）同口径
    period = to_compact(data.get("period"))
    entity_id = data.get("entityId")
    result = rent_repo.save_expense(
        landlord_id=data.get("landlordId"),
        period=period,
        amount=data.get("amount"),
        remark=data.get("remark"),
        entity_id=int(entity_id) if entity_id else None,
    )
    # 自动更新该场地该月的分红记录
    _update_dividend_records(data.get("landlordId"), period)
    return result


@router.delete("/expenses/{expense_id}")
async def delete_expense(expense_id: int):
    # 先获取运营费用信息，用于后续更新分红记录
    expense = rent_repo.get_expense_by_id(expense_id)
    rent_repo.delete_expense(expense_id)
    # 自动更新该场地该月的分红记录
    if expense:
        _update_dividend_records(expense.get("landlord_id"), expense.get("period"))
    return {"ok": True}


# ─── 美团台账Excel数据（v2 已下线）────────────────────────────
# 背景：用户明确"系统数据来源只有三处（电表/合同/分红配置）"，美团 Excel 台账属第四数据源。
# v2 决策：租金唯一主源 = contracts（+ 分期表），Excel 不再运行时解析；
# 历史 Excel 数据如有需要，一次性人工导入 contracts（data_source='excel'）后即可丢弃文件。
# 接口保留签名返回空结构，前端自动降级到 contracts 数据（柜数/租金/分期全部以库为准）。


@router.get("/excel-data")
async def get_excel_data(stationName: str = Query(None)):
    """DEPRECATED：美团台账 Excel 运行时解析已下线（v2 租金主源为 contracts）。返回空结构，前端降级。"""
    return {"stations": []}


def _update_dividend_records(landlord_id: int, period: str):
    """运营费用变更后：更新该场地该月的分红记录。

    具体重算逻辑统一在 domain/dividend_refresh.refresh_dividend_records
    （合同/电表/柜子/台账变更共用同一入口，含审批状态保护）。
    """
    from ..domain.dividend_refresh import refresh_dividend_records
    refresh_dividend_records(landlord_id, [period] if period else None)


# ─── 场地费月台账（Rent 页核心，v2 重设计）──────────────────
# 只含场地费（品牌方合同=收入 / 场地合同=成本），不含电费；
# 支持按场地方 / 按品牌方 维度查看任意月份；返回 总览行 + 合同明细 + 分期状态。

@router.get("/monthly-ledger")
async def monthly_ledger(request: Request, period: str = Query(..., description="月份 YYYYMM 或 YYYY-MM"),
                         dim: str = Query("landlord", description="landlord=按场地方 / brand=按品牌方")):
    """场地费月台账：按场地方/品牌方 × 月份 汇总 + 明细（仅场地费）"""
    from datetime import date, timedelta
    from ..infra.database import get_connection, get_dict_cursor

    period = to_compact(period)
    if len(period) != 6 or not period.isdigit():
        raise HTTPException(400, "月份格式错误，应为 YYYY-MM 或 YYYYMM")
    y, m = int(period[:4]), int(period[4:6])
    month_end = (date(y + 1, 1, 1) - timedelta(days=1)) if m == 12 else (date(y, m + 1, 1) - timedelta(days=1))
    ms = period + "01"  # 月初 YYYYMMDD
    me = month_end.strftime("%Y%m%d")

    # 数据隔离：股东只能查看关联场地的租金台账；财务按电表类型范围派生场地范围
    allowed = scope_landlord_ids(request)
    scope_cond, scope_val = "", []
    if allowed is not None:
        scope_cond = " AND c.landlord_id = ANY(%s::int[])"
        scope_val = [allowed]

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 覆盖该月的全部场地费合同（场地合同=成本，品牌方合同=收入）
        cur.execute(f"""
            SELECT c.id AS contract_id, c.contract_type, c.landlord_id, l.name AS landlord_name,
                   l.contact AS landlord_contact, l.phone AS landlord_phone,
                   c.brand_id, b.name AS brand_name, c.monthly_rent, c.rent_amount,
                   c.entity_id, ent.name AS entity_name,
                   c.unit_monthly_rent, c.cabinets_count, c.deposit, c.input_cost,
                   c.rent_tax_enabled, c.rent_tax_rate, c.post_tax_rent_price,
                   c.pay_method, c.start_date, c.end_date, c.early_end_date, c.first_month_rent
            FROM contracts c
            LEFT JOIN landlords l ON c.landlord_id = l.id
            LEFT JOIN brands b ON c.brand_id = b.id
            LEFT JOIN entities ent ON ent.id = c.entity_id
            WHERE (c.start_date IS NULL OR c.start_date <= %s)
              AND (COALESCE(c.early_end_date, c.end_date) IS NULL OR COALESCE(c.early_end_date, c.end_date) >= %s){scope_cond}
            ORDER BY c.landlord_id, c.contract_type, c.id
        """, [me, ms] + scope_val)
        contracts = cur.fetchall()

        # 全年合同（含已结束/未开始的品牌合同）：用于「承担场地成本按合同周期逐月分摊」——
        # 查看月是 8 月时，某品牌合同若只覆盖 1-6 月（已结束），不在 contracts 里，
        # 但分摊 2026 年 1-6 月场地费时它仍参与，故需单独查全年。
        year_start_s = period[:4] + "0101"
        year_end_s = period[:4] + "1231"
        cur.execute(f"""
            SELECT c.id AS contract_id, c.contract_type, c.landlord_id, l.name AS landlord_name,
                   l.contact AS landlord_contact, l.phone AS landlord_phone,
                   c.brand_id, b.name AS brand_name, c.monthly_rent, c.rent_amount,
                   c.entity_id, ent.name AS entity_name,
                   c.unit_monthly_rent, c.cabinets_count, c.deposit, c.input_cost,
                   c.rent_tax_enabled, c.rent_tax_rate, c.post_tax_rent_price,
                   c.pay_method, c.start_date, c.end_date, c.early_end_date, c.first_month_rent
            FROM contracts c
            LEFT JOIN landlords l ON c.landlord_id = l.id
            LEFT JOIN brands b ON c.brand_id = b.id
            LEFT JOIN entities ent ON ent.id = c.entity_id
            WHERE (c.start_date IS NULL OR c.start_date <= %s)
              AND (COALESCE(c.early_end_date, c.end_date) IS NULL OR COALESCE(c.early_end_date, c.end_date) >= %s){scope_cond}
            ORDER BY c.landlord_id, c.contract_type, c.id
        """, [year_end_s, year_start_s] + scope_val)
        year_contracts = cur.fetchall()

        # 计费柜数：{landlord_id: {brand_id: 柜数}}。口径与合同列表一致：按 landlord+brand 匹配电表，
        # 每表 GREATEST(1, 其下柜子数)，排除 TEST 开头电表。
        # 共享电表（brand_id 为空且标签=共享电表）另算：各品牌在该表下没有自己的电表，
        # 柜数取分摊行人工录入值（按月，见下方 shared_cab_month）；没录过的表才整表按 1 柜
        # 归 brand_id=None 组，供全品牌合同（brandId 为空）分摊使用。
        # 场租分摊不读 contracts.cabinets_count 存储快照（电表后关联品牌时快照不会更新）
        cur.execute("""
            SELECT m.landlord_id, m.brand_id,
                   SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id))) AS cabs
            FROM meters m
            WHERE m.landlord_id IS NOT NULL
              AND m.brand_id IS NOT NULL
              AND m.meter_no NOT LIKE 'TEST%'
            GROUP BY m.landlord_id, m.brand_id
        """)
        live_brand_cabs: dict = {}
        for r in cur.fetchall():
            live_brand_cabs.setdefault(r["landlord_id"], {})[r["brand_id"]] = float(r["cabs"] or 0)

        cur.execute("""
            SELECT m.landlord_id, m.meter_no,
                   GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id)) AS cabs
            FROM meters m
            WHERE m.landlord_id IS NOT NULL
              AND m.brand_id IS NULL AND m.is_shared = TRUE
              AND m.meter_no NOT LIKE 'TEST%'
        """)
        shared_meters = cur.fetchall()

        # 全部期次（付款/收款）：用于「逐年付款/到账情况」（不再按月过滤）
        cur.execute("""
            SELECT contract_id, status, period_start, period_end, amount
            FROM rent_income_schedule
        """)
        inc_scheds = cur.fetchall()
        cur.execute("""
            SELECT contract_id, status, period_start, period_end, amount
            FROM rent_payment_schedule
        """)
        pay_scheds = cur.fetchall()
    finally:
        cur.close()
        conn.close()

    # 共享电表柜数（按月）：{landlord_id: {period: {brand_id: cabs}}}
    # 各品牌共用一块总表时没有自己的电表，「数电表」数不到它们 —— 柜数只能靠分摊行人工录入，
    # 且逐月可调（当月填了用当月，没填沿用该品牌最近一次填写值）。
    # 全年 12 个月都要取值：某月没填则沿用该品牌最近一次填写值（柜数逐月可调，不是只在录入月有效）
    shared_cab_month = shared_allocation_repo.cabinet_usage_by_month(
        periods=[f"{y}{mm:02d}" for mm in range(1, 13)]
    )
    # ★V5：柜数月度快照（优先口径；该月没生成过台账则无快照 → 上方回退实时）
    from ..domain.cabinet_snapshot import snapshot_cabinet_totals as _snap_totals
    snap_cabs_by_month = {f"{y}{mm:02d}": _snap_totals(f"{y}{mm:02d}") for mm in range(1, 13)}
    shared_recorded = set(shared_allocation_repo.cabinet_records().keys())
    # 完全没录过柜数的共享表 → 整表至少 1 柜，归 brand_id=None 组兜底
    for r in shared_meters:
        if r["meter_no"] in shared_recorded:
            continue
        live_brand_cabs.setdefault(r["landlord_id"], {})
        live_brand_cabs[r["landlord_id"]][None] = (
            live_brand_cabs[r["landlord_id"]].get(None, 0.0) + float(r["cabs"] or 0)
        )

    sched_map = {}
    for s in inc_scheds + pay_scheds:
        sched_map.setdefault(s["contract_id"], []).append(s)

    def _year_status(contract_id: int, paid_flags: tuple) -> list:
        """按年统计某合同分期状态：返回 [{year, paid, total}]，如 季付 2026 上半年付了 → 2026: 1/4"""
        from collections import defaultdict
        agg = defaultdict(lambda: [0, 0])
        for s in sched_map.get(contract_id, []):
            y = str(s["period_start"])[:4]
            agg[y][1] += 1
            if s["status"] in paid_flags:
                agg[y][0] += 1
        return [{"year": y, "paid": agg[y][0], "total": agg[y][1]} for y in sorted(agg.keys())]

    def _live_cabs(lid, bid, ym: str = None) -> float:
        """(场地, 品牌) 的计费柜数；未匹配到电表为 0（不落快照兜底）。

        ★V5：传了 ym 且该月有【柜数快照】时优先读快照（快照已按
        "加柜本月生效/减柜下月生效" 规则算好，含共用表分摊行人工录入值，
        且排除了无品牌归属的柜子）；该月无快照（尚未生成台账）→ 回退实时口径。
        柜数两条实时来源相加：有品牌电表数 cabinets；共享电表取分摊行人工录入值（按月）。
        bid=None 表示全品牌合同 → 对应场地内共享电表兜底组（快照不含该组，走实时）。
        """
        if lid is None:
            return 0.0
        if ym and bid is not None:
            snap = (snap_cabs_by_month.get(str(ym)) or {}).get(lid)
            if snap is not None:
                return float(snap.get(bid, 0.0))
        cabs = float(live_brand_cabs.get(lid, {}).get(bid, 0.0))
        if ym and bid is not None:
            cabs += float((shared_cab_month.get(lid) or {}).get(str(ym), {}).get(bid, 0.0))
        return cabs

    def _contract_item(c: dict) -> dict:
        """合同明细项：月租 + 税费 + 该月分期状态 + 年租金/押金/单台/负责人 + 逐年付款情况"""
        monthly = float(c["monthly_rent"] or 0)
        annual = float(c["rent_amount"] or monthly * 12)
        rent_tax = 0.0
        if c["contract_type"] == "品牌方合同" and c["rent_tax_enabled"] and c.get("post_tax_rent_price") is not None:
            rent_tax = round(monthly - float(c["post_tax_rent_price"]), 2)
        # 收付拆分：品牌方合同=收款侧（已到账/未到账）；场地合同=付款侧（已付款/未付款）
        collected = uncollected = paid = unpaid = 0.0
        is_income = c["contract_type"] == "品牌方合同"
        for s in sched_map.get(c["contract_id"], []):
            amt = float(s["amount"] or 0)
            if is_income:
                if s["status"] == "已到账":
                    collected += amt
                else:
                    uncollected += amt
            else:
                if s["status"] == "已付款":
                    paid += amt
                else:
                    unpaid += amt
        return {
            "contractId": c["contract_id"],
            "contractType": c["contract_type"],
            "landlordId": c["landlord_id"],
            "landlordName": c["landlord_name"],
            "landlordContact": c.get("landlord_contact"),
            "landlordPhone": c.get("landlord_phone"),
            "brandId": c["brand_id"],
            "brandName": c["brand_name"],
            "entityId": c.get("entity_id"),
            "entityName": c.get("entity_name"),
            "monthlyRent": round(monthly, 2),
            "annualRent": round(annual, 2),
            "unitMonthlyRent": float(c["unit_monthly_rent"]) if c.get("unit_monthly_rent") is not None else None,
            "cabinetsCount": float(c["cabinets_count"]) if c.get("cabinets_count") is not None else None,
            "liveCabinetsCount": _live_cabs(c["landlord_id"], c.get("brand_id"), period) if is_income else None,
            "deposit": float(c["deposit"]) if c.get("deposit") is not None else None,
            "inputCost": float(c["input_cost"]) if c.get("input_cost") is not None else None,
            "rentTax": rent_tax,
            "rentTaxRate": float(c["rent_tax_rate"]) if c.get("rent_tax_rate") is not None else None,
            "postTaxRentPrice": float(c["post_tax_rent_price"]) if c.get("post_tax_rent_price") is not None else None,
            "payMethod": c["pay_method"],
            "startDate": str(c["start_date"])[:10] if c["start_date"] else None,
            "endDate": str(c["early_end_date"] or c["end_date"])[:10] if (c["early_end_date"] or c["end_date"]) else None,
            "paidAmount": round(paid, 2),
            "unpaidAmount": round(unpaid, 2),
            "collectedAmount": round(collected, 2),
            "uncollectedAmount": round(uncollected, 2),
            # 逐年付款/到账情况（品牌方=已到账，场地=已付款）
            "yearStatus": _year_status(c["contract_id"], ("已到账", "已付款") if is_income else ("已付款",)),
        }

    # 按维度组装
    rows = {}
    for c in contracts:
        item = _contract_item(c)
        if dim == "brand":
            # 品牌维度：只统计品牌方合同（收入侧）；无品牌合同不计
            if c["contract_type"] != "品牌方合同" or not c["brand_id"]:
                continue
            key = ("brand", c["brand_id"])
            g = rows.setdefault(key, {
                "key": c["brand_id"], "name": c["brand_name"] or f"品牌#{c['brand_id']}",
                "rentIncome": 0.0, "rentCost": 0.0, "rentTax": 0.0,
                "paidAmount": 0.0, "unpaidAmount": 0.0,
                "collectedAmount": 0.0, "uncollectedAmount": 0.0, "contracts": [],
            })
            g["rentIncome"] += item["monthlyRent"]
            g["rentTax"] += item["rentTax"]
        else:
            key = ("landlord", c["landlord_id"])
            g = rows.setdefault(key, {
                "key": c["landlord_id"], "name": c["landlord_name"] or f"场地#{c['landlord_id']}",
                "rentIncome": 0.0, "rentCost": 0.0, "rentTax": 0.0,
                "paidAmount": 0.0, "unpaidAmount": 0.0,
                "collectedAmount": 0.0, "uncollectedAmount": 0.0, "contracts": [],
            })
            if c["contract_type"] == "品牌方合同":
                g["rentIncome"] += item["monthlyRent"]
                g["rentTax"] += item["rentTax"]
            else:
                g["rentCost"] += item["monthlyRent"]
        if c["contract_type"] == "品牌方合同":
            g["collectedAmount"] += item["collectedAmount"]
            g["uncollectedAmount"] += item["uncollectedAmount"]
        else:
            g["paidAmount"] += item["paidAmount"]
            g["unpaidAmount"] += item["unpaidAmount"]
        g["contracts"].append(item)

    # 为每个品牌方合同附加「场地合同付款信息」快照（v3：品牌行 = 场地付款 + 品牌收款）
    # - venueShareAnnual：该品牌承担的场地成本/年——按合同周期逐月累计：
    #     每个月 = 场地月租金 × 该品牌计费柜数 ÷ 该月所有在期品牌计费柜数之和；
    #     合同只覆盖 N 个月就累加 N 个月（如 7 月开始 → 只承担 7-12 月）
    # - unitCostAnnual：单台成本/年 = 场地年付款金额 ÷ 该年有品牌在期的月份平均总柜数（整场地同一值）
    from calendar import monthrange

    year = period[:4]

    def _ym_bounds(ym: str):
        ms = ym + "01"
        me = ym + str(monthrange(int(ym[:4]), int(ym[4:]))[1]).zfill(2)
        return ms, me

    def _covers_month(c: dict, ym: str) -> bool:
        ms, me = _ym_bounds(ym)
        s = str(c["start_date"]).replace("-", "") if c["start_date"] else "00000000"
        e = str(c["early_end_date"] or c["end_date"]).replace("-", "") if (c["early_end_date"] or c["end_date"]) else "99999999"
        return s <= me and e >= ms

    def _month_brand_cabs(lid: int, ym: str) -> float:
        """该场地 ym 月在期品牌合同覆盖品牌的实时计费柜数之和（同品牌多份合同不重复计）"""
        brand_ids = {c.get("brand_id") for c in year_contracts
                     if c["contract_type"] == "品牌方合同"
                     and c["landlord_id"] == lid
                     and _covers_month(c, ym)}
        return sum(_live_cabs(lid, bid, ym) for bid in brand_ids)

    def _venue_share_annual(lid: int, brand_id: int) -> float:
        """该品牌 year 年承担的场地成本（逐月累计：场地月租 × 该品牌当月柜数 / 该月在期总柜数）

        分子分母必须**同月同口径**取柜数：共享电表的柜数逐月可调，若分子固定用当月值、
        分母逐月变，比例会失真（实测会把年分摊额顶到场地年租的数倍）。
        """
        venue_monthly = next(
            (float(c["monthly_rent"] or 0) for c in year_contracts
             if c["contract_type"] == "场地合同" and c["landlord_id"] == lid), 0.0)
        if not venue_monthly:
            return 0.0
        total = 0.0
        for mm in range(1, 13):
            ym = f"{year}{mm:02d}"
            month_cabs = _month_brand_cabs(lid, ym)
            if month_cabs <= 0:
                continue
            # 该品牌合同覆盖该月才承担
            covers = any(
                c["contract_type"] == "品牌方合同"
                and c["landlord_id"] == lid
                and c.get("brand_id") == brand_id
                and _covers_month(c, ym)
                for c in year_contracts
            )
            if covers:
                # 分子取该月该品牌柜数，与分母同月
                total += venue_monthly * _live_cabs(lid, brand_id, ym) / month_cabs
        return round(total, 2)

    for g in rows.values():
        landlord_id = g["key"] if dim == "landlord" else None
        # brand 维度下：场地合同来自品牌合同所在场地
        if dim == "brand":
            brand_landlord_ids = {c.get("landlordId") for c in g["contracts"] if c.get("landlordId")}
            venue_contracts = [c for c in year_contracts
                               if c["contract_type"] == "场地合同"
                               and c["landlord_id"] in brand_landlord_ids]
        else:
            venue_contracts = [c for c in year_contracts
                               if c["contract_type"] == "场地合同"
                               and c["landlord_id"] == landlord_id]
        venue = _contract_item(venue_contracts[0]) if venue_contracts else None
        venue_lid = venue["landlordId"] if venue else (landlord_id if dim == "landlord" else None)
        # 该年各月在期品牌总柜数（有品牌在期的月份做平均，用于单台成本/年）
        monthly_cabs = [_month_brand_cabs(venue_lid, f"{year}{mm:02d}") for mm in range(1, 13)] if venue_lid else []
        active = [x for x in monthly_cabs if x > 0]
        avg_month_cabs = sum(active) / len(active) if active else 0.0
        venue_annual = float(venue["annualRent"]) if venue else 0.0
        unit_cost_annual = round(venue_annual / avg_month_cabs, 2) if venue and avg_month_cabs > 0 else None
        for item in g["contracts"]:
            if item["contractType"] != "品牌方合同":
                continue
            brand_cabs = _live_cabs(item["landlordId"], item["brandId"], period)
            venue_share_annual = _venue_share_annual(venue_lid, item["brandId"]) if venue_lid else 0.0
            # 当月平摊场地成本 = 场地月租 × 该品牌柜数 ÷ 该月在期品牌总柜数（与 Rent 页年度口径同一算法）
            venue_monthly = float(venue["monthlyRent"]) if venue else 0.0
            venue_share_month = 0.0
            if venue_lid and brand_cabs and venue_monthly:
                month_cabs = _month_brand_cabs(venue_lid, period)
                if month_cabs > 0:
                    venue_share_month = round(venue_monthly * brand_cabs / month_cabs, 2)
            item["venueContract"] = venue
            item["venueShareAnnual"] = venue_share_annual
            item["venueShareMonth"] = venue_share_month
            item["unitCostAnnual"] = unit_cost_annual

    result_rows = []
    totals = {"rentIncome": 0.0, "rentCost": 0.0, "rentTax": 0.0,
              "paidAmount": 0.0, "unpaidAmount": 0.0, "collectedAmount": 0.0, "uncollectedAmount": 0.0}
    for key, g in sorted(rows.items(), key=lambda kv: kv[1]["name"]):
        g["rentProfit"] = round(g["rentIncome"] - g["rentCost"] - g["rentTax"], 2)
        for k in ("rentIncome", "rentCost", "rentTax", "paidAmount", "unpaidAmount", "collectedAmount", "uncollectedAmount"):
            g[k] = round(g[k], 2)
            totals[k] += g[k]
        result_rows.append(g)
    totals["rentProfit"] = round(totals["rentIncome"] - totals["rentCost"] - totals["rentTax"], 2)

    # ── 整年场地收支明细（yearlyRows）：按 场地×品牌 用全年合同构建（框外展示）──
    # 每个品牌合同一行：场地付款信息（venueContract 快照）+ 品牌收款信息（整年口径）
    yearly_map = {}  # (landlord_id) -> {name, venue, brands: [...]}
    for c in year_contracts:
        if c["contract_type"] == "品牌方合同":
            lid = c["landlord_id"]
            if lid not in yearly_map:
                venue_cs = [x for x in year_contracts
                            if x["contract_type"] == "场地合同" and x["landlord_id"] == lid]
                yearly_map[lid] = {
                    "landlordId": lid,
                    "landlordName": c["landlord_name"],
                    "venue": _contract_item(venue_cs[0]) if venue_cs else None,
                    "brands": [],
                }
            item = _contract_item(c)
            yearly_map[lid]["brands"].append(item)

    # 为整年品牌行计算分摊（复用逐月逻辑）
    for lid, gy in yearly_map.items():
        venue = gy["venue"]
        venue_lid = venue["landlordId"] if venue else lid
        # 公司主体：优先场地合同的报税主体，缺失时回退任一品牌方合同的主体
        ent = next((x for x in ([venue] if venue else []) + gy["brands"] if x.get("entityId")), None)
        gy["entityId"] = ent.get("entityId") if ent else None
        gy["entityName"] = (ent.get("entityName") if ent else None) or "未指定主体"
        monthly_cabs = [_month_brand_cabs(venue_lid, f"{year}{mm:02d}") for mm in range(1, 13)] if venue_lid else []
        active = [x for x in monthly_cabs if x > 0]
        avg_month_cabs = sum(active) / len(active) if active else 0.0
        venue_annual = float(venue["annualRent"]) if venue else 0.0
        gy["unitCostAnnual"] = round(venue_annual / avg_month_cabs, 2) if venue and avg_month_cabs > 0 else None
        for item in gy["brands"]:
            item["venueContract"] = venue
            item["venueShareAnnual"] = _venue_share_annual(venue_lid, item["brandId"]) if venue_lid else 0.0
            item["unitCostAnnual"] = gy["unitCostAnnual"]

    yearly_rows = sorted(yearly_map.values(), key=lambda x: (x["entityName"] or "", x["landlordName"] or ""))

    # 公司主体名称：挂到月份明细的每一行，前端按主体分块展示（场地维度按场地方取，品牌维度按品牌取）
    if result_rows:
        from ..infra.database import get_connection as _gc, get_dict_cursor as _gdc
        conn2 = _gc()
        cur2 = _gdc(conn2)
        ent_map = {}
        meter_ent_by_landlord = {}
        meter_ent_by_brand = {}
        try:
            # 电表主体兜底映射（合同未选主体时按电表归属，与合同页/主体损益表同口径）
            cur2.execute("""
                SELECT m.landlord_id AS lid, m.brand_id AS bid, ent.name AS entity_name
                FROM meters m JOIN entities ent ON ent.id = m.entity_id
                WHERE m.meter_no NOT LIKE 'TEST%%'
                  AND (m.brand_id IS NOT NULL OR m.is_shared = TRUE)
                GROUP BY m.landlord_id, m.brand_id, ent.name
            """)
            for r in cur2.fetchall():
                meter_ent_by_landlord.setdefault(r["lid"], r["entity_name"])
                if r["bid"] is not None:
                    meter_ent_by_brand.setdefault(r["bid"], r["entity_name"])
            keys = [g["key"] for g in result_rows if g.get("key") is not None]
            if keys:
                if dim == "landlord":
                    cur2.execute("""
                        SELECT c.landlord_id AS k, MAX(ent.name) AS entity_name
                        FROM contracts c LEFT JOIN entities ent ON ent.id = c.entity_id
                        WHERE c.landlord_id = ANY(%s::int[]) AND c.entity_id IS NOT NULL
                        GROUP BY c.landlord_id
                    """, (keys,))
                else:
                    cur2.execute("""
                        SELECT c.brand_id AS k, MAX(ent.name) AS entity_name
                        FROM contracts c LEFT JOIN entities ent ON ent.id = c.entity_id
                        WHERE c.brand_id = ANY(%s::int[]) AND c.entity_id IS NOT NULL
                        GROUP BY c.brand_id
                    """, (keys,))
                ent_map = {r["k"]: r["entity_name"] for r in cur2.fetchall()}
        finally:
            cur2.close()
            conn2.close()
        for g in result_rows:
            # 归属链：合同主体 → 电表主体 → 未指定主体
            if dim == "landlord":
                g["entityName"] = ent_map.get(g.get("key")) or meter_ent_by_landlord.get(g.get("key")) or "未指定主体"
            else:
                g["entityName"] = ent_map.get(g.get("key")) or meter_ent_by_brand.get(g.get("key")) or "未指定主体"
        # 年度行主体兜底（场地合同主体 → 品牌合同主体之后，补电表主体）并重排序
        for gy in yearly_rows:
            if (gy.get("entityName") or "未指定主体") == "未指定主体":
                name = meter_ent_by_landlord.get(gy.get("landlordId"))
                if name:
                    gy["entityName"] = name
        yearly_rows.sort(key=lambda x: (x.get("entityName") or "", x.get("landlordName") or ""))

    return {"period": period, "dim": dim, "rows": result_rows, "totals": totals, "yearlyRows": yearly_rows}


# ─── 年度付款计划（Rent 页底部模块）──────────────────────────
# 返回某场地方的场地合同在指定年份的付款分期明细 + 关联审批记录

@router.get("/yearly-payment-schedule")
async def yearly_payment_schedule(request: Request, landlordId: int = Query(...), year: str = Query(...)):
    """年度付款计划：场地合同的当年付款分期明细 + 审批状态"""
    from ..infra.database import get_connection, get_dict_cursor

    # 股东账号：只能查看关联场地的付款计划
    allowed = scope_landlord_ids(request)
    if allowed is not None and landlordId not in allowed:
        raise HTTPException(403, "无权查看该场地付款计划")

    year_s = str(year).strip()[:4]
    year_start = f"{year_s}-01-01"
    year_end = f"{year_s}-12-31"

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 查场地合同
        cur.execute("""
            SELECT c.id AS contract_id, c.monthly_rent, c.rent_amount, c.pay_method,
                   c.start_date, c.end_date, c.early_end_date,
                   l.id AS landlord_id, l.name AS landlord_name
            FROM contracts c
            JOIN landlords l ON c.landlord_id = l.id
            WHERE c.landlord_id = %s AND c.contract_type = '场地合同'
            ORDER BY c.id DESC LIMIT 1
        """, (landlordId,))
        venue = cur.fetchone()

        # ── 收款侧：该场地方所有品牌方合同当年的收款分期（场地费收款，品牌方 → 公司）──
        cur.execute("""
            SELECT c.id AS contract_id, COALESCE(b.name, '全品牌共享') AS brand_name,
                   c.monthly_rent, c.start_date, c.early_end_date, c.end_date,
                   s.id AS sched_id, s.seq, s.period_start, s.period_end, s.amount, s.status, s.pay_date
            FROM contracts c
            LEFT JOIN brands b ON b.id = c.brand_id
            LEFT JOIN rent_income_schedule s
                   ON s.contract_id = c.id
                  AND s.period_start <= %s::date AND s.period_end >= %s::date
            WHERE c.landlord_id = %s AND c.contract_type = '品牌方合同'
            ORDER BY c.id, s.seq
        """, (year_end, year_start, landlordId))
        income_map: dict = {}
        for r in cur.fetchall():
            cid = r["contract_id"]
            entry = income_map.get(cid)
            if entry is None:
                entry = income_map[cid] = {
                    "contractId": cid,
                    "brandName": r.get("brand_name") or "全品牌共享",
                    "monthlyRent": float(r.get("monthly_rent") or 0),
                    "startDate": str(r["start_date"])[:10] if r.get("start_date") else None,
                    "endDate": str(r.get("early_end_date") or r.get("end_date"))[:10] if (r.get("early_end_date") or r.get("end_date")) else None,
                    "schedules": [],
                }
            if r.get("sched_id") is not None:
                entry["schedules"].append({
                    "id": r["sched_id"],
                    "seq": r["seq"],
                    "periodStart": str(r["period_start"])[:10] if r.get("period_start") else None,
                    "periodEnd": str(r["period_end"])[:10] if r.get("period_end") else None,
                    "amount": float(r.get("amount") or 0),
                    "status": r.get("status") or "未到账",
                    "payDate": str(r["pay_date"])[:10] if r.get("pay_date") else None,
                })
        income_contracts = list(income_map.values())
        for ic in income_contracts:
            ic["totalCount"] = len(ic["schedules"])
            ic["paidCount"] = sum(1 for x in ic["schedules"] if x["status"] == "已到账")
            ic["totalAmount"] = round(sum(x["amount"] for x in ic["schedules"]), 2)
            ic["paidAmount"] = round(sum(x["amount"] for x in ic["schedules"] if x["status"] == "已到账"), 2)
        income_total = round(sum(ic["totalAmount"] for ic in income_contracts), 2)
        income_paid = round(sum(ic["paidAmount"] for ic in income_contracts), 2)
        income_paid_count = sum(ic["paidCount"] for ic in income_contracts)
        income_total_count = sum(ic["totalCount"] for ic in income_contracts)

        if not venue:
            return {
                "landlordId": landlordId, "landlordName": "", "year": year_s,
                "venueContract": None, "schedules": [],
                "totalAmount": 0, "paidAmount": 0, "paidCount": 0, "totalCount": 0,
                "incomeContracts": income_contracts,
                "incomeTotalAmount": income_total, "incomePaidAmount": income_paid,
                "incomePaidCount": income_paid_count, "incomeTotalCount": income_total_count,
            }

        # 查该场地合同当年的付款分期
        cur.execute("""
            SELECT id, seq, period_start, period_end, amount, status, pay_date, invoice, remark
            FROM rent_payment_schedule
            WHERE contract_id = %s
              AND period_start <= %s::date
              AND period_end >= %s::date
            ORDER BY seq
        """, (venue["contract_id"], year_end, year_start))
        schedules = cur.fetchall()

        # 查该场地方当年的场地费付款审批记录
        cur.execute("""
            SELECT id, title, amount, status, period, rent_amount, created_at, finished_at
            FROM approval_requests
            WHERE landlord_id = %s
              AND biz_type = '场地费付款'
              AND status IN ('审批中', '已通过', '已驳回')
            ORDER BY created_at DESC
        """, (landlordId,))
        approvals = cur.fetchall()

        # 为每个分期关联审批记录（按 period 匹配）+ 经营佐证（供审核核验真实性）
        # 场地租金收入（品牌方合同月租合计，按场地固定）；电费收入按该期首月台账
        cur.execute("""
            SELECT COALESCE(SUM(c.monthly_rent), 0) as total
            FROM contracts c
            WHERE c.contract_type = '品牌方合同' AND c.landlord_id = %s
        """, (landlordId,))
        venue_income = float(cur.fetchone()["total"] or 0)

        for s in schedules:
            s_period_start = s["period_start"]
            if s_period_start:
                s_month = str(s_period_start)[:7]  # YYYY-MM
                s["approvals"] = [
                    a for a in approvals
                    if a.get("period") and str(a["period"]).replace("-", "")[:6] == s_month.replace("-", "")[:6]
                ]
                # 该期首月电费收入（台账口径，不含税）
                s_month_key = s_month.replace("-", "")[:6]
                cur.execute("""
                    SELECT COALESCE(SUM(e.collect_net), 0) as total
                    FROM electricity_records e
                    WHERE e.landlord_id = %s AND e.period = %s
                """, (landlordId, s_month_key))
                s["monthElecIncome"] = float(cur.fetchone()["total"] or 0)
            else:
                s["approvals"] = []
                s["monthElecIncome"] = 0.0
            s["monthIncome"] = venue_income

        paid_count = sum(1 for s in schedules if s["status"] == "已付款")
        paid_amount = sum(float(s["amount"] or 0) for s in schedules if s["status"] == "已付款")
        total_amount = sum(float(s["amount"] or 0) for s in schedules)

        return {
            "landlordId": landlordId,
            "landlordName": venue["landlord_name"],
            "year": year_s,
            "venueContract": {
                "contractId": venue["contract_id"],
                "monthlyRent": float(venue["monthly_rent"] or 0),
                "annualRent": float(venue["rent_amount"] or venue["monthly_rent"] or 0) * 12 if not venue["rent_amount"] else float(venue["rent_amount"]),
                "payMethod": venue["pay_method"],
                "startDate": str(venue["start_date"])[:10] if venue["start_date"] else None,
                "endDate": str(venue["early_end_date"] or venue["end_date"])[:10] if (venue["early_end_date"] or venue["end_date"]) else None,
            },
            "schedules": [{
                "id": s["id"],
                "seq": s["seq"],
                "periodStart": str(s["period_start"])[:10] if s["period_start"] else None,
                "periodEnd": str(s["period_end"])[:10] if s["period_end"] else None,
                "amount": float(s["amount"] or 0),
                "status": s["status"],
                "payDate": str(s["pay_date"])[:10] if s["pay_date"] else None,
                "monthIncome": s.get("monthIncome", 0.0),
                "monthElecIncome": s.get("monthElecIncome", 0.0),
                "approvals": s.get("approvals", []),
            } for s in schedules],
            "totalAmount": round(total_amount, 2),
            "paidAmount": round(paid_amount, 2),
            "paidCount": paid_count,
            "totalCount": len(schedules),
            "incomeContracts": income_contracts,
            "incomeTotalAmount": income_total,
            "incomePaidAmount": income_paid,
            "incomePaidCount": income_paid_count,
            "incomeTotalCount": income_total_count,
        }
    finally:
        cur.close()
        conn.close()
