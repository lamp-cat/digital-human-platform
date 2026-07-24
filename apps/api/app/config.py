"""应用配置：全部从环境变量读取，默认值与根目录 .env.example 对齐。"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),  # 允许从仓库根目录 .env 读取
        extra="ignore",
    )

    # 应用
    app_env: str = "dev"
    public_origin: str = "http://localhost:5173"
    api_origin: str = "http://localhost:8000"

    # 数据库（默认 SQLite，相对路径基于进程工作目录）
    database_url: str = "sqlite:///./data/dhp.db"

    # 对象存储（V1 仅实现 local）
    storage_backend: str = "local"
    storage_local_dir: str = "./data/storage"

    # 任务队列：inprocess=后台线程；sync=同步执行（测试用）
    job_runner: str = "inprocess"
    job_timeout_seconds: int = 120

    # 导入限制
    import_max_bytes: int = 100 * 1024 * 1024
    import_max_triangles: int = 120_000
    import_max_triangles_recommended: int = 80_000
    import_validate_timeout_seconds: int = 60

    # 安全
    jwt_secret: str = "dev-only-change-me"
    jwt_expire_seconds: int = 7 * 24 * 3600
    signed_url_ttl_seconds: int = 600
    import_retention_days: int = 30


@lru_cache
def get_settings() -> Settings:
    return Settings()
