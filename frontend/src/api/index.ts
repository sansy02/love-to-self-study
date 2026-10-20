/**
 * API 请求工具 — 带内存缓存，同一会话不重复请求
 */

// 开发环境用 Vite 代理，生产环境用完整后端地址
export const API_BASE = import.meta.env.VITE_API_URL || "/api"

// 账号密码登录：默认下线（代码保留）。需要重新开放时，在 Vercel 环境变量里设置 VITE_ENABLE_LOGIN=true，
// 同时后端设置 AUTH_MODE=account 或 both。
export const LOGIN_ENABLED = import.meta.env.VITE_ENABLE_LOGIN === "true"

function getToken(): string {
  return localStorage.getItem("token") || ""
}

// 内存缓存（页面切换不丢失）
const cache = new Map<string, { data: any; time: number }>()
const CACHE_TTL = 60000 // 缓存 60 秒

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
    if (retryCount < 1) {
      await new Promise((r) => setTimeout(r, 3000))
      return request(url, options, retryCount + 1, authRetried)
    }
    throw new Error("网络连接失败，请检查网络后重试")
  }

  // 匿名模式下凭证失效（比如服务器换了密钥）：自动换一个新的匿名身份再试一次
  if (res.status === 401 && !LOGIN_ENABLED && !authRetried) {
    clearToken()
    await ensureIdentity()
    return request(url, options, retryCount, true)
  }

  if (!res.ok) {
    const text = await res.text()
    // Render 休眠返回 HTML，自动重试一次（等待唤醒）
    if (text.includes("<!DOCTYPE") && retryCount < 1) {
      await new Promise((r) => setTimeout(r, 5000))
      return request(url, options, retryCount + 1, authRetried)
    }
    let detail = ""
    try {
      const err = JSON.parse(text)
      detail = typeof err.detail === "string" ? err.detail : (err.error || "")
    } catch {}
    if (res.status === 429 && !detail) detail = "操作太频繁了，请稍后再试"
    const e = new Error(detail || `服务器正在唤醒中，请稍后重试 (${res.status})`) as Error & { status?: number }
    e.status = res.status
    throw e
  }
  const text = await res.text()
  // 防止 HTML 响应被当作 JSON 解析
  if (text.startsWith("<!DOCTYPE") && retryCount < 1) {
    await new Promise((r) => setTimeout(r, 5000))
    return request(url, options, retryCount + 1, authRetried)
  }
  const data = JSON.parse(text)
  if (isGet) cache.set(cacheKey, { data, time: Date.now() })
  return data
}

// 清除缓存（POST/PUT 等修改操作后调用）
export function clearCache() {
  cache.clear()
}

/** 带登录凭证下载图片，返回可以放进 <img src> 的地址 */
export async function fetchImageUrl(url: string): Promise<string> {
  const token = getToken()
  const res = await fetch(`${API_BASE}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error("图片加载失败")
  return URL.createObjectURL(await res.blob())
}

// ---- 身份 ----

let identityPromise: Promise<void> | null = null

/** 匿名模式：没有凭证时自动创建一个匿名身份（不需要注册） */
export function ensureIdentity(): Promise<void> {
  if (LOGIN_ENABLED || getToken()) return Promise.resolve()
  if (!identityPromise) {
    identityPromise = (async () => {
      const res = await fetch(`${API_BASE}/auth/anonymous`, { method: "POST" })
      if (!res.ok) {
        let detail = ""
        try { detail = (await res.json()).detail } catch {}
        throw new Error(detail || "无法连接服务器，请稍后刷新重试")
      }
      const data = await res.json()
      localStorage.setItem("token", data.token)
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

export async function uploadStudyFile(file: File): Promise<StudyView> {
  const form = new FormData()
  form.append("file", file)
  return request<StudyView>("/study/upload", { method: "POST", body: form })
}

export async function startTopic(topic: string, grade = "", major = ""): Promise<StudyView> {
  return request<StudyView>("/study/topic", { method: "POST", body: JSON.stringify({ topic, grade, major }) })
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

export interface ExerciseItem {
  id: number
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
  box: number
  review_count: number
}

export interface ReviewSummary {
  questions_due: number
  words_due: number
  open_wrong: number
  total_words: number
}

export async function getReviewSummary(): Promise<ReviewSummary> {
  return request("/review/summary")
}

export async function getReviewToday(): Promise<{ questions: ReviewQuestion[]; words: SavedWord[] }> {
  return request("/review/today")
}

export interface ReviewResult {
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
  localStorage.removeItem("token")
  cache.clear()
}

export function hasToken(): boolean {
  return !!localStorage.getItem("token")
}
