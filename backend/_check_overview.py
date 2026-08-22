# -*- coding: utf-8 -*-
"""检查经营总览数据：overview() + monthly_detail() 输出 vs 期望口径"""
import sys, os, traceback, asyncio
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from starlette.requests import Request
from app.api.overview import overview, monthly_detail

scope = {"type": "http", "method": "GET", "path": "/api/overview", "headers": [],
         "query_string": b"", "client": ("127.0.0.1", 1), "server": ("test", 80), "scheme": "http"}
req = Request(scope)

async def main():
    o = await overview(req)
    print("== overview() ==")
    keys = ["stationCount", "activeStations", "meterCount", "cabinetCount", "brandCount", "entityCount", "landlordCount",
            "elecPay", "elecCollect", "elecProfit", "elecUnpaid", "elecUncollected",
            "rentIncomeTotal", "rentCostTotal", "rentTaxTotal", "rentProfitTotal", "netProfitTotal",
            "rentUncollected", "opExpenseTotal", "expiringContracts", "expiredContracts", "totalKwh"]
    for k in keys:
        print(f"  {k} = {o.get(k)}")
    print("  monthly:")
    for m in o.get("monthly", []):
        print(f"    {m['period']} kwh={m['kwh']} pay={m['elecPay']} collect={m['elecCollect']} profit={m['elecProfit']}")
    print("  bills.payable.elec =", o.get("bills", {}).get("payable", {}).get("elec"))
    print("  bills.receivable.elec =", o.get("bills", {}).get("receivable", {}).get("elec"))
    print("  bills.payable.site =", o.get("bills", {}).get("payable", {}).get("site"))
    print("  bills.receivable.site =", o.get("bills", {}).get("receivable", {}).get("site"))

    print("\n== monthly_detail(2026-08) ==")
    md = await monthly_detail(req, period="2026-08")
    print(f"  totalKwh = {md['totalKwh']}")
    print(f"  elec: income={md['elec']['income']} cost={md['elec']['cost']} profit={md['elec']['profit']} details={len(md['elec']['details'])}")
    for d in md["elec"]["details"]:
        print(f"    {d['meterNo']} {d['brandName']} kwh={d['kwh']} pay={d['payAmount']} collectNet={d['collectNet']}")
    print(f"  rent: income={md['rent']['income']} cost={md['rent']['cost']} profit={md['rent']['profit']}")
    print(f"    incomeDetails={md['rent']['incomeDetails']}")
    print(f"    costDetails={md['rent']['costDetails']}")
    print(f"  opExpense: total={md['opExpense']['total']}")
    print(f"  dividend: total={md['dividend']['total']} pending={md['dividend']['pending']}")

asyncio.run(main())
