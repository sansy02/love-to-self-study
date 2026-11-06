"""
课程 API（2.2）

一门课 = 一组资料（老师课件 / Tutorial / 往年考试题 / 笔记），按周排列。
知识点、复习都可以按课程汇总：同名知识点（比如两份资料里都有 Encapsulation）合在一起算掌握度。
"""
import re
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from errors import AppError
from models.models import Course, Document, Exercise, KnowledgePoint, StudySession, User, WrongBook
from routers.auth import get_current_user
from middleware.rate_limit import limiter
from routers.study import ai_ctx, ai_http_error
from services import ai_service, bank, route
from services import courses as svc
from services import learning, sample
from services.ai_service import AIError

router = APIRouter(prefix="/api/courses", tags=["courses"])


class CourseRequest(BaseModel):
    name: str
    code: str = ""
    exam_date: str = ""


class CourseUpdate(BaseModel):
    name: str | None = None
    code: str | None = None
    exam_date: str | None = None


def _clean_date(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        raise AppError(400, "bad_request", "考试日期格式应该是 2026-12-15 这样")
    return v


def _due_by_session(db: Session, user_id: int) -> dict[str, int]:
    """每份资料今天要复习的错题数（同一个知识点只算一道）"""
    now = datetime.utcnow()
    rows = (db.query(WrongBook, Exercise).join(Exercise, WrongBook.exercise_id == Exercise.id)
            .filter(WrongBook.user_id == user_id, WrongBook.mastered != True)  # noqa: E712
            .filter((WrongBook.next_review_at.is_(None)) | (WrongBook.next_review_at <= now)).all())
    out: dict[str, int] = {}
    seen: set = set()
    for _, ex in rows:
        ids = learning.load_ids(ex.kp_ids)
        key = (ex.session_id, ids[0] if ids else f"q{ex.id}")
        if key in seen:
            continue
        seen.add(key)
        out[ex.session_id] = out.get(ex.session_id, 0) + 1
    return out


def course_view(c: Course, sessions: list[StudySession], due: dict[str, int]) -> dict:
    last = max((s.updated_at or s.created_at for s in sessions if (s.updated_at or s.created_at)), default=None)
    return {"id": c.id, "name": c.name, "code": c.code or "", "exam_date": c.exam_date or "", "kind": c.kind or "normal",
            "material_count": len(sessions), "due": sum(due.get(s.session_id, 0) for s in sessions),
            "last_studied_at": last.isoformat() if last else None,
            "created_at": c.created_at.isoformat() if c.created_at else None}


@router.get("")
async def list_courses(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    svc.adopt_orphans(db, user_id)
    courses = db.query(Course).filter(Course.user_id == user_id).all()
    sessions = (db.query(StudySession).filter(StudySession.user_id == user_id, StudySession.course_id.isnot(None),
                                              StudySession.document_id.isnot(None)).all())
    by_course: dict[int, list[StudySession]] = {}
    for s in sessions:
        by_course.setdefault(s.course_id, []).append(s)
    due = _due_by_session(db, user_id)
    out = [course_view(c, by_course.get(c.id, []), due) for c in courses]
    # 空的「未分类」不显示；示例课程排最后
    out = [c for c in out if not (c["kind"] == "inbox" and c["material_count"] == 0)]
    order = {"normal": 0, "inbox": 1, "sample": 2}
    out.sort(key=lambda c: (order.get(c["kind"], 0), -(datetime.fromisoformat(c["last_studied_at"] or c["created_at"] or "1970-01-01").timestamp())))
    return {"courses": out}


@router.post("")
async def create_course(req: CourseRequest, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    name = " ".join(req.name.split())
    if len(name) < 1:
        raise AppError(400, "bad_request", "请输入课程名")
    if len(name) > 120:
        raise AppError(400, "bad_request", "课程名太长了，120 字以内")
    if db.query(Course).filter(Course.user_id == user_id).count() >= 50:
        raise AppError(400, "bad_request", "最多可以建 50 门课")
    c = Course(user_id=user_id, name=name, code=req.code.strip()[:50], exam_date=_clean_date(req.exam_date),
               kind="normal", updated_at=datetime.utcnow())
    db.add(c)
    db.commit()
    db.refresh(c)
    return course_view(c, [], {})


@router.post("/sample")
async def open_sample_course(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """示例课程：一门已经放好一份示例课件的课（不消耗 AI 次数）"""
    c = svc.special_course(db, user_id, "sample")
    doc = sample.ensure_sample(db)
    learning.ensure_kps(db, doc)
    s = (db.query(StudySession).filter(StudySession.user_id == user_id, StudySession.document_id == doc.id).first())
    if not s:
        from routers.study import _get_or_create_session
        s = _get_or_create_session(db, user_id, doc, course_id=c.id, material_type="lecture", week=3)
    elif s.course_id != c.id:
        s.course_id = c.id
        db.commit()
    # 3.0：示例课程里再放一份示例往年考试题，用来演示题库和考试页
    exam_doc = sample.ensure_sample_exam(db)
    if not db.query(StudySession).filter(StudySession.user_id == user_id, StudySession.document_id == exam_doc.id).first():
        from routers.study import _get_or_create_session
        _get_or_create_session(db, user_id, exam_doc, course_id=c.id, material_type="past_exam", week=None)
    return {"course": course_view(c, [s], {}), "session_id": s.session_id}


@router.get("/{course_id}")
async def get_course(course_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    c = svc.get_owned_course(db, course_id, user_id)
    sessions = svc.course_sessions(db, c.id, user_id)
    docs = {d.id: d for d in db.query(Document).filter(Document.id.in_([s.document_id for s in sessions])).all()}
    due = _due_by_session(db, user_id)
    materials = []
    for s in sessions:
        d = docs.get(s.document_id)
        if not d:
            continue
        prog = svc.load_progress(s)
        outline = learning._load(d.outline, {})
        materials.append({
            "session_id": s.session_id,
            "title": outline.get("title") or d.title or s.topic,
            "material_type": svc.normalize_type(s.material_type),
            "type_label": svc.MATERIAL_TYPES[svc.normalize_type(s.material_type)],
            "week": s.week,
            "source_type": d.source_type,
            "page_count": d.page_count or 0,
            "last_page": prog.get("last_page", 1),
            "visited": len(prog.get("visited") or []),
            "finished": bool(prog.get("finished")) or (d.page_count and len(prog.get("visited") or []) >= d.page_count),
            "diagnostic": prog.get("diagnostic"),
            "due": due.get(s.session_id, 0),
            "updated_at": (s.updated_at or s.created_at).isoformat() if (s.updated_at or s.created_at) else None,
        })
    materials.sort(key=lambda m: (m["week"] if m["week"] is not None else 999, m["updated_at"] or ""))
    recent = max(materials, key=lambda m: m["updated_at"] or "", default=None)
    view = course_view(c, sessions, due)
    view.update({"materials": materials, "continue_session_id": recent["session_id"] if recent else None,
                 "types": [{"key": k, "label": v} for k, v in svc.MATERIAL_TYPES.items()]})
    return view


@router.patch("/{course_id}")
async def update_course(course_id: int, req: CourseUpdate, user_id: int = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    c = svc.get_owned_course(db, course_id, user_id)
    if req.name is not None:
        name = " ".join(req.name.split())
        if not name or len(name) > 120:
            raise AppError(400, "bad_request", "课程名不能为空，并且在 120 字以内")
        c.name = name
    if req.code is not None:
        c.code = req.code.strip()[:50]
    if req.exam_date is not None:
        c.exam_date = _clean_date(req.exam_date)
    if c.kind == "inbox" and req.name is not None:
        c.kind = "normal"  # 给「未分类」改了名字，就当成普通课程
    c.updated_at = datetime.utcnow()
    db.commit()
    return {"status": "ok"}


@router.delete("/{course_id}")
async def delete_course(course_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    c = svc.get_owned_course(db, course_id, user_id)
    if svc.course_sessions(db, c.id, user_id):
        raise AppError(400, "course_not_empty", "这门课里还有资料。先把资料移到别的课程，再删除。")
    db.delete(c)
    db.commit()
    return {"status": "ok"}


@router.get("/{course_id}/knowledge")
async def course_knowledge(course_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """整门课的知识点地图：不同资料里同名的知识点合在一起算掌握度（知识点来自老师课件和笔记）"""
    c = svc.get_owned_course(db, course_id, user_id)
    out = []
    for g in bank.knowledge_groups(db, c, user_id):
        m = g["mastery"]
        out.append({"id": g["id"], "name": g["name"], "kind": g["kind"], "sources": g["sources"],
                    "due_today": learning.is_due_today(m), **m})
    order = {"weak": 0, "learning": 1, "new": 2, "mastered": 3}
    out.sort(key=lambda x: (order[x["status"]], x["kind"] != "section", x["name"].lower()))
    counts = {k: sum(1 for x in out if x["status"] == k) for k in order}
    return {"knowledge_points": out, "counts": counts}


# ---------------------------------------------------------------- 3.0 考试页 + 题库

@router.get("/{course_id}/exam")
async def course_exam(course_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """考试页：题库状态、高频考点排行、考前计划"""
    c = svc.get_owned_course(db, course_id, user_id)
    return bank.exam_overview(db, c, user_id)


@router.post("/{course_id}/bank/{session_id}")
@limiter.limit("20/hour")
async def build_bank(request: Request, course_id: int, session_id: str, force: int = 0,
                     user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """把一份 Tutorial / 往年考试题整理成题库（拆题 + 对应知识点 + AI 参考答案）"""
    c = svc.get_owned_course(db, course_id, user_id)
    s = db.query(StudySession).filter(StudySession.session_id == session_id, StudySession.user_id == user_id,
                                      StudySession.course_id == c.id).first()
    if not s:
        raise AppError(404, "not_found", "这门课里没有这份资料")
    if svc.normalize_type(s.material_type) not in bank.EXAM_TYPES:
        raise AppError(400, "bad_request", "只有 Tutorial 和往年考试题可以整理成题库。可以在资料卡片的「⋯」里改类型。")
    existing = bank.bank_exercises(db, s.session_id, user_id)
    if existing and not force:
        return {"session_id": s.session_id, "count": len(existing), "reused": True}
    doc = db.query(Document).filter(Document.id == s.document_id).first()
    if not doc:
        raise AppError(404, "not_found", "资料不存在")
    groups = bank.knowledge_groups(db, c, user_id)
    pages = bank._pages_for(db, doc)
    if not pages:
        raise AppError(400, "upload_no_text", "这份资料里没有读到文字，没法拆题。扫描版 PDF 请换成带文字的版本。")
    if sample.is_sample_exam(doc):
        items = bank.sample_bank_items(groups)       # 示例练习卷：题库提前整理好，不调用 AI
    else:
        kps = bank.kp_choices(groups)
        items = []
        title = learning._load(doc.outline, {}).get("title") or doc.title
        ctx = ai_ctx(request, db, user_id)
        try:
            for chunk in bank.chunk_pages(pages):
                items += await ai_service.extract_questions(title, chunk, kps, svc.normalize_type(s.material_type), ctx=ctx)
        except AIError as e:
            if not items:
                raise ai_http_error(e)
    if not items:
        raise AppError(502, "ai_bad_output", "没有在这份资料里找到题目。如果它其实是课件，可以在「⋯」里把类型改成老师课件。")
    bank.clear_unused_bank(db, s.session_id, user_id)
    saved = bank.save_bank(db, s, user_id, items, {p["page_no"] for p in pages})
    bank.set_bank_status(s, len(saved))
    db.commit()
    return {"session_id": s.session_id, "count": len(saved), "reused": False,
            "mapped": sum(1 for e in saved if learning.load_ids(e.kp_ids))}


# ---------------------------------------------------------------- 3.0 我的路线

@router.get("/{course_id}/route")
async def course_route(course_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """今天这门课按你的情况排出来的几步（当天第一次打开时排好）"""
    c = svc.get_owned_course(db, course_id, user_id)
    u = db.query(User).filter(User.id == user_id).first()
    return route.build_route(db, c, u)


@router.post("/{course_id}/route/more")
async def course_route_more(course_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """今天的做完了，再加一步"""
    c = svc.get_owned_course(db, course_id, user_id)
    u = db.query(User).filter(User.id == user_id).first()
    return route.build_route(db, c, u, extra=1)


@router.post("/{course_id}/route/reset")
async def course_route_reset(course_id: int, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """按现在的情况重新排今天的路线"""
    c = svc.get_owned_course(db, course_id, user_id)
    route.reset_route(db, c, user_id)
    u = db.query(User).filter(User.id == user_id).first()
    return route.build_route(db, c, u)
