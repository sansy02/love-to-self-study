"""
数据模型定义
"""
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, ForeignKey, LargeBinary, UniqueConstraint, Index
from database import Base


class ContentCache(Base):
    """内容缓存 — 相同输入直接返回缓存，省 Token（旧版整篇生成使用）"""
    __tablename__ = "content_cache"

    id = Column(Integer, primary_key=True, autoincrement=True)
    content_hash = Column(String(64), unique=True, nullable=False, index=True)  # SHA256
    topic = Column(String(500), default="")
    outline = Column(Text, default="")    # JSON
    content = Column(Text, default="")    # JSON
    hit_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class AppSetting(Base):
    """应用配置（自动生成的密钥等）"""
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(100), unique=True, nullable=False)
    value = Column(Text, default="")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class StudentProfile(Base):
    """学生画像 — 年级、专业、学科"""
    __tablename__ = "student_profiles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    grade = Column(String(20), default="")
    major = Column(String(100), default="")
    subject = Column(String(100), default="")
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class FeaturePreference(Base):
    """功能偏好设置"""
    __tablename__ = "feature_preferences"

    id = Column(Integer, primary_key=True, autoincrement=True)
    show_english = Column(Boolean, default=True)
    show_practice = Column(Boolean, default=True)
    show_wrong_book = Column(Boolean, default=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)


class Document(Base):
    """
    一份课件（或一个话题）。同一份文件（按内容哈希）全站只解析、只生成一次，
    不同用户上传同一份课件时直接复用大纲和逐页讲解。
    """
    __tablename__ = "documents"

    id = Column(String(32), primary_key=True)                 # uuid hex
    content_hash = Column(String(64), unique=True, nullable=False, index=True)
    source_type = Column(String(20), default="file")          # file / topic
    file_type = Column(String(10), default="")                # pptx / pdf / docx / topic
    filename = Column(String(300), default="")
    title = Column(String(500), default="")
    page_count = Column(Integer, default=0)
    outline = Column(Text, default="")                        # JSON: {title, summary, sections:[{title, summary, start, end}]}
    created_at = Column(DateTime, default=datetime.utcnow)


class DocPage(Base):
    """课件里的一页，以及这一页的 AI 讲解缓存"""
    __tablename__ = "doc_pages"
    __table_args__ = (UniqueConstraint("document_id", "page_no", name="uq_doc_page"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(String(32), ForeignKey("documents.id"), nullable=False, index=True)
    page_no = Column(Integer, nullable=False)                 # 从 1 开始
    title = Column(String(300), default="")
    text = Column(Text, default="")
    notes = Column(Text, default="")                          # PPT 演讲者备注
    image = Column(LargeBinary, nullable=True)                # JPEG：PDF 为整页截图，PPT 为页面里最大的图片
    image_kind = Column(String(20), default="")               # page / picture / ""
    image_count = Column(Integer, default=0)
    explanation = Column(Text, default="")                    # JSON 缓存
    explanation_provider = Column(String(50), default="")
    explained_at = Column(DateTime, nullable=True)


class StudySession(Base):
    """学习记录（每个用户每份课件一条）"""
    __tablename__ = "study_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), unique=True, nullable=False)
    topic = Column(String(500), nullable=False)
    source_type = Column(String(20), default="topic")  # "topic" 或 "file"
    source_text = Column(Text, default="")              # 原始文本内容（旧版）
    outline = Column(Text, default="")                  # JSON: 教学大纲（旧版）
    content = Column(Text, default="")                  # JSON: 教学内容（旧版）
    document_id = Column(String(32), nullable=True, index=True)   # 新版：逐页学习
    progress = Column(Text, default="")                 # JSON: {"last_page": 3, "visited": [1,2,3]}
    profile_id = Column(Integer, ForeignKey("student_profiles.id"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    course_id = Column(Integer, nullable=True, index=True)          # 2.2：属于哪门课
    material_type = Column(String(20), default="lecture")           # lecture / tutorial / past_exam / notes
    week = Column(Integer, nullable=True)                           # 第几周（可不填）
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)


class Course(Base):
    """一门课：把老师课件、Tutorial、往年考试题等资料组织在一起"""
    __tablename__ = "courses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    code = Column(String(50), default="")
    exam_date = Column(String(10), default="")       # YYYY-MM-DD，可不填
    kind = Column(String(20), default="normal")      # normal / inbox（未分类）/ sample
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)


class PageChat(Base):
    """每一页的追问记录（按用户隔离）"""
    __tablename__ = "page_chats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    page_no = Column(Integer, nullable=False)
    role = Column(String(10), nullable=False)   # user / assistant
    content = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class AIUsage(Base):
    """AI 调用记录，用于免费额度统计"""
    __tablename__ = "ai_usage"
    __table_args__ = (Index("ix_ai_usage_user_time", "user_id", "created_at"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=True)
    ip = Column(String(64), default="")
    kind = Column(String(30), default="")        # outline / explain / ask / exercises / grade ...
    provider = Column(String(50), default="")
    free_pool = Column(Boolean, default=True)    # 是否消耗了站长提供的免费额度
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class Vocabulary(Base):
    """英语词汇（旧版按学习记录生成的词表）"""
    __tablename__ = "vocabularies"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), nullable=False)
    chapter_index = Column(Integer, default=0)
    word = Column(String(200), nullable=False)
    translation = Column(String(500), default="")
    example = Column(String(1000), default="")
    favorited = Column(Boolean, default=False)       # 旧字段，已不再使用（收藏改为每人一份，见 UserVocab）
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class UserVocab(Base):
    """用户收藏的术语 + 间隔复习状态"""
    __tablename__ = "user_vocab"
    __table_args__ = (UniqueConstraint("user_id", "word_key", name="uq_user_word"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    word = Column(String(200), nullable=False)
    word_key = Column(String(200), nullable=False)       # 小写，用于去重
    translation = Column(String(500), default="")
    note = Column(String(1000), default="")
    example = Column(String(1000), default="")
    session_id = Column(String(36), default="")
    page_no = Column(Integer, nullable=True)
    box = Column(Integer, default=0)
    next_review_at = Column(DateTime, nullable=True)
    review_count = Column(Integer, default=0)
    mastered = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Exercise(Base):
    """练习题"""
    __tablename__ = "exercises"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), nullable=False)
    chapter_index = Column(Integer, default=0)
    question_type = Column(String(20), nullable=False)  # choice / blank / short_answer
    question = Column(Text, nullable=False)
    options = Column(Text, default="")           # JSON: 选择题选项
    correct_answer = Column(Text, default="")
    explanation = Column(Text, default="")
    key_points = Column(Text, default="")        # JSON: 简答题得分要点
    page_no = Column(Integer, nullable=True)     # 出自第几页
    scope = Column(String(50), default="all")    # all / section-2 ...
    batch = Column(String(36), default="")       # 同一次生成的一套题
    answered = Column(Boolean, default=False)
    lang = Column(String(10), default="zh")      # 题目语言
    kp_ids = Column(Text, default="")            # JSON: 关联的知识点 id 列表
    source_label = Column(String(200), default="")  # 3.0 题库：原题出处，例如「Q4(b)」
    marks = Column(Integer, nullable=True)           # 3.0 题库：原题分值
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class KnowledgePoint(Base):
    """
    知识点：来自课件大纲的章节（kind=section）和讲解里的关键术语（kind=term）。
    出题时 AI 只能从这份清单里选，不能自己发明知识点。
    """
    __tablename__ = "knowledge_points"
    __table_args__ = (UniqueConstraint("document_id", "name", name="uq_doc_kp"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(String(32), ForeignKey("documents.id"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    kind = Column(String(20), default="section")     # section / term
    section_index = Column(Integer, nullable=True)
    page_start = Column(Integer, nullable=True)
    page_end = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Attempt(Base):
    """
    每一次作答都记一条（练习、复习、补救题），用于计算掌握度。
    evidence：strong = 选择题/填空题精确判分；weak = AI 给简答题打的分（只作参考）
    """
    __tablename__ = "attempts"
    __table_args__ = (Index("ix_attempt_user_time", "user_id", "created_at"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    exercise_id = Column(Integer, ForeignKey("exercises.id"), nullable=False, index=True)
    session_id = Column(String(36), default="")
    kp_ids = Column(Text, default="")                # JSON
    question_type = Column(String(20), default="")
    user_answer = Column(Text, default="")
    correct_answer = Column(Text, default="")
    status = Column(String(20), default="")          # correct / wrong / ungraded
    score = Column(Integer, nullable=True)
    evidence = Column(String(10), default="strong")  # strong / weak
    graded_by = Column(String(10), default="rule")   # rule / ai / keyword
    error_reason = Column(String(20), default="")    # 见 ai_service.ERROR_TYPES
    error_reason_source = Column(String(10), default="")  # ai / user
    feedback = Column(Text, default="")              # JSON
    source = Column(String(20), default="practice")  # practice / review / remedial
    created_at = Column(DateTime, default=datetime.utcnow)


class User(Base):
    """用户表"""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String(200), unique=True, nullable=False, index=True)
    password_hash = Column(String(200), nullable=False)
    grade = Column(String(20), default="")
    major = Column(String(100), default="")
    subject = Column(String(100), default="")
    is_admin = Column(Boolean, default=False)
    is_anonymous = Column(Boolean, default=False)
    api_key = Column(String(200), nullable=True)          # 旧字段：明文 Key（读取时自动迁移到 api_key_enc 并清空）
    api_key_enc = Column(Text, nullable=True)             # 加密后的用户 API Key
    recovery_hash = Column(String(64), nullable=True, index=True)  # 找回码的哈希（不存明文）
    recovery_created_at = Column(DateTime, nullable=True)
    learn_profile = Column(Text, default="")             # 3.0：学习方式问卷（JSON）
    login_attempts = Column(Integer, default=0)        # 登录失败次数
    locked_until = Column(DateTime, nullable=True)      # 锁定到期时间
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login_at = Column(DateTime, nullable=True)


class WrongBook(Base):
    """错题本 + 间隔复习状态"""
    __tablename__ = "wrong_book"

    id = Column(Integer, primary_key=True, autoincrement=True)
    exercise_id = Column(Integer, ForeignKey("exercises.id"), nullable=False)
    user_answer = Column(Text, default="")
    is_correct = Column(Boolean, default=False)
    feedback = Column(Text, default="")            # JSON: 最近一次批改反馈
    box = Column(Integer, default=0)               # 莱特纳盒子：0 表示刚错
    next_review_at = Column(DateTime, nullable=True)
    review_count = Column(Integer, default=0)
    mastered = Column(Boolean, default=False)
    last_reviewed_at = Column(DateTime, nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class PageStyleExplanation(Base):
    """
    3.0：按学习方式生成的讲解（英文程度 / 先例子还是先定义 / 长短）。
    默认方式的讲解仍然放在 DocPage.explanation；其他方式按 style_key 缓存，同样方式的人直接复用。
    """
    __tablename__ = "page_style_explanations"
    __table_args__ = (UniqueConstraint("document_id", "page_no", "style_key", name="uq_page_style"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(String(32), ForeignKey("documents.id"), nullable=False, index=True)
    page_no = Column(Integer, nullable=False)
    style_key = Column(String(60), nullable=False)
    explanation = Column(Text, default="")
    provider = Column(String(50), default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class ActivityDay(Base):
    """3.0：每天有没有学（用来算连续学习天数和学习日历）"""
    __tablename__ = "activity_days"
    __table_args__ = (UniqueConstraint("user_id", "day", name="uq_user_day"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    day = Column(String(10), nullable=False)          # 北京时间 YYYY-MM-DD
    count = Column(Integer, default=0)


class RoutePlan(Base):
    """3.0：某一天某门课的路线（当天第一次打开时排好，之后只更新完成情况）"""
    __tablename__ = "route_plans"
    __table_args__ = (UniqueConstraint("user_id", "course_id", "day", name="uq_route_day"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    course_id = Column(Integer, nullable=False)
    day = Column(String(10), nullable=False)
    steps = Column(Text, default="[]")                # JSON
    created_at = Column(DateTime, default=datetime.utcnow)
