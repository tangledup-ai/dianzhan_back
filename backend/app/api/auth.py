"""管理后台认证：登录 / 当前用户 / 首次引导创建

权限模型（用户确认 2026-08）：
- role ∈ {boss 老板, finance 财务, finance_supervisor 财务主管} → 全部数据可见；
- role = shareholder 股东 → 只能查看 platform_users.landlord_ids 关联场地的数据。
"""
from fastapi import APIRouter, HTTPException, Depends
from ..middleware.mp_auth import create_token, get_current_user
from ..infra.password import hash_password, verify_password
from ..infra.database import get_connection, get_dict_cursor
from .base import CamelJSONResponse

router = APIRouter(prefix="/api/auth", tags=["认证"], default_response_class=CamelJSONResponse)

FULL_ROLES = {"boss", "finance", "finance_supervisor"}


def is_full_access(user: dict) -> bool:
    """老板/财务/财务主管 = 全部权限"""
    return (user.get("role") in FULL_ROLES)


def _user_payload(u: dict) -> dict:
    return {
        "id": u["id"],
        "name": u.get("name"),
        "role": u.get("role"),
        "shareholderId": u.get("shareholder_id"),
        "shareholderName": u.get("shareholder_name"),
        "landlordIds": [int(x) for x in (u.get("landlord_ids") or []) if x is not None],
        "phone": u.get("phone"),
    }


@router.post("/login")
async def login(data: dict):
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""
    if not name or not password:
        raise HTTPException(400, "请输入姓名和密码")

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT pu.*, s.name as shareholder_name
            FROM platform_users pu
            LEFT JOIN shareholders s ON pu.shareholder_id = s.id
            WHERE pu.name = %s
        """, (name,))
        u = cur.fetchone()
    finally:
        cur.close()
        conn.close()

    if not u or not verify_password(password, u.get("password") or ""):
        raise HTTPException(401, "姓名或密码错误")

    token = create_token(u["id"], u["name"], u["role"])
    return {"token": token, "user": _user_payload(u)}


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    """当前登录用户信息（含角色与关联场地）"""
    return _user_payload(user)


@router.post("/bootstrap")
async def bootstrap(data: dict):
    """首次使用引导：仅当平台还没有任何用户时，创建第一个「老板」账号"""
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""
    if not name or not password:
        raise HTTPException(400, "请输入姓名和密码")

    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT COUNT(*) as c FROM platform_users")
        if cur.fetchone()["c"] > 0:
            raise HTTPException(400, "平台已有用户，请直接登录")
        cur.execute(
            "INSERT INTO platform_users (name, role, password) VALUES (%s, 'boss', %s) RETURNING *",
            (name, hash_password(password)),
        )
        u = cur.fetchone()
        conn.commit()
    finally:
        cur.close()
        conn.close()

    token = create_token(u["id"], u["name"], u["role"])
    return {"token": token, "user": _user_payload(u)}
