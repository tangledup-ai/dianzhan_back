"""分红计算器（v3：场地(landlord)+品牌(brand) 直挂，无站点层）"""
from datetime import date
from ..repositories import (
    electricity_repo, rent_repo, dividend_repo, meter_repo
)
from ..infra.database import get_connection, get_dict_cursor


class DividendCalculator:
    """分红计算器 - 核心业务逻辑（v3：calculate(landlord_id, brand_id=None, period)）"""

    def calculate(self, landlord_id: int, brand_id, period: str) -> dict:
        """计算某场地（或场地×品牌）某月的分红（预览，不入库）。

        brand_id 传 None = 整场地分红；传品牌 id = 指定品牌分红（只算该品牌电表/合同）。
        """
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("SELECT id, name, company_share FROM landlords WHERE id = %s", (landlord_id,))
            landlord = cur.fetchone()
        finally:
            cur.close()
            conn.close()
        if not landlord:
            return None

        # 0. 取该场地（或该品牌）实表电表读数（v3：直挂 landlord，无站点）
        total_kwh, meter_details = self._get_meter_kwh(landlord_id, period, brand_id)

        # 整场地各品牌柜数（用于场地成本/运营费按品牌分摊）
        landlord_brand_cabs, landlord_total_cabs = self._get_landlord_cabinet_totals(landlord_id)
        # 本次计算涉及品牌的柜数（品牌柜数 ≤ 整场地柜数；品牌=该场地该品牌）
        meter_brand_cabs = {}
        for d in meter_details:
            bid = d.get("brand_id")
            if bid is not None:
                meter_brand_cabs[int(bid)] = meter_brand_cabs.get(int(bid), 0) + int(d.get("cabinet_count") or 1)

        # 1. 获取该场地的合同（计算电费单价和租金）
        contracts = self._get_contracts(landlord_id)
        elec_pay_price = 0    # 场地合同电费单价（成本）
        rent_cost = 0          # 场地合同月租金
        rent_income = 0        # 品牌方合同月租金
        rent_refund_total = 0  # 场地费退款总额
        brand_elec_map = {}    # brand_id -> {pre_tax, post_tax, tax_enabled}
        brand_rent_map = {}    # brand_id -> {pre_tax, post_tax, tax_enabled, brand_name}

        if "-" in period:
            period_year, period_month = map(int, period.split("-"))
        else:
            period_year, period_month = int(period[:4]), int(period[4:])

        for c in contracts:
            if c["contract_type"] == "场地合同":
                if c["monthly_rent"]:
                    rent_cost += float(c["monthly_rent"])
                if c["electricity_price"]:
                    elec_pay_price = float(c["electricity_price"])
            elif c["contract_type"] == "品牌方合同":
                c_brand = c.get("brand_id")
                if brand_id is not None and c_brand != brand_id:
                    continue  # 指定品牌时只算该品牌
                if c_brand:
                    brand_elec_map[c_brand] = {
                        "pre_tax": float(c["electricity_price"] or 0),
                        "post_tax": float(c.get("post_tax_electricity_price") or 0),
                        "tax_rate": float(c.get("tax_rate") or 0.01),
                        "tax_enabled": bool(c.get("tax_enabled") and c.get("post_tax_electricity_price")),
                    }
                    if c.get("rent_tax_enabled") and c.get("post_tax_rent_price"):
                        brand_rent_map[c_brand] = {
                            "pre_tax": float(c["monthly_rent"] or 0),
                            "post_tax": float(c["post_tax_rent_price"] or 0),
                            "tax_rate": float(c.get("rent_tax_rate") or 0.01),
                            "tax_enabled": True,
                            "brand_name": c.get("brand_name", ""),
                        }

                # 判断是否为合同首月（使用首月场地租金）
                start_date = c.get("start_date")
                is_first_month = False
                if start_date and c.get("first_month_rent"):
                    sy = start_date.year if hasattr(start_date, 'year') else int(str(start_date)[:4])
                    sm = start_date.month if hasattr(start_date, 'month') else int(str(start_date)[5:7])
                    is_first_month = (period_year == sy and period_month == sm)

                if is_first_month:
                    rent_income += float(c["first_month_rent"])
                elif c["monthly_rent"]:
                    rent_income += float(c["monthly_rent"])

                # 判断是否为合同提前结束月（场地费退款）
                early_end_date = c.get("early_end_date")
                end_date = early_end_date or c.get("end_date")
                if end_date and c.get("rent_refund"):
                    ey = end_date.year if hasattr(end_date, 'year') else int(str(end_date)[:4])
                    em = end_date.month if hasattr(end_date, 'month') else int(str(end_date)[5:7])
                    if period_year == ey and period_month == em:
                        rent_refund_total += float(c["rent_refund"])

        # 3. 计算电费收入（使用税前单价）和成本（v3：品牌各算各的，无站点）
        def _meter_income(d):
            bid = d.get("brand_id")
            brand_info = brand_elec_map.get(bid) if bid is not None else None
            unit = float(brand_info["pre_tax"]) if brand_info and brand_info.get("pre_tax") else 0
            return round(float(d.get("kwh") or 0) * unit, 2)

        elec_income = round(sum(_meter_income(d) for d in meter_details), 2)
        elec_cost = round(total_kwh * elec_pay_price, 2) if elec_pay_price else 0

        # 电费税费（税费 = 含税收入 × 税率；仅启用税率的品牌计税）
        from .electricity_pricing import split_tax
        elec_tax = 0
        tax_details = []
        for d in meter_details:
            bid = d.get("brand_id")
            kwh = float(d.get("kwh") or 0)
            brand_info = brand_elec_map.get(bid, {})
            if brand_info.get("tax_enabled") and kwh > 0:
                income = round(kwh * float(brand_info["pre_tax"]), 2)
                tax_amount, _ = split_tax(income, brand_info.get("tax_rate"))
                elec_tax += tax_amount
                tax_details.append({
                    "meterNo": d["meter_no"],
                    "brandName": d.get("brand_name", ""),
                    "kwh": kwh,
                    "preTaxPrice": brand_info["pre_tax"],
                    "postTaxPrice": brand_info["post_tax"],
                    "amount": tax_amount,
                })
        elec_tax = round(elec_tax, 2)

        # 场地税费（品牌方合同；税费 = 含税月租 × 税率）
        rent_tax = 0
        rent_tax_details = []
        for bid2, brand_info in brand_rent_map.items():
            if brand_info.get("tax_enabled"):
                tax_rate = brand_info.get("tax_rate", 0.01)
                tax_amount, _ = split_tax(brand_info["pre_tax"], tax_rate)
                rent_tax += tax_amount
                rent_tax_details.append({
                    "brandName": brand_info["brand_name"],
                    "preTaxPrice": brand_info["pre_tax"],
                    "postTaxPrice": brand_info["post_tax"],
                    "taxRate": tax_rate,
                    "amount": tax_amount,
                })
        rent_tax = round(rent_tax, 2)

        # 4. 运营费用（v3：按场地）
        expense = rent_repo.get_expense_by_landlord(landlord_id, period.replace("-", ""))
        op_expense = float(expense["amount"]) if expense else 0

        # 5. 组装收入数据（租金明细：品牌方合同，首月租逻辑）
        rent_income_details = []
        for c in contracts:
            if c["contract_type"] == "品牌方合同":
                c_brand = c.get("brand_id")
                if brand_id is not None and c_brand != brand_id:
                    continue
                start_date = c.get("start_date")
                is_first_month = False
                if start_date and c.get("first_month_rent"):
                    sy = start_date.year if hasattr(start_date, 'year') else int(str(start_date)[:4])
                    sm = start_date.month if hasattr(start_date, 'month') else int(str(start_date)[5:7])
                    is_first_month = (period_year == sy and period_month == sm)

                amount = round(float(c.get("first_month_rent") or 0) if is_first_month else float(c.get("monthly_rent") or 0), 2)
                rent_tax_info = brand_rent_map.get(c_brand, {})
                rent_income_details.append({
                    "brandId": c_brand,
                    "brandName": c.get("brand_name", ""),
                    "cabinets": float(c.get("cabinets_count") or 0),
                    "unitMonthlyRent": float(c.get("unit_monthly_rent") or 0),
                    "amount": amount,
                    "isFirstMonth": is_first_month,
                    "postTaxRent": rent_tax_info.get("post_tax") if rent_tax_info.get("tax_enabled") else None,
                })

        income = {
            "elecIncome": {
                "total": elec_income,
                "details": [{
                    "meterNo": d["meter_no"],
                    "brandName": d["brand_name"],
                    "kwh": float(d["kwh"] or 0),
                    "unitPrice": brand_elec_map.get(d.get("brand_id"), {}).get("pre_tax", 0),
                    "postTaxPrice": brand_elec_map.get(d.get("brand_id"), {}).get("post_tax") if brand_elec_map.get(d.get("brand_id"), {}).get("tax_enabled") else None,
                    "amount": round(float(d["kwh"] or 0) * brand_elec_map.get(d.get("brand_id"), {}).get("pre_tax", 0), 2),
                } for d in meter_details],
            },
            "rentIncome": {
                "total": round(rent_income, 2),
                "details": rent_income_details,
            },
            "totalIncome": round(elec_income + rent_income, 2),
        }

        # 6. 组装成本数据（v3：场地成本不分摊，直接整场地）
        cost = {
            "elecCost": elec_cost,
            "rentCost": round(rent_cost, 2),
            "opExpense": round(op_expense, 2),
            "elecTax": round(elec_tax, 2),
            "rentTax": round(rent_tax, 2),
            "rentRefund": round(rent_refund_total, 2),
            "bizDividendCost": 0,
            "totalCost": round(elec_cost + rent_cost + op_expense + elec_tax + rent_tax + rent_refund_total, 2),
            "details": {
                "electricity": [{
                    "meterNo": d["meter_no"],
                    "kwh": float(d["kwh"] or 0),
                    "unitPrice": elec_pay_price,
                    "amount": round(float(d["kwh"] or 0) * elec_pay_price, 2),
                } for d in meter_details],
                "rent": [{
                    "landlordName": c.get("landlord_name") or c.get("partner", ""),
                    "monthlyRent": float(c.get("monthly_rent") or 0),
                } for c in contracts if c["contract_type"] == "场地合同"],
                "operatingExpense": {
                    "amount": round(op_expense, 2),
                    "remark": expense.get("remark") if expense else None,
                },
                "elecTax": {
                    "amount": round(elec_tax, 2),
                    "details": tax_details,
                },
                "rentTax": {
                    "amount": round(rent_tax, 2),
                    "details": rent_tax_details,
                },
                "rentRefund": {
                    "amount": round(rent_refund_total, 2),
                    "remark": "场地费退款" if rent_refund_total > 0 else None,
                },
            },
        }

        # 6.5 按品牌 P&L（用于按品牌分红：股东/介绍人只参与某个品牌的分红）
        brand_map = {}
        brand_contracts = [c for c in contracts if c["contract_type"] == "品牌方合同" and c.get("brand_id")]
        if brand_id is not None:
            brand_contracts = [c for c in brand_contracts if c["brand_id"] == brand_id]

        # 按品牌汇总电表度数 和 电表柜数（每电表至少 1 柜）
        brand_kwh = {}
        brand_cabinets = {}
        for d in meter_details:
            bid = d.get("brand_id")
            if bid:
                brand_kwh[bid] = brand_kwh.get(bid, 0) + float(d.get("kwh") or 0)
                brand_cabinets[bid] = brand_cabinets.get(bid, 0) + int(d.get("cabinet_count") or 1)
        landlord_total_brand_cabs = sum(landlord_brand_cabs.values()) or 1  # 整场地品牌柜数（场地成本/运营费按此分摊）

        for c in brand_contracts:
            bid = c["brand_id"]
            cabs = brand_cabinets.get(bid, 0) or 1
            kwh = brand_kwh.get(bid, 0)
            unit_price = float(c.get("electricity_price") or 0)
            b_elec_income = round(kwh * unit_price, 2) if unit_price else 0

            start_date = c.get("start_date")
            b_is_first = False
            if start_date and c.get("first_month_rent"):
                sy = start_date.year if hasattr(start_date, 'year') else int(str(start_date)[:4])
                sm = start_date.month if hasattr(start_date, 'month') else int(str(start_date)[5:7])
                b_is_first = (period_year == sy and period_month == sm)
            b_rent_income = round(float(c.get("first_month_rent") or 0) if b_is_first else float(c.get("monthly_rent") or 0), 2)

            # 场地级成本按品牌柜数分摊（各品牌之和 = 整场地租金成本）
            b_venue_cost = round(rent_cost * cabs / landlord_total_brand_cabs, 2)
            b_elec_cost = round(kwh * elec_pay_price, 2) if elec_pay_price else 0
            b_op = round(op_expense * cabs / landlord_total_brand_cabs, 2)

            b_elec_tax = 0
            if brand_elec_map.get(bid, {}).get("tax_enabled") and kwh > 0:
                b_elec_tax, _ = split_tax(b_elec_income, brand_elec_map[bid].get("tax_rate"))
            b_rent_tax = 0
            if brand_rent_map.get(bid, {}).get("tax_enabled"):
                b_rent_tax, _ = split_tax(b_rent_income, brand_rent_map[bid].get("tax_rate"))

            b_income = round(b_elec_income + b_rent_income, 2)
            b_cost = round(b_venue_cost + b_elec_cost + b_op + b_elec_tax + b_rent_tax, 2)
            brand_map[bid] = {
                "brandId": bid,
                "brandName": c.get("brand_name", ""),
                "elecIncome": b_elec_income,
                "rentIncome": b_rent_income,
                "income": b_income,
                "venueCost": b_venue_cost,
                "elecCost": b_elec_cost,
                "elecTax": b_elec_tax,
                "rentTax": b_rent_tax,
                "opExpense": b_op,
                "cost": b_cost,
                "profit": round(b_income - b_cost, 2),
            }

        # 7. 计算商务分红
        biz_dividends = self._calc_business_dividends(landlord_id, income, cost, period, brand_map)

        # 8. 如果商务分红计入成本，更新总成本
        biz_cost = sum(d["amount"] for d in biz_dividends if d.get("countAsCost"))
        cost["bizDividendCost"] = round(biz_cost, 2)
        cost["totalCost"] = round(
            cost["elecCost"] + cost["rentCost"] + cost["opExpense"]
            + cost["elecTax"] + cost["rentTax"] + cost["rentRefund"] + biz_cost, 2
        )

        # 9. 计算净利润
        profit = round(income["totalIncome"] - cost["totalCost"], 2)

        # 10. 计算股东分红
        shareholder_dividends = self._calc_shareholder_dividends(landlord_id, income, profit, period, brand_map)

        # 11. 计算结算日期
        settlement_date = self._calc_settlement_date(period)

        return {
            "landlordId": landlord_id,
            "landlordName": landlord.get("name"),
            "period": period,
            "companyShare": float(landlord.get("company_share") or 0),
            "income": income,
            "cost": cost,
            "profit": profit,
            "brandBreakdown": list(brand_map.values()),
            "bizDividends": biz_dividends,
            "shareholderDividends": shareholder_dividends,
            "settlementDate": settlement_date,
            "summary": {
                "totalBusinessDividend": round(sum(d["amount"] for d in biz_dividends), 2),
                "totalShareholderDividend": round(sum(d["amount"] for d in shareholder_dividends), 2),
            },
        }

    def _get_contracts(self, landlord_id: int) -> list:
        """获取场地方的合同，统一按 landlord_id 匹配（合同挂场地方一级）"""
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            if not landlord_id:
                return []
            cur.execute("""
                SELECT c.*, b.name as brand_name, l.name as landlord_name
                FROM contracts c
                LEFT JOIN brands b ON c.brand_id = b.id
                LEFT JOIN landlords l ON c.landlord_id = l.id
                WHERE c.landlord_id = %s
            """, (landlord_id,))
            return cur.fetchall()
        finally:
            cur.close()
            conn.close()

    def _get_meter_kwh(self, landlord_id: int, period: str, brand_id=None) -> tuple:
        """v3：按场地（+可选品牌）取实表电表的月度用电量。

        空表规则：未关联 landlord+brand 的电表不参与任何计算。
        """
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            conditions = ["m.landlord_id = %s", "m.meter_no NOT LIKE 'TEST%%'", "m.brand_id IS NOT NULL"]
            values = [landlord_id]
            if brand_id is not None:
                conditions.append("m.brand_id = %s")
                values.append(brand_id)
            where = " AND ".join(conditions)
            cur.execute(f"""
                SELECT m.id, m.meter_no, m.meter_name, m.brand_id, b.name as brand_name, m.transformer_ratio
                FROM meters m
                LEFT JOIN brands b ON m.brand_id = b.id
                WHERE {where}
                ORDER BY m.id
            """, values)
            meters = cur.fetchall()

            meter_ids = [m["id"] for m in meters]
            meter_nos = [m["meter_no"] for m in meters if m.get("meter_no")]
            total_kwh = 0
            details = []

            # 每个电表的柜子数：max(1, 实际柜子数)
            cabinet_map = {}
            if meter_ids:
                placeholders = ",".join(["%s"] * len(meter_ids))
                cur.execute(f"""
                    SELECT meter_id, COUNT(*) as cnt
                    FROM cabinets
                    WHERE meter_id IN ({placeholders})
                    GROUP BY meter_id
                """, meter_ids)
                for r in cur.fetchall():
                    cabinet_map[r["meter_id"]] = max(1, int(r["cnt"] or 0))

            if meter_nos and period:
                month_period = period.replace("-", "")
                placeholders = ",".join(["%s"] * len(meter_nos))
                cur.execute(f"""
                    SELECT mm.address as meter_no, COALESCE(SUM(mm.kwh), 0) as kwh, MAX(mm.actual_kwh) as actual_kwh
                    FROM meter_monthly mm
                    WHERE mm.address IN ({placeholders}) AND mm.month_period = %s
                    GROUP BY mm.address
                """, (*meter_nos, month_period))
                rows = cur.fetchall()
                kwh_map = {r["meter_no"]: float(r["kwh"] or 0) for r in rows}
                actual_map = {r["meter_no"]: r["actual_kwh"] for r in rows if r.get("actual_kwh") is not None}

                for m in meters:
                    if m["meter_no"] in actual_map:
                        kwh = round(float(actual_map[m["meter_no"]]), 2)
                    else:
                        kwh = round(kwh_map.get(m["meter_no"], 0) * float(m.get("transformer_ratio") or 1), 2)
                    total_kwh += kwh
                    details.append({
                        "meter_id": m["id"],
                        "meter_no": m["meter_no"],
                        "meter_name": m.get("meter_name"),
                        "brand_id": m.get("brand_id"),
                        "brand_name": m.get("brand_name"),
                        "kwh": kwh,
                        "cabinet_count": cabinet_map.get(m["id"], 1),
                    })
            else:
                for m in meters:
                    details.append({
                        "meter_id": m["id"],
                        "meter_no": m["meter_no"],
                        "meter_name": m.get("meter_name"),
                        "brand_id": m.get("brand_id"),
                        "brand_name": m.get("brand_name"),
                        "kwh": 0,
                        "cabinet_count": cabinet_map.get(m["id"], 1),
                    })

            return round(total_kwh, 2), details
        finally:
            cur.close()
            conn.close()

    def _get_landlord_cabinet_totals(self, landlord_id: int) -> tuple:
        """整场地（landlord）各品牌柜数与总柜数（每电表至少 1 柜）。

        用于把场地级租金成本/运营费按品牌柜数分摊到品牌。
        Returns:
            (brand_cabs: {brand_id: 柜数}, total_cabs: int)
        """
        if not landlord_id:
            return {}, 0
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("""
                SELECT m.brand_id,
                       SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id))) AS cabs
                FROM meters m
                WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
                  AND m.brand_id IS NOT NULL
                GROUP BY m.brand_id
            """, (landlord_id,))
            brand_cabs = {}
            total = 0
            for r in cur.fetchall():
                n = int(r["cabs"] or 0)
                total += n
                bid = r.get("brand_id")
                if bid is not None:
                    brand_cabs[int(bid)] = brand_cabs.get(int(bid), 0) + n
            return brand_cabs, total
        finally:
            cur.close()
            conn.close()

    def _filter_configs_by_period(self, configs: list, period: str) -> list:
        """按期间过滤配置（只保留生效中的配置）"""
        if "-" in period:
            year, month = map(int, period.split("-"))
        else:
            year, month = int(period[:4]), int(period[4:])
        period_date = f"{year}-{month:02d}-01"

        result = []
        for cfg in configs:
            start = cfg.get("start_date")
            end = cfg.get("end_date")
            if start and str(start) > period_date:
                continue
            if end and str(end) < period_date:
                continue
            result.append(cfg)
        return result

    def _calc_business_dividends(self, landlord_id: int, income: dict, cost: dict, period: str = None, brand_map: dict = None) -> list:
        """计算商务分红（v3：配置挂场地；带 brand_id 时用该品牌的收入/利润作基数）"""
        configs = dividend_repo.list_introducer_configs(landlord_id=landlord_id)
        if period:
            configs = self._filter_configs_by_period(configs, period)
        total_income = income["totalIncome"]
        base_cost = (cost["elecCost"] + cost["rentCost"] + cost["opExpense"]
                     + cost["elecTax"] + cost["rentTax"] + cost["rentRefund"])
        base_profit = round(total_income - base_cost, 2)

        results = []
        for cfg in configs:
            brand_id = cfg.get("brand_id")
            brand = brand_map.get(brand_id) if brand_id and brand_map else None

            mode = cfg.get("mode")
            ratio = float(cfg.get("ratio") or 0)
            fixed_amount = float(cfg.get("fixed_amount") or 0)
            settlement_period = cfg.get("settlement_period", "月")

            if brand:
                base_income = brand["income"]
                base_profit_brand = brand["profit"]
            else:
                base_income = total_income
                base_profit_brand = base_profit

            period_multiplier = self._get_period_multiplier(settlement_period, period)

            if mode == "收入分红":
                amount = round(base_income * ratio * period_multiplier, 2)
                base_amount = base_income
            elif mode == "利润分红":
                amount = round(base_profit_brand * ratio * period_multiplier, 2)
                base_amount = base_profit_brand
            elif mode == "固定金额":
                amount = round(fixed_amount * period_multiplier, 2)
                base_amount = None
            else:
                amount = 0
                base_amount = None

            results.append({
                "introducerId": cfg.get("introducer_id"),
                "introducerName": cfg.get("introducer_name"),
                "brandId": brand_id,
                "brandName": brand["brandName"] if brand else None,
                "mode": mode,
                "ratio": ratio,
                "fixedAmount": fixed_amount if mode == "固定金额" else None,
                "countAsCost": cfg.get("count_as_cost", False),
                "baseAmount": base_amount,
                "amount": amount,
                "settlementPeriod": settlement_period,
            })

        return results

    def _calc_shareholder_dividends(self, landlord_id: int, income: dict, profit: float, period: str = None, brand_map: dict = None) -> list:
        """计算股东分红（v3：配置挂场地；各拿各的比例，互不影响）"""
        configs = dividend_repo.list_shareholder_configs(landlord_id=landlord_id)
        if period:
            configs = self._filter_configs_by_period(configs, period)

        total_income = income["totalIncome"]

        results = []
        for cfg in configs:
            brand_id = cfg.get("brand_id")
            brand = brand_map.get(brand_id) if brand_id and brand_map else None

            mode = cfg.get("mode")
            ratio = float(cfg.get("ratio") or 0)
            fixed_amount = float(cfg.get("fixed_amount") or 0)
            settlement_period = cfg.get("settlement_period", "月")
            period_multiplier = self._get_period_multiplier(settlement_period, period)

            if mode == "收入分红":
                amount = round(total_income * ratio * period_multiplier, 2)
                base_amount = total_income
            elif mode == "利润分红":
                amount = round(profit * ratio * period_multiplier, 2)
                base_amount = profit
            elif mode == "固定金额":
                amount = round(fixed_amount * period_multiplier, 2)
                base_amount = None
            else:
                amount = 0
                base_amount = None

            results.append({
                "shareholderId": cfg.get("shareholder_id"),
                "shareholderName": cfg.get("shareholder_name"),
                "brandId": brand_id,
                "brandName": brand["brandName"] if brand else None,
                "mode": mode,
                "ratio": ratio,
                "fixedAmount": fixed_amount if mode == "固定金额" else None,
                "baseAmount": base_amount,
                "amount": amount,
                "settlementPeriod": settlement_period,
            })

        return results

    def _get_period_multiplier(self, settlement_period: str, current_period: str) -> int:
        """根据分红周期计算倍数
        月分红：1；季度分红：3（季度末）；半年分红：6（6/12月）；年分红：12（12月）。
        """
        if settlement_period == "月":
            return 1
        elif settlement_period == "季度":
            if "-" in current_period:
                _, month = map(int, current_period.split("-"))
            else:
                month = int(current_period[4:])
            return 3 if month in [3, 6, 9, 12] else 0
        elif settlement_period == "半年":
            if "-" in current_period:
                _, month = map(int, current_period.split("-"))
            else:
                month = int(current_period[4:])
            return 6 if month in [6, 12] else 0
        elif settlement_period == "年":
            if "-" in current_period:
                _, month = map(int, current_period.split("-"))
            else:
                month = int(current_period[4:])
            return 12 if month == 12 else 0
        else:
            return 1

    def _calc_settlement_date(self, period: str) -> str:
        """计算结算日期（月末）"""
        if "-" in period:
            year, month = map(int, period.split("-"))
        else:
            year, month = int(period[:4]), int(period[4:])
        if month == 12:
            return f"{year + 1}-01-01"
        else:
            return f"{year}-{month + 1:02d}-01"


# 全局实例
dividend_calculator = DividendCalculator()
