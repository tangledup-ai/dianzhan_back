# -*- coding: utf-8 -*-
"""验证：共享电表的电费收入进分红（全品牌合同定价）"""
import requests, jwt, warnings, sys, psycopg2
from datetime import datetime, timedelta, timezone
warnings.filterwarnings('ignore')
sys.path.insert(0, '.')
from app.config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_DAYS

token = jwt.encode({"sub": "1", "name": "大老板", "role": "boss",
                    "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS)},
                   JWT_SECRET, algorithm=JWT_ALGORITHM)
H = {"Authorization": f"Bearer {token}"}
B = "http://localhost:3001"
ok = []

conn = psycopg2.connect("postgresql://quant:CHANGE_ME_DB_PASSWORD@localhost:5432/huandian_v2")
cur = conn.cursor()
# 清理残留测试全品牌合同；场景：电表 99 → 共享电表
cur.execute("DELETE FROM contract_audit_log WHERE contract_id IN (SELECT id FROM contracts WHERE landlord_id = 13 AND brand_id IS NULL AND contract_type = '品牌方合同')")
cur.execute("DELETE FROM rent_payment_schedule WHERE contract_id IN (SELECT id FROM contracts WHERE landlord_id = 13 AND brand_id IS NULL AND contract_type = '品牌方合同')")
cur.execute("DELETE FROM rent_income_schedule WHERE contract_id IN (SELECT id FROM contracts WHERE landlord_id = 13 AND brand_id IS NULL AND contract_type = '品牌方合同')")
cur.execute("DELETE FROM contracts WHERE landlord_id = 13 AND brand_id IS NULL AND contract_type = '品牌方合同'")
cur.execute("UPDATE meters SET brand_id = NULL, tag = '共享电表' WHERE id = 99")
cur.execute("SELECT COALESCE(SUM(kwh),0) FROM meter_monthly WHERE address='251206550085' AND month_period='202608'")
real_kwh = float(cur.fetchone()[0])
conn.commit(); cur.close(); conn.close()

# 建全品牌合同（电价 1.2、月租 1200）
r = requests.post(f"{B}/api/contracts", json={
    "landlordId": 13, "contractType": "品牌方合同",
    "unitMonthlyRent": "1200", "monthlyRent": "1200", "rentCalcMethod": "按柜子数量",
    "electricityPrice": "1.2",
    "startDate": "2026-01-01", "endDate": "2026-12-31",
}, headers=H)
shared_cid = r.json().get("id")
assert shared_cid, f"建全品牌合同失败: {r.status_code} {r.text[:150]}"

# 分红整场地计算 202608
d = requests.post(f"{B}/api/dividends/calculate", json={"landlordId": 13, "period": "202608"}, headers=H).json()
bb = {b["brandName"]: b for b in d.get("brandBreakdown", [])}
shared_entry = bb.get("全品牌共享", {})
expect_elec = round(real_kwh * 1.2, 2)

ok.append((f"共享电表电量纳入（202608 实际 {real_kwh} 度）", real_kwh > 0))
ok.append((f"全品牌共享: 电费收入={shared_entry.get('elecIncome')}（应为 {expect_elec}）",
           abs((shared_entry.get("elecIncome") or 0) - expect_elec) < 0.05))
ok.append((f"全品牌共享: 场地成本分摊={shared_entry.get('venueCost')}（应为 1200）",
           shared_entry.get("venueCost") == 1200))

# 还原：电表 99 回到 云貂/民用电表，删测试全品牌合同
conn = psycopg2.connect("postgresql://quant:CHANGE_ME_DB_PASSWORD@localhost:5432/huandian_v2")
cur = conn.cursor()
cur.execute("UPDATE meters SET brand_id = 17, tag = '民用电表' WHERE id = 99")
cur.execute("DELETE FROM contract_audit_log WHERE contract_id = %s", (shared_cid,))
cur.execute("DELETE FROM rent_payment_schedule WHERE contract_id = %s", (shared_cid,))
cur.execute("DELETE FROM rent_income_schedule WHERE contract_id = %s", (shared_cid,))
cur.execute("DELETE FROM contracts WHERE id = %s", (shared_cid,))
conn.commit(); cur.close(); conn.close()

d = requests.post(f"{B}/api/dividends/calculate", json={"landlordId": 13, "period": "202608"}, headers=H).json()
bb = {b["brandName"]: b.get("elecIncome") for b in d.get("brandBreakdown", [])}
ok.append(("还原后: 共享条目消失，云貂条目保留（其合同无电价，电费收入 0 属正常）", "全品牌共享" not in bb and "云貂" in bb))

n = sum(1 for _, v in ok if v)
for name, v in ok:
    print(("✅" if v else "❌"), name)
print(f"\n通过 {n}/{len(ok)}")
