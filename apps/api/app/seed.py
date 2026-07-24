"""启动种子：内置账号 + 内置资产（manifest 与 avatar-schema 对齐）。

内置资产的 assets.model 统一为 `procedural:<id>`，由前端 avatar-runtime 程序化生成。
"""
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Asset, User
from .schemas import BODY_SECTIONS, RIG_VERSION
from .security import hash_password

logger = logging.getLogger("dhp.seed")

_LICENSE = {"source": "self-created", "licenseId": "project-owned"}
_BASE = "base-adult-v1"


def _manifest(
    asset_id: str,
    display_name: str,
    type_: str,
    category: str,
    *,
    slots: list[str] | None = None,
    layer: int = 10,
    body_mask: list[str] | None = None,
    shape_constraints: dict | None = None,
    replaces_slots: list[str] | None = None,
    restricts_traits: dict | None = None,
    extra: dict | None = None,
) -> dict:
    m = {
        "id": asset_id,
        "version": "1.0.0",
        "displayName": display_name,
        "type": type_,
        "category": category,
        "slots": slots or [],
        "layer": layer,
        "rigVersion": RIG_VERSION,
        "compatibleBaseAvatars": [_BASE],
        "shapeConstraints": shape_constraints or {},
        "bodyMask": body_mask or [],
        "replacesSlots": replaces_slots or [],
        "restrictsTraits": restricts_traits or {},
        "assets": {"model": f"procedural:{asset_id}"},
        "license": dict(_LICENSE),
    }
    if extra:
        m.update(extra)
    return m


SEED_ASSETS: list[dict] = [
    # 底模
    _manifest(
        _BASE, "标准成人底模", "base_avatar", "base",
        layer=0, body_mask=list(BODY_SECTIONS),
        extra={"heightMeters": 1.70, "bindPose": "T_POSE"},
    ),
    # 发型
    _manifest("hair-short-01", "清爽短发", "hair", "hair", slots=["hair"]),
    _manifest(
        "hair-long-01", "披肩长发", "hair", "hair", slots=["hair"],
        body_mask=["body_neck"],
    ),
    # 上装
    _manifest(
        "top-hoodie-01", "连帽卫衣", "garment", "top", slots=["top"], layer=20,
        body_mask=["body_torso", "body_left_upper_arm", "body_right_upper_arm"],
        shape_constraints={"shoulderWidth": [0.9, 1.12], "torsoLength": [0.92, 1.08]},
    ),
    _manifest(
        "top-tee-01", "基础 T 恤", "garment", "top", slots=["top"], layer=10,
        body_mask=["body_torso"],
    ),
    _manifest(
        "top-jacket-01", "工装夹克", "garment", "top", slots=["top"], layer=30,
        body_mask=[
            "body_torso",
            "body_left_upper_arm", "body_left_lower_arm",
            "body_right_upper_arm", "body_right_lower_arm",
        ],
        replaces_slots=["top"],
    ),
    # 下装
    _manifest(
        "bottom-jeans-01", "直筒牛仔裤", "garment", "bottom", slots=["bottom"],
        body_mask=[
            "body_hips",
            "body_left_upper_leg", "body_left_lower_leg",
            "body_right_upper_leg", "body_right_lower_leg",
        ],
    ),
    _manifest(
        "bottom-shorts-01", "休闲短裤", "garment", "bottom", slots=["bottom"],
        body_mask=["body_hips", "body_left_upper_leg", "body_right_upper_leg"],
    ),
    # 鞋子
    _manifest(
        "shoes-sneaker-01", "运动板鞋", "shoes", "footwear", slots=["footwear"],
        body_mask=["body_left_foot", "body_right_foot"],
    ),
    _manifest(
        "shoes-leather-01", "皮鞋", "shoes", "footwear", slots=["footwear"],
        body_mask=["body_left_foot", "body_right_foot"],
    ),
    # 配件
    _manifest("acc-glasses-01", "黑框眼镜", "accessory", "eyewear", slots=["eyewear"]),
    _manifest(
        "acc-cap-01", "棒球帽", "accessory", "headwear", slots=["headwear"],
        restricts_traits={"hair": ["hair-long-01"]},
    ),
    _manifest("acc-watch-01", "简约腕表", "accessory", "hand", slots=["hand"]),
    # 动作（程序化动画片段）
    _manifest(
        "anim-idle-01", "待机呼吸", "animation", "animation", layer=0,
        extra={"clip": {"durationSeconds": 4.0, "loop": True}},
    ),
    _manifest(
        "anim-wave-01", "挥手致意", "animation", "animation", layer=0,
        extra={"clip": {"durationSeconds": 2.0, "loop": False}},
    ),
    _manifest(
        "anim-walk-01", "原地行走", "animation", "animation", layer=0,
        extra={"clip": {"durationSeconds": 1.2, "loop": True}},
    ),
]

SEED_USERS = [
    ("demo@dhp.local", "demo123456", "演示用户", "user"),
    ("admin@dhp.local", "admin123456", "平台管理员", "system_admin"),
]


def seed_database(db: Session) -> None:
    # 账号（幂等）
    for email, password, display_name, role in SEED_USERS:
        exists = db.scalar(select(User).where(User.email == email))
        if not exists:
            db.add(
                User(
                    email=email,
                    display_name=display_name,
                    password_hash=hash_password(password),
                    role=role,
                )
            )
    db.commit()

    # 资产（幂等：已存在则跳过，不覆盖管理员后续改动）
    existing = set(db.scalars(select(Asset.id)).all())
    created = 0
    for manifest in SEED_ASSETS:
        if manifest["id"] in existing:
            continue
        db.add(
            Asset(
                id=manifest["id"],
                type=manifest["type"],
                status="published",
                version=manifest["version"],
                manifest_json=manifest,
            )
        )
        created += 1
    db.commit()
    if created:
        logger.info("seeded %d built-in assets", created)
