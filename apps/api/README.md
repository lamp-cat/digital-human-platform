# apps/api — 数字人平台后端（FastAPI）

V1 参赛版 API 服务，实现 `docs/api/api-contract.md` 的全部端点：
认证（JWT）、角色 CRUD（乐观锁）、资产目录、外部模型导入（GLB/VRM 校验分级）、
任务系统、审计与健康检查。领域 schema 与 `packages/avatar-schema`（zod）逐字段对齐。

## 环境准备

需要 `/usr/local/bin/python3.11`。一键脚本（推荐）：

```bash
../../scripts/dev-api.sh      # 自动建 venv、装依赖、起服务
```

或手动：

```bash
cd apps/api
/usr/local/bin/python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 启动

```bash
cd apps/api
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

- 健康检查：`curl http://localhost:8000/healthz`、`/readyz`
- 业务接口前缀：`/api/v1`（如 `curl http://localhost:8000/api/v1/assets -H "Authorization: Bearer <token>"`）
- OpenAPI 文档：`http://localhost:8000/docs`
- 首次启动自动建表并写入种子：账号 `demo@dhp.local/demo123456`（user）、
  `admin@dhp.local/admin123456`（system_admin），以及 16 个内置资产（`procedural:<id>` 模型）。

## 测试

```bash
cd apps/api
source .venv/bin/activate
python -m pytest          # 48 个用例
```

> 说明：本机 Python 3.11.0b2（beta）的 `compile()` 与 pytest 断言重写不兼容，
> `pytest.ini` 已加 `--assert=plain`（仅影响失败时的断言展示，不影响用例判定）。

## 配置（环境变量）

默认值见根目录 `.env.example`，常用项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///./data/dhp.db` | 相对路径基于启动目录 |
| `STORAGE_BACKEND` / `STORAGE_LOCAL_DIR` | `local` / `./data/storage` | 对象存储 |
| `JOB_RUNNER` | `inprocess` | `inprocess`=后台线程 worker；`sync`=同步执行（测试用） |
| `JWT_SECRET` | `dev-only-change-me` | 生产必须更换 |
| `SIGNED_URL_TTL_SECONDS` | `600` | 私有模型签名 URL 有效期 |
| `IMPORT_MAX_BYTES` / `IMPORT_MAX_TRIANGLES` | 100MB / 120000 | 导入限制 |
| `PUBLIC_ORIGIN` | `http://localhost:5173` | CORS 放行源 |

## 目录结构

```
app/
  main.py          # create_app 工厂、lifespan（建表/种子/worker）、中间件、异常处理
  config.py        # pydantic-settings 配置
  database.py      # 引擎/会话/时间工具
  models.py        # SQLAlchemy 2 ORM（users/avatars/avatar_versions/assets/
                   #   imported_assets/import_reports/jobs/consents/audit_logs）
  schemas.py       # 与 avatar-schema 对齐的 Pydantic 模型 + StandardRig 常量/映射表
  security.py      # pbkdf2 密码哈希、JWT
  deps.py          # get_db / get_current_user / 角色检查
  storage.py       # 本地对象存储
  signing.py       # 私有模型 HMAC 短时签名 URL
  validator.py     # GLB/VRM 纯 Python 校验器（分级 FULL/POSE_ONLY/REJECTED）
  jobs.py          # 任务系统（queue + 后台线程，sync 模式可同步执行）
  seed.py          # 种子账号与内置资产
  routers/         # auth / avatars / assets / admin / imports / jobs
tests/             # pytest（临时 sqlite + 临时 storage + 同步任务）
```

## 环境兼容备注

本机解释器为 3.11.0b2（beta），其 `typing` 与 `typing_extensions>=4.6` 的泛型别名
实现不兼容，导致 SQLAlchemy 导入失败。`app/__init__.py` 在导入第三方库前将
`typing._check_generic` 的空参数误报分支跳过（仅影响该校验，不影响运行时行为）。
requirements.txt 中 pydantic 2.9.2 + typing_extensions 4.12.2 为配套锁定版本。
