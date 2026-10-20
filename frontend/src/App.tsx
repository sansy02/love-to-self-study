import { useState, useEffect, useCallback } from "react"
import Login from "./pages/Login"
import Welcome from "./pages/Welcome"
import Study from "./pages/Study"
import Practice from "./pages/Practice"
import WrongBook from "./pages/WrongBook"
import Profile from "./pages/Profile"
import About from "./pages/About"
import VocabularyBook from "./pages/VocabularyBook"
import Review from "./pages/Review"
import { hasToken, clearToken, getMe, ensureIdentity, LOGIN_ENABLED, type Preferences } from "./api"

type Page = "login" | "welcome" | "study" | "practice" | "wrongbook" | "profile" | "about" | "vocabularybook" | "review"

function App() {
  const [page, setPage] = useState<Page>(LOGIN_ENABLED ? "login" : "study")
  const [sessionId, setSessionId] = useState(localStorage.getItem("sessionId") || "")
  const [practiceScope, setPracticeScope] = useState("all")
  // 进入学习页时要直接打开的学习记录（空 = 显示上传页）
  const [studyTarget, setStudyTarget] = useState("")
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [bootError, setBootError] = useState("")
  const [preferences, setPreferences] = useState<Preferences>({
    id: null,
    show_english: true,
    show_practice: true,
    show_wrong_book: true,
  })

  // 启动：账号模式检查登录；匿名模式（默认）自动获得身份，不需要注册
  const boot = useCallback(async () => {
    setCheckingAuth(true)
    setBootError("")
    try {
      if (LOGIN_ENABLED) {
        if (hasToken()) {
          try {
            await getMe()
            setPage("welcome")
          } catch {
            clearToken()
            setPage("login")
          }
        }
      } else {
        await ensureIdentity()
        const me = await getMe()
        // 第一次使用先填一下年级专业，之后直接进入学习
        setPage(me.grade || me.major ? "study" : "welcome")
      }
    } catch (e: any) {
      setBootError(e?.message || "无法连接服务器")
    } finally {
      setCheckingAuth(false)
    }
  }, [])

  useEffect(() => { boot() }, [boot])

  // 持久化 sessionId
  useEffect(() => {
    if (sessionId) localStorage.setItem("sessionId", sessionId)
  }, [sessionId])

  const handleLogin = () => {
    setPage("welcome")
  }

  const handleStart = (prefs: Preferences) => {
    setPreferences(prefs)
    setStudyTarget("")
    setPage("study")
  }

  const handleNavigate = (target: string, sid?: string, scope?: string) => {
    if (sid) {
      setSessionId(sid)
      localStorage.setItem("sessionId", sid)
    }
    if (target === "practice") setPracticeScope(scope || "all")
    if (target === "study") setStudyTarget(sid || "")
    setPage(target as Page)
    window.scrollTo(0, 0)
  }

  const handleLogout = () => {
    clearToken()
    localStorage.removeItem("sessionId")
    setSessionId("")
    if (LOGIN_ENABLED) {
      setPage("login")
    } else {
      boot()
    }
  }

  if (checkingAuth) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
        <p className="text-xs text-gray-300">正在连接服务器（第一次打开可能要等 30 秒左右）</p>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-gray-600">{bootError}</p>
        <button onClick={boot} className="text-sm px-4 py-2 bg-gray-900 text-white rounded-lg">重试</button>
      </div>
    )
  }

  if (page === "login") {
    return <Login onLogin={handleLogin} />
  }

  // 欢迎页的导航栏
  const NavBar = () => (
    <div className="border-b border-gray-100 px-4 py-2.5 flex items-center gap-3 bg-white">
      <span className="text-sm font-medium text-gray-800">📚 爱学</span>
      <button onClick={() => setPage("about")} className="text-xs text-gray-400 hover:text-gray-600">关于我</button>
      <div className="flex-1" />
      <button onClick={() => handleNavigate("review")} className="text-xs text-gray-400 hover:text-gray-600">今日复习</button>
      <button onClick={() => handleNavigate("wrongbook")} className="text-xs text-gray-400 hover:text-gray-600">错题本</button>
      <button onClick={() => handleNavigate("vocabularybook")} className="text-xs text-gray-400 hover:text-gray-600">术语</button>
      <button onClick={() => setPage("profile")} className="text-xs text-gray-400 hover:text-gray-600">个人中心</button>
    </div>
  )

  switch (page) {
    case "welcome":
      return (
        <>
          <NavBar />
          <Welcome onStart={handleStart} />
        </>
      )
    case "study":
      return <Study key={studyTarget || "new"} preferences={preferences} initialSessionId={studyTarget} onNavigate={handleNavigate} />
    case "practice":
      return <Practice sessionId={sessionId} scope={practiceScope} preferences={preferences} onNavigate={handleNavigate} />
    case "wrongbook":
      return <WrongBook onNavigate={handleNavigate} />
    case "review":
      return <Review onNavigate={handleNavigate} />
    case "profile":
      return <Profile onNavigate={handleNavigate} onLogout={handleLogout} preferences={preferences} />
    case "about":
      return <About onNavigate={handleNavigate} />
    case "vocabularybook":
      return <VocabularyBook onNavigate={handleNavigate} />
    default:
      return null
  }
}

export default App
