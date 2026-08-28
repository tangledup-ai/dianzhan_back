"""系统配置：AI / 地图等第三方 key

- 管理后台「系统设置」页可读写（/api/* 自动受 AdminAuthMiddleware 保护）；
- 未在管理后台填写时，回落到 config.py 里的默认值；
- 供 AI 对话（deepseek_api_key）与地图组件（map_key）读取。
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from ..config import DEFAULT_DEEPSEEK_API_KEY, DEFAULT_MAP_KEY
from ..infra.database import get_connection, get_dict_cursor
from ..middleware.mp_auth import get_current_user
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/system-config", tags=["系统配置"], default_response_class=CamelJSONResponse)

# 小程序端配置（登录用户可读；供小程序拉取 key，拉取失败时小程序用本地默认值）
mp_router = APIRouter(tags=["📱 小程序 - 系统配置"])

_table_ready = False


def ensure_table():
    """system_configs 表（幂等创建；重启/首次访问自动建）"""
    global _table_ready
    if _table_ready:
        return
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS system_configs (
                config_key VARCHAR(64) PRIMARY KEY,
                config_value TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        conn.commit()
        _table_ready = True
    finally:
        cur.close()
        conn.close()


def get_config_value(key: str, default: str = "") -> str:
    """读单个配置值；表不存在/无记录/值为空 时返回默认值（后台未填写即用默认）"""
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT config_value FROM system_configs WHERE config_key = %s", (key,))
        row = cur.fetchone()
        if not row:
            return default
        return (row["config_value"] or "").strip() or default
    except Exception:
        return default
    finally:
        cur.close()
        conn.close()


@router.get("")
async def read_system_config():
    """读取系统配置（管理后台设置页 / 地图组件加载 key）"""
    ensure_table()
    return {
        "deepseekApiKey": get_config_value("deepseek_api_key", DEFAULT_DEEPSEEK_API_KEY),
        "mapKey": get_config_value("map_key", DEFAULT_MAP_KEY),
    }


class SystemConfigPayload(BaseModel):
    deepseekApiKey: str | None = None
    mapKey: str | None = None


@router.put("")
async def update_system_config(data: SystemConfigPayload):
    """保存系统配置（传 None 的项不修改，传空字符串表示清空、回落默认值）"""
    ensure_table()
    conn = get_connection()
    cur = conn.cursor()
    try:
        for key, value in (
            ("deepseek_api_key", data.deepseekApiKey),
            ("map_key", data.mapKey),
        ):
            if value is None:
                continue
            cur.execute("""
                INSERT INTO system_configs (config_key, config_value, updated_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (config_key)
                DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
            """, (key, value.strip()))
        conn.commit()
        return {"ok": True}
    finally:
        cur.close()
        conn.close()


@mp_router.get("/config")
async def read_mp_config(user: dict = Depends(get_current_user)):
    """小程序端读取配置（mapKey 供地图/位置服务使用；deepseekApiKey 备用）"""
    ensure_table()
    return {
        "mapKey": get_config_value("map_key", DEFAULT_MAP_KEY),
        "deepseekApiKey": get_config_value("deepseek_api_key", DEFAULT_DEEPSEEK_API_KEY),
    }
