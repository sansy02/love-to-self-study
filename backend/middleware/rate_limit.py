"""
速率限制中间件 — 防止恶意高频调用消耗 Token

以前按 IP 限流：宿舍、校园网共用一个出口 IP，一个人用完全宿舍都用不了。
现在优先按「用户」限流（从登录凭证里取用户 ID），没有凭证时才按 IP。
"""
from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def client_ip(request: Request) -> str:
    """部署在 Render / Vercel 等反向代理后面时，真实 IP 在 X-Forwarded-For 第一个"""
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return (get_remote_address(request) or "unknown")[:64]


def user_or_ip(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        try:
            from routers.auth import decode_token
            return f"user:{decode_token(auth[7:])['user_id']}"
        except Exception:
            pass
    return f"ip:{client_ip(request)}"


# 全局限流器（只作用于加了 @limiter.limit 的接口）
limiter = Limiter(key_func=user_or_ip)
