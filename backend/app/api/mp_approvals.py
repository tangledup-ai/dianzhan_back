"""小程序审批管理接口"""

import json
from datetime import datetime
from fastapi import APIRouter, HTTPException, Depends
from ..middleware.mp_auth import get_current_user
from ..infra.database import get_connection, get_dict_cursor

router = APIRouter(prefix="/approvals", tags=["📱 小程序 - 审批管理"])


def _format_approval(cur, row):
    """将数据库审批记录格式化为小程序所需格式"""
    flow_nodes = json.loads(row["flow_nodes"]) if isinstance(row["flow_nodes"], str) else row["flow_nodes"]

    # 获取审批操作记录
    cur.execute("""
        SELECT node_index, node_name, approver, action, comment, created_at
        FROM approval_records
        WHERE request_id = %s
        ORDER BY created_at
    """, (row["id"],))
    records = cur.fetchall()

    # 构建节点列表
    nodes = []
    for i, node in enumerate(flow_nodes):
        node_status = "wait"
        node_time = ""
        node_comment = ""
        node_name = node.get("approver", "")

        if i < row["current_node"]:
            node_status = "done"
        elif i == row["current_node"]:
            if row["status"] == "审批中":
                node_status = "active"
            elif row["status"] == "已通过":
                node_status = "done"
            elif row["status"] == "已驳回":
                node_status = "reject"

        # 从记录中补充具体时间和评论
        for rec in records:
            if rec["node_index"] == i:
                if rec["action"] in ("通过", "提交"):
                    node_status = "done"
                    node_time = rec["created_at"].strftime("%Y-%m-%d %H:%M") if rec.get("created_at") else ""
                    node_comment = rec.get("comment") or ""
                    node_name = rec.get("approver") or node_name
                elif rec["action"] == "驳回":
                    node_status = "reject"
                    node_time = rec["created_at"].strftime("%Y-%m-%d %H:%M") if rec.get("created_at") else ""
                    node_comment = rec.get("comment") or ""
                    node_name = rec.get("approver") or node_name
                elif rec["action"] == "转办":
                    node_name = rec.get("comment", "").replace("转办给 ", "") or node_name

        nodes.append({
            "role": node["name"],
            "name": node_name,
            "status": node_status,
            "time": node_time,
            "comment": node_comment,
        })

    status_map = {"审批中": "progress", "已通过": "done", "已驳回": "reject"}

    return {
        "id": f"AP{row['created_at'].strftime('%Y%m')}{row['id']:03d}",
        "numericId": row["id"],
        "type": row["biz_type"],
        "title": row["title"],
        "amount": float(row["amount"]) if row["amount"] else 0,
        "station": "",
        "applicant": row["applicant"],
        "applyDate": row["created_at"].strftime("%Y-%m-%d") if row.get("created_at") else "",
        "status": status_map.get(row["status"], "progress"),
        "reason": row.get("reason") or "",
        "nodes": nodes,
    }


@router.get("")
async def list_approvals(
    type: str = None,
    status: str = None,
    keyword: str = None,
    user: dict = Depends(get_current_user),
):
    """审批列表"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if type:
            conditions.append("ar.biz_type = %s")
            values.append(type)
        if status:
            status_map = {"progress": "审批中", "done": "已通过", "reject": "已驳回"}
            conditions.append("ar.status = %s")
            values.append(status_map.get(status, status))
        if keyword:
            conditions.append("(ar.title ILIKE %s OR ar.applicant ILIKE %s)")
            values.extend([f"%{keyword}%", f"%{keyword}%"])

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT ar.* FROM approval_requests ar
            {where}
            ORDER BY ar.created_at DESC
        """, values)

        return {
            "code": 0,
            "data": [_format_approval(cur, r) for r in cur.fetchall()]
        }
    finally:
        cur.close()
        conn.close()


@router.post("")
async def create_approval(data: dict, user: dict = Depends(get_current_user)):
    """创建审批单"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 获取默认审批流程
        biz_type = data.get("type", "电费付款")
        cur.execute("SELECT nodes FROM approval_flows WHERE biz_type = %s", (biz_type,))
        flow = cur.fetchone()
        if flow:
            flow_nodes = json.loads(flow["nodes"]) if isinstance(flow["nodes"], str) else flow["nodes"]
        else:
            # 未配置流程：默认交老板审批（节点审批人留空会导致任何人都能审批）
            cur.execute("SELECT name FROM platform_users WHERE role = 'boss' ORDER BY id LIMIT 1")
            boss = cur.fetchone()
            if not boss:
                raise HTTPException(400, "该业务类型未配置审批流程，且平台没有老板账号")
            flow_nodes = [{"name": "老板审批", "approver": boss["name"]}]

        applicant = user["name"]

        # 保存联动所需字段（v3：场地费/电费审批通过后回写付款状态，需 landlord_id + period）
        # 注：v3 重构后 stations 表已下线，场地维度统一用 landlord_id，仅接受直接传参
        landlord_id = data.get("landlordId") or data.get("landlord_id")
        period = data.get("period")

        cur.execute("""
            INSERT INTO approval_requests (biz_type, title, reason, amount, applicant, flow_nodes, status,
                                           landlord_id, period, electricity_amount, rent_amount)
            VALUES (%s, %s, %s, %s, %s, %s, '审批中', %s, %s, %s, %s)
            RETURNING *
        """, (
            biz_type,
            data.get("title", ""),
            data.get("reason", ""),
            data.get("amount", 0),
            applicant,
            json.dumps(flow_nodes, ensure_ascii=False),
            landlord_id,
            period,
            data.get("electricityAmount"),
            data.get("rentAmount"),
        ))
        request = cur.fetchone()

        # 创建提交记录
        cur.execute("""
            INSERT INTO approval_records (request_id, node_index, node_name, approver, action, comment)
            VALUES (%s, 0, %s, %s, '提交', %s)
        """, (request["id"], flow_nodes[0]["name"], applicant, "已提交审批申请"))

        conn.commit()
        return {"code": 0, "data": _format_approval(cur, request)}
    finally:
        cur.close()
        conn.close()


@router.post("/{request_id}/approve")
async def approve(request_id: int, data: dict, user: dict = Depends(get_current_user)):
    """审批通过"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM approval_requests WHERE id = %s", (request_id,))
        request = cur.fetchone()
        if not request:
            raise HTTPException(404, "审批单不存在")
        # 状态机：终态审批单不允许再操作
        if request["status"] != "审批中":
            raise HTTPException(400, f"该审批单当前状态为「{request['status']}」，不能再审批")

        flow_nodes = json.loads(request["flow_nodes"]) if isinstance(request["flow_nodes"], str) else request["flow_nodes"]
        current_node = request["current_node"]
        comment = data.get("comment", "同意")

        # 审批人身份校验：须与当前节点配置的审批人一致（节点未配置审批人时放行，兼容历史流程）
        if current_node < len(flow_nodes):
            node_approver = str((flow_nodes[current_node] or {}).get("approver") or "").strip()
            if node_approver and str(user["name"]).strip() != node_approver:
                raise HTTPException(403, f"该节点应由「{node_approver}」审批，您无权审批")

        next_node = current_node + 1
        if next_node >= len(flow_nodes):
            cur.execute(
                "UPDATE approval_requests SET current_node = %s, status = '已通过', finished_at = NOW() WHERE id = %s",
                (next_node, request_id)
            )
            # 审批通过 → 联动回写付款状态（场地费→付款分期，电费→电费台账）
            from ..repositories.approval_repo import apply_payment_links
            apply_payment_links(cur, request)
        else:
            cur.execute(
                "UPDATE approval_requests SET current_node = %s WHERE id = %s",
                (next_node, request_id)
            )

        node_name = flow_nodes[current_node]["name"] if current_node < len(flow_nodes) else ""
        cur.execute("""
            INSERT INTO approval_records (request_id, node_index, node_name, approver, action, comment)
            VALUES (%s, %s, %s, %s, '通过', %s)
        """, (request_id, current_node, node_name, user["name"], comment))

        conn.commit()
        return {"code": 0, "message": "审批通过"}
    finally:
        cur.close()
        conn.close()


@router.post("/{request_id}/reject")
async def reject(request_id: int, data: dict, user: dict = Depends(get_current_user)):
    """审批驳回"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM approval_requests WHERE id = %s", (request_id,))
        request = cur.fetchone()
        if not request:
            raise HTTPException(404, "审批单不存在")
        # 状态机：终态审批单不允许再操作
        if request["status"] != "审批中":
            raise HTTPException(400, f"该审批单当前状态为「{request['status']}」，不能再驳回")

        flow_nodes = json.loads(request["flow_nodes"]) if isinstance(request["flow_nodes"], str) else request["flow_nodes"]
        current_node = request["current_node"]
        comment = data.get("comment", "驳回")

        # 审批人身份校验：须与当前节点配置的审批人一致（节点未配置审批人时放行，兼容历史流程）
        if current_node < len(flow_nodes):
            node_approver = str((flow_nodes[current_node] or {}).get("approver") or "").strip()
            if node_approver and str(user["name"]).strip() != node_approver:
                raise HTTPException(403, f"该节点应由「{node_approver}」审批，您无权审批")

        cur.execute(
            "UPDATE approval_requests SET status = '已驳回', finished_at = NOW() WHERE id = %s",
            (request_id,)
        )

        node_name = flow_nodes[current_node]["name"] if current_node < len(flow_nodes) else ""
        cur.execute("""
            INSERT INTO approval_records (request_id, node_index, node_name, approver, action, comment)
            VALUES (%s, %s, %s, %s, '驳回', %s)
        """, (request_id, current_node, node_name, user["name"], comment))

        conn.commit()
        return {"code": 0, "message": "已驳回"}
    finally:
        cur.close()
        conn.close()


@router.post("/{request_id}/transfer")
async def transfer(request_id: int, data: dict, user: dict = Depends(get_current_user)):
    """审批转办"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM approval_requests WHERE id = %s", (request_id,))
        request = cur.fetchone()
        if not request:
            raise HTTPException(404, "审批单不存在")
        if request["status"] != "审批中":
            raise HTTPException(400, f"该审批单当前状态为「{request['status']}」，不能转办")

        flow_nodes = json.loads(request["flow_nodes"]) if isinstance(request["flow_nodes"], str) else request["flow_nodes"]
        current_node = request["current_node"]
        to_person = data.get("to", "")

        # 更新当前节点的审批人为转办目标
        if current_node < len(flow_nodes):
            flow_nodes[current_node]["approver"] = to_person
            cur.execute(
                "UPDATE approval_requests SET flow_nodes = %s WHERE id = %s",
                (json.dumps(flow_nodes, ensure_ascii=False), request_id)
            )

        node_name = flow_nodes[current_node]["name"] if current_node < len(flow_nodes) else ""
        cur.execute("""
            INSERT INTO approval_records (request_id, node_index, node_name, approver, action, comment)
            VALUES (%s, %s, %s, %s, '转办', %s)
        """, (request_id, current_node, node_name, user["name"], f"转办给 {to_person}"))

        conn.commit()
        return {"code": 0, "message": "已转办"}
    finally:
        cur.close()
        conn.close()
