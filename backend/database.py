"""
数据库连接和会话管理
"""
import os

import config  # noqa: F401  先加载 .env
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./aixue.db")
# Render 等平台给的地址可能是 postgres://，SQLAlchemy 需要 postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

IS_POSTGRES = DATABASE_URL.startswith("postgresql")

if IS_POSTGRES:
    engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args={
        "connect_timeout": 10,
        "sslmode": os.getenv("DB_SSLMODE", "require"),
    })
else:
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _sqlite_foreign_keys(dbapi_conn, _record):
        """SQLite 默认不检查外键。打开它，本地和测试才会像线上 Postgres 一样，在写入顺序错误时报错。"""
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """获取数据库会话（依赖注入用）"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# 老数据库里缺少的列：启动时自动补上（新建的表由 create_all 负责）
# 格式：表名 -> {列名: (SQLite 类型, PostgreSQL 类型)}
_NEW_COLUMNS = {
    "users": {
        "api_key": ("VARCHAR(200)", "VARCHAR(200)"),
        "api_key_enc": ("TEXT", "TEXT"),
        "is_anonymous": ("BOOLEAN DEFAULT 0", "BOOLEAN DEFAULT false"),
        "recovery_hash": ("VARCHAR(64)", "VARCHAR(64)"),
        "recovery_created_at": ("DATETIME", "TIMESTAMP"),
        "learn_profile": ("TEXT DEFAULT ''", "TEXT DEFAULT ''"),
    },
    "study_sessions": {
        "document_id": ("VARCHAR(32)", "VARCHAR(32)"),
        "progress": ("TEXT DEFAULT ''", "TEXT DEFAULT ''"),
        "updated_at": ("DATETIME", "TIMESTAMP"),
        "course_id": ("INTEGER", "INTEGER"),
        "material_type": ("VARCHAR(20) DEFAULT 'lecture'", "VARCHAR(20) DEFAULT 'lecture'"),
        "week": ("INTEGER", "INTEGER"),
    },
    "exercises": {
        "key_points": ("TEXT DEFAULT ''", "TEXT DEFAULT ''"),
        "page_no": ("INTEGER", "INTEGER"),
        "scope": ("VARCHAR(50) DEFAULT 'all'", "VARCHAR(50) DEFAULT 'all'"),
        "batch": ("VARCHAR(36) DEFAULT ''", "VARCHAR(36) DEFAULT ''"),
        "answered": ("BOOLEAN DEFAULT 0", "BOOLEAN DEFAULT false"),
        "lang": ("VARCHAR(10) DEFAULT 'zh'", "VARCHAR(10) DEFAULT 'zh'"),
        "user_id": ("INTEGER", "INTEGER"),
        "kp_ids": ("TEXT DEFAULT ''", "TEXT DEFAULT ''"),
        "source_label": ("VARCHAR(200) DEFAULT ''", "VARCHAR(200) DEFAULT ''"),
        "marks": ("INTEGER", "INTEGER"),
    },
    "wrong_book": {
        "feedback": ("TEXT DEFAULT ''", "TEXT DEFAULT ''"),
        "box": ("INTEGER DEFAULT 0", "INTEGER DEFAULT 0"),
        "next_review_at": ("DATETIME", "TIMESTAMP"),
        "review_count": ("INTEGER DEFAULT 0", "INTEGER DEFAULT 0"),
        "mastered": ("BOOLEAN DEFAULT 0", "BOOLEAN DEFAULT false"),
        "last_reviewed_at": ("DATETIME", "TIMESTAMP"),
    },
}


def _add_missing_columns():
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    with engine.begin() as conn:
        for table, cols in _NEW_COLUMNS.items():
            if table not in existing_tables:
                continue
            have = {c["name"] for c in insp.get_columns(table)}
            for name, (sqlite_type, pg_type) in cols.items():
                if name in have:
                    continue
                col_type = pg_type if IS_POSTGRES else sqlite_type
                conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {name} {col_type}'))


def init_db():
    """初始化数据库，创建所有表 + 补齐新增的列"""
    import models.models  # noqa: F401  确保所有模型已注册
    Base.metadata.create_all(bind=engine)
    _add_missing_columns()
