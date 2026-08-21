"""小程序认证接口"""

from fastapi import APIRouter, HTTPException, Depends
from ..middleware.mp_auth import create_token, get_current_user
from ..infra.database import get_connection, get_dict_cursor

router = APIRouter(prefix="/auth", tags=["📱 小程序 - 认证"])


@router.post("/login")
async def login(data: dict):
    """用户登录（按 name 匹配，无密码）"""
    username = data.get("username", "").strip()
    if not username:
        raise HTTPException(400, "用户名不能为空")

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "SELECT id, name, role, phone FROM platform_users WHERE name = %s",
            (username,)
        )
        user = cur.fetchone()
        if not user:
            raise HTTPException(401, "用户不存在")

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
