"""电表能耗数据 API"""
from fastapi import APIRouter, HTTPException, Query, Request
from ..infra.database import get_connection, get_dict_cursor
from ..infra.auth_scope import scope_landlord_ids, scope_meter_tag, ensure_meter_in_scope
from ..infra.period import to_compact, to_display
from ..domain.electricity_pricing import resolve_prices, split_tax
from ..repositories import shared_allocation_repo
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/meter-energy", tags=["电表能耗"], default_response_class=CamelJSONResponse)


def _shared_kwh(collect_amount, unit_price):
    """用电量 = 应收电费 ÷ 单价（单价为空/0 → None，无法倒推）"""
    try:
        price = float(unit_price or 0)
        if price <= 0:
            return None
        return round(float(collect_amount or 0) / price, 2)
    except (TypeError, ValueError):
        return None


def _scope_conditions(conditions: list, values: list, request, column: str):
    """能耗查询的数据隔离条件：m 为 JOIN 出的 meters 表别名"""
    allowed = scope_landlord_ids(request)
    if allowed is not None:
        conditions.append(f"{column}.landlord_id = ANY(%s::int[])")
        values.append(allowed)
    tag_scope = scope_meter_tag(request)
    if tag_scope:
        conditions.append(f"{column}.tag = %s")
        values.append(tag_scope)


@router.get("/daily")
async def get_daily_kwh(
    request: Request = None,
    meterNo: str = None,
    startDate: str = Query(None, description="开始日期 YYYYMMDD"),
    endDate: str = Query(None, description="结束日期 YYYYMMDD"),
):
    """获取日用电量"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if request is not None:
            _scope_conditions(conditions, values, request, "m")
        if meterNo:
            conditions.append("d.address = %s")
            values.append(meterNo)
        if startDate:
            conditions.append("d.day_date >= %s")
            values.append(startDate)
        if endDate:
            conditions.append("d.day_date <= %s")
            values.append(endDate)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        cur.execute(f"""
            SELECT d.*, m.meter_name, m.landlord_id, l.name as station_name, m.transformer_ratio
            FROM meter_daily d
            LEFT JOIN meters m ON m.meter_no = d.address
            LEFT JOIN landlords l ON m.landlord_id = l.id
            {where}
            ORDER BY d.day_date DESC, d.address
        """, values)
        rows = cur.fetchall()
        # 实际用电量 = 表码度数 × 互感器倍数
        for r in rows:
            if r.get("kwh") is not None:
                r["kwh"] = round(float(r["kwh"]) * float(r.get("transformer_ratio") or 1), 2)
        return rows
    finally:
        cur.close()
        conn.close()


@router.get("/hourly")
async def get_hourly_kwh(
    request: Request = None,
    meterNo: str = None,
    startTime: str = Query(None, description="开始时间 YYYYMMDDHH"),
    endTime: str = Query(None, description="结束时间 YYYYMMDDHH"),
):
    """获取小时用电量"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if request is not None:
            _scope_conditions(conditions, values, request, "m")
        if meterNo:
            conditions.append("h.address = %s")
            values.append(meterNo)
        if startTime:
            conditions.append("h.hour_time >= %s")
            values.append(startTime)
        if endTime:
            conditions.append("h.hour_time <= %s")
            values.append(endTime)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        cur.execute(f"""
            SELECT h.*, m.meter_name, m.landlord_id, l.name as station_name, m.transformer_ratio
            FROM meter_hourly h
            LEFT JOIN meters m ON m.meter_no = h.address
            LEFT JOIN landlords l ON m.landlord_id = l.id
            {where}
            ORDER BY h.hour_time DESC, h.address
        """, values)
        rows = cur.fetchall()
        # 实际用电量 = 表码度数 × 互感器倍数
        for r in rows:
            if r.get("kwh") is not None:
                r["kwh"] = round(float(r["kwh"]) * float(r.get("transformer_ratio") or 1), 2)
        return rows
    finally:
        cur.close()
        conn.close()


@router.get("/monthly")
async def get_monthly_kwh(
    request: Request = None,
    meterNo: str = None,
    startMonth: str = Query(None, description="开始月份 YYYYMM"),
    endMonth: str = Query(None, description="结束月份 YYYYMM"),
):
    """获取月用电量"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if request is not None:
            _scope_conditions(conditions, values, request, "m")
        if meterNo:
            # ★V5：把「电表号 / 设备地址」先解析成电表 id 再过滤 —— 读数表已不再按字符串关联，
            #       这样人工改电表编号后历史读数依然查得到（旧库已因此失联 14 块表）。
            cur.execute(
                """
                SELECT id FROM meters
                WHERE meter_no = %s OR device_address = %s
                ORDER BY (meter_no = %s) DESC NULLS LAST, id
                LIMIT 1
                """,
                (meterNo, meterNo, meterNo),
            )
            _m = cur.fetchone()
            conditions.append("mm.meter_id = %s")
            values.append(_m["id"] if _m else -1)   # 解析不到 ⇒ -1（返回空列表，不报错）
        if startMonth:
            conditions.append("mm.month_period >= %s")
            values.append(startMonth)
        if endMonth:
            conditions.append("mm.month_period <= %s")
            values.append(endMonth)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        cur.execute(f"""
            SELECT mm.*, m.meter_name, m.landlord_id, l.name as station_name, m.transformer_ratio
            FROM meter_readings mm
            LEFT JOIN meters m ON m.id = mm.meter_id
            LEFT JOIN landlords l ON m.landlord_id = l.id
            {where}
            ORDER BY mm.month_period DESC, mm.address
        """, values)
        rows = cur.fetchall()
        # 实际用电量 = actual_kwh（若有）否则 表码度数 × 互感器倍数
        # raw_kwh 保留原始表码度数，供「读数编辑表单」回填，避免读→编辑→写回导致二次相乘
        for r in rows:
            if r.get("kwh") is not None or r.get("actual_kwh") is not None:
                # ★V5：倍数优先取**读数行上的快照**（换互感器倍数不影响历史月份）
                ratio = float(r.get("transformer_ratio_snapshot") or r.get("transformer_ratio") or 1)
                r["raw_kwh"] = float(r["kwh"]) if r.get("kwh") is not None else None
                if r.get("actual_kwh") is not None:
                    r["kwh"] = round(float(r["actual_kwh"]), 2)
                else:
                    r["kwh"] = round(float(r["kwh"]) * ratio, 2)
        return rows
    finally:
        cur.close()
        conn.close()


@router.post("/readings")
async def save_meter_reading(data: dict, request: Request = None):
    """手动录入/更新电表月度读数（人工实际读数不随第三方同步覆盖）"""
    address = data.get("address")
    month_period = data.get("monthPeriod")
    kwh = data.get("kwh")
    actual_kwh = data.get("actualKwh")
    prev_actual_reading = data.get("prevActualReading")
    curr_actual_reading = data.get("currActualReading")
    prev_reading_date = data.get("prevReadingDate")
    prev_reading = data.get("prevReading")
    curr_reading_date = data.get("currReadingDate")
    curr_reading = data.get("currReading")

    if not address or not month_period:
        raise HTTPException(400, "address 和 monthPeriod 必填")

    # 电表类型范围：受限账号只能写范围内电表的读数（地址不存在或范围外一律拒绝）
    if request is not None and (scope_meter_tag(request) or scope_landlord_ids(request) is not None):
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("SELECT tag, landlord_id FROM meters WHERE meter_no = %s", (address,))
            meter = cur.fetchone()
        finally:
            cur.close()
            conn.close()
        if not meter:
            raise HTTPException(403, "电表不存在，无法录入读数")
        ensure_meter_in_scope(request, meter.get("tag"), meter.get("landlord_id"))

    # ★V5：读数唯一键已改为 (meter_id, period)，写库前必须解析出本库电表 id。
    # 解析顺序：业务编号 meter_no（前端目前传的是它）→ 设备地址 device_address（改名后仍能对上）。
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            """
            SELECT id, transformer_ratio FROM meters
            WHERE meter_no = %s OR device_address = %s
            ORDER BY (meter_no = %s) DESC NULLS LAST, id
            LIMIT 1
            """,
            (address, address, address),
        )
        mid_row = cur.fetchone()
    finally:
        cur.close()
        conn.close()
    if not mid_row:
        raise HTTPException(404, f"电表档案不存在，无法录入读数：{address}")
    meter_id = mid_row["id"]
    transformer_ratio = float(mid_row.get("transformer_ratio") or 1)

    # 如果提供了起始度数和抄表度数，自动计算区间度数
    if kwh is None and prev_reading is not None and curr_reading is not None:
        kwh = float(curr_reading) - float(prev_reading)
    elif kwh is not None:
        kwh = float(kwh)
    else:
        kwh = 0

    # 人工实际值（已含倍数，非空则优先使用；空则保留 NULL，走「区间值×倍数」）
    actual_kwh = float(actual_kwh) if actual_kwh is not None and str(actual_kwh).strip() != "" else None
    # 人工实际读数（第三方同步不覆盖；填写时若未给实际用电量，可由 本月-上月 自动补）
    prev_actual_reading = float(prev_actual_reading) if prev_actual_reading is not None and str(prev_actual_reading).strip() != "" else None
    curr_actual_reading = float(curr_actual_reading) if curr_actual_reading is not None and str(curr_actual_reading).strip() != "" else None
    if actual_kwh is None and prev_actual_reading is not None and curr_actual_reading is not None:
        # 人工填写的“实际用电量”已含倍率；表码差需乘当前倍率。
        actual_kwh = round((curr_actual_reading - prev_actual_reading) * transformer_ratio, 2)

    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO meter_readings
                (meter_id, period, address, month_period,
                 kwh, actual_kwh, prev_actual_reading, curr_actual_reading,
                 prev_reading_date, prev_reading, curr_reading_date, curr_reading,
                 synced_at, data_source, transformer_ratio_snapshot)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), 'manual',
                    (SELECT transformer_ratio FROM meters WHERE id = %s))
            ON CONFLICT (meter_id, period)
            DO UPDATE SET
                kwh = EXCLUDED.kwh,
                actual_kwh = EXCLUDED.actual_kwh,
                prev_actual_reading = EXCLUDED.prev_actual_reading,
                curr_actual_reading = EXCLUDED.curr_actual_reading,
                prev_reading_date = EXCLUDED.prev_reading_date,
                prev_reading = EXCLUDED.prev_reading,
                curr_reading_date = EXCLUDED.curr_reading_date,
                curr_reading = EXCLUDED.curr_reading,
                synced_at = NOW()
        """, (meter_id, month_period, address, month_period,
              kwh, actual_kwh, prev_actual_reading, curr_actual_reading,
              prev_reading_date, prev_reading, curr_reading_date, curr_reading, meter_id))
        conn.commit()
        return {
            "ok": True,
            "address": address,
            "monthPeriod": month_period,
            "kwh": kwh,
            "actualKwh": actual_kwh,
            "prevActualReading": prev_actual_reading,
            "currActualReading": curr_actual_reading,
            "prevReadingDate": prev_reading_date,
            "prevReading": prev_reading,
            "currReadingDate": curr_reading_date,
            "currReading": curr_reading,
        }
    finally:
        cur.close()
        conn.close()


# ─── 共享电表品牌分摊（「所有品牌共用此电表」按品牌录入应收电费）────────────
#
# 口径（用户 2026-09 确认）：
#   录入值 = 品牌方付给我方的电费（收款/收入，含税）
#   用电量 = 录入金额 ÷ 单价；单价默认取该品牌方合同单价，可在表单里人工覆盖
#   付款给场地方 = 倒推出的用电量 × 场地合同单价（口径不变）
# 某表某月没有任何分摊行时，台账仍按原口径（读数 × 合同单价）整场地出一行。

def _price_info(unit_price, fallback_info):
    """单价与税信息：表单覆盖单价优先，其次合同单价"""
    price = unit_price if unit_price is not None else (fallback_info or {}).get("price")
    tax_rate = (fallback_info or {}).get("tax_rate", 0.01)
    tax_enabled = bool((fallback_info or {}).get("tax_enabled"))
    return price, tax_rate, tax_enabled


@router.get("/shared-allocations")
async def get_shared_allocations(request: Request = None, meterNo: str = None, monthPeriod: str = None):
    """共享电表品牌分摊录入表单数据：电表信息 + 候选品牌（带合同单价）+ 已录入分摊

    非共享电表也会返回（isShared=false），前端据此决定是否展示分摊录入区。
    """
    if not meterNo:
        raise HTTPException(400, "meterNo 必填")
    month_period = to_compact(monthPeriod) or ""

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT m.id, m.meter_no, m.meter_name, m.brand_id, m.landlord_id, m.entity_id,
                   m.tag, m.category_code, m.is_shared, m.transformer_ratio, m.device_address,
                   l.name AS landlord_name, b.name AS brand_name
            FROM meters m
            LEFT JOIN landlords l ON m.landlord_id = l.id
            LEFT JOIN brands b ON m.brand_id = b.id
            WHERE m.meter_no = %s OR m.device_address = %s
            ORDER BY (m.meter_no = %s) DESC NULLS LAST, m.id
            LIMIT 1
        """, (meterNo, meterNo, meterNo))
        meter = cur.fetchone()
        if not meter:
            raise HTTPException(404, "电表不存在")
        if request is not None:
            ensure_meter_in_scope(request, meter.get("tag"), meter.get("landlord_id"), hide=True)

        contracts = []
        if meter.get("landlord_id"):
            cur.execute("SELECT * FROM contracts WHERE landlord_id = %s", (meter["landlord_id"],))
            contracts = cur.fetchall()

        cur.execute("SELECT id, name FROM brands ORDER BY name")
        all_brands = [{"brandId": r["id"], "brandName": r["name"]} for r in cur.fetchall()]
        brand_names = {b["brandId"]: b["brandName"] for b in all_brands}
        cur.execute("SELECT id, name, short_name FROM entities ORDER BY id")
        all_entities = [{"entityId": r["id"], "entityName": r["short_name"] or r["name"],
                         "entityFullName": r["name"]} for r in cur.fetchall()]
    finally:
        cur.close()
        conn.close()

    pricing = resolve_prices(contracts, month_period)
    # 候选品牌：该场地方已签品牌方合同的品牌（默认单价 = 合同单价）
    candidates = []
    for bid, info in sorted(pricing["brand_prices"].items(), key=lambda kv: brand_names.get(kv[0], "")):
        candidates.append({
            "brandId": bid,
            "brandName": brand_names.get(bid, f"品牌{bid}"),
            "unitPrice": info.get("price"),
            "taxRate": info.get("tax_rate", 0.01),
            "taxEnabled": bool(info.get("tax_enabled")),
            "hasContract": True,
        })

    saved = shared_allocation_repo.list_allocations(address=meterNo, month_period=month_period) if month_period else []
    allocations = []
    for r in saved:
        fallback = pricing["brand_price_options"].get(int(r["brand_id"]), [])
        fallback = fallback[0] if fallback else None
        price, tax_rate, tax_enabled = _price_info(r.get("unit_price"), fallback)
        # ★应收电费可为 NULL（该品牌本月未计电费、只录了柜数/主体）→ 回填为空，不能显示成 0
        amount = float(r["collect_amount"]) if r.get("collect_amount") is not None else None
        if amount is None:
            net, kwh = None, None
        else:
            _, net = split_tax(amount, tax_rate) if tax_enabled else (0, amount)
            kwh = _shared_kwh(amount, price)
        entity_id = r.get("entity_id")
        allocations.append({
            "brandId": r["brand_id"],
            "brandName": r.get("brand_name") or brand_names.get(r["brand_id"], ""),
            "collectAmount": round(amount, 2) if amount is not None else None,
            "unitPrice": float(r["unit_price"]) if r.get("unit_price") is not None else None,
            "effectiveUnitPrice": float(price) if price is not None else None,
            "taxRate": tax_rate,
            "taxEnabled": tax_enabled,
            "kwh": kwh,
            "collectNet": round(net, 2) if net is not None else None,
            "cabinetCount": int(r["cabinet_count"]) if r.get("cabinet_count") is not None else None,
            "entityId": int(entity_id) if entity_id is not None else None,
            "entityName": r.get("entity_name"),
            "remark": r.get("remark"),
        })

    # 电柜数量默认值：该品牌最近一次填写值（逐月可调整；本月留空则沿用）
    cabinet_defaults = shared_allocation_repo.latest_cabinet_counts(meterNo, before_period=month_period or None)

    # ★V5：品牌绑定清单（该月这块共享表**应当**由哪几个品牌共享）+ 漏录检查
    #   绑定是「动态月度、默认继承上月」的：start_period<=本月 且 (end 为空 or end>=本月)
    bindings = []
    missing_brands = []
    if month_period and meter.get("is_shared"):
        bound = shared_allocation_repo.bound_brands(meter["id"], month_period)
        saved_ids = {int(r["brand_id"]) for r in saved}
        for b in bound:
            bid = int(b["brand_id"])
            bname = b.get("brand_name") or brand_names.get(bid, f"品牌{bid}")
            bindings.append({
                "brandId": bid,
                "brandName": bname,
                "startPeriod": b.get("start_period"),
                "endPeriod": b.get("end_period"),
                "hasAllocation": bid in saved_ids,
            })
            # 已绑定但本月没录分摊 ⇒ 告警（不自动补，交由财务核对）
            if bid not in saved_ids:
                missing_brands.append({"brandId": bid, "brandName": bname})

    return {
        "monthPeriod": month_period,
        "displayPeriod": to_display(month_period) if month_period else "",
        "meter": meter,
        # ★V5：是否共用**读表级 is_shared 列**，不再由「大类=共享电表」推导（那是滇池写错的根源）
        "isShared": bool(meter.get("is_shared")),
        "payPrice": pricing.get("pay_price"),
        "sharedPrice": (pricing.get("shared_price") or {}).get("price"),
        "brands": candidates,
        "allBrands": all_brands,
        "allEntities": all_entities,
        # 默认报税主体 = 整场地口径：该共享电表自身的主体（未指定主体时展示为「未指定」）
        "defaultEntityId": meter.get("entity_id"),
        "allocations": allocations,
        # ★V5：这块共享表的「品牌绑定清单」——该月**应当**由哪些品牌共享（动态月度、继承上月）
        "bindings": bindings,
        # 已绑定但**本月还没录分摊**的品牌（漏录 ⇒ 页面告警，不自动补）
        "missingBrands": missing_brands,
        "periods": shared_allocation_repo.list_periods_for_meter(meterNo),
        # {"<brandId>": {"count": 12, "monthPeriod": "202608"}}
        "cabinetDefaults": {str(bid): info for bid, info in cabinet_defaults.items()},
    }


@router.get("/shared-cabinet-usage")
async def get_shared_cabinet_usage(request: Request = None, landlordId: int = None, period: str = None):
    """共享电表柜数明细（供合同页按「场地 → 品牌」取计费柜数）。

    共享电表下各品牌没有自己的电表，「数电表」数不到它们的柜数，只能取分摊行人工录入值。
    period 为空时按「最近一次填写值」取值（合同列表无月份维度）。
    """
    allowed = scope_landlord_ids(request) if request is not None else None
    items = shared_allocation_repo.shared_meter_cabinets(
        landlord_id=landlordId, period=to_compact(period) or None
    )
    if allowed is not None:
        items = [it for it in items if it.get("landlordId") in set(allowed)]
    return {"period": to_compact(period) or None, "meters": items}


@router.post("/shared-allocations")
async def save_shared_allocations(data: dict, request: Request = None):
    """整体保存某共享电表某月的品牌分摊（应收电费），并按新分摊重算该月台账。

    入参：{ address, monthPeriod, rows: [{ brandId, collectAmount, unitPrice?, cabinetCount?, entityId?, remark? }] }
    rows 为空数组 = 清空该月分摊（台账退回「读数 × 合同单价」口径）。
    cabinetCount = 该品牌当月在该表下投放的电柜数量（逐月可调，可空）。
    entityId = 该品牌电柜的报税公司主体；留空 = 默认（整场地口径，取共享电表自身主体）。
    """
    address = data.get("address")
    month_period = to_compact(data.get("monthPeriod"))
    if not address or not month_period:
        raise HTTPException(400, "address 和 monthPeriod 必填")
    if len(str(month_period)) != 6 or not str(month_period).isdigit():
        raise HTTPException(400, f"月份格式应为 YYYYMM，收到：{month_period}")

    raw_rows = data.get("rows") or []
    seen, rows = set(), []
    for r in raw_rows:
        brand_id = r.get("brandId")
        if not brand_id:
            raise HTTPException(400, "每一行都必须选择品牌方")
        brand_id = int(brand_id)
        if brand_id in seen:
            raise HTTPException(400, f"品牌方重复：{brand_id}（同一电表同一月一个品牌只能一行）")
        seen.add(brand_id)

        # ★应收电费：留空 = 本月该品牌不计电费（存 NULL）。
        #   ⚠️ 不能因为「金额为空」就把整行丢掉 —— 共享表的**柜数**独立于电费：
        #   财务常只录柜数（该品牌本月没有应收电费），旧逻辑会把它静默丢弃，
        #   导致合同页「计费柜数」永远是 0（本次修复的 bug）。
        amount_raw = r.get("collectAmount")
        amount = None
        if amount_raw is not None and str(amount_raw).strip() not in ("", "null", "None"):
            try:
                amount = round(float(amount_raw), 2)
            except (TypeError, ValueError):
                raise HTTPException(400, f"应收电费格式无效：{amount_raw}")
            if amount < 0:
                raise HTTPException(400, "应收电费不能为负数")

        unit_price = r.get("unitPrice")
        if unit_price is not None and str(unit_price).strip() != "":
            try:
                unit_price = float(unit_price)
            except (TypeError, ValueError):
                raise HTTPException(400, f"单价格式无效：{unit_price}")
            if unit_price <= 0:
                raise HTTPException(400, "单价必须大于 0（否则无法倒推用电量）")
        else:
            unit_price = None

        # 电柜数量：逐月可动态调整；留空 = 未填（NULL），前端会默认沿用最近一次填写值
        cabinet_count = r.get("cabinetCount")
        if cabinet_count is not None and str(cabinet_count).strip() != "":
            try:
                cabinet_count = int(float(str(cabinet_count).strip()))
            except (TypeError, ValueError):
                raise HTTPException(400, f"电柜数量格式无效：{cabinet_count}")
            if cabinet_count <= 0:
                raise HTTPException(400, "电柜数量必须大于 0（留空表示本月未填）")
        else:
            cabinet_count = None

        # 报税主体：留空 = 默认（整场地口径，取共享电表自身主体）；填了则只改该品牌
        entity_id = r.get("entityId")
        if entity_id is not None and str(entity_id).strip() not in ("", "null"):
            try:
                entity_id = int(float(str(entity_id).strip()))
            except (TypeError, ValueError):
                raise HTTPException(400, f"报税主体格式无效：{entity_id}")
        else:
            entity_id = None

        # 应收电费 / 柜数 / 报税主体 三项全空 = 空行，不保存
        if amount is None and cabinet_count is None and entity_id is None:
            continue

        rows.append({
            "brandId": brand_id,
            "entityId": entity_id,
            "collectAmount": amount,
            "unitPrice": unit_price,
            "cabinetCount": cabinet_count,
            "remark": r.get("remark"),
        })

    # 权限校验：只允许写范围内电表的分摊
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            """
            SELECT id, tag, category_code, is_shared, landlord_id, brand_id
            FROM meters
            WHERE meter_no = %s OR device_address = %s
            ORDER BY (meter_no = %s) DESC NULLS LAST, id
            LIMIT 1
            """,
            (address, address, address),
        )
        meter = cur.fetchone()
    finally:
        cur.close()
        conn.close()
    if not meter:
        raise HTTPException(404, "电表不存在")
    if request is not None:
        ensure_meter_in_scope(request, meter.get("tag"), meter.get("landlord_id"))
    # 台账按「场地 × 品牌 × 主体」生成，电表没有场地方则分摊无法落到台账上
    if not meter.get("landlord_id"):
        raise HTTPException(400, "该电表未关联场地方，无法生成电费台账；请先在电表档案里设置场地方")
    # 只有「所有品牌共用此电表」（表级 is_shared=TRUE）才谈得上按品牌分摊
    # ★V5：判定读 is_shared 列，与「电表大类」彻底解耦
    if not meter.get("is_shared"):
        raise HTTPException(400, "只有「所有品牌共用此电表」的电表才能按品牌录入分摊（请在电表档案里打开该开关）")

    try:
        saved = shared_allocation_repo.replace_allocations(address, month_period, rows)
    except ValueError as e:
        raise HTTPException(400, str(e))

    # 台账联动：分摊变了 → 该月台账需按新分摊重算（失败不影响保存结果）
    regenerated = None
    try:
        from .electricity import generate_electricity
        regenerated = await generate_electricity({"period": month_period})
    except Exception as e:
        regenerated = {"error": str(e)}

    return {
        "ok": True,
        "address": address,
        "monthPeriod": month_period,
        "saved": saved,
        # 只累加有应收电费的行（可能有无金额、只录柜数的行 → None 不能直接相加）
        "totalAmount": round(sum(float(r["collectAmount"]) for r in rows if r.get("collectAmount") is not None), 2),
        "regenerated": regenerated,
    }


@router.get("/sync-logs")
async def get_sync_logs(limit: int = 20):
    """获取同步日志"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT * FROM sync_logs
            ORDER BY started_at DESC
            LIMIT %s
        """, (limit,))
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


@router.post("/sync")
async def trigger_sync(type: str):
    """手动触发同步

    type: devices | collectors | status | hourly | daily | monthly | yearly | full
    """
    from ..jobs.sync_meters import (
        sync_devices, sync_collectors, sync_status,
        sync_hourly_data, sync_daily_data, sync_monthly_data, sync_yearly_data,
        full_sync,
    )

    sync_map = {
        "devices": sync_devices,
        "collectors": sync_collectors,
        "status": sync_status,
        "hourly": sync_hourly_data,
        "daily": sync_daily_data,
        "monthly": sync_monthly_data,
        "yearly": sync_yearly_data,
        "full": full_sync,
    }

    fn = sync_map.get(type)
    if not fn:
        raise HTTPException(400, f"未知同步类型: {type}，可选: {', '.join(sync_map.keys())}")

    result = await fn()
    return {"ok": True, "type": type, "result": result}
