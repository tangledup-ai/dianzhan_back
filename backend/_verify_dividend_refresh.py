# -*- coding: utf-8 -*-
"""验证分红自动重算：合同变更触发 + 审批状态保护 + 手动刷新端点"""
import requests, jwt, warnings
from datetime import datetime, timedelta, timezone
warnings.filterwarnings('ignore')
import sys
sys.path.insert(0, '.')
from app.config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_DAYS

token = jwt.encode({"sub": "1", "name": "大老板", "role": "boss",
                    "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS)},
                   JWT_SECRET, algorithm=JWT_ALGORITHM)
H = {"Authorization": f"Bearer {token}"}
B = "http://localhost:3001"


def get_record():
    rows = requests.get(f"{B}/api/dividends", params={"landlordId": 13, "period": "202608"}, headers=H).json()
    return rows[0] if rows else None


# 1. 建测试分红记录（大观体育公园 2026-08，整场地）
r = requests.post(f"{B}/api/dividends", json={"landlordId": 13, "period": "202608"}, headers=H)
rec = r.json() if r.status_code < 300 else None
assert rec, f"建记录失败: {r.status_code} {r.text[:200]}"
rid = rec["id"]
p0 = rec["profit"]
print(f"1) 建分红记录 id={rid} 初始 profit={p0} (rentIncome={rec['rentIncome']} rentCost={rec['rentCost']})")

# 2. 改云貂品牌方合同月租 100→200（合同月租是分红 rentIncome 的输入）
requests.put(f"{B}/api/contracts/40", json={"monthlyRent": "200"}, headers=H)
rec = get_record()
print(f"2) 合同月租改 200 后（自动触发）: profit={rec['profit']} rentIncome={rec['rentIncome']} -> {'✅ 自动重算生效' if rec['profit'] != p0 else '❌ 未重算'}")
p1 = rec["profit"]

# 3. 置为申报中，再改合同 → 审批保护应跳过
import psycopg2
conn = psycopg2.connect("postgresql://quant:quant-speed123@localhost:5432/huandian_v2")
cur = conn.cursor(); cur.execute("UPDATE dividend_records SET status='申报中' WHERE id=%s", (rid,)); conn.commit(); cur.close(); conn.close()
requests.put(f"{B}/api/contracts/40", json={"monthlyRent": "300"}, headers=H)
rec = get_record()
print(f"3) 申报中状态下改合同: profit={rec['profit']} -> {'✅ 审批保护生效(未改)' if rec['profit'] == p1 else '❌ 错改了已申报记录'}")

# 4. 手动刷新端点：应报告 skipped=1
r = requests.post(f"{B}/api/dividends/refresh", json={"landlordId": 13}, headers=H)
print(f"4) 手动 /refresh（申报中）: {r.json()} -> {'✅' if r.json().get('skipped') == 1 else '❌'}")

# 5. 恢复未结算 + 合同月租还原 100 → profit 应回到初始值
conn = psycopg2.connect("postgresql://quant:quant-speed123@localhost:5432/huandian_v2")
cur = conn.cursor(); cur.execute("UPDATE dividend_records SET status='未结算' WHERE id=%s", (rid,)); conn.commit(); cur.close(); conn.close()
requests.put(f"{B}/api/contracts/40", json={"monthlyRent": "100"}, headers=H)
rec = get_record()
print(f"5) 合同还原 100 后: profit={rec['profit']} (初始 {p0}) -> {'✅ 还原一致' if abs(rec['profit'] - p0) < 0.01 else '❌'}")

# 6. 清理测试分红记录
requests.delete(f"{B}/api/dividends/{rid}", headers=H)
rec = get_record()
print(f"6) 清理测试记录: {'✅ 已删除' if not rec else '❌ 仍存在'}")
