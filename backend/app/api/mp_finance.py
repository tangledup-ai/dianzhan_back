"""小程序财务数据接口（v3：场地×品牌/品牌/公司/场地方/股东 5个维度，去站点层）
- /stations 保留（小程序还在用），数据源改为 场地×品牌 组合返回
- /landlords 直接按 landlord_id 统计
- 租金一律从 contracts（场地合同=成本 / 品牌方合同=收入）+ rent_income_schedule（应收未到账）计算
"""

from fastapi import APIRouter, Depends
from ..middleware.mp_auth import get_current_user
from ..infra.database import get_connection, get_dict_cursor

router = APIRouter(prefix="/finance", tags=["📱 小程序 - 财务数据"])


@router.get("/stations")
async def finance_stations(user: dict = Depends(get_current_user)):
    """站点维度财务数据（v3：按 场地×品牌 返回；保留 station 键名兼容小程序）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 场地×品牌 组合（电表直接挂 landlord_id/brand_id，不再经 stations）
        cur.execute("""
            SELECT
                cmb.landlord_id, cmb.brand_id,
                l.name as landlord_name,
                COALESCE(b.name, '未指定') as brand,
                COALESCE(e.name, '') as entity
            FROM (SELECT DISTINCT landlord_id, brand_id FROM meters
                  WHERE landlord_id IS NOT NULL AND brand_id IS NOT NULL AND meter_no NOT LIKE 'TEST%') cmb
            JOIN landlords l ON cmb.landlord_id = l.id
            LEFT JOIN brands b ON cmb.brand_id = b.id
            LEFT JOIN entities e ON e.id = (SELECT id FROM entities LIMIT 1)
            ORDER BY l.id, b.id
        """)
        combos = cur.fetchall()

        # 电费数据（v3：台账挂 landlord_id/brand_id，按组合归集）
        cur.execute("""
            SELECT landlord_id, brand_id,
                   COALESCE(SUM(pay_amount), 0) as elec_pay,
                   COALESCE(SUM(collect_net), 0) as elec_collect,
                   COALESCE(SUM(profit), 0) as elec_profit
            FROM electricity_records
            GROUP BY landlord_id, brand_id
        """)
        elec_map = {}
        for r in cur.fetchall():
            elec_map[(r["landlord_id"], r["brand_id"])] = r

        # 租金数据（v3：contracts 为唯一主源；月租 ×12 年化，兼容 rentCostAnnual/rentIncomeAnnual 键名）
        cur.execute("""
            SELECT landlord_id, COALESCE(SUM(monthly_rent), 0) as rent_cost
            FROM contracts WHERE contract_type = '场地合同'
            GROUP BY landlord_id
        """)
        rent_cost_map = {r["landlord_id"]: float(r["rent_cost"]) * 12 for r in cur.fetchall()}

        cur.execute("""
            SELECT landlord_id, brand_id, COALESCE(SUM(monthly_rent), 0) as rent_income
            FROM contracts WHERE contract_type = '品牌方合同'
            GROUP BY landlord_id, brand_id
        """)
        rent_income_map = {}
        for r in cur.fetchall():
            rent_income_map[(r["landlord_id"], r.get("brand_id"))] = float(r["rent_income"]) * 12

        result = []
        for row in combos:
            lid = row["landlord_id"]
            bid = row["brand_id"]
            e = elec_map.get((lid, bid), {})
            rent_cost = rent_cost_map.get(lid, 0)
            # 品牌方合同无 brand_id 时按整场地兜底
            rent_income = rent_income_map.get((lid, bid), rent_income_map.get((lid, None), 0))
            elec_profit = float(e.get("elec_profit") or 0)
            result.append({
                "station": row["landlord_name"] or row["brand"] or "未指定",
                "brand": row["brand"],
                "entity": row["entity"],
                "landlord": row["landlord_name"] or "",
                "elecPay": round(float(e.get("elec_pay") or 0), 2),
                "elecCollect": round(float(e.get("elec_collect") or 0), 2),
                "elecProfit": round(elec_profit, 2),
                "rentCostAnnual": round(rent_cost, 2),
                "rentIncomeAnnual": round(rent_income, 2),
                "totalProfit": round(elec_profit + rent_income - rent_cost, 2),
            })

        return {"code": 0, "data": result}
    finally:
        cur.close()
        conn.close()


@router.get("/brands")
async def finance_brands(user: dict = Depends(get_current_user)):
    """品牌方维度财务数据（v3：以 场地×品牌 组合为基数，台账按 landlord_id/brand_id 关联）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 电费数据：组合为基数（含暂无台账的品牌），避免按电表 JOIN 导致重复累计
        cur.execute("""
            SELECT
                COALESCE(b.name, '未关联') as brand,
                COUNT(DISTINCT cmb.landlord_id) as station_count,
                COALESCE(SUM(er.pay_amount), 0) as elec_pay,
                COALESCE(SUM(er.collect_net), 0) as elec_collect,
                COALESCE(SUM(er.profit), 0) as elec_profit,
                COALESCE(SUM(CASE WHEN er.pay_status = '未付款' THEN er.pay_amount ELSE 0 END), 0) as elec_unpaid,
                COALESCE(SUM(CASE WHEN er.collect_status = '未到账' THEN er.collect_net ELSE 0 END), 0) as elec_uncollected
            FROM (SELECT DISTINCT landlord_id, brand_id FROM meters
                  WHERE landlord_id IS NOT NULL AND brand_id IS NOT NULL AND meter_no NOT LIKE 'TEST%') cmb
            LEFT JOIN brands b ON cmb.brand_id = b.id
            LEFT JOIN electricity_records er ON er.landlord_id = cmb.landlord_id AND er.brand_id = cmb.brand_id
            GROUP BY b.name
            ORDER BY elec_profit DESC
        """)
        elec_data = cur.fetchall()

        # 租金成本（v3：场地合同月租；同一场地多个品牌时各自承担该场地成本，与旧按站点归集口径一致）
        cur.execute("""
            SELECT COALESCE(b.name, '未关联') as brand,
                   COALESCE(SUM(c.monthly_rent), 0) as rent_cost
            FROM (SELECT DISTINCT landlord_id, brand_id FROM meters
                  WHERE landlord_id IS NOT NULL AND brand_id IS NOT NULL AND meter_no NOT LIKE 'TEST%') cmb
            LEFT JOIN brands b ON cmb.brand_id = b.id
            LEFT JOIN contracts c ON c.landlord_id = cmb.landlord_id AND c.contract_type = '场地合同'
            GROUP BY b.name
        """)
        rent_cost_map = {r["brand"]: float(r["rent_cost"]) * 12 for r in cur.fetchall()}

        # 租金收入 / 应收未到账（v3：品牌方合同 + 收款分期）
        cur.execute("""
            SELECT COALESCE(b.name, '未关联') as brand,
                   COALESCE(SUM(c.monthly_rent), 0) as rent_income,
                   COALESCE(SUM(CASE WHEN rs.status = '未到账' THEN rs.amount ELSE 0 END), 0) as rent_uncollected
            FROM contracts c
            LEFT JOIN brands b ON c.brand_id = b.id
            LEFT JOIN rent_income_schedule rs ON rs.contract_id = c.id
            WHERE c.contract_type = '品牌方合同'
            GROUP BY b.name
        """)
        rent_income_map = {}
        rent_uncollected_map = {}
        for r in cur.fetchall():
            rent_income_map[r["brand"]] = float(r["rent_income"]) * 12
            rent_uncollected_map[r["brand"]] = float(r["rent_uncollected"])

        result = []
        for row in elec_data:
            brand = row["brand"]
            rent_cost = rent_cost_map.get(brand, 0)
            rent_income = rent_income_map.get(brand, 0)
            result.append({
                "brand": brand,
                "stationCount": row["station_count"],
                "elecPay": round(float(row["elec_pay"]), 2),
                "elecCollect": round(float(row["elec_collect"]), 2),
                "elecProfit": round(float(row["elec_profit"]), 2),
                "elecUnpaid": round(float(row["elec_unpaid"]), 2),
                "elecUncollected": round(float(row["elec_uncollected"]), 2),
                "rentCostAnnual": round(rent_cost, 2),
                "rentIncomeAnnual": round(rent_income, 2),
                "rentProfit": round(rent_income - rent_cost, 2),
                "rentUncollected": round(rent_uncollected_map.get(brand, 0), 2),
                "totalProfit": round(float(row["elec_profit"]) + rent_income - rent_cost, 2),
            })

        return {"code": 0, "data": result}
    finally:
        cur.close()
        conn.close()


@router.get("/entities")
async def finance_entities(user: dict = Depends(get_current_user)):
    """公司主体维度财务数据（v3：按 场地×品牌 组合统计，保留原有整体口径）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # v3.1：台账行自带 entity_id（按电表主体生成），直接按主体聚合真实口径
        cur.execute("""
            SELECT
                e.name as entity,
                COUNT(DISTINCT er.landlord_id) as station_count,
                COUNT(DISTINCT er.brand_id) as brand_count,
                COALESCE(SUM(er.pay_amount), 0) as elec_pay,
                COALESCE(SUM(er.collect_net), 0) as elec_collect,
                COALESCE(SUM(er.profit), 0) as elec_profit
            FROM entities e
            LEFT JOIN electricity_records er ON er.entity_id = e.id
            GROUP BY e.id, e.name
            ORDER BY e.id
        """)
        elec_data = cur.fetchall()

        # 租金数据（v3：contracts 为唯一主源；月租 ×12 年化）
        cur.execute("SELECT COALESCE(SUM(monthly_rent), 0) as total FROM contracts WHERE contract_type = '场地合同'")
        total_rent_cost = float(cur.fetchone()["total"]) * 12

        cur.execute("SELECT COALESCE(SUM(monthly_rent), 0) as total FROM contracts WHERE contract_type = '品牌方合同'")
        total_rent_income = float(cur.fetchone()["total"]) * 12

        result = []
        for row in elec_data:
            # 简化处理：租金按实体均分
            entity_count = len(elec_data) if elec_data else 1
            rent_cost = total_rent_cost / entity_count
            rent_income = total_rent_income / entity_count
            result.append({
                "entity": row["entity"],
                "stationCount": row["station_count"],
                "brandCount": row["brand_count"],
                "elecPay": round(float(row["elec_pay"]), 2),
                "elecCollect": round(float(row["elec_collect"]), 2),
                "elecProfit": round(float(row["elec_profit"]), 2),
                "rentCostAnnual": round(rent_cost, 2),
                "rentIncomeAnnual": round(rent_income, 2),
                "rentProfit": round(rent_income - rent_cost, 2),
                "totalProfit": round(float(row["elec_profit"]) + rent_income - rent_cost, 2),
            })

        return {"code": 0, "data": result}
    finally:
        cur.close()
        conn.close()


@router.get("/landlords")
async def finance_landlords(user: dict = Depends(get_current_user)):
    """场地方维度财务数据（v3：直接按 landlord_id 统计）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 电费数据：台账挂 landlord_id 直接过滤；站点数 = 该场地下品牌数（场地×品牌组合数）
        cur.execute("""
            SELECT
                l.name as landlord,
                COALESCE(cnt.cnt, 0) as station_count,
                COALESCE(SUM(er.pay_amount), 0) as elec_pay,
                COALESCE(SUM(er.collect_net), 0) as elec_collect,
                COALESCE(SUM(er.profit), 0) as elec_profit
            FROM landlords l
            LEFT JOIN LATERAL (
                SELECT COUNT(DISTINCT m.brand_id) as cnt
                FROM meters m
                WHERE m.landlord_id = l.id AND m.brand_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%'
            ) cnt ON TRUE
            LEFT JOIN electricity_records er ON er.landlord_id = l.id
            GROUP BY l.id, l.name, cnt.cnt
            ORDER BY l.id
        """)
        elec_data = cur.fetchall()

        # 租金成本（v3：场地合同月租，×12 年化）
        cur.execute("""
            SELECT l.name as landlord,
                   COALESCE(SUM(c.monthly_rent), 0) as rent_cost
            FROM contracts c
            JOIN landlords l ON c.landlord_id = l.id
            WHERE c.contract_type = '场地合同'
            GROUP BY l.name
        """)
        rent_cost_map = {r["landlord"]: float(r["rent_cost"]) * 12 for r in cur.fetchall()}

        # 租金收入（v3：品牌方合同月租，×12 年化）
        cur.execute("""
            SELECT l.name as landlord,
                   COALESCE(SUM(c.monthly_rent), 0) as rent_income
            FROM contracts c
            JOIN landlords l ON c.landlord_id = l.id
            WHERE c.contract_type = '品牌方合同'
            GROUP BY l.name
        """)
        rent_income_map = {r["landlord"]: float(r["rent_income"]) * 12 for r in cur.fetchall()}

        result = []
        for row in elec_data:
            landlord = row["landlord"]
            rent_cost = rent_cost_map.get(landlord, 0)
            rent_income = rent_income_map.get(landlord, 0)
            result.append({
                "landlord": landlord,
                "stationCount": row["station_count"],
                "elecPay": round(float(row["elec_pay"]), 2),
                "elecCollect": round(float(row["elec_collect"]), 2),
                "elecProfit": round(float(row["elec_profit"]), 2),
                "rentCostAnnual": round(rent_cost, 2),
                "rentIncomeAnnual": round(rent_income, 2),
                "rentProfit": round(rent_income - rent_cost, 2),
                "totalProfit": round(float(row["elec_profit"]) + rent_income - rent_cost, 2),
            })

        return {"code": 0, "data": result}
    finally:
        cur.close()
        conn.close()


@router.get("/shareholders")
async def finance_shareholders(user: dict = Depends(get_current_user)):
    """股东分红数据（v3：分红台账挂 landlord_id）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT
                sh.name as shareholder,
                COUNT(DISTINCT dr.landlord_id) as station_count,
                COALESCE(SUM(ds.amount), 0) as dividend_amount,
                COALESCE(SUM(CASE WHEN dr.status = '已结算' THEN ds.amount ELSE 0 END), 0) as paid,
                COALESCE(SUM(CASE WHEN dr.status != '已结算' THEN ds.amount ELSE 0 END), 0) as unpaid
            FROM shareholders sh
            LEFT JOIN dividend_shares ds ON ds.shareholder_id = sh.id
            LEFT JOIN dividend_records dr ON dr.id = ds.dividend_id
            GROUP BY sh.id, sh.name
            ORDER BY sh.id
        """)

        result = []
        for row in cur.fetchall():
            dividend_amount = float(row["dividend_amount"])
            # 计算分红比例（简化：用分红金额占总利润的比例）
            ratio = ""
            if dividend_amount > 0:
                cur.execute("SELECT COALESCE(SUM(profit), 0) as total FROM dividend_records")
                total_profit = float(cur.fetchone()["total"])
                if total_profit > 0:
                    ratio = f"{round(dividend_amount / total_profit * 100, 1)}%"

            result.append({
                "shareholder": row["shareholder"],
                "stationCount": row["station_count"],
                "dividendAmount": round(dividend_amount, 2),
                "dividendRatio": ratio,
                "paid": round(float(row["paid"]), 2),
                "unpaid": round(float(row["unpaid"]), 2),
            })

        return {"code": 0, "data": result}
    finally:
        cur.close()
        conn.close()
