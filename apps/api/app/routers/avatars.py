"""角色（avatars）API：CRUD、乐观锁保存、复制、软删除、封面。"""
import base64
import binascii

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from ..database import utcnow
from ..deps import get_current_user, get_db
from ..errors import ApiError
from ..jobs import create_job
from ..models import Avatar, AvatarVersion, User
from ..open_avatar_catalog import get_open_avatar, list_open_avatars
from ..schemas import create_default_profile, validate_profile
from ..serializers import avatar_detail, avatar_summary

router = APIRouter(prefix="/avatars", tags=["avatars"])

_COVER_MAX_BYTES = 5 * 1024 * 1024
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC = b"\xff\xd8\xff"


class CreateAvatarBody(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    catalogAssetId: str | None = None


class PatchAvatarBody(BaseModel):
    expectedVersion: int
    profile: dict
    name: str | None = Field(None, min_length=1, max_length=64)


class CoverBase64Body(BaseModel):
    imageBase64: str


def _get_owned_avatar(db: Session, user: User, avatar_id: str) -> Avatar:
    avatar = db.get(Avatar, avatar_id)
    if avatar is None or avatar.owner_id != user.id or avatar.deleted_at is not None:
        raise ApiError(404, "NOT_FOUND", "人物不存在")
    return avatar


def _write_snapshot(db: Session, avatar: Avatar) -> None:
    db.add(
        AvatarVersion(
            avatar_id=avatar.id, version=avatar.version, profile_json=avatar.profile_json
        )
    )


@router.post("", status_code=201)
def create_avatar(
    body: CreateAvatarBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    profile = create_default_profile()
    base_avatar_id = "base-adult-v1"
    if body.catalogAssetId is not None:
        catalog_asset = get_open_avatar(body.catalogAssetId)
        if catalog_asset is None:
            raise ApiError(404, "CATALOG_AVATAR_NOT_FOUND", "开源人物不存在")
        base_avatar_id = f"catalog-{catalog_asset['id']}"
        profile = create_default_profile(base_avatar_id=base_avatar_id)
        profile["assetSource"] = {
            "type": "catalog",
            "assetId": catalog_asset["id"],
            "compatibility": catalog_asset["compatibility"],
        }
    avatar = Avatar(
        owner_id=user.id,
        name=body.name,
        base_avatar_id=base_avatar_id,
        profile_json=profile,
        version=1,
    )
    db.add(avatar)
    db.flush()
    _write_snapshot(db, avatar)
    db.commit()
    db.refresh(avatar)
    return {"avatar": avatar_detail(avatar)}


@router.get("/catalog")
def list_avatar_catalog(user: User = Depends(get_current_user)):
    return {"avatars": list_open_avatars()}


@router.get("")
def list_avatars(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Avatar)
        .where(Avatar.owner_id == user.id, Avatar.deleted_at.is_(None))
        .order_by(Avatar.updated_at.desc())
    ).all()
    return {"avatars": [avatar_summary(a) for a in rows]}


@router.get("/{avatar_id}")
def get_avatar(
    avatar_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return {"avatar": avatar_detail(_get_owned_avatar(db, user, avatar_id))}


@router.patch("/{avatar_id}")
def patch_avatar(
    avatar_id: str,
    body: PatchAvatarBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    avatar = _get_owned_avatar(db, user, avatar_id)
    # 乐观锁：版本不匹配 → 409 + 服务端最新版本摘要
    if body.expectedVersion != avatar.version:
        raise ApiError(
            409,
            "AVATAR_VERSION_CONFLICT",
            "人物版本已变化，请基于最新版本重新编辑",
            {"latestVersion": avatar.version, "latestProfile": avatar.profile_json},
        )
    profile_json, errors = validate_profile(body.profile)
    if profile_json is None:
        raise ApiError(422, "AVATAR_PROFILE_INVALID", "Profile 校验失败", {"errors": errors})
    source = profile_json.get("assetSource", {})
    if source.get("type") == "catalog":
        catalog_asset = get_open_avatar(source.get("assetId", ""))
        expected_base_id = f"catalog-{source.get('assetId', '')}"
        if catalog_asset is None or profile_json.get("baseAvatarId") != expected_base_id:
            raise ApiError(
                422,
                "AVATAR_PROFILE_INVALID",
                "开源人物来源与底模不匹配",
                {"errors": ["assetSource.assetId: unknown or mismatched catalog asset"]},
            )
    avatar.profile_json = profile_json
    avatar.base_avatar_id = profile_json["baseAvatarId"]
    if body.name is not None:
        avatar.name = body.name
    avatar.version += 1
    avatar.updated_at = utcnow()
    _write_snapshot(db, avatar)
    db.commit()
    db.refresh(avatar)
    return {"avatar": avatar_detail(avatar)}


@router.post("/{avatar_id}/duplicate", status_code=201)
def duplicate_avatar(
    avatar_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    src = _get_owned_avatar(db, user, avatar_id)
    avatar = Avatar(
        owner_id=user.id,
        name=f"{src.name} 副本",
        base_avatar_id=src.base_avatar_id,
        profile_json=dict(src.profile_json),
        version=1,
    )
    db.add(avatar)
    db.flush()
    _write_snapshot(db, avatar)
    db.commit()
    db.refresh(avatar)
    return {"avatar": avatar_detail(avatar)}


@router.delete("/{avatar_id}", status_code=204)
def delete_avatar(
    avatar_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    avatar = _get_owned_avatar(db, user, avatar_id)
    avatar.deleted_at = utcnow()  # 软删除
    avatar.updated_at = utcnow()
    db.commit()
    return Response(status_code=204)


def _check_cover_bytes(data: bytes) -> str:
    if len(data) > _COVER_MAX_BYTES:
        raise ApiError(422, "VALIDATION_FAILED", "封面图片不能超过 5MB")
    if data.startswith(_PNG_MAGIC):
        return "png"
    if data.startswith(_JPEG_MAGIC):
        return "jpg"
    raise ApiError(422, "VALIDATION_FAILED", "封面仅支持 PNG 或 JPEG 图片")


@router.post("/{avatar_id}/cover")
async def upload_cover(
    avatar_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """封面上传：multipart 文件或 JSON {imageBase64} 二选一。"""
    avatar = _get_owned_avatar(db, user, avatar_id)
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        file = form.get("file") or form.get("cover")
        if not isinstance(file, UploadFile):
            raise ApiError(422, "VALIDATION_FAILED", "multipart 中缺少文件字段 file")
        data = await file.read()
    else:
        try:
            body = CoverBase64Body.model_validate(await request.json())
            data = base64.b64decode(body.imageBase64, validate=True)
        except (binascii.Error, ValueError):
            raise ApiError(422, "VALIDATION_FAILED", "imageBase64 不是合法 Base64") from None
    ext = _check_cover_bytes(data)

    storage = request.app.state.storage
    key = f"avatars/{user.id}/{avatar.id}/covers/v{avatar.version}.{ext}"
    storage.put(key, data)
    avatar.cover_key = key
    avatar.updated_at = utcnow()
    db.commit()

    # 封面缩略图任务（V1 占位：直接 succeeded）
    create_job(
        db,
        job_type="avatar_cover",
        input_json={"avatarId": avatar.id, "coverKey": key},
        owner_id=user.id,
        runner=request.app.state.job_runner,
    )
    db.refresh(avatar)
    return {"avatar": avatar_detail(avatar)}


@router.get("/{avatar_id}/cover")
def get_cover(
    avatar_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    avatar = _get_owned_avatar(db, user, avatar_id)
    if not avatar.cover_key:
        raise ApiError(404, "NOT_FOUND", "该人物还没有封面")
    storage = request.app.state.storage
    if not storage.exists(avatar.cover_key):
        raise ApiError(404, "NOT_FOUND", "封面文件不存在")
    media_type = "image/png" if avatar.cover_key.endswith(".png") else "image/jpeg"
    return Response(content=storage.get(avatar.cover_key), media_type=media_type)
