"""
后端自动化测试（不会真的调用 AI，用假的模型回复代替）

运行方法（在 backend 目录下）：
    python -m unittest discover -s tests -v
"""
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="aixue-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(TMP, 'test.db')}"
os.environ.pop("JWT_SECRET", None)          # 测试：没配置密钥时自动生成
os.environ["GEMINI_API_KEY"] = "fake-gemini"
os.environ["GLM_API_KEY"] = "fake-glm"
os.environ.pop("AI_API_KEY", None)
os.environ["FREE_DAILY_LIMIT"] = "1000"
os.environ["AUTH_MODE"] = "anonymous"
sys.path.insert(0, BACKEND)

import jwt  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import config  # noqa: E402
import main  # noqa: E402
from database import SessionLocal  # noqa: E402
from models.models import User, Document, DocPage, WrongBook, AIUsage, UserVocab  # noqa: E402
from services import ai_service  # noqa: E402


# ---------------------------------------------------------------- 假模型

class FakeAI:
    def __init__(self):
        self.calls = []          # (provider_key, kind_guess, has_image)
        self.fail = set()        # 这些 provider 会报错
        self.grade_fails = False
        self.outline_raw = None

    async def __call__(self, p, messages, max_tokens, temperature, timeout):
        sys_text = messages[0]["content"] if isinstance(messages[0]["content"], str) else ""
        user = messages[-1]["content"]
        has_image = isinstance(user, list) and any(part.get("type") == "image_url" for part in user)
        user_text = user if isinstance(user, str) else " ".join(x.get("text", "") for x in user if x.get("type") == "text")
        if "整理课件结构" in sys_text:
            kind = "outline"
        elif "看懂英文课件" in sys_text:
            kind = "explain"
        elif "rigorous university examiner" in sys_text:
            kind = "exercises"
        elif "fair university examiner" in sys_text:
            kind = "grade"
        elif "一起看课件" in sys_text:
            kind = "ask"
        elif "课程设计专家" in sys_text:
            kind = "topic"
        else:
            kind = "other"
        self.calls.append((p.key, kind, has_image))
        if p.key in self.fail:
            raise RuntimeError(f"{p.key} down")
        if kind == "outline":
            return self.outline_raw or json.dumps({"title": "面向对象 (OOP)", "summary": "s", "sections": [
                {"title": "A", "summary": "a", "start": 1, "end": 2},
                {"title": "B", "summary": "b", "start": 2, "end": 2},   # 和上一章重叠
                {"title": "C", "summary": "c", "start": 4, "end": 9},   # 中间缺了第 3 页，结尾超出
            ]})
        if kind == "explain":
            return "```json\n" + json.dumps({"summary": "讲封装", "explanation": "**封装 (Encapsulation)** 就是…",
                                             "key_terms": [{"en": "Encapsulation", "zh": "封装", "note": "把数据藏起来"}],
                                             "example": "像胶囊", "exam_tip": "Encapsulation hides data.",
                                             "page_type": "content"}) + "\n```"
        if kind == "exercises":
            return json.dumps({"exercises": [
                {"type": "choice", "question": "What is encapsulation?", "options": ["A. x", "B. y", "C. z", "D. w"],
                 "answer": "B", "explanation": "因为…", "page": 1},
                {"type": "blank", "question": "___ hides data.", "answer": "Encapsulation", "explanation": "…", "page": 2},
                {"type": "short_answer", "question": "Explain encapsulation. (4 marks)", "answer": "model",
                 "key_points": ["hide data", "public methods"], "explanation": "…", "page": 3},
            ]})
        if kind == "grade":
            if self.grade_fails:
                raise RuntimeError("grader down")
            student = user_text.split('"""')[1] if '"""' in user_text else user_text.split("Student answer:")[-1]
            ok = "correct" in student.lower()
            return json.dumps({"score": 8 if ok else 2, "is_correct": ok, "content_feedback": "要点",
                               "language_feedback": "英文表达清楚", "improved_answer": "Better answer."})
        if kind == "ask":
            return "这是回答。"
        if kind == "topic":
            return json.dumps({"title": "排序 (Sorting)", "summary": "s", "sections": [
                {"title": "冒泡", "summary": "", "pages": [{"title": "Bubble sort", "points": "- swap"},
                                                         {"title": "Complexity", "points": "- O(n^2)"}]}]})
        return "{}"


FAKE = FakeAI()
ai_service._post_chat = FAKE


# ---------------------------------------------------------------- 测试用文件

def make_pptx() -> bytes:
    from pptx import Presentation
    from pptx.util import Inches
    from PIL import Image

    prs = Presentation()
    layout = prs.slide_layouts[5]  # 只有标题
    for i in range(1, 6):
        slide = prs.slides.add_slide(layout)
        slide.shapes.title.text = f"Slide {i} Encapsulation"
        if i == 2:
            # 组合图形里的文字（旧版解析器读不到）
            group = slide.shapes.add_group_shape()
            tb = group.shapes.add_textbox(Inches(1), Inches(2), Inches(3), Inches(1))
            tb.text_frame.text = "Text inside a group"
            slide.notes_slide.notes_text_frame.text = "Speaker note for slide 2"
        if i == 3:
            img = Image.new("RGB", (400, 300), (200, 30, 30))
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            slide.shapes.add_picture(buf, Inches(1), Inches(2), Inches(4), Inches(3))
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


def make_pdf(lines: list[str]) -> bytes:
    """手写一个最小的带文字 PDF（每行一页）"""
    objs = []
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(len(lines)))
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(lines)} >>")
    font_id = 3 + len(lines) * 2
    for i, line in enumerate(lines):
        content_id = 4 + i * 2
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
                    f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>")
        stream = f"BT /F1 24 Tf 72 700 Td ({line}) Tj ET"
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = "%PDF-1.4\n"
    offsets = []
    for n, o in enumerate(objs, 1):
        offsets.append(len(out.encode()))
        out += f"{n} 0 obj\n{o}\nendobj\n"
    xref = len(out.encode())
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n"
    out += "".join(f"{off:010d} 00000 n \n" for off in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    return out.encode()


# ---------------------------------------------------------------- 测试

class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.client.__enter__()  # 触发 lifespan：建表、生成密钥

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def anon(self):
        r = self.client.post("/api/auth/anonymous")
        self.assertEqual(r.status_code, 200, r.text)
        return {"Authorization": f"Bearer {r.json()['token']}"}

    def upload(self, headers, name, data):
        r = self.client.post("/api/study/upload", headers=headers, files={"file": (name, data, "application/octet-stream")})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ---- 安全 & 登录 ----

    def test_health_and_mode(self):
        self.assertEqual(self.client.get("/api/health").json()["status"], "ok")
        self.assertNotIn("users", self.client.get("/api/health").json())
        mode = self.client.get("/api/auth/mode").json()
        self.assertTrue(mode["anonymous"])
        self.assertFalse(mode["account"])

    def test_login_offline_but_code_kept(self):
        r = self.client.post("/api/auth/login", json={"email": "a@b.c", "password": "123456"})
        self.assertEqual(r.status_code, 403)
        r = self.client.post("/api/auth/register", json={"email": "a@b.c", "password": "123456", "confirm_password": "123456"})
        self.assertEqual(r.status_code, 403)

    def test_leaked_default_secret_rejected(self):
        forged = jwt.encode({"user_id": 1, "email": "x", "exp": datetime.utcnow() + timedelta(days=1)},
                            "aixue-secret-change-in-production", algorithm="HS256")
        r = self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {forged}"})
        self.assertEqual(r.status_code, 401)

    def test_anonymous_me(self):
        h = self.anon()
        me = self.client.get("/api/auth/me", headers=h).json()
        self.assertTrue(me["is_anonymous"])
        self.assertEqual(me["email"], "")

    def test_api_key_encrypted_and_legacy_migrated(self):
        h = self.anon()
        r = self.client.post("/api/settings/api-key", headers=h, json={"api_key": "sk-test-1234567890abcdef"})
        self.assertEqual(r.status_code, 200, r.text)
        st = self.client.get("/api/settings/api-key/status", headers=h).json()
        self.assertEqual(st["source"], "user")
        self.assertNotIn("1234567890", st["masked"])
        uid = self.client.get("/api/auth/me", headers=h).json()["id"]
        db = SessionLocal()
        u = db.query(User).get(uid)
        self.assertIsNone(u.api_key)
        self.assertTrue(u.api_key_enc.startswith("enc:"))
        self.assertNotIn("1234567890", u.api_key_enc)
        # 旧版明文 Key 自动迁移
        u.api_key, u.api_key_enc = "sk-legacy-plaintext-key", None
        db.commit()
        db.close()
        st = self.client.get("/api/settings/api-key/status", headers=h).json()
        self.assertEqual(st["source"], "user")
        db = SessionLocal()
        u = db.query(User).get(uid)
        self.assertIsNone(u.api_key)
        self.assertTrue(u.api_key_enc.startswith("enc:"))
        db.close()

    # ---- 解析 ----

    def test_pptx_parsing_groups_notes_images(self):
        from services.parser_service import parse_document
        doc = parse_document("x.pptx", make_pptx())
        self.assertEqual(len(doc.pages), 5)
        self.assertIn("Text inside a group", doc.pages[1].text)
        self.assertEqual(doc.pages[1].notes, "Speaker note for slide 2")
        self.assertIsNotNone(doc.pages[2].image)
        self.assertEqual(doc.pages[2].image_kind, "picture")

    def test_pdf_parsing_renders_pages(self):
        from services.parser_service import parse_document
        doc = parse_document("x.pdf", make_pdf(["Hello Encapsulation", "Second page"]))
        self.assertEqual(len(doc.pages), 2)
        self.assertIn("Hello Encapsulation", doc.pages[0].text)
        self.assertIsNotNone(doc.pages[0].image)
        self.assertEqual(doc.pages[0].image[:2], b"\xff\xd8")  # JPEG

    def test_docx_parsing(self):
        from docx import Document as D
        d = D()
        d.add_heading("Chapter 1", level=1)
        d.add_paragraph("Intro " * 50)
        d.add_heading("Chapter 2", level=1)
        d.add_paragraph("More " * 50)
        buf = io.BytesIO()
        d.save(buf)
        from services.parser_service import parse_document
        doc = parse_document("x.docx", buf.getvalue())
        self.assertEqual(len(doc.pages), 2)
        self.assertTrue(doc.pages[1].title.startswith("Chapter 2"))

    # ---- 逐页学习主流程 ----

    def test_full_flow(self):
        FAKE.calls.clear()
        FAKE.fail = set()
        h1 = self.anon()
        pptx = make_pptx()
        v = self.upload(h1, "OOP Lecture.pptx", pptx)
        self.assertFalse(v["reused"])
        self.assertEqual(v["page_count"], 5)
        self.assertFalse(v["outline_ready"])
        sid = v["session_id"]

        # 大纲：AI 给的有重叠、缺页、越界 → 自动修好
        o = self.client.post(f"/api/study/{sid}/outline", headers=h1).json()
        secs = o["sections"]
        self.assertEqual(secs[0]["start"], 1)
        self.assertEqual(secs[-1]["end"], 5)
        for a, b in zip(secs, secs[1:]):
            self.assertEqual(a["end"] + 1, b["start"])
        self.assertEqual(o["title"], "面向对象 (OOP)")

        # 讲解：第一次生成，第二次走缓存
        r = self.client.post(f"/api/study/{sid}/pages/2/explain", headers=h1).json()
        self.assertFalse(r["cached"])
        self.assertEqual(r["explanation"]["key_terms"][0]["en"], "Encapsulation")
        r2 = self.client.post(f"/api/study/{sid}/pages/2/explain", headers=h1).json()
        self.assertTrue(r2["cached"])
        self.assertEqual(sum(1 for c in FAKE.calls if c[1] == "explain"), 1)

        # 第 3 页有图：发给能看图的 Gemini
        FAKE.calls.clear()
        self.client.post(f"/api/study/{sid}/pages/3/explain", headers=h1)
        self.assertEqual(FAKE.calls[0][0], "gemini")
        self.assertTrue(FAKE.calls[0][2])

        # Gemini 挂了 → 自动切到 GLM，图片被去掉
        FAKE.calls.clear()
        FAKE.fail = {"gemini"}
        r = self.client.post(f"/api/study/{sid}/pages/4/explain", headers=h1)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([c[0] for c in FAKE.calls], ["gemini", "glm"])
        FAKE.fail = set()

        # 原页面图片
        img = self.client.get(f"/api/study/{sid}/pages/3/image", headers=h1)
        self.assertEqual(img.status_code, 200)
        self.assertEqual(img.headers["content-type"], "image/jpeg")

        # 追问
        a = self.client.post(f"/api/study/{sid}/pages/2/ask", headers=h1, json={"question": "什么意思？"})
        self.assertEqual(a.json()["answer"], "这是回答。")
        detail = self.client.get(f"/api/study/{sid}/pages/2", headers=h1).json()
        self.assertEqual([m["role"] for m in detail["chat"]], ["user", "assistant"])

        # 进度
        self.client.post(f"/api/study/{sid}/progress", headers=h1, json={"page_no": 2})
        self.assertEqual(self.client.get(f"/api/study/{sid}", headers=h1).json()["progress"]["last_page"], 2)

        # 同一份课件，另一位同学上传：直接复用，不再调用 AI
        FAKE.calls.clear()
        h2 = self.anon()
        v2 = self.upload(h2, "renamed.pptx", pptx)
        self.assertTrue(v2["reused"])
        self.assertEqual(v2["document_id"], v["document_id"])
        self.assertTrue(v2["outline_ready"])
        sid2 = v2["session_id"]
        r = self.client.post(f"/api/study/{sid2}/pages/2/explain", headers=h2).json()
        self.assertTrue(r["cached"])
        self.assertEqual(FAKE.calls, [])
        # 但是看不到别人的追问记录
        self.assertEqual(self.client.get(f"/api/study/{sid2}/pages/2", headers=h2).json()["chat"], [])

        # 权限：不能打开别人的学习记录
        self.assertEqual(self.client.get(f"/api/study/{sid}", headers=h2).status_code, 404)
        self.assertEqual(self.client.post(f"/api/study/{sid}/pages/2/ask", headers=h2, json={"question": "x"}).status_code, 404)
        self.assertEqual(self.client.post(f"/api/practice/generate/{sid}", headers=h2).status_code, 404)

        # ---- 练习 ----
        g = self.client.post(f"/api/practice/generate/{sid}?scope=section-0", headers=h1).json()
        self.assertEqual(len(g["exercises"]), 3)
        for ex in g["exercises"]:
            self.assertNotIn("answer", ex)       # 不再把答案发给浏览器
        g_again = self.client.post(f"/api/practice/generate/{sid}?scope=section-0", headers=h1).json()
        self.assertTrue(g_again["reused"])
        ids = {ex["type"]: ex["id"] for ex in g["exercises"]}
        FAKE.grade_fails = False
        res = self.client.post(f"/api/practice/submit/{sid}", headers=h1, json={"answers": [
            {"exercise_id": ids["choice"], "answer": "B"},
            {"exercise_id": ids["blank"], "answer": "encapsulation"},
            {"exercise_id": ids["short_answer"], "answer": "a wrong idea"},
        ]}).json()
        status = {r["exercise_id"]: r["status"] for r in res["results"]}
        self.assertEqual(status[ids["choice"]], "correct")
        self.assertEqual(status[ids["blank"]], "correct")
        self.assertEqual(status[ids["short_answer"]], "wrong")
        sa = next(r for r in res["results"] if r["exercise_id"] == ids["short_answer"])
        self.assertEqual(sa["feedback"]["improved"], "Better answer.")
        wb = self.client.get("/api/practice/wrong-book", headers=h1).json()["entries"]
        self.assertEqual(len(wb), 1)
        self.assertIsNotNone(wb[0]["next_review_at"])

        # 批改失败 → 不判错、不进错题本
        g2 = self.client.post(f"/api/practice/generate/{sid}?scope=all&fresh=1", headers=h1).json()
        sa_id = next(e["id"] for e in g2["exercises"] if e["type"] == "short_answer")
        FAKE.grade_fails = True
        res2 = self.client.post(f"/api/practice/submit/{sid}", headers=h1,
                                json={"answers": [{"exercise_id": sa_id, "answer": "correct answer"}]}).json()
        FAKE.grade_fails = False
        self.assertEqual(res2["results"][0]["status"], "ungraded")
        self.assertEqual(res2["ungraded"], 1)
        self.assertEqual(len(self.client.get("/api/practice/wrong-book", headers=h1).json()["entries"]), 1)

        # ---- 今日复习 ----
        self.assertEqual(self.client.get("/api/review/summary", headers=h1).json()["questions_due"], 0)  # 明天才复习
        db = SessionLocal()
        e = db.query(WrongBook).filter(WrongBook.id == wb[0]["id"]).first()
        e.next_review_at = datetime.utcnow() - timedelta(minutes=1)
        db.commit()
        db.close()
        today = self.client.get("/api/review/today", headers=h1).json()
        self.assertEqual(len(today["questions"]), 1)
        self.assertNotIn("correct_answer", today["questions"][0])
        rv = self.client.post(f"/api/review/questions/{wb[0]['id']}", headers=h1, json={"answer": "correct answer"}).json()
        self.assertTrue(rv["is_correct"])
        db = SessionLocal()
        e = db.query(WrongBook).filter(WrongBook.id == wb[0]["id"]).first()
        self.assertEqual(e.box, 1)
        self.assertGreater(e.next_review_at, datetime.utcnow() + timedelta(days=1, hours=23))
        db.close()

        # ---- 术语收藏 ----
        w = self.client.post("/api/review/words", headers=h1, json={"word": "Encapsulation", "translation": "封装",
                                                                    "session_id": sid, "page_no": 2}).json()
        self.client.post("/api/review/words", headers=h1, json={"word": "encapsulation", "translation": "封装"})
        self.assertEqual(len(self.client.get("/api/review/words", headers=h1).json()["words"]), 1)  # 去重
        rw = self.client.post(f"/api/review/words/{w['id']}/review", headers=h1, json={"remembered": True}).json()
        self.assertEqual(rw["box"], 1)
        self.assertEqual(len(self.client.get("/api/user/vocabulary", headers=h1).json()["words"]), 1)
        # 别人删不掉我的词
        self.client.delete(f"/api/review/words/{w['id']}", headers=h2)
        self.assertEqual(len(self.client.get("/api/review/words", headers=h1).json()["words"]), 1)

        # 导出
        ex = self.client.get(f"/api/study/{sid}/export", headers=h1).json()
        self.assertEqual(len(ex["pages"]), 5)

        # 历史
        hist = self.client.get("/api/study/history", headers=h1).json()["sessions"]
        self.assertEqual(hist[0]["session_id"], sid)

    def test_outline_fallback_when_ai_down(self):
        FAKE.fail = {"gemini", "glm"}
        try:
            h = self.anon()
            v = self.upload(h, "down.pdf", make_pdf([f"Page {i}" for i in range(1, 13)]))
            o = self.client.post(f"/api/study/{v['session_id']}/outline", headers=h)
            self.assertEqual(o.status_code, 200, o.text)
            o = o.json()
            self.assertTrue(o["outline_fallback"])
            self.assertEqual(o["sections"][-1]["end"], 12)
            r = self.client.post(f"/api/study/{v['session_id']}/pages/1/explain", headers=h)
            self.assertEqual(r.status_code, 503)
            self.assertIn("暂时不可用", r.json()["detail"])
        finally:
            FAKE.fail = set()
        # AI 恢复后再请求大纲：重新生成正式大纲
        o2 = self.client.post(f"/api/study/{v['session_id']}/outline", headers=h).json()
        self.assertFalse(o2["outline_fallback"])

    def test_topic_mode(self):
        h = self.anon()
        r = self.client.post("/api/study/topic", headers=h, json={"topic": "排序算法"})
        self.assertEqual(r.status_code, 200, r.text)
        v = r.json()
        self.assertEqual(v["page_count"], 2)
        self.assertTrue(v["outline_ready"])

    def test_quota_and_own_key(self):
        old = config.FREE_DAILY_LIMIT
        config.FREE_DAILY_LIMIT = 2
        try:
            h = self.anon()
            v = self.upload(h, "quota.pdf", make_pdf(["Alpha content here", "Beta content here", "Gamma content here"]))
            sid = v["session_id"]
            self.assertEqual(self.client.post(f"/api/study/{sid}/pages/1/explain", headers=h).status_code, 200)
            self.assertEqual(self.client.post(f"/api/study/{sid}/pages/2/explain", headers=h).status_code, 200)
            r = self.client.post(f"/api/study/{sid}/pages/3/explain", headers=h)
            self.assertEqual(r.status_code, 429)
            self.assertIn("免费", r.json()["detail"])
            # 填了自己的 Key 就不受限制
            self.client.post("/api/settings/api-key", headers=h, json={"api_key": "sk-own-key-0000000000"})
            FAKE.calls.clear()
            r = self.client.post(f"/api/study/{sid}/pages/3/explain", headers=h)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(FAKE.calls[0][0], "user-deepseek")
            q = self.client.get("/api/study/quota", headers=h).json()
            self.assertEqual(q["used"], 2)
            self.assertTrue(q["own_key"])
        finally:
            config.FREE_DAILY_LIMIT = old

    def test_legacy_content_session_is_private(self):
        h1, h2 = self.anon(), self.anon()
        from models.models import StudySession
        uid = self.client.get("/api/auth/me", headers=h1).json()["id"]
        db = SessionLocal()
        db.add(StudySession(session_id="legacy-1", topic="t", user_id=uid, outline="[]", content="[]"))
        db.commit()
        db.close()
        self.assertEqual(self.client.get("/api/content/legacy-1", headers=h1).status_code, 200)
        self.assertEqual(self.client.get("/api/content/legacy-1", headers=h2).status_code, 404)


class MigrationTest(unittest.TestCase):
    def test_old_database_gets_new_columns(self):
        path = os.path.join(TMP, "old.db")
        con = sqlite3.connect(path)
        con.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(200) UNIQUE NOT NULL, password_hash VARCHAR(200) NOT NULL,
            grade VARCHAR(20), major VARCHAR(100), subject VARCHAR(100), is_admin BOOLEAN, login_attempts INTEGER,
            locked_until DATETIME, created_at DATETIME, last_login_at DATETIME);
        CREATE TABLE study_sessions (id INTEGER PRIMARY KEY, session_id VARCHAR(36) UNIQUE NOT NULL, topic VARCHAR(500) NOT NULL,
            source_type VARCHAR(20), source_text TEXT, outline TEXT, content TEXT, profile_id INTEGER, user_id INTEGER, created_at DATETIME);
        CREATE TABLE exercises (id INTEGER PRIMARY KEY, session_id VARCHAR(36) NOT NULL, chapter_index INTEGER,
            question_type VARCHAR(20) NOT NULL, question TEXT NOT NULL, options TEXT, correct_answer TEXT, explanation TEXT, created_at DATETIME);
        CREATE TABLE wrong_book (id INTEGER PRIMARY KEY, exercise_id INTEGER NOT NULL, user_answer TEXT, is_correct BOOLEAN,
            user_id INTEGER, created_at DATETIME);
        INSERT INTO users (email, password_hash) VALUES ('old@x.com', 'hash');
        """)
        con.commit()
        con.close()
        env = dict(os.environ, DATABASE_URL=f"sqlite:///{path}")
        code = "from database import init_db; init_db(); print('ok')"
        out = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env=env, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        con = sqlite3.connect(path)
        cols = {r[1] for r in con.execute("PRAGMA table_info(users)")}
        self.assertTrue({"api_key", "api_key_enc", "is_anonymous"} <= cols)
        cols = {r[1] for r in con.execute("PRAGMA table_info(wrong_book)")}
        self.assertTrue({"box", "next_review_at", "mastered"} <= cols)
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"documents", "doc_pages", "page_chats", "ai_usage", "user_vocab"} <= tables)
        self.assertEqual(con.execute("SELECT email FROM users").fetchone()[0], "old@x.com")
        con.close()


if __name__ == "__main__":
    unittest.main()
