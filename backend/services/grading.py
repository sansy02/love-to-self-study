"""
批改 + 间隔复习（莱特纳盒子）

批改规则：
- 选择题：对比字母。
- 填空题：完全一致直接判对，否则交给 AI 判断（允许同义词、单复数、拼写小错）。
- 简答题：AI 按得分点给 0–10 分，并给出中文的内容反馈、英文表达反馈和改写后的高分答案。
- AI 批改失败时状态为 ungraded（暂未批改）：不算错、不进错题本（以前会直接判错）。

复习间隔：答错 → 1 天后复习；之后每答对一次，间隔变为 2、4、7、15、30 天；全部通过算「已掌握」。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta

from services import ai_service
from services.ai_service import AIContext

INTERVALS_DAYS = [1, 2, 4, 7, 15, 30]


def _norm(s: str) -> str:
    return re.sub(r"[\s\.\,;:!\?'\"`’‘“”()（）]+", " ", (s or "").strip().lower()).strip()


def choice_letter(answer: str) -> str:
    a = (answer or "").strip().upper()
    m = re.match(r"^\(?([A-F])[\.\)、:：\s]?", a)
    return m.group(1) if m else a[:1]


async def grade_one(question_type: str, question: str, correct_answer: str, key_points: list[str],
                    user_answer: str, ctx: AIContext | None) -> dict:
    """返回 {status: correct|wrong|ungraded, is_correct, score, feedback{...}}"""
    ua = (user_answer or "").strip()
    if question_type == "choice":
        ok = bool(ua) and choice_letter(ua) == choice_letter(correct_answer)
        return {"status": "correct" if ok else "wrong", "is_correct": ok, "score": 10 if ok else 0, "feedback": {}}

    if not ua:
        return {"status": "wrong", "is_correct": False, "score": 0,
                "feedback": {"content": "没有作答。", "language": "", "improved": ""}}

    if question_type == "blank" and _norm(ua) == _norm(correct_answer):
        return {"status": "correct", "is_correct": True, "score": 10, "feedback": {}}

    try:
        r = await ai_service.grade_english_answer(question, correct_answer, key_points, ua, question_type, ctx)
    except Exception:  # noqa: BLE001 —— AI 报错、额度用完、格式不对：一律「暂未批改」，绝不判错
        return {"status": "ungraded", "is_correct": None, "score": None,
                "feedback": {"content": "AI 批改暂时失败，这题不计分，稍后可以在「今日复习」里重新批改。",
                             "language": "", "improved": ""}}
    return {"status": "correct" if r["is_correct"] else "wrong", "is_correct": r["is_correct"], "score": r["score"],
            "feedback": {"content": r["content_feedback"], "language": r["language_feedback"],
                         "improved": r["improved_answer"]}}


def load_key_points(raw: str) -> list[str]:
    try:
        v = json.loads(raw) if raw else []
        return [str(x) for x in v] if isinstance(v, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


# ---------------------------------------------------------------- 间隔复习

def schedule_after_wrong(item, now: datetime | None = None):
    now = now or datetime.utcnow()
    item.box = 0
    item.mastered = False
    item.next_review_at = now + timedelta(days=INTERVALS_DAYS[0])


def schedule_after_review(item, remembered: bool, now: datetime | None = None):
    now = now or datetime.utcnow()
    item.review_count = (item.review_count or 0) + 1
    if not remembered:
        schedule_after_wrong(item, now)
        return
    box = (item.box or 0) + 1
    item.box = box
    if box >= len(INTERVALS_DAYS):
        item.mastered = True
        item.next_review_at = None
    else:
        item.next_review_at = now + timedelta(days=INTERVALS_DAYS[box])
