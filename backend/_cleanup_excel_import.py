# -*- coding: utf-8 -*-
"""清理本地 Excel 导入的合同与场地方（审计日志精准定位）"""
import psycopg2
conn = psycopg2.connect("postgresql://quant:quant-speed123@localhost:5432/huandian_v2")
cur = conn.cursor()

# 1. 定位 Excel导入 创建的合同与场地方
cur.execute("SELECT contract_id FROM contract_audit_log WHERE action='create' AND operator='Excel导入'")
contract_ids = [r[0] for r in cur.fetchall()]
cur.execute("SELECT DISTINCT changes->'snapshot'->>'landlord_id' FROM contract_audit_log WHERE action='create' AND operator='Excel导入'")
landlord_ids = [int(r[0]) for r in cur.fetchall() if r[0]]
print(f"待删除: 合同 {len(contract_ids)} 份, 场地方 {len(landlord_ids)} 个")

# 2. 删合同及从属
for cid in contract_ids:
    cur.execute("DELETE FROM rent_payment_schedule WHERE contract_id=%s", (cid,))
    cur.execute("DELETE FROM rent_income_schedule WHERE contract_id=%s", (cid,))
    cur.execute("DELETE FROM contract_audit_log WHERE contract_id=%s", (cid,))
cur.execute("DELETE FROM contracts WHERE id = ANY(%s::int[])", (contract_ids,))
print("合同及分期/审计已删除")

# 3. 删自动生成的电费台账
cur.execute("""
    DELETE FROM electricity_meter_details WHERE electricity_id IN (
        SELECT id FROM electricity_records WHERE landlord_id = ANY(%s::int[]))
""", (landlord_ids,))
cur.execute("DELETE FROM electricity_records WHERE landlord_id = ANY(%s::int[])", (landlord_ids,))
print("电费台账（自动生成）已删除")

# 4. 删场地方（级联业主）
cur.execute("DELETE FROM landlord_owners WHERE landlord_id = ANY(%s::int[])", (landlord_ids,))
cur.execute("DELETE FROM landlords WHERE id = ANY(%s::int[])", (landlord_ids,))
print("场地方及业主记录已删除")

conn.commit()

# 5. 验证残留
cur.execute("SELECT COUNT(*) FROM contracts WHERE id = ANY(%s::int[])", (contract_ids,))
print("合同残留:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM landlords WHERE id = ANY(%s::int[])", (landlord_ids,))
print("场地方残留:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM contracts")
print("当前合同总数:", cur.fetchone()[0])
cur.close(); conn.close()
