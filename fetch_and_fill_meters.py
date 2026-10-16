#!/usr/bin/env python3
"""
从第三方 API 获取电表数据并填充到新数据库

API 接口：
1. /Api/Meter - 获取设备列表（电表）
2. /Api/Collector - 获取采集器列表
3. /Api/EleMeterState - 获取实时状态

目标表：
1. meter_devices - 电表设备表
2. meter_collectors - 采集器表
3. meter_status_cache - 实时状态缓存表
"""

import asyncio
import httpx
import psycopg2
from datetime import datetime

# 第三方 API 配置
TQ_API_URL = "https://api1.tqdianbiao.com"
TQ_AUTH_CODE = "5ec0b6bf6f59984d97ec54f775a3c780"

# 新数据库连接配置
NEW_DB_CONFIG = {
    'host': 'localhost',
    'port': 5432,
    'user': 'quant',
    'password': 'CHANGE_ME_DB_PASSWORD',
    'dbname': 'dianzhan-test'
}

async def fetch_api(path: str) -> dict:
    """调用第三方 API"""
    url = f"{TQ_API_URL}{path}"
    params = {"auth": TQ_AUTH_CODE}

    async with httpx.AsyncClient(timeout=30, verify=False) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()

def extract_data(result, key="data"):
    """从响应中提取数据"""
    if isinstance(result, dict):
        if result.get("status") not in (1, None):
            raise ValueError(result.get("msg") or f"接口返回异常状态 {result.get('status')}")
        return result.get(key, [])
    if isinstance(result, list):
        return result
    return []

async def fetch_and_fill_meter_devices():
    """获取设备列表并填充到 meter_devices 表"""
    print("正在从第三方 API 获取设备列表...")

    # 调用 API
    result = await fetch_api("/Api/Meter")
    devices = extract_data(result)

    print(f"获取到 {len(devices)} 个设备")

    if not devices:
        print("无设备数据")
        return

    # 连接新数据库
    conn = psycopg2.connect(**NEW_DB_CONFIG)
    cur = conn.cursor()

    try:
        # 清空目标表
        cur.execute("DELETE FROM meter_devices")
        conn.commit()
        print("已清空 meter_devices 表")

        # 插入数据
        insert_sql = """
            INSERT INTO meter_devices (device_id, collector_id, address, description, rate, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """

        success_count = 0
        error_count = 0

        for device in devices:
            try:
                # 提取字段（根据 API 返回的实际字段名调整）
                device_id = device.get('MeterId') or device.get('device_id') or device.get('id')
                collector_id = device.get('CollectorId') or device.get('collector_id')
                address = device.get('Address') or device.get('address') or device.get('meter_no')
                description = device.get('Description') or device.get('description') or device.get('meter_name')
                rate = device.get('Rate') or device.get('rate') or device.get('transformer_ratio', 1)

                # 转换数值
                if rate:
                    rate = float(rate)
                else:
                    rate = 1.0

                now = datetime.now()

                cur.execute(insert_sql, (
                    str(device_id),
                    str(collector_id) if collector_id else None,
                    str(address) if address else None,
                    str(description) if description else None,
                    rate,
                    now,
                    now
                ))
                success_count += 1
            except Exception as e:
                print(f"插入设备失败: {e}, 数据: {device}")
                error_count += 1

        conn.commit()
        print(f"meter_devices 迁移完成: 成功 {success_count} 条, 失败 {error_count} 条")

    except Exception as e:
        print(f"迁移 meter_devices 时发生错误: {e}")
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()

async def fetch_and_fill_meter_collectors():
    """获取采集器列表并填充到 meter_collectors 表"""
    print("\n正在从第三方 API 获取采集器列表...")

    # 调用 API
    result = await fetch_api("/Api/Collector")
    collectors = extract_data(result)

    print(f"获取到 {len(collectors)} 个采集器")

    if not collectors:
        print("无采集器数据")
        return

    # 连接新数据库
    conn = psycopg2.connect(**NEW_DB_CONFIG)
    cur = conn.cursor()

    try:
        # 清空目标表
        cur.execute("DELETE FROM meter_collectors")
        conn.commit()
        print("已清空 meter_collectors 表")

        # 插入数据
        insert_sql = """
            INSERT INTO meter_collectors (collector_id, csq, imei, iccid, online, description, connect_time, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """

        success_count = 0
        error_count = 0

        for collector in collectors:
            try:
                # 提取字段（根据 API 返回的实际字段名调整）
                collector_id = collector.get('CollectorId') or collector.get('collector_id') or collector.get('id')
                csq = collector.get('Csq') or collector.get('csq')
                imei = collector.get('Imei') or collector.get('imei')
                iccid = collector.get('Iccid') or collector.get('iccid')
                online = collector.get('Online') or collector.get('online', False)
                description = collector.get('Description') or collector.get('description')
                connect_time = collector.get('ConnectTime') or collector.get('connect_time')

                # 转换布尔值
                if isinstance(online, str):
                    online = online.lower() in ('true', '1', 'yes')
                else:
                    online = bool(online) if online else False

                # 转换时间
                if connect_time:
                    try:
                        if isinstance(connect_time, str):
                            connect_time = datetime.strptime(connect_time, '%Y-%m-%d %H:%M:%S')
                    except:
                        connect_time = None

                now = datetime.now()

                cur.execute(insert_sql, (
                    str(collector_id),
                    str(csq) if csq else None,
                    str(imei) if imei else None,
                    str(iccid) if iccid else None,
                    online,
                    str(description) if description else None,
                    connect_time,
                    now,
                    now
                ))
                success_count += 1
            except Exception as e:
                print(f"插入采集器失败: {e}, 数据: {collector}")
                error_count += 1

        conn.commit()
        print(f"meter_collectors 迁移完成: 成功 {success_count} 条, 失败 {error_count} 条")

    except Exception as e:
        print(f"迁移 meter_collectors 时发生错误: {e}")
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()

async def fetch_and_fill_meter_status_cache():
    """获取实时状态并填充到 meter_status_cache 表"""
    print("\n正在从第三方 API 获取实时状态...")

    # 调用 API
    result = await fetch_api("/Api/EleMeterState")
    statuses = extract_data(result)

    print(f"获取到 {len(statuses)} 条状态记录")

    if not statuses:
        print("无状态数据")
        return

    # 连接新数据库
    conn = psycopg2.connect(**NEW_DB_CONFIG)
    cur = conn.cursor()

    try:
        # 清空目标表
        cur.execute("DELETE FROM meter_status_cache")
        conn.commit()
        print("已清空 meter_status_cache 表")

        # 插入数据
        insert_sql = """
            INSERT INTO meter_status_cache (device_id, address, c0, c1, c2, c3, c4, remain_money, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """

        success_count = 0
        error_count = 0

        for status in statuses:
            try:
                # 提取字段（根据 API 返回的实际字段名调整）
                # 从错误信息看，API 返回的字段名是 'id' 和 'address'
                device_id = status.get('id') or status.get('DeviceId') or status.get('device_id') or status.get('MeterId')
                address = status.get('address') or status.get('Address') or status.get('meter_no')
                c0 = status.get('C0') or status.get('c0') or status.get('total_kwh')
                c1 = status.get('C1') or status.get('c1') or status.get('peak_kwh')
                c2 = status.get('C2') or status.get('c2') or status.get('sharp_kwh')
                c3 = status.get('C3') or status.get('c3') or status.get('flat_kwh')
                c4 = status.get('C4') or status.get('c4') or status.get('valley_kwh')
                remain_money = status.get('RemainMoney') or status.get('remain_money') or status.get('remaining_amount')

                # 转换数值
                def to_float(val):
                    if val is None:
                        return None
                    try:
                        return float(val)
                    except:
                        return None

                c0 = to_float(c0)
                c1 = to_float(c1)
                c2 = to_float(c2)
                c3 = to_float(c3)
                c4 = to_float(c4)
                remain_money = to_float(remain_money)

                now = datetime.now()

                cur.execute(insert_sql, (
                    str(device_id),
                    str(address) if address else None,
                    c0,
                    c1,
                    c2,
                    c3,
                    c4,
                    remain_money,
                    now
                ))
                success_count += 1
            except Exception as e:
                print(f"插入状态失败: {e}, 数据: {status}")
                error_count += 1

        conn.commit()
        print(f"meter_status_cache 迁移完成: 成功 {success_count} 条, 失败 {error_count} 条")

    except Exception as e:
        print(f"迁移 meter_status_cache 时发生错误: {e}")
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()

async def main():
    print("=" * 60)
    print("从第三方 API 获取电表数据并填充到新数据库")
    print("=" * 60)

    try:
        # 1. 获取并填充设备列表
        await fetch_and_fill_meter_devices()

        # 2. 获取并填充采集器列表
        await fetch_and_fill_meter_collectors()

        # 3. 获取并填充实时状态
        await fetch_and_fill_meter_status_cache()

        print("\n" + "=" * 60)
        print("所有数据获取和填充完成！")
        print("=" * 60)

    except Exception as e:
        print(f"\n发生错误: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
