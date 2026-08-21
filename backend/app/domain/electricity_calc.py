"""电费计算"""

from .electricity_pricing import split_tax


def calc_electricity(meter_details: list, pay_price: float, collect_price: float, tax_rate: float) -> dict:
    """根据电表明细计算电费

    Args:
        meter_details: [{"meterId": 1, "startReading": 1000, "endReading": 2000}, ...]
        pay_price: 付款单价（付给业主）
        collect_price: 收款单价（品牌方付给公司）
        tax_rate: 税率

    Returns:
        电费计算结果
    """
    total_pay_kwh = 0
    total_collect_kwh = 0
    total_pay_amount = 0
    total_collect_amount = 0
    total_collect_net = 0
    details = []

    for md in meter_details:
        kwh = round(float(md.get("endReading", 0)) - float(md.get("startReading", 0)), 2)
        if kwh < 0:
            kwh = 0

        pay_amount = round(kwh * pay_price, 2)
        collect_amount = round(kwh * collect_price, 2)
        # 统一税费口径（用户确认）：税费 = 含税收入 × 税率；不含税 = 收入 − 税费
        _, collect_net = split_tax(collect_amount, tax_rate)

        total_pay_kwh += kwh
        total_collect_kwh += kwh
        total_pay_amount += pay_amount
        total_collect_amount += collect_amount
        total_collect_net += collect_net

        details.append({
            "meterId": md.get("meterId"),
            "startReading": md.get("startReading"),
            "endReading": md.get("endReading"),
            "kwh": kwh,
            "payUnitPrice": pay_price,
            "payAmount": pay_amount,
            "collectUnitPrice": collect_price,
            "collectAmount": collect_amount,
            "collectNet": collect_net,
        })

    profit = round(total_collect_net - total_pay_amount, 2)

    return {
        "payKwh": round(total_pay_kwh, 2),
        "payAmount": round(total_pay_amount, 2),
        "collectKwh": round(total_collect_kwh, 2),
        "collectAmount": round(total_collect_amount, 2),
        "collectNet": round(total_collect_net, 2),
        "profit": profit,
        "details": details,
    }
