"""
爱学助手 — 后端服务
FastAPI 应用入口
"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config
import errors
from database import init_db, SessionLocal
from middleware.rate_limit import limiter
from routers.profile import router as profile_router
from routers.upload import router as upload_router
from routers.content import router as content_router
from routers.settings import router as settings_router
from routers.vocabulary import router as vocabulary_router
from routers.practice import router as practice_router
from routers.auth import router as auth_router
from routers.study import router as study_router
from routers.courses import router as courses_router
from routers.me import router as me_router
from routers.review import router as review_router, legacy_router as user_vocab_router
from security import get_secret
from services.ai_service import free_providers_summary

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("aixue")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动时初始化数据库、检查配置"""
    init_db()
    get_secret()  # 没配置 JWT_SECRET 时在这里生成并保存
    from services.sample import ensure_sample
    db = SessionLocal()
    try:
        ensure_sample(db)  # 准备好示例课程
    finally:
        db.close()
    models = free_providers_summary()
    if models:
        logger.info("免费模型链：%s", " → ".join(models))
    else:
        logger.warning("没有配置任何免费模型（GEMINI_API_KEY / GLM_API_KEY），用户必须自带 Key 才能使用 AI")
    logger.info("登录模式：%s", config.AUTH_MODE)
    yield


app = FastAPI(
    title="爱学助手",
    description="上传 PPT 或输入话题，AI 逐页讲解、追问、英文练习和间隔复习",
    version="3.0.0",
    lifespan=lifespan,
)

# 注册速率限制器 + 统一错误格式
app.state.limiter = limiter
errors.register(app)


@app.middleware("http")
async def catch_unhandled(request, call_next):
    """兜底：未知异常也返回统一格式（放在 CORS 里面，前端才能读到错误内容，而不是看到跨域失败）"""
    try:
        return await call_next(request)
    except Exception as exc:  # noqa: BLE001
        return await errors.unhandled_error_handler(request, exc)


# CORS：只放行配置的域名 + 本项目的 Vercel 预览域名
ALLOWED_ORIGINS = [o.strip() for o in os.getenv(
    "ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000,https://love-to-self-study.vercel.app"
).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=os.getenv("ALLOWED_ORIGIN_REGEX", r"https://love-to-self-study(-[a-z0-9-]+)?\.vercel\.app"),
    allow_credentials=False,  # 用的是 Authorization 头，不需要 Cookie
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(auth_router)
app.include_router(courses_router)
app.include_router(me_router)
app.include_router(study_router)
app.include_router(practice_router)
app.include_router(review_router)
app.include_router(user_vocab_router)
app.include_router(settings_router)
app.include_router(profile_router)
# 旧版接口（整篇生成），保留兼容
app.include_router(upload_router)
app.include_router(content_router)
app.include_router(vocabulary_router)


@app.get("/api/health")
async def health_check():
    """健康检查（不再对外暴露用户数等内部数据）"""
    from database import IS_POSTGRES
    return {"status": "ok", "message": "爱学助手后端运行中", "db": "postgresql" if IS_POSTGRES else "sqlite",
            "auth_mode": config.AUTH_MODE, "ai_ready": bool(free_providers_summary())}
