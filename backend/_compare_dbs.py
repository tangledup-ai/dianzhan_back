# -*- coding: utf-8 -*-
"""远程 vs 本地 数据库结构与数据诊断（只读，不做任何修改）"""
import psycopg2, json

LOCAL = dict(host="localhost", port=5432, dbname="huandian_v2", user="quant", password="CHANGE_ME_DB_PASSWORD")
REMOTE = dict(host="121.43.104.161", port=6433, dbname="huandian_v2", user="quant", password="CHANGE_ME_DB_PASSWORD", connect_timeout=15)

def q(conn, sql, params=None):
    cur = conn.cursor()
    cur.execute(sql, params or ())
    rows = cur.fetchall()
    cur.close()
    return rows

lc = psycopg2.connect(**LOCAL)
rc = psycopg2.connect(**REMOTE)
print("✅ 远程连接成功")

# ── 0. 远程实例上的数据库列表（确认库名）──
rc.autocommit = True
dbs = [r[0] for r in q(rc, "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1")]
print("远程实例数据库:", dbs)
rc.autocommit = False

# ── 1. 表集合对比 ──
lt = set(r[0] for r in q(lc, "SELECT tablename FROM pg_tables WHERE schemaname='public'"))
rt = set(r[0] for r in q(rc, "SELECT tablename FROM pg_tables WHERE schemaname='public'"))
only_local = sorted(lt - rt)
only_remote = sorted(rt - lt)
print(f"\n== 表数量: 本地 {len(lt)} / 远程 {len(rt)} ==")
if only_local: print("仅本地有:", only_local)
if only_remote: print("仅远程有:", only_remote)

# ── 2. 每表列对比（本地有远程没有 → 远程缺列）──
lc_cols = {}
for t, c, dt, nullable, dflt in q(lc, """
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position"""):
    lc_cols.setdefault(t, {})[c] = (dt, nullable, dflt)
rc_cols = {}
for t, c, dt, nullable, dflt in q(rc, """
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position"""):
    rc_cols.setdefault(t, {})[c] = (dt, nullable, dflt)

common = sorted(lt & rt)
missing_pk, missing_cols, missing_uq = [], [], []
for t in common:
    lset, rset = set(lc_cols[t]), set(rc_cols[t])
    for c in sorted(lset - rset):
        missing_cols.append(f"{t}.{c} (类型 {lc_cols[t][c][0]})")

# ── 3. 主键对比 ──
PK_SQL = """
    SELECT kcu.table_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS pk
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema='public'
    GROUP BY kcu.table_name"""
lpk = {r[0]: r[1] for r in q(lc, PK_SQL)}
rpk = {r[0]: r[1] for r in q(rc, PK_SQL)}
rpk = {r[0]: r[1] for r in q(rc, PK_SQL)}
for t in common:
    lp, rp = lpk.get(t), rpk.get(t)
    if lp and not rp:
        missing_pk.append(f"{t}: 缺主键（本地主键 {lp}）")
    elif lp and rp and lp != rp:
        missing_pk.append(f"{t}: 主键不同（本地 {lp} / 远程 {rp}）")

# ── 4. 关键表在远程的行数（数据规模 sanity）──
key_tables = ["contracts", "rent_payment_schedule", "rent_income_schedule", "meters", "electricity_records", "approval_requests", "landlord_owners"]
print("\n== 关键表行数（本地 / 远程）==")
for t in key_tables:
    if t in common:
        ln = q(lc, f"SELECT COUNT(*) FROM {t}")[0][0]
        rn = q(rc, f"SELECT COUNT(*) FROM {t}")[0][0]
        print(f"  {t}: {ln} / {rn}")

print("\n== 汇总 ==")
print("缺主键的表:", missing_pk if missing_pk else "无")
print("缺列:", missing_cols[:20] if missing_cols else "无")

lc.close(); rc.close()
