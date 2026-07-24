"""GLB/VRM 校验器（开发文档 §8.4）：纯 Python 解析，不依赖第三方 glTF 库。

分级规则：
- 解析失败 / 非 glTF 2.0 / 骨架映射不完整 / 无蒙皮 / 超限 → REJECTED
- VRM 1.0 或骨架映射完整的 GLB → 至少 POSE_ONLY（VRM 0.x 封顶 POSE_ONLY）
- 且附带合法 Import Manifest（rigMap 覆盖最小骨架、声明 bodySections 与 license）→ FULL
"""
import json
import struct
from dataclasses import dataclass, field

from pydantic import ValidationError

from .schemas import (
    COMMON_NAME_TO_RIG,
    MINIMAL_RIG_BONES,
    VRM_HUMANOID_TO_RIG,
    ImportManifest,
)

VALIDATOR_VERSION = "1.0.0"
MAX_TEXTURE_SIZE = 4096

# 核心骨架：缺失即拒绝（VRM 1.0 规范中的必需骨骼，动捕/换装无法回退）。
CORE_RIG_BONES = [
    "Hips", "Spine", "Chest", "Neck", "Head",
    "LeftUpperArm", "LeftLowerArm", "LeftHand",
    "RightUpperArm", "RightLowerArm", "RightHand",
    "LeftUpperLeg", "LeftLowerLeg", "LeftFoot",
    "RightUpperLeg", "RightLowerLeg", "RightFoot",
]

# VRM 1.0 规范中的可选骨骼：缺失时回退映射到最近的已存在祖先骨骼（§8.4 降级为 POSE_ONLY）。
# 注意顺序：先解析 UpperChest，肩/脚趾再以其为依据。
FALLBACK_BONE_MAP = {
    "UpperChest": "Chest",
    "LeftShoulder": "UpperChest",
    "RightShoulder": "UpperChest",
    "LeftToes": "LeftFoot",
    "RightToes": "RightFoot",
}


def resolve_optional_fallbacks(mapping: dict) -> list[str]:
    """为缺失的可选骨骼补齐回退映射，返回 'Bone→Target' 说明列表。"""
    applied: list[str] = []
    for bone, target in FALLBACK_BONE_MAP.items():
        if bone in mapping:
            continue
        resolved = target
        while resolved not in mapping and resolved in FALLBACK_BONE_MAP:
            resolved = FALLBACK_BONE_MAP[resolved]
        if resolved in mapping:
            mapping[bone] = mapping[resolved]
            applied.append(f"{bone}→{resolved}")
    return applied


class GlbParseError(Exception):
    pass


@dataclass
class Check:
    name: str
    status: str  # pass / warn / fail
    message: str
    suggestion: str | None = None
    errorCode: str | None = None

    def to_dict(self) -> dict:
        d: dict = {"name": self.name, "status": self.status, "message": self.message}
        if self.suggestion:
            d["suggestion"] = self.suggestion
        if self.errorCode:
            d["errorCode"] = self.errorCode
        return d


@dataclass
class ValidationResult:
    compatibility: str  # FULL / POSE_ONLY / REJECTED
    checks: list[Check] = field(default_factory=list)
    error_code: str | None = None
    manifest: ImportManifest | None = None  # 校验通过的 manifest（若有）
    stats: dict = field(default_factory=dict)

    @property
    def report(self) -> dict:
        suggestions: list[str] = []
        for c in self.checks:
            if c.status in ("fail", "warn") and c.suggestion and c.suggestion not in suggestions:
                suggestions.append(c.suggestion)
        failed = [c for c in self.checks if c.status == "fail"]
        if self.compatibility == "FULL":
            summary = "校验通过：可动作控制，支持平台通用换装"
        elif self.compatibility == "POSE_ONLY":
            summary = "校验通过：可动作控制，不支持 V1 通用换装"
        else:
            summary = f"校验未通过：{failed[0].message if failed else '未知错误'}"
        return {
            "validatorVersion": VALIDATOR_VERSION,
            "compatibility": self.compatibility,
            "errorCode": self.error_code,
            "summary": summary,
            "checks": [c.to_dict() for c in self.checks],
            "suggestions": suggestions[:3],  # 不超过 3 条可执行修复建议
            "stats": self.stats,
        }


def parse_glb(data: bytes) -> dict:
    """解析 GLB 容器，返回 JSON chunk 对应的 glTF 文档。"""
    if len(data) < 12:
        raise GlbParseError("文件太小，不是合法 GLB")
    magic, _version, total_length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise GlbParseError("文件魔数不是 glTF（GLB）")
    if total_length > len(data):
        raise GlbParseError("GLB 头声明的长度超出实际文件大小")
    offset = 12
    json_chunk: bytes | None = None
    while offset + 8 <= min(total_length, len(data)):
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == 0x4E4F534A:  # "JSON"
            json_chunk = chunk
    if json_chunk is None:
        raise GlbParseError("GLB 中未找到 JSON chunk")
    try:
        doc = json.loads(json_chunk.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GlbParseError(f"glTF JSON 解析失败: {exc}") from exc
    if not isinstance(doc, dict):
        raise GlbParseError("glTF JSON 不是对象")
    return doc


def detect_vrm(doc: dict) -> str | None:
    """返回 '1.0' / '0.x' / None。"""
    extensions = doc.get("extensions") or {}
    used = set(doc.get("extensionsUsed") or []) | set(extensions.keys())
    if "VRMC_vrm" in used:
        return "1.0"
    if "VRM" in used:
        return "0.x"
    return None


def _vrm_humanoid_map(doc: dict, vrm_version: str) -> dict[str, int]:
    """从 VRM extensions 提取 StandardRig 骨骼名 → node index。"""
    extensions = doc.get("extensions") or {}
    mapping: dict[str, int] = {}
    if vrm_version == "1.0":
        human_bones = (
            (extensions.get("VRMC_vrm") or {}).get("humanoid") or {}
        ).get("humanBones") or {}
        # 1.0：{hips: {node: 0}, ...}
        for name, info in human_bones.items():
            rig = VRM_HUMANOID_TO_RIG.get(name)
            node = (info or {}).get("node") if isinstance(info, dict) else None
            if rig and isinstance(node, int):
                mapping[rig] = node
    else:
        human_bones = ((extensions.get("VRM") or {}).get("humanoid") or {}).get(
            "humanBones"
        ) or []
        # 0.x：[{bone: "hips", node: 0}, ...]
        for info in human_bones:
            if not isinstance(info, dict):
                continue
            rig = VRM_HUMANOID_TO_RIG.get(info.get("bone", ""))
            node = info.get("node")
            if rig and isinstance(node, int):
                mapping[rig] = node
    return mapping


def _node_names(doc: dict) -> list[str]:
    return [str(n.get("name", "")) for n in doc.get("nodes") or []]


def _build_rig_mapping(
    doc: dict, vrm_version: str | None, manifest: ImportManifest | None
) -> tuple[dict[str, int], list[str], list[str]]:
    """返回 (StandardRig名→node index, 已命中骨骼列表, 无法识别的骨骼名列表)。"""
    nodes = doc.get("nodes") or []
    names = _node_names(doc)
    name_to_index: dict[str, int] = {}
    for idx, name in enumerate(names):
        if name and name not in name_to_index:
            name_to_index[name] = idx

    mapping: dict[str, int] = {}
    unmatched: list[str] = []

    if vrm_version:
        # VRM：以 humanoid.humanBones 为准（显式映射，不猜测）
        mapping = _vrm_humanoid_map(doc, vrm_version)
    else:
        # GLB：先按显式名称表匹配（StandardRig 原名 / mixamo 常见名）
        for name, idx in name_to_index.items():
            rig = COMMON_NAME_TO_RIG.get(name)
            if rig and rig not in mapping:
                mapping[rig] = idx
        # 再用 manifest.rigMap 显式覆盖/补充
        if manifest:
            for rig, actual in manifest.rigMap.items():
                if actual in name_to_index:
                    mapping[rig] = name_to_index[actual]
                else:
                    unmatched.append(actual)

    # 无法识别的节点名（仅统计，用于报告）
    recognized = set(mapping.values())
    for name, idx in name_to_index.items():
        if idx not in recognized and name not in COMMON_NAME_TO_RIG:
            unmatched.append(name)
    return mapping, sorted(mapping.keys()), unmatched


def _count_triangles(doc: dict) -> int:
    accessors = doc.get("accessors") or []
    total = 0
    for mesh in doc.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            if prim.get("mode", 4) != 4:  # 仅统计 TRIANGLES
                continue
            if "indices" in prim:
                idx_acc = accessors[prim["indices"]] if prim["indices"] < len(accessors) else {}
                total += int(idx_acc.get("count", 0)) // 3
            else:
                pos = (prim.get("attributes") or {}).get("POSITION")
                if isinstance(pos, int) and pos < len(accessors):
                    total += int(accessors[pos].get("count", 0)) // 3
    return total


def validate_glb(
    data: bytes,
    manifest_bytes: bytes | None,
    *,
    max_triangles: int,
    recommended_triangles: int = 80_000,
) -> ValidationResult:
    """校验入口：返回分级结果与结构化报告。"""
    checks: list[Check] = []
    stats: dict = {"fileBytes": len(data)}

    # 1. 文件安全：魔数与容器结构
    try:
        doc = parse_glb(data)
    except GlbParseError as exc:
        checks.append(
            Check("file", "fail", str(exc), "请导出为二进制 GLB/VRM（glTF-Binary）格式", "IMPORT_FILE_INVALID")
        )
        return ValidationResult("REJECTED", checks, "IMPORT_FILE_INVALID", stats=stats)

    # 2. 格式：glTF 2.0
    asset = doc.get("asset") or {}
    gltf_version = str(asset.get("version", ""))
    if not gltf_version.startswith("2"):
        checks.append(
            Check(
                "format", "fail", f"glTF 版本 {gltf_version or '未知'}，平台要求 2.0",
                "请在导出工具中选择 glTF 2.0 / GLB 格式重新导出", "IMPORT_FORMAT_UNSUPPORTED",
            )
        )
        return ValidationResult("REJECTED", checks, "IMPORT_FORMAT_UNSUPPORTED", stats=stats)
    checks.append(Check("format", "pass", f"glTF {gltf_version}"))

    # 3. VRM 识别
    vrm_version = detect_vrm(doc)
    stats["isVrm"] = bool(vrm_version)
    stats["vrmVersion"] = vrm_version
    if vrm_version == "0.x":
        checks.append(
            Check(
                "vrm", "warn",
                "检测到 VRM 0.x，V1 按 POSE_ONLY 降级处理",
                "建议使用 VRM 1.0 导出以获得完整换装能力",
            )
        )
    elif vrm_version == "1.0":
        checks.append(Check("vrm", "pass", "检测到 VRM 1.0"))

    # 4. Manifest（若提供）：先用 Pydantic 严格校验，失败则仅警告（封顶 POSE_ONLY）
    manifest: ImportManifest | None = None
    manifest_ok = False
    manifest_error_code: str | None = None
    manifest_msg = ""
    if manifest_bytes is not None:
        try:
            manifest_raw = json.loads(manifest_bytes.decode("utf-8"))
            manifest = ImportManifest.model_validate(manifest_raw)
            manifest_ok = True
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            manifest_msg = f"manifest.json 不是合法 JSON：{exc}"
            manifest_error_code = "IMPORT_FILE_INVALID"
        except ValidationError as exc:
            manifest_msg = "manifest.json 字段校验失败：" + "; ".join(
                ".".join(str(p) for p in e["loc"]) + f" {e['msg']}" for e in exc.errors()[:5]
            )
            license_related = any("license" in e.get("loc", ()) for e in exc.errors())
            manifest_error_code = "IMPORT_LICENSE_MISSING" if license_related else "IMPORT_FILE_INVALID"
    stats["hasManifest"] = manifest_bytes is not None

    # 5. 骨架：收集骨骼并映射到 StandardRig
    mapping, matched, _unmatched = _build_rig_mapping(doc, vrm_version, manifest)
    stats["nodeCount"] = len(doc.get("nodes") or [])
    stats["mappedBones"] = len(matched)
    missing_core = [b for b in CORE_RIG_BONES if b not in mapping]
    fallbacks_applied = resolve_optional_fallbacks(mapping)
    stats["optionalFallbacks"] = fallbacks_applied
    if not mapping:
        checks.append(
            Check(
                "rig", "fail", "未识别到任何人形骨骼",
                "请按 StandardRig 骨骼命名（如 Hips/Spine/Head）绑定，或随模型提交 manifest.json 的 rigMap",
                "IMPORT_RIG_INCOMPLETE",
            )
        )
    elif missing_core:
        checks.append(
            Check(
                "rig", "fail",
                f"核心骨架缺失 {len(missing_core)} 根：{', '.join(missing_core[:5])}{'…' if len(missing_core) > 5 else ''}",
                "补齐核心骨架绑定或在 manifest.rigMap 中显式映射后重新导出",
                "IMPORT_RIG_INCOMPLETE",
            )
        )
    elif fallbacks_applied:
        checks.append(
            Check(
                "rig", "warn",
                f"核心骨架完整（{len(matched)} 根已映射）；可选骨骼已回退映射：{', '.join(fallbacks_applied)}",
                "如需完整换装能力，请补齐全部 22 根 StandardRig 骨骼绑定",
            )
        )
    else:
        checks.append(Check("rig", "pass", f"最小骨架映射完整（{len(matched)}/22）"))

    # 6. 蒙皮：skins 非空且蒙皮网格带 JOINTS_0/WEIGHTS_0
    skins = doc.get("skins") or []
    meshes = doc.get("meshes") or []
    nodes = doc.get("nodes") or []
    skinned_mesh_ok = True
    skinned_count = 0
    if skins:
        for node in nodes:
            if "mesh" not in node or "skin" not in node:
                continue
            mesh_idx = node["mesh"]
            if not isinstance(mesh_idx, int) or mesh_idx >= len(meshes):
                continue
            skinned_count += 1
            for prim in meshes[mesh_idx].get("primitives") or []:
                attrs = prim.get("attributes") or {}
                if "JOINTS_0" not in attrs or "WEIGHTS_0" not in attrs:
                    skinned_mesh_ok = False
    stats["skinnedMeshes"] = skinned_count
    if not skins:
        checks.append(
            Check(
                "skin", "fail", "模型不包含蒙皮（skins 为空）",
                "请在建模工具中完成骨骼蒙皮绑定后再导出", "IMPORT_RIG_INCOMPLETE",
            )
        )
    elif skinned_count == 0 or not skinned_mesh_ok:
        checks.append(
            Check(
                "skin", "fail", "蒙皮网格缺少 JOINTS_0/WEIGHTS_0 顶点属性",
                "请检查蒙皮权重导出设置，确保导出关节与权重", "IMPORT_RIG_INCOMPLETE",
            )
        )
    else:
        checks.append(Check("skin", "pass", f"蒙皮完整（{len(skins)} 个 skin）"))

    # 7. 性能：三角面数
    triangles = _count_triangles(doc)
    stats["triangles"] = triangles
    if triangles > max_triangles:
        checks.append(
            Check(
                "triangles", "fail",
                f"三角面数 {triangles} 超过硬上限 {max_triangles}",
                "请离线减面（建议 ≤ 80k）后重新导出", "IMPORT_LIMIT_EXCEEDED",
            )
        )
    elif triangles > recommended_triangles:
        checks.append(
            Check(
                "triangles", "warn",
                f"三角面数 {triangles} 超过建议值 {recommended_triangles}，可能影响实时驱动性能",
                "建议减面至 80k 以下",
            )
        )
    else:
        checks.append(Check("triangles", "pass", f"三角面数 {triangles}"))

    # 8. 贴图尺寸（仅在 glTF 中带有尺寸信息时检查）
    oversized = []
    for img in doc.get("images") or []:
        extras = img.get("extras") or {}
        w, h = extras.get("width"), extras.get("height")
        if isinstance(w, int) and w > MAX_TEXTURE_SIZE or isinstance(h, int) and h > MAX_TEXTURE_SIZE:
            oversized.append(img.get("name") or img.get("uri") or "?")
    if oversized:
        checks.append(
            Check(
                "textures", "warn",
                f"{len(oversized)} 张贴图超过 {MAX_TEXTURE_SIZE}px：{', '.join(map(str, oversized[:3]))}",
                "建议将贴图压缩到 2048×2048 以内",
            )
        )
    else:
        checks.append(Check("textures", "pass", "贴图尺寸未超限"))

    # 9. Manifest 结果与 FULL 换装条件
    if manifest_bytes is not None and not manifest_ok:
        checks.append(
            Check(
                "manifest", "warn",
                f"manifest.json 未通过校验：{manifest_msg}；本次最高只能 POSE_ONLY",
                "按 import manifest 规范修正 schemaVersion/rigMap/license 等字段",
                manifest_error_code,
            )
        )
    elif manifest_ok and manifest is not None:
        rig_map_cover = [b for b in CORE_RIG_BONES if b not in manifest.rigMap]
        if rig_map_cover:
            manifest_ok = False
            checks.append(
                Check(
                    "manifest", "warn",
                    f"manifest.rigMap 未覆盖全部核心骨架（缺 {len(rig_map_cover)} 根）",
                    "在 rigMap 中补齐核心 StandardRig 骨骼映射",
                    "IMPORT_RIG_INCOMPLETE",
                )
            )
        elif not manifest.bodySections:
            manifest_ok = False
            checks.append(
                Check(
                    "manifest", "warn",
                    "manifest 未声明 bodySections 身体分区，无法支持换装",
                    "在 manifest.json 中声明 body_* 分区",
                )
            )
        else:
            checks.append(Check("manifest", "pass", "Import Manifest 校验通过"))

    # 分级
    failed = [c for c in checks if c.status == "fail"]
    if failed:
        compatibility = "REJECTED"
        error_code = failed[0].errorCode or "IMPORT_FILE_INVALID"
    elif vrm_version == "0.x":
        compatibility, error_code = "POSE_ONLY", None
    elif manifest_ok:
        compatibility, error_code = "FULL", None
    else:
        compatibility, error_code = "POSE_ONLY", None

    return ValidationResult(compatibility, checks, error_code, manifest=manifest, stats=stats)
