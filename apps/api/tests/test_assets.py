"""资产目录：种子资产、筛选、缩略图、管理端权限与流程。"""
from .conftest import auth_headers


def test_seed_assets_listed(client, user_token):
    resp = client.get("/api/v1/assets", headers=auth_headers(user_token))
    assert resp.status_code == 200
    assets = {a["id"]: a for a in resp.json()["assets"]}
    # 契约要求的关键种子资产
    for asset_id in [
        "base-adult-v1", "hair-short-01", "hair-long-01",
        "top-hoodie-01", "top-tee-01", "top-jacket-01",
        "bottom-jeans-01", "bottom-shorts-01",
        "shoes-sneaker-01", "shoes-leather-01",
        "acc-glasses-01", "acc-cap-01", "acc-watch-01",
        "anim-idle-01", "anim-wave-01", "anim-walk-01",
    ]:
        assert asset_id in assets, f"缺少种子资产 {asset_id}"

    hoodie = assets["top-hoodie-01"]
    assert hoodie["type"] == "garment"
    assert hoodie["category"] == "top"
    assert hoodie["layer"] == 20
    assert hoodie["status"] == "published"
    assert hoodie["license"] == {"source": "self-created", "licenseId": "project-owned"}
    assert hoodie["assets"]["model"] == "procedural:top-hoodie-01"
    assert hoodie["assets"]["thumbnail"] == "/api/v1/assets/top-hoodie-01/thumbnail"
    assert hoodie["shapeConstraints"]["shoulderWidth"] == [0.9, 1.12]
    assert "body_torso" in hoodie["bodyMask"]

    # 关键规则字段
    assert assets["top-jacket-01"]["replacesSlots"] == ["top"]
    assert assets["acc-cap-01"]["restrictsTraits"] == {"hair": ["hair-long-01"]}
    assert set(assets["bottom-shorts-01"]["bodyMask"]) != set(assets["bottom-jeans-01"]["bodyMask"])
    assert assets["anim-idle-01"]["type"] == "animation"


def test_assets_type_filter(client, user_token):
    resp = client.get("/api/v1/assets?type=garment&status=published", headers=auth_headers(user_token))
    assert resp.status_code == 200
    assets = resp.json()["assets"]
    assert assets and all(a["type"] == "garment" for a in assets)


def test_get_asset_detail(client, user_token):
    resp = client.get("/api/v1/assets/top-hoodie-01", headers=auth_headers(user_token))
    assert resp.status_code == 200
    assert resp.json()["asset"]["id"] == "top-hoodie-01"

    resp = client.get("/api/v1/assets/not-exist", headers=auth_headers(user_token))
    assert resp.status_code == 404
    assert resp.json()["code"] == "ASSET_NOT_FOUND"


def test_thumbnail(client, user_token):
    resp = client.get("/api/v1/assets/top-hoodie-01/thumbnail", headers=auth_headers(user_token))
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/svg+xml")
    assert b"<svg" in resp.content


def test_admin_forbidden_for_normal_user(client, user_token):
    for method, url in [
        ("get", "/api/v1/admin/assets"),
        ("post", "/api/v1/admin/assets/import"),
        ("post", "/api/v1/admin/assets/top-hoodie-01/publish"),
        ("post", "/api/v1/admin/assets/top-hoodie-01/archive"),
    ]:
        kwargs = {"json": {"manifest": {}}} if method == "post" and url.endswith("import") else {}
        resp = getattr(client, method)(url, headers=auth_headers(user_token), **kwargs)
        assert resp.status_code == 403, f"{method} {url} 应拒绝普通用户"
        assert resp.json()["code"] == "FORBIDDEN"


def _new_garment_manifest(asset_id="top-vest-01"):
    return {
        "id": asset_id,
        "version": "1.0.0",
        "displayName": "测试马甲",
        "type": "garment",
        "category": "top",
        "slots": ["top"],
        "layer": 15,
        "rigVersion": "standard-rig-1",
        "compatibleBaseAvatars": ["base-adult-v1"],
        "shapeConstraints": {},
        "bodyMask": ["body_torso"],
        "replacesSlots": [],
        "restrictsTraits": {},
        "assets": {"model": f"procedural:{asset_id}"},
        "license": {"source": "self-created", "licenseId": "project-owned"},
    }


def test_admin_import_validate_publish_archive(client, admin_token, user_token):
    headers = auth_headers(admin_token)
    # 导入（同步执行校验任务）
    resp = client.post(
        "/api/v1/admin/assets/import", json={"manifest": _new_garment_manifest()}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    job = resp.json()["job"]
    assert job["type"] == "asset_validate"
    assert job["status"] == "succeeded", job

    # 校验通过 → draft，普通用户目录不可见
    resp = client.get("/api/v1/admin/assets", headers=headers)
    vest = next(a for a in resp.json()["assets"] if a["id"] == "top-vest-01")
    assert vest["status"] == "draft"
    resp = client.get("/api/v1/assets/top-vest-01", headers=auth_headers(user_token))
    assert resp.status_code == 404

    # 发布 → 公开可见
    resp = client.post("/api/v1/admin/assets/top-vest-01/publish", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["asset"]["status"] == "published"
    resp = client.get("/api/v1/assets/top-vest-01", headers=auth_headers(user_token))
    assert resp.status_code == 200

    # 下架 → 普通用户目录不可见
    resp = client.post("/api/v1/admin/assets/top-vest-01/archive", headers=headers)
    assert resp.json()["asset"]["status"] == "archived"
    resp = client.get("/api/v1/assets?type=garment", headers=auth_headers(user_token))
    assert all(a["id"] != "top-vest-01" for a in resp.json()["assets"])


def test_admin_import_invalid_manifest(client, admin_token):
    bad = _new_garment_manifest("top-bad-01")
    bad["layer"] = 999  # 超出 0-100
    resp = client.post(
        "/api/v1/admin/assets/import", json={"manifest": bad}, headers=auth_headers(admin_token)
    )
    assert resp.status_code == 201
    job = resp.json()["job"]
    assert job["status"] == "failed"
    assert job["errorCode"] == "VALIDATION_FAILED"


def test_audit_log_written(client, admin_token, settings):
    from app.models import AuditLog
    from app.database import make_engine, make_session_factory

    client.post(
        "/api/v1/admin/assets/import",
        json={"manifest": _new_garment_manifest("top-vest-02")},
        headers=auth_headers(admin_token),
    )
    engine = make_engine(settings.database_url)
    db = make_session_factory(engine)()
    try:
        rows = db.query(AuditLog).filter(AuditLog.action == "asset.import").all()
        assert any(r.target_id == "top-vest-02" for r in rows)
    finally:
        db.close()
