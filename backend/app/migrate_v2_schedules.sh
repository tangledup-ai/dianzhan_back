#!/bin/sh
# ============================================================
# 补迁：v2 → v5 的【收付款分期】（rent_payment_schedule / rent_income_schedule）
# 背景：migrate_v2_to_v5.sql 按「账单类（台账/分期）舍弃」的口径没有迁分期，
#       导致 v5 里分期为空 ⇒ 场租台账「付款计划」全部 0 期、已收未收全为 0。
# 本脚本只写这两张表，不动其它任何数据；目标表必须为空（防止重复灌）。
# 用法：docker exec postgres-quant sh /tmp/migrate_v2_schedules.sh
# ============================================================
set -e

echo "──── 迁移前 ────"
psql -U quant -d huandian_v5 -At -c "SELECT 'v5 付款分期='||count(*)||' 行' FROM rent_payment_schedule; SELECT 'v5 收款分期='||count(*)||' 行' FROM rent_income_schedule"

pay_n=$(psql -U quant -d huandian_v5 -At -c "SELECT count(*) FROM rent_payment_schedule")
inc_n=$(psql -U quant -d huandian_v5 -At -c "SELECT count(*) FROM rent_income_schedule")
if [ "$pay_n" != "0" ] || [ "$inc_n" != "0" ]; then
  echo "❌ ABORT：v5 分期表非空（付款 $pay_n / 收款 $inc_n），为避免重复灌入已中止"
  exit 1
fi

# 外键保护：contract_id 在 v5 若不存在，COPY 会因 FK 约束直接失败并整条回滚（不会写入半截数据）

echo "──── 拷贝付款分期 ────"
psql -U quant -d huandian_v2 -c "COPY (
    SELECT id, contract_id, seq, to_char(period_start,'YYYYMM'),
           period_start, period_end, amount, status, pay_date, invoice, 'migrated', remark, created_at
    FROM rent_payment_schedule ORDER BY id
  ) TO STDOUT" \
| psql -U quant -d huandian_v5 -v ON_ERROR_STOP=1 -c "COPY rent_payment_schedule
    (id, contract_id, seq, period, period_start, period_end, amount, status, pay_date, invoice, data_source, remark, created_at)
    FROM STDIN"

echo "──── 拷贝收款分期 ────"
psql -U quant -d huandian_v2 -c "COPY (
    SELECT id, contract_id, seq, to_char(period_start,'YYYYMM'),
           period_start, period_end, amount, status, pay_date, invoice, 'migrated', remark, created_at
    FROM rent_income_schedule ORDER BY id
  ) TO STDOUT" \
| psql -U quant -d huandian_v5 -v ON_ERROR_STOP=1 -c "COPY rent_income_schedule
    (id, contract_id, seq, period, period_start, period_end, amount, status, pay_date, invoice, data_source, remark, created_at)
    FROM STDIN"

echo "──── 重置自增序列（否则后续新增分期会撞主键）────"
psql -U quant -d huandian_v5 -At -c "SELECT 'payment next id → '||setval(pg_get_serial_sequence('rent_payment_schedule','id'), COALESCE((SELECT MAX(id) FROM rent_payment_schedule),1))"
psql -U quant -d huandian_v5 -At -c "SELECT 'income  next id → '||setval(pg_get_serial_sequence('rent_income_schedule','id'), COALESCE((SELECT MAX(id) FROM rent_income_schedule),1))"

echo "──── 迁移后 ────"
psql -U quant -d huandian_v5 -At -c "SELECT 'v5 付款分期='||count(*)||' 行' FROM rent_payment_schedule; SELECT 'v5 收款分期='||count(*)||' 行' FROM rent_income_schedule"
psql -U quant -d huandian_v5 -c "SELECT contract_id, seq, period, period_start, period_end, amount, status, pay_date, data_source FROM rent_payment_schedule WHERE contract_id = 214 ORDER BY seq"
