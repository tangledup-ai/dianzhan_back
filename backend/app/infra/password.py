"""密码哈希（SHA-256 加盐，无外部依赖），存 'salt$hash'"""

import hashlib
import secrets


def hash_password(password: str, salt: str = None) -> str:
    salt = salt or secrets.token_hex(8)
    h = hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()
    return f"{salt}${h}"


def verify_password(password: str, stored: str) -> bool:
    if not stored or "$" not in stored:
        return False
    salt, _ = stored.split("$", 1)
    return secrets.compare_digest(hash_password(password, salt), stored)
