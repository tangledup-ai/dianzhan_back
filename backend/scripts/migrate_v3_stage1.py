# -*- coding: utf-8 -*-
"""v3 阶段1：去站点层——表结构 + 数据迁移（先备份）"""
import psycopg2, datetime

HOST = "127.0.0.1"; USER = "quant"; PWD = "quant-speed123"; DB = "huandian_v2"
BAK = r"backend\scripts\backup_v3_stage1.sql"

conn = psycopg2.connect(host=HOST, user=USER, password=PWD, dbname=DB)
conn.autocommit = True
cur = conn.cursor()

BACKUP_TABLES = ["electricity_records", "electricity_meter_details", "operating_expenses",
                 "dividend_records", "dividend_shares",
                 "station_shareholder_configs", "station_introducer_configs",
                 "approval_requests", "approval_records", "approval_dividend_records"]

# ── ① 备份 ──
print("=== 备份 →", BAK)
with open(BAK, "w", encoding="utf-8") as f:
    f.write(f"-- v3 阶段1 备份（{datetime.date.today()}）\n")
    for t in BACKUP_TABLES:
        cur.execute(f"SELECT * FROM {t}")
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
        f.write(f"-- {t}: {len(rows)} 行\n")
        for r in rows:
            vals = []
            for v in r:
                if v is None: vals.append("NULL")
                elif isinstance(v, (int, float)): vals.append(str(v))
                elif isinstance(v, (datetime.date, datetime.datetime)): vals.append(f"'{v}'")
                else: vals.append("'" + str(v).replace("'", "''") + "'")
            f.write(f"INSERT INTO {t} ({', '.join(cols)}) VALUES ({', '.join(vals)});\n")
        f.write("\n")
print("备份完成")

# ── ② 加列 ──
print("=== 加列 ===")
cur.execute("ALTER TABLE electricity_records ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id)")
cur.execute("ALTER TABLE electricity_records ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id)")
cur.execute("ALTER TABLE operating_expenses ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id)")
cur.execute("ALTER TABLE dividend_records ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id)")
cur.execute("ALTER TABLE dividend_records ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id)")
cur.execute("ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id)")
print("加列完成")

# ── ③ 数据迁移（站 → 场地+品牌） ──
print("=== 数据迁移 ===")
cur.execute("""
    WITH st AS (
        SELECT s.id AS station_id, s.landlord_id,
               (SELECT MIN(brand_id) FROM meters m WHERE m.station_id = s.id AND m.brand_id IS NOT NULL) AS brand_id
        FROM stations s
    )
    UPDATE electricity_records e SET landlord_id = st.landlord_id, brand_id = st.brand_id
    FROM st WHERE e.station_id = st.station_id
""")
print("electricity_records 迁移:", cur.rowcount, "行")
cur.execute("""
    WITH st AS (SELECT s.id AS station_id, s.landlord_id FROM stations s)
    UPDATE operating_expenses o SET landlord_id = st.landlord_id
    FROM st WHERE o.station_id = st.station_id
""")
print("operating_expenses 迁移:", cur.rowcount, "行")
cur.execute("""
    WITH st AS (
        SELECT s.id AS station_id, s.landlord_id,
               (SELECT MIN(brand_id) FROM meters m WHERE m.station_id = s.id AND m.brand_id IS NOT NULL) AS brand_id
        FROM stations s
    )
    UPDATE dividend_records d SET landlord_id = st.landlord_id, brand_id = st.brand_id
    FROM st WHERE d.station_id = st.station_id
""")
print("dividend_records 迁移:", cur.rowcount, "行")
cur.execute("""
    WITH st AS (SELECT s.id AS station_id, s.landlord_id FROM stations s)
    UPDATE approval_requests a SET landlord_id = st.landlord_id
    FROM st WHERE a.station_id = st.station_id
""")
print("approval_requests 迁移:", cur.rowcount, "行")

# ── ④ 建 landlord_* 配置表（新）+ 迁移 ──
print("=== 配置表改名重建 ===")
cur.execute("DROP TABLE IF EXISTS landlord_shareholder_configs CASCADE")
cur.execute("""
    CREATE TABLE landlord_shareholder_configs (
        id SERIAL PRIMARY KEY,
        landlord_id INTEGER NOT NULL REFERENCES landlords(id),
        shareholder_id INTEGER NOT NULL REFERENCES shareholders(id),
        brand_id INTEGER REFERENCES brands(id),
        mode VARCHAR(20) NOT NULL,
        ratio NUMERIC(6,4),
        fixed_amount NUMERIC(12,2),
        settlement_period VARCHAR(10) NOT NULL DEFAULT '月',
        start_date DATE, end_date DATE,
        remark VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )
""")
cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS uq_lsh_conf_whole ON landlord_shareholder_configs
               (landlord_id, shareholder_id, COALESCE(start_date, DATE '1970-01-01')) WHERE brand_id IS NULL""")
cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS uq_lsh_conf_brand ON landlord_shareholder_configs
               (landlord_id, brand_id, shareholder_id, COALESCE(start_date, DATE '1970-01-01')) WHERE brand_id IS NOT NULL""")
cur.execute("DROP TABLE IF EXISTS landlord_introducer_configs CASCADE")
cur.execute("""
    CREATE TABLE landlord_introducer_configs (
        id SERIAL PRIMARY KEY,
        landlord_id INTEGER NOT NULL REFERENCES landlords(id),
        introducer_id INTEGER NOT NULL REFERENCES introducers(id),
        brand_id INTEGER REFERENCES brands(id),
        mode VARCHAR(20) NOT NULL,
        ratio NUMERIC(6,4),
        fixed_amount NUMERIC(12,2),
        settlement_period VARCHAR(10) NOT NULL DEFAULT '月',
        count_as_cost BOOLEAN DEFAULT FALSE,
        start_date DATE, end_date DATE,
        remark VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )
""")
cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS uq_lin_conf_whole ON landlord_introducer_configs
               (landlord_id, introducer_id, COALESCE(start_date, DATE '1970-01-01')) WHERE brand_id IS NULL""")
cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS uq_lin_conf_brand ON landlord_introducer_configs
               (landlord_id, brand_id, introducer_id, COALESCE(start_date, DATE '1970-01-01')) WHERE brand_id IS NOT NULL""")
cur.execute("""
    INSERT INTO landlord_shareholder_configs (landlord_id, shareholder_id, brand_id, mode, ratio, fixed_amount,
        settlement_period, start_date, end_date, remark, created_at, updated_at)
    SELECT s.landlord_id, c.shareholder_id, c.brand_id, c.mode, c.ratio, c.fixed_amount, c.settlement_period,
           c.start_date, c.end_date, c.remark, c.created_at, c.updated_at
    FROM station_shareholder_configs c JOIN stations s ON c.station_id = s.id
""")
print("股东配置迁移:", cur.rowcount, "行")
cur.execute("""
    INSERT INTO landlord_introducer_configs (landlord_id, introducer_id, brand_id, mode, ratio, fixed_amount,
        settlement_period, count_as_cost, start_date, end_date, remark, created_at, updated_at)
    SELECT s.landlord_id, c.introducer_id, c.brand_id, c.mode, c.ratio, c.fixed_amount, c.settlement_period,
           c.count_as_cost, c.start_date, c.end_date, c.remark, c.created_at, c.updated_at
    FROM station_introducer_configs c JOIN stations s ON c.station_id = s.id
""")
print("介绍人配置迁移:", cur.rowcount, "行")

# ── ⑤ 新唯一键（无重复才建） ──
cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS uq_er_landlord_brand_period
               ON electricity_records (landlord_id, brand_id, period)""")
cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS uq_oe_landlord_period
               ON operating_expenses (landlord_id, period)""")
print("唯一键建立完成")

# ── ⑥ 验证 ──
print("=== 验证 ===")
cur.execute("""
    SELECT e.period, l.name AS landlord, b.name AS brand, COUNT(*)
    FROM electricity_records e
    LEFT JOIN landlords l ON e.landlord_id = l.id
    LEFT JOIN brands b ON e.brand_id = b.id
    GROUP BY e.period, l.name, b.name ORDER BY e.period DESC LIMIT 6""")
print("台账 场地×品牌 分布:")
for r in cur.fetchall(): print("  ", r)
cur.execute("SELECT COUNT(*) FROM electricity_records WHERE landlord_id IS NULL")
print("台账缺 landlord 的行:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM landlord_shareholder_configs")
print("landlord_shareholder_configs 行数:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM landlord_introducer_configs")
print("landlord_introducer_configs 行数:", cur.fetchone()[0])
cur.close(); conn.close()
print("DONE")
