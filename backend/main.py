"""
爱学助手 — 后端服务
FastAPI 应用入口
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from database import init_db
from middleware.rate_limit import limiter
from routers.profile import router as profile_router
from routers.upload import router as upload_router
from routers.content import router as content_router
from routers.settings import router as settings_router
from routers.vocabulary import router as vocabulary_router
from routers.practice import router as practice_router
from routers.auth import router as auth_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动时初始化数据库"""
    init_db()
    yield


app = FastAPI(
    title="爱学助手",
    description="上传 PPT 或输入话题，AI 自动生成教学内容、英语词汇和练习题",
    version="1.0.0",
    lifespan=lifespan,
)

# 注册速率限制器
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS（生产环境允许 Vercel 等域名）
import os
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS + ["https://*.vercel.app"],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(profile_router)
app.include_router(upload_router)
app.include_router(content_router)
app.include_router(settings_router)
app.include_router(vocabulary_router)
app.include_router(practice_router)
app.include_router(auth_router)


@app.get("/api/health")
async def health_check():
    """健康检查 + 统计"""
    import os
    from database import SessionLocal
    from models.models import User, StudySession
    db_url = os.getenv("DATABASE_URL", "sqlite:///./aixue.db")
    db_type = "postgresql" if db_url.startswith("postgresql") else "sqlite"

    stats = {}
    try:
        db = SessionLocal()
        user_count = db.query(User).count()
        session_count = db.query(StudySession).count()
        db.close()
        stats = {"users": user_count, "study_sessions": session_count}
    except Exception:
        stats = {"users": "N/A", "study_sessions": "N/A"}

    return {"status": "ok", "message": "爱学助手后端运行中", "db": db_type, **stats}
