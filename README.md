# 📚 爱学助手：打开连接即可使用https://love-to-self-study.vercel.app/

上传 PPT 或输入话题，AI 自动生成教学内容、英语高频词汇和配套练习题。

你是否因为教授口音太重上课听不懂，是否是因为生病了没法去学校，水课不想听，亦或者是我就是不想上这门课但是还得考试怕挂科。

## 项目简介

“爱学”是一款面向大学生的 AI 辅助学习工具。只需上传一份 PPT 课件或输入一个学习话题，系统即可自动生成结构化的教学大纲、逐章详细的讲解内容、章节配套的相应专业英语高频词汇，以及三种题型的智能练习题。做完题目后 AI 自动批改并生成解析，错题自动收入错题本方便复习。支持邮箱注册登录，个人信息用于定制教学深度，英语词汇和练习模块可按需开关。

## 功能

- 🎯 **AI 生成教学内容**：输入话题或上传 PPTX/PDF，自动生成结构化教学大纲和详细讲解
- 🇬🇧 **英语高频词汇**：自动提取专业术语，附带翻译和例句，可一键关闭
- 📝 **智能练习题**：选择题 + 填空题 + 简答题，AI 自动批改
- 📖 **错题本**：自动收集错题，随时回顾
- 👤 **个人中心**：学习统计、词汇收藏、个性化设置

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| 后端 | Python FastAPI |
| 数据库 | SQLite |
| AI | DeepSeek API（兼容 OpenAI） |

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

### 3. 配置 API Key
每日免费使用五次（作者真的没米负担那么多token量了）

免费次数结束后再次使用需要在后端设置 API Key：
这里留一个市面上最便宜的api ai界面，10元大概可以供自己使用500次
- 注册 https://platform.deepseek.com 获取 Key
- 程序首次启动后，通过 `/api/settings/api-key` 接口设置，Key 自动持久化到数据库

## 项目结构

```
├── frontend/          # React 前端
│   └── src/
│       ├── pages/     # 页面组件
│       ├── components/# 通用组件
│       └── api/       # API 封装
├── backend/           # Python 后端
│   ├── routers/       # API 路由
│   ├── services/      # 业务逻辑（AI、文件解析）
│   ├── models/        # 数据模型
│   └── middleware/     # 中间件（限流、认证）
└── .gitignore
```

碎碎念：
本网页的不足在于每日只有五次免费次数（因为我是内置了一个ai的api，使用需要花钱），当然您可以自行添加自己的api以至于无限使用，后期我会想平衡一下这个付费和免费的使用体验。
2.0想加入很多小功能增添学习的动力，但还是很需要你们的想法与支持。后期会上架app store。
