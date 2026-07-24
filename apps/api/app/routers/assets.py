"""资产目录：列表 / 详情 / 程序化 SVG 缩略图。"""
import hashlib

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import get_current_user, get_db
from ..errors import ApiError
from ..models import Asset, User
from ..serializers import asset_entry

router = APIRouter(prefix="/assets", tags=["assets"])

_ADMIN_ROLES = ("asset_admin", "system_admin")


def _is_admin(user: User) -> bool:
    return user.role in _ADMIN_ROLES


@router.get("")
def list_assets(
    type: str | None = Query(None),
    status: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Asset)
    if type:
        stmt = stmt.where(Asset.type == type)
    # 非管理员只能看到 published；管理员可用 status 过滤
    if _is_admin(user):
        stmt = stmt.where(Asset.status == status) if status else stmt
    else:
        stmt = stmt.where(Asset.status == "published")
    rows = db.scalars(stmt.order_by(Asset.type, Asset.id)).all()
    return {"assets": [asset_entry(a) for a in rows]}


@router.get("/{asset_id}")
def get_asset(
    asset_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    asset = db.get(Asset, asset_id)
    if asset is None or (asset.status != "published" and not _is_admin(user)):
        raise ApiError(404, "ASSET_NOT_FOUND", "资产不存在")
    return {"asset": asset_entry(asset)}


def _render_svg_thumbnail(asset: Asset) -> str:
    """程序化缩略图：底色（由 id 哈希取色相）+ 名称首字。"""
    hue = int(hashlib.sha256(asset.id.encode()).hexdigest()[:8], 16) % 360
    name = asset.manifest_json.get("displayName") or asset.id
    initial = name[0]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
        f'<rect width="256" height="256" rx="24" fill="hsl({hue}, 45%, 32%)"/>'
        f'<circle cx="128" cy="104" r="52" fill="hsl({hue}, 60%, 72%)" opacity="0.35"/>'
        f'<text x="128" y="150" font-size="96" font-family="sans-serif" font-weight="bold" '
        f'fill="hsl({hue}, 70%, 88%)" text-anchor="middle">{initial}</text>'
        f'<text x="128" y="228" font-size="20" font-family="sans-serif" '
        f'fill="hsl({hue}, 40%, 75%)" text-anchor="middle">{name[:12]}</text>'
        "</svg>"
    )


@router.get("/{asset_id}/thumbnail")
def get_thumbnail(
    asset_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    asset = db.get(Asset, asset_id)
    if asset is None or (asset.status != "published" and not _is_admin(user)):
        raise ApiError(404, "ASSET_NOT_FOUND", "资产不存在")
    svg = _render_svg_thumbnail(asset)
    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=3600"},
    )
