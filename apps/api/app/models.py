"""ORM 模型（SQLAlchemy 2 风格），对应开发文档 §12.2 核心数据表。"""
import uuid

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base, utcnow


def new_id() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(sa.String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(sa.String(255), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(sa.String(64))
    password_hash: Mapped[str] = mapped_column(sa.String(255))
    role: Mapped[str] = mapped_column(sa.String(32), default="user")  # user / asset_admin / system_admin
    status: Mapped[str] = mapped_column(sa.String(16), default="active")
    created_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)


class Avatar(Base):
    __tablename__ = "avatars"

    id: Mapped[str] = mapped_column(sa.String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(sa.String(36), sa.ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(sa.String(64))
    base_avatar_id: Mapped[str] = mapped_column(sa.String(64))
    profile_json: Mapped[dict] = mapped_column(sa.JSON)
    version: Mapped[int] = mapped_column(sa.Integer, default=1)  # 乐观锁
    cover_key: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    visibility: Mapped[str] = mapped_column(sa.String(16), default="private")
    created_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)
    updated_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[object | None] = mapped_column(sa.DateTime, nullable=True)  # 软删除


class AvatarVersion(Base):
    __tablename__ = "avatar_versions"
    __table_args__ = (sa.UniqueConstraint("avatar_id", "version"),)

    id: Mapped[str] = mapped_column(sa.String(36), primary_key=True, default=new_id)
    avatar_id: Mapped[str] = mapped_column(sa.String(36), sa.ForeignKey("avatars.id"), index=True)
    version: Mapped[int] = mapped_column(sa.Integer)
    profile_json: Mapped[dict] = mapped_column(sa.JSON)  # 每次保存写快照
    created_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)  # 如 top-hoodie-01
    type: Mapped[str] = mapped_column(sa.String(32), index=True)  # garment/hair/accessory/shoes/base_avatar/animation
    status: Mapped[str] = mapped_column(sa.String(16), default="draft", index=True)  # draft/validating/published/archived/rejected
    version: Mapped[str] = mapped_column(sa.String(32), default="1.0.0")
    manifest_json: Mapped[dict] = mapped_column(sa.JSON)
    model_key: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    thumbnail_key: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    created_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)
    updated_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow, onupdate=utcnow)


class ImportedAsset(Base):
    __tablename__ = "imported_assets"

    id: Mapped[str] = mapped_column(sa.String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(sa.String(36), sa.ForeignKey("users.id"), index=True)
    display_name: Mapped[str] = mapped_column(sa.String(64))
    original_filename: Mapped[str] = mapped_column(sa.String(255))
    original_key: Mapped[str] = mapped_column(sa.Text)  # 私有存储 key
    manifest_key: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    manifest_json: Mapped[dict | None] = mapped_column(sa.JSON, nullable=True)  # 校验通过的 manifest
    sha256: Mapped[str] = mapped_column(sa.String(64))
    size_bytes: Mapped[int] = mapped_column(sa.Integer)
    status: Mapped[str] = mapped_column(sa.String(32), default="validating", index=True)
    # uploaded/validating/accepted_full/accepted_pose_only/rejected/activated
    compatibility: Mapped[str | None] = mapped_column(sa.String(16), nullable=True)  # FULL/POSE_ONLY/REJECTED
    created_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)
    updated_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow, onupdate=utcnow)


class ImportReport(Base):
    __tablename__ = "import_reports"

    id: Mapped[str] = mapped_column(sa.String(36), primary_key=True, default=new_id)
    imported_asset_id: Mapped[str] = mapped_column(sa.String(36), sa.ForeignKey("imported_assets.id"), index=True)
    validator_version: Mapped[str] = mapped_column(sa.String(32))
    report_json: Mapped[dict] = mapped_column(sa.JSON)
    created_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(sa.String(36), primary_key=True, default=new_id)
    type: Mapped[str] = mapped_column(sa.String(32), index=True)  # import_validate/asset_validate/avatar_cover
    status: Mapped[str] = mapped_column(sa.String(16), default="queued", index=True)
    # queued/running/succeeded/failed
    progress: Mapped[int] = mapped_column(sa.Integer, default=0)
    input_json: Mapped[dict] = mapped_column(sa.JSON, default=dict)
    result_json: Mapped[dict | None] = mapped_column(sa.JSON, nullable=True)
    error_code: Mapped[str | None] = mapped_column(sa.String(64), nullable=True)
    owner_id: Mapped[str | None] = mapped_column(sa.String(36), nullable=True, index=True)
    created_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)
    updated_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow, onupdate=utcnow)


class Consent(Base):
    __tablename__ = "consents"

    id: Mapped[str] = mapped_column(sa.String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(sa.String(36), sa.ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(sa.String(32))  # 如 import_rights（外部资产权属声明）
    version: Mapped[str] = mapped_column(sa.String(16), default="1.0")
    granted_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)
    revoked_at: Mapped[object | None] = mapped_column(sa.DateTime, nullable=True)
    meta_json: Mapped[dict | None] = mapped_column(sa.JSON, nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(sa.String(36), primary_key=True, default=new_id)
    actor_id: Mapped[str | None] = mapped_column(sa.String(36), nullable=True)
    action: Mapped[str] = mapped_column(sa.String(64), index=True)
    target_type: Mapped[str] = mapped_column(sa.String(32))
    target_id: Mapped[str] = mapped_column(sa.String(64))
    meta_json: Mapped[dict | None] = mapped_column(sa.JSON, nullable=True)
    created_at: Mapped[object] = mapped_column(sa.DateTime, default=utcnow)
