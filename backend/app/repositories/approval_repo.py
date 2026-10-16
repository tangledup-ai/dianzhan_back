import json
from datetime import datetime
from ..infra.database import get_connection, get_dict_cursor


def list_flows():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM approval_flows ORDER BY id")
        rows = cur.fetchall()
        for r in rows:
            if isinstance(r.get("nodes"), str):
                r["nodes"] = json.loads(r["nodes"])
        return rows
    finally:
        cur.close()
        conn.close()


def save_flow(biz_type: str, nodes: list):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO approval_flows (biz_type, nodes)
            VALUES (%s, %s)
            ON CONFLICT (biz_type)
            DO UPDATE SET nodes = EXCLUDED.nodes, updated_at = NOW()
            RETURNING *
        """, (biz_type, json.dumps(nodes, ensure_ascii=False)))
        conn.commit()
        row = cur.fetchone()
        if row and isinstance(row.get("nodes"), str):
            row["nodes"] = json.loads(row["nodes"])
        return row
    finally:
        cur.close()
        conn.close()


def list_requests(biz_type: str = None, status: str = None, applicant: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if biz_type:
            conditions.append("ar.biz_type = %s"); values.append(biz_type)
        if status:
            conditions.append("ar.status = %s"); values.append(status)
        if applicant:
            conditions.append("ar.applicant = %s"); values.append(applicant)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT ar.*,
                   COALESCE(dr.landlord_id, ar.landlord_id) as landlord_id,
                   COALESCE(l.name, al.name) as landlord_name,
                   COALESCE(ar.period, dr.period) as period,
                   dr.period as dividend_period
            FROM approval_requests ar
            LEFT JOIN dividend_records dr ON ar.dividend_record_id = dr.id
            LEFT JOIN landlords l ON dr.landlord_id = l.id
            LEFT JOIN landlords al ON ar.landlord_id = al.id
            {where}
            ORDER BY ar.created_at DESC
        """, values)
        rows = cur.fetchall()
        for r in rows:
            if isinstance(r.get("flow_nodes"), str):
                r["flow_nodes"] = json.loads(r["flow_nodes"])
        return rows
    finally:
        cur.close()
        conn.close()


def get_request(request_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM approval_requests WHERE id = %s", (request_id,))
        row = cur.fetchone()
        if row and isinstance(row.get("flow_nodes"), str):
            row["flow_nodes"] = json.loads(row["flow_nodes"])
        return row
    finally:
        cur.close()
        conn.close()


def get_records(request_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "SELECT * FROM approval_records WHERE request_id = %s ORDER BY created_at",
            (request_id,)
        )
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_request(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 如果传入了自定义 flowNodes 则使用，否则从数据库获取
        if data.get("flowNodes"):
            flow_nodes = data["flowNodes"]
        else:
            cur.execute("SELECT nodes FROM approval_flows WHERE biz_type = %s", (data.get("bizType"),))
            flow = cur.fetchone()
            if flow:
                flow_nodes = json.loads(flow["nodes"])
            else:
                # 未配置流程：默认交老板审批，绝不允许申请人自审（资金安全）
                cur.execute("SELECT name FROM platform_users WHERE role = 'boss' ORDER BY id LIMIT 1")
                boss = cur.fetchone()
                if not boss:
                    raise ValueError("该业务类型未配置审批流程，且平台没有老板账号，请先在审批中心配置流程")
                flow_nodes = [{"name": "老板审批", "approver": boss["name"]}]

        cur.execute("""
            INSERT INTO approval_requests
            (biz_type, title, reason, amount, applicant, attachments, flow_nodes, status, dividend_record_id,
             landlord_id, period, electricity_amount, rent_amount, contract_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, '审批中', %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            data.get("bizType"), data.get("title"), data.get("reason"),
            data.get("amount"), data.get("applicant"),
            json.dumps(data.get("attachments", []), ensure_ascii=False),
            json.dumps(flow_nodes, ensure_ascii=False),
            data.get("dividendRecordId"),
            data.get("landlordId"),
            data.get("period"), data.get("electricityAmount"),
            data.get("rentAmount"),
            data.get("contractId"),
        ))
        request = cur.fetchone()

        # 创建提交记录
        cur.execute("""
            INSERT INTO approval_records (request_id, node_index, node_name, approver, action, comment)
            VALUES (%s, 0, %s, %s, '提交', %s)
        """, (request["id"], flow_nodes[0]["name"], data.get("applicant"), data.get("reason")))

        # 关联回分红记录（支持多条：dividendRecordIds 数组，兼容单条 dividendRecordId）
        record_ids = data.get("dividendRecordIds") or []
        if data.get("dividendRecordId"):
            record_ids.append(data["dividendRecordId"])
        record_ids = list(dict.fromkeys(x for x in record_ids if x))  # 去重
        for rid in record_ids:
            cur.execute(
                "INSERT INTO approval_dividend_records (approval_id, dividend_record_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (request["id"], rid)
            )
            cur.execute(
                "UPDATE dividend_records SET approval_id = %s WHERE id = %s",
                (request["id"], rid)
            )

        conn.commit()
        if isinstance(request.get("flow_nodes"), str):
            request["flow_nodes"] = json.loads(request["flow_nodes"])
        return request
    finally:
        cur.close()
        conn.close()


def apply_payment_links(cur, request: dict):
    """兼容旧调用点：审批通过不代表已经收付款，收付款状态必须由用户手动标注。

    审批模块只记录审批状态，不再更新场租分期、电费台账或退款金额。
    """
    return None


def act_on_request(request_id: int, action: str, approver: str, comment: str = None, **kwargs):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM approval_requests WHERE id = %s", (request_id,))
        request = cur.fetchone()
        if not request:
            return None
        # 状态机：终态（已通过/已驳回）的审批单不允许再操作，
        # 否则会重复回写付款状态、或"通过后再驳回"造成账实不符
        if request["status"] != "审批中":
            raise ValueError(f"该审批单当前状态为「{request['status']}」，不能再执行「{action}」操作")

        flow_nodes = json.loads(request["flow_nodes"]) if isinstance(request["flow_nodes"], str) else request["flow_nodes"]
        current_node = request["current_node"]

        # 审批人身份校验：通过/驳回必须由当前节点配置的审批人执行
        # （节点未配置审批人时允许任何登录用户操作，兼容历史流程）
        if action in ("通过", "驳回") and current_node < len(flow_nodes):
            node_approver = str((flow_nodes[current_node] or {}).get("approver") or "").strip()
            if node_approver and approver.strip() != node_approver:
                raise PermissionError(
                    f"该节点应由「{node_approver}」审批，当前操作人「{approver}」无权审批；"
                    f"如需改派他人请使用转办，或调整审批流程配置"
                )

        # 获取关联的所有分红记录（含兼容单条的 dividend_record_id）
        def _linked_dividend_ids():
            ids = []
            cur.execute("SELECT dividend_record_id FROM approval_dividend_records WHERE approval_id = %s", (request_id,))
            for r in cur.fetchall():
                ids.append(r["dividend_record_id"])
            if request.get("dividend_record_id") and request["dividend_record_id"] not in ids:
                ids.append(request["dividend_record_id"])
            return ids

        if action == "通过":
            next_node = current_node + 1
            if next_node >= len(flow_nodes):
                # 最后一个节点，审批通过
                cur.execute(
                    "UPDATE approval_requests SET current_node = %s, status = '已通过', finished_at = NOW() WHERE id = %s",
                    (next_node, request_id)
                )
                # 更新关联的所有分红记录状态
                for rid in _linked_dividend_ids():
                    cur.execute(
                        "UPDATE dividend_records SET status = '已通过', updated_at = NOW() WHERE id = %s",
                        (rid,)
                    )
                # 保留旧调用兼容；审批结果不改变手动维护的收付款状态。
                apply_payment_links(cur, request)
            else:
                cur.execute(
                    "UPDATE approval_requests SET current_node = %s WHERE id = %s",
                    (next_node, request_id)
                )
        elif action == "驳回":
            cur.execute(
                "UPDATE approval_requests SET status = '已驳回', finished_at = NOW() WHERE id = %s",
                (request_id,)
            )
            # 更新关联的所有分红记录状态
            for rid in _linked_dividend_ids():
                cur.execute(
                    "UPDATE dividend_records SET status = '已驳回', updated_at = NOW() WHERE id = %s",
                    (rid,)
                )
        elif action == "催办":
            cur.execute(
                "UPDATE approval_requests SET urge_count = urge_count + 1 WHERE id = %s",
                (request_id,)
            )

        # 记录操作
        node_name = flow_nodes[current_node]["name"] if current_node < len(flow_nodes) else ""
        cur.execute("""
            INSERT INTO approval_records (request_id, node_index, node_name, approver, action, comment)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (request_id, current_node, node_name, approver, action, comment))

        conn.commit()
        return {"ok": True}
    finally:
        cur.close()
        conn.close()


def get_stats():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = '审批中') as pending,
                COUNT(*) FILTER (WHERE status = '已通过') as approved,
                COUNT(*) FILTER (WHERE status = '已驳回') as rejected
            FROM approval_requests
        """)
        stats = cur.fetchone()

        cur.execute("""
            SELECT biz_type, COUNT(*) as count,
                   COUNT(*) FILTER (WHERE status = '审批中') as pending
            FROM approval_requests
            GROUP BY biz_type
        """)
        stats["by_biz_type"] = cur.fetchall()
        return stats
    finally:
        cur.close()
        conn.close()
