"""
练习题 & 错题本 API
"""
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import get_db
from models.models import StudySession, Exercise, WrongBook, StudentProfile
from services.ai_service import generate_exercises, grade_answer
from routers.auth import get_current_user

router = APIRouter(prefix="/api/practice", tags=["practice"])


@router.post("/generate/{session_id}")
async def gen_exercises(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """为指定学习记录生成练习题"""
    session = db.query(StudySession).filter(StudySession.session_id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="学习记录不存在")

    # 拼接教学内容
    chapters = json.loads(session.content) if session.content else []
    content_text = ""
    for ch in chapters:
        for sec in ch.get("sections", []):
            content_text += sec.get("body", "") + "\n"

    if not content_text.strip():
        raise HTTPException(status_code=400, detail="教学内容为空")

    # 获取学生信息
    grade, major = "", ""
    if session.profile_id:
        p = db.query(StudentProfile).filter(StudentProfile.id == session.profile_id).first()
        if p:
            grade, major = p.grade, p.major

    # 调用 AI 生成
    try:
        exercises = await generate_exercises(content_text, grade=grade, major=major, user_id=user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {str(e)}")

    # 保存
    saved = []
    for ex in exercises:
        exercise = Exercise(
            session_id=session_id,
            chapter_index=0,
            question_type=ex.get("type", "choice"),
            question=ex.get("question", ""),
            options=json.dumps(ex.get("options", []), ensure_ascii=False),
            correct_answer=ex.get("answer", ""),
            explanation=ex.get("explanation", ""),
        )
        db.add(exercise)
        saved.append(exercise)
    db.commit()

    return {
        "session_id": session_id,
        "exercises": [
            {
                "id": e.id,
                "type": e.question_type,
                "question": e.question,
                "options": json.loads(e.options) if e.options else [],
                "answer": e.correct_answer,
                "explanation": e.explanation,
            }
            for e in saved
        ],
    }


# ---- 错题本 ----
# 注意：/wrong-book 必须在 /{session_id} 之前，否则会被后者捕获

@router.get("/wrong-book")
async def get_wrong_book(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取当前用户的错题本列表"""
    entries = (
        db.query(WrongBook, Exercise)
        .join(Exercise, WrongBook.exercise_id == Exercise.id)
        .filter(WrongBook.user_id == user_id)
        .order_by(WrongBook.created_at.desc())
        .all()
    )
    return {
        "entries": [
            {
                "id": wb.id,
                "exercise_id": wb.exercise_id,
                "question": ex.question,
                "question_type": ex.question_type,
                "options": json.loads(ex.options) if ex.options else [],
                "correct_answer": ex.correct_answer,
                "user_answer": wb.user_answer,
                "explanation": ex.explanation,
                "created_at": wb.created_at.isoformat() if wb.created_at else None,
            }
            for wb, ex in entries
        ],
    }


@router.get("/{session_id}")
async def get_exercises(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取已有练习题（不含答案）"""
    exercises = db.query(Exercise).filter(Exercise.session_id == session_id).all()
    return {
        "session_id": session_id,
        "exercises": [
            {
                "id": e.id,
                "type": e.question_type,
                "question": e.question,
                "options": json.loads(e.options) if e.options else [],
            }
            for e in exercises
        ],
    }


# ---- 批改 ----

class SubmitRequest(BaseModel):
    answers: list[dict]  # [{exercise_id, answer}]


@router.post("/submit/{session_id}")
async def submit_answers(session_id: str, req: SubmitRequest, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """提交答案并批改"""
    exercises = db.query(Exercise).filter(Exercise.session_id == session_id).all()
    if not exercises:
        raise HTTPException(status_code=404, detail="练习题不存在")

    ex_map = {e.id: e for e in exercises}
    results = []
    wrong_count = 0

    for ans in req.answers:
        ex_id = ans.get("exercise_id", 0)
        user_answer = ans.get("answer", "")
        exercise = ex_map.get(ex_id)
        if not exercise:
            continue

        # 选择题精确匹配，填空/简答用 AI 语义评判
        is_correct = False
        grading_note = ""
        if exercise.question_type == "choice":
            is_correct = user_answer.strip().upper() == exercise.correct_answer.strip().upper()
        else:
            cleaned = user_answer.strip()
            correct = exercise.correct_answer.strip()
            # 快速路径：精确匹配
            if cleaned and cleaned.lower() == correct.lower():
                is_correct = True
            elif cleaned:
                # AI 语义比较
                try:
                    ai_result = await grade_answer(
                        question=exercise.question,
                        correct_answer=correct,
                        user_answer=cleaned,
                        question_type=exercise.question_type,
                        user_id=user_id,
                    )
                    is_correct = ai_result.get("is_correct", False)
                    grading_note = ai_result.get("explanation", "")
                except Exception:
                    is_correct = False

        # 记录错题
        if not is_correct:
            wrong_count += 1
            entry = WrongBook(
                exercise_id=ex_id,
                user_answer=user_answer,
                is_correct=False,
                user_id=user_id,
            )
            db.add(entry)

        results.append({
            "exercise_id": ex_id,
            "user_answer": user_answer,
            "correct_answer": exercise.correct_answer,
            "is_correct": is_correct,
            "explanation": grading_note or exercise.explanation,
        })

    db.commit()

    return {
        "total": len(results),
        "correct": len(results) - wrong_count,
        "wrong": wrong_count,
        "score": round((len(results) - wrong_count) / len(results) * 100, 1) if results else 0,
        "results": results,
    }


# ---- 错题重练 ----

class RetryRequest(BaseModel):
    exercise_ids: list[int]


@router.post("/retry-wrong")
async def retry_wrong(req: RetryRequest, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """根据错题 exercise_ids 重新生成一套练习题"""
    if not req.exercise_ids:
        raise HTTPException(status_code=400, detail="请提供要重练的错题")

    # 找到这些 exercise 的 session_id，拼接内容
    exercises = db.query(Exercise).filter(Exercise.id.in_(req.exercise_ids)).all()
    session_ids = list(set(e.session_id for e in exercises))
    content_text = ""
    for sid in session_ids:
        session = db.query(StudySession).filter(StudySession.session_id == sid).first()
        if session:
            chapters = json.loads(session.content) if session.content else []
            for ch in chapters:
                for sec in ch.get("sections", []):
                    content_text += sec.get("body", "") + "\n"

    if not content_text.strip():
        raise HTTPException(status_code=400, detail="无法从错题中提取教学内容")

    # 调用 AI 生成新练习题
    try:
        new_exercises = await generate_exercises(content_text, user_id=user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {str(e)}")

    import uuid
    new_session_id = str(uuid.uuid4())

    saved = []
    for ex in new_exercises:
        exercise = Exercise(
            session_id=new_session_id,
            chapter_index=0,
            question_type=ex.get("type", "choice"),
            question=ex.get("question", ""),
            options=json.dumps(ex.get("options", []), ensure_ascii=False),
            correct_answer=ex.get("answer", ""),
            explanation=ex.get("explanation", ""),
        )
        db.add(exercise)
        saved.append(exercise)
    db.commit()

    return {
        "session_id": new_session_id,
        "exercises": [
            {
                "id": e.id,
                "type": e.question_type,
                "question": e.question,
                "options": json.loads(e.options) if e.options else [],
                "answer": e.correct_answer,
                "explanation": e.explanation,
            }
            for e in saved
        ],
    }
