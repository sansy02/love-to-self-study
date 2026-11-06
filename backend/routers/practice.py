"""
练习题 & 错题本 API

- 题目是英文（和真实考试一致），解析用中文；简答题按得分点批改，并给英文表达反馈。
- 可以按章节出题（scope=section-2），也可以整讲出题（scope=all）。
- 同一套题没做完之前不会重复生成，省额度；想换题传 fresh=1。
- 出题接口不会把答案发给浏览器。
- 每道题关联 1–2 个知识点（只能从课件的知识点清单里选）。
- 每次作答都会记一条作答记录（答案、正确答案、错误原因），用来算掌握度。
- 重复提交同一套题不会重复批改、也不会重复记错题。
- AI 批改失败不判错；答错的题自动进入间隔复习。
- 所有接口都检查「这是不是你的学习记录」。
"""
import asyncio
import json
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from errors import AppError
from middleware.rate_limit import limiter
from models.models import Attempt, StudySession, Exercise, WrongBook, DocPage, Document, KnowledgePoint
from routers.auth import get_current_user
from routers.study import get_owned_session, ai_ctx, ai_http_error, user_profile, _load_json
from services import ai_service, learning, sample
from services import bank as bank_svc
from services import persona
from services.ai_service import AIError, ERROR_TYPES
from services.grading import grade_one, load_key_points, schedule_after_wrong

router = APIRouter(prefix="/api/practice", tags=["practice"])


def _public(e: Exercise, names: dict[int, str] | None = None) -> dict:
    """返回给前端做题用：不含答案"""
    ids = learning.load_ids(e.kp_ids)
    return {"id": e.id, "type": e.question_type, "question": e.question,
            "options": json.loads(e.options) if e.options else [], "page_no": e.page_no, "lang": e.lang or "zh",
            "kps": [{"id": k, "name": (names or {}).get(k, "")} for k in ids],
            "source_label": e.source_label or "", "marks": e.marks}


def _public_list(db: Session, exercises: list[Exercise]) -> list[dict]:
    ids = sorted({k for e in exercises for k in learning.load_ids(e.kp_ids)})
    names = learning.kp_names(db, ids)
    return [_public(e, names) for e in exercises]


def _session_doc(db: Session, session: StudySession) -> Document | None:
    if not session.document_id:
        return None
    return db.query(Document).filter(Document.id == session.document_id).first()


def _scope_pages(db: Session, session: StudySession, scope: str) -> tuple[str, list[dict]]:
    """取出出题用的页面内容"""
    doc = _session_doc(db, session)
    if session.document_id:
        if not doc:
            raise AppError(404, "not_found", "课件不存在")
        outline = _load_json(doc.outline, {})
        q = db.query(DocPage).filter(DocPage.document_id == doc.id)
        if scope.startswith("section-"):
            try:
                idx = int(scope.split("-", 1)[1])
                sec = outline.get("sections", [])[idx]
            except (ValueError, IndexError):
                raise AppError(400, "bad_request", "章节不存在")
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


def _save_batch(db: Session, session: StudySession, user_id: int, scope: str, items: list[dict],
                valid_pages: set[int], kps: list[KnowledgePoint], outline: dict) -> list[Exercise]:
    batch = str(uuid.uuid4())
    valid_kp = {k.id for k in kps}
    saved = []
    for ex in items:
        page_no = ex.get("page")
        try:
            page_no = int(page_no) if page_no is not None else None
        except (TypeError, ValueError):
            page_no = None
        if page_no not in valid_pages:
            page_no = None
        kp_ids = [k for k in (ex.get("kp_ids") or []) if k in valid_kp]
        if not kp_ids and kps:
            kp_ids = learning.fallback_kp(kps, outline, page_no)
        e = Exercise(
            session_id=session.session_id, chapter_index=0, question_type=ex["type"],
            question=str(ex.get("question", ""))[:4000],
            options=json.dumps(ex.get("options", []) if ex["type"] == "choice" else [], ensure_ascii=False),
            correct_answer=str(ex.get("answer", ""))[:4000], explanation=str(ex.get("explanation", ""))[:4000],
            key_points=json.dumps([str(k) for k in (ex.get("key_points") or [])][:6], ensure_ascii=False),
            page_no=page_no, scope=scope, batch=batch, answered=False, lang="en", user_id=user_id,
            kp_ids=json.dumps(kp_ids),
        )
        db.add(e)
        saved.append(e)
    db.commit()
    return saved


async def _create_batch(request: Request, db: Session, session: StudySession, user_id: int, scope: str,
                        focus_pages: set[int] | None = None) -> list[Exercise]:
    title, pages = _scope_pages(db, session, scope)
    if focus_pages:
        pages = [p for p in pages if p["page_no"] in focus_pages] or pages
    if not pages:
        raise AppError(400, "bad_request", "这部分没有可以出题的内容")
    doc = _session_doc(db, session)
    outline = _load_json(doc.outline, {}) if doc else {}
    kps = learning.ensure_kps(db, doc) if doc else []
    page_nos = {p["page_no"] for p in pages}

    if scope == "diagnostic":
        seen = [e.question for e in db.query(Exercise).filter(Exercise.session_id == session.session_id,
                                                              Exercise.user_id == user_id).all()]
        if sample.is_sample(doc):
            by_name = {sample.normalize_kp_name(k.name): k.id for k in kps}
            items = []
            for ex in sample.diagnostic_items(seen):
                ex["kp_ids"] = [by_name[sample.normalize_kp_name(n)] for n in ex.get("kps", [])
                                if sample.normalize_kp_name(n) in by_name][:1]
                items.append(ex)
        else:
            # 优先考还没掌握的知识点：章节 + 术语，最多 20 个
            attempts = learning.user_kp_attempts(db, user_id, [k.id for k in kps])
            ranked = sorted(kps, key=lambda k: (learning.mastery_from_attempts(attempts.get(k.id, []))["status"] == "mastered",
                                                k.kind != "section"))
            try:
                items = await ai_service.generate_diagnostic(
                    title, pages, [{"id": k.id, "name": k.name} for k in ranked[:20]], ctx=ai_ctx(request, db, user_id))
            except AIError as e:
                raise ai_http_error(e)
    elif sample.is_sample(doc):
        # 示例课程：用提前写好的题目，不调用 AI
        by_name = {sample.normalize_kp_name(k.name): k.id for k in kps}
        items = []
        for ex in sample.sample_exercises_for_pages(page_nos):
            ex["kp_ids"] = [by_name[sample.normalize_kp_name(n)] for n in ex.get("kps", [])
                            if sample.normalize_kp_name(n) in by_name]
            items.append(ex)
    else:
        scope_kps = learning.kps_for_scope(kps, page_nos)
        grade, major = user_profile(db, user_id)
        try:
            items = await ai_service.generate_english_exercises(
                title, pages, grade, major, ctx=ai_ctx(request, db, user_id),
                kps=[{"id": k.id, "name": k.name} for k in scope_kps])
        except AIError as e:
            raise ai_http_error(e)
    if not items:
        raise AppError(502, "ai_bad_output", "AI 没有生成出题目，请重试")
    return _save_batch(db, session, user_id, scope, items, page_nos, kps, outline)


@router.post("/generate/{session_id}")
@limiter.limit("30/hour")
async def gen_exercises(request: Request, session_id: str, scope: str = "all", fresh: int = 0,
                        user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """为学习记录出一套题（scope=all 整讲 / section-N 某一章 / retry / remedial）"""
    session = get_owned_session(db, session_id, user_id)
    if scope == "bank" or scope.startswith("bank-kp:"):
        # 3.0 题库：直接返回整理好的题（可以只看和某个知识点有关的）
        items = bank_svc.bank_exercises(db, session_id, user_id)
        if scope.startswith("bank-kp:"):
            want = sample.normalize_kp_name(scope[len("bank-kp:"):])
            kp_ids = {k.id for k in db.query(KnowledgePoint).filter(
                KnowledgePoint.id.in_(sorted({k for e in items for k in learning.load_ids(e.kp_ids)}) or [0])).all()
                if sample.normalize_kp_name(k.name) == want}
            items = [e for e in items if kp_ids & set(learning.load_ids(e.kp_ids))]
        if not items:
            raise AppError(404, "not_found", "还没有题库。先在课程的「考试」页把这份资料整理成题库。")
        return {"session_id": session_id, "scope": scope, "reused": True, "exercises": _public_list(db, items)}
    if scope not in ("all", "retry", "diagnostic") and not scope.startswith("section-"):
        scope = "all"
    if not fresh or scope == "retry":
        latest = (db.query(Exercise).filter(Exercise.session_id == session_id, Exercise.user_id == user_id,
                                            Exercise.scope == scope, Exercise.answered == False)  # noqa: E712
                  .order_by(Exercise.id.desc()).first())
        if latest and latest.batch:
            existing = (db.query(Exercise).filter(Exercise.batch == latest.batch).order_by(Exercise.id).all())
            return {"session_id": session_id, "scope": scope, "reused": True, "exercises": _public_list(db, existing)}
    if scope == "retry":
        raise AppError(404, "not_found", "这套重练题已经做完了，可以回错题本再生成一套")
    saved = await _create_batch(request, db, session, user_id, scope)
    return {"session_id": session_id, "scope": scope, "reused": False, "exercises": _public_list(db, saved)}


# ---- 错题本 ----
# 注意：/wrong-book 必须在 /{session_id} 之前，否则会被后者捕获

def wrong_entry_view(db: Session, wb: WrongBook, ex: Exercise, names: dict[int, str] | None = None) -> dict:
    ids = learning.load_ids(ex.kp_ids)
    names = names if names is not None else learning.kp_names(db, ids)
    last = (db.query(Attempt).filter(Attempt.user_id == wb.user_id, Attempt.exercise_id == ex.id)
            .order_by(Attempt.id.desc()).first())
    return {
        "id": wb.id, "exercise_id": wb.exercise_id, "session_id": ex.session_id, "page_no": ex.page_no,
        "question": ex.question, "question_type": ex.question_type,
        "options": json.loads(ex.options) if ex.options else [],
        "correct_answer": ex.correct_answer, "user_answer": wb.user_answer, "explanation": ex.explanation,
        "feedback": _load_json(wb.feedback, {}) or {},
        "kps": [{"id": k, "name": names.get(k, "")} for k in ids],
        "error_reason": last.error_reason if last else "",
        "attempt_id": last.id if last else None,
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
    names = learning.kp_names(db, sorted({k for _, ex in entries for k in learning.load_ids(ex.kp_ids)}))
    return {"entries": [wrong_entry_view(db, wb, ex, names) for wb, ex in entries]}


@router.delete("/wrong-book/{entry_id}")
async def remove_wrong(entry_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    wb = db.query(WrongBook).filter(WrongBook.id == entry_id, WrongBook.user_id == user_id).first()
    if not wb:
        raise AppError(404, "not_found", "错题不存在")
    wb.mastered = True
    wb.next_review_at = None
    db.commit()
    return {"status": "ok"}


@router.get("/error-reasons")
async def error_reasons():
    return {"reasons": [{"key": k, "label": v} for k, v in ERROR_TYPES.items()]}


class ErrorReasonRequest(BaseModel):
    error_reason: str


@router.patch("/attempts/{attempt_id}")
async def set_error_reason(attempt_id: int, req: ErrorReasonRequest, user_id: int = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    """学生自己修改错误原因（AI 推测的原因可能不准）"""
    a = db.query(Attempt).filter(Attempt.id == attempt_id, Attempt.user_id == user_id).first()
    if not a:
        raise AppError(404, "not_found", "作答记录不存在")
    if req.error_reason and req.error_reason not in ERROR_TYPES:
        raise AppError(400, "bad_request", "错误原因不在可选范围内")
    a.error_reason = req.error_reason
    a.error_reason_source = "user" if req.error_reason else ""
    db.commit()
    return {"status": "ok", "error_reason": a.error_reason}


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
    return {"session_id": session_id, "exercises": _public_list(db, q.order_by(Exercise.id).all())}


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


def record_attempt(db: Session, user_id: int, ex: Exercise, answer: str, g: dict, source: str) -> Attempt:
    a = Attempt(user_id=user_id, exercise_id=ex.id, session_id=ex.session_id, kp_ids=ex.kp_ids or "[]",
                question_type=ex.question_type, user_answer=(answer or "")[:4000],
                correct_answer=(ex.correct_answer or "")[:4000], status=g["status"], score=g.get("score"),
                evidence=g.get("evidence", "strong"), graded_by=g.get("graded_by", "rule"),
                error_reason=g.get("error_reason", "") or "", error_reason_source="ai" if g.get("error_reason") else "",
                feedback=json.dumps(g.get("feedback") or {}, ensure_ascii=False), source=source)
    db.add(a)
    return a


def result_view(ex: Exercise, a: Attempt, names: dict[int, str]) -> dict:
    fb = _load_json(a.feedback, {}) or {}
    ids = learning.load_ids(ex.kp_ids)
    return {
        "exercise_id": ex.id, "attempt_id": a.id, "user_answer": a.user_answer, "correct_answer": ex.correct_answer,
        "status": a.status, "is_correct": None if a.status == "ungraded" else a.status == "correct",
        "score": a.score, "feedback": fb, "explanation": ex.explanation, "page_no": ex.page_no,
        "key_points": load_key_points(ex.key_points), "evidence": a.evidence, "graded_by": a.graded_by,
        "error_reason": a.error_reason, "error_reason_source": a.error_reason_source,
        "kps": [{"id": k, "name": names.get(k, "")} for k in ids],
    }


@router.post("/submit/{session_id}")
@limiter.limit("60/hour")
async def submit_answers(request: Request, session_id: str, req: SubmitRequest,
                         user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """提交答案并批改（同一道题重复提交时直接返回第一次的结果）"""
    session = get_owned_session(db, session_id, user_id)
    doc = _session_doc(db, session)
    keyword_grader = sample.keyword_grade if sample.is_sample(doc) else None
    ids = []
    for a in req.answers[:50]:
        try:
            ids.append(int(a.get("exercise_id", 0)))
        except (TypeError, ValueError):
            continue
    exercises = (db.query(Exercise).filter(Exercise.session_id == session_id, Exercise.id.in_(ids))
                 .filter((Exercise.user_id == user_id) | (Exercise.user_id.is_(None))).all())
    if not exercises:
        raise AppError(404, "not_found", "练习题不存在")
    ex_map = {e.id: e for e in exercises}
    ctx = ai_ctx(request, db, user_id)

    pairs, seen = [], set()
    for a in req.answers[:50]:
        try:
            ex = ex_map.get(int(a.get("exercise_id", 0)))
        except (TypeError, ValueError):
            ex = None
        if ex and ex.id not in seen:
            seen.add(ex.id)
            pairs.append((ex, str(a.get("answer", "") or "")[:4000]))

    # 已经批改过的题（重复提交 / 网络重试）：直接用第一次的结果
    prior = {a.exercise_id: a for a in db.query(Attempt).filter(
        Attempt.user_id == user_id, Attempt.exercise_id.in_([e.id for e, _ in pairs]),
        Attempt.source.in_(["practice", "remedial", "diagnostic", "bank"])).order_by(Attempt.id).all()}
    # 题库的题可以反复练：只有 2 分钟内的重复提交才算同一次
    recent = datetime.utcnow() - timedelta(minutes=2)
    prior = {k: a for k, a in prior.items() if a.source != "bank" or (a.created_at and a.created_at >= recent)}
    to_grade = [(ex, ans) for ex, ans in pairs if not (ex.id in prior and prior[ex.id].status != "ungraded")]

    graded = await asyncio.gather(*[
        grade_one(ex.question_type, ex.question, ex.correct_answer, load_key_points(ex.key_points), ans, ctx,
                  keyword_grader=keyword_grader)
        for ex, ans in to_grade
    ])

    attempts: dict[int, Attempt] = {}
    for (ex, ans), g in zip(to_grade, graded):
        ex.answered = True
        source = ex.scope if ex.scope in ("remedial", "diagnostic", "bank") else "practice"
        attempts[ex.id] = record_attempt(db, user_id, ex, ans, g, source)
        if g["status"] == "wrong":
            upsert_wrong(db, user_id, ex, ans, g["feedback"])
    db.commit()

    if to_grade:
        persona.touch_activity(db, user_id)
    names = learning.kp_names(db, sorted({k for e, _ in pairs for k in learning.load_ids(e.kp_ids)}))
    results = []
    diag = [ex for ex, _ in pairs if ex.scope == "diagnostic"]
    for ex, _ in pairs:
        a = attempts.get(ex.id) or prior[ex.id]
        results.append(result_view(ex, a, names))
    correct = sum(1 for r in results if r["status"] == "correct")
    wrong = sum(1 for r in results if r["status"] == "wrong")
    ungraded = sum(1 for r in results if r["status"] == "ungraded")
    graded_n = correct + wrong
    if diag:
        # 记下这一讲最近一次诊断的结果（显示在课程的资料卡片上）
        p = _load_json(session.progress, {})
        p = p if isinstance(p, dict) else {}
        p["diagnostic"] = {"correct": correct, "total": graded_n, "at": datetime.utcnow().isoformat()}
        session.progress = json.dumps(p)
        db.commit()
    return {
        "total": len(results), "correct": correct, "wrong": wrong, "ungraded": ungraded,
        "score": round(correct / graded_n * 100) if graded_n else 0,
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
        raise AppError(400, "bad_request", "请提供要重练的错题")
    own_ids = {wb.exercise_id for wb in db.query(WrongBook).filter(
        WrongBook.user_id == user_id, WrongBook.exercise_id.in_(req.exercise_ids[:200])).all()}
    exercises = db.query(Exercise).filter(Exercise.id.in_(own_ids)).all()
    if not exercises:
        raise AppError(404, "not_found", "没有找到这些错题")

    # 选错题最多的那份学习记录，在它的相关页面上出题
    by_session: dict[str, list[Exercise]] = {}
    for e in exercises:
        by_session.setdefault(e.session_id, []).append(e)
    sid = max(by_session, key=lambda k: len(by_session[k]))
    session = db.query(StudySession).filter(StudySession.session_id == sid, StudySession.user_id == user_id).first()
    if not session:
        raise AppError(404, "not_found", "错题对应的学习记录不存在")

    wanted = {e.page_no for e in by_session[sid] if e.page_no}
    near = {n + d for n in wanted for d in (-1, 0, 1)} if wanted else None
    saved = await _create_batch(request, db, session, user_id, "all", focus_pages=near)
    for e in saved:
        e.scope = "retry"
    db.commit()
    return {"session_id": sid, "scope": "retry", "exercises": _public_list(db, saved)}
