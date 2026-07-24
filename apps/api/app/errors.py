"""统一错误响应：{code, message, requestId, details}（契约 §通用约定）。"""
import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("dhp.error")


class ApiError(Exception):
    """业务错误：code 取自 avatar-schema errors.ts 定义的错误码。"""

    def __init__(self, status: int, code: str, message: str, details: object = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def error_body(request: Request, code: str, message: str, details: object = None) -> dict:
    request_id = getattr(request.state, "request_id", None) or uuid.uuid4().hex
    body: dict = {"code": code, "message": message, "requestId": request_id}
    if details is not None:
        body["details"] = details
    return body


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.status,
            content=error_body(request, exc.code, exc.message, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        # 请求体/参数不合法 → 422 VALIDATION_FAILED
        details = [
            {"loc": [str(p) for p in e.get("loc", [])], "msg": e.get("msg", "")}
            for e in exc.errors()[:10]
        ]
        return JSONResponse(
            status_code=422,
            content=error_body(request, "VALIDATION_FAILED", "请求参数校验失败", details),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(request: Request, exc: StarletteHTTPException):
        code = {404: "NOT_FOUND", 405: "VALIDATION_FAILED", 401: "UNAUTHORIZED", 403: "FORBIDDEN"}.get(
            exc.status_code, "INTERNAL_ERROR"
        )
        message = exc.detail if isinstance(exc.detail, str) else "请求失败"
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(request, code, message),
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception):
        # 不向客户端暴露堆栈；堆栈仅落服务端日志
        logger.exception("unhandled error request_id=%s", getattr(request.state, "request_id", "-"))
        return JSONResponse(
            status_code=500,
            content=error_body(request, "INTERNAL_ERROR", "服务器内部错误"),
        )
