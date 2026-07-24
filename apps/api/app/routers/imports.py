"""外部模型导入：上传 / 列表 / 详情 / 报告 / 激活 / 删除 / 签名下载。"""
import hashlib
import io

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from ..database import utcnow
from ..deps import get_current_user, get_db
from ..errors import ApiError
from ..jobs import create_job
from ..models import AuditLog, Consent, ImportReport, ImportedAsset, Job, User, Avatar, AvatarVersion
from ..schemas import create_default_profile
from ..serializers import avatar_detail, import_record, import_summary, job_json
from ..signing import verify_import_token

router = APIRouter(prefix="/imports", tags=["imports"])

_ALLOWED_EXTENSIONS = (".vrm", ".glb")
_GLB_MAGIC = b"glTF"


class ActivateBody(BaseModel):
    name: str = Field(min_length=1, max_length=64)


def _get_owned_import(db: Session, user: User, import_id: str) -> ImportedAsset:
    rec = db.get(ImportedAsset, import_id)
    if rec is None or rec.owner_id != user.id:
        raise ApiError(404, "NOT_FOUND", "导入记录不存在")
    return rec


@router.post("", status_code=201)
async def create_import(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """multipart：model（必传 .vrm/.glb）、manifest（可选）、rightsConfirmed=true。"""
    settings = request.app.state.settings
    form = await request.form()

    # 权属确认（§16：必须先确认合法使用权）
    if form.get("rightsConfirmed") != "true":
        raise ApiError(422, "VALIDATION_FAILED", "必须确认拥有该模型及贴图的合法使用权（rightsConfirmed=true）")

    model_file = form.get("model")
    if not isinstance(model_file, UploadFile):
        raise ApiError(422, "VALIDATION_FAILED", "缺少模型文件字段 model")
    filename = model_file.filename or ""
    lower = filename.lower()
    if not lower.endswith(_ALLOWED_EXTENSIONS):
        raise ApiError(422, "IMPORT_FORMAT_UNSUPPORTED", "仅支持 .vrm / .glb 格式")

    # 读取并限制大小
    data = await model_file.read()
    if not data:
        raise ApiError(422, "IMPORT_FILE_INVALID", "文件内容为空")
    if len(data) > settings.import_max_bytes:
        raise ApiError(
            413, "IMPORT_LIMIT_EXCEEDED",
            f"文件大小 {len(data)} 超过上限 {settings.import_max_bytes}",
        )
    # 魔数校验（不信任扩展名与 MIME）
    if not data.startswith(_GLB_MAGIC):
        raise ApiError(422, "IMPORT_FILE_INVALID", "文件魔数不是 GLB（glTF-Binary）")

    manifest_file = form.get("manifest")
    manifest_bytes: bytes | None = None
    if isinstance(manifest_file, UploadFile):
        manifest_bytes = await manifest_file.read() or None

    sha256 = hashlib.sha256(data).hexdigest()
    storage = request.app.state.storage
    rec = ImportedAsset(
        owner_id=user.id,
        display_name=filename.rsplit(".", 1)[0][:64] or "导入人物",
        original_filename=filename[:255],
        original_key="",  # 先占位，拿到 id 后写 key
        sha256=sha256,
        size_bytes=len(data),
        status="validating",
    )
    db.add(rec)
    db.flush()

    ext = ".vrm" if lower.endswith(".vrm") else ".glb"
    base_key = f"private/imports/{user.id}/{rec.id}"
    rec.original_key = f"{base_key}/source/model{ext}"
    storage.put(rec.original_key, data)
    if manifest_bytes is not None:
        rec.manifest_key = f"{base_key}/source/manifest.json"
        storage.put(rec.manifest_key, manifest_bytes)

    # 权属确认落库
    db.add(
        Consent(
            user_id=user.id,
            type="import_rights",
            version="1.0",
            meta_json={"importId": rec.id, "sha256": sha256},
        )
    )
    db.commit()
    db.refresh(rec)

    job = create_job(
        db,
        job_type="import_validate",
        input_json={"importId": rec.id},
        owner_id=user.id,
        runner=request.app.state.job_runner,
    )
    db.refresh(rec)
    return {
        "importRecord": import_record(rec, settings.jwt_secret, settings.signed_url_ttl_seconds),
        "job": job_json(job),
    }


@router.get("")
def list_imports(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(ImportedAsset)
        .where(ImportedAsset.owner_id == user.id)
        .order_by(ImportedAsset.created_at.desc())
    ).all()
    return {"imports": [import_summary(r) for r in rows]}


@router.get("/{import_id}")
def get_import(
    import_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = request.app.state.settings
    rec = _get_owned_import(db, user, import_id)
    return {"importRecord": import_record(rec, settings.jwt_secret, settings.signed_url_ttl_seconds)}


@router.get("/{import_id}/report")
def get_report(
    import_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_owned_import(db, user, import_id)
    report = db.scalar(
        select(ImportReport)
        .where(ImportReport.imported_asset_id == import_id)
        .order_by(ImportReport.created_at.desc())
        .limit(1)
    )
    if report is None:
        raise ApiError(404, "NOT_FOUND", "校验报告尚未生成")
    return {"report": report.report_json}


@router.post("/{import_id}/activate", status_code=201)
def activate_import(
    import_id: str,
    body: ActivateBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rec = _get_owned_import(db, user, import_id)
    if rec.status not in ("accepted_full", "accepted_pose_only"):
        raise ApiError(
            409, "IMPORT_NOT_VALIDATED",
            f"当前状态 {rec.status} 不能激活（需 accepted_full / accepted_pose_only）",
        )
    compatibility = "FULL" if rec.status == "accepted_full" else "POSE_ONLY"

    profile = create_default_profile(base_avatar_id=f"imported-{rec.id}")
    profile["assetSource"] = {
        "type": "imported",
        "importId": rec.id,
        "compatibility": compatibility,
    }
    # FULL：把 manifest.compatibleGarments 存入 profile 附加字段
    if compatibility == "FULL" and rec.manifest_json:
        profile["importCompatibleGarments"] = rec.manifest_json.get("compatibleGarments", [])

    avatar = Avatar(
        owner_id=user.id,
        name=body.name,
        base_avatar_id=profile["baseAvatarId"],
        profile_json=profile,
        version=1,
    )
    db.add(avatar)
    db.flush()
    db.add(AvatarVersion(avatar_id=avatar.id, version=1, profile_json=profile))
    rec.status = "activated"
    rec.updated_at = utcnow()
    db.commit()
    db.refresh(avatar)
    return {"avatar": avatar_detail(avatar)}


@router.delete("/{import_id}", status_code=204)
def delete_import(
    import_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rec = _get_owned_import(db, user, import_id)
    storage = request.app.state.storage
    # 删除原文件 / 派生物 / 报告（对象存储侧）
    storage.delete_prefix(f"private/imports/{user.id}/{rec.id}")
    # 数据库侧：报告 + 记录
    for report in db.scalars(
        select(ImportReport).where(ImportReport.imported_asset_id == rec.id)
    ).all():
        db.delete(report)
    db.add(
        AuditLog(
            actor_id=user.id,
            action="import.delete",
            target_type="imported_asset",
            target_id=rec.id,
            meta_json={"sha256": rec.sha256},
        )
    )
    db.delete(rec)
    db.commit()
    return None


@router.get("/{import_id}/model")
def download_model(
    import_id: str,
    request: Request,
    token: str | None = Query(None),
    db: Session = Depends(get_db),
):
    """短时签名 URL 下载（签名即授权，不再要求 Bearer）。"""
    settings = request.app.state.settings
    if not verify_import_token(import_id, token, settings.jwt_secret):
        raise ApiError(403, "FORBIDDEN", "签名无效或已过期")
    rec = db.get(ImportedAsset, import_id)
    if rec is None:
        raise ApiError(404, "NOT_FOUND", "导入记录不存在")
    storage = request.app.state.storage
    if not storage.exists(rec.original_key):
        raise ApiError(404, "NOT_FOUND", "模型文件不存在")
    data = storage.get(rec.original_key)
    return StreamingResponse(
        io.BytesIO(data),
        media_type="model/gltf-binary",
        headers={"Content-Length": str(len(data))},
    )
