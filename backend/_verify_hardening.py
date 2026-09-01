# -*- coding: utf-8 -*-
"""验证 2026-09 加固批次：meters source / cabinets 无 brand_id / cabinets_count 停写 /
押金退还回写 / 合同审计 / 电费 data_source"""
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
ok = []

# 1. meters source 派生
rows = requests.get(f"{B}/api/meters", headers=H).json()
synced = sum(1 for m in rows if m.get("source") == "synced")
manual = sum(1 for m in rows if m.get("source") == "manual")
ok.append((f"隐患1: meters source 派生（第三方 {synced} / 手动 {manual}，应 113/1）", synced == 113 and manual == 1))

# 2. cabinets 不带 brand_id 也能建
r = requests.post(f"{B}/api/cabinets", json={"meterId": 99, "cabinetNo": "HARDEN-CHECK", "cabinetType": "普通柜"}, headers=H)
cab_id = r.json().get("id")
lst = requests.get(f"{B}/api/cabinets", params={"meterId": 99}, headers=H).json()
derived_brand = lst[0].get("brandName") if lst else None
ok.append(("隐患3: 无 brand_id 建柜成功，brand_name 由 meter 派生（云貂）", cab_id is not None and derived_brand == "云貂"))
requests.delete(f"{B}/api/cabinets/{cab_id}", headers=H)

# 3. cabinets_count 停写：带值提交 → 库里不更新
before = next(c for c in requests.get(f"{B}/api/contracts", headers=H).json() if c["id"] == 22)
requests.put(f"{B}/api/contracts/22", json={"cabinetsCount": "99"}, headers=H)
after = next(c for c in requests.get(f"{B}/api/contracts", headers=H).json() if c["id"] == 22)
ok.append((f"隐患4: cabinetsCount 停写（提交 99 后仍为 {after.get('cabinetsCount')}）", after.get("cabinetsCount") == before.get("cabinetsCount")))

# 4. 押金退还回写：合同 22 提前结束+退款 → 提交退款审批 → 审批通过 → 回写
requests.put(f"{B}/api/contracts/22", json={"earlyEndDate": "2026-09-30", "rentRefund": "500"}, headers=H)
r = requests.post(f"{B}/api/approvals", json={
    "bizType": "场地费退款", "title": "官南大道 台铃 提前终止退款", "applicant": "经办人", "contractId": 22,
    "amount": 1500, "rentAmount": 500, "reason": "验证：场地费退款 500 + 押金退还 1000", "landlordId": 5}, headers=H)
ap_id = r.json()["id"]
requests.post(f"{B}/api/approvals/{ap_id}/act", json={"action": "通过", "approver": "经办人"}, headers=H)
import psycopg2
conn = psycopg2.connect("postgresql://quant:quant-speed123@localhost:5432/huandian_v2")
cur = conn.cursor()
cur.execute("SELECT deposit_refund_amount, deposit_refund_date, deposit_refund_approval_id FROM contracts WHERE id=22")
dep = cur.fetchone()
ok.append((f"押金: 审批通过后回写押金退还 1000 元/日期/审批单（实际 {dep}）",
           dep[0] == 1000 and dep[2] == ap_id and dep[1] is not None))

# 5. 合同审计：22 应有 update 记录（含 operator=大老板 和字段 diff）
audit = requests.get(f"{B}/api/contracts/22/audit", headers=H).json()
upd = [a for a in audit if a["action"] == "update" and a.get("changes")]
ok.append((f"审计: update 记录含操作人与字段 diff（{len(audit)} 条）", len(audit) >= 2 and any(
    a.get("operator") == "大老板" and "earlyEndDate" in (a.get("changes") or {}) for a in upd)))

# 6. 电费 data_source：manual 写入 → 台账明细标记
r = requests.post(f"{B}/api/electricity", json={
    "landlordId": 13, "brandId": 17, "period": "202608",
    "payKwh": "10", "payAmount": "5", "collectKwh": "10", "collectAmount": "16", "collectNet": "15.84",
}, headers=H)
manual_flag = r.json().get("data_source") or r.json().get("dataSource")
ok.append((f"电费: 手工建台账 data_source=manual（实际 {manual_flag}）", manual_flag in ("manual",)))
requests.delete(f"{B}/api/electricity/{r.json()['id']}", headers=H)

# 清理：还原合同 22、删除测试审批单与审计记录
requests.put(f"{B}/api/contracts/22", json={"earlyEndDate": None, "rentRefund": None}, headers=H)
cur.execute("DELETE FROM approval_records WHERE request_id=%s", (ap_id,))
cur.execute("DELETE FROM approval_requests WHERE id=%s", (ap_id,))
cur.execute("DELETE FROM contract_audit_log WHERE contract_id=22 AND created_at > NOW() - INTERVAL '10 minutes'")
conn.commit(); cur.close(); conn.close()

n = sum(1 for _, v in ok if v)
for name, v in ok:
    print(("✅" if v else "❌"), name)
print(f"\n通过 {n}/{len(ok)}")
