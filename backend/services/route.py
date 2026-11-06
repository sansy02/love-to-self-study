"""
3.0「我的路线」：每天按你的情况，排出今天要做的几步。

排序依据（全部来自你的问卷和学习数据，每一步都会写出理由）：
- 有到期错题 → 先复习（遗忘曲线不等人）
- 需要加强 / 学习中的知识点：喜欢先弄懂的人先「补一补」，喜欢先做题的人先练原题
- 往年常考、还没掌握的知识点 → 练相关原题（目标「及格」只盯常考的，「冲 A」全部覆盖）
- 还没学完的课件按周往下学；学完的课件做诊断小测
- 离考试 14 天以内进入冲刺模式：常考点优先，新课件往后放
- 英文吃力的人，路线里加术语卡片

当天第一次打开时排好并保存（RoutePlan），之后只更新完成情况，不会一刷新就变。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from models.models import Attempt, Course, Document, RoutePlan, StudySession, User, UserVocab
from services import bank, learning, persona
from services import courses as course_svc

CST = timezone(timedelta(hours=8))
SPRINT_DAYS = 14


def _today_start_utc() -> datetime:
    now = datetime.now(CST)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(timezone.utc).replace(tzinfo=None)


def _week_label(s: StudySession) -> str:
    return f"第 {s.week} 周 · " if s.week is not None else ""


def _due_review_count(db, course: Course, user_id: int) -> int:
    from routers.review import _due_questions, _one_per_kp
    rows = _due_questions(db, user_id, datetime.utcnow(), course.id).all()
    return len(_one_per_kp(rows))


def _due_words(db, user_id: int) -> int:
    now = datetime.utcnow()
    return (db.query(UserVocab).filter(UserVocab.user_id == user_id, UserVocab.mastered != True)  # noqa: E712
            .filter((UserVocab.next_review_at.is_(None)) | (UserVocab.next_review_at <= now)).count())


def candidates(db, course: Course, user: User) -> tuple[list[dict], dict]:
    """所有可以做的事，按优先级从高到低排好"""
    answers = persona.load_profile(user)["answers"]
    reasons = persona.error_reason_counts(db, user.id)
    concept_first = persona.concept_first(answers, reasons)
    sessions = course_svc.course_sessions(db, course.id, user.id)
    docs = {d.id: d for d in db.query(Document).filter(Document.id.in_([s.document_id for s in sessions])).all()}
    exam = bank.exam_overview(db, course, user.id)
    left = exam["days_left"]
    sprint = left is not None and 0 <= left <= SPRINT_DAYS
    hot_by_name = {h["name"]: h for h in exam["hot"]}
    any_hot = bool(exam["hot"])
    out: list[dict] = []

    def add(prio: float, step: dict):
        step["prio"] = prio
        out.append(step)

    if not sessions:
        add(0, {"key": "add", "kind": "add", "title": "把这门课的第一份资料放进来", "minutes": 2,
                "reason": "路线要根据你的课件和题目来排", "action": {"type": "tab", "tab": "materials"}, "check": {}})
        return out, {"sprint": sprint, "days_left": left, "answers": answers}

    # 1. 到期错题
    n_due = _due_review_count(db, course, user.id)
    if n_due:
        add(0, {"key": "review", "kind": "review", "title": f"复习 {n_due} 道到期的错题", "minutes": min(10, 2 * n_due),
                "reason": "按遗忘曲线，这些题今天该再做一次了", "action": {"type": "tab", "tab": "review"}, "check": {}})

    # 2. 题目资料还没整理成题库
    for m in exam["materials"]:
        if not m["ready"]:
            add(5, {"key": f"build:{m['session_id']}", "kind": "build_bank", "title": f"把「{m['title']}」整理成题库",
                    "minutes": 1, "reason": "整理好之后，才能算出哪些知识点最常考",
                    "action": {"type": "build_bank", "session_id": m["session_id"]}, "check": {}})

    # 3. 知识点
    for g in bank.knowledge_groups(db, course, user.id):
        st = g["mastery"]["status"]
        if st == "mastered":
            continue
        h = hot_by_name.get(g["name"])
        exam_n = h["exam_count"] if h else 0
        hot_txt = f"往年考了 {exam_n} 次{'（' + str(h['marks']) + ' 分）' if h and h['marks'] else ''}" if exam_n else ""
        if answers["goal"] == "pass" and any_hot and not exam_n:
            continue                       # 及格就好：不常考的先放一放
        practice = h["practice"] if h else None
        if st in ("weak", "learning"):
            last_wrong = g["mastery"].get("last_status") == "wrong"
            base = 8 if st == "weak" else 14
            base -= min(exam_n, 4)
            why = "；".join(x for x in [hot_txt, "你最近两天都答错" if st == "weak" else ("你上次答错了" if last_wrong else g["mastery"]["note"])] if x)
            if practice and not concept_first:
                add(base, {"key": f"bank:{g['name']}", "kind": "bank", "title": f"练原题：{g['name']}", "minutes": 8,
                           "reason": why + "；你选了「先做题」，所以先练题", "kp_ids": g["kp_ids"],
                           "action": {"type": "practice", **practice}, "check": {}})
            else:
                add(base, {"key": f"remedial:{g['name']}", "kind": "remedial", "title": f"补一补：{g['name']}", "minutes": 5,
                           "reason": why + "；先看一段短讲解，再做一道新题", "kp_ids": g["kp_ids"],
                           "action": {"type": "remedial", "kp_id": g["id"], "name": g["name"]}, "check": {}})
        elif exam_n and practice:
            add(20 - min(exam_n * 2, 10) - (6 if sprint else 0),
                {"key": f"bank:{g['name']}", "kind": "bank", "title": f"练原题：{g['name']}", "minutes": 8,
                 "reason": hot_txt + "，你还没练过" + ("；离考试很近了，先练常考的" if sprint else ""), "kp_ids": g["kp_ids"],
                 "action": {"type": "practice", **practice}, "check": {}})
        elif answers["goal"] == "top" and g["kind"] != "section" and st == "new":
            add(45, {"key": f"remedial:{g['name']}", "kind": "remedial", "title": f"补一补：{g['name']}", "minutes": 5,
                     "reason": "你的目标是冲 A，每个知识点都要过一遍", "kp_ids": g["kp_ids"],
                     "action": {"type": "remedial", "kp_id": g["id"], "name": g["name"]}, "check": {}})

    # 4. 课件：没学完的往下学，学完没诊断的做诊断
    order = sorted((s for s in sessions if course_svc.normalize_type(s.material_type) in bank.STUDY_TYPES),
                   key=lambda s: (s.week if s.week is not None else 999, s.id))
    for i, s in enumerate(order):
        d = docs.get(s.document_id)
        if not d:
            continue
        p = course_svc.load_progress(s)
        visited = len(p.get("visited") or [])
        title = learning._load(d.outline, {}).get("title") or d.title
        if p.get("finished"):
            if not p.get("diagnostic"):
                add(12, {"key": f"diag:{s.session_id}", "kind": "diagnostic", "title": f"诊断小测：{title}", "minutes": 3,
                         "reason": "这一讲学完了，5 道题看看哪里还没懂",
                         "action": {"type": "practice", "session_id": s.session_id, "scope": "diagnostic"}, "check": {}})
            continue
        prio = 30 + i + (10 if answers["style"] == "practice" else 0) + (10 if sprint else 0)
        why = f"看到第 {p.get('last_page', 1)} / {d.page_count} 页" if visited else "还没开始学"
        if i == 0:
            why += "，按周顺序这是下一讲"
        add(prio, {"key": f"study:{s.session_id}", "kind": "study", "title": f"学 {_week_label(s)}{title}",
                   "minutes": 10 if answers["length"] == "short" else 15, "reason": why,
                   "action": {"type": "study", "session_id": s.session_id},
                   "check": {"visited": visited, "page_count": d.page_count or 0}})

    # 5. 术语卡片
    n_words = _due_words(db, user.id)
    if n_words:
        needs = persona.english_needs_terms(answers, reasons)
        add(15 if needs else 40, {"key": "words", "kind": "words", "title": f"背 {n_words} 张术语卡片", "minutes": min(8, n_words),
                                  "reason": "你看英文课件比较吃力，术语熟了题目才看得懂" if needs else "收藏的术语到复习时间了",
                                  "action": {"type": "page", "page": "review"}, "check": {}})

    out.sort(key=lambda x: x["prio"])
    return out, {"sprint": sprint, "days_left": left, "answers": answers}


def _done(db, step: dict, user_id: int, course: Course, today_attempts: list[Attempt]) -> bool:
    kind = step["kind"]
    if kind == "review":
        return _due_review_count(db, course, user_id) == 0
    if kind == "words":
        return _due_words(db, user_id) == 0
    if kind == "add":
        return bool(course_svc.course_sessions(db, course.id, user_id))
    if kind == "build_bank":
        s = db.query(StudySession).filter(StudySession.session_id == step["action"]["session_id"]).first()
        return bool(s and course_svc.load_progress(s).get("bank"))
    if kind in ("study", "diagnostic"):
        s = db.query(StudySession).filter(StudySession.session_id == step["action"]["session_id"],
                                          StudySession.user_id == user_id).first()
        if not s:
            return False
        p = course_svc.load_progress(s)
        if kind == "diagnostic":
            return bool(p.get("diagnostic"))
        base = step.get("check", {}).get("visited", 0)
        total = step.get("check", {}).get("page_count", 0)
        return bool(p.get("finished")) or len(p.get("visited") or []) >= min(total or 999, base + 5)
    if kind in ("remedial", "bank"):
        ids = set(step.get("kp_ids") or [])
        sources = {"remedial", "practice", "review", "diagnostic"} if kind == "remedial" else {"bank"}
        return any(a.source in sources and ids & set(learning.load_ids(a.kp_ids)) for a in today_attempts)
    return False


def _public(step: dict, done: bool) -> dict:
    return {k: v for k, v in step.items() if k not in ("prio", "check")} | {"done": done}


def build_route(db, course: Course, user: User, extra: int = 0) -> dict:
    day = persona.today()
    cands, info = candidates(db, course, user)
    answers = info["answers"]
    per_day = persona.STEPS_PER_DAY[answers["minutes"]]
    plan = db.query(RoutePlan).filter(RoutePlan.user_id == user.id, RoutePlan.course_id == course.id,
                                      RoutePlan.day == day).first()
    if not plan:
        steps = cands[:per_day]
        plan = RoutePlan(user_id=user.id, course_id=course.id, day=day, steps=json.dumps(steps, ensure_ascii=False))
        db.add(plan)
        db.commit()
    steps = json.loads(plan.steps or "[]")
    # 排路线时可做的事不够（比如题库还没整理），后来有了新的：补满到每天的步数
    want = max(per_day - len(steps), 0) + extra
    if want:
        have = {s["key"] for s in steps}
        more = [c for c in cands if c["key"] not in have][:want]
        if more:
            steps += more
            plan.steps = json.dumps(steps, ensure_ascii=False)
            db.commit()
    today_attempts = (db.query(Attempt).filter(Attempt.user_id == user.id, Attempt.created_at >= _today_start_utc()).all())
    today = [_public(s, _done(db, s, user.id, course, today_attempts)) for s in steps]
    keys = {s["key"] for s in steps}
    later = [_public(c, False) for c in cands if c["key"] not in keys][:5]
    done_n = sum(1 for s in today if s["done"])
    left = info["days_left"]
    profile = persona.load_profile(user)
    return {
        "day": day, "today": today, "later": later, "done": done_n, "total": len(today),
        "minutes": sum(s.get("minutes", 0) for s in today if not s["done"]),
        "streak": persona.streak(db, user.id), "days_left": left, "sprint": info["sprint"],
        "exam_date": course.exam_date or "", "profile_completed": profile["completed"],
        "style_summary": persona.style_summary(answers), "per_day": per_day,
    }


def reset_route(db, course: Course, user_id: int) -> None:
    db.query(RoutePlan).filter(RoutePlan.user_id == user_id, RoutePlan.course_id == course.id,
                               RoutePlan.day == persona.today()).delete()
    db.commit()
