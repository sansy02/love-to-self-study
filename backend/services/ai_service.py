"""
AI 服务 — 多模型自动切换 + 免费额度

调用顺序（模型链）：
1. 用户自己填的 Key（DeepSeek 或 Gemini）—— 不限次数
2. 站长配置的免费模型：Gemini（主力，能看图）→ 智谱 GLM（备用）
3. 旧版的 AI_API_KEY（如果还配置着）

任何一个模型报错 / 超时 / 额度用完 / 返回格式不对，自动换下一个。
所有模型都走 OpenAI 兼容的 /chat/completions 接口。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import httpx

import config

logger = logging.getLogger("aixue.ai")


# =====================================================================
# 模型配置
# =====================================================================

@dataclass
class Provider:
    name: str                 # 展示名，如 "Gemini 3.8 Flash"
    key: str                  # 唯一标识，如 "gemini"
    base_url: str             # 不含 /chat/completions
    api_key: str
    model: str
    vision: bool = False      # 能否看图
    free_pool: bool = True    # 是否消耗站长免费额度
    extra: dict = field(default_factory=dict)
    max_concurrency: int = 0  # 0 = 不限制


GEMINI_BASE = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai").rstrip("/")
GLM_BASE = os.getenv("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4").rstrip("/")
DEEPSEEK_BASE = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _gemini_provider(api_key: str, free_pool: bool, label_suffix: str = "") -> Provider:
    model = _env("GEMINI_MODEL", "gemini-3.8-flash")
    extra = {}
    effort = _env("GEMINI_REASONING_EFFORT", "low")
    if effort:
        extra["reasoning_effort"] = effort  # 3.x 系列无法关闭思考，设成 low 让它快一点
    return Provider(name=f"Gemini ({model}){label_suffix}", key="gemini" if free_pool else "user-gemini",
                    base_url=GEMINI_BASE, api_key=api_key, model=model, vision=True,
                    free_pool=free_pool, extra=extra)


def free_providers() -> list[Provider]:
    """站长提供的免费模型（顺序即优先级）"""
    chain: list[Provider] = []
    gemini_key = _env("GEMINI_API_KEY")
    if gemini_key:
        chain.append(_gemini_provider(gemini_key, free_pool=True))
    glm_key = _env("GLM_API_KEY") or _env("ZHIPU_API_KEY")
    if glm_key:
        model = _env("GLM_MODEL", "glm-4.7-flash")
        chain.append(Provider(name=f"智谱 ({model})", key="glm", base_url=GLM_BASE, api_key=glm_key,
                              model=model, vision=False, free_pool=True,
                              max_concurrency=int(_env("GLM_CONCURRENCY", "1") or 1)))
        vmodel = _env("GLM_VISION_MODEL", "")
        if vmodel:
            chain.append(Provider(name=f"智谱 ({vmodel})", key="glm-vision", base_url=GLM_BASE, api_key=glm_key,
                                  model=vmodel, vision=True, free_pool=True,
                                  max_concurrency=int(_env("GLM_CONCURRENCY", "1") or 1)))
    legacy = _env("AI_API_KEY")
    if legacy and legacy != "your-api-key-here":
        base = _env("AI_BASE_URL", DEEPSEEK_BASE).rstrip("/")
        chain.append(Provider(name="站长 Key", key="admin", base_url=base, api_key=legacy,
                              model=_env("AI_MODEL", "deepseek-chat"), vision=False, free_pool=True))
    return chain


def free_providers_summary() -> list[str]:
    return [p.name for p in free_providers()]


def detect_user_key_provider(key: str) -> str:
    return "Gemini" if key.startswith("AIza") else "DeepSeek"


def user_provider(api_key: str) -> Provider:
    if api_key.startswith("AIza"):
        return _gemini_provider(api_key, free_pool=False, label_suffix=" · 你的 Key")
    return Provider(name="DeepSeek · 你的 Key", key="user-deepseek", base_url=DEEPSEEK_BASE,
                    api_key=api_key, model=_env("USER_DEEPSEEK_MODEL", "deepseek-chat"),
                    vision=False, free_pool=False)


# =====================================================================
# 额度
# =====================================================================

class AIError(Exception):
    """给用户看的错误（中文）"""
    status_code = 502


class QuotaExceeded(AIError):
    status_code = 429


class AIUnavailable(AIError):
    status_code = 503


@dataclass
class AIContext:
    user_id: int | None = None
    ip: str = ""
    db: object | None = None          # SQLAlchemy Session；为 None 时不统计额度（测试/脚本）
    user_key: str | None = None       # 不传则自动从数据库读取


def _cst_day_start_utc() -> datetime:
    """北京时间 0 点，换算成数据库里用的 UTC（naive）"""
    cst = timezone(timedelta(hours=8))
    start = datetime.now(cst).replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(timezone.utc).replace(tzinfo=None)


def usage_today(db, user_id: int | None, ip: str = "") -> tuple[int, int]:
    from models.models import AIUsage
    start = _cst_day_start_utc()
    by_user = 0
    if user_id:
        by_user = db.query(AIUsage).filter(AIUsage.user_id == user_id, AIUsage.free_pool == True,  # noqa: E712
                                           AIUsage.created_at >= start).count()
    by_ip = 0
    if ip:
        by_ip = db.query(AIUsage).filter(AIUsage.ip == ip, AIUsage.free_pool == True,  # noqa: E712
                                         AIUsage.created_at >= start).count()
    return by_user, by_ip


def quota_status(db, user_id: int | None, ip: str = "") -> dict:
    used, _ = usage_today(db, user_id, ip)
    return {"used": used, "limit": config.FREE_DAILY_LIMIT, "remaining": max(config.FREE_DAILY_LIMIT - used, 0)}


def _check_free_quota(ctx: AIContext):
    if ctx.db is None:
        return
    by_user, by_ip = usage_today(ctx.db, ctx.user_id, ctx.ip)
    if by_user >= config.FREE_DAILY_LIMIT or (ctx.ip and by_ip >= config.FREE_DAILY_LIMIT_PER_IP):
        raise QuotaExceeded(
            f"今天的免费 AI 次数（{config.FREE_DAILY_LIMIT} 次）已用完，北京时间 0:00 重置。"
            "已经生成过的讲解可以继续免费看；也可以填入自己的 DeepSeek 或 Gemini Key 无限使用。"
        )


def _record_usage(ctx: AIContext, kind: str, provider: Provider):
    if ctx.db is None:
        return
    from models.models import AIUsage
    try:
        ctx.db.add(AIUsage(user_id=ctx.user_id, ip=ctx.ip or "", kind=kind,
                           provider=provider.key, free_pool=provider.free_pool))
        ctx.db.commit()
    except Exception:  # 统计失败不影响主流程
        ctx.db.rollback()


def _resolve_user_key(ctx: AIContext) -> str:
    if ctx.user_key is not None:
        return ctx.user_key
    if not ctx.user_id:
        return ""
    from routers.settings import get_api_key
    return get_api_key(ctx.user_id)


# =====================================================================
# 底层调用
# =====================================================================

_semaphores: dict[str, asyncio.Semaphore] = {}


def _sem(p: Provider) -> asyncio.Semaphore | None:
    if p.max_concurrency <= 0:
        return None
    if p.key not in _semaphores:
        _semaphores[p.key] = asyncio.Semaphore(p.max_concurrency)
    return _semaphores[p.key]


async def _post_chat(p: Provider, messages: list[dict], max_tokens: int, temperature: float, timeout: float) -> str:
    """发一次请求，返回模型输出的文本。测试时会被替换掉。"""
    body = {"model": p.model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    body.update(p.extra)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{p.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {p.api_key}", "Content-Type": "application/json"},
            json=body,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"{p.name} HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json()
    choice = (data.get("choices") or [{}])[0]
    content = (choice.get("message") or {}).get("content") or ""
    if isinstance(content, list):  # 少数兼容层会返回分段内容
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    if not content.strip():
        raise RuntimeError(f"{p.name} 返回了空内容（finish_reason={choice.get('finish_reason')}）")
    return content


def parse_json_loose(text: str):
    """尽量从模型输出里抠出 JSON：去掉 ```json 包裹、前后多余文字"""
    s = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
    if fence:
        s = fence.group(1).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    starts = [i for i in (s.find("{"), s.find("[")) if i >= 0]
    if not starts:
        raise ValueError("模型没有返回 JSON")
    start = min(starts)
    end = max(s.rfind("}"), s.rfind("]"))
    if end <= start:
        raise ValueError("模型返回的 JSON 不完整")
    return json.loads(s[start:end + 1])


def _strip_images(messages: list[dict]) -> list[dict]:
    """给不能看图的模型：把图片部分去掉，只留文字"""
    out = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            texts = [part.get("text", "") for part in c if part.get("type") == "text"]
            out.append({**m, "content": "\n".join(texts) + "\n（注意：这一页有图片，但当前模型看不到图片，请根据文字讲解并提醒学生对照原图。）"})
        else:
            out.append(m)
    return out


async def call_ai(messages: list[dict], ctx: AIContext | None = None, kind: str = "general",
                  want_json: bool = True, max_tokens: int = 4096, temperature: float = 0.5,
                  timeout: float = 120.0, prefer_vision: bool = False):
    """
    按模型链依次尝试，返回 (结果, Provider)。
    want_json=True 时结果是解析后的 dict/list，否则是字符串。
    """
    ctx = ctx or AIContext()
    user_key = _resolve_user_key(ctx)
    user_p = user_provider(user_key) if user_key else None

    free = free_providers()
    quota_error: QuotaExceeded | None = None
    free_allowed: list[Provider] = []
    if free:
        try:
            _check_free_quota(ctx)
            free_allowed = free
        except QuotaExceeded as e:
            quota_error = e

    if prefer_vision and not (user_p and user_p.vision):
        # 这一页需要看图，而用户自己的 Key 看不了图：先用能看图的免费模型
        chain = [p for p in free_allowed if p.vision] + ([user_p] if user_p else []) + \
                [p for p in free_allowed if not p.vision]
    else:
        chain = ([user_p] if user_p else []) + free_allowed

    if not chain:
        if quota_error:
            raise quota_error
        raise AIUnavailable("站点还没有配置免费 AI 模型。请在页面上填入你自己的 DeepSeek 或 Gemini Key。")

    errors = []
    for p in chain:
        msgs = messages if p.vision else _strip_images(messages)
        sem = _sem(p)
        try:
            if sem is not None:
                try:
                    await asyncio.wait_for(sem.acquire(), timeout=25)
                except asyncio.TimeoutError:
                    errors.append(f"{p.name}: 排队超时")
                    continue
            try:
                text = await _post_chat(p, msgs, max_tokens, temperature, timeout)
            finally:
                if sem is not None:
                    sem.release()
            result = parse_json_loose(text) if want_json else text.strip()
        except Exception as e:  # 换下一个模型
            logger.warning("AI provider %s failed: %s", p.name, e)
            errors.append(f"{p.name}: {str(e)[:120]}")
            continue
        _record_usage(ctx, kind, p)
        return result, p

    if quota_error and user_p is None:
        raise quota_error
    raise AIUnavailable("AI 暂时不可用，请稍后重试。" + (f"（{errors[-1]}）" if errors else ""))


# =====================================================================
# 提示词 —— 新版：逐页讲解
# =====================================================================

STYLE_RULES = """语言规则（非常重要）：
- 学生是在英文授课大学读书的中国留学生，英语一般，专业概念不熟。
- 用简体中文讲解；所有专业术语第一次出现时写成「中文 (English)」，例如「封装 (Encapsulation)」。
- 句子短、口语化，多用生活中的比喻；不要堆砌术语，不要空话套话。
- 忠于课件内容，课件里没有的内容要明确说「补充：」，不要编造课件没说的结论。"""


def _page_block(page_no: int, text: str, limit: int) -> str:
    t = (text or "").strip()
    if len(t) > limit:
        t = t[:limit] + "…"
    return f"[第{page_no}页]\n{t if t else '（这一页几乎没有文字，可能是图片/图表/封面）'}"


async def make_outline(title: str, pages: list[dict], ctx: AIContext | None = None) -> dict:
    """
    根据每页文字生成大纲：把连续的页面分成 3–8 个章节。
    pages: [{"page_no": 1, "text": "..."}]
    返回 {"title", "summary", "sections": [{"title", "summary", "start", "end"}]}
    """
    per_page = 350 if len(pages) <= 40 else 180
    body = "\n\n".join(_page_block(p["page_no"], p.get("text", ""), per_page) for p in pages)
    if len(body) > 30000:
        body = body[:30000] + "\n…（后面的页面省略）"
    prompt = f"""下面是一份大学课件，共 {len(pages)} 页，文件名：{title}

{body}

任务：把这份课件按页码顺序切分成 3–8 个章节，生成学习大纲。
要求：
- 每个章节是一段连续的页码，章节之间不重叠、不遗漏，第一个章节从第 1 页开始，最后一个章节到第 {len(pages)} 页结束。
- 章节标题写成「中文标题 (English Title)」，summary 用一句中文说清这一章学什么。
- title：整份课件的主题，格式同上；summary：一句话概括整讲。

{STYLE_RULES}

只返回 JSON，格式：
{{"title": "面向对象基础 (OOP Basics)", "summary": "...", "sections": [{{"title": "...", "summary": "...", "start": 1, "end": 5}}]}}"""
    result, _ = await call_ai([{"role": "system", "content": "你是大学课程助教，擅长整理课件结构。只输出 JSON。"},
                               {"role": "user", "content": prompt}],
                              ctx, kind="outline", max_tokens=3000, temperature=0.3)
    return result if isinstance(result, dict) else {}


async def plan_topic(topic: str, grade: str = "", major: str = "", ctx: AIContext | None = None) -> dict:
    """没有课件、只输入话题时：先规划出若干「虚拟页面」，后面和课件走同一套逐页讲解流程"""
    prompt = f"""学生想自学这个话题：{topic}
学生背景：年级 {grade or '未知'}，专业 {major or '未知'}。

请把这个话题拆成 3–6 个章节，每个章节 2–3 个知识点（每个知识点相当于课件的一页）。
每个知识点写：title（「中文 (English)」格式）和 points（3–6 行要点，用英文写，模仿英文课件的写法，方便学生熟悉英文表达）。

只返回 JSON：
{{"title": "...", "summary": "一句中文概括", "sections": [{{"title": "...", "summary": "...", "pages": [{{"title": "...", "points": "- ...\\n- ..."}}]}}]}}"""
    result, _ = await call_ai([{"role": "system", "content": "你是大学课程设计专家。只输出 JSON。"},
                               {"role": "user", "content": prompt}],
                              ctx, kind="topic", max_tokens=3000, temperature=0.5)
    return result if isinstance(result, dict) else {}


async def explain_page(doc_title: str, section_title: str, page_no: int, page_count: int,
                       text: str, notes: str = "", prev_text: str = "", next_text: str = "",
                       image_b64: str | None = None, ctx: AIContext | None = None) -> tuple[dict, str]:
    """讲解一页。返回 (讲解 JSON, 用到的模型名)"""
    context = ""
    if prev_text:
        context += f"\n上一页（只作衔接参考）：{prev_text[:300]}"
    if next_text:
        context += f"\n下一页（只作衔接参考）：{next_text[:200]}"
    notes_part = f"\n老师的演讲者备注：{notes[:1500]}" if notes else ""
    prompt = f"""课件：{doc_title}
当前章节：{section_title}
当前是第 {page_no} / {page_count} 页。

这一页的文字：
{text[:4000] if text.strip() else '（这一页几乎没有文字，内容主要在图片里）'}
{notes_part}{context}

任务：像一位耐心的学长，给学生讲懂「这一页」。
- summary：一句话说清这页在讲什么。
- explanation：讲解正文，200–500 字。可以用「- 」开头的列表；需要强调的词用 **加粗**。如果这页有图（流程图、UML、表格），按图的结构一步步讲。
- key_terms：这一页出现的 0–6 个关键英文术语，每个给中文和一句中文解释。
- example：一个帮助理解的生活化例子；这页不需要就给空字符串。
- exam_tip：考试可能怎么考这一页，并给一句可以直接写进英文答卷的英文句子；封面/目录页给空字符串。
- page_type：content（正常内容）/ cover（封面、目录、致谢等）。封面类页面 explanation 写一两句即可。

{STYLE_RULES}

只返回 JSON：
{{"summary": "...", "explanation": "...", "key_terms": [{{"en": "Encapsulation", "zh": "封装", "note": "..."}}], "example": "...", "exam_tip": "...", "page_type": "content"}}"""
    if image_b64:
        user_content: object = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]
    else:
        user_content = prompt
    result, provider = await call_ai(
        [{"role": "system", "content": "你是大学课程助教，专门帮英语不好的中国留学生看懂英文课件。只输出 JSON。"},
         {"role": "user", "content": user_content}],
        ctx, kind="explain", max_tokens=3000, temperature=0.4, prefer_vision=bool(image_b64))
    return normalize_explanation(result), provider.name


def normalize_explanation(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    terms = []
    for t in raw.get("key_terms") or []:
        if isinstance(t, dict) and str(t.get("en", "")).strip():
            terms.append({"en": str(t.get("en", "")).strip()[:120], "zh": str(t.get("zh", "")).strip()[:120],
                          "note": str(t.get("note", "")).strip()[:300]})
    return {
        "summary": str(raw.get("summary", "")).strip(),
        "explanation": str(raw.get("explanation", "")).strip(),
        "key_terms": terms[:8],
        "example": str(raw.get("example", "") or "").strip(),
        "exam_tip": str(raw.get("exam_tip", "") or "").strip(),
        "page_type": "cover" if raw.get("page_type") == "cover" else "content",
    }


async def answer_page_question(doc_title: str, page_no: int, text: str, explanation_summary: str,
                               history: list[dict], question: str, ctx: AIContext | None = None) -> str:
    """针对某一页追问"""
    msgs = [{"role": "system", "content": f"""你是大学课程助教，正在和一位中国留学生一起看课件《{doc_title}》第 {page_no} 页。
这一页的原文：
{text[:3500] if text.strip() else '（这页主要是图片）'}

这一页的讲解要点：{explanation_summary[:500]}

回答规则：
- 只围绕这一页和学生的问题回答，150–400 字，口语化，先给结论再解释。
- 用简体中文，术语写成「中文 (English)」。学生要求翻译或用英文时照做。
- 课件里没有的内容要说明是补充；不确定就直接说不确定，不要编。"""}]
    for h in history[-6:]:
        if h.get("role") in ("user", "assistant") and h.get("content"):
            msgs.append({"role": h["role"], "content": str(h["content"])[:1500]})
    msgs.append({"role": "user", "content": question[:1000]})
    result, _ = await call_ai(msgs, ctx, kind="ask", want_json=False, max_tokens=1500, temperature=0.5)
    return result


# =====================================================================
# 提示词 —— 英文练习题 & 批改
# =====================================================================

async def generate_english_exercises(doc_title: str, pages: list[dict], grade: str = "", major: str = "",
                                     ctx: AIContext | None = None) -> list[dict]:
    """
    根据页面内容出英文题（和真实英文考试一致）。
    pages: [{"page_no", "text", "summary"}]
    """
    blocks = []
    budget = 14000
    for p in pages:
        piece = _page_block(p["page_no"], p.get("text", ""), 700)
        if p.get("summary"):
            piece += f"\n（讲解要点：{p['summary'][:200]}）"
        if budget - len(piece) < 0:
            break
        budget -= len(piece)
        blocks.append(piece)
    prompt = f"""Course material: {doc_title}
Student: year {grade or 'unknown'}, major {major or 'unknown'}. The student is a Chinese international student whose English is intermediate.

Slides:
{chr(10).join(blocks)}

Write an exam-style practice set IN ENGLISH, like a real university exam for this course:
- 4 multiple-choice questions ("choice"): 4 options "A. ...", "B. ...", "C. ...", "D. ...", answer is a single letter.
- 3 fill-in-the-blank questions ("blank"): use ___ for the blank, answer is a short term (1–4 words) taken from the slides.
- 3 short-answer questions ("short_answer"): typical exam wording such as "Explain...", "Compare...", "Give an example of..." with marks, e.g. "(4 marks)". answer is a model answer in English (60–120 words); key_points lists 2–4 scoring points in English.
- Every question must be answerable from the slides; set "page" to the slide number it comes from.
- "explanation" is written in simplified Chinese (简体中文), explaining why, with key terms in English.

Return JSON only:
{{"exercises": [{{"type": "choice", "question": "...", "options": ["A. ...", "B. ...", "C. ...", "D. ..."], "answer": "B", "explanation": "中文解析", "page": 3}},
{{"type": "blank", "question": "... ___ ...", "answer": "...", "explanation": "中文解析", "page": 4}},
{{"type": "short_answer", "question": "... (4 marks)", "answer": "model answer", "key_points": ["...", "..."], "explanation": "中文评分要点", "page": 5}}]}}"""
    result, _ = await call_ai([{"role": "system", "content": "You are a rigorous university examiner. Output JSON only."},
                               {"role": "user", "content": prompt}],
                              ctx, kind="exercises", max_tokens=6000, temperature=0.5, timeout=150)
    items = result.get("exercises", []) if isinstance(result, dict) else (result if isinstance(result, list) else [])
    clean = []
    for ex in items:
        if not isinstance(ex, dict) or not str(ex.get("question", "")).strip():
            continue
        t = ex.get("type", "choice")
        if t not in ("choice", "blank", "short_answer"):
            continue
        if t == "choice":
            opts = [str(o) for o in (ex.get("options") or [])][:6]
            ans = str(ex.get("answer", "")).strip().upper()[:1]
            if len(opts) < 2 or not ans:
                continue
            ex["options"], ex["answer"] = opts, ans
        clean.append(ex)
    return clean


async def grade_english_answer(question: str, model_answer: str, key_points: list[str], user_answer: str,
                               question_type: str, ctx: AIContext | None = None) -> dict:
    """
    批改英文作答。返回：
    {"is_correct", "score"(0-10), "content_feedback", "language_feedback", "improved_answer"}
    """
    if question_type == "blank":
        prompt = f"""Fill-in-the-blank question: {question}
Expected answer: {model_answer}
Student answer: {user_answer}

Is the student's answer correct? Accept synonyms, singular/plural, small spelling mistakes and Chinese translations of the correct term.
Return JSON only: {{"is_correct": true, "score": 10, "content_feedback": "一句中文说明", "language_feedback": "", "improved_answer": ""}}"""
        max_tokens = 400
    else:
        kp = "\n".join(f"- {k}" for k in key_points) if key_points else "(none given)"
        prompt = f"""Exam question: {question}
Model answer: {model_answer}
Scoring points:
{kp}

Student's answer (the student is a Chinese international student; English is not their first language):
\"\"\"{user_answer[:2000]}\"\"\"

Mark it like a fair university examiner. Content matters most; minor grammar mistakes should not lose content marks.
Return JSON only:
{{"score": 0-10,
  "is_correct": true if score >= 6,
  "content_feedback": "用简体中文：答到了哪些得分点，漏了哪些（点名具体要点）",
  "language_feedback": "用简体中文：指出 1–3 处英文表达问题并给出改法；没有问题就写「英文表达清楚」",
  "improved_answer": "在保留学生思路的前提下，改写成一段能拿高分的英文答案（60–120 words）"}}"""
        max_tokens = 1500
    result, _ = await call_ai([{"role": "system", "content": "You are a fair university examiner. Output JSON only."},
                               {"role": "user", "content": prompt}],
                              ctx, kind="grade", max_tokens=max_tokens, temperature=0.2)
    if not isinstance(result, dict) or "is_correct" not in result and "score" not in result:
        raise ValueError("批改结果格式不对")
    try:
        score = float(result.get("score", 10 if result.get("is_correct") else 0))
    except (TypeError, ValueError):
        score = 0.0
    score = max(0.0, min(10.0, score))
    is_correct = bool(result.get("is_correct")) if "is_correct" in result else score >= 6
    return {
        "is_correct": is_correct,
        "score": round(score, 1),
        "content_feedback": str(result.get("content_feedback", "")).strip(),
        "language_feedback": str(result.get("language_feedback", "")).strip(),
        "improved_answer": str(result.get("improved_answer", "")).strip(),
    }


# =====================================================================
# 旧版接口（整篇生成），保留兼容
# =====================================================================

OUTLINE_CONTENT_PROMPT = """你是一位资深的大学课程教学设计专家。你需要根据提供的学习材料，生成一套结构化的教学内容。

## 学生背景
- 年级：{grade}
- 专业：{major}
- 专业课程：{subject}

## 原始材料
{source_text}

## 任务要求
请生成一份完整、详细的教学内容，严格按 JSON 格式返回：
{{"topic": "主题名称", "outline": [{{"title": "第一章 xxx", "summary": "一句话概括"}}],
  "chapters": [{{"title": "第一章 xxx", "sections": [{{"heading": "1.1 概念介绍", "body": "详细讲解...", "example": "举个例子..."}}]}}]}}
将内容组织为 4-6 个章节，每章 2-4 节，每节 body 300-800 字，example 必填。
""" + STYLE_RULES


async def generate_teaching_content(source_text: str, grade: str = "", major: str = "", subject: str = "",
                                    user_id: int | None = None, ctx: AIContext | None = None) -> dict:
    prompt = OUTLINE_CONTENT_PROMPT.format(grade=grade or "未指定", major=major or "未指定",
                                           subject=subject or "未指定", source_text=source_text[:30000])
    result, _ = await call_ai([{"role": "system", "content": "你是一个专业的教学助手。只输出 JSON。"},
                               {"role": "user", "content": prompt}],
                              ctx or AIContext(user_id=user_id), kind="legacy-content", max_tokens=8000, timeout=180)
    return result if isinstance(result, dict) else {}


async def generate_vocabulary(content_text: str, grade: str = "", user_id: int | None = None,
                              ctx: AIContext | None = None) -> list[dict]:
    prompt = f"""请根据以下教学内容，提取 15-25 个专业相关的英语词汇或术语，覆盖所有核心概念。
## 教学内容
{content_text[:12000]}

严格按 JSON 数组返回：[{{"word": "algorithm", "translation": "算法", "example": "This algorithm can sort data efficiently."}}]"""
    result, _ = await call_ai([{"role": "system", "content": "你是一位英语教学专家。只输出 JSON。"},
                               {"role": "user", "content": prompt}],
                              ctx or AIContext(user_id=user_id), kind="legacy-vocab", max_tokens=3000)
    if isinstance(result, dict):
        result = result.get("words") or result.get("vocabulary") or []
    return [w for w in result if isinstance(w, dict) and w.get("word")]
