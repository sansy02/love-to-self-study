"""
练习题 & 错题本 API

改进：
- 题目改成英文（和真实考试一致），解析用中文；简答题按得分点批改，并给英文表达反馈。
- 可以按章节出题（scope=section-2），也可以整讲出题（scope=all）。
- 同一套题没做完之前不会重复生成，省额度；想换题传 fresh=1。
- 出题接口不再把答案发给浏览器。
- AI 批改失败不再判错。
- 答错的题自动进入间隔复习。
- 所有接口都检查「这是不是你的学习记录」。
"""
import asyncio
import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from middleware.rate_limit import limiter
from models.models import StudySession, Exercise, WrongBook, DocPage, Document
from routers.auth import get_current_user
from routers.study import get_owned_session, ai_ctx, ai_http_error, user_profile, _load_json
from services import ai_service
from services.ai_service import AIError
from services.grading import grade_one, load_key_points, schedule_after_wrong

router = APIRouter(prefix="/api/practice", tags=["practice"])


def _public(e: Exercise) -> dict:
    """返回给前端做题用：不含答案"""
    return {"id": e.id, "type": e.question_type, "question": e.question,
            "options": json.loads(e.options) if e.options else [], "page_no": e.page_no, "lang": e.lang or "zh"}


def _scope_pages(db: Session, session: StudySession, scope: str) -> tuple[str, list[dict]]:
    """取出出题用的页面内容"""
    if session.document_id:
        doc = db.query(Document).filter(Document.id == session.document_id).first()
        if not doc:
            raise HTTPException(status_code=404, detail="课件不存在")
        outline = _load_json(doc.outline, {})
        q = db.query(DocPage).filter(DocPage.document_id == doc.id)
        if scope.startswith("section-"):
            try:
                idx = int(scope.split("-", 1)[1])
                sec = outline.get("sections", [])[idx]
            except (ValueError, IndexError):
                raise HTTPException(status_code=400, detail="章节不存在")
            q = q.filter(DocPage.page_no >= sec["start"], DocPage.page_no <= sec["end"])
        pages = q.order_by(DocPage.page_no).all()
        items = []
        for p in pages:
            expl = _load_json(p.explanation, {}) or {}
            if (p.text or "").strip() or expl.get("explanation"):
                items.append({"page_no": p.page_no,
                              "text": p.text or expl.get("explanation", ""),
                              "summary": expl.get("summary", "")})
        return outline.get("title") or doc.title, items

    # 旧版学习记录：用整篇讲解内容出题
    chapters = _load_json(session.content, [])
    items = []
    n = 0
    for ch in chapters:
        for sec in ch.get("sections", []):
            n += 1
            items.append({"page_no": n, "text": f"{sec.get('heading', '')}\n{sec.get('body', '')}", "summary": ""})
    return session.topic, items


async def _create_batch(request: Request, db: Session, session: StudySession, user_id: int, scope: str) -> list[Exercise]:
    title, pages = _scope_pages(db, session, scope)
    if not pages:
        raise HTTPException(status_code=400, detail="这部分没有可以出题的内容")
    grade, major = user_profile(db, user_id)
    try:
        items = await ai_service.generate_english_exercises(title, pages, grade, major, ctx=ai_ctx(request, db, user_id))
    except AIError as e:
        raise ai_http_error(e)
    if not items:
        raise HTTPException(status_code=502, detail="AI 没有生成出题目，请重试")
    batch = str(uuid.uuid4())
    valid_pages = {p["page_no"] for p in pages}
    saved = []
    for ex in items:
        page_no = ex.get("page")
        try:
            page_no = int(page_no) if page_no is not None else None
        except (TypeError, ValueError):
            page_no = None
        if page_no not in valid_pages:
            page_no = None
        e = Exercise(
            session_id=session.session_id, chapter_index=0, question_type=ex["type"],
            question=str(ex.get("question", ""))[:4000],
            options=json.dumps(ex.get("options", []) if ex["type"] == "choice" else [], ensure_ascii=False),
            correct_answer=str(ex.get("answer", ""))[:4000], explanation=str(ex.get("explanation", ""))[:4000],
            key_points=json.dumps([str(k) for k in (ex.get("key_points") or [])][:6], ensure_ascii=False),
            page_no=page_no, scope=scope, batch=batch, answered=False, lang="en", user_id=user_id,
        )
        db.add(e)
        saved.append(e)
    db.commit()
    return saved


@router.post("/generate/{session_id}")
@limiter.limit("30/hour")
async def gen_exercises(request: Request, session_id: str, scope: str = "all", fresh: int = 0,
                        user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """为学习记录出一套题（scope=all 整讲 / section-N 某一章）"""
    session = get_owned_session(db, session_id, user_id)
    if scope not in ("all", "retry") and not scope.startswith("section-"):
        scope = "all"
    if not fresh or scope == "retry":
        latest = (db.query(Exercise).filter(Exercise.session_id == session_id, Exercise.user_id == user_id,
                                            Exercise.scope == scope, Exercise.answered == False)  # noqa: E712
                  .order_by(Exercise.id.desc()).first())
        if latest and latest.batch:
            existing = (db.query(Exercise).filter(Exercise.batch == latest.batch).order_by(Exercise.id).all())
            return {"session_id": session_id, "scope": scope, "reused": True, "exercises": [_public(e) for e in existing]}
    if scope == "retry":
        raise HTTPException(status_code=404, detail="这套重练题已经做完了，可以回错题本再生成一套")
    saved = await _create_batch(request, db, session, user_id, scope)
    return {"session_id": session_id, "scope": scope, "reused": False, "exercises": [_public(e) for e in saved]}


# ---- 错题本 ----
# 注意：/wrong-book 必须在 /{session_id} 之前，否则会被后者捕获

def wrong_entry_view(wb: WrongBook, ex: Exercise) -> dict:
    return {
        "id": wb.id, "exercise_id": wb.exercise_id, "session_id": ex.session_id, "page_no": ex.page_no,
        "question": ex.question, "question_type": ex.question_type,
        "options": json.loads(ex.options) if ex.options else [],
        "correct_answer": ex.correct_answer, "user_answer": wb.user_answer, "explanation": ex.explanation,
        "feedback": _load_json(wb.feedback, {}) or {},
        "box": wb.box or 0, "mastered": bool(wb.mastered), "review_count": wb.review_count or 0,
        "next_review_at": wb.next_review_at.isoformat() if wb.next_review_at else None,
        "created_at": wb.created_at.isoformat() if wb.created_at else None,
    }


@router.get("/wrong-book")
async def get_wrong_book(include_mastered: int = 0, user_id: int = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    q = (db.query(WrongBook, Exercise).join(Exercise, WrongBook.exercise_id == Exercise.id)
         .filter(WrongBook.user_id == user_id))
    if not include_mastered:
        q = q.filter(WrongBook.mastered != True)  # noqa: E712
    entries = q.order_by(WrongBook.created_at.desc()).all()
    return {"entries": [wrong_entry_view(wb, ex) for wb, ex in entries]}


@router.delete("/wrong-book/{entry_id}")
async def remove_wrong(entry_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    wb = db.query(WrongBook).filter(WrongBook.id == entry_id, WrongBook.user_id == user_id).first()
    if not wb:
        raise HTTPException(status_code=404, detail="错题不存在")
    wb.mastered = True
    wb.next_review_at = None
    db.commit()
    return {"status": "ok"}


@router.get("/{session_id}")
async def get_exercises(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取这条学习记录下最近一套题（不含答案）"""
    get_owned_session(db, session_id, user_id)
    latest = (db.query(Exercise).filter(Exercise.session_id == session_id)
              .filter((Exercise.user_id == user_id) | (Exercise.user_id.is_(None)))
              .order_by(Exercise.id.desc()).first())
    if not latest:
        return {"session_id": session_id, "exercises": []}
    q = db.query(Exercise).filter(Exercise.session_id == session_id)
    q = q.filter(Exercise.batch == latest.batch) if latest.batch else q.filter(Exercise.batch.in_(["", None]))
    return {"session_id": session_id, "exercises": [_public(e) for e in q.order_by(Exercise.id).all()]}


# ---- 批改 ----

class SubmitRequest(BaseModel):
    answers: list[dict]  # [{exercise_id, answer}]


def upsert_wrong(db: Session, user_id: int, ex: Exercise, user_answer: str, feedback: dict):
    wb = (db.query(WrongBook).filter(WrongBook.user_id == user_id, WrongBook.exercise_id == ex.id).first())
    if not wb:
        wb = WrongBook(exercise_id=ex.id, user_id=user_id, is_correct=False, review_count=0)
        db.add(wb)
    wb.user_answer = (user_answer or "")[:4000]
    wb.feedback = json.dumps(feedback or {}, ensure_ascii=False)
    schedule_after_wrong(wb)
    return wb


@router.post("/submit/{session_id}")
@limiter.limit("60/hour")
async def submit_answers(request: Request, session_id: str, req: SubmitRequest,
                         user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """提交答案并批改"""
    get_owned_session(db, session_id, user_id)
    ids = []
    for a in req.answers[:50]:
        try:
            ids.append(int(a.get("exercise_id", 0)))
        except (TypeError, ValueError):
            continue
    exercises = (db.query(Exercise).filter(Exercise.session_id == session_id, Exercise.id.in_(ids))
                 .filter((Exercise.user_id == user_id) | (Exercise.user_id.is_(None))).all())
    if not exercises:
        raise HTTPException(status_code=404, detail="练习题不存在")
    ex_map = {e.id: e for e in exercises}
    ctx = ai_ctx(request, db, user_id)

    pairs = []
    for a in req.answers[:50]:
        try:
            ex = ex_map.get(int(a.get("exercise_id", 0)))
        except (TypeError, ValueError):
            ex = None
        if ex:
            pairs.append((ex, str(a.get("answer", "") or "")[:4000]))

    graded = await asyncio.gather(*[
        grade_one(ex.question_type, ex.question, ex.correct_answer, load_key_points(ex.key_points), ans, ctx)
        for ex, ans in pairs
    ])

    results = []
    correct = wrong = ungraded = 0
    for (ex, ans), g in zip(pairs, graded):
        ex.answered = True
        if g["status"] == "correct":
            correct += 1
        elif g["status"] == "wrong":
            wrong += 1
            upsert_wrong(db, user_id, ex, ans, g["feedback"])
        else:
            ungraded += 1
        results.append({
            "exercise_id": ex.id, "user_answer": ans, "correct_answer": ex.correct_answer,
            "status": g["status"], "is_correct": g["is_correct"], "score": g["score"],
            "feedback": g["feedback"], "explanation": ex.explanation, "page_no": ex.page_no,
            "key_points": load_key_points(ex.key_points),
        })
    db.commit()
    graded_n = correct + wrong
    return {
        "total": len(results), "correct": correct, "wrong": wrong, "ungraded": ungraded,
        "score": round(correct / graded_n * 100, 1) if graded_n else 0,
        "results": results,
    }


# ---- 错题重练 ----

class RetryRequest(BaseModel):
    exercise_ids: list[int]


@router.post("/retry-wrong")
@limiter.limit("20/hour")
async def retry_wrong(request: Request, req: RetryRequest, user_id: int = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """根据错题对应的页面，重新出一套新题"""
    if not req.exercise_ids:
        raise HTTPException(status_code=400, detail="请提供要重练的错题")
    own_ids = {wb.exercise_id for wb in db.query(WrongBook).filter(
        WrongBook.user_id == user_id, WrongBook.exercise_id.in_(req.exercise_ids[:200])).all()}
    exercises = db.query(Exercise).filter(Exercise.id.in_(own_ids)).all()
    if not exercises:
        raise HTTPException(status_code=404, detail="没有找到这些错题")

    # 选错题最多的那份学习记录，在它的相关页面上出题
    by_session: dict[str, list[Exercise]] = {}
    for e in exercises:
        by_session.setdefault(e.session_id, []).append(e)
    sid = max(by_session, key=lambda k: len(by_session[k]))
    session = db.query(StudySession).filter(StudySession.session_id == sid, StudySession.user_id == user_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="错题对应的学习记录不存在")

    title, pages = _scope_pages(db, session, "all")
    wanted = {e.page_no for e in by_session[sid] if e.page_no}
    if wanted:
        near = {n + d for n in wanted for d in (-1, 0, 1)}
        focused = [p for p in pages if p["page_no"] in near]
        pages = focused or pages
    grade, major = user_profile(db, user_id)
    try:
        items = await ai_service.generate_english_exercises(title, pages, grade, major, ctx=ai_ctx(request, db, user_id))
    except AIError as e:
        raise ai_http_error(e)
    batch = str(uuid.uuid4())
    saved = []
    for ex in items:
        e = Exercise(session_id=sid, chapter_index=0, question_type=ex["type"], question=str(ex["question"])[:4000],
                     options=json.dumps(ex.get("options", []) if ex["type"] == "choice" else [], ensure_ascii=False),
                     correct_answer=str(ex.get("answer", ""))[:4000], explanation=str(ex.get("explanation", ""))[:4000],
                     key_points=json.dumps([str(k) for k in (ex.get("key_points") or [])][:6], ensure_ascii=False),
                     page_no=ex.get("page") if isinstance(ex.get("page"), int) else None,
                     scope="retry", batch=batch, answered=False, lang="en", user_id=user_id,
                     created_at=datetime.utcnow())
        db.add(e)
        saved.append(e)
    db.commit()
    return {"session_id": sid, "scope": "retry", "exercises": [_public(e) for e in saved]}
