import { useState, useEffect } from "react"
import { getWrongBook, retryWrong, type WrongBookEntry } from "../api"

interface WrongBookProps {
  onNavigate: (page: string, sessionId?: string) => void
}

export default function WrongBook({ onNavigate }: WrongBookProps) {
  const [entries, setEntries] = useState<WrongBookEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showExplanation, setShowExplanation] = useState<Record<number, boolean>>({})
  const [retrying, setRetrying] = useState(false)

  const handleRetry = async () => {
    if (entries.length === 0) return
    setRetrying(true)
    try {
      const result = await retryWrong(entries.map(e => e.exercise_id))
      onNavigate("practice", result.session_id)
    } catch {
      alert("重练生成失败，请稍后重试")
    } finally {
      setRetrying(false)
    }
  }

  useEffect(() => {
    getWrongBook()
      .then((data) => setEntries(data.entries))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const choices = entries.filter((e) => e.question_type === "choice")
  const blanks = entries.filter((e) => e.question_type === "blank")
  const shorts = entries.filter((e) => e.question_type === "short_answer")

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* 顶部栏 */}
      <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-4">
        <button
          onClick={() => onNavigate("study")}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          ← 返回
        </button>
        <h2 className="text-sm font-medium text-gray-800 flex-1">📖 错题本</h2>
        {entries.length > 0 && (
          <button onClick={handleRetry} disabled={retrying}
                  className="text-xs px-3 py-1 bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
            {retrying ? "生成中..." : "🔄 重练全部"}
          </button>
        )}
        <span className="text-xs text-gray-400">{entries.length} 道错题</span>
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-8">
        {entries.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-4">🎉</p>
            <p className="text-sm text-gray-400">没有错题，继续保持！</p>
          </div>
        ) : (
          <>
            {/* 统计 */}
            <div className="flex gap-4 mb-8">
              <div className="flex-1 p-3 bg-gray-50 rounded-xl text-center">
                <p className="text-lg font-semibold text-gray-800">{choices.length}</p>
                <p className="text-xs text-gray-400">选择题</p>
              </div>
              <div className="flex-1 p-3 bg-gray-50 rounded-xl text-center">
                <p className="text-lg font-semibold text-gray-800">{blanks.length}</p>
                <p className="text-xs text-gray-400">填空题</p>
              </div>
              <div className="flex-1 p-3 bg-gray-50 rounded-xl text-center">
                <p className="text-lg font-semibold text-gray-800">{shorts.length}</p>
                <p className="text-xs text-gray-400">简答题</p>
              </div>
            </div>

            {/* 错题列表 */}
            <div className="space-y-4">
              {entries.map((entry, i) => (
                <div key={entry.id} className="p-4 bg-red-50 border border-red-100 rounded-xl">
                  <div className="flex items-start gap-2 mb-2">
                    <span className="text-xs font-medium text-red-400 shrink-0 mt-0.5">
                      {i + 1}.
                    </span>
                    <div>
                      <p className="text-sm text-gray-800">{entry.question}</p>
                      <span className="text-xs text-gray-400">
                        {entry.question_type === "choice" ? "选择题" : entry.question_type === "blank" ? "填空题" : "简答题"}
                      </span>
                    </div>
                  </div>

                  {/* 用户答案 vs 正确答案 */}
                  <div className="ml-5 space-y-1 mb-2">
                    <p className="text-xs">
                      <span className="text-red-400">你的答案：</span>
                      <span className="text-red-500 line-through">{entry.user_answer || "未作答"}</span>
                    </p>
                    <p className="text-xs">
                      <span className="text-green-500">正确答案：</span>
                      <span className="text-green-600">{entry.correct_answer}</span>
                    </p>
                  </div>

                  {/* 解析 */}
                  {entry.explanation && (
                    <div className="ml-5">
                      <button
                        onClick={() => setShowExplanation((p) => ({ ...p, [entry.id]: !p[entry.id] }))}
                        className="text-xs text-blue-500"
                      >
                        {showExplanation[entry.id] ? "隐藏解析" : "查看解析"}
                      </button>
                      {showExplanation[entry.id] && (
                        <p className="text-xs text-gray-600 mt-1 bg-white p-2 rounded">{entry.explanation}</p>
                      )}
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
