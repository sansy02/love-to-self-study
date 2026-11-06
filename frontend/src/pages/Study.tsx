/**
 * 逐页学习（全屏专心模式）：左边原页面，右边讲解；每页可以追问；学完一讲提示做诊断小测。
 */
import { useState, useRef, useEffect, useCallback } from "react"
import {
  ensureOutline,
  getStudy,
  getPageDetail,
  explainPage,
  askPage,
  clearPageChat,
  saveProgress,
  exportStudy,
  getQuota,
  fetchImageUrl,
  listWords,
  addWord,
  deleteWord,
  toApiError,
  type Preferences,
  type StudyView,
  type PageDetail,
  type PageExplanation,
  type QuotaInfo,
  type KeyTerm,
} from "../api"
import RichText from "../components/RichText"
import ErrorPanel from "../components/ErrorPanel"
import KeyForm from "../components/KeyForm"
import Spinner from "../components/Spinner"
import { toast } from "../components/Toast"

interface StudyProps {
  preferences: Preferences
  initialSessionId: string
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
  onCourse?: (courseId: number | null) => void
}

const QUICK_QUESTIONS = ["用更简单的话再讲一遍", "举一个生活中的例子", "这页考试会怎么考？", "把这一页翻译成中文"]

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
}

export default function Study({ preferences, initialSessionId, onNavigate, onCourse }: StudyProps) {
  const [busy, setBusy] = useState<"" | "outline" | "open">("open")
  const [openErr, setOpenErr] = useState<unknown>(null)
  const [quota, setQuota] = useState<QuotaInfo | null>(null)
  const showEnglish = preferences.show_english
  const showPractice = preferences.show_practice

  const [view, setView] = useState<StudyView | null>(null)
  const [current, setCurrent] = useState(1)
  const [details, setDetails] = useState<Record<number, PageDetail>>({})
  const [explaining, setExplaining] = useState<Record<number, boolean>>({})
  const [explainErr, setExplainErr] = useState<Record<number, unknown>>({})
  const [images, setImages] = useState<Record<number, string>>({})
  const [visited, setVisited] = useState<Set<number>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showPageText, setShowPageText] = useState(false)
  const [mobileTab, setMobileTab] = useState<"explain" | "original">("explain")
  const [question, setQuestion] = useState("")
  const [asking, setAsking] = useState(false)
  const [askErr, setAskErr] = useState<unknown>(null)
  const [savedWords, setSavedWords] = useState<Record<string, number>>({})  // 小写术语 -> 收藏 id
  const [savingWord, setSavingWord] = useState("")
  const [exporting, setExporting] = useState(false)
  const [keyForm, setKeyForm] = useState(false)
  const imagesRef = useRef<Record<number, string>>({})
  const inflight = useRef<Set<string>>(new Set())
  const pendingSave = useRef<{ sid: string; page: number } | null>(null)

  // 离开学习页时，把还没来得及保存的进度存掉
  useEffect(() => () => {
    const p = pendingSave.current
    if (p) saveProgress(p.sid, p.page).catch(() => {})
  }, [])

  const refreshQuota = useCallback(() => {
    getQuota().then(setQuota).catch(() => {})
  }, [])

  useEffect(() => {
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
    setOpenErr(null)
    setBusy("open")
    try {
      let v = await getStudy(sid)
      onCourse?.(v.course?.id ?? null)
      if (!v.outline_ready) {
        setBusy("outline")
        v = await ensureOutline(sid)
      }
      setView(v)
      setVisited(new Set(v.progress.visited || []))
      const last = Math.min(Math.max(v.progress.last_page || 1, 1), v.page_count || 1)
      setCurrent(last)
      setDetails({}); setExplainErr({})
    } catch (e) {
      setOpenErr(e)
    } finally {
      setBusy("")
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { openSession(initialSessionId) }, [initialSessionId, openSession])

  const sid = view?.session_id || ""
  const back = () => onNavigate("course")

  const loadExplanation = useCallback(async (pageNo: number, isPrefetch = false) => {
    if (!sid) return
    const key = `${sid}:${pageNo}`
    if (inflight.current.has(key)) return
    inflight.current.add(key)
    if (!isPrefetch) {
      setExplaining((p) => ({ ...p, [pageNo]: true }))
      setExplainErr((p) => ({ ...p, [pageNo]: null }))
    }
    try {
      const r = await explainPage(sid, pageNo)
      setDetails((p) => (p[pageNo] ? { ...p, [pageNo]: { ...p[pageNo], explanation: r.explanation } } : p))
      setView((v) => v ? { ...v, pages: v.pages.map((pg) => pg.page_no === pageNo ? { ...pg, explained: true } : pg) } : v)
      if (!r.cached) refreshQuota()
    } catch (e) {
      if (!isPrefetch) setExplainErr((p) => ({ ...p, [pageNo]: e }))
    } finally {
      inflight.current.delete(key)
      if (!isPrefetch) setExplaining((p) => ({ ...p, [pageNo]: false }))
    }
  }, [sid, refreshQuota])

  useEffect(() => {
    if (!view || !sid) return
    let cancelled = false
    const pageNo = current
    setQuestion(""); setAskErr(null); setKeyForm(false)
    const meta = view.pages.find((p) => p.page_no === pageNo)
    setShowPageText(!meta?.has_image)

    getPageDetail(sid, pageNo).then((d) => {
      if (cancelled) return
      setDetails((p) => ({ ...p, [pageNo]: { ...d, explanation: p[pageNo]?.explanation || d.explanation } }))
      if (!d.explanation) loadExplanation(pageNo)
    }).catch((e) => { if (!cancelled) setExplainErr((p) => ({ ...p, [pageNo]: e })) })

    if (meta?.has_image && !imagesRef.current[pageNo]) {
      fetchImageUrl(`/study/${sid}/pages/${pageNo}/image`).then((url) => {
        imagesRef.current[pageNo] = url
        setImages((p) => ({ ...p, [pageNo]: url }))
      }).catch(() => {})
    }

    setVisited((s) => { const n = new Set(s); n.add(pageNo); return n })
    pendingSave.current = { sid, page: pageNo }
    const t = setTimeout(() => {
      pendingSave.current = null
      saveProgress(sid, pageNo).catch(() => {})
    }, 600)
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
    setMobileTab("explain")
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const handleAsk = async (q?: string) => {
    const text = (q ?? question).trim()
    if (!text || !sid || asking) return
    const pageNo = current
    setAsking(true); setAskErr(null)
    setDetails((p) => ({ ...p, [pageNo]: { ...p[pageNo], chat: [...(p[pageNo]?.chat || []), { role: "user", content: text }] } }))
    setQuestion("")
    try {
      const r = await askPage(sid, pageNo, text)
      setDetails((p) => ({ ...p, [pageNo]: { ...p[pageNo], chat: [...(p[pageNo]?.chat || []), { role: "assistant", content: r.answer }] } }))
      refreshQuota()
    } catch (e) {
      setAskErr(e)
      setDetails((p) => ({ ...p, [pageNo]: { ...p[pageNo], chat: (p[pageNo]?.chat || []).slice(0, -1) } }))
      setQuestion(text)
    } finally { setAsking(false) }
  }

  const handleClearChat = async () => {
    if (!sid) return
    try {
      await clearPageChat(sid, current)
      setDetails((p) => ({ ...p, [current]: { ...p[current], chat: [] } }))
      toast("已清空这一页的追问", "success")
    } catch { toast("清空失败，请重试", "error") }
  }

  const toggleWord = async (t: KeyTerm) => {
    const k = t.en.toLowerCase()
    if (savingWord) return
    setSavingWord(k)
    try {
      if (savedWords[k]) {
        await deleteWord(savedWords[k])
        setSavedWords((m) => { const n = { ...m }; delete n[k]; return n })
        toast(`已取消收藏 ${t.en}`)
      } else {
        const w = await addWord({ word: t.en, translation: t.zh, note: t.note, session_id: sid, page_no: current })
        setSavedWords((m) => ({ ...m, [k]: w.id }))
        toast(`已收藏 ${t.en}，明天会出现在「今日复习」`, "success")
      }
    } catch { toast("收藏没成功，请再点一次", "error") } finally { setSavingWord("") }
  }

  const handleExport = async () => {
    if (!sid || exporting) return
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
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.8;color:#322b3d}
h1{text-align:center;font-weight:500}h2{font-size:1.05em;border-top:1px solid #e4e0ea;padding-top:20px;margin-top:28px}
pre{white-space:pre-wrap;background:#f8f7fa;padding:12px;border-radius:8px;font-size:.85em;color:#5c546a}
.sum{font-weight:600}.terms{font-size:.9em;color:#5c546a}.eg{background:#faf7f0;padding:10px 14px;border-radius:8px;margin:8px 0}
.tip{background:#f4f2f8;padding:10px 14px;border-radius:8px;margin:8px 0}.none{color:#6d657a}</style></head>
<body><h1>${escapeHtml(data.title)}</h1>${pagesHtml}</body></html>`
      const blob = new Blob([html], { type: "text/html;charset=utf-8" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `${data.title || "讲解"}.html`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      toast("已导出为网页文件", "success")
    } catch (e) {
      toast(toApiError(e).message || "导出失败", "error")
    } finally { setExporting(false) }
  }

  // =====================================================================
  // 打开中 / 打开失败
  // =====================================================================
  if (!view) {
    if (openErr) {
      return (
        <div className="min-h-screen flex items-center justify-center px-6">
          <div className="w-full max-w-sm">
            <ErrorPanel error={openErr} actions={{ onRetry: () => openSession(initialSessionId), onHome: () => onNavigate("home") }} />
            <button onClick={back} className="w-full mt-3 text-xs text-gray-500 hover:text-gray-800">← 返回课程</button>
          </div>
        </div>
      )
    }
    const msg = busy === "outline"
      ? ["正在整理章节大纲…", "只生成大纲，很快；每一页的讲解会在你打开时再生成"]
      : ["正在打开…", ""]
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center animate-fade-in">
        <Spinner size={22} />
        <p className="text-sm text-gray-600">{msg[0]}</p>
        <div className="w-56 h-1 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full bg-gray-400 rounded-full animate-pulse transition-all duration-500" style={{ width: busy === "outline" ? "60%" : "30%" }} />
        </div>
        {msg[1] && <p className="text-xs text-gray-400">{msg[1]}</p>}
      </div>
    )
  }

  // =====================================================================
  // 逐页学习页
  // =====================================================================
  const detail = details[current]
  const expl: PageExplanation | null | undefined = detail?.explanation
  const secIndex = view.sections.findIndex((s) => s.start <= current && current <= s.end)
  const sec = secIndex >= 0 ? view.sections[secIndex] : null
  const isSectionEnd = !!sec && current === sec.end
  const isLast = current === view.page_count
  const meta = view.pages.find((p) => p.page_no === current)
  const img = images[current]
  const isSample = view.source_type === "sample"
  const diag = view.diagnostic

  const original = (
    <section className="border border-gray-100 rounded-2xl p-4 md:p-5 bg-gray-50/60">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-400 tracking-wide">原页面</p>
        {meta?.has_image && detail?.text && (
          <button onClick={() => setShowPageText(!showPageText)} className="text-xs text-gray-400 hover:text-gray-700">
            {showPageText ? "收起文字" : "看文字"}
          </button>
        )}
      </div>
      {meta?.has_image && (
        img ? (
          <img src={img} alt={`第 ${current} 页`} className="w-full rounded-lg border border-gray-100 bg-white mb-3 animate-fade-in" />
        ) : (
          <div className="w-full aspect-video rounded-lg bg-gray-100 animate-pulse mb-3" />
        )
      )}
      {meta?.image_kind === "picture" && (
        <p className="text-[11px] text-gray-400 -mt-1 mb-2">PPT 只能显示页面里的图片；想看完整原页面，可以把 PPT 另存为 PDF 再上传</p>
      )}
      {(showPageText || !meta?.has_image) && (
        detail ? (
          <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words font-sans leading-relaxed">
            {detail.text || "（这一页没有文字）"}
          </pre>
        ) : <div className="space-y-2"><div className="h-3 bg-gray-100 rounded animate-pulse" /><div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" /></div>
      )}
      {detail?.notes && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <p className="text-[11px] text-gray-400 mb-1">老师备注</p>
          <p className="text-xs text-gray-600 whitespace-pre-wrap">{detail.notes}</p>
        </div>
      )}
    </section>
  )

  const explanation = (
    <section className="border border-gray-100 rounded-2xl p-4 md:p-5 bg-white">
      <p className="text-xs text-gray-400 tracking-wide mb-3">讲解</p>
      {expl ? (
        <div key={current} className="animate-fade-in">
          {expl.summary && (
            <div className="mb-4 pl-3 border-l-2 border-gray-300">
              <p className="text-[11px] text-gray-400 mb-0.5">一句话</p>
              <p className="font-serif text-[15px] text-gray-900 leading-relaxed">{expl.summary}</p>
            </div>
          )}
          <RichText text={expl.explanation} className="text-sm text-gray-700 leading-7 break-words" />
          {expl.example && (
            <div className="mt-4 bg-amber-50 border border-amber-100 rounded-xl p-3">
              <p className="text-xs text-amber-600 mb-1">例子</p>
              <RichText text={expl.example} className="text-sm text-gray-700 leading-relaxed" />
            </div>
          )}
          {expl.exam_tip && (
            <div className="mt-3 bg-blue-50 border border-blue-100 rounded-xl p-3">
              <p className="text-xs text-blue-600 mb-1">考试提示</p>
              <RichText text={expl.exam_tip} className="text-sm text-gray-700 leading-relaxed" />
            </div>
          )}
          {showEnglish && expl.key_terms.length > 0 && (
            <div className="mt-5">
              <p className="text-xs text-gray-400 mb-2">本页术语（点 ☆ 收藏，之后在「今日复习」里背）</p>
              <div className="space-y-2">
                {expl.key_terms.map((t) => {
                  const saved = !!savedWords[t.en.toLowerCase()]
                  const saving = savingWord === t.en.toLowerCase()
                  return (
                    <div key={t.en} className="flex items-start gap-2 text-sm">
                      <button onClick={() => toggleWord(t)} disabled={!!savingWord}
                              className={`shrink-0 w-6 h-6 -mt-0.5 rounded-full flex items-center justify-center hover:bg-gray-100
                                ${saved ? "text-amber-500" : "text-gray-400 hover:text-gray-600"}`}
                              title={saved ? "取消收藏" : "收藏"} aria-pressed={saved}>
                        {saving ? <Spinner size={11} /> : saved ? "★" : "☆"}
                      </button>
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
        </div>
      ) : explainErr[current] ? (
        keyForm ? (
          <KeyForm autoFocus onCancel={() => setKeyForm(false)} onSaved={() => {
            setKeyForm(false); refreshQuota(); loadExplanation(current)
          }} />
        ) : (
          <ErrorPanel error={explainErr[current]} actions={{
            onRetry: () => loadExplanation(current), retrying: !!explaining[current],
            onUseKey: () => setKeyForm(true),
            onHome: back,
          }} />
        )
      ) : (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-4">
            <Spinner size={12} />
            {explaining[current] ? "正在讲解这一页（第一次打开需要几秒，之后全班秒开）" : "加载中…"}
          </div>
          <div className="h-4 bg-gray-100 rounded animate-pulse w-4/5 mb-4" />
          <div className="h-3 bg-gray-100 rounded animate-pulse" />
          <div className="h-3 bg-gray-100 rounded animate-pulse w-11/12" />
          <div className="h-3 bg-gray-100 rounded animate-pulse w-2/3" />
        </div>
      )}
    </section>
  )

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶部栏：返回课程 · 标题 · 页码 · 导出 · 练习（次要按钮） */}
      <div className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="md:hidden text-gray-500 p-1 -m-1 rounded" aria-label="目录">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
            {sidebarOpen ? <path d="M4 4l10 10M14 4L4 14" strokeLinecap="round" /> : <path d="M2 4h14M2 9h14M2 14h14" strokeLinecap="round" />}
          </svg>
        </button>
        <button onClick={back} className="text-xs text-gray-400 hover:text-gray-700 shrink-0 max-w-[30%] truncate">
          ← {view.course?.name || "返回课程"}
        </button>
        <h2 className="text-sm text-gray-800 truncate flex-1">{view.title}</h2>
        <span className="text-xs text-gray-400 shrink-0 tabular-nums">{current} / {view.page_count}</span>
        <button onClick={handleExport} disabled={exporting} className="hidden sm:inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 shrink-0 disabled:opacity-60" title="把已生成的讲解导出为网页">
          {exporting && <Spinner size={11} />}{exporting ? "导出中" : "导出"}
        </button>
        {showPractice && (
          <button onClick={() => onNavigate("practice", sid, "all")}
                  className="hidden sm:inline text-xs px-3 py-1.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 shrink-0">练习</button>
        )}
      </div>

      {sidebarOpen && <div className="md:hidden fixed inset-0 bg-gray-900/20 z-40 animate-fade-in" onClick={() => setSidebarOpen(false)} />}

      <div className="flex flex-1">
        {/* 左侧目录 */}
        <aside className={`md:sticky md:top-[53px] md:h-[calc(100vh-53px)] md:translate-x-0 fixed left-0 top-[53px] bottom-0 z-50
          w-64 md:w-60 border-r border-gray-100 bg-white overflow-y-auto p-3 shrink-0 transition-transform duration-300
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
          {isSample && (
            <p className="text-[11px] text-blue-600 bg-blue-50 rounded-lg p-2 mb-3 leading-relaxed">这是示例课程：讲解和题目都是提前写好的，不消耗 AI 次数。</p>
          )}
          {view.outline_fallback && (
            <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg p-2 mb-3">AI 暂时不可用，先按页码简单分了章节</p>
          )}
          {view.sections.map((s, i) => (
            <div key={i} className="mb-4">
              <p className={`text-xs px-2 mb-1 leading-relaxed ${i === secIndex ? "text-gray-900 font-medium" : "text-gray-500"}`}>{s.title}</p>
              {Array.from({ length: s.end - s.start + 1 }, (_, k) => s.start + k).map((n) => {
                const pm = view.pages.find((p) => p.page_no === n)
                return (
                  <button key={n} onClick={() => goPage(n)}
                          aria-current={n === current ? "page" : undefined}
                          className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2
                            ${n === current ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:bg-gray-50"}`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${visited.has(n) ? "bg-gray-400" : "bg-gray-200"}`} />
                    <span className="shrink-0 text-gray-400 w-5 tabular-nums">{n}</span>
                    <span className="truncate">{pm?.title || `第 ${n} 页`}</span>
                  </button>
                )
              })}
              {showPractice && (
                <button onClick={() => onNavigate("practice", sid, `section-${i}`)}
                        className="ml-2 mt-1 text-[11px] text-blue-600 hover:text-blue-700">练习这一章 →</button>
              )}
            </div>
          ))}
          <div className="border-t border-gray-100 pt-3 mt-2 space-y-1">
            <button onClick={() => onNavigate("practice", sid, "diagnostic")}
                    className="w-full text-left px-2 py-1.5 rounded-md text-xs text-gray-600 hover:bg-gray-50">
              诊断小测{diag ? `（上次 ${diag.correct}/${diag.total}）` : ""}
            </button>
            {showPractice && (
              <button onClick={() => onNavigate("practice", sid, "all")}
                      className="w-full text-left px-2 py-1.5 rounded-md text-xs text-gray-600 hover:bg-gray-50 sm:hidden">整讲练习</button>
            )}
          </div>
        </aside>

        {/* 主体 */}
        <main className="flex-1 min-w-0 px-4 py-5 md:p-8 max-w-6xl">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-4">
            <p className="text-xs text-gray-400">{sec ? sec.title : ""}{sec ? " · " : ""}第 {current} 页</p>
            {view.style_summary && (
              <button onClick={() => onNavigate("profile")} title="修改我的学习方式"
                      className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 text-gray-500 hover:text-gray-800">
                {isSample ? "示例课程的讲解是固定的" : `讲解方式：${view.style_summary}`}
              </button>
            )}
          </div>

          {/* 手机：讲解 / 原页面 切换 */}
          <div className="lg:hidden flex p-1 bg-gray-100 rounded-xl mb-4" role="tablist">
            {([["explain", "讲解"], ["original", "原页面"]] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={mobileTab === k} onClick={() => setMobileTab(k)}
                      className={`flex-1 py-1.5 text-xs rounded-lg ${mobileTab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>{label}</button>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-5">
            <div className={mobileTab === "original" ? "hidden lg:block lg:order-2" : "lg:order-2"}>{explanation}</div>
            <div className={mobileTab === "explain" ? "hidden lg:block lg:order-1" : "lg:order-1"}>{original}</div>
          </div>

          {/* 学完一讲：提示做诊断小测 */}
          {isLast && (
            <section className="mt-5 p-5 rounded-2xl border border-gray-200 bg-gray-50 animate-fade-in">
              <p className="font-serif text-base text-gray-900">这一讲学完了</p>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                {diag
                  ? `上次诊断答对 ${diag.correct} / ${diag.total}。可以再做一次，看看有没有进步。`
                  : "花 2 分钟做 5 道选择 / 填空题，看看哪些知识点还没懂。结果会算进这门课的知识点掌握度。"}
              </p>
              <div className="flex flex-wrap gap-2 mt-4">
                <button onClick={() => onNavigate("practice", sid, "diagnostic")}
                        className="px-4 py-2 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-800">做诊断小测</button>
                {showPractice && (
                  <button onClick={() => onNavigate("practice", sid, "all")}
                          className="px-4 py-2 text-sm border border-gray-200 bg-white text-gray-700 rounded-xl hover:bg-gray-50">整讲练习（10 题）</button>
                )}
              </div>
            </section>
          )}

          {/* 追问这一页 */}
          <section className="mt-5 border border-gray-100 rounded-2xl p-4 md:p-5 bg-white">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-gray-400 tracking-wide">追问这一页</p>
              {!!detail?.chat?.length && (
                <button onClick={handleClearChat} className="text-xs text-gray-400 hover:text-gray-700">清空</button>
              )}
            </div>
            {detail?.chat?.length ? (
              <div className="space-y-3 mb-3">
                {detail.chat.map((m, i) => (
                  <div key={i} className={`animate-fade-in ${m.role === "user" ? "flex justify-end" : ""}`}>
                    <div className={`max-w-[90%] rounded-2xl px-3.5 py-2 text-sm ${m.role === "user" ? "bg-gray-900 text-white" : "bg-gray-50 text-gray-700"}`}>
                      {m.role === "user" ? m.content : <RichText text={m.content} className="leading-relaxed" />}
                    </div>
                  </div>
                ))}
                {asking && <p className="text-xs text-gray-400 inline-flex items-center gap-1.5"><Spinner size={11} />正在想…</p>}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 mb-3">
                {QUICK_QUESTIONS.map((q) => (
                  <button key={q} onClick={() => handleAsk(q)} disabled={asking}
                          className="text-xs px-3 py-1.5 border border-gray-200 rounded-full text-gray-600 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-50">{q}</button>
                ))}
                {asking && <span className="text-xs text-gray-400 inline-flex items-center gap-1.5"><Spinner size={11} />正在想…</span>}
              </div>
            )}
            {!!askErr && <div className="mb-3"><ErrorPanel compact error={askErr} actions={{ onRetry: () => handleAsk(), onUseKey: () => { setAskErr(null); onNavigate("profile") } }} /></div>}
            <div className="flex gap-2">
              <input value={question} onChange={(e) => setQuestion(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleAsk() }}
                     placeholder="哪里没看懂？直接问（中文英文都可以）"
                     className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none" />
              <button onClick={() => handleAsk()} disabled={!question.trim() || asking}
                      className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-1.5">
                {asking && <Spinner size={12} light />}发送
              </button>
            </div>
          </section>

          {/* 翻页 */}
          <div className="flex items-center justify-between mt-6 pt-5 border-t border-gray-100 gap-3">
            <button onClick={() => goPage(current - 1)} disabled={current <= 1}
                    className="text-sm text-gray-500 hover:text-gray-800 disabled:text-gray-300 px-2 py-1 -mx-2 rounded-lg">← 上一页</button>
            <div className="flex gap-2">
              {showPractice && isSectionEnd && !isLast && secIndex >= 0 && (
                <button onClick={() => onNavigate("practice", sid, `section-${secIndex}`)}
                        className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50">练习这一章</button>
              )}
            </div>
            {!isLast ? (
              <button onClick={() => goPage(current + 1)} className="text-sm text-gray-800 hover:text-gray-600 px-2 py-1 -mx-2 rounded-lg">下一页 →</button>
            ) : (
              <button onClick={back} className="text-sm text-gray-500 hover:text-gray-800 px-2 py-1 -mx-2 rounded-lg">回到课程</button>
            )}
          </div>
          <p className="text-center text-[11px] text-gray-400 mt-4 hidden md:block">键盘 ← → 也可以翻页</p>
        </main>
      </div>
    </div>
  )
}
