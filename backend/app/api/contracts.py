from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from ..repositories import contract_repo
from ..infra.auth_scope import scope_landlord_ids
from ..infra.database import get_connection, get_dict_cursor
from .base import CamelJSONResponse
import openpyxl
from io import BytesIO
from datetime import datetime

router = APIRouter(prefix="/api/contracts", tags=["合同管理"], default_response_class=CamelJSONResponse)


@router.get("")
async def list_contracts(request: Request, brandId: int = None, landlordId: int = None, stationId: int = None, contractType: str = None, keyword: str = None):
    # 股东：只能看到关联场地的合同
    allowed = scope_landlord_ids(request)
    return contract_repo.list_contracts(
        brand_id=brandId, landlord_id=landlordId, station_id=stationId,
        contract_type=contractType, keyword=keyword,
        allowed_landlord_ids=allowed,
    )


@router.post("", status_code=201)
async def create_contract(data: dict, request: Request):
    operator = (getattr(request.state, "current_user", None) or {}).get("name")
    try:
        result = contract_repo.create_contract(data, operator)
    except ValueError as e:
        raise HTTPException(400, str(e))
    # 动态生成：合同保存后，自动生成该场地所有实表电表有读数月份的台账
    from .electricity import auto_generate_for_landlord
    try:
        await auto_generate_for_landlord(result.get("landlord_id") or data.get("landlordId"))
    except Exception:
        pass  # 自动生成失败不影响合同保存（可手动点「自动生成」）
    # 分红联动：合同变更后重算该场地已有分红记录（失败不影响合同保存）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        refresh_dividend_records(result.get("landlord_id") or data.get("landlordId"))
    except Exception:
        pass
    return result


# ─── Excel 导入辅助函数 ─────────────────────────────────────

def _parse_date(val) -> str | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.strftime("%Y-%m-%d")
    s = str(val).strip()
    if not s:
        return None
    for fmt in ("%Y.%m.%d", "%Y/%m/%d", "%Y-%m-%d", "%Y年%m月%d日"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None

def _num(val):
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None

def _str(val) -> str | None:
    if val is None:
        return None
    s = str(val).strip()
    return s if s else None

def _get_or_create_landlord(name: str, contact: str = None) -> int:
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id, contact FROM landlords WHERE name = %s", (name,))
        row = cur.fetchone()
        if row:
            # 已存在的场地方：负责人为空时补填
            if contact and not row.get("contact"):
                cur.execute("UPDATE landlords SET contact = %s WHERE id = %s", (contact, row["id"]))
                conn.commit()
            return row["id"]
        cur.execute("INSERT INTO landlords (name, contact) VALUES (%s, %s) RETURNING id", (name, contact))
        conn.commit()
        return cur.fetchone()["id"]
    finally:
        cur.close()
        conn.close()

def _get_or_create_brand(name: str) -> int:
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

def _find_landlord_id(name: str) -> int | None:
    if not name:
        return None
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id FROM landlords WHERE name = %s", (name,))
        row = cur.fetchone()
        return row["id"] if row else None
    finally:
        cur.close()
        conn.close()

def _find_brand_id(name: str) -> int | None:
    if not name:
        return None
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id FROM brands WHERE name = %s", (name,))
        row = cur.fetchone()
        return row["id"] if row else None
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

def _get_or_create_entity(name: str) -> int:
    """按名称找公司主体（entities），不存在则创建"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id FROM entities WHERE name = %s", (name,))
        row = cur.fetchone()
        if row:
            return row["id"]
        cur.execute("INSERT INTO entities (name) VALUES (%s) RETURNING id", (name,))
        conn.commit()
        return cur.fetchone()["id"]
    finally:
        cur.close()
        conn.close()


# ─── Excel 导入列映射 ────────────────────────────────────────
# 优先按表头名解析列位（兼容 2026-09 新版模板：B 列新增「公司收款主体」、
# 删除备注/承担成本列）；无表头时回退到旧版固定列位。
_IMPORT_COLS = {
    "ct_venue":          (0,  ["合同类型(场地)"]),
    "entity_name":       (None, ["公司收款主体", "公司主体"]),
    "landlord_name":     (3,  ["地址"]),
    "venue_contact":     (1,  ["场地方"]),
    "region":            (2,  ["区域"]),
    "address":           (3,  ["地址"]),
    "rent_amount":       (4,  ["场地年租金(元)", "场地年租金"]),
    "monthly_rent":      (5,  ["场地月租金(元)", "场地月租金"]),
    "elec_pay_price":    (6,  ["电费单价(元/度)", "电费单价"]),
    "pay_method_venue":  (7,  ["场地租金付款方式"]),
    "deposit_venue":     (8,  ["场地押金(元)", "场地押金"]),
    "rent_advance_days": (9,  ["场地租金提前支付(天)", "场地租金提前支付"]),
    "start_date_venue":  (10, ["场地合同开始日期"]),
    "end_date_venue":    (11, ["场地合同结束日期"]),
    "remark_venue":      (12, ["备注"]),
    "ct_brand":          (13, ["合同类型(品牌)"]),
    "brand_name":        (14, ["品牌方"]),
    "rent_calc_method":  (15, ["计费方式"]),
    "unit_monthly_rent": (16, ["单柜场地月租金(元)", "单柜场地月租金"]),
    "cabinets_count":    (17, ["计费柜数"]),
    "brand_monthly_rent": (18, ["品牌场地月租金(元)", "品牌场地月租金"]),
    "brand_rent_amount": (19, ["品牌合同年租金(元)", "品牌合同年租金"]),
    "brand_elec_price":  (21, ["电费收款单价(税前·元/度)", "电费收款单价"]),
    "pay_method_brand":  (22, ["场地租金收款方式"]),
    "deposit_brand":     (23, ["品牌押金(元)", "品牌押金"]),
    "first_month_rent":  (24, ["首月场地租金(元)", "首月场地租金"]),
    "rent_refund":       (25, ["场地费退款(元)", "场地费退款"]),
    "elec_tax_pct":      (26, ["电费税率（%）", "电费税率(%)"]),
    "rent_tax_pct":      (27, ["场地费税率（%）", "场地费税率(%)"]),
    "start_date_brand":  (28, ["品牌合同开始日期"]),
    "end_date_brand":    (29, ["品牌合同结束日期"]),
    "remark_brand":      (30, ["品牌备注", "备注"]),
}


def _resolve_import_cols(header_row) -> dict:
    """按表头行解析列索引；表头缺失的键回退到旧版固定列位"""
    header_map = {}
    if header_row:
        for i, h in enumerate(header_row):
            if h is not None and str(h).strip():
                header_map[str(h).strip()] = i
    known = sum(1 for _, names in _IMPORT_COLS.values() for n in names if n in header_map)
    resolved = {}
    for key, (fallback, names) in _IMPORT_COLS.items():
        idx = next((header_map[n] for n in names if n in header_map), None)
        resolved[key] = idx if idx is not None else (fallback if known >= 3 else fallback)
    return resolved


# ─── Excel 导入端点（必须在 /{contract_id} 之前）─────────────

@router.post("/import")
async def import_contracts(request: Request, file: UploadFile = File(...)):
    """Import contracts from Excel file（场地信息关联表 测试2 格式）

    列布局（sheet「收付款合同」，第 3 行为表头，按列名解析、兼容新旧模板）：
      场地合同：类型/公司收款主体/场地方/区域/地址/年租金/月租金(可空→年/12)/电费单价/付款方式/押金/提前天数/开始/结束[/备注]
      品牌合同：类型/品牌方/计费方式/单柜月租/柜数/品牌月租(可空)/品牌年租(可空)/电费收款单价/收款方式/押金/首月租金/退款/电费税率%/场地费税率%/开始/结束
    「公司收款主体」→ 公司主体（entities，不存在自动创建），写入场地与品牌合同的 entity_id。
    场地合同：计费方式固定为「固定价格」，租金（年/月）以 Excel 为准。
    品牌合同：场地方尚未关联电表 → 计费柜数、品牌年租金不导入；
              品牌月租/电费收款单价/收款方式以 Excel 为准。
    品牌合同无"关联场地"列：按顺序关联前一行场地合同对应的场地方。
    """
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(400, "请上传Excel文件(.xlsx)")

    content = await file.read()
    try:
        wb = openpyxl.load_workbook(BytesIO(content), data_only=True)
    except Exception as e:
        raise HTTPException(400, f"无法读取Excel文件: {str(e)}")

    ws = None
    for name in wb.sheetnames:
        if "合同" in name or "收付" in name:
            ws = wb[name]
            break
    if ws is None:
        ws = wb[wb.sheetnames[0]]

    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if len(rows) < 4:
        raise HTTPException(400, "Excel文件数据不足，至少需要4行")

    # 列位解析：第 3 行为表头（按列名匹配，兼容新旧模板）；无表头回退旧版固定列位
    cols = _resolve_import_cols(rows[2] if len(rows) > 2 else None)

    def _cell(row, key):
        i = cols.get(key)
        if i is None or i >= len(row):
            return None
        return row[i]

    results = {
        "imported": 0,
        "skipped": 0,
        "errors": [],
        "created_landlords": [],
        "created_brands": [],
        "created_entities": [],
    }

    current_landlord_id = None
    current_landlord_name = None

    for row_idx, row in enumerate(rows[3:], start=4):
        try:
            ct_venue = _str(_cell(row, "ct_venue"))          # 合同类型(场地)
            entity_name = _str(_cell(row, "entity_name"))    # 公司收款主体 → 公司主体
            landlord_name = _str(_cell(row, "landlord_name"))  # 「地址」列 = 场地方（场地本身）
            venue_contact = _str(_cell(row, "venue_contact"))  # 「场地方」列 = 场地负责人 → 存入联系人
            region = _str(_cell(row, "region"))              # 区域
            address = _str(_cell(row, "address"))            # 地址
            rent_amount = _num(_cell(row, "rent_amount"))    # 场地年租金
            monthly_rent = _num(_cell(row, "monthly_rent"))  # 场地月租金（可空 → 年/12）
            elec_pay_price = _num(_cell(row, "elec_pay_price"))  # 电费付款单价
            pay_method_venue = _str(_cell(row, "pay_method_venue"))  # 场地租金付款方式
            deposit_venue = _num(_cell(row, "deposit_venue"))  # 场地押金
            rent_advance_days = _num(_cell(row, "rent_advance_days"))  # 提前支付天数
            start_date_venue = _parse_date(_cell(row, "start_date_venue"))
            end_date_venue = _parse_date(_cell(row, "end_date_venue"))
            remark_venue = _str(_cell(row, "remark_venue"))

            ct_brand = _str(_cell(row, "ct_brand"))          # 合同类型(品牌)
            brand_name = _str(_cell(row, "brand_name"))      # 品牌方
            rent_calc_method = _str(_cell(row, "rent_calc_method"))  # 计费方式
            unit_monthly_rent = _num(_cell(row, "unit_monthly_rent"))  # 单柜场地月租金
            cabinets_count = _num(_cell(row, "cabinets_count"))  # 计费柜数
            brand_monthly_rent = _num(_cell(row, "brand_monthly_rent"))  # 品牌场地月租金（可空）
            brand_rent_amount = _num(_cell(row, "brand_rent_amount"))  # 品牌合同年租金（可空）
            brand_elec_price = _num(_cell(row, "brand_elec_price"))  # 电费收款单价
            pay_method_brand = _str(_cell(row, "pay_method_brand"))  # 场地租金收款方式
            deposit_brand = _num(_cell(row, "deposit_brand"))  # 品牌押金
            first_month_rent = _num(_cell(row, "first_month_rent"))  # 首月场地租金
            rent_refund = _num(_cell(row, "rent_refund"))    # 场地费退款
            elec_tax_pct = _num(_cell(row, "elec_tax_pct"))  # 电费税率(%)
            rent_tax_pct = _num(_cell(row, "rent_tax_pct"))  # 场地费税率(%)
            start_date_brand = _parse_date(_cell(row, "start_date_brand"))
            end_date_brand = _parse_date(_cell(row, "end_date_brand"))
            remark_brand = _str(_cell(row, "remark_brand"))

            # 公司收款主体 → 公司主体（entities，不存在则自动创建）
            entity_id = None
            if entity_name:
                entity_id = _find_entity_id(entity_name)
                if entity_id is None:
                    entity_id = _get_or_create_entity(entity_name)
                    if entity_name not in results["created_entities"]:
                        results["created_entities"].append(entity_name)

            is_venue = ct_venue and "场地" in ct_venue
            is_brand = ct_brand and "品牌" in ct_brand

            if not is_venue and not is_brand:
                continue

            # 注意：场地合同与品牌合同可能出现在同一行（场地行合并单元格的首行 = 第一个品牌行）。
            # 必须各自独立处理：场地块更新 current_landlord 后，同行的品牌继续用该场地。
            if is_venue:
                if not landlord_name:
                    results["errors"].append(f"第{row_idx}行: 场地方名称为空")
                else:
                    landlord_id = _find_landlord_id(landlord_name)
                    if landlord_id is None:
                        landlord_id = _get_or_create_landlord(landlord_name, venue_contact)
                        results["created_landlords"].append(landlord_name)
                    else:
                        # 已存在的场地方：补填负责人
                        _get_or_create_landlord(landlord_name, venue_contact)

                    current_landlord_id = landlord_id
                    current_landlord_name = landlord_name
                    # 「场地方」列实为场地负责人 → 同步为该场地方的业主记录
                    if venue_contact:
                        from ..repositories.directory_repo import ensure_landlord_owner
                        ensure_landlord_owner(landlord_id, venue_contact)

                    # 月租缺失 → 年租/12
                    if monthly_rent is None and rent_amount:
                        monthly_rent = round(rent_amount / 12, 2)
                    pm = pay_method_venue or "月付"

                    # Check duplicate
                    conn = get_connection()
                    cur = get_dict_cursor(conn)
                    try:
                        cur.execute("""
                            SELECT id FROM contracts
                            WHERE contract_type = '场地合同' AND landlord_id = %s
                              AND start_date = %s AND end_date = %s
                        """, (landlord_id, start_date_venue, end_date_venue))
                        existing = cur.fetchone()
                    finally:
                        cur.close()
                        conn.close()

                    if existing:
                        results["skipped"] += 1
                        results["errors"].append(f"第{row_idx}行: 场地合同已存在（{landlord_name}），跳过")
                    else:
                        contract_data = {
                            "contractType": "场地合同",
                            "landlordId": landlord_id,
                            "entityId": entity_id,
                            # 场地租金以 Excel 数值为准 → 计费方式固定为「固定价格」
                            "rentCalcMethod": "固定价格",
                            "region": region,
                            "address": address,
                            "rentAmount": rent_amount,
                            "monthlyRent": monthly_rent,
                            "electricityPrice": elec_pay_price,
                            "payMethod": pm,
                            "deposit": deposit_venue,
                            "rentAdvanceDays": int(rent_advance_days) if rent_advance_days else 0,
                            "startDate": start_date_venue,
                            "endDate": end_date_venue,
                            "remark": remark_venue,
                        }
                        contract_repo.create_contract(contract_data, operator="Excel导入")
                        results["imported"] += 1

            if is_brand:
                if not current_landlord_id:
                    results["errors"].append(f"第{row_idx}行: 品牌合同前缺少场地合同行，无法关联场地方")
                    continue
                landlord_id = current_landlord_id

                if not brand_name:
                    results["errors"].append(f"第{row_idx}行: 品牌方名称为空")
                    continue

                brand_id = _find_brand_id(brand_name)
                if brand_id is None:
                    brand_id = _get_or_create_brand(brand_name)
                    results["created_brands"].append(brand_name)

                is_fixed = rent_calc_method and "固定" in rent_calc_method
                rcm = "固定价格" if is_fixed else "按柜子数量"

                # 2026-09 新规：场地方尚未关联电表 → 计费柜数、品牌年租金不使用 Excel 值；
                # 品牌月租 / 电费收款单价 / 收款方式 以 Excel 为准。
                # 固定计费且月租缺失时，用单柜月租/12 推导（不再按柜数推算）
                if brand_monthly_rent is None and is_fixed and unit_monthly_rent:
                    brand_monthly_rent = round(unit_monthly_rent / 12, 2)
                brand_rent_amount = None

                pm = pay_method_brand or "月付"

                # 税率（% → 小数）+ 税后单价
                elec_tax_rate = round((elec_tax_pct or 0) / 100, 4) if elec_tax_pct else None
                rent_tax_rate = round((rent_tax_pct or 0) / 100, 4) if rent_tax_pct else None
                post_tax_elec = round(brand_elec_price * (1 - elec_tax_rate), 4) if brand_elec_price and elec_tax_rate else None
                post_tax_rent = round(brand_monthly_rent * (1 - rent_tax_rate), 2) if brand_monthly_rent and rent_tax_rate else None

                # Check duplicate
                conn = get_connection()
                cur = get_dict_cursor(conn)
                try:
                    cur.execute("""
                        SELECT id FROM contracts
                        WHERE contract_type = '品牌方合同' AND landlord_id = %s AND brand_id = %s
                          AND start_date = %s AND end_date = %s
                    """, (landlord_id, brand_id, start_date_brand, end_date_brand))
                    existing = cur.fetchone()
                finally:
                    cur.close()
                    conn.close()

                if existing:
                    results["skipped"] += 1
                    results["errors"].append(f"第{row_idx}行: 品牌方合同已存在（{current_landlord_name} - {brand_name}），跳过")
                    continue

                contract_data = {
                    "contractType": "品牌方合同",
                    "landlordId": landlord_id,
                    "brandId": brand_id,
                    "entityId": entity_id,
                    "rentCalcMethod": rcm,
                    "unitMonthlyRent": unit_monthly_rent,
                    # 计费柜数/年租金不导入（场地方未关联电表前无意义），电表关联后由实时口径接管
                    "monthlyRent": brand_monthly_rent,
                    "electricityPrice": brand_elec_price,
                    "payMethod": pm,
                    "deposit": deposit_brand,
                    "firstMonthRent": first_month_rent,
                    "rentRefund": rent_refund,
                    "taxEnabled": bool(elec_tax_rate and elec_tax_rate > 0),
                    "taxRate": elec_tax_rate or 0.01,
                    "postTaxElectricityPrice": post_tax_elec,
                    "rentTaxEnabled": bool(rent_tax_rate and rent_tax_rate > 0),
                    "rentTaxRate": rent_tax_rate or 0.01,
                    "postTaxRentPrice": post_tax_rent,
                    "startDate": start_date_brand,
                    "endDate": end_date_brand,
                    "remark": remark_brand,
                }
                contract_repo.create_contract(contract_data, operator="Excel导入")
                results["imported"] += 1

        except Exception as e:
            results["errors"].append(f"第{row_idx}行: {str(e)}")

    return results


# ─── 合同 CRUD ──────────────────────────────────────────────

@router.put("/{contract_id}")
async def update_contract(contract_id: int, data: dict, request: Request):
    operator = (getattr(request.state, "current_user", None) or {}).get("name")
    try:
        result = contract_repo.update_contract(contract_id, data, operator)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not result:
        raise HTTPException(404, "合同不存在")
    # 动态生成：合同变更后，自动生成该场地所有实表电表有读数月份的台账
    from .electricity import auto_generate_for_landlord
    try:
        await auto_generate_for_landlord(result.get("landlord_id") or data.get("landlordId"))
    except Exception:
        pass  # 自动生成失败不影响合同保存（可手动点「自动生成」）
    # 分红联动：合同变更后重算该场地已有分红记录（失败不影响合同保存）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        refresh_dividend_records(result.get("landlord_id") or data.get("landlordId"))
    except Exception:
        pass
    return result


@router.delete("/{contract_id}")
async def delete_contract(contract_id: int, request: Request):
    operator = (getattr(request.state, "current_user", None) or {}).get("name")
    landlord_id = contract_repo.delete_contract(contract_id, operator)
    # 分红联动：合同删除后重算该场地已有分红记录（失败不影响删除）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        refresh_dividend_records(landlord_id)
    except Exception:
        pass
    return {"ok": True}


@router.get("/{contract_id}/audit")
async def get_contract_audit(contract_id: int):
    """合同变更审计记录（倒序，最多 50 条）"""
    return contract_repo.list_audit(contract_id)
