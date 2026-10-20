import { useState, useEffect } from "react"
import {
  getReviewToday,
  reviewQuestion,
  reviewWord,
  type ReviewQuestion,
  type ReviewResult,
  type SavedWord,
} from "../api"
import { FeedbackBlock } from "./Practice"

interface ReviewProps {
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
}

function nextText(iso: string | null, mastered: boolean): string {
  if (mastered) return "🎉 已掌握，不会再出现了"
  if (!iso) return ""
  const days = Math.max(1, Math.round((new Date(iso + "Z").getTime() - Date.now()) / 86400000))
  return `下次复习：${days} 天后`
}

export default function Review({ onNavigate }: ReviewProps) {
  const [loading, setLoading] = useState(true)
  const [questions, setQuestions] = useState<ReviewQuestion[]>([])
  const [words, setWords] = useState<SavedWord[]>([])
  const [tab, setTab] = useState<"questions" | "words">("questions")
  const [error, setError] = useState("")

  // 错题
  const [qi, setQi] = useState(0)
  const [answer, setAnswer] = useState("")
  const [checking, setChecking] = useState(false)
  const [qResult, setQResult] = useState<ReviewResult | null>(null)

  // 术语卡片
  const [wi, setWi] = useState(0)
  const [flipped, setFlipped] = useState(false)

  useEffect(() => {
    getReviewToday()
      .then((d) => {
        setQuestions(d.questions); setWords(d.words)
        if (!d.questions.length && d.words.length) setTab("words")
      })
      .catch((e) => setError(e.message || "加载失败"))
      .finally(() => setLoading(false))
  }, [])

  const q = questions[qi]
  const w = words[wi]

  const check = async () => {
    if (!q) return
    setChecking(true); setError("")
    try {
      setQResult(await reviewQuestion(q.id, answer))
    } catch (e: any) {
      setError(e.message || "批改失败")
    } finally { setChecking(false) }
  }

  const nextQuestion = () => { setQi(qi + 1); setAnswer(""); setQResult(null) }

  const rateWord = async (remembered: boolean) => {
    if (!w) return
    try { await reviewWord(w.id, remembered) } catch {}
    setFlipped(false)
    setWi(wi + 1)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
      </div>
    )
  }

  const qLeft = Math.max(questions.length - qi, 0)
  const wLeft = Math.max(words.length - wi, 0)

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-4">
        <button onClick={() => onNavigate("study")} className="text-xs text-gray-400 hover:text-gray-600">← 返回</button>
        <h2 className="text-sm font-medium text-gray-800 flex-1">今日复习</h2>
      </div>

      <div className="max-w-xl mx-auto w-full px-4 py-6">
        <p className="text-xs text-gray-400 mb-4 leading-relaxed">
          按「遗忘曲线」安排：答错的题第 2 天复习，之后每答对一次，间隔变成 2、4、7、15、30 天，全部答对就算掌握。
        </p>
        <div className="flex gap-2 mb-6">
          <button onClick={() => setTab("questions")}
                  className={`flex-1 py-2 text-sm rounded-xl border ${tab === "questions" ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 text-gray-600"}`}>
            错题 {qLeft}
          </button>
          <button onClick={() => setTab("words")}
                  className={`flex-1 py-2 text-sm rounded-xl border ${tab === "words" ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 text-gray-600"}`}>
            术语卡片 {wLeft}
          </button>
        </div>

        {error && <p className="text-xs text-red-500 mb-4">{error}</p>}

        {tab === "questions" && (
          q ? (
            <div className="p-5 rounded-xl border border-gray-100 bg-gray-50">
              <p className="text-xs text-gray-400 mb-2">第 {qi + 1} / {questions.length} 题 · 已复习 {q.review_count} 次</p>
              <p className="text-sm text-gray-800 mb-4 whitespace-pre-wrap">{q.question}</p>
              {q.question_type === "choice" ? (
                <div className="space-y-2">
                  {q.options.map((opt) => {
                    const label = opt.trim().charAt(0).toUpperCase()
                    return (
                      <label key={opt} className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer ${answer === label ? "bg-gray-200" : "bg-white hover:bg-gray-100"}`}>
                        <input type="radio" name={`r-${q.id}`} checked={answer === label} disabled={!!qResult}
                               onChange={() => setAnswer(label)} className="w-3.5 h-3.5" />
                        <span className="text-sm text-gray-700">{opt}</span>
                      </label>
                    )
                  })}
                </div>
              ) : q.question_type === "blank" ? (
                <input value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={!!qResult} placeholder="Your answer"
                       className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none bg-white" />
              ) : (
                <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={!!qResult} rows={4}
                          placeholder="Answer in English"
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none bg-white resize-y" />
              )}

              {qResult ? (
                <>
                  <FeedbackBlock r={{ ...qResult, type: q.question_type }} />
                  <p className="text-xs text-gray-400 mt-3">{qResult.status === "ungraded" ? "" : nextText(qResult.next_review_at, qResult.mastered)}</p>
                  <button onClick={nextQuestion} className="w-full mt-4 py-2.5 text-sm bg-gray-900 text-white rounded-xl">下一题 →</button>
                </>
              ) : (
                <button onClick={check} disabled={checking || !answer.trim()}
                        className="w-full mt-4 py-2.5 text-sm bg-gray-900 text-white rounded-xl disabled:opacity-40">
                  {checking ? "批改中…" : "提交"}
                </button>
              )}
            </div>
          ) : (
            <div className="text-center py-16">
              <p className="text-4xl mb-3">🎉</p>
              <p className="text-sm text-gray-500">今天的错题复习完了</p>
              <button onClick={() => onNavigate("wrongbook")} className="text-xs text-gray-400 underline mt-3">看全部错题</button>
            </div>
          )
        )}

        {tab === "words" && (
          w ? (
            <div>
              <button onClick={() => setFlipped(!flipped)}
                      className="w-full min-h-[200px] p-6 rounded-2xl border border-gray-200 bg-white flex flex-col items-center justify-center text-center hover:bg-gray-50">
                <p className="text-xl font-semibold text-gray-900">{w.word}</p>
                {flipped ? (
                  <div className="mt-4">
                    <p className="text-base text-gray-700">{w.translation}</p>
                    {w.note && <p className="text-sm text-gray-400 mt-2">{w.note}</p>}
                    {w.example && <p className="text-sm text-gray-400 italic mt-2">{w.example}</p>}
                  </div>
                ) : (
                  <p className="text-xs text-gray-300 mt-4">先想想中文意思，再点一下翻面</p>
                )}
              </button>
              <p className="text-xs text-gray-300 text-center mt-2">{wi + 1} / {words.length}</p>
              {flipped && (
                <div className="flex gap-3 mt-4">
                  <button onClick={() => rateWord(false)} className="flex-1 py-2.5 text-sm border border-gray-200 rounded-xl text-gray-600">忘了</button>
                  <button onClick={() => rateWord(true)} className="flex-1 py-2.5 text-sm bg-gray-900 text-white rounded-xl">记得</button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-16">
              <p className="text-4xl mb-3">📚</p>
              <p className="text-sm text-gray-500">今天没有要复习的术语</p>
              <p className="text-xs text-gray-300 mt-1">学习时在「本页术语」里点 ☆ 收藏</p>
            </div>
          )
        )}
      </div>
    </div>
  )
}
