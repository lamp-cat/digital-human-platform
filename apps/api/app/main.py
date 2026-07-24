"""FastAPI 应用组装：create_app(settings) 工厂。"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import Settings, get_settings
from .database import Base, make_engine, make_session_factory
from .errors import register_exception_handlers
from .jobs import JobContext, JobRunner
from .logging_setup import RequestContextMiddleware, setup_logging
from .routers import admin, assets, auth, avatars, imports, jobs
from .seed import seed_database
from .storage import make_storage

logger = logging.getLogger("dhp.main")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    setup_logging()

    engine = make_engine(settings.database_url)
    session_factory = make_session_factory(engine)
    storage = make_storage(settings.storage_backend, settings.storage_local_dir)
    job_ctx = JobContext(session_factory, storage, settings)
    runner = JobRunner(job_ctx, sync=settings.job_runner == "sync")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # 启动：自动建表 + 种子数据 + 后台 worker
        Base.metadata.create_all(engine)
        db = session_factory()
        try:
            seed_database(db)
        finally:
            db.close()
        runner.start()
        logger.info("dhp api started (env=%s)", settings.app_env)
        yield
        runner.stop()

    app = FastAPI(title="数字人平台 API", version="1.0.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.storage = storage
    app.state.job_runner = runner

    # 中间件：request_id + 结构化访问日志
    app.add_middleware(RequestContextMiddleware)
    # CORS：仅放行前端开发源
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.public_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)

    # 健康检查（无需认证）
    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz():
        db = session_factory()
        try:
            db.execute(text("SELECT 1"))
            return {"status": "ready"}
        finally:
            db.close()

    # 业务路由（/api/v1 前缀）
    app.include_router(auth.router, prefix="/api/v1")
    app.include_router(avatars.router, prefix="/api/v1")
    app.include_router(assets.router, prefix="/api/v1")
    app.include_router(admin.router, prefix="/api/v1")
    app.include_router(imports.router, prefix="/api/v1")
    app.include_router(jobs.router, prefix="/api/v1")
    return app


app = create_app()
