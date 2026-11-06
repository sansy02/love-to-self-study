"""
今日复习 + 知识点掌握度 + 术语收藏（间隔复习）

- 错题：答错后第二天复习，之后答对一次间隔变长（2、4、7、15、30 天），全部通过算已掌握。
- 按知识点复习：同一个知识点今天只考一道题，避免同一个点反复刷屏。
- 每次复习作答都会记录下来，用于计算知识点掌握度（规则见 services/learning.py）。
- 薄弱知识点可以点「补一补」：一段短讲解 + 一道换了角度的新题。
- 术语：讲解页里点 ☆ 收藏，以卡片形式复习，「记得 / 忘了」决定下次出现的时间。
"""
import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from errors import AppError
from middleware.rate_limit import limiter
from models.models import (Attempt, Document, DocPage, Exercise, KnowledgePoint, StudySession, UserVocab,
                           Vocabulary, WrongBook)
from routers.auth import get_current_user
from routers.practice import _public, record_attempt, wrong_entry_view, result_view
from routers.study import ai_ctx, ai_http_error, _load_json
from services import ai_service, learning, sample
from services import courses as course_svc
from services import persona
from services.ai_service import AIError
from services.grading import grade_one, load_key_points, schedule_after_review

router = APIRouter(prefix="/api/review", tags=["review"])
legacy_router = APIRouter(prefix="/api/user", tags=["vocabulary"])


def _due_questions(db: Session, user_id: int, now: datetime, course_id: int | None = None):
    q = (db.query(WrongBook, Exercise).join(Exercise, WrongBook.exercise_id == Exercise.id)
         .filter(WrongBook.user_id == user_id, WrongBook.mastered != True)  # noqa: E712
         .filter((WrongBook.next_review_at.is_(None)) | (WrongBook.next_review_at <= now)))
    if course_id is not None:
        course_svc.get_owned_course(db, course_id, user_id)
        q = q.filter(Exercise.session_id.in_(course_svc.course_session_ids(db, course_id, user_id) or [""]))
    return q


def _due_words(db: Session, user_id: int, now: datetime):
    return (db.query(UserVocab).filter(UserVocab.user_id == user_id, UserVocab.mastered != True)  # noqa: E712
            .filter((UserVocab.next_review_at.is_(None)) | (UserVocab.next_review_at <= now)))


def word_view(w: UserVocab) -> dict:
    return {"id": w.id, "word": w.word, "translation": w.translation, "note": w.note, "example": w.example,
            "session_id": w.session_id, "page_no": w.page_no, "box": w.box or 0, "mastered": bool(w.mastered),
            "next_review_at": w.next_review_at.isoformat() if w.next_review_at else None}


def _one_per_kp(rows):
    """按知识点复习：每个知识点今天只出一道（没有知识点的旧题各算一组）"""
    picked, seen = [], set()
    for wb, ex in rows:
        ids = learning.load_ids(ex.kp_ids)
        key = ids[0] if ids else f"q{ex.id}"
        if key in seen:
            continue
        seen.add(key)
        picked.append((wb, ex))
    return picked


@router.get("/summary")
async def summary(course_id: int | None = None, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    due = _due_questions(db, user_id, now, course_id).order_by(WrongBook.next_review_at.asc().nullsfirst()).all()
    return {
        "questions_due": len(_one_per_kp(due)),
        "words_due": _due_words(db, user_id, now).count(),
        "open_wrong": db.query(WrongBook).filter(WrongBook.user_id == user_id, WrongBook.mastered != True).count(),  # noqa: E712
        "total_words": db.query(UserVocab).filter(UserVocab.user_id == user_id).count(),
    }


@router.get("/today")
async def today(course_id: int | None = None, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    rows = _due_questions(db, user_id, now, course_id).order_by(WrongBook.next_review_at.asc().nullsfirst()).all()
    picked = _one_per_kp(rows)[:30]
    words = _due_words(db, user_id, now).order_by(UserVocab.next_review_at.asc().nullsfirst()).limit(50).all()
    names = learning.kp_names(db, sorted({k for _, ex in picked for k in learning.load_ids(ex.kp_ids)}))
    questions = []
    for wb, ex in picked:
        v = wrong_entry_view(db, wb, ex, names)
        # 复习时先不给答案
        for k in ("correct_answer", "explanation", "user_answer", "feedback", "error_reason", "attempt_id"):
            v.pop(k, None)
        questions.append(v)
    return {"questions": questions, "words": [word_view(w) for w in words],
            "postponed": max(len(rows) - len(picked), 0)}


class ReviewAnswer(BaseModel):
    answer: str


@router.post("/questions/{entry_id}")
@limiter.limit("120/hour")
async def review_question(request: Request, entry_id: int, req: ReviewAnswer,
                          user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    wb = db.query(WrongBook).filter(WrongBook.id == entry_id, WrongBook.user_id == user_id).first()
    if not wb:
        raise AppError(404, "not_found", "错题不存在")
    ex = db.query(Exercise).filter(Exercise.id == wb.exercise_id).first()
    if not ex:
        raise AppError(404, "not_found", "题目不存在")
    s = db.query(StudySession).filter(StudySession.session_id == ex.session_id).first()
    doc = db.query(Document).filter(Document.id == s.document_id).first() if s and s.document_id else None
    g = await grade_one(ex.question_type, ex.question, ex.correct_answer, load_key_points(ex.key_points),
                        req.answer, ai_ctx(request, db, user_id),
                        keyword_grader=sample.keyword_grade if sample.is_sample(doc) else None)
    a = record_attempt(db, user_id, ex, req.answer, g, "review")
    persona.touch_activity(db, user_id)
    if g["status"] != "ungraded":
        schedule_after_review(wb, remembered=bool(g["is_correct"]))
        wb.last_reviewed_at = datetime.utcnow()
        wb.user_answer = req.answer[:4000]
        if g["feedback"]:
            wb.feedback = json.dumps(g["feedback"], ensure_ascii=False)
    db.commit()
    names = learning.kp_names(db, learning.load_ids(ex.kp_ids))
    view = result_view(ex, a, names)
    view.update({"mastered": bool(wb.mastered),
                 "next_review_at": wb.next_review_at.isoformat() if wb.next_review_at else None})
    return view


# ---------------------------------------------------------------- 知识点掌握度

def _user_docs(db: Session, user_id: int) -> dict[str, StudySession]:
    rows = (db.query(StudySession).filter(StudySession.user_id == user_id, StudySession.document_id.isnot(None))
            .order_by(StudySession.id.desc()).all())
    out: dict[str, StudySession] = {}
    for r in rows:
        out.setdefault(r.document_id, r)
    return out


@router.get("/knowledge")
async def knowledge_overview(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """你练过的所有知识点和掌握情况（需要加强的排在前面）"""
    docs = _user_docs(db, user_id)
    attempts = learning.user_kp_attempts(db, user_id)
    if not attempts:
        return {"knowledge_points": []}
    kps = db.query(KnowledgePoint).filter(KnowledgePoint.id.in_(list(attempts.keys()))).all()
    titles = {d.id: d.title for d in db.query(Document).filter(Document.id.in_(list(docs.keys()))).all()}
    out = []
    for k in kps:
        if k.document_id not in docs:  # 只看自己学过的课件
            continue
        m = learning.mastery_from_attempts(attempts.get(k.id, []))
        out.append({"id": k.id, "name": k.name, "kind": k.kind, "course": titles.get(k.document_id, ""),
                    "session_id": docs[k.document_id].session_id, "page_start": k.page_start, "page_end": k.page_end,
                    "due_today": learning.is_due_today(m), **m})
    order = {"weak": 0, "learning": 1, "new": 2, "mastered": 3}
    out.sort(key=lambda x: (order[x["status"]], x["course"], x["name"]))
    return {"knowledge_points": out}


@router.post("/kp/{kp_id}/remedial")
@limiter.limit("30/hour")
async def remedial(request: Request, kp_id: int, user_id: int = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """薄弱知识点补救：一段短讲解 + 一道换了角度的新题（学生点了才生成）"""
    k = db.query(KnowledgePoint).filter(KnowledgePoint.id == kp_id).first()
    docs = _user_docs(db, user_id)
    if not k or k.document_id not in docs:
        raise AppError(404, "not_found", "找不到这个知识点")
    session = docs[k.document_id]
    doc = db.query(Document).filter(Document.id == k.document_id).first()
    q = db.query(DocPage).filter(DocPage.document_id == doc.id)
    if k.page_start is not None and k.page_end is not None:
        q = q.filter(DocPage.page_no >= k.page_start, DocPage.page_no <= k.page_end)
    pages = [{"page_no": p.page_no, "text": p.text or ""} for p in q.order_by(DocPage.page_no).limit(6).all()]
    previous = [e.question for e in db.query(Exercise).filter(Exercise.user_id == user_id,
                                                              Exercise.session_id == session.session_id).all()
                if k.id in learning.load_ids(e.kp_ids)]
    outline = _load_json(doc.outline, {})
    if sample.is_sample(doc):
        r = sample.remedial_for(k.name, k.page_start, previous)  # 示例课程不消耗 AI 额度
    else:
        try:
            r = await ai_service.generate_remedial(outline.get("title") or doc.title, k.name, pages, previous,
                                                   ctx=ai_ctx(request, db, user_id))
        except AIError as e:
            raise ai_http_error(e)
    qd = r["question"]
    ex = Exercise(session_id=session.session_id, chapter_index=0, question_type=qd["type"],
                  question=str(qd["question"])[:4000],
                  options=json.dumps(qd.get("options", []) if qd["type"] == "choice" else [], ensure_ascii=False),
                  correct_answer=str(qd["answer"])[:4000], explanation=str(qd.get("explanation", ""))[:4000],
                  key_points="[]", page_no=k.page_start, scope="remedial", batch="", answered=False, lang="en",
                  user_id=user_id, kp_ids=json.dumps([k.id]))
    db.add(ex)
    db.commit()
    return {"kp": {"id": k.id, "name": k.name}, "session_id": session.session_id,
            "explanation": r["explanation"], "exercise": _public(ex, {k.id: k.name})}


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
    persona.touch_activity(db, user_id)
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
