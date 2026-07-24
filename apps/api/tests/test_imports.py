"""外部模型导入：上传校验、分级、报告、激活、签名 URL、删除。"""
import json

from .conftest import auth_headers, register
from .glb_builder import STANDARD_RIG_BONES, build_glb, build_manifest


def _upload(client, token, model=b"", filename="model.glb", manifest=None, rights="true"):
    files = {"model": (filename, model, "model/gltf-binary")}
    if manifest is not None:
        files["manifest"] = ("manifest.json", json.dumps(manifest).encode(), "application/json")
    return client.post(
        "/api/v1/imports",
        files=files,
        data={"rightsConfirmed": rights},
        headers=auth_headers(token),
    )


def test_upload_rejects_non_glb(client, user_token):
    resp = _upload(client, user_token, model=b"definitely not a glb")
    assert resp.status_code == 422
    assert resp.json()["code"] == "IMPORT_FILE_INVALID"


def test_upload_rejects_bad_extension(client, user_token):
    resp = _upload(client, user_token, model=build_glb(), filename="model.fbx")
    assert resp.status_code == 422
    assert resp.json()["code"] == "IMPORT_FORMAT_UNSUPPORTED"


def test_upload_requires_rights_confirmation(client, user_token):
    resp = _upload(client, user_token, model=build_glb(), rights="false")
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_FAILED"


def test_gltf_v1_rejected(client, user_token):
    resp = _upload(client, user_token, model=build_glb(gltf_version="1.0"))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["job"]["status"] == "failed"
    assert body["job"]["errorCode"] == "IMPORT_FORMAT_UNSUPPORTED"
    rec = body["importRecord"]
    assert rec["status"] == "rejected"
    assert rec["compatibility"] == "REJECTED"

    resp = client.get(f"/api/v1/imports/{rec['id']}/report", headers=auth_headers(user_token))
    assert resp.status_code == 200
    report = resp.json()["report"]
    assert report["compatibility"] == "REJECTED"
    assert report["errorCode"] == "IMPORT_FORMAT_UNSUPPORTED"
    assert 1 <= len(report["suggestions"]) <= 3
    fmt = next(c for c in report["checks"] if c["name"] == "format")
    assert fmt["status"] == "fail"


def test_minimal_glb_pose_only(client, user_token):
    resp = _upload(client, user_token, model=build_glb())
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["job"]["status"] == "succeeded"
    rec = body["importRecord"]
    assert rec["status"] == "accepted_pose_only"
    assert rec["compatibility"] == "POSE_ONLY"

    resp = client.get(f"/api/v1/imports/{rec['id']}/report", headers=auth_headers(user_token))
    report = resp.json()["report"]
    assert report["compatibility"] == "POSE_ONLY"
    by_name = {c["name"]: c for c in report["checks"]}
    assert by_name["rig"]["status"] == "pass"
    assert by_name["skin"]["status"] == "pass"
    assert report["stats"]["mappedBones"] == 22


def test_glb_with_manifest_full(client, user_token):
    resp = _upload(client, user_token, model=build_glb(), manifest=build_manifest())
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["job"]["status"] == "succeeded"
    assert body["job"]["resultJson"]["compatibility"] == "FULL"
    rec = body["importRecord"]
    assert rec["status"] == "accepted_full"
    assert rec["compatibility"] == "FULL"
    assert rec["displayName"] == "外部测试人物"

    resp = client.get(f"/api/v1/imports/{rec['id']}/report", headers=auth_headers(user_token))
    report = resp.json()["report"]
    assert report["compatibility"] == "FULL"
    by_name = {c["name"]: c for c in report["checks"]}
    assert by_name["manifest"]["status"] == "pass"


def test_vrm10_pose_only_without_manifest(client, user_token):
    resp = _upload(client, user_token, model=build_glb(vrm="1.0"), filename="avatar.vrm")
    assert resp.status_code == 201, resp.text
    rec = resp.json()["importRecord"]
    assert rec["status"] == "accepted_pose_only"


def test_vrm10_missing_optional_bones_pose_only(client, user_token):
    """VRM 规范可选骨骼（UpperChest/肩/脚趾）缺失时回退映射，降级 POSE_ONLY 而非拒绝。"""
    optional = {"UpperChest", "LeftShoulder", "RightShoulder", "LeftToes", "RightToes"}
    bones = [b for b in STANDARD_RIG_BONES if b not in optional]
    resp = _upload(client, user_token, model=build_glb(vrm="1.0", bone_names=bones), filename="seed.vrm")
    assert resp.status_code == 201, resp.text
    rec = resp.json()["importRecord"]
    assert rec["status"] == "accepted_pose_only"
    resp = client.get(f"/api/v1/imports/{rec['id']}/report", headers=auth_headers(user_token))
    report = resp.json()["report"]
    by_name = {c["name"]: c for c in report["checks"]}
    assert by_name["rig"]["status"] == "warn"
    assert "UpperChest→Chest" in by_name["rig"]["message"]


def test_vrm0x_degraded_pose_only(client, user_token):
    resp = _upload(
        client, user_token, model=build_glb(vrm="0.x"), filename="old.vrm",
        manifest=build_manifest(),
    )
    assert resp.status_code == 201, resp.text
    rec = resp.json()["importRecord"]
    # 即使有 manifest，VRM 0.x 也封顶 POSE_ONLY
    assert rec["status"] == "accepted_pose_only"
    resp = client.get(f"/api/v1/imports/{rec['id']}/report", headers=auth_headers(user_token))
    report = resp.json()["report"]
    by_name = {c["name"]: c for c in report["checks"]}
    assert by_name["vrm"]["status"] == "warn"


def test_no_skin_rejected(client, user_token):
    resp = _upload(client, user_token, model=build_glb(with_skin=False))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["job"]["status"] == "failed"
    assert body["job"]["errorCode"] == "IMPORT_RIG_INCOMPLETE"
    assert body["importRecord"]["status"] == "rejected"


def test_incomplete_rig_rejected(client, user_token):
    bones = [b for b in STANDARD_RIG_BONES if b != "Head"]
    resp = _upload(client, user_token, model=build_glb(bone_names=bones))
    assert resp.status_code == 201, resp.text
    assert resp.json()["importRecord"]["status"] == "rejected"
    assert resp.json()["job"]["errorCode"] == "IMPORT_RIG_INCOMPLETE"


def test_list_and_get_import(client, user_token):
    rec = _upload(client, user_token, model=build_glb()).json()["importRecord"]
    resp = client.get("/api/v1/imports", headers=auth_headers(user_token))
    assert resp.status_code == 200
    assert any(i["id"] == rec["id"] for i in resp.json()["imports"])

    resp = client.get(f"/api/v1/imports/{rec['id']}", headers=auth_headers(user_token))
    assert resp.status_code == 200
    detail = resp.json()["importRecord"]
    assert detail["status"] == "accepted_pose_only"
    assert detail["modelUrl"].startswith(f"/api/v1/imports/{rec['id']}/model?token=")
    assert detail["displayName"]
    assert "previewUrl" in detail


def test_activate_full_creates_avatar(client, user_token):
    rec = _upload(
        client, user_token, model=build_glb(), manifest=build_manifest()
    ).json()["importRecord"]
    resp = client.post(
        f"/api/v1/imports/{rec['id']}/activate",
        json={"name": "导入人物"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 201, resp.text
    avatar = resp.json()["avatar"]
    assert avatar["baseAvatarId"] == f"imported-{rec['id']}"
    assert avatar["assetSource"] == {
        "type": "imported", "importId": rec["id"], "compatibility": "FULL"
    }
    assert avatar["profile"]["importCompatibleGarments"] == ["top-hoodie-01", "bottom-jeans-01"]

    # 导入记录状态推进为 activated
    resp = client.get(f"/api/v1/imports/{rec['id']}", headers=auth_headers(user_token))
    assert resp.json()["importRecord"]["status"] == "activated"


def test_activate_pose_only(client, user_token):
    rec = _upload(client, user_token, model=build_glb()).json()["importRecord"]
    resp = client.post(
        f"/api/v1/imports/{rec['id']}/activate",
        json={"name": "仅动作"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 201, resp.text
    avatar = resp.json()["avatar"]
    assert avatar["assetSource"]["compatibility"] == "POSE_ONLY"
    assert avatar["profile"].get("importCompatibleGarments") is None


def test_activate_rejected_conflict(client, user_token):
    rec = _upload(client, user_token, model=build_glb(with_skin=False)).json()["importRecord"]
    resp = client.post(
        f"/api/v1/imports/{rec['id']}/activate",
        json={"name": "不应成功"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "IMPORT_NOT_VALIDATED"


def test_signed_model_url(client, user_token):
    glb = build_glb()
    rec = _upload(client, user_token, model=glb).json()["importRecord"]

    # 合法签名可下载（无需 Bearer）
    resp = client.get(rec["modelUrl"])
    assert resp.status_code == 200
    assert resp.content == glb

    # 坏签名 → 403
    resp = client.get(f"/api/v1/imports/{rec['id']}/model?token=9999999999.deadbeef")
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"

    resp = client.get(f"/api/v1/imports/{rec['id']}/model")
    assert resp.status_code == 403


def test_delete_import(client, user_token):
    rec = _upload(client, user_token, model=build_glb()).json()["importRecord"]
    resp = client.delete(f"/api/v1/imports/{rec['id']}", headers=auth_headers(user_token))
    assert resp.status_code == 204
    resp = client.get(f"/api/v1/imports/{rec['id']}", headers=auth_headers(user_token))
    assert resp.status_code == 404
    # 签名 URL 同步失效
    resp = client.get(rec["modelUrl"])
    assert resp.status_code == 404


def test_import_isolation(client, user_token):
    rec = _upload(client, user_token, model=build_glb()).json()["importRecord"]
    other = register(client, email="other2@test.local")["token"]
    resp = client.get(f"/api/v1/imports/{rec['id']}", headers=auth_headers(other))
    assert resp.status_code == 404
    resp = client.get("/api/v1/imports", headers=auth_headers(other))
    assert all(i["id"] != rec["id"] for i in resp.json()["imports"])
