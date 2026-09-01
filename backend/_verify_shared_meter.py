# -*- coding: utf-8 -*-
"""方案 A 验证：共享电表 + 全品牌合同的场地成本分摊"""
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

conn = psycopg2.connect("postgresql://quant:quant-speed123@localhost:5432/huandian_v2")
cur = conn.cursor()
# 清理上次运行残留的测试全品牌合同
cur.execute("DELETE FROM contract_audit_log WHERE contract_id IN (SELECT id FROM contracts WHERE landlord_id = 13 AND brand_id IS NULL AND contract_type = '品牌方合同' AND remark IS NULL AND unit_monthly_rent = 1200)")
cur.execute("DELETE FROM rent_payment_schedule WHERE contract_id IN (SELECT id FROM contracts WHERE landlord_id = 13 AND brand_id IS NULL AND contract_type = '品牌方合同' AND remark IS NULL AND unit_monthly_rent = 1200)")
cur.execute("DELETE FROM rent_income_schedule WHERE contract_id IN (SELECT id FROM contracts WHERE landlord_id = 13 AND brand_id IS NULL AND contract_type = '品牌方合同' AND remark IS NULL AND unit_monthly_rent = 1200)")
cur.execute("DELETE FROM contracts WHERE landlord_id = 13 AND brand_id IS NULL AND contract_type = '品牌方合同' AND remark IS NULL AND unit_monthly_rent = 1200")
# 场景搭建：电表 99 → 共享电表（品牌解除）
cur.execute("UPDATE meters SET brand_id = NULL, tag = '共享电表' WHERE id = 99")
conn.commit(); cur.close(); conn.close()

# 建全品牌合同（brandId 为空）
r = requests.post(f"{B}/api/contracts", json={
    "landlordId": 13, "contractType": "品牌方合同",
    "unitMonthlyRent": "1200", "monthlyRent": "1200", "rentCalcMethod": "按柜子数量",
    "startDate": "2026-01-01", "endDate": "2026-12-31",
}, headers=H)
shared_cid = r.json().get("id")
assert shared_cid, f"建全品牌合同失败: {r.status_code} {r.text[:150]}"

def contracts_map():
    return {c["id"]: c for c in requests.get(f"{B}/api/contracts", headers=H).json()}

# 1. 计费柜数：全品牌合同 = 共享电表数（1），云貂合同 = 0
cm = contracts_map()
shared_live = cm[shared_cid]["liveCabinetsCount"]
yundiao_live = cm[40]["liveCabinetsCount"]
ok.append((f"计费柜数: 全品牌合同={shared_live}（共享电表 1 块）、云貂合同={yundiao_live}（电表已共享）",
           shared_live == 1 and yundiao_live == 0))

# 2. 场地合同弹窗口径：income_cabinets_total = 1
ok.append(("场地合同口径: incomeCabinetsTotal=1（收入合同计费柜数总和）",
           cm[39]["incomeCabinetsTotal"] == 1))

# 3. 场租页分摊：全品牌承担 1200，云貂 0，守恒
rows = requests.get(f"{B}/api/rent/monthly-ledger", params={"period": "202608", "dim": "landlord"}, headers=H).json()
yr = next(y for y in rows["yearlyRows"] if y["landlordName"] == "大观体育公园")
shares = {b.get("brandName") or "全品牌共享": b.get("venueShareAnnual") for b in yr["brands"]}
total_share = sum(v for v in shares.values() if v)
ok.append((f"场租分摊: {shares} 合计={total_share}（守恒=14400）", abs(total_share - 14400) < 0.01 and shares.get("全品牌共享") == 14400))

# 4. 分红 breakdown：含「全品牌共享」，venueCost = 1200
d = requests.post(f"{B}/api/dividends/calculate", json={"landlordId": 13, "period": "202608"}, headers=H).json()
bb = {b["brandName"]: b["venueCost"] for b in d.get("brandBreakdown", [])}
ok.append((f"分红: brandBreakdown={bb} 全品牌共享 venueCost=1200（守恒）",
           bb.get("全品牌共享") == 1200 and abs(sum(bb.values()) - 1200) < 0.01))

# 还原：电表 99 回到 云貂/民用电表，删测试全品牌合同
conn = psycopg2.connect("postgresql://quant:quant-speed123@localhost:5432/huandian_v2")
cur = conn.cursor()
cur.execute("UPDATE meters SET brand_id = 17, tag = '民用电表' WHERE id = 99")
cur.execute("DELETE FROM contract_audit_log WHERE contract_id = %s", (shared_cid,))
cur.execute("DELETE FROM rent_payment_schedule WHERE contract_id = %s", (shared_cid,))
cur.execute("DELETE FROM rent_income_schedule WHERE contract_id = %s", (shared_cid,))
cur.execute("DELETE FROM contracts WHERE id = %s", (shared_cid,))
conn.commit(); cur.close(); conn.close()

cm = contracts_map()
ok.append(("还原后: 云貂合同计费柜数=1、venueCost 恢复", cm[40]["liveCabinetsCount"] == 1))

n = sum(1 for _, v in ok if v)
for name, v in ok:
    print(("✅" if v else "❌"), name)
print(f"\n通过 {n}/{len(ok)}")
