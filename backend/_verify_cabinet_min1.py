# -*- coding: utf-8 -*-
"""验证柜数口径：每块电表至少 1 柜，N 柜算 N（全系统统一）"""
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

def live40():
    rows = requests.get(f"{B}/api/contracts", headers=H).json()
    return next(c["liveCabinetsCount"] for c in rows if c["id"] == 40)

def dash_cabinets():
    return requests.get(f"{B}/api/overview", headers=H).json()["cabinetCount"]

def mp_sql():
    conn = psycopg2.connect("postgresql://quant:CHANGE_ME_DB_PASSWORD@localhost:5432/huandian_v2")
    cur = conn.cursor()
    cur.execute("""
        SELECT landlord_id, brand_id,
               SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id))) AS cnt
        FROM meters m
        WHERE m.landlord_id IS NOT NULL AND m.brand_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%'
        GROUP BY landlord_id, brand_id
    """)
    d = {(r[0], r[1]): int(r[2]) for r in cur.fetchall()}
    cur.close(); conn.close()
    return d

ok = []
base_dash, base_live = dash_cabinets(), live40()
ok.append((f"基线: 云貂合同计费柜数=1（电表 99 当前 0 柜，min=1）", base_live == 1))

# 加 2 个柜子 → 该表柜数应为 2
ids = []
for i in (1, 2):
    r = requests.post(f"{B}/api/cabinets", json={"meterId": 99, "cabinetNo": f"GLM-CHECK-{i}", "cabinetType": "普通柜"}, headers=H)
    ids.append(r.json()["id"])
after_dash, after_live = dash_cabinets(), live40()
ok.append((f"加 2 柜后: 云貂合同计费柜数=2", after_live == 2))
ok.append((f"加 2 柜后: 仪表盘总柜数 +1（该表 1→2）", after_dash == base_dash + 1))
ok.append((f"加 2 柜后: 小程序站点卡柜数(13,17)=2", mp_sql().get((13, 17)) == 2))

# 清理测试柜子 → 回到 1
for cid in ids:
    requests.delete(f"{B}/api/cabinets/{cid}", headers=H)
ok.append((f"清理后: 云貂合同计费柜数=1", live40() == 1))
ok.append((f"清理后: 仪表盘总柜数还原", dash_cabinets() == base_dash))

n_pass = sum(1 for _, v in ok if v)
for name, v in ok:
    print(("✅" if v else "❌"), name)
print(f"\n通过 {n_pass}/{len(ok)}")
