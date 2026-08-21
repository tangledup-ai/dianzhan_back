import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
os.environ.setdefault("DATABASE_URL", "postgresql://quant:quant-speed123@127.0.0.1:5432/huandian_v2")
from app.infra.database import get_connection

conn = get_connection()
cur = conn.cursor()
tables = ['station_shareholder_configs', 'station_introducer_configs',
          'rent_leases', 'rent_incomes', 'rent_income_records', 'rent_payment_records',
          'rent_receipts', 'rent_income_schedule', 'rent_payment_schedule',
          'landlord_shareholder_configs', 'landlord_introducer_configs']
for t in tables:
    cur.execute(f"SELECT COUNT(*) FROM {t}")
    print(t, "->", cur.fetchone()[0])
cur.close()
conn.close()
