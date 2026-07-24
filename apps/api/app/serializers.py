"""ORM → 契约 JSON 的序列化。"""
from .database import iso
from .models import Asset, Avatar, ImportedAsset, Job, User
from .signing import sign_import_token


def user_json(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "role": user.role,
    }


def avatar_summary(a: Avatar) -> dict:
    return {
        "id": a.id,
        "name": a.name,
        "baseAvatarId": a.base_avatar_id,
        "version": a.version,
        "coverUrl": f"/api/v1/avatars/{a.id}/cover" if a.cover_key else None,
        "visibility": a.visibility,
        "createdAt": iso(a.created_at),
        "updatedAt": iso(a.updated_at),
    }


def avatar_detail(a: Avatar) -> dict:
    detail = avatar_summary(a)
    profile = a.profile_json or {}
    detail["profile"] = profile
    detail["assetSource"] = profile.get("assetSource", {"type": "built_in"})
    return detail


def asset_entry(asset: Asset) -> dict:
    """AssetEntry = manifest_json 超集 + status；thumbnail 统一走 API。"""
    entry = dict(asset.manifest_json)
    entry["id"] = asset.id
    entry["status"] = asset.status
    assets = dict(entry.get("assets") or {})
    assets["thumbnail"] = f"/api/v1/assets/{asset.id}/thumbnail"
    entry["assets"] = assets
    return entry


def import_summary(rec: ImportedAsset) -> dict:
    return {
        "id": rec.id,
        "displayName": rec.display_name,
        "originalFilename": rec.original_filename,
        "status": rec.status,
        "compatibility": rec.compatibility,
        "sizeBytes": rec.size_bytes,
        "createdAt": iso(rec.created_at),
    }


def import_record(rec: ImportedAsset, jwt_secret: str, ttl_seconds: int) -> dict:
    token = sign_import_token(rec.id, jwt_secret, ttl_seconds)
    return {
        **import_summary(rec),
        "sha256": rec.sha256,
        "modelUrl": f"/api/v1/imports/{rec.id}/model?token={token}",
        "previewUrl": None,  # V1 不生成派生预览，前端直接用 modelUrl 加载
        "updatedAt": iso(rec.updated_at),
    }


def job_json(job: Job) -> dict:
    return {
        "id": job.id,
        "type": job.type,
        "status": job.status,
        "progress": job.progress,
        "resultJson": job.result_json,
        "errorCode": job.error_code,
        "createdAt": iso(job.created_at),
        "updatedAt": iso(job.updated_at),
    }
