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
    """Import contracts from Excel file"""
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
            contract_type_venue = _str(row[0])  # A
            landlord_name = _str(row[1])  # B
            region = _str(row[2])  # C
            address = _str(row[3])  # D
            rent_amount = _num(row[4])  # E
            monthly_rent = _num(row[5])  # F
            electricity_price = _num(row[6])  # G
            pay_method_venue = _str(row[7])  # H
            deposit_venue = _num(row[8])  # I
            rent_advance_days = _num(row[9])  # J
            start_date_venue = _parse_date(row[10])  # K
            end_date_venue = _parse_date(row[11])  # L
            remark_venue = _str(row[12])  # M

            contract_type_brand = _str(row[13])  # N
            linked_landlord = _str(row[14])  # O
            brand_name = _str(row[15])  # P
            rent_calc_method = _str(row[16])  # Q
            unit_monthly_rent = _num(row[17])  # R
            cabinets_count = _num(row[18])  # S
            brand_monthly_rent = _num(row[19])  # T
            brand_rent_amount = _num(row[20])  # U
            brand_electricity_price = _num(row[22])  # W
            pay_method_brand = _str(row[23])  # X
            deposit_brand = _num(row[24])  # Y
            first_month_rent = _num(row[25])  # Z
            rent_refund = _num(row[26])  # AA
            start_date_brand = _parse_date(row[29])  # AD
            end_date_brand = _parse_date(row[30])  # AE
            remark_brand = _str(row[31])  # AF

            is_venue = contract_type_venue and "场地" in contract_type_venue
            is_brand = contract_type_brand and "品牌" in contract_type_brand

            if not is_venue and not is_brand:
                continue

            if is_venue:
                if not landlord_name:
                    results["errors"].append(f"第{row_idx}行: 场地方名称为空")
                    continue

                landlord_id = _find_landlord_id(landlord_name)
                if landlord_id is None:
                    landlord_id = _get_or_create_landlord(landlord_name)
                    results["created_landlords"].append(landlord_name)

                current_landlord_id = landlord_id
                current_landlord_name = landlord_name

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
                    continue

                contract_data = {
                    "contractType": "场地合同",
                    "landlordId": landlord_id,
                    "region": region,
                    "address": address,
                    "rentAmount": rent_amount,
                    "monthlyRent": monthly_rent,
                    "electricityPrice": electricity_price,
                    "payMethod": pm,
                    "deposit": deposit_venue,
                    "rentAdvanceDays": int(rent_advance_days) if rent_advance_days else 0,
                    "startDate": start_date_venue,
                    "endDate": end_date_venue,
                    "remark": remark_venue,
                }
                contract_repo.create_contract(contract_data)
                results["imported"] += 1

            elif is_brand:
                landlord_lookup = linked_landlord or current_landlord_name
                if not landlord_lookup:
                    results["errors"].append(f"第{row_idx}行: 品牌合同缺少关联场地方")
                    continue

                landlord_id = _find_landlord_id(landlord_lookup)
                if landlord_id is None:
                    landlord_id = _get_or_create_landlord(landlord_lookup)
                    results["created_landlords"].append(landlord_lookup)

                if not brand_name:
                    results["errors"].append(f"第{row_idx}行: 品牌方名称为空")
                    continue

                brand_id = _find_brand_id(brand_name)
                if brand_id is None:
                    brand_id = _get_or_create_brand(brand_name)
                    results["created_brands"].append(brand_name)

                rcm = "按柜子数量"
                if rent_calc_method:
                    if "固定" in rent_calc_method:
                        rcm = "固定价格"
                    elif "柜" in rent_calc_method:
                        rcm = "按柜子数量"

                pm = pay_method_brand or "月付"

                mr = brand_monthly_rent
                if mr is None and unit_monthly_rent and cabinets_count:
                    mr = unit_monthly_rent * cabinets_count

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
                    results["errors"].append(f"第{row_idx}行: 品牌方合同已存在（{landlord_lookup} - {brand_name}），跳过")
                    continue

                contract_data = {
                    "contractType": "品牌方合同",
                    "landlordId": landlord_id,
                    "brandId": brand_id,
                    "rentCalcMethod": rcm,
                    "unitMonthlyRent": unit_monthly_rent,
                    "cabinetsCount": cabinets_count,
                    "monthlyRent": mr,
                    "rentAmount": brand_rent_amount,
                    "electricityPrice": brand_electricity_price,
                    "payMethod": pm,
                    "deposit": deposit_brand,
                    "firstMonthRent": first_month_rent,
                    "rentRefund": rent_refund,
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
    return result


@router.delete("/{contract_id}")
async def delete_contract(contract_id: int):
    contract_repo.delete_contract(contract_id)
    return {"ok": True}
