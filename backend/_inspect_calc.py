# -*- coding: utf-8 -*-
"""验证 dividend_calc estimate 返回结构，供前端明细弹窗核对字段"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.domain.dividend_calc import DividendCalculator

calc = DividendCalculator()
r = calc.calculate(5, None, "202608", estimate=True)
print("== 顶层 keys ==")
print(list(r.keys()))
print("profit =", r["profit"], " period =", r["period"])
print()
print("== income ==")
print(" elecIncome.total =", r["income"]["elecIncome"]["total"])
for d in r["income"]["elecIncome"]["details"][:4]:
    print("   ", d)
print(" rentIncome.total =", r["income"]["rentIncome"]["total"])
for d in r["income"]["rentIncome"]["details"][:4]:
    print("   ", d)
print()
print("== cost ==")
print(" elecCost =", r["cost"]["elecCost"], " rentCost =", r["cost"]["rentCost"], " opExpense =", r["cost"]["opExpense"])
print(" elecTax =", r["cost"]["elecTax"], " rentTax =", r["cost"]["rentTax"], " rentRefund =", r["cost"]["rentRefund"], " totalCost =", r["cost"]["totalCost"])
print(" cost.details keys =", list(r["cost"]["details"].keys()))
print("  electricity:", r["cost"]["details"]["electricity"][:3])
print("  rent:", r["cost"]["details"]["rent"])
print("  operatingExpense:", r["cost"]["details"]["operatingExpense"])
print("  elecTax.details:", r["cost"]["details"]["elecTax"]["details"])
print("  rentTax.details:", r["cost"]["details"]["rentTax"]["details"])
print()
print("== brandBreakdown ==")
for b in r["brandBreakdown"]:
    print("  ", b)
print()
print("== shareholderDividends ==")
for d in r["shareholderDividends"]:
    print("  ", {k: d[k] for k in ["shareholderId", "shareholderName", "brandId", "brandName", "mode", "ratio", "fixedAmount", "baseAmount", "amount", "settlementPeriod", "isSettlementMonth", "periodStartMonth"]})
print()
print("== summary ==", r["summary"])
