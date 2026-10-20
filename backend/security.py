"""
安全相关工具：JWT 密钥、API Key 加密。

修复的问题：
1. 以前 JWT 密钥有一个写在公开仓库里的默认值，任何人都能伪造登录凭证。
   现在优先读环境变量 JWT_SECRET；没设置时自动生成一个随机密钥并保存在数据库里，
   绝不再使用公开的默认值。
2. 以前用户的 API Key 明文存数据库。现在用 Fernet（AES）加密后存储。
"""
import base64
import hashlib
import logging
import os
import secrets
import threading

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("aixue.security")

# 曾经公开过的默认值，出现即视为未设置
_LEAKED_SECRETS = {"aixue-secret-change-in-production", "your-secret", "changeme", ""}

_lock = threading.Lock()
_cached_secret: str | None = None


def _load_or_create_db_secret() -> str:
    """没有配置 JWT_SECRET 时，在数据库里生成并保存一个随机密钥"""
    from database import SessionLocal
    from models.models import AppSetting

    db = SessionLocal()
    try:
        row = db.query(AppSetting).filter(AppSetting.key == "jwt_secret").first()
        if row and row.value:
            return row.value
        value = secrets.token_urlsafe(48)
        db.add(AppSetting(key="jwt_secret", value=value))
        db.commit()
        logger.warning(
            "未设置环境变量 JWT_SECRET，已自动生成随机密钥并保存在数据库。"
            "生产环境请在部署平台设置 JWT_SECRET（至少 32 个随机字符）。"
        )
        return value
    finally:
        db.close()


def get_secret() -> str:
    global _cached_secret
    if _cached_secret:
        return _cached_secret
    with _lock:
        if _cached_secret:
            return _cached_secret
        env = os.getenv("JWT_SECRET", "").strip()
        if env and env not in _LEAKED_SECRETS and len(env) >= 16:
            _cached_secret = env
        else:
            if env:
                logger.warning("JWT_SECRET 太短或是公开过的默认值，已忽略。")
            _cached_secret = _load_or_create_db_secret()
        return _cached_secret


def reset_secret_cache() -> None:
    """测试用"""
    global _cached_secret
    _cached_secret = None


def _fernet() -> Fernet:
    raw = os.getenv("ENCRYPTION_KEY", "").strip() or get_secret()
    key = base64.urlsafe_b64encode(hashlib.sha256(("aixue-apikey|" + raw).encode()).digest())
    return Fernet(key)


def encrypt_text(plain: str) -> str:
    return "enc:" + _fernet().encrypt(plain.encode()).decode()


def decrypt_text(stored: str | None) -> str:
    """解密；密钥变了或数据损坏时返回空字符串（相当于用户需要重新填写 Key）"""
    if not stored:
        return ""
    if not stored.startswith("enc:"):
        return stored  # 旧数据：明文
    try:
        return _fernet().decrypt(stored[4:].encode()).decode()
    except (InvalidToken, ValueError):
        logger.warning("API Key 解密失败（可能更换过密钥），视为未设置")
        return ""


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:3]}…{key[-4:]}"
