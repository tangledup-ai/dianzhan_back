#!/usr/bin/env python3
"""
完整数据迁移脚本：将所有 meters 相关数据迁移到新数据库

迁移表：
1. meters → meter_devices (已完成)
2. meter_collectors → meter_collectors
3. meter_status_cache → meter_status_cache
4. meter_hourly → meter_hourly
5. meter_daily → meter_daily
6. meter_monthly → meter_monthly
"""

import psycopg2
from datetime import datetime, timedelta
import json

# 数据库连接配置
DB_CONFIG = {
    'host': 'localhost',
    'port': 5432,
    'user': 'quant',
    'password': 'quant-speed123'
}

OLD_DB = {**DB_CONFIG, 'dbname': 'huandian_v2'}
NEW_DB = {**DB_CONFIG, 'dbname': 'dianzhan-test'}

def migrate_with_custom_sql(table_name, insert_sql, select_sql, transform_func=None, batch_size=1000):
    """使用自定义 SQL 的表迁移函数"""

    old_conn = psycopg2.connect(**OLD_DB)
    old_cur = old_conn.cursor()

    new_conn = psycopg2.connect(**NEW_DB)
    new_cur = new_conn.cursor()

    try:
        # 检查目标表是否已有数据
        new_cur.execute(f"SELECT COUNT(*) FROM {table_name}")
        existing_count = new_cur.fetchone()[0]

        if existing_count > 0:
            print(f"  目标表 {table_name} 已有 {existing_count} 条数据")
            user_input = input(f"  是否清空后重新迁移？(y/N): ").strip().lower()
            if user_input == 'y':
                new_cur.execute(f"DELETE FROM {table_name}")
                new_conn.commit()
                print(f"  已清空 {table_name} 表")
            else:
                print(f"  跳过 {table_name} 迁移")
                return 0

        # 获取源数据
        old_cur.execute(select_sql)
        rows = old_cur.fetchall()

        if not rows:
            print(f"  {table_name} 表无数据")
            return 0

        # 批量插入
        success_count = 0
        error_count = 0

        for i in range(0, len(rows), batch_size):
            batch = rows[i:i+batch_size]
            for row in batch:
                try:
                    # 应用转换函数（如果有的话）
                    if transform_func:
                        row = transform_func(row)
                    new_cur.execute(insert_sql, row)
                    success_count += 1
                except Exception as e:
                    print(f"  插入失败: {e}")
                    error_count += 1

            # 每批次提交一次
            new_conn.commit()
            print(f"  已处理 {min(i+batch_size, len(rows))}/{len(rows)} 条")

        print(f"  迁移完成: 成功 {success_count} 条, 失败 {error_count} 条")
        return success_count

    except Exception as e:
        print(f"  迁移 {table_name} 时发生错误: {e}")
        new_conn.rollback()
        raise
    finally:
        old_cur.close()
        old_conn.close()
        new_cur.close()
        new_conn.close()

def transform_meter_collectors(row):
    """转换 meter_collectors 数据
    旧表: id(varchar), collector_id, description, device_count, raw_data(jsonb), synced_at
    新表: id(bigint), collector_id, csq, imei, iccid, online, description, connect_time, created_at, updated_at
    """
    # 旧表数据：(id, collector_id, description, device_count, raw_data, synced_at)
    id_val, collector_id, description, device_count, raw_data, synced_at = row

    # 从 raw_data 中提取字段（如果有的话）
    csq = None
    imei = None
    iccid = None
    online = False
    connect_time = synced_at

    # 尝试从 raw_data 解析
    if raw_data:
        try:
            data = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
            csq = data.get('csq')
            imei = data.get('imei')
            iccid = data.get('iccid')
            online = data.get('online', False)
        except:
            pass

    # 返回新表格式：(collector_id, csq, imei, iccid, online, description, connect_time, created_at, updated_at)
    now = datetime.now()
    return (collector_id, csq, imei, iccid, online, description, connect_time, now, now)

def transform_meter_status_cache(row):
    """转换 meter_status_cache 数据
    旧表: id(integer), device_id, address, c0-c4, remain_money, synced_at
    新表: id(bigint), device_id, address, c0-c4, remain_money, updated_at
    """
    # 旧表数据：(id, device_id, address, c0, c1, c2, c3, c4, remain_money, synced_at)
    id_val, device_id, address, c0, c1, c2, c3, c4, remain_money, synced_at = row

    # 返回新表格式：(device_id, address, c0, c1, c2, c3, c4, remain_money, updated_at)
    return (device_id, address, c0, c1, c2, c3, c4, remain_money, synced_at)

def transform_meter_hourly(row):
    """转换 meter_hourly 数据
    旧表: id(integer), device_id, address, hour_time(varchar), kwh, raw_data(jsonb), synced_at
    新表: id(bigint), device_id, start_time, end_time, d0-d4, e0, s0, rate, created_at
    """
    # 旧表数据：(id, device_id, address, hour_time, kwh, raw_data, synced_at)
    id_val, device_id, address, hour_time, kwh, raw_data, synced_at = row

    # 解析 hour_time (格式可能是 "2026-08-20 14:00:00" 或其他格式)
    try:
        if isinstance(hour_time, str):
            start_time = datetime.strptime(hour_time, '%Y-%m-%d %H:%M:%S')
        else:
            start_time = hour_time
        # 假设每小时数据，结束时间 = 开始时间 + 1小时
        end_time = start_time + timedelta(hours=1)
    except:
        start_time = synced_at
        end_time = synced_at

    # 从 raw_data 中提取详细数据（如果有的话）
    d0 = kwh  # 总用电量
    d1 = None  # 尖峰
    d2 = None  # 峰时
    d3 = None  # 平时
    d4 = None  # 谷时
    e0 = None  # 结束抄表总度数
    s0 = None  # 开始抄表总度数
    rate = None  # 倍率

    if raw_data:
        try:
            data = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
            d0 = data.get('d0', kwh)
            d1 = data.get('d1')
            d2 = data.get('d2')
            d3 = data.get('d3')
            d4 = data.get('d4')
            e0 = data.get('e0')
            s0 = data.get('s0')
            rate = data.get('rate')
        except:
            pass

    # 返回新表格式：(device_id, start_time, end_time, d0, d1, d2, d3, d4, e0, s0, rate, created_at)
    return (device_id, start_time, end_time, d0, d1, d2, d3, d4, e0, s0, rate, synced_at)

def transform_meter_daily(row):
    """转换 meter_daily 数据
    旧表: id(integer), device_id, address, day_date(varchar), kwh, raw_data(jsonb), synced_at
    新表: id(bigint), device_id, date(date), d0-d4, e0, s0, rate, created_at
    """
    # 旧表数据：(id, device_id, address, day_date, kwh, raw_data, synced_at)
    id_val, device_id, address, day_date, kwh, raw_data, synced_at = row

    # 解析 day_date
    try:
        if isinstance(day_date, str):
            date_val = datetime.strptime(day_date, '%Y-%m-%d').date()
        else:
            date_val = day_date
    except:
        date_val = datetime.now().date()

    # 从 raw_data 中提取详细数据（如果有的话）
    d0 = kwh  # 总用电量
    d1 = None  # 尖峰
    d2 = None  # 峰时
    d3 = None  # 平时
    d4 = None  # 谷时
    e0 = None  # 结束总度数
    s0 = None  # 开始总度数
    rate = None  # 倍率

    if raw_data:
        try:
            data = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
            d0 = data.get('d0', kwh)
            d1 = data.get('d1')
            d2 = data.get('d2')
            d3 = data.get('d3')
            d4 = data.get('d4')
            e0 = data.get('e0')
            s0 = data.get('s0')
            rate = data.get('rate')
        except:
            pass

    # 返回新表格式：(device_id, date, d0, d1, d2, d3, d4, e0, s0, rate, created_at)
    return (device_id, date_val, d0, d1, d2, d3, d4, e0, s0, rate, synced_at)

def transform_meter_monthly(row):
    """转换 meter_monthly 数据
    旧表: id(integer), address, month_period(varchar), kwh, raw_data(jsonb), synced_at, prev/curr reading fields
    新表: id(bigint), device_id, year_month(varchar), d0-d4, e0, s0, rate, created_at
    """
    # 旧表数据：(id, address, month_period, kwh, raw_data, synced_at, prev_reading_date, prev_reading, curr_reading_date, curr_reading, actual_kwh)
    id_val, address, month_period, kwh, raw_data, synced_at, prev_reading_date, prev_reading, curr_reading_date, curr_reading, actual_kwh = row

    # 从 meter_devices 表中查找 device_id（通过 address）
    # 注意：这里需要在迁移前建立 address 到 device_id 的映射
    # 为了简化，我们假设 address 就是 device_id
    device_id = address

    # 从 raw_data 中提取详细数据（如果有的话）
    d0 = actual_kwh if actual_kwh else kwh  # 优先使用 actual_kwh
    d1 = None  # 尖峰
    d2 = None  # 峰时
    d3 = None  # 平时
    d4 = None  # 谷时
    e0 = curr_reading  # 月末总度数
    s0 = prev_reading  # 月初总度数
    rate = None  # 倍率

    if raw_data:
        try:
            data = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
            d0 = data.get('d0', d0)
            d1 = data.get('d1')
            d2 = data.get('d2')
            d3 = data.get('d3')
            d4 = data.get('d4')
            e0 = data.get('e0', e0)
            s0 = data.get('s0', s0)
            rate = data.get('rate')
        except:
            pass

    # 返回新表格式：(device_id, year_month, d0, d1, d2, d3, d4, e0, s0, rate, created_at)
    return (device_id, month_period, d0, d1, d2, d3, d4, e0, s0, rate, synced_at)

def main():
    print("=" * 60)
    print("完整数据迁移：所有 meters 相关表")
    print("=" * 60)

    # 迁移顺序（按依赖关系）
    # 每个迁移定义：(表名, 插入SQL, 查询SQL, 转换函数)
    migrations = [
        (
            "meter_collectors",
            """INSERT INTO meter_collectors (collector_id, csq, imei, iccid, online, description, connect_time, created_at, updated_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            "SELECT id, collector_id, description, device_count, raw_data, synced_at FROM meter_collectors",
            transform_meter_collectors
        ),
        (
            "meter_status_cache",
            """INSERT INTO meter_status_cache (device_id, address, c0, c1, c2, c3, c4, remain_money, updated_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            "SELECT id, device_id, address, c0, c1, c2, c3, c4, remain_money, synced_at FROM meter_status_cache",
            transform_meter_status_cache
        ),
        (
            "meter_hourly",
            """INSERT INTO meter_hourly (device_id, start_time, end_time, d0, d1, d2, d3, d4, e0, s0, rate, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            "SELECT id, device_id, address, hour_time, kwh, raw_data, synced_at FROM meter_hourly",
            transform_meter_hourly
        ),
        (
            "meter_daily",
            """INSERT INTO meter_daily (device_id, date, d0, d1, d2, d3, d4, e0, s0, rate, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            "SELECT id, device_id, address, day_date, kwh, raw_data, synced_at FROM meter_daily",
            transform_meter_daily
        ),
        (
            "meter_monthly",
            """INSERT INTO meter_monthly (device_id, year_month, d0, d1, d2, d3, d4, e0, s0, rate, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            """SELECT id, address, month_period, kwh, raw_data, synced_at,
                      prev_reading_date, prev_reading, curr_reading_date, curr_reading, actual_kwh
               FROM meter_monthly""",
            transform_meter_monthly
        ),
    ]

    total_success = 0

    for table_name, insert_sql, select_sql, transform_func in migrations:
        print(f"\n正在迁移 {table_name}...")
        try:
            count = migrate_with_custom_sql(table_name, insert_sql, select_sql, transform_func)
            total_success += count
        except Exception as e:
            print(f"迁移 {table_name} 失败: {e}")
            import traceback
            traceback.print_exc()
            continue

    print("\n" + "=" * 60)
    print(f"所有迁移完成！总成功迁移: {total_success} 条")
    print("=" * 60)

if __name__ == "__main__":
    main()
