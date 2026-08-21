"""租金计算"""


def calc_rent_profit(lease_annual_rent: float, income_monthly_rent: float) -> dict:
    """计算租金利润

    Args:
        lease_annual_rent: 付给业主的年租金
        income_monthly_rent: 品牌方付给公司的月租金

    Returns:
        租金计算结果
    """
    monthly_cost = round(lease_annual_rent / 12, 2) if lease_annual_rent else 0
    monthly_income = round(income_monthly_rent, 2) if income_monthly_rent else 0
    profit = round(monthly_income - monthly_cost, 2)

    return {
        "monthlyCost": monthly_cost,
        "monthlyIncome": monthly_income,
        "profit": profit,
    }
