"""认证：注册 / 登录 / 鉴权失败。"""
from .conftest import auth_headers, register


def test_register_login_me(client):
    body = register(client, email="a@test.local")
    assert body["token"]
    user = body["user"]
    assert user["email"] == "a@test.local"
    assert user["role"] == "user"
    assert user["displayName"] == "测试用户"

    resp = client.post(
        "/api/v1/auth/login", json={"email": "a@test.local", "password": "password123"}
    )
    assert resp.status_code == 200
    assert resp.json()["user"]["id"] == user["id"]

    resp = client.get("/api/v1/auth/me", headers=auth_headers(body["token"]))
    assert resp.status_code == 200
    assert resp.json()["user"]["email"] == "a@test.local"


def test_register_duplicate_email(client):
    register(client, email="dup@test.local")
    resp = client.post(
        "/api/v1/auth/register", json={"email": "dup@test.local", "password": "password123"}
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "CONFLICT"


def test_register_weak_password(client):
    resp = client.post(
        "/api/v1/auth/register", json={"email": "w@test.local", "password": "short"}
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_FAILED"


def test_login_wrong_password(client):
    register(client, email="b@test.local")
    resp = client.post(
        "/api/v1/auth/login", json={"email": "b@test.local", "password": "wrong-password"}
    )
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"


def test_me_unauthorized(client):
    resp = client.get("/api/v1/auth/me")
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"

    resp = client.get("/api/v1/auth/me", headers=auth_headers("bad-token"))
    assert resp.status_code == 401


def test_seed_accounts(client):
    # 契约种子账号
    resp = client.post(
        "/api/v1/auth/login", json={"email": "demo@dhp.local", "password": "demo123456"}
    )
    assert resp.status_code == 200
    assert resp.json()["user"]["role"] == "user"

    resp = client.post(
        "/api/v1/auth/login", json={"email": "admin@dhp.local", "password": "admin123456"}
    )
    assert resp.status_code == 200
    assert resp.json()["user"]["role"] == "system_admin"


def test_error_shape(client):
    # 统一错误响应 {code, message, requestId, details?}
    resp = client.get("/api/v1/auth/me")
    body = resp.json()
    assert set(body) >= {"code", "message", "requestId"}
