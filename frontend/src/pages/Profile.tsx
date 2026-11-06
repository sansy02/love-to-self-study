import { useState, useEffect } from "react"
import FeatureToggle from "../components/FeatureToggle"
import Spinner from "../components/Spinner"
import KeyForm from "../components/KeyForm"
import ProfileQuiz from "../components/ProfileQuiz"
import { toast } from "../components/Toast"
import {
  getMe, updateMe, changePassword, getUserStats, getUserVocabulary,
  savePreferences, getRecoveryStatus, createRecoveryCode, toApiError, getQuota, checkApiKeyStatus, deleteApiKey,
  type QuotaInfo,
  LOGIN_ENABLED, type UserInfo, type UserStats, type VocabWord, type Preferences,
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
    try { await savePreferences(updated) } catch { toast("设置没保存成功", "error") }
  }

  // 找回码
  const [hasCode, setHasCode] = useState(false)
  const [code, setCode] = useState("")
  const [making, setMaking] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getRecoveryStatus().then((s) => setHasCode(s.has_code)).catch(() => {})
  }, [])

  // AI 次数和自己的 Key
  const [quota, setQuota] = useState<QuotaInfo | null>(null)
  const [keyMasked, setKeyMasked] = useState("")
  const [keyProvider, setKeyProvider] = useState("")
  const [changingKey, setChangingKey] = useState(false)
  const loadKey = () => {
    getQuota().then(setQuota).catch(() => {})
    checkApiKeyStatus().then((s) => { setKeyMasked(s.source === "user" ? s.masked : ""); setKeyProvider(s.user_provider || "") }).catch(() => {})
  }
  useEffect(loadKey, [])
  const removeKey = async () => {
    try { await deleteApiKey(); toast("已删除你的 Key", "success"); loadKey() } catch { toast("删除失败，请重试", "error") }
  }

  const handleMakeCode = async () => {
    if (making) return
    if (hasCode && !confirm("生成新的找回码后，旧的找回码会立即失效。继续吗？")) return
    setMaking(true)
    try {
      const r = await createRecoveryCode()
      setCode(r.code); setHasCode(true)
    } catch (e) {
      toast(toApiError(e).message, "error")
    } finally { setMaking(false) }
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      toast("已复制找回码", "success")
    } catch { toast("复制失败，请手动抄下来", "error") }
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
    if (saving) return
    setSaving(true)
    try {
      await updateMe({ grade: editGrade, major: editMajor, subject: editSubject })
      setUser((prev) => prev ? { ...prev, grade: editGrade, major: editMajor, subject: editSubject } : prev)
      setEditing(false)
      toast("资料已保存", "success")
    } catch (e) { toast(toApiError(e).message, "error") } finally { setSaving(false) }
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
      <div className="min-h-screen flex items-center justify-center"><Spinner size={20} /></div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶部栏 */}
      <div className="max-w-2xl mx-auto w-full px-4 pt-6 md:pt-10 flex items-center gap-4">
        <h1 className="font-serif text-2xl text-gray-900 tracking-wide flex-1">我的</h1>
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-8">
        {/* 用户信息卡片 */}
        <div className="p-4 bg-gray-50 border border-gray-100 rounded-2xl mb-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-white border border-gray-200 rounded-full flex items-center justify-center font-serif text-sm text-gray-600">
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
                <button onClick={handleSaveProfile} disabled={saving} className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-lg disabled:opacity-60 inline-flex items-center gap-1.5">{saving && <Spinner size={11} light />}保存</button>
                <button onClick={() => setEditing(false)} className="text-xs px-3 py-1 text-gray-400">取消</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setEditing(true)} className="text-xs text-gray-500 hover:text-gray-800">
              {user?.grade || user?.major ? "编辑资料" : "填一下年级和专业（出题会更贴近你的课程）"}
            </button>
          )}
        </div>

        {/* 学习数据 */}
        {stats && (
          <div className="flex gap-4 mb-6">
            <div className="flex-1 p-3 bg-gray-50 border border-gray-100 rounded-xl text-center">
              <p className="font-serif text-xl text-gray-800 tabular-nums">{stats.sessions}</p>
              <p className="text-xs text-gray-400">学习次数</p>
            </div>
            <div className="flex-1 p-3 bg-gray-50 border border-gray-100 rounded-xl text-center">
              <p className="font-serif text-xl text-gray-800 tabular-nums">{stats.accuracy}%</p>
              <p className="text-xs text-gray-400">正确率</p>
            </div>
            <div className="flex-1 p-3 bg-gray-50 border border-gray-100 rounded-xl text-center">
              <p className="font-serif text-xl text-gray-800 tabular-nums">{stats.favorite_vocab}</p>
              <p className="text-xs text-gray-400">收藏词汇</p>
            </div>
          </div>
        )}

        {/* 快捷入口 */}
        <div className="space-y-1 mb-6">
          <button onClick={() => onNavigate("wrongbook")}
                  className="w-full flex items-center justify-between p-3 hover:bg-gray-50 rounded-xl transition-colors">
            <span className="text-sm text-gray-700">错题本</span>
            <span className="text-xs text-gray-400">{stats?.wrong_count || 0} 道 →</span>
          </button>
          <button onClick={() => onNavigate("about")}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-gray-50 transition-colors md:hidden">
            <span className="text-sm text-gray-700">关于爱学</span>
            <span className="text-xs text-gray-400">→</span>
          </button>
          <button onClick={() => onNavigate("vocabularybook")}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-gray-50 transition-colors">
            <span className="text-sm text-gray-700">收藏的术语</span>
            <span className="text-xs text-gray-400">{words.length} 词 →</span>
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

        {/* 3.0 我的学习方式 */}
        <div className="border-t border-gray-100 pt-6 mb-6">
          <div className="flex items-baseline justify-between mb-1">
            <p className="text-sm text-gray-800">我的学习方式</p>
            <button onClick={() => onNavigate("portrait")} className="text-xs text-gray-500 hover:text-gray-800">看学习画像 →</button>
          </div>
          <p className="text-xs text-gray-500 leading-relaxed mb-4">讲解怎么写、每天的路线怎么排，都按这里的回答来。改了以后，新打开的页面和今天的路线会马上换成新的方式。</p>
          <ProfileQuiz />
        </div>

        {/* AI 次数和自己的 Key */}
        <div className="border-t border-gray-100 pt-6 mb-6">
          <p className="text-sm text-gray-800 mb-1">AI 次数</p>
          {quota?.own_key ? (
            <p className="text-xs text-gray-500 mb-3">正在使用你自己的 {keyProvider} Key（{keyMasked}），不限次数</p>
          ) : quota ? (
            <>
              <div className="flex items-baseline justify-between">
                <p className="text-xs text-gray-500">今天的免费次数</p>
                <p className="text-xs text-gray-700 tabular-nums">剩余 {quota.remaining} / {quota.limit}</p>
              </div>
              <div className="h-1 rounded-full bg-gray-100 mt-2 overflow-hidden">
                <div className="h-full bg-gray-500 rounded-full" style={{ width: `${quota.limit ? (quota.remaining / quota.limit) * 100 : 0}%` }} />
              </div>
              <p className="text-xs text-gray-400 mt-2 mb-3 leading-relaxed">翻到没讲过的页、追问、出题、批改才计次；同学生成过的讲解和示例课程不计次。北京时间 0 点重置。</p>
            </>
          ) : <div className="h-8 bg-gray-50 rounded animate-pulse mb-3" />}
          {keyMasked && !changingKey ? (
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500 flex-1">已保存你的 Key：{keyMasked}（加密存储）</span>
              <button onClick={() => setChangingKey(true)} className="text-xs text-gray-500 hover:text-gray-800">更换</button>
              <button onClick={removeKey} className="text-xs text-red-500 hover:text-red-600">删除</button>
            </div>
          ) : (
            <KeyForm onCancel={keyMasked ? () => setChangingKey(false) : undefined}
                     onSaved={() => { setChangingKey(false); loadKey() }} />
          )}
        </div>

        {/* 换设备继续学习 */}
        {!LOGIN_ENABLED && (
          <div className="border-t border-gray-100 pt-6 mb-6">
            <p className="text-sm text-gray-800 mb-1">换设备继续学习</p>
            <p className="text-xs text-gray-500 leading-relaxed mb-3">
              不需要注册。生成一个找回码，在新手机或新电脑的首页点「换了设备？用找回码继续之前的学习」输入它，就能看到同样的课件、错题和收藏。
            </p>
            {code ? (
              <div className="p-4 rounded-xl border border-gray-200 bg-white animate-fade-in">
                <p className="font-mono text-lg tracking-[0.15em] text-gray-900 text-center select-all">{code}</p>
                <p className="text-[11px] text-gray-500 text-center mt-2">只显示这一次，请抄下来或截图保存。不要发给别人：拿到它的人能看到你的学习记录。</p>
                <div className="flex justify-center gap-3 mt-3">
                  <button onClick={copyCode} className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-lg">复制</button>
                  <button onClick={() => setCode("")} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600">我已保存</button>
                </div>
              </div>
            ) : (
              <button onClick={handleMakeCode} disabled={making}
                      className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-60 inline-flex items-center gap-1.5">
                {making && <Spinner size={11} />}{hasCode ? "重新生成找回码（旧的会失效）" : "生成找回码"}
              </button>
            )}
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
              清除浏览器数据前，先生成一个找回码，就不会丢。
            </p>
            <button onClick={() => { if (confirm("确定要换一个新身份吗？当前的学习记录、错题和收藏在这个浏览器里将看不到了。")) onLogout() }}
                    className="text-xs text-gray-400 hover:text-red-500 underline">换一个新身份（清空本机记录）</button>
          </div>
        )}
      </div>
    </div>
  )
}
