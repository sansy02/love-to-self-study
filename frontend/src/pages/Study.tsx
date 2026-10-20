import { useState, useRef, useEffect, useCallback } from "react"
import {
  uploadStudyFile,
  startTopic,
  ensureOutline,
  getStudy,
  getPageDetail,
  explainPage,
  askPage,
  clearPageChat,
  saveProgress,
  exportStudy,
  getHistory,
  getQuota,
  getMe,
  checkApiKeyStatus,
  setApiKey,
  deleteApiKey,
  savePreferences,
  fetchImageUrl,
  listWords,
  addWord,
  deleteWord,
  getReviewSummary,
  type Preferences,
  type StudyView,
  type PageDetail,
  type PageExplanation,
  type HistoryItem,
  type QuotaInfo,
  type KeyTerm,
} from "../api"
import FeatureToggle from "../components/FeatureToggle"
import RichText from "../components/RichText"

interface StudyProps {
  preferences: Preferences
  initialSessionId?: string
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
}

const QUICK_QUESTIONS = ["用更简单的话再讲一遍", "举一个生活中的例子", "这页考试会怎么考？", "把这一页翻译成中文"]

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
}

export default function Study({ preferences, initialSessionId, onNavigate }: StudyProps) {
  // ---------------- 输入页状态
  const [topic, setTopic] = useState("")
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState<"" | "upload" | "topic" | "outline" | "open">(initialSessionId ? "open" : "")
  const [error, setError] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [historyList, setHistoryList] = useState<HistoryItem[]>([])
  const [quota, setQuota] = useState<QuotaInfo | null>(null)
  const [reviewDue, setReviewDue] = useState(0)

  // API Key
  const [apiKeyInput, setApiKeyInput] = useState("")
  const [keyMasked, setKeyMasked] = useState("")
  const [keyProvider, setKeyProvider] = useState("")
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [savingKey, setSavingKey] = useState(false)

  // 功能开关
  const [showEnglish, setShowEnglish] = useState(preferences.show_english)
  const [showPractice, setShowPractice] = useState(preferences.show_practice)

  // 学生画像（话题模式用）
  const [profile, setProfile] = useState({ grade: "", major: "" })

  // ---------------- 学习页状态
  const [view, setView] = useState<StudyView | null>(null)
  const [current, setCurrent] = useState(1)
  const [details, setDetails] = useState<Record<number, PageDetail>>({})
  const [explaining, setExplaining] = useState<Record<number, boolean>>({})
  const [explainErr, setExplainErr] = useState<Record<number, string>>({})
  const [images, setImages] = useState<Record<number, string>>({})
  const [visited, setVisited] = useState<Set<number>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showPageText, setShowPageText] = useState(false)
  const [question, setQuestion] = useState("")
  const [asking, setAsking] = useState(false)
  const [askErr, setAskErr] = useState("")
  const [savedWords, setSavedWords] = useState<Record<string, number>>({})  // 小写术语 -> 收藏 id
  const [exporting, setExporting] = useState(false)
  const imagesRef = useRef<Record<number, string>>({})
  const inflight = useRef<Set<string>>(new Set())

  const refreshQuota = useCallback(() => {
    getQuota().then(setQuota).catch(() => {})
  }, [])

  // ---------------- 初始化
  useEffect(() => {
    getMe().then((u) => setProfile({ grade: u.grade || "", major: u.major || "" })).catch(() => {})
    checkApiKeyStatus().then((s) => {
      setKeyMasked(s.source === "user" ? s.masked : "")
      setKeyProvider(s.user_provider || "")
    }).catch(() => {})
    getHistory().then((h) => setHistoryList(h.sessions.filter((x) => !x.legacy))).catch(() => {})
    getReviewSummary().then((s) => setReviewDue(s.questions_due + s.words_due)).catch(() => {})
    listWords().then((w) => {
      const m: Record<string, number> = {}
      w.words.forEach((x) => { m[x.word.toLowerCase()] = x.id })
      setSavedWords(m)
    }).catch(() => {})
    refreshQuota()
    return () => {
      Object.values(imagesRef.current).forEach((u) => URL.revokeObjectURL(u))
    }
  }, [refreshQuota])

  const openSession = useCallback(async (sid: string) => {
    setError("")
    setBusy("open")
    try {
      let v = await getStudy(sid)
      if (!v.outline_ready) {
        setBusy("outline")
        v = await ensureOutline(sid)
      }
      setView(v)
      setVisited(new Set(v.progress.visited || []))
      const last = Math.min(Math.max(v.progress.last_page || 1, 1), v.page_count || 1)
      setCurrent(last)
      setDetails({}); setExplainErr({})
    } catch (e: any) {
      setError(e.message || "打开失败")
    } finally {
      setBusy("")
    }
  }, [])

  useEffect(() => {
    if (initialSessionId) openSession(initialSessionId)
  }, [initialSessionId, openSession])

  // ---------------- 输入页操作
  const handleToggle = async (key: "eng" | "prc", val: boolean) => {
    const updated = {
      show_english: key === "eng" ? val : showEnglish,
      show_practice: key === "prc" ? val : showPractice,
      show_wrong_book: preferences.show_wrong_book,
    }
    if (key === "eng") setShowEnglish(val)
    if (key === "prc") setShowPractice(val)
    try { await savePreferences(updated) } catch {}
  }

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return
    setSavingKey(true)
    try {
      const r = await setApiKey(apiKeyInput.trim())
      setKeyMasked(r.masked); setKeyProvider(r.provider)
      setApiKeyInput(""); setShowKeyInput(false); setError("")
      refreshQuota()
    } catch (e: any) {
      setError(e.message || "API Key 保存失败")
    } finally { setSavingKey(false) }
  }

  const handleDeleteKey = async () => {
    try {
      await deleteApiKey()
      setKeyMasked(""); setKeyProvider("")
      refreshQuota()
    } catch {}
  }

  const handleFile = async (f: File | undefined) => {
    if (!f) return
    const ext = "." + (f.name.split(".").pop() || "").toLowerCase()
    if (![".pptx", ".pdf", ".docx"].includes(ext)) {
      setError("仅支持 PPTX、PDF、DOCX 文件。旧版 .ppt/.doc 请先另存为新格式。"); return
    }
    if (f.size > 20 * 1024 * 1024) {
      setError("文件超过 20MB，请压缩图片或拆分后上传"); return
    }
    setError(""); setBusy("upload")
    try {
      const v = await uploadStudyFile(f)
      onNavigate("study", v.session_id)  // 学习页会重新挂载并打开这份课件
    } catch (e: any) {
      setError(e.message || "上传失败")
      setBusy("")
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleTopic = async () => {
    if (!topic.trim()) return
    setError(""); setBusy("topic")
    try {
      const v = await startTopic(topic.trim(), profile.grade, profile.major)
      onNavigate("study", v.session_id)
    } catch (e: any) {
      setError(e.message || "生成失败")
      setBusy("")
    }
  }

  // ---------------- 学习页：加载当前页
  const sid = view?.session_id || ""

  const loadExplanation = useCallback(async (pageNo: number, isPrefetch = false) => {
    if (!sid) return
    const key = `${sid}:${pageNo}`
    if (inflight.current.has(key)) return
    inflight.current.add(key)
    if (!isPrefetch) {
      setExplaining((p) => ({ ...p, [pageNo]: true }))
      setExplainErr((p) => ({ ...p, [pageNo]: "" }))
    }
    try {
      const r = await explainPage(sid, pageNo)
      setDetails((p) => (p[pageNo] ? { ...p, [pageNo]: { ...p[pageNo], explanation: r.explanation } } : p))
      setView((v) => v ? { ...v, pages: v.pages.map((pg) => pg.page_no === pageNo ? { ...pg, explained: true } : pg) } : v)
      if (!r.cached) refreshQuota()
    } catch (e: any) {
      if (!isPrefetch) setExplainErr((p) => ({ ...p, [pageNo]: e.message || "讲解生成失败" }))
    } finally {
      inflight.current.delete(key)
      if (!isPrefetch) setExplaining((p) => ({ ...p, [pageNo]: false }))
    }
  }, [sid, refreshQuota])

  useEffect(() => {
    if (!view || !sid) return
    let cancelled = false
    const pageNo = current
    setQuestion(""); setAskErr("")
    const meta = view.pages.find((p) => p.page_no === pageNo)
    setShowPageText(!meta?.has_image)

    getPageDetail(sid, pageNo).then((d) => {
      if (cancelled) return
      setDetails((p) => ({ ...p, [pageNo]: { ...d, explanation: p[pageNo]?.explanation || d.explanation } }))
      if (!d.explanation) loadExplanation(pageNo)
    }).catch((e) => { if (!cancelled) setExplainErr((p) => ({ ...p, [pageNo]: e.message || "加载失败" })) })

    if (meta?.has_image && !imagesRef.current[pageNo]) {
      fetchImageUrl(`/study/${sid}/pages/${pageNo}/image`).then((url) => {
        imagesRef.current[pageNo] = url
        setImages((p) => ({ ...p, [pageNo]: url }))
      }).catch(() => {})
    }

    setVisited((s) => { const n = new Set(s); n.add(pageNo); return n })
    const t = setTimeout(() => { saveProgress(sid, pageNo).catch(() => {}) }, 800)
    return () => { cancelled = true; clearTimeout(t) }
  }, [current, sid, view?.page_count]) // eslint-disable-line react-hooks/exhaustive-deps

  // 当前页讲完后，后台预先生成下一页（额度快用完时不预取）
  const curExplained = !!details[current]?.explanation
  useEffect(() => {
    if (!view || !curExplained) return
    const next = view.pages.find((p) => p.page_no === current + 1)
    if (!next || next.explained) return
    if (quota && !quota.own_key && quota.remaining < 5) return
    const t = setTimeout(() => loadExplanation(current + 1, true), 1500)
    return () => clearTimeout(t)
  }, [curExplained, current]) // eslint-disable-line react-hooks/exhaustive-deps

  // 键盘左右键翻页
  useEffect(() => {
    if (!view) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      if (e.key === "ArrowRight") setCurrent((c) => Math.min(c + 1, view.page_count))
      if (e.key === "ArrowLeft") setCurrent((c) => Math.max(c - 1, 1))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [view])

  const goPage = (n: number) => {
    if (!view) return
    setCurrent(Math.min(Math.max(n, 1), view.page_count))
    setSidebarOpen(false)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const handleAsk = async (q?: string) => {
    const text = (q ?? question).trim()
    if (!text || !sid || asking) return
    const pageNo = current
    setAsking(true); setAskErr("")
    setDetails((p) => ({ ...p, [pageNo]: { ...p[pageNo], chat: [...(p[pageNo]?.chat || []), { role: "user", content: text }] } }))
    setQuestion("")
    try {
      const r = await askPage(sid, pageNo, text)
      setDetails((p) => ({ ...p, [pageNo]: { ...p[pageNo], chat: [...(p[pageNo]?.chat || []), { role: "assistant", content: r.answer }] } }))
      refreshQuota()
    } catch (e: any) {
      setAskErr(e.message || "回答失败")
      setDetails((p) => ({ ...p, [pageNo]: { ...p[pageNo], chat: (p[pageNo]?.chat || []).slice(0, -1) } }))
      setQuestion(text)
    } finally { setAsking(false) }
  }

  const handleClearChat = async () => {
    if (!sid) return
    try {
      await clearPageChat(sid, current)
      setDetails((p) => ({ ...p, [current]: { ...p[current], chat: [] } }))
    } catch {}
  }

  const toggleWord = async (t: KeyTerm) => {
    const k = t.en.toLowerCase()
    try {
      if (savedWords[k]) {
        await deleteWord(savedWords[k])
        setSavedWords((m) => { const n = { ...m }; delete n[k]; return n })
      } else {
        const w = await addWord({ word: t.en, translation: t.zh, note: t.note, session_id: sid, page_no: current })
        setSavedWords((m) => ({ ...m, [k]: w.id }))
      }
    } catch {}
  }

  const handleExport = async () => {
    if (!sid) return
    setExporting(true)
    try {
      const data = await exportStudy(sid)
      const pagesHtml = data.pages.map((p) => {
        const e = p.explanation
        const body = e
          ? `<p class="sum">${escapeHtml(e.summary)}</p><div class="ex">${escapeHtml(e.explanation).replace(/\n/g, "<br>")}</div>
             ${e.key_terms.length ? `<p class="terms">${e.key_terms.map((t) => `<b>${escapeHtml(t.en)}</b> ${escapeHtml(t.zh)}`).join(" · ")}</p>` : ""}
             ${e.example ? `<div class="eg">例子：${escapeHtml(e.example)}</div>` : ""}
             ${e.exam_tip ? `<div class="tip">考试提示：${escapeHtml(e.exam_tip)}</div>` : ""}`
          : `<p class="none">（这一页还没有生成讲解）</p>`
        return `<section><h2>第 ${p.page_no} 页 · ${escapeHtml(p.title || "")}</h2><pre>${escapeHtml(p.text || "")}</pre>${body}</section>`
      }).join("")
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(data.title)}</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.8;color:#333}
h1{text-align:center}h2{font-size:1.05em;border-top:1px solid #eee;padding-top:20px;margin-top:28px}
pre{white-space:pre-wrap;background:#f7f7f7;padding:12px;border-radius:8px;font-size:.85em;color:#555}
.sum{font-weight:600}.terms{font-size:.9em;color:#555}.eg{background:#fff8e1;padding:10px 14px;border-radius:8px;margin:8px 0}
.tip{background:#eef4ff;padding:10px 14px;border-radius:8px;margin:8px 0}.none{color:#aaa}</style></head>
<body><h1>${escapeHtml(data.title)}</h1>${pagesHtml}</body></html>`
      const blob = new Blob([html], { type: "text/html;charset=utf-8" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `${data.title || "讲解"}.html`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch (e: any) {
      setError(e.message || "导出失败")
    } finally { setExporting(false) }
  }

  // =====================================================================
  // 加载中
  // =====================================================================
  if (busy && !view) {
    const msg = {
      upload: ["正在读取课件的每一页…", "页数多的 PDF 可能要 10–20 秒"],
      topic: ["AI 正在规划学习内容…", "大约需要 10–30 秒"],
      outline: ["正在整理章节大纲…", "只生成大纲，很快；每一页的讲解会在你打开时再生成"],
      open: ["正在打开…", ""],
    }[busy]
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white gap-4 px-6 text-center">
        <div className="w-8 h-8 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
        <p className="text-sm text-gray-500">{msg[0]}</p>
        {msg[1] && <p className="text-xs text-gray-300">{msg[1]}</p>}
      </div>
    )
  }

  // =====================================================================
  // 逐页学习页
  // =====================================================================
  if (view) {
    const detail = details[current]
    const expl: PageExplanation | null | undefined = detail?.explanation
    const secIndex = view.sections.findIndex((s) => s.start <= current && current <= s.end)
    const sec = secIndex >= 0 ? view.sections[secIndex] : null
    const isSectionEnd = !!sec && current === sec.end
    const isLast = current === view.page_count
    const meta = view.pages.find((p) => p.page_no === current)
    const img = images[current]

    return (
      <div className="min-h-screen bg-white flex flex-col">
        {/* 顶部栏 */}
        <div className="sticky top-0 z-30 bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="md:hidden text-gray-500 p-0.5" aria-label="目录">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2">
              {sidebarOpen ? <path d="M4 4l10 10M14 4L4 14" strokeLinecap="round" /> : <path d="M2 4h14M2 9h14M2 14h14" strokeLinecap="round" />}
            </svg>
          </button>
          <button onClick={() => { setView(null); onNavigate("study") }} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">← 返回</button>
          <h2 className="text-sm font-medium text-gray-800 truncate flex-1">{view.title}</h2>
          <span className="text-xs text-gray-400 shrink-0">{current} / {view.page_count}</span>
          <button onClick={handleExport} disabled={exporting} className="hidden sm:inline text-xs text-gray-400 hover:text-gray-600 shrink-0" title="把已生成的讲解导出为网页">
            {exporting ? "导出中…" : "导出"}
          </button>
          {showPractice && (
            <button onClick={() => onNavigate("practice", sid, "all")}
                    className="text-xs px-2.5 py-1 bg-gray-900 text-white rounded-lg hover:bg-gray-800 shrink-0">整讲练习</button>
          )}
        </div>

        {sidebarOpen && <div className="md:hidden fixed inset-0 bg-black/20 z-40" onClick={() => setSidebarOpen(false)} />}

        <div className="flex flex-1">
          {/* 左侧目录 */}
          <aside className={`md:sticky md:top-[49px] md:h-[calc(100vh-49px)] md:translate-x-0 fixed left-0 top-[49px] bottom-0 z-50
            w-64 md:w-60 border-r border-gray-100 bg-white overflow-y-auto p-3 shrink-0 transition-transform
            ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
            {view.outline_fallback && (
              <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg p-2 mb-2">AI 暂时不可用，先按页码简单分了章节</p>
            )}
            {view.sections.map((s, i) => (
              <div key={i} className="mb-3">
                <p className={`text-xs font-medium px-2 mb-1 ${i === secIndex ? "text-gray-900" : "text-gray-500"}`}>{s.title}</p>
                {Array.from({ length: s.end - s.start + 1 }, (_, k) => s.start + k).map((n) => {
                  const pm = view.pages.find((p) => p.page_no === n)
                  return (
                    <button key={n} onClick={() => goPage(n)}
                            className={`w-full text-left px-2 py-1 rounded-md text-xs flex items-center gap-2 transition-colors
                              ${n === current ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:bg-gray-50"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${visited.has(n) ? "bg-gray-400" : "bg-gray-200"}`} />
                      <span className="shrink-0 text-gray-300 w-5">{n}</span>
                      <span className="truncate">{pm?.title || `第 ${n} 页`}</span>
                    </button>
                  )
                })}
                {showPractice && (
                  <button onClick={() => onNavigate("practice", sid, `section-${i}`)}
                          className="ml-2 mt-1 text-[11px] text-blue-500 hover:text-blue-700">练习这一章 →</button>
                )}
              </div>
            ))}
          </aside>

          {/* 主体 */}
          <main className="flex-1 min-w-0 p-4 md:p-6">
            <p className="text-xs text-gray-400 mb-3">{sec ? sec.title : ""}{sec ? " · " : ""}第 {current} 页</p>

            <div className="grid lg:grid-cols-2 gap-5">
              {/* 原页面 */}
              <section className="border border-gray-100 rounded-xl p-4 bg-gray-50/40">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-400">原页面</p>
                  {meta?.has_image && detail?.text && (
                    <button onClick={() => setShowPageText(!showPageText)} className="text-xs text-gray-400 hover:text-gray-600">
                      {showPageText ? "收起文字" : "看文字"}
                    </button>
                  )}
                </div>
                {meta?.has_image && (
                  img ? (
                    <img src={img} alt={`第 ${current} 页`} className="w-full rounded-lg border border-gray-100 bg-white mb-3" />
                  ) : (
                    <div className="w-full aspect-video rounded-lg bg-gray-100 animate-pulse mb-3" />
                  )
                )}
                {meta?.image_kind === "picture" && (
                  <p className="text-[11px] text-gray-300 -mt-1 mb-2">PPT 只能显示页面里的图片；想看完整原页面，可以把 PPT 另存为 PDF 再上传</p>
                )}
                {(showPageText || !meta?.has_image) && (
                  detail ? (
                    <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words font-sans leading-relaxed">
                      {detail.text || "（这一页没有文字）"}
                    </pre>
                  ) : <div className="h-24 bg-gray-100 rounded animate-pulse" />
                )}
                {detail?.notes && (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <p className="text-[11px] text-gray-400 mb-1">老师备注</p>
                    <p className="text-xs text-gray-600 whitespace-pre-wrap">{detail.notes}</p>
                  </div>
                )}
              </section>

              {/* 讲解 */}
              <section className="border border-gray-100 rounded-xl p-4">
                <p className="text-xs text-gray-400 mb-2">讲解</p>
                {expl ? (
                  <>
                    {expl.summary && <p className="text-sm font-medium text-gray-900 mb-3">{expl.summary}</p>}
                    <RichText text={expl.explanation} className="text-sm text-gray-700 leading-relaxed break-words" />
                    {expl.example && (
                      <div className="mt-4 bg-amber-50 border border-amber-100 rounded-lg p-3">
                        <p className="text-xs text-amber-600 font-medium mb-1">例子</p>
                        <RichText text={expl.example} className="text-sm text-gray-700 leading-relaxed" />
                      </div>
                    )}
                    {expl.exam_tip && (
                      <div className="mt-3 bg-blue-50 border border-blue-100 rounded-lg p-3">
                        <p className="text-xs text-blue-600 font-medium mb-1">考试提示</p>
                        <RichText text={expl.exam_tip} className="text-sm text-gray-700 leading-relaxed" />
                      </div>
                    )}
                    {showEnglish && expl.key_terms.length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs text-gray-400 mb-2">本页术语（点 ☆ 收藏，之后在「今日复习」里背）</p>
                        <div className="space-y-1.5">
                          {expl.key_terms.map((t) => {
                            const saved = !!savedWords[t.en.toLowerCase()]
                            return (
                              <div key={t.en} className="flex items-start gap-2 text-sm">
                                <button onClick={() => toggleWord(t)} className={`shrink-0 ${saved ? "text-amber-500" : "text-gray-300 hover:text-gray-500"}`}
                                        title={saved ? "取消收藏" : "收藏"}>{saved ? "★" : "☆"}</button>
                                <div>
                                  <span className="font-medium text-gray-900">{t.en}</span>
                                  <span className="text-gray-500 ml-1.5">{t.zh}</span>
                                  {t.note && <p className="text-xs text-gray-400">{t.note}</p>}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </>
                ) : explainErr[current] ? (
                  <div className="p-3 bg-red-50 border border-red-100 rounded-lg">
                    <p className="text-xs text-red-500 whitespace-pre-wrap mb-2">{explainErr[current]}</p>
                    <button onClick={() => loadExplanation(current)} className="text-xs px-3 py-1 bg-gray-900 text-white rounded-lg">重试</button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-gray-400 mb-3">
                      <div className="w-3 h-3 border border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                      {explaining[current] ? "正在讲解这一页（第一次打开需要几秒，之后全班秒开）" : "加载中…"}
                    </div>
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-4/5" />
                    <div className="h-3 bg-gray-100 rounded animate-pulse" />
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-11/12" />
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-2/3" />
                  </div>
                )}
              </section>
            </div>

            {/* 追问这一页 */}
            <section className="mt-5 border border-gray-100 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-400">追问这一页</p>
                {!!detail?.chat?.length && (
                  <button onClick={handleClearChat} className="text-xs text-gray-300 hover:text-gray-500">清空</button>
                )}
              </div>
              {detail?.chat?.length ? (
                <div className="space-y-3 mb-3">
                  {detail.chat.map((m, i) => (
                    <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                      <div className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${m.role === "user" ? "bg-gray-900 text-white" : "bg-gray-50 text-gray-700"}`}>
                        {m.role === "user" ? m.content : <RichText text={m.content} className="leading-relaxed" />}
                      </div>
                    </div>
                  ))}
                  {asking && <p className="text-xs text-gray-300">正在想…</p>}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 mb-3">
                  {QUICK_QUESTIONS.map((q) => (
                    <button key={q} onClick={() => handleAsk(q)} disabled={asking}
                            className="text-xs px-2.5 py-1 border border-gray-200 rounded-full text-gray-500 hover:bg-gray-50 disabled:opacity-50">{q}</button>
                  ))}
                </div>
              )}
              {askErr && <p className="text-xs text-red-500 mb-2">{askErr}</p>}
              <div className="flex gap-2">
                <input value={question} onChange={(e) => setQuestion(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleAsk() }}
                       placeholder="哪里没看懂？直接问（中文英文都可以）"
                       className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-gray-400" />
                <button onClick={() => handleAsk()} disabled={!question.trim() || asking}
                        className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg disabled:opacity-40">发送</button>
              </div>
            </section>

            {/* 翻页 */}
            <div className="flex items-center justify-between mt-6 pt-5 border-t border-gray-100 gap-3">
              <button onClick={() => goPage(current - 1)} disabled={current <= 1}
                      className="text-sm text-gray-500 hover:text-gray-800 disabled:text-gray-200">← 上一页</button>
              <div className="flex gap-2">
                {showPractice && isSectionEnd && secIndex >= 0 && (
                  <button onClick={() => onNavigate("practice", sid, `section-${secIndex}`)}
                          className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50">练习这一章</button>
                )}
              </div>
              {!isLast ? (
                <button onClick={() => goPage(current + 1)} className="text-sm text-gray-800 font-medium hover:text-gray-600">下一页 →</button>
              ) : showPractice ? (
                <button onClick={() => onNavigate("practice", sid, "all")}
                        className="text-sm text-white bg-gray-900 px-4 py-1.5 rounded-lg hover:bg-gray-800">整讲练习 →</button>
              ) : (
                <button onClick={() => { setView(null); onNavigate("study") }} className="text-sm text-gray-400 hover:text-gray-600">完成</button>
              )}
            </div>
            <p className="text-center text-[11px] text-gray-300 mt-4 hidden md:block">键盘 ← → 也可以翻页</p>
            {error && <p className="text-xs text-red-500 mt-3 text-center">{error}</p>}
          </main>
        </div>
      </div>
    )
  }

  // =====================================================================
  // 输入页
  // =====================================================================
  return (
    <div className="min-h-screen bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-4 max-w-4xl mx-auto">
        <h2 className="text-sm font-medium text-gray-800 flex-1">爱学助手</h2>
        <button onClick={() => onNavigate("review")} className="text-xs text-gray-500 hover:text-gray-800">
          今日复习{reviewDue > 0 && <span className="ml-1 px-1.5 py-0.5 bg-red-500 text-white rounded-full text-[10px]">{reviewDue}</span>}
        </button>
        <button onClick={() => onNavigate("wrongbook")} className="text-xs text-gray-400 hover:text-gray-600">错题本</button>
        <button onClick={() => onNavigate("vocabularybook")} className="text-xs text-gray-400 hover:text-gray-600">术语</button>
        <button onClick={() => onNavigate("profile")} className="text-xs text-gray-400 hover:text-gray-600">我的</button>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center mb-8">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">今天学哪一讲？</h1>
          <p className="text-sm text-gray-400">上传英文课件，AI 一页一页讲给你听，哪里不懂就追问</p>
        </div>

        {/* 继续学习 */}
        {historyList.length > 0 && (
          <div className="mb-6">
            <p className="text-xs text-gray-400 mb-2">继续学习</p>
            <div className="space-y-1">
              {historyList.slice(0, 5).map((h) => (
                <button key={h.session_id} onClick={() => onNavigate("study", h.session_id)}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100 hover:bg-gray-50 text-left">
                  <span className="text-sm text-gray-700 truncate">{h.topic}</span>
                  <span className="text-xs text-gray-300 shrink-0 ml-3">{h.last_page ? `看到第 ${h.last_page} 页` : ""}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 上传 */}
        <label
          className={`flex flex-col items-center justify-center h-36 border-2 border-dashed rounded-xl cursor-pointer transition-colors mb-2
            ${dragOver ? "border-gray-500 bg-gray-100" : "border-gray-200 hover:border-gray-300 bg-gray-50/50"}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]) }}
        >
          <p className="text-sm text-gray-600 mb-1">{dragOver ? "松开鼠标上传" : "点击上传或拖拽课件到这里"}</p>
          <p className="text-xs text-gray-300">PPTX / PDF / DOCX，最大 20MB</p>
          <input ref={fileInputRef} type="file" accept=".pptx,.pdf,.docx" className="hidden"
                 onChange={(e) => handleFile(e.target.files?.[0])} />
        </label>
        <p className="text-[11px] text-gray-300 mb-6">小提示：PDF 能显示原页面截图，效果最好。同一份课件如果已经有同学学过，会直接秒开。</p>

        {/* 话题 */}
        <div className="mb-8">
          <p className="text-xs text-gray-400 mb-2">没有课件？输入一个想学的话题</p>
          <div className="flex gap-2">
            <input value={topic} onChange={(e) => setTopic(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleTopic() }}
                   placeholder='例如 "UML class diagram"、"Big-O notation"'
                   className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-gray-400" />
            <button onClick={handleTopic} disabled={!topic.trim() || !!busy}
                    className="px-4 py-2.5 text-sm bg-gray-900 text-white rounded-xl disabled:opacity-40">开始</button>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-50 border border-red-100 rounded-xl">
            <p className="text-xs text-red-500 whitespace-pre-wrap">{error}</p>
          </div>
        )}

        {/* 额度 & Key */}
        <div className="mb-4 p-4 bg-gray-50 border border-gray-100 rounded-xl">
          {quota?.own_key ? (
            <p className="text-xs text-gray-600">✅ 正在使用你自己的 {keyProvider} Key（{keyMasked}），不限次数</p>
          ) : quota ? (
            <>
              <p className="text-xs text-gray-700 font-medium">今日免费 AI 次数：剩余 {quota.remaining} / {quota.limit}</p>
              <p className="text-xs text-gray-400 mt-1">
                翻到没讲过的页、追问、出题批改才计次；同学已经生成过的讲解不计次。
                {quota.free_models.length > 0 && <> 当前免费模型：{quota.free_models.join(" → ")}</>}
              </p>
            </>
          ) : <p className="text-xs text-gray-300">正在读取额度…</p>}

          <div className="mt-3 pt-3 border-t border-gray-100">
            {keyMasked && !showKeyInput ? (
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500 flex-1">已保存你的 Key：{keyMasked}（加密存储）</span>
                <button onClick={() => setShowKeyInput(true)} className="text-xs text-gray-400 hover:text-gray-600">更换</button>
                <button onClick={handleDeleteKey} className="text-xs text-red-400 hover:text-red-600">删除</button>
              </div>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-2">想不限次数？填入你自己的 DeepSeek Key（sk- 开头）或 Gemini Key（AIza 开头）</p>
                <div className="flex gap-2">
                  <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)}
                         placeholder="粘贴 API Key"
                         className="flex-1 px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-gray-400 bg-white" />
                  <button onClick={handleSaveKey} disabled={!apiKeyInput.trim() || savingKey}
                          className="px-3 py-2 text-xs bg-gray-900 text-white rounded-lg disabled:opacity-40">{savingKey ? "保存中…" : "保存"}</button>
                  {keyMasked && <button onClick={() => setShowKeyInput(false)} className="text-xs text-gray-400">取消</button>}
                </div>
              </>
            )}
          </div>
        </div>

        {/* 功能开关 */}
        <div className="grid grid-cols-2 gap-2">
          <FeatureToggle label="显示英文术语" enabled={showEnglish} onChange={(v) => handleToggle("eng", v)} />
          <FeatureToggle label="练习系统" enabled={showPractice} onChange={(v) => handleToggle("prc", v)} />
        </div>

        <div className="text-center mt-10">
          <p className="text-xs text-gray-300">sansy02 制作</p>
          <button onClick={() => onNavigate("about")} className="text-xs text-gray-300 hover:text-gray-500 underline mt-1">关于我</button>
        </div>
      </div>
    </div>
  )
}
