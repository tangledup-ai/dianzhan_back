"""小程序 JWT 认证中间件"""

import jwt
from datetime import datetime, timedelta
from fastapi import HTTPException, Header
from ..config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_DAYS
from ..infra.database import get_connection, get_dict_cursor


def create_token(user_id: int, name: str, role: str) -> str:
    """生成 JWT token（PyJWT>=2.10 要求 sub 为字符串）"""
    payload = {
        "sub": str(user_id),
        "name": name,
        "role": role,
        "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> dict:
    """验证 JWT token，返回 payload"""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "token 已过期")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "token 无效")


def get_current_user(authorization: str = Header(None)) -> dict:
    """FastAPI 依赖：从 Authorization header 解析当前用户"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "未登录")
    token = authorization[7:]
    payload = verify_token(token)

    # 从数据库查最新用户信息（含角色、股东、关联场地）
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT pu.*, s.name as shareholder_name
            FROM platform_users pu
            LEFT JOIN shareholders s ON pu.shareholder_id = s.id
            WHERE pu.id = %s
        """, (payload["sub"],))
        user = cur.fetchone()
        if not user:
            raise HTTPException(401, "用户不存在")
        return dict(user)
    finally:
        cur.close()
        conn.close()
