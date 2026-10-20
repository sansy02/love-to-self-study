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
from services.ai_service import generate_teaching_content, AIContext, AIError
from routers.auth import get_current_user
from middleware.rate_limit import limiter, client_ip

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
    # 用完整输入做哈希（以前只取前 2000 字，开头相同的两份课件会被当成同一份）
    cache_key = f"{req.topic}|{ai_input}|{req.grade}|{req.major}|{req.subject}"
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
            ctx=AIContext(user_id=user_id, ip=client_ip(request), db=db),
        )
    except AIError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {str(e)[:200]}")

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
async def get_session(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取已有学习记录（只能看自己的）"""
    session = db.query(StudySession).filter(StudySession.session_id == session_id).first()
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="学习记录不存在")

    return {
        "session_id": session.session_id,
        "topic": session.topic,
        "source_type": session.source_type,
        "outline": json.loads(session.outline) if session.outline else [],
        "chapters": json.loads(session.content) if session.content else [],
        "created_at": session.created_at.isoformat() if session.created_at else None,
    }
