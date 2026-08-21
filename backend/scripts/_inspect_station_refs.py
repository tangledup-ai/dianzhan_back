import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
os.environ.setdefault("DATABASE_URL", "postgresql://quant:quant-speed123@127.0.0.1:5432/huandian_v2")
from app.infra.database import get_connection

conn = get_connection()
cur = conn.cursor()
cur.execute("""
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'stations'
    ORDER BY tc.table_name
""")
print("FK refs to stations:")
for r in cur.fetchall():
    print(" ", r)
cur.execute("""
    SELECT tc.constraint_name, tc.table_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'stations'
    ORDER BY tc.table_name
""")
print("FK constraint names:")
for r in cur.fetchall():
    print(" ", r)
cur.execute("""
    SELECT table_name, column_name FROM information_schema.columns
    WHERE column_name = 'station_id' ORDER BY table_name
""")
print("station_id columns:")
for r in cur.fetchall():
    print(" ", r)
cur.close()
conn.close()
