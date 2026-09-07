"""小程序数据快照接口 - 聚合首页/地图/站点/利润/审批所需数据（v3：场地×品牌维度，去站点层）"""

import json
from datetime import date, datetime
from fastapi import APIRouter, Depends
from ..middleware.mp_auth import get_current_user
from ..infra.database import get_connection, get_dict_cursor

router = APIRouter(tags=["📱 小程序 - 数据快照"])


@router.get("/snapshot")
async def snapshot(user: dict = Depends(get_current_user)):
    """经营数据快照（首页/地图/站点/利润/审批共用）
    v3：台账/电表已直接挂 landlord_id（brand_id），站点列表按 场地×品牌 组合返回，
    不再经 stations 关联；stations/stationCount 等键名保留兼容小程序。"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        today = date.today()
        current_year = today.strftime("%Y")
        current_month = today.strftime("%Y-%m")

        # ── 1. 总览 ──────────────────────────────────────────
        # v3：站点数 = 场地×品牌 组合数（电表直接挂 landlord_id/brand_id）
        cur.execute("""
            SELECT COUNT(*) as cnt FROM (
                SELECT DISTINCT landlord_id, brand_id FROM meters
                WHERE landlord_id IS NOT NULL AND brand_id IS NOT NULL AND meter_no NOT LIKE 'TEST%'
            ) t
        """)
        station_count = cur.fetchone()["cnt"]

        cur.execute("""
            SELECT
                COALESCE(SUM(profit), 0) as elec_profit,
                COALESCE(SUM(pay_amount), 0) as elec_pay,
                COALESCE(SUM(collect_net), 0) as elec_collect
            FROM electricity_records
            WHERE period LIKE %s
        """, (f"{current_year}%",))
        elec_year = cur.fetchone()

        # 租金利润（品牌方合同月租 - 场地合同月租，×12 年化；v3：contracts 为唯一主源）
        cur.execute("SELECT COALESCE(SUM(monthly_rent), 0) as total FROM contracts WHERE contract_type = '场地合同'")
        rent_cost_annual = float(cur.fetchone()["total"]) * 12

        cur.execute("SELECT COALESCE(SUM(monthly_rent), 0) as total FROM contracts WHERE contract_type = '品牌方合同'")
        rent_income_annual = float(cur.fetchone()["total"]) * 12

        rent_profit_annual = rent_income_annual - rent_cost_annual

        # 当年电费利润
        elec_profit = float(elec_year["elec_profit"])

        # 异常场地数（当月电量低于平均值50%的场地；v3：按 landlord_id 分组）
        cur.execute("""
            WITH station_avg AS (
                SELECT m.landlord_id, AVG(COALESCE(mm.actual_kwh, mm.kwh * COALESCE(m.transformer_ratio, 1))) as avg_kwh
                FROM meter_monthly mm
                JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                WHERE mm.kwh > 0 AND m.meter_no NOT LIKE 'TEST%%'
                GROUP BY m.landlord_id
            ),
            station_current AS (
                SELECT m.landlord_id, SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))) as current_kwh
                FROM meter_monthly mm
                JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
                WHERE mm.month_period = %s AND m.meter_no NOT LIKE 'TEST%%'
                GROUP BY m.landlord_id
            )
            SELECT COUNT(*) as cnt
            FROM station_avg sa
            JOIN station_current sc ON sa.landlord_id = sc.landlord_id
            WHERE sc.current_kwh < sa.avg_kwh * 0.5
        """, (current_month.replace("-", ""),))
        abnormal_count = cur.fetchone()["cnt"]

        # ── 2. 电量统计（v3：电表直接挂 landlord_id/brand_id，无需经 stations）──────
        # 本月
        cur.execute("""
            SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as total
            FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE mm.month_period = %s AND m.meter_no NOT LIKE 'TEST%%'
        """, (current_month.replace("-", ""),))
        month_kwh = float(cur.fetchone()["total"])

        # 本季度
        quarter = (today.month - 1) // 3 + 1
        quarter_start = f"{current_year}{(quarter - 1) * 3 + 1:02d}"
        quarter_end = f"{current_year}{quarter * 3:02d}"
        cur.execute("""
            SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as total
            FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE mm.month_period >= %s AND mm.month_period <= %s AND m.meter_no NOT LIKE 'TEST%%'
        """, (quarter_start, quarter_end))
        quarter_kwh = float(cur.fetchone()["total"])

        # 本年
        cur.execute("""
            SELECT COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as total
            FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE mm.month_period >= %s AND mm.month_period <= %s AND m.meter_no NOT LIKE 'TEST%%'
        """, (f"{current_year}01", f"{current_year}12"))
        year_kwh = float(cur.fetchone()["total"])

        # 月度趋势（当年每月）
        cur.execute("""
            SELECT mm.month_period, COALESCE(SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))), 0) as kwh
            FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE mm.month_period >= %s AND mm.month_period <= %s AND m.meter_no NOT LIKE 'TEST%%'
            GROUP BY mm.month_period
            ORDER BY mm.month_period
        """, (f"{current_year}01", f"{current_year}12"))
        monthly_rows = cur.fetchall()

        # ── 3. 公司主体列表 ──────────────────────────────────
        cur.execute("SELECT name FROM entities ORDER BY id")
        entities = [r["name"] for r in cur.fetchall()]

        # ── 4. 站点明细（v3：场地×品牌 维度，直接由 meters.landlord_id/brand_id 组合）──
        cur.execute("""
            SELECT
                l.id as landlord_id, l.name as landlord_name,
                b.id as brand_id, b.name as brand_name,
                COALESCE(c.region, l.region) as region,
                COALESCE(c.address, l.address) as address,
                MIN(m.meter_no) as meter_no
            FROM meters m
            JOIN landlords l ON m.landlord_id = l.id
            LEFT JOIN brands b ON m.brand_id = b.id
            LEFT JOIN LATERAL (
                SELECT region, address FROM contracts
                WHERE landlord_id = m.landlord_id AND contract_type = '场地合同'
                ORDER BY id LIMIT 1
            ) c ON TRUE
            WHERE m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
              AND m.meter_no NOT LIKE 'TEST%'
            GROUP BY l.id, l.name, b.id, b.name, c.region, c.address, l.region, l.address
            ORDER BY l.id, b.id
        """)
        raw_stations = cur.fetchall()

        # 获取合同（v3：按 landlord_id / brand_id 归集租金，不再依赖 station_id）
        cur.execute("""
            SELECT landlord_id, brand_id, contract_type, monthly_rent
            FROM contracts
        """)
        all_contracts = cur.fetchall()

        # 租金成本按场地归集（场地合同）；租金收入按 场地×品牌 归集（品牌方合同）
        rent_cost_map = {}
        rent_income_map = {}
        for c in all_contracts:
            lid = c["landlord_id"]
            if c["contract_type"] == "场地合同" and c.get("monthly_rent"):
                rent_cost_map[lid] = rent_cost_map.get(lid, 0) + float(c["monthly_rent"])
            elif c["contract_type"] == "品牌方合同" and c.get("monthly_rent"):
                key = (lid, c.get("brand_id"))
                rent_income_map[key] = rent_income_map.get(key, 0) + float(c["monthly_rent"])

        # 获取每个场地的最新月度电量（v3：按 landlord_id 分组）
        cur.execute("""
            SELECT m.landlord_id, SUM(COALESCE(mm.actual_kwh, ROUND(mm.kwh * COALESCE(m.transformer_ratio, 1), 2))) as kwh
            FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE mm.month_period = %s AND m.meter_no NOT LIKE 'TEST%%'
            GROUP BY m.landlord_id
        """, (current_month.replace("-", ""),))
        station_kwh_map = {r["landlord_id"]: float(r["kwh"] or 0) for r in cur.fetchall()}

        # 获取每个场地的历史平均电量（v3：按 landlord_id 分组）
        cur.execute("""
            SELECT m.landlord_id, AVG(COALESCE(mm.actual_kwh, mm.kwh * COALESCE(m.transformer_ratio, 1))) as avg_kwh
            FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address AND m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL
            WHERE mm.kwh > 0 AND m.meter_no NOT LIKE 'TEST%'
            GROUP BY m.landlord_id
        """)
        station_avg_kwh_map = {r["landlord_id"]: float(r["avg_kwh"] or 0) for r in cur.fetchall()}

        # 获取每个场地的电费数据（v3：台账已挂 landlord_id，直接按 landlord 过滤）
        cur.execute("""
            SELECT landlord_id,
                   COALESCE(SUM(pay_amount), 0) as elec_pay,
                   COALESCE(SUM(collect_net), 0) as elec_collect,
                   COALESCE(SUM(profit), 0) as elec_profit,
                   COALESCE(SUM(pay_kwh), 0) as kwh_total
            FROM electricity_records
            WHERE period LIKE %s
            GROUP BY landlord_id
        """, (f"{current_year}%",))
        station_elec_map = {}
        for r in cur.fetchall():
            station_elec_map[r["landlord_id"]] = {
                "elecPay": float(r["elec_pay"]),
                "elecCollect": float(r["elec_collect"]),
                "elecProfit": float(r["elec_profit"]),
                "kwhTotal": float(r["kwh_total"]),
            }

        # 获取柜子数量（统计已归属 landlord+brand 的实表；共享电表计入 brand_id 为空的组，供全品牌合同站点卡使用）
        # 口径与合同/分红一致：每块电表至少 1 柜（max(1, 实际柜子数)），不是电表数
        cur.execute("""
            SELECT m.landlord_id, m.brand_id,
                   SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id))) AS cnt
            FROM meters m
            WHERE m.landlord_id IS NOT NULL
              AND (m.brand_id IS NOT NULL OR m.tag = '共享电表')
              AND m.meter_no NOT LIKE 'TEST%'
            GROUP BY m.landlord_id, m.brand_id
        """)
        station_meter_count = {(r["landlord_id"], r["brand_id"]): int(r["cnt"] or 0) for r in cur.fetchall()}

        # 构建站点列表（v3：一行 = 一个 场地×品牌 组合；raw_stations 已按组合去重）
        entity_name = entities[0] if entities else ""
        stations = []
        for row in raw_stations:
            lid = row["landlord_id"]
            bid = row["brand_id"]
            brand = row.get("brand_name") or "未指定"
            name = row.get("landlord_name") or brand

            elec_data = station_elec_map.get(lid, {})
            latest_kwh = station_kwh_map.get(lid, 0)
            avg_kwh = station_avg_kwh_map.get(lid, 0)

            # 租金数据（品牌方合同无 brand_id 时按整场地兜底）
            rent_cost = rent_cost_map.get(lid, 0)
            rent_income = rent_income_map.get((lid, bid), rent_income_map.get((lid, None), 0))

            rent_profit = rent_income - rent_cost
            total_profit = elec_data.get("elecProfit", 0) + rent_profit

            # ROI
            roi = None
            if rent_cost > 0 and total_profit > 0:
                roi = round((total_profit * 12 / (rent_cost * 12)) * 100, 1)

            stations.append({
                "id": lid,
                "name": name,
                "region": row.get("region") or "",
                "brand": brand,
                "entity": entity_name,
                "landlord": row.get("landlord_name") or "",
                "status": "运营中",
                "meterNo": row.get("meter_no") or "",
                "cabinets": station_meter_count.get((lid, bid)),
                "companyShare": None,
                "latestKwh": round(latest_kwh, 2),
                "avgKwh": round(avg_kwh, 2) if avg_kwh else None,
                "abnormal": latest_kwh < avg_kwh * 0.5 if avg_kwh > 0 else False,
                "kwhTotal": elec_data.get("kwhTotal", 0),
                "elecPay": elec_data.get("elecPay", 0),
                "elecCollect": elec_data.get("elecCollect", 0),
                "elecProfit": elec_data.get("elecProfit", 0),
                "rentCost": round(rent_cost, 2),
                "rentIncome": round(rent_income, 2),
                "rentProfit": round(rent_profit, 2),
                "totalProfit": round(total_profit, 2),
                "roi": roi,
                "lat": None,
                "lng": None,
            })

        # ── 5. 提醒事项 ──────────────────────────────────────
        # 合同到期提醒（90天内到期或已过期；v3：显示场地方名）
        cur.execute("""
            SELECT l.name as station_name, b.name as brand, c.partner, c.end_date,
                   (c.end_date - %s::date) as days_left
            FROM contracts c
            LEFT JOIN landlords l ON c.landlord_id = l.id
            LEFT JOIN brands b ON c.brand_id = b.id
            WHERE c.end_date IS NOT NULL
              AND c.end_date <= %s::date + INTERVAL '90 days'
            ORDER BY c.end_date
        """, (today, today))
        contracts_reminder = []
        for r in cur.fetchall():
            days = int(r["days_left"]) if r["days_left"] else 0
            contracts_reminder.append({
                "station": r["station_name"] or "未指定",
                "brand": r["brand"] or "",
                "partner": r["partner"] or "",
                "endDate": r["end_date"].isoformat() if r["end_date"] else "",
                "daysLeft": days,
            })

        # 电费未付款（v3：台账挂 landlord_id，显示场地方名，品牌兜底）
        cur.execute("""
            SELECT COALESCE(l.name, b.name, '未指定') as station, er.period, er.pay_amount as amount
            FROM electricity_records er
            LEFT JOIN landlords l ON er.landlord_id = l.id
            LEFT JOIN brands b ON er.brand_id = b.id
            WHERE er.pay_status = '未付款' AND er.pay_amount > 0
            ORDER BY er.period DESC
            LIMIT 20
        """)
        elec_unpaid = [{"station": r["station"], "period": r["period"], "amount": float(r["amount"])} for r in cur.fetchall()]

        # 电费未到账（v3：同上，按 landlord 过滤）
        cur.execute("""
            SELECT COALESCE(l.name, b.name, '未指定') as station, er.period, er.collect_net as amount
            FROM electricity_records er
            LEFT JOIN landlords l ON er.landlord_id = l.id
            LEFT JOIN brands b ON er.brand_id = b.id
            WHERE er.collect_status = '未到账' AND er.collect_net > 0
            ORDER BY er.period DESC
            LIMIT 20
        """)
        elec_uncollected = [{"station": r["station"], "period": r["period"], "amount": float(r["amount"])} for r in cur.fetchall()]

        # 租金待收（v3：品牌方合同收款分期未到账，JOIN contracts 限定）
        cur.execute("""
            SELECT COALESCE(l.name, b.name, '未指定') as station, rs.seq, rs.amount, rs.period_end
            FROM rent_income_schedule rs
            JOIN contracts c ON rs.contract_id = c.id
            LEFT JOIN landlords l ON c.landlord_id = l.id
            LEFT JOIN brands b ON c.brand_id = b.id
            WHERE rs.status = '未到账'
            ORDER BY rs.period_end
            LIMIT 20
        """)
        rent_pending = []
        for r in cur.fetchall():
            rent_pending.append({
                "station": r["station"],
                "seq": int(r["seq"]),
                # amount 可空（历史数据存在未填金额的排期），按 0 兜底，避免整页快照 500
                "amount": float(r["amount"]) if r["amount"] is not None else 0.0,
                "periodEnd": r["period_end"].isoformat() if r["period_end"] else "",
            })

        # ── 6. 待审批 ────────────────────────────────────────
        cur.execute("""
            SELECT ar.id, ar.biz_type, ar.title, ar.amount, ar.applicant,
                   ar.created_at, ar.status, ar.reason, ar.flow_nodes, ar.current_node
            FROM approval_requests ar
            WHERE ar.status = '审批中'
            ORDER BY ar.created_at DESC
        """)
        approvals_raw = cur.fetchall()

        approvals = []
        for a in approvals_raw:
            flow_nodes = json.loads(a["flow_nodes"]) if isinstance(a["flow_nodes"], str) else a["flow_nodes"]

            # 获取审批记录
            cur.execute("""
                SELECT node_name as role, approver as name, action, comment, created_at
                FROM approval_records
                WHERE request_id = %s
                ORDER BY created_at
            """, (a["id"],))
            records = cur.fetchall()

            # 构建节点状态
            nodes = []
            for i, node in enumerate(flow_nodes):
                node_status = "wait"
                node_time = ""
                node_comment = ""
                if i < a["current_node"]:
                    node_status = "done"
                elif i == a["current_node"]:
                    node_status = "active" if a["status"] == "审批中" else "done"

                # 从审批记录中找对应的操作
                for rec in records:
                    if rec["role"] == node["name"]:
                        if rec["action"] == "通过":
                            node_status = "done"
                            node_time = rec["created_at"].strftime("%Y-%m-%d %H:%M") if rec.get("created_at") else ""
                            node_comment = rec.get("comment") or ""
                        elif rec["action"] == "驳回":
                            node_status = "reject"
                            node_time = rec["created_at"].strftime("%Y-%m-%d %H:%M") if rec.get("created_at") else ""
                            node_comment = rec.get("comment") or ""

                nodes.append({
                    "role": node["name"],
                    "name": node.get("approver", ""),
                    "status": node_status,
                    "time": node_time,
                    "comment": node_comment,
                })

            approvals.append({
                "id": f"AP{a['created_at'].strftime('%Y%m')}{a['id']:03d}",
                "type": a["biz_type"],
                "title": a["title"],
                "amount": float(a["amount"]) if a["amount"] else 0,
                "station": "",
                "applicant": a["applicant"],
                "applyDate": a["created_at"].strftime("%Y-%m-%d") if a.get("created_at") else "",
                "status": "progress" if a["status"] == "审批中" else ("done" if a["status"] == "已通过" else "reject"),
                "reason": a.get("reason") or "",
                "nodes": nodes,
            })

        # ── 组装响应 ─────────────────────────────────────────
        return {
            "code": 0,
            "data": {
                "generatedAt": today.isoformat(),
                "overview": {
                    "stationCount": station_count,
                    "elecProfit": round(elec_profit, 2),
                    "rentProfit": round(rent_profit_annual / 12, 2),
                    "totalProfit": round(elec_profit + rent_profit_annual / 12, 2),
                    "abnormalCount": abnormal_count,
                },
                "kwh": {
                    "month": {
                        "label": current_month,
                        "kwh": round(month_kwh, 2),
                    },
                    "quarter": {
                        "label": f"{current_year} Q{quarter}",
                        "kwh": round(quarter_kwh, 2),
                    },
                    "year": {
                        "label": f"{current_year}年",
                        "kwh": round(year_kwh, 2),
                    },
                    "monthly": [
                        {
                            "period": f"{r['month_period'][:4]}-{r['month_period'][4:]}",
                            "kwh": round(float(r["kwh"]), 2),
                        }
                        for r in monthly_rows
                    ],
                },
                "entities": entities,
                "stations": stations,
                "reminders": {
                    "contracts": contracts_reminder,
                    "elecUnpaid": elec_unpaid,
                    "elecUncollected": elec_uncollected,
                    "rentPending": rent_pending,
                },
                "approvals": approvals,
            }
        }
    finally:
        cur.close()
        conn.close()
