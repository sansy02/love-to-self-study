"""
知识点 + 掌握度

知识点从哪来：课件大纲的每个章节（section）+ 已生成讲解里的关键术语（term）。
出题时 AI 只能从这份清单里选知识点；选错或没选的题，按出自哪一页自动归到对应章节。

掌握度规则（写给学生看，也写给以后的自己看）：
- 选择题、填空题按规则判分，算「硬证据」（strong）；简答题是 AI 打分，只算「参考」（weak）。
- 错一次不代表不会：只错过一次（或同一天错了几道同知识点的题）→ 「学习中」，提示明天再试。
- 在两个不同的日子连续答错（中间没有答对过）→ 「需要加强」。
- 至少在两个不同的日子答对，其中至少一次是硬证据，并且最近一次是对的 → 「已掌握」。
- 只有 AI 评分的简答题答对，不会直接判定为已掌握，要再用一道选择/填空题确认。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from models.models import Attempt, DocPage, Document, Exercise, KnowledgePoint

CST = timezone(timedelta(hours=8))

STATUS_LABELS = {
    "new": "还没练过",
    "learning": "学习中",
    "weak": "需要加强",
    "mastered": "已掌握",
}


def load_ids(raw) -> list[int]:
    try:
        v = json.loads(raw) if isinstance(raw, str) and raw else (raw or [])
        return [int(x) for x in v if str(x).lstrip("-").isdigit()]
    except (json.JSONDecodeError, TypeError, ValueError):
        return []


def _load(raw, default):
    try:
        return json.loads(raw) if raw else default
    except (json.JSONDecodeError, TypeError):
        return default


# ---------------------------------------------------------------- 知识点

def ensure_kps(db, doc: Document) -> list[KnowledgePoint]:
    """确保这份课件的知识点清单存在（章节 + 已讲解页面里的术语），返回全部知识点"""
    existing = {k.name.lower(): k for k in db.query(KnowledgePoint).filter(KnowledgePoint.document_id == doc.id).all()}
    outline = _load(doc.outline, {})
    added = False
    for i, sec in enumerate(outline.get("sections", [])):
        name = str(sec.get("title", "")).strip()[:200]
        if name and name.lower() not in existing:
            k = KnowledgePoint(document_id=doc.id, name=name, kind="section", section_index=i,
                               page_start=sec.get("start"), page_end=sec.get("end"))
            db.add(k)
            existing[name.lower()] = k
            added = True
    from models.models import PageStyleExplanation
    pages = [(p.page_no, p.explanation) for p in
             db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.explanation != "").all()]
    # 3.0：按学习方式生成的讲解里的术语也算
    pages += [(r.page_no, r.explanation) for r in
              db.query(PageStyleExplanation).filter(PageStyleExplanation.document_id == doc.id).all()]
    for page_no, raw in pages:
        expl = _load(raw, {}) or {}
        for t in (expl.get("key_terms") or [])[:6]:
            en = str(t.get("en", "")).strip()[:200]
            if en and en.lower() not in existing and len(existing) < 120:
                sec_i = section_index_for(outline, page_no)
                k = KnowledgePoint(document_id=doc.id, name=en, kind="term", section_index=sec_i,
                                   page_start=page_no, page_end=page_no)
                db.add(k)
                existing[en.lower()] = k
                added = True
    if added:
        db.commit()
    return list(existing.values())


def section_index_for(outline: dict, page_no: int | None) -> int | None:
    if page_no is None:
        return None
    for i, s in enumerate(outline.get("sections", [])):
        if s.get("start", 0) <= page_no <= s.get("end", 0):
            return i
    return None


def kps_for_scope(kps: list[KnowledgePoint], page_nos: set[int]) -> list[KnowledgePoint]:
    """只给出和这些页面相关的知识点，避免清单太长"""
    out = []
    for k in kps:
        if k.page_start is None or k.page_end is None:
            continue
        if any(k.page_start <= n <= k.page_end for n in page_nos):
            out.append(k)
    return out[:40]


def fallback_kp(kps: list[KnowledgePoint], outline: dict, page_no: int | None) -> list[int]:
    """AI 没给知识点时：按题目出自的页面，归到所在章节"""
    sec_i = section_index_for(outline, page_no)
    for k in kps:
        if k.kind == "section" and k.section_index == sec_i:
            return [k.id]
    sections = [k for k in kps if k.kind == "section"]
    return [sections[0].id] if sections else []


def kp_names(db, ids: list[int]) -> dict[int, str]:
    if not ids:
        return {}
    return {k.id: k.name for k in db.query(KnowledgePoint).filter(KnowledgePoint.id.in_(ids)).all()}


# ---------------------------------------------------------------- 掌握度

def _day(dt: datetime) -> str:
    return dt.replace(tzinfo=timezone.utc).astimezone(CST).strftime("%Y-%m-%d")


def _wrong_streak_days(graded: list[Attempt]) -> set[str]:
    """最近一次答对之后，答错发生在哪几天（同一天错好几道只算一天）"""
    days = set()
    for a in reversed(graded):
        if a.status == "correct":
            break
        if a.created_at:
            days.add(_day(a.created_at))
    return days


def mastery_from_attempts(attempts: list[Attempt]) -> dict:
    graded = [a for a in sorted(attempts, key=lambda a: (a.created_at or datetime.min, a.id or 0))
              if a.status in ("correct", "wrong")]
    if not graded:
        return {"status": "new", "label": STATUS_LABELS["new"], "note": "", "attempts": 0,
                "correct_days": 0, "wrong": 0}
    correct = [a for a in graded if a.status == "correct"]
    wrong = [a for a in graded if a.status == "wrong"]
    correct_days = {_day(a.created_at) for a in correct if a.created_at}
    strong_days = {_day(a.created_at) for a in correct if a.created_at and a.evidence == "strong"}
    last = graded[-1]

    if last.status == "correct" and len(correct_days) >= 2 and strong_days:
        status, note = "mastered", f"在 {len(correct_days)} 个不同的日子答对过"
    elif last.status == "wrong" and len(streak_days := _wrong_streak_days(graded)) >= 2:
        status, note = "weak", f"连续 {len(streak_days)} 天都答错了，建议补一补"
    elif last.status == "wrong":
        status, note = "learning", "错了还不能说明不会，明天再试一次"
    elif not strong_days:
        status, note = "learning", "目前只有 AI 评分的简答题答对，再做一道选择或填空题确认"
    else:
        status, note = "learning", "答对过，换一天再答对一次就算掌握"
    return {"status": status, "label": STATUS_LABELS[status], "note": note, "attempts": len(graded),
            "correct_days": len(correct_days), "wrong": len(wrong),
            "last_at": last.created_at.isoformat() if last.created_at else None,
            "last_status": last.status}


def user_kp_attempts(db, user_id: int, kp_ids: list[int] | None = None) -> dict[int, list[Attempt]]:
    rows = db.query(Attempt).filter(Attempt.user_id == user_id).order_by(Attempt.created_at, Attempt.id).all()
    out: dict[int, list[Attempt]] = {}
    for a in rows:
        for k in load_ids(a.kp_ids):
            if kp_ids is None or k in kp_ids:
                out.setdefault(k, []).append(a)
    return out


def is_due_today(m: dict) -> bool:
    """最近一次答错、而且不是今天错的 → 今天该重新作答（第二天复习）"""
    if m["status"] not in ("learning", "weak") or m.get("last_status") != "wrong" or not m.get("last_at"):
        return False
    last = datetime.fromisoformat(m["last_at"])
    return _day(last) < datetime.now(CST).strftime("%Y-%m-%d")


def exercise_kps(ex: Exercise) -> list[int]:
    return load_ids(ex.kp_ids)
