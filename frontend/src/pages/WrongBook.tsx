import { useState, useEffect } from "react"
import { getWrongBook, retryWrong, removeWrong, type WrongBookEntry } from "../api"
import RichText from "../components/RichText"

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
  const [error, setError] = useState("")

  useEffect(() => {
    getWrongBook()
      .then((data) => setEntries(data.entries))
      .catch((e) => setError(e.message || "加载失败"))
      .finally(() => setLoading(false))
  }, [])

  const handleRetry = async () => {
    if (entries.length === 0) return
    setRetrying(true); setError("")
    try {
      const result = await retryWrong(entries.map((e) => e.exercise_id))
      onNavigate("practice", result.session_id, "retry")
    } catch (e: any) {
      setError(e.message || "重练生成失败，请稍后重试")
    } finally {
      setRetrying(false)
    }
  }

  const handleRemove = async (id: number) => {
    try {
      await removeWrong(id)
      setEntries((list) => list.filter((e) => e.id !== id))
    } catch {}
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
      </div>
    )
  }

  const counts = { choice: 0, blank: 0, short_answer: 0 } as Record<string, number>
  entries.forEach((e) => { counts[e.question_type] = (counts[e.question_type] || 0) + 1 })

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-4">
        <button onClick={() => onNavigate("study")} className="text-xs text-gray-400 hover:text-gray-600">← 返回</button>
        <h2 className="text-sm font-medium text-gray-800 flex-1">📖 错题本</h2>
        <button onClick={() => onNavigate("review")} className="text-xs text-gray-500 hover:text-gray-800">今日复习</button>
        {entries.length > 0 && (
          <button onClick={handleRetry} disabled={retrying}
                  className="text-xs px-3 py-1 bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
            {retrying ? "出题中…" : "🔄 按错题出一套新题"}
          </button>
        )}
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-8">
        {error && <p className="text-xs text-red-500 mb-4">{error}</p>}
        {entries.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-4">🎉</p>
            <p className="text-sm text-gray-400">没有待复习的错题，继续保持！</p>
          </div>
        ) : (
          <>
            <div className="flex gap-4 mb-8">
              {(["choice", "blank", "short_answer"] as const).map((t) => (
                <div key={t} className="flex-1 p-3 bg-gray-50 rounded-xl text-center">
                  <p className="text-lg font-semibold text-gray-800">{counts[t] || 0}</p>
                  <p className="text-xs text-gray-400">{TYPE_LABEL[t]}</p>
                </div>
              ))}
            </div>

            <div className="space-y-4">
              {entries.map((entry, i) => (
                <div key={entry.id} className="p-4 bg-red-50/60 border border-red-100 rounded-xl">
                  <div className="flex items-start gap-2 mb-2">
                    <span className="text-xs font-medium text-red-400 shrink-0 mt-0.5">{i + 1}.</span>
                    <div className="flex-1">
                      <p className="text-sm text-gray-800 whitespace-pre-wrap">{entry.question}</p>
                      <span className="text-xs text-gray-400">
                        {TYPE_LABEL[entry.question_type] || entry.question_type}
                        {entry.page_no ? ` · 第 ${entry.page_no} 页` : ""} · {reviewText(entry)}
                      </span>
                    </div>
                  </div>

                  <div className="ml-5 space-y-1 mb-2">
                    <p className="text-xs">
                      <span className="text-red-400">你的答案：</span>
                      <span className="text-red-500">{entry.user_answer || "未作答"}</span>
                    </p>
                    <p className="text-xs">
                      <span className="text-green-500">{entry.question_type === "short_answer" ? "参考答案：" : "正确答案："}</span>
                      <span className="text-green-700">{entry.correct_answer}</span>
                    </p>
                  </div>

                  <div className="ml-5 flex gap-4">
                    <button onClick={() => setOpen((p) => ({ ...p, [entry.id]: !p[entry.id] }))} className="text-xs text-blue-500">
                      {open[entry.id] ? "收起解析" : "查看解析"}
                    </button>
                    {entry.session_id && (
                      <button onClick={() => onNavigate("study", entry.session_id)} className="text-xs text-gray-400 hover:text-gray-600">回到课件</button>
                    )}
                    <button onClick={() => handleRemove(entry.id)} className="text-xs text-gray-400 hover:text-gray-600">已经会了，移出</button>
                  </div>
                  {open[entry.id] && (
                    <div className="ml-5 mt-2 space-y-2 text-xs text-gray-700">
                      {entry.feedback?.content && <div className="bg-white p-2 rounded"><RichText text={entry.feedback.content} /></div>}
                      {entry.feedback?.language && <div className="bg-white p-2 rounded"><p className="text-gray-400">英文表达</p><RichText text={entry.feedback.language} /></div>}
                      {entry.feedback?.improved && <div className="bg-white p-2 rounded"><p className="text-gray-400">高分写法</p><p className="italic">{entry.feedback.improved}</p></div>}
                      {entry.explanation && <div className="bg-white p-2 rounded"><RichText text={entry.explanation} /></div>}
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
