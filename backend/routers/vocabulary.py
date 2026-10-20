"""
英语词汇 API
"""
import json
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from database import get_db
from models.models import StudySession, Vocabulary
from services.ai_service import generate_vocabulary, AIContext, AIError
from middleware.rate_limit import client_ip
from routers.auth import get_current_user

router = APIRouter(prefix="/api/vocabulary", tags=["vocabulary"])


@router.post("/generate/{session_id}")
async def gen_vocabulary(session_id: str, request: Request, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """为指定学习记录生成英语词汇（旧版）"""
    session = db.query(StudySession).filter(StudySession.session_id == session_id).first()
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="学习记录不存在")

    # 拼接教学内容文本
    chapters = json.loads(session.content) if session.content else []
    content_text = ""
    for ch in chapters:
        for sec in ch.get("sections", []):
            content_text += sec.get("body", "") + "\n"

    if not content_text.strip():
        raise HTTPException(status_code=400, detail="教学内容为空")

    # 获取学生画像年级
    grade = ""
    if session.profile_id:
        from models.models import StudentProfile
        p = db.query(StudentProfile).filter(StudentProfile.id == session.profile_id).first()
        if p:
            grade = p.grade

    # 调用 AI 生成
    try:
        words = await generate_vocabulary(content_text, grade=grade,
                                          ctx=AIContext(user_id=user_id, ip=client_ip(request), db=db))
    except AIError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {str(e)}")

    # 保存到数据库
    saved = []
    for i, w in enumerate(words):
        vocab = Vocabulary(
            session_id=session_id,
            chapter_index=i + 1,
            word=w.get("word", ""),
            translation=w.get("translation", ""),
            example=w.get("example", ""),
        )
        db.add(vocab)
        saved.append(vocab)
    db.commit()

    return {
        "session_id": session_id,
        "words": [{"id": v.id, "word": v.word, "translation": v.translation, "example": v.example} for v in saved],
    }


@router.get("/{session_id}")
async def get_vocabulary(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取已有词汇"""
    session = db.query(StudySession).filter(StudySession.session_id == session_id).first()
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="学习记录不存在")
    words = db.query(Vocabulary).filter(Vocabulary.session_id == session_id).all()
    return {
        "session_id": session_id,
        "words": [{"id": w.id, "word": w.word, "translation": w.translation, "example": w.example} for w in words],
    }
