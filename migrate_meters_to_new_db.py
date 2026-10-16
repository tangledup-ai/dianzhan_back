#!/usr/bin/env python3
"""
数据迁移脚本：将 meters 表数据迁移到新数据库的 meter_devices 表

字段映射关系：
- meters.meter_no → meter_devices.device_id (第三方设备ID)
- meters.collector_id → meter_devices.collector_id (采集器ID)
- meters.meter_no → meter_devices.address (电表地址)
- meters.meter_name → meter_devices.description (设备描述/名称)
- meters.transformer_ratio → meter_devices.rate (倍率)
- meters.created_at → meter_devices.created_at
- now() → meter_devices.updated_at
"""

import psycopg2
from datetime import datetime

# 旧数据库连接配置
OLD_DB_CONFIG = {
    'host': 'localhost',
    'port': 5432,
    'user': 'quant',
    'password': 'CHANGE_ME_DB_PASSWORD',
    'dbname': 'huandian_v2'
}

# 新数据库连接配置
NEW_DB_CONFIG = {
    'host': 'localhost',
    'port': 5432,
    'user': 'quant',
    'password': 'CHANGE_ME_DB_PASSWORD',
    'dbname': 'dianzhan-test'
}

def migrate_meters():
    """迁移 meters 数据到 meter_devices"""

    # 连接旧数据库
    old_conn = psycopg2.connect(**OLD_DB_CONFIG)
    old_cur = old_conn.cursor()

    # 连接新数据库
    new_conn = psycopg2.connect(**NEW_DB_CONFIG)
    new_cur = new_conn.cursor()

    try:
        # 1. 从旧数据库读取 meters 数据
        print("正在从旧数据库读取 meters 数据...")
        old_cur.execute("""
            SELECT id, meter_no, meter_name, collector_id, transformer_ratio, created_at
            FROM meters
            ORDER BY id
        """)
        meters = old_cur.fetchall()
        print(f"读取到 {len(meters)} 条 meters 数据")

        # 2. 检查新数据库 meter_devices 表是否已有数据
        new_cur.execute("SELECT COUNT(*) FROM meter_devices")
        existing_count = new_cur.fetchone()[0]

        if existing_count > 0:
            print(f"警告：新数据库 meter_devices 表已有 {existing_count} 条数据")
            user_input = input("是否清空后重新迁移？(y/N): ").strip().lower()
            if user_input == 'y':
                new_cur.execute("DELETE FROM meter_devices")
                new_conn.commit()
                print("已清空 meter_devices 表")
            else:
                print("跳过迁移")
                return

        # 3. 插入数据到新数据库
        print("正在插入数据到新数据库...")
        insert_sql = """
            INSERT INTO meter_devices (device_id, collector_id, address, description, rate, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """

        success_count = 0
        error_count = 0

        for meter in meters:
            meter_id, meter_no, meter_name, collector_id, transformer_ratio, created_at = meter

            # 准备数据
            device_id = meter_no  # meter_no 作为 device_id
            address = meter_no    # meter_no 也作为 address
            description = meter_name
            rate = float(transformer_ratio) if transformer_ratio else 1.0
            updated_at = datetime.now()

            try:
                new_cur.execute(insert_sql, (
                    device_id,
                    collector_id,
                    address,
                    description,
                    rate,
                    created_at,
                    updated_at
                ))
                success_count += 1
            except Exception as e:
                print(f"插入失败 (meter_id={meter_id}, meter_no={meter_no}): {e}")
                error_count += 1

        # 4. 提交事务
        new_conn.commit()
        print(f"\n迁移完成！")
        print(f"  成功: {success_count} 条")
        print(f"  失败: {error_count} 条")

        # 5. 验证迁移结果
        new_cur.execute("SELECT COUNT(*) FROM meter_devices")
        final_count = new_cur.fetchone()[0]
        print(f"  新数据库 meter_devices 表当前数据量: {final_count} 条")

    except Exception as e:
        print(f"迁移过程中发生错误: {e}")
        new_conn.rollback()
        raise
    finally:
        old_cur.close()
        old_conn.close()
        new_cur.close()
        new_conn.close()

if __name__ == "__main__":
    print("=" * 60)
    print("数据迁移：meters → meter_devices")
    print("=" * 60)
    migrate_meters()
