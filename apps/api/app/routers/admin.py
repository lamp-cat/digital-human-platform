"""管理端资产接口：导入校验 / 发布 / 下架 / 全量列表（写审计日志）。"""
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import utcnow
from ..deps import get_db, require_asset_admin
from ..errors import ApiError
from ..jobs import create_job
from ..models import Asset, AuditLog, User
from ..serializers import asset_entry, job_json

router = APIRouter(prefix="/admin/assets", tags=["admin-assets"])


class ImportAssetBody(BaseModel):
    manifest: dict


def _audit(db: Session, actor: User, action: str, target_id: str, meta: dict | None = None):
    db.add(
        AuditLog(
            actor_id=actor.id,
            action=action,
            target_type="asset",
            target_id=target_id,
            meta_json=meta,
        )
    )


@router.get("")
def list_all_assets(
    user: User = Depends(require_asset_admin),
    db: Session = Depends(get_db),
):
    rows = db.scalars(select(Asset).order_by(Asset.type, Asset.id)).all()
    return {"assets": [asset_entry(a) for a in rows]}


@router.post("/import", status_code=201)
def import_asset(
    body: ImportAssetBody,
    request: Request,
    user: User = Depends(require_asset_admin),
    db: Session = Depends(get_db),
):
    """提交资产 manifest，创建 asset_validate 校验任务。"""
    manifest = body.manifest
    asset_id = manifest.get("id")
    asset_type = manifest.get("type")
    if not isinstance(asset_id, str) or not asset_id:
        raise ApiError(422, "VALIDATION_FAILED", "manifest 缺少 id")
    if asset_type not in ("garment", "hair", "accessory", "shoes", "base_avatar", "animation"):
        raise ApiError(422, "VALIDATION_FAILED", "manifest.type 非法")

    asset = db.get(Asset, asset_id)
    if asset is None:
        asset = Asset(
            id=asset_id,
            type=asset_type,
            status="validating",
            version=str(manifest.get("version", "1.0.0")),
            manifest_json=manifest,
        )
        db.add(asset)
    else:
        # 重新导入：更新 manifest 并重新校验
        asset.type = asset_type
        asset.manifest_json = manifest
        asset.version = str(manifest.get("version", asset.version))
        asset.status = "validating"
        asset.updated_at = utcnow()
    db.commit()

    job = create_job(
        db,
        job_type="asset_validate",
        input_json={"assetId": asset_id},
        owner_id=user.id,
        runner=request.app.state.job_runner,
    )
    _audit(db, user, "asset.import", asset_id, {"type": asset_type})
    db.commit()
    return {"job": job_json(job)}


@router.post("/{asset_id}/publish")
def publish_asset(
    asset_id: str,
    user: User = Depends(require_asset_admin),
    db: Session = Depends(get_db),
):
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise ApiError(404, "ASSET_NOT_FOUND", "资产不存在")
    if asset.status not in ("draft", "archived"):
        raise ApiError(
            409, "ASSET_NOT_PUBLISHED", f"当前状态 {asset.status} 不允许发布（需先通过校验）"
        )
    asset.status = "published"
    asset.updated_at = utcnow()
    _audit(db, user, "asset.publish", asset_id)
    db.commit()
    db.refresh(asset)
    return {"asset": asset_entry(asset)}


@router.post("/{asset_id}/archive")
def archive_asset(
    asset_id: str,
    user: User = Depends(require_asset_admin),
    db: Session = Depends(get_db),
):
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise ApiError(404, "ASSET_NOT_FOUND", "资产不存在")
    asset.status = "archived"
    asset.updated_at = utcnow()
    _audit(db, user, "asset.archive", asset_id)
    db.commit()
    db.refresh(asset)
    return {"asset": asset_entry(asset)}
