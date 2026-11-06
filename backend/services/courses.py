"""
课程：把一门课的所有资料（老师课件、Tutorial、往年考试题、笔记）放在一起。

- 每个学习记录（StudySession）属于一门课（course_id）。
- 没有指定课程时放进「未分类」；示例课程放进「示例课程」。
- 2.1 及以前的学习记录没有课程，第一次打开课程列表时自动放进「未分类」。
"""
from __future__ import annotations

import json
from datetime import datetime

from errors import AppError
from models.models import Course, Document, StudySession

MATERIAL_TYPES = {
    "lecture": "老师课件",
    "tutorial": "Tutorial 题目",
    "past_exam": "往年考试题",
    "notes": "其他笔记",
}

INBOX_NAME = "未分类"
SAMPLE_COURSE_NAME = "示例课程：类与对象"


def normalize_type(t: str | None) -> str:
    return t if t in MATERIAL_TYPES else "lecture"


def get_owned_course(db, course_id: int, user_id: int) -> Course:
    c = db.query(Course).filter(Course.id == course_id, Course.user_id == user_id).first()
    if not c:
        raise AppError(404, "not_found", "找不到这门课")
    return c


def special_course(db, user_id: int, kind: str) -> Course:
    """未分类（inbox）或示例课程（sample），没有就创建"""
    c = db.query(Course).filter(Course.user_id == user_id, Course.kind == kind).first()
    if c:
        return c
    c = Course(user_id=user_id, name=INBOX_NAME if kind == "inbox" else SAMPLE_COURSE_NAME, kind=kind,
               code="" if kind == "inbox" else "SAMPLE", updated_at=datetime.utcnow())
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def adopt_orphans(db, user_id: int) -> None:
    """旧版的学习记录没有课程：示例课程放进示例课程，其余放进「未分类」"""
    orphans = (db.query(StudySession).filter(StudySession.user_id == user_id, StudySession.course_id.is_(None),
                                             StudySession.document_id.isnot(None)).all())
    if not orphans:
        return
    docs = {d.id: d for d in db.query(Document).filter(Document.id.in_([o.document_id for o in orphans])).all()}
    for o in orphans:
        d = docs.get(o.document_id)
        kind = "sample" if d is not None and d.source_type == "sample" else "inbox"
        o.course_id = special_course(db, user_id, kind).id
        if not o.material_type:
            o.material_type = "lecture"
    db.commit()


def course_sessions(db, course_id: int, user_id: int) -> list[StudySession]:
    return (db.query(StudySession).filter(StudySession.user_id == user_id, StudySession.course_id == course_id,
                                          StudySession.document_id.isnot(None))
            .order_by(StudySession.id).all())


def course_session_ids(db, course_id: int, user_id: int) -> list[str]:
    return [s.session_id for s in course_sessions(db, course_id, user_id)]


def touch(db, course_id: int | None) -> None:
    if course_id:
        c = db.query(Course).filter(Course.id == course_id).first()
        if c:
            c.updated_at = datetime.utcnow()


def load_progress(s: StudySession) -> dict:
    try:
        v = json.loads(s.progress) if s.progress else {}
        return v if isinstance(v, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}
