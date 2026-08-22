# -*- coding: utf-8 -*-
"""直接调用 save_shareholder_config 复现报错"""
import sys, os, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.repositories.dividend_repo import save_shareholder_config, list_shareholder_configs

try:
    r = save_shareholder_config({
        "landlordId": 5,
        "shareholderId": 3,
        "brandId": None,
        "mode": "利润分红",
        "ratio": 0.1,
        "fixedAmount": None,
        "settlementPeriod": "月",
        "startDate": None,
        "endDate": None,
        "remark": None,
    })
    print("保存成功:", r)
except Exception:
    traceback.print_exc()

print("\n== 当前配置 ==")
try:
    for c in list_shareholder_configs(landlord_id=5):
        print(" ", c)
except Exception:
    traceback.print_exc()
