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
            # 默认流程
            flow_nodes = [
                {"name": "经办人", "approver": user["name"]},
                {"name": "部门负责人", "approver": ""},
                {"name": "总经理审批", "approver": ""},
                {"name": "财务审核付款", "approver": ""},
            ]

        applicant = user["name"]

        cur.execute("""
            INSERT INTO approval_requests (biz_type, title, reason, amount, applicant, flow_nodes, status)
            VALUES (%s, %s, %s, %s, %s, %s, '审批中')
            RETURNING *
        """, (
            biz_type,
            data.get("title", ""),
            data.get("reason", ""),
            data.get("amount", 0),
            applicant,
            json.dumps(flow_nodes, ensure_ascii=False),
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

        flow_nodes = json.loads(request["flow_nodes"]) if isinstance(request["flow_nodes"], str) else request["flow_nodes"]
        current_node = request["current_node"]
        comment = data.get("comment", "同意")

        next_node = current_node + 1
        if next_node >= len(flow_nodes):
            cur.execute(
                "UPDATE approval_requests SET current_node = %s, status = '已通过', finished_at = NOW() WHERE id = %s",
                (next_node, request_id)
            )
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

        flow_nodes = json.loads(request["flow_nodes"]) if isinstance(request["flow_nodes"], str) else request["flow_nodes"]
        current_node = request["current_node"]
        comment = data.get("comment", "驳回")

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
