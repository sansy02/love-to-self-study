/**
 * 外框：电脑上是左侧栏（新建课程 + 课程列表 + 复习/错题/术语/我的），手机上是底部栏（课程 / 复习 / 我的）。
 * 不管在哪一页，入口都在同一个地方。
 */
import type { ReactNode } from "react"
import type { CourseSummary } from "../api"

interface ShellProps {
  page: string
  courses: CourseSummary[]
  activeCourseId: number | null
  reviewDue: number
  onHome: () => void
  onNewCourse: () => void
  onOpenCourse: (id: number) => void
  onNavigate: (page: string) => void
  children: ReactNode
}

function Badge({ n }: { n: number }) {
  if (n <= 0) return null
  return <span className="min-w-4 px-1.5 py-0.5 bg-gray-900 text-white rounded-full text-[10px] leading-none tabular-nums">{n > 99 ? "99+" : n}</span>
}

export default function Shell({ page, courses, activeCourseId, reviewDue, onHome, onNewCourse, onOpenCourse, onNavigate, children }: ShellProps) {
  const navItem = (key: string, label: string, badge = 0) => (
    <button key={key} onClick={() => onNavigate(key)}
            aria-current={page === key ? "page" : undefined}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm
              ${page === key ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:bg-gray-50"}`}>
      <span>{label}</span><Badge n={badge} />
    </button>
  )

  return (
    <div className="min-h-screen md:flex">
      {/* 电脑：左侧栏 */}
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 h-screen sticky top-0 border-r border-gray-100 bg-white">
        <div className="px-4 pt-5 pb-3">
          <button onClick={onHome} className="font-serif text-lg text-gray-900 tracking-[0.3em]">爱学</button>
        </div>
        <div className="px-3">
          <button onClick={onNewCourse}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-800 hover:bg-gray-50">
            <span className="text-gray-500">＋</span>新建课程
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pt-5" aria-label="课程">
          <p className="px-3 text-[11px] text-gray-400 mb-1.5">课程</p>
          {courses.length === 0 && <p className="px-3 text-xs text-gray-400">还没有课程</p>}
          {courses.map((c) => (
            <button key={c.id} onClick={() => onOpenCourse(c.id)}
                    aria-current={activeCourseId === c.id ? "page" : undefined}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm
                      ${activeCourseId === c.id ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:bg-gray-50"}`}>
              <span className="truncate flex-1">{c.name}</span>
              {c.kind === "sample" && <span className="text-[10px] text-gray-400 shrink-0">示例</span>}
              <Badge n={c.due} />
            </button>
          ))}
        </nav>
        <div className="px-3 py-3 border-t border-gray-100 space-y-0.5">
          {navItem("review", "今日复习", reviewDue)}
          {navItem("wrongbook", "错题本")}
          {navItem("vocabularybook", "术语卡片")}
          {navItem("portrait", "学习画像")}
          {navItem("profile", "我的")}
        </div>
      </aside>

      {/* 主体（手机上给底部栏留出位置） */}
      <main className="flex-1 min-w-0 pb-16 md:pb-0">{children}</main>

      {/* 手机：底部栏 */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur-sm border-t border-gray-100 flex"
           style={{ paddingBottom: "env(safe-area-inset-bottom)" }} aria-label="主导航">
        {([
          ["courses", "课程", page === "home" || page === "course", onHome, 0],
          ["review", "复习", page === "review", () => onNavigate("review"), reviewDue],
          ["profile", "我的", ["profile", "wrongbook", "vocabularybook", "about", "portrait"].includes(page), () => onNavigate("profile"), 0],
        ] as const).map(([key, label, active, go, n]) => (
          <button key={key} onClick={go} aria-current={active ? "page" : undefined}
                  className={`flex-1 h-14 flex flex-col items-center justify-center gap-1 text-xs ${active ? "text-gray-900" : "text-gray-400"}`}>
            <span className={`h-0.5 w-6 rounded-full ${active ? "bg-gray-900" : "bg-transparent"}`} />
            <span className="inline-flex items-center gap-1">{label}<Badge n={n} /></span>
          </button>
        ))}
      </nav>
    </div>
  )
}
