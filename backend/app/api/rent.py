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
async def list_expenses(request: Request, stationId: int = None, period: str = None):
    # period 统一为 6 位 YYYYMM（与 operating_expenses.period 存储格式一致）
    if period:
        period = to_compact(period)
    return _scope_rows(request, rent_repo.list_expenses(station_id=stationId, period=period))


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
                   c.brand_id, b.name AS brand_name, c.monthly_rent,
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

        # 分期状态（收款=品牌方合同，付款=场地合同；仅覆盖该月的期次）
        cur.execute("""
            SELECT 'income' AS side, contract_id, status, period_start, period_end, amount
            FROM rent_income_schedule
            WHERE period_start <= %s AND period_end >= %s
        """, (me, ms))
        inc_scheds = cur.fetchall()
        cur.execute("""
            SELECT 'payment' AS side, contract_id, status, period_start, period_end, amount
            FROM rent_payment_schedule
            WHERE period_start <= %s AND period_end >= %s
        """, (me, ms))
        pay_scheds = cur.fetchall()
    finally:
        cur.close()
        conn.close()

    sched_map = {}
    for s in inc_scheds + pay_scheds:
        sched_map.setdefault(s["contract_id"], []).append(s)

    def _contract_item(c: dict) -> dict:
        """合同明细项：月租 + 税费 + 该月分期状态"""
        monthly = float(c["monthly_rent"] or 0)
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
        return {
            "contractId": c["contract_id"],
            "contractType": c["contract_type"],
            "landlordId": c["landlord_id"],
            "landlordName": c["landlord_name"],
            "brandId": c["brand_id"],
            "brandName": c["brand_name"],
            "monthlyRent": round(monthly, 2),
            "rentTax": rent_tax,
            "payMethod": c["pay_method"],
            "startDate": str(c["start_date"])[:10] if c["start_date"] else None,
            "endDate": str(c["early_end_date"] or c["end_date"])[:10] if (c["early_end_date"] or c["end_date"]) else None,
            "paidAmount": round(paid, 2),
            "pendingAmount": round(pending, 2),
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

    result_rows = []
    totals = {"rentIncome": 0.0, "rentCost": 0.0, "rentTax": 0.0, "paidAmount": 0.0, "pendingAmount": 0.0}
    for key, g in sorted(rows.items(), key=lambda kv: kv[1]["name"]):
        g["rentProfit"] = round(g["rentIncome"] - g["rentCost"] - g["rentTax"], 2)
        for k in ("rentIncome", "rentCost", "rentTax", "paidAmount", "pendingAmount"):
            g[k] = round(g[k], 2)
            totals[k] += g[k]
        result_rows.append(g)
    totals["rentProfit"] = round(totals["rentIncome"] - totals["rentCost"] - totals["rentTax"], 2)

    return {"period": period, "dim": dim, "rows": result_rows, "totals": totals}
