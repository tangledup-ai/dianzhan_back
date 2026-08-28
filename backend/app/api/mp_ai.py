"""小程序 AI 对话：DeepSeek（OpenAI 兼容接口）

API Key 优先级：管理后台「系统设置」配置值 > config.py 默认值（DEEPSEEK_API_KEY 环境变量）。
未配置任何 key 时返回明确提示，引导管理员到后台填写。
"""
import httpx
from fastapi import APIRouter, HTTPException, Depends
from ..middleware.mp_auth import get_current_user
from ..config import DEEPSEEK_API_URL, DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_API_KEY
from .system_config import ensure_table, get_config_value

router = APIRouter(prefix="/ai", tags=["📱 小程序 - AI 助手"])

# 经营助手的系统提示词
SYSTEM_PROMPT = (
    "你是换电经营平台的经营数据助手。用简洁的中文回答用户关于站点、电量、电费、"
    "租金、利润、合同、分红等经营管理方面的问题；数据类问题建议用户查看对应页面的实时数据。"
)


def _resolve_api_key() -> str:
    return get_config_value("deepseek_api_key", DEFAULT_DEEPSEEK_API_KEY).strip()


@router.post("/chat")
async def ai_chat(data: dict, user: dict = Depends(get_current_user)):
    """AI 对话（key 从系统配置读取，未配置时提示到管理后台填写）"""
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    if not message:
        raise HTTPException(400, "消息不能为空")

    api_key = _resolve_api_key()
    if not api_key:
        raise HTTPException(400, "AI 服务尚未配置 API Key，请管理员在后台「系统设置」中填写 DeepSeek API Key")

    # 组装消息（历史截断最近 10 条，控制 token）
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for h in history[-10:]:
        role = h.get("role")
        content = (h.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": message})

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                DEEPSEEK_API_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={"model": DEEPSEEK_MODEL, "messages": messages, "stream": False},
            )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"AI 服务连接失败：{e.__class__.__name__}")

    if resp.status_code == 401:
        raise HTTPException(401, "DeepSeek API Key 无效，请管理员在后台「系统设置」中更新")
    if resp.status_code == 402:
        raise HTTPException(402, "DeepSeek 账户余额不足，请充值后重试")
    if resp.status_code != 200:
        raise HTTPException(502, f"DeepSeek 服务返回错误({resp.status_code})")

    try:
        answer = resp.json()["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, ValueError):
        raise HTTPException(502, "AI 返回格式异常，请稍后重试")

    return {"answer": answer}
