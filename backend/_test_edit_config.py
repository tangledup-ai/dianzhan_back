# -*- coding: utf-8 -*-
"""验证配置编辑：新增后带 configId 更新（改品牌/日期），确认仍是同一条 id"""
import sys, os, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app.repositories import dividend_repo

cfg_id = None
try:
    # 1. 新增（全场 利润分红 10%）
    c = dividend_repo.save_shareholder_config({
        "landlordId": 5, "shareholderId": 3, "brandId": None,
        "mode": "利润分红", "ratio": 0.1, "fixedAmount": None,
        "settlementPeriod": "月", "startDate": None, "endDate": None, "remark": None,
    })
    cfg_id = c["id"]
    print("新增 id =", cfg_id, "brand =", c["brand_id"], "ratio =", c["ratio"])

    # 2. 编辑：带 configId，改成 台铃品牌(2) + 季度 + 20% + 生效日期
    c2 = dividend_repo.save_shareholder_config({
        "landlordId": 5, "shareholderId": 3, "brandId": 2,
        "mode": "利润分红", "ratio": 0.2, "fixedAmount": None,
        "settlementPeriod": "季度", "startDate": "2026-09-01", "endDate": None,
        "remark": "edited", "configId": cfg_id,
    })
    print("编辑后 id =", c2["id"], "(应仍为", cfg_id, ") brand =", c2["brand_id"],
          "ratio =", c2["ratio"], "period =", c2["settlement_period"], "start =", c2["start_date"])

    # 3. 确认只有一条
    rows = dividend_repo.list_shareholder_configs(landlord_id=5)
    print("该场地配置总数 =", len(rows), "(应=1)")
    assert c2["id"] == cfg_id
    assert len(rows) == 1
    print("OK: 编辑按 id 更新，未产生重复配置")
except Exception:
    traceback.print_exc()
finally:
    import psycopg2
    conn = psycopg2.connect(host="127.0.0.1", port=5432, dbname="huandian_v2", user="quant", password="CHANGE_ME_DB_PASSWORD")
    cur = conn.cursor()
    if cfg_id:
        cur.execute("DELETE FROM landlord_shareholder_configs WHERE id = %s", (cfg_id,))
    conn.commit(); conn.close()
    print("cleaned")
