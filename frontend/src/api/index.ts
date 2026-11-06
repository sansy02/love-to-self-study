/**
 * API 请求工具 — 带内存缓存，同一会话不重复请求
 */

// 开发环境用 Vite 代理，生产环境用完整后端地址
export const API_BASE = import.meta.env.VITE_API_URL || "/api"

// 账号密码登录：默认下线（代码保留）。需要重新开放时，在 Vercel 环境变量里设置 VITE_ENABLE_LOGIN=true，
// 同时后端设置 AUTH_MODE=account 或 both。
export const LOGIN_ENABLED = import.meta.env.VITE_ENABLE_LOGIN === "true"

// 浏览器存储在隐私模式等情况下可能用不了：读写都包一层，失败时不影响使用
function store(key: string, value?: string | null): string {
  try {
    if (value === undefined) return localStorage.getItem(key) || ""
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* ignore */ }
  return ""
}

function getToken(): string {
  return store("token")
}

// 内存缓存（页面切换不丢失）
const cache = new Map<string, { data: any; time: number }>()
const CACHE_TTL = 60000 // 缓存 60 秒

/** 后端统一错误格式 {detail, code}；code 决定前端显示什么恢复按钮 */
export class ApiError extends Error {
  status: number
  code: string
  constructor(message: string, status = 0, code = "error") {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 把任意异常变成可以给学生看的错误（不显示内部报错原文） */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  return new ApiError("出了点问题，请重试", 0, "error")
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function parseError(status: number, text: string): ApiError {
  let detail = ""
  let code = ""
  try {
    const err = JSON.parse(text)
    detail = typeof err.detail === "string" ? err.detail : ""
    code = typeof err.code === "string" ? err.code : ""
  } catch {}
  if (!code) {
    code = status === 429 ? "rate_limited" : status === 404 ? "not_found" : status >= 500 ? "server_error" : "error"
  }
  if (!detail) {
    detail = status === 429 ? "操作太频繁了，请稍后再试" : status >= 500 ? "服务器暂时出了点问题，请稍后重试" : "请求出错了，请重试"
  }
  return new ApiError(detail, status, code)
}

async function request<T>(url: string, options?: RequestInit, retryCount = 0, authRetried = false): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (!(options?.body instanceof FormData)) headers["Content-Type"] = "application/json"
  if (token) headers["Authorization"] = `Bearer ${token}`

  // GET 请求走缓存；其他请求会清空缓存，避免看到旧数据
  const isGet = !options?.method || options.method === "GET"
  const cacheKey = `${options?.method || "GET"}:${url}`
  if (isGet && cache.has(cacheKey)) {
    const entry = cache.get(cacheKey)!
    if (Date.now() - entry.time < CACHE_TTL) {
      return entry.data as T
    }
    cache.delete(cacheKey)
  }
  if (!isGet) cache.clear()

  let res: Response
  try {
    res = await fetch(`${API_BASE}${url}`, { ...options, headers: { ...headers, ...(options?.headers as any) } })
  } catch {
    // 只有读取类请求自动重试，提交类请求不重复发送（避免重复提交）
    if (isGet && retryCount < 1) {
      await wait(3000)
      return request(url, options, retryCount + 1, authRetried)
    }
    throw new ApiError("网络连接失败，请检查网络后重试", 0, "network")
  }

  // 匿名模式下凭证失效（比如服务器换了密钥）：自动换一个新的匿名身份再试一次
  if (res.status === 401 && !LOGIN_ENABLED && !authRetried) {
    clearToken()
    await ensureIdentity()
    return request(url, options, retryCount, true)
  }

  const text = await res.text()
  // Render 休眠时会先返回一个 HTML 页面：等它醒来再试一次
  if (text.trimStart().startsWith("<") && retryCount < 1) {
    await wait(5000)
    return request(url, options, retryCount + 1, authRetried)
  }
  if (!res.ok) throw parseError(res.status, text)
  try {
    const data = JSON.parse(text)
    if (isGet) cache.set(cacheKey, { data, time: Date.now() })
    return data
  } catch {
    throw new ApiError("服务器正在唤醒，请稍等几秒再试", res.status, "service_unavailable")
  }
}

// 清除缓存（POST/PUT 等修改操作后调用）
export function clearCache() {
  cache.clear()
}

/** 带登录凭证下载图片，返回可以放进 <img src> 的地址 */
export async function fetchImageUrl(url: string): Promise<string> {
  const token = getToken()
  const res = await fetch(`${API_BASE}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new ApiError("图片加载失败", res.status, "error")
  return URL.createObjectURL(await res.blob())
}

// ---- 身份 ----

let identityPromise: Promise<void> | null = null

/** 匿名模式：没有凭证时自动创建一个匿名身份（不需要注册） */
export function ensureIdentity(): Promise<void> {
  if (LOGIN_ENABLED || getToken()) return Promise.resolve()
  if (!identityPromise) {
    identityPromise = (async () => {
      let res: Response
      try {
        res = await fetch(`${API_BASE}/auth/anonymous`, { method: "POST" })
      } catch {
        throw new ApiError("无法连接服务器，请检查网络后重试", 0, "network")
      }
      if (!res.ok) throw parseError(res.status, await res.text())
      const data = await res.json()
      store("token", data.token)
    })().finally(() => { identityPromise = null })
  }
  return identityPromise
}

// ---- 类型 ----

export interface Profile {
  id: number | null
  grade: string
  major: string
  subject: string
}

export interface Preferences {
  id: number | null
  show_english: boolean
  show_practice: boolean
  show_wrong_book: boolean
}

// ---- 教学内容（旧版整篇生成，保留类型兼容） ----

export interface OutlineItem {
  title: string
  summary: string
}

export interface Section {
  heading: string
  body: string
  example?: string
}

export interface Chapter {
  title: string
  sections: Section[]
}

export interface GenerateResponse {
  session_id: string
  topic: string
  outline: OutlineItem[]
  chapters: Chapter[]
}

// ---- 学生画像 ----

export async function saveProfile(profile: Omit<Profile, "id">): Promise<Profile> {
  return request<Profile>("/profile", {
    method: "POST",
    body: JSON.stringify(profile),
  })
}

export async function getLatestProfile(): Promise<Profile> {
  return request<Profile>("/profile/latest")
}

// ---- 功能偏好 ----

export async function savePreferences(prefs: Omit<Preferences, "id">): Promise<Preferences> {
  return request<Preferences>("/preferences", {
    method: "POST",
    body: JSON.stringify(prefs),
  })
}

export async function getLatestPreferences(): Promise<Preferences> {
  return request<Preferences>("/preferences/latest")
}

// ---- 健康检查 ----

export async function healthCheck(): Promise<{ status: string }> {
  return request("/health")
}

// ---- 逐页学习（新版） ----

export interface StudySection {
  title: string
  summary: string
  start: number
  end: number
}

export interface StudyPageMeta {
  page_no: number
  title: string
  has_image: boolean
  image_kind: string
  explained: boolean
}

export interface StudyView {
  session_id: string
  document_id: string
  source_type: string
  file_type: string
  title: string
  summary: string
  page_count: number
  sections: StudySection[]
  outline_ready: boolean
  outline_fallback: boolean
  pages: StudyPageMeta[]
  progress: { last_page: number; visited: number[] }
  reused?: boolean
  diagnostic?: DiagnosticResult | null
  course?: { id: number; name: string; kind: CourseKind } | null
  material_type?: MaterialType
  week?: number | null
  style_summary?: string
  personal_style?: boolean
}

// ---- 课程（2.2） ----

export type CourseKind = "normal" | "inbox" | "sample"
export type MaterialType = "lecture" | "tutorial" | "past_exam" | "notes"

export const MATERIAL_TYPES: { key: MaterialType; label: string; hint: string }[] = [
  { key: "lecture", label: "老师课件", hint: "上课用的 PPT / PDF" },
  { key: "tutorial", label: "Tutorial 题目", hint: "每周的练习题" },
  { key: "past_exam", label: "往年考试题", hint: "Past year paper" },
  { key: "notes", label: "其他笔记", hint: "自己的笔记、阅读材料" },
]

export interface DiagnosticResult {
  correct: number
  total: number
  at: string
}

export interface CourseSummary {
  id: number
  name: string
  code: string
  exam_date: string
  kind: CourseKind
  material_count: number
  due: number
  last_studied_at: string | null
  created_at: string | null
}

export interface Material {
  session_id: string
  title: string
  material_type: MaterialType
  type_label: string
  week: number | null
  source_type: string
  page_count: number
  last_page: number
  visited: number
  finished: boolean
  diagnostic: DiagnosticResult | null
  due: number
  updated_at: string | null
}

export interface CourseDetail extends CourseSummary {
  materials: Material[]
  continue_session_id: string | null
}

export interface CourseKnowledgePoint extends KnowledgePoint {
  sources: { session_id: string; title: string; week: number | null; material_type: MaterialType; page_start: number | null; page_end: number | null }[]
}

export async function listCourses(): Promise<{ courses: CourseSummary[] }> {
  return request("/courses")
}

export async function createCourse(name: string, examDate = "", code = ""): Promise<CourseSummary> {
  return request("/courses", { method: "POST", body: JSON.stringify({ name, exam_date: examDate, code }) })
}

export async function getCourse(id: number): Promise<CourseDetail> {
  return request(`/courses/${id}`)
}

export async function updateCourse(id: number, data: { name?: string; exam_date?: string; code?: string }): Promise<{ status: string }> {
  return request(`/courses/${id}`, { method: "PATCH", body: JSON.stringify(data) })
}

export async function deleteCourse(id: number): Promise<{ status: string }> {
  return request(`/courses/${id}`, { method: "DELETE" })
}

export async function getCourseKnowledge(id: number): Promise<{ knowledge_points: CourseKnowledgePoint[]; counts: Record<MasteryStatus, number> }> {
  return request(`/courses/${id}/knowledge`)
}

// ---- 考试页 + 题库（2.3） ----

export interface ExamMaterial {
  session_id: string
  title: string
  material_type: MaterialType
  type_label: string
  week: number | null
  page_count: number
  ready: boolean
  count: number
  done: number
  marks: number
  is_sample: boolean
}

export interface HotPoint {
  id: number
  name: string
  kind: string
  status: MasteryStatus
  label: string
  note: string
  exam_count: number
  tutorial_count: number
  marks: number
  practice: { session_id: string; scope: string } | null
  study: { session_id: string; page_start: number | null } | null
}

export interface ExamOverview {
  exam_date: string
  days_left: number | null
  materials: ExamMaterial[]
  hot: HotPoint[]
  has_study_material: boolean
  question_count: number
}

export async function getCourseExam(id: number): Promise<ExamOverview> {
  return request(`/courses/${id}/exam`)
}

/** 把 Tutorial / 往年考试题整理成题库；force=true 重新整理 */
export async function buildBank(courseId: number, sessionId: string, force = false): Promise<{ count: number; reused: boolean; mapped?: number }> {
  return request(`/courses/${courseId}/bank/${sessionId}?force=${force ? 1 : 0}`, { method: "POST" })
}

/** 打开示例课程（返回课程和里面那份示例课件） */
export async function openSampleCourse(): Promise<{ course: CourseSummary; session_id: string }> {
  return request("/courses/sample", { method: "POST" })
}

export async function updateMaterial(sessionId: string, data: { course_id?: number; material_type?: MaterialType; week?: number; clear_week?: boolean }): Promise<{ status: string }> {
  return request(`/study/${sessionId}/meta`, { method: "PATCH", body: JSON.stringify(data) })
}

export interface KeyTerm {
  en: string
  zh: string
  note: string
}

export interface PageExplanation {
  summary: string
  explanation: string
  key_terms: KeyTerm[]
  example: string
  exam_tip: string
  page_type: "content" | "cover"
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface PageDetail {
  page_no: number
  title: string
  text: string
  notes: string
  has_image: boolean
  image_kind: string
  explanation: PageExplanation | null
  chat: ChatMessage[]
}

/** 上传课件（带进度）：onProgress(0–100) 是上传进度，传完后服务器还要几秒读取每一页 */
export function uploadStudyFile(file: File, onProgress?: (pct: number) => void,
                                opts: { courseId?: number; materialType?: MaterialType; week?: number | null } = {}): Promise<StudyView> {
  const send = (): Promise<StudyView> => new Promise((resolve, reject) => {
    const form = new FormData()
    form.append("file", file)
    if (opts.courseId != null) form.append("course_id", String(opts.courseId))
    if (opts.materialType) form.append("material_type", opts.materialType)
    if (opts.week != null) form.append("week", String(opts.week))
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `${API_BASE}/study/upload`)
    const token = getToken()
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onerror = () => reject(new ApiError("网络连接失败，请检查网络后重试", 0, "network"))
    xhr.ontimeout = () => reject(new ApiError("上传超时了，请检查网络后重试", 0, "network"))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch { reject(new ApiError("服务器正在唤醒，请稍等几秒再试", xhr.status, "service_unavailable")) }
      } else {
        reject(Object.assign(parseError(xhr.status, xhr.responseText), {}))
      }
    }
    xhr.timeout = 180000
    xhr.send(form)
  })
  cache.clear()
  return send().catch(async (e: ApiError) => {
    if (e.status === 401 && !LOGIN_ENABLED) {
      clearToken()
      await ensureIdentity()
      return send()
    }
    throw e
  })
}

/** 打开示例课程（讲解和题目都是写好的，不消耗 AI 次数） */
export async function startSample(): Promise<StudyView> {
  return request<StudyView>("/study/sample", { method: "POST" })
}

export async function startTopic(topic: string, grade = "", major = "", courseId?: number, week?: number | null): Promise<StudyView> {
  return request<StudyView>("/study/topic", { method: "POST", body: JSON.stringify({ topic, grade, major, course_id: courseId ?? null, week: week ?? null }) })
}

export async function ensureOutline(sessionId: string): Promise<StudyView> {
  return request<StudyView>(`/study/${sessionId}/outline`, { method: "POST" })
}

export async function getStudy(sessionId: string): Promise<StudyView> {
  return request<StudyView>(`/study/${sessionId}`)
}

export async function getPageDetail(sessionId: string, pageNo: number): Promise<PageDetail> {
  return request<PageDetail>(`/study/${sessionId}/pages/${pageNo}`)
}

export async function explainPage(sessionId: string, pageNo: number): Promise<{ page_no: number; explanation: PageExplanation; cached: boolean }> {
  return request(`/study/${sessionId}/pages/${pageNo}/explain`, { method: "POST" })
}

export async function askPage(sessionId: string, pageNo: number, question: string): Promise<{ answer: string }> {
  return request(`/study/${sessionId}/pages/${pageNo}/ask`, { method: "POST", body: JSON.stringify({ question }) })
}

export async function clearPageChat(sessionId: string, pageNo: number): Promise<{ status: string }> {
  return request(`/study/${sessionId}/pages/${pageNo}/chat`, { method: "DELETE" })
}

export async function saveProgress(sessionId: string, pageNo: number): Promise<{ status: string }> {
  return request(`/study/${sessionId}/progress`, { method: "POST", body: JSON.stringify({ page_no: pageNo }) })
}

export interface ExportData {
  title: string
  sections: StudySection[]
  pages: { page_no: number; title: string; text: string; explanation: PageExplanation | null }[]
}

export async function exportStudy(sessionId: string): Promise<ExportData> {
  return request(`/study/${sessionId}/export`)
}

export interface HistoryItem {
  session_id: string
  topic: string
  created_at: string | null
  legacy?: boolean
  last_page?: number | null
}

export async function getHistory(): Promise<{ sessions: HistoryItem[] }> {
  return request("/study/history")
}

export interface QuotaInfo {
  used: number
  limit: number
  remaining: number
  own_key: boolean
  free_models: string[]
}

export async function getQuota(): Promise<QuotaInfo> {
  return request("/study/quota")
}

// ---- API Key 设置 ----

export async function setApiKey(apiKey: string): Promise<{ status: string; message: string; masked: string; provider: string }> {
  return request("/settings/api-key", {
    method: "POST",
    body: JSON.stringify({ api_key: apiKey }),
  })
}

export async function deleteApiKey(): Promise<{ status: string }> {
  return request("/settings/api-key", { method: "DELETE" })
}

export async function checkApiKeyStatus(): Promise<{ configured: boolean; source: string; masked: string; user_provider: string; free_models: string[] }> {
  return request("/settings/api-key/status")
}

// ---- 英语词汇 ----

export interface VocabWord {
  id: number
  word: string
  translation: string
  example: string
}

export interface SavedWord {
  id: number
  word: string
  translation: string
  note: string
  example: string
  session_id: string
  page_no: number | null
  box: number
  mastered: boolean
  next_review_at: string | null
}

export async function listWords(): Promise<{ words: SavedWord[] }> {
  return request("/review/words")
}

export async function addWord(w: { word: string; translation?: string; note?: string; example?: string; session_id?: string; page_no?: number }): Promise<SavedWord> {
  return request("/review/words", { method: "POST", body: JSON.stringify(w) })
}

export async function deleteWord(id: number): Promise<{ status: string }> {
  return request(`/review/words/${id}`, { method: "DELETE" })
}

export async function reviewWord(id: number, remembered: boolean): Promise<SavedWord> {
  return request(`/review/words/${id}/review`, { method: "POST", body: JSON.stringify({ remembered }) })
}

// ---- 练习题 ----

// ---- 知识点 ----

export interface KpRef {
  id: number
  name: string
}

export type MasteryStatus = "new" | "learning" | "weak" | "mastered"

export interface KnowledgePoint {
  id: number
  name: string
  kind: "section" | "term"
  page_start: number | null
  page_end: number | null
  status: MasteryStatus
  label: string
  note: string
  attempts: number
  correct_days: number
  wrong: number
  section_index?: number | null
  course?: string
  session_id?: string
  due_today?: boolean
}

export async function getKnowledge(sessionId: string): Promise<{ knowledge_points: KnowledgePoint[] }> {
  return request(`/study/${sessionId}/knowledge`)
}

export async function getKnowledgeOverview(): Promise<{ knowledge_points: KnowledgePoint[] }> {
  return request("/review/knowledge")
}

export async function getRemedial(kpId: number): Promise<{ kp: KpRef; session_id: string; explanation: string; exercise: ExerciseItem }> {
  return request(`/review/kp/${kpId}/remedial`, { method: "POST" })
}

export interface ErrorReason {
  key: string
  label: string
}

/** 固定的错误原因（和后端一致；接口取不到时用这份） */
export const ERROR_REASONS: ErrorReason[] = [
  { key: "concept", label: "概念没懂" },
  { key: "english", label: "题目英文没看懂" },
  { key: "term", label: "术语记错" },
  { key: "expression", label: "表达不清" },
  { key: "careless", label: "粗心 / 其他" },
]

export async function setErrorReason(attemptId: number, errorReason: string): Promise<{ status: string; error_reason: string }> {
  return request(`/practice/attempts/${attemptId}`, { method: "PATCH", body: JSON.stringify({ error_reason: errorReason }) })
}

export interface ExerciseItem {
  id: number
  kps?: KpRef[]
  source_label?: string
  marks?: number | null
  type: "choice" | "blank" | "short_answer"
  question: string
  options: string[]
  page_no?: number | null
  lang?: string
}

export interface GradeFeedback {
  content?: string
  language?: string
  improved?: string
}

export interface SubmitResultItem {
  exercise_id: number
  user_answer: string
  correct_answer: string
  status: "correct" | "wrong" | "ungraded"
  is_correct: boolean | null
  score: number | null
  feedback: GradeFeedback
  explanation: string
  page_no: number | null
  key_points: string[]
  attempt_id?: number
  evidence?: "strong" | "weak"
  graded_by?: "rule" | "ai" | "keyword"
  error_reason?: string
  error_reason_source?: "ai" | "user" | ""
  kps?: KpRef[]
}

export interface SubmitResult {
  total: number
  correct: number
  wrong: number
  ungraded: number
  score: number
  results: SubmitResultItem[]
}

export async function generateExercises(sessionId: string, scope = "all", fresh = false): Promise<{ session_id: string; scope: string; reused: boolean; exercises: ExerciseItem[] }> {
  return request(`/practice/generate/${sessionId}?scope=${encodeURIComponent(scope)}&fresh=${fresh ? 1 : 0}`, { method: "POST" })
}

export async function submitAnswers(sessionId: string, answers: { exercise_id: number; answer: string }[]): Promise<SubmitResult> {
  return request(`/practice/submit/${sessionId}`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  })
}

export async function retryWrong(exerciseIds: number[]): Promise<{ session_id: string; scope: string; exercises: ExerciseItem[] }> {
  return request("/practice/retry-wrong", {
    method: "POST",
    body: JSON.stringify({ exercise_ids: exerciseIds }),
  })
}

// ---- 错题本 ----

export interface WrongBookEntry {
  id: number
  exercise_id: number
  session_id: string
  page_no: number | null
  question: string
  question_type: string
  options: string[]
  correct_answer: string
  user_answer: string
  explanation: string
  feedback: GradeFeedback
  kps: KpRef[]
  error_reason: string
  attempt_id: number | null
  box: number
  mastered: boolean
  review_count: number
  next_review_at: string | null
  created_at: string
}

export async function getWrongBook(includeMastered = false): Promise<{ entries: WrongBookEntry[] }> {
  return request(`/practice/wrong-book?include_mastered=${includeMastered ? 1 : 0}`)
}

export async function removeWrong(id: number): Promise<{ status: string }> {
  return request(`/practice/wrong-book/${id}`, { method: "DELETE" })
}

// ---- 今日复习 ----

export interface ReviewQuestion {
  id: number
  exercise_id: number
  session_id: string
  page_no: number | null
  question: string
  question_type: string
  options: string[]
  kps: KpRef[]
  box: number
  review_count: number
}

export interface ReviewSummary {
  questions_due: number
  words_due: number
  open_wrong: number
  total_words: number
}

export async function getReviewSummary(courseId?: number): Promise<ReviewSummary> {
  return request(courseId != null ? `/review/summary?course_id=${courseId}` : "/review/summary")
}

export async function getReviewToday(courseId?: number): Promise<{ questions: ReviewQuestion[]; words: SavedWord[]; postponed: number }> {
  return request(courseId != null ? `/review/today?course_id=${courseId}` : "/review/today")
}

export interface ReviewResult {
  attempt_id?: number
  error_reason?: string
  error_reason_source?: "ai" | "user" | ""
  evidence?: "strong" | "weak"
  graded_by?: "rule" | "ai" | "keyword"
  kps?: KpRef[]
  status: "correct" | "wrong" | "ungraded"
  is_correct: boolean | null
  score: number | null
  feedback: GradeFeedback
  correct_answer: string
  explanation: string
  key_points: string[]
  mastered: boolean
  next_review_at: string | null
}

export async function reviewQuestion(id: number, answer: string): Promise<ReviewResult> {
  return request(`/review/questions/${id}`, { method: "POST", body: JSON.stringify({ answer }) })
}

// ---- 认证 ----

export interface UserInfo {
  id: number
  email: string
  grade: string
  major: string
  subject: string
  is_admin?: boolean
  is_anonymous?: boolean
}

export async function getMe(): Promise<UserInfo> {
  return request("/auth/me")
}

export async function updateMe(data: { grade?: string; major?: string; subject?: string }): Promise<{ status: string }> {
  return request("/auth/me", { method: "PUT", body: JSON.stringify(data) })
}

export async function changePassword(old_password: string, new_password: string): Promise<{ status: string }> {
  return request("/auth/password", { method: "PUT", body: JSON.stringify({ old_password, new_password }) })
}

// ---- 3.0 个性化：学习方式、路线、画像 ----

export interface ProfileQuestion {
  key: "goal" | "english" | "style" | "minutes" | "length"
  title: string
  default: string
  options: { value: string; label: string; hint: string }[]
}

export interface LearnProfile {
  questions: ProfileQuestion[]
  answers: Record<string, string>
  completed: boolean
  style_summary: string
}

export async function getLearnProfile(): Promise<LearnProfile> {
  return request("/me/profile")
}

export async function saveLearnProfile(answers: Record<string, string>): Promise<LearnProfile> {
  return request("/me/profile", { method: "PUT", body: JSON.stringify({ answers }) })
}

export type RouteAction =
  | { type: "tab"; tab: string }
  | { type: "page"; page: string }
  | { type: "study"; session_id: string }
  | { type: "practice"; session_id: string; scope: string }
  | { type: "remedial"; kp_id: number; name: string }
  | { type: "build_bank"; session_id: string }

export interface RouteStep {
  key: string
  kind: "add" | "review" | "build_bank" | "remedial" | "bank" | "diagnostic" | "study" | "words"
  title: string
  reason: string
  minutes: number
  action: RouteAction
  done: boolean
}

export interface CourseRoute {
  day: string
  today: RouteStep[]
  later: RouteStep[]
  done: number
  total: number
  minutes: number
  streak: number
  days_left: number | null
  sprint: boolean
  exam_date: string
  profile_completed: boolean
  style_summary: string
  per_day: number
}

export async function getRoute(courseId: number): Promise<CourseRoute> {
  return request(`/courses/${courseId}/route`)
}

export async function routeMore(courseId: number): Promise<CourseRoute> {
  return request(`/courses/${courseId}/route/more`, { method: "POST" })
}

export async function routeReset(courseId: number): Promise<CourseRoute> {
  return request(`/courses/${courseId}/route/reset`, { method: "POST" })
}

export interface Portrait {
  streak: number
  calendar: { day: string; count: number }[]
  active_days: number
  answered: number
  accuracy: number | null
  reasons: { key: string; label: string; count: number }[]
  weak: { name: string; course: string; status: MasteryStatus; label: string; wrong: number }[]
  courses: { id: number; name: string; kind: CourseKind; total: number; mastered: number; learning: number; days_left: number | null }[]
  adaptations: string[]
  style_summary: string
  profile_completed: boolean
}

export async function getPortrait(): Promise<Portrait> {
  return request("/me/portrait")
}

// ---- 找回码（换设备继续用，不需要账号密码） ----

export async function getRecoveryStatus(): Promise<{ has_code: boolean; created_at: string | null }> {
  return request("/auth/recovery-code")
}

export async function createRecoveryCode(): Promise<{ code: string }> {
  return request("/auth/recovery-code", { method: "POST" })
}

/** 在这台设备上输入找回码：换成原来的身份 */
export async function recoverWithCode(code: string): Promise<void> {
  const data = await request<{ token: string }>("/auth/recover", { method: "POST", body: JSON.stringify({ code }) })
  store("token", data.token)
  store("courseId", null)
  cache.clear()
}

// ---- 用户统计 ----

export interface UserStats {
  sessions: number
  total_exercises: number
  wrong_count: number
  accuracy: number
  favorite_vocab: number
}

export async function getUserStats(): Promise<UserStats> {
  return request("/user/stats")
}

export async function getUserVocabulary(): Promise<{ words: VocabWord[] }> {
  return request("/user/vocabulary")
}

export async function toggleVocabFavorite(vocabId: number): Promise<{ vocab_id: number; favorited: boolean }> {
  return request(`/user/vocabulary/${vocabId}/favorite`, { method: "POST" })
}

// ---- Token 管理 ----

export function clearToken() {
  store("token", null)
  cache.clear()
}

export function hasToken(): boolean {
  return !!store("token")
}
