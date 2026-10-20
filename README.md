# 📚 爱学助手：打开连接即可使用https://love-to-self-study.vercel.app/

上传 PPT 或输入话题，AI 自动生成教学内容、英语高频词汇和配套练习题。

你是否因为教授口音太重上课听不懂，是否是因为生病了没法去学校，水课不想听，亦或者是我就是不想上这门课但是还得考试怕挂科。

## 项目简介

“爱学”是一款面向大学生的 AI 辅助学习工具。只需上传一份 PPT 课件或输入一个学习话题，系统即可自动生成结构化的教学大纲、逐章详细的讲解内容、章节配套的相应专业英语高频词汇，以及三种题型的智能练习题。2.0 版改成「逐页对照讲解」：翻到哪页讲哪页、每页都能追问，练习题改成英文并批改英文表达，错题和术语按遗忘曲线复习。打开就能用，不需要注册。

## 功能（2.0）

- 📄 **逐页对照讲解**：上传 PPTX / PDF / DOCX，左边是原页面（PDF 显示原页截图），右边是这一页的中文讲解，术语保留英文
- ⚡ **按需生成**：先秒出大纲，翻到哪一页才讲哪一页；同一份课件全站只生成一次，同学之间自动复用、不耗额度
- 💬 **每页追问**：哪里没懂直接问，AI 只围绕这一页回答
- 🇬🇧 **英文练习 + 英文批改**：题目和真实考试一样是英文，简答题按得分点打分，并帮你改英文表达
- 🔁 **间隔复习**：错题和收藏的术语按 1、2、4、7、15、30 天自动安排复习
- 🆓 **免费模型**：Gemini（主力，能看图）→ 智谱 GLM（备用），出错自动切换；也可以填自己的 DeepSeek / Gemini Key 不限次数
- 🔓 **不用注册**：打开就能用（账号密码功能已下线，代码保留，可随时重新开放）

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS |
| 后端 | Python FastAPI |
| 数据库 | SQLite（本地）/ PostgreSQL（线上） |
| AI | Gemini / 智谱 GLM / DeepSeek（OpenAI 兼容接口，自动切换） |

## 本地运行

### 1. 后端
```bash
cd backend
python -m venv venv
source venv/Scripts/activate  # Windows
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

### 2. 前端
```bash
cd frontend
npm install
npm run dev
```

### 3. 配置环境变量

对照 `backend/env.example` 设置（本地可以复制成 `backend/.env`；Render 上在 Environment 页面逐条填）：

| 变量 | 说明 |
|------|------|
| `JWT_SECRET` | **必填**，至少 32 位随机字符 |
| `GEMINI_API_KEY` | 免费主力模型（Google AI Studio 申请） |
| `GLM_API_KEY` | 免费备用模型（智谱开放平台申请） |
| `AUTH_MODE` | 默认 `anonymous`（不用注册）；改成 `account` 或 `both` 可重新开放账号登录 |
| `FREE_DAILY_LIMIT` | 每人每天免费生成次数，默认 60（已缓存内容不计次） |

前端（Vercel）想重新开放登录页时，设置 `VITE_ENABLE_LOGIN=true`。

### 4. 运行测试

```bash
cd backend
python -m unittest discover -s tests -v
```

## 项目结构

```
├── frontend/          # React 前端
│   └── src/
│       ├── pages/     # 页面组件
│       ├── components/# 通用组件
│       └── api/       # API 封装
├── backend/           # Python 后端
│   ├── routers/       # API 路由（study 逐页学习 / practice 练习 / review 复习 / auth 身份）
│   ├── services/      # 业务逻辑（AI 模型链、逐页解析、批改与间隔复习）
│   ├── tests/         # 自动化测试
│   ├── models/        # 数据模型
│   └── middleware/     # 中间件（限流、认证）
└── .gitignore
```

碎碎念：
本网页的不足在于每日只有五次免费次数（因为我是内置了一个ai的api，使用需要花钱），当然您可以自行添加自己的api以至于无限使用，后期我会想平衡一下这个付费和免费的使用体验。
2.0想加入很多小功能增添学习的动力，但还是很需要你们的想法与支持。后期会上架app store。
