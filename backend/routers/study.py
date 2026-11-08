"""
逐页学习 API（新版核心流程）

上传课件 → 解析每一页 → 生成大纲（很快）→ 打开哪一页才讲解哪一页（按需生成 + 全站缓存）
→ 每一页都可以追问 → 练习 / 复习

同一份课件（按文件内容哈希）全站只解析一次、每页只讲解一次：
后上传同一份课件的同学直接复用，秒出结果，也不消耗 AI 额度。
"""

import asyncio
import base64
import hashlib
import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import logging

import config
from database import get_db
from middleware.rate_limit import limiter, client_ip
from models.models import Document, DocPage, PageChat, PageStyleExplanation, StudySession, User
from routers.auth import get_current_user
from services import ai_service
from services.ai_service import AIContext, AIError
from services.parser_service import parse_document
from services import learning, sample
from services import courses as course_svc
from services import persona
from errors import AppError

router = APIRouter(prefix="/api/study", tags=["study"])
logger = logging.getLogger("aixue.study")

_page_locks: dict[tuple[str, int], asyncio.Lock] = {}


def _lock_for(doc_id: str, page_no: int) -> asyncio.Lock:
    key = (doc_id, page_no)
    if key not in _page_locks:
        if len(_page_locks) > 5000:
            _page_locks.clear()
        _page_locks[key] = asyncio.Lock()
    return _page_locks[key]


def ai_ctx(request: Request, db: Session, user_id: int) -> AIContext:
    return AIContext(user_id=user_id, ip=client_ip(request), db=db)


def ai_http_error(e: AIError) -> AppError:
    return AppError(e.status_code, e.code, str(e))


# ---------------------------------------------------------------- 工具

def get_owned_session(db: Session, session_id: str, user_id: int) -> StudySession:
    s = db.query(StudySession).filter(StudySession.session_id == session_id).first()
    if not s or s.user_id != user_id:
        raise AppError(404, "not_found", "找不到这条学习记录，可能已经被删除，或者不是你的。")
    return s


def get_session_doc(db: Session, session_id: str, user_id: int) -> tuple[StudySession, Document]:
    s = get_owned_session(db, session_id, user_id)
    if not s.document_id:
        raise HTTPException(status_code=400, detail="这是旧版学习记录，不支持逐页学习")
    doc = db.query(Document).filter(Document.id == s.document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="课件不存在")
    return s, doc


def _load_json(text: str, default):
    try:
        return json.loads(text) if text else default
    except (json.JSONDecodeError, TypeError):
        return default


def fallback_outline(doc: Document, pages: list[DocPage]) -> dict:
    """AI 不可用时的大纲：每 5 页一章，用页面标题当章节名"""
    n = len(pages)
    size = 5 if n > 8 else max(n, 1)
    sections = []
    for start in range(1, n + 1, size):
        end = min(start + size - 1, n)
        first = next((p for p in pages if p.page_no == start), None)
        name = (first.title if first and first.title else f"第 {start}–{end} 页")[:80]
        sections.append({"title": name, "summary": f"第 {start}–{end} 页", "start": start, "end": end})
    return {"title": doc.title or doc.filename, "summary": "", "sections": sections, "fallback": True}


def repair_outline(raw: dict, page_count: int, default_title: str) -> dict | None:
    """检查并修正 AI 给的大纲：页码连续、不重叠、覆盖全部页"""
    secs = []
    for s in raw.get("sections") or []:
        try:
            start, end = int(s.get("start")), int(s.get("end"))
        except (TypeError, ValueError):
            continue
        title = str(s.get("title", "")).strip()
        if not title:
            continue
        secs.append({"title": title[:120], "summary": str(s.get("summary", "")).strip()[:300],
                     "start": max(1, start), "end": min(page_count, max(start, end))})
    secs.sort(key=lambda x: x["start"])
    if not secs:
        return None
    fixed = []
    expected = 1
    for s in secs:
        if s["end"] < expected:
            continue  # 完全重叠，丢掉
        s["start"] = expected  # 填补空隙 / 去掉重叠
        if s["end"] < s["start"]:
            s["end"] = s["start"]
        fixed.append(s)
        expected = s["end"] + 1
        if expected > page_count:
            break
    if fixed and fixed[-1]["end"] < page_count:
        fixed[-1]["end"] = page_count
    return {"title": str(raw.get("title") or default_title).strip()[:300],
            "summary": str(raw.get("summary", "")).strip()[:500], "sections": fixed}


def section_for(outline: dict, page_no: int) -> tuple[int, dict | None]:
    for i, s in enumerate(outline.get("sections", [])):
        if s["start"] <= page_no <= s["end"]:
            return i, s
    return -1, None


def session_view(db: Session, s: StudySession, doc: Document) -> dict:
    pages = db.query(DocPage).filter(DocPage.document_id == doc.id).order_by(DocPage.page_no).all()
    outline = _load_json(doc.outline, {})
    progress = _load_json(s.progress, {})
    key = user_style(db, s.user_id, doc)[0] if s.user_id else persona.DEFAULT_STYLE_KEY
    styled = ({r.page_no for r in db.query(PageStyleExplanation).filter(
        PageStyleExplanation.document_id == doc.id, PageStyleExplanation.style_key == key).all()}
        if key != persona.DEFAULT_STYLE_KEY else None)
    return {
        "session_id": s.session_id,
        "document_id": doc.id,
        "source_type": doc.source_type,
        "file_type": doc.file_type,
        "title": outline.get("title") or doc.title or doc.filename,
        "summary": outline.get("summary", ""),
        "page_count": doc.page_count,
        "sections": outline.get("sections", []),
        "outline_ready": bool(outline.get("sections")),
        "outline_fallback": bool(outline.get("fallback")),
        "pages": [{
            "page_no": p.page_no,
            "title": p.title or "",
            "has_image": bool(p.image),
            "image_kind": p.image_kind or "",
            "explained": bool(p.explanation) if styled is None else p.page_no in styled,
        } for p in pages],
        "progress": {"last_page": progress.get("last_page", 1), "visited": progress.get("visited", [])},
        "diagnostic": progress.get("diagnostic"),
        "course": _course_brief(db, s),
        "material_type": course_svc.normalize_type(s.material_type),
        "week": s.week,
        "style_summary": persona.style_summary(persona.load_profile(db.query(User).filter(User.id == s.user_id).first())["answers"]),
        "personal_style": key != persona.DEFAULT_STYLE_KEY,
    }


def _course_brief(db: Session, s: StudySession) -> dict | None:
    if not s.course_id:
        return None
    from models.models import Course
    c = db.query(Course).filter(Course.id == s.course_id).first()
    return {"id": c.id, "name": c.name, "kind": c.kind or "normal"} if c else None


def _get_or_create_session(db: Session, user_id: int, doc: Document, course_id: int | None = None,
                           material_type: str | None = None, week: int | None = None) -> StudySession:
    """同一个人同一份资料只有一条学习记录；再次上传到别的课程时，记录跟着移过去"""
    s = (db.query(StudySession)
         .filter(StudySession.user_id == user_id, StudySession.document_id == doc.id)
         .order_by(StudySession.id.desc()).first())
    if course_id is None:
        course_id = (s.course_id if s and s.course_id else
                     course_svc.special_course(db, user_id, "sample" if doc.source_type == "sample" else "inbox").id)
    if s:
        s.updated_at = datetime.utcnow()
        s.course_id = course_id
        if material_type:
            s.material_type = course_svc.normalize_type(material_type)
        if week is not None:
            s.week = week
        course_svc.touch(db, course_id)
        db.commit()
        return s
    s = StudySession(session_id=str(uuid.uuid4()), topic=(doc.title or doc.filename or "未命名")[:500],
                     source_type=doc.source_type, document_id=doc.id, user_id=user_id,
                     course_id=course_id, material_type=course_svc.normalize_type(material_type), week=week,
                     progress=json.dumps({"last_page": 1, "visited": []}), updated_at=datetime.utcnow())
    course_svc.touch(db, course_id)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


# ---------------------------------------------------------------- 上传课件

@router.post("/upload")
@limiter.limit("30/hour")
async def upload(request: Request, file: UploadFile = File(...), course_id: int | None = Form(None),
                 material_type: str = Form("lecture"), week: int | None = Form(None),
                 user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    if course_id is not None:
        course_svc.get_owned_course(db, course_id, user_id)
    if week is not None and not (0 <= week <= 60):
        week = None
    filename = (file.filename or "unknown").strip()
    lower = filename.lower()
    if not lower.endswith((".pptx", ".pdf", ".docx", ".ppt", ".doc")):
        raise AppError(400, "upload_bad_type", "这个文件格式不支持。请上传 PPTX、PDF 或 DOCX 文件。")
    contents = await file.read()
    if not contents:
        raise AppError(400, "upload_empty", "这个文件是空的，请检查后重新上传。")
    if len(contents) > config.MAX_FILE_SIZE:
        raise AppError(413, "upload_too_large", f"文件超过 {config.MAX_FILE_SIZE // 1024 // 1024}MB。可以压缩图片，或者把课件拆成几份再上传。")

    digest = hashlib.sha256(contents).hexdigest()  # 整个文件的哈希，不会把两份不同课件当成同一份
    doc = db.query(Document).filter(Document.content_hash == digest).first()
    reused = doc is not None
    if not doc:
        try:
            parsed = await run_in_threadpool(parse_document, filename, contents)
        except ValueError as e:
            msg = str(e)
            code = "upload_old_format" if ("97-2003" in msg or "旧版" in msg) else (
                "upload_bad_type" if "不支持的文件格式" in msg else "upload_parse_failed")
            raise AppError(400, code, msg)
        except Exception:
            logger.exception("parse failed for %s", filename[:100])
            raise AppError(400, "upload_parse_failed", "这个文件解析失败了，可能已损坏或有加密。可以用 PowerPoint 另存为 PDF 再试。")
        if not parsed.pages or not any(p.text.strip() or p.image for p in parsed.pages):
            raise AppError(400, "upload_no_text", "没能从文件里读到内容。如果是扫描版 PDF，请换成带文字的版本。")
        title = filename.rsplit(".", 1)[0][:300]
        doc = Document(id=uuid.uuid4().hex, content_hash=digest, source_type="file", file_type=parsed.file_type,
                       filename=filename[:300], title=title, page_count=len(parsed.pages))
        db.add(doc)
        db.flush()  # 先写入 documents，doc_pages 的外键才成立（Postgres 会检查）
        for p in parsed.pages:
            db.add(DocPage(document_id=doc.id, page_no=p.page_no, title=p.title[:300], text=p.text,
                           notes=p.notes, image=p.image, image_kind=p.image_kind, image_count=p.image_count))
        db.commit()
    s = _get_or_create_session(db, user_id, doc, course_id=course_id, material_type=material_type, week=week)
    view = session_view(db, s, doc)
    view["reused"] = reused
    return view


# ---------------------------------------------------------------- 只输入话题

class TopicRequest(BaseModel):
    topic: str
    grade: str = ""
    major: str = ""
    course_id: int | None = None
    week: int | None = None


@router.post("/topic")
@limiter.limit("20/hour")
async def start_topic(request: Request, req: TopicRequest, user_id: int = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    if req.course_id is not None:
        course_svc.get_owned_course(db, req.course_id, user_id)
    topic = req.topic.strip()
    if len(topic) < 2:
        raise HTTPException(status_code=400, detail="请输入想学的话题")
    if len(topic) > 200:
        raise HTTPException(status_code=400, detail="话题太长了，请控制在 200 字以内；长材料请上传文件")
    digest = hashlib.sha256(("topic:" + " ".join(topic.lower().split())).encode()).hexdigest()
    doc = db.query(Document).filter(Document.content_hash == digest).first()
    if not doc:
        try:
            plan = await ai_service.plan_topic(topic, req.grade, req.major, ctx=ai_ctx(request, db, user_id))
        except AIError as e:
            raise ai_http_error(e)
        pages, sections = [], []
        for sec in plan.get("sections") or []:
            sec_pages = [p for p in (sec.get("pages") or []) if isinstance(p, dict) and p.get("title")]
            if not sec_pages:
                continue
            start = len(pages) + 1
            for p in sec_pages:
                pages.append((str(p["title"])[:300], f"{p['title']}\n{p.get('points', '')}".strip()))
            sections.append({"title": str(sec.get("title", ""))[:120] or f"第 {len(sections) + 1} 章",
                             "summary": str(sec.get("summary", ""))[:300], "start": start, "end": len(pages)})
        if not pages:
            raise AppError(502, "ai_bad_output", "AI 没能规划出学习内容，请换个说法再试")
        doc = Document(id=uuid.uuid4().hex, content_hash=digest, source_type="topic", file_type="topic",
                       filename=topic[:300], title=str(plan.get("title") or topic)[:300], page_count=len(pages),
                       outline=json.dumps({"title": plan.get("title") or topic, "summary": plan.get("summary", ""),
                                           "sections": sections}, ensure_ascii=False))
        db.add(doc)
        db.flush()  # 先写入 documents，doc_pages 的外键才成立（Postgres 会检查）
        for i, (title, text) in enumerate(pages, 1):
            db.add(DocPage(document_id=doc.id, page_no=i, title=title, text=text))
        db.commit()
    s = _get_or_create_session(db, user_id, doc, course_id=req.course_id, material_type="notes", week=req.week)
    return session_view(db, s, doc)


# ---------------------------------------------------------------- 大纲

@router.post("/{session_id}/outline")
async def ensure_outline(session_id: str, request: Request, user_id: int = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    s, doc = get_session_doc(db, session_id, user_id)
    outline = _load_json(doc.outline, {})
    if outline.get("sections") and not outline.get("fallback"):
        return session_view(db, s, doc)
    pages = db.query(DocPage).filter(DocPage.document_id == doc.id).order_by(DocPage.page_no).all()
    new_outline = None
    try:
        raw = await ai_service.make_outline(doc.filename or doc.title,
                                            [{"page_no": p.page_no, "text": p.text} for p in pages],
                                            ctx=ai_ctx(request, db, user_id))
        new_outline = repair_outline(raw, doc.page_count, doc.title or doc.filename)
    except AIError:
        new_outline = None  # AI 不可用 / 额度用完：用简单分组，照样能学
    if not new_outline:
        new_outline = outline if outline.get("sections") else fallback_outline(doc, pages)
    doc.outline = json.dumps(new_outline, ensure_ascii=False)
    if new_outline.get("title") and not new_outline.get("fallback"):
        doc.title = new_outline["title"][:300]
        s.topic = doc.title[:500]
    db.commit()
    return session_view(db, s, doc)


# ---------------------------------------------------------------- 示例课程

@router.post("/sample")
async def start_sample(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """打开示例课程：讲解和题目都是提前写好的，不消耗 AI 额度"""
    doc = sample.ensure_sample(db)
    learning.ensure_kps(db, doc)
    c = course_svc.special_course(db, user_id, "sample")
    s = _get_or_create_session(db, user_id, doc, course_id=c.id, week=3)
    return session_view(db, s, doc)


@router.get("/history")
async def history(user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(StudySession).filter(StudySession.user_id == user_id)
            .order_by(StudySession.id.desc()).limit(50).all())
    out = []
    for r in rows:
        progress = _load_json(r.progress, {})
        out.append({"session_id": r.session_id, "topic": r.topic, "legacy": not r.document_id,
                    "created_at": (r.updated_at or r.created_at).isoformat() if (r.updated_at or r.created_at) else None,
                    "last_page": progress.get("last_page")})
    return {"sessions": out}


@router.get("/quota")
async def quota(request: Request, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    from routers.settings import get_api_key
    own = bool(get_api_key(user_id))
    st = ai_service.quota_status(db, user_id, client_ip(request))
    st["own_key"] = own
    st["free_models"] = ai_service.free_providers_summary()
    return st


@router.get("/{session_id}/knowledge")
async def knowledge(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """这份课件的知识点清单，以及你在每个知识点上的掌握情况"""
    _, doc = get_session_doc(db, session_id, user_id)
    kps = learning.ensure_kps(db, doc)
    attempts = learning.user_kp_attempts(db, user_id, [k.id for k in kps])
    out = []
    for k in kps:
        m = learning.mastery_from_attempts(attempts.get(k.id, []))
        out.append({"id": k.id, "name": k.name, "kind": k.kind, "section_index": k.section_index,
                    "page_start": k.page_start, "page_end": k.page_end, **m})
    order = {"weak": 0, "learning": 1, "new": 2, "mastered": 3}
    out.sort(key=lambda x: (order[x["status"]], x["section_index"] if x["section_index"] is not None else 99))
    return {"knowledge_points": out}


@router.get("/{session_id}")
async def get_study(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    s, doc = get_session_doc(db, session_id, user_id)
    return session_view(db, s, doc)


# ---------------------------------------------------------------- 原页面图片

@router.get("/{session_id}/pages/{page_no}/image")
async def page_image(session_id: str, page_no: int, user_id: int = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    _, doc = get_session_doc(db, session_id, user_id)
    page = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page_no).first()
    if not page or not page.image:
        raise HTTPException(status_code=404, detail="这一页没有图片")
    return Response(content=page.image, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=86400"})


@router.get("/{session_id}/pages/{page_no}")
async def page_detail(session_id: str, page_no: int, user_id: int = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """页面原文 + 已缓存的讲解（不触发 AI）+ 追问记录"""
    _, doc = get_session_doc(db, session_id, user_id)
    page = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page_no).first()
    if not page:
        raise AppError(404, "not_found", "这一页不存在。")
    chats = (db.query(PageChat).filter(PageChat.session_id == session_id, PageChat.page_no == page_no,
                                       PageChat.user_id == user_id).order_by(PageChat.id).all())
    return {
        "page_no": page.page_no, "title": page.title, "text": page.text, "notes": page.notes,
        "has_image": bool(page.image), "image_kind": page.image_kind or "",
        "explanation": styled_explanation(db, doc, page, user_style(db, user_id, doc)[0]),
        "chat": [{"role": c.role, "content": c.content} for c in chats],
    }


# ---------------------------------------------------------------- 讲解（按需生成）

def _needs_vision(page: DocPage) -> bool:
    if not page.image:
        return False
    text_len = len((page.text or "").strip())
    if page.image_kind == "picture":
        return text_len < 800      # PPT 里的图通常就是重点（流程图、UML…）
    return text_len < 300          # PDF 整页截图：文字太少时说明内容在图里


def user_style(db: Session, user_id: int, doc: Document) -> tuple[str, str]:
    """3.0：这个学生的讲解方式。返回 (style_key, 给 AI 的要求)；示例课程和默认方式用全站共用的讲解"""
    u = db.query(User).filter(User.id == user_id).first()
    answers = persona.load_profile(u)["answers"]
    key = persona.style_key(answers)
    if key == persona.DEFAULT_STYLE_KEY or sample.is_sample(doc):
        return persona.DEFAULT_STYLE_KEY, ""
    return key, persona.style_rules(answers)


def styled_explanation(db: Session, doc: Document, page: DocPage, key: str) -> dict | None:
    if key == persona.DEFAULT_STYLE_KEY:
        return _load_json(page.explanation, None)
    row = (db.query(PageStyleExplanation).filter(PageStyleExplanation.document_id == doc.id,
                                                 PageStyleExplanation.page_no == page.page_no,
                                                 PageStyleExplanation.style_key == key).first())
    return _load_json(row.explanation, None) if row else None


async def _make_explanation(request: Request, db: Session, user_id: int, doc: Document, page: DocPage,
                            rules: str = "") -> tuple[dict, str]:
    text = (page.text or "").strip()
    if len(text) < 15 and not page.image:
        return ({"summary": "这一页几乎没有内容", "explanation": "这一页没有可讲解的文字，可能是封面、过渡页或空白页，直接看下一页吧。",
                 "key_terms": [], "example": "", "exam_tip": "", "page_type": "cover"}, "none")
    outline = _load_json(doc.outline, {})
    _, sec = section_for(outline, page.page_no)
    prev_p = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page.page_no - 1).first()
    next_p = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page.page_no + 1).first()
    image_b64 = base64.b64encode(page.image).decode() if _needs_vision(page) else None
    try:
        return await ai_service.explain_page(
            outline.get("title") or doc.title, sec["title"] if sec else "", page.page_no, doc.page_count,
            text, page.notes or "", prev_p.text if prev_p else "", next_p.title if next_p else "",
            image_b64=image_b64, ctx=ai_ctx(request, db, user_id), style_rules=rules)
    except AIError as e:
        raise ai_http_error(e)


@router.post("/{session_id}/pages/{page_no}/explain")
async def explain(session_id: str, page_no: int, request: Request, user_id: int = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    _, doc = get_session_doc(db, session_id, user_id)
    page = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page_no).first()
    if not page:
        raise AppError(404, "not_found", "这一页不存在。")
    key, rules = user_style(db, user_id, doc)
    cached = styled_explanation(db, doc, page, key)
    if cached:
        return {"page_no": page_no, "explanation": cached, "cached": True, "style": key}

    async with _lock_for(f"{doc.id}:{key}", page_no):
        db.refresh(page)
        cached = styled_explanation(db, doc, page, key)
        if cached:  # 等锁的时候别人已经生成好了
            return {"page_no": page_no, "explanation": cached, "cached": True, "style": key}
        result, provider = await _make_explanation(request, db, user_id, doc, page, rules)
        if key == persona.DEFAULT_STYLE_KEY:
            page.explanation = json.dumps(result, ensure_ascii=False)
            page.explanation_provider = provider[:50]
            page.explained_at = datetime.utcnow()
        else:
            db.add(PageStyleExplanation(document_id=doc.id, page_no=page_no, style_key=key,
                                        explanation=json.dumps(result, ensure_ascii=False), provider=provider[:50]))
        db.commit()
        return {"page_no": page_no, "explanation": result, "cached": False, "style": key}


# ---------------------------------------------------------------- 追问

class AskRequest(BaseModel):
    question: str


@router.post("/{session_id}/pages/{page_no}/ask")
@limiter.limit("60/hour")
async def ask(request: Request, session_id: str, page_no: int, req: AskRequest,
              user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    q = req.question.strip()
    if not q:
        raise HTTPException(status_code=400, detail="问题不能为空")
    if len(q) > 1000:
        raise HTTPException(status_code=400, detail="问题太长了，请控制在 1000 字以内")
    s, doc = get_session_doc(db, session_id, user_id)
    page = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page_no).first()
    if not page:
        raise AppError(404, "not_found", "这一页不存在。")
    history_rows = (db.query(PageChat).filter(PageChat.session_id == session_id, PageChat.page_no == page_no,
                                              PageChat.user_id == user_id).order_by(PageChat.id).all())
    expl = _load_json(page.explanation, {}) or {}
    outline = _load_json(doc.outline, {})
    try:
        answer = await ai_service.answer_page_question(
            outline.get("title") or doc.title, page_no, page.text or "",
            (expl.get("summary", "") + " " + expl.get("explanation", "")[:400]).strip(),
            [{"role": h.role, "content": h.content} for h in history_rows], q, ctx=ai_ctx(request, db, user_id))
    except AIError as e:
        raise ai_http_error(e)
    db.add(PageChat(session_id=session_id, user_id=user_id, page_no=page_no, role="user", content=q))
    db.add(PageChat(session_id=session_id, user_id=user_id, page_no=page_no, role="assistant", content=answer))
    db.commit()
    return {"answer": answer}


@router.delete("/{session_id}/pages/{page_no}/chat")
async def clear_chat(session_id: str, page_no: int, user_id: int = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    get_owned_session(db, session_id, user_id)
    db.query(PageChat).filter(PageChat.session_id == session_id, PageChat.page_no == page_no,
                              PageChat.user_id == user_id).delete()
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------------- 学习进度 & 导出

class ProgressRequest(BaseModel):
    page_no: int


@router.post("/{session_id}/progress")
async def save_progress(session_id: str, req: ProgressRequest, user_id: int = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    s = get_owned_session(db, session_id, user_id)
    p = _load_json(s.progress, {})
    if not isinstance(p, dict):
        p = {}
    visited = set(p.get("visited", []))
    visited.add(int(req.page_no))
    p.update({"last_page": int(req.page_no), "visited": sorted(visited)[:2000]})
    if s.document_id:
        doc = db.query(Document).filter(Document.id == s.document_id).first()
        if doc and int(req.page_no) >= (doc.page_count or 0):
            p["finished"] = True   # 翻到过最后一页
    s.progress = json.dumps(p)
    s.updated_at = datetime.utcnow()
    course_svc.touch(db, s.course_id)
    db.commit()
    persona.touch_activity(db, user_id)
    return {"status": "ok"}


class MetaRequest(BaseModel):
    course_id: int | None = None
    material_type: str | None = None
    week: int | None = None
    clear_week: bool = False


@router.patch("/{session_id}/meta")
async def update_meta(session_id: str, req: MetaRequest, user_id: int = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """修改资料的类型、第几周，或者移到另一门课"""
    s = get_owned_session(db, session_id, user_id)
    if req.course_id is not None:
        course_svc.get_owned_course(db, req.course_id, user_id)
        s.course_id = req.course_id
    if req.material_type is not None:
        if req.material_type not in course_svc.MATERIAL_TYPES:
            raise AppError(400, "bad_request", "资料类型不对")
        s.material_type = req.material_type
    if req.clear_week:
        s.week = None
    elif req.week is not None:
        if not (0 <= req.week <= 60):
            raise AppError(400, "bad_request", "周数应该在 0–60 之间")
        s.week = req.week
    db.commit()
    return {"status": "ok"}


@router.get("/{session_id}/export")
async def export(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """已生成的讲解全部导出（不会触发新的 AI 调用）"""
    s, doc = get_session_doc(db, session_id, user_id)
    key = user_style(db, user_id, doc)[0]
    pages = db.query(DocPage).filter(DocPage.document_id == doc.id).order_by(DocPage.page_no).all()
    outline = _load_json(doc.outline, {})
    return {
        "title": outline.get("title") or doc.title,
        "sections": outline.get("sections", []),
        "pages": [{"page_no": p.page_no, "title": p.title, "text": p.text,
                   "explanation": styled_explanation(db, doc, p, key) or _load_json(p.explanation, None)} for p in pages],
    }


def user_profile(db: Session, user_id: int) -> tuple[str, str]:
    u = db.query(User).filter(User.id == user_id).first()
    return (u.grade or "", u.major or "") if u else ("", "")
