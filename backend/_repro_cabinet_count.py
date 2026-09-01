# -*- coding: utf-8 -*-
"""复现：电表后关联品牌，场地合同「计费柜数（来自收入合同）」不更新"""
import requests

BASE = "http://localhost:3001"
import jwt
from datetime import datetime, timedelta
from app.config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_DAYS

token = jwt.encode(
    {"sub": "1", "name": "大老板", "role": "boss",
     "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRE_DAYS)},
    JWT_SECRET, algorithm=JWT_ALGORITHM,
)
H = {"Authorization": f"Bearer {token}"}

# 1. 建品牌 云貂
r = requests.post(f"{BASE}/api/directory/brands", json={"name": "云貂"}, headers=H)
brand = r.json() if r.status_code < 300 else None
print("create brand:", r.status_code, brand)
brand_id = brand["id"]

# 2. 建场地方 大观体育公园
r = requests.post(f"{BASE}/api/directory/landlords", json={"name": "大观体育公园"}, headers=H)
landlord = r.json() if r.status_code < 300 else None
print("create landlord:", r.status_code, landlord)
landlord_id = landlord["id"]

# 3. 建场地合同
r = requests.post(f"{BASE}/api/contracts", json={
    "landlordId": landlord_id, "contractType": "场地合同",
    "monthlyRent": "1200", "rentAmount": "14400",
    "startDate": "2026-01-01", "endDate": "2026-12-31",
}, headers=H)
venue = r.json()
print("create venue contract:", r.status_code, venue.get("id") if r.status_code < 300 else venue)

# 4. 建品牌方合同（此时电表还没关联 → 模拟柜数没存上，不传 cabinetsCount）
r = requests.post(f"{BASE}/api/contracts", json={
    "landlordId": landlord_id, "brandId": brand_id, "contractType": "品牌方合同",
    "unitMonthlyRent": "100", "monthlyRent": "100", "rentCalcMethod": "按柜子数量",
    "startDate": "2026-01-01", "endDate": "2026-12-31",
}, headers=H)
income = r.json()
print("create income contract:", r.status_code, income.get("id") if r.status_code < 300 else income)
income_id = income["id"]

# 5. 【之后】再把电表 251206550085 关联到 大观体育公园 + 云貂（用户在 meters 页的操作）
r = requests.put(f"{BASE}/api/meters/99", json={"landlordId": landlord_id, "brandId": brand_id}, headers=H)
print("associate meter 99:", r.status_code, (r.json() or {}).get("landlordId"), (r.json() or {}).get("brandId"))

# 6. 查合同列表
r = requests.get(f"{BASE}/api/contracts", headers=H)
rows = r.json()
for c in rows:
    if c.get("landlordId") == landlord_id:
        print(f"\ncontract id={c['id']} type={c['contractType']} brand={c.get('brandName')}")
        print(f"  cabinetsCount(存储)      = {c.get('cabinetsCount')}")
        print(f"  liveCabinetsCount(实时)  = {c.get('liveCabinetsCount')}")
        print(f"  incomeCabinetsTotal      = {c.get('incomeCabinetsTotal')}")
print("\n=== 前端场地合同弹窗显示的「计费柜数（来自收入合同）」===")
fe_total = sum((c.get("cabinetsCount") or 0) for c in rows
               if c.get("landlordId") == landlord_id and c.get("contractType") == "品牌方合同")
print("前端口径(存储快照之和):", fe_total)
fe_total_live = sum((c.get("liveCabinetsCount") if c.get("liveCabinetsCount") is not None else (c.get("cabinetsCount") or 0))
                    for c in rows
                    if c.get("landlordId") == landlord_id and c.get("contractType") == "品牌方合同")
print("若改用实时口径应为:", fe_total_live)
