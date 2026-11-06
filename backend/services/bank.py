"""
3.0 题库 + 考试页

- 题库：把 Tutorial / 往年考试题拆成一道道题（Exercise，scope="bank"），每道题对应到课程知识点。
  之后作答、批改、错题本、复习、掌握度都和普通练习一样。
- 高频考点：统计每个知识点在往年题里出现几次、一共多少分，再结合掌握情况排序。
- 考前计划：按离考试还有几天，把没掌握的知识点分到每一天，今天给 3 件事。
"""
from __future__ import annotations

import json
import math
import uuid
from datetime import datetime, timedelta, timezone

from models.models import Attempt, Course, DocPage, Document, Exercise, StudySession
from services import courses as course_svc
from services import learning, sample

CST = timezone(timedelta(hours=8))
EXAM_TYPES = ("tutorial", "past_exam")
STUDY_TYPES = ("lecture", "notes")


# ---------------------------------------------------------------- 课程知识点（按名字合并）

def knowledge_groups(db, course: Course, user_id: int) -> list[dict]:
    """
    整门课的知识点，不同资料里同名的合在一起。
    知识点只来自老师课件和笔记；整门课只有题目类资料时，才用题目资料里的章节。
    """
    sessions = course_svc.course_sessions(db, course.id, user_id)
    has_study = any(course_svc.normalize_type(s.material_type) in STUDY_TYPES for s in sessions)
    docs = {d.id: d for d in db.query(Document).filter(Document.id.in_([s.document_id for s in sessions])).all()}
    groups: dict[str, dict] = {}
    for s in sessions:
        mtype = course_svc.normalize_type(s.material_type)
        if has_study and mtype not in STUDY_TYPES:
            continue
        d = docs.get(s.document_id)
        if not d:
            continue
        title = learning._load(d.outline, {}).get("title") or d.title
        for k in learning.ensure_kps(db, d):
            key = sample.normalize_kp_name(k.name)
            g = groups.setdefault(key, {"key": key, "name": k.name, "kind": k.kind, "kp_ids": [], "sources": []})
            if k.kind == "section":
                g["kind"] = "section"
            g["kp_ids"].append(k.id)
            g["sources"].append({"session_id": s.session_id, "title": title, "week": s.week, "material_type": mtype,
                                 "page_start": k.page_start, "page_end": k.page_end})
    all_ids = [i for g in groups.values() for i in g["kp_ids"]]
    attempts = learning.user_kp_attempts(db, user_id, all_ids)
    for g in groups.values():
        merged = {a.id: a for i in g["kp_ids"] for a in attempts.get(i, [])}
        g["mastery"] = learning.mastery_from_attempts(list(merged.values()))
        practiced = [i for i in g["kp_ids"] if attempts.get(i)]
        g["id"] = (practiced or g["kp_ids"])[0]
    return list(groups.values())


def kp_choices(groups: list[dict], limit: int = 80) -> list[dict]:
    """给 AI 的知识点清单：每个名字一个 id（章节在前）"""
    ordered = sorted(groups, key=lambda g: g["kind"] != "section")
    return [{"id": g["kp_ids"][0], "name": g["name"]} for g in ordered[:limit]]


# ---------------------------------------------------------------- 拆题

def bank_exercises(db, session_id: str, user_id: int) -> list[Exercise]:
    return (db.query(Exercise).filter(Exercise.session_id == session_id, Exercise.user_id == user_id,
                                      Exercise.scope == "bank").order_by(Exercise.id).all())


def _pages_for(db, doc: Document) -> list[dict]:
    pages = db.query(DocPage).filter(DocPage.document_id == doc.id).order_by(DocPage.page_no).all()
    return [{"page_no": p.page_no, "text": p.text or ""} for p in pages if (p.text or "").strip()]


def chunk_pages(pages: list[dict], budget: int = 14000) -> list[list[dict]]:
    chunks, cur, size = [], [], 0
    for p in pages:
        t = len(p["text"][:2500]) + 20
        if cur and size + t > budget:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(p)
        size += t
    if cur:
        chunks.append(cur)
    return chunks[:8]   # 最多 8 段（大约 100 页），避免一份资料用掉太多次数


def save_bank(db, s: StudySession, user_id: int, items: list[dict], valid_pages: set[int]) -> list[Exercise]:
    batch = str(uuid.uuid4())
    saved = []
    for it in items:
        page = it.get("page")
        try:
            page = int(page) if page is not None else None
        except (TypeError, ValueError):
            page = None
        e = Exercise(session_id=s.session_id, chapter_index=0, question_type=it["type"],
                     question=str(it.get("question", ""))[:4000],
                     options=json.dumps(it.get("options", []) if it["type"] == "choice" else [], ensure_ascii=False),
                     correct_answer=str(it.get("answer", ""))[:4000], explanation=str(it.get("explanation", ""))[:4000],
                     key_points=json.dumps([str(k) for k in (it.get("key_points") or [])][:6], ensure_ascii=False),
                     page_no=page if page in valid_pages else None, scope="bank", batch=batch, answered=False, lang="en",
                     user_id=user_id, kp_ids=json.dumps(it.get("kp_ids") or []),
                     source_label=str(it.get("label") or "")[:200], marks=it.get("marks"))
        db.add(e)
        saved.append(e)
    return saved


def clear_unused_bank(db, session_id: str, user_id: int) -> None:
    """重新整理前：删掉还没人做过的旧题（做过的保留，作答记录不会丢）"""
    old = bank_exercises(db, session_id, user_id)
    if not old:
        return
    done = {a.exercise_id for a in db.query(Attempt).filter(Attempt.user_id == user_id,
                                                            Attempt.exercise_id.in_([e.id for e in old])).all()}
    for e in old:
        if e.id in done:
            e.scope = "bank_old"   # 保留作答记录，但不再出现在题库里
        else:
            db.delete(e)


def set_bank_status(s: StudySession, count: int) -> None:
    p = course_svc.load_progress(s)
    p["bank"] = {"count": count, "at": datetime.utcnow().isoformat()}
    s.progress = json.dumps(p)


def sample_bank_items(groups: list[dict]) -> list[dict]:
    by_name = {g["key"]: g["kp_ids"][0] for g in groups}
    items = []
    for q in sample.SAMPLE_BANK:
        it = dict(q)
        it["kp_ids"] = [by_name[sample.normalize_kp_name(n)] for n in q["kps"] if sample.normalize_kp_name(n) in by_name][:2]
        items.append(it)
    return items


# ---------------------------------------------------------------- 考试页

def days_left(exam_date: str) -> int | None:
    if not exam_date:
        return None
    try:
        d = datetime.strptime(exam_date, "%Y-%m-%d").date()
    except ValueError:
        return None
    return (d - datetime.now(CST).date()).days


STATUS_WEIGHT = {"weak": 4, "learning": 2, "new": 1, "mastered": 0}


def exam_overview(db, course: Course, user_id: int) -> dict:
    sessions = course_svc.course_sessions(db, course.id, user_id)
    by_sid = {s.session_id: s for s in sessions}
    docs = {d.id: d for d in db.query(Document).filter(Document.id.in_([s.document_id for s in sessions])).all()}
    groups = knowledge_groups(db, course, user_id)
    id_to_group = {i: g for g in groups for i in g["kp_ids"]}

    bank = (db.query(Exercise).filter(Exercise.user_id == user_id, Exercise.scope == "bank",
                                      Exercise.session_id.in_(list(by_sid) or [""])).all())
    done_ids = {a.exercise_id for a in db.query(Attempt).filter(
        Attempt.user_id == user_id, Attempt.exercise_id.in_([e.id for e in bank] or [0])).all()}

    # 每份题目资料的题库状态
    materials = []
    for s in sessions:
        mtype = course_svc.normalize_type(s.material_type)
        if mtype not in EXAM_TYPES:
            continue
        d = docs.get(s.document_id)
        mine = [e for e in bank if e.session_id == s.session_id]
        status = course_svc.load_progress(s).get("bank")
        materials.append({
            "session_id": s.session_id, "title": (learning._load(d.outline, {}).get("title") if d else "") or (d.title if d else s.topic),
            "material_type": mtype, "type_label": course_svc.MATERIAL_TYPES[mtype], "week": s.week,
            "page_count": d.page_count if d else 0, "ready": status is not None, "count": len(mine),
            "done": sum(1 for e in mine if e.id in done_ids),
            "marks": sum(e.marks or 0 for e in mine),
            "is_sample": sample.is_sample_exam(d),
        })

    # 高频考点
    stats: dict[str, dict] = {}
    for e in bank:
        mtype = course_svc.normalize_type(by_sid[e.session_id].material_type)
        seen = set()
        for k in learning.load_ids(e.kp_ids):
            g = id_to_group.get(k)
            if not g or g["key"] in seen:
                continue
            seen.add(g["key"])
            st = stats.setdefault(g["key"], {"exam": 0, "tutorial": 0, "marks": 0, "by_session": {}})
            if mtype == "past_exam":
                st["exam"] += 1
                st["marks"] += e.marks or 0
            else:
                st["tutorial"] += 1
            st["by_session"][e.session_id] = st["by_session"].get(e.session_id, 0) + 1

    def view(g: dict) -> dict:
        st = stats.get(g["key"], {"exam": 0, "tutorial": 0, "marks": 0, "by_session": {}})
        practice = None
        if st["by_session"]:
            sid = max(st["by_session"], key=lambda k: st["by_session"][k])
            practice = {"session_id": sid, "scope": f"bank-kp:{g['name']}"}
        study = next((src for src in g["sources"] if src["material_type"] in STUDY_TYPES), g["sources"][0] if g["sources"] else None)
        m = g["mastery"]
        return {"id": g["id"], "name": g["name"], "kind": g["kind"], "status": m["status"], "label": m["label"], "note": m["note"],
                "exam_count": st["exam"], "tutorial_count": st["tutorial"], "marks": st["marks"], "practice": practice,
                "study": {"session_id": study["session_id"], "page_start": study["page_start"]} if study else None}

    hot = [view(g) for g in groups if g["key"] in stats]
    hot.sort(key=lambda h: (-h["exam_count"], -h["marks"], -h["tutorial_count"], STATUS_WEIGHT[h["status"]] * -1, h["name"].lower()))

    # 考前计划：没掌握的知识点按「常考程度 + 掌握情况」排优先级，平均分到剩下的每一天
    left = days_left(course.exam_date or "")
    pending = [view(g) for g in groups if g["mastery"]["status"] != "mastered"]
    pending.sort(key=lambda h: -(3 * h["exam_count"] + h["tutorial_count"] + STATUS_WEIGHT[h["status"]]))
    plan = None
    if left is not None:
        per_day = math.ceil(len(pending) / max(left, 1)) if pending else 0
        tasks = []
        for h in pending[:max(1, min(3, per_day))] if pending else []:
            if h["status"] in ("weak", "learning"):
                action = "remedial"
            elif h["practice"]:
                action = "bank"
            else:
                action = "study"
            tasks.append({**h, "action": action})
        plan = {"days_left": left, "per_day": per_day, "pending": len(pending),
                "mastered": sum(1 for g in groups if g["mastery"]["status"] == "mastered"), "total": len(groups),
                "tasks": tasks if left >= 0 else []}

    return {"exam_date": course.exam_date or "", "days_left": left, "materials": materials, "hot": hot[:30],
            "plan": plan, "has_study_material": any(course_svc.normalize_type(s.material_type) in STUDY_TYPES for s in sessions),
            "question_count": len(bank)}
