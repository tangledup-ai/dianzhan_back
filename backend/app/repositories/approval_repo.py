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
                   dr.landlord_id as landlord_id,
                   l.name as landlord_name,
                   COALESCE(ar.period, dr.period) as period,
                   dr.period as dividend_period
            FROM approval_requests ar
            LEFT JOIN dividend_records dr ON ar.dividend_record_id = dr.id
            LEFT JOIN landlords l ON dr.landlord_id = l.id
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
            flow_nodes = json.loads(flow["nodes"]) if flow else [{"name": "经办人", "approver": data.get("applicant")}]

        cur.execute("""
            INSERT INTO approval_requests
            (biz_type, title, reason, amount, applicant, attachments, flow_nodes, status, dividend_record_id,
             landlord_id, period, electricity_amount, rent_amount)
            VALUES (%s, %s, %s, %s, %s, %s, %s, '审批中', %s, %s, %s, %s, %s)
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


def act_on_request(request_id: int, action: str, approver: str, comment: str = None, **kwargs):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM approval_requests WHERE id = %s", (request_id,))
        request = cur.fetchone()
        if not request:
            return None

        flow_nodes = json.loads(request["flow_nodes"]) if isinstance(request["flow_nodes"], str) else request["flow_nodes"]
        current_node = request["current_node"]

        # 获取关联的所有分红记录（含兼容单条的 dividend_record_id）
        def _linked_dividend_ids():
            ids = []
            cur.execute("SELECT dividend_record_id FROM approval_dividend_records WHERE approval_id = %s", (request_id,))
            for r in cur.fetchall():
                ids.append(r["dividend_record_id"])
            if request.get("dividend_record_id") and request["dividend_record_id"] not in ids:
                ids.append(request["dividend_record_id"])
            return ids

        # 场地费付款审批通过 → 联动更新场地合同对应周期的付款分期为已付款（v3：按 landlord_id 直接查场地合同）
        def _link_venue_payment():
            biz = request.get("biz_type") or ""
            if "场地费" not in biz:
                return  # 只有场地费相关审批才联动付款分期
            landlord_id = request.get("landlord_id")
            period = request.get("period")  # YYYY-MM
            if not landlord_id or not period or "-" not in period:
                return
            cur.execute("""
                SELECT id FROM contracts WHERE landlord_id = %s AND contract_type = '场地合同'
            """, (landlord_id,))
            contracts = cur.fetchall()
            month_key = period.replace("-", "")  # 2026-08 -> 202608
            for c in contracts:
                cur.execute("""
                    SELECT id, period_start FROM rent_payment_schedule
                    WHERE contract_id = %s AND status != '已付款'
                """, (c["id"],))
                for s in cur.fetchall():
                    ps = str(s.get("period_start") or "")[:7].replace("-", "")
                    if ps == month_key:
                        cur.execute("""
                            UPDATE rent_payment_schedule
                            SET status = '已付款', pay_date = NOW()::date
                            WHERE id = %s
                        """, (s["id"],))
                        break

        # 电费付款审批通过 → 联动更新电费台账付款状态（v3：台账挂 landlord_id，按 场地×月 更新）
        def _link_elec_payment():
            biz = request.get("biz_type") or ""
            if "电费" not in biz:
                return
            landlord_id = request.get("landlord_id")
            period = request.get("period")
            if not landlord_id or not period:
                return
            cur.execute("""
                UPDATE electricity_records
                SET pay_status = '已付款', updated_at = NOW()
                WHERE landlord_id = %s AND period = %s
            """, (landlord_id, str(period).replace("-", "")))

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
                # 场地费付款审批 → 联动更新付款分期
                _link_venue_payment()
                # 电费付款审批 → 联动更新电费台账付款状态
                _link_elec_payment()
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
