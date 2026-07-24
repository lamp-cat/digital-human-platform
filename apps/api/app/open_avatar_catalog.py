"""随平台发布的开源人物目录。

模型文件由 Web 应用从 /open-avatars/ 静态目录提供；API 只负责返回经过
许可证审核的元数据，并在创建人物时校验 assetId，避免客户端伪造任意路径。
"""

from copy import deepcopy


OPEN_AVATARS: tuple[dict, ...] = (
    {
        "id": "quaternius-male",
        "displayName": "拟真人物 · 男",
        "category": "拟真人物",
        "description": "标准成人比例、完整五指骨骼，适合舞蹈复现和全身动作。",
        "creator": "Quaternius",
        "modelUrl": "/open-avatars/models/quaternius-male.glb",
        "thumbnailUrl": "/open-avatars/thumbnails/quaternius.png",
        "sourceUrl": "https://quaternius.com/packs/universalbasecharacters.html",
        "licenseId": "CC0-1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "转体", "手指骨骼"],
    },
    {
        "id": "quaternius-female",
        "displayName": "拟真人物 · 女",
        "category": "拟真人物",
        "description": "标准成人比例、完整五指骨骼，适合直播和真人视频复现。",
        "creator": "Quaternius",
        "modelUrl": "/open-avatars/models/quaternius-female.glb",
        "thumbnailUrl": "/open-avatars/thumbnails/quaternius.png",
        "sourceUrl": "https://quaternius.com/packs/universalbasecharacters.html",
        "licenseId": "CC0-1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "转体", "手指骨骼"],
    },
    {
        "id": "kaykit-mage",
        "displayName": "卡通法师",
        "category": "卡通人物",
        "description": "轻量低多边形法师，内含人形骨架和丰富原生动画。",
        "creator": "Kay Lousberg",
        "modelUrl": "/open-avatars/models/kaykit-mage.glb",
        "thumbnailUrl": "/open-avatars/thumbnails/kaykit.png",
        "sourceUrl": "https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0",
        "licenseId": "CC0-1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "转体", "轻量模型"],
    },
    {
        "id": "kaykit-knight",
        "displayName": "卡通骑士",
        "category": "卡通人物",
        "description": "轻量低多边形骑士，适合游戏化直播间和趣味视频。",
        "creator": "Kay Lousberg",
        "modelUrl": "/open-avatars/models/kaykit-knight.glb",
        "thumbnailUrl": "/open-avatars/thumbnails/kaykit.png",
        "sourceUrl": "https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0",
        "licenseId": "CC0-1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "转体", "轻量模型"],
    },
    {
        "id": "avatar-sample-a",
        "displayName": "动漫少女 A",
        "category": "VTuber / 动漫",
        "description": "VRoid 官方样例，支持完整人形与手指骨骼、眨眼和口型表情。",
        "creator": "VRoid",
        "modelUrl": "/open-avatars/models/avatar-sample-a.vrm",
        "thumbnailUrl": "/open-avatars/thumbnails/avatar-sample-a.png",
        "sourceUrl": "https://github.com/madjin/vrm-samples",
        "licenseId": "VRoid-Sample-Terms",
        "licenseUrl": "https://vroid.pixiv.help/hc/en-us/articles/4402394424089",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "手指骨骼", "面部表情"],
    },
    {
        "id": "seed-san",
        "displayName": "科幻 Seed-san",
        "category": "VTuber / 动漫",
        "description": "VirtualCast 官方 VRM 角色，适合科幻风直播与动作演示。",
        "creator": "VirtualCast, Inc.",
        "modelUrl": "/open-avatars/models/seed-san.vrm",
        "thumbnailUrl": "/open-avatars/thumbnails/seed-san.jpg",
        "sourceUrl": "https://github.com/madjin/vrm-samples/tree/master/Seed-san",
        "licenseId": "VRM-Public-1.0",
        "licenseUrl": "https://vrm.dev/en/licenses/1.0/",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "手指骨骼", "面部表情"],
    },
    {
        "id": "chibi-bear",
        "displayName": "二头身潮流小熊",
        "category": "二头身动物",
        "description": "Lil Teddy 原创 CC0 角色，短肢体与大头比例适合萌系直播。",
        "creator": "Polygonal Mind / Open Source Avatars",
        "modelUrl": "/open-avatars/models/chibi-bear.vrm",
        "thumbnailUrl": "/open-avatars/thumbnails/chibi-bear.png",
        "sourceUrl": "https://github.com/ToxSam/open-source-avatars",
        "licenseId": "CC0-1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "转体", "二头身"],
    },
    {
        "id": "chibi-fox",
        "displayName": "二头身机甲狐狸",
        "category": "二头身动物",
        "description": "Megan The Fox 原创 CC0 角色，夸张四肢适合动作和舞蹈。",
        "creator": "Polygonal Mind / Open Source Avatars",
        "modelUrl": "/open-avatars/models/chibi-fox.vrm",
        "thumbnailUrl": "/open-avatars/thumbnails/chibi-fox.png",
        "sourceUrl": "https://github.com/ToxSam/open-source-avatars",
        "licenseId": "CC0-1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "转体", "部分手指"],
    },
    {
        "id": "chibi-dog",
        "displayName": "二头身汉堡柴犬",
        "category": "二头身动物",
        "description": "Dogo Burger 原创 CC0 角色，圆润轮廓适合趣味直播和短视频。",
        "creator": "Polygonal Mind / Open Source Avatars",
        "modelUrl": "/open-avatars/models/chibi-dog.vrm",
        "thumbnailUrl": "/open-avatars/thumbnails/chibi-dog.png",
        "sourceUrl": "https://github.com/ToxSam/open-source-avatars",
        "licenseId": "CC0-1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "compatibility": "POSE_ONLY",
        "capabilities": ["全身动作", "转体", "基础手指"],
    },
)

_OPEN_AVATAR_BY_ID = {item["id"]: item for item in OPEN_AVATARS}


def list_open_avatars() -> list[dict]:
    return deepcopy(list(OPEN_AVATARS))


def get_open_avatar(asset_id: str) -> dict | None:
    item = _OPEN_AVATAR_BY_ID.get(asset_id)
    return deepcopy(item) if item is not None else None
