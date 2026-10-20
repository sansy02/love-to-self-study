import { useState, useEffect, useCallback } from "react"
import {
  generateExercises,
  submitAnswers,
  type Preferences,
  type ExerciseItem,
  type SubmitResult,
  type SubmitResultItem,
} from "../api"
import RichText from "../components/RichText"

interface PracticeProps {
  sessionId: string
  scope: string
  preferences: Preferences
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
}

const TYPE_LABEL: Record<string, string> = { choice: "选择题 Multiple choice", blank: "填空题 Fill in the blank", short_answer: "简答题 Short answer" }

function optionLetter(opt: string): string {
  const m = opt.trim().match(/^\(?([A-Fa-f])[.)、:：\s]/)
  return m ? m[1].toUpperCase() : opt.trim().charAt(0).toUpperCase()
}

export function FeedbackBlock({ r }: { r: Pick<SubmitResultItem, "status" | "score" | "feedback" | "correct_answer" | "explanation" | "key_points"> & { type: string } }) {
  const [open, setOpen] = useState(r.status !== "correct")
  if (r.status === "ungraded") {
    return <p className="text-xs text-gray-500 mt-3">⏳ {r.feedback?.content || "AI 批改暂时失败，这题不计分"}</p>
  }
  return (
    <div className="mt-3">
      <div className="flex items-center gap-3">
        {r.status === "correct"
          ? <p className="text-xs text-green-600">✅ 正确{r.type === "short_answer" && r.score != null ? ` · ${r.score}/10 分` : ""}</p>
          : <p className="text-xs text-red-500">❌ {r.type === "short_answer" && r.score != null ? `${r.score}/10 分` : "错误"}
              {r.type !== "short_answer" && <> · 正确答案：<span className="font-medium">{r.correct_answer}</span></>}</p>}
        <button onClick={() => setOpen(!open)} className="text-xs text-blue-500">{open ? "收起解析" : "查看解析"}</button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 text-xs text-gray-700">
          {r.feedback?.content && <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">内容</p><RichText text={r.feedback.content} /></div>}
          {r.feedback?.language && <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">英文表达</p><RichText text={r.feedback.language} /></div>}
          {r.feedback?.improved && <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">帮你改写成高分答案</p><p className="italic leading-relaxed">{r.feedback.improved}</p></div>}
          {r.type === "short_answer" && r.correct_answer && (
            <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">参考答案 Model answer</p><p className="leading-relaxed">{r.correct_answer}</p>
              {r.key_points?.length > 0 && <ul className="list-disc pl-4 mt-1 text-gray-500">{r.key_points.map((k, i) => <li key={i}>{k}</li>)}</ul>}
            </div>
          )}
          {r.explanation && <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">解析</p><RichText text={r.explanation} /></div>}
        </div>
      )}
    </div>
  )
}

export default function Practice({ sessionId, scope, preferences, onNavigate }: PracticeProps) {
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [exercises, setExercises] = useState<ExerciseItem[]>([])
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [result, setResult] = useState<SubmitResult | null>(null)
  const [error, setError] = useState("")

  const load = useCallback((fresh: boolean) => {
    if (!sessionId) return
    setLoading(true); setError(""); setResult(null); setAnswers({})
    generateExercises(sessionId, scope, fresh)
      .then((data) => setExercises(data.exercises))
      .catch((err) => setError("练习生成失败：" + (err.message || "未知错误")))
      .finally(() => setLoading(false))
  }, [sessionId, scope])

  useEffect(() => { load(false) }, [load])

  const setAnswer = (exId: number, value: string) => setAnswers((prev) => ({ ...prev, [exId]: value }))

  const handleSubmit = async () => {
    setSubmitting(true); setError("")
    try {
      const res = await submitAnswers(sessionId, exercises.map((ex) => ({ exercise_id: ex.id, answer: answers[ex.id] || "" })))
      setResult(res)
      window.scrollTo({ top: 0, behavior: "smooth" })
    } catch (err: any) {
      setError("提交失败：" + (err.message || "未知错误"))
    } finally { setSubmitting(false) }
  }

  const answeredCount = exercises.filter((ex) => (answers[ex.id] || "").trim()).length
  const title = scope === "all" ? "整讲练习" : scope === "retry" ? "错题重练" : `第 ${Number(scope.split("-")[1] || 0) + 1} 章练习`

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <div className="w-8 h-8 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
        <p className="text-sm text-gray-400">正在出题（英文题目，和考试一样）…</p>
        <p className="text-xs text-gray-300">大约 10–30 秒</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-4">
        <button onClick={() => onNavigate("study", sessionId)} className="text-xs text-gray-400 hover:text-gray-600">← 返回学习</button>
        <h2 className="text-sm font-medium text-gray-800 flex-1">{title}</h2>
        {result && (
          <span className="text-xs text-gray-500">得分 <span className="font-medium text-gray-800">{result.score}</span>（{result.correct}/{result.correct + result.wrong}）</span>
        )}
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-8">
        {result && (
          <div className="p-4 bg-gray-50 rounded-xl text-center mb-6">
            <p className="text-lg font-semibold text-gray-800">{result.score} 分</p>
            <p className="text-xs text-gray-400 mt-1">
              正确 {result.correct} · 错误 {result.wrong}{result.ungraded > 0 && ` · 暂未批改 ${result.ungraded}`}
            </p>
            {result.wrong > 0 && <p className="text-xs text-gray-400 mt-1">错题已加入错题本，明天会出现在「今日复习」里</p>}
          </div>
        )}

        {!result && exercises.length > 0 && (
          <p className="text-xs text-gray-400 mb-4">题目是英文的，和考试一样；简答题尽量用英文回答，会帮你改英文表达。解析是中文。</p>
        )}

        <div className="space-y-4 mb-8">
          {exercises.map((ex, index) => {
            const r = result?.results.find((x) => x.exercise_id === ex.id)
            const userAnswer = answers[ex.id] || ""
            const bg = !r ? "bg-gray-50 border-gray-100" : r.status === "correct" ? "bg-green-50 border-green-100"
              : r.status === "wrong" ? "bg-red-50 border-red-100" : "bg-gray-50 border-gray-200"
            return (
              <div key={ex.id} className={`p-5 rounded-xl border ${bg}`}>
                <div className="flex items-start gap-2 mb-3">
                  <span className="text-xs font-medium text-gray-400 shrink-0 mt-0.5">{index + 1}.</span>
                  <div className="flex-1">
                    <p className="text-sm text-gray-800 mb-1 whitespace-pre-wrap">{ex.question}</p>
                    <span className="text-xs text-gray-400">{TYPE_LABEL[ex.type] || ex.type}{ex.page_no ? ` · 出自第 ${ex.page_no} 页` : ""}</span>
                  </div>
                </div>

                {ex.type === "choice" && (
                  <div className="ml-5 space-y-2">
                    {ex.options.map((opt) => {
                      const label = optionLetter(opt)
                      const isRight = r && label === optionLetter(r.correct_answer)
                      const isPickedWrong = r && label === userAnswer && r.status === "wrong"
                      return (
                        <label key={opt} className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors
                          ${r ? (isRight ? "bg-green-100" : isPickedWrong ? "bg-red-100" : "bg-white") : userAnswer === label ? "bg-gray-100" : "bg-white hover:bg-gray-50"}`}>
                          <input type="radio" name={`q-${ex.id}`} value={label} checked={userAnswer === label}
                                 onChange={() => setAnswer(ex.id, label)} disabled={!!result} className="w-3.5 h-3.5" />
                          <span className="text-sm text-gray-700">{opt}</span>
                        </label>
                      )
                    })}
                  </div>
                )}

                {ex.type === "blank" && (
                  <div className="ml-5">
                    <input type="text" value={userAnswer} onChange={(e) => setAnswer(ex.id, e.target.value)} disabled={!!result}
                           placeholder="Your answer"
                           className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500" />
                  </div>
                )}

                {ex.type === "short_answer" && (
                  <div className="ml-5">
                    <textarea value={userAnswer} onChange={(e) => setAnswer(ex.id, e.target.value)} disabled={!!result} rows={4}
                              placeholder="Answer in English（写不出来也可以先用中文，会帮你翻译成英文答案）"
                              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500 resize-y" />
                  </div>
                )}

                {r && <div className="ml-5"><FeedbackBlock r={{ ...r, type: ex.type }} /></div>}
              </div>
            )
          })}
        </div>

        {exercises.length > 0 && !result && (
          <button onClick={handleSubmit} disabled={submitting}
                  className="w-full py-3 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-60">
            {submitting ? "批改中…（简答题需要几秒）" : `提交批改（已答 ${answeredCount}/${exercises.length}）`}
          </button>
        )}

        {result && (
          <div className="flex gap-3">
            {preferences.show_wrong_book && result.wrong > 0 && (
              <button onClick={() => onNavigate("wrongbook")} className="flex-1 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50">错题本</button>
            )}
            {scope !== "retry" && (
              <button onClick={() => load(true)} className="flex-1 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50">再来一套</button>
            )}
            <button onClick={() => onNavigate("study", sessionId)} className="flex-1 py-2.5 text-sm text-white bg-gray-900 rounded-xl hover:bg-gray-800">返回学习</button>
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-xl">
            <p className="text-xs text-red-500 whitespace-pre-wrap">{error}</p>
            <button onClick={() => load(false)} className="text-xs mt-2 px-3 py-1 bg-gray-900 text-white rounded-lg">重试</button>
          </div>
        )}
      </div>
    </div>
  )
}
