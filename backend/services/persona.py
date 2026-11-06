"""
3.0 个性化：学习方式问卷、按学习方式讲解、学习日历、学习画像。

问卷只有 5 题（目标 / 英文 / 习惯 / 每天时间 / 讲解长度），随时可以改。
没填的时候用默认值，体验和 2.x 一样。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from models.models import ActivityDay, Attempt, User

CST = timezone(timedelta(hours=8))

QUESTIONS = [
    {"key": "goal", "title": "这门课你的目标是？", "default": "good", "options": [
        {"value": "pass", "label": "及格就好", "hint": "只盯最常考的点"},
        {"value": "good", "label": "想拿 B 左右", "hint": "常考的点都要会"},
        {"value": "top", "label": "冲 A", "hint": "每个知识点都覆盖"}]},
    {"key": "english", "title": "看英文课件的感觉？", "default": "mid", "options": [
        {"value": "low", "label": "基本看不懂", "hint": "讲解全用中文，关键句逐句翻译"},
        {"value": "mid", "label": "能看懂大概，细节吃力", "hint": "中文讲解，术语中英对照"},
        {"value": "high", "label": "英文基本没问题", "hint": "少翻译，多讲考点和易错点"}]},
    {"key": "style", "title": "你更喜欢怎么学？", "default": "example", "options": [
        {"value": "example", "label": "先看例子", "hint": "先用生活中的例子带入"},
        {"value": "definition", "label": "先看定义", "hint": "先给中英对照的准确定义"},
        {"value": "practice", "label": "先做题，错了再学", "hint": "路线里先练题，再回课件"}]},
    {"key": "minutes", "title": "每天大概能花多少时间？", "default": "30", "options": [
        {"value": "15", "label": "15 分钟", "hint": "每天 2 步"},
        {"value": "30", "label": "30 分钟", "hint": "每天 3 步"},
        {"value": "60", "label": "1 小时", "hint": "每天 5 步"}]},
    {"key": "length", "title": "讲解想要多长？", "default": "normal", "options": [
        {"value": "short", "label": "越短越好", "hint": "只讲重点"},
        {"value": "normal", "label": "适中", "hint": ""},
        {"value": "detailed", "label": "讲细一点", "hint": "多讲为什么"}]},
]
DEFAULTS = {q["key"]: q["default"] for q in QUESTIONS}
VALID = {q["key"]: {o["value"] for o in q["options"]} for q in QUESTIONS}
STEPS_PER_DAY = {"15": 2, "30": 3, "60": 5}

# 默认学习方式的讲解就是 2.x 的讲解（全站共用的那一份）
DEFAULT_STYLE_KEY = "mid-example-normal"


def load_profile(user: User | None) -> dict:
    try:
        raw = json.loads(user.learn_profile) if user and user.learn_profile else {}
    except (json.JSONDecodeError, TypeError):
        raw = {}
    answers = {k: (raw.get(k) if raw.get(k) in VALID[k] else DEFAULTS[k]) for k in DEFAULTS}
    return {"answers": answers, "completed": bool(raw.get("completed")), "updated_at": raw.get("updated_at")}


def save_profile(user: User, answers: dict) -> dict:
    clean = {}
    for k in DEFAULTS:
        v = str(answers.get(k, DEFAULTS[k]))
        if v not in VALID[k]:
            raise ValueError(k)
        clean[k] = v
    clean["completed"] = True
    clean["updated_at"] = datetime.utcnow().isoformat()
    user.learn_profile = json.dumps(clean)
    return load_profile(user)


def style_key(answers: dict) -> str:
    return f"{answers['english']}-{answers['style']}-{answers['length']}"


def style_rules(answers: dict) -> str:
    """按学习方式给讲解加的要求（写进讲解提示词）"""
    rules = []
    rules.append({
        "low": "- 学生英文很弱：全部用简体中文讲，每个英文术语后面都写中文；把这一页里最关键的 1–3 句英文原句逐句翻译出来。",
        "mid": "- 用简体中文讲，术语写成「中文 (English)」。",
        "high": "- 学生英文不错：不用逐句翻译，可以多用英文原词，重点讲考点、容易混淆和容易丢分的地方。",
    }[answers["english"]])
    rules.append({
        "example": "- 先用一个生活中的例子把学生带进来，再讲定义。",
        "definition": "- 先给出准确的定义（英文原句 + 中文意思），再解释，例子放在最后。",
        "practice": "- 先用一句话说这一页考什么、题目会怎么问，再讲答题思路和要点。",
    }[answers["style"]])
    rules.append({
        "short": "- explanation 控制在 80–200 字，只讲最重要的 2–3 点。",
        "normal": "- explanation 控制在 200–500 字。",
        "detailed": "- explanation 写 400–700 字，多讲为什么，把容易误解的地方说透。",
    }[answers["length"]])
    return "\n".join(rules)


def style_summary(answers: dict) -> str:
    labels = {q["key"]: {o["value"]: o["label"] for o in q["options"]} for q in QUESTIONS}
    return " · ".join([labels["english"][answers["english"]].replace("基本看不懂", "英文从中文讲起"),
                       labels["style"][answers["style"]], labels["length"][answers["length"]]])


# ---------------------------------------------------------------- 学习日历

def today() -> str:
    return datetime.now(CST).strftime("%Y-%m-%d")


def touch_activity(db, user_id: int) -> None:
    """今天学过（翻页、作答、复习都算）。失败不影响主流程。"""
    try:
        d = today()
        row = db.query(ActivityDay).filter(ActivityDay.user_id == user_id, ActivityDay.day == d).first()
        if row:
            row.count = (row.count or 0) + 1
        else:
            db.add(ActivityDay(user_id=user_id, day=d, count=1))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


def activity_days(db, user_id: int, days: int = 28) -> list[dict]:
    start = (datetime.now(CST) - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    rows = {r.day: r.count for r in db.query(ActivityDay).filter(ActivityDay.user_id == user_id,
                                                                    ActivityDay.day >= start).all()}
    out = []
    for i in range(days - 1, -1, -1):
        d = (datetime.now(CST) - timedelta(days=i)).strftime("%Y-%m-%d")
        out.append({"day": d, "count": rows.get(d, 0)})
    return out


def streak(db, user_id: int) -> int:
    """连续学习天数：今天还没学的话，从昨天往前数"""
    days = {r.day for r in db.query(ActivityDay).filter(ActivityDay.user_id == user_id).all()}
    n = 0
    cur = datetime.now(CST)
    if cur.strftime("%Y-%m-%d") not in days:
        cur -= timedelta(days=1)
    while cur.strftime("%Y-%m-%d") in days:
        n += 1
        cur -= timedelta(days=1)
    return n


# ---------------------------------------------------------------- 行为数据里看出来的习惯

def error_reason_counts(db, user_id: int) -> dict[str, int]:
    rows = db.query(Attempt).filter(Attempt.user_id == user_id, Attempt.status == "wrong").all()
    out: dict[str, int] = {}
    for a in rows:
        if a.error_reason:
            out[a.error_reason] = out.get(a.error_reason, 0) + 1
    return out


def adaptations(answers: dict, reasons: dict[str, int]) -> list[str]:
    """爱学根据你的情况做了哪些调整（只写真的生效了的）"""
    out = []
    out.append({
        "low": "讲解全部用中文，并把每页最关键的英文句子逐句翻译",
        "mid": "讲解用中文，术语中英对照",
        "high": "讲解少翻译，多讲考点和容易丢分的地方",
    }[answers["english"]])
    out.append({
        "example": "每页先用生活中的例子带入，再讲定义",
        "definition": "每页先给中英对照的定义，例子放在最后",
        "practice": "每页先告诉你考什么；路线里先练题，错了再回课件",
    }[answers["style"]])
    out.append({"short": "讲解只讲 2–3 个重点", "normal": "讲解长度适中", "detailed": "讲解写得更细，多讲为什么"}[answers["length"]])
    out.append(f"每天的路线安排 {STEPS_PER_DAY[answers['minutes']]} 步，大约 {answers['minutes']} 分钟")
    out.append({
        "pass": "路线只盯往年最常考的知识点，不常考的先放一放",
        "good": "路线优先常考的知识点，其他的穿插着学",
        "top": "路线覆盖每一个知识点，还会多安排简答题",
    }[answers["goal"]])
    if english_needs_terms(answers, reasons):
        why = f"你有 {reasons.get('english', 0)} 次是「题目英文没看懂」" if reasons.get("english", 0) >= 2 else "你看英文课件比较吃力"
        out.append(f"{why}：路线里会安排术语卡片复习")
    if concept_first(answers, reasons):
        why = f"你有 {reasons.get('concept', 0)} 次是「概念没懂」" if reasons.get("concept", 0) >= 2 else "你喜欢先弄懂再做题"
        out.append(f"{why}：答错的知识点先「补一补」，再去练原题")
    return out


def english_needs_terms(answers: dict, reasons: dict[str, int]) -> bool:
    return answers["english"] == "low" or reasons.get("english", 0) >= 2


def concept_first(answers: dict, reasons: dict[str, int]) -> bool:
    """答错的知识点：先补一补再练题（否则先练题）"""
    return answers["style"] != "practice" or reasons.get("concept", 0) >= 2
