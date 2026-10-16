# -*- coding: utf-8 -*-
import psycopg2
conn = psycopg2.connect(host="127.0.0.1", port=5432, dbname="huandian_v2", user="quant", password="CHANGE_ME_DB_PASSWORD")
cur = conn.cursor()

print("== electricity_records 全量 ==")
cur.execute("""
    SELECT period, landlord_id, brand_id, pay_amount, collect_net, profit, pay_status, collect_status
    FROM electricity_records ORDER BY period, landlord_id
""")
rows = cur.fetchall()
for r in rows:
    print(" ", r)
print("SUM pay =", sum(r[3] for r in rows), "collect_net =", sum(r[4] for r in rows), "profit =", sum(r[5] for r in rows))

print("\n== meters 总数（非TEST）==")
cur.execute("SELECT COUNT(*) FROM meters WHERE meter_no NOT LIKE 'TEST%'")
print(" ", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM meters WHERE meter_no NOT LIKE 'TEST%' AND landlord_id IS NOT NULL AND brand_id IS NOT NULL")
print(" 实表:", cur.fetchone()[0])

print("\n== cabinets ==")
cur.execute("SELECT COUNT(*) FROM cabinets")
print(" ", cur.fetchone()[0])

print("\n== rent_income_schedule 未到账 ==")
cur.execute("SELECT COALESCE(SUM(amount),0) FROM rent_income_schedule WHERE status='未到账'")
print(" ", cur.fetchone()[0])

print("\n== 合同 ==")
cur.execute("SELECT COUNT(*) FROM contracts WHERE end_date IS NOT NULL AND end_date < CURRENT_DATE")
print(" 已到期:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM contracts WHERE end_date IS NOT NULL AND end_date >= CURRENT_DATE AND end_date <= CURRENT_DATE + INTERVAL '90 days'")
print(" 临期:", cur.fetchone()[0])
conn.close()
