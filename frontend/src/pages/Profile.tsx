import { useState, useEffect } from "react"
import FeatureToggle from "../components/FeatureToggle"
import {
  getMe, updateMe, changePassword, getUserStats, getUserVocabulary,
  savePreferences, LOGIN_ENABLED, type UserInfo, type UserStats, type VocabWord, type Preferences,
} from "../api"

interface ProfileProps {
  onNavigate: (page: string) => void
  onLogout: () => void
  preferences: Preferences
}

export default function Profile({ onNavigate, onLogout, preferences }: ProfileProps) {
  const [user, setUser] = useState<UserInfo | null>(null)
  const [stats, setStats] = useState<UserStats | null>(null)
  const [words, setWords] = useState<VocabWord[]>([])
  const [loading, setLoading] = useState(true)

  // 功能开关
  const [showEnglish, setShowEnglish] = useState(preferences.show_english)
  const [showPractice, setShowPractice] = useState(preferences.show_practice)
  const [showWrongBook, setShowWrongBook] = useState(preferences.show_wrong_book)

  const handleToggle = async (key: string, val: boolean) => {
    const updated = {
      show_english: key === "english" ? val : showEnglish,
      show_practice: key === "practice" ? val : showPractice,
      show_wrong_book: key === "wrongbook" ? val : showWrongBook,
    }
    if (key === "english") setShowEnglish(val)
    if (key === "practice") setShowPractice(val)
    if (key === "wrongbook") setShowWrongBook(val)
    try { await savePreferences(updated) } catch {}
  }

  // 编辑状态
  const [editing, setEditing] = useState(false)
  const [editGrade, setEditGrade] = useState("")
  const [editMajor, setEditMajor] = useState("")
  const [editSubject, setEditSubject] = useState("")

  // 修改密码
  const [showPassword, setShowPassword] = useState(false)
  const [oldPw, setOldPw] = useState("")
  const [newPw, setNewPw] = useState("")
  const [pwMsg, setPwMsg] = useState("")

  useEffect(() => {
    Promise.all([getMe(), getUserStats(), getUserVocabulary()])
      .then(([u, s, w]) => {
        setUser(u)
        setStats(s)
        setWords(w.words)
        setEditGrade(u.grade || "")
        setEditMajor(u.major || "")
        setEditSubject(u.subject || "")
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSaveProfile = async () => {
    try {
      await updateMe({ grade: editGrade, major: editMajor, subject: editSubject })
      setUser((prev) => prev ? { ...prev, grade: editGrade, major: editMajor, subject: editSubject } : prev)
      setEditing(false)
    } catch {}
  }

  const handleChangePassword = async () => {
    if (!oldPw || !newPw) { setPwMsg("请填写旧密码和新密码"); return }
    if (newPw.length < 6) { setPwMsg("新密码至少6位"); return }
    try {
      await changePassword(oldPw, newPw)
      setPwMsg("✅ 密码修改成功")
      setOldPw(""); setNewPw("")
    } catch (err: any) {
      setPwMsg(err.message || "修改失败")
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* 顶部栏 */}
      <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-4">
        <button onClick={() => onNavigate("study")} className="text-xs text-gray-400 hover:text-gray-600">← 返回</button>
        <h2 className="text-sm font-medium text-gray-800 flex-1">个人中心</h2>
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-8">
        {/* 用户信息卡片 */}
        <div className="p-4 bg-gray-50 rounded-xl mb-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center text-sm text-gray-500">
              {user?.is_anonymous ? "我" : user?.email?.charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-sm font-medium text-gray-800">{user?.is_anonymous ? "本机用户" : user?.email}</p>
              <p className="text-xs text-gray-400">
                {user?.grade || "未设置年级"} · {user?.major || "未设置专业"}
              </p>
            </div>
          </div>

          {editing ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <select value={editGrade} onChange={(e) => setEditGrade(e.target.value)}
                        className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white">
                  <option value="">年级</option>
                  {["大一","大二","大三","大四","研一","研二","研三","其他"].map(g => <option key={g} value={g}>{g}</option>)}
                </select>
                <input value={editMajor} onChange={(e) => setEditMajor(e.target.value)}
                       placeholder="专业" className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded-lg" />
              </div>
              <input value={editSubject} onChange={(e) => setEditSubject(e.target.value)}
                     placeholder="专业课程" className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg" />
              <div className="flex gap-2">
                <button onClick={handleSaveProfile} className="text-xs px-3 py-1 bg-gray-900 text-white rounded-lg">保存</button>
                <button onClick={() => setEditing(false)} className="text-xs px-3 py-1 text-gray-400">取消</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-gray-600">编辑资料</button>
          )}
        </div>

        {/* 学习数据 */}
        {stats && (
          <div className="flex gap-4 mb-6">
            <div className="flex-1 p-3 bg-gray-50 rounded-xl text-center">
              <p className="text-lg font-semibold text-gray-800">{stats.sessions}</p>
              <p className="text-xs text-gray-400">学习次数</p>
            </div>
            <div className="flex-1 p-3 bg-gray-50 rounded-xl text-center">
              <p className="text-lg font-semibold text-gray-800">{stats.accuracy}%</p>
              <p className="text-xs text-gray-400">正确率</p>
            </div>
            <div className="flex-1 p-3 bg-gray-50 rounded-xl text-center">
              <p className="text-lg font-semibold text-gray-800">{stats.favorite_vocab}</p>
              <p className="text-xs text-gray-400">收藏词汇</p>
            </div>
          </div>
        )}

        {/* 快捷入口 */}
        <div className="space-y-1 mb-6">
          <button onClick={() => onNavigate("wrongbook")}
                  className="w-full flex items-center justify-between p-3 hover:bg-gray-50 rounded-xl transition-colors">
            <span className="text-sm text-gray-700">📖 错题本</span>
            <span className="text-xs text-gray-300">{stats?.wrong_count || 0} 道 →</span>
          </button>
          <button onClick={() => onNavigate("vocabularybook")}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-gray-50 transition-colors">
            <span className="text-sm text-gray-700">📚 我的词汇收藏</span>
            <span className="text-xs text-gray-300">{words.length} 词 →</span>
          </button>
        </div>

        {/* 收藏词汇列表 */}
        {words.length > 0 && (
          <div className="mb-6">
            <p className="text-xs text-gray-400 mb-2">收藏的词汇</p>
            <div className="space-y-2">
              {words.map((w) => (
                <div key={w.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                  <div>
                    <span className="text-sm text-gray-800 font-medium">{w.word}</span>
                    <span className="text-xs text-gray-400 ml-2">{w.translation}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 功能开关 */}
        <div className="border-t border-gray-100 pt-6 mb-6">
          <p className="text-xs text-gray-400 mb-3">功能开关</p>
          <div className="space-y-1">
            <FeatureToggle
              label="英语词汇"
              description="学习时展示专业英语词汇"
              enabled={showEnglish}
              onChange={(v) => handleToggle("english", v)}
            />
            <FeatureToggle
              label="练习系统"
              description="每章学完后提供配套练习"
              enabled={showPractice}
              onChange={(v) => handleToggle("practice", v)}
            />
            <FeatureToggle
              label="错题本"
              description="自动收集错题方便复习"
              enabled={showWrongBook}
              onChange={(v) => handleToggle("wrongbook", v)}
            />
          </div>
        </div>

        {/* 修改密码（账号模式才显示） */}
        {LOGIN_ENABLED && !user?.is_anonymous && (
        <div className="border-t border-gray-100 pt-6 mb-6">
          <button onClick={() => setShowPassword(!showPassword)}
                  className="text-sm text-gray-500 hover:text-gray-700">
            {showPassword ? "取消修改密码" : "修改密码"}
          </button>
          {showPassword && (
            <div className="mt-3 space-y-2">
              <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)}
                     placeholder="旧密码" className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg" />
              <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)}
                     placeholder="新密码（至少6位）" className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg" />
              <div className="flex gap-2 items-center">
                <button onClick={handleChangePassword} className="text-xs px-3 py-1 bg-gray-900 text-white rounded-lg">确认修改</button>
                {pwMsg && <span className={`text-xs ${pwMsg.includes("✅") ? "text-green-500" : "text-red-500"}`}>{pwMsg}</span>}
              </div>
            </div>
          )}
        </div>
        )}

        {/* 退出登录 / 匿名模式说明 */}
        {LOGIN_ENABLED ? (
          <button onClick={onLogout}
                  className="w-full py-3 text-sm text-red-400 border border-red-100 rounded-xl hover:bg-red-50 transition-colors">
            退出登录
          </button>
        ) : (
          <div className="border-t border-gray-100 pt-6">
            <p className="text-xs text-gray-400 leading-relaxed mb-3">
              现在不需要注册账号：你的学习记录、错题和收藏保存在这台设备的浏览器里对应的身份下。
              清除浏览器数据或换设备后会变成新的身份。
            </p>
            <button onClick={() => { if (confirm("确定要换一个新身份吗？当前的学习记录、错题和收藏在这个浏览器里将看不到了。")) onLogout() }}
                    className="text-xs text-gray-400 hover:text-red-500 underline">换一个新身份（清空本机记录）</button>
          </div>
        )}
      </div>
    </div>
  )
}
