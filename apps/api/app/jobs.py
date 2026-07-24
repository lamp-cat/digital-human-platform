"""任务系统：jobs 表 + 进程内后台 worker（threading + queue）。

- 状态机：queued → running → succeeded | failed
- JOB_RUNNER=inprocess 时由后台线程执行；=sync 时入队即同步执行（测试用）
- 任何异常只写结构化 errorCode，不把堆栈暴露给客户端（堆栈仅落服务端日志）
"""
import json
import logging
import queue
import threading
from collections.abc import Callable

from sqlalchemy.orm import Session, sessionmaker

from .database import utcnow
from .models import Asset, ImportReport, ImportedAsset, Job
from .schemas import GarmentManifest
from .storage import LocalStorage
from .validator import VALIDATOR_VERSION, validate_glb

logger = logging.getLogger("dhp.jobs")

JobHandler = Callable[[Session, Job, "JobContext"], None]


class JobContext:
    """处理器可用的共享资源。"""

    def __init__(self, session_factory: sessionmaker, storage: LocalStorage, settings):
        self.session_factory = session_factory
        self.storage = storage
        self.settings = settings


def _set_progress(db: Session, job: Job, progress: int) -> None:
    job.progress = progress
    job.updated_at = utcnow()
    db.commit()


# ---------------------------------------------------------------------------
# 任务处理器
# ---------------------------------------------------------------------------

def handle_import_validate(db: Session, job: Job, ctx: JobContext) -> None:
    """导入模型校验：跑 validator → 写 import_reports、更新 imported_assets。"""
    import_id = job.input_json["importId"]
    rec = db.get(ImportedAsset, import_id)
    if rec is None:
        job.error_code = "IMPORT_FILE_INVALID"
        raise ValueError("导入记录不存在")
    _set_progress(db, job, 10)

    data = ctx.storage.get(rec.original_key)
    manifest_bytes = ctx.storage.get(rec.manifest_key) if rec.manifest_key else None
    _set_progress(db, job, 30)

    result = validate_glb(
        data,
        manifest_bytes,
        max_triangles=ctx.settings.import_max_triangles,
        recommended_triangles=ctx.settings.import_max_triangles_recommended,
    )
    _set_progress(db, job, 70)

    # 报告入库
    db.add(
        ImportReport(
            imported_asset_id=rec.id,
            validator_version=VALIDATOR_VERSION,
            report_json=result.report,
        )
    )
    rec.compatibility = result.compatibility
    if result.manifest is not None:
        rec.manifest_json = result.manifest.model_dump(mode="json")
        rec.display_name = result.manifest.displayName
    rec.status = {
        "FULL": "accepted_full",
        "POSE_ONLY": "accepted_pose_only",
        "REJECTED": "rejected",
    }[result.compatibility]
    rec.updated_at = utcnow()

    if result.compatibility == "REJECTED":
        job.status = "failed"
        job.error_code = result.error_code or "IMPORT_FILE_INVALID"
        job.result_json = {"compatibility": "REJECTED"}
    else:
        job.status = "succeeded"
        job.result_json = {
            "compatibility": result.compatibility,
            "importId": rec.id,
            "displayName": rec.display_name,
        }
    job.progress = 100
    job.updated_at = utcnow()
    db.commit()


def handle_asset_validate(db: Session, job: Job, ctx: JobContext) -> None:
    """管理端资产 manifest 校验（与 TS garmentManifestSchema 对齐）。"""
    asset_id = job.input_json["assetId"]
    asset = db.get(Asset, asset_id)
    if asset is None:
        job.error_code = "ASSET_NOT_FOUND"
        raise ValueError("资产不存在")
    _set_progress(db, job, 30)

    manifest = asset.manifest_json or {}
    errors: list[str] = []
    if asset.type in ("garment", "hair", "accessory", "shoes"):
        try:
            GarmentManifest.model_validate(manifest)
        except Exception as exc:  # pydantic ValidationError
            errors = [str(e) for e in getattr(exc, "errors", lambda: [str(exc)])()][:10]
    else:
        # base_avatar / animation：V1 轻量校验必填字段
        for key in ("id", "version", "displayName", "type", "rigVersion", "assets", "license"):
            if key not in manifest:
                errors.append(f"缺少必填字段 {key}")
        if manifest.get("rigVersion") != "standard-rig-1":
            errors.append("rigVersion 必须为 standard-rig-1")
    _set_progress(db, job, 80)

    if errors:
        asset.status = "rejected"
        job.status = "failed"
        job.error_code = "VALIDATION_FAILED"
        job.result_json = {"errors": errors}
    else:
        asset.status = "draft"  # 校验通过 → 草稿，等待发布
        job.status = "succeeded"
        job.result_json = {"assetId": asset.id, "checks": "pass"}
    asset.updated_at = utcnow()
    job.progress = 100
    job.updated_at = utcnow()
    db.commit()


def handle_avatar_cover(db: Session, job: Job, ctx: JobContext) -> None:
    """封面图任务：V1 占位实现（封面字节在上传时已写入存储）。"""
    job.status = "succeeded"
    job.progress = 100
    job.result_json = {"ok": True, "avatarId": job.input_json.get("avatarId")}
    job.updated_at = utcnow()
    db.commit()


HANDLERS: dict[str, JobHandler] = {
    "import_validate": handle_import_validate,
    "asset_validate": handle_asset_validate,
    "avatar_cover": handle_avatar_cover,
}


# ---------------------------------------------------------------------------
# 后台 worker
# ---------------------------------------------------------------------------

class JobRunner:
    def __init__(self, ctx: JobContext, sync: bool = False):
        self.ctx = ctx
        self.sync = sync
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self.sync or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="dhp-job-worker", daemon=True)
        self._thread.start()
        logger.info("job worker started (inprocess)")

    def stop(self) -> None:
        if self._thread is None:
            return
        self._queue.put(None)
        self._thread.join(timeout=5)
        self._thread = None

    def enqueue(self, job_id: str) -> None:
        if self.sync:
            self._run_one(job_id)
        else:
            self._queue.put(job_id)

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            if job_id is None:
                return
            try:
                self._run_one(job_id)
            except Exception:  # worker 循环不能死
                logger.exception("job %s 执行异常", job_id)

    def _run_one(self, job_id: str) -> None:
        db = self.ctx.session_factory()
        try:
            job = db.get(Job, job_id)
            if job is None or job.status not in ("queued", "running"):
                return
            handler = HANDLERS.get(job.type)
            if handler is None:
                job.status = "failed"
                job.error_code = "JOB_FAILED"
                db.commit()
                return
            job.status = "running"
            job.progress = max(job.progress, 5)
            job.updated_at = utcnow()
            db.commit()
            try:
                handler(db, job, self.ctx)
            except Exception as exc:
                # 处理器未自行落状态的兜底：不暴露堆栈
                logger.exception("job %s (%s) 处理失败", job.id, job.type)
                db.rollback()
                job = db.get(Job, job_id)
                job.status = "failed"
                if not job.error_code:
                    job.error_code = "JOB_FAILED"
                job.result_json = job.result_json or {"message": str(exc)[:200]}
                job.updated_at = utcnow()
                db.commit()
        finally:
            db.close()


def create_job(
    db: Session,
    *,
    job_type: str,
    input_json: dict,
    owner_id: str | None,
    runner: JobRunner,
) -> Job:
    """建任务并入队。"""
    job = Job(type=job_type, status="queued", progress=0, input_json=input_json, owner_id=owner_id)
    db.add(job)
    db.commit()
    db.refresh(job)
    runner.enqueue(job.id)
    db.refresh(job)  # sync 模式下此时已完成
    return job
