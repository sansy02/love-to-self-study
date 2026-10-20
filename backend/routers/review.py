"""
今日复习 + 术语收藏（间隔复习）

- 错题：答错后第 1 天复习，之后答对一次间隔变长（2、4、7、15、30 天），全部通过算已掌握。
- 术语：讲解页里点 ☆ 收藏，以卡片形式复习，「记得 / 忘了」决定下次出现的时间。
"""
import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from middleware.rate_limit import limiter
from models.models import Exercise, UserVocab, Vocabulary, WrongBook, StudySession
from routers.auth import get_current_user
from routers.practice import wrong_entry_view
from routers.study import ai_ctx
from services.grading import grade_one, load_key_points, schedule_after_review

router = APIRouter(prefix="/api/review", tags=["review"])
legacy_router = APIRouter(prefix="/api/user", tags=["vocabulary"])


def _due_questions(db: Session, user_id: int, now: datetime):
    return (db.query(WrongBook, Exercise).join(Exercise, WrongBook.exercise_id == Exercise.id)
            .filter(WrongBook.user_id == user_id, WrongBook.mastered != True)  # noqa: E712
            .filter((WrongBook.next_review_at.is_(None)) | (WrongBook.next_review_at <= now)))


def _due_words(db: Session, user_id: int, now: datetime):
    return (db.query(UserVocab).filter(UserVocab.user_id == user_id, UserVocab.mastered != True)  # noqa: E712
            .filter((UserVocab.next_review_at.is_(None)) | (UserVocab.next_review_at <= now)))


def word_view(w: UserVocab) -> dict:
    return {"id": w.id, "word": w.word, "translation": w.translation, "note": w.note, "example": w.example,
            "session_id": w.session_id, "page_no": w.page_no, "box": w.box or 0, "mastered": bool(w.mastered),
            "next_review_at": w.next_review_at.isoformat() if w.next_review_at else None}


@router.get("/summary")
async def summary(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    return {
        "questions_due": _due_questions(db, user_id, now).count(),
        "words_due": _due_words(db, user_id, now).count(),
        "open_wrong": db.query(WrongBook).filter(WrongBook.user_id == user_id, WrongBook.mastered != True).count(),  # noqa: E712
        "total_words": db.query(UserVocab).filter(UserVocab.user_id == user_id).count(),
    }


@router.get("/today")
async def today(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    qs = _due_questions(db, user_id, now).order_by(WrongBook.next_review_at.asc().nullsfirst()).limit(30).all()
    words = _due_words(db, user_id, now).order_by(UserVocab.next_review_at.asc().nullsfirst()).limit(50).all()
    questions = []
    for wb, ex in qs:
        v = wrong_entry_view(wb, ex)
        # 复习时先不给答案
        for k in ("correct_answer", "explanation", "user_answer", "feedback"):
            v.pop(k, None)
        questions.append(v)
    return {"questions": questions, "words": [word_view(w) for w in words]}


class ReviewAnswer(BaseModel):
    answer: str


@router.post("/questions/{entry_id}")
@limiter.limit("120/hour")
async def review_question(request: Request, entry_id: int, req: ReviewAnswer,
                          user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    wb = db.query(WrongBook).filter(WrongBook.id == entry_id, WrongBook.user_id == user_id).first()
    if not wb:
        raise HTTPException(status_code=404, detail="错题不存在")
    ex = db.query(Exercise).filter(Exercise.id == wb.exercise_id).first()
    if not ex:
        raise HTTPException(status_code=404, detail="题目不存在")
    g = await grade_one(ex.question_type, ex.question, ex.correct_answer, load_key_points(ex.key_points),
                        req.answer, ai_ctx(request, db, user_id))
    if g["status"] != "ungraded":
        schedule_after_review(wb, remembered=bool(g["is_correct"]))
        wb.last_reviewed_at = datetime.utcnow()
        wb.user_answer = req.answer[:4000]
        if g["feedback"]:
            wb.feedback = json.dumps(g["feedback"], ensure_ascii=False)
        db.commit()
    return {
        "status": g["status"], "is_correct": g["is_correct"], "score": g["score"], "feedback": g["feedback"],
        "correct_answer": ex.correct_answer, "explanation": ex.explanation,
        "key_points": load_key_points(ex.key_points), "mastered": bool(wb.mastered),
        "next_review_at": wb.next_review_at.isoformat() if wb.next_review_at else None,
    }


# ---------------------------------------------------------------- 术语收藏

class WordRequest(BaseModel):
    word: str
    translation: str = ""
    note: str = ""
    example: str = ""
    session_id: str = ""
    page_no: int | None = None


@router.get("/words")
async def list_words(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    words = db.query(UserVocab).filter(UserVocab.user_id == user_id).order_by(UserVocab.id.desc()).all()
    return {"words": [word_view(w) for w in words]}


@router.post("/words")
async def add_word(req: WordRequest, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    word = req.word.strip()[:200]
    if not word:
        raise HTTPException(status_code=400, detail="术语不能为空")
    if req.session_id:
        s = db.query(StudySession).filter(StudySession.session_id == req.session_id).first()
        if not s or s.user_id != user_id:
            req.session_id, req.page_no = "", None
    key = word.lower()
    w = db.query(UserVocab).filter(UserVocab.user_id == user_id, UserVocab.word_key == key).first()
    if not w:
        w = UserVocab(user_id=user_id, word=word, word_key=key, box=0,
                      next_review_at=datetime.utcnow() + timedelta(days=1))
        db.add(w)
    w.translation = req.translation.strip()[:500] or w.translation
    w.note = req.note.strip()[:1000] or w.note
    w.example = req.example.strip()[:1000] or w.example
    w.session_id = req.session_id or w.session_id or ""
    w.page_no = req.page_no if req.page_no is not None else w.page_no
    db.commit()
    db.refresh(w)
    return word_view(w)


@router.delete("/words/{word_id}")
async def delete_word(word_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(UserVocab).filter(UserVocab.id == word_id, UserVocab.user_id == user_id).delete()
    db.commit()
    return {"status": "ok"}


class WordReview(BaseModel):
    remembered: bool


@router.post("/words/{word_id}/review")
async def review_word(word_id: int, req: WordReview, user_id: int = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    w = db.query(UserVocab).filter(UserVocab.id == word_id, UserVocab.user_id == user_id).first()
    if not w:
        raise HTTPException(status_code=404, detail="术语不存在")
    schedule_after_review(w, req.remembered)
    db.commit()
    return word_view(w)


# ---------------------------------------------------------------- 旧接口兼容（/api/user/vocabulary）

@legacy_router.get("/vocabulary")
async def legacy_list(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    words = db.query(UserVocab).filter(UserVocab.user_id == user_id).order_by(UserVocab.id.desc()).all()
    return {"words": [{"id": w.id, "word": w.word, "translation": w.translation,
                       "example": w.example or w.note} for w in words]}


@legacy_router.post("/vocabulary/{vocab_id}/favorite")
async def legacy_toggle(vocab_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """旧版词表的收藏按钮：以前会改动全站共享的词条，现在改成每人一份"""
    v = db.query(Vocabulary).filter(Vocabulary.id == vocab_id).first()
    if not v:
        raise HTTPException(status_code=404, detail="词汇不存在")
    key = v.word.strip().lower()
    w = db.query(UserVocab).filter(UserVocab.user_id == user_id, UserVocab.word_key == key).first()
    if w:
        db.delete(w)
        db.commit()
        return {"vocab_id": vocab_id, "favorited": False}
    db.add(UserVocab(user_id=user_id, word=v.word[:200], word_key=key, translation=v.translation or "",
                     example=v.example or "", session_id=v.session_id or "", box=0,
                     next_review_at=datetime.utcnow() + timedelta(days=1)))
    db.commit()
    return {"vocab_id": vocab_id, "favorited": True}
