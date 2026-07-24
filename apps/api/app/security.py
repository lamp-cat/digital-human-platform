"""密码哈希（pbkdf2_hmac 加盐，不依赖 bcrypt）与 JWT。"""
import hashlib
import hmac
import os
import time

import jwt

_ALGO = "pbkdf2_sha256"
_ITERATIONS = 200_000
_JWT_ALG = "HS256"


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return f"{_ALGO}${_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt_hex, digest_hex = stored.split("$")
        if algo != _ALGO:
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def create_token(user_id: str, secret: str, expire_seconds: int) -> str:
    now = int(time.time())
    payload = {"sub": user_id, "iat": now, "exp": now + expire_seconds}
    return jwt.encode(payload, secret, algorithm=_JWT_ALG)


def decode_token(token: str, secret: str) -> str | None:
    """校验 JWT，返回 user_id；失败返回 None。"""
    try:
        payload = jwt.decode(token, secret, algorithms=[_JWT_ALG])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None
