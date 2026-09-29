from fastapi import APIRouter, HTTPException, Request
from ..repositories import electricity_repo, shared_allocation_repo
from ..domain.electricity_calc import calc_electricity
from ..domain.electricity_pricing import split_tax
from ..infra.auth_scope import scope_landlord_ids, ensure_meter_in_scope
from ..infra.period import to_compact
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/electricity", tags=["电费台账"], default_response_class=CamelJSONResponse)


def compute_landlord_ledger(cur, landlord_id: int, period: str):
    """单场地台账计算（v3：按场地方查该场地所有实表，按 meter_readings 读数 × 合同单价自动计算）。

    Returns:
        (meter_details, totals) 与 generate 的明细/合计结构一致。
    """
    from ..domain.electricity_pricing import resolve_prices, brand_collect_price, brand_price_for

    cur.execute("""
        SELECT m.id, m.meter_no, m.brand_id, m.entity_id, m.transformer_ratio,
               b.name as brand_name
        FROM meters m
        LEFT JOIN brands b ON m.brand_id = b.id
        WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
          AND (m.brand_id IS NOT NULL OR m.is_shared = TRUE)
        ORDER BY m.id
    """, (landlord_id,))
    meters = cur.fetchall()

    meter_nos = [m["meter_no"] for m in meters if m.get("meter_no")]
    readings = {}
    if meter_nos:
        placeholders = ",".join(["%s"] * len(meter_nos))
        cur.execute(
            f"SELECT address, kwh, actual_kwh FROM meter_readings WHERE month_period = %s AND address IN ({placeholders})",
            (period, *meter_nos),
        )
        for r in cur.fetchall():
            readings[r["address"]] = {"kwh": r["kwh"], "actual": r["actual_kwh"]}

    # 场地合同（与 generate 同一条匹配链路；v3：contracts 直接挂 landlord_id）
    cur.execute("""
        SELECT c.*, l.name as landlord_name
        FROM contracts c
        LEFT JOIN landlords l ON c.landlord_id = l.id
        WHERE c.landlord_id = %s
    """, (landlord_id,))
    contracts = cur.fetchall()

    pricing = resolve_prices(contracts)
    pay_price = pricing["pay_price"]

    meter_details = []
    total_pay_kwh = 0.0
    total_collect_kwh = 0.0
    for m in meters:
        row = readings.get(m["meter_no"]) or {}
        kwh = float(row.get("kwh") or 0)
        if row.get("actual") is not None:
            actual_kwh = round(float(row["actual"]), 2)
        else:
            actual_kwh = round(kwh * float(m.get("transformer_ratio") or 1), 2)
        total_pay_kwh += actual_kwh
        total_collect_kwh += actual_kwh

        # 收款单价（v3.2 主体感知）：按电表品牌+主体匹配拆签合同；共享电表（无品牌）取「全品牌合同」单价，无合同 → 收入为 0
        brand_info = brand_price_for(pricing, m.get("brand_id"), m.get("entity_id")) if m.get("brand_id") else pricing.get("shared_price")
        brand_price = brand_info["price"] if brand_info else None
        # 税费仅在启用税率且合同有税率时按「收入×税率」扣（税费 = 含税收入 × 税率）
        detail_rate = brand_info["tax_rate"] if (brand_info and brand_info.get("tax_enabled")) else None

        pay_amount = round(actual_kwh * float(pay_price or 0), 2) if pay_price else 0
        collect_amount = round(actual_kwh * float(brand_price or 0), 2) if brand_price else 0
        # 统一税费口径：税费 = 含税收入 × 税率；不含税 = 收入 − 税费
        _, collect_net = split_tax(collect_amount, detail_rate)

        meter_details.append({
            "meterId": m["id"],
            "meterNo": m["meter_no"],
            "brandId": m.get("brand_id"),
            "brandName": m.get("brand_name"),
            "kwh": actual_kwh,
            "payUnitPrice": float(pay_price or 0),
            "payAmount": pay_amount,
            "collectUnitPrice": float(brand_price or 0),
            "collectAmount": collect_amount,
            "collectNet": collect_net,
        })

    totals = {
        "payKwh": round(total_pay_kwh, 2),
        "collectKwh": round(total_collect_kwh, 2),
        "payAmount": round(sum(d["payAmount"] for d in meter_details), 2),
        "collectAmount": round(sum(d["collectAmount"] for d in meter_details), 2),
        "collectNet": round(sum(d["collectNet"] for d in meter_details), 2),
    }
    totals["profit"] = round(totals["collectNet"] - totals["payAmount"], 2)
    # 表头展示用代表单价：付款=场地合同唯一单价；收款=第一台电表（列表首位）的品牌单价
    first_meter = meters[0] if meters else None
    record_collect_price = brand_collect_price(first_meter.get("brand_id"), pricing) if first_meter else None
    return meter_details, totals, (pay_price or 0), (record_collect_price or 0)


@router.get("")
async def list_electricity(request: Request, landlordId: int = None, period: str = None):
    records = electricity_repo.list_records(landlord_id=landlordId, period=period)
    # 股东：只能看到关联场地的电费台账
    allowed = scope_landlord_ids(request)
    if allowed is not None:
        records = [r for r in records if r.get("landlord_id") in allowed]
    result = []
    for r in records:
        details = electricity_repo.get_meter_details(r["id"])
        result.append({**r, "meterDetails": details})
    return result


@router.get("/periods")
async def list_periods():
    return electricity_repo.list_periods()


@router.put("/{record_id}/status")
async def update_electricity_status(record_id: int, data: dict):
    """只更新付款/收款状态（点击状态徽章编辑；不影响金额与 data_source 标记）"""
    pay = data.get("payStatus")
    collect = data.get("collectStatus")
    if pay is None and collect is None:
        raise HTTPException(400, "无状态更新")
    if pay is not None and pay not in ("未付款", "已付款"):
        raise HTTPException(400, f"付款状态无效: {pay}")
    if collect is not None and collect not in ("未到账", "已到账"):
        raise HTTPException(400, f"收款状态无效: {collect}")
    result = electricity_repo.update_status(record_id, pay, collect)
    if not result:
        raise HTTPException(404, "电费记录不存在")
    return result


@router.get("/reading-detail")
async def reading_detail(request: Request, meterNo: str, period: str):
    """单块电表的抄表核对信息（上月/本月抄表读数与日期、区间度数、台账费用），
    供发给场地方/品牌方老板核对。"""
    from ..infra.database import get_connection, get_dict_cursor
    period = to_compact(period)
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 电表信息
        cur.execute("""
            SELECT m.id, m.meter_no, m.meter_name, m.transformer_ratio, m.tag,
                   b.name AS brand_name, l.name AS landlord_name
            FROM meters m
            LEFT JOIN brands b ON m.brand_id = b.id
            LEFT JOIN landlords l ON m.landlord_id = l.id
            WHERE m.meter_no = %s
        """, (meterNo,))
        meter = cur.fetchone()
        if not meter:
            raise HTTPException(404, "电表不存在")
        # 电表类型范围：受限账号只能看范围内电表的抄表信息
        ensure_meter_in_scope(request, meter.get("tag"), meter.get("landlord_id"), hide=True)

        # 抄表链（当期行自带 上月读数/日期 → 本月读数/日期 → 区间度数）
        cur.execute("""
            SELECT month_period, kwh, actual_kwh, prev_reading_date, prev_reading,
                   curr_reading_date, curr_reading, prev_actual_reading, curr_actual_reading,
                   synced_at
            FROM meter_readings
            WHERE address = %s AND month_period = %s
        """, (meterNo, period))
        reading = cur.fetchone()

        # 上一个月的用量（供对比）
        prev_period = str(int(period) - 1) if period[4:6] != "01" else f"{int(period[:4]) - 1}12"
        cur.execute("""
            SELECT month_period, kwh FROM meter_readings
            WHERE address = %s AND month_period = %s
        """, (meterNo, prev_period))
        prev_row = cur.fetchone()

        # 该表当期台账费用（场地×品牌×月的记录中本表明细）
        # 共享电表按品牌分摊后，同一块表在同一月会有多条明细（每个品牌一条），全部返回。
        cur.execute("""
            SELECT e.pay_unit_price, e.pay_amount, e.pay_status,
                   e.collect_unit_price, e.collect_amount, e.collect_net, e.collect_status,
                   d.kwh AS ledger_kwh, e.data_source,
                   COALESCE(e.brand_id, m.brand_id) AS brand_id, b.name AS brand_name
            FROM electricity_meter_details d
            JOIN electricity_records e ON e.id = d.electricity_id
            JOIN meters m ON d.meter_id = m.id
            LEFT JOIN brands b ON COALESCE(e.brand_id, m.brand_id) = b.id
            WHERE d.meter_id = %s AND e.period = %s
            ORDER BY b.name
        """, (meter["id"], period))
        ledger_rows = cur.fetchall()
        ledger = ledger_rows[0] if ledger_rows else None

        # 品牌分摊录入（共享电表）：核对时可直接看到各品牌录入的应收电费与倒推电量
        cur.execute("""
            SELECT a.brand_id, b.name AS brand_name, a.collect_amount, a.unit_price, a.remark
            FROM meter_shared_allocations a
            LEFT JOIN brands b ON a.brand_id = b.id
            WHERE a.address = %s AND a.month_period = %s
            ORDER BY b.name
        """, (meterNo, period))
        allocations = cur.fetchall()

        return {
            "meter": meter,
            "reading": reading,
            "prevMonth": prev_row,
            "ledger": ledger,
            "ledgerRows": ledger_rows,
            "allocations": allocations,
        }
    finally:
        cur.close()
        conn.close()


@router.get("/{record_id:int}")
async def get_electricity(record_id: int, request: Request):
    record = electricity_repo.get_record(record_id)
    if not record:
        raise HTTPException(404, "电费记录不存在")
    allowed = scope_landlord_ids(request)
    if allowed is not None and (record.get("landlord_id") not in allowed):
        raise HTTPException(403, "无权查看该电费记录")
    details = electricity_repo.get_meter_details(record_id)
    return {**record, "meterDetails": details}


@router.post("", status_code=201)
async def create_electricity(data: dict):
    landlord_id = data.get("landlordId")
    brand_id = data.get("brandId")
    period = to_compact(data.get("period"))

    if not landlord_id or not period:
        raise HTTPException(400, "landlordId 和 period 必填")
    landlord_id = int(landlord_id)
    if landlord_id <= 0:
        raise HTTPException(400, "请选择场地方")

    # 主体归属：显式指定优先；未指定时取该场地×品牌下电表的主体众数（与自动生成同源）
    entity_id = data.get("entityId")
    if entity_id is not None:
        entity_id = int(entity_id)
    else:
        from ..infra.database import get_connection, get_dict_cursor
        _conn = get_connection()
        _cur = get_dict_cursor(_conn)
        try:
            brand_cond = "brand_id IS NULL" if brand_id is None else "brand_id = %s"
            brand_vals = [] if brand_id is None else [brand_id]
            _cur.execute(f"""
                SELECT m.entity_id FROM meters m
                WHERE m.landlord_id = %s AND {brand_cond} AND m.entity_id IS NOT NULL
                GROUP BY m.entity_id ORDER BY COUNT(*) DESC, m.entity_id LIMIT 1
            """, (landlord_id, *brand_vals))
            _row = _cur.fetchone()
            entity_id = _row["entity_id"] if _row else None
        finally:
            _cur.close()
            _conn.close()

    # period 统一为 6 位 YYYYMM（与 generate / meter_readings 一致）
    existing = electricity_repo.get_record_by_landlord_brand_period(landlord_id, brand_id, period, entity_id)
    if existing:
        raise HTTPException(400, f"该场地该主体 {period} 的电费记录已存在")

    # 明细来源（按优先级）：
    #   1) 显式 meterDetails → 按明细计算；
    #   2) 手工填写了度数/金额 → 以提交值为准，缺失金额按 度数×单价 推算；
    #   3) 空表单 → 按该场地该月 meter_readings × 合同单价自动计算（#2 口径）。
    meter_details = data.get("meterDetails", [])
    detail_rows = []
    if meter_details:
        pay_price = float(data.get("payUnitPrice", 0))
        collect_price = float(data.get("collectUnitPrice", 0))
        tax_rate = float(data.get("taxRate", 0.01))
        calc = calc_electricity(meter_details, pay_price, collect_price, tax_rate)
        detail_rows = calc["details"]
        record_pay_price = pay_price
        record_collect_price = collect_price
        record_tax_rate = tax_rate
    elif any(data.get(k) is not None for k in ("payKwh", "collectKwh", "payAmount", "collectAmount")):
        pay_kwh = float(data.get("payKwh") or 0)
        collect_kwh = float(data.get("collectKwh") or 0)
        pay_price = float(data.get("payUnitPrice") or 0)
        collect_price = float(data.get("collectUnitPrice") or 0)
        tax_rate = float(data.get("taxRate") or 0.01)
        pay_amount = float(data["payAmount"]) if data.get("payAmount") is not None else round(pay_kwh * pay_price, 2)
        collect_amount = float(data["collectAmount"]) if data.get("collectAmount") is not None else round(collect_kwh * collect_price, 2)
        collect_net = float(data["collectNet"]) if data.get("collectNet") is not None else (
            split_tax(collect_amount, tax_rate)[1]
        )
        calc = {
            "payKwh": round(pay_kwh, 2),
            "collectKwh": round(collect_kwh, 2),
            "payAmount": round(pay_amount, 2),
            "collectAmount": round(collect_amount, 2),
            "collectNet": round(collect_net, 2),
            "profit": round(collect_net - pay_amount, 2),
        }
        record_pay_price = pay_price
        record_collect_price = collect_price
        record_tax_rate = tax_rate
    else:
        from ..infra.database import get_connection, get_dict_cursor
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            detail_rows, calc, record_pay_price, record_collect_price = compute_landlord_ledger(cur, landlord_id, period)
        finally:
            cur.close()
            conn.close()
        record_tax_rate = float(data.get("taxRate") or 0.01)

    # 创建记录
    record = electricity_repo.create_record({
        "landlordId": landlord_id,
        "brandId": brand_id,
        "entityId": entity_id,
        "period": period,
        "payStartDate": data.get("payStartDate"),
        "payStartReading": sum(d.get("startReading", 0) for d in meter_details) or None,
        "payEndDate": data.get("payEndDate"),
        "payEndReading": sum(d.get("endReading", 0) for d in meter_details) or None,
        "payKwh": calc["payKwh"],
        "payUnitPrice": record_pay_price,
        "payAmount": calc["payAmount"],
        "payStatus": data.get("payStatus", "未付款"),
        "collectStartDate": data.get("collectStartDate"),
        "collectStartReading": sum(d.get("startReading", 0) for d in meter_details) or None,
        "collectEndDate": data.get("collectEndDate"),
        "collectEndReading": sum(d.get("endReading", 0) for d in meter_details) or None,
        "collectKwh": calc["collectKwh"],
        "collectUnitPrice": record_collect_price,
        "collectAmount": calc["collectAmount"],
        "taxRate": record_tax_rate,
        "collectNet": calc["collectNet"],
        "collectStatus": data.get("collectStatus", "未到账"),
        "profit": calc["profit"],
        "remark": data.get("remark"),
    })

    # 保存电表明细
    for d in detail_rows:
        electricity_repo.create_meter_detail(record["id"], d["meterId"], d)

    # 分红联动：电费台账是分红收入/成本的输入，重算该场地该月的分红记录（失败不影响保存）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        refresh_dividend_records(landlord_id, [period])
    except Exception:
        pass

    return record


@router.put("/{record_id:int}")
async def update_electricity(record_id: int, data: dict):
    record = electricity_repo.get_record(record_id)
    if not record:
        raise HTTPException(404, "电费记录不存在")

    # period 统一为 6 位（避免手工编辑时把 6 位改成 7 位产生重复）
    if data.get("period"):
        data["period"] = to_compact(data["period"])

    # 人工编辑 → 数据来源标记为 manual（重新生成台账会置回 auto）
    data["dataSource"] = "manual"

    # 如果有新的电表读数，重新计算
    if "meterDetails" in data and data["meterDetails"]:
        meter_details = data["meterDetails"]
        pay_price = float(data.get("payUnitPrice", record.get("pay_unit_price", 0)))
        collect_price = float(data.get("collectUnitPrice", record.get("collect_unit_price", 0)))
        tax_rate = float(data.get("taxRate", record.get("tax_rate", 0.01)))

        calc = calc_electricity(meter_details, pay_price, collect_price, tax_rate)

        data["payKwh"] = calc["payKwh"]
        data["payAmount"] = calc["payAmount"]
        data["collectKwh"] = calc["collectKwh"]
        data["collectAmount"] = calc["collectAmount"]
        data["collectNet"] = calc["collectNet"]
        data["profit"] = calc["profit"]

        # 更新电表明细
        electricity_repo.delete_meter_details(record_id)
        for d in calc["details"]:
            electricity_repo.create_meter_detail(record_id, d["meterId"], d)
    else:
        # 无明细的手工编辑：若改了度数/单价，派生金额按提交值推算，避免金额与度数脱节
        submitted_kwh = data.get("payKwh") is not None or data.get("collectKwh") is not None
        submitted_price = data.get("payUnitPrice") is not None or data.get("collectUnitPrice") is not None
        if submitted_kwh or submitted_price:
            pay_kwh = float(data.get("payKwh", record.get("pay_kwh") or 0))
            collect_kwh = float(data.get("collectKwh", record.get("collect_kwh") or 0))
            pay_price = float(data.get("payUnitPrice", record.get("pay_unit_price") or 0))
            collect_price = float(data.get("collectUnitPrice", record.get("collect_unit_price") or 0))
            tax_rate = float(data.get("taxRate", record.get("tax_rate") or 0.01))
            # 显式赋值（表单空字段是 null，update_record 会跳过 null，需先补齐派生金额）
            if data.get("payAmount") is None:
                data["payAmount"] = round(pay_kwh * pay_price, 2)
            if data.get("collectAmount") is None:
                data["collectAmount"] = round(collect_kwh * collect_price, 2)
            if data.get("collectNet") is None:
                data["collectNet"] = split_tax(float(data["collectAmount"]), tax_rate)[1]
            data["profit"] = round(float(data["collectNet"]) - float(data["payAmount"]), 2)

    result = electricity_repo.update_record(record_id, data)
    if not result:
        raise HTTPException(400, "无更新内容")
    # 分红联动：重算新旧「场地×月份」的分红记录（period/场地可能被修改）（失败不影响保存）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        seen = set()
        for lid, p in [(record.get("landlord_id"), record.get("period")),
                       (result.get("landlord_id"), result.get("period"))]:
            key = (lid, p)
            if lid and p and key not in seen:
                seen.add(key)
                refresh_dividend_records(lid, [p])
    except Exception:
        pass
    return result


@router.delete("/{record_id:int}")
async def delete_electricity(record_id: int):
    record = electricity_repo.get_record(record_id)
    electricity_repo.delete_record(record_id)
    # 分红联动：重算被删记录的「场地×月份」分红记录（失败不影响删除）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        if record and record.get("landlord_id") and record.get("period"):
            refresh_dividend_records(record["landlord_id"], [record["period"]])
    except Exception:
        pass
    return {"ok": True}


def _alloc_unit_price(pricing: dict, alloc: dict, meter_entity_id=None):
    """共享电表分摊行的有效收款单价：表单人工覆盖优先，其次该品牌（按分摊行主体匹配）合同单价。

    Returns: (price, brand_info)
    """
    from ..domain.electricity_pricing import brand_price_for
    entity_id = alloc.get("entity_id") or meter_entity_id
    info = brand_price_for(pricing, alloc.get("brand_id"), entity_id)
    price = alloc.get("unit_price")
    if price is None:
        price = info["price"] if info else None
    return price, info


def _shared_full_kwh(readings: dict, meter: dict) -> float:
    """共享电表「整表实际用电量」：人工补录的 actual_kwh 优先，否则 原始表码 × 互感器倍数。

    这是付给场地方的结算电量口径（品牌倒推合计与它的差额即亏空/线损，由我方承担）。
    """
    row = readings.get(meter["meter_no"]) or {}
    if row.get("actual") is not None:
        return round(float(row["actual"]), 2)
    return round(float(row.get("kwh") or 0) * float(meter.get("transformer_ratio") or 1), 2)


@router.post("/generate")
async def generate_electricity(data: dict):
    """从 meter_readings + contracts 自动生成电费台账（v3.1：按 场地×品牌×主体 全量生成）

    主体归属：按电表的 meters.entity_id（一表一主体）；
    共享电表可按品牌分摊行指定报税主体（alloc.entity_id），未指定才退回电表主体。
    同场地同品牌下不同主体的电表拆成多行台账，各行只含本主体电表的明细。

    共享电表付款口径（2026-09）：付场地方 = **整表读数 × 场地单价**；
    品牌倒推电量合计与整表读数的差额（亏空/线损）由我方承担，按各品牌用电量比例分摊进
    各品牌明细的付款金额（收款金额不受影响）。
    """
    period = data.get("period")
    if not period:
        raise HTTPException(400, "period 必填")
    # 统一 period 为 6 位 YYYYMM（与 meter_readings / electricity_records 一致）
    period = str(period).replace("-", "")

    # ★V5：先刷新该月柜数快照（加柜本月生效/减柜下月生效；manual 行不覆盖）——
    # 场租/分红/合同页按月读柜数都依赖它。失败不阻断台账生成。
    try:
        from ..domain.cabinet_snapshot import refresh_cabinet_snapshots
        refresh_cabinet_snapshots(period)
    except Exception as _e:
        print(f"⚠️ 柜数快照刷新失败（period={period}）: {_e}")

    from ..infra.database import get_connection, get_dict_cursor

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 1. 实表电表（v3：直挂 场地+品牌+主体，无站点层）
        #    ★V5：民用电表（无品牌且非共用）也纳入 —— 它们的电费是真实成本，
        #    生成独立的 row_type='civil' 行（只有付款侧，无收款对象）。
        #    若不纳入，其耗电会被场地级「差额行」吞掉，损耗虚高。
        cur.execute("""
            SELECT m.id, m.meter_no, m.landlord_id, m.brand_id, m.entity_id, m.transformer_ratio,
                   m.is_shared, m.category_code,
                   b.name as brand_name
            FROM meters m
            LEFT JOIN brands b ON m.brand_id = b.id
            WHERE m.landlord_id IS NOT NULL
              AND m.meter_no NOT LIKE 'TEST%'
        """)
        meters = cur.fetchall()

        # 2. 获取该月电表读数（只查相关电表）
        meter_nos = [m["meter_no"] for m in meters if m.get("meter_no")]
        if meter_nos:
            placeholders = ",".join(["%s"] * len(meter_nos))
            cur.execute(f"SELECT address, kwh, actual_kwh FROM meter_readings WHERE month_period = %s AND address IN ({placeholders})", (period, *meter_nos))
        else:
            cur.execute("SELECT address, kwh, actual_kwh FROM meter_readings WHERE month_period = %s AND 1=0", (period,))
        readings = {}
        for r in cur.fetchall():
            readings[r["address"]] = {"kwh": r["kwh"], "actual": r["actual_kwh"]}

        # 3. 获取相关合同（按电表的 landlord 集合）
        from collections import defaultdict

        landlord_ids = list(set(m["landlord_id"] for m in meters if m.get("landlord_id")))
        if landlord_ids:
            placeholders = ",".join(["%s"] * len(landlord_ids))
            cur.execute(f"""
                SELECT c.*, l.name as landlord_name
                FROM contracts c
                LEFT JOIN landlords l ON c.landlord_id = l.id
                WHERE c.landlord_id IN ({placeholders})
            """, landlord_ids)
        else:
            cur.execute("""
                SELECT c.*, l.name as landlord_name
                FROM contracts c
                LEFT JOIN landlords l ON c.landlord_id = l.id
                WHERE 1=0
            """)
        all_contracts = cur.fetchall()

        landlord_contracts_map = defaultdict(list)
        for c in all_contracts:
            if c.get("landlord_id"):
                landlord_contracts_map[c["landlord_id"]].append(c)

        # 4. 按 (场地, 品牌, 主体, 行类型) 分组电表（★V5：键加 row_type）
        #    row_type：normal=品牌行（含共用表品牌分摊）/ civil=民用电表行（只有成本）/ loss=损耗行（§5 单独写）
        #
        # 共用表（「所有品牌共用此电表」）特例：该表某月已人工录入品牌分摊时，
        # 按分摊品牌拆成多条明细（金额人工给、用电量=金额÷单价倒推），该表自身不再单独成组，
        # 避免「总表整场地一行」与「品牌明细」双算；未录分摊的月份维持原口径（读数 × 合同单价）。
        alloc_map = shared_allocation_repo.list_allocations_by_period(period)
        groups = defaultdict(list)
        for m in meters:
            allocs = alloc_map.get(m["meter_no"]) if m.get("is_shared") else None
            if allocs:
                for a in allocs:
                    # 报税主体：分摊行人工指定优先；留空 = 默认（整场地口径，取共用表自身主体）
                    groups[(m["landlord_id"], a["brand_id"], a.get("entity_id") or m["entity_id"], "normal")].append(
                        {"meter": m, "alloc": a}
                    )
            else:
                # ★V5：无品牌且非共用 = 民用电表 → 独立 civil 行（纯成本）
                rtype = "civil" if (m["brand_id"] is None and not m.get("is_shared")) else "normal"
                groups[(m["landlord_id"], m["brand_id"], m["entity_id"], rtype)].append({"meter": m, "alloc": None})

        # 共享电表「品牌倒推电量合计」（逐表）：付场地方按整表读数结算，两者差额即亏空，
        # 按各品牌用电量比例分摊进付款金额（见 _alloc_unit_price / _shared_full_kwh）。
        from ..domain.electricity_pricing import resolve_prices
        meter_by_no = {m["meter_no"]: m for m in meters}
        _pricing_cache = {}

        def _pricing_of(lid):
            if lid not in _pricing_cache:
                _pricing_cache[lid] = resolve_prices(landlord_contracts_map.get(lid, []) if lid else [])
            return _pricing_cache[lid]

        alloc_kwh_by_meter = {}
        for addr, allocs in alloc_map.items():
            m0 = meter_by_no.get(addr)
            if not m0:
                continue
            pr = _pricing_of(m0["landlord_id"])
            total_alloc_kwh = 0.0
            for a in allocs:
                price, _info = _alloc_unit_price(pr, a, m0.get("entity_id"))
                if not price:
                    continue
                total_alloc_kwh += round(float(a.get("collect_amount") or 0) / float(price), 2)
            if total_alloc_kwh > 0:
                alloc_kwh_by_meter[addr] = total_alloc_kwh

        # 预加载已有台账（★V5：键加 row_type —— 否则"损耗行"(brand/entity 都空)会与普通行撞键）
        cur.execute(
            "SELECT id, landlord_id, brand_id, entity_id, row_type FROM electricity_records WHERE period = %s",
            (period,),
        )
        existing_map = {
            (r["landlord_id"], r["brand_id"], r["entity_id"], r.get("row_type") or "normal"): r
            for r in cur.fetchall()
        }

        created = []
        updated = []
        warnings = []
        deleted = []
        # ★V5：各场地「已入台账的品牌付款电量」合计 —— 用于算差额行（见 §5）
        site_pay_kwh = defaultdict(float)

        for (lid, bid, eid, rtype), meter_list in groups.items():
            # ★V5：existing 按 (场地,品牌,主体,行类型) 四元组取 —— 民用行/普通行互不撞键
            existing = existing_map.get((lid, bid, eid, rtype))

            contracts = landlord_contracts_map.get(lid, []) if lid else []
            # 统一单价解析（#2）：付款=场地合同唯一单价；收款=按品牌匹配品牌方合同单价
            from ..domain.electricity_pricing import resolve_prices, brand_collect_price, brand_price_for
            pricing = resolve_prices(contracts)
            landlord_price = pricing["pay_price"]

            # 有品牌分摊录入的组：金额是人工确认的应付款，无对应品牌合同也照常生成
            has_alloc = any(e["alloc"] for e in meter_list)

            # 只生成有合同的场地×品牌：无场地合同 且（该品牌无品牌方合同 且 无全品牌合同）→ 不生成；有旧记录则删除
            # ★V5：民用行（civil）没有收款对象，只需【场地合同】有单价即可生成（纯成本行）
            has_site_contract = any(c.get("contract_type") == "场地合同" for c in contracts)
            has_brand_contract = (bid in pricing["brand_prices"]) if bid is not None else pricing.get("shared_price") is not None
            if rtype == "civil":
                if not has_site_contract or landlord_price is None:
                    if existing:
                        cur.execute("DELETE FROM electricity_meter_details WHERE electricity_id = %s", (existing["id"],))
                        cur.execute("DELETE FROM electricity_records WHERE id = %s", (existing["id"],))
                    continue
            elif not has_site_contract and not has_brand_contract and not has_alloc:
                if existing:
                    cur.execute("DELETE FROM electricity_meter_details WHERE electricity_id = %s", (existing["id"],))
                    cur.execute("DELETE FROM electricity_records WHERE id = %s", (existing["id"],))
                continue

            # 记录级税率：取第一个有品牌方合同的税率（仅作台账表头展示；明细金额按各品牌各自税率计算）
            first_brand_info = next(iter(pricing["brand_prices"].values()), None) or pricing.get("shared_price")
            tax_rate = float(first_brand_info["tax_rate"]) if first_brand_info else 0.01

            # 记录级收款单价（表头展示用）：按组主体取该品牌合同单价（共用表组取全品牌合同单价）
            # ★V5：民用行无收款对象 → 收款单价为空
            if rtype == "civil":
                record_collect_price = None
            else:
                brand_info0 = brand_price_for(pricing, bid, eid)
                record_collect_price = brand_info0["price"] if brand_info0 else None

            # 计算度数（按电表分别匹配）
            total_pay_kwh = 0
            total_collect_kwh = 0
            meter_details = []
            for item in meter_list:
                m = item["meter"]
                alloc = item["alloc"]

                if alloc is not None:
                    # ── 共享电表品牌分摊：金额人工录入，用电量 = 金额 ÷ 单价 倒推 ──
                    unit_price, brand_info = _alloc_unit_price(pricing, alloc, m.get("entity_id"))
                    collect_amount = round(float(alloc["collect_amount"] or 0), 2)
                    if not unit_price:
                        warnings.append(
                            f"{m['meter_no']}（{alloc.get('brand_name') or alloc['brand_id']}）"
                            f"{period} 缺单价，无法倒推用电量，已跳过该品牌分摊"
                        )
                        continue
                    actual_kwh = round(collect_amount / float(unit_price), 2)
                    # ★V5：品牌只承担【自己用电量】对应的成本 —— **不再乘损耗系数**。
                    #   旧口径把「整表读数 − 品牌倒推合计」的差额按电量比例摊进品牌付款电量
                    #   （= 品牌替我们承担了损耗）；现改为：差额由我方承担，
                    #   连同场地级损耗一起进本场地当月唯一的【损耗行】（见本函数末尾 §5）。
                    pay_kwh = actual_kwh
                    detail_rate = brand_info["tax_rate"] if (brand_info and brand_info.get("tax_enabled")) else None
                    pay_amount = round(pay_kwh * float(landlord_price or 0), 2) if landlord_price else 0
                    _, collect_net = split_tax(collect_amount, detail_rate)
                    total_pay_kwh += pay_kwh
                    total_collect_kwh += actual_kwh
                    # 表内未分摊差额（**表级**，只提示、不摊）：整表读数 − 该表各品牌倒推合计
                    full_kwh = _shared_full_kwh(readings, m)
                    alloc_kwh_sum = alloc_kwh_by_meter.get(m["meter_no"]) or 0.0
                    if abs(full_kwh - alloc_kwh_sum) > max(1, full_kwh * 0.01):
                        warnings.append(
                            f"{m['meter_no']} {period} 表内未分摊差额 {round(full_kwh - alloc_kwh_sum, 2)} 度"
                            f"（整表 {full_kwh} − 品牌倒推合计 {round(alloc_kwh_sum, 2)}）→ 我方承担，不摊给品牌"
                        )
                    meter_details.append({
                        "meterId": m["id"],
                        "meterNo": m["meter_no"],
                        "brandId": alloc["brand_id"],
                        "brandName": alloc.get("brand_name"),
                        "kwh": pay_kwh,
                        "payUnitPrice": float(landlord_price or 0),
                        "payAmount": pay_amount,
                        "collectUnitPrice": float(unit_price),
                        "collectAmount": collect_amount,
                        "collectNet": collect_net,
                        "source": "shared_alloc",
                    })
                    continue

                row = readings.get(m["meter_no"]) or {}
                kwh = float(row.get("kwh") or 0)
                if row.get("actual") is not None:
                    # 有实际值：优先使用（已含倍数）
                    actual_kwh = round(float(row["actual"]), 2)
                else:
                    ratio = float(m.get("transformer_ratio") or 1)
                    actual_kwh = round(kwh * ratio, 2)

                total_pay_kwh += actual_kwh
                total_collect_kwh += actual_kwh

                # 收款单价（v3.2 主体感知）：按电表品牌+主体匹配拆签合同；共用表（无品牌）取「全品牌合同」单价，无合同 → 收入为 0
                # ★V5：民用行（civil）**没有收款对象** —— 收款侧一律为 0（不能拿全品牌合同给民用电表计收入）
                if rtype == "civil":
                    brand_info, brand_price = None, None
                else:
                    brand_info = brand_price_for(pricing, m.get("brand_id"), m.get("entity_id")) if m.get("brand_id") else pricing.get("shared_price")
                    brand_price = brand_info["price"] if brand_info else None
                # 税费仅在启用税率且合同有税率时按「收入×税率」扣（税费 = 含税收入 × 税率）
                detail_rate = brand_info["tax_rate"] if (brand_info and brand_info.get("tax_enabled")) else None

                pay_amount = round(actual_kwh * float(landlord_price or 0), 2) if landlord_price else 0
                collect_amount = round(actual_kwh * float(brand_price or 0), 2) if brand_price else 0
                # 统一税费口径：税费 = 含税收入 × 税率；不含税 = 收入 − 税费
                _, collect_net = split_tax(collect_amount, detail_rate)

                meter_details.append({
                    "meterId": m["id"],
                    "meterNo": m["meter_no"],
                    "brandId": m.get("brand_id"),
                    "brandName": m.get("brand_name"),
                    "kwh": actual_kwh,
                    "payUnitPrice": float(landlord_price or 0),
                    "payAmount": pay_amount,
                    "collectUnitPrice": float(brand_price or 0),
                    "collectAmount": collect_amount,
                    "collectNet": collect_net,
                })

            total_pay_amount = sum(d["payAmount"] for d in meter_details)
            total_collect_amount = sum(d["collectAmount"] for d in meter_details)
            total_collect_net = sum(d["collectNet"] for d in meter_details)
            # ★V5：累加该场地「已入台账的品牌付款电量」，供 §5 算差额行
            site_pay_kwh[lid] += round(total_pay_kwh, 2)

            # 分摊组的表头收款单价取明细实际单价（可能是人工覆盖的单价，合同里查不到）
            if has_alloc and meter_details:
                record_collect_price = meter_details[0]["collectUnitPrice"]

            # 电费台账只记纯电费，不混租金（租金在 rent_* 体系单独体现）
            profit = round(total_collect_net - total_pay_amount, 2)

            if existing:
                # 更新已有记录（用同一个连接）；重新生成 → 数据来源记为 auto
                cur.execute("""
                    UPDATE electricity_records SET
                        pay_kwh=%s, pay_unit_price=%s, pay_amount=%s,
                        collect_kwh=%s, collect_unit_price=%s, collect_amount=%s,
                        tax_rate=%s, collect_net=%s, profit=%s, data_source='auto', updated_at=NOW()
                    WHERE id=%s
                """, (
                    round(total_pay_kwh, 2), float(landlord_price or 0), total_pay_amount,
                    round(total_collect_kwh, 2), float(record_collect_price or 0), total_collect_amount,
                    tax_rate, total_collect_net, profit, existing["id"]
                ))
                # 删除旧明细，插入新明细
                cur.execute("DELETE FROM electricity_meter_details WHERE electricity_id = %s", (existing["id"],))
                for d in meter_details:
                    cur.execute("""
                        INSERT INTO electricity_meter_details
                        (electricity_id, meter_id, start_reading, end_reading, kwh,
                         pay_unit_price, pay_amount, collect_unit_price, collect_amount, collect_net)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """, (
                        existing["id"], d["meterId"], None, None, d["kwh"],
                        d["payUnitPrice"], d["payAmount"],
                        d["collectUnitPrice"], d["collectAmount"], d["collectNet"]
                    ))
                updated.append(f"{lid}-{bid}-{eid}")
            else:
                # 新增记录（用同一个连接）；系统生成 → 数据来源 auto
                # ★V5：写入 row_type（normal / civil；loss 行由 §5 单独维护）
                cur.execute("""
                    INSERT INTO electricity_records
                    (landlord_id, brand_id, entity_id, period, row_type, pay_kwh, pay_unit_price, pay_amount, pay_status,
                     collect_kwh, collect_unit_price, collect_amount, tax_rate, collect_net, collect_status, profit, data_source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, '未付款', %s, %s, %s, %s, %s, '未到账', %s, 'auto')
                    RETURNING id
                """, (
                    lid, bid, eid, period, rtype,
                    round(total_pay_kwh, 2), float(landlord_price or 0), total_pay_amount,
                    round(total_collect_kwh, 2), float(record_collect_price or 0), total_collect_amount,
                    tax_rate, total_collect_net, profit
                ))
                record_id = cur.fetchone()["id"]
                for d in meter_details:
                    cur.execute("""
                        INSERT INTO electricity_meter_details
                        (electricity_id, meter_id, start_reading, end_reading, kwh,
                         pay_unit_price, pay_amount, collect_unit_price, collect_amount, collect_net)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """, (
                        record_id, d["meterId"], None, None, d["kwh"],
                        d["payUnitPrice"], d["payAmount"],
                        d["collectUnitPrice"], d["collectAmount"], d["collectNet"]
                    ))
                created.append(record_id)

        # 5. 场地级电费与【损耗行】（★V5 —— 本切片的核心）
        #    V5 口径：损耗是【场地级】的：
        #      参考电量 ref_kwh   = Σ场地内**所有**表的实际用电量
        #      最终电量 final_kwh = 财务在场地级填的「最终付给场地方的电量」（默认 = 参考值）
        #      损耗 = final_kwh − ref_kwh  → **我方承担**、**单独一行**、**不归任何主体**、**不摊给品牌**
        #    与「表内未分摊差额」（= 某块共享表读数 − 该表各品牌倒推合计，表级）是两个**不同**的值。
        cur.execute("""
            SELECT m.id, m.meter_no, m.landlord_id, m.is_shared, m.transformer_ratio
            FROM meters m
            WHERE m.landlord_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%'
        """)
        site_ref = defaultdict(float)
        for m in cur.fetchall():
            row = readings.get(m["meter_no"])
            if not row:
                continue
            if m.get("is_shared"):
                kwh_m = _shared_full_kwh(readings, m)      # 共用表：整表读数（付场地方的结算口径）
            elif row.get("actual") is not None:
                kwh_m = round(float(row["actual"]), 2)
            else:
                kwh_m = round(float(row.get("kwh") or 0) * float(m.get("transformer_ratio") or 1), 2)
            site_ref[m["landlord_id"]] += kwh_m

        for lid, ref_raw in site_ref.items():
            if not lid:
                continue
            ref_kwh = round(ref_raw, 2)
            price = float(_pricing_of(lid)["pay_price"] or 0)
            cur.execute("""
                SELECT id, final_kwh, final_amount, data_source FROM landlord_monthly_elec
                WHERE landlord_id = %s AND period = %s
            """, (lid, period))
            lme = cur.fetchone()
            # ★只有【人工填过】的最终电量才算数（data_source='manual'）。
            #   迁移时预填的 final_kwh = 参考值属于"系统默认"，不能当成"财务填的真实值"，
            #   否则会把它误算成损耗。
            final_kwh = None
            if lme and (lme.get("data_source") == "manual"):
                if lme.get("final_kwh") is not None:
                    final_kwh = float(lme["final_kwh"])
                elif lme.get("final_amount") is not None and price:
                    final_kwh = round(float(lme["final_amount"]) / price, 2)
            if final_kwh is None:
                final_kwh = ref_kwh
            # ★V5：差额 = 最终付场地方电量 − **已入台账的各品牌电量合计**
            #   它同时涵盖 V5 的两个值：① 表内未分摊差额（表级）② 场地级损耗（final − Σ所有表）；
            #   ⇒ 账面恒等：Σ各品牌 pay_amount + 差额行 pay_amount = final_kwh × 场地单价
            #   （参考电量 ref_kwh 另存在 landlord_monthly_elec.ref_kwh，供页面对账展示）
            site_pay = round(site_pay_kwh.get(lid, 0.0), 2)
            # 无场地单价的场地：差额算不出金额，也谈不上"我方为它付了钱" ⇒ 一律记 0
            loss_kwh = round(final_kwh - site_pay, 2) if price else 0.0
            loss_amount = round(loss_kwh * price, 2) if price else 0.0

            # 场地级月度电费：ref/单价/损耗由系统算；final_kwh 同步为本轮采用的最终值
            #   （人工填的 = 人工值；没填的 = 参考值）—— 避免迁移预填的陈旧 final 残留在页面上误导
            cur.execute("""
                INSERT INTO landlord_monthly_elec
                    (landlord_id, period, ref_kwh, final_kwh, unit_price, loss_kwh, loss_amount, data_source)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'auto')
                ON CONFLICT (landlord_id, period) DO UPDATE SET
                    ref_kwh = EXCLUDED.ref_kwh,
                    final_kwh = EXCLUDED.final_kwh,
                    unit_price = EXCLUDED.unit_price,
                    loss_kwh = EXCLUDED.loss_kwh,
                    loss_amount = EXCLUDED.loss_amount,
                    updated_at = NOW()
            """, (lid, period, ref_kwh, final_kwh, price or None, loss_kwh, loss_amount))

            cur.execute("""
                SELECT id FROM electricity_records
                WHERE period = %s AND landlord_id = %s AND row_type = 'loss'
            """, (period, lid))
            ex_loss = cur.fetchone()
            # 只有【知道场地单价】的场地才建差额行 —— 否则"我们为这部分电付了多少钱"无从计算，
            # 把整场地电量写成"损耗"是误导（无场地合同的场地就是这样）。
            if price and loss_kwh > 0:
                if ex_loss:
                    cur.execute("""
                        UPDATE electricity_records SET
                            pay_kwh=%s, pay_unit_price=%s, pay_amount=%s,
                            collect_kwh=0, collect_unit_price=NULL, collect_amount=0, collect_net=0,
                            profit=%s, data_source='auto', updated_at=NOW()
                        WHERE id=%s
                    """, (loss_kwh, price or None, loss_amount, -loss_amount, ex_loss["id"]))
                    updated.append(f"{lid}-loss")
                else:
                    cur.execute("""
                        INSERT INTO electricity_records
                        (landlord_id, brand_id, entity_id, period, row_type,
                         pay_kwh, pay_unit_price, pay_amount, pay_status,
                         collect_kwh, collect_unit_price, collect_amount, collect_net, collect_status,
                         profit, data_source, remark)
                        VALUES (%s, NULL, NULL, %s, 'loss',
                                %s, %s, %s, '未付款',
                                0, NULL, 0, 0, '未到账',
                                %s, 'auto', %s)
                    """, (lid, period, loss_kwh, price or None, loss_amount, -loss_amount,
                          "差额（我方承担）：表内未分摊差额 + 场地级损耗 = 最终付场地方电量 − 已入台账的各品牌电量；"
                          "不归任何主体、不摊给品牌"))
                    created.append("loss")
            elif ex_loss:
                # 损耗为 0（财务填的最终电量 = 参考值）⇒ 清掉旧的损耗行，避免残留
                cur.execute("DELETE FROM electricity_records WHERE id = %s", (ex_loss["id"],))
                deleted.append(ex_loss["id"])

        # 6. 清理「分组已消失」的自动台账：电表归属变更（品牌 ↔ 共享互转、改场地、换主体）或合同变化后，
        #    旧分组不再出现在当前 groups 中，残留记录会导致台账重复计表。
        #    不变式：生成后，data_source='auto' 的台账 ⊆ 当前分组；手工台账（manual）保留不删。
        #    ★V5：损耗行（row_type='loss'）由 §5 专项维护，这里跳过。
        cur.execute("""
            SELECT id, landlord_id, brand_id, entity_id, row_type FROM electricity_records
            WHERE period = %s AND COALESCE(data_source, 'auto') = 'auto'
        """, (period,))
        for r in cur.fetchall():
            _rt = r.get("row_type") or "normal"
            if _rt == "loss":
                continue
            # ★V5：按 (场地, 品牌, 主体, 行类型) 四元组匹配当前分组
            if (r["landlord_id"], r["brand_id"], r["entity_id"], _rt) in groups:
                continue
            cur.execute("DELETE FROM electricity_meter_details WHERE electricity_id = %s", (r["id"],))
            cur.execute("DELETE FROM electricity_records WHERE id = %s", (r["id"],))
            deleted.append(r["id"])

        conn.commit()

        # 分红联动：台账生成/更新后，重算涉及场地该月的分红记录（失败不影响台账生成）
        try:
            from ..domain.dividend_refresh import refresh_dividend_records
            for lid in landlord_ids:
                refresh_dividend_records(lid, [period])
        except Exception:
            pass

        return {
            "created": len(created),
            "updated": len(updated),
            "deleted": len(deleted),
            "period": period,
            "warnings": warnings,
            "detail": f"新增 {len(created)} 条，更新 {len(updated)} 条" + (f"，清理残留 {len(deleted)} 条" if deleted else "")
        }
    finally:
        cur.close()
        conn.close()


# ─── 动态生成：电表归属变更 / 合同保存后 自动生成台账 ──────────
# 用户需求：只要 电表关联好场地方+品牌方、合同填写好，台账自动出现（无需手动点「自动生成」）。

async def auto_generate_for_meter(meter_no: str, from_period: str = None) -> int:
    """电表归属变更后：对该电表有读数的月份，自动生成/更新台账（v3.1：按场地×品牌×主体）。

    仅在电表已归属场地（landlord 非空）且 指定了品牌 或 标记为共享电表 时生效；
    归属被解除后，重算会自动剔除该电表。
    from_period：只重算 >= 该月（6 位 YYYYMM）的月份——换主体选「仅从本月起」时用，
    None=全部历史月份（默认，历史台账整体搬到新主体）。
    """
    from ..infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT landlord_id, brand_id FROM meters
            WHERE meter_no = %s AND landlord_id IS NOT NULL
              AND (brand_id IS NOT NULL OR tag = '共享电表')
        """, (meter_no,))
        row = cur.fetchone()
        if not row:
            return 0
        # 有读数的月份 ∪ 有品牌分摊录入的月份（共享电表可能只录了分摊、没录读数）
        cur.execute("""
            SELECT DISTINCT month_period AS p FROM meter_readings WHERE address = %s
            UNION
            SELECT DISTINCT month_period AS p FROM meter_shared_allocations WHERE address = %s
        """, (meter_no, meter_no))
        periods = [r["p"] for r in cur.fetchall()]
    finally:
        cur.close()
        conn.close()
    if from_period:
        periods = [p for p in periods if str(p) >= str(from_period)]
    count = 0
    for p in periods:
        await generate_electricity({"period": p})
        count += 1
    return count


async def auto_generate_for_landlord(landlord_id) -> int:
    """合同保存后：对该场地所有实表电表有读数的月份，自动生成/更新台账（v3）。"""
    from ..infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT DISTINCT mm.month_period AS p FROM meter_readings mm
            JOIN meters m ON m.id = mm.meter_id
            WHERE m.landlord_id = %s AND (m.brand_id IS NOT NULL OR m.is_shared = TRUE)
              AND m.meter_no NOT LIKE 'TEST%%'
            UNION
            SELECT DISTINCT a.month_period AS p FROM meter_shared_allocations a
            JOIN meters m ON m.id = a.meter_id
            WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
        """, (landlord_id, landlord_id))
        periods = [r["p"] for r in cur.fetchall()]
    finally:
        cur.close()
        conn.close()
    count = 0
    for p in periods:
        await generate_electricity({"period": p})
        count += 1
    return count


async def generate_all_ledger() -> int:
    """全量自动生成台账：所有实表电表有读数的月份（v3.1，按场地×品牌×主体生成）。

    触发时机：后端启动后 / 第三方月度读数同步完成后 / 电表归属、合同、录读数保存后（后两者走各自触发）。
    """
    from ..infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT DISTINCT mm.month_period AS p FROM meter_readings mm
            JOIN meters m ON m.id = mm.meter_id
            WHERE m.landlord_id IS NOT NULL
              AND (m.brand_id IS NOT NULL OR m.is_shared = TRUE)
              AND m.meter_no NOT LIKE 'TEST%%'
            UNION
            SELECT DISTINCT a.month_period AS p FROM meter_shared_allocations a
            JOIN meters m ON m.id = a.meter_id
            WHERE m.landlord_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%%'
        """)
        periods = [r["p"] for r in cur.fetchall()]
    finally:
        cur.close()
        conn.close()
    count = 0
    for p in periods:
        await generate_electricity({"period": p})
        count += 1
    return count


# ─── 电费月台账（Electricity 页，v2 重设计，只含电费）──────────

@router.get("/monthly-ledger")
async def monthly_ledger(period: str, dim: str = "landlord", request: Request = None):
    """电费月台账：按场地方(landlord)/品牌方(brand)/公司主体(entity) × 单月 汇总 + 明细"""
    from ..infra.database import get_connection, get_dict_cursor
    from ..infra.auth_scope import scope_landlord_ids, scope_meter_tag
    period = str(period).replace("-", "")

    # 数据隔离：股东按可见场地过滤；指定电表类型范围的账号另按类型过滤电表明细行
    allowed = scope_landlord_ids(request) if request is not None else None
    tag_scope = scope_meter_tag(request) if request is not None else None

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        if dim == "brand":
            # 品牌维度：按电费分表明细（每表有 付款/收款）按品牌聚合（共享电表无品牌，单独一组）
            brand_scope_sql, brand_scope_vals = "", []
            if allowed is not None:
                brand_scope_sql += " AND m.landlord_id = ANY(%s::int[])"
                brand_scope_vals.append(allowed)
            if tag_scope:
                brand_scope_sql += " AND m.tag = %s"
                brand_scope_vals.append(tag_scope)
            cur.execute(f"""
                SELECT COALESCE(e.brand_id, m.brand_id) AS key, COALESCE(b.name, '全品牌共享') AS name,
                       COALESCE(SUM(d.kwh), 0) AS kwh,
                       COALESCE(SUM(d.pay_amount), 0) AS pay_amount,
                       COALESCE(SUM(d.collect_amount), 0) AS collect_amount,
                       COALESCE(SUM(d.collect_net), 0) AS collect_net
                FROM electricity_meter_details d
                JOIN electricity_records e ON e.id = d.electricity_id
                JOIN meters m ON d.meter_id = m.id
                LEFT JOIN brands b ON COALESCE(e.brand_id, m.brand_id) = b.id
                WHERE e.period = %s{brand_scope_sql}
                GROUP BY COALESCE(e.brand_id, m.brand_id), b.name
                ORDER BY name
            """, (period, *brand_scope_vals))
            rows = cur.fetchall()
            # 品牌明细：该品牌该月的 电表行（含 互感器倍数/单价/金额/状态）
            for r in rows:
                # 品牌口径：优先台账行品牌（共享电表按品牌分摊后每行一个品牌），
                # 其次电表品牌；两者都空 = 未做分摊的共享电表（全品牌共享）
                brand_cond = "COALESCE(e.brand_id, m.brand_id) IS NULL" if r["key"] is None else "COALESCE(e.brand_id, m.brand_id) = %s"
                brand_vals = (period,) if r["key"] is None else (period, r["key"])
                cur.execute(f"""
                    SELECT m.meter_name AS station_name, m.meter_no, m.meter_name,
                           m.transformer_ratio,
                           COALESCE(e.brand_id, m.brand_id) AS brand_id, b.name AS brand_name,
                           d.kwh, d.pay_unit_price, d.pay_amount, d.collect_unit_price,
                           d.collect_amount, d.collect_net,
                           e.pay_status, e.collect_status, e.data_source, e.id AS record_id
                    FROM electricity_meter_details d
                    JOIN electricity_records e ON e.id = d.electricity_id
                    JOIN meters m ON d.meter_id = m.id
                    LEFT JOIN brands b ON COALESCE(e.brand_id, m.brand_id) = b.id
                    WHERE e.period = %s AND {brand_cond}{brand_scope_sql}
                    ORDER BY m.meter_name, m.meter_no
                """, (*brand_vals, *brand_scope_vals))
                r["details"] = cur.fetchall()
        elif dim == "entity":
            # 公司主体维度：台账行自带 entity_id（生成时按电表主体归属），按主体聚合
            entity_scope_sql, entity_scope_vals = "", []
            if allowed is not None:
                entity_scope_sql = " AND e.landlord_id = ANY(%s::int[])"
                entity_scope_vals.append(allowed)
            cur.execute(f"""
                SELECT e.entity_id AS key, COALESCE(ent.name, '未指定主体') AS name,
                       COALESCE(SUM(e.pay_kwh), 0) AS kwh,
                       COALESCE(SUM(e.pay_amount), 0) AS pay_amount,
                       COALESCE(SUM(e.collect_amount), 0) AS collect_amount,
                       COALESCE(SUM(e.collect_net), 0) AS collect_net,
                       COALESCE(SUM(e.profit), 0) AS profit,
                       CASE
                         WHEN COUNT(*) > 0 AND COUNT(*) FILTER (WHERE e.pay_status = '已付款') = COUNT(*) THEN '已付款'
                         ELSE '未付款'
                       END AS pay_status
                FROM electricity_records e
                LEFT JOIN entities ent ON e.entity_id = ent.id
                WHERE e.period = %s AND COALESCE(e.row_type, 'normal') <> 'loss'{entity_scope_sql}
                GROUP BY e.entity_id, ent.name
                ORDER BY name
            """, (period, *entity_scope_vals))
            rows = cur.fetchall()
            # 主体明细：该主体该月的 电表行（电表主体 = 台账主体）
            detail_scope_sql, detail_scope_vals = "", []
            if tag_scope:
                detail_scope_sql = " AND m.tag = %s"
                detail_scope_vals.append(tag_scope)
            for r in rows:
                cur.execute(f"""
                    SELECT m.meter_name, m.meter_no, m.meter_name AS station_name,
                           m.transformer_ratio,
                           COALESCE(e.brand_id, m.brand_id) AS brand_id, b.name AS brand_name,
                           l.name AS landlord_name,
                           d.kwh, d.pay_unit_price, d.pay_amount, d.collect_unit_price,
                           d.collect_amount, d.collect_net,
                           e.pay_status, e.collect_status, e.data_source, e.id AS record_id
                    FROM electricity_meter_details d
                    JOIN electricity_records e ON e.id = d.electricity_id
                    JOIN meters m ON d.meter_id = m.id
                    LEFT JOIN brands b ON COALESCE(e.brand_id, m.brand_id) = b.id
                    LEFT JOIN landlords l ON m.landlord_id = l.id
                    WHERE e.period = %s AND m.entity_id IS NOT DISTINCT FROM %s{detail_scope_sql}
                    ORDER BY l.name, m.meter_name, m.meter_no
                """, (period, r["key"], *detail_scope_vals))
                r["details"] = cur.fetchall()
        else:
            # 场地维度：按 场地×主体 聚合（同一主体同名场地只出一行；跨主体场地自动拆行）
            landlord_scope_sql, landlord_scope_vals = "", []
            if allowed is not None:
                landlord_scope_sql = " AND e.landlord_id = ANY(%s::int[])"
                landlord_scope_vals.append(allowed)
            cur.execute(f"""
                SELECT e.landlord_id AS key, COALESCE(l.name, '未指定场地') AS name,
                       e.entity_id AS entity_id, COALESCE(ent.name, '未指定主体') AS entity_name,
                       e.row_type AS row_type,
                       COALESCE(SUM(e.pay_kwh), 0) AS kwh,
                       COALESCE(SUM(e.pay_amount), 0) AS pay_amount,
                       COALESCE(SUM(e.collect_amount), 0) AS collect_amount,
                       COALESCE(SUM(e.collect_net), 0) AS collect_net,
                       COALESCE(SUM(e.profit), 0) AS profit,
                       CASE
                         WHEN COUNT(*) > 0 AND COUNT(*) FILTER (WHERE e.pay_status = '已付款') = COUNT(*) THEN '已付款'
                         ELSE '未付款'
                       END AS pay_status
                FROM electricity_records e
                LEFT JOIN landlords l ON e.landlord_id = l.id
                LEFT JOIN entities ent ON e.entity_id = ent.id
                WHERE e.period = %s{landlord_scope_sql}
                GROUP BY e.landlord_id, l.name, e.entity_id, ent.name, e.row_type
                ORDER BY name
            """, (period, *landlord_scope_vals))
            rows = cur.fetchall()
            # 场地明细：该场地该主体该月的 电表行（含 互感器倍数/单价/金额/状态）；受限账号只看范围内类型的电表行
            detail_scope_sql, detail_scope_vals = "", []
            if tag_scope:
                detail_scope_sql = " AND m.tag = %s"
                detail_scope_vals.append(tag_scope)
            for r in rows:
                cur.execute(f"""
                    SELECT m.meter_name, m.meter_no, m.meter_name AS station_name,
                           m.transformer_ratio,
                           COALESCE(e.brand_id, m.brand_id) AS brand_id, b.name AS brand_name,
                           d.kwh, d.pay_unit_price, d.pay_amount, d.collect_unit_price,
                           d.collect_amount, d.collect_net,
                           e.pay_status, e.collect_status, e.data_source, e.id AS record_id
                    FROM electricity_meter_details d
                    JOIN electricity_records e ON e.id = d.electricity_id
                    JOIN meters m ON d.meter_id = m.id
                    LEFT JOIN brands b ON COALESCE(e.brand_id, m.brand_id) = b.id
                    WHERE e.period = %s AND m.landlord_id = %s
                      AND m.entity_id IS NOT DISTINCT FROM %s{detail_scope_sql}
                    ORDER BY m.meter_name, m.meter_no
                """, (period, r["key"], r.get("entity_id"), *detail_scope_vals))
                r["details"] = cur.fetchall()
    finally:
        cur.close()
        conn.close()

    totals = {"kwh": 0.0, "payAmount": 0.0, "collectAmount": 0.0, "collectNet": 0.0, "elecTax": 0.0, "profit": 0.0}
    out_rows = []
    for r in rows:
        pay = float(r["pay_amount"] or 0)
        collect = float(r["collect_amount"] or 0)
        net = float(r["collect_net"] or 0)
        item = {
            "key": r["key"],
            "name": r["name"],
            # ★V5：行类型（normal=品牌行 / civil=民用电表行 / loss=损耗行）+ 大类展示名
            "rowType": r.get("row_type") or "normal",
            "entityId": r.get("entity_id") if "entity_id" in r else (r["key"] if dim == "entity" else None),
            "entityName": r.get("entity_name") or (r["name"] if dim == "entity" else None) or "未指定主体",
            "kwh": round(float(r["kwh"] or 0), 2),
            "payAmount": round(pay, 2),
            "collectAmount": round(collect, 2),
            "collectNet": round(net, 2),
            "elecTax": round(collect - net, 2),
            "profit": round(float(r.get("profit") or (net - pay)), 2),
            "payStatus": r.get("pay_status") or "未付款",
            "details": r["details"],
        }
        for k in ("kwh", "payAmount", "collectAmount", "collectNet", "elecTax", "profit"):
            totals[k] += item[k]
        out_rows.append(item)

    return {
        "period": period,
        "dim": dim,
        "rows": out_rows,
        "totals": {k: round(v, 2) for k, v in totals.items()},
    }


# ─── 场地级月度电费（★V5：损耗的唯一载体；财务录「最终付给场地方的电量/金额」）────────

@router.get("/landlord-monthly")
async def get_landlord_monthly(request: Request, period: str):
    """某月各场地的电费对账数据：参考电量（系统算）+ 最终电量/金额（财务填）+ 损耗。

    - ref_kwh   = Σ场地内所有表的实际用电量（系统算，台账生成时维护）
    - final_kwh / final_amount = 财务填的「最终付给场地方的电量/金额」
    - loss_kwh  = 最终 − 参考电量（我方承担；不摊给品牌）
    数据隔离：股东按可见场地过滤。
    """
    from ..infra.database import get_connection, get_dict_cursor
    period = str(period).replace("-", "")
    allowed = scope_landlord_ids(request) if request is not None else None

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        where, vals = "", []
        if allowed is not None:
            where = "AND l.id = ANY(%s::int[])"
            vals.append(allowed)
        cur.execute(f"""
            SELECT l.id AS landlord_id, l.name AS landlord_name,
                   lme.ref_kwh, lme.final_kwh, lme.final_amount,
                   lme.unit_price, lme.loss_kwh, lme.loss_amount, lme.data_source,
                   lme.remark
            FROM landlords l
            LEFT JOIN landlord_monthly_elec lme
                   ON lme.landlord_id = l.id AND lme.period = %s
            WHERE EXISTS (SELECT 1 FROM meters m WHERE m.landlord_id = l.id)
              {where}
            ORDER BY l.name
        """, (period, *vals))
        rows = cur.fetchall()
        return {
            "period": period,
            "rows": [
                {
                    "landlordId": r["landlord_id"],
                    "landlordName": r["landlord_name"],
                    "refKwh": float(r["ref_kwh"]) if r.get("ref_kwh") is not None else None,
                    "finalKwh": float(r["final_kwh"]) if r.get("final_kwh") is not None else None,
                    "finalAmount": float(r["final_amount"]) if r.get("final_amount") is not None else None,
                    "unitPrice": float(r["unit_price"]) if r.get("unit_price") is not None else None,
                    "lossKwh": float(r["loss_kwh"]) if r.get("loss_kwh") is not None else None,
                    "lossAmount": float(r["loss_amount"]) if r.get("loss_amount") is not None else None,
                    "dataSource": r.get("data_source"),
                    "remark": r.get("remark"),
                }
                for r in rows
            ],
        }
    finally:
        cur.close()
        conn.close()


@router.put("/landlord-monthly/{landlord_id}")
async def save_landlord_monthly(landlord_id: int, request: Request, data: dict):
    """保存某场地某月的「最终付给场地方」电量/金额（财务人工值，data_source='manual'）。

    入参：{ period, finalKwh?, finalAmount?, remark? } —— 电量/金额至少填一个；
    保存后自动重算该月台账（损耗行/品牌行随之更新）。
    """
    from ..infra.database import get_connection, get_dict_cursor
    period = str(data.get("period", "")).replace("-", "")
    if len(period) != 6 or not period.isdigit():
        raise HTTPException(400, f"月份格式应为 YYYYMM，收到：{period}")
    final_kwh = data.get("finalKwh")
    final_amount = data.get("finalAmount")
    final_kwh = float(final_kwh) if final_kwh not in (None, "") else None
    final_amount = float(final_amount) if final_amount not in (None, "") else None
    if final_kwh is None and final_amount is None:
        raise HTTPException(400, "最终电量 / 最终金额 至少填一个")

    # 数据隔离：股东只能写可见场地
    if request is not None:
        allowed = scope_landlord_ids(request)
        if allowed is not None and landlord_id not in set(allowed):
            raise HTTPException(403, "无该场地的操作权限")
    operator = (getattr(request.state, "current_user", None) or {}).get("id") if request is not None else None

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id FROM landlords WHERE id = %s", (landlord_id,))
        if not cur.fetchone():
            raise HTTPException(404, "场地方不存在")
        cur.execute("""
            INSERT INTO landlord_monthly_elec
                (landlord_id, period, final_kwh, final_amount, data_source, updated_by, remark)
            VALUES (%s, %s, %s, %s, 'manual', %s, %s)
            ON CONFLICT (landlord_id, period) DO UPDATE SET
                final_kwh = EXCLUDED.final_kwh,
                final_amount = EXCLUDED.final_amount,
                data_source = 'manual',
                updated_by = EXCLUDED.updated_by,
                remark = EXCLUDED.remark,
                updated_at = NOW()
        """, (landlord_id, period, final_kwh, final_amount, operator, data.get("remark")))
        conn.commit()
    finally:
        cur.close()
        conn.close()

    # 保存后自动重算该月台账（损耗行随最终值变化；失败不影响保存结果）
    try:
        await generate_electricity({"period": period, "landlordId": landlord_id})
    except Exception:
        pass
    return {"ok": True, "landlordId": landlord_id, "period": period,
            "finalKwh": final_kwh, "finalAmount": final_amount}


# ─── 电费收付明细导出（参考 Excel：每电表一行，按维度分组）────────

@router.get("/export")
async def export_ledger(request: Request, period: str, dim: str = "landlord"):
    """电费收付明细台账导出（每电表一行）。

    列结构对齐参考 Excel「八维通-电费收付明细台账.xlsx」：
      序号/收款公司/站名/业主方/电表编号/互感器倍数/
      上月抄表时间/起始度数/抄表时间/抄表度数/区间度数/   ← 付款侧
      付款单价/付款金额/付款情况/
      起始度数/抄表时间/抄表度数/区间度数/               ← 收款侧
      收款单价/收款金额/不含税收入/到账情况/
      利润/运营费用/运营费用后利润/公司占股/公司净利润/备注

    返回 rows（每电表一行，含 group 分组键）+ 分组后的合计，供前端生成 Excel。
    """
    from ..infra.database import get_connection, get_dict_cursor
    from ..infra.auth_scope import scope_meter_tag
    period = str(period).replace("-", "")
    allowed = scope_landlord_ids(request)
    tag_scope = scope_meter_tag(request)

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 每电表一行：台账明细 + 电表 + 抄表读数(meter_readings) + 场地/品牌/实体 + 运营费用
        cur.execute("""
            SELECT
                d.id AS detail_id,
                m.id AS meter_id, m.meter_no, m.meter_name, m.transformer_ratio, m.tag,
                l.id AS landlord_id, l.name AS landlord_name, l.company_share,
                COALESCE(e.brand_id, m.brand_id) AS brand_id, b.name AS brand_name,
                m.entity_id AS entity_id, ent.name AS entity_name,
                d.kwh, d.pay_unit_price, d.pay_amount,
                d.collect_unit_price, d.collect_amount, d.collect_net,
                e.pay_status, e.collect_status, e.remark,
                mm.prev_reading_date, mm.prev_reading,
                mm.curr_reading_date, mm.curr_reading,
                op.amount AS op_expense
            FROM electricity_meter_details d
            JOIN electricity_records e ON e.id = d.electricity_id
            JOIN meters m ON d.meter_id = m.id
            LEFT JOIN landlords l ON m.landlord_id = l.id
            LEFT JOIN brands b ON COALESCE(e.brand_id, m.brand_id) = b.id
            LEFT JOIN entities ent ON m.entity_id = ent.id
            LEFT JOIN meter_readings mm
                   ON mm.meter_id = m.id AND mm.month_period = %s
            -- 运营费用预聚合（同场地同月可 公共+多主体 多行，直接 JOIN 会翻倍明细行）
            LEFT JOIN (SELECT landlord_id, period, SUM(amount) AS amount
                       FROM operating_expenses GROUP BY landlord_id, period) op
                   ON op.landlord_id = m.landlord_id AND op.period = %s
            WHERE e.period = %s
            ORDER BY l.name, b.name, m.meter_name, m.meter_no
        """, (period, period, period))
        rows = cur.fetchall()
    finally:
        cur.close()
        conn.close()

    # 权限过滤（股东只看关联场地；指定电表类型范围的账号只看该类型电表行）
    if allowed is not None:
        rows = [r for r in rows if r.get("landlord_id") in allowed]
    if tag_scope:
        rows = [r for r in rows if (r.get("tag") or "") == tag_scope]

    out = []
    for r in rows:
        pay = float(r.get("pay_amount") or 0)
        collect = float(r.get("collect_amount") or 0)
        net = float(r.get("collect_net") or 0)
        profit = round(net - pay, 2)
        op_expense = float(r.get("op_expense") or 0)
        profit_after_op = round(profit - op_expense, 2)
        share = r.get("company_share")
        company_net = round(profit_after_op * float(share), 2) if share is not None else None

        # 分组键：dim=brand 按品牌 / dim=entity 按公司主体，否则按场地
        if dim == "brand":
            group = r.get("brand_name") or "全品牌共享"
            group_key = f"brand-{r.get('brand_id') or 0}"
            # 收款公司 = 电表关联的公司主体；未关联时明确标注，不冒充公司名
            collect_company = r.get("entity_name") or "未指定主体"
        elif dim == "entity":
            group = r.get("entity_name") or "未指定主体"
            group_key = f"entity-{r.get('entity_id') or 0}"
            collect_company = group
        else:
            group = r.get("landlord_name") or "未指定场地"
            group_key = f"landlord-{r.get('landlord_id') or 0}"
            collect_company = r.get("entity_name") or "未指定主体"

        out.append({
            "groupKey": group_key,
            "group": group,
            "collectCompany": collect_company,
            "stationName": r.get("meter_name") or "",
            "landlordName": r.get("landlord_name") or "",
            "meterNo": r.get("meter_no") or "",
            "transformerRatio": float(r.get("transformer_ratio") or 1),
            "prevReadingDate": str(r.get("prev_reading_date") or "")[:10],
            "startReading": float(r.get("prev_reading") or 0),
            "readingDate": str(r.get("curr_reading_date") or "")[:10],
            "endReading": float(r.get("curr_reading") or 0),
            "kwh": round(float(r.get("kwh") or 0), 2),
            "payUnitPrice": float(r.get("pay_unit_price") or 0),
            "payAmount": round(pay, 2),
            "payStatus": r.get("pay_status") or "",
            "collectStartReading": float(r.get("prev_reading") or 0),
            "collectReadingDate": str(r.get("curr_reading_date") or "")[:10],
            "collectEndReading": float(r.get("curr_reading") or 0),
            "collectKwh": round(float(r.get("kwh") or 0), 2),
            "collectUnitPrice": float(r.get("collect_unit_price") or 0),
            "collectAmount": round(collect, 2),
            "collectNet": round(net, 2),
            "collectStatus": r.get("collect_status") or "",
            "profit": profit,
            "opExpense": round(op_expense, 2),
            "profitAfterOp": profit_after_op,
            "companyShare": float(share) if share is not None else None,
            "companyNetProfit": company_net,
            "remark": r.get("remark") or "",
        })

    # 分组合计 + 总计
    group_totals = {}
    for row in out:
        key = row["groupKey"]
        t = group_totals.setdefault(key, {"group": row["group"], "kwh": 0.0, "payAmount": 0.0,
                                           "collectAmount": 0.0, "collectNet": 0.0, "profit": 0.0,
                                           "opExpense": 0.0, "profitAfterOp": 0.0, "companyNetProfit": 0.0})
        for k in ("kwh", "payAmount", "collectAmount", "collectNet", "profit", "opExpense", "profitAfterOp"):
            t[k] += row[k]
        if row.get("companyNetProfit") is not None:
            t["companyNetProfit"] += row["companyNetProfit"]
    for t in group_totals.values():
        for k in ("kwh", "payAmount", "collectAmount", "collectNet", "profit", "opExpense", "profitAfterOp", "companyNetProfit"):
            t[k] = round(t[k], 2)

    totals = {"kwh": 0.0, "payAmount": 0.0, "collectAmount": 0.0, "collectNet": 0.0,
              "profit": 0.0, "opExpense": 0.0, "profitAfterOp": 0.0, "companyNetProfit": 0.0}
    for row in out:
        for k in ("kwh", "payAmount", "collectAmount", "collectNet", "profit", "opExpense", "profitAfterOp"):
            totals[k] += row[k]
        if row.get("companyNetProfit") is not None:
            totals["companyNetProfit"] += row["companyNetProfit"]
    totals = {k: round(v, 2) for k, v in totals.items()}

    return {
        "period": period,
        "dim": dim,
        "rows": out,
        "groupTotals": list(group_totals.values()),
        "totals": totals,
    }
