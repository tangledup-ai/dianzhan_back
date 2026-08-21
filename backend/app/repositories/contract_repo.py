from datetime import date
from ..infra.database import get_connection, get_dict_cursor


def list_contracts(brand_id: int = None, landlord_id: int = None, station_id: int = None, contract_type: str = None, keyword: str = None,
                   allowed_landlord_ids: list = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if brand_id:
            conditions.append("c.brand_id = %s"); values.append(brand_id)
        if landlord_id:
            conditions.append("c.landlord_id = %s"); values.append(landlord_id)
        # v3：station_id 列已删除，忽略该过滤参数（保留签名兼容）
        if contract_type:
            conditions.append("c.contract_type = %s"); values.append(contract_type)
        if allowed_landlord_ids is not None:
            conditions.append("c.landlord_id = ANY(%s::int[])"); values.append(allowed_landlord_ids)
        if keyword:
            conditions.append("(l.name ILIKE %s OR b.name ILIKE %s)")
            values.extend([f"%{keyword}%", f"%{keyword}%"])
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT c.*, b.name as brand_name, l.name as landlord_name, NULL as station_name_ref,
              (
                SELECT COALESCE(SUM(GREATEST(1, cab_cnt)), 0) FROM (
                  SELECT m.id, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id) AS cab_cnt
                  FROM meters m
                  WHERE m.landlord_id = c.landlord_id AND m.brand_id = c.brand_id
                    AND m.meter_no NOT LIKE 'TEST%%'
                ) t
              ) AS live_cabinets_count,
              (
                SELECT COALESCE(SUM(v.monthly_rent), 0) FROM contracts v
                WHERE v.landlord_id = c.landlord_id AND v.contract_type = '场地合同'
              ) AS venue_monthly_rent,
              (
                SELECT COALESCE(SUM(GREATEST(1, cab_cnt)), 0) FROM (
                  SELECT m.id, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id) AS cab_cnt
                  FROM meters m
                  WHERE m.landlord_id = c.landlord_id
                    AND m.brand_id IS NOT NULL
                    AND m.meter_no NOT LIKE 'TEST%%'
                ) t
              ) AS total_brand_cabinets
            FROM contracts c
            LEFT JOIN brands b ON c.brand_id = b.id
            LEFT JOIN landlords l ON c.landlord_id = l.id
            {where}
            ORDER BY c.landlord_id, c.contract_type, c.id
        """, values)
        rows = cur.fetchall()

        # 批量查询所有合同的分期状态（用于推导付款状态：全部分期已付→已付款，否则未付款）
        if rows:
            contract_ids = [r["id"] for r in rows]
            placeholders = ",".join(["%s"] * len(contract_ids))
            cur.execute(f"""
                SELECT contract_id,
                       COUNT(*) as total,
                       COUNT(*) FILTER (WHERE status IN ('已付款','已到账')) as paid
                FROM (
                    SELECT contract_id, status FROM rent_payment_schedule WHERE contract_id IN ({placeholders})
                    UNION ALL
                    SELECT contract_id, status FROM rent_income_schedule WHERE contract_id IN ({placeholders})
                ) s
                GROUP BY contract_id
            """, contract_ids + contract_ids)
            schedule_status_map = {r["contract_id"]: r for r in cur.fetchall()}
        else:
            schedule_status_map = {}

        today = date.today()
        for r in rows:
            # 优先使用 early_end_date，否则使用 end_date
            early_end = r.get("early_end_date")
            end = early_end or r.get("end_date")
            if end:
                days_left = (end - today).days
                r["days_left"] = days_left
                if early_end and days_left < 0:
                    r["status"] = "提前结束"
                elif days_left < 0:
                    r["status"] = "已到期"
                elif days_left <= 90:
                    r["status"] = "临期"
                else:
                    r["status"] = "正常"
            else:
                r["days_left"] = None
                r["status"] = "未知"
            # 计算品牌方合同承担的场地成本
            # 口径：场地合同月租金总和 ÷ 该场地所有品牌计费柜数总和 × 本品牌计费柜数
            # （与 dividend_calc.py 的分红按品牌场地成本一致；分母含无品牌方合同的品牌电表柜数，不计 TEST 电表）
            venue_rent = r.get("venue_monthly_rent")
            total_cabs = int(r.get("total_brand_cabinets") or 0)
            live_cabs = int(r.get("live_cabinets_count") or 0)
            if r.get("contract_type") == "品牌方合同" and venue_rent and total_cabs > 0:
                r["venue_cost"] = round(float(venue_rent) / total_cabs * live_cabs, 2)
            else:
                r["venue_cost"] = None
            # 推导付款状态（不存库）：无分期→未付款；全部分期已付→已付款；否则未付款
            ss = schedule_status_map.get(r["id"])
            if ss and ss["total"] > 0:
                r["pay_status"] = "已付款" if ss["paid"] == ss["total"] else "未付款"
            else:
                r["pay_status"] = "未付款"
        return rows
    finally:
        cur.close()
        conn.close()


def create_contract(data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO contracts
            (landlord_id, brand_id, entity_id, contract_type,
             electricity_price, rent_amount, cabinets_count, unit_monthly_rent, monthly_rent,
             rent_calc_method, pay_method, rent_advance_days, region, address, latitude, longitude, pay_entity, start_date, end_date, pay_status,
             tax_enabled, tax_rate, post_tax_electricity_price, deposit, first_month_rent, rent_refund, early_end_date,
             rent_tax_enabled, rent_tax_rate, post_tax_rent_price, remark)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            data.get("landlordId"), data.get("brandId"),
            data.get("entityId"),
            data.get("contractType", "场地合同"),
            data.get("electricityPrice"), data.get("rentAmount"),
            data.get("cabinetsCount"), data.get("unitMonthlyRent"), data.get("monthlyRent"),
            data.get("rentCalcMethod", "按柜子数量"),
            data.get("payMethod"), data.get("rentAdvanceDays", 0),
            data.get("region"), data.get("address"),
            data.get("latitude"), data.get("longitude"),
            data.get("payEntity"),
            data.get("startDate"), data.get("endDate"),
            data.get("payStatus", "未付款"),
            data.get("taxEnabled", False), data.get("taxRate", 0.01), data.get("postTaxElectricityPrice"),
            data.get("deposit"),
            data.get("firstMonthRent"),
            data.get("rentRefund"),
            data.get("earlyEndDate"),
            data.get("rentTaxEnabled", False),
            data.get("rentTaxRate", 0.01),
            data.get("postTaxRentPrice"),
            data.get("remark")
        ))
        conn.commit()
        contract = cur.fetchone()
        # 生成收付款分期（按 pay_method 拆期）
        try:
            from .contract_schedule_repo import generate_schedules
            generate_schedules(
                contract_id=contract["id"],
                contract_type=data.get("contractType", "场地合同"),
                pay_method=data.get("payMethod") or "月付",
                start_date=data.get("startDate"),
                end_date=data.get("endDate"),
                monthly_rent=data.get("monthlyRent"),
            )
        except Exception:
            pass
        return contract
    finally:
        cur.close()
        conn.close()


def update_contract(contract_id: int, data: dict):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        field_map = {
            "landlordId": "landlord_id", "brandId": "brand_id", "entityId": "entity_id",
            "contractType": "contract_type",
            "electricityPrice": "electricity_price", "rentAmount": "rent_amount",
            "cabinetsCount": "cabinets_count", "unitMonthlyRent": "unit_monthly_rent",
            "monthlyRent": "monthly_rent", "rentCalcMethod": "rent_calc_method",
            "payMethod": "pay_method",
            "rentAdvanceDays": "rent_advance_days",
            "region": "region", "latitude": "latitude", "longitude": "longitude",
            "address": "address", "payEntity": "pay_entity",
            "startDate": "start_date", "endDate": "end_date",
            "payStatus": "pay_status",
            "taxEnabled": "tax_enabled", "taxRate": "tax_rate",
            "postTaxElectricityPrice": "post_tax_electricity_price",
            "deposit": "deposit",
            "firstMonthRent": "first_month_rent",
            "rentRefund": "rent_refund",
            "earlyEndDate": "early_end_date",
            "rentTaxEnabled": "rent_tax_enabled",
            "rentTaxRate": "rent_tax_rate",
            "postTaxRentPrice": "post_tax_rent_price",
            "remark": "remark"
        }
        updates, values = [], []
        for key, db_field in field_map.items():
            if key in data and data[key] is not None:
                updates.append(f"{db_field} = %s"); values.append(data[key])
        if not updates:
            return None
        values.append(contract_id)
        cur.execute(f"UPDATE contracts SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        updated = cur.fetchone()
        conn.commit()
        # 修复 #7：合同月租/付款方式/起止日期变更后，重建收付款分期（generate_schedules 会按 seq 保留已付状态）
        try:
            from .contract_schedule_repo import generate_schedules
            generate_schedules(
                contract_id=contract_id,
                contract_type=updated.get("contract_type", "场地合同"),
                pay_method=updated.get("pay_method") or "月付",
                start_date=updated.get("start_date"),
                end_date=updated.get("end_date"),
                monthly_rent=updated.get("monthly_rent"),
            )
        except Exception:
            pass
        return updated
    finally:
        cur.close()
        conn.close()


def delete_contract(contract_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        # 先删合同的分期记录，再删合同（避免孤儿分期）
        cur.execute("DELETE FROM rent_payment_schedule WHERE contract_id = %s", (contract_id,))
        cur.execute("DELETE FROM rent_income_schedule WHERE contract_id = %s", (contract_id,))
        cur.execute("DELETE FROM contracts WHERE id = %s", (contract_id,))
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()
