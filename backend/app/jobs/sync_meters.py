"""天雀电表数据同步（支持多账户：遍历 third_party_configs，每个账户用各自的 URL/auth）"""
import json
import logging
from datetime import datetime, timedelta
from ..infra.database import get_connection, get_dict_cursor
from ..infra.meter_api import tq_client, TQMeterClient

logger = logging.getLogger(__name__)


def get_account_configs():
    """读取所有第三方接口配置账户；为空时回退全局默认（旧行为）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT id, name, base_url, auth_code, meter_tag FROM third_party_configs ORDER BY id")
        rows = cur.fetchall()
        if rows:
            return rows
        # 回退：无配置时用 config.py 默认（单账户旧行为），config_id 记 None
        return [{"id": None, "name": "默认", "base_url": tq_client.base_url, "auth_code": tq_client.auth_code, "meter_tag": "合作商电表"}]
    finally:
        cur.close()
        conn.close()


def log_sync(sync_type: str, status: str, records: int = 0, error: str = None):
    """记录同步日志"""
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO sync_logs (sync_type, status, records_synced, error_message, started_at, completed_at)
            VALUES (%s, %s, %s, %s, NOW(), NOW())
        """, (sync_type, status, records, error))
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"记录同步日志失败: {e}")


def parse_kwh_data(item: dict) -> dict:
    """解析能耗数据，处理多费率格式

    返回: {total, sharp, peak, flat, valley, deep_valley, rate, start_reading, end_reading}
    """
    d = item.get("d", [])
    s = item.get("s", [])
    e = item.get("e", [])
    r = item.get("r", 1) or 1

    return {
        "total": d[0] if len(d) > 0 else 0,
        "sharp": d[1] if len(d) > 1 else 0,
        "peak": d[2] if len(d) > 2 else 0,
        "flat": d[3] if len(d) > 3 else 0,
        "valley": d[4] if len(d) > 4 else 0,
        "deep_valley": d[5] if len(d) > 5 else 0,
        "rate": r,
        "start_reading": s[0] if len(s) > 0 else 0,
        "end_reading": e[0] if len(e) > 0 else 0,
        "start_time": item.get("st", ""),
        "end_time": item.get("et", ""),
        "meter_type": len(d),
    }


# ─── 设备同步 ─────────────────────────────────────────────

async def sync_devices():
    """同步设备列表（遍历所有配置账户）"""
    logger.info("🔄 开始同步设备列表...")
    configs = get_account_configs()
    total = 0
    for cfg in configs:
        client = TQMeterClient(base_url=cfg["base_url"], auth_code=cfg["auth_code"])
        try:
            devices = await client.get_devices()
        except Exception as e:
            logger.error(f"❌ 账户[{cfg.get('name')}] 设备列表拉取失败: {e}")
            log_sync("devices", "failed", error=str(e))
            continue

        conn = get_connection()
        cur = conn.cursor()
        synced = 0
        try:
            for d in devices:
                address = d.get("address", "")
                if not address:
                    continue
                cur.execute("""
                    INSERT INTO meter_devices (device_id, collector_id, address, description, rate, config_id, synced_at)
                    VALUES (%s, %s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (address)
                    DO UPDATE SET device_id = EXCLUDED.device_id, collector_id = EXCLUDED.collector_id,
                                  description = EXCLUDED.description, rate = EXCLUDED.rate,
                                  config_id = EXCLUDED.config_id, synced_at = NOW()
                """, (
                    d.get("id"), d.get("collectorid"),
                    address, d.get("description"), d.get("rate"),
                    cfg["id"]
                ))
                synced += 1
            conn.commit()
            logger.info(f"✅ 账户[{cfg.get('name')}] 设备列表同步完成: {synced} 条")
            total += synced
        finally:
            cur.close()
            conn.close()
    log_sync("devices", "success", total)
    return total


async def sync_collectors():
    """同步采集器列表（遍历所有配置账户）"""
    logger.info("🔄 开始同步采集器列表...")
    configs = get_account_configs()
    total = 0
    for cfg in configs:
        client = TQMeterClient(base_url=cfg["base_url"], auth_code=cfg["auth_code"])
        try:
            collectors = await client.get_collectors()
        except Exception as e:
            logger.error(f"❌ 账户[{cfg.get('name')}] 采集器拉取失败: {e}")
            log_sync("collectors", "failed", error=str(e))
            continue

        conn = get_connection()
        cur = conn.cursor()
        synced = 0
        try:
            for item in collectors:
                collector_id = item.get("id")
                if not collector_id:
                    continue
                cur.execute("""
                    INSERT INTO meter_collectors (id, collector_id, description, device_count, raw_data, synced_at)
                    VALUES (%s, %s, %s, %s, %s::jsonb, NOW())
                    ON CONFLICT (id) DO UPDATE SET
                        collector_id = EXCLUDED.collector_id,
                        description = EXCLUDED.description,
                        device_count = EXCLUDED.device_count,
                        raw_data = EXCLUDED.raw_data,
                        synced_at = NOW()
                """, (
                    str(collector_id),
                    item.get("collectorid"),
                    item.get("description"),
                    item.get("count", 0),
                    json.dumps(item, ensure_ascii=False),
                ))
                synced += 1
            conn.commit()
            logger.info(f"✅ 账户[{cfg.get('name')}] 采集器同步完成: {synced} 条")
            total += synced
        finally:
            cur.close()
            conn.close()
    log_sync("collectors", "success", total)
    return total


# ─── 实时状态同步 ──────────────────────────────────────────

async def sync_status():
    """同步实时状态（遍历所有配置账户，每2小时）"""
    logger.info("🔄 开始同步实时状态...")
    configs = get_account_configs()
    total = 0
    for cfg in configs:
        client = TQMeterClient(base_url=cfg["base_url"], auth_code=cfg["auth_code"])
        try:
            meters = await client.get_status()
        except Exception as e:
            logger.error(f"❌ 账户[{cfg.get('name')}] 实时状态拉取失败: {e}")
            log_sync("status", "failed", error=str(e))
            continue

        conn = get_connection()
        cur = conn.cursor()
        synced = 0
        try:
            for m in meters:
                cur.execute("""
                    INSERT INTO meter_status_cache (device_id, address, c0, c1, c2, c3, c4, remain_money, synced_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (device_id) DO UPDATE SET
                        address = EXCLUDED.address,
                        c0 = EXCLUDED.c0,
                        c1 = EXCLUDED.c1,
                        c2 = EXCLUDED.c2,
                        c3 = EXCLUDED.c3,
                        c4 = EXCLUDED.c4,
                        remain_money = EXCLUDED.remain_money,
                        synced_at = NOW()
                """, (
                    m.get("id"), m.get("address", ""),
                    m.get("c0"), m.get("c1"), m.get("c2"), m.get("c3"), m.get("c4"),
                    m.get("remain_money")
                ))
                synced += 1
            conn.commit()
            logger.info(f"✅ 账户[{cfg.get('name')}] 实时状态同步完成: {synced} 条")
            total += synced
        finally:
            cur.close()
            conn.close()
    log_sync("status", "success", total)
    return total


# ─── 能耗数据同步 ──────────────────────────────────────────

async def sync_hourly_data():
    """同步最近24小时用电量（遍历所有配置账户，每2小时）"""
    logger.info("🔄 开始同步小时用电量...")
    now = datetime.now()
    start = (now - timedelta(hours=24)).strftime("%Y%m%d%H")
    end = now.strftime("%Y%m%d%H")

    configs = get_account_configs()
    total = 0
    for cfg in configs:
        client = TQMeterClient(base_url=cfg["base_url"], auth_code=cfg["auth_code"])
        try:
            data = await client.get_electricity_by_hour(start, end)
            if isinstance(data, dict) and data.get("status") not in (1, None):
                raise ValueError(data.get("msg") or f"小时用电量返回异常状态 {data.get('status')}")
        except Exception as e:
            logger.error(f"❌ 账户[{cfg.get('name')}] 小时用电量拉取失败: {e}")
            log_sync("hourly", "failed", error=str(e))
            continue

        if not data or not data.get("data"):
            logger.info(f"账户[{cfg.get('name')}] 小时用电量无数据")
            continue

        conn = get_connection()
        cur = conn.cursor()
        synced = 0
        try:
            # 预加载该账户的设备ID到电表号的映射
            if cfg["id"]:
                cur.execute("SELECT device_id, address FROM meter_devices WHERE config_id = %s", (cfg["id"],))
            else:
                cur.execute("SELECT device_id, address FROM meter_devices WHERE config_id IS NULL")
            device_map = {str(row[0]): row[1] for row in cur.fetchall()}

            for period_key, items in data["data"].items():
                if not isinstance(items, list):
                    continue
                for item in items:
                    device_id = str(item.get("mid", item.get("id", "")))
                    if not device_id:
                        continue
                    address = item.get("address") or device_map.get(device_id, "")
                    if not address:
                        continue
                    parsed = parse_kwh_data(item)
                    cur.execute("""
                        INSERT INTO meter_hourly (device_id, address, hour_time, kwh, raw_data, synced_at)
                        VALUES (%s, %s, %s, %s, %s::jsonb, NOW())
                        ON CONFLICT (address, hour_time) DO UPDATE SET
                            device_id = EXCLUDED.device_id,
                            kwh = EXCLUDED.kwh,
                            raw_data = EXCLUDED.raw_data,
                            synced_at = NOW()
                    """, (
                        device_id, address, period_key,
                        parsed["total"],
                        json.dumps(item, ensure_ascii=False),
                    ))
                    synced += 1
            conn.commit()
            logger.info(f"✅ 账户[{cfg.get('name')}] 小时用电量同步完成: {synced} 条")
            total += synced
        finally:
            cur.close()
            conn.close()
    log_sync("hourly", "success", total)
    return total


async def sync_daily_data():
    """同步最近31天用电量（遍历所有配置账户，每天）"""
    logger.info("🔄 开始同步日用电量...")
    now = datetime.now()
    start = (now - timedelta(days=31)).strftime("%Y%m%d")
    end = now.strftime("%Y%m%d")

    configs = get_account_configs()
    total = 0
    for cfg in configs:
        client = TQMeterClient(base_url=cfg["base_url"], auth_code=cfg["auth_code"])
        try:
            data = await client.get_electricity_by_day(start, end)
            if isinstance(data, dict) and data.get("status") not in (1, None):
                raise ValueError(data.get("msg") or f"日用电量返回异常状态 {data.get('status')}")
        except Exception as e:
            logger.error(f"❌ 账户[{cfg.get('name')}] 日用电量拉取失败: {e}")
            log_sync("daily", "failed", error=str(e))
            continue

        if not data or not data.get("data"):
            logger.info(f"账户[{cfg.get('name')}] 日用电量无数据")
            continue

        conn = get_connection()
        cur = conn.cursor()
        synced = 0
        try:
            if cfg["id"]:
                cur.execute("SELECT device_id, address FROM meter_devices WHERE config_id = %s", (cfg["id"],))
            else:
                cur.execute("SELECT device_id, address FROM meter_devices WHERE config_id IS NULL")
            device_map = {str(row[0]): row[1] for row in cur.fetchall()}

            for period_key, items in data["data"].items():
                if not isinstance(items, list):
                    continue
                for item in items:
                    device_id = str(item.get("mid", item.get("id", "")))
                    if not device_id:
                        continue
                    address = item.get("address") or device_map.get(device_id, "")
                    if not address:
                        continue
                    parsed = parse_kwh_data(item)
                    # day_date 直接存 8 位字符串 YYYYMMDD（废弃早期 date 列）
                    cur.execute("""
                        INSERT INTO meter_daily (device_id, address, day_date, kwh, raw_data, synced_at)
                        VALUES (%s, %s, %s, %s, %s::jsonb, NOW())
                        ON CONFLICT (address, day_date) DO UPDATE SET
                            device_id = EXCLUDED.device_id,
                            kwh = EXCLUDED.kwh,
                            raw_data = EXCLUDED.raw_data,
                            synced_at = NOW()
                    """, (
                        device_id, address, period_key,
                        parsed["total"],
                        json.dumps(item, ensure_ascii=False),
                    ))
                    synced += 1
            conn.commit()
            logger.info(f"✅ 账户[{cfg.get('name')}] 日用电量同步完成: {synced} 条")
            total += synced
        finally:
            cur.close()
            conn.close()
    log_sync("daily", "success", total)
    return total


async def sync_monthly_data():
    """同步最近12个月用电量（遍历所有配置账户，每天）"""
    logger.info("🔄 开始同步月用电量...")
    now = datetime.now()
    start = (now - timedelta(days=365)).strftime("%Y%m")
    end = now.strftime("%Y%m")

    def parse_reading_fields(item):
        """从 raw_data 中解析起始/抄表度数和时间"""
        prev_reading = None
        prev_reading_date = None
        curr_reading = None
        curr_reading_date = None
        # s: 起始度数, e: 抄表度数, st: 起始时间, et: 抄表时间
        s = item.get("s")
        if isinstance(s, list) and len(s) > 0:
            prev_reading = s[0]
        e = item.get("e")
        if isinstance(e, list) and len(e) > 0:
            curr_reading = e[0]
        st = item.get("st")
        if st:
            prev_reading_date = st.replace("/", "-").split(" ")[0]
        et = item.get("et")
        if et:
            curr_reading_date = et.replace("/", "-").split(" ")[0]
        return prev_reading, prev_reading_date, curr_reading, curr_reading_date

    configs = get_account_configs()
    total = 0
    for cfg in configs:
        client = TQMeterClient(base_url=cfg["base_url"], auth_code=cfg["auth_code"])
        try:
            data = await client.get_electricity_by_month(start, end)
            if isinstance(data, dict) and data.get("status") not in (1, None):
                raise ValueError(data.get("msg") or f"月用电量返回异常状态 {data.get('status')}")
        except Exception as e:
            logger.error(f"❌ 账户[{cfg.get('name')}] 月用电量拉取失败: {e}")
            log_sync("monthly", "failed", error=str(e))
            continue

        if not data:
            logger.info(f"账户[{cfg.get('name')}] 月用电量无数据")
            continue

        conn = get_connection()
        cur = conn.cursor()
        synced = 0
        try:
            if cfg["id"]:
                cur.execute("SELECT device_id, address FROM meter_devices WHERE config_id = %s", (cfg["id"],))
            else:
                cur.execute("SELECT device_id, address FROM meter_devices WHERE config_id IS NULL")
            device_map = {str(row[0]): row[1] for row in cur.fetchall()}

            # 兼容两种返回格式
            if isinstance(data, dict) and "data" in data:
                for period_key, items in data["data"].items():
                    if not isinstance(items, list):
                        continue
                    for item in items:
                        device_id = str(item.get("mid", item.get("id", "")))
                        if not device_id:
                            continue
                        address = item.get("address") or device_map.get(device_id, "")
                        if not address:
                            continue
                        parsed = parse_kwh_data(item)
                        prev_reading, prev_reading_date, curr_reading, curr_reading_date = parse_reading_fields(item)
                        month_period = period_key.replace("-", "")  # 统一 6 位 YYYYMM
                        cur.execute("""
                            INSERT INTO meter_monthly (device_id, address, month_period, kwh, raw_data, synced_at,
                                prev_reading, prev_reading_date, curr_reading, curr_reading_date)
                            VALUES (%s, %s, %s, %s, %s::jsonb, NOW(), %s, %s, %s, %s)
                            ON CONFLICT (address, month_period) DO UPDATE SET
                                device_id = EXCLUDED.device_id,
                                kwh = EXCLUDED.kwh, raw_data = EXCLUDED.raw_data, synced_at = NOW(),
                                prev_reading = EXCLUDED.prev_reading, prev_reading_date = EXCLUDED.prev_reading_date,
                                curr_reading = EXCLUDED.curr_reading, curr_reading_date = EXCLUDED.curr_reading_date
                        """, (device_id, address, month_period,
                              parsed["total"], json.dumps(item, ensure_ascii=False),
                              prev_reading, prev_reading_date, curr_reading, curr_reading_date))
                        synced += 1
            elif isinstance(data, list):
                for p in data:
                    month_period = p.get("period", "").replace("-", "")
                    for m in p.get("meters", []):
                        address = m.get("meterNo", "")
                        if not address:
                            continue
                        prev_reading, prev_reading_date, curr_reading, curr_reading_date = parse_reading_fields(m)
                        # 从 address 查找 device_id
                        cur.execute("SELECT device_id FROM meter_devices WHERE address = %s LIMIT 1", (address,))
                        dev_row = cur.fetchone()
                        dev_id = dev_row[0] if dev_row else address
                        cur.execute("""
                            INSERT INTO meter_monthly (device_id, address, month_period, kwh, raw_data, synced_at,
                                prev_reading, prev_reading_date, curr_reading, curr_reading_date)
                            VALUES (%s, %s, %s, %s, %s::jsonb, NOW(), %s, %s, %s, %s)
                            ON CONFLICT (address, month_period) DO UPDATE SET
                                device_id = EXCLUDED.device_id,
                                kwh = EXCLUDED.kwh, raw_data = EXCLUDED.raw_data, synced_at = NOW(),
                                prev_reading = EXCLUDED.prev_reading, prev_reading_date = EXCLUDED.prev_reading_date,
                                curr_reading = EXCLUDED.curr_reading, curr_reading_date = EXCLUDED.curr_reading_date
                        """, (dev_id, address, month_period,
                              m.get("kwh"), json.dumps(m, ensure_ascii=False),
                              prev_reading, prev_reading_date, curr_reading, curr_reading_date))
                        synced += 1

            conn.commit()
            logger.info(f"✅ 账户[{cfg.get('name')}] 月用电量同步完成: {synced} 条")
            total += synced
        finally:
            cur.close()
            conn.close()
    log_sync("monthly", "success", total)
    # 动态生成：月度读数同步完成后，自动生成/更新台账（无需手动点「自动生成」）
    if total > 0:
        try:
            from ..api.electricity import generate_all_ledger
            await generate_all_ledger()
        except Exception:
            pass
    return total


async def sync_yearly_data():
    """同步最近12年用电量（遍历所有配置账户）"""
    logger.info("🔄 开始同步年用电量...")
    now = datetime.now()
    start = str(now.year - 12)
    end = str(now.year)

    configs = get_account_configs()
    total = 0
    for cfg in configs:
        client = TQMeterClient(base_url=cfg["base_url"], auth_code=cfg["auth_code"])
        try:
            data = await client.get_electricity_by_year(start, end)
            if isinstance(data, dict) and data.get("status") not in (1, None):
                raise ValueError(data.get("msg") or f"年用电量返回异常状态 {data.get('status')}")
        except Exception as e:
            logger.error(f"❌ 账户[{cfg.get('name')}] 年用电量拉取失败: {e}")
            log_sync("yearly", "failed", error=str(e))
            continue

        if not data or not data.get("data"):
            logger.info(f"账户[{cfg.get('name')}] 年用电量无数据")
            continue

        conn = get_connection()
        cur = conn.cursor()
        synced = 0
        try:
            if cfg["id"]:
                cur.execute("SELECT device_id, address FROM meter_devices WHERE config_id = %s", (cfg["id"],))
            else:
                cur.execute("SELECT device_id, address FROM meter_devices WHERE config_id IS NULL")
            device_map = {str(row[0]): row[1] for row in cur.fetchall()}

            for period_key, items in data["data"].items():
                if not isinstance(items, list):
                    continue
                for item in items:
                    device_id = str(item.get("mid", item.get("id", "")))
                    if not device_id:
                        continue
                    address = item.get("address") or device_map.get(device_id, "")
                    if not address:
                        continue
                    parsed = parse_kwh_data(item)
                    cur.execute("""
                        INSERT INTO meter_yearly (device_id, address, year_period, kwh, raw_data, synced_at)
                        VALUES (%s, %s, %s, %s, %s::jsonb, NOW())
                        ON CONFLICT (address, year_period) DO UPDATE SET
                            device_id = EXCLUDED.device_id,
                            kwh = EXCLUDED.kwh,
                            raw_data = EXCLUDED.raw_data,
                            synced_at = NOW()
                    """, (
                        device_id, address, period_key,
                        parsed["total"],
                        json.dumps(item, ensure_ascii=False),
                    ))
                    synced += 1
            conn.commit()
            logger.info(f"✅ 账户[{cfg.get('name')}] 年用电量同步完成: {synced} 条")
            total += synced
        finally:
            cur.close()
            conn.close()
    log_sync("yearly", "success", total)
    return total


# ─── 报警同步 ─────────────────────────────────────────────

async def sync_warnings():
    """同步报警信息（遍历所有配置账户，每2小时）"""
    logger.info("🔄 开始同步报警信息...")
    configs = get_account_configs()
    total = 0
    # 各账户报警合并写入，先清空一次
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM meter_warnings_cache")
        conn.commit()
    finally:
        cur.close()
        conn.close()

    for cfg in configs:
        client = TQMeterClient(base_url=cfg["base_url"], auth_code=cfg["auth_code"])
        try:
            warnings = await client.get_warnings()
        except Exception as e:
            logger.error(f"❌ 账户[{cfg.get('name')}] 报警信息拉取失败: {e}")
            log_sync("warnings", "failed", error=str(e))
            continue

        conn = get_connection()
        cur = conn.cursor()
        synced = 0
        try:
            for w in warnings:
                cur.execute("""
                    INSERT INTO meter_warnings_cache (device_type, device_id, device_address, warning_def_id, start_time, msg, synced_at)
                    VALUES (%s, %s, %s, %s, %s, %s, NOW())
                """, (
                    w.get("device_type"), w.get("device_id"),
                    w.get("device_address"), w.get("warning_def_id"),
                    w.get("start_time"), w.get("msg")
                ))
                synced += 1
            conn.commit()
            logger.info(f"✅ 账户[{cfg.get('name')}] 报警信息同步完成: {synced} 条")
            total += synced
        finally:
            cur.close()
            conn.close()
    log_sync("warnings", "success", total)
    return total


# ─── 组合同步 ─────────────────────────────────────────────

async def sync_all_static():
    """同步所有静态数据"""
    results = {}
    results["devices"] = await sync_devices()
    results["collectors"] = await sync_collectors()
    return results


async def sync_all_energy():
    """同步所有能耗数据"""
    results = {}
    results["hourly"] = await sync_hourly_data()
    results["daily"] = await sync_daily_data()
    results["monthly"] = await sync_monthly_data()
    results["yearly"] = await sync_yearly_data()
    return results


async def full_sync():
    """全量同步"""
    logger.info("开始全量同步...")
    results = {}
    results["static"] = await sync_all_static()
    results["status"] = await sync_status()
    results["energy"] = await sync_all_energy()
    results["warnings"] = await sync_warnings()
    logger.info(f"全量同步完成: {results}")
    return results
