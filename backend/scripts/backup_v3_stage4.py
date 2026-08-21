"""v3 阶段4 备份：stations 及含 station_id 的表 → backend/scripts/backup_v3_stage4/ 目录 CSV"""
import sys, os, csv
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
os.environ.setdefault("DATABASE_URL", "postgresql://quant:quant-speed123@127.0.0.1:5432/huandian_v2")
from app.infra.database import get_connection

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backup_v3_stage4")
os.makedirs(OUT, exist_ok=True)

TABLES = [
    "stations",
    "meters", "contracts", "electricity_records", "operating_expenses",
    "dividend_records", "approval_requests",
    "rent_payment_schedule", "rent_income_schedule",
    "landlord_shareholder_configs", "landlord_introducer_configs",
    "station_shareholder_configs", "station_introducer_configs",
    "rent_leases", "rent_incomes", "rent_income_records", "rent_payment_records", "rent_receipts",
]

conn = get_connection()
cur = conn.cursor()
for t in TABLES:
    cur.execute(f"SELECT COUNT(*) FROM {t}")
    n = cur.fetchone()[0]
    path = os.path.join(OUT, f"{t}.csv")
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        cur.copy_expert(f"COPY {t} TO STDOUT WITH CSV HEADER", f)
    print(f"{t}: {n} rows -> {path}")
cur.close()
conn.close()
print("BACKUP DONE")
