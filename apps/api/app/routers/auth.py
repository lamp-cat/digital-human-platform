"""认证：注册 / 登录 / me（契约 §认证）。"""
import re

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import get_current_user, get_db
from ..errors import ApiError
from ..models import User
from ..security import create_token, hash_password, verify_password
from ..serializers import user_json

router = APIRouter(prefix="/auth", tags=["auth"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterBody(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    displayName: str | None = Field(None, max_length=64)


class LoginBody(BaseModel):
    email: str
    password: str


def _issue_token(request: Request, user: User) -> str:
    settings = request.app.state.settings
    return create_token(user.id, settings.jwt_secret, settings.jwt_expire_seconds)


@router.post("/register", status_code=201)
def register(body: RegisterBody, request: Request, db: Session = Depends(get_db)):
    if not _EMAIL_RE.match(body.email):
        raise ApiError(422, "VALIDATION_FAILED", "邮箱格式不正确")
    exists = db.scalar(select(User).where(User.email == body.email))
    if exists:
        raise ApiError(409, "CONFLICT", "该邮箱已注册")
    user = User(
        email=body.email,
        display_name=body.displayName or body.email.split("@")[0],
        password_hash=hash_password(body.password),
        role="user",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"token": _issue_token(request, user), "user": user_json(user)}


@router.post("/login")
def login(body: LoginBody, request: Request, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email))
    if user is None or not verify_password(body.password, user.password_hash):
        raise ApiError(401, "UNAUTHORIZED", "邮箱或密码错误")
    if user.status != "active":
        raise ApiError(401, "UNAUTHORIZED", "账号已停用")
    return {"token": _issue_token(request, user), "user": user_json(user)}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return {"user": user_json(user)}
