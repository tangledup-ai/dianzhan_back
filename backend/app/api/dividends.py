from fastapi import APIRouter, HTTPException, Request
from ..repositories import dividend_repo, approval_repo
from ..domain.dividend_calc import dividend_calculator
from ..infra.auth_scope import scope_landlord_ids
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/dividends", tags=["分红管理"], default_response_class=CamelJSONResponse)


# ─── 分红配置（v3：挂 场地 landlord_id，brand_id 空=整场地 / 非空=指定品牌）───────────────

@router.get("/configs/shareholder")
async def list_shareholder_configs(landlordId: int = None):
    return dividend_repo.list_shareholder_configs(landlord_id=landlordId)


@router.post("/configs/shareholder", status_code=201)
async def save_shareholder_config(data: dict):
    return dividend_repo.save_shareholder_config(data)


@router.delete("/configs/shareholder/{config_id}")
async def delete_shareholder_config(config_id: int):
    dividend_repo.delete_shareholder_config(config_id)
    return {"ok": True}


@router.get("/configs/introducer")
async def list_introducer_configs(landlordId: int = None):
    return dividend_repo.list_introducer_configs(landlord_id=landlordId)


@router.post("/configs/introducer", status_code=201)
async def save_introducer_config(data: dict):
    return dividend_repo.save_introducer_config(data)


@router.delete("/configs/introducer/{config_id}")
async def delete_introducer_config(config_id: int):
    dividend_repo.delete_introducer_config(config_id)
    return {"ok": True}


# ─── 分红计算 ───────────────────────────────────────────────

@router.post("/calculate")
async def calculate_dividend(data: dict, request: Request):
    """计算分红（预览，不入库）v3：按 场地(+品牌) 计算。
    estimate=true 时：返回本月预估分红（不乘周期倍数）+ 周期信息（是否结算月/周期起点月）。"""
    from ..infra.period import to_compact
    landlord_id = data.get("landlordId")
    brand_id = data.get("brandId")
    estimate = bool(data.get("estimate"))
    period = to_compact(data.get("period"))
    if not landlord_id or not period:
        raise HTTPException(400, "landlordId 和 period 必填")

    # 股东：只能计算关联场地的分红
    allowed = scope_landlord_ids(request)
    if allowed is not None and int(landlord_id) not in allowed:
        raise HTTPException(403, "无权查看该场地分红")

    result = dividend_calculator.calculate(int(landlord_id), brand_id, period, estimate=estimate)
    if not result:
        raise HTTPException(404, "场地不存在")
    return result


@router.post("/refresh")
async def refresh_dividends(data: dict, request: Request):
    """手动重算：某场地方（可选限定月份）的分红记录按最新上游数据重算（所有状态一律重算）。"""
    from ..domain.dividend_refresh import refresh_dividend_records
    from ..infra.period import to_compact
    landlord_id = data.get("landlordId")
    if not landlord_id:
        raise HTTPException(400, "landlordId 必填")

    # 股东：只能重算关联场地的分红
    allowed = scope_landlord_ids(request)
    if allowed is not None and int(landlord_id) not in allowed:
        raise HTTPException(403, "无权重算该场地分红")

    period = to_compact(data["period"]) if data.get("period") else None
    return refresh_dividend_records(int(landlord_id), [period] if period else None)


# ─── 分红记录 ───────────────────────────────────────────────

@router.get("")
async def list_dividends(request: Request, landlordId: int = None, brandId: int = None, stationId: int = None,
                         period: str = None, type: str = None, status: str = None):
    records = dividend_repo.list_records(station_id=stationId, landlord_id=landlordId, brand_id=brandId,
                                         period=period, type_=type, status=status)
    # 股东：只能看到关联场地的分红记录
    allowed = scope_landlord_ids(request)
    if allowed is not None:
        records = [r for r in records if r.get("landlord_id") in allowed]
    result = []
    for r in records:
        shares = dividend_repo.get_shares(r["id"])
        result.append({**r, "shares": shares})
    return result


@router.get("/{record_id}")
async def get_dividend(record_id: int, request: Request):
    record = dividend_repo.get_record(record_id)
    if not record:
        raise HTTPException(404, "分红记录不存在")
    # 股东：只能查看关联场地的分红记录
    allowed = scope_landlord_ids(request)
    if allowed is not None and (record.get("landlord_id") not in allowed):
        raise HTTPException(403, "无权查看该分红记录")
    shares = dividend_repo.get_shares(record_id)

    # 获取数据来源明细（v3.1 主源：电费台账(landlord×brand×entity) + contracts 租金 + 运营费用）
    from ..repositories import electricity_repo, contract_repo, rent_repo
    # 主体拆行：同 场地×品牌×月 可能有多行（每主体一行），明细取各行并集
    elec_records = electricity_repo.list_records_by_landlord_brand_period(
        record["landlord_id"], record.get("brand_id"), record["period"])
    elec_details = []
    for er in elec_records:
        elec_details.extend(electricity_repo.get_meter_details(er["id"]))
    # 租金数据源：场地合同=成本，品牌方合同=收入
    contracts = contract_repo.list_contracts(landlord_id=record["landlord_id"]) if record.get("landlord_id") else []
    leases = [c for c in contracts if c.get("contract_type") == "场地合同"]
    incomes = [c for c in contracts if c.get("contract_type") == "品牌方合同"]
    expense = rent_repo.get_expense_by_landlord(record["landlord_id"], record["period"]) if record.get("landlord_id") else None

    return {
        **record,
        "shares": shares,
        "dataSources": {
            "electricity": elec_details,
            "rent": {
                "leases": leases,
                "incomes": incomes,
            },
            "operatingExpense": expense,
        },
    }


@router.post("", status_code=201)
async def create_dividend(data: dict):
    """创建分红记录（v3：按 场地×品牌）"""
    from ..infra.period import to_compact
    landlord_id = data.get("landlordId")
    brand_id = data.get("brandId")
    period = to_compact(data.get("period"))

    if not landlord_id or not period:
        raise HTTPException(400, "landlordId 和 period 必填")

    # 计算分红
    calc = dividend_calculator.calculate(int(landlord_id), brand_id, period)
    if not calc:
        raise HTTPException(404, "场地不存在")

    # 创建记录
    record = dividend_repo.create_record({
        "landlordId": landlord_id,
        "brandId": brand_id,
        "period": period,
        "type": data.get("type", "股东分红"),
        "elecIncome": calc["income"]["elecIncome"]["total"],
        "rentIncome": calc["income"]["rentIncome"]["total"],
        "totalIncome": calc["income"]["totalIncome"],
        "elecCost": calc["cost"]["elecCost"],
        "rentCost": calc["cost"]["rentCost"],
        "opExpense": calc["cost"]["opExpense"],
        "bizDividendCost": calc["cost"]["bizDividendCost"],
        "totalCost": calc["cost"]["totalCost"],
        "profit": calc["profit"],
        "status": "未结算",
        "settlementDate": calc.get("settlementDate"),
        "remark": data.get("remark"),
    })

    # 创建分红明细
    dividend_type = data.get("type", "股东分红")
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

    return record


@router.post("/{record_id}/submit")
async def submit_dividend(record_id: int, data: dict):
    """提交分红审批（关联分红记录，审核人员可展开查看详细分红核算信息）

    允许从未结算提交，也允许被驳回后重新提交。
    """
    record = dividend_repo.get_record(record_id)
    if not record:
        raise HTTPException(404, "分红记录不存在")
    if record["status"] not in ("未结算", "已驳回"):
        raise HTTPException(400, f"当前状态 {record['status']} 不允许提交")

    # 审批金额 = 该记录所有分红明细之和（实际要发放的金额）；无明细时退回用净利润
    shares = dividend_repo.get_shares(record_id)
    dividend_total = round(sum(float(s.get("amount") or 0) for s in shares), 2)
    amount = dividend_total if dividend_total > 0 else (record.get("profit") or 0)

    # 创建审批单（bizType 需与 approval_flows 流程配置一致，Approvals 页按此类型展示分红详情）
    try:
        approval = approval_repo.create_request({
            "bizType": "分红审批",
            "title": f"{record.get('landlord_name', '')} {record['period']} 分红",
            "reason": data.get("reason"),
            "amount": amount,
            "applicant": data.get("applicant", "系统"),
            "dividendRecordId": record_id,
            "landlordId": record.get("landlord_id"),
            "period": record.get("period"),
        })
    except ValueError as e:
        raise HTTPException(400, str(e))

    # 更新分红状态
    dividend_repo.update_status(record_id, "申报中")

    return {"ok": True, "approvalRequestId": approval["id"]}


# 说明：分红的状态流转只有一条合法路径：
#   未结算/已驳回 → submit 提交审批 → 审批流通过/驳回（approval_repo.act_on_request 回写状态）
#   → 已通过 → settle 标记已结算（打款完成）。
# 不提供任意改状态的接口；settle 仅允许「已通过 → 已结算」，防止绕过审批直接放款。
@router.post("/{record_id}/settle")
async def settle_dividend(record_id: int, data: dict):
    """标记已结算（仅限审批已通过的记录，表示分红款已实际发放）"""
    record = dividend_repo.get_record(record_id)
    if not record:
        raise HTTPException(404, "分红记录不存在")
    if record["status"] != "已通过":
        raise HTTPException(400, f"只有审批「已通过」的分红才能标记已结算，当前状态为「{record['status']}」")
    dividend_repo.update_status(record_id, "已结算")
    return {"ok": True}


@router.delete("/{record_id}")
async def delete_dividend(record_id: int):
    record = dividend_repo.get_record(record_id)
    if not record:
        raise HTTPException(404, "分红记录不存在")
    # 已进入审批或已发放的分红记录是财务凭证，不允许直接删除
    if record["status"] in ("申报中", "已通过", "已结算"):
        raise HTTPException(400, f"当前状态「{record['status']}」不允许删除（已进入审批/发放流程）")
    dividend_repo.delete_record(record_id)
    return {"ok": True}


# ─── 分红汇总 ───────────────────────────────────────────────

@router.get("/summary/shareholder")
async def shareholder_summary(request: Request, shareholderId: int = None, period: str = None, periodStart: str = None, periodEnd: str = None):
    # 股东账号：只能汇总自己 + 只看关联场地的分红
    user = getattr(request.state, "current_user", None)
    if user and user.get("role") == "shareholder":
        shareholderId = user.get("shareholder_id")
    rows = dividend_repo.get_shareholder_summary(shareholder_id=shareholderId, period=period, period_start=periodStart, period_end=periodEnd)
    allowed = scope_landlord_ids(request)
    if allowed is not None:
        # v3：分红记录已挂 landlord_id，直接按场地过滤
        rows = [r for r in rows if r.get("landlord_id") in allowed]
    # 按股东聚合
    holders = {}
    for r in rows:
        hid = r["shareholder_id"]
        if hid not in holders:
            holders[hid] = {
                "shareholderId": hid,
                "shareholderName": r["shareholder_name"],
                "totalAmount": 0,
                "settledAmount": 0,
                "pendingAmount": 0,
                "details": [],
            }
        h = holders[hid]
        amount = float(r.get("amount") or 0)
        h["totalAmount"] += amount
        if r.get("status") == "已结算":
            h["settledAmount"] += amount
        else:
            h["pendingAmount"] += amount
        h["details"].append(r)
    return list(holders.values())


@router.get("/summary/introducer")
async def introducer_summary(introducerId: int = None, period: str = None):
    rows = dividend_repo.get_introducer_summary(introducer_id=introducerId, period=period)
    intros = {}
    for r in rows:
        iid = r["introducer_id"]
        if iid not in intros:
            intros[iid] = {
                "introducerId": iid,
                "introducerName": r["introducer_name"],
                "totalAmount": 0,
                "settledAmount": 0,
                "pendingAmount": 0,
                "details": [],
            }
        h = intros[iid]
        amount = float(r.get("amount") or 0)
        h["totalAmount"] += amount
        if r.get("status") == "已结算":
            h["settledAmount"] += amount
        else:
            h["pendingAmount"] += amount
        h["details"].append(r)
    return list(intros.values())
