# -*- coding: utf-8 -*-
"""模拟前端"按场地方导出"：对每个场地逐月 calculate，检查导出字段是否为空"""
import sys, os, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app.domain.dividend_calc import DividendCalculator

calc = DividendCalculator()
landlords = [(4, "螺蛳湾"), (5, "官南大道"), (7, "文创园")]
months = ["202608"]

for lid, name in landlords:
    print(f"== {name} (landlord {lid}) ==")
    try:
        d = calc.calculate(lid, None, "202608", estimate=True)
        if not d:
            print("  -> calculate 返回 None")
            continue
        kwh = sum(x.get("kwh") or 0 for x in (d["income"]["elecIncome"]["details"] or []))
        elec_gross = sum((x.get("kwh") or 0) * (x.get("unitPrice") or 0) for x in (d["income"]["elecIncome"]["details"] or []))
        rent_gross = sum(x.get("preTaxRent") or 0 for x in (d["income"]["rentIncome"]["details"] or []))
        pay_price = (d["cost"]["details"]["electricity"] or [{}])[0].get("unitPrice")
        print(f"  电量={kwh} 付款单价={pay_price} 付款={d['cost']['elecCost']} 电费含税={elec_gross} 电费不含税={d['income']['elecIncome']['total']}")
        print(f"  租金含税={rent_gross} 租金不含税={d['income']['rentIncome']['total']} 合计={d['income']['totalIncome']} 利润={d['profit']}")
        print(f"  股东分红={[(x['shareholderName'], x['amount']) for x in d['shareholderDividends']]}")
        print(f"  商务分红={[(x['introducerName'], x['amount']) for x in d['bizDividends']]}")
    except Exception as e:
        print("  异常:", type(e).__name__, e)
