"""测试夹具：临时 sqlite + 临时 storage + 同步任务执行。"""
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(
        database_url=f"sqlite:///{tmp_path}/test.db",
        storage_local_dir=str(tmp_path / "storage"),
        job_runner="sync",  # 测试模式：任务同步执行
        jwt_secret="test-secret-key-0123456789abcdef0123456789abcdef",
        signed_url_ttl_seconds=600,
        app_env="test",
    )


@pytest.fixture()
def client(settings):
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def register(client, email="user1@test.local", password="password123", display_name="测试用户"):
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "displayName": display_name},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def user_token(client):
    return register(client)["token"]


@pytest.fixture()
def admin_token(client):
    resp = client.post(
        "/api/v1/auth/login", json={"email": "admin@dhp.local", "password": "admin123456"}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]
