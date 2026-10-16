# -*- coding: utf-8 -*-
"""从 huandian_v2 导出真实数据 → 生成 src/mocks/index.ts

策略：
- 档案/站点/电表/合同/台账/分红/配置/审批/柜子/运营费用 → 全量真实导出
- 能耗明细(meter_daily/hourly/status_cache) 不导（量巨大，前端用示例）
- meter_monthly 全量导出为 mockMeterMonthly（供 mockClient 读数接口按电表过滤）
- 聚合(mockOverview 等) 从真实表现场聚合
"""
import psycopg2, json, re, datetime

HOST = "127.0.0.1"; USER = "quant"; PWD = "CHANGE_ME_DB_PASSWORD"; DB = "huandian_v2"
OUT = r"src\mocks\index.ts"

conn = psycopg2.connect(host=HOST, user=USER, password=PWD, dbname=DB)
cur = conn.cursor()

def q(sql, params=None):
    cur.execute(sql, params or ())
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]

# ── TS 序列化 ────────────────────────────────────────────────
def ts(v):
    """Python 值 → TS 字面量（字符串用 json.dumps 完整转义，避免换行/引号/反斜杠破坏语法）"""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int,)):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, decimal.Decimal):
        return repr(float(v))
    if isinstance(v, (datetime.date, datetime.datetime)):
        return json.dumps(str(v)[:10], ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(ts(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ", ".join(f"{k}: {ts(x)}" for k, x in v.items()) + "}"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    return repr(v)

import decimal

def camel(d):
    """snake_case dict → camelCase dict"""
    out = {}
    for k, v in d.items():
        parts = k.split("_")
        ck = parts[0] + "".join(p.capitalize() for p in parts[1:])
        out[ck] = v
    return out

def fmt(v):
    """数值 → number 或 null"""
    if v is None:
        return None
    return float(v)

# ── 档案域 ───────────────────────────────────────────────────
mockBrands = [camel(r) for r in q("SELECT * FROM brands ORDER BY id")]
mockEntities = [camel(r) for r in q("SELECT * FROM entities ORDER BY id")]
mockLandlords = [camel(r) for r in q("SELECT * FROM landlords ORDER BY id")]
mockShareholders = [camel(r) for r in q("SELECT * FROM shareholders ORDER BY id")]
mockIntroducers = [camel(r) for r in q("SELECT * FROM introducers ORDER BY id")]
mockEntityBrands = [camel(r) for r in q("SELECT eb.*, e.name AS entity_name, b.name AS brand_name FROM entity_brands eb JOIN entities e ON eb.entity_id=e.id JOIN brands b ON eb.brand_id=b.id ORDER BY eb.id")]
mockThirdPartyConfigs = [camel(r) for r in q("SELECT * FROM third_party_configs ORDER BY id")]
mockPlatformUsers = [camel(r) for r in q("""
    SELECT u.*, s.name AS shareholder_name FROM platform_users u
    LEFT JOIN shareholders s ON u.shareholder_id = s.id ORDER BY u.id""")]

# ── 站点 + 电表（站点从电表带出品牌/倍率/柜数）────────────────
mockStations = []
for r in q("SELECT * FROM stations ORDER BY id"):
    s = camel(r)
    m = q("SELECT id, meter_no, brand_id, transformer_ratio FROM meters WHERE station_id=%s ORDER BY id LIMIT 1", (r["id"],))
    s["brandId"] = m[0]["brand_id"] if m else None
    s["meterNo"] = m[0]["meter_no"] if m else None
    s["transformerRatio"] = float(m[0]["transformer_ratio"]) if m and m[0]["transformer_ratio"] else 1
    c = q("SELECT COUNT(*) AS n FROM cabinets cab JOIN meters mt ON cab.meter_id=mt.id WHERE mt.station_id=%s", (r["id"],))
    s["cabinets"] = c[0]["n"] if c else 0
    s["storageCabinets"] = 0
    mockStations.append(s)

mockMeters = [camel(r) for r in q("""
    SELECT m.*, s.name AS station_name, b.name AS brand_name, l.name AS landlord_name, e.name AS entity_name
    FROM meters m
    LEFT JOIN stations s ON m.station_id = s.id
    LEFT JOIN brands b ON m.brand_id = b.id
    LEFT JOIN landlords l ON m.landlord_id = l.id
    LEFT JOIN entities e ON m.entity_id = e.id
    ORDER BY m.id""")]
for m in mockMeters:
    m["transformerRatio"] = fmt(m.get("transformerRatio"))

mockCabinets = [camel(r) for r in q("SELECT * FROM cabinets ORDER BY id")]

# ── 合同 + 分期 ───────────────────────────────────────────────
mockContracts = [camel(r) for r in q("""
    SELECT c.*, l.name AS landlord_name, b.name AS brand_name, s.name AS station_name_ref
    FROM contracts c
    LEFT JOIN landlords l ON c.landlord_id = l.id
    LEFT JOIN brands b ON c.brand_id = b.id
    LEFT JOIN stations s ON c.station_id = s.id
    ORDER BY c.id""")]
for c in mockContracts:
    for k in ("electricityPrice","monthlyRent","unitMonthlyRent","rentAmount","cabinetsCount","deposit","firstMonthRent","rentRefund","rentTaxRate","taxRate","postTaxElectricityPrice","postTaxRentPrice","rentAdvanceDays"):
        if c.get(k) is not None:
            c[k] = float(c[k])

mockContractSchedules = []
for r in q("SELECT *, 'payment' AS side FROM rent_payment_schedule ORDER BY contract_id, seq"):
    mockContractSchedules.append(camel(r))
for r in q("SELECT *, 'income' AS side FROM rent_income_schedule ORDER BY contract_id, seq"):
    mockContractSchedules.append(camel(r))

# ── 电费台账 + 明细 ───────────────────────────────────────────
mockElectricity = []
for r in q("""
    SELECT e.*, s.name AS station_name FROM electricity_records e
    LEFT JOIN stations s ON e.station_id = s.id ORDER BY e.period DESC, e.station_id"""):
    rec = camel(r)
    details = q("""
        SELECT d.*, m.meter_no, m.meter_name FROM electricity_meter_details d
        LEFT JOIN meters m ON d.meter_id = m.id WHERE d.electricity_id=%s ORDER BY d.id""", (r["id"],))
    rec["meterDetails"] = [camel(x) for x in details]
    for k in ("payStartReading","payEndReading","payKwh","payUnitPrice","payAmount","collectStartReading","collectEndReading","collectKwh","collectUnitPrice","collectAmount","taxRate","collectNet","profit"):
        if rec.get(k) is not None:
            rec[k] = float(rec[k])
    for d in rec["meterDetails"]:
        for k in ("startReading","endReading","kwh","payUnitPrice","payAmount","collectUnitPrice","collectAmount","collectNet"):
            if d.get(k) is not None:
                d[k] = float(d[k])
    mockElectricity.append(rec)

mockExpenses = [camel(r) for r in q("""
    SELECT o.*, s.name AS station_name FROM operating_expenses o
    LEFT JOIN stations s ON o.station_id = s.id ORDER BY o.id""")]
for e in mockExpenses:
    if e.get("amount") is not None:
        e["amount"] = float(e["amount"])

# ── 分红记录 + 明细 ───────────────────────────────────────────
mockDividends = []
for r in q("""
    SELECT d.*, s.name AS station_name FROM dividend_records d
    LEFT JOIN stations s ON d.station_id = s.id ORDER BY d.period DESC, d.station_id"""):
    rec = camel(r)
    shares = q("""
        SELECT ds.*, sh.name AS shareholder_name, i.name AS introducer_name, b.name AS brand_name
        FROM dividend_shares ds
        LEFT JOIN shareholders sh ON ds.shareholder_id = sh.id
        LEFT JOIN introducers i ON ds.introducer_id = i.id
        LEFT JOIN brands b ON ds.brand_id = b.id
        WHERE ds.dividend_id=%s ORDER BY ds.id""", (r["id"],))
    rec["shareholderConfigs"] = []
    rec["introducerConfigs"] = []
    for x in shares:
        item = camel(x)
        for k in ("ratio","fixedAmount","amount"):
            if item.get(k) is not None:
                item[k] = float(item[k])
        if item.get("shareholderId"):
            rec["shareholderConfigs"].append(item)
        if item.get("introducerId"):
            rec["introducerConfigs"].append(item)
    mockDividends.append(rec)

# ── 分红配置 ──────────────────────────────────────────────────
mockShareholderConfigs = [camel(r) for r in q("""
    SELECT c.*, sh.name AS shareholder_name, s.name AS station_name, b.name AS brand_name
    FROM station_shareholder_configs c
    LEFT JOIN shareholders sh ON c.shareholder_id = sh.id
    LEFT JOIN stations s ON c.station_id = s.id
    LEFT JOIN brands b ON c.brand_id = b.id
    ORDER BY c.id""")]
mockIntroducerConfigs = [camel(r) for r in q("""
    SELECT c.*, i.name AS introducer_name, s.name AS station_name, b.name AS brand_name
    FROM station_introducer_configs c
    LEFT JOIN introducers i ON c.introducer_id = i.id
    LEFT JOIN stations s ON c.station_id = s.id
    LEFT JOIN brands b ON c.brand_id = b.id
    ORDER BY c.id""")]
for cfg in (mockShareholderConfigs + mockIntroducerConfigs):
    for k in ("ratio","fixedAmount"):
        if cfg.get(k) is not None:
            cfg[k] = float(cfg[k])

# ── 审批 ──────────────────────────────────────────────────────
mockApprovalFlows = [camel(r) for r in q("SELECT * FROM approval_flows ORDER BY id")]
for f in mockApprovalFlows:
    try:
        f["nodes"] = json.loads(f["nodes"]) if isinstance(f["nodes"], str) else f["nodes"]
    except Exception:
        f["nodes"] = []
mockApprovals = []
for r in q("SELECT * FROM approval_requests ORDER BY id DESC"):
    a = camel(r)
    try:
        a["flowNodes"] = json.loads(a["flowNodes"]) if isinstance(a["flowNodes"], str) else a["flowNodes"]
    except Exception:
        a["flowNodes"] = []
    try:
        a["attachments"] = json.loads(a["attachments"]) if isinstance(a["attachments"], str) else (a["attachments"] or [])
    except Exception:
        a["attachments"] = []
    mockApprovals.append(a)

# ── 能耗（月度全量 + 日/时/状态示例）──────────────────────────
mockMeterMonthly = [camel(r) for r in q("""
    SELECT address, month_period, kwh, actual_kwh, prev_reading, prev_reading_date,
           curr_reading, curr_reading_date, synced_at
    FROM meter_monthly ORDER BY month_period DESC, address""")]
for m in mockMeterMonthly:
    for k in ("kwh","actualKwh","prevReading","currReading"):
        if m.get(k) is not None:
            m[k] = float(m[k])

mockMeterEnergy = {
    "daily": [{"date": "2026-08-19", "kwh": 12.5}, {"date": "2026-08-20", "kwh": 15.2}],
    "hourly": [{"hour": "2026-08-20 14:00", "kwh": 1.2}, {"hour": "2026-08-20 15:00", "kwh": 1.5}],
    "monthly": [{"month": "2026-07", "kwh": 350}, {"month": "2026-08", "kwh": 500}],
}

# ── 同步日志（截断 20）────────────────────────────────────────
mockSyncLogs = [camel(r) for r in q("SELECT * FROM sync_logs ORDER BY started_at DESC LIMIT 20")]

# ── 租金旧台账（真实有值才导）────────────────────────────────
mockRentLeases = [camel(r) for r in q("SELECT * FROM rent_leases ORDER BY id")]
mockRentIncomes = [camel(r) for r in q("SELECT * FROM rent_incomes ORDER BY id")]
mockRentReceipts = [camel(r) for r in q("SELECT * FROM rent_receipts ORDER BY id")]
mockRentPaymentRecords = [camel(r) for r in q("SELECT * FROM rent_payment_records ORDER BY id")]
mockRentIncomeRecords = [camel(r) for r in q("SELECT * FROM rent_income_records ORDER BY id")]

# ── 聚合：总览 / 汇总 ─────────────────────────────────────────
def s(sql, params=None):
    cur.execute(sql, params or ())
    r = cur.fetchone()
    return r[0] if r else 0

station_count = s("SELECT COUNT(*) FROM stations")
meter_count = s("SELECT COUNT(*) FROM meters")
brand_count = s("SELECT COUNT(*) FROM brands")
entity_count = s("SELECT COUNT(*) FROM entities")
landlord_count = s("SELECT COUNT(*) FROM landlords")
shareholder_count = s("SELECT COUNT(*) FROM shareholders")
introducer_count = s("SELECT COUNT(*) FROM introducers")
elec_pay = s("SELECT COALESCE(SUM(pay_amount),0) FROM electricity_records")
elec_collect = s("SELECT COALESCE(SUM(collect_amount),0) FROM electricity_records")
elec_profit = s("SELECT COALESCE(SUM(profit),0) FROM electricity_records")
rent_income = s("SELECT COALESCE(SUM(monthly_rent),0) FROM contracts WHERE contract_type='品牌方合同'")
rent_cost = s("SELECT COALESCE(SUM(monthly_rent),0) FROM contracts WHERE contract_type='场地合同'")
op_total = s("SELECT COALESCE(SUM(amount),0) FROM operating_expenses")

monthly = []
for r in q("""
    SELECT period, COALESCE(SUM(collect_amount),0) AS c, COALESCE(SUM(pay_amount),0) AS p,
           COALESCE(SUM(profit),0) AS f
    FROM electricity_records GROUP BY period ORDER BY period"""):
    monthly.append({"period": r["period"], "elecCollect": float(r["c"]), "elecPay": float(r["p"]), "elecProfit": float(r["f"])})

station_board = []
for r in q("""
    SELECT e.station_id, s.name AS station_name, e.period,
           COALESCE(SUM(e.pay_amount),0) AS pay, COALESCE(SUM(e.collect_amount),0) AS collect,
           COALESCE(SUM(e.profit),0) AS profit
    FROM electricity_records e LEFT JOIN stations s ON e.station_id = s.id
    GROUP BY e.station_id, s.name, e.period ORDER BY e.period DESC, e.station_id"""):
    station_board.append({
        "stationId": r["station_id"], "stationName": r["station_name"], "period": r["period"],
        "payAmount": float(r["pay"]), "collectAmount": float(r["collect"]), "profit": float(r["profit"]),
    })

brand_board = []
for r in q("""
    SELECT b.id AS brand_id, b.name AS brand_name, COUNT(DISTINCT s.id) AS cnt
    FROM brands b LEFT JOIN meters m ON m.brand_id = b.id LEFT JOIN stations s ON s.id = m.station_id
    GROUP BY b.id, b.name ORDER BY b.id"""):
    brand_board.append({"brandId": r["brand_id"], "brandName": r["brand_name"], "stationCount": r["cnt"], "totalProfit": 0})

entity_board = []
for r in q("""
    SELECT e.id AS entity_id, e.name AS entity_name, COUNT(DISTINCT s.id) AS cnt
    FROM entities e LEFT JOIN stations s ON s.entity_id = e.id
    GROUP BY e.id, e.name ORDER BY e.id"""):
    entity_board.append({"entityId": r["entity_id"], "entityName": r["entity_name"], "stationCount": r["cnt"], "totalProfit": 0})

landlord_board = []
for r in q("""
    SELECT l.id AS landlord_id, l.name AS landlord_name, COUNT(DISTINCT s.id) AS cnt
    FROM landlords l LEFT JOIN stations s ON s.landlord_id = l.id
    GROUP BY l.id, l.name ORDER BY l.id"""):
    landlord_board.append({"landlordId": r["landlord_id"], "landlordName": r["landlord_name"], "stationCount": r["cnt"], "totalProfit": 0})

shareholder_board = []
for r in q("""
    SELECT ds.shareholder_id, sh.name AS shareholder_name, COUNT(DISTINCT d.station_id) AS cnt,
           COALESCE(SUM(ds.amount),0) AS amt
    FROM dividend_shares ds
    JOIN dividend_records d ON ds.dividend_id = d.id
    JOIN shareholders sh ON ds.shareholder_id = sh.id
    WHERE ds.shareholder_id IS NOT NULL
    GROUP BY ds.shareholder_id, sh.name"""):
    shareholder_board.append({"shareholderId": r["shareholder_id"], "shareholderName": r["shareholder_name"], "stationCount": r["cnt"], "totalAmount": float(r["amt"])})

mockOverview = {
    "elecProfit": float(elec_profit), "elecCollect": float(elec_collect), "elecPay": float(elec_pay),
    "elecUncollected": 0, "elecUnpaid": 0,
    "rentIncomeTotal": float(rent_income), "rentCostTotal": float(rent_cost),
    "rentUncollected": 0, "opExpenseTotal": float(op_total),
    "stationCount": station_count, "activeStations": station_count,
    "meterCount": meter_count, "brandCount": brand_count, "entityCount": entity_count,
    "landlordCount": landlord_count, "shareholderCount": shareholder_count, "introducerCount": introducer_count,
    "expiringContracts": 0, "expiredContracts": 0,
    "monthly": monthly,
    "stationBoard": station_board,
    "brandBoard": brand_board, "entityBoard": entity_board,
    "landlordBoard": landlord_board, "shareholderBoard": shareholder_board,
}

# mockMonthlyDetail：最新月份真实数据（完整结构，Dashboard 消费 incomeDetails/costDetails 等）
latest = q("SELECT MAX(period) AS p FROM electricity_records")
latest_period = latest[0]["p"] if latest and latest[0]["p"] else None
detail_elec = {"income": 0.0, "cost": 0.0, "profit": 0.0, "details": []}
detail_rent = {"income": 0.0, "cost": 0.0, "profit": 0.0, "incomeDetails": [], "costDetails": [], "details": []}
detail_op = {"total": 0.0, "details": []}
detail_div = {"total": 0.0, "pending": 0, "details": []}
total_kwh = 0.0
if latest_period:
    for r in q("""
        SELECT e.station_id, s.name AS station_name, e.pay_kwh, e.pay_amount, e.collect_net, e.profit
        FROM electricity_records e LEFT JOIN stations s ON e.station_id = s.id
        WHERE e.period = %s ORDER BY e.station_id""", (latest_period,)):
        total_kwh += float(r["pay_kwh"] or 0)
        detail_elec["income"] += float(r["collect_net"] or 0)
        detail_elec["cost"] += float(r["pay_amount"] or 0)
        detail_elec["profit"] += float(r["profit"] or 0)
        for d in q("""
            SELECT m.meter_no, b.name AS brand_name, d.kwh, d.pay_amount, d.collect_net
            FROM electricity_meter_details d
            LEFT JOIN meters m ON d.meter_id = m.id
            LEFT JOIN brands b ON m.brand_id = b.id
            WHERE d.electricity_id = (SELECT id FROM electricity_records WHERE period = %s AND station_id = %s LIMIT 1)
            ORDER BY d.id""", (latest_period, r["station_id"])):
            detail_elec["details"].append({
                "meterNo": d["meter_no"], "brandName": d["brand_name"],
                "kwh": float(d["kwh"] or 0), "payAmount": float(d["pay_amount"] or 0),
                "collectNet": float(d["collect_net"] or 0)})
    # 租金：覆盖该月的合同（标准月口径）
    for c in q("""
        SELECT contract_type, b.name AS brand_name, l.name AS landlord_name, monthly_rent
        FROM contracts c
        LEFT JOIN brands b ON c.brand_id = b.id
        LEFT JOIN landlords l ON c.landlord_id = l.id
        WHERE (c.start_date IS NULL OR c.start_date <= %s)
          AND (COALESCE(c.early_end_date, c.end_date) IS NULL OR COALESCE(c.early_end_date, c.end_date) >= %s)""",
        (latest_period + "31", latest_period + "01")):
        mr = float(c["monthly_rent"] or 0)
        if c["contract_type"] == "品牌方合同":
            detail_rent["income"] += mr
            detail_rent["incomeDetails"].append({"brandName": c["brand_name"], "monthlyRent": mr})
        else:
            detail_rent["cost"] += mr
            detail_rent["costDetails"].append({"landlordName": c["landlord_name"], "monthlyRent": mr})
    detail_rent["profit"] = detail_rent["income"] - detail_rent["cost"]
    # 运营费用
    for r in q("""
        SELECT o.*, s.name AS station_name FROM operating_expenses o
        LEFT JOIN stations s ON o.station_id = s.id WHERE o.period = %s ORDER BY o.id""", (latest_period,)):
        amt = float(r["amount"] or 0)
        detail_op["total"] += amt
        detail_op["details"].append({"stationName": r["station_name"], "type": "运营费用", "amount": amt, "remark": r.get("remark")})
    # 分红
    for r in q("""
        SELECT d.*, s.name AS station_name FROM dividend_records d
        LEFT JOIN stations s ON d.station_id = s.id WHERE d.period = %s ORDER BY d.id""", (latest_period,)):
        amt = float(r["profit"] or 0)
        detail_div["total"] += amt
        if r["status"] != "已结算":
            detail_div["pending"] += 1
        detail_div["details"].append({"stationName": r["station_name"], "period": r["period"], "amount": amt, "status": r["status"]})

mockMonthlyDetail = {
    "totalKwh": round(total_kwh, 2),
    "elec": detail_elec,
    "rent": detail_rent,
    "opExpense": detail_op,
    "dividend": detail_div,
}

mockShareholderSummary = []
for r in q("""
    SELECT ds.shareholder_id, sh.name AS shareholder_name, d.period,
           COALESCE(SUM(ds.amount),0) AS amt, COUNT(DISTINCT d.station_id) AS cnt
    FROM dividend_shares ds
    JOIN dividend_records d ON ds.dividend_id = d.id
    JOIN shareholders sh ON ds.shareholder_id = sh.id
    WHERE ds.shareholder_id IS NOT NULL
    GROUP BY ds.shareholder_id, sh.name, d.period ORDER BY d.period DESC"""):
    mockShareholderSummary.append({"shareholderId": r["shareholder_id"], "shareholderName": r["shareholder_name"], "period": r["period"], "totalAmount": float(r["amt"]), "stationCount": r["cnt"]})

mockIntroducerSummary = []
for r in q("""
    SELECT ds.introducer_id, i.name AS introducer_name, d.period,
           COALESCE(SUM(ds.amount),0) AS amt, COUNT(DISTINCT d.station_id) AS cnt
    FROM dividend_shares ds
    JOIN dividend_records d ON ds.dividend_id = d.id
    JOIN introducers i ON ds.introducer_id = i.id
    WHERE ds.introducer_id IS NOT NULL
    GROUP BY ds.introducer_id, i.name, d.period ORDER BY d.period DESC"""):
    mockIntroducerSummary.append({"introducerId": r["introducer_id"], "introducerName": r["introducer_name"], "period": r["period"], "totalAmount": float(r["amt"]), "stationCount": r["cnt"]})

mockUsers = [camel(r) for r in q("""
    SELECT u.id, u.name, u.role, u.shareholder_id, u.landlord_ids, u.phone
    FROM platform_users u ORDER BY u.id""")]
for u in mockUsers:
    u["shareholderName"] = None

# ── 组装 TS 文件 ──────────────────────────────────────────────
lines = []
lines.append("// Mock 数据 - 由 huandian_v2 真实数据库导出（2026-08）")
lines.append("// 说明：档案/站点/电表/合同/台账/分红/配置/审批为真实数据；能耗明细(hourly/status)为示例；")
lines.append("//       mockMeterMonthly 为真实月度读数（供 mockClient 读数接口按电表过滤）")
lines.append("")
for name, data in [
    ("mockBrands", mockBrands), ("mockEntities", mockEntities), ("mockLandlords", mockLandlords),
    ("mockShareholders", mockShareholders), ("mockIntroducers", mockIntroducers),
    ("mockEntityBrands", mockEntityBrands), ("mockPlatformUsers", mockPlatformUsers),
    ("mockThirdPartyConfigs", mockThirdPartyConfigs),
    ("mockStations", mockStations), ("mockMeters", mockMeters), ("mockCabinets", mockCabinets),
    ("mockContracts", mockContracts), ("mockContractSchedules", mockContractSchedules),
    ("mockElectricity", mockElectricity), ("mockExpenses", mockExpenses),
    ("mockDividends", mockDividends),
    ("mockShareholderConfigs", mockShareholderConfigs), ("mockIntroducerConfigs", mockIntroducerConfigs),
    ("mockApprovals", mockApprovals), ("mockApprovalFlows", mockApprovalFlows),
    ("mockMeterMonthly", mockMeterMonthly), ("mockMeterEnergy", mockMeterEnergy),
    ("mockSyncLogs", mockSyncLogs),
    ("mockRentLeases", mockRentLeases), ("mockRentIncomes", mockRentIncomes),
    ("mockRentReceipts", mockRentReceipts), ("mockRentPaymentRecords", mockRentPaymentRecords),
    ("mockRentIncomeRecords", mockRentIncomeRecords),
    ("mockOverview", mockOverview), ("mockMonthlyDetail", mockMonthlyDetail),
    ("mockShareholderSummary", mockShareholderSummary), ("mockIntroducerSummary", mockIntroducerSummary),
    ("mockUsers", mockUsers),
]:
    # 空数组标注 any[]，避免 mockClient 的 push/find 触发 never[] 类型错误
    if isinstance(data, list) and len(data) == 0:
        lines.append(f"export const {name}: any[] = {ts(data)};")
    else:
        lines.append(f"export const {name} = {ts(data)};")
    lines.append("")

with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print(f"已生成 {OUT}")
print(f"mockStations={len(mockStations)} mockMeters={len(mockMeters)} mockContracts={len(mockContracts)} "
      f"mockElectricity={len(mockElectricity)} mockDividends={len(mockDividends)} "
      f"mockMeterMonthly={len(mockMeterMonthly)} mockApprovals={len(mockApprovals)}")
cur.close(); conn.close()
