"""
统一错误格式

所有错误都返回：{"detail": "给用户看的中文说明", "code": "机器可读的错误类型"}
前端根据 code 显示「发生了什么、为什么、接下来怎么做」和对应的恢复按钮。

安全原则：任何报错都不返回内部异常原文、模型服务商的原始回复、堆栈或密钥，细节只写进服务器日志。
"""
import logging

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("aixue.errors")


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def error_json(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": message, "code": code})


_DEFAULT_CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
                  405: "bad_request", 409: "conflict", 413: "upload_too_large", 422: "bad_request",
                  429: "rate_limited", 502: "ai_unavailable", 503: "service_unavailable"}


async def app_error_handler(request: Request, exc: AppError):
    return error_json(exc.status_code, exc.code, exc.message)


async def http_error_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        return error_json(exc.status_code, detail.get("code", _DEFAULT_CODES.get(exc.status_code, "error")),
                          str(detail.get("message", "")))
    code = _DEFAULT_CODES.get(exc.status_code, "error")
    message = detail if isinstance(detail, str) and detail else "请求出错了，请重试"
    return error_json(exc.status_code, code, message)


async def validation_error_handler(request: Request, exc: RequestValidationError):
    return error_json(422, "bad_request", "提交的内容格式不对，请刷新页面后重试")


async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return error_json(429, "rate_limited", "操作太频繁了，请稍等一会儿再试")


async def db_error_handler(request: Request, exc: SQLAlchemyError):
    logger.exception("database error on %s %s", request.method, request.url.path)
    return error_json(503, "save_failed", "数据保存失败了，你的操作没有生效，请稍后重试")


async def unhandled_error_handler(request: Request, exc: Exception):
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return error_json(500, "server_error", "服务器出了点问题，已经记录下来了，请重试")


def register(app):
    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(RateLimitExceeded, rate_limit_handler)
    app.add_exception_handler(SQLAlchemyError, db_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
