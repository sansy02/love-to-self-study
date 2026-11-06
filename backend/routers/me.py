"""
3.0「我」：学习方式问卷 + 学习画像
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from errors import AppError
from models.models import Attempt, Course, KnowledgePoint, Document, User
from routers.auth import get_current_user
from services import bank, learning, persona
from services.ai_service import ERROR_TYPES

router = APIRouter(prefix="/api/me", tags=["me"])


def _user(db: Session, user_id: int) -> User:
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise AppError(404, "not_found", "用户不存在")
    return u


def profile_view(u: User) -> dict:
    p = persona.load_profile(u)
    return {"questions": persona.QUESTIONS, "answers": p["answers"], "completed": p["completed"],
            "style_summary": persona.style_summary(p["answers"]), "updated_at": p["updated_at"]}


@router.get("/profile")
async def get_profile(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    return profile_view(_user(db, user_id))


class ProfileRequest(BaseModel):
    answers: dict


@router.put("/profile")
async def put_profile(req: ProfileRequest, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    u = _user(db, user_id)
    try:
        persona.save_profile(u, req.answers)
    except ValueError:
        raise AppError(400, "bad_request", "有一个选项不在可选范围内，请刷新页面后重试")
    # 学习方式变了：今天的路线按新的方式重新排
    from models.models import RoutePlan
    db.query(RoutePlan).filter(RoutePlan.user_id == u.id, RoutePlan.day == persona.today()).delete()
    db.commit()
    return profile_view(u)


@router.get("/portrait")
async def portrait(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """学习画像：学习日历、常犯错误、最弱的知识点、各门课的掌握比例、爱学做了哪些调整"""
    u = _user(db, user_id)
    answers = persona.load_profile(u)["answers"]
    reasons = persona.error_reason_counts(db, user_id)
    attempts = db.query(Attempt).filter(Attempt.user_id == user_id).all()
    graded = [a for a in attempts if a.status in ("correct", "wrong")]

    # 最弱的知识点（按知识点名字合并）
    by_kp = learning.user_kp_attempts(db, user_id)
    kps = {k.id: k for k in db.query(KnowledgePoint).filter(KnowledgePoint.id.in_(list(by_kp) or [0])).all()}
    titles = {d.id: d.title for d in db.query(Document).filter(Document.id.in_({k.document_id for k in kps.values()} or {""})).all()}
    merged: dict[str, dict] = {}
    for kid, rows in by_kp.items():
        k = kps.get(kid)
        if not k:
            continue
        key = k.name.strip().lower()
        g = merged.setdefault(key, {"name": k.name, "course": titles.get(k.document_id, ""), "attempts": {}})
        for a in rows:
            g["attempts"][a.id] = a
    weak = []
    for g in merged.values():
        m = learning.mastery_from_attempts(list(g["attempts"].values()))
        if m["status"] in ("weak", "learning") and m["wrong"]:
            weak.append({"name": g["name"], "course": g["course"], "status": m["status"], "label": m["label"], "wrong": m["wrong"]})
    weak.sort(key=lambda w: (w["status"] != "weak", -w["wrong"]))

    # 各门课
    courses = []
    for c in db.query(Course).filter(Course.user_id == user_id).all():
        groups = bank.knowledge_groups(db, c, user_id)
        if not groups:
            continue
        courses.append({"id": c.id, "name": c.name, "kind": c.kind or "normal", "total": len(groups),
                        "mastered": sum(1 for g in groups if g["mastery"]["status"] == "mastered"),
                        "learning": sum(1 for g in groups if g["mastery"]["status"] in ("learning", "weak")),
                        "days_left": bank.days_left(c.exam_date or "")})

    days = persona.activity_days(db, user_id, 28)
    return {
        "streak": persona.streak(db, user_id),
        "calendar": days,
        "active_days": sum(1 for d in days if d["count"]),
        "answered": len(graded),
        "accuracy": round(sum(1 for a in graded if a.status == "correct") / len(graded) * 100) if graded else None,
        "reasons": [{"key": k, "label": v, "count": reasons.get(k, 0)} for k, v in ERROR_TYPES.items()],
        "weak": weak[:5],
        "courses": courses,
        "adaptations": persona.adaptations(answers, reasons),
        "style_summary": persona.style_summary(answers),
        "profile_completed": persona.load_profile(u)["completed"],
    }
