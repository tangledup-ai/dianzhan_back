# -*- coding: utf-8 -*-
"""验证 venue_cost 口径统一：无电表品牌不参与分摊，分摊不溢出"""
import requests, jwt, warnings, sys
from datetime import datetime, timedelta, timezone
warnings.filterwarnings('ignore')
sys.path.insert(0, '.')
from app.config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_DAYS

token = jwt.encode({"sub": "1", "name": "大老板", "role": "boss",
                    "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS)},
                   JWT_SECRET, algorithm=JWT_ALGORITHM)
H = {"Authorization": f"Bearer {token}"}
B = "http://localhost:3001"

def breakdown(lid, period="202608"):
    d = requests.post(f"{B}/api/dividends/calculate", json={"landlordId": lid, "period": period}, headers=H).json()
    return d["cost"]["rentCost"], {b["brandName"]: b["venueCost"] for b in d.get("brandBreakdown", [])}

ok = []
# 1. 修前基线：大观只有云貂（1 块电表）
rent_cost, bb = breakdown(13)
ok.append((f"基线: 大观 rentCost={rent_cost}, 云貂 venueCost={bb.get('云貂')} (应为 {rent_cost})", bb.get("云貂") == rent_cost))

# 2. 给大观签一份台铃品牌合同（台铃在大观无电表）
r = requests.post(f"{B}/api/contracts", json={
    "landlordId": 13, "brandId": 2, "contractType": "品牌方合同",
    "unitMonthlyRent": "100", "monthlyRent": "100", "rentCalcMethod": "按柜子数量",
    "startDate": "2026-01-01", "endDate": "2026-12-31",
}, headers=H)
test_cid = r.json().get("id") if r.status_code < 300 else None
assert test_cid, f"建测试合同失败: {r.status_code} {r.text[:200]}"

rent_cost, bb = breakdown(13)
ok.append((f"台铃(无电表)合同加入后: 台铃 venueCost=0（修复前会被硬算 1 柜）", bb.get("台铃") == 0))
ok.append((f"台铃(无电表)合同加入后: 云貂 venueCost 不被稀释，仍={rent_cost}", bb.get("云貂") == rent_cost))
ok.append((f"守恒: 各品牌分摊之和({sum(bb.values())}) = 场地租金({rent_cost})", abs(sum(bb.values()) - rent_cost) < 0.01))

# 3. 其他场地的分摊不超出租金（分母含无合同品牌时 ≤ 租金）
for lid, name in [(4, "螺蛳湾"), (5, "官南大道")]:
    rent_cost, bb = breakdown(lid)
    total = sum(bb.values())
    ok.append((f"{name}: 分摊之和({total}) ≤ 场地租金({rent_cost})", total <= rent_cost + 0.01))

# 清理测试合同
requests.delete(f"{B}/api/contracts/{test_cid}", headers=H)
rent_cost, bb = breakdown(13)
ok.append(("清理后恢复: 云貂 venueCost 不变", bb.get("云貂") == rent_cost and "台铃" not in bb))

n_pass = sum(1 for _, v in ok if v)
for name, v in ok:
    print(("✅" if v else "❌"), name)
print(f"\n通过 {n_pass}/{len(ok)}")
