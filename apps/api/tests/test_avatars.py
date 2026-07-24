"""角色 CRUD、乐观锁、profile 校验、复制、软删除、封面。"""
import base64

from .conftest import auth_headers

_TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _create(client, token, name="我的数字人"):
    resp = client.post("/api/v1/avatars", json={"name": name}, headers=auth_headers(token))
    assert resp.status_code == 201, resp.text
    return resp.json()["avatar"]


def test_create_and_get(client, user_token):
    avatar = _create(client, user_token)
    assert avatar["version"] == 1
    assert avatar["baseAvatarId"] == "base-adult-v1"
    assert avatar["coverUrl"] is None
    profile = avatar["profile"]
    assert profile["schemaVersion"] == "1.0"
    assert profile["assetSource"] == {"type": "built_in"}
    # 默认 profile：morphs 11 键全 0，boneScales 4 键全 1.0
    assert len(profile["morphs"]) == 11
    assert profile["morphs"]["faceWidth"] == 0
    assert profile["boneScales"] == {
        "height": 1.0, "shoulderWidth": 1.0, "torsoLength": 1.0, "legLength": 1.0
    }
    assert profile["materials"]["skinToneId"] == "warm-03"
    assert profile["pose"] == {"mode": "idle", "animationId": "idle-01"}

    resp = client.get(f"/api/v1/avatars/{avatar['id']}", headers=auth_headers(user_token))
    assert resp.status_code == 200
    assert resp.json()["avatar"]["assetSource"] == {"type": "built_in"}


def test_list_only_own(client, user_token):
    _create(client, user_token, "A")
    _create(client, user_token, "B")
    resp = client.get("/api/v1/avatars", headers=auth_headers(user_token))
    assert resp.status_code == 200
    assert len(resp.json()["avatars"]) == 2


def test_patch_success_and_version_snapshot(client, user_token):
    avatar = _create(client, user_token)
    profile = avatar["profile"]
    profile["morphs"]["faceWidth"] = 0.5
    profile["traits"]["top"] = "top-hoodie-01"
    resp = client.patch(
        f"/api/v1/avatars/{avatar['id']}",
        json={"expectedVersion": 1, "profile": profile, "name": "改名"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200, resp.text
    saved = resp.json()["avatar"]
    assert saved["version"] == 2
    assert saved["name"] == "改名"
    assert saved["profile"]["morphs"]["faceWidth"] == 0.5
    assert saved["profile"]["traits"]["top"] == "top-hoodie-01"


def test_patch_version_conflict(client, user_token):
    avatar = _create(client, user_token)
    profile = avatar["profile"]
    # 先保存一次，版本升到 2
    client.patch(
        f"/api/v1/avatars/{avatar['id']}",
        json={"expectedVersion": 1, "profile": profile},
        headers=auth_headers(user_token),
    )
    # 用旧版本再保存 → 409
    resp = client.patch(
        f"/api/v1/avatars/{avatar['id']}",
        json={"expectedVersion": 1, "profile": profile},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "AVATAR_VERSION_CONFLICT"
    assert body["details"]["latestVersion"] == 2
    assert body["details"]["latestProfile"]["baseAvatarId"] == "base-adult-v1"


def test_patch_invalid_profile_value(client, user_token):
    avatar = _create(client, user_token)
    profile = avatar["profile"]
    profile["morphs"]["faceWidth"] = 5  # 超出 [-1, 1]
    resp = client.patch(
        f"/api/v1/avatars/{avatar['id']}",
        json={"expectedVersion": 1, "profile": profile},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "AVATAR_PROFILE_INVALID"


def test_patch_unknown_profile_field(client, user_token):
    avatar = _create(client, user_token)
    profile = avatar["profile"]
    profile["morphs"]["notARealMorph"] = 0.1  # 未知键
    resp = client.patch(
        f"/api/v1/avatars/{avatar['id']}",
        json={"expectedVersion": 1, "profile": profile},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 422

    profile = avatar["profile"]
    profile["boneScales"]["height"] = 2.0  # 超出 [0.85, 1.15]
    resp = client.patch(
        f"/api/v1/avatars/{avatar['id']}",
        json={"expectedVersion": 1, "profile": profile},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 422


def test_duplicate(client, user_token):
    avatar = _create(client, user_token)
    resp = client.post(
        f"/api/v1/avatars/{avatar['id']}/duplicate", headers=auth_headers(user_token)
    )
    assert resp.status_code == 201
    dup = resp.json()["avatar"]
    assert dup["id"] != avatar["id"]
    assert dup["version"] == 1
    assert "副本" in dup["name"]
    assert dup["profile"]["morphs"] == avatar["profile"]["morphs"]


def test_soft_delete(client, user_token):
    avatar = _create(client, user_token)
    resp = client.delete(f"/api/v1/avatars/{avatar['id']}", headers=auth_headers(user_token))
    assert resp.status_code == 204
    resp = client.get(f"/api/v1/avatars/{avatar['id']}", headers=auth_headers(user_token))
    assert resp.status_code == 404
    resp = client.get("/api/v1/avatars", headers=auth_headers(user_token))
    assert all(a["id"] != avatar["id"] for a in resp.json()["avatars"])


def test_cover_base64_and_get(client, user_token):
    avatar = _create(client, user_token)
    resp = client.post(
        f"/api/v1/avatars/{avatar['id']}/cover",
        json={"imageBase64": base64.b64encode(_TINY_PNG).decode()},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200, resp.text
    cover_url = resp.json()["avatar"]["coverUrl"]
    assert cover_url == f"/api/v1/avatars/{avatar['id']}/cover"

    resp = client.get(cover_url, headers=auth_headers(user_token))
    assert resp.status_code == 200
    assert resp.content == _TINY_PNG


def test_cover_multipart(client, user_token):
    avatar = _create(client, user_token)
    resp = client.post(
        f"/api/v1/avatars/{avatar['id']}/cover",
        files={"file": ("cover.png", _TINY_PNG, "image/png")},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200
    assert resp.json()["avatar"]["coverUrl"]


def test_cover_invalid_bytes(client, user_token):
    avatar = _create(client, user_token)
    resp = client.post(
        f"/api/v1/avatars/{avatar['id']}/cover",
        json={"imageBase64": base64.b64encode(b"not-an-image").decode()},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 422


def test_avatar_isolation(client, user_token):
    # 其他用户不能访问
    avatar = _create(client, user_token)
    from .conftest import register

    other = register(client, email="other@test.local")["token"]
    resp = client.get(f"/api/v1/avatars/{avatar['id']}", headers=auth_headers(other))
    assert resp.status_code == 404
