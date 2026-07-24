"""私有导入文件的短时签名 URL（HMAC-SHA256 + 过期时间）。"""
import hashlib
import hmac
import time


def sign_import_token(import_id: str, secret: str, ttl_seconds: int) -> str:
    """生成 `<expires>.<hmac>` 形式的令牌。"""
    expires = int(time.time()) + ttl_seconds
    sig = hmac.new(secret.encode(), f"{import_id}.{expires}".encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{sig}"


def verify_import_token(import_id: str, token: str | None, secret: str) -> bool:
    if not token:
        return False
    try:
        expires_str, sig = token.split(".", 1)
        expires = int(expires_str)
    except ValueError:
        return False
    if expires < int(time.time()):
        return False
    expected = hmac.new(
        secret.encode(), f"{import_id}.{expires}".encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, sig)
