from fastapi import APIRouter, HTTPException, Query, Request
from ..repositories import rent_repo, dividend_repo
from ..domain.dividend_calc import dividend_calculator
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
    result = rent_repo.save_expense(
        landlord_id=data.get("landlordId"),
        period=period,
        amount=data.get("amount"),
        remark=data.get("remark"),
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
    """运营费用变更后：更新该场地该月的分红记录（v3 按 场地×品牌 重算）"""
    if not landlord_id or not period:
        return

    # period 统一为 6 位，与 dividend_records.period 存储格式一致
    period = to_compact(period)

    # 查找该场地该月的分红记录
    records = dividend_repo.list_records(landlord_id=landlord_id, period=period)
    if not records:
        return

    for record in records:
        # 重新计算分红（按记录的 brand 维度；整场地记录 brand_id 为空）
        calc = dividend_calculator.calculate(landlord_id, record.get("brand_id"), period)
        if not calc:
            continue

        # 更新分红记录
        dividend_repo.update_record(record["id"], {
            "elecIncome": calc["income"]["elecIncome"]["total"],
            "rentIncome": calc["income"]["rentIncome"]["total"],
            "totalIncome": calc["income"]["totalIncome"],
            "elecCost": calc["cost"]["elecCost"],
            "rentCost": calc["cost"]["rentCost"],
            "opExpense": calc["cost"]["opExpense"],
            "bizDividendCost": calc["cost"]["bizDividendCost"],
            "totalCost": calc["cost"]["totalCost"],
            "profit": calc["profit"],
        })

        # 更新分红明细
        dividend_repo.delete_shares(record["id"])
        dividend_type = record.get("type", "股东分红")
        if dividend_type == "商务分红":
            for d in calc["bizDividends"]:
                dividend_repo.create_share(record["id"], {
                    "introducerId": d["introducerId"],
                    "brandId": d.get("brandId"),
                    "mode": d["mode"],
                    "ratio": d.get("ratio"),
                    "fixedAmount": d.get("fixedAmount"),
                    "amount": d["amount"],
                })
        else:
            for d in calc["shareholderDividends"]:
                dividend_repo.create_share(record["id"], {
                    "shareholderId": d["shareholderId"],
                    "brandId": d.get("brandId"),
                    "mode": d["mode"],
                    "ratio": d.get("ratio"),
                    "fixedAmount": d.get("fixedAmount"),
                    "amount": d["amount"],
                })


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
    y, m = int(period[:4]), int(period[4:6])
    month_end = (date(y + 1, 1, 1) - timedelta(days=1)) if m == 12 else (date(y, m + 1, 1) - timedelta(days=1))
    ms = period + "01"  # 月初 YYYYMMDD
    me = month_end.strftime("%Y%m%d")

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 覆盖该月的全部场地费合同（场地合同=成本，品牌方合同=收入）
        cur.execute("""
            SELECT c.id AS contract_id, c.contract_type, c.landlord_id, l.name AS landlord_name,
                   l.contact AS landlord_contact, l.phone AS landlord_phone,
                   c.brand_id, b.name AS brand_name, c.monthly_rent, c.rent_amount,
                   c.unit_monthly_rent, c.cabinets_count, c.deposit, c.input_cost,
                   c.rent_tax_enabled, c.rent_tax_rate, c.post_tax_rent_price,
                   c.pay_method, c.start_date, c.end_date, c.early_end_date, c.first_month_rent
            FROM contracts c
            LEFT JOIN landlords l ON c.landlord_id = l.id
            LEFT JOIN brands b ON c.brand_id = b.id
            WHERE (c.start_date IS NULL OR c.start_date <= %s)
              AND (COALESCE(c.early_end_date, c.end_date) IS NULL OR COALESCE(c.early_end_date, c.end_date) >= %s)
            ORDER BY c.landlord_id, c.contract_type, c.id
        """, (me, ms))
        contracts = cur.fetchall()

        # 全年合同（含已结束/未开始的品牌合同）：用于「承担场地成本按合同周期逐月分摊」——
        # 查看月是 8 月时，某品牌合同若只覆盖 1-6 月（已结束），不在 contracts 里，
        # 但分摊 2026 年 1-6 月场地费时它仍参与，故需单独查全年。
        year_start_s = period[:4] + "0101"
        year_end_s = period[:4] + "1231"
        cur.execute("""
            SELECT c.id AS contract_id, c.contract_type, c.landlord_id, l.name AS landlord_name,
                   l.contact AS landlord_contact, l.phone AS landlord_phone,
                   c.brand_id, b.name AS brand_name, c.monthly_rent, c.rent_amount,
                   c.unit_monthly_rent, c.cabinets_count, c.deposit, c.input_cost,
                   c.rent_tax_enabled, c.rent_tax_rate, c.post_tax_rent_price,
                   c.pay_method, c.start_date, c.end_date, c.early_end_date, c.first_month_rent
            FROM contracts c
            LEFT JOIN landlords l ON c.landlord_id = l.id
            LEFT JOIN brands b ON c.brand_id = b.id
            WHERE (c.start_date IS NULL OR c.start_date <= %s)
              AND (COALESCE(c.early_end_date, c.end_date) IS NULL OR COALESCE(c.early_end_date, c.end_date) >= %s)
            ORDER BY c.landlord_id, c.contract_type, c.id
        """, (year_end_s, year_start_s))
        year_contracts = cur.fetchall()

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

    def _contract_item(c: dict) -> dict:
        """合同明细项：月租 + 税费 + 该月分期状态 + 年租金/押金/单台/负责人 + 逐年付款情况"""
        monthly = float(c["monthly_rent"] or 0)
        annual = float(c["rent_amount"] or monthly * 12)
        rent_tax = 0.0
        if c["contract_type"] == "品牌方合同" and c["rent_tax_enabled"] and c.get("post_tax_rent_price") is not None:
            rent_tax = round(monthly - float(c["post_tax_rent_price"]), 2)
        paid = pending = 0.0
        for s in sched_map.get(c["contract_id"], []):
            amt = float(s["amount"] or 0)
            if s["status"] in ("已到账", "已付款"):
                paid += amt
            else:
                pending += amt
        is_income = c["contract_type"] == "品牌方合同"
        return {
            "contractId": c["contract_id"],
            "contractType": c["contract_type"],
            "landlordId": c["landlord_id"],
            "landlordName": c["landlord_name"],
            "landlordContact": c.get("landlord_contact"),
            "landlordPhone": c.get("landlord_phone"),
            "brandId": c["brand_id"],
            "brandName": c["brand_name"],
            "monthlyRent": round(monthly, 2),
            "annualRent": round(annual, 2),
            "unitMonthlyRent": float(c["unit_monthly_rent"]) if c.get("unit_monthly_rent") is not None else None,
            "cabinetsCount": float(c["cabinets_count"]) if c.get("cabinets_count") is not None else None,
            "deposit": float(c["deposit"]) if c.get("deposit") is not None else None,
            "inputCost": float(c["input_cost"]) if c.get("input_cost") is not None else None,
            "rentTax": rent_tax,
            "rentTaxRate": float(c["rent_tax_rate"]) if c.get("rent_tax_rate") is not None else None,
            "postTaxRentPrice": float(c["post_tax_rent_price"]) if c.get("post_tax_rent_price") is not None else None,
            "payMethod": c["pay_method"],
            "startDate": str(c["start_date"])[:10] if c["start_date"] else None,
            "endDate": str(c["early_end_date"] or c["end_date"])[:10] if (c["early_end_date"] or c["end_date"]) else None,
            "paidAmount": round(paid, 2),
            "pendingAmount": round(pending, 2),
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
                "paidAmount": 0.0, "pendingAmount": 0.0, "contracts": [],
            })
            g["rentIncome"] += item["monthlyRent"]
            g["rentTax"] += item["rentTax"]
        else:
            key = ("landlord", c["landlord_id"])
            g = rows.setdefault(key, {
                "key": c["landlord_id"], "name": c["landlord_name"] or f"场地#{c['landlord_id']}",
                "rentIncome": 0.0, "rentCost": 0.0, "rentTax": 0.0,
                "paidAmount": 0.0, "pendingAmount": 0.0, "contracts": [],
            })
            if c["contract_type"] == "品牌方合同":
                g["rentIncome"] += item["monthlyRent"]
                g["rentTax"] += item["rentTax"]
            else:
                g["rentCost"] += item["monthlyRent"]
        g["paidAmount"] += item["paidAmount"]
        g["pendingAmount"] += item["pendingAmount"]
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
        """该场地 ym 月所有在期品牌合同的计费柜数之和（用全年合同计算）"""
        return sum(
            float(c.get("cabinets_count") or 0) for c in year_contracts
            if c["contract_type"] == "品牌方合同"
            and c["landlord_id"] == lid
            and _covers_month(c, ym)
        )

    def _venue_share_annual(lid: int, brand_id: int, brand_cabs: float) -> float:
        """该品牌 year 年承担的场地成本（逐月累计：场地月租 × 品牌柜数 / 该月在期总柜数）"""
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
                total += venue_monthly * brand_cabs / month_cabs
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
            brand_cabs = float(item["cabinetsCount"] or 0)
            venue_share_annual = _venue_share_annual(venue_lid, item["brandId"], brand_cabs) if venue_lid else 0.0
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
    totals = {"rentIncome": 0.0, "rentCost": 0.0, "rentTax": 0.0, "paidAmount": 0.0, "pendingAmount": 0.0}
    for key, g in sorted(rows.items(), key=lambda kv: kv[1]["name"]):
        g["rentProfit"] = round(g["rentIncome"] - g["rentCost"] - g["rentTax"], 2)
        for k in ("rentIncome", "rentCost", "rentTax", "paidAmount", "pendingAmount"):
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
        monthly_cabs = [_month_brand_cabs(venue_lid, f"{year}{mm:02d}") for mm in range(1, 13)] if venue_lid else []
        active = [x for x in monthly_cabs if x > 0]
        avg_month_cabs = sum(active) / len(active) if active else 0.0
        venue_annual = float(venue["annualRent"]) if venue else 0.0
        gy["unitCostAnnual"] = round(venue_annual / avg_month_cabs, 2) if venue and avg_month_cabs > 0 else None
        for item in gy["brands"]:
            brand_cabs = float(item["cabinetsCount"] or 0)
            item["venueContract"] = venue
            item["venueShareAnnual"] = _venue_share_annual(venue_lid, item["brandId"], brand_cabs) if venue_lid else 0.0
            item["unitCostAnnual"] = gy["unitCostAnnual"]

    yearly_rows = sorted(yearly_map.values(), key=lambda x: x["landlordName"] or "")

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

        if not venue:
            return {
                "landlordId": landlordId, "landlordName": "", "year": year_s,
                "venueContract": None, "schedules": [],
                "totalAmount": 0, "paidAmount": 0, "paidCount": 0, "totalCount": 0,
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
        }
    finally:
        cur.close()
        conn.close()
