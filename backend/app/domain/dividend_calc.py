"""分红计算器（v3：场地(landlord)+品牌(brand) 直挂，无站点层）"""
from datetime import date, timedelta
from ..repositories import (
    electricity_repo, rent_repo, dividend_repo, meter_repo
)
from ..infra.database import get_connection, get_dict_cursor


def _covers_month(period_year: int, period_month: int, c: dict) -> bool:
    """合同是否覆盖该计算月：start <= 月末 且 (early_end 或 end) >= 月初。

    无任何起止日期视为长期有效；提前结束（early_end_date）后的月份不参与计算。
    提前结束当月仍算覆盖（退款计入该月）。
    """
    def _compact(v) -> str:
        return str(v)[:10].replace("-", "") if v else ""

    start = _compact(c.get("start_date"))
    end = _compact(c.get("early_end_date") or c.get("end_date"))
    if not start and not end:
        return True
    nm_y, nm_m = (period_year + 1, 1) if period_month == 12 else (period_year, period_month + 1)
    month_end = (date(nm_y, nm_m, 1) - timedelta(days=1)).strftime("%Y%m%d")
    month_start = f"{period_year:04d}{period_month:02d}01"
    if start and start > month_end:
        return False
    if end and end < month_start:
        return False
    return True


class DividendCalculator:
    """分红计算器 - 核心业务逻辑（v3：calculate(landlord_id, brand_id=None, period)）"""

    def calculate(self, landlord_id: int, brand_id, period: str, estimate: bool = False) -> dict:
        """计算某场地（或场地×品牌）某月的分红（预览，不入库）。

        brand_id 传 None = 整场地分红；传品牌 id = 指定品牌分红（只算该品牌电表/合同）。
        estimate=True = 预估模式：本月预估分红（multiplier 恒为 1，不管周期），
                       并返回 settlementMonth（本月是否结算月）与 periodStartMonth（当前周期起点月），
                       供前端累加「周期内待结算金额」。
        estimate 通过参数逐层传递（不挂实例状态，避免全局单例并发互相污染）。
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

        # 1. 获取该场地的合同（计算电费单价和租金）
        contracts = self._get_contracts(landlord_id)

        # 整场地各品牌柜数（用于场地成本/运营费按品牌分摊；每电表至少 1 柜）。
        # 场地内存在「全品牌合同」（品牌方合同 brand_id 为空）时，共享电表（brand_id 为空且
        # 标签=共享电表）也计入柜数，作为 brand_id=None 的虚拟品牌参与分摊
        has_shared_contract = any(
            c.get("contract_type") == "品牌方合同" and c.get("brand_id") is None
            for c in contracts
        )
        landlord_brand_cabs, landlord_total_cabs = self._get_landlord_cabinet_totals(
            landlord_id, include_shared=has_shared_contract
        )

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
            if not _covers_month(period_year, period_month, c):
                continue  # 未开始 / 已提前结束的合同不参与该月计算
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
                    brand_elec_map[(c_brand, c.get("entity_id"))] = {
                        "pre_tax": float(c["electricity_price"] or 0),
                        "post_tax": float(c.get("post_tax_electricity_price") or 0),
                        "tax_rate": float(c.get("tax_rate") or 0.01),
                        "tax_enabled": bool(c.get("tax_enabled") and c.get("post_tax_electricity_price")),
                    }
                    if c.get("rent_tax_enabled") and c.get("post_tax_rent_price"):
                        brand_rent_map[(c_brand, c.get("entity_id"))] = {
                            "pre_tax": float(c["monthly_rent"] or 0),
                            "post_tax": float(c["post_tax_rent_price"] or 0),
                            "tax_rate": float(c.get("rent_tax_rate") or 0.01),
                            "tax_enabled": True,
                            "brand_name": c.get("brand_name", ""),
                        }
                else:
                    # 全品牌合同（brand_id 为空）：为场地内共享电表定价/计税
                    brand_elec_map[(None, None)] = {
                        "pre_tax": float(c["electricity_price"] or 0),
                        "post_tax": float(c.get("post_tax_electricity_price") or 0),
                        "tax_rate": float(c.get("tax_rate") or 0.01),
                        "tax_enabled": bool(c.get("tax_enabled") and c.get("post_tax_electricity_price")),
                    }
                    if c.get("rent_tax_enabled") and c.get("post_tax_rent_price"):
                        brand_rent_map[(None, None)] = {
                            "pre_tax": float(c["monthly_rent"] or 0),
                            "post_tax": float(c["post_tax_rent_price"] or 0),
                            "tax_rate": float(c.get("rent_tax_rate") or 0.01),
                            "tax_enabled": True,
                            "brand_name": "全品牌共享",
                        }

                # 判断是否为合同首月（使用首月场地租金）
                start_date = c.get("start_date")
                is_first_month = False
                if start_date and c.get("first_month_rent"):
                    sy = start_date.year if hasattr(start_date, 'year') else int(str(start_date)[:4])
                    sm = start_date.month if hasattr(start_date, 'month') else int(str(start_date)[5:7])
                    is_first_month = (period_year == sy and period_month == sm)

                # 租金收入（不含税口径：启用租金税率的品牌用税后月租，与 Rent 页一致；首月用 first_month_rent）
                raw = float(c.get("first_month_rent") or 0) if is_first_month else float(c.get("monthly_rent") or 0)
                ri = brand_rent_map.get((c_brand, c.get("entity_id")))
                if ri and ri.get("tax_enabled") and ri.get("post_tax"):
                    raw = float(ri["post_tax"])
                rent_income += raw

                # 判断是否为合同提前结束月（场地费退款）
                early_end_date = c.get("early_end_date")
                end_date = early_end_date or c.get("end_date")
                if end_date and c.get("rent_refund"):
                    ey = end_date.year if hasattr(end_date, 'year') else int(str(end_date)[:4])
                    em = end_date.month if hasattr(end_date, 'month') else int(str(end_date)[5:7])
                    if period_year == ey and period_month == em:
                        rent_refund_total += float(c["rent_refund"])

        # 3. 计算电费收入（不含税：价内税口径与台账一致——税 = 含税收入 × 税率，不含税 = 含税 − 税）
        # 启用税率的品牌用 split_tax 拆分；未启用用税前单价（用户确认 2026-08）
        from .electricity_pricing import split_tax, rent_income_for_period, rent_refund_for_period

        def _elec_info(d):
            """v3.2 主体感知：按 (品牌, 电表主体) 精确取拆签合同单价，逐级回退到未指定主体合同/全品牌合同"""
            bid = d.get("brand_id")
            eid = d.get("entity_id")
            return (brand_elec_map.get((bid, eid))
                    or brand_elec_map.get((bid, None))
                    or brand_elec_map.get((None, None)))

        def _meter_income(d):
            brand_info = _elec_info(d)
            gross = round(float(d.get("kwh") or 0) * (float(brand_info["pre_tax"]) if brand_info and brand_info.get("pre_tax") else 0), 2)
            if brand_info and brand_info.get("tax_enabled") and brand_info.get("post_tax"):
                _, net = split_tax(gross, brand_info.get("tax_rate"))
                return round(net, 2)
            return gross

        elec_income = round(sum(_meter_income(d) for d in meter_details), 2)
        elec_cost = round(total_kwh * elec_pay_price, 2) if elec_pay_price else 0

        # 电费税费（税费 = 含税收入 × 税率；仅启用税率的品牌计税）
        elec_tax = 0
        tax_details = []
        for d in meter_details:
            kwh = float(d.get("kwh") or 0)
            brand_info = _elec_info(d) or {}
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
        for _key, brand_info in brand_rent_map.items():
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
                rent_tax_info = brand_rent_map.get((c_brand, c.get("entity_id")), {})
                # 不含税口径：启用税率的品牌用税后月租
                if rent_tax_info.get("tax_enabled") and rent_tax_info.get("post_tax"):
                    amount = round(float(rent_tax_info["post_tax"]), 2)
                rent_income_details.append({
                    "brandId": c_brand,
                    "brandName": c.get("brand_name", ""),
                    "cabinets": float(c.get("cabinets_count") or 0),
                    "unitMonthlyRent": float(c.get("unit_monthly_rent") or 0),
                    "amount": amount,
                    "isFirstMonth": is_first_month,
                    "preTaxRent": float(c.get("first_month_rent") or 0) if is_first_month else float(c.get("monthly_rent") or 0),
                    "postTaxRent": rent_tax_info.get("post_tax") if rent_tax_info.get("tax_enabled") else None,
                })

        income = {
            "elecIncome": {
                "total": elec_income,
                "details": [{
                    "meterNo": d["meter_no"],
                    "brandName": d["brand_name"],
                    "kwh": float(d["kwh"] or 0),
                    "unitPrice": (_elec_info(d) or {}).get("pre_tax", 0),
                    "postTaxPrice": (_elec_info(d) or {}).get("post_tax") if (_elec_info(d) or {}).get("tax_enabled") else None,
                    "amount": round(float(d["kwh"] or 0) * (_elec_info(d) or {}).get("pre_tax", 0), 2),
                } for d in meter_details],
            },
            "rentIncome": {
                "total": round(rent_income, 2),
                "details": rent_income_details,
            },
            "totalIncome": round(elec_income + rent_income, 2),
        }

        # 6. 组装成本数据（v3：场地成本不分摊，直接整场地）
        # 口径：收入已为不含税，税费单独展示（elecTax/rentTax 字段保留，不参与 totalCost/profit，避免双扣）
        cost = {
            "elecCost": elec_cost,
            "rentCost": round(rent_cost, 2),
            "opExpense": round(op_expense, 2),
            "elecTax": round(elec_tax, 2),
            "rentTax": round(rent_tax, 2),
            "rentRefund": round(rent_refund_total, 2),
            "bizDividendCost": 0,
            "totalCost": round(elec_cost + rent_cost + op_expense + rent_refund_total, 2),
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
        # 全品牌合同（brand_id 为空）也纳入逐品牌 P&L：其柜数=场地内共享电表，参与场地成本分摊
        brand_contracts = [c for c in contracts if c["contract_type"] == "品牌方合同"]
        if brand_id is not None:
            brand_contracts = [c for c in brand_contracts if c["brand_id"] == brand_id]

        weights_brand_entity = self._get_brand_entity_weights(landlord_id, include_shared=has_shared_contract)
        # 按品牌汇总电表度数（柜数统一用 landlord_brand_cabs：每电表 GREATEST(1,柜数)，与合同列表/场租页同口径）
        brand_kwh = {}
        brand_kwh_entity = {}
        for d in meter_details:
            bid = d.get("brand_id")
            # bid=None 的共享电表组也聚合（键 None，供全品牌合同定价/计收入）
            brand_kwh[bid] = brand_kwh.get(bid, 0) + float(d.get("kwh") or 0)
            _bkey = (bid, d.get("entity_id"))
            brand_kwh_entity[_bkey] = brand_kwh_entity.get(_bkey, 0) + float(d.get("kwh") or 0)
        landlord_total_brand_cabs = sum(landlord_brand_cabs.values()) or 1  # 整场地品牌柜数（场地成本/运营费按此分摊）

        # v3.2：同品牌拆签多主体合同时逐合同累加；每份合同只算其主体对应电表的电量
        # （电表 → 合同匹配：主体精确匹配优先，落到未指定主体的合同；全品牌合同承接全部共享电表）
        meter_contract_kwh = {}
        for d in meter_details:
            bid_d, eid_d = d.get("brand_id"), d.get("entity_id")
            kwh_d = float(d.get("kwh") or 0)
            if bid_d is None:
                key = (None, None)
            elif (bid_d, eid_d) in brand_elec_map:
                key = (bid_d, eid_d)
            elif (bid_d, None) in brand_elec_map:
                key = (bid_d, None)
            else:
                key = None  # 无合同的电表：收入 0
            if key is not None:
                meter_contract_kwh[key] = meter_contract_kwh.get(key, 0) + kwh_d

        contracts_by_brand = {}
        for c in brand_contracts:
            if not _covers_month(period_year, period_month, c):
                continue  # 未开始 / 已提前结束的品牌合同不参与该月 P&L
            contracts_by_brand.setdefault(c.get("brand_id"), []).append(c)

        for bid, cs in contracts_by_brand.items():
            cabs = int(landlord_brand_cabs.get(bid, 0))  # 签了合同但无电表的品牌 = 0 柜，不参与分摊（保证各品牌分摊之和=场地成本）
            kwh = brand_kwh.get(bid, 0)
            b_elec_gross = 0.0
            b_elec_income = 0.0
            b_elec_tax = 0.0
            b_rent_income = 0.0
            b_rent_tax = 0.0
            brand_name = None
            for c in cs:
                c_entity = c.get("entity_id")
                brand_name = brand_name or c.get("brand_name") or ("全品牌共享" if bid is None else "")
                kwh_c = meter_contract_kwh.get((bid, c_entity), 0.0)
                b_info = brand_elec_map.get((bid, c_entity)) or {}
                gross = round(kwh_c * float(c.get("electricity_price") or 0), 2)
                if b_info.get("tax_enabled") and b_info.get("post_tax"):
                    _, net = split_tax(gross, b_info.get("tax_rate"))
                else:
                    net = gross
                b_elec_gross += gross
                b_elec_income += net
                if b_info.get("tax_enabled") and kwh_c > 0:
                    t, _ = split_tax(gross, b_info.get("tax_rate"))
                    b_elec_tax += t

                start_date = c.get("start_date")
                b_is_first = False
                if start_date and c.get("first_month_rent"):
                    sy = start_date.year if hasattr(start_date, 'year') else int(str(start_date)[:4])
                    sm = start_date.month if hasattr(start_date, 'month') else int(str(start_date)[5:7])
                    b_is_first = (period_year == sy and period_month == sm)
                ri = round(float(c.get("first_month_rent") or 0) if b_is_first else float(c.get("monthly_rent") or 0), 2)
                r_info = brand_rent_map.get((bid, c_entity)) or {}
                if r_info.get("tax_enabled") and r_info.get("post_tax"):
                    ri = round(float(r_info["post_tax"]), 2)
                b_rent_income += ri
                if r_info.get("tax_enabled"):
                    t2, _ = split_tax(ri, r_info.get("tax_rate"))
                    b_rent_tax += t2

            # 场地级成本按品牌柜数分摊（各品牌之和 = 整场地租金成本）
            b_venue_cost = round(rent_cost * cabs / landlord_total_brand_cabs, 2)
            b_elec_cost = round(kwh * elec_pay_price, 2) if elec_pay_price else 0
            b_op = round(op_expense * cabs / landlord_total_brand_cabs, 2)

            b_income = round(b_elec_income + b_rent_income, 2)
            b_cost = round(b_venue_cost + b_elec_cost + b_op, 2)
            brand_map[bid] = {
                "brandId": bid,
                "brandName": brand_name or ("全品牌共享" if bid is None else ""),
                "elecIncome": round(b_elec_income, 2),
                "rentIncome": round(b_rent_income, 2),
                "income": b_income,
                "venueCost": b_venue_cost,
                "elecCost": b_elec_cost,
                "elecTax": round(b_elec_tax, 2),
                "rentTax": round(b_rent_tax, 2),
                "opExpense": b_op,
                "cost": b_cost,
                "profit": round(b_income - b_cost, 2),
            }

        # ── 6.6 按主体 P&L（v3.2：主体分红基数；口径与 entity-monthly 一致，场地范围内）──
        entity_cabs_map = self._get_entity_weights(landlord_id, include_shared=has_shared_contract)
        entity_total = sum(entity_cabs_map.values()) or 1
        entity_kwh_map = {}
        entity_elec_income = {}
        entity_elec_tax_map = {}
        for d in meter_details:
            eid = d.get("entity_id")
            kwh_d = float(d.get("kwh") or 0)
            entity_kwh_map[eid] = entity_kwh_map.get(eid, 0) + kwh_d
            _info = _elec_info(d) or {}
            _gross = round(kwh_d * (_info.get("pre_tax") or 0), 2)
            if _info.get("tax_enabled") and _info.get("post_tax"):
                _t, _net = split_tax(_gross, _info.get("tax_rate"))
                entity_elec_income[eid] = entity_elec_income.get(eid, 0) + _net
                entity_elec_tax_map[eid] = entity_elec_tax_map.get(eid, 0) + _t
            else:
                entity_elec_income[eid] = entity_elec_income.get(eid, 0) + _gross
        entity_rent = {}
        entity_rent_tax = {}
        for c in brand_contracts:
            if not _covers_month(period_year, period_month, c):
                continue
            inc_c = round(rent_income_for_period(c, period) - rent_refund_for_period(c, period), 2)
            rtax_c = 0.0
            if c.get("rent_tax_enabled") and c.get("post_tax_rent_price") is not None:
                rtax_c = round(float(c.get("monthly_rent") or 0) - float(c["post_tax_rent_price"]), 2)
            if c.get("entity_id") is not None:
                allocs = [(c["entity_id"], inc_c, rtax_c)]
            else:
                wmap = weights_brand_entity.get(c.get("brand_id"), {})
                total_w = sum(w for w in wmap.values() if w > 0)
                if total_w > 0 and inc_c:
                    eids_w = sorted([e for e in wmap if wmap[e] > 0], key=lambda x: (x is None, x))
                    _rest = inc_c
                    allocs = []
                    for _i, _e in enumerate(eids_w):
                        _share = inc_c * wmap[_e] / total_w
                        if _i == len(eids_w) - 1:
                            _share = _rest
                        _rest = round(_rest - _share, 2)
                        allocs.append((_e, round(_share, 2), 0.0))
                else:
                    allocs = [(None, inc_c, rtax_c)]
            for _e, _inc, _tax in allocs:
                entity_rent[_e] = entity_rent.get(_e, 0) + _inc
                entity_rent_tax[_e] = entity_rent_tax.get(_e, 0) + _tax
        entity_map = {}
        for eid in set(entity_cabs_map) | set(entity_kwh_map) | set(entity_elec_income) | set(entity_rent):
            cabs_e = entity_cabs_map.get(eid, 0)
            venue_e = round(rent_cost * cabs_e / entity_total, 2)
            elec_cost_e = round(entity_kwh_map.get(eid, 0) * elec_pay_price, 2) if elec_pay_price else 0
            op_e = round(op_expense * cabs_e / entity_total, 2)
            e_income = round(entity_elec_income.get(eid, 0) + entity_rent.get(eid, 0), 2)
            e_cost = round(venue_e + elec_cost_e + op_e, 2)
            entity_map[eid] = {
                "entityId": eid,
                "elecIncome": round(entity_elec_income.get(eid, 0), 2),
                "elecCost": elec_cost_e,
                "rentIncome": round(entity_rent.get(eid, 0), 2),
                "venueCost": venue_e,
                "opExpense": op_e,
                "income": e_income,
                "cost": e_cost,
                "profit": round(e_income - e_cost, 2),
            }

        # 7. 计算商务分红
        biz_dividends = self._calc_business_dividends(landlord_id, income, cost, period, brand_map, entity_map, estimate)

        # 8. 如果商务分红计入成本，更新总成本（税费已独立展示，不参与 totalCost/profit）
        biz_cost = sum(d["amount"] for d in biz_dividends if d.get("countAsCost"))
        cost["bizDividendCost"] = round(biz_cost, 2)
        cost["totalCost"] = round(
            cost["elecCost"] + cost["rentCost"] + cost["opExpense"]
            + cost["rentRefund"] + biz_cost, 2
        )

        # 9. 计算净利润
        profit = round(income["totalIncome"] - cost["totalCost"], 2)

        # 10. 计算股东分红
        shareholder_dividends = self._calc_shareholder_dividends(landlord_id, income, profit, period, brand_map, entity_map, estimate)

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
            "entityMap": entity_map,
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

        空表规则：未关联 landlord 的电表不参与计算。
        共享电表（brand_id 为空且标签=共享电表）在整场地计算（brand_id 参数为空）时纳入：
        其电量计入场地电费成本，收入按「全品牌合同」单价计算（见 brand_elec_map[None]）。
        """
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            if brand_id is not None:
                conditions = ["m.landlord_id = %s", "m.meter_no NOT LIKE 'TEST%%'", "m.brand_id = %s"]
                values = [landlord_id, brand_id]
            else:
                conditions = [
                    "m.landlord_id = %s", "m.meter_no NOT LIKE 'TEST%%'",
                    "(m.brand_id IS NOT NULL OR m.tag = '共享电表')",
                ]
                values = [landlord_id]
            where = " AND ".join(conditions)
            cur.execute(f"""
                SELECT m.id, m.meter_no, m.meter_name, m.brand_id, m.entity_id, b.name as brand_name, m.transformer_ratio
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
                        "entity_id": m.get("entity_id"),
                        "brand_name": m.get("brand_name") or ("全品牌共享" if m.get("brand_id") is None else None),
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
                        "entity_id": m.get("entity_id"),
                        "brand_name": m.get("brand_name") or ("全品牌共享" if m.get("brand_id") is None else None),
                        "kwh": 0,
                        "cabinet_count": cabinet_map.get(m["id"], 1),
                    })

            return round(total_kwh, 2), details
        finally:
            cur.close()
            conn.close()

    def _get_landlord_cabinet_totals(self, landlord_id: int, include_shared: bool = False) -> tuple:
        """整场地（landlord）各品牌柜数与总柜数（每电表至少 1 柜）。

        用于把场地级租金成本/运营费按品牌柜数分摊到品牌。
        include_shared=True 时，共享电表（brand_id 为空且标签=共享电表）计入 brand_id=None 组，
        供「全品牌合同」参与分摊。
        Returns:
            (brand_cabs: {brand_id: 柜数，None=共享组}, total_cabs: int)
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
                  AND (m.brand_id IS NOT NULL OR (%s AND m.tag = '共享电表'))
                GROUP BY m.brand_id
            """, (landlord_id, include_shared))
            brand_cabs = {}
            total = 0
            for r in cur.fetchall():
                n = int(r["cabs"] or 0)
                total += n
                bid = r.get("brand_id")
                brand_cabs[bid] = brand_cabs.get(bid, 0) + n
            return brand_cabs, total
        finally:
            cur.close()
            conn.close()

    def _get_entity_weights(self, landlord_id: int, include_shared: bool = False) -> dict:
        """场地内各主体的计费柜数（每电表至少 1 柜）——主体损益/主体分红分摊用"""
        if not landlord_id:
            return {}
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("""
                SELECT m.entity_id,
                       COALESCE(SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id))), 0) AS cabs
                FROM meters m
                WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
                  AND (m.brand_id IS NOT NULL OR (%s AND m.tag = '共享电表'))
                GROUP BY m.entity_id
            """, (landlord_id, include_shared))
            out = {}
            for r in cur.fetchall():
                out[r.get("entity_id")] = out.get(r.get("entity_id"), 0) + int(r["cabs"] or 0)
            return out
        finally:
            cur.close()
            conn.close()

    def _get_brand_entity_weights(self, landlord_id: int, include_shared: bool = False) -> dict:
        """场地内 品牌→主体 计费柜数：{brand_id: {entity_id: cabs}} —— 品牌租金跨主体拆分用"""
        if not landlord_id:
            return {}
        conn = get_connection()
        cur = get_dict_cursor(conn)
        try:
            cur.execute("""
                SELECT m.brand_id, m.entity_id,
                       COALESCE(SUM(GREATEST(1, (SELECT COUNT(*) FROM cabinets cab WHERE cab.meter_id = m.id))), 0) AS cabs
                FROM meters m
                WHERE m.landlord_id = %s AND m.meter_no NOT LIKE 'TEST%%'
                  AND (m.brand_id IS NOT NULL OR (%s AND m.tag = '共享电表'))
                GROUP BY m.brand_id, m.entity_id
            """, (landlord_id, include_shared))
            out = {}
            for r in cur.fetchall():
                bid = r.get("brand_id")
                out.setdefault(bid, {})
                out[bid][r.get("entity_id")] = out[bid].get(r.get("entity_id"), 0) + int(r["cabs"] or 0)
            return out
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

    def _calc_business_dividends(self, landlord_id: int, income: dict, cost: dict, period: str = None, brand_map: dict = None, entity_map: dict = None, estimate: bool = False) -> list:
        """计算商务分红（v3.2：配置挂场地；brand_id → 品牌基数，entity_id → 主体基数，均空 → 整场地）"""
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
            entity_id = cfg.get("entity_id")
            brand = brand_map.get(brand_id) if brand_id and brand_map else None
            entity = entity_map.get(entity_id) if entity_id and entity_map and not brand_id else None

            mode = cfg.get("mode")
            ratio = float(cfg.get("ratio") or 0)
            fixed_amount = float(cfg.get("fixed_amount") or 0)
            settlement_period = cfg.get("settlement_period", "月")

            if brand:
                base_income = brand["income"]
                base_profit_brand = brand["profit"]
            elif entity:
                # v3.2 主体基数：该主体在该场地的收入/利润（跨品牌归集场景）
                base_income = entity["income"]
                base_profit_brand = entity["profit"]
            else:
                base_income = total_income
                base_profit_brand = base_profit

            period_multiplier = self._get_period_multiplier(settlement_period, period, estimate)

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
                "entityId": entity_id,
                "entityName": cfg.get("entity_name"),
                "mode": mode,
                "ratio": ratio,
                "fixedAmount": fixed_amount if mode == "固定金额" else None,
                "countAsCost": cfg.get("count_as_cost", False),
                "baseAmount": base_amount,
                "amount": amount,
                "settlementPeriod": settlement_period,
                "isSettlementMonth": self.is_settlement_month(settlement_period, period),
                "periodStartMonth": self.period_start_month(settlement_period, period),
            })

        return results

    def _calc_shareholder_dividends(self, landlord_id: int, income: dict, profit: float, period: str = None, brand_map: dict = None, entity_map: dict = None, estimate: bool = False) -> list:
        """计算股东分红（v3.2：配置挂场地；entity_id → 主体基数；各拿各的比例，互不影响）"""
        configs = dividend_repo.list_shareholder_configs(landlord_id=landlord_id)
        if period:
            configs = self._filter_configs_by_period(configs, period)

        total_income = income["totalIncome"]

        results = []
        for cfg in configs:
            brand_id = cfg.get("brand_id")
            entity_id = cfg.get("entity_id")
            brand = brand_map.get(brand_id) if brand_id and brand_map else None
            entity = entity_map.get(entity_id) if entity_id and entity_map and not brand_id else None
            # v3.2：配置了主体的股东用该主体的收入/利润作基数；未配置保持整场地口径
            if entity:
                base_income_total = entity["income"]
                base_profit_total = entity["profit"]
            else:
                base_income_total = total_income
                base_profit_total = profit

            mode = cfg.get("mode")
            ratio = float(cfg.get("ratio") or 0)
            fixed_amount = float(cfg.get("fixed_amount") or 0)
            settlement_period = cfg.get("settlement_period", "月")
            period_multiplier = self._get_period_multiplier(settlement_period, period, estimate)

            if mode == "收入分红":
                amount = round(base_income_total * ratio * period_multiplier, 2)
                base_amount = base_income_total
            elif mode == "利润分红":
                amount = round(base_profit_total * ratio * period_multiplier, 2)
                base_amount = base_profit_total
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
                "entityId": entity_id,
                "entityName": cfg.get("entity_name"),
                "mode": mode,
                "ratio": ratio,
                "fixedAmount": fixed_amount if mode == "固定金额" else None,
                "baseAmount": base_amount,
                "amount": amount,
                "settlementPeriod": settlement_period,
                "isSettlementMonth": self.is_settlement_month(settlement_period, period),
                "periodStartMonth": self.period_start_month(settlement_period, period),
            })

        return results

    def _get_period_multiplier(self, settlement_period: str, current_period: str, estimate: bool = False) -> int:
        """根据分红周期计算倍数
        月分红：1；季度分红：3（季度末）；半年分红：6（6/12月）；年分红：12（12月）。
        预估模式（estimate=True）：恒返回 1（本月预估，不乘周期倍数）。
        """
        if estimate:
            return 1
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

    @staticmethod
    def period_start_month(settlement_period: str, current_period: str) -> str:
        """当前分红周期起点月（YYYYMM）：季度→季首月，半年→1/7月，年→1月，月→当月"""
        if "-" in current_period:
            year, month = map(int, current_period.split("-"))
        else:
            year, month = int(current_period[:4]), int(current_period[4:])
        if settlement_period == "季度":
            qs = ((month - 1) // 3) * 3 + 1
            return f"{year}{qs:02d}"
        elif settlement_period == "半年":
            hs = 1 if month <= 6 else 7
            return f"{year}{hs:02d}"
        elif settlement_period == "年":
            return f"{year}01"
        else:
            return f"{year}{month:02d}"

    @staticmethod
    def is_settlement_month(settlement_period: str, current_period: str) -> bool:
        """当前月是否该周期的结算月：月→每月；季度→3/6/9/12；半年→6/12；年→12"""
        if "-" in current_period:
            _, month = map(int, current_period.split("-"))
        else:
            month = int(current_period[4:])
        if settlement_period == "月":
            return True
        if settlement_period == "季度":
            return month in [3, 6, 9, 12]
        if settlement_period == "半年":
            return month in [6, 12]
        if settlement_period == "年":
            return month == 12
        return True

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
