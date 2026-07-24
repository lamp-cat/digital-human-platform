"""任务查询（契约：GET /jobs/{id}）。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..deps import get_current_user, get_db
from ..errors import ApiError
from ..models import Job, User
from ..serializers import job_json

router = APIRouter(prefix="/jobs", tags=["jobs"])

_ADMIN_ROLES = ("asset_admin", "system_admin")


@router.get("/{job_id}")
def get_job(
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.get(Job, job_id)
    # 非属主且非管理员：按不存在处理，避免泄露任务存在性
    if job is None or (job.owner_id != user.id and user.role not in _ADMIN_ROLES):
        raise ApiError(404, "JOB_NOT_FOUND", "任务不存在")
    return {"job": job_json(job)}
