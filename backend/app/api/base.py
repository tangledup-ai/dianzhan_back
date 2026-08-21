"""API 响应基类：统一 camelCase 输出

用法：router = APIRouter(prefix=..., default_response_class=CamelJSONResponse)
或接口手动返回：CamelJSONResponse(content)

模式开关：
- CAMEL_MODE = "alias"  过渡期：snake+camel 双 key（旧前端不破）
- CAMEL_MODE = "full"   收尾：只输出 camel 单 key
切换在 main.py 启动时按需调整，或读环境变量。
"""
import datetime
import os
from decimal import Decimal
from fastapi.responses import JSONResponse

from ..infra.serializers import to_camel, add_camel_aliases

# 过渡期默认 alias（双 key），全部前端迁移完改 "full"
CAMEL_MODE = os.getenv("CAMEL_MODE", "alias")

# 不参与转换的 key：第三方原始 JSONB
SKIP_KEYS = frozenset(["raw_data", "rawData"])


def _json_safe(obj):
    """把 datetime/date/Decimal 等 JSON 无法直接序列化的类型转成安全值。"""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    return obj


class CamelJSONResponse(JSONResponse):
    """把响应内容递归转换为 camelCase（或双 key 过渡）。"""

    def render(self, content):
        content = _json_safe(content)
        if CAMEL_MODE == "full":
            content = to_camel(content, skip=SKIP_KEYS)
        else:
            content = add_camel_aliases(content, skip=SKIP_KEYS)
        return super().render(content)
