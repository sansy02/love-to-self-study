import { useState, useEffect, useCallback, useRef } from "react"
import {
  generateExercises,
  submitAnswers,
  type Preferences,
  type ExerciseItem,
  type SubmitResult,
  type SubmitResultItem,
} from "../api"
import RichText from "../components/RichText"
import ErrorPanel from "../components/ErrorPanel"
import Spinner from "../components/Spinner"
import { KpChips, ErrorReasonPicker } from "../components/Learning"
import { toast } from "../components/Toast"

interface PracticeProps {
  sessionId: string
  scope: string
  preferences: Preferences
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
}

const TYPE_LABEL: Record<string, string> = { choice: "选择题 Multiple choice", blank: "填空题 Fill in the blank", short_answer: "简答题 Short answer" }

export function optionLetter(opt: string): string {
  const m = opt.trim().match(/^\(?([A-Fa-f])[.)、:：\s]/)
  return m ? m[1].toUpperCase() : opt.trim().charAt(0).toUpperCase()
}

type FeedbackInput = Pick<SubmitResultItem, "status" | "score" | "feedback" | "correct_answer" | "explanation" | "key_points"> & {
  type: string
  attempt_id?: number
  error_reason?: string
  error_reason_source?: string
  evidence?: string
}

export function FeedbackBlock({ r }: { r: FeedbackInput }) {
  const [open, setOpen] = useState(r.status !== "correct")
  if (r.status === "ungraded") {
    return <p className="text-xs text-gray-500 mt-3">{r.feedback?.content || "AI 批改暂时失败，这题不计分"}</p>
  }
  const score = r.score != null ? Math.round(r.score) : null
  const isShort = r.type === "short_answer"
  return (
    <div className="mt-3 animate-fade-in">
      <div className="flex items-center gap-3 flex-wrap">
        {r.status === "correct"
          ? <p className="text-xs text-green-600">答对了{isShort && score != null ? ` · ${score} / 10 分` : ""}</p>
          : <p className="text-xs text-red-500">{isShort && score != null ? `${score} / 10 分` : "答错了"}
              {!isShort && <> · 正确答案：<span className="font-medium">{r.correct_answer}</span></>}</p>}
        <button onClick={() => setOpen(!open)} className="text-xs text-blue-600 hover:text-blue-700">{open ? "收起解析" : "查看解析"}</button>
        {isShort && r.evidence === "weak" && <span className="text-[11px] text-gray-400">简答题分数仅供参考</span>}
      </div>
      {open && (
        <div className="mt-2 space-y-2 text-xs text-gray-700">
          {r.feedback?.content && <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">内容</p><RichText text={r.feedback.content} /></div>}
          {r.feedback?.language && <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">英文表达</p><RichText text={r.feedback.language} /></div>}
          {r.feedback?.improved && <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">帮你改写成高分答案</p><p className="italic leading-relaxed">{r.feedback.improved}</p></div>}
          {isShort && r.correct_answer && (
            <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">参考答案 Model answer</p><p className="leading-relaxed">{r.correct_answer}</p>
              {r.key_points?.length > 0 && <ul className="list-disc pl-4 mt-1 text-gray-500">{r.key_points.map((k, i) => <li key={i}>{k}</li>)}</ul>}
            </div>
          )}
          {r.explanation && <div className="bg-white rounded-lg p-2.5"><p className="text-gray-400 mb-0.5">解析</p><RichText text={r.explanation} /></div>}
        </div>
      )}
      {r.status === "wrong" && (
        <ErrorReasonPicker attemptId={r.attempt_id} value={r.error_reason} source={r.error_reason_source} />
      )}
    </div>
  )
}

/** 一道题的作答区（练习、复习、补救题共用） */
export function AnswerInput({ ex, value, onChange, disabled, correctAnswer, wrong }: {
  ex: { id: number; type: string; options: string[] }
  value: string
  onChange: (v: string) => void
  disabled: boolean
  correctAnswer?: string
  wrong?: boolean
}) {
  if (ex.type === "choice") {
    return (
      <div className="space-y-2">
        {ex.options.map((opt) => {
          const label = optionLetter(opt)
          const isRight = disabled && correctAnswer !== undefined && label === optionLetter(correctAnswer)
          const isPickedWrong = disabled && wrong && label === value
          return (
            <label key={opt} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer
              ${isRight ? "bg-green-100 border-green-100" : isPickedWrong ? "bg-red-100 border-red-100"
                : value === label ? "bg-gray-100 border-gray-300" : "bg-white border-gray-100 hover:border-gray-200"}
              ${disabled ? "cursor-default" : ""}`}>
              <input type="radio" name={`q-${ex.id}`} value={label} checked={value === label}
                     onChange={() => onChange(label)} disabled={disabled} className="w-3.5 h-3.5" />
              <span className="text-sm text-gray-700">{opt}</span>
            </label>
          )
        })}
      </div>
    )
  }
  if (ex.type === "blank") {
    return (
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
             placeholder="Your answer"
             className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none bg-white disabled:bg-gray-50 disabled:text-gray-500" />
    )
  }
  return (
    <textarea value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} rows={4}
              placeholder="Answer in English（写不出来也可以先用中文，会帮你改成英文答案）"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none bg-white disabled:bg-gray-50 disabled:text-gray-500 resize-y" />
  )
}

function QuestionSkeleton() {
  return (
    <div className="p-5 rounded-2xl border border-gray-100 bg-gray-50/60 space-y-3">
      <div className="h-3.5 bg-gray-100 rounded animate-pulse w-5/6" />
      <div className="h-3 bg-gray-100 rounded animate-pulse w-1/3" />
      <div className="space-y-2 pt-1">
        <div className="h-8 bg-white border border-gray-100 rounded-lg" />
        <div className="h-8 bg-white border border-gray-100 rounded-lg" />
      </div>
    </div>
  )
}

export default function Practice({ sessionId, scope, preferences, onNavigate }: PracticeProps) {
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [exercises, setExercises] = useState<ExerciseItem[]>([])
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [result, setResult] = useState<SubmitResult | null>(null)
  const [loadErr, setLoadErr] = useState<unknown>(null)
  const [submitErr, setSubmitErr] = useState<unknown>(null)
  const [elapsed, setElapsed] = useState(0)
  const submittingRef = useRef(false)

  const load = useCallback((fresh: boolean) => {
    if (!sessionId) return
    setLoading(true); setLoadErr(null); setSubmitErr(null); setResult(null); setAnswers({})
    generateExercises(sessionId, scope, fresh)
      .then((data) => setExercises(data.exercises))
      .catch((err) => setLoadErr(err))
      .finally(() => setLoading(false))
  }, [sessionId, scope])

  useEffect(() => { load(false) }, [load])

  // 出题时显示等待了多久，让人知道没有卡住
  useEffect(() => {
    if (!loading) return
    setElapsed(0)
    const t = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [loading])

  const setAnswer = (exId: number, value: string) => setAnswers((prev) => ({ ...prev, [exId]: value }))

  const handleSubmit = async () => {
    if (submittingRef.current) return   // 防止连点重复提交
    submittingRef.current = true
    setSubmitting(true); setSubmitErr(null)
    try {
      const res = await submitAnswers(sessionId, exercises.map((ex) => ({ exercise_id: ex.id, answer: answers[ex.id] || "" })))
      setResult(res)
      window.scrollTo({ top: 0, behavior: "smooth" })
      if (res.wrong > 0) toast("错题已加入错题本，明天按知识点再考一次")
      else if (res.correct > 0) toast("全部答对", "success")
    } catch (err) {
      setSubmitErr(err)
    } finally { setSubmitting(false); submittingRef.current = false }
  }

  const answeredCount = exercises.filter((ex) => (answers[ex.id] || "").trim()).length
  const isDiag = scope === "diagnostic"
  const isBank = scope === "bank" || scope.startsWith("bank-kp:")
  const title = scope === "all" ? "整讲练习" : scope === "retry" ? "错题重练" : isDiag ? "诊断小测"
    : scope === "bank" ? "题库练习" : isBank ? `考点练习：${scope.slice(8)}`
    : `第 ${Number(scope.split("-")[1] || 0) + 1} 章练习`
  const weakKps = result
    ? [...new Map(result.results.filter((r) => r.status === "wrong").flatMap((r) => r.kps || []).map((k) => [k.name, k])).values()]
    : []

  return (
    <div className="min-h-screen flex flex-col">
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b border-gray-100 px-4 py-3 flex items-center gap-4">
        {isBank ? (
          <button onClick={() => onNavigate("course", undefined, "exam")} className="text-xs text-gray-400 hover:text-gray-700">← 返回考试页</button>
        ) : (
          <button onClick={() => onNavigate("study", sessionId)} className="text-xs text-gray-400 hover:text-gray-700">← 返回学习</button>
        )}
        <h2 className="text-sm text-gray-800 flex-1">{title}</h2>
        {result && (
          <span className="text-xs text-gray-500">得分 <span className="text-gray-900 tabular-nums">{result.score}</span>（{result.correct}/{result.correct + result.wrong}）</span>
        )}
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-8">
        {loading ? (
          <div className="animate-fade-in">
            <div className="flex items-center gap-2 text-sm text-gray-500 mb-1"><Spinner size={14} />{isDiag ? "正在出 5 道诊断题…" : isBank ? "正在打开题库…" : "正在出题（英文题目，和考试一样）…"}</div>
            <p className="text-xs text-gray-400 mb-6 tabular-nums">已等待 {elapsed} 秒，一般 10–30 秒</p>
            <div className="space-y-4"><QuestionSkeleton /><QuestionSkeleton /><QuestionSkeleton /></div>
          </div>
        ) : loadErr ? (
          <ErrorPanel error={loadErr} actions={{ onRetry: () => load(false), onHome: () => onNavigate("study"), onUseKey: () => onNavigate("study") }} />
        ) : (
          <>
            {result && isDiag && (
              <div className="p-5 bg-gray-50 border border-gray-100 rounded-2xl mb-6 animate-fade-in">
                <p className="text-xs text-gray-500 text-center">这一讲的诊断结果</p>
                <p className="font-serif text-3xl text-gray-900 tabular-nums text-center mt-1">
                  {result.correct}<span className="text-base text-gray-500"> / {result.correct + result.wrong}</span>
                </p>
                {weakKps.length > 0 ? (
                  <>
                    <p className="text-xs text-gray-500 mt-4 mb-2">这些知识点还没掌握，建议先补一补：</p>
                    <div className="flex flex-wrap gap-1.5"><KpChips kps={weakKps} /></div>
                    <div className="flex gap-2 mt-4">
                      <button onClick={() => onNavigate("course", undefined, "knowledge")}
                              className="flex-1 py-2.5 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-800">去补一补</button>
                      <button onClick={() => onNavigate("study", sessionId)}
                              className="flex-1 py-2.5 text-sm border border-gray-200 bg-white text-gray-700 rounded-xl hover:bg-gray-50">回到课件</button>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-3">答错的题明天会出现在「今日复习」里。</p>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-gray-500 text-center mt-3">这一讲的知识点都答对了。换一天再答对一次，就算真正掌握。</p>
                    <button onClick={() => onNavigate("course")}
                            className="w-full mt-4 py-2.5 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-800">回到课程</button>
                  </>
                )}
              </div>
            )}

            {result && !isDiag && (
              <div className="p-5 bg-gray-50 border border-gray-100 rounded-2xl text-center mb-6 animate-fade-in">
                <p className="font-serif text-3xl text-gray-900 tabular-nums">{result.score}<span className="text-base text-gray-500 ml-1">分</span></p>
                <p className="text-xs text-gray-500 mt-2">
                  答对 {result.correct} · 答错 {result.wrong}{result.ungraded > 0 && ` · 暂未批改 ${result.ungraded}`}
                </p>
                {result.wrong > 0 && <p className="text-xs text-gray-400 mt-1">错一次不代表不会：错题已加入错题本，明天会按知识点再考一次</p>}
              </div>
            )}

            {!result && exercises.length > 0 && (
              <p className="text-xs text-gray-400 mb-5 leading-relaxed">
                {isDiag
                  ? "5 道选择题 / 填空题，每题考一个知识点，大约 2 分钟。不会就留空，结果会告诉你先补哪里。"
                  : isBank
                    ? "这些是从你的 Tutorial / 往年考试题里整理出来的原题。简答题的参考答案由 AI 写，只作参考；批改结果会算进知识点掌握度。"
                    : "题目是英文的，和考试一样；简答题尽量用英文回答，会帮你改英文表达。解析是中文。"}
              </p>
            )}

            <div className="space-y-4 mb-8">
              {exercises.map((ex, index) => {
                const r = result?.results.find((x) => x.exercise_id === ex.id)
                const userAnswer = answers[ex.id] || ""
                const tone = !r ? "bg-white border-gray-100" : r.status === "correct" ? "bg-green-50 border-green-100"
                  : r.status === "wrong" ? "bg-red-50 border-red-100" : "bg-gray-50 border-gray-200"
                return (
                  <div key={ex.id} className={`p-5 rounded-2xl border transition-colors ${tone}`}>
                    <div className="flex items-start gap-2 mb-3">
                      <span className="text-xs text-gray-400 shrink-0 mt-0.5 tabular-nums">{index + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800 mb-1.5 whitespace-pre-wrap">{ex.question}</p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {ex.source_label && (
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-900 text-white">{ex.source_label}{ex.marks ? ` · ${ex.marks} 分` : ""}</span>
                          )}
                          <span className="text-xs text-gray-400">{TYPE_LABEL[ex.type] || ex.type}{ex.page_no ? ` · 出自第 ${ex.page_no} 页` : ""}</span>
                          <KpChips kps={ex.kps} />
                        </div>
                      </div>
                    </div>
                    <div className="ml-5">
                      <AnswerInput ex={ex} value={userAnswer} onChange={(v) => setAnswer(ex.id, v)} disabled={!!result}
                                   correctAnswer={r?.correct_answer} wrong={r?.status === "wrong"} />
                      {r && <FeedbackBlock r={{ ...r, type: ex.type }} />}
                    </div>
                  </div>
                )
              })}
            </div>

            {!!submitErr && <div className="mb-4"><ErrorPanel error={submitErr} actions={{ onRetry: handleSubmit, retrying: submitting }} /></div>}

            {exercises.length > 0 && !result && (
              <button onClick={handleSubmit} disabled={submitting}
                      className="w-full py-3 bg-gray-900 text-white text-sm rounded-xl hover:bg-gray-800 disabled:opacity-60 inline-flex items-center justify-center gap-2">
                {submitting && <Spinner size={14} light />}
                {submitting ? "批改中…（简答题需要几秒）" : `提交批改（已答 ${answeredCount}/${exercises.length}）`}
              </button>
            )}

            {result && !isDiag && (
              <div className="flex gap-3">
                {preferences.show_wrong_book && result.wrong > 0 && (
                  <button onClick={() => onNavigate("wrongbook")} className="flex-1 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 bg-white">错题本</button>
                )}
                {scope !== "retry" && (
                  <button onClick={() => load(!isBank)} className="flex-1 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 bg-white">
                    {isBank ? "再做一遍" : "再来一套"}
                  </button>
                )}
                {isBank ? (
                  <button onClick={() => onNavigate("course", undefined, "exam")} className="flex-1 py-2.5 text-sm text-white bg-gray-900 rounded-xl hover:bg-gray-800">回到考试页</button>
                ) : (
                  <button onClick={() => onNavigate("study", sessionId)} className="flex-1 py-2.5 text-sm text-white bg-gray-900 rounded-xl hover:bg-gray-800">返回学习</button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
