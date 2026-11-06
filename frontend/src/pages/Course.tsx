import { useState, useEffect, useRef, useCallback } from "react"
import {
  getCourse, updateCourse, deleteCourse, getCourseKnowledge, uploadStudyFile, startTopic, updateMaterial,
  getCourseExam, buildBank, getRoute, routeMore, routeReset, toApiError, MATERIAL_TYPES,
  type CourseRoute, type RouteStep,
  type ExamOverview, type ExamMaterial, type CourseDetail, type CourseSummary, type CourseKnowledgePoint, type Material, type MaterialType, type MasteryStatus,
} from "../api"
import Spinner from "../components/Spinner"
import ErrorPanel from "../components/ErrorPanel"
import { MasteryBadge } from "../components/Learning"
import { toast } from "../components/Toast"
import Review, { Remedial } from "./Review"
import { examText, daysUntil } from "./Home"
import ProfileQuiz from "../components/ProfileQuiz"

export type CourseTab = "route" | "materials" | "knowledge" | "exam" | "review"

interface CourseProps {
  courseId: number
  tab: CourseTab
  onTab: (t: CourseTab) => void
  courses: CourseSummary[]
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
  onChanged: () => void
  onDeleted: () => void
  onMissing: () => void
}

const TYPE_LABEL: Record<MaterialType, string> = Object.fromEntries(MATERIAL_TYPES.map((t) => [t.key, t.label])) as Record<MaterialType, string>

export default function Course({ courseId, tab, onTab, courses, onNavigate, onChanged, onDeleted, onMissing }: CourseProps) {
  const [course, setCourse] = useState<CourseDetail | null>(null)
  const [loadErr, setLoadErr] = useState<unknown>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const load = useCallback(async () => {
    setLoadErr(null)
    try {
      setCourse(await getCourse(courseId))
    } catch (e) {
      if (toApiError(e).code === "not_found") onMissing()
      else setLoadErr(e)
    }
  }, [courseId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  if (loadErr) return <div className="max-w-xl mx-auto px-4 py-16"><ErrorPanel error={loadErr} actions={{ onRetry: load }} /></div>
  if (!course) {
    return (
      <div className="max-w-3xl mx-auto px-4 pt-10 space-y-3">
        <div className="h-7 w-2/3 bg-gray-100 rounded animate-pulse" />
        <div className="h-4 w-1/3 bg-gray-100 rounded animate-pulse" />
        <div className="h-24 bg-gray-50 border border-gray-100 rounded-2xl animate-pulse mt-6" />
      </div>
    )
  }

  const tabs: [CourseTab, string, number][] = [["route", "路线", 0], ["materials", "资料", 0], ["knowledge", "知识点", 0], ["exam", "考试", 0], ["review", "复习", course.due]]
  const left = daysUntil(course.exam_date)

  return (
    <div className="max-w-3xl mx-auto px-4 pt-6 md:pt-10 pb-16">
      <button onClick={() => onNavigate("home")} className="md:hidden text-xs text-gray-400 mb-3">← 全部课程</button>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="font-serif text-2xl text-gray-900 leading-snug">{course.name}</h1>
          <p className="text-xs text-gray-400 mt-1.5">
            {course.kind === "sample" ? "示例课程 · " : course.kind === "inbox" ? "以前上传的资料都在这里 · " : ""}
            {course.material_count} 份资料{course.exam_date ? ` · ${examText(course.exam_date)}` : ""}
          </p>
          {left !== null && left >= 0 && left <= 14 && (
            <button onClick={() => onTab("exam")}
                    className="mt-2 text-[11px] px-2.5 py-1 rounded-full bg-gray-900 text-white">考前冲刺 · 还有 {left} 天</button>
          )}
        </div>
        <button onClick={() => setSettingsOpen(!settingsOpen)} aria-expanded={settingsOpen}
                className="text-xs text-gray-500 hover:text-gray-800 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white shrink-0">设置</button>
      </div>

      {settingsOpen && (
        <CourseSettings course={course} onSaved={() => { setSettingsOpen(false); load(); onChanged() }} onDeleted={onDeleted} />
      )}

      <div className="flex gap-5 sm:gap-6 border-b border-gray-100 mt-6 mb-6 overflow-x-auto" role="tablist">
        {tabs.map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => onTab(k)}
                  className={`-mb-px pb-2.5 text-sm border-b-2 inline-flex items-center gap-1.5 shrink-0
                    ${tab === k ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
            {label}{n > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-900 text-white leading-none">{n}</span>}
          </button>
        ))}
      </div>

      {tab === "route" && (
        <RouteTab course={course} onTab={onTab} onNavigate={onNavigate} onChanged={() => { load(); onChanged() }} />
      )}
      {tab === "materials" && (
        <MaterialsTab course={course} courses={courses} onNavigate={onNavigate} reload={() => { load(); onChanged() }} />
      )}
      {tab === "knowledge" && <KnowledgeTab courseId={course.id} onNavigate={onNavigate} />}
      {tab === "exam" && <ExamTab courseId={course.id} onNavigate={onNavigate} onAddMaterial={() => onTab("materials")} />}
      {tab === "review" && (
        <Review courseId={course.id} embedded onNavigate={onNavigate} onDone={() => { load(); onChanged() }} />
      )}
    </div>
  )
}

// =====================================================================
// 设置：改名、考试日期、删除
// =====================================================================

function CourseSettings({ course, onSaved, onDeleted }: { course: CourseDetail; onSaved: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(course.name)
  const [exam, setExam] = useState(course.exam_date)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await updateCourse(course.id, { name: name.trim(), exam_date: exam })
      toast("已保存", "success"); onSaved()
    } catch (e) { toast(toApiError(e).message, "error") } finally { setSaving(false) }
  }
  const remove = async () => {
    if (deleting || !confirm(`确定删除「${course.name}」吗？`)) return
    setDeleting(true)
    try {
      await deleteCourse(course.id)
      toast("课程已删除", "success"); onDeleted()
    } catch (e) { toast(toApiError(e).message, "error"); setDeleting(false) }
  }

  return (
    <div className="mt-4 p-4 rounded-2xl border border-gray-200 bg-white animate-fade-in">
      <div className="grid sm:grid-cols-[1fr_180px] gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1" htmlFor="c-name">课程名</label>
          <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
                 className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1" htmlFor="c-exam">考试日期</label>
          <input id="c-exam" type="date" value={exam} onChange={(e) => setExam(e.target.value)}
                 className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none text-gray-700" />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button onClick={save} disabled={!name.trim() || saving}
                className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-1.5">
          {saving && <Spinner size={11} light />}保存
        </button>
        <div className="flex-1" />
        {course.material_count === 0 ? (
          <button onClick={remove} disabled={deleting} className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50">删除这门课</button>
        ) : (
          <span className="text-[11px] text-gray-400">课里还有资料，不能删除</span>
        )}
      </div>
    </div>
  )
}

// =====================================================================
// 资料：添加资料 + 按周排列
// =====================================================================

function MaterialsTab({ course, courses, onNavigate, reload }: {
  course: CourseDetail
  courses: CourseSummary[]
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
  reload: () => void
}) {
  const empty = course.materials.length === 0
  const [adding, setAdding] = useState(empty)
  const [fresh, setFresh] = useState<string | null>(null)
  const isSample = course.kind === "sample"
  const cont = course.materials.find((m) => m.session_id === course.continue_session_id)

  // 按周分组
  const groups = new Map<string, Material[]>()
  for (const m of course.materials) {
    const key = m.week != null ? `第 ${m.week} 周` : "没有标周的资料"
    groups.set(key, [...(groups.get(key) || []), m])
  }

  return (
    <div className="animate-fade-in">
      {cont && (
        <div className="p-5 rounded-2xl border border-gray-200 bg-white mb-4 flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-gray-400 mb-1">继续学习</p>
            <p className="text-sm text-gray-900 truncate">{cont.title}</p>
            <p className="text-xs text-gray-400 mt-1">
              {cont.finished && !cont.diagnostic ? "已经学完，可以做诊断小测了" : `看到第 ${cont.last_page} / ${cont.page_count} 页`}
            </p>
          </div>
          {cont.finished && !cont.diagnostic ? (
            <button onClick={() => onNavigate("practice", cont.session_id, "diagnostic")}
                    className="shrink-0 px-4 py-2 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-800">做诊断小测</button>
          ) : (
            <button onClick={() => onNavigate("study", cont.session_id)}
                    className="shrink-0 px-4 py-2 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-800">继续</button>
          )}
        </div>
      )}

      {!isSample && (adding ? (
        <AddMaterial courseId={course.id} first={empty} onCancel={empty ? undefined : () => setAdding(false)}
                     onAdded={(sid) => { setFresh(sid); reload() }} />
      ) : (
        <button onClick={() => setAdding(true)}
                className="w-full mb-6 py-2.5 text-sm rounded-xl border border-dashed border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-900 bg-white">
          ＋ 添加资料
        </button>
      ))}

      {[...groups.entries()].map(([label, items]) => (
        <section key={label} className="mb-6">
          <p className="text-xs text-gray-400 mb-2">{label}</p>
          <div className="space-y-2">
            {items.map((m) => (
              <MaterialCard key={m.session_id} m={m} highlight={fresh === m.session_id} courses={courses} courseId={course.id}
                            onNavigate={onNavigate} reload={reload} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function AddMaterial({ courseId, first, onCancel, onAdded }: {
  courseId: number
  first: boolean
  onCancel?: () => void
  onAdded: (sessionId: string) => void
}) {
  const [type, setType] = useState<MaterialType>("lecture")
  const [week, setWeek] = useState("")
  const [busy, setBusy] = useState("")      // 正在上传的文件名
  const [pct, setPct] = useState(0)
  const [err, setErr] = useState<unknown>(null)
  const [drag, setDrag] = useState(false)
  const [showTopic, setShowTopic] = useState(false)
  const [topic, setTopic] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)
  const weekNo = week.trim() ? Math.max(0, Math.min(60, parseInt(week, 10) || 0)) : null

  const upload = async (files: FileList | File[] | null | undefined) => {
    const list = Array.from(files || [])
    if (!list.length || busy) return
    setErr(null)
    for (const f of list) {
      const ext = "." + (f.name.split(".").pop() || "").toLowerCase()
      if (![".pptx", ".pdf", ".docx"].includes(ext)) {
        const old = [".ppt", ".doc"].includes(ext)
        setErr(Object.assign(toApiError(null), {
          code: old ? "upload_old_format" : "upload_bad_type",
          message: `${f.name}：` + (old ? "旧版 .ppt / .doc 请先「另存为」.pptx / .docx（或导出为 PDF）再上传。" : "只支持 PPTX、PDF、DOCX 文件。"),
        }))
        continue
      }
      if (f.size > 20 * 1024 * 1024) {
        setErr(Object.assign(toApiError(null), { code: "upload_too_large", message: `${f.name} 超过 20MB。可以压缩图片，或者拆成两份再上传。` }))
        continue
      }
      setBusy(f.name); setPct(0)
      try {
        const v = await uploadStudyFile(f, setPct, { courseId, materialType: type, week: weekNo })
        toast(`已加入：${v.title}`, "success")
        onAdded(v.session_id)
      } catch (e) {
        setErr(e)
      }
    }
    setBusy("")
    if (fileRef.current) fileRef.current.value = ""
  }

  const addTopic = async () => {
    if (!topic.trim() || busy) return
    setBusy(topic.trim()); setErr(null)
    try {
      const v = await startTopic(topic.trim(), "", "", courseId, weekNo)
      toast(`已加入：${v.title}`, "success")
      setTopic(""); setShowTopic(false)
      onAdded(v.session_id)
    } catch (e) { setErr(e) } finally { setBusy("") }
  }

  return (
    <div className="mb-6 p-5 rounded-2xl border border-gray-200 bg-white animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-900">{first ? "把这门课的第一份资料放进来" : "添加资料"}</p>
        {onCancel && <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-700">收起</button>}
      </div>

      <p className="text-xs text-gray-500 mb-2">这是什么资料？</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4" role="radiogroup">
        {MATERIAL_TYPES.map((t) => (
          <button key={t.key} role="radio" aria-checked={type === t.key} onClick={() => setType(t.key)}
                  className={`text-left px-3 py-2 rounded-xl border ${type === t.key ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:border-gray-300"}`}>
            <span className="block text-sm text-gray-900">{t.label}</span>
            <span className="block text-[11px] text-gray-400">{t.hint}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-4">
        <label className="text-xs text-gray-500" htmlFor="week">第几周</label>
        <input id="week" inputMode="numeric" value={week} onChange={(e) => setWeek(e.target.value.replace(/\D/g, "").slice(0, 2))}
               placeholder="可不填" className="w-20 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg outline-none" />
      </div>

      <label
        className={`flex flex-col items-center justify-center h-32 border border-dashed rounded-2xl transition-colors
          ${busy ? "cursor-default" : "cursor-pointer"} ${drag ? "border-gray-500 bg-gray-100" : "border-gray-300 hover:border-gray-400 bg-gray-50/50"}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files) }}
      >
        {busy ? (
          <>
            <p className="text-sm text-gray-700 mb-2 inline-flex items-center gap-2 px-4 text-center"><Spinner size={13} />{pct < 100 ? `正在上传 ${pct}%` : "正在读取每一页…"}</p>
            <p className="text-[11px] text-gray-400 truncate max-w-[80%]">{busy}</p>
            <div className="w-48 h-1 rounded-full bg-gray-200 overflow-hidden mt-2">
              <div className={`h-full bg-gray-500 rounded-full transition-all duration-500 ${pct >= 100 ? "animate-pulse" : ""}`} style={{ width: `${pct < 100 ? pct * 0.8 : 90}%` }} />
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-700 mb-1">{drag ? "松开鼠标上传" : `点击或拖拽「${TYPE_LABEL[type]}」到这里`}</p>
            <p className="text-xs text-gray-400">PPTX / PDF / DOCX，可以一次选多个，每个最大 20MB</p>
          </>
        )}
        <input ref={fileRef} type="file" multiple accept=".pptx,.pdf,.docx,.ppt,.doc" className="hidden" disabled={!!busy}
               onChange={(e) => upload(e.target.files)} />
      </label>

      <div className="mt-3">
        {showTopic ? (
          <div className="flex gap-2 animate-fade-in">
            <input value={topic} onChange={(e) => setTopic(e.target.value)} autoFocus
                   onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) addTopic() }}
                   placeholder='想学的话题，例如 "UML class diagram"'
                   className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none" />
            <button onClick={addTopic} disabled={!topic.trim() || !!busy}
                    className="px-3 py-2 text-xs border border-gray-200 rounded-lg text-gray-700 disabled:opacity-40">生成</button>
          </div>
        ) : (
          <button onClick={() => setShowTopic(true)} className="text-xs text-gray-500 hover:text-gray-800">没有文件？输入一个话题，AI 帮你写一份讲义</button>
        )}
      </div>

      {!!err && <div className="mt-4"><ErrorPanel compact error={err} actions={{ onPickFile: () => fileRef.current?.click(), onRetry: () => fileRef.current?.click() }} /></div>}
    </div>
  )
}

function MaterialCard({ m, highlight, courses, courseId, onNavigate, reload }: {
  m: Material
  highlight: boolean
  courses: CourseSummary[]
  courseId: number
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
  reload: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [type, setType] = useState<MaterialType>(m.material_type)
  const [week, setWeek] = useState(m.week != null ? String(m.week) : "")
  const [target, setTarget] = useState(courseId)
  const [saving, setSaving] = useState(false)
  const pct = m.page_count ? Math.min(100, Math.round((m.visited / m.page_count) * 100)) : 0
  const moveTargets = courses.filter((c) => c.kind !== "sample")

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      await updateMaterial(m.session_id, {
        material_type: type,
        ...(week.trim() ? { week: parseInt(week, 10) } : { clear_week: true }),
        ...(target !== courseId ? { course_id: target } : {}),
      })
      toast(target !== courseId ? "已移到另一门课" : "已保存", "success")
      setEditing(false); reload()
    } catch (e) { toast(toApiError(e).message, "error") } finally { setSaving(false) }
  }

  return (
    <div className={`rounded-2xl border bg-white transition-colors ${highlight ? "border-gray-400" : "border-gray-100"}`}>
      <div className="flex items-center gap-3 p-4">
        <button onClick={() => onNavigate("study", m.session_id)} className="flex-1 min-w-0 text-left group">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 text-gray-500 shrink-0">{m.type_label}</span>
            <span className="text-sm text-gray-900 truncate group-hover:underline underline-offset-4 decoration-gray-300">{m.title}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-1 w-24 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-gray-400 rounded-full" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[11px] text-gray-400 tabular-nums">{m.visited}/{m.page_count} 页</span>
            {m.due > 0 && <span className="text-[11px] text-gray-600">· 今天复习 {m.due}</span>}
          </div>
        </button>
        {m.diagnostic ? (
          <button onClick={() => onNavigate("practice", m.session_id, "diagnostic")} title="再做一次诊断"
                  className="shrink-0 text-[11px] px-2 py-1 rounded-lg bg-gray-50 border border-gray-100 text-gray-600 tabular-nums">
            诊断 {m.diagnostic.correct}/{m.diagnostic.total}
          </button>
        ) : m.finished ? (
          <button onClick={() => onNavigate("practice", m.session_id, "diagnostic")}
                  className="shrink-0 text-[11px] px-2 py-1 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">做诊断</button>
        ) : null}
        <button onClick={() => setEditing(!editing)} aria-label="编辑资料" aria-expanded={editing}
                className="shrink-0 w-7 h-7 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50">⋯</button>
      </div>
      {editing && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-100 animate-fade-in">
          <div className="flex flex-wrap items-end gap-3 mt-3">
            <label className="text-xs text-gray-500">类型
              <select value={type} onChange={(e) => setType(e.target.value as MaterialType)}
                      className="block mt-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-white">
                {MATERIAL_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-500">第几周
              <input inputMode="numeric" value={week} onChange={(e) => setWeek(e.target.value.replace(/\D/g, "").slice(0, 2))}
                     placeholder="不填" className="block mt-1 w-20 px-2 py-1.5 text-sm border border-gray-200 rounded-lg" />
            </label>
            {moveTargets.length > 1 && (
              <label className="text-xs text-gray-500">所在课程
                <select value={target} onChange={(e) => setTarget(Number(e.target.value))}
                        className="block mt-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-white max-w-[200px]">
                  {moveTargets.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <button onClick={save} disabled={saving}
                    className="text-xs px-3 py-2 bg-gray-900 text-white rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5">
              {saving && <Spinner size={11} light />}保存
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// =====================================================================
// 知识点：整门课的掌握地图
// =====================================================================

const GROUPS: [MasteryStatus, string][] = [["weak", "需要加强"], ["learning", "学习中"], ["new", "还没练过"], ["mastered", "已掌握"]]

function KnowledgeTab({ courseId, onNavigate }: { courseId: number; onNavigate: (page: string, sessionId?: string, scope?: string) => void }) {
  const [data, setData] = useState<{ knowledge_points: CourseKnowledgePoint[]; counts: Record<MasteryStatus, number> } | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [openKp, setOpenKp] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)

  const load = () => {
    setErr(null)
    getCourseKnowledge(courseId).then(setData).catch(setErr)
  }
  useEffect(load, [courseId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <ErrorPanel error={err} actions={{ onRetry: load }} />
  if (!data) return <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-14 bg-gray-50 border border-gray-100 rounded-xl animate-pulse" />)}</div>
  if (!data.knowledge_points.length) {
    return <p className="text-sm text-gray-500 text-center py-16">先在「资料」里放一份课件，打开学习后这里会列出知识点</p>
  }

  const practiced = data.counts.weak + data.counts.learning + data.counts.mastered
  return (
    <div className="animate-fade-in">
      <div className="grid grid-cols-4 gap-2 mb-4">
        {GROUPS.map(([k, label]) => (
          <div key={k} className="p-3 rounded-xl bg-gray-50 border border-gray-100 text-center">
            <p className="font-serif text-xl text-gray-900 tabular-nums">{data.counts[k]}</p>
            <p className="text-[11px] text-gray-500">{label}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400 mb-6 leading-relaxed">
        怎么算掌握：在两个不同的日子都答对，并且至少一次是选择题或填空题。错一次（或同一天错几道）只算「学习中」，在两个不同的日子都答错才算「需要加强」。不同资料里同名的知识点合在一起算。
        {practiced === 0 && " 学完一份资料后做个诊断小测，这里就会有结果。"}
      </p>

      {GROUPS.map(([status, label]) => {
        const items = data.knowledge_points.filter((k) => k.status === status)
        if (!items.length) return null
        const collapsed = status === "new" && !showNew && practiced > 0
        return (
          <section key={status} className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-500">{label} · {items.length}</p>
              {status === "new" && practiced > 0 && (
                <button onClick={() => setShowNew(!showNew)} className="text-xs text-gray-500 hover:text-gray-800">{showNew ? "收起" : "展开"}</button>
              )}
            </div>
            {!collapsed && (
              <div className="space-y-2">
                {items.map((k) => {
                  const src = k.sources[0]
                  return (
                    <div key={k.name} className="p-4 rounded-xl border border-gray-100 bg-white">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-900">{k.name}</p>
                          <p className="text-[11px] text-gray-400 truncate">
                            {src ? `${src.week != null ? `第 ${src.week} 周 · ` : ""}${TYPE_LABEL[src.material_type]}${src.page_start ? ` · 第 ${src.page_start}${src.page_end && src.page_end !== src.page_start ? `–${src.page_end}` : ""} 页` : ""}` : ""}
                            {k.sources.length > 1 ? ` · 另有 ${k.sources.length - 1} 份资料讲到` : ""}
                          </p>
                          {k.note && <p className="text-xs text-gray-500 mt-1">{k.note}</p>}
                        </div>
                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                          <MasteryBadge status={k.status} label={k.label} />
                          {k.due_today && <span className="text-[11px] text-gray-500">今天该复习</span>}
                        </div>
                      </div>
                      <div className="flex gap-3 mt-2">
                        {src && (
                          <button onClick={() => onNavigate("study", src.session_id)} className="text-xs text-gray-500 hover:text-gray-800">回到课件</button>
                        )}
                        {(k.status === "weak" || k.status === "learning") && openKp !== k.id && (
                          <button onClick={() => setOpenKp(k.id)}
                                  className={`text-xs px-2.5 py-1 rounded-lg ${k.status === "weak" ? "bg-gray-900 text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
                            补一补
                          </button>
                        )}
                      </div>
                      {openKp === k.id && <Remedial kp={k} onDone={() => toast("已记录，掌握情况会更新", "success")} />}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
      <button onClick={load} className="text-xs text-gray-500 hover:text-gray-800 underline underline-offset-4 decoration-gray-300">刷新</button>
    </div>
  )
}

// =====================================================================
// 考试：题库 + 高频考点（2.3）
// =====================================================================

function BankCard({ m, courseId, primary, onBuilt, onNavigate }: {
  m: ExamMaterial
  courseId: number
  primary: boolean
  onBuilt: () => void
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
}) {
  const [building, setBuilding] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  const [confirmRedo, setConfirmRedo] = useState(false)

  const build = async (force: boolean) => {
    if (building) return
    setBuilding(true); setErr(null); setConfirmRedo(false)
    try {
      const r = await buildBank(courseId, m.session_id, force)
      toast(`整理好了：${r.count} 道题${r.mapped != null && r.mapped < r.count ? `，其中 ${r.mapped} 道对应到了知识点` : ""}`, "success")
      onBuilt()
    } catch (e) { setErr(e) } finally { setBuilding(false) }
  }

  return (
    <div className="p-4 rounded-2xl border border-gray-100 bg-white">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 text-gray-500 shrink-0">{m.type_label}</span>
            <span className="text-sm text-gray-900 truncate">{m.title}</span>
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5 tabular-nums">
            {building ? "AI 正在一道道读题，大约 10–40 秒…"
              : m.ready ? `${m.count} 道题 · 做过 ${m.done} 道${m.marks ? ` · 共 ${m.marks} 分` : ""}`
              : `${m.page_count} 页 · 还没有整理成题库${m.is_sample ? "（示例考卷，不耗次数）" : ""}`}
          </p>
        </div>
        {m.ready ? (
          <button onClick={() => onNavigate("practice", m.session_id, "bank")}
                  className={`shrink-0 px-3.5 py-2 text-sm rounded-xl ${primary ? "bg-gray-900 text-white hover:bg-gray-800" : "border border-gray-200 text-gray-700 hover:bg-gray-50"}`}>
            开始练习
          </button>
        ) : (
          <button onClick={() => build(false)} disabled={building}
                  className={`shrink-0 px-3.5 py-2 text-sm rounded-xl inline-flex items-center gap-1.5 disabled:opacity-60
                    ${primary ? "bg-gray-900 text-white hover:bg-gray-800" : "border border-gray-200 text-gray-700 hover:bg-gray-50"}`}>
            {building && <Spinner size={12} light={primary} />}整理成题库
          </button>
        )}
      </div>
      {m.ready && !building && (
        <div className="flex gap-3 mt-2">
          <button onClick={() => onNavigate("study", m.session_id)} className="text-xs text-gray-500 hover:text-gray-800">看原卷</button>
          {confirmRedo ? (
            <span className="text-xs text-gray-500">
              会重新调用 AI 拆题，做过的记录会保留。<button onClick={() => build(true)} className="text-gray-900 underline underline-offset-4 ml-1">确定重新整理</button>
              <button onClick={() => setConfirmRedo(false)} className="ml-2 text-gray-400">取消</button>
            </span>
          ) : (
            <button onClick={() => setConfirmRedo(true)} className="text-xs text-gray-500 hover:text-gray-800">重新整理</button>
          )}
        </div>
      )}
      {!!err && <div className="mt-3"><ErrorPanel compact error={err} actions={{ onRetry: () => build(false) }} /></div>}
    </div>
  )
}

function ExamTab({ courseId, onNavigate, onAddMaterial }: {
  courseId: number
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
  onAddMaterial: () => void
}) {
  const [data, setData] = useState<ExamOverview | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [openKp, setOpenKp] = useState<number | null>(null)

  const load = () => {
    setErr(null)
    getCourseExam(courseId).then(setData).catch(setErr)
  }
  useEffect(load, [courseId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <ErrorPanel error={err} actions={{ onRetry: load }} />
  if (!data) return <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-16 bg-gray-50 border border-gray-100 rounded-2xl animate-pulse" />)}</div>

  if (!data.materials.length) {
    return (
      <div className="text-center py-14 animate-fade-in">
        <p className="font-serif text-lg text-gray-900 mb-2">还没有题目类资料</p>
        <p className="text-xs text-gray-500 leading-relaxed max-w-sm mx-auto">
          把 Tutorial 或往年考试题放进「资料」（上传时选对应的类型）。这里会把题目一道道拆出来，并算出哪些知识点最常考。
        </p>
        <button onClick={onAddMaterial} className="mt-5 px-4 py-2 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-800">去添加资料</button>
      </div>
    )
  }

  const firstPending = data.materials.findIndex((m) => !m.ready)
  const primaryIdx = firstPending >= 0 ? firstPending : 0
  return (
    <div className="animate-fade-in">
      <section className="mb-8">
        <p className="text-xs text-gray-500 mb-2">题库</p>
        <div className="space-y-2">
          {data.materials.map((m, i) => (
            <BankCard key={m.session_id} m={m} courseId={courseId} primary={i === primaryIdx} onBuilt={load} onNavigate={onNavigate} />
          ))}
        </div>
        {!data.has_study_material && (
          <p className="text-[11px] text-gray-400 mt-2">先放一份老师课件进来并打开学习，题目才能对应到知识点。</p>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-xs text-gray-500">高频考点</p>
          {data.hot.length > 0 && <p className="text-[11px] text-gray-400">按往年题出现次数和分值排序</p>}
        </div>
        {data.hot.length === 0 ? (
          <p className="text-xs text-gray-400 py-6 text-center border border-dashed border-gray-200 rounded-2xl">
            整理好题库后，这里会列出最常考的知识点
          </p>
        ) : (
          <ol className="space-y-2">
            {data.hot.map((h, i) => (
              <li key={h.name} className="p-4 rounded-2xl border border-gray-100 bg-white">
                <div className="flex items-start gap-3">
                  <span className="font-serif text-base text-gray-400 w-5 shrink-0 tabular-nums">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">{h.name}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
                      {[h.exam_count ? `往年题 ${h.exam_count} 道${h.marks ? ` · ${h.marks} 分` : ""}` : "",
                        h.tutorial_count ? `Tutorial ${h.tutorial_count} 道` : ""].filter(Boolean).join(" · ")}
                    </p>
                    {h.status !== "mastered" && h.exam_count > 0 && h.status !== "new" && (
                      <p className="text-[11px] text-red-500 mt-0.5">常考，但还没掌握</p>
                    )}
                  </div>
                  <MasteryBadge status={h.status} label={h.label} />
                </div>
                <div className="flex flex-wrap gap-3 mt-3 pl-8">
                  {h.practice && (
                    <button onClick={() => onNavigate("practice", h.practice!.session_id, h.practice!.scope)}
                            className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">练相关原题</button>
                  )}
                  {(h.status === "weak" || h.status === "learning") && openKp !== h.id && (
                    <button onClick={() => setOpenKp(h.id)} className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">补一补</button>
                  )}
                  {h.study && (
                    <button onClick={() => onNavigate("study", h.study!.session_id)} className="text-xs text-gray-500 hover:text-gray-800">回课件</button>
                  )}
                </div>
                {openKp === h.id && <div className="pl-8"><Remedial kp={h} onDone={() => toast("已记录，掌握情况会更新", "success")} /></div>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

// =====================================================================
// 路线：今天按你的情况排出来的几步（3.0）
// =====================================================================

const KIND_LABEL: Record<RouteStep["kind"], string> = {
  add: "开始", review: "复习", build_bank: "整理题库", remedial: "补一补", bank: "练原题", diagnostic: "诊断", study: "学课件", words: "术语",
}

function readSkip(): boolean {
  try { return localStorage.getItem("quizSkipped") === "1" } catch { return false }
}

function RouteTab({ course, onTab, onNavigate, onChanged }: {
  course: CourseDetail
  onTab: (t: CourseTab) => void
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
  onChanged: () => void
}) {
  const [route, setRoute] = useState<CourseRoute | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [busy, setBusy] = useState("")
  const [openRemedial, setOpenRemedial] = useState<string | null>(null)
  const [skipQuiz, setSkipQuiz] = useState(readSkip())
  const [showLater, setShowLater] = useState(false)

  const load = () => {
    setErr(null)
    getRoute(course.id).then(setRoute).catch(setErr)
  }
  useEffect(load, [course.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (step: RouteStep) => {
    const a = step.action
    if (a.type === "tab") onTab(a.tab as CourseTab)
    else if (a.type === "page") onNavigate(a.page)
    else if (a.type === "study") onNavigate("study", a.session_id)
    else if (a.type === "practice") onNavigate("practice", a.session_id, a.scope)
    else if (a.type === "remedial") setOpenRemedial(openRemedial === step.key ? null : step.key)
    else if (a.type === "build_bank") {
      if (busy) return
      setBusy(step.key)
      try {
        const r = await buildBank(course.id, a.session_id)
        toast(`整理好了：${r.count} 道题`, "success")
        load(); onChanged()
      } catch (e) { toast(toApiError(e).message, "error") } finally { setBusy("") }
    }
  }

  const more = async () => {
    if (busy) return
    setBusy("more")
    try { setRoute(await routeMore(course.id)) } catch (e) { toast(toApiError(e).message, "error") } finally { setBusy("") }
  }
  const reset = async () => {
    if (busy) return
    setBusy("reset")
    try { setRoute(await routeReset(course.id)); toast("按现在的情况重新排好了", "success") }
    catch (e) { toast(toApiError(e).message, "error") } finally { setBusy("") }
  }

  if (err) return <ErrorPanel error={err} actions={{ onRetry: load }} />
  if (!route) return <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-20 bg-gray-50 border border-gray-100 rounded-2xl animate-pulse" />)}</div>

  const firstUndone = route.today.findIndex((s) => !s.done)
  const allDone = route.today.length > 0 && firstUndone < 0

  return (
    <div className="animate-fade-in">
      {!route.profile_completed && !skipQuiz && (
        <section className="mb-8 p-5 rounded-2xl border border-gray-200 bg-white">
          <p className="font-serif text-lg text-gray-900">先让爱学认识你</p>
          <p className="text-xs text-gray-500 mt-1 mb-5 leading-relaxed">5 个问题。讲解怎么写、每天的路线怎么排，都会按你的回答来，之后在「我的」里随时能改。</p>
          <ProfileQuiz compact onSaved={() => load()}
                       onSkip={() => { setSkipQuiz(true); try { localStorage.setItem("quizSkipped", "1") } catch { /* ignore */ } }} />
        </section>
      )}

      <div className="flex items-end justify-between gap-4 mb-1">
        <h2 className="font-serif text-xl text-gray-900">{allDone ? "今天的路线走完了" : "今天的路线"}</h2>
        <div className="flex items-center gap-2 shrink-0">
          {route.streak > 0 && <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 text-gray-600 tabular-nums">连续学习 {route.streak} 天</span>}
          {route.days_left !== null && route.days_left >= 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 tabular-nums">距离考试 {route.days_left} 天</span>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-5 tabular-nums">
        {allDone ? `${route.done} 步都完成了。` : `${route.total} 步，还剩大约 ${route.minutes} 分钟。`}
        按你的方式：{route.style_summary}
        {route.sprint && " · 冲刺模式，常考点优先"}
      </p>

      <ol className="relative">
        {route.today.map((s, i) => {
          const primary = i === firstUndone
          return (
            <li key={s.key} className="relative pl-9 pb-5 last:pb-0">
              {i < route.today.length - 1 && <span className="absolute left-[11px] top-7 bottom-0 w-px bg-gray-200" aria-hidden="true" />}
              <span className={`absolute left-0 top-0.5 w-[23px] h-[23px] rounded-full border flex items-center justify-center text-[11px]
                ${s.done ? "bg-gray-900 border-gray-900 text-white" : primary ? "border-gray-900 text-gray-900 bg-white" : "border-gray-300 text-gray-400 bg-white"}`}
                    aria-label={s.done ? "已完成" : `第 ${i + 1} 步`}>
                {s.done ? "✓" : i + 1}
              </span>
              <div className={`p-4 rounded-2xl border ${primary ? "border-gray-300 bg-white" : "border-gray-100 bg-white"} ${s.done ? "opacity-60" : ""}`}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-gray-400 mb-0.5">{KIND_LABEL[s.kind]} · 约 {s.minutes} 分钟</p>
                    <p className={`text-sm text-gray-900 ${s.done ? "line-through decoration-gray-300" : ""}`}>{s.title}</p>
                    <p className="text-xs text-gray-500 mt-1 leading-relaxed">{s.reason}</p>
                  </div>
                  {!s.done && (
                    <button onClick={() => run(s)} disabled={busy === s.key}
                            className={`shrink-0 px-3.5 py-2 text-sm rounded-xl inline-flex items-center gap-1.5 disabled:opacity-60
                              ${primary ? "bg-gray-900 text-white hover:bg-gray-800" : "border border-gray-200 text-gray-700 hover:bg-gray-50"}`}>
                      {busy === s.key && <Spinner size={12} light={primary} />}
                      {s.action.type === "remedial" && openRemedial === s.key ? "收起" : "开始"}
                    </button>
                  )}
                </div>
                {s.action.type === "remedial" && openRemedial === s.key && (
                  <Remedial kp={{ id: s.action.kp_id }} onDone={() => { load(); toast("这一步完成了", "success") }} />
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {allDone && (
        <div className="mt-6 p-4 rounded-2xl bg-gray-50 border border-gray-100 flex items-center gap-3">
          <p className="text-xs text-gray-600 flex-1">今天的目标完成了{route.streak > 1 ? `，已经连续学了 ${route.streak} 天` : ""}。还有时间的话可以再走一步。</p>
          {route.later.length > 0 && (
            <button onClick={more} disabled={busy === "more"}
                    className="shrink-0 px-3.5 py-2 text-sm rounded-xl bg-gray-900 text-white disabled:opacity-60 inline-flex items-center gap-1.5">
              {busy === "more" && <Spinner size={12} light />}再加一步
            </button>
          )}
        </div>
      )}

      {route.later.length > 0 && (
        <section className="mt-8">
          <button onClick={() => setShowLater(!showLater)} className="text-xs text-gray-500 hover:text-gray-800" aria-expanded={showLater}>
            {showLater ? "收起" : `接下来还有 ${route.later.length} 步`}
          </button>
          {showLater && (
            <ul className="mt-3 space-y-2 animate-fade-in">
              {route.later.map((s) => (
                <li key={s.key} className="px-4 py-3 rounded-xl border border-dashed border-gray-200">
                  <p className="text-sm text-gray-700">{s.title}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">{s.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="flex flex-wrap gap-4 mt-8 pt-4 border-t border-gray-100">
        <button onClick={reset} disabled={busy === "reset"} className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-60">按现在的情况重新排</button>
        <button onClick={() => onNavigate("profile")} className="text-xs text-gray-500 hover:text-gray-800">修改我的学习方式</button>
        {!course.exam_date && <span className="text-xs text-gray-400">在右上角「设置」里填考试日期，离考试 14 天内会自动进入冲刺模式</span>}
      </div>
    </div>
  )
}
