from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from ..repositories import meter_repo
from ..infra.auth_scope import scope_landlord_ids, scope_meter_tag, ensure_meter_in_scope
from ..infra.meter_api import tq_client
from ..infra.database import get_connection, get_dict_cursor
from .base import CamelJSONResponse
import openpyxl
from io import BytesIO
from datetime import datetime

router = APIRouter(prefix="/api/meters", tags=["电表管理"], default_response_class=CamelJSONResponse)


def _num(val):
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None

def _str(val):
    if val is None:
        return None
    s = str(val).strip()
    return s if s else None

def _get_or_create_landlord(name: str) -> int | None:
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id FROM landlords WHERE name = %s", (name,))
        row = cur.fetchone()
        if row:
            return row["id"]
        cur.execute("INSERT INTO landlords (name) VALUES (%s) RETURNING id", (name,))
        conn.commit()
        return cur.fetchone()["id"]
    finally:
        cur.close()
        conn.close()

def _get_or_create_brand(name: str) -> int | None:
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id FROM brands WHERE name = %s", (name,))
        row = cur.fetchone()
        if row:
            return row["id"]
        cur.execute("INSERT INTO brands (name) VALUES (%s) RETURNING id", (name,))
        conn.commit()
        return cur.fetchone()["id"]
    finally:
        cur.close()
        conn.close()

def _find_entity_id(name: str) -> int | None:
    if not name:
        return None
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id FROM entities WHERE name = %s", (name,))
        row = cur.fetchone()
        return row["id"] if row else None
    finally:
        cur.close()
        conn.close()


@router.post("/import")
async def import_meters(request: Request, file: UploadFile = File(...)):
    """电表读数导入（智慧电表-示例表 格式，按场地方分块、场地方列合并单元格）

    列：A场地方 / B品牌方(未关联时填) / C电表编号* / D月份* / E本月实际用电量(kWh) /
        F本月实际读数 / G上月实际读数 / H备注 / I报税公司主体 / J电表名称 / K互感器倍数

    规则：
    - 场地方列是合并单元格：为空时继承上一行的场地方（同一场地块内多行电表）。
    - 已关联场地的电表：只更新当月实际用电量/读数（meter_monthly），其他信息不修改。
    - 未关联场地的电表：自动关联场地方(+品牌/报税公司主体/电表名称/互感器倍数) 并保存读数。
    """
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(400, "请上传Excel文件(.xlsx)")

    content = await file.read()
    try:
        wb = openpyxl.load_workbook(BytesIO(content), data_only=True)
    except Exception as e:
        raise HTTPException(400, f"无法读取Excel文件: {str(e)}")

    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if len(rows) < 3:
        raise HTTPException(400, "Excel文件数据不足")

    results = {"updated": 0, "errors": [], "created_landlords": [], "created_brands": []}
    periods = {}  # (landlord_id, month) 需要重新生成台账

    current_landlord_name = None

    for row_idx, row in enumerate(rows[1:], start=2):
        try:
            # 合并单元格：场地方列为空 → 继承上一行（同一场地块）
            landlord_name = _str(row[0]) or current_landlord_name
            if landlord_name:
                current_landlord_name = landlord_name
            brand_name = _str(row[1])
            meter_no = _str(row[2])
            month_raw = _str(row[3])
            actual_kwh = _num(row[4])
            curr_reading = _num(row[5])
            prev_reading = _num(row[6])
            remark = _str(row[7]) or ""
            tax_entity = _str(row[8])
            meter_name = _str(row[9])
            ratio = _num(row[10])

            if "示例" in remark:
                continue  # 模板示例行跳过

            if not meter_no:
                results["errors"].append(f"第{row_idx}行: 电表编号为空")
                continue
            if not month_raw:
                results["errors"].append(f"第{row_idx}行: 月份为空")
                continue
            month_key = str(month_raw).replace("-", "").replace(".", "")[:6]
            if len(month_key) != 6 or not month_key.isdigit():
                results["errors"].append(f"第{row_idx}行: 月份格式错误（{month_raw}），应为 2026-08 或 202608")
                continue

            # 找电表
            conn = get_connection()
            cur = get_dict_cursor(conn)
            try:
                cur.execute("SELECT id, landlord_id, brand_id, entity_id, meter_name, transformer_ratio FROM meters WHERE meter_no = %s", (meter_no,))
                meter = cur.fetchone()
            finally:
                cur.close(); conn.close()
            if not meter:
                results["errors"].append(f"第{row_idx}行: 电表编号 {meter_no} 不存在")
                continue

            landlord_id = meter["landlord_id"]
            brand_id = meter["brand_id"]
            is_linked = bool(landlord_id)

            # ── 未关联的电表：自动关联场地 + 品牌 + 主体 + 名称 + 倍数 ──
            if not is_linked:
                if not landlord_name:
                    results["errors"].append(f"第{row_idx}行: 电表 {meter_no} 未关联场地且 Excel 未填场地方")
                    continue
                landlord_id = _get_or_create_landlord(landlord_name)
                if landlord_name not in results["created_landlords"]:
                    results["created_landlords"].append(landlord_name)
                if brand_name and not brand_id:
                    brand_id = _get_or_create_brand(brand_name)
                    if brand_name not in results["created_brands"]:
                        results["created_brands"].append(brand_name)
                entity_id = _find_entity_id(tax_entity) if tax_entity else None

                conn = get_connection()
                cur = get_dict_cursor(conn)
                try:
                    updates, vals = ["landlord_id = %s"], [landlord_id]
                    if brand_id and not meter["brand_id"]:
                        updates.append("brand_id = %s"); vals.append(brand_id)
                    if entity_id and entity_id != meter.get("entity_id"):
                        updates.append("entity_id = %s"); vals.append(entity_id)
                        updates.append("entity_source = %s"); vals.append("manual")
                    if meter_name:
                        updates.append("meter_name = %s"); vals.append(meter_name)
                    if ratio:
                        updates.append("transformer_ratio = %s"); vals.append(ratio)
                    vals.append(meter["id"])
                    cur.execute(f"UPDATE meters SET {', '.join(updates)} WHERE id = %s", vals)
                finally:
                    cur.close(); conn.close()

            # ── 保存当月读数（已关联/未关联都执行）──
            if actual_kwh is None and curr_reading is not None and prev_reading is not None:
                actual_kwh = round(curr_reading - prev_reading, 2)

            if actual_kwh is not None or curr_reading is not None or prev_reading is not None:
                conn = get_connection()
                cur = get_dict_cursor(conn)
                try:
                    cur.execute("""
                        SELECT id FROM meter_monthly
                        WHERE address = %s AND month_period = %s
                    """, (meter_no, month_key))
                    existing = cur.fetchone()
                    if existing:
                        set_sql, vals = [], []
                        if actual_kwh is not None:
                            set_sql.append("actual_kwh = %s"); vals.append(actual_kwh)
                        if curr_reading is not None:
                            set_sql.append("curr_actual_reading = %s"); vals.append(curr_reading)
                        if prev_reading is not None:
                            set_sql.append("prev_actual_reading = %s"); vals.append(prev_reading)
                        if set_sql:
                            vals.append(existing["id"])
                            cur.execute(f"UPDATE meter_monthly SET {', '.join(set_sql)} WHERE id = %s", vals)
                    else:
                        cur.execute("""
                            INSERT INTO meter_monthly (address, month_period, actual_kwh, prev_actual_reading, curr_actual_reading)
                            VALUES (%s, %s, %s, %s, %s)
                        """, (meter_no, month_key, actual_kwh, prev_reading, curr_reading))
                finally:
                    cur.close(); conn.close()

            if landlord_id:
                periods[(landlord_id, month_key)] = True
            results["updated"] += 1

        except Exception as e:
            results["errors"].append(f"第{row_idx}行: {str(e)}")

    # 自动重新生成涉及场地的电费台账
    from .electricity import auto_generate_for_landlord
    for (lid, _period) in periods:
        try:
            await auto_generate_for_landlord(lid)
        except Exception:
            pass

    return results


@router.get("")
async def list_meters(request: Request, stationId: int = None, brandId: int = None, landlordId: int = None):
    # 股东：只能看到关联场地的电表；财务指定电表类型范围：再按类型过滤
    allowed = scope_landlord_ids(request)
    return meter_repo.list_meters(station_id=stationId, brand_id=brandId, landlord_id=landlordId,
                                  allowed_landlord_ids=allowed, allowed_tag=scope_meter_tag(request))


@router.get("/{meter_id}")
async def get_meter(meter_id: int, request: Request = None):
    meter = meter_repo.get_meter(meter_id)
    if not meter:
        raise HTTPException(404, "电表不存在")
    if request is not None:
        ensure_meter_in_scope(request, meter.get("tag"), meter.get("landlord_id"), hide=True)

    # 获取实时状态（从新数据库的 meter_status_cache 表读取）
    status = meter_repo.get_meter_status(meter["meter_no"])

    # 获取月度用电量（从新数据库的 meter_monthly 表读取）
    monthly = meter_repo.get_meter_monthly_usage(meter["meter_no"])

    realtime = None
    if status:
        realtime = {
            "totalKwh": float(status.get("total_kwh") or 0),
            "peakKwh": float(status.get("peak_kwh") or 0),
            "sharpKwh": float(status.get("sharp_kwh") or 0),
            "flatKwh": float(status.get("flat_kwh") or 0),
            "valleyKwh": float(status.get("valley_kwh") or 0),
            "remainingAmount": float(status.get("remain_money") or 0),
            "syncedAt": str(status.get("updated_at") or ""),
        }

    # 互感器倍数：实际用电量 = 表码度数 × 倍数（actual_kwh 人工修正优先，v2 口径）
    ratio = float(meter.get("transformer_ratio") or 1)
    usage = {
        "monthly": []
    }
    for m in monthly:
        if m.get("actual_kwh") is not None:
            kwh = round(float(m["actual_kwh"]), 2)
        else:
            kwh = round(float(m.get("kwh") or 0) * ratio, 2)
        usage["monthly"].append({"period": m.get("period"), "kwh": kwh})

    return {**meter, "realtime": realtime, "usage": usage}


@router.post("", status_code=201)
async def create_meter(request: Request, data: dict):
    # 电表类型范围校验：受限账号创建的电表必须落在自己范围内
    ensure_meter_in_scope(request, data.get("tag") or "合作商电表", data.get("landlordId"))
    try:
        result = meter_repo.create_meter(data)
    except Exception as e:
        import logging
        logging.error(f"create_meter error: {e}, data={data}")
        raise HTTPException(400, str(e))
    # 动态生成：电表创建后若已归属（landlord+brand），自动生成其有读数月份的台账
    from .electricity import auto_generate_for_meter
    try:
        await auto_generate_for_meter(result.get("meter_no") or data.get("meterNo"))
    except Exception:
        pass  # 自动生成失败不影响电表保存（可手动点「自动生成」）
    # 分红联动：电表归属影响场地成本分摊，重算该场地已有分红记录（失败不影响保存）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        refresh_dividend_records(result.get("landlord_id"))
    except Exception:
        pass
    return result


@router.put("/{meter_id}")
async def update_meter(meter_id: int, request: Request, data: dict):
    # 归属变更会同时影响新旧两个场地的分红分摊，先记下旧归属
    old_meter = meter_repo.get_meter(meter_id)
    if not old_meter:
        raise HTTPException(404, "电表不存在")
    # 电表类型范围：原电表须在范围内；改类型/改场地后的落点也须在范围内
    ensure_meter_in_scope(request, old_meter.get("tag"), old_meter.get("landlord_id"), hide=True)
    ensure_meter_in_scope(request,
                          data.get("tag") or old_meter.get("tag"),
                          data.get("landlordId") if data.get("landlordId") is not None else old_meter.get("landlord_id"))
    # 换主体审计的操作人（repo 内写 meter_entity_changes 用；额外键不影响字段更新）
    operator = (getattr(request.state, "current_user", None) or {}).get("name")
    if operator:
        data["operator"] = operator
    try:
        result = meter_repo.update_meter(meter_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not result:
        raise HTTPException(404, "电表不存在")

    # 换主体：默认重算该电表全部有读数月份（历史台账整体搬到新主体）；
    # entityRegenerateFrom="current" 时仅从本月起重算（历史月保留在原主体口径下）
    entity_changed = result.get("entity_id") != old_meter.get("entity_id")
    affected_months: list = []
    if entity_changed:
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("""
                SELECT DISTINCT month_period AS p FROM meter_monthly
                WHERE address = %s ORDER BY p
            """, (result.get("meter_no"),))
            affected_months = [r["p"] for r in cur.fetchall()]
        finally:
            cur.close()
            conn.close()

    from_period = None
    if entity_changed and data.get("entityRegenerateFrom") == "current":
        from_period = datetime.now().strftime("%Y%m")

    # 动态生成：电表归属（landlord/brand/entity）变更后，自动生成其有读数月份的台账
    from .electricity import auto_generate_for_meter
    try:
        await auto_generate_for_meter(result.get("meter_no") or data.get("meterNo"), from_period=from_period)
    except Exception:
        pass  # 自动生成失败不影响电表保存（可手动点「自动生成」）
    # 分红联动：重算新旧场地的已有分红记录（失败不影响保存）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        lids = {old_meter.get("landlord_id") if old_meter else None, result.get("landlord_id")}
        for lid in lids:
            refresh_dividend_records(lid)
    except Exception:
        pass
    if entity_changed:
        return {**result, "entityChanged": True, "affectedMonths": affected_months}
    return result


@router.delete("/{meter_id}")
async def delete_meter(meter_id: int, request: Request):
    old_meter = meter_repo.get_meter(meter_id)
    if not old_meter:
        raise HTTPException(404, "电表不存在")
    ensure_meter_in_scope(request, old_meter.get("tag"), old_meter.get("landlord_id"), hide=True)
    meter_repo.delete_meter(meter_id)
    # 分红联动：重算原场地已有分红记录（失败不影响删除）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        refresh_dividend_records(old_meter.get("landlord_id") if old_meter else None)
    except Exception:
        pass
    return {"ok": True}
