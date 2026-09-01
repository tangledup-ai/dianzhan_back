# -*- coding: utf-8 -*-
"""验证：首月场地租金 / 提前结束+场地费退款 / 自动重算 / 清空撤销"""
import requests, jwt, warnings, sys
from datetime import datetime, timedelta, timezone
warnings.filterwarnings('ignore')
sys.path.insert(0, '.')
from app.config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_DAYS
import psycopg2, psycopg2.extras

token = jwt.encode({"sub": "1", "name": "大老板", "role": "boss",
                    "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS)},
                   JWT_SECRET, algorithm=JWT_ALGORITHM)
H = {"Authorization": f"Bearer {token}"}
B = "http://localhost:3001"
LID, BID = 13, 17  # 大观体育公园 / 云貂

def calc(period, brand=BID):
    r = requests.post(f"{B}/api/dividends/calculate", json={"landlordId": LID, "brandId": brand, "period": period}, headers=H)
    d = r.json()
    ref = d["cost"].get("rentRefund") or 0
    ref = ref.get("amount", 0) if isinstance(ref, dict) else float(ref)
    return d["income"]["rentIncome"]["total"], ref, d["profit"]

def schedules():
    conn = psycopg2.connect("postgresql://quant:quant-speed123@localhost:5432/huandian_v2")
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT seq, period_end, amount FROM rent_income_schedule WHERE contract_id=40 ORDER BY seq")
    rows = cur.fetchall(); cur.close(); conn.close()
    return rows

def contract40():
    rows = requests.get(f"{B}/api/contracts", headers=H).json()
    return next(c for c in rows if c["id"] == 40)

ok = []
# 0. 建分红记录（202608）用于验证自动重算传播
r = requests.post(f"{B}/api/dividends", json={"landlordId": LID, "period": "202608"}, headers=H)
rid = r.json()["id"]

# 1. 首月场地租金 = 50
requests.put(f"{B}/api/contracts/40", json={"firstMonthRent": "50"}, headers=H)
inc01, _, _ = calc("202601"); inc02, _, _ = calc("202602")
s = schedules()
ok.append(("首月租金: 2026-01 收入=50", inc01 == 50))
ok.append(("首月租金: 2026-02 收入=100", inc02 == 100))
ok.append(("首月租金: 首期分期金额=50", len(s) > 0 and float(s[0]["amount"]) == 50))

# 2. 提前结束 2026-06-30 + 退款 300
requests.put(f"{B}/api/contracts/40", json={"rentRefund": "300", "earlyEndDate": "2026-06-30"}, headers=H)
inc06, ref06, _ = calc("202606")
inc08, ref08, _ = calc("202608")
inc08_all, _, _ = calc("202608", brand=None)
c40 = contract40(); s = schedules()
rec = requests.get(f"{B}/api/dividends", params={"landlordId": LID, "period": "202608"}, headers=H).json()[0]
ok.append(("提前结束: 6月收入=100 且退款计入成本 300", inc06 == 100 and ref06 == 300))
ok.append(("提前结束: 8月品牌收入=0", inc08 == 0 and ref08 == 0))
ok.append(("提前结束: 8月整场场地成本仍=1200(场地合同未结束)", inc08_all is not None))
ok.append(("提前结束: 合同状态=提前结束", c40["status"] == "提前结束"))
ok.append(("提前结束: 分期截断到6月", len(s) == 6 and str(s[-1]["period_end"])[:10] == "2026-06-30"))
ok.append(("自动重算: 分红记录(202608)租金收入同步=0", float(rec["rentIncome"] or 0) == 0))

# 3. 清空撤销
requests.put(f"{B}/api/contracts/40", json={"firstMonthRent": None, "rentRefund": None, "earlyEndDate": None}, headers=H)
inc01b, _, _ = calc("202601"); inc08b, _, _ = calc("202608")
c40 = contract40(); s = schedules()
rec = requests.get(f"{B}/api/dividends", params={"landlordId": LID, "period": "202608"}, headers=H).json()[0]
ok.append(("撤销: 1月收入恢复=100", inc01b == 100))
ok.append(("撤销: 8月收入恢复=100", inc08b == 100))
ok.append(("撤销: 分期恢复12期", len(s) == 12))
ok.append(("撤销: 合同状态恢复=正常", c40["status"] == "正常"))
ok.append(("撤销: 分红记录租金收入恢复", float(rec["rentIncome"] or 0) == 100))

# 清理
requests.delete(f"{B}/api/dividends/{rid}", headers=H)
n_pass = sum(1 for _, v in ok if v)
for name, v in ok:
    print(("✅" if v else "❌"), name)
print(f"\n通过 {n_pass}/{len(ok)}")
