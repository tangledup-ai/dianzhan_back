import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["DATABASE_URL"] = "postgresql://quant:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/huandian_v2"
from app.domain.dividend_calc import dividend_calculator
from app.repositories import dividend_repo

# 建一条季度分红配置测试（股东3，整场地，利润分红 10%）
dividend_repo.save_shareholder_config({
    "landlordId": 5, "shareholderId": 3, "brandId": None,
    "mode": "利润分红", "ratio": 0.1, "settlementPeriod": "季度",
    "startDate": None, "endDate": None,
})

for p in ["202608", "202609"]:
    # 非预估（正式）：季度 8 月 multiplier=0 → 0；9 月 multiplier=3
    r = dividend_calculator.calculate(5, None, p)
    print(f"[{p}] 正式 amount:", [(d['shareholderName'], d['amount'], d['isSettlementMonth']) for d in r['shareholderDividends']])
    # 预估：恒为 1
    e = dividend_calculator.calculate(5, None, p, estimate=True)
    print(f"[{p}] 预估 amount:", [(d['shareholderName'], d['amount'], d['isSettlementMonth'], d['periodStartMonth']) for d in e['shareholderDividends']])
    print(f"    8月利润={r['profit']}, 预估9月利润={e['profit']}")

# 清理
from app.infra.database import get_connection
conn = get_connection(); cur = conn.cursor()
cur.execute("DELETE FROM landlord_shareholder_configs WHERE landlord_id=5 AND shareholder_id=3")
conn.commit(); cur.close(); conn.close()
print("CLEANED")
