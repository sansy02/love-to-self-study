/**
 * 预览版用的「假后端」：在浏览器里模拟所有 /api 接口，数据只存在这个页面里（刷新就清空）。
 * 用来每次改完界面后，打包成一个网页给自己点着看；不会连接真正的服务器，也不会调用 AI。
 * 正式网站不会用到这个文件。
 */
import data from "./sample-data.json"

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Page { page_no: number; title: string; text: string; explanation: Json | null }
interface Doc { id: string; title: string; source_type: string; pages: Page[]; sections: Json[] }
interface Session { session_id: string; course_id: number; doc_id: string; material_type: string; week: number | null;
  progress: Json; created: number; updated: number }
interface Ex { id: number; session_id: string; type: string; question: string; options: string[]; answer: string;
  explanation: string; key_points: string[]; page_no: number | null; scope: string; batch: string; kp_ids: number[]; answered: boolean
  label?: string; marks?: number | null }
interface Attempt { id: number; exercise_id: number; kp_ids: number[]; status: string; evidence: string; error_reason: string;
  error_reason_source: string; source: string; at: number; user_answer: string; feedback: Json; score: number | null; graded_by: string }
interface Wrong { id: number; exercise_id: number; user_answer: string; feedback: Json; box: number; mastered: boolean;
  next_review_at: number | null; review_count: number; created: number }
interface Kp { id: number; doc_id: string; name: string; kind: string; section_index: number | null; page_start: number | null; page_end: number | null }

const TYPES: Record<string, string> = { lecture: "老师课件", tutorial: "Tutorial 题目", past_exam: "往年考试题", notes: "其他笔记" }
const REASONS: Record<string, string> = { concept: "概念没懂", english: "题目英文没看懂", term: "术语记错", expression: "表达不清", careless: "粗心 / 其他" }
const LABELS: Record<string, string> = { new: "还没练过", learning: "学习中", weak: "需要加强", mastered: "已掌握" }
const DAY = 86400000

// ---------------------------------------------------------------- 内存数据
let seq = 1
const nid = () => seq++
const courses: Json[] = []
const sessions: Record<string, Session> = {}
const docs: Record<string, Doc> = {}
const exercises: Record<number, Ex> = {}
const attempts: Attempt[] = []
const wrongs: Wrong[] = []
const words: Json[] = []
const kps: Kp[] = []
const chats: Record<string, Json[]> = {}
let keyMasked = ""
let used = 0

const iso = (t: number | null) => (t ? new Date(t).toISOString().replace("Z", "") : null)
const norm = (s: string) => (s || "").toLowerCase().replace(/[\s.,;:!?'"`()（）]+/g, " ").trim()
const letter = (s: string) => { const m = (s || "").trim().toUpperCase().match(/^\(?([A-F])/); return m ? m[1] : (s || "").trim().toUpperCase().slice(0, 1) }

const SAMPLE_DOC = "sample"
docs[SAMPLE_DOC] = {
  id: SAMPLE_DOC, title: data.SAMPLE_TITLE, source_type: "sample", sections: data.SAMPLE_SECTIONS,
  pages: data.SAMPLE_PAGES.map((p: Json, i: number) => ({ page_no: i + 1, title: p.title, text: p.text, explanation: p.explanation })),
}

const SAMPLE_EXAM = "sample-exam"
docs[SAMPLE_EXAM] = {
  id: SAMPLE_EXAM, title: data.SAMPLE_EXAM_TITLE, source_type: "sample",
  sections: [{ title: "Section A", summary: "", start: 1, end: 1 }, { title: "Section B", summary: "", start: 2, end: 2 }],
  pages: data.SAMPLE_EXAM_PAGES.map((p: Json, i: number) => ({ page_no: i + 1, title: p.title, text: p.text, explanation: p.explanation })),
}

function genericExplanation(title: string, n: number): Json {
  return {
    summary: `这是「${title}」第 ${n} 页的一句话总结（预览模式的示例文字）。`,
    explanation: "正式网站会在这里用中文一页一页讲解你的课件。\n- 术语写成「中文 (English)」\n- 先讲结论，再讲为什么\n\n预览模式不连接 AI，所以这里是固定的示例文字。",
    key_terms: [{ en: "Preview", zh: "预览", note: "这里只展示界面，不会真的读取文件" }],
    example: "", exam_tip: "", page_type: "content",
  }
}

function makeDoc(title: string, source: string, count: number): Doc {
  const id = "d" + nid()
  const pages = Array.from({ length: count }, (_, i) => ({
    page_no: i + 1, title: i === 0 ? title : `Page ${i + 1}`,
    text: `${title}\n（预览模式：不会真的读取你的文件，这里是第 ${i + 1} 页的示例文字）`, explanation: null,
  }))
  const half = Math.max(1, Math.floor(count / 2))
  const sections = [
    { title: "第一部分 (Part 1)", summary: "", start: 1, end: half },
    { title: "第二部分 (Part 2)", summary: "", start: half + 1, end: count },
  ].filter((s) => s.start <= s.end)
  docs[id] = { id, title, source_type: source, pages, sections }
  return docs[id]
}

function ensureKps(doc: Doc): Kp[] {
  const have = () => kps.filter((k) => k.doc_id === doc.id)
  const names = new Set(have().map((k) => k.name.toLowerCase()))
  doc.sections.forEach((s: Json, i: number) => {
    if (!names.has(s.title.toLowerCase())) {
      kps.push({ id: nid(), doc_id: doc.id, name: s.title, kind: "section", section_index: i, page_start: s.start, page_end: s.end })
      names.add(s.title.toLowerCase())
    }
  })
  for (const p of doc.pages) {
    for (const t of (p.explanation?.key_terms || []).slice(0, 6)) {
      if (!names.has(t.en.toLowerCase())) {
        const sec = doc.sections.findIndex((s: Json) => s.start <= p.page_no && p.page_no <= s.end)
        kps.push({ id: nid(), doc_id: doc.id, name: t.en, kind: "term", section_index: sec, page_start: p.page_no, page_end: p.page_no })
        names.add(t.en.toLowerCase())
      }
    }
  }
  return have()
}

function special(kind: string): Json {
  let c = courses.find((x) => x.kind === kind)
  if (!c) {
    c = { id: nid(), name: kind === "sample" ? "示例课程：类与对象" : "未分类", code: "", exam_date: "", kind, created: Date.now(), updated: Date.now() }
    courses.push(c)
  }
  return c
}

function getSession(doc: Doc, courseId: number, type = "lecture", week: number | null = null): Session {
  let s = Object.values(sessions).find((x) => x.doc_id === doc.id)
  if (!s) {
    s = { session_id: "s" + nid(), course_id: courseId, doc_id: doc.id, material_type: type, week,
          progress: { last_page: 1, visited: [] }, created: Date.now(), updated: Date.now() }
    sessions[s.session_id] = s
  } else {
    s.course_id = courseId; s.material_type = type || s.material_type
    if (week != null) s.week = week
    s.updated = Date.now()
  }
  const c = courses.find((x) => x.id === courseId)
  if (c) c.updated = Date.now()
  return s
}

// ---------------------------------------------------------------- 掌握度（和后端同样的规则）
const dayOf = (t: number) => new Date(t + 8 * 3600000).toISOString().slice(0, 10)
function mastery(list: Attempt[]): Json {
  const g = list.filter((a) => a.status === "correct" || a.status === "wrong").sort((a, b) => a.at - b.at || a.id - b.id)
  if (!g.length) return { status: "new", label: LABELS.new, note: "", attempts: 0, correct_days: 0, wrong: 0 }
  const correct = g.filter((a) => a.status === "correct")
  const cDays = new Set(correct.map((a) => dayOf(a.at)))
  const sDays = new Set(correct.filter((a) => a.evidence === "strong").map((a) => dayOf(a.at)))
  const last = g[g.length - 1]
  const streak = new Set<string>()
  for (let i = g.length - 1; i >= 0 && g[i].status !== "correct"; i--) streak.add(dayOf(g[i].at))
  let status: string, note: string
  if (last.status === "correct" && cDays.size >= 2 && sDays.size) [status, note] = ["mastered", `在 ${cDays.size} 个不同的日子答对过`]
  else if (last.status === "wrong" && streak.size >= 2) [status, note] = ["weak", `连续 ${streak.size} 天都答错了，建议补一补`]
  else if (last.status === "wrong") [status, note] = ["learning", "错了还不能说明不会，明天再试一次"]
  else if (!sDays.size) [status, note] = ["learning", "目前只有 AI 评分的简答题答对，再做一道选择或填空题确认"]
  else [status, note] = ["learning", "答对过，换一天再答对一次就算掌握"]
  return { status, label: LABELS[status], note, attempts: g.length, correct_days: cDays.size, wrong: g.length - correct.length,
           last_at: iso(last.at), last_status: last.status }
}
const kpAttempts = (id: number) => attempts.filter((a) => a.kp_ids.includes(id))

// ---------------------------------------------------------------- 出题和批改
function sampleItems(scope: string, sessionId: string): Json[] {
  if (scope === "diagnostic") {
    const seen = new Set(Object.values(exercises).filter((e) => e.session_id === sessionId).map((e) => e.question.toLowerCase()))
    const pool = [...data.SAMPLE_REMEDIAL, ...data.SAMPLE_EXERCISES].filter((e: Json) => e.type !== "short_answer")
      .sort((a: Json, b: Json) => Number(seen.has(a.question.toLowerCase())) - Number(seen.has(b.question.toLowerCase())))
    const out: Json[] = []; const usedKp = new Set<string>()
    for (const e of pool) {
      const k = e.kps[0].toLowerCase()
      if (usedKp.has(k)) continue
      usedKp.add(k); out.push({ ...e }); if (out.length >= 5) break
    }
    return out
  }
  let pages: number[] | null = null
  const m = scope.match(/^section-(\d+)$/)
  if (m) { const s = data.SAMPLE_SECTIONS[Number(m[1])]; if (s) pages = Array.from({ length: s.end - s.start + 1 }, (_, i) => s.start + i) }
  const items = data.SAMPLE_EXERCISES.filter((e: Json) => !pages || pages.includes(e.page))
  return (items.length ? items : data.SAMPLE_EXERCISES).map((e: Json) => ({ ...e }))
}

function genericItems(scope: string, doc: Doc): Json[] {
  const n = scope === "diagnostic" ? 5 : 3
  return Array.from({ length: n }, (_, i) => i === 2 && scope !== "diagnostic"
    ? { type: "short_answer", question: `Explain the main idea of "${doc.title}". (4 marks)`, answer: "A model answer would appear here.",
        key_points: ["main idea", "one example"], explanation: "预览模式的示例题。", page: 1 }
    : { type: "choice", question: `Preview question ${i + 1}: which option is correct?`,
        options: ["A. This one", "B. Not this", "C. Not this", "D. Not this"], answer: "A", explanation: "预览模式的示例题：答案是 A。", page: 1 })
}

function saveBatch(s: Session, scope: string, items: Json[]): Ex[] {
  const doc = docs[s.doc_id]
  const list = ensureKps(doc)
  const byName = new Map(list.map((k) => [k.name.toLowerCase(), k.id]))
  const batch = "b" + nid()
  return items.map((it) => {
    let ids = (it.kps || []).map((n: string) => byName.get(n.toLowerCase())).filter(Boolean) as number[]
    if (scope === "diagnostic") ids = ids.slice(0, 1)
    if (!ids.length) {
      const sec = doc.sections.findIndex((x: Json) => x.start <= (it.page || 1) && (it.page || 1) <= x.end)
      const k = list.find((x) => x.kind === "section" && x.section_index === sec) || list[0]
      if (k) ids = [k.id]
    }
    const e: Ex = { id: nid(), session_id: s.session_id, type: it.type, question: it.question, options: it.options || [],
      answer: it.answer, explanation: it.explanation || "", key_points: it.key_points || [], page_no: it.page || null,
      scope, batch, kp_ids: ids, answered: false }
    exercises[e.id] = e
    return e
  })
}

const kpRefs = (ids: number[]) => ids.map((id) => ({ id, name: kps.find((k) => k.id === id)?.name || "" }))
const publicEx = (e: Ex) => ({ id: e.id, type: e.type, question: e.question, options: e.options, page_no: e.page_no, lang: "en",
  kps: kpRefs(e.kp_ids), source_label: e.label || "", marks: e.marks ?? null })

// 课程知识点（按名字合并）：有课件 / 笔记时，只用它们的知识点
function knowledgeGroups(courseId: number): Json[] {
  const ss = courseSessions(courseId)
  const hasStudy = ss.some((s) => ["lecture", "notes"].includes(s.material_type))
  const groups = new Map<string, Json>()
  for (const s of ss) {
    if (hasStudy && !["lecture", "notes"].includes(s.material_type)) continue
    const d = docs[s.doc_id]
    for (const k of ensureKps(d)) {
      const key = k.name.toLowerCase()
      const g = groups.get(key) || { key, name: k.name, kind: k.kind, ids: [] as number[], sources: [] as Json[] }
      if (k.kind === "section") g.kind = "section"
      g.ids.push(k.id)
      g.sources.push({ session_id: s.session_id, title: d.title, week: s.week, material_type: s.material_type, page_start: k.page_start, page_end: k.page_end })
      groups.set(key, g)
    }
  }
  return [...groups.values()].map((g) => {
    const list = [...new Map(g.ids.flatMap((id: number) => kpAttempts(id)).map((a: Attempt) => [a.id, a])).values()] as Attempt[]
    const practiced = g.ids.filter((id: number) => kpAttempts(id).length)
    return { ...g, id: practiced[0] ?? g.ids[0], mastery: mastery(list) }
  })
}

function grade(e: Ex, answer: string): Json {
  const ua = (answer || "").trim()
  if (e.type === "choice") {
    const ok = !!ua && letter(ua) === letter(e.answer)
    return { status: ok ? "correct" : "wrong", score: ok ? 10 : 0, feedback: {}, error_reason: ok ? "" : "concept", graded_by: "rule", evidence: "strong" }
  }
  const ev = e.type === "short_answer" ? "weak" : "strong"
  if (!ua) return { status: "wrong", score: 0, feedback: { content: "没有作答。" }, error_reason: "", graded_by: "rule", evidence: ev }
  if (e.type === "blank") {
    const alts = (data.SAMPLE_BLANKS as Json)[e.question] || (data.REMEDIAL_BLANKS as Json)[e.question] || [e.answer]
    const ok = alts.map(norm).includes(norm(ua)) || norm(ua) === norm(e.answer)
    return { status: ok ? "correct" : "wrong", score: ok ? 10 : 0, feedback: ok ? {} : { content: `参考答案是 ${e.answer}。` },
             error_reason: ok ? "" : "term", graded_by: "keyword", evidence: "strong" }
  }
  const groups: string[][] = (data.SAMPLE_KEYWORDS as Json)[e.question] || [["the"], ["is"]]
  const hit = groups.map((g) => g.some((k) => ua.toLowerCase().includes(k)))
  const score = Math.round((hit.filter(Boolean).length / groups.length) * 10)
  const ok = score >= 6
  return { status: ok ? "correct" : "wrong", score, graded_by: "keyword", evidence: ev, error_reason: ok ? "" : "expression",
           feedback: { content: ok ? "答到了主要得分点。" : "还有得分点没答到，可以对照参考答案补上。（预览模式用关键词评分）",
                       language: "预览模式不检查英文表达；正式网站会帮你改英文。", improved: "" } }
}

function record(e: Ex, answer: string, g: Json, source: string): Attempt {
  touch()
  const a: Attempt = { id: nid(), exercise_id: e.id, kp_ids: e.kp_ids, status: g.status, evidence: g.evidence, error_reason: g.error_reason,
    error_reason_source: g.error_reason ? "ai" : "", source, at: Date.now(), user_answer: answer, feedback: g.feedback, score: g.score, graded_by: g.graded_by }
  attempts.push(a)
  return a
}

function resultView(e: Ex, a: Attempt): Json {
  return { exercise_id: e.id, attempt_id: a.id, user_answer: a.user_answer, correct_answer: e.answer, status: a.status,
    is_correct: a.status === "correct", score: a.score, feedback: a.feedback, explanation: e.explanation, page_no: e.page_no,
    key_points: e.key_points, evidence: a.evidence, graded_by: a.graded_by, error_reason: a.error_reason,
    error_reason_source: a.error_reason_source, kps: kpRefs(e.kp_ids) }
}

function wrongView(w: Wrong): Json {
  const e = exercises[w.exercise_id]
  const last = [...attempts].reverse().find((a) => a.exercise_id === e.id)
  return { id: w.id, exercise_id: e.id, session_id: e.session_id, page_no: e.page_no, question: e.question, question_type: e.type,
    options: e.options, correct_answer: e.answer, user_answer: w.user_answer, explanation: e.explanation, feedback: w.feedback,
    kps: kpRefs(e.kp_ids), error_reason: last?.error_reason || "", attempt_id: last?.id || null, box: w.box, mastered: w.mastered,
    review_count: w.review_count, next_review_at: iso(w.next_review_at), created_at: iso(w.created) }
}

// 预览模式：错题马上就能在「今日复习」里看到（正式网站是第二天）
const dueWrongs = (courseId?: number) => wrongs.filter((w) => !w.mastered && (w.next_review_at ?? 0) <= Date.now())
  .filter((w) => courseId == null || sessions[exercises[w.exercise_id].session_id]?.course_id === courseId)
function onePerKp(list: Wrong[]): Wrong[] {
  const seen = new Set<string>(); const out: Wrong[] = []
  for (const w of list) {
    const e = exercises[w.exercise_id]; const key = e.kp_ids.length ? String(e.kp_ids[0]) : "q" + e.id
    if (!seen.has(key)) { seen.add(key); out.push(w) }
  }
  return out
}

// ---------------------------------------------------------------- 视图
function sessionView(s: Session): Json {
  const d = docs[s.doc_id]
  const c = courses.find((x) => x.id === s.course_id)
  return { session_id: s.session_id, document_id: d.id, source_type: d.source_type, file_type: d.source_type, title: d.title, summary: "",
    page_count: d.pages.length, sections: d.sections, outline_ready: true, outline_fallback: false,
    pages: d.pages.map((p) => ({ page_no: p.page_no, title: p.title, has_image: false, image_kind: "", explained: !!p.explanation })),
    progress: { last_page: s.progress.last_page || 1, visited: s.progress.visited || [] }, diagnostic: s.progress.diagnostic || null,
    course: c ? { id: c.id, name: c.name, kind: c.kind } : null, material_type: s.material_type, week: s.week,
    style_summary: styleSummary(), personal_style: false }
}

function courseSessions(id: number) { return Object.values(sessions).filter((s) => s.course_id === id) }
function dueBySession(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const w of onePerKp(dueWrongs())) { const sid = exercises[w.exercise_id].session_id; out[sid] = (out[sid] || 0) + 1 }
  return out
}
function courseView(c: Json): Json {
  const ss = courseSessions(c.id); const due = dueBySession()
  const last = Math.max(0, ...ss.map((s) => s.updated))
  return { id: c.id, name: c.name, code: c.code, exam_date: c.exam_date, kind: c.kind, material_count: ss.length,
    due: ss.reduce((n, s) => n + (due[s.session_id] || 0), 0), last_studied_at: last ? iso(last) : null, created_at: iso(c.created) }
}


// ---------------------------------------------------------------- 3.0 个性化（预览版的简化实现）
const QUESTIONS = [
  { key: "goal", title: "这门课你的目标是？", default: "good", options: [
    { value: "pass", label: "及格就好", hint: "只盯最常考的点" }, { value: "good", label: "想拿 B 左右", hint: "常考的点都要会" },
    { value: "top", label: "冲 A", hint: "每个知识点都覆盖" }] },
  { key: "english", title: "看英文课件的感觉？", default: "mid", options: [
    { value: "low", label: "基本看不懂", hint: "讲解全用中文，关键句逐句翻译" }, { value: "mid", label: "能看懂大概，细节吃力", hint: "中文讲解，术语中英对照" },
    { value: "high", label: "英文基本没问题", hint: "少翻译，多讲考点和易错点" }] },
  { key: "style", title: "你更喜欢怎么学？", default: "example", options: [
    { value: "example", label: "先看例子", hint: "先用生活中的例子带入" }, { value: "definition", label: "先看定义", hint: "先给中英对照的准确定义" },
    { value: "practice", label: "先做题，错了再学", hint: "路线里先练题，再回课件" }] },
  { key: "minutes", title: "每天大概能花多少时间？", default: "30", options: [
    { value: "15", label: "15 分钟", hint: "每天 2 步" }, { value: "30", label: "30 分钟", hint: "每天 3 步" }, { value: "60", label: "1 小时", hint: "每天 5 步" }] },
  { key: "length", title: "讲解想要多长？", default: "normal", options: [
    { value: "short", label: "越短越好", hint: "只讲重点" }, { value: "normal", label: "适中", hint: "" }, { value: "detailed", label: "讲细一点", hint: "多讲为什么" }] },
]
let answers: Record<string, string> = Object.fromEntries(QUESTIONS.map((q) => [q.key, q.default]))
let profileDone = false
const activity = new Map<string, number>()
const todayKey = () => dayOf(Date.now())
const touch = () => activity.set(todayKey(), (activity.get(todayKey()) || 0) + 1)
const label = (k: string) => QUESTIONS.find((q) => q.key === k)!.options.find((o) => o.value === answers[k])!.label
function styleSummary() { return [answers.english === "low" ? "英文从中文讲起" : label("english"), label("style"), label("length")].join(" · ") }
function profileView() { return { questions: QUESTIONS, answers, completed: profileDone, style_summary: styleSummary(), updated_at: null } }
function streakDays() {
  let n = 0; let t = Date.now()
  if (!activity.get(dayOf(t))) t -= DAY
  while (activity.get(dayOf(t))) { n++; t -= DAY }
  return n
}
const routePlans = new Map<string, Json[]>()

function routeCandidates(c: Json): Json[] {
  const ss = courseSessions(c.id); const out: Json[] = []
  const add = (prio: number, st: Json) => out.push({ ...st, prio })
  if (!ss.length) { add(0, { key: "add", kind: "add", title: "把这门课的第一份资料放进来", minutes: 2, reason: "路线要根据你的课件和题目来排", action: { type: "tab", tab: "materials" } }); return out }
  const due = onePerKp(dueWrongs(c.id)).length
  if (due) add(0, { key: "review", kind: "review", title: `复习 ${due} 道到期的错题`, minutes: Math.min(10, 2 * due), reason: "按遗忘曲线，这些题今天该再做一次了", action: { type: "tab", tab: "review" } })
  const exam = handle("GET", `/courses/${c.id}/exam`, new URLSearchParams(), {})
  for (const m of exam.materials) if (!m.ready) add(5, { key: `build:${m.session_id}`, kind: "build_bank", title: `把「${m.title}」整理成题库`, minutes: 1, reason: "整理好之后，才能算出哪些知识点最常考", action: { type: "build_bank", session_id: m.session_id } })
  const hot = new Map<string, Json>(exam.hot.map((h: Json) => [h.name, h]))
  for (const g of knowledgeGroups(c.id)) {
    const st = g.mastery.status; if (st === "mastered") continue
    const h = hot.get(g.name); const n = h ? h.exam_count : 0
    if (answers.goal === "pass" && hot.size && !n) continue
    const hotTxt = n ? `往年考了 ${n} 次${h.marks ? `（${h.marks} 分）` : ""}` : ""
    if (st === "learning" || st === "weak") {
      const why = [hotTxt, g.mastery.last_status === "wrong" ? "你上次答错了" : g.mastery.note].filter(Boolean).join("；")
      if (h && answers.style === "practice") add(14 - Math.min(n, 4), { key: `bank:${g.name}`, kind: "bank", title: `练原题：${g.name}`, minutes: 8, reason: why + "；你选了「先做题」，所以先练题", kp_ids: g.ids, action: { type: "practice", ...h.practice } })
      else add(14 - Math.min(n, 4), { key: `remedial:${g.name}`, kind: "remedial", title: `补一补：${g.name}`, minutes: 5, reason: why + "；先看一段短讲解，再做一道新题", kp_ids: g.ids, action: { type: "remedial", kp_id: g.id, name: g.name } })
    } else if (n && h) {
      add(20 - Math.min(n * 2, 10), { key: `bank:${g.name}`, kind: "bank", title: `练原题：${g.name}`, minutes: 8, reason: hotTxt + "，你还没练过", kp_ids: g.ids, action: { type: "practice", ...h.practice } })
    } else if (answers.goal === "top" && g.kind !== "section") {
      add(45, { key: `remedial:${g.name}`, kind: "remedial", title: `补一补：${g.name}`, minutes: 5, reason: "你的目标是冲 A，每个知识点都要过一遍", kp_ids: g.ids, action: { type: "remedial", kp_id: g.id, name: g.name } })
    }
  }
  ss.filter((s) => ["lecture", "notes"].includes(s.material_type)).forEach((s, i) => {
    const d = docs[s.doc_id]
    if (s.progress.finished) {
      if (!s.progress.diagnostic) add(12, { key: `diag:${s.session_id}`, kind: "diagnostic", title: `诊断小测：${d.title}`, minutes: 3, reason: "这一讲学完了，5 道题看看哪里还没懂", action: { type: "practice", session_id: s.session_id, scope: "diagnostic" } })
      return
    }
    const v = (s.progress.visited || []).length
    add(30 + i + (answers.style === "practice" ? 10 : 0), { key: `study:${s.session_id}`, kind: "study", title: `学 ${s.week != null ? `第 ${s.week} 周 · ` : ""}${d.title}`, minutes: answers.length === "short" ? 10 : 15,
      reason: (v ? `看到第 ${s.progress.last_page || 1} / ${d.pages.length} 页` : "还没开始学") + (i === 0 ? "，按周顺序这是下一讲" : ""), action: { type: "study", session_id: s.session_id }, base: v })
  })
  const nWords = words.filter((w) => !w.mastered).length
  if (nWords) add(answers.english === "low" ? 15 : 40, { key: "words", kind: "words", title: `背 ${nWords} 张术语卡片`, minutes: Math.min(8, nWords), reason: "收藏的术语到复习时间了", action: { type: "page", page: "review" } })
  return out.sort((a, b) => a.prio - b.prio)
}

function stepDone(st: Json, c: Json): boolean {
  const today = attempts.filter((a) => dayOf(a.at) === todayKey())
  if (st.kind === "review") return onePerKp(dueWrongs(c.id)).length === 0
  if (st.kind === "words") return words.every((w) => w.mastered)
  if (st.kind === "add") return courseSessions(c.id).length > 0
  if (st.kind === "build_bank") return !!sessions[st.action.session_id]?.progress.bank
  if (st.kind === "diagnostic") return !!sessions[st.action.session_id]?.progress.diagnostic
  if (st.kind === "study") { const s = sessions[st.action.session_id]; return !!s && (!!s.progress.finished || (s.progress.visited || []).length >= (st.base || 0) + 5) }
  const ids = new Set<number>(st.kp_ids || [])
  return today.some((a) => (st.kind === "bank" ? a.source === "bank" : a.source !== "bank") && a.kp_ids.some((k) => ids.has(k)))
}

function routeView(c: Json, extra = 0): Json {
  const key = `${c.id}:${todayKey()}`
  const cands = routeCandidates(c)
  const per = { "15": 2, "30": 3, "60": 5 }[answers.minutes] || 3
  if (!routePlans.has(key)) routePlans.set(key, cands.slice(0, per))
  let steps = routePlans.get(key)!
  const want = Math.max(per - steps.length, 0) + extra
  if (want) { const have = new Set(steps.map((x) => x.key)); steps = [...steps, ...cands.filter((x) => !have.has(x.key)).slice(0, want)]; routePlans.set(key, steps) }
  const today = steps.map((x) => ({ ...x, done: stepDone(x, c) }))
  const keys = new Set(steps.map((x) => x.key))
  return { day: todayKey(), today, later: cands.filter((x) => !keys.has(x.key)).slice(0, 5).map((x) => ({ ...x, done: false })),
    done: today.filter((x) => x.done).length, total: today.length, minutes: today.filter((x) => !x.done).reduce((n, x) => n + x.minutes, 0),
    streak: streakDays(), days_left: null, sprint: false, exam_date: c.exam_date, profile_completed: profileDone, style_summary: styleSummary(), per_day: per }
}

// ---------------------------------------------------------------- 路由
class HttpError extends Error { constructor(public status: number, public code: string, msg: string) { super(msg) } }
const notFound = (what = "找不到这条记录") => new HttpError(404, "not_found", what)
const quota = () => ({ used, limit: 60, remaining: 60 - used, own_key: !!keyMasked, free_models: ["Gemini", "GLM"] })

function handle(method: string, path: string, query: URLSearchParams, body: Json): Json {
  let m: RegExpMatchArray | null
  const M = (re: RegExp) => (m = path.match(re))

  // 3.0 个性化
  if (path === "/me/profile") {
    if (method === "PUT") { answers = { ...answers, ...(body.answers || {}) }; profileDone = true; routePlans.clear() }
    return profileView()
  }
  if (path === "/me/portrait") {
    const graded = attempts.filter((a) => a.status === "correct" || a.status === "wrong")
    const cal = Array.from({ length: 28 }, (_, i) => { const d = dayOf(Date.now() - (27 - i) * DAY); return { day: d, count: activity.get(d) || 0 } })
    const counts: Record<string, number> = {}
    for (const a of attempts) if (a.status === "wrong" && a.error_reason) counts[a.error_reason] = (counts[a.error_reason] || 0) + 1
    const weak: Json[] = []
    const cs = courses.map((c) => { const gs = knowledgeGroups(c.id); for (const g of gs) if (["weak", "learning"].includes(g.mastery.status) && g.mastery.wrong) weak.push({ name: g.name, course: c.name, status: g.mastery.status, label: g.mastery.label, wrong: g.mastery.wrong })
      return { id: c.id, name: c.name, kind: c.kind, total: gs.length, mastered: gs.filter((g) => g.mastery.status === "mastered").length,
               learning: gs.filter((g) => ["learning", "weak"].includes(g.mastery.status)).length, days_left: null } }).filter((c) => c.total)
    const adapt = [
      { low: "讲解全部用中文，并把每页最关键的英文句子逐句翻译", mid: "讲解用中文，术语中英对照", high: "讲解少翻译，多讲考点和容易丢分的地方" }[answers.english]!,
      { example: "每页先用生活中的例子带入，再讲定义", definition: "每页先给中英对照的定义，例子放在最后", practice: "每页先告诉你考什么；路线里先练题，错了再回课件" }[answers.style]!,
      { short: "讲解只讲 2–3 个重点", normal: "讲解长度适中", detailed: "讲解写得更细，多讲为什么" }[answers.length]!,
      `每天的路线安排 ${{ "15": 2, "30": 3, "60": 5 }[answers.minutes]} 步，大约 ${answers.minutes} 分钟`,
      { pass: "路线只盯往年最常考的知识点，不常考的先放一放", good: "路线优先常考的知识点，其他的穿插着学", top: "路线覆盖每一个知识点，还会多安排简答题" }[answers.goal]!,
    ]
    return { streak: streakDays(), calendar: cal, active_days: cal.filter((d) => d.count).length, answered: graded.length,
      accuracy: graded.length ? Math.round(graded.filter((a) => a.status === "correct").length / graded.length * 100) : null,
      reasons: Object.entries(REASONS).map(([key, label]) => ({ key, label, count: counts[key] || 0 })), weak: weak.slice(0, 5), courses: cs,
      adaptations: adapt, style_summary: styleSummary(), profile_completed: profileDone }
  }
  if (M(/^\/courses\/(\d+)\/route(\/more|\/reset)?$/)) {
    const c = courses.find((x) => x.id === Number(m![1])); if (!c) throw notFound("找不到这门课")
    if (m![2] === "/reset") routePlans.delete(`${c.id}:${todayKey()}`)
    return routeView(c, m![2] === "/more" ? 1 : 0)
  }

  // 身份
  if (path === "/auth/anonymous") return { token: "preview-token", user: { id: 1, email: "", is_anonymous: true } }
  if (path === "/auth/mode") return { anonymous: true, account: false }
  if (path === "/auth/me") return method === "GET" ? { id: 1, email: "", grade: "", major: "", subject: "", is_anonymous: true } : { status: "ok" }
  if (path === "/auth/recovery-code") return method === "GET" ? { has_code: false, created_at: null } : { code: "PREV-IEW2-MODE-ONLY" }
  if (path === "/auth/recover") throw new HttpError(400, "bad_request", "预览模式不能用找回码，请在正式网站上试。")
  if (path === "/health") return { status: "ok" }
  if (path === "/user/stats") return { sessions: Object.keys(sessions).length, total_exercises: attempts.length, wrong_count: wrongs.filter((w) => !w.mastered).length,
    accuracy: attempts.length ? Math.round(attempts.filter((a) => a.status === "correct").length / attempts.length * 100) : 0, favorite_vocab: words.length }
  if (path === "/user/vocabulary") return { words: words.map((w) => ({ id: w.id, word: w.word, translation: w.translation, example: "" })) }
  if (path.startsWith("/preferences") || path.startsWith("/profile")) return { id: 1, show_english: true, show_practice: true, show_wrong_book: true, grade: "", major: "", subject: "" }
  if (path === "/settings/api-key/status") return { configured: true, source: keyMasked ? "user" : "free", masked: keyMasked, user_provider: keyMasked ? "DeepSeek" : "", free_models: ["Gemini", "GLM"] }
  if (path === "/settings/api-key") {
    if (method === "DELETE") { keyMasked = ""; return { status: "ok" } }
    const k = String(body?.api_key || "")
    if (!/^(sk-|AIza)/.test(k)) throw new HttpError(400, "bad_request", "Key 格式不对：DeepSeek 以 sk- 开头，Gemini 以 AIza 开头")
    keyMasked = k.slice(0, 5) + "…" + k.slice(-4)
    return { status: "ok", message: "", masked: keyMasked, provider: k.startsWith("sk-") ? "DeepSeek" : "Gemini" }
  }

  // 课程
  if (path === "/courses" && method === "GET") {
    const out = courses.map(courseView).filter((c) => !(c.kind === "inbox" && !c.material_count))
    const order: Record<string, number> = { normal: 0, inbox: 1, sample: 2 }
    out.sort((a, b) => order[a.kind] - order[b.kind] || String(b.last_studied_at || b.created_at).localeCompare(String(a.last_studied_at || a.created_at)))
    return { courses: out }
  }
  if (path === "/courses" && method === "POST") {
    const name = String(body?.name || "").trim()
    if (!name) throw new HttpError(400, "bad_request", "请输入课程名")
    const c = { id: nid(), name, code: body.code || "", exam_date: body.exam_date || "", kind: "normal", created: Date.now(), updated: Date.now() }
    courses.push(c)
    return courseView(c)
  }
  if (path === "/courses/sample") {
    const c = special("sample"); const doc = docs[SAMPLE_DOC]; ensureKps(doc)
    if (!Object.values(sessions).some((x) => x.doc_id === SAMPLE_EXAM)) getSession(docs[SAMPLE_EXAM], c.id, "past_exam", null)
    const s = getSession(doc, c.id, "lecture", 3)
    return { course: courseView(c), session_id: s.session_id }
  }
  if (M(/^\/courses\/(\d+)\/bank\/([^/]+)$/)) {
    const c = courses.find((x) => x.id === Number(m![1])); const s = sessions[m![2]]
    if (!c || !s || s.course_id !== c.id) throw notFound("这门课里没有这份资料")
    if (!["tutorial", "past_exam"].includes(s.material_type)) throw new HttpError(400, "bad_request", "只有 Tutorial 和往年考试题可以整理成题库。")
    const existing = Object.values(exercises).filter((e) => e.session_id === s.session_id && e.scope === "bank")
    if (existing.length && query.get("force") !== "1") return { count: existing.length, reused: true }
    for (const e of existing) e.scope = "bank_old"
    const groups = knowledgeGroups(c.id)
    const byName = new Map(groups.map((g) => [g.key, g.ids[0]]))
    const items = s.doc_id === SAMPLE_EXAM
      ? data.SAMPLE_BANK.map((q: Json) => ({ ...q }))
      : genericItems("all", docs[s.doc_id]).map((q, i) => ({ ...q, label: `Q${i + 1}`, marks: q.type === "short_answer" ? 6 : 2 }))
    const batch = "b" + nid()
    let mapped = 0
    for (const it of items) {
      const ids = s.doc_id === SAMPLE_EXAM
        ? it.kps.map((n: string) => byName.get(n.toLowerCase())).filter(Boolean).slice(0, 2)
        : groups.length ? [groups[0].ids[0]] : []
      if (ids.length) mapped++
      const e: Ex = { id: nid(), session_id: s.session_id, type: it.type, question: it.question, options: it.options || [], answer: it.answer,
        explanation: it.explanation || "", key_points: it.key_points || [], page_no: it.page || null, scope: "bank", batch, kp_ids: ids,
        answered: false, label: it.label, marks: it.marks ?? null }
      exercises[e.id] = e
    }
    s.progress = { ...s.progress, bank: { count: items.length, at: new Date().toISOString() } }
    return { count: items.length, reused: false, mapped }
  }
  if (M(/^\/courses\/(\d+)\/exam$/)) {
    const c = courses.find((x) => x.id === Number(m![1])); if (!c) throw notFound("找不到这门课")
    const ss = courseSessions(c.id)
    const groups = knowledgeGroups(c.id)
    const idToGroup = new Map<number, Json>(); for (const g of groups) for (const id of g.ids) idToGroup.set(id, g)
    const bank = Object.values(exercises).filter((e) => e.scope === "bank" && ss.some((s) => s.session_id === e.session_id))
    const done = new Set(attempts.map((a) => a.exercise_id))
    const materials = ss.filter((s) => ["tutorial", "past_exam"].includes(s.material_type)).map((s) => {
      const mine = bank.filter((e) => e.session_id === s.session_id)
      return { session_id: s.session_id, title: docs[s.doc_id].title, material_type: s.material_type, type_label: TYPES[s.material_type], week: s.week,
        page_count: docs[s.doc_id].pages.length, ready: !!s.progress.bank, count: mine.length, done: mine.filter((e) => done.has(e.id)).length,
        marks: mine.reduce((n, e) => n + (e.marks || 0), 0), is_sample: s.doc_id === SAMPLE_EXAM }
    })
    const stats = new Map<string, Json>()
    for (const e of bank) {
      const mtype = sessions[e.session_id].material_type; const seen = new Set<string>()
      for (const id of e.kp_ids) {
        const g = idToGroup.get(id); if (!g || seen.has(g.key)) continue
        seen.add(g.key)
        const st = stats.get(g.key) || { exam: 0, tutorial: 0, marks: 0, by: {} as Record<string, number> }
        if (mtype === "past_exam") { st.exam++; st.marks += e.marks || 0 } else st.tutorial++
        st.by[e.session_id] = (st.by[e.session_id] || 0) + 1
        stats.set(g.key, st)
      }
    }
    const hot = groups.filter((g) => stats.has(g.key)).map((g) => {
      const st = stats.get(g.key); const sid = Object.keys(st.by).sort((a, b) => st.by[b] - st.by[a])[0]
      const study = g.sources.find((x: Json) => ["lecture", "notes"].includes(x.material_type)) || g.sources[0]
      return { id: g.id, name: g.name, kind: g.kind, status: g.mastery.status, label: g.mastery.label, note: g.mastery.note,
        exam_count: st.exam, tutorial_count: st.tutorial, marks: st.marks, practice: { session_id: sid, scope: `bank-kp:${g.name}` },
        study: study ? { session_id: study.session_id, page_start: study.page_start } : null }
    }).sort((a, b) => b.exam_count - a.exam_count || b.marks - a.marks || b.tutorial_count - a.tutorial_count)
    return { exam_date: c.exam_date, days_left: null, materials, hot, plan: null,
             has_study_material: ss.some((s) => ["lecture", "notes"].includes(s.material_type)), question_count: bank.length }
  }
  if (M(/^\/courses\/(\d+)(\/knowledge)?$/)) {
    const c = courses.find((x) => x.id === Number(m![1])); if (!c) throw notFound("找不到这门课")
    if (m![2]) {
      const out = knowledgeGroups(c.id).map((g) => ({ id: g.id, name: g.name, kind: g.kind, sources: g.sources, due_today: false, ...g.mastery }))
      const order: Record<string, number> = { weak: 0, learning: 1, new: 2, mastered: 3 }
      out.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))
      const counts = Object.fromEntries(Object.keys(order).map((k) => [k, out.filter((x) => x.status === k).length]))
      return { knowledge_points: out, counts }
    }
    if (method === "PATCH") { Object.assign(c, Object.fromEntries(Object.entries(body).filter(([, v]) => v != null))); if (c.kind === "inbox" && body.name) c.kind = "normal"; return { status: "ok" } }
    if (method === "DELETE") {
      if (courseSessions(c.id).length) throw new HttpError(400, "course_not_empty", "这门课里还有资料。先把资料移到别的课程，再删除。")
      courses.splice(courses.indexOf(c), 1); return { status: "ok" }
    }
    const due = dueBySession()
    const materials = courseSessions(c.id).map((s) => {
      const d = docs[s.doc_id]; const visited = s.progress.visited || []
      return { session_id: s.session_id, title: d.title, material_type: s.material_type, type_label: TYPES[s.material_type], week: s.week,
        source_type: d.source_type, page_count: d.pages.length, last_page: s.progress.last_page || 1, visited: visited.length,
        finished: !!s.progress.finished, diagnostic: s.progress.diagnostic || null, due: due[s.session_id] || 0, updated_at: iso(s.updated) }
    }).sort((a, b) => (a.week ?? 999) - (b.week ?? 999) || String(a.updated_at).localeCompare(String(b.updated_at)))
    const recent = [...materials].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]
    return { ...courseView(c), materials, continue_session_id: recent?.session_id || null,
             types: Object.entries(TYPES).map(([key, label]) => ({ key, label })) }
  }

  // 学习
  if (path === "/study/quota") return quota()
  if (path === "/study/history") return { sessions: Object.values(sessions).map((s) => ({ session_id: s.session_id, topic: docs[s.doc_id].title, legacy: false, created_at: iso(s.updated), last_page: s.progress.last_page })) }
  if (path === "/study/upload") {
    const f: File | null = body instanceof FormData ? (body.get("file") as File) : null
    const title = (f?.name || "课件").replace(/\.[^.]+$/, "")
    const courseId = Number(body.get("course_id")) || special("inbox").id
    const week = body.get("week") ? Number(body.get("week")) : null
    const doc = makeDoc(title, "file", 6)
    return { ...sessionView(getSession(doc, courseId, String(body.get("material_type") || "lecture"), week)), reused: false }
  }
  if (path === "/study/topic") {
    const doc = makeDoc(String(body.topic || "话题"), "topic", 4)
    return sessionView(getSession(doc, body.course_id || special("inbox").id, "notes", body.week ?? null))
  }
  if (path === "/study/sample") { const c = special("sample"); return sessionView(getSession(docs[SAMPLE_DOC], c.id, "lecture", 3)) }
  if (M(/^\/study\/([^/]+)(\/.*)?$/)) {
    const s = sessions[m![1]]; if (!s) throw notFound("这条学习记录不存在")
    const rest = m![2] || ""
    const doc = docs[s.doc_id]
    let p: RegExpMatchArray | null
    if (rest === "" || rest === "/outline") return sessionView(s)
    if (rest === "/progress") {
      const v = new Set<number>(s.progress.visited || []); v.add(Number(body.page_no))
      s.progress = { ...s.progress, last_page: Number(body.page_no), visited: [...v].sort((a, b) => a - b) }
      if (Number(body.page_no) >= doc.pages.length) s.progress.finished = true
      s.updated = Date.now(); touch(); return { status: "ok" }
    }
    if (rest === "/meta") {
      if (body.course_id != null) s.course_id = body.course_id
      if (body.material_type) s.material_type = body.material_type
      if (body.clear_week) s.week = null; else if (body.week != null) s.week = body.week
      return { status: "ok" }
    }
    if (rest === "/knowledge") return { knowledge_points: ensureKps(doc).map((k) => ({ ...k, ...mastery(kpAttempts(k.id)) })) }
    if (rest === "/export") return { title: doc.title, sections: doc.sections, pages: doc.pages }
    if ((p = rest.match(/^\/pages\/(\d+)(\/\w+)?$/))) {
      const page = doc.pages.find((x) => x.page_no === Number(p![1])); if (!page) throw notFound("这一页不存在。")
      const key = `${s.session_id}:${page.page_no}`
      if (p[2] === "/image") throw notFound()
      if (p[2] === "/explain") {
        const cached = !!page.explanation
        if (!page.explanation) { page.explanation = genericExplanation(doc.title, page.page_no); used++ }
        ensureKps(doc)
        return { page_no: page.page_no, explanation: page.explanation, cached }
      }
      if (p[2] === "/ask") {
        used++
        const answer = `（预览模式的示例回答）你问的是「${String(body.question).slice(0, 40)}」。正式网站会只围绕这一页回答，先给结论，再用生活中的例子解释。`
        chats[key] = [...(chats[key] || []), { role: "user", content: body.question }, { role: "assistant", content: answer }]
        return { answer }
      }
      if (p[2] === "/chat") { chats[key] = []; return { status: "ok" } }
      return { page_no: page.page_no, title: page.title, text: page.text, notes: "", has_image: false, image_kind: "",
               explanation: page.explanation, chat: chats[key] || [] }
    }
  }

  // 练习
  if (path === "/practice/error-reasons") return { reasons: Object.entries(REASONS).map(([key, label]) => ({ key, label })) }
  if (path === "/practice/wrong-book") return { entries: wrongs.filter((w) => !w.mastered).map(wrongView).reverse() }
  if (M(/^\/practice\/wrong-book\/(\d+)$/)) { const w = wrongs.find((x) => x.id === Number(m![1])); if (!w) throw notFound(); w.mastered = true; return { status: "ok" } }
  if (M(/^\/practice\/attempts\/(\d+)$/)) {
    const a = attempts.find((x) => x.id === Number(m![1])); if (!a) throw notFound()
    a.error_reason = body.error_reason || ""; a.error_reason_source = a.error_reason ? "user" : ""
    return { status: "ok", error_reason: a.error_reason }
  }
  if (path === "/practice/retry-wrong") {
    const e = exercises[Number(body.exercise_ids?.[0])]; if (!e) throw notFound("没有找到这些错题")
    const s = sessions[e.session_id]; const doc = docs[s.doc_id]
    const saved = saveBatch(s, "retry", doc.id === SAMPLE_DOC ? sampleItems("all", s.session_id) : genericItems("all", doc))
    return { session_id: s.session_id, scope: "retry", exercises: saved.map(publicEx) }
  }
  if (M(/^\/practice\/generate\/([^/]+)$/)) {
    const s = sessions[m![1]]; if (!s) throw notFound()
    const scope = query.get("scope") || "all"; const fresh = query.get("fresh") === "1"
    if (scope === "bank" || scope.startsWith("bank-kp:")) {
      let items = Object.values(exercises).filter((e) => e.session_id === s.session_id && e.scope === "bank")
      if (scope.startsWith("bank-kp:")) {
        const want = scope.slice(8).toLowerCase()
        items = items.filter((e) => e.kp_ids.some((id) => kps.find((k) => k.id === id)?.name.toLowerCase() === want))
      }
      if (!items.length) throw notFound("还没有题库。先在课程的「考试」页把这份资料整理成题库。")
      return { session_id: s.session_id, scope, reused: true, exercises: items.map(publicEx) }
    }
    if (!fresh) {
      const open = Object.values(exercises).filter((e) => e.session_id === s.session_id && e.scope === scope && !e.answered)
      if (open.length) { const b = open[open.length - 1].batch; return { session_id: s.session_id, scope, reused: true, exercises: open.filter((e) => e.batch === b).map(publicEx) } }
    }
    const doc = docs[s.doc_id]
    if (doc.id !== SAMPLE_DOC) used++
    const saved = saveBatch(s, scope, doc.id === SAMPLE_DOC ? sampleItems(scope, s.session_id) : genericItems(scope, doc))
    return { session_id: s.session_id, scope, reused: false, exercises: saved.map(publicEx) }
  }
  if (M(/^\/practice\/submit\/([^/]+)$/)) {
    const s = sessions[m![1]]; if (!s) throw notFound()
    const results: Json[] = []; let diag = false
    for (const item of body.answers || []) {
      const e = exercises[Number(item.exercise_id)]; if (!e || results.some((r) => r.exercise_id === e.id)) continue
      const prior = e.scope === "bank" ? undefined : attempts.find((a) => a.exercise_id === e.id && ["practice", "remedial", "diagnostic"].includes(a.source))
      let a = prior
      if (!a) {
        const g = grade(e, String(item.answer || ""))
        a = record(e, String(item.answer || ""), g, ["remedial", "diagnostic", "bank"].includes(e.scope) ? e.scope : "practice")
        e.answered = true
        if (g.status === "wrong" && !wrongs.some((w) => w.exercise_id === e.id))
          wrongs.push({ id: nid(), exercise_id: e.id, user_answer: a.user_answer, feedback: g.feedback, box: 0, mastered: false, next_review_at: Date.now(), review_count: 0, created: Date.now() })
      }
      if (e.scope === "diagnostic") diag = true
      results.push(resultView(e, a))
    }
    const correct = results.filter((r) => r.status === "correct").length; const wrong = results.filter((r) => r.status === "wrong").length
    if (diag) s.progress = { ...s.progress, diagnostic: { correct, total: correct + wrong, at: new Date().toISOString() } }
    return { total: results.length, correct, wrong, ungraded: 0, score: correct + wrong ? Math.round(correct / (correct + wrong) * 100) : 0, results }
  }
  if (M(/^\/practice\/([^/]+)$/)) {
    const list = Object.values(exercises).filter((e) => e.session_id === m![1])
    const b = list[list.length - 1]?.batch
    return { session_id: m![1], exercises: list.filter((e) => e.batch === b).map(publicEx) }
  }

  // 复习
  const cid = query.get("course_id") ? Number(query.get("course_id")) : undefined
  if (path === "/review/summary") return { questions_due: onePerKp(dueWrongs(cid)).length, words_due: words.filter((w) => !w.mastered).length, open_wrong: wrongs.filter((w) => !w.mastered).length, total_words: words.length }
  if (path === "/review/today") {
    const due = dueWrongs(cid); const picked = onePerKp(due)
    return { questions: picked.map((w) => { const v = wrongView(w); for (const k of ["correct_answer", "explanation", "user_answer", "feedback", "error_reason", "attempt_id"]) delete v[k]; return v }),
             words: cid != null ? [] : words.filter((w) => !w.mastered), postponed: due.length - picked.length }
  }
  if (M(/^\/review\/questions\/(\d+)$/)) {
    const w = wrongs.find((x) => x.id === Number(m![1])); if (!w) throw notFound("错题不存在")
    const e = exercises[w.exercise_id]; const g = grade(e, String(body.answer || "")); const a = record(e, String(body.answer || ""), g, "review")
    w.review_count++
    if (g.status === "correct") { w.box++; w.next_review_at = Date.now() + [1, 2, 4, 7, 15, 30][Math.min(w.box, 5)] * DAY; if (w.box >= 6) w.mastered = true }
    else { w.box = 0; w.next_review_at = Date.now() + DAY }
    return { ...resultView(e, a), mastered: w.mastered, next_review_at: iso(w.next_review_at) }
  }
  if (path === "/review/knowledge") {
    const ids = [...new Set(attempts.flatMap((a) => a.kp_ids))]
    return { knowledge_points: ids.map((id) => {
      const k = kps.find((x) => x.id === id)!; const s = Object.values(sessions).find((x) => x.doc_id === k.doc_id)
      return { ...k, course: docs[k.doc_id].title, session_id: s?.session_id, due_today: false, ...mastery(kpAttempts(id)) }
    }) }
  }
  if (M(/^\/review\/kp\/(\d+)\/remedial$/)) {
    const k = kps.find((x) => x.id === Number(m![1])); if (!k) throw notFound("找不到这个知识点")
    const s = Object.values(sessions).find((x) => x.doc_id === k.doc_id)!
    const doc = docs[k.doc_id]
    const seen = new Set(Object.values(exercises).filter((e) => e.session_id === s.session_id).map((e) => e.question.toLowerCase()))
    const pool = doc.id === SAMPLE_DOC
      ? [...data.SAMPLE_REMEDIAL, ...data.SAMPLE_EXERCISES.filter((e: Json) => e.type !== "short_answer")]
      : genericItems("diagnostic", doc).map((x) => ({ ...x, kps: [k.name] }))
    const want = k.name.toLowerCase()
    const q = pool.find((e: Json) => e.kps?.some((n: string) => n.toLowerCase() === want) && !seen.has(e.question.toLowerCase()))
      || pool.find((e: Json) => !seen.has(e.question.toLowerCase())) || pool[0]
    const [e] = saveBatch(s, "remedial", [{ ...q, kps: [k.name] }])
    const page = doc.pages.find((x) => x.page_no === (k.page_start || 1))
    const ex = page?.explanation || genericExplanation(doc.title, 1)
    return { kp: { id: k.id, name: k.name }, session_id: s.session_id, explanation: `${ex.summary}\n\n${ex.explanation}`, exercise: publicEx(e) }
  }
  if (path === "/review/words" && method === "GET") return { words }
  if (path === "/review/words" && method === "POST") {
    const ex = words.find((w) => w.word.toLowerCase() === String(body.word).toLowerCase())
    if (ex) return ex
    const w = { id: nid(), word: body.word, translation: body.translation || "", note: body.note || "", example: "", session_id: body.session_id || "",
      page_no: body.page_no ?? null, box: 0, mastered: false, next_review_at: null }
    words.push(w); return w
  }
  if (M(/^\/review\/words\/(\d+)(\/review)?$/)) {
    const w = words.find((x) => x.id === Number(m![1])); if (!w) throw notFound()
    if (m![2]) { w.box = body.remembered ? w.box + 1 : 0; return w }
    words.splice(words.indexOf(w), 1); return { status: "ok" }
  }
  throw notFound()
}

// ---------------------------------------------------------------- 接管 fetch / XMLHttpRequest
function respond(method: string, url: string, body: Json): { status: number; text: string } {
  const u = new URL(url, "https://preview.local")
  const path = u.pathname.replace(/^\/api/, "")
  let parsed = body
  if (typeof body === "string") { try { parsed = JSON.parse(body) } catch { parsed = {} } }
  try {
    return { status: 200, text: JSON.stringify(handle(method.toUpperCase(), path, u.searchParams, parsed ?? {})) }
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, text: JSON.stringify({ detail: e.message, code: e.code }) }
    console.error(e)
    return { status: 500, text: JSON.stringify({ detail: "预览模式出错了", code: "server_error" }) }
  }
}

const isApi = (url: string) => url.startsWith("/api/") || url.startsWith("/api?") || url === "/api"
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!isApi(url)) return realFetch(input, init)
  await new Promise((r) => setTimeout(r, 180))   // 模拟一点网络延迟，好看到加载状态
  const r = respond(init?.method || "GET", url, init?.body as Json)
  return new Response(r.text, { status: r.status, headers: { "Content-Type": "application/json" } })
}

class PreviewXHR {
  status = 0
  responseText = ""
  timeout = 0
  upload: { onprogress: ((e: Json) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  private method = "GET"
  private url = ""
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader() { /* 不需要 */ }
  send(body: Json) {
    let pct = 0
    const tick = () => {
      pct = Math.min(100, pct + 25)
      this.upload.onprogress?.({ lengthComputable: true, loaded: pct, total: 100 })
      if (pct < 100) setTimeout(tick, 150)
      else setTimeout(() => { const r = respond(this.method, this.url, body); this.status = r.status; this.responseText = r.text; this.onload?.() }, 500)
    }
    setTimeout(tick, 100)
  }
}
;(window as Json).XMLHttpRequest = PreviewXHR
