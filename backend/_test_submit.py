# -*- coding: utf-8 -*-
"""验证分红提交审批全链路（配置→记录→shares→审批单→状态回写），测后清理"""
import sys, os, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.repositories import dividend_repo, approval_repo
from app.domain.dividend_calc import DividendCalculator

created_ids = {"cfg": None, "record": None, "approval": None}

try:
    # 1. 临时配置：官南大道 股东1号 全场 利润分红10% 月
    cfg = dividend_repo.save_shareholder_config({
        "landlordId": 5, "shareholderId": 3, "brandId": None,
        "mode": "利润分红", "ratio": 0.1, "fixedAmount": None,
        "settlementPeriod": "月", "startDate": None, "endDate": None, "remark": None,
    })
    created_ids["cfg"] = cfg["id"]
    print("配置:", cfg["id"], cfg["mode"], cfg["ratio"])

    # 2. 计算并创建记录（202608 结算月）
    calc = DividendCalculator().calculate(5, None, "202608")
    print("profit =", calc["profit"], "分红:", calc["summary"])
    record = dividend_repo.create_record({
        "landlordId": 5, "brandId": None, "period": "202608", "type": "股东分红",
        "elecIncome": calc["income"]["elecIncome"]["total"],
        "rentIncome": calc["income"]["rentIncome"]["total"],
        "totalIncome": calc["income"]["totalIncome"],
        "elecCost": calc["cost"]["elecCost"], "rentCost": calc["cost"]["rentCost"],
        "opExpense": calc["cost"]["opExpense"], "bizDividendCost": calc["cost"]["bizDividendCost"],
        "totalCost": calc["cost"]["totalCost"], "profit": calc["profit"],
        "status": "未结算", "settlementDate": calc.get("settlementDate"),
    })
    created_ids["record"] = record["id"]
    for d in calc["shareholderDividends"]:
        dividend_repo.create_share(record["id"], {
            "shareholderId": d["shareholderId"], "brandId": d.get("brandId"),
            "mode": d["mode"], "ratio": d.get("ratio"), "fixedAmount": d.get("fixedAmount"),
            "amount": d["amount"],
        })
    print("记录:", record["id"], "status=", record["status"])

    # 3. 模拟 submit_dividend
    shares = dividend_repo.get_shares(record["id"])
    dividend_total = round(sum(float(s.get("amount") or 0) for s in shares), 2)
    amount = dividend_total if dividend_total > 0 else (record.get("profit") or 0)
    approval = approval_repo.create_request({
        "bizType": "分红审批",
        "title": f"{record.get('landlord_name', '')} {record['period']} 分红",
        "reason": None, "amount": amount, "applicant": "测试财务",
        "dividendRecordId": record["id"], "landlordId": 5, "period": "202608",
    })
    created_ids["approval"] = approval["id"]
    dividend_repo.update_status(record["id"], "申报中")
    print("审批单:", approval["id"], "amount=", amount, "flow=", len(approval.get("flow_nodes") or []), "节点")

    # 4. 验证关联与列表返回
    rec = dividend_repo.get_record(record["id"])
    print("记录状态:", rec["status"], "approval_id=", rec.get("approval_id"))
    reqs = approval_repo.list_requests(biz_type="分红审批")
    r = next((x for x in reqs if x["id"] == approval["id"]), None)
    if r:
        print("list_requests: landlord_id=", r.get("landlord_id"), "landlord_name=", r.get("landlord_name"),
              "period=", r.get("period"), "dividend_period=", r.get("dividend_period"))
    print("OK")
except Exception:
    traceback.print_exc()
finally:
    # 清理
    import psycopg2
    conn = psycopg2.connect(host="127.0.0.1", port=5432, dbname="huandian_v2", user="quant", password="quant-speed123")
    cur = conn.cursor()
    if created_ids["approval"]:
        aid = created_ids["approval"]
        cur.execute("DELETE FROM approval_dividend_records WHERE approval_id = %s", (aid,))
        cur.execute("DELETE FROM approval_records WHERE request_id = %s", (aid,))
        cur.execute("DELETE FROM approval_requests WHERE id = %s", (aid,))
    if created_ids["record"]:
        rid = created_ids["record"]
        cur.execute("DELETE FROM dividend_shares WHERE dividend_id = %s", (rid,))
        cur.execute("DELETE FROM dividend_records WHERE id = %s", (rid,))
    if created_ids["cfg"]:
        cur.execute("DELETE FROM landlord_shareholder_configs WHERE id = %s", (created_ids["cfg"],))
    conn.commit()
    conn.close()
    print("cleaned")
