import os
from dotenv import load_dotenv

load_dotenv()

# 数据库
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://quant:CHANGE_ME_DB_PASSWORD@localhost:5432/huandian_v2")

# 服务
PORT = int(os.getenv("PORT", "3001"))

# 天雀电表 API
TQ_API_URL = os.getenv("TQ_API_URL", "https://api1.tqdianbiao.com")
TQ_AUTH_CODE = os.getenv("TQ_AUTH_CODE", "5ec0b6bf6f59984d97ec54f775a3c780")

# JWT
JWT_SECRET = os.getenv("JWT_SECRET", "huandian-platform-secret-key-2026")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7

# DeepSeek AI（小程序 AI 对话；管理后台「系统设置」可覆盖默认值）
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
DEFAULT_DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")

# 腾讯地图 key（管理后台地图组件使用；管理后台「系统设置」可覆盖默认值）
DEFAULT_MAP_KEY = os.getenv("MAP_KEY", "VS3BZ-TIXCV-RJ2PQ-5YUEE-UZDEV-MHFQD")
