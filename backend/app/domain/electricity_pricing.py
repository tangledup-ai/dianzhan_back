"""电费单价解析统一模块（修复 #2：台账 / 分红预览 / 站点详情 / 看板 共用同一套规则）

业务规则（用户确认 2026-08）：
- 场地（landlord）是聚合根，下面可能挂多份「场地合同」（多个业主）和多份「品牌方合同」。
- 付款（成本）单价：
  - 场地合同提供 electricity_price（付给业主的元/度）。
  - 同一场地若有多个业主、多份场地合同且单价不同，目前数据模型无法把度数按业主拆分
    （meters 只有 landlord_id，没有「所属业主合同」归属）。
    → 本期规则：取该场地**唯一的场地合同单价**；若存在多份且单价不同，取 id 最小的那份，
      并置 pay_price_conflict=True 供上层告警（后续引入 meters.contract_id 归属后再按业主分摊）。
- 收款（收入）单价：按品牌各算各的。
  - meters.brand_id → 「品牌方合同」brand_id 的 electricity_price。
  - 电费收入 = Σ (品牌度数 × 该品牌合同单价)；**无对应品牌方合同的电表收入为 0**
    （收入只能来自已签合同；数据上出现"有电表无品牌合同"时应补合同，而不是套用别的品牌单价）。
- 本模块只负责"单价解析"，不负责度数计算。
"""


def resolve_prices(contracts: list) -> dict:
    """从合同列表解析付款/收款单价。

    Args:
        contracts: 该场地下所有合同行（dict，需含 contract_type / brand_id /
                   electricity_price / tax_rate / tax_enabled / post_tax_electricity_price；
                   缺字段视为 0/False/None）。

    Returns:
        {
            "pay_price": float | None,        # 场地合同唯一付款单价
            "pay_price_conflict": bool,       # 多份场地合同且单价不同
            "brand_prices": {                 # brand_id -> 该品牌收款信息
                <brand_id>: {
                    "price": float | None,    # 税前单价（元/度）
                    "tax_rate": float,        # 税率（默认 0.01）
                    "tax_enabled": bool,
                    "post_tax": float | None, # 税后单价
                },
            },
        }
    """
    site_contracts = [c for c in contracts if (c.get("contract_type") or "") == "场地合同"]
    brand_contracts = [c for c in contracts if (c.get("contract_type") or "") == "品牌方合同"]

    # ── 付款单价：唯一单价；多份不同 → 取 id 最小并标记冲突 ──
    site_prices = []
    for c in sorted(site_contracts, key=lambda x: x.get("id") or 0):
        p = c.get("electricity_price")
        if p is not None:
            site_prices.append(float(p))
    pay_price = site_prices[0] if site_prices else None
    pay_price_conflict = len(set(site_prices)) > 1

    # ── 收款单价：按品牌匹配 ──
    # brand_id 为空的品牌方合同 = 「全品牌合同」，其单价仅对共享电表（无品牌）生效，
    # 存放在独立的 shared_price 字段，不进入 brand_prices（避免被误当作某品牌的兜底单价）。
    brand_prices = {}
    shared_price = None
    for c in brand_contracts:
        bid = c.get("brand_id")
        info = {
            "price": float(c.get("electricity_price")) if c.get("electricity_price") is not None else None,
            "tax_rate": float(c.get("tax_rate") or 0.01),
            "tax_enabled": bool(c.get("tax_enabled")),
            "post_tax": float(c["post_tax_electricity_price"]) if c.get("post_tax_electricity_price") is not None else None,
        }
        if bid is None:
            if shared_price is None:
                shared_price = info
            continue
        brand_prices[int(bid)] = info

    return {
        "pay_price": pay_price,
        "pay_price_conflict": pay_price_conflict,
        "brand_prices": brand_prices,
        "shared_price": shared_price,
    }


def brand_collect_price(brand_id, pricing: dict):
    """取某品牌电表的收款单价（税前）。

    brand_id=None → 共享电表，取「全品牌合同」单价；无该品牌合同/无全品牌合同 → None（收入为 0）。
    """
    if brand_id is None:
        info = pricing.get("shared_price")
    else:
        info = pricing.get("brand_prices", {}).get(int(brand_id))
    if not info:
        return None
    return info["price"]


def split_tax(amount, rate):
    """价内税口径（用户确认 2026-08）：税费 = 收入（含税）× 税率；不含税 = 收入 − 税费。

    电费税费、场地费税费各自独立，均用本函数（各自传入各自的含税金额与税率）。

    Args:
        amount: 含税金额（收入）
        rate: 税率（0.01=1%）；为空/0 视为不扣税

    Returns:
        (tax, net) —— 税费、不含税金额
    """
    if not rate:
        return 0, round(float(amount), 2)
    tax = round(float(amount) * float(rate), 2)
    net = round(float(amount) - tax, 2)
    return tax, net


def rent_income_for_period(c: dict, period: str) -> float:
    """品牌方合同在指定月份的租金收入（#6 统一口径，与分红一致）：
    合同首月用 first_month_rent，其余月份用 monthly_rent。

    period: 'YYYYMM' 或 'YYYY-MM'。
    """
    start = c.get("start_date")
    first = c.get("first_month_rent")
    if start and first:
        s = str(start)
        sy, sm = int(s[:4]), int(s[5:7])
        p = str(period or "").replace("-", "")
        if len(p) >= 6:
            py, pm = int(p[:4]), int(p[4:6])
            if py == sy and pm == sm:
                return float(first)
    return float(c.get("monthly_rent") or 0)


def rent_refund_for_period(c: dict, period: str) -> float:
    """品牌方合同在指定月份的场地费退款（提前结束月，优先 early_end_date），无则 0。"""
    refund = c.get("rent_refund")
    if not refund:
        return 0
    end = c.get("early_end_date") or c.get("end_date")
    if not end:
        return 0
    s = str(end)
    ey, em = int(s[:4]), int(s[5:7])
    p = str(period or "").replace("-", "")
    if len(p) >= 6:
        py, pm = int(p[:4]), int(p[4:6])
        if py == ey and pm == em:
            return float(refund)
    return 0
