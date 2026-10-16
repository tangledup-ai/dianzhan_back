"""小程序认证接口"""

from fastapi import APIRouter, HTTPException, Depends
from ..middleware.mp_auth import create_token, get_current_user
from ..infra.database import get_connection, get_dict_cursor
from ..infra.password import verify_password

router = APIRouter(prefix="/auth", tags=["📱 小程序 - 认证"])


@router.post("/login")
async def login(data: dict):
    """小程序用户登录，复用管理后台账号密码。"""
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username or not password:
        raise HTTPException(400, "用户名和密码不能为空")

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "SELECT id, name, role, phone, password FROM platform_users WHERE name = %s",
            (username,)
        )
        user = cur.fetchone()
        if not user or not verify_password(password, user.get("password") or ""):
            raise HTTPException(401, "用户名或密码错误")

        token = create_token(user["id"], user["name"], user["role"])
        return {
            "code": 0,
            "data": {
                "username": user["name"],
                "nickname": user["name"],
                "token": token,
            }
        }
    finally:
        cur.close()
        conn.close()


@router.post("/logout")
async def logout():
    """退出登录（无状态 JWT，前端清 token 即可）"""
    return {"code": 0, "message": "ok"}


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    """获取当前用户信息"""
    return {
        "code": 0,
        "data": {
            "username": user["name"],
            "nickname": user["name"],
        }
    }
