# -*- coding: utf-8 -*-
"""开发阶段数据清理（谨慎版）：
保留：meters 相关（第三方来源）+ 档案（brands/entities/landlords/shareholders/introducers 等，meters 外键依赖）
清除：派生/人工业务数据（台账/分红/运营费用/合同/审批/分红配置/旧租金台账）
步骤：① 备份待清表 → SQL 文件；② TRUNCATE CASCADE；③ 验证保留表完好
"""
import psycopg2, datetime

HOST = "127.0.0.1"; USER = "quant"; PWD = "CHANGE_ME_DB_PASSWORD"; DB = "huandian_v2"
BAK = r"backend\scripts\backup_dev_data.sql"

# 待清表（子表在前，TRUNCATE 用 CASCADE 更稳，但备份按依赖顺序）
CLEAR_TABLES = [
    "electricity_meter_details", "electricity_records",
    "operating_expenses",
    "dividend_shares", "dividend_records",
    "approval_records", "approval_requests", "approval_dividend_records",
    "rent_payment_schedule", "rent_income_schedule", "contracts",
    "rent_receipts", "rent_incomes", "rent_leases",
    "rent_payment_records", "rent_income_records",
    "station_shareholder_configs", "station_introducer_configs",
]

conn = psycopg2.connect(host=HOST, user=USER, password=PWD, dbname=DB)
conn.autocommit = True
cur = conn.cursor()

# ── ① 备份 ──
print("=== 备份待清数据 →", BAK)
with open(BAK, "w", encoding="utf-8") as f:
    f.write(f"-- 开发阶段数据备份（{datetime.date.today()}）\n")
    for t in CLEAR_TABLES:
        cur.execute(f'SELECT * FROM {t}')
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
        f.write(f"-- {t}: {len(rows)} 行\n")
        for r in rows:
            vals = []
            for v in r:
                if v is None:
                    vals.append("NULL")
                elif isinstance(v, (int, float)):
                    vals.append(str(v))
                elif isinstance(v, (datetime.date, datetime.datetime)):
                    vals.append(f"'{v}'")
                else:
                    vals.append("'" + str(v).replace("'", "''") + "'")
            f.write(f"INSERT INTO {t} ({', '.join(cols)}) VALUES ({', '.join(vals)});\n")
        f.write("\n")
    f.write(f"-- 备份完成（{datetime.date.today()}）\n")

# 打印行数
print("=== 清理前行数 ===")
for t in CLEAR_TABLES:
    cur.execute(f'SELECT COUNT(*) FROM {t}')
    print(f"  {t}: {cur.fetchone()[0]}")

# ── ② 清理 ──
print("=== TRUNCATE CASCADE ===")
cur.execute("TRUNCATE TABLE " + ", ".join(CLEAR_TABLES) + " CASCADE")
print("清理完成")

# ── ③ 验证 ──
print("=== 清理后验证 ===")
for t in CLEAR_TABLES:
    cur.execute(f'SELECT COUNT(*) FROM {t}')
    print(f"  {t}: {cur.fetchone()[0]} (应为 0)")
KEEP = ["meters", "meter_devices", "meter_monthly", "meter_daily", "meter_status_cache", "third_party_configs",
        "cabinets", "brands", "entities", "landlords", "shareholders", "introducers", "platform_users"]
for t in KEEP:
    cur.execute(f'SELECT COUNT(*) FROM {t}')
    print(f"  保留 {t}: {cur.fetchone()[0]}")
cur.close(); conn.close()
print("DONE")
