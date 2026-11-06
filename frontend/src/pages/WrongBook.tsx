import { useState, useEffect } from "react"
import { getWrongBook, retryWrong, removeWrong, type WrongBookEntry } from "../api"
import RichText from "../components/RichText"
import ErrorPanel from "../components/ErrorPanel"
import Spinner from "../components/Spinner"
import { KpChips, ErrorReasonPicker } from "../components/Learning"
import { toast } from "../components/Toast"

interface WrongBookProps {
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
}

const TYPE_LABEL: Record<string, string> = { choice: "选择题", blank: "填空题", short_answer: "简答题" }

function reviewText(e: WrongBookEntry): string {
  if (e.mastered) return "已掌握"
  if (!e.next_review_at) return "待复习"
  const ms = new Date(e.next_review_at + "Z").getTime() - Date.now()
  if (ms <= 0) return "今天复习"
  return `${Math.max(1, Math.round(ms / 86400000))} 天后复习`
}

export default function WrongBook({ onNavigate }: WrongBookProps) {
  const [entries, setEntries] = useState<WrongBookEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [removing, setRemoving] = useState<number | null>(null)

  useEffect(() => {
    getWrongBook()
      .then((data) => setEntries(data.entries))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  const handleRetry = async () => {
    if (entries.length === 0) return
    if (retrying) return
    setRetrying(true); setError(null)
    try {
      const result = await retryWrong(entries.map((e) => e.exercise_id))
      onNavigate("practice", result.session_id, "retry")
    } catch (e) {
      setError(e)
    } finally {
      setRetrying(false)
    }
  }

  const handleRemove = async (id: number) => {
    if (removing) return
    setRemoving(id)
    try {
      await removeWrong(id)
      setEntries((list) => list.filter((e) => e.id !== id))
      toast("已移出错题本", "success")
    } catch { toast("没移出成功，请重试", "error") } finally { setRemoving(null) }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center"><Spinner size={20} /></div>
    )
  }

  const counts = { choice: 0, blank: 0, short_answer: 0 } as Record<string, number>
  entries.forEach((e) => { counts[e.question_type] = (counts[e.question_type] || 0) + 1 })

  return (
    <div className="min-h-screen flex flex-col">
      <div className="max-w-2xl mx-auto w-full px-4 pt-6 md:pt-10 flex items-center gap-4">
        <h1 className="font-serif text-2xl text-gray-900 tracking-wide flex-1">错题本</h1>
        <button onClick={() => onNavigate("review")} className="text-xs text-gray-500 hover:text-gray-800">今日复习</button>
        {entries.length > 0 && (
          <button onClick={handleRetry} disabled={retrying}
                  className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50 inline-flex items-center gap-1.5">
            {retrying && <Spinner size={11} light />}{retrying ? "出题中…" : "按错题出一套新题"}
          </button>
        )}
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-8">
        {!!error && <div className="mb-4"><ErrorPanel error={error} actions={{ onRetry: entries.length ? handleRetry : () => window.location.reload(), retrying }} /></div>}
        {entries.length === 0 ? (
          <div className="text-center py-20">
            <p className="font-serif text-lg text-gray-800 mb-2">没有待复习的错题</p>
            <p className="text-xs text-gray-400">做练习答错的题会收在这里，并安排到第二天复习</p>
          </div>
        ) : (
          <>
            <div className="flex gap-4 mb-8">
              {(["choice", "blank", "short_answer"] as const).map((t) => (
                <div key={t} className="flex-1 p-3 bg-gray-50 border border-gray-100 rounded-xl text-center">
                  <p className="font-serif text-xl text-gray-800 tabular-nums">{counts[t] || 0}</p>
                  <p className="text-xs text-gray-400">{TYPE_LABEL[t]}</p>
                </div>
              ))}
            </div>

            <div className="space-y-4">
              {entries.map((entry, i) => (
                <div key={entry.id} className="p-4 bg-white border border-gray-100 rounded-2xl">
                  <div className="flex items-start gap-2 mb-2">
                    <span className="text-xs text-gray-400 shrink-0 mt-0.5 tabular-nums">{i + 1}.</span>
                    <div className="flex-1">
                      <p className="text-sm text-gray-800 whitespace-pre-wrap">{entry.question}</p>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                        <span className="text-xs text-gray-400">
                          {TYPE_LABEL[entry.question_type] || entry.question_type}
                          {entry.page_no ? ` · 第 ${entry.page_no} 页` : ""} · {reviewText(entry)}
                        </span>
                        <KpChips kps={entry.kps} />
                      </div>
                    </div>
                  </div>

                  <div className="ml-5 space-y-1 mb-2">
                    <p className="text-xs">
                      <span className="text-gray-400">你的答案：</span>
                      <span className="text-red-500">{entry.user_answer || "未作答"}</span>
                    </p>
                    <p className="text-xs">
                      <span className="text-gray-400">{entry.question_type === "short_answer" ? "参考答案：" : "正确答案："}</span>
                      <span className="text-green-700">{entry.correct_answer}</span>
                    </p>
                  </div>

                  <div className="ml-5 flex gap-4">
                    <button onClick={() => setOpen((p) => ({ ...p, [entry.id]: !p[entry.id] }))} className="text-xs text-blue-600 hover:text-blue-700">
                      {open[entry.id] ? "收起解析" : "查看解析"}
                    </button>
                    {entry.session_id && (
                      <button onClick={() => onNavigate("study", entry.session_id)} className="text-xs text-gray-400 hover:text-gray-600">回到课件</button>
                    )}
                    <button onClick={() => handleRemove(entry.id)} disabled={removing === entry.id} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-50">已经会了，移出</button>
                  </div>
                  <div className="ml-5"><ErrorReasonPicker attemptId={entry.attempt_id} value={entry.error_reason} /></div>
                  {open[entry.id] && (
                    <div className="ml-5 mt-2 space-y-2 text-xs text-gray-700">
                      {entry.feedback?.content && <div className="bg-gray-50 p-2.5 rounded-lg"><RichText text={entry.feedback.content} /></div>}
                      {entry.feedback?.language && <div className="bg-gray-50 p-2.5 rounded-lg"><p className="text-gray-400">英文表达</p><RichText text={entry.feedback.language} /></div>}
                      {entry.feedback?.improved && <div className="bg-gray-50 p-2.5 rounded-lg"><p className="text-gray-400">高分写法</p><p className="italic">{entry.feedback.improved}</p></div>}
                      {entry.explanation && <div className="bg-gray-50 p-2.5 rounded-lg"><RichText text={entry.explanation} /></div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
