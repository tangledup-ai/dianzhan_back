import json
from datetime import date
from ..infra.database import get_connection, get_dict_cursor


def _log_contract_audit(cur, contract_id: int, action: str, changes: dict, operator: str = None):
    """写合同变更审计日志（与业务写入同事务提交）"""
    cur.execute(
        "INSERT INTO contract_audit_log (contract_id, action, changes, operator) VALUES (%s, %s, %s, %s)",
        (contract_id, action, json.dumps(changes, ensure_ascii=False, default=str), operator),
    )


def list_audit(contract_id: int, limit: int = 50):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "SELECT * FROM contract_audit_log WHERE contract_id = %s ORDER BY created_at DESC, id DESC LIMIT %s",
            (contract_id, limit),
        )
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


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
                  WHERE m.landlord_id = c.landlord_id
                    AND m.meter_no NOT LIKE 'TEST%%'
                    AND (
                      (c.brand_id IS NOT NULL AND m.brand_id = c.brand_id)
                      -- 全品牌收入合同（无品牌）：匹配该场地的共享电表
                      OR (c.contract_type = '品牌方合同' AND c.brand_id IS NULL
                          AND m.brand_id IS NULL AND m.tag = '共享电表')
                    )
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
                    AND (m.brand_id IS NOT NULL OR m.tag = '共享电表')
                    AND m.meter_no NOT LIKE 'TEST%%'
                ) t
              ) AS total_brand_cabinets,
              -- 该场地下所有收入合同（品牌方合同）的计费柜数总和（实时：与 live_cabinets_count 同口径，
              -- 按品牌方合同覆盖的品牌统计 meters→cabinets；全品牌收入合同额外覆盖场地内共享电表；
              -- 电表归属变更后自动跟随，不读 cabinets_count 存储快照）
              (
                SELECT COALESCE(SUM(GREATEST(1, cab_cnt)), 0) FROM (
                  SELECT m.id, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id) AS cab_cnt
                  FROM meters m
                  WHERE m.landlord_id = c.landlord_id
                    AND m.meter_no NOT LIKE 'TEST%%'
                    AND (
                      m.brand_id IN (
                        SELECT v.brand_id FROM contracts v
                        WHERE v.landlord_id = c.landlord_id
                          AND v.contract_type = '品牌方合同'
                          AND v.brand_id IS NOT NULL
                      )
                      OR (
                        m.brand_id IS NULL AND m.tag = '共享电表'
                        AND EXISTS (
                          SELECT 1 FROM contracts v2
                          WHERE v2.landlord_id = c.landlord_id
                            AND v2.contract_type = '品牌方合同'
                            AND v2.brand_id IS NULL
                        )
                      )
                    )
                ) t
              ) AS income_cabinets_total
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
            # 口径：场地合同月租金总和 ÷ 该场地所有计费柜数总和（含共享电表，分红分摊口径不含共享）
            #      × 本合同计费柜数；仅合同页展示用，不计 TEST 电表
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


def _validate_early_end(data: dict):
    """填写了合同提前结束日期时，必须同时填写场地费退款金额（>0）"""
    early = data.get("earlyEndDate")
    if not early:
        return
    try:
        refund = float(data.get("rentRefund") or 0)
    except (TypeError, ValueError):
        refund = 0
    if refund <= 0:
        raise ValueError("填写了合同提前结束日期时，必须同时填写场地费退款金额")


def create_contract(data: dict, operator: str = None):
    _validate_early_end(data)
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 唯一场地合同校验：同一个场地方只能有一个场地合同
        contract_type = data.get("contractType", "场地合同")
        landlord_id = data.get("landlordId")
        if contract_type == "场地合同" and landlord_id:
            cur.execute("""
                SELECT id FROM contracts
                WHERE contract_type = '场地合同' AND landlord_id = %s
            """, (landlord_id,))
            if cur.fetchone():
                raise ValueError("该场地方已存在场地合同，一个场地方只能有一份场地合同")

        cur.execute("""
            INSERT INTO contracts
            (landlord_id, brand_id, entity_id, contract_type,
             electricity_price, rent_amount, unit_monthly_rent, monthly_rent,
             rent_calc_method, pay_method, rent_advance_days, region, address, latitude, longitude, pay_entity, start_date, end_date, pay_status,
             tax_enabled, tax_rate, post_tax_electricity_price, deposit, first_month_rent, rent_refund, early_end_date,
             rent_tax_enabled, rent_tax_rate, post_tax_rent_price, remark)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            landlord_id, data.get("brandId"),
            data.get("entityId"),
            contract_type,
            data.get("electricityPrice"), data.get("rentAmount"),
            data.get("unitMonthlyRent"), data.get("monthlyRent"),
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
        contract = cur.fetchone()
        # 变更审计：合同创建快照（与业务写入同事务）
        _log_contract_audit(cur, contract["id"], "create", {"snapshot": dict(contract)}, operator)
        conn.commit()
        # 生成收付款分期（按 pay_method 拆期）；失败不再静默，打印日志便于排查
        try:
            from .contract_schedule_repo import generate_schedules
            generate_schedules(
                contract_id=contract["id"],
                contract_type=contract_type,
                pay_method=data.get("payMethod") or "月付",
                start_date=data.get("startDate"),
                end_date=data.get("earlyEndDate") or data.get("endDate"),
                monthly_rent=data.get("monthlyRent"),
                first_month_rent=data.get("firstMonthRent"),
            )
        except Exception as e:
            import logging
            logging.error(f"generate_schedules error for contract {contract['id']}: {e}, data={data}")
        return contract
    finally:
        cur.close()
        conn.close()


def update_contract(contract_id: int, data: dict, operator: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 读取更新前的合同（用于唯一场地合同校验、提前结束/退款的合并校验、变更审计）
        cur.execute("SELECT * FROM contracts WHERE id = %s", (contract_id,))
        before = cur.fetchone()
        if not before:
            return None

        # 生效值校验：提前结束/退款属于可清空字段——显式传入（含 null/空串）以新值为准，否则沿用库中现值
        eff_early = data["earlyEndDate"] if "earlyEndDate" in data else before.get("early_end_date")
        eff_early = eff_early or None
        eff_refund = data["rentRefund"] if "rentRefund" in data else before.get("rent_refund")
        try:
            eff_refund_num = float(eff_refund) if eff_refund not in (None, "") else 0
        except (TypeError, ValueError):
            eff_refund_num = 0
        if eff_early and eff_refund_num <= 0:
            raise ValueError("填写了合同提前结束日期时，必须同时填写场地费退款金额")

        field_map = {
            "landlordId": "landlord_id", "brandId": "brand_id", "entityId": "entity_id",
            "contractType": "contract_type",
            "electricityPrice": "electricity_price", "rentAmount": "rent_amount",
            "unitMonthlyRent": "unit_monthly_rent",
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
        # 这三个字段允许显式清空：前端清空输入框提交 null/空串 表示"撤销该设置"
        # （如撤销提前结束/场地费退款/首月场地租金），其余字段保持跳过 null 的行为
        CLEARABLE_FIELDS = {"firstMonthRent", "rentRefund", "earlyEndDate"}
        updates, values = [], []
        for key, db_field in field_map.items():
            if key not in data:
                continue
            if key in CLEARABLE_FIELDS:
                updates.append(f"{db_field} = %s")
                values.append(data[key] if data[key] not in (None, "") else None)
            elif data[key] is not None:
                updates.append(f"{db_field} = %s"); values.append(data[key])
        if not updates:
            return None

        # 唯一场地合同校验：若更新后是场地合同（或保持场地合同），同 landlord 只能有一份
        new_type = data.get("contractType", before["contract_type"])
        new_landlord = data.get("landlordId", before["landlord_id"])
        if new_type == "场地合同" and new_landlord:
            cur.execute("""
                SELECT id FROM contracts
                WHERE contract_type = '场地合同' AND landlord_id = %s AND id != %s
            """, (new_landlord, contract_id))
            if cur.fetchone():
                raise ValueError("该场地方已存在场地合同，一个场地方只能有一份场地合同")

        values.append(contract_id)
        cur.execute(f"UPDATE contracts SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        updated = cur.fetchone()
        # 变更审计：记录修改字段（from → to），与业务写入同事务
        changes = {}
        for key, db_field in field_map.items():
            old, new = before.get(db_field), updated.get(db_field)
            if str(old) != str(new):
                changes[key] = {"from": old, "to": new}
        if changes:
            _log_contract_audit(cur, contract_id, "update", changes, operator)
        conn.commit()
        # 修复 #7：合同月租/付款方式/起止日期变更后，重建收付款分期（generate_schedules 会按 seq 保留已付状态）
        try:
            from .contract_schedule_repo import generate_schedules
            generate_schedules(
                contract_id=contract_id,
                contract_type=updated.get("contract_type", "场地合同"),
                pay_method=updated.get("pay_method") or "月付",
                start_date=updated.get("start_date"),
                end_date=updated.get("early_end_date") or updated.get("end_date"),
                monthly_rent=updated.get("monthly_rent"),
                first_month_rent=updated.get("first_month_rent"),
            )
        except Exception as e:
            import logging
            logging.error(f"generate_schedules error for contract {contract_id}: {e}")
        return updated
    finally:
        cur.close()
        conn.close()


def delete_contract(contract_id: int, operator: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 先取合同快照（变更审计）与场地方（用于删除后刷新分红记录），再删分期与合同本身（避免孤儿分期）
        cur.execute("SELECT * FROM contracts WHERE id = %s", (contract_id,))
        row = cur.fetchone()
        landlord_id = row["landlord_id"] if row else None
        cur.execute("DELETE FROM rent_payment_schedule WHERE contract_id = %s", (contract_id,))
        cur.execute("DELETE FROM rent_income_schedule WHERE contract_id = %s", (contract_id,))
        cur.execute("DELETE FROM contracts WHERE id = %s", (contract_id,))
        if row:
            _log_contract_audit(cur, contract_id, "delete", {"snapshot": dict(row)}, operator)
        conn.commit()
        return landlord_id
    finally:
        cur.close()
        conn.close()
