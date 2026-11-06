import { useState, useEffect, useCallback } from "react"
import Login from "./pages/Login"
import Welcome from "./pages/Welcome"
import Home from "./pages/Home"
import Course, { type CourseTab } from "./pages/Course"
import Study from "./pages/Study"
import Practice from "./pages/Practice"
import WrongBook from "./pages/WrongBook"
import Profile from "./pages/Profile"
import About from "./pages/About"
import VocabularyBook from "./pages/VocabularyBook"
import Review from "./pages/Review"
import Portrait from "./pages/Portrait"
import Shell from "./components/Shell"
import {
  hasToken, clearToken, getMe, ensureIdentity, listCourses, getReviewSummary,
  LOGIN_ENABLED, type Preferences, type CourseSummary,
} from "./api"
import { Toaster } from "./components/Toast"
import ErrorPanel from "./components/ErrorPanel"
import Spinner from "./components/Spinner"

/**
 * 页面结构（2.2）
 *
 * 课程列表 / 新建课程（home）
 *   └ 一门课（course）：资料 · 知识点 · 复习
 *       └ 逐页学习（study，全屏）→ 练习 / 诊断小测（practice，全屏）
 * 侧边栏（手机是底部栏）：新建课程、课程列表、今日复习、错题本、术语、我的
 */
type Page = "login" | "welcome" | "home" | "course" | "study" | "practice" | "wrongbook" | "profile" | "about" | "vocabularybook" | "review" | "portrait"

function readNumber(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

function App() {
  const [page, setPage] = useState<Page>(LOGIN_ENABLED ? "login" : "home")
  const [sessionId, setSessionId] = useState("")
  const [practiceScope, setPracticeScope] = useState("all")
  const [courseId, setCourseId] = useState<number | null>(readNumber("courseId"))
  const [courseTab, setCourseTab] = useState<CourseTab>("route")
  const [creating, setCreating] = useState(false)   // 首页显示「新建课程」表单
  const [courses, setCourses] = useState<CourseSummary[] | null>(null)
  const [reviewDue, setReviewDue] = useState(0)
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [bootError, setBootError] = useState<unknown>(null)
  const [preferences, setPreferences] = useState<Preferences>({
    id: null,
    show_english: true,
    show_practice: true,
    show_wrong_book: true,
  })

  const refreshCourses = useCallback(async () => {
    try {
      const r = await listCourses()
      setCourses(r.courses)
      return r.courses
    } catch {
      setCourses((c) => c ?? [])
      return null
    }
  }, [])

  const refreshDue = useCallback(() => {
    getReviewSummary().then((s) => setReviewDue(s.questions_due + s.words_due)).catch(() => {})
  }, [])

  // 启动：账号模式检查登录；匿名模式（默认）自动获得身份，不需要注册
  const boot = useCallback(async () => {
    setCheckingAuth(true)
    setBootError(null)
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
        await getMe()
        const list = await refreshCourses()
        refreshDue()
        // 上次在看哪门课就回到哪门课；还没有课程就停在首页（新建课程）
        const last = readNumber("courseId")
        if (list && last && list.some((c) => c.id === last)) {
          setCourseId(last); setPage("course")
        } else {
          setPage("home")
        }
      }
    } catch (e) {
      setBootError(e)
    } finally {
      setCheckingAuth(false)
    }
  }, [refreshCourses, refreshDue])

  useEffect(() => { boot() }, [boot])

  useEffect(() => {
    try {
      if (courseId) localStorage.setItem("courseId", String(courseId))
      else localStorage.removeItem("courseId")
    } catch { /* 浏览器不让存也没关系 */ }
  }, [courseId])

  const openCourse = (id: number, tab: CourseTab = "route") => {
    setCourseId(id); setCourseTab(tab); setCreating(false); setPage("course")
    window.scrollTo(0, 0)
  }

  const goHome = (create = false) => {
    setCreating(create); setPage("home")
    window.scrollTo(0, 0)
  }

  /** 旧的跳转写法：onNavigate(页面, 学习记录 id, 练习范围 / 课程标签) */
  const handleNavigate = (target: string, sid?: string, scope?: string) => {
    if (target === "study" && sid) {
      setSessionId(sid); setPage("study")
    } else if (target === "study" || target === "course" || target === "welcome") {
      // 没有指定资料：回到当前课程；没有课程就回首页
      refreshCourses(); refreshDue()
      if (courseId) openCourse(courseId, (scope as CourseTab) || "route")
      else goHome()
      return
    } else if (target === "practice") {
      if (sid) setSessionId(sid)
      setPracticeScope(scope || "all"); setPage("practice")
    } else if (target === "home") {
      refreshCourses(); goHome(); return
    } else {
      if (target === "review") refreshDue()
      setPage(target as Page)
    }
    window.scrollTo(0, 0)
  }

  const handleLogout = () => {
    clearToken()
    try { localStorage.removeItem("courseId") } catch { /* ignore */ }
    setCourseId(null); setCourses(null)
    if (LOGIN_ENABLED) setPage("login")
    else boot()
  }

  if (checkingAuth) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 animate-fade-in">
        <p className="font-serif text-2xl text-gray-800 tracking-[0.3em]">爱学</p>
        <Spinner size={18} />
        <p className="text-xs text-gray-400">正在连接服务器（第一次打开可能要等 30 秒左右）</p>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="w-full max-w-sm"><ErrorPanel error={bootError} actions={{ onRetry: boot }} /></div>
      </div>
    )
  }

  if (page === "login") {
    return <><Login onLogin={() => setPage("welcome")} /><Toaster /></>
  }

  // 全屏页面：逐页学习、练习（专心模式，不显示侧边栏）
  if (page === "study") {
    return (
      <>
        <Study key={sessionId} preferences={preferences} initialSessionId={sessionId} onNavigate={handleNavigate}
               onCourse={(id) => { if (id) setCourseId(id) }} />
        <Toaster />
      </>
    )
  }
  if (page === "practice") {
    return (
      <>
        <Practice key={`${sessionId}:${practiceScope}`} sessionId={sessionId} scope={practiceScope} preferences={preferences}
                  onNavigate={handleNavigate} />
        <Toaster />
      </>
    )
  }

  return (
    <>
      <Shell page={page} courses={courses || []} activeCourseId={page === "course" ? courseId : null} reviewDue={reviewDue}
             onHome={() => goHome(false)} onNewCourse={() => goHome(true)} onOpenCourse={(id) => openCourse(id)}
             onNavigate={(p) => handleNavigate(p)}>
        {page === "welcome" && LOGIN_ENABLED ? (
          <Welcome onStart={(prefs) => { setPreferences(prefs); goHome() }} />
        ) : page === "home" || page === "welcome" ? (
          <Home courses={courses} creating={creating || (courses !== null && courses.length === 0)}
                onCancelCreate={() => setCreating(false)}
                onOpenCourse={(id) => { refreshCourses(); openCourse(id) }}
                onOpenStudy={(cid, sid) => { setCourseId(cid); refreshCourses(); handleNavigate("study", sid) }}
                onNewCourse={() => setCreating(true)} />
        ) : page === "course" && courseId ? (
          <Course key={courseId} courseId={courseId} tab={courseTab} onTab={setCourseTab} courses={courses || []}
                  onNavigate={handleNavigate} onChanged={() => { refreshCourses(); refreshDue() }}
                  onDeleted={() => { setCourseId(null); refreshCourses(); goHome() }}
                  onMissing={() => { setCourseId(null); refreshCourses(); goHome() }} />
        ) : page === "wrongbook" ? (
          <WrongBook onNavigate={handleNavigate} />
        ) : page === "review" ? (
          <Review onNavigate={handleNavigate} />
        ) : page === "profile" ? (
          <Profile onNavigate={handleNavigate} onLogout={handleLogout} preferences={preferences} />
        ) : page === "portrait" ? (
          <Portrait onNavigate={handleNavigate} />
        ) : page === "about" ? (
          <About onNavigate={handleNavigate} />
        ) : page === "vocabularybook" ? (
          <VocabularyBook onNavigate={handleNavigate} />
        ) : null}
      </Shell>
      <Toaster />
    </>
  )
}

export default App
