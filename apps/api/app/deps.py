"""FastAPI 依赖：DB 会话、当前用户、角色检查。"""
from collections.abc import Generator

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from .errors import ApiError
from .models import User
from .security import decode_token


def get_db(request: Request) -> Generator[Session, None, None]:
    session_factory = request.app.state.session_factory
    db = session_factory()
    try:
        yield db
    finally:
        db.close()


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    auth = request.headers.get("authorization", "")
    scheme, _, token = auth.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise ApiError(401, "UNAUTHORIZED", "缺少或非法的 Bearer Token")
    settings = request.app.state.settings
    user_id = decode_token(token, settings.jwt_secret)
    if not user_id:
        raise ApiError(401, "UNAUTHORIZED", "Token 无效或已过期")
    user = db.get(User, user_id)
    if user is None or user.status != "active":
        raise ApiError(401, "UNAUTHORIZED", "用户不存在或已停用")
    return user


def require_roles(*roles: str):
    """角色检查依赖工厂：user / asset_admin / system_admin。"""

    def checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise ApiError(403, "FORBIDDEN", "当前角色无权执行该操作")
        return user

    return checker


require_asset_admin = require_roles("asset_admin", "system_admin")
