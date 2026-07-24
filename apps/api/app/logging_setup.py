"""结构化 JSON 日志 + 请求 ID 中间件。

日志不记录：Authorization 头、URL query（可能含签名 token）、私有文件路径。
"""
import json
import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def setup_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    # 压低第三方日志噪音
    logging.getLogger("uvicorn.access").handlers = [handler]


class RequestContextMiddleware(BaseHTTPMiddleware):
    """生成 request_id、输出访问日志（仅 method/path/status/耗时）。"""

    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        response.headers["x-request-id"] = request_id
        logging.getLogger("dhp.access").info(
            "request_id=%s method=%s path=%s status=%s duration_ms=%s",
            request_id, request.method, request.url.path, response.status_code, duration_ms,
        )
        return response
