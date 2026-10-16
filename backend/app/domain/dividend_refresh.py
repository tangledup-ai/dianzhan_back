"""分红记录刷新：上游数据（合同 / 电表归属 / 柜子 / 电费台账 / 运营费用）变更后自动重算。

权威计算在 dividend_calc.calculate；本模块只负责"哪些记录需要重算、何时重算"。
未进入审批的分红随上游变动重算。已提交、已批准或已结算记录保留原金额，避免
静默改写已提交给股东或已经付款的财务凭证；这类记录返回 protected 供调用方提示复核/更正。
"""
from ..infra.period import to_compact
from ..repositories import dividend_repo
from .dividend_calc import dividend_calculator


def refresh_dividend_records(landlord_id, periods: list = None) -> dict:
    """重算某场地方（可选限定月份列表）的分红记录并同步分红明细。

    periods 为空时重算该场地下已有分红记录的全部月份（记录不存在则无操作）。
    返回 {"refreshed": n}。
    """
    if not landlord_id:
        return {"refreshed": 0}
    existing = dividend_repo.list_periods(landlord_id)
    if periods:
        wanted = {to_compact(str(p)) for p in periods if p}
        targets = [p for p in existing if p in wanted]
    else:
        targets = existing

    refreshed = 0
    protected = 0
    for period in targets:
        for record in dividend_repo.list_records(landlord_id=landlord_id, period=period):
            if record.get("status") in ("申报中", "已通过", "已结算"):
                protected += 1
                continue
            calc = dividend_calculator.calculate(landlord_id, record.get("brand_id"), period)
            if not calc:
                continue
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
            dividend_repo.delete_shares(record["id"])
            if record.get("type", "股东分红") == "商务分红":
                shares = [{"introducerId": d["introducerId"],
                           "brandId": d.get("brandId"), "entityId": d.get("entityId"),
                           "mode": d["mode"], "ratio": d.get("ratio"), "fixedAmount": d.get("fixedAmount"),
                           "amount": d["amount"]} for d in calc["bizDividends"]]
            else:
                shares = [{"shareholderId": d["shareholderId"],
                           "brandId": d.get("brandId"), "entityId": d.get("entityId"),
                           "mode": d["mode"], "ratio": d.get("ratio"), "fixedAmount": d.get("fixedAmount"),
                           "amount": d["amount"]} for d in calc["shareholderDividends"]]
            for d in shares:
                dividend_repo.create_share(record["id"], d)
            refreshed += 1
    return {"refreshed": refreshed, "protected": protected}
