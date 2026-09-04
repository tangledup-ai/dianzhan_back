# -*- coding: utf-8 -*-
"""远程库加固：补齐缺失索引（先去重）+ 清理 Excel 导入的合同数据"""
import psycopg2, re

conn = psycopg2.connect(host="121.43.104.161", port=6433, dbname="huandian_v2",
                        user="quant", password="quant-speed123", connect_timeout=15)
conn.autocommit = True
cur = conn.cursor()

# ── 1. 本地有而远程缺失的索引 ──
loc = psycopg2.connect(host="localhost", port=5432, dbname="huandian_v2", user="quant", password="quant-speed123")
lcur = loc.cursor()
lcur.execute("SELECT indexdef FROM pg_indexes WHERE schemaname='public'")
lidx = set(r[0] for r in lcur.fetchall())
cur.execute("SELECT indexdef FROM pg_indexes WHERE schemaname='public'")
ridx = set(r[0] for r in cur.fetchall())
missing = sorted(lidx - ridx)
print(f"缺失索引 {len(missing)} 个，逐个补齐（先去重再创建）:")
fail = []
for idxdef in sorted(missing):
    m = re.search(r"ON public\.(\w+) USING btree \((.+)\)", idxdef)
    if not m:
        continue
    table, cols_raw = m.group(1), m.group(2)
    cols = [c.strip().replace(" DESC", "").replace(" ASC", "") for c in cols_raw.split(",")]
    # 去重（保留 id 最大的一行）
    cond = " AND ".join(f"a.{c} = b.{c}" for c in cols)
    try:
        cur.execute(f"DELETE FROM {table} a USING {table} b WHERE {cond} AND a.id < b.id")
        dup = cur.rowcount
        cur.execute(idxdef)
        name = re.search(r"INDEX (\S+) ON", idxdef).group(1)
        print(f"  ✅ {name}（去重 {dup} 行）")
    except Exception as e:
        conn.rollback()
        fail.append((table, str(e)[:80]))
        print(f"  ❌ {table}: {str(e)[:80]}")
if fail:
    print("失败列表:", fail)

# ── 2. 清理 Excel 导入的合同及相关数据 ──
cur.execute("SELECT contract_id FROM contract_audit_log WHERE action='create' AND operator='Excel导入'")
contract_ids = [r[0] for r in cur.fetchall()]
cur.execute("SELECT DISTINCT changes->'snapshot'->>'landlord_id' FROM contract_audit_log WHERE action='create' AND operator='Excel导入'")
landlord_ids = [int(r[0]) for r in cur.fetchall() if r[0]]
print(f"\n清理 Excel 导入数据: 合同 {len(contract_ids)} 份, 场地方 {len(landlord_ids)} 个")

# 关联的审批单（电费付款等引用了这些合同）
cur.execute("SELECT id FROM approval_requests WHERE contract_id = ANY(%s::int[])", (contract_ids,))
ap_ids = [r[0] for r in cur.fetchall()]
for aid in ap_ids:
    cur.execute("DELETE FROM approval_records WHERE request_id=%s", (aid,))
    cur.execute("DELETE FROM approval_dividend_records WHERE approval_id=%s", (aid,))
cur.execute("DELETE FROM approval_requests WHERE contract_id = ANY(%s::int[])", (contract_ids,))
print(f"  关联审批单删除: {len(ap_ids)} 个")

for cid in contract_ids:
    cur.execute("DELETE FROM rent_payment_schedule WHERE contract_id=%s", (cid,))
    cur.execute("DELETE FROM rent_income_schedule WHERE contract_id=%s", (cid,))
    cur.execute("DELETE FROM contract_audit_log WHERE contract_id=%s", (cid,))
cur.execute("DELETE FROM contracts WHERE id = ANY(%s::int[])", (contract_ids,))
print("  合同及分期/审计已删除")

cur.execute("""
    DELETE FROM electricity_meter_details WHERE electricity_id IN (
        SELECT id FROM electricity_records WHERE landlord_id = ANY(%s::int[]))
""", (landlord_ids,))
cur.execute("DELETE FROM electricity_records WHERE landlord_id = ANY(%s::int[])", (landlord_ids,))
print("  自动生成的电费台账已删除")

cur.execute("DELETE FROM landlord_owners WHERE landlord_id = ANY(%s::int[])", (landlord_ids,))
cur.execute("DELETE FROM landlords WHERE id = ANY(%s::int[])", (landlord_ids,))
print("  场地方及业主记录已删除")

# ── 3. 验证 ──
cur.execute("SELECT COUNT(*) FROM contracts WHERE id = ANY(%s::int[])", (contract_ids,))
print("\n合同残留:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM landlords WHERE id = ANY(%s::int[])", (landlord_ids,))
print("场地方残留:", cur.fetchone()[0])
cur.execute("SELECT indexname FROM pg_indexes WHERE schemaname='public'")
remote_now = set(r[0] for r in cur.fetchall())
still_missing = [m for m in missing if re.search(r"INDEX (\S+) ON", m).group(1) not in remote_now]
print("索引仍缺:", still_missing if still_missing else "无 ✓")

cur.close(); loc.close(); conn.close()
