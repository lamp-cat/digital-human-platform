"""程序化构造最小合法 GLB 的测试工具（纯 Python，与运行时校验器同规则）。"""
import json
import struct

STANDARD_RIG_BONES = [
    "Hips", "Spine", "Chest", "UpperChest", "Neck", "Head",
    "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
    "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
    "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
    "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
]

# StandardRig 父子关系（avatar-schema rig.ts RIG_HIERARCHY）
_HIERARCHY = {
    "Hips": None, "Spine": "Hips", "Chest": "Spine", "UpperChest": "Chest",
    "Neck": "UpperChest", "Head": "Neck",
    "LeftShoulder": "UpperChest", "LeftUpperArm": "LeftShoulder",
    "LeftLowerArm": "LeftUpperArm", "LeftHand": "LeftLowerArm",
    "RightShoulder": "UpperChest", "RightUpperArm": "RightShoulder",
    "RightLowerArm": "RightUpperArm", "RightHand": "RightLowerArm",
    "LeftUpperLeg": "Hips", "LeftLowerLeg": "LeftUpperLeg",
    "LeftFoot": "LeftLowerLeg", "LeftToes": "LeftFoot",
    "RightUpperLeg": "Hips", "RightLowerLeg": "RightUpperLeg",
    "RightFoot": "RightLowerLeg", "RightToes": "RightFoot",
}


def build_glb(
    *,
    bone_names: list[str] | None = None,
    with_skin: bool = True,
    vrm: str | None = None,  # None | "1.0" | "0.x"
    triangles: int = 12,
    gltf_version: str = "2.0",
) -> bytes:
    """构造一个最小 GLB：22 根骨骼节点 + 1 个带 JOINTS_0/WEIGHTS_0 的蒙皮网格。"""
    bones = bone_names or list(STANDARD_RIG_BONES)
    nodes = []
    children_map: dict[str, list[int]] = {}
    for i, name in enumerate(bones):
        parent = _HIERARCHY.get(name)
        if parent in bones:
            children_map.setdefault(parent, []).append(i)
    for name in bones:
        node: dict = {"name": name}
        if children_map.get(name):
            node["children"] = children_map[name]
        nodes.append(node)

    # 蒙皮网格节点
    vertex_count = max(24, triangles)
    index_count = triangles * 3
    accessors = [
        {"componentType": 5126, "count": vertex_count, "type": "VEC3"},  # 0 POSITION
        {"componentType": 5121, "count": vertex_count, "type": "VEC4"},  # 1 JOINTS_0
        {"componentType": 5126, "count": vertex_count, "type": "VEC4"},  # 2 WEIGHTS_0
        {"componentType": 5123, "count": index_count, "type": "SCALAR"},  # 3 indices
    ]
    attributes = {"POSITION": 0}
    if with_skin:
        attributes["JOINTS_0"] = 1
        attributes["WEIGHTS_0"] = 2
    meshes = [{"primitives": [{"attributes": attributes, "indices": 3, "mode": 4}]}]
    mesh_node: dict = {"name": "Body", "mesh": 0}
    if with_skin:
        mesh_node["skin"] = 0
    nodes.append(mesh_node)

    doc: dict = {
        "asset": {"version": gltf_version, "generator": "dhp-test-builder"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
        "meshes": meshes,
        "accessors": accessors,
    }
    if with_skin:
        doc["skins"] = [{"joints": list(range(len(bones))), "skeleton": 0}]
    if vrm == "1.0":
        human_bones = {}
        for i, name in enumerate(bones):
            # StandardRig → VRM humanoid 名（首字母小写的反向映射仅用于测试数据）
            vrm_name = _RIG_TO_VRM.get(name)
            if vrm_name:
                human_bones[vrm_name] = {"node": i}
        doc["extensions"] = {
            "VRMC_vrm": {"specVersion": "1.0", "humanoid": {"humanBones": human_bones}}
        }
        doc["extensionsUsed"] = ["VRMC_vrm"]
    elif vrm == "0.x":
        human_bones = []
        for i, name in enumerate(bones):
            vrm_name = _RIG_TO_VRM.get(name)
            if vrm_name:
                human_bones.append({"bone": vrm_name, "node": i})
        doc["extensions"] = {"VRM": {"specVersion": "0.0", "humanoid": {"humanBones": human_bones}}}
        doc["extensionsUsed"] = ["VRM"]

    json_bytes = json.dumps(doc).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)  # 4 字节对齐（空格填充）
    total = 12 + 8 + len(json_bytes)
    return (
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
    )


_RIG_TO_VRM = {
    "Hips": "hips", "Spine": "spine", "Chest": "chest", "UpperChest": "upperChest",
    "Neck": "neck", "Head": "head",
    "LeftShoulder": "leftShoulder", "LeftUpperArm": "leftUpperArm",
    "LeftLowerArm": "leftLowerArm", "LeftHand": "leftHand",
    "RightShoulder": "rightShoulder", "RightUpperArm": "rightUpperArm",
    "RightLowerArm": "rightLowerArm", "RightHand": "rightHand",
    "LeftUpperLeg": "leftUpperLeg", "LeftLowerLeg": "leftLowerLeg",
    "LeftFoot": "leftFoot", "LeftToes": "leftToes",
    "RightUpperLeg": "rightUpperLeg", "RightLowerLeg": "rightLowerLeg",
    "RightFoot": "rightFoot", "RightToes": "rightToes",
}


def build_manifest(**overrides) -> dict:
    """合法 import manifest：rigMap 覆盖全部最小骨架。"""
    manifest = {
        "schemaVersion": "1.0",
        "assetType": "imported-avatar",
        "displayName": "外部测试人物",
        "rigVersion": "standard-rig-1",
        "rigMap": {b: b for b in STANDARD_RIG_BONES},
        "bindPose": "T_POSE",
        "bodySections": ["body_head", "body_torso"],
        "editableProfile": {"morphs": ["faceWidth"], "materials": ["skinToneId"]},
        "compatibleGarments": ["top-hoodie-01", "bottom-jeans-01"],
        "license": {"source": "user-created", "licenseId": "user-confirmed"},
    }
    manifest.update(overrides)
    return manifest
