from fastapi import APIRouter, HTTPException, Request
from ..repositories import electricity_repo
from ..domain.electricity_calc import calc_electricity
from ..domain.electricity_pricing import split_tax
from ..infra.auth_scope import scope_landlord_ids
from ..infra.period import to_compact
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/electricity", tags=["电费台账"], default_response_class=CamelJSONResponse)


def compute_landlord_ledger(cur, landlord_id: int, period: str):
    """单场地台账计算（v3：按场地方查该场地所有实表，按 meter_monthly 读数 × 合同单价自动计算）。

    Returns:
        (meter_details, totals) 与 generate 的明细/合计结构一致。
    """
    from ..domain.electricity_pricing import resolve_prices, brand_collect_price

    cur.execute("""
        SELECT m.id, m.meter_no, m.brand_id, m.transformer_ratio,
               b.name as brand_name
        FROM meters m
        LEFT JOIN brands b ON m.brand_id = b.id
        WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
          AND (m.brand_id IS NOT NULL OR m.tag = '共享电表')
        ORDER BY m.id
    """, (landlord_id,))
    meters = cur.fetchall()

    meter_nos = [m["meter_no"] for m in meters if m.get("meter_no")]
    readings = {}
    if meter_nos:
        placeholders = ",".join(["%s"] * len(meter_nos))
        cur.execute(
            f"SELECT address, kwh, actual_kwh FROM meter_monthly WHERE month_period = %s AND address IN ({placeholders})",
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

        # 共享电表（无品牌）取「全品牌合同」单价；无合同 → 收入为 0
        brand_info = pricing["brand_prices"].get(int(m["brand_id"])) if m.get("brand_id") else pricing.get("shared_price")
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

    # period 统一为 6 位 YYYYMM（与 generate / meter_monthly 一致）
    existing = electricity_repo.get_record_by_landlord_brand_period(landlord_id, brand_id, period)
    if existing:
        raise HTTPException(400, f"场地 {landlord_id} 的 {period} 电费记录已存在")

    # 明细来源（按优先级）：
    #   1) 显式 meterDetails → 按明细计算；
    #   2) 手工填写了度数/金额 → 以提交值为准，缺失金额按 度数×单价 推算；
    #   3) 空表单 → 按该场地该月 meter_monthly × 合同单价自动计算（#2 口径）。
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


@router.post("/generate")
async def generate_electricity(data: dict):
    """从 meter_monthly + contracts 自动生成电费台账（v3：按 场地×品牌 全量生成）"""
    period = data.get("period")
    if not period:
        raise HTTPException(400, "period 必填")
    # 统一 period 为 6 位 YYYYMM（与 meter_monthly / electricity_records 一致）
    period = str(period).replace("-", "")

    from ..infra.database import get_connection, get_dict_cursor

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 1. 实表电表（v3：直挂 场地+品牌，无站点层；共享电表无品牌也参与，单独成组）
        cur.execute("""
            SELECT m.id, m.meter_no, m.landlord_id, m.brand_id, m.transformer_ratio,
                   b.name as brand_name
            FROM meters m
            LEFT JOIN brands b ON m.brand_id = b.id
            WHERE m.landlord_id IS NOT NULL
              AND (m.brand_id IS NOT NULL OR m.tag = '共享电表')
              AND m.meter_no NOT LIKE 'TEST%'
        """)
        meters = cur.fetchall()

        # 2. 获取该月电表读数（只查相关电表）
        meter_nos = [m["meter_no"] for m in meters if m.get("meter_no")]
        if meter_nos:
            placeholders = ",".join(["%s"] * len(meter_nos))
            cur.execute(f"SELECT address, kwh, actual_kwh FROM meter_monthly WHERE month_period = %s AND address IN ({placeholders})", (period, *meter_nos))
        else:
            cur.execute("SELECT address, kwh, actual_kwh FROM meter_monthly WHERE month_period = %s AND 1=0", (period,))
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

        # 4. 按 (场地, 品牌) 分组电表（v3）
        groups = defaultdict(list)
        for m in meters:
            groups[(m["landlord_id"], m["brand_id"])].append(m)

        # 预加载已有台账（按 landlord+brand）
        cur.execute("SELECT * FROM electricity_records WHERE period = %s", (period,))
        existing_map = {(r["landlord_id"], r["brand_id"]): r for r in cur.fetchall()}

        created = []
        updated = []

        for (lid, bid), meter_list in groups.items():
            existing = existing_map.get((lid, bid))

            contracts = landlord_contracts_map.get(lid, []) if lid else []
            # 统一单价解析（#2）：付款=场地合同唯一单价；收款=按品牌匹配品牌方合同单价
            from ..domain.electricity_pricing import resolve_prices, brand_collect_price
            pricing = resolve_prices(contracts)
            landlord_price = pricing["pay_price"]

            # 只生成有合同的场地×品牌：无场地合同 且（该品牌无品牌方合同 且 无全品牌合同）→ 不生成；有旧记录则删除
            has_site_contract = any(c.get("contract_type") == "场地合同" for c in contracts)
            has_brand_contract = (bid in pricing["brand_prices"]) if bid is not None else pricing.get("shared_price") is not None
            if not has_site_contract and not has_brand_contract:
                if existing:
                    cur.execute("DELETE FROM electricity_meter_details WHERE electricity_id = %s", (existing["id"],))
                    cur.execute("DELETE FROM electricity_records WHERE id = %s", (existing["id"],))
                continue

            # 记录级税率：取第一个有品牌方合同的税率（仅作台账表头展示；明细金额按各品牌各自税率计算）
            first_brand_info = next(iter(pricing["brand_prices"].values()), None) or pricing.get("shared_price")
            tax_rate = float(first_brand_info["tax_rate"]) if first_brand_info else 0.01

            # 记录级收款单价（表头展示用）：取该品牌合同单价（共享组取全品牌合同单价）
            brand_info0 = pricing["brand_prices"].get(bid) if bid is not None else pricing.get("shared_price")
            record_collect_price = brand_info0["price"] if brand_info0 else None

            # 计算度数（按电表分别匹配）
            total_pay_kwh = 0
            total_collect_kwh = 0
            meter_details = []
            for m in meter_list:
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

                # 收款单价：按电表品牌匹配；共享电表（无品牌）取「全品牌合同」单价，无合同 → 收入为 0
                brand_info = pricing["brand_prices"].get(int(m["brand_id"])) if m.get("brand_id") else pricing.get("shared_price")
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
                updated.append(f"{lid}-{bid}")
            else:
                # 新增记录（用同一个连接）；系统生成 → 数据来源 auto
                cur.execute("""
                    INSERT INTO electricity_records
                    (landlord_id, brand_id, period, pay_kwh, pay_unit_price, pay_amount, pay_status,
                     collect_kwh, collect_unit_price, collect_amount, tax_rate, collect_net, collect_status, profit, data_source)
                    VALUES (%s, %s, %s, %s, %s, %s, '未付款', %s, %s, %s, %s, %s, '未到账', %s, 'auto')
                    RETURNING id
                """, (
                    lid, bid, period, round(total_pay_kwh, 2), float(landlord_price or 0), total_pay_amount,
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

        # 5. 清理「分组已消失」的自动台账：电表归属变更（品牌 ↔ 共享互转、改场地）或合同变化后，
        #    旧分组不再出现在当前 groups 中，残留记录会导致台账重复计表。
        #    不变式：生成后，data_source='auto' 的台账 ⊆ 当前分组 —— 自动记录分组不在当前分组即删；
        #    手工建的台账（data_source='manual'）是用户录入的财务数据，保留不删。
        cur.execute("""
            SELECT id, landlord_id, brand_id FROM electricity_records
            WHERE period = %s AND COALESCE(data_source, 'auto') = 'auto'
        """, (period,))
        deleted = []
        for r in cur.fetchall():
            if (r["landlord_id"], r["brand_id"]) in groups:
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
            "detail": f"新增 {len(created)} 条，更新 {len(updated)} 条" + (f"，清理残留 {len(deleted)} 条" if deleted else "")
        }
    finally:
        cur.close()
        conn.close()


# ─── 动态生成：电表归属变更 / 合同保存后 自动生成台账 ──────────
# 用户需求：只要 电表关联好场地方+品牌方、合同填写好，台账自动出现（无需手动点「自动生成」）。

async def auto_generate_for_meter(meter_no: str) -> int:
    """电表归属变更后：对该电表有读数的所有月份，自动生成/更新台账（v3：按场地×品牌）。

    仅在电表已归属场地（landlord 非空）且 指定了品牌 或 标记为共享电表 时生效；
    归属被解除后，重算会自动剔除该电表。
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
        cur.execute("SELECT DISTINCT month_period AS p FROM meter_monthly WHERE address = %s", (meter_no,))
        periods = [r["p"] for r in cur.fetchall()]
    finally:
        cur.close()
        conn.close()
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
            SELECT DISTINCT mm.month_period AS p FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address
            WHERE m.landlord_id = %s AND (m.brand_id IS NOT NULL OR m.tag = '共享电表')
              AND m.meter_no NOT LIKE 'TEST%%'
        """, (landlord_id,))
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
    """全量自动生成台账：所有实表电表有读数的月份（v3，按场地×品牌生成）。

    触发时机：后端启动后 / 第三方月度读数同步完成后 / 电表归属、合同、录读数保存后（后两者走各自触发）。
    """
    from ..infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT DISTINCT mm.month_period AS p FROM meter_monthly mm
            JOIN meters m ON m.meter_no = mm.address
            WHERE m.landlord_id IS NOT NULL
              AND (m.brand_id IS NOT NULL OR m.tag = '共享电表')
              AND m.meter_no NOT LIKE 'TEST%%'
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
async def monthly_ledger(period: str, dim: str = "landlord"):
    """电费月台账：按场地方(landlord)/品牌方(brand) × 单月 汇总 + 明细"""
    from ..infra.database import get_connection, get_dict_cursor
    period = str(period).replace("-", "")

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        if dim == "brand":
            # 品牌维度：按电费分表明细（每表有 付款/收款）按品牌聚合（共享电表无品牌，单独一组）
            cur.execute("""
                SELECT m.brand_id AS key, COALESCE(b.name, '全品牌共享') AS name,
                       COALESCE(SUM(d.kwh), 0) AS kwh,
                       COALESCE(SUM(d.pay_amount), 0) AS pay_amount,
                       COALESCE(SUM(d.collect_amount), 0) AS collect_amount,
                       COALESCE(SUM(d.collect_net), 0) AS collect_net
                FROM electricity_meter_details d
                JOIN electricity_records e ON e.id = d.electricity_id
                JOIN meters m ON d.meter_id = m.id
                LEFT JOIN brands b ON m.brand_id = b.id
                WHERE e.period = %s
                GROUP BY m.brand_id, b.name
                ORDER BY name
            """, (period,))
            rows = cur.fetchall()
            # 品牌明细：该品牌该月的 电表行（含 互感器倍数/单价/金额/状态）
            for r in rows:
                # 共享电表 brand_id 为 NULL，需用 IS NULL 匹配
                brand_cond = "m.brand_id IS NULL" if r["key"] is None else "m.brand_id = %s"
                brand_vals = (period,) if r["key"] is None else (period, r["key"])
                cur.execute(f"""
                    SELECT m.meter_name AS station_name, m.meter_no, m.meter_name,
                           m.transformer_ratio,
                           m.brand_id, b.name AS brand_name,
                           d.kwh, d.pay_unit_price, d.pay_amount, d.collect_unit_price,
                           d.collect_amount, d.collect_net,
                           e.pay_status, e.collect_status, e.data_source
                    FROM electricity_meter_details d
                    JOIN electricity_records e ON e.id = d.electricity_id
                    JOIN meters m ON d.meter_id = m.id
                    LEFT JOIN brands b ON m.brand_id = b.id
                    WHERE e.period = %s AND {brand_cond}
                    ORDER BY m.meter_name, m.meter_no
                """, brand_vals)
                r["details"] = cur.fetchall()
        else:
            # 场地维度：台账按 landlord 聚合（v3 直挂）
            cur.execute("""
                SELECT e.landlord_id AS key, COALESCE(l.name, '未指定场地') AS name,
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
                WHERE e.period = %s
                GROUP BY e.landlord_id, l.name
                ORDER BY name
            """, (period,))
            rows = cur.fetchall()
            # 场地明细：该场地该月的 电表行（含 互感器倍数/单价/金额/状态）
            for r in rows:
                cur.execute("""
                    SELECT m.meter_name, m.meter_no, m.meter_name AS station_name,
                           m.transformer_ratio,
                           m.brand_id, b.name AS brand_name,
                           d.kwh, d.pay_unit_price, d.pay_amount, d.collect_unit_price,
                           d.collect_amount, d.collect_net,
                           e.pay_status, e.collect_status, e.data_source
                    FROM electricity_meter_details d
                    JOIN electricity_records e ON e.id = d.electricity_id
                    JOIN meters m ON d.meter_id = m.id
                    LEFT JOIN brands b ON m.brand_id = b.id
                    WHERE e.period = %s AND m.landlord_id = %s
                    ORDER BY m.meter_name, m.meter_no
                """, (period, r["key"]))
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
    period = str(period).replace("-", "")
    allowed = scope_landlord_ids(request)

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 每电表一行：台账明细 + 电表 + 抄表读数(meter_monthly) + 场地/品牌/实体 + 运营费用
        cur.execute("""
            SELECT
                d.id AS detail_id,
                m.id AS meter_id, m.meter_no, m.meter_name, m.transformer_ratio,
                l.id AS landlord_id, l.name AS landlord_name, l.company_share,
                b.id AS brand_id, b.name AS brand_name,
                ent.name AS entity_name,
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
            LEFT JOIN brands b ON m.brand_id = b.id
            LEFT JOIN entities ent ON m.entity_id = ent.id
            LEFT JOIN meter_monthly mm
                   ON mm.address = m.meter_no AND mm.month_period = %s
            LEFT JOIN operating_expenses op
                   ON op.landlord_id = m.landlord_id AND op.period = %s
            WHERE e.period = %s
            ORDER BY l.name, b.name, m.meter_name, m.meter_no
        """, (period, period, period))
        rows = cur.fetchall()
    finally:
        cur.close()
        conn.close()

    # 权限过滤（股东只看关联场地）
    if allowed is not None:
        rows = [r for r in rows if r.get("landlord_id") in allowed]

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

        # 分组键：dim=brand 按品牌，否则按场地
        if dim == "brand":
            group = r.get("brand_name") or "全品牌共享"
            group_key = f"brand-{r.get('brand_id') or 0}"
            collect_company = r.get("entity_name") or group  # 收款公司：实体优先，兜底品牌
        else:
            group = r.get("landlord_name") or "未指定场地"
            group_key = f"landlord-{r.get('landlord_id') or 0}"
            collect_company = r.get("entity_name") or group

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
