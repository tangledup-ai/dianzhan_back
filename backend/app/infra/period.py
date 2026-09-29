"""period 统一格式化：全系统用 6 位 YYYYMM（与 meter_readings.month_period 一致）"""


def to_compact(period: str) -> str:
    """'2026-08' → '202608'；已是 '202608' 则原样返回。"""
    if not period:
        return period
    return str(period).replace("-", "")


def to_display(period: str) -> str:
    """'202608' → '2026-08'；已是 '2026-08' 则原样返回。"""
    if not period or "-" in period:
        return period
    p = str(period)
    if len(p) == 6:
        return f"{p[:4]}-{p[4:]}"
    return p
