"""
系统设置 API — 用户自己的 API Key

- Key 加密后存数据库（以前是明文）。
- 支持 DeepSeek Key（sk- 开头）和 Gemini Key（AIza 开头），自动识别。
- 站长的免费模型 Key 只放在环境变量里，永远不会返回给前端。
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import get_db, SessionLocal
from models.models import User
from routers.auth import get_current_user
from security import encrypt_text, decrypt_text, mask_key
from services import ai_service

router = APIRouter(prefix="/api/settings", tags=["settings"])


class ApiKeyRequest(BaseModel):
    api_key: str


def _read_user_key(user: User, db: Session | None = None) -> str:
    """读取用户 Key；顺便把旧版明文 Key 迁移成加密存储"""
    if user.api_key and not user.api_key_enc:
        plain = user.api_key.strip()
        user.api_key_enc = encrypt_text(plain)
        user.api_key = None
        if db is not None:
            db.commit()
        return plain
    return decrypt_text(user.api_key_enc)


@router.post("/api-key")
async def set_api_key(req: ApiKeyRequest, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """设置当前用户的 API Key"""
    key = req.api_key.strip()
    if len(key) < 10 or len(key) > 300 or any(c.isspace() for c in key):
        raise HTTPException(status_code=400, detail="API Key 格式不对，请检查是否复制完整")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    user.api_key_enc = encrypt_text(key)
    user.api_key = None
    db.commit()
    provider = ai_service.detect_user_key_provider(key)
    return {"status": "ok", "message": f"已保存你的 {provider} Key（加密存储）", "masked": mask_key(key), "provider": provider}


@router.delete("/api-key")
async def delete_api_key(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if user:
        user.api_key = None
        user.api_key_enc = None
        db.commit()
    return {"status": "ok"}


@router.get("/api-key/status")
async def check_api_key(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """检查用户是否配置了自己的 Key，以及站点可用的免费模型"""
    user = db.query(User).filter(User.id == user_id).first()
    own = _read_user_key(user, db) if user else ""
    free = ai_service.free_providers_summary()
    return {
        "configured": bool(own) or bool(free),
        "source": "user" if own else ("admin" if free else "none"),
        "masked": mask_key(own),
        "user_provider": ai_service.detect_user_key_provider(own) if own else "",
        "free_models": free,
    }


def get_api_key(user_id: int | None = None) -> str:
    """
    旧接口兼容：返回该用户自己的 Key（没有则返回空字符串）。
    站长 Key 不再从这里返回，统一由 ai_service 的模型链处理。
    """
    if not user_id:
        return ""
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        return _read_user_key(user, db) if user else ""
    finally:
        db.close()
