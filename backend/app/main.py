import os
import asyncio
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from .config import PORT
from .infra.database import init_database
from .api import directory, stations, meters, cabinets, electricity, rent, dividends, approvals, contracts, overview, meter_energy, alerts, contract_schedules, auth
from .api import mp_auth, mp_snapshot, mp_approvals, mp_finance
from .jobs.scheduler import start_scheduler, stop_scheduler, get_scheduler_status
from .jobs.sync_meters import full_sync


class AdminAuthMiddleware(BaseHTTPMiddleware):
    """管理后台 API 鉴权：/api/* 除 /api/auth/* 与健康检查外，必须携带 Bearer token。

    - 未登录/无效 token → 401；
    - 校验通过后把当前用户挂到 request.state.current_user（供股东数据隔离读取）。
    """

    async def dispatch(self, request, call_next):
        path = request.url.path
        if path.startswith("/api/auth") or path in ("/api/health", "/api/scheduler/status"):
            return await call_next(request)
        if path.startswith("/api/"):
            auth_header = request.headers.get("authorization", "")
            if not auth_header.startswith("Bearer "):
                return JSONResponse(status_code=401, content={"detail": "未登录"})
            try:
                from .middleware.mp_auth import verify_token
                from .infra.database import get_connection, get_dict_cursor
                payload = verify_token(auth_header[7:])
                conn = get_connection()
                cur = get_dict_cursor(conn)
                try:
                    cur.execute("SELECT * FROM platform_users WHERE id = %s", (payload["sub"],))
                    user = cur.fetchone()
                finally:
                    cur.close()
                    conn.close()
                if not user:
                    return JSONResponse(status_code=401, content={"detail": "用户不存在"})
                # 股东账号只读：禁止一切写操作（新增/修改/删除）
                if user.get("role") == "shareholder" and request.method not in ("GET", "HEAD", "OPTIONS"):
                    return JSONResponse(status_code=403, content={"detail": "股东账号仅可查看，不能修改数据"})
                request.state.current_user = dict(user)
            except HTTPException as e:
                return JSONResponse(status_code=e.status_code, content={"detail": e.detail})
            except Exception:
                return JSONResponse(status_code=401, content={"detail": "token 无效"})
        return await call_next(request)


# ── 主应用（管理后台） ────────────────────────────────────────
app = FastAPI(
    title="换电站管理平台 API",
    description="换电站经营管理平台后端服务（管理后台）",
    version="2.0.0",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# 管理后台鉴权（放最后注册，最先执行）
app.add_middleware(AdminAuthMiddleware)

# 注册后台路由
app.include_router(directory.router)
app.include_router(stations.router)
app.include_router(meters.router)
app.include_router(cabinets.router)
app.include_router(electricity.router)
app.include_router(rent.router)
app.include_router(dividends.router)
app.include_router(approvals.router)
app.include_router(contracts.router)
app.include_router(overview.router)
app.include_router(meter_energy.router)
app.include_router(alerts.router)
app.include_router(contract_schedules.router)
app.include_router(auth.router)

# ── 小程序子应用 ──────────────────────────────────────────────
mp_app = FastAPI(
    title="换电站小程序 API",
    description="换电站小程序端接口",
    version="1.0.0",
)

mp_app.include_router(mp_auth.router)
mp_app.include_router(mp_snapshot.router)
mp_app.include_router(mp_approvals.router)
mp_app.include_router(mp_finance.router)

# 挂载到 /mp 路径，Swagger 文档地址: /mp/docs
app.mount("/mp", mp_app)


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


@app.get("/api/scheduler/status")
async def scheduler_status():
    return get_scheduler_status()


@app.post("/api/sync/trigger")
async def sync_trigger(data: dict):
    """手动触发同步

    type 可选值:
    - devices: 同步设备列表
    - collectors: 同步采集器
    - status: 同步实时状态
    - hourly: 同步小时用电量
    - daily: 同步日用电量
    - monthly: 同步月用电量
    - yearly: 同步年用电量
    - warnings: 同步报警信息
    - full: 全量同步
    """
    sync_type = data.get("type", "full")
    from .jobs.sync_meters import (
        sync_devices, sync_collectors, sync_status,
        sync_hourly_data, sync_daily_data, sync_monthly_data, sync_yearly_data,
        sync_warnings, full_sync,
    )

    sync_map = {
        "devices": sync_devices,
        "collectors": sync_collectors,
        "status": sync_status,
        "hourly": sync_hourly_data,
        "daily": sync_daily_data,
        "monthly": sync_monthly_data,
        "yearly": sync_yearly_data,
        "warnings": sync_warnings,
        "full": full_sync,
    }

    fn = sync_map.get(sync_type)
    if fn:
        result = await fn()
        return {"message": "同步成功", "type": sync_type, "result": result}
    else:
        await full_sync()
        return {"message": "全量同步成功", "type": "full"}


@app.get("/api/sync/monthly-kwh/status")
async def monthly_kwh_status():
    """查询月度用电量同步状态（本月调用次数）"""
    from .infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT COUNT(*) as cnt FROM meter_monthly
            WHERE synced_at >= date_trunc('month', CURRENT_DATE)
        """)
        row = cur.fetchone()
        calls_this_month = row["cnt"] if row else 0
        return {
            "callsThisMonth": calls_this_month,
            "limit": 10,
            "remaining": max(0, 10 - calls_this_month),
        }
    finally:
        cur.close()
        conn.close()


@app.get("/api/meter-monthly")
async def get_meter_monthly(address: str = None, month: str = None):
    """查询本地缓存的月度用电量（不调用第三方API）"""
    from .infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if address:
            conditions.append("address = %s")
            values.append(address)
        if month:
            conditions.append("month_period = %s")
            values.append(month)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT address, month_period, kwh, synced_at
            FROM meter_monthly
            {where}
            ORDER BY month_period DESC, address
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


@app.post("/api/meters/import-from-third-party")
async def import_meters_from_third_party():
    """从第三方平台导入电表到本地 meters 表"""
    from .infra.database import get_connection, get_dict_cursor
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 账户 → 电表类型 映射
        cur.execute("SELECT id, meter_tag FROM third_party_configs")
        tag_map = {r["id"]: r["meter_tag"] for r in cur.fetchall()}

        # 获取第三方平台的设备列表（未导入的；v3：新电表不自动建站点）
        cur.execute("""
            SELECT d.device_id, d.address, d.description, d.rate,
                   d.collector_id, d.config_id
            FROM meter_devices d
            WHERE d.address NOT IN (SELECT meter_no FROM meters WHERE meter_no IS NOT NULL)
        """)
        devices = cur.fetchall()

        imported = 0
        for d in devices:
            # 根据 description 判断品牌（简单规则）
            desc = d["description"] or ""
            brand_id = None
            if "台铃" in desc:
                cur.execute("SELECT id FROM brands WHERE name = '台铃'")
                row = cur.fetchone()
                brand_id = row["id"] if row else None
            elif "八维通" in desc:
                cur.execute("SELECT id FROM brands WHERE name = '八维通'")
                row = cur.fetchone()
                brand_id = row["id"] if row else None
            elif "美团" in desc:
                cur.execute("SELECT id FROM brands WHERE name = '美团'")
                row = cur.fetchone()
                brand_id = row["id"] if row else None
            elif "哈啰" in desc:
                cur.execute("SELECT id FROM brands WHERE name = '哈啰'")
                row = cur.fetchone()
                brand_id = row["id"] if row else None

            # 电表类型：按设备来源账户映射（默认合作商电表）
            meter_tag = tag_map.get(d.get("config_id")) or "合作商电表"

            # v3：新导入电表不挂站点，landlord/brand 后续在「智慧电表」人工指定

            # 插入 meters 表
            cur.execute("""
                INSERT INTO meters (brand_id, landlord_id, meter_no, meter_name, collector_id, transformer_ratio, tag, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, '正常')
            """, (brand_id, None, d["address"], desc, d["collector_id"], d["rate"], meter_tag))
            imported += 1

        conn.commit()
        return {"ok": True, "imported": imported, "total": len(devices)}
    finally:
        cur.close()
        conn.close()


@app.on_event("startup")
async def startup():
    print("🚀 启动换电站管理平台后端服务...")
    init_database()
    start_scheduler()

    # 首次同步
    asyncio.create_task(initial_sync())
    # 动态生成：启动后自动生成全部实表站点台账（无需手动点「自动生成」）
    asyncio.create_task(initial_generate())

    print(f"✅ 服务器已启动: http://localhost:{PORT}")


async def initial_sync():
    await asyncio.sleep(2)
    print("🔄 开始首次数据同步...")
    try:
        await full_sync()
        print("✅ 首次同步完成")
    except Exception as e:
        print(f"❌ 首次同步失败: {e}")


async def initial_generate():
    """启动后自动生成台账（等同步先跑，避免读旧读数）"""
    await asyncio.sleep(8)
    try:
        from .api.electricity import generate_all_ledger
        n = await generate_all_ledger()
        print(f"✅ 台账自动生成完成: {n} 次生成")
    except Exception as e:
        print(f"❌ 台账自动生成失败: {e}")


@app.on_event("shutdown")
async def shutdown():
    stop_scheduler()


# 静态文件
BASE_DIR = Path("/app") if Path("/app").exists() else Path(__file__).resolve().parent.parent.parent
DIST_DIR = BASE_DIR / "dist"
if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(DIST_DIR / "assets")), name="assets")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, reload=True)
