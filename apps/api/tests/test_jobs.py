"""任务状态查询。"""
from .conftest import auth_headers, register
from .glb_builder import build_glb
from .test_imports import _upload


def test_job_query_shape(client, user_token):
    body = _upload(client, user_token, model=build_glb()).json()
    job = body["job"]
    resp = client.get(f"/api/v1/jobs/{job['id']}", headers=auth_headers(user_token))
    assert resp.status_code == 200
    data = resp.json()["job"]
    assert data["id"] == job["id"]
    assert data["type"] == "import_validate"
    assert data["status"] == "succeeded"
    assert data["progress"] == 100
    assert data["errorCode"] is None
    assert data["resultJson"]["compatibility"] == "POSE_ONLY"


def test_failed_job_error_code(client, user_token):
    body = _upload(client, user_token, model=build_glb(with_skin=False)).json()
    job = body["job"]
    assert job["status"] == "failed"
    assert job["errorCode"] == "IMPORT_RIG_INCOMPLETE"
    # 不暴露堆栈
    assert "Traceback" not in str(job)


def test_job_not_found_and_isolation(client, user_token):
    resp = client.get("/api/v1/jobs/nonexistent-id", headers=auth_headers(user_token))
    assert resp.status_code == 404
    assert resp.json()["code"] == "JOB_NOT_FOUND"

    # 他人任务按不存在处理
    job = _upload(client, user_token, model=build_glb()).json()["job"]
    other = register(client, email="other3@test.local")["token"]
    resp = client.get(f"/api/v1/jobs/{job['id']}", headers=auth_headers(other))
    assert resp.status_code == 404


def test_admin_can_view_any_job(client, user_token, admin_token):
    job = _upload(client, user_token, model=build_glb()).json()["job"]
    resp = client.get(f"/api/v1/jobs/{job['id']}", headers=auth_headers(admin_token))
    assert resp.status_code == 200
