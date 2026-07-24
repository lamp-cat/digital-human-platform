"""领域 Schema：与 packages/avatar-schema 的 zod 定义逐字段对齐。

注意：为与前端 JSON 契约一致，字段名直接使用 camelCase。
"""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

# ---------------------------------------------------------------------------
# rig.ts 对应常量
# ---------------------------------------------------------------------------

RIG_VERSION = "standard-rig-1"

STANDARD_RIG_BONES = [
    "Hips", "Spine", "Chest", "UpperChest", "Neck", "Head",
    "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
    "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
    "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
    "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
]
MINIMAL_RIG_BONES = list(STANDARD_RIG_BONES)

BODY_SECTIONS = [
    "body_head", "body_neck", "body_torso",
    "body_left_upper_arm", "body_left_lower_arm",
    "body_right_upper_arm", "body_right_lower_arm",
    "body_hips",
    "body_left_upper_leg", "body_left_lower_leg", "body_left_foot",
    "body_right_upper_leg", "body_right_lower_leg", "body_right_foot",
]

# VRM Humanoid 名称 → StandardRig 显式映射（rig.ts VRM_HUMANOID_TO_RIG）
VRM_HUMANOID_TO_RIG = {
    "hips": "Hips", "spine": "Spine", "chest": "Chest", "upperChest": "UpperChest",
    "neck": "Neck", "head": "Head",
    "leftShoulder": "LeftShoulder", "leftUpperArm": "LeftUpperArm",
    "leftLowerArm": "LeftLowerArm", "leftHand": "LeftHand",
    "rightShoulder": "RightShoulder", "rightUpperArm": "RightUpperArm",
    "rightLowerArm": "RightLowerArm", "rightHand": "RightHand",
    "leftUpperLeg": "LeftUpperLeg", "leftLowerLeg": "LeftLowerLeg",
    "leftFoot": "LeftFoot", "leftToes": "LeftToes",
    "rightUpperLeg": "RightUpperLeg", "rightLowerLeg": "RightLowerLeg",
    "rightFoot": "RightFoot", "rightToes": "RightToes",
}

# 常见外部骨骼名 → StandardRig 显式映射表（禁止运行时名称猜测，仅查表）
COMMON_NAME_TO_RIG: dict[str, str] = {b: b for b in STANDARD_RIG_BONES}
_MIXAMO = {
    "Hips": "Hips", "Spine": "Spine", "Spine1": "Chest", "Spine2": "UpperChest",
    "Neck": "Neck", "Head": "Head",
    "LeftShoulder": "LeftShoulder", "LeftArm": "LeftUpperArm",
    "LeftForeArm": "LeftLowerArm", "LeftHand": "LeftHand",
    "RightShoulder": "RightShoulder", "RightArm": "RightUpperArm",
    "RightForeArm": "RightLowerArm", "RightHand": "RightHand",
    "LeftUpLeg": "LeftUpperLeg", "LeftLeg": "LeftLowerLeg",
    "LeftFoot": "LeftFoot", "LeftToeBase": "LeftToes",
    "RightUpLeg": "RightUpperLeg", "RightLeg": "RightLowerLeg",
    "RightFoot": "RightFoot", "RightToeBase": "RightToes",
}
for _mix, _rig in _MIXAMO.items():
    COMMON_NAME_TO_RIG[f"mixamorig:{_mix}"] = _rig
    COMMON_NAME_TO_RIG[f"mixamorig_{_mix}"] = _rig
    COMMON_NAME_TO_RIG[f"Mixamo:{_mix}"] = _rig

SLOTS = ["hair", "inner", "top", "bottom", "footwear", "headwear", "eyewear", "neck", "hand"]

SlotName = Literal[
    "hair", "inner", "top", "bottom", "footwear", "headwear", "eyewear", "neck", "hand"
]
RigBoneName = Literal[
    "Hips", "Spine", "Chest", "UpperChest", "Neck", "Head",
    "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
    "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
    "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
    "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
]
BodySectionName = Literal[
    "body_head", "body_neck", "body_torso",
    "body_left_upper_arm", "body_left_lower_arm",
    "body_right_upper_arm", "body_right_lower_arm", "body_hips",
    "body_left_upper_leg", "body_left_lower_leg", "body_left_foot",
    "body_right_upper_leg", "body_right_lower_leg", "body_right_foot",
]

# ---------------------------------------------------------------------------
# profile.ts 对应常量与模型
# ---------------------------------------------------------------------------

PROFILE_SCHEMA_VERSION = "1.0"
BUILT_IN_BASE_AVATAR_ID = "base-adult-v1"

MORPH_PARAM_KEYS = [
    "faceWidth", "faceLength", "jawWidth", "chinLength",
    "eyeSize", "eyeSpacing", "eyeHeight",
    "noseWidth", "noseHeight", "mouthWidth", "lipFullness",
]
BONE_SCALE_PARAM_KEYS = ["height", "shoulderWidth", "torsoLength", "legLength"]
# 体型参数允许范围（profile.ts BONE_SCALE_PARAM_DEFS）
BONE_SCALE_RANGES = {
    "height": (0.9, 1.1), "shoulderWidth": (0.9, 1.12),
    "torsoLength": (0.92, 1.08), "legLength": (0.9, 1.1),
}
BoneScaleKey = Literal["height", "shoulderWidth", "torsoLength", "legLength"]
MorphKey = Literal[
    "faceWidth", "faceLength", "jawWidth", "chinLength",
    "eyeSize", "eyeSpacing", "eyeHeight",
    "noseWidth", "noseHeight", "mouthWidth", "lipFullness",
]


class Morphs(BaseModel):
    """捏脸参数：固定 11 个键，取值 [-1, 1]，拒绝未知键。"""
    model_config = ConfigDict(extra="forbid")

    faceWidth: float | None = Field(None, ge=-1, le=1)
    faceLength: float | None = Field(None, ge=-1, le=1)
    jawWidth: float | None = Field(None, ge=-1, le=1)
    chinLength: float | None = Field(None, ge=-1, le=1)
    eyeSize: float | None = Field(None, ge=-1, le=1)
    eyeSpacing: float | None = Field(None, ge=-1, le=1)
    eyeHeight: float | None = Field(None, ge=-1, le=1)
    noseWidth: float | None = Field(None, ge=-1, le=1)
    noseHeight: float | None = Field(None, ge=-1, le=1)
    mouthWidth: float | None = Field(None, ge=-1, le=1)
    lipFullness: float | None = Field(None, ge=-1, le=1)


class BoneScales(BaseModel):
    """体型参数：固定 4 个键，取值 [0.85, 1.15]。"""
    model_config = ConfigDict(extra="forbid")

    height: float | None = Field(None, ge=0.85, le=1.15)
    shoulderWidth: float | None = Field(None, ge=0.85, le=1.15)
    torsoLength: float | None = Field(None, ge=0.85, le=1.15)
    legLength: float | None = Field(None, ge=0.85, le=1.15)


class Materials(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skinToneId: str = "warm-03"
    skinRoughness: float = Field(0.52, ge=0, le=1)
    eyeColorId: str = "brown-02"


class Traits(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hair: str | None = None
    top: str | None = None
    bottom: str | None = None
    shoes: str | None = None
    accessories: list[str] = Field(default_factory=list)


class AssetSourceBuiltIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["built_in"] = "built_in"


class AssetSourceImported(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["imported"]
    importId: str
    compatibility: Literal["FULL", "POSE_ONLY"]


class AssetSourceCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["catalog"]
    assetId: str = Field(min_length=1)
    compatibility: Literal["POSE_ONLY"] = "POSE_ONLY"


AssetSource = Annotated[
    AssetSourceBuiltIn | AssetSourceCatalog | AssetSourceImported,
    Field(discriminator="type"),
]


class Pose(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["idle", "preset", "camera"] = "idle"
    animationId: str | None = "idle-01"


class AvatarProfile(BaseModel):
    """对应 avatarProfileSchema；importCompatibleGarments 为导入人物附加字段。"""
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["1.0"]
    baseAvatarId: str = Field(min_length=1)
    assetSource: AssetSource = Field(default_factory=AssetSourceBuiltIn)
    morphs: Morphs = Field(default_factory=Morphs)
    boneScales: BoneScales = Field(default_factory=BoneScales)
    materials: Materials = Field(default_factory=Materials)
    traits: Traits = Field(default_factory=Traits)
    pose: Pose = Field(default_factory=Pose)
    importCompatibleGarments: list[str] | None = None


def create_default_profile(base_avatar_id: str = BUILT_IN_BASE_AVATAR_ID) -> dict:
    """对应 TS createDefaultProfile：morphs 全 0、boneScales 全 1.0。"""
    profile = AvatarProfile(
        schemaVersion=PROFILE_SCHEMA_VERSION,
        baseAvatarId=base_avatar_id,
        morphs=Morphs(**{k: 0 for k in MORPH_PARAM_KEYS}),
        boneScales=BoneScales(**{k: 1.0 for k in BONE_SCALE_PARAM_KEYS}),
    )
    return profile.model_dump(mode="json", exclude_none=True)


def validate_profile(data: object) -> tuple[dict | None, list[str]]:
    """校验并规范化 profile；返回 (profile_json, errors)。"""
    try:
        profile = AvatarProfile.model_validate(data)
    except ValidationError as exc:
        errors = [".".join(str(p) for p in e["loc"]) + f": {e['msg']}" for e in exc.errors()]
        return None, errors
    return profile.model_dump(mode="json", exclude_none=True), []


# ---------------------------------------------------------------------------
# garment.ts 对应模型（资产管理端校验用）
# ---------------------------------------------------------------------------

class LicenseInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(min_length=1)
    licenseId: str = Field(min_length=1)


class GarmentAssets(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str
    thumbnail: str | None = None


class GarmentManifest(BaseModel):
    """对应 garmentManifestSchema（type 仅限可穿戴四类）。"""
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$")
    version: str = Field(min_length=1)
    displayName: str = Field(min_length=1)
    type: Literal["garment", "hair", "accessory", "shoes"]
    category: SlotName
    slots: list[SlotName] = Field(min_length=1)
    layer: int = Field(10, ge=0, le=100)
    rigVersion: Literal["standard-rig-1"]
    compatibleBaseAvatars: list[str] = Field(min_length=1)
    shapeConstraints: dict[BoneScaleKey, tuple[float, float]] = Field(default_factory=dict)
    bodyMask: list[BodySectionName] = Field(default_factory=list)
    replacesSlots: list[SlotName] = Field(default_factory=list)
    restrictsTraits: dict[SlotName, list[str]] = Field(default_factory=dict)
    assets: GarmentAssets
    license: LicenseInfo


ASSET_TYPES = ["garment", "hair", "accessory", "shoes", "base_avatar", "animation"]
ASSET_STATUSES = ["draft", "validating", "published", "archived", "rejected"]


# ---------------------------------------------------------------------------
# import.ts 对应模型
# ---------------------------------------------------------------------------

class EditableProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    morphs: list[MorphKey] = Field(default_factory=list)
    materials: list[Literal["skinToneId", "skinRoughness", "eyeColorId"]] = Field(
        default_factory=list
    )


class ImportManifest(BaseModel):
    """对应 importManifestSchema。"""
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["1.0"]
    assetType: Literal["imported-avatar"]
    displayName: str = Field(min_length=1, max_length=64)
    rigVersion: Literal["standard-rig-1"]
    rigMap: dict[RigBoneName, str]  # 键：StandardRig 骨骼名；值：GLB 实际骨骼名
    bindPose: Literal["A_POSE", "T_POSE"]
    bodySections: list[BodySectionName] = Field(default_factory=list)
    editableProfile: EditableProfile = Field(default_factory=EditableProfile)
    compatibleGarments: list[str] = Field(default_factory=list)
    license: LicenseInfo


COMPATIBILITY_LEVELS = ["FULL", "POSE_ONLY", "REJECTED"]
IMPORT_STATES = [
    "uploaded", "validating", "accepted_full", "accepted_pose_only",
    "rejected", "activated", "archived",
]

# ---------------------------------------------------------------------------
# errors.ts 对应错误码
# ---------------------------------------------------------------------------

ERROR_CODES = {
    "VALIDATION_FAILED", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT",
    "RATE_LIMITED", "INTERNAL_ERROR",
    "AVATAR_VERSION_CONFLICT", "AVATAR_PROFILE_INVALID",
    "ASSET_NOT_FOUND", "ASSET_INCOMPATIBLE", "ASSET_NOT_PUBLISHED",
    "IMPORT_FILE_INVALID", "IMPORT_FORMAT_UNSUPPORTED", "IMPORT_RIG_INCOMPLETE",
    "IMPORT_LIMIT_EXCEEDED", "IMPORT_LICENSE_MISSING", "IMPORT_NOT_VALIDATED",
    "JOB_NOT_FOUND", "JOB_FAILED",
}
