import { useState, useEffect } from "react"
import SelectInput from "../components/SelectInput"
import { updateMe, getMe, type Preferences } from "../api"

interface WelcomeProps {
  onStart: (prefs: Preferences) => void
}

const GRADE_OPTIONS = ["大一", "大二", "大三", "大四", "研一", "研二", "研三", "其他"]
const MAJOR_OPTIONS = [
  "计算机科学与技术", "软件工程", "人工智能", "数据科学",
  "电子信息工程", "通信工程", "自动化", "电气工程",
  "金融学", "经济学", "会计学", "工商管理",
  "法学", "英语", "汉语言文学", "新闻传播",
  "临床医学", "药学", "生物科学", "化学",
  "数学与应用数学", "物理学", "统计学",
  "土木工程", "机械工程", "材料科学",
  "心理学", "教育学", "社会学",
  "其他",
]
const SUBJECT_OPTIONS = [
  "编程/算法", "人工智能/机器学习", "数据结构", "操作系统",
  "高等数学", "线性代数", "概率论",
  "英语四六级", "考研英语", "托福/雅思",
  "微观经济学", "宏观经济学", "管理学",
  "大学物理", "化学基础", "生物化学",
  "考研政治", "法律基础",
  "其他",
]

export default function Welcome({ onStart }: WelcomeProps) {
  const [grade, setGrade] = useState("")
  const [major, setMajor] = useState("")
  const [subject, setSubject] = useState("")

  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)

  // 加载上次保存的设置
  useEffect(() => {
    getMe()
      .then((user) => {
        if (user) {
          setGrade(user.grade || "")
          setMajor(user.major || "")
          setSubject(user.subject || "")
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // 点击开始学习
  const handleStart = async () => {
    setStarting(true)
    const prefs: Preferences = {
      id: null,
      show_english: true,
      show_practice: true,
      show_wrong_book: true,
    }

    try {
      await updateMe({ grade, major, subject })
    } catch {
      // 保存失败也继续
    }

    onStart(prefs)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        {/* 标题区 */}
        <div className="text-center mb-10">
          <div className="text-5xl mb-4">📚</div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            欢迎访问爱学助手
          </h1>
          <p className="text-sm text-gray-400 leading-relaxed">
            上传 PPT 或输入话题，AI 自动生成
            <br />
            教学内容、英语词汇、练习题
          </p>
        </div>

        {/* 个人信息区 */}
        <div className="mb-8">
          <p className="text-xs text-gray-400 mb-3 text-center">
            我是谁？（让 AI 更懂你）
          </p>
          <div className="space-y-3">
            <SelectInput
              label="年级"
              value={grade}
              options={GRADE_OPTIONS}
              placeholder="选择或输入年级"
              onChange={setGrade}
            />
            <SelectInput
              label="专业"
              value={major}
              options={MAJOR_OPTIONS}
              placeholder="选择或输入专业"
              onChange={setMajor}
            />
            <SelectInput
              label="专业课程"
              value={subject}
              options={SUBJECT_OPTIONS}
              placeholder="今天想学什么方向？"
              onChange={setSubject}
            />
          </div>
        </div>

        {/* 分割线 */}
        <div className="border-t border-gray-100 mb-6" />

        {/* 开始按钮 */}
        <button
          onClick={handleStart}
          disabled={starting}
          className="w-full py-3 bg-gray-900 text-white text-sm font-medium rounded-xl
                     hover:bg-gray-800 active:bg-gray-950 transition-colors disabled:opacity-70"
        >
          {starting ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              正在加载...
            </span>
          ) : (
            "开始学习 →"
          )}
        </button>

        <p className="text-center text-xs text-gray-400 mt-8">
          由 <span className="text-gray-400 font-medium">sansy02</span> 开发
        </p>
      </div>
    </div>
  )
}
