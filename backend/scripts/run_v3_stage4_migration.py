#!/usr/bin/env python3
"""
v3 阶段4：删除 stations 表和所有 station_id 列
"""

import sys
import os
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

# 加载环境变量
from dotenv import load_dotenv
load_dotenv(project_root / ".env")

# 导入数据库配置
from backend.app.config import DATABASE_URL

# 数据库连接
import psycopg2
from psycopg2.extras import RealDictCursor

def connect_db():
    """连接数据库"""
    return psycopg2.connect(DATABASE_URL)

def run_migration():
    """执行迁移"""
    print("=" * 60)
    print("v3 阶段4：删除 stations 表和所有 station_id 列")
    print("=" * 60)

    conn = connect_db()
    conn.autocommit = False
    cur = conn.cursor()

    try:
        # 1. 解除对 stations 的外键
        print("\n1. 解除对 stations 的外键...")
        foreign_keys = [
            "contracts_station_id_fkey",
            "dividend_records_station_id_fkey",
            "electricity_records_station_id_fkey",
            "meters_station_id_fkey",
            "operating_expenses_station_id_fkey",
            "rent_income_records_station_id_fkey",
            "rent_incomes_station_id_fkey",
            "rent_leases_station_id_fkey",
            "rent_payment_records_station_id_fkey",
            "station_introducer_configs_station_id_fkey",
            "station_shareholder_configs_station_id_fkey",
            "approval_requests_station_id_fkey"
        ]

        for fk in foreign_keys:
            try:
                cur.execute(f"ALTER TABLE contracts DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE dividend_records DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE electricity_records DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE meters DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE operating_expenses DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE rent_income_records DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE rent_incomes DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE rent_leases DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE rent_payment_records DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE station_introducer_configs DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE station_shareholder_configs DROP CONSTRAINT IF EXISTS {fk}")
                cur.execute(f"ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS {fk}")
            except Exception as e:
                print(f"  警告: 删除外键 {fk} 时出错: {e}")

        conn.commit()
        print("  外键解除完成")

        # 2. 删除 station_id 列
        print("\n2. 删除 station_id 列...")
        tables_with_station_id = [
            "contracts",
            "dividend_records",
            "electricity_records",
            "meters",
            "operating_expenses",
            "rent_income_records",
            "rent_incomes",
            "rent_leases",
            "rent_payment_records",
            "station_introducer_configs",
            "station_shareholder_configs",
            "approval_requests"
        ]

        for table in tables_with_station_id:
            try:
                cur.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS station_id")
                print(f"  已删除 {table}.station_id")
            except Exception as e:
                print(f"  警告: 删除 {table}.station_id 时出错: {e}")

        # 删除废弃列
        try:
            cur.execute("ALTER TABLE contracts DROP COLUMN IF EXISTS station_name")
            print("  已删除 contracts.station_name")
        except Exception as e:
            print(f"  警告: 删除 contracts.station_name 时出错: {e}")

        try:
            cur.execute("ALTER TABLE approval_requests DROP COLUMN IF EXISTS station_name")
            print("  已删除 approval_requests.station_name")
        except Exception as e:
            print(f"  警告: 删除 approval_requests.station_name 时出错: {e}")

        conn.commit()
        print("  station_id 列删除完成")

        # 3. 删除 stations 表
        print("\n3. 删除 stations 表...")
        try:
            cur.execute("DROP TABLE IF EXISTS stations")
            print("  已删除 stations 表")
        except Exception as e:
            print(f"  警告: 删除 stations 表时出错: {e}")

        conn.commit()
        print("  stations 表删除完成")

        # 4. 重建依赖 stations 的视图
        print("\n4. 重建依赖 stations 的视图...")

        # 4.1 landlord_monthly_summary
        try:
            cur.execute("DROP VIEW IF EXISTS landlord_monthly_summary")
            cur.execute("""
                CREATE OR REPLACE VIEW landlord_monthly_summary AS
                WITH periods AS (
                    SELECT period FROM electricity_records
                    UNION SELECT period FROM operating_expenses
                    UNION SELECT period FROM dividend_records
                )
                SELECT
                    l.id AS landlord_id,
                    l.name AS landlord_name,
                    p.period,
                    COUNT(DISTINCT m.id)::INTEGER AS meter_count,
                    COUNT(DISTINCT e.id)::INTEGER AS elec_record_count,
                    COALESCE(SUM(e.pay_kwh), 0)::NUMERIC(14,2) AS elec_pay_kwh,
                    COALESCE(SUM(e.pay_amount), 0)::NUMERIC(14,2) AS elec_pay_amount,
                    COALESCE(SUM(e.collect_amount), 0)::NUMERIC(14,2) AS elec_collect_amount,
                    COALESCE(SUM(e.collect_net), 0)::NUMERIC(14,2) AS elec_collect_net,
                    (COALESCE(SUM(e.collect_amount), 0) - COALESCE(SUM(e.collect_net), 0))::NUMERIC(14,2) AS elec_tax,
                    (COALESCE(SUM(e.collect_net), 0) - COALESCE(SUM(e.pay_amount), 0))::NUMERIC(14,2) AS elec_profit,
                    COALESCE(SUM(oc.monthly_rent), 0)::NUMERIC(14,2) AS rent_cost,
                    COALESCE(SUM(ic.monthly_rent), 0)::NUMERIC(14,2) AS rent_income,
                    (COALESCE(SUM(ic.monthly_rent), 0) - COALESCE(SUM(oc.monthly_rent), 0)
                     - COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                                         THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0))::NUMERIC(14,2) AS rent_profit,
                    COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                                      THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0)::NUMERIC(14,2) AS rent_tax,
                    COALESCE(SUM(oe.amount), 0)::NUMERIC(14,2) AS op_expense,
                    COALESCE(SUM(d.profit), 0)::NUMERIC(14,2) AS net_profit,
                    (COALESCE(SUM(e.collect_net), 0) - COALESCE(SUM(e.pay_amount), 0)
                     + COALESCE(SUM(ic.monthly_rent), 0) - COALESCE(SUM(oc.monthly_rent), 0)
                     - COALESCE(SUM(CASE WHEN ic.rent_tax_enabled AND ic.post_tax_rent_price IS NOT NULL
                                         THEN ic.monthly_rent - ic.post_tax_rent_price ELSE 0 END), 0)
                     - COALESCE(SUM(oe.amount), 0)
                     - COALESCE(SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL), 0)
                     - COALESCE(SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL), 0))::NUMERIC(14,2) AS gross_profit,
                    COALESCE(SUM(ds.amount) FILTER (WHERE ds.shareholder_id IS NOT NULL), 0)::NUMERIC(14,2) AS shareholder_dividend,
                    COALESCE(SUM(ds.amount) FILTER (WHERE ds.introducer_id IS NOT NULL), 0)::NUMERIC(14,2) AS biz_dividend
                FROM landlords l
                CROSS JOIN periods p
                LEFT JOIN meters m ON m.landlord_id = l.id AND m.brand_id IS NOT NULL AND m.meter_no NOT LIKE 'TEST%'
                LEFT JOIN electricity_records e ON e.landlord_id = l.id AND e.period = p.period
                LEFT JOIN contracts oc ON oc.landlord_id = l.id AND oc.contract_type = '场地合同'
                    AND (oc.start_date IS NULL OR oc.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
                    AND (COALESCE(oc.early_end_date, oc.end_date) IS NULL OR COALESCE(oc.early_end_date, oc.end_date) >= DATE(p.period || '01'))
                LEFT JOIN contracts ic ON ic.landlord_id = l.id AND ic.contract_type = '品牌方合同'
                    AND (ic.start_date IS NULL OR ic.start_date <= (DATE(p.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
                    AND (COALESCE(ic.early_end_date, ic.end_date) IS NULL OR COALESCE(ic.early_end_date, ic.end_date) >= DATE(p.period || '01'))
                LEFT JOIN operating_expenses oe ON oe.landlord_id = l.id AND oe.period = p.period
                LEFT JOIN dividend_records d ON d.landlord_id = l.id AND d.period = p.period
                LEFT JOIN dividend_shares ds ON ds.dividend_id = d.id
                GROUP BY l.id, l.name, p.period
            """)
            print("  已重建 landlord_monthly_summary 视图")
        except Exception as e:
            print(f"  警告: 重建 landlord_monthly_summary 视图时出错: {e}")

        # 4.2 dividend_settlement_schedule
        try:
            cur.execute("DROP VIEW IF EXISTS dividend_settlement_schedule")
            cur.execute("""
                CREATE OR REPLACE VIEW dividend_settlement_schedule AS
                WITH cur AS (
                    SELECT
                        to_char(CURRENT_DATE, 'YYYYMM') AS cur_period,
                        to_char(CURRENT_DATE, 'YYYY')   AS cur_year,
                        to_char(date_trunc('quarter', CURRENT_DATE), 'YYYYMM') AS q_start,
                        to_char(date_trunc('quarter', CURRENT_DATE) + interval '3 months' - interval '1 day', 'YYYYMM') AS q_end,
                        to_char(date_trunc('year', CURRENT_DATE), 'YYYYMM') AS y_start,
                        to_char(date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day', 'YYYYMM') AS y_end
                ),
                period_range AS (
                    SELECT '月' AS settlement_period,
                           cur.cur_period AS p_start, cur.cur_period AS p_end,
                           cur.cur_period AS next_period,
                           (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')::date AS next_date
                    FROM cur
                    UNION ALL
                    SELECT '季度', cur.q_start, cur.q_end, cur.q_end,
                           (date_trunc('quarter', CURRENT_DATE) + interval '3 months' - interval '1 day')::date
                    FROM cur
                    UNION ALL
                    SELECT '半年',
                           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '01' ELSE cur.cur_year || '07' END,
                           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '06' ELSE cur.y_end END,
                           CASE WHEN cur.cur_period <= cur.cur_year || '06' THEN cur.cur_year || '06' ELSE cur.y_end END,
                           CASE WHEN cur.cur_period <= cur.cur_year || '06'
                                THEN (date_trunc('year', CURRENT_DATE) + interval '6 months' - interval '1 day')::date
                                ELSE (date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day')::date END
                    FROM cur
                    UNION ALL
                    SELECT '年', cur.y_start, cur.y_end, cur.y_end,
                           (date_trunc('year', CURRENT_DATE) + interval '1 year' - interval '1 day')::date
                    FROM cur
                ),
                periods AS (
                    SELECT '股东' AS beneficiary_type, shareholder_id AS beneficiary_id, settlement_period,
                           COUNT(DISTINCT landlord_id) AS landlord_count
                    FROM landlord_shareholder_configs
                    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
                    GROUP BY shareholder_id, settlement_period
                    UNION ALL
                    SELECT '商务' AS beneficiary_type, introducer_id AS beneficiary_id, settlement_period,
                           COUNT(DISTINCT landlord_id) AS landlord_count
                    FROM landlord_introducer_configs
                    WHERE COALESCE(end_date, DATE '9999-12-31') >= CURRENT_DATE
                    GROUP BY introducer_id, settlement_period
                )
                SELECT
                    p.beneficiary_type,
                    p.beneficiary_id,
                    COALESCE(sh.name, i.name) AS beneficiary_name,
                    p.settlement_period,
                    p.landlord_count,
                    pr.p_start, pr.p_end, pr.next_period, pr.next_date,
                    COALESCE(SUM(CASE WHEN d.status = '已结算' THEN ds.amount ELSE 0 END), 0)::NUMERIC(14,2) AS settled_amount,
                    COALESCE(SUM(CASE WHEN d.status <> '已结算' THEN ds.amount ELSE 0 END), 0)::NUMERIC(14,2) AS pending_amount
                FROM periods p
                CROSS JOIN period_range pr
                LEFT JOIN dividend_shares ds ON ds.dividend_id IS NOT NULL
                    AND ((p.beneficiary_type = '股东' AND ds.shareholder_id = p.beneficiary_id)
                         OR (p.beneficiary_type = '商务' AND ds.introducer_id = p.beneficiary_id))
                LEFT JOIN dividend_records d ON ds.dividend_id = d.id AND d.period BETWEEN pr.p_start AND pr.p_end
                LEFT JOIN shareholders sh ON p.beneficiary_type = '股东' AND sh.id = p.beneficiary_id
                LEFT JOIN introducers i ON p.beneficiary_type = '商务' AND i.id = p.beneficiary_id
                GROUP BY p.beneficiary_type, p.beneficiary_id, COALESCE(sh.name, i.name), p.settlement_period,
                         p.landlord_count, pr.p_start, pr.p_end, pr.next_period, pr.next_date
            """)
            print("  已重建 dividend_settlement_schedule 视图")
        except Exception as e:
            print(f"  警告: 重建 dividend_settlement_schedule 视图时出错: {e}")

        conn.commit()
        print("  视图重建完成")

        print("\n" + "=" * 60)
        print("迁移完成！stations 表和所有 station_id 列已删除")
        print("=" * 60)

    except Exception as e:
        print(f"\n错误: {e}")
        conn.rollback()
        sys.exit(1)
    finally:
        cur.close()
        conn.close()

if __name__ == "__main__":
    run_migration()