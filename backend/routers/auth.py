"""
认证 API — 匿名身份、注册、登录、JWT、用户信息、统计

登录模式由环境变量 AUTH_MODE 控制（见 config.py）：
- anonymous（默认）：账号密码功能下线，浏览器自动获得匿名身份。注册/登录代码保留但接口关闭。
- account / both：重新开放邮箱账号登录。
"""
import datetime
import secrets
import uuid

import jwt
from fastapi import APIRouter, Depends, HTTPException, Header, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel

import config
from database import get_db
from middleware.rate_limit import limiter
from models.models import User, WrongBook, StudySession, Exercise, UserVocab
from security import get_secret

router = APIRouter(prefix="/api", tags=["auth"])

JWT_EXPIRE_DAYS = 7
ANON_EXPIRE_DAYS = 365


# ---- 请求模型 ----

class RegisterRequest(BaseModel):
    email: str
    password: str
    confirm_password: str
    grade: str = ""
    major: str = ""
    subject: str = ""


class LoginRequest(BaseModel):
    email: str
    password: str


class UpdateProfileRequest(BaseModel):
    grade: str = ""
    major: str = ""
    subject: str = ""


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


# ---- 工具 ----

def hash_password(pw: str) -> str:
    import bcrypt
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    import bcrypt
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False  # 匿名用户的占位哈希


def create_token(user_id: int, email: str, anonymous: bool = False) -> str:
    days = ANON_EXPIRE_DAYS if anonymous else JWT_EXPIRE_DAYS
    return jwt.encode({
        "user_id": user_id, "email": email, "anon": anonymous,
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days),
    }, get_secret(), algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, get_secret(), algorithms=["HS256"])


def get_current_user(authorization: str = Header(default="")) -> int:
    """从 Bearer Token 提取当前用户 ID"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="请先登录")
    token = authorization[7:]
    try:
        payload = decode_token(token)
        return int(payload["user_id"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    except (jwt.InvalidTokenError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="无效的登录凭证")


def _user_payload(user: User) -> dict:
    return {"id": user.id, "email": "" if user.is_anonymous else user.email,
            "grade": user.grade, "major": user.major, "subject": user.subject,
            "is_anonymous": bool(user.is_anonymous)}


# ---- 登录模式 ----

@router.get("/auth/mode")
async def auth_mode():
    """前端据此决定显示登录页还是直接匿名进入"""
    return {"mode": config.AUTH_MODE, "anonymous": config.ANONYMOUS_ENABLED, "account": config.ACCOUNT_ENABLED}


# ---- 匿名身份（默认） ----

@router.post("/auth/anonymous")
@limiter.limit("20/hour")
async def create_anonymous(request: Request, db: Session = Depends(get_db)):
    """不需要注册：为这个浏览器创建一个匿名用户，返回长期有效的 token"""
    if not config.ANONYMOUS_ENABLED:
        raise HTTPException(status_code=403, detail="匿名使用已关闭，请登录")
    user = User(
        email=f"anon-{uuid.uuid4().hex}@anonymous.local",
        password_hash="!anonymous-" + secrets.token_hex(8),  # 不是合法的 bcrypt 哈希，永远无法用密码登录
        is_anonymous=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"token": create_token(user.id, user.email, anonymous=True), "user": _user_payload(user)}


def _require_account_mode():
    if not config.ACCOUNT_ENABLED:
        raise HTTPException(status_code=403, detail="账号登录暂未开放，直接使用即可（无需注册）")


# ---- 注册（代码保留，默认关闭） ----

@router.post("/auth/register")
@limiter.limit("10/hour")
async def register(request: Request, req: RegisterRequest, db: Session = Depends(get_db)):
    _require_account_mode()
    if not req.email or "@" not in req.email:
        raise HTTPException(status_code=400, detail="请输入有效的邮箱地址")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少需要 6 位")
    if req.password != req.confirm_password:
        raise HTTPException(status_code=400, detail="两次输入的密码不一致")

    email = req.email.strip().lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=400, detail="该邮箱已注册")

    user = User(email=email, password_hash=hash_password(req.password),
                grade=req.grade, major=req.major, subject=req.subject)
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_token(user.id, user.email)
    return {"token": token, "user": _user_payload(user)}


# ---- 登录（代码保留，默认关闭） ----

@router.post("/auth/login")
@limiter.limit("20/hour")
async def login(request: Request, req: LoginRequest, db: Session = Depends(get_db)):
    _require_account_mode()
    user = db.query(User).filter(User.email == req.email.strip().lower()).first()
    if not user or user.is_anonymous:
        raise HTTPException(status_code=401, detail="邮箱或密码错误")

    now = datetime.datetime.utcnow()
    if user.locked_until and user.locked_until > now:
        remaining = max(1, int((user.locked_until - now).total_seconds() // 60))
        raise HTTPException(status_code=403, detail=f"账户已锁定，请 {remaining} 分钟后重试")

    if not verify_password(req.password, user.password_hash):
        user.login_attempts = (user.login_attempts or 0) + 1
        if user.login_attempts >= 5:
            user.locked_until = now + datetime.timedelta(minutes=15)
            user.login_attempts = 0
        db.commit()
        raise HTTPException(status_code=401, detail="邮箱或密码错误")

    user.login_attempts = 0
    user.locked_until = None
    user.last_login_at = now
    db.commit()

    token = create_token(user.id, user.email)
    return {"token": token, "user": _user_payload(user)}


# ---- 当前用户信息 ----

@router.get("/auth/me")
async def get_me(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在，请刷新页面")
    data = _user_payload(user)
    data["is_admin"] = bool(user.is_admin)
    return data


@router.put("/auth/me")
async def update_me(req: UpdateProfileRequest, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if req.grade: user.grade = req.grade[:20]
    if req.major: user.major = req.major[:100]
    if req.subject: user.subject = req.subject[:100]
    db.commit()
    return {"status": "ok"}


# ---- 修改密码（代码保留，默认关闭） ----

@router.put("/auth/password")
async def change_password(req: ChangePasswordRequest, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_account_mode()
    user = db.query(User).filter(User.id == user_id).first()
    if not user or user.is_anonymous or not verify_password(req.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码错误")
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="新密码至少需要 6 位")
    user.password_hash = hash_password(req.new_password)
    db.commit()
    return {"status": "ok"}


# ---- 用户统计 ----

@router.get("/user/stats")
async def get_stats(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    sessions = db.query(StudySession).filter(StudySession.user_id == user_id).count()
    answered = db.query(Exercise).filter(Exercise.user_id == user_id, Exercise.answered == True).count()  # noqa: E712
    legacy_total = db.query(Exercise).filter(
        Exercise.user_id.is_(None),
        Exercise.session_id.in_(db.query(StudySession.session_id).filter(StudySession.user_id == user_id)),
    ).count()
    total_ex = answered + legacy_total
    wrongs = db.query(WrongBook).filter(WrongBook.user_id == user_id).count()
    open_wrongs = db.query(WrongBook).filter(WrongBook.user_id == user_id, WrongBook.mastered != True).count()  # noqa: E712
    vocab = db.query(UserVocab).filter(UserVocab.user_id == user_id).count()

    accuracy = round((1 - wrongs / max(total_ex, 1)) * 100, 1) if total_ex else 0.0

    return {"sessions": sessions, "total_exercises": total_ex, "wrong_count": open_wrongs,
            "accuracy": max(accuracy, 0.0), "favorite_vocab": vocab}
