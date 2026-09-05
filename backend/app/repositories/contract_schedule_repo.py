"""合同收付款分期：按 pay_method 拆期生成 + CRUD

- 付款分期表：rent_payment_schedule（场地合同，公司付给场地方）
- 收款分期表：rent_income_schedule（品牌方合同，品牌方付给公司）
"""
from datetime import date, timedelta
from ..infra.database import get_connection, get_dict_cursor

# 每期月数（pay_method → 期长）
_PERIOD_MONTHS = {
    "月付": 1,
    "季付": 3,
    "半年付": 6,
    "年付": 12,
}


def _nominal_period_end(ps: date, months: int) -> date:
    """本期不被合同截止日截断时的自然结束日（下一期起点的前一天）"""
    total_m = (ps.year * 12 + ps.month - 1) + months
    ny, nm = divmod(total_m, 12)
    return date(ny, nm + 1, 1) - timedelta(days=1)


def _period_amount(monthly: float, months: int, ps: date, pe: date, nominal_end: date,
                   first_ym: str, first_month_rent):
    """一期金额。

    - 完整期 = 月租 × 期长月数（含首月租金特殊期）；
    - 被合同截止日截短的尾期（不足一个完整付款周期）→ 返回 None（金额留空），
      由用户在分期列表手动填写，系统不擅自折算（2026-09 用户确认）。
    """
    monthly = float(monthly or 0)
    if pe >= nominal_end:
        if first_ym and ps.strftime("%Y%m") == first_ym:
            n = (pe.year * 12 + pe.month) - (ps.year * 12 + ps.month) + 1
            return round(float(first_month_rent or 0) + monthly * (n - 1), 2)
        return round(monthly * months, 2)
    return None


def _split_periods(start: date, end: date, months_per_period: int):
    """把 [start, end] 按 months_per_period 拆成 [start, end] 区间列表"""
    periods = []
    cur = start
    while cur <= end:
        # 本期结束 = 当前起点 + 期长月数 - 1 天
        y, m = cur.year, cur.month
        total_m = (y * 12 + m - 1) + months_per_period - 1
        ny, nm = divmod(total_m, 12)
        nm += 1
        # 本期区间结束（月末）
        if nm == 12:
            next_y, next_m = ny + 1, 1
        else:
            next_y, next_m = ny, nm + 1
        period_end = date(next_y, next_m, 1) - timedelta(days=1)
        if period_end > end:
            period_end = end
        periods.append((cur, period_end))
        # 下期起点
        total_m2 = (cur.year * 12 + cur.month - 1) + months_per_period
        ny2, nm2 = divmod(total_m2, 12)
        nm2 += 1
        cur = date(ny2, nm2, 1)
    return periods


def payment_due_months(start_date, end_date, pay_method, rent_advance_days=0):
    """按合同时间/付款方式/提前支付天数计算场地租金各期付款的到期月份（YYYY-MM 列表）。

    每期租金在期初前 rent_advance_days 天支付，到期月份取该付款日期所在月份。
    用于站点「提交审核」校验所选月份是否处于可提交场地费的月份。
    """
    if not start_date or not end_date:
        return []
    if isinstance(start_date, str):
        start_date = date.fromisoformat(str(start_date)[:10])
    if isinstance(end_date, str):
        end_date = date.fromisoformat(str(end_date)[:10])
    months = _PERIOD_MONTHS.get(pay_method, 1)
    days = int(rent_advance_days or 0)
    result = []
    for ps, _pe in _split_periods(start_date, end_date, months):
        due = ps - timedelta(days=days)
        result.append(f"{due.year:04d}-{due.month:02d}")
    return result


def generate_schedules(contract_id: int, contract_type: str, pay_method: str,
                       start_date, end_date, monthly_rent, first_month_rent=None):
    """为合同生成/重建分期记录（先删旧，再生成）。

    - 调用方需传"生效截止日"：提前结束的合同应传 early_end_date，使分期止于废弃月。
    - 填了首月场地租金（first_month_rent）时，包含合同首月的那一期金额
      = 首月租金 + 该期其余月份 × 月租，其余期仍为 月租 × 期长月数。
    - 不足完整付款周期的尾期：金额留空（NULL），由用户在分期列表手动填写；
      重建时若用户已填过金额则保留。
    修复 #7：重建时按 seq 保留旧分期的财务状态（已付款/已到账、付款日期、发票、备注），
    避免合同改价/改付款方式后重建丢失已标记的收付款状态。
    返回生成条数。
    """
    if not start_date or not end_date:
        return 0
    if isinstance(start_date, str):
        start_date = date.fromisoformat(str(start_date)[:10])
    if isinstance(end_date, str):
        end_date = date.fromisoformat(str(end_date)[:10])

    months = _PERIOD_MONTHS.get(pay_method, 1)
    periods = _split_periods(start_date, end_date, months)
    # 首月场地租金所在期（按月判断）：该期金额单独计算
    first_ym = ""
    if first_month_rent and start_date:
        first_ym = start_date.strftime("%Y%m")

    table = "rent_payment_schedule" if contract_type == "场地合同" else "rent_income_schedule"

    conn = get_connection()
    cur = conn.cursor()
    try:
        # 保存旧分期状态（按 seq 映射），重建后回填
        cur.execute(f"SELECT seq, status, pay_date, invoice, remark, amount FROM {table} WHERE contract_id = %s", (contract_id,))
        old_rows = {}
        for r in cur.fetchall():
            old_rows[r[0]] = {"status": r[1], "pay_date": r[2], "invoice": r[3], "remark": r[4], "amount": r[5]}

        cur.execute(f"DELETE FROM {table} WHERE contract_id = %s", (contract_id,))
        for i, (ps, pe) in enumerate(periods, start=1):
            period_amount = _period_amount(monthly_rent, months, ps, pe,
                                           _nominal_period_end(ps, months), first_ym, first_month_rent)
            old = old_rows.get(i, {})
            # 尾期金额留空由用户手填；用户已填过的金额在重建时保留，不被清空
            if period_amount is None and old.get("amount") is not None:
                period_amount = old["amount"]
            cur.execute(f"""
                INSERT INTO {table} (contract_id, seq, period_start, period_end, amount, status, pay_date, invoice, remark)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (contract_id, seq) DO UPDATE SET
                    period_start = EXCLUDED.period_start,
                    period_end = EXCLUDED.period_end,
                    amount = EXCLUDED.amount,
                    status = EXCLUDED.status,
                    pay_date = EXCLUDED.pay_date,
                    invoice = EXCLUDED.invoice,
                    remark = EXCLUDED.remark
            """, (
                contract_id, i, ps, pe, period_amount,
                old.get("status") or ("未付款" if table == "rent_payment_schedule" else "未到账"),
                old.get("pay_date"), old.get("invoice"), old.get("remark"),
            ))
        conn.commit()
        return len(periods)
    finally:
        cur.close()
        conn.close()


def list_schedules(contract_id: int = None):
    """查询分期记录。contract_type 用于确定查哪张表（场地=付款，品牌方=收款）。"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if contract_id:
            conditions.append("contract_id = %s"); values.append(contract_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        # 返回两张表合并（含表名标识）
        results = []
        cur.execute(f"SELECT 'payment' as side, * FROM rent_payment_schedule {where} ORDER BY seq", values)
        results += cur.fetchall()
        cur.execute(f"SELECT 'income' as side, * FROM rent_income_schedule {where} ORDER BY seq", values)
        results += cur.fetchall()
        return results
    finally:
        cur.close()
        conn.close()


def list_payment_schedules(contract_id: int = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if contract_id:
            conditions.append("contract_id = %s"); values.append(contract_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"SELECT * FROM rent_payment_schedule {where} ORDER BY seq", values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def list_income_schedules(contract_id: int = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if contract_id:
            conditions.append("contract_id = %s"); values.append(contract_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"SELECT * FROM rent_income_schedule {where} ORDER BY seq", values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_schedule(contract_id: int, side: str, data: dict):
    """手动添加一期分期（side: payment=付款, income=收款）"""
    table = "rent_payment_schedule" if side == "payment" else "rent_income_schedule"
    default_status = "未付款" if side == "payment" else "未到账"
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 自动计算 seq：当前最大 + 1
        cur.execute(f"SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM {table} WHERE contract_id = %s", (contract_id,))
        next_seq = cur.fetchone()["next_seq"]

        cur.execute(f"""
            INSERT INTO {table} (contract_id, seq, period_start, period_end, amount, status, pay_date, invoice, remark)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            contract_id, next_seq,
            data.get("periodStart"), data.get("periodEnd"),
            data.get("amount"), data.get("status") or default_status,
            data.get("payDate"), data.get("invoice"), data.get("remark")
        ))
        conn.commit()
        row = cur.fetchone()
        if row:
            row["side"] = side
        return row
    finally:
        cur.close()
        conn.close()


def update_schedule(schedule_id: int, side: str, data: dict):
    """更新分期状态（标记已付款/已到账 + 日期 + 发票）。side 必传：payment/income，避免两张表 id 冲突。"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        table = "rent_payment_schedule" if side == "payment" else "rent_income_schedule"
        if not table:
            return None
        field_map = {
            "status": "status", "payDate": "pay_date",
            "invoice": "invoice", "remark": "remark",
            "amount": "amount",
        }
        updates, values = [], []
        # 撤销标记：状态改回未付款/未到账时，清空实际付款/到账日期（忽略传入的 payDate）
        revert = data.get("status") in ("未付款", "未到账")
        for key, db_field in field_map.items():
            if key not in data:
                continue
            if key == "payDate" and revert:
                continue
            if data[key] is not None:
                updates.append(f"{db_field} = %s"); values.append(data[key])
        if revert:
            updates.append("pay_date = NULL")
        if not updates:
            return None
        values.append(schedule_id)
        cur.execute(f"UPDATE {table} SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        row = cur.fetchone()
        if row:
            row["side"] = "payment" if table == "rent_payment_schedule" else "income"
        return row
    finally:
        cur.close()
        conn.close()


def delete_schedules(contract_id: int, contract_type: str):
    """删除合同的全部分期（合同删除时调用）"""
    table = "rent_payment_schedule" if contract_type == "场地合同" else "rent_income_schedule"
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute(f"DELETE FROM {table} WHERE contract_id = %s", (contract_id,))
        conn.commit()
    finally:
        cur.close()
        conn.close()
