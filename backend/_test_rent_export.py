# -*- coding: utf-8 -*-
"""验证 Rent 导出行数据：monthly-ledger yearlyRows → 导出字段"""
import sys, os, traceback, asyncio
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from starlette.requests import Request
from app.api.rent import monthly_ledger

scope = {"type": "http", "method": "GET", "path": "/api/rent/monthly-ledger", "headers": [],
         "query_string": b"", "client": ("127.0.0.1", 1), "server": ("test", 80), "scheme": "http"}
req = Request(scope)

async def main():
    r = await monthly_ledger(req, period="2026-08", dim="landlord")
    yrows = r.get("yearlyRows", [])
    print("yearlyRows:", len(yrows))
    for gy in yrows:
        venue = gy.get("venue") or {}
        brands = [b for b in gy.get("brands", []) if b.get("contractType") == "品牌方合同"]
        print(f"\n场地: {gy.get('landlordName')}  venue keys:", sorted(venue.keys()) if venue else None)
        print("  venue: start=%s end=%s 年租金=%s 付款方式=%s 押金=%s 负责人=%s" % (
            str(venue.get("startDate"))[:10], str(venue.get("endDate"))[:10],
            venue.get("annualRent"), venue.get("payMethod"), venue.get("deposit"), venue.get("landlordContact")))
        for c in brands:
            cabinets = float(c.get("cabinetsCount") or 1)
            unit_monthly = c.get("unitMonthlyRent")
            unit_annual = round(float(unit_monthly) * 12, 2) if unit_monthly is not None else None
            tax_rate = float(c.get("rentTaxRate") or 0)
            input_cost = float(c.get("inputCost") or 0)
            gross = round(unit_annual * cabinets, 2) if unit_annual is not None else None
            net = round(gross * (1 - tax_rate), 2) if gross is not None and tax_rate > 0 else gross
            unit_cost = c.get("unitCostAnnual")
            rent_cost_annual = round(float(unit_cost) * cabinets, 2) if unit_cost is not None else None
            profit = round(net - rent_cost_annual - input_cost, 2) if net is not None and rent_cost_annual is not None else None
            print(f"  品牌={c.get('brandName')} 柜数={cabinets} 单台月租={unit_monthly} 单台年收入={unit_annual}")
            print(f"    租金收入含税/年={gross} 税率={tax_rate} 不含税={net} 单台成本/年={unit_cost} 承租成本/年={rent_cost_annual} 进项={input_cost} 利润={profit}")
            print(f"    合同收款租期={str(c.get('startDate'))[:10]}~{str(c.get('endDate'))[:10]} 到账情况={c.get('yearStatus')}")

asyncio.run(main())
