from fastapi import APIRouter, HTTPException, Request
from ..repositories import approval_repo
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/approvals", tags=["审批管理"], default_response_class=CamelJSONResponse)


@router.get("/flows")
async def list_flows():
    return approval_repo.list_flows()


@router.post("/flows", status_code=201)
async def save_flow(data: dict):
    nodes = data.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise HTTPException(400, "审批流程至少需要一个审批节点")
    if any(not isinstance(node, dict) or not node.get("name") or not node.get("approver") for node in nodes):
        raise HTTPException(400, "每个审批节点都必须配置节点名称和审批人")
    return approval_repo.save_flow(
        biz_type=data.get("bizType", ""),
        nodes=nodes,
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
async def create_request(data: dict, request: Request):
    # 审批节点必须来自老板维护的服务端流程配置，不能信任客户端传入的
    # flowNodes/approvers，否则申请人可把自己伪造成最终审批人。
    data.pop("flowNodes", None)
    data.pop("approvers", None)
    current_user = getattr(request.state, "current_user", None) or {}
    data["applicant"] = current_user.get("name") or ""
    try:
        return approval_repo.create_request(data)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{request_id}/act")
async def act_on_request(request_id: int, data: dict, request: Request):
    action = data.get("action")
    if not action:
        raise HTTPException(400, "action 必填")

    # 操作人一律取当前登录用户，不信任请求体里的名字（防止冒名审批）
    current_user = getattr(request.state, "current_user", None)
    if not current_user:
        raise HTTPException(401, "未登录")
    approver = current_user.get("name") or ""

    try:
        result = approval_repo.act_on_request(
            request_id=request_id,
            action=action,
            approver=approver,
            comment=data.get("comment"),
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
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
