"""
集中读取环境变量。所有可配置项都在这里，部署时对照 .env.example 设置。
"""
import os


def _load_dotenv():
    """本地开发：如果 backend/.env 存在就读进来（不覆盖已有的环境变量）。部署平台上直接配环境变量即可。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and v and k not in os.environ:
                os.environ[k] = v


_load_dotenv()


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


# ---- 登录模式 ----
# anonymous：默认。不需要注册，浏览器自动获得一个匿名身份（账号密码功能下线但代码保留）
# account：只允许邮箱账号登录（旧模式）
# both：两种都可以
AUTH_MODE = os.getenv("AUTH_MODE", "anonymous").strip().lower()
if AUTH_MODE not in ("anonymous", "account", "both"):
    AUTH_MODE = "anonymous"

ANONYMOUS_ENABLED = AUTH_MODE in ("anonymous", "both")
ACCOUNT_ENABLED = AUTH_MODE in ("account", "both")

# ---- 免费额度 ----
# 每个用户每天可用的「新生成」AI 次数（命中缓存不计次；自带 Key 不受限）
FREE_DAILY_LIMIT = _int("FREE_DAILY_LIMIT", 60)
# 同一 IP 每天的上限，防止有人清空浏览器反复领取匿名额度
FREE_DAILY_LIMIT_PER_IP = _int("FREE_DAILY_LIMIT_PER_IP", 200)

# ---- 上传限制 ----
MAX_FILE_SIZE = _int("MAX_FILE_MB", 20) * 1024 * 1024
MAX_PAGES = _int("MAX_PAGES", 150)
PAGE_IMAGE_WIDTH = _int("PAGE_IMAGE_WIDTH", 1100)
