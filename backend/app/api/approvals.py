from fastapi import APIRouter, HTTPException
from ..repositories import approval_repo
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/approvals", tags=["审批管理"], default_response_class=CamelJSONResponse)


@router.get("/flows")
async def list_flows():
    return approval_repo.list_flows()


@router.post("/flows", status_code=201)
async def save_flow(data: dict):
    return approval_repo.save_flow(
        biz_type=data.get("bizType", ""),
        nodes=data.get("nodes", []),
    )


@router.get("")
async def list_requests(bizType: str = None, status: str = None, applicant: str = None):
    requests = approval_repo.list_requests(biz_type=bizType, status=status, applicant=applicant)
    result = []
    for r in requests:
        records = approval_repo.get_records(r["id"])
        result.append({**r, "records": records})
    return result


@router.get("/{request_id}")
async def get_request(request_id: int):
    request = approval_repo.get_request(request_id)
    if not request:
        raise HTTPException(404, "审批单不存在")
    records = approval_repo.get_records(request_id)
    return {**request, "records": records}


@router.post("", status_code=201)
async def create_request(data: dict):
    # 如果指定了审批人，动态构建审批流程
    approvers = data.get("approvers")
    if approvers and data.get("bizType") == "分红审批":
        import json
        nodes = []
        if approvers.get("finance_supervisor"):
            nodes.append({"name": "财务主管审核", "approver": approvers["finance_supervisor"]})
        if approvers.get("boss"):
            nodes.append({"name": "老板审批", "approver": approvers["boss"]})
        if nodes:
            data["flowNodes"] = nodes
    return approval_repo.create_request(data)


@router.post("/{request_id}/act")
async def act_on_request(request_id: int, data: dict):
    action = data.get("action")
    approver = data.get("approver")
    if not action or not approver:
        raise HTTPException(400, "action 和 approver 必填")

    result = approval_repo.act_on_request(
        request_id=request_id,
        action=action,
        approver=approver,
        comment=data.get("comment"),
    )
    if not result:
        raise HTTPException(404, "审批单不存在")
    return result


@router.get("/stats/overview")
async def get_stats():
    return approval_repo.get_stats()


@router.get("/by-dividend/{dividend_id}")
async def get_by_dividend(dividend_id: int):
    """查询分红记录关联的审批单"""
    from ..infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id FROM approval_requests WHERE dividend_record_id = %s ORDER BY created_at DESC LIMIT 1", (dividend_id,))
        row = cur.fetchone()
        if not row:
            return None
        request = approval_repo.get_request(row["id"])
        records = approval_repo.get_records(row["id"])
        return {**request, "records": records}
    finally:
        cur.close()
        conn.close()
