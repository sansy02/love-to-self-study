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

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import config
from database import get_db
from middleware.rate_limit import limiter, client_ip
from models.models import Document, DocPage, PageChat, StudySession, User
from routers.auth import get_current_user
from services import ai_service
from services.ai_service import AIContext, AIError
from services.parser_service import parse_document

router = APIRouter(prefix="/api/study", tags=["study"])

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


def ai_http_error(e: AIError) -> HTTPException:
    return HTTPException(status_code=e.status_code, detail=str(e))


# ---------------------------------------------------------------- 工具

def get_owned_session(db: Session, session_id: str, user_id: int) -> StudySession:
    s = db.query(StudySession).filter(StudySession.session_id == session_id).first()
    if not s or s.user_id != user_id:
        raise HTTPException(status_code=404, detail="学习记录不存在")
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
            "explained": bool(p.explanation),
        } for p in pages],
        "progress": {"last_page": progress.get("last_page", 1), "visited": progress.get("visited", [])},
    }


def _get_or_create_session(db: Session, user_id: int, doc: Document) -> StudySession:
    s = (db.query(StudySession)
         .filter(StudySession.user_id == user_id, StudySession.document_id == doc.id)
         .order_by(StudySession.id.desc()).first())
    if s:
        s.updated_at = datetime.utcnow()
        db.commit()
        return s
    s = StudySession(session_id=str(uuid.uuid4()), topic=(doc.title or doc.filename or "未命名")[:500],
                     source_type=doc.source_type, document_id=doc.id, user_id=user_id,
                     progress=json.dumps({"last_page": 1, "visited": []}), updated_at=datetime.utcnow())
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


# ---------------------------------------------------------------- 上传课件

@router.post("/upload")
@limiter.limit("30/hour")
async def upload(request: Request, file: UploadFile = File(...), user_id: int = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    filename = (file.filename or "unknown").strip()
    lower = filename.lower()
    if not lower.endswith((".pptx", ".pdf", ".docx", ".ppt", ".doc")):
        raise HTTPException(status_code=400, detail="仅支持 PPTX、PDF、DOCX 文件。")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(contents) > config.MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"文件超过 {config.MAX_FILE_SIZE // 1024 // 1024}MB 限制")

    digest = hashlib.sha256(contents).hexdigest()  # 整个文件的哈希，不会把两份不同课件当成同一份
    doc = db.query(Document).filter(Document.content_hash == digest).first()
    reused = doc is not None
    if not doc:
        try:
            parsed = await run_in_threadpool(parse_document, filename, contents)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"文件解析失败: {str(e)[:200]}")
        if not parsed.pages or not any(p.text.strip() or p.image for p in parsed.pages):
            raise HTTPException(status_code=400, detail="没能从文件里读到内容。如果是扫描版 PDF，请换成带文字的版本。")
        title = filename.rsplit(".", 1)[0][:300]
        doc = Document(id=uuid.uuid4().hex, content_hash=digest, source_type="file", file_type=parsed.file_type,
                       filename=filename[:300], title=title, page_count=len(parsed.pages))
        db.add(doc)
        for p in parsed.pages:
            db.add(DocPage(document_id=doc.id, page_no=p.page_no, title=p.title[:300], text=p.text,
                           notes=p.notes, image=p.image, image_kind=p.image_kind, image_count=p.image_count))
        db.commit()
    s = _get_or_create_session(db, user_id, doc)
    view = session_view(db, s, doc)
    view["reused"] = reused
    return view


# ---------------------------------------------------------------- 只输入话题

class TopicRequest(BaseModel):
    topic: str
    grade: str = ""
    major: str = ""


@router.post("/topic")
@limiter.limit("20/hour")
async def start_topic(request: Request, req: TopicRequest, user_id: int = Depends(get_current_user),
                      db: Session = Depends(get_db)):
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
            raise HTTPException(status_code=502, detail="AI 没能规划出学习内容，请换个说法再试")
        doc = Document(id=uuid.uuid4().hex, content_hash=digest, source_type="topic", file_type="topic",
                       filename=topic[:300], title=str(plan.get("title") or topic)[:300], page_count=len(pages),
                       outline=json.dumps({"title": plan.get("title") or topic, "summary": plan.get("summary", ""),
                                           "sections": sections}, ensure_ascii=False))
        db.add(doc)
        for i, (title, text) in enumerate(pages, 1):
            db.add(DocPage(document_id=doc.id, page_no=i, title=title, text=text))
        db.commit()
    s = _get_or_create_session(db, user_id, doc)
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
        raise HTTPException(status_code=404, detail="页面不存在")
    chats = (db.query(PageChat).filter(PageChat.session_id == session_id, PageChat.page_no == page_no,
                                       PageChat.user_id == user_id).order_by(PageChat.id).all())
    return {
        "page_no": page.page_no, "title": page.title, "text": page.text, "notes": page.notes,
        "has_image": bool(page.image), "image_kind": page.image_kind or "",
        "explanation": _load_json(page.explanation, None),
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


@router.post("/{session_id}/pages/{page_no}/explain")
async def explain(session_id: str, page_no: int, request: Request, user_id: int = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    _, doc = get_session_doc(db, session_id, user_id)
    page = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page_no).first()
    if not page:
        raise HTTPException(status_code=404, detail="页面不存在")
    if page.explanation:
        return {"page_no": page_no, "explanation": _load_json(page.explanation, None), "cached": True}

    async with _lock_for(doc.id, page_no):
        db.refresh(page)
        if page.explanation:  # 等锁的时候别人已经生成好了
            return {"page_no": page_no, "explanation": _load_json(page.explanation, None), "cached": True}

        text = (page.text or "").strip()
        if len(text) < 15 and not page.image:
            result = {"summary": "这一页几乎没有内容", "explanation": "这一页没有可讲解的文字，可能是封面、过渡页或空白页，直接看下一页吧。",
                      "key_terms": [], "example": "", "exam_tip": "", "page_type": "cover"}
            provider = "none"
        else:
            outline = _load_json(doc.outline, {})
            _, sec = section_for(outline, page_no)
            prev_p = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page_no - 1).first()
            next_p = db.query(DocPage).filter(DocPage.document_id == doc.id, DocPage.page_no == page_no + 1).first()
            image_b64 = base64.b64encode(page.image).decode() if _needs_vision(page) else None
            try:
                result, provider = await ai_service.explain_page(
                    outline.get("title") or doc.title, sec["title"] if sec else "", page_no, doc.page_count,
                    text, page.notes or "", prev_p.text if prev_p else "", next_p.title if next_p else "",
                    image_b64=image_b64, ctx=ai_ctx(request, db, user_id))
            except AIError as e:
                raise ai_http_error(e)
            if not result.get("explanation"):
                raise HTTPException(status_code=502, detail="AI 返回的讲解是空的，请重试")
        page.explanation = json.dumps(result, ensure_ascii=False)
        page.explanation_provider = provider[:50]
        page.explained_at = datetime.utcnow()
        db.commit()
        return {"page_no": page_no, "explanation": result, "cached": False}


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
        raise HTTPException(status_code=404, detail="页面不存在")
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
    visited = set(p.get("visited", []))
    visited.add(int(req.page_no))
    s.progress = json.dumps({"last_page": int(req.page_no), "visited": sorted(visited)[:2000]})
    s.updated_at = datetime.utcnow()
    db.commit()
    return {"status": "ok"}


@router.get("/{session_id}/export")
async def export(session_id: str, user_id: int = Depends(get_current_user), db: Session = Depends(get_db)):
    """已生成的讲解全部导出（不会触发新的 AI 调用）"""
    s, doc = get_session_doc(db, session_id, user_id)
    pages = db.query(DocPage).filter(DocPage.document_id == doc.id).order_by(DocPage.page_no).all()
    outline = _load_json(doc.outline, {})
    return {
        "title": outline.get("title") or doc.title,
        "sections": outline.get("sections", []),
        "pages": [{"page_no": p.page_no, "title": p.title, "text": p.text,
                   "explanation": _load_json(p.explanation, None)} for p in pages],
    }


def user_profile(db: Session, user_id: int) -> tuple[str, str]:
    u = db.query(User).filter(User.id == user_id).first()
    return (u.grade or "", u.major or "") if u else ("", "")
