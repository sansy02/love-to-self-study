"""
教学内容生成 API
"""
import uuid
import json
import hashlib
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import get_db
from models.models import StudySession, StudentProfile, FeaturePreference, ContentCache
from services.ai_service import generate_teaching_content
from routers.auth import get_current_user
from middleware.rate_limit import limiter

router = APIRouter(prefix="/api", tags=["content"])


class GenerateRequest(BaseModel):
    topic: str                          # 话题名称
    source_type: str = "topic"          # "topic" 或 "file"
    source_text: str = ""               # 原始文本（如果是文件上传，则为提取的文本）
    grade: str = ""
    major: str = ""
    subject: str = ""


# 广告关键词（不含 URL 和域名，避免误杀正常教学引用）
SPAM_KEYWORDS = [
    "加微信", "加QQ", "免费领取", "点击链接领",
    "赚钱", "兼职", "刷单", "赌博", "色情", "裸聊",
    "████", "▓", "▒",
]


def validate_content(text: str) -> tuple[bool, str]:
    """内容质量检测，宽松策略，避免误杀正常PPT"""
    text = text.strip()
    # 长度检查
    if len(text) < 10:
        return False, "内容过短（少于10字），请提供有实质内容的学习材料"
    # 乱码检测
    normal_chars = sum(1 for c in text if c.isalpha() or c.isspace()
                       or '一' <= c <= '鿿'  # 中文字符
                       or c in ',.;:!?，。；：！？、()（）[]【】""''—-…')
    if len(text) > 100 and normal_chars / len(text) < 0.4:
        return False, "检测到大量乱码或无效字符，请上传有效的教学材料"
    # 广告检测（至少命中 2 个关键词才拒绝）
    text_lower = text.lower()
    hits = sum(1 for kw in SPAM_KEYWORDS if kw.lower() in text_lower)
    if hits >= 2:
        return False, "内容疑似广告信息，已被拒绝"
    return True, "ok"


class GenerateResponse(BaseModel):
    session_id: str
    topic: str
    outline: list
    chapters: list


@router.post("/content/generate")
@limiter.limit("3/minute;20/day")
async def generate_content(request: Request, req: GenerateRequest, db: Session = Depends(get_db),
                            user_id: int = Depends(get_current_user)):
    """生成教学大纲和教学内容（需要登录）"""
    # 确定要发送给 AI 的文本
    if req.source_text.strip():
        ai_input = req.source_text
    else:
        ai_input = req.topic

    if not ai_input.strip():
        raise HTTPException(status_code=400, detail="请提供学习话题或上传文件")

    # 内容质量预检
    if req.source_text.strip():
        valid, reason = validate_content(ai_input)
        if not valid:
            raise HTTPException(status_code=400, detail=f"内容未通过审核: {reason}")

    # 每日免费次数检查
    # - 用户有自己的 API Key → 不限制
    # - 用户没有自己的 Key，但有管理员 Key → 每天 5 次免费
    # - 都没有 → 报错
    from routers.settings import get_api_key
    from datetime import datetime, timedelta, timezone
    admin_key = get_api_key()
    user_key = get_api_key(user_id)
    has_own_key = (user_key != admin_key)  # 用户设了自己的 Key 则不同
    if has_own_key:
        pass  # 用户用自己的 Key，无限制
    elif admin_key == "your-api-key-here":
        raise HTTPException(
            status_code=400,
            detail="AI API Key 未配置。请联系管理员或自行在前端设置中填入 API Key。获取 Key: https://platform.deepseek.com"
        )
    else:
        # 用管理员 Key，每天 5 次限制，北京时间 0:00 刷新
        CST = timezone(timedelta(hours=8))
        today_start = datetime.now(CST).replace(hour=0, minute=0, second=0, microsecond=0)
        daily_count = db.query(StudySession).filter(
            StudySession.user_id == user_id,
            StudySession.created_at >= today_start
        ).count()
        if daily_count >= 5:
            raise HTTPException(
                status_code=429,
                detail="今日免费次数已用完（5次/天），北京时间 0:00 重置。你也可以在前端页面中输入自己的 DeepSeek API Key 继续使用。获取 Key: https://platform.deepseek.com"
            )

    # 保存学生画像
    profile = StudentProfile(
        grade=req.grade,
        major=req.major,
        subject=req.subject,
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)

    # 缓存检查：相同输入直接返回缓存，不消耗 Token
    cache_key = f"{req.topic}|{ai_input[:2000]}|{req.grade}|{req.major}|{req.subject}"
    cache_hash = hashlib.sha256(cache_key.encode()).hexdigest()
    cached = db.query(ContentCache).filter(ContentCache.content_hash == cache_hash).first()

    if cached:
        cached.hit_count = (cached.hit_count or 0) + 1
        db.commit()
        session_id = str(uuid.uuid4())
        topic = json.loads(cached.outline)[0].get("title", req.topic) if cached.outline else req.topic
        session = StudySession(
            session_id=session_id, topic=cached.topic or req.topic,
            source_type=req.source_type, source_text=ai_input[:50000],
            outline=cached.outline, content=cached.content,
            profile_id=profile.id, user_id=user_id,
        )
        db.add(session)
        db.commit()
        return {
            "session_id": session_id, "topic": cached.topic or req.topic,
            "outline": json.loads(cached.outline) if cached.outline else [],
            "chapters": json.loads(cached.content) if cached.content else [],
            "cached": True,
        }

    # 调用 AI 生成教学内容
    try:
        result = await generate_teaching_content(
            source_text=ai_input,
            grade=req.grade,
            major=req.major,
            subject=req.subject,
            user_id=user_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {str(e)}")

    # 存入缓存
    cache_entry = ContentCache(
        content_hash=cache_hash,
        topic=result.get("topic", req.topic),
        outline=json.dumps(result.get("outline", []), ensure_ascii=False),
        content=json.dumps(result.get("chapters", []), ensure_ascii=False),
        hit_count=1,
    )
    db.add(cache_entry)

    # 生成 session_id
    session_id = str(uuid.uuid4())

    # 保存学习记录
    session = StudySession(
        session_id=session_id,
        topic=result.get("topic", req.topic),
        source_type=req.source_type,
        source_text=ai_input[:50000],
        outline=json.dumps(result.get("outline", []), ensure_ascii=False),
        content=json.dumps(result.get("chapters", []), ensure_ascii=False),
        profile_id=profile.id,
        user_id=user_id,
    )
    db.add(session)
    db.commit()

    return {
        "session_id": session_id,
        "topic": result.get("topic", req.topic),
        "outline": result.get("outline", []),
        "chapters": result.get("chapters", []),
    }


@router.get("/content/history")
async def get_history(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取当前用户最近 20 条学习记录（仅标题和日期）"""
    sessions = (
        db.query(StudySession)
        .filter(StudySession.user_id == user_id)
        .order_by(StudySession.created_at.desc())
        .limit(20)
        .all()
    )
    return {
        "sessions": [
            {
                "session_id": s.session_id,
                "topic": s.topic,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in sessions
        ],
    }


@router.get("/content/{session_id}")
async def get_session(session_id: str, db: Session = Depends(get_db)):
    """获取已有学习记录"""
    session = db.query(StudySession).filter(StudySession.session_id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="学习记录不存在")

    return {
        "session_id": session.session_id,
        "topic": session.topic,
        "source_type": session.source_type,
        "outline": json.loads(session.outline) if session.outline else [],
        "chapters": json.loads(session.content) if session.content else [],
        "created_at": session.created_at.isoformat() if session.created_at else None,
    }
