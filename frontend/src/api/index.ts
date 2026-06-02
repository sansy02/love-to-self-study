/**
 * API 请求工具 — 带内存缓存，同一会话不重复请求
 */

// 开发环境用 Vite 代理，生产环境用完整后端地址
const BASE = import.meta.env.VITE_API_URL || "/api"

function getToken(): string {
  return localStorage.getItem("token") || ""
}

// 内存缓存（页面切换不丢失）
const cache = new Map<string, { data: any; time: number }>()
const CACHE_TTL = 60000 // 缓存 60 秒

async function request<T>(url: string, options?: RequestInit, retryCount = 0): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`

  // GET 请求走缓存
  const isGet = !options?.method || options.method === "GET"
  const cacheKey = `${options?.method || "GET"}:${url}`
  if (isGet && cache.has(cacheKey)) {
    const entry = cache.get(cacheKey)!
    if (Date.now() - entry.time < CACHE_TTL) {
      return entry.data as T
    }
    cache.delete(cacheKey)
  }

  const res = await fetch(`${BASE}${url}`, { headers, ...options })
  if (!res.ok) {
    const text = await res.text()
    // Render 休眠返回 HTML，自动重试一次（等待唤醒）
    if (text.includes("<!DOCTYPE") && retryCount < 1) {
      await new Promise((r) => setTimeout(r, 5000))
      return request(url, options, retryCount + 1)
    }
    try {
      const err = JSON.parse(text)
      throw new Error(err.detail || `HTTP ${res.status}`)
    } catch (e: any) {
      if (e.message && !e.message.startsWith("HTTP")) throw e
      throw new Error(`服务器正在唤醒中，请稍后重试 (${res.status})`)
    }
  }
  const text = await res.text()
  // 防止 HTML 响应被当作 JSON 解析
  if (text.startsWith("<!DOCTYPE") && retryCount < 1) {
    await new Promise((r) => setTimeout(r, 5000))
    return request(url, options, retryCount + 1)
  }
  const data = JSON.parse(text)
  if (isGet) cache.set(cacheKey, { data, time: Date.now() })
  return data
}

// 清除缓存（POST/PUT 等修改操作后调用）
export function clearCache() {
  cache.clear()
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

// ---- 教学内容 ----

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

export interface GenerateRequest {
  topic: string
  source_type: string
  source_text: string
  grade: string
  major: string
  subject: string
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

// ---- 教学内容生成 ----

export async function generateContent(req: GenerateRequest): Promise<GenerateResponse> {
  return request<GenerateResponse>("/content/generate", {
    method: "POST",
    body: JSON.stringify(req),
  })
}

export async function getSession(sessionId: string): Promise<GenerateResponse> {
  return request<GenerateResponse>(`/content/${sessionId}`)
}

export interface HistoryItem {
  session_id: string
  topic: string
  created_at: string | null
}

export async function getHistory(): Promise<{ sessions: HistoryItem[] }> {
  return request("/content/history")
}

// ---- API Key 设置 ----

export async function setApiKey(apiKey: string): Promise<{ status: string; message: string }> {
  return request("/settings/api-key", {
    method: "POST",
    body: JSON.stringify({ api_key: apiKey }),
  })
}

export async function checkApiKeyStatus(): Promise<{ configured: boolean; source: string }> {
  return request("/settings/api-key/status")
}

// ---- 英语词汇 ----

export interface VocabWord {
  id: number
  word: string
  translation: string
  example: string
}

export async function generateVocabulary(sessionId: string): Promise<{ session_id: string; words: VocabWord[] }> {
  return request(`/vocabulary/generate/${sessionId}`, { method: "POST" })
}

export async function getVocabulary(sessionId: string): Promise<{ session_id: string; words: VocabWord[] }> {
  return request(`/vocabulary/${sessionId}`)
}

// ---- 练习题 ----

export interface ExerciseItem {
  id: number
  type: "choice" | "blank" | "short_answer"
  question: string
  options: string[]
  answer?: string
  explanation?: string
}

export interface SubmitResult {
  total: number
  correct: number
  wrong: number
  score: number
  results: {
    exercise_id: number
    user_answer: string
    correct_answer: string
    is_correct: boolean
    explanation: string
  }[]
}

export async function generateExercises(sessionId: string): Promise<{ session_id: string; exercises: ExerciseItem[] }> {
  return request(`/practice/generate/${sessionId}`, { method: "POST" })
}

export async function getExercises(sessionId: string): Promise<{ session_id: string; exercises: ExerciseItem[] }> {
  return request(`/practice/${sessionId}`)
}

export async function submitAnswers(sessionId: string, answers: { exercise_id: number; answer: string }[]): Promise<SubmitResult> {
  return request(`/practice/submit/${sessionId}`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  })
}

// ---- 错题本 ----

export interface WrongBookEntry {
  id: number
  exercise_id: number
  question: string
  question_type: string
  options: string[]
  correct_answer: string
  user_answer: string
  explanation: string
  created_at: string
}

export async function getWrongBook(): Promise<{ entries: WrongBookEntry[] }> {
  return request("/practice/wrong-book")
}

// ---- 认证 ----

export interface UserInfo {
  id: number
  email: string
  grade: string
  major: string
  subject: string
  is_admin?: boolean
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
}

export function hasToken(): boolean {
  return !!localStorage.getItem("token")
}
