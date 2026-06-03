import { useState, useRef, useEffect } from "react"
import {
  generateContent,
  generateVocabulary,
  generateExercises,
  getMe,
  getHistory,
  getSession,
  toggleVocabFavorite,
  checkApiKeyStatus,
  setApiKey,
  savePreferences,
  type Preferences,
  type OutlineItem,
  type Chapter,
  type VocabWord,
  type HistoryItem,
} from "../api"
import FeatureToggle from "../components/FeatureToggle"

interface StudyProps {
  preferences: Preferences
  onNavigate: (page: string, sessionId?: string) => void
}

export default function Study({ preferences, onNavigate }: StudyProps) {
  // 输入状态
  const [topic, setTopic] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [extractedText, setExtractedText] = useState("")
  const [textPreview, setTextPreview] = useState("")
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  // API Key 状态
  const [showApiPanel, setShowApiPanel] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState("")
  const [keyConfigured, setKeyConfigured] = useState(false)
  const [savingKey, setSavingKey] = useState(false)

  // 生成状态
  const [generating, setGenerating] = useState(false)
  const [sessionId, setSessionId] = useState("")
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [activeChapter, setActiveChapter] = useState(0)
  const [contentTitle, setContentTitle] = useState("")

  // 词汇状态
  const [vocabWords, setVocabWords] = useState<VocabWord[]>([])
  const [generatingVocab, setGeneratingVocab] = useState(false)

  // 移动端侧边栏控制
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // 大纲/词汇折叠（词汇默认隐藏）
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [vocabVisible, setVocabVisible] = useState(false)

  // 已收藏词汇ID
  const [favoritedIds, setFavoritedIds] = useState<Set<number>>(new Set())

  // 后台预生成练习题
  const [exercisesReady, setExercisesReady] = useState(false)
  const [preGenerating, setPreGenerating] = useState(false)

  // 历史记录
  const [showHistory, setShowHistory] = useState(false)
  const [historyList, setHistoryList] = useState<HistoryItem[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)

  const handleOpenHistory = async () => {
    if (showHistory) { setShowHistory(false); return }
    setShowHistory(true)
    if (historyList.length === 0) {
      setLoadingHistory(true)
      try {
        const data = await getHistory()
        setHistoryList(data.sessions)
      } catch {}
      setLoadingHistory(false)
    }
  }

  const handleRestoreSession = async (sessionId: string) => {
    setShowHistory(false)
    setGenerating(true); setError("")
    try {
      const result = await getSession(sessionId)
      setSessionId(result.session_id)
      setContentTitle(result.topic)
      setOutline(result.outline)
      setChapters(result.chapters)
      setActiveChapter(0)
      setVocabWords([])
      if (showEnglish) {
        setGeneratingVocab(true)
        generateVocabulary(result.session_id)
          .then((v) => setVocabWords(v.words))
          .catch(() => {})
          .finally(() => setGeneratingVocab(false))
      }
    } catch (err: any) {
      setError(err.message || "加载失败")
    } finally { setGenerating(false) }
  }

  // 功能开关
  const [showEnglish, setShowEnglish] = useState(preferences.show_english)
  const [showPractice, setShowPractice] = useState(preferences.show_practice)
  const [showWrongBook, setShowWrongBook] = useState(preferences.show_wrong_book)

  const handleToggle = async (key: string, val: boolean) => {
    const updated = {
      show_english: key === "eng" ? val : showEnglish,
      show_practice: key === "prc" ? val : showPractice,
      show_wrong_book: key === "wb" ? val : showWrongBook,
    }
    if (key === "eng") setShowEnglish(val)
    if (key === "prc") setShowPractice(val)
    if (key === "wb") setShowWrongBook(val)
    try { await savePreferences(updated) } catch {}
  }

  // 加载学生画像
  const [profile, setProfile] = useState({ grade: "", major: "", subject: "" })
  useEffect(() => {
    getMe().then((u) => {
      if (u) setProfile({ grade: u.grade || "", major: u.major || "", subject: u.subject || "" })
    }).catch(() => {})
    checkApiKeyStatus().then((s) => setKeyConfigured(s.source === "user")).catch(() => {})
  }, [])

  // 学到倒数第二章时，后台预生成练习题
  useEffect(() => {
    if (!sessionId || chapters.length < 3 || !showPractice) return
    if (activeChapter === chapters.length - 2 && !exercisesReady && !preGenerating) {
      setPreGenerating(true)
      generateExercises(sessionId)
        .then(() => setExercisesReady(true))
        .catch(() => {})
        .finally(() => setPreGenerating(false))
    }
  }, [activeChapter, chapters.length, sessionId, exercisesReady, preGenerating, showPractice])

  // 保存自定义 API Key
  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return
    setSavingKey(true)
    try {
      await setApiKey(apiKeyInput.trim())
      setKeyConfigured(true)
      setShowApiPanel(false)
      setError("")
    } catch {
      setError("API Key 保存失败")
    } finally { setSavingKey(false) }
  }

  // 上传并解析文件
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (!selectedFile) return
    const ext = "." + selectedFile.name.split(".").pop()?.toLowerCase()
    if (![".pptx", ".pdf", ".docx"].includes(ext)) {
      setError("仅支持 PPTX、PDF、DOCX 文件。旧版 .ppt/.doc 请先转换为新格式。"); return
    }
    setFile(selectedFile); setError(""); setUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", selectedFile)
      const token = localStorage.getItem("token") || ""
      const API_BASE = import.meta.env.VITE_API_URL || "/api"
      const res = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        body: formData,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const contentType = res.headers.get("content-type") || ""
        const errMsg = contentType.includes("application/json")
          ? (await res.json()).detail : "服务器返回了无效响应"
        throw new Error(errMsg || "上传失败")
      }
      const data = await res.json()
      setExtractedText(data.text)
      setTextPreview(data.preview)
      if (!topic) setTopic(selectedFile.name.replace(/\.[^.]+$/, ""))
    } catch (err: any) {
      setError(err.message || "文件解析失败"); setFile(null)
    } finally { setUploading(false) }
  }

  const removeFile = () => {
    setFile(null); setExtractedText(""); setTextPreview("")
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  // 生成教学内容
  const handleGenerate = async () => {
    setGenerating(true); setError(""); setVocabWords([])
    try {
      const result = await generateContent({
        topic: topic.trim() || "未命名话题",
        source_type: extractedText ? "file" : "topic",
        source_text: extractedText,
        grade: profile.grade,
        major: profile.major,
        subject: profile.subject,
      })
      setSessionId(result.session_id)
      setContentTitle(result.topic)
      setOutline(result.outline)
      setChapters(result.chapters)
      setActiveChapter(0)

      // 如果开启了英语词汇，自动生成
      if (showEnglish) {
        setGeneratingVocab(true)
        generateVocabulary(result.session_id)
          .then((v) => setVocabWords(v.words))
          .catch(() => {})
          .finally(() => setGeneratingVocab(false))
      }
    } catch (err: any) {
      setError(err.message || "AI 生成失败，请检查 API Key 是否正确配置")
    } finally { setGenerating(false) }
  }

  const canGenerate = (topic.trim() || extractedText) && !generating

  // 已生成内容 → 显示学习页面
  if (chapters.length > 0) {
    const chapter = chapters[activeChapter]
    return (
      <div className="min-h-screen bg-white flex flex-col">
        {/* 顶部栏 */}
        <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-4">
          {/* 移动端汉堡菜单 */}
          <button onClick={() => setSidebarOpen(!sidebarOpen)}
                  className="md:hidden text-gray-500 hover:text-gray-800 p-0.5">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2">
              {sidebarOpen
                ? <path d="M4 4l10 10M14 4L4 14" strokeLinecap="round" />
                : <path d="M2 4h14M2 9h14M2 14h14" strokeLinecap="round" />
              }
            </svg>
          </button>
          <button
            onClick={() => {
              setChapters([]); setOutline([]); setSessionId("")
              setTopic(""); setExtractedText(""); setTextPreview(""); setFile(null)
            }}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            ← 返回
          </button>
          <h2 className="text-sm font-medium text-gray-800 truncate flex-1">{contentTitle}</h2>
          <button
            onClick={() => {
              const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${contentTitle}</title>
              <style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;line-height:1.8;color:#333}
              h1{text-align:center;border-bottom:1px solid #eee;padding-bottom:16px}
              h2{font-size:1.2em;margin-top:32px}h3{font-size:1em;color:#555}
              .example{background:#fff8e1;padding:12px 16px;border-radius:8px;margin:12px 0;border-left:3px solid #ffc107}</style></head>
              <body><h1>${contentTitle}</h1>
              ${chapters.map((ch, i) => `<h2>${outline[i]?.title || ch.title}</h2>
              ${ch.sections.map(s => `<h3>${s.heading}</h3><p>${s.body.replace(/\n/g,'<br>')}</p>
              ${s.example?`<div class="example">💡 <b>案例：</b>${s.example}</div>`:''}`).join('')}`).join('')}
              </body></html>`
              const blob = new Blob([html], {type:'text/html;charset=utf-8'})
              const a = document.createElement('a'); a.href=URL.createObjectURL(blob)
              a.download=`${contentTitle}.html`; a.click()
            }}
            className="text-xs text-gray-400 hover:text-gray-600"
            title="导出为 HTML">📄 导出</button>
          {showEnglish && (
            <button onClick={() => setVocabVisible(!vocabVisible)}
                    className={`text-xs px-2 py-1 rounded-lg transition-colors
                      ${vocabVisible ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:text-gray-600'}`}>
              📚 词汇
            </button>
          )}
        </div>

        {/* 移动端遮罩 */}
        {sidebarOpen && (
          <div className="md:hidden fixed inset-0 bg-black/20 z-40"
               onClick={() => setSidebarOpen(false)} />
        )}

        <div className="flex flex-1">
          {/* 左侧大纲 — 折叠时显示窄条 */}
          <aside className={`
            md:static md:translate-x-0 fixed left-0 top-[49px] bottom-0 z-50
            border-r border-gray-100 bg-white shrink-0 transition-all duration-200
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
            ${outlineCollapsed
              ? 'md:w-8 md:p-1 md:overflow-hidden'
              : 'md:w-56 w-64 p-3 overflow-y-auto'
            }
          `}>
            {outlineCollapsed ? (
              <button onClick={() => setOutlineCollapsed(false)}
                      className="w-full py-3 text-xs text-gray-400 hover:text-gray-600 flex flex-col items-center gap-1"
                      title="展开大纲">
                <span className="[writing-mode:vertical-rl] tracking-wider">大纲</span>
                <span>▶</span>
              </button>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2 px-2">
                  <p className="text-xs text-gray-400">教学大纲</p>
                  <button onClick={() => setOutlineCollapsed(true)}
                          className="text-xs text-gray-300 hover:text-gray-500">◀</button>
                </div>
                {outline.map((item, i) => (
                  <button
                    key={i}
                    onClick={() => { setActiveChapter(i); setSidebarOpen(false) }}
                    className={`w-full text-left px-2 py-2 rounded-lg text-sm mb-1 transition-colors
                      ${i === activeChapter
                        ? "bg-gray-100 text-gray-900 font-medium"
                        : "text-gray-500 hover:bg-gray-50"
                      }`}
                  >
                    <span className="block text-xs">{item.title}</span>
                    <span className="block text-xs text-gray-300 truncate">{item.summary}</span>
                  </button>
                ))}
              </>
            )}
          </aside>

          {/* 中间内容区 — 高度由章节内容决定 */}
          <main className="flex-1 p-4 md:p-6 max-w-3xl transition-all duration-200">
            <h3 className="text-lg font-semibold text-gray-900 mb-6">{chapter.title}</h3>
            {chapter.sections.map((section, si) => (
              <div key={si} className="mb-8">
                <h4 className="text-sm font-medium text-gray-800 mb-3">{section.heading}</h4>
                <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap mb-3 break-words">
                  {section.body}
                </p>
                {section.example && (
                  <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
                    <p className="text-xs text-amber-600 font-medium mb-1">💡 案例</p>
                    <p className="text-sm text-gray-700 leading-relaxed">{section.example}</p>
                  </div>
                )}
              </div>
            ))}

            {/* 章节导航 */}
            <div className="flex justify-between mt-10 pt-6 border-t border-gray-100">
              <button
                onClick={() => setActiveChapter(Math.max(0, activeChapter - 1))}
                disabled={activeChapter === 0}
                className="text-sm text-gray-500 hover:text-gray-800 disabled:text-gray-200 disabled:cursor-not-allowed"
              >
                ← 上一章
              </button>
              <span className="text-xs text-gray-300">
                {activeChapter + 1} / {chapters.length}
              </span>
              {activeChapter < chapters.length - 1 ? (
                <button
                  onClick={() => setActiveChapter(activeChapter + 1)}
                  className="text-sm text-gray-800 hover:text-gray-600 font-medium"
                >
                  下一章 →
                </button>
              ) : showPractice ? (
                <button
                  onClick={() => onNavigate("practice", sessionId)}
                  className="text-sm text-white bg-gray-900 px-4 py-1.5 rounded-lg hover:bg-gray-800"
                >
                  开始练习 →
                </button>
              ) : (
                <button
                  onClick={() => onNavigate("welcome")}
                  className="text-sm text-gray-400 hover:text-gray-600"
                >
                  完成学习
                </button>
              )}
            </div>
          </main>

          {/* 右侧词汇区 — 默认隐藏，点右上角按钮滑出 */}
          {showEnglish && vocabVisible ? (
            <aside className="border-l border-gray-100 bg-white shrink-0 overflow-hidden transition-all duration-300 w-48 md:w-56">
              <div className="h-full max-h-[calc(100vh-97px)] overflow-y-auto p-3">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-gray-400">📚 英语词汇</p>
                  <button onClick={() => setVocabVisible(false)}
                          className="text-xs text-gray-300 hover:text-gray-500">✕</button>
                </div>
                  {generatingVocab ? (
                    <div className="flex items-center gap-2 text-xs text-gray-300">
                      <div className="w-3 h-3 border border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                      生成中...
                    </div>
                  ) : vocabWords.length > 0 ? (
                    <div className="space-y-3">
                      {vocabWords.map((w) => (
                        <div key={w.id} className="pb-3 border-b border-gray-50 last:border-0">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="text-sm font-medium text-gray-800">{w.word}</p>
                              <p className="text-xs text-gray-500 mt-0.5">{w.translation}</p>
                            </div>
                            <button
                              onClick={async () => {
                                try {
                                  await toggleVocabFavorite(w.id)
                                  setFavoritedIds(prev => {
                                    const next = new Set(prev)
                                    if (next.has(w.id)) next.delete(w.id); else next.add(w.id)
                                    return next
                                  })
                                } catch {}
                              }}
                              className="text-xs ml-1 shrink-0"
                              title={favoritedIds.has(w.id) ? "已收藏" : "收藏"}
                            >
                              {favoritedIds.has(w.id) ? '✅' : '☆'}
                            </button>
                          </div>
                          {w.example && (
                            <p className="text-xs text-gray-300 mt-1 italic leading-relaxed">
                              {w.example}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-300">暂无词汇</p>
                  )}
                </div>
              </aside>
          ) : null}
        </div>
      </div>
    )
  }

  // 加载中
  if (generating) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white gap-4">
        <div className="w-8 h-8 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
        <p className="text-sm text-gray-400">AI 正在生成教学内容...</p>
        <p className="text-xs text-gray-300">这可能需要 10-30 秒</p>
      </div>
    )
  }

  // 输入页面
  return (
    <div className="min-h-screen bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between max-w-4xl mx-auto">
        <h2 className="text-sm font-medium text-gray-800">爱学助手</h2>
        <button
          onClick={handleOpenHistory}
          className={`text-xs px-2 py-1 rounded-lg transition-colors
            ${showHistory ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:text-gray-600'}`}
        >
          历史
        </button>
        <button
          onClick={() => onNavigate("profile")}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          我的
        </button>
      </div>

      {/* 历史记录下拉 */}
      {showHistory && (
        <div className="max-w-2xl mx-auto w-full px-4">
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-3 mb-4">
            <p className="text-xs text-gray-400 mb-2">最近学习记录</p>
            {loadingHistory ? (
              <div className="flex items-center gap-2 py-4 justify-center">
                <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                <span className="text-xs text-gray-300">加载中...</span>
              </div>
            ) : historyList.length === 0 ? (
              <p className="text-xs text-gray-300 py-2 text-center">暂无记录</p>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {historyList.map((item) => (
                  <button
                    key={item.session_id}
                    onClick={() => handleRestoreSession(item.session_id)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <p className="text-sm text-gray-700 truncate">{item.topic}</p>
                    <p className="text-xs text-gray-300 mt-0.5">
                      {item.created_at ? new Date(item.created_at).toLocaleString("zh-CN") : ""}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-16">
        <div className="text-center mb-10">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">今天想学什么？</h1>
          <p className="text-sm text-gray-400">
            输入话题或上传 PPT/PDF，AI 为你生成教学内容
          </p>
        </div>

        {/* 免费额度面板 — 始终显示 */}
        <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <p className="text-xs text-amber-700 font-medium mb-1">
            🎓 每日免费使用 5 次
          </p>
          <p className="text-xs text-amber-400">
            当前使用为 DeepSeek V4 Pro
          </p>
        </div>

        {/* 自己的 API Key — 始终显示 */}
        <div className="mb-6 p-4 bg-white border border-gray-200 rounded-xl">
          {keyConfigured ? (
            <>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-green-600 font-medium">✅ 已绑定你的 API Key</span>
                <button onClick={() => { setShowApiPanel(true); setApiKeyInput("") }}
                        className="text-xs text-gray-400 hover:text-gray-600">更换</button>
              </div>
              <p className="text-xs text-gray-400">使用你自己的专属 Key，无限次使用</p>
              {showApiPanel && (
                <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                  <input type="password" value={apiKeyInput}
                         onChange={(e) => setApiKeyInput(e.target.value)}
                         placeholder="输入新的 API Key"
                         className="flex-1 px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none" />
                  <button onClick={handleSaveKey} disabled={!apiKeyInput.trim() || savingKey}
                          className="px-3 py-2 text-xs bg-gray-900 text-white rounded-lg disabled:opacity-50">
                    {savingKey ? "保存中..." : "保存"}
                  </button>
                  <button onClick={() => { setShowApiPanel(false); setApiKeyInput("") }}
                          className="text-xs text-gray-400 hover:text-gray-600">取消</button>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-gray-700 font-medium mb-1">🔑 使用你自己的 API Key</p>
              <p className="text-xs text-gray-400 mb-3">绑定后不受每日次数限制，无限次使用</p>
              <div className="flex gap-2">
                <input type="password" value={apiKeyInput}
                       onChange={(e) => setApiKeyInput(e.target.value)}
                       placeholder="粘贴你的 DeepSeek API Key"
                       className="flex-1 px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-gray-400" />
                <button onClick={handleSaveKey} disabled={!apiKeyInput.trim() || savingKey}
                        className="px-4 py-2 text-xs bg-gray-900 text-white rounded-lg hover:bg-gray-800
                                   disabled:opacity-50 shrink-0">
                  {savingKey ? "保存中..." : "保存 Key"}
                </button>
              </div>
            </>
          )}
        </div>

        {/* 文件上传 */}
        <div className="mb-6">
          <label className="block text-xs text-gray-400 mb-2">
            上传文件（PPTX / PDF / DOCX）
          </label>
          {!file ? (
            <label
              className={`flex flex-col items-center justify-center h-32 border-2 border-dashed
                rounded-xl cursor-pointer transition-colors bg-gray-50/50
                ${dragOver ? "border-gray-500 bg-gray-100" : "border-gray-200 hover:border-gray-300"}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                const dropped = e.dataTransfer.files?.[0]
                if (dropped) {
                  const fakeEvent = { target: { files: [dropped] } } as any
                  handleFileChange(fakeEvent)
                }
              }}
            >
              <div className="text-center">
                <p className="text-sm text-gray-500 mb-1">
                  {uploading ? "解析中..." : dragOver ? "松开鼠标上传文件" : "点击上传或拖拽文件到此处"}
                </p>
                <p className="text-xs text-gray-300">支持 PPTX、PDF、DOCX，最大 20MB</p>
              </div>
              <input ref={fileInputRef} type="file" accept=".pptx,.pdf,.docx"
                     onChange={handleFileChange} className="hidden" disabled={uploading} />
            </label>
          ) : (
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100">
              <div className="flex items-center gap-3">
                <span className="text-lg">📄</span>
                <div>
                  <p className="text-sm text-gray-700">{file.name}</p>
                  <p className="text-xs text-gray-400">
                    {extractedText ? `已提取 ${extractedText.length} 字` : "解析中..."}
                  </p>
                </div>
              </div>
              <button onClick={removeFile} className="text-gray-400 hover:text-gray-600 text-sm">移除</button>
            </div>
          )}
        </div>

        {/* 功能开关 — 一行两个 */}
        <div className="mb-6">
          <p className="text-xs text-gray-400 mb-2">功能开关</p>
          <div className="grid grid-cols-2 gap-2">
            <FeatureToggle
              label="英语词汇"
              enabled={showEnglish}
              onChange={(v) => handleToggle("eng", v)}
            />
            <FeatureToggle
              label="练习系统"
              enabled={showPractice}
              onChange={(v) => handleToggle("prc", v)}
            />
            <FeatureToggle
              label="错题本"
              enabled={showWrongBook}
              onChange={(v) => handleToggle("wb", v)}
            />
          </div>
        </div>

        {/* 话题输入（可选） */}
        <div className="mb-8">
          <label className="block text-xs text-gray-400 mb-2">学习话题（可选）</label>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder='例如："机器学习基础"、"高等数学第二章"'
            className="w-full px-4 py-3 text-sm text-gray-800 border border-gray-200 rounded-xl
                       placeholder:text-gray-300 focus:outline-none focus:border-gray-400 transition-colors"
          />
        </div>

        {textPreview && (
          <div className="mb-8 p-4 bg-gray-50 rounded-xl border border-gray-100 max-h-40 overflow-y-auto">
            <p className="text-xs text-gray-400 mb-1">文件内容预览</p>
            <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">
              {textPreview}
              {extractedText.length > 2000 && (
                <span className="text-gray-300"> ... (共 {extractedText.length} 字)</span>
              )}
            </p>
          </div>
        )}

        {error && (
          <div className="mb-6 p-3 bg-red-50 border border-red-100 rounded-xl">
            <p className="text-xs text-red-500 whitespace-pre-wrap">{error}</p>
          </div>
        )}

        <button
          onClick={handleGenerate}
          disabled={!canGenerate}
          className={`w-full py-3 text-sm font-medium rounded-xl transition-colors
            ${canGenerate
              ? "bg-gray-900 text-white hover:bg-gray-800 active:bg-gray-950"
              : "bg-gray-100 text-gray-300 cursor-not-allowed"
            }`}
        >
          生成教学内容 →
        </button>

        {/* 底部署名 */}
        <div className="text-center mt-10">
          <p className="text-xs text-gray-300">sansy02 制作</p>
          <button onClick={() => onNavigate("about")}
                  className="text-xs text-gray-300 hover:text-gray-500 underline mt-1">
            关于我
          </button>
        </div>
      </div>
    </div>
  )
}
