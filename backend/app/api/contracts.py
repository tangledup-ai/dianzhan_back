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
async def create_contract(data: dict):
    result = contract_repo.create_contract(data)
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

def _get_or_create_landlord(name: str) -> int:
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


# ─── Excel 导入端点（必须在 /{contract_id} 之前）─────────────

@router.post("/import")
async def import_contracts(request: Request, file: UploadFile = File(...)):
    """Import contracts from Excel file（场地信息关联表 测试2 格式）

    列布局（sheet1）：
      场地合同 A~M：类型/场地方/区域/地址/年租金/月租金(可空→年/12)/电费单价/付款方式/押金/提前天数/开始/结束/备注
      品牌合同 N~AE：类型/品牌方/计费方式/单柜月租/柜数/品牌月租(可空)/品牌年租(可空)/承担成本(忽略)/
                     电费收款单价/收款方式/押金/首月租金/退款/电费税率%/场地费税率%/开始/结束/备注
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

    results = {
        "imported": 0,
        "skipped": 0,
        "errors": [],
        "created_landlords": [],
        "created_brands": [],
    }

    current_landlord_id = None
    current_landlord_name = None

    for row_idx, row in enumerate(rows[3:], start=4):
        try:
            ct_venue = _str(row[0])   # A 合同类型(场地)
            landlord_name = _str(row[1])  # B 场地方
            region = _str(row[2])     # C 区域
            address = _str(row[3])    # D 地址
            rent_amount = _num(row[4])   # E 场地年租金
            monthly_rent = _num(row[5])  # F 场地月租金（可空 → 年/12）
            elec_pay_price = _num(row[6])  # G 电费付款单价
            pay_method_venue = _str(row[7])  # H 场地租金付款方式
            deposit_venue = _num(row[8])  # I 场地押金
            rent_advance_days = _num(row[9])  # J 提前支付天数
            start_date_venue = _parse_date(row[10])  # K
            end_date_venue = _parse_date(row[11])  # L
            remark_venue = _str(row[12])  # M

            ct_brand = _str(row[13])   # N 合同类型(品牌)
            brand_name = _str(row[14])  # O 品牌方
            rent_calc_method = _str(row[15])  # P 计费方式
            unit_monthly_rent = _num(row[16])  # Q 单柜场地月租金
            cabinets_count = _num(row[17])  # R 计费柜数
            brand_monthly_rent = _num(row[18])  # S 品牌场地月租金（可空）
            brand_rent_amount = _num(row[19])  # T 品牌合同年租金（可空）
            # row[20] U 承担场地成本（分摊计算值，忽略）
            brand_elec_price = _num(row[21])  # V 电费收款单价
            pay_method_brand = _str(row[22])  # W 场地租金收款方式
            deposit_brand = _num(row[23])  # X 品牌押金
            first_month_rent = _num(row[24])  # Y 首月场地租金
            rent_refund = _num(row[25])  # Z 场地费退款
            elec_tax_pct = _num(row[26])  # AA 电费税率(%)
            rent_tax_pct = _num(row[27])  # AB 场地费税率(%)
            start_date_brand = _parse_date(row[28])  # AC
            end_date_brand = _parse_date(row[29])  # AD
            remark_brand = _str(row[30])  # AE

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
                        landlord_id = _get_or_create_landlord(landlord_name)
                        results["created_landlords"].append(landlord_name)

                    current_landlord_id = landlord_id
                    current_landlord_name = landlord_name

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
                        contract_repo.create_contract(contract_data)
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

                # 品牌月租：按柜 → 单柜×柜数；固定租金 → Q 视为年租金/12
                if brand_monthly_rent is None:
                    if is_fixed:
                        brand_monthly_rent = round((unit_monthly_rent or 0) / 12, 2) if unit_monthly_rent else None
                    elif unit_monthly_rent and cabinets_count:
                        brand_monthly_rent = round(unit_monthly_rent * cabinets_count, 2)
                # 品牌年租：缺失 → 固定租金用 Q（年租金）；按柜 → 月租×12
                if brand_rent_amount is None:
                    if is_fixed:
                        brand_rent_amount = unit_monthly_rent
                    elif brand_monthly_rent:
                        brand_rent_amount = round(brand_monthly_rent * 12, 2)

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
                    "rentCalcMethod": rcm,
                    "unitMonthlyRent": unit_monthly_rent,
                    "cabinetsCount": cabinets_count,
                    "monthlyRent": brand_monthly_rent,
                    "rentAmount": brand_rent_amount,
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
                contract_repo.create_contract(contract_data)
                results["imported"] += 1

        except Exception as e:
            results["errors"].append(f"第{row_idx}行: {str(e)}")

    return results


# ─── 合同 CRUD ──────────────────────────────────────────────

@router.put("/{contract_id}")
async def update_contract(contract_id: int, data: dict):
    result = contract_repo.update_contract(contract_id, data)
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
async def delete_contract(contract_id: int):
    landlord_id = contract_repo.delete_contract(contract_id)
    # 分红联动：合同删除后重算该场地已有分红记录（失败不影响删除）
    try:
        from ..domain.dividend_refresh import refresh_dividend_records
        refresh_dividend_records(landlord_id)
    except Exception:
        pass
    return {"ok": True}
