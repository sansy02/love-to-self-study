import { useState, useRef, useEffect } from "react"
import { createCourse, openSampleCourse, recoverWithCode, toApiError, type CourseSummary } from "../api"
import Spinner from "../components/Spinner"
import ErrorPanel from "../components/ErrorPanel"
import { toast } from "../components/Toast"

interface HomeProps {
  courses: CourseSummary[] | null
  creating: boolean
  onCancelCreate: () => void
  onOpenCourse: (id: number) => void
  onOpenStudy: (courseId: number, sessionId: string) => void
  onNewCourse: () => void
}

const STEPS = [
  { n: "一", title: "新建一门课", text: "一门课放一个学期的资料，比如 BIC3133。" },
  { n: "二", title: "把资料放进来", text: "老师课件、Tutorial、往年考试题都可以，按周排好。" },
  { n: "三", title: "逐页学，学完做诊断", text: "每页先看一句话总结；学完做 5 道题，第二天复习错的。" },
]

export function daysUntil(date: string): number | null {
  if (!date) return null
  const t = new Date(date + "T00:00:00").getTime()
  if (Number.isNaN(t)) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((t - today.getTime()) / 86400000)
}

export function examText(date: string): string {
  const d = daysUntil(date)
  if (d === null) return ""
  if (d > 0) return `距离考试 ${d} 天`
  if (d === 0) return "今天考试"
  return "考试已结束"
}

export default function Home({ courses, creating, onCancelCreate, onOpenCourse, onOpenStudy, onNewCourse }: HomeProps) {
  const [name, setName] = useState("")
  const [examDate, setExamDate] = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  const [opening, setOpening] = useState(false)
  const [showRecover, setShowRecover] = useState(false)
  const [code, setCode] = useState("")
  const [recovering, setRecovering] = useState(false)
  const [recoverErr, setRecoverErr] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const isNew = courses !== null && courses.length === 0

  useEffect(() => { if (creating) inputRef.current?.focus() }, [creating])

  const create = async () => {
    if (!name.trim() || saving) return
    setSaving(true); setErr(null)
    try {
      const c = await createCourse(name.trim(), examDate)
      toast(`已创建「${c.name}」，现在把资料放进来`, "success")
      setName(""); setExamDate("")
      onOpenCourse(c.id)
    } catch (e) { setErr(e) } finally { setSaving(false) }
  }

  const openSample = async () => {
    if (opening) return
    setOpening(true); setErr(null)
    try {
      const r = await openSampleCourse()
      onOpenStudy(r.course.id, r.session_id)
    } catch (e) { setErr(e); setOpening(false) }
  }

  const recover = async () => {
    if (!code.trim() || recovering) return
    setRecovering(true); setRecoverErr("")
    try {
      await recoverWithCode(code.trim())
      toast("找回成功，正在打开你的学习记录…", "success")
      setTimeout(() => window.location.reload(), 600)
    } catch (e) {
      setRecoverErr(toApiError(e).message); setRecovering(false)
    }
  }

  if (courses === null) {
    return <div className="min-h-screen flex items-center justify-center"><Spinner size={20} /></div>
  }

  // ---------------- 新建课程（新同学进来的第一步）
  if (creating) {
    return (
      <div className="max-w-xl mx-auto px-4 pt-14 md:pt-24 pb-16 animate-fade-in">
        {isNew && <p className="font-serif text-sm text-gray-400 tracking-[0.3em] text-center mb-6 md:hidden">爱学</p>}
        <h1 className="font-serif text-2xl md:text-[28px] text-gray-900 text-center mb-3 tracking-wide">
          {isNew ? "先建一门课" : "新建一门课"}
        </h1>
        <p className="text-sm text-gray-500 text-center leading-relaxed mb-8">
          一门课放这学期的所有资料：老师课件、Tutorial、往年考试题。<br className="hidden sm:inline" />
          爱学会把它们整理在一起，逐页讲给你听。
        </p>

        <div className="p-5 rounded-2xl border border-gray-200 bg-white">
          <label className="block text-xs text-gray-500 mb-1.5" htmlFor="course-name">课程名</label>
          <input id="course-name" ref={inputRef} value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) create() }}
                 placeholder="例如 BIC3133 Object Oriented Methods" maxLength={120}
                 className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none bg-white" />
          <label className="block text-xs text-gray-500 mt-4 mb-1.5" htmlFor="exam-date">考试日期（可以不填，填了会显示倒计时）</label>
          <input id="exam-date" type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)}
                 className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl outline-none bg-white text-gray-700" />
          <button onClick={create} disabled={!name.trim() || saving}
                  className="w-full mt-5 py-3 text-sm rounded-xl bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40 inline-flex items-center justify-center gap-2">
            {saving && <Spinner size={14} light />}创建课程
          </button>
          {!isNew && <button onClick={onCancelCreate} className="w-full mt-2 py-2 text-xs text-gray-500 hover:text-gray-800">取消</button>}
        </div>

        {!!err && <div className="mt-4"><ErrorPanel error={err} actions={{ onRetry: create }} /></div>}

        {isNew && (
          <>
            <div className="text-center mt-6">
              <button onClick={openSample} disabled={opening}
                      className="text-sm text-gray-600 hover:text-gray-900 underline underline-offset-4 decoration-gray-300 inline-flex items-center gap-1.5">
                {opening && <Spinner size={12} />}还没有资料？先看示例课程（不耗次数）
              </button>
            </div>

            <ol className="grid sm:grid-cols-3 gap-3 mt-12">
              {STEPS.map((s) => (
                <li key={s.n} className="p-4 rounded-2xl border border-gray-100 bg-white">
                  <p className="font-serif text-gray-400 text-sm mb-1.5">{s.n}</p>
                  <p className="text-sm text-gray-900 mb-1">{s.title}</p>
                  <p className="text-xs text-gray-500 leading-relaxed">{s.text}</p>
                </li>
              ))}
            </ol>
            <figure className="rounded-2xl border border-gray-100 bg-gray-50 p-2 mt-3">
              <img src="/onboarding-reader.png" alt="学习页：左边是原课件，右边是一句话总结和中文讲解" loading="lazy"
                   className="w-full rounded-xl border border-gray-100 bg-white" />
              <figcaption className="text-[11px] text-gray-400 text-center mt-2 mb-1">学习页：左边原课件，右边先看一句话总结，再看讲解</figcaption>
            </figure>

            <div className="mt-10 text-center">
              {showRecover ? (
                <div className="max-w-sm mx-auto text-left p-4 border border-gray-100 rounded-2xl bg-white animate-fade-in">
                  <p className="text-xs text-gray-600 mb-2">输入在旧设备「我的 → 换设备继续学习」里生成的找回码</p>
                  <div className="flex gap-2">
                    <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") recover() }}
                           placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false}
                           className="flex-1 min-w-0 px-3 py-2 text-sm font-mono tracking-wider border border-gray-200 rounded-lg outline-none uppercase" />
                    <button onClick={recover} disabled={!code.trim() || recovering}
                            className="px-3 py-2 text-xs bg-gray-900 text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-1.5">
                      {recovering && <Spinner size={12} light />}找回
                    </button>
                  </div>
                  {recoverErr && <p className="text-xs text-red-500 mt-2">{recoverErr}</p>}
                </div>
              ) : (
                <button onClick={() => setShowRecover(true)} className="text-xs text-gray-500 hover:text-gray-800 underline underline-offset-4 decoration-gray-300">
                  换了设备？用找回码继续之前的学习
                </button>
              )}
            </div>
          </>
        )}
      </div>
    )
  }

  // ---------------- 课程列表
  return (
    <div className="max-w-3xl mx-auto px-4 pt-10 md:pt-14 pb-16 animate-fade-in">
      <div className="flex items-end justify-between mb-6">
        <h1 className="font-serif text-2xl text-gray-900 tracking-wide">我的课程</h1>
        <button onClick={onNewCourse} className="md:hidden text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 bg-white">＋ 新建课程</button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {courses.map((c) => (
          <button key={c.id} onClick={() => onOpenCourse(c.id)}
                  className="text-left p-5 rounded-2xl border border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-gray-900 leading-relaxed">{c.name}</p>
              {c.due > 0 && <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-gray-900 text-white">今天复习 {c.due}</span>}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {c.kind === "sample" ? "示例 · " : ""}{c.material_count} 份资料{c.exam_date ? ` · ${examText(c.exam_date)}` : ""}
            </p>
          </button>
        ))}
        <button onClick={onNewCourse}
                className="hidden md:flex p-5 rounded-2xl border border-dashed border-gray-300 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-800 items-center justify-center">
          ＋ 新建课程
        </button>
      </div>
      {!!err && <div className="mt-4"><ErrorPanel error={err} /></div>}
    </div>
  )
}
