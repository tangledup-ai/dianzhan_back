import os
from dotenv import load_dotenv

load_dotenv()

# 数据库
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://quant:quant-speed123@localhost:5432/huandian_v2")

# 服务
PORT = int(os.getenv("PORT", "3001"))

# 天雀电表 API
TQ_API_URL = os.getenv("TQ_API_URL", "https://api1.tqdianbiao.com")
TQ_AUTH_CODE = os.getenv("TQ_AUTH_CODE", "5ec0b6bf6f59984d97ec54f775a3c780")

# JWT
JWT_SECRET = os.getenv("JWT_SECRET", "huandian-platform-secret-key-2026")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7
