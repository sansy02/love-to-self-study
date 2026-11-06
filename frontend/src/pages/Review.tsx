import { useState, useEffect, useRef } from "react"
import {
  getReviewToday,
  getKnowledgeOverview,
  getRemedial,
  submitAnswers,
  reviewQuestion,
  reviewWord,
  type ExerciseItem,
  type KnowledgePoint,
  type ReviewQuestion,
  type ReviewResult,
  type SavedWord,
  type SubmitResultItem,
} from "../api"
import { FeedbackBlock, AnswerInput } from "./Practice"
import RichText from "../components/RichText"
import ErrorPanel from "../components/ErrorPanel"
import Spinner from "../components/Spinner"
import { KpChips, MasteryBadge } from "../components/Learning"
import { toast } from "../components/Toast"

interface ReviewProps {
  onNavigate: (page: string, sessionId?: string, scope?: string) => void
  courseId?: number      // 只看这门课的复习
  embedded?: boolean     // 放在课程页的「复习」标签里：不显示顶部栏，只显示错题
  onDone?: () => void
}

type Tab = "questions" | "knowledge" | "words"

function nextText(iso: string | null, mastered: boolean): string {
  if (mastered) return "这道题已经过了所有复习间隔，不会再出现了"
  if (!iso) return ""
  const days = Math.max(1, Math.round((new Date(iso + "Z").getTime() - Date.now()) / 86400000))
  return `下次复习：${days} 天后`
}

/** 薄弱知识点的「补一补」：短讲解 + 一道换了角度的新题 */
export function Remedial({ kp, onDone }: { kp: Pick<KnowledgePoint, "id">; onDone: () => void }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<unknown>(null)
  const [data, setData] = useState<{ session_id: string; explanation: string; exercise: ExerciseItem } | null>(null)
  const [answer, setAnswer] = useState("")
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<SubmitResultItem | null>(null)
  const busy = useRef(false)

  const load = () => {
    setLoading(true); setErr(null)
    getRemedial(kp.id).then(setData).catch(setErr).finally(() => setLoading(false))
  }
  useEffect(load, [kp.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    if (!data || busy.current || !answer.trim()) return
    busy.current = true; setChecking(true); setErr(null)
    try {
      const r = await submitAnswers(data.session_id, [{ exercise_id: data.exercise.id, answer }])
      setResult(r.results[0])
      onDone()
    } catch (e) { setErr(e) } finally { setChecking(false); busy.current = false }
  }

  if (loading) return <div className="mt-3 flex items-center gap-2 text-xs text-gray-400"><Spinner size={12} />正在准备一段短讲解和一道新题…</div>
  if (err && !data) return <div className="mt-3"><ErrorPanel compact error={err} actions={{ onRetry: load }} /></div>
  if (!data) return null
  return (
    <div className="mt-3 pt-3 border-t border-gray-100 animate-fade-in">
      <RichText text={data.explanation} className="text-sm text-gray-700 leading-7" />
      <div className="mt-4 p-4 rounded-xl bg-gray-50 border border-gray-100">
        <p className="text-[11px] text-gray-400 mb-1">换个角度再考一次</p>
        <p className="text-sm text-gray-800 mb-3 whitespace-pre-wrap">{data.exercise.question}</p>
        <AnswerInput ex={data.exercise} value={answer} onChange={setAnswer} disabled={!!result}
                     correctAnswer={result?.correct_answer} wrong={result?.status === "wrong"} />
        {result ? <FeedbackBlock r={{ ...result, type: data.exercise.type }} /> : (
          <button onClick={check} disabled={checking || !answer.trim()}
                  className="w-full mt-3 py-2 text-sm bg-gray-900 text-white rounded-lg disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
            {checking && <Spinner size={12} light />}提交
          </button>
        )}
        {!!err && <div className="mt-3"><ErrorPanel compact error={err} actions={{ onRetry: check }} /></div>}
      </div>
    </div>
  )
}

export default function Review({ onNavigate, courseId, embedded = false, onDone }: ReviewProps) {
  const [loading, setLoading] = useState(true)
  const [questions, setQuestions] = useState<ReviewQuestion[]>([])
  const [postponed, setPostponed] = useState(0)
  const [words, setWords] = useState<SavedWord[]>([])
  const [kps, setKps] = useState<KnowledgePoint[] | null>(null)
  const [tab, setTab] = useState<Tab>("questions")
  const [loadErr, setLoadErr] = useState<unknown>(null)
  const [checkErr, setCheckErr] = useState<unknown>(null)
  const [openKp, setOpenKp] = useState<number | null>(null)

  // 错题
  const [qi, setQi] = useState(0)
  const [answer, setAnswer] = useState("")
  const [checking, setChecking] = useState(false)
  const [qResult, setQResult] = useState<ReviewResult | null>(null)
  const checkingRef = useRef(false)

  // 术语卡片
  const [wi, setWi] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [rating, setRating] = useState(false)

  const load = () => {
    setLoading(true); setLoadErr(null)
    getReviewToday(courseId)
      .then((d) => {
        setQuestions(d.questions); setWords(d.words); setPostponed(d.postponed || 0)
        if (!embedded && !d.questions.length && d.words.length) setTab("words")
      })
      .catch(setLoadErr)
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const loadKps = () => {
    getKnowledgeOverview().then((d) => setKps(d.knowledge_points)).catch(() => setKps([]))
  }
  useEffect(() => { if (tab === "knowledge" && kps === null) loadKps() }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const q = questions[qi]
  const w = words[wi]

  const check = async () => {
    if (!q || checkingRef.current) return
    checkingRef.current = true
    setChecking(true); setCheckErr(null)
    try {
      const r = await reviewQuestion(q.id, answer)
      setQResult(r)
      setKps(null)   // 掌握度变了，下次打开知识点页时重新读取
      if (r.status === "correct") toast(r.mastered ? "这道题已经掌握了" : "答对了，间隔会变长", "success")
    } catch (e) {
      setCheckErr(e)
    } finally { setChecking(false); checkingRef.current = false }
  }

  const nextQuestion = () => {
    if (qi + 1 >= questions.length) onDone?.()
    setQi(qi + 1); setAnswer(""); setQResult(null); setCheckErr(null)
    if (!embedded) window.scrollTo({ top: 0 })
  }

  const rateWord = async (remembered: boolean) => {
    if (!w || rating) return
    setRating(true)
    try { await reviewWord(w.id, remembered) } catch { toast("没保存成功，这张卡片之后还会出现", "error") }
    setRating(false)
    setFlipped(false)
    setWi(wi + 1)
  }

  const qLeft = Math.max(questions.length - qi, 0)
  const wLeft = Math.max(words.length - wi, 0)
  const tabs: [Tab, string][] = [["questions", `错题 ${loading ? "" : qLeft}`], ["knowledge", "知识点"], ["words", `术语卡片 ${loading ? "" : wLeft}`]]

  return (
    <div className={embedded ? "" : "min-h-screen flex flex-col"}>
      {!embedded && (
        <div className="px-4 pt-6 md:pt-10 max-w-xl mx-auto w-full">
          <h1 className="font-serif text-2xl text-gray-900 tracking-wide">今日复习</h1>
          <p className="text-xs text-gray-400 mt-1.5">所有课程今天要复习的错题、知识点和术语</p>
        </div>
      )}

      <div className={embedded ? "w-full" : "max-w-xl mx-auto w-full px-4 py-6"}>
        <div className={`flex p-1 bg-gray-100 rounded-xl mb-6 ${embedded ? "hidden" : ""}`} role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                    className={`flex-1 py-2 text-sm rounded-lg ${tab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>{label}</button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-3">
            <div className="h-4 bg-gray-100 rounded animate-pulse w-1/3" />
            <div className="h-36 bg-gray-50 border border-gray-100 rounded-2xl animate-pulse" />
          </div>
        ) : loadErr ? (
          <ErrorPanel error={loadErr} actions={{ onRetry: load }} />
        ) : (
          <>
            {tab === "questions" && (
              q ? (
                <div key={q.id} className="p-5 rounded-2xl border border-gray-100 bg-white animate-fade-in">
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <p className="text-xs text-gray-400">第 {qi + 1} / {questions.length} 题 · 已复习 {q.review_count} 次</p>
                    <KpChips kps={q.kps} />
                  </div>
                  <p className="text-sm text-gray-800 mb-4 whitespace-pre-wrap">{q.question}</p>
                  <AnswerInput ex={{ id: q.id, type: q.question_type, options: q.options }} value={answer} onChange={setAnswer}
                               disabled={!!qResult} correctAnswer={qResult?.correct_answer} wrong={qResult?.status === "wrong"} />

                  {qResult ? (
                    <>
                      <FeedbackBlock r={{ ...qResult, type: q.question_type }} />
                      <p className="text-xs text-gray-400 mt-3">{qResult.status === "ungraded" ? "" : nextText(qResult.next_review_at, qResult.mastered)}</p>
                      <button onClick={nextQuestion} className="w-full mt-4 py-2.5 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-800">
                        {qi + 1 < questions.length ? "下一题 →" : "完成"}
                      </button>
                    </>
                  ) : (
                    <button onClick={check} disabled={checking || !answer.trim()}
                            className="w-full mt-4 py-2.5 text-sm bg-gray-900 text-white rounded-xl disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
                      {checking && <Spinner size={13} light />}{checking ? "批改中…" : "提交"}
                    </button>
                  )}
                  {!!checkErr && <div className="mt-3"><ErrorPanel compact error={checkErr} actions={{ onRetry: check, retrying: checking }} /></div>}
                </div>
              ) : (
                <div className="text-center py-16 animate-fade-in">
                  <p className="font-serif text-lg text-gray-800 mb-2">{embedded ? "这门课今天没有要复习的题" : "今天的错题复习完了"}</p>
                  <p className="text-xs text-gray-400">{postponed > 0 ? `还有 ${postponed} 道同知识点的题，会在之后几天出现` : "答错的题会在第二天出现在这里"}</p>
                  <div className={`flex justify-center gap-4 mt-5 ${embedded ? "hidden" : ""}`}>
                    <button onClick={() => setTab("knowledge")} className="text-xs text-gray-600 underline underline-offset-4 decoration-gray-300">看知识点掌握情况</button>
                    <button onClick={() => onNavigate("wrongbook")} className="text-xs text-gray-600 underline underline-offset-4 decoration-gray-300">看全部错题</button>
                  </div>
                </div>
              )
            )}
            {tab === "questions" && q && postponed > 0 && (
              <p className="text-[11px] text-gray-400 mt-3 text-center">同一个知识点今天只考一道，另外 {postponed} 道推迟到之后几天</p>
            )}

            {tab === "knowledge" && (
              kps === null ? (
                <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 bg-gray-50 border border-gray-100 rounded-xl animate-pulse" />)}</div>
              ) : kps.length === 0 ? (
                <div className="text-center py-16">
                  <p className="text-sm text-gray-500">还没有做过练习</p>
                  <p className="text-xs text-gray-400 mt-1">做完练习后，这里会按知识点显示你的掌握情况</p>
                </div>
              ) : (
                <div className="animate-fade-in">
                  <p className="text-xs text-gray-400 mb-4 leading-relaxed">
                    怎么算掌握：在两个不同的日子都答对，并且至少有一次是选择题或填空题。错一次（或同一天错几道）只算「学习中」，在两个不同的日子都答错才算「需要加强」。简答题由 AI 打分，只作参考。
                  </p>
                  <div className="space-y-2">
                    {kps.map((k) => (
                      <div key={k.id} className="p-4 rounded-xl border border-gray-100 bg-white">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-900">{k.name}</p>
                            <p className="text-[11px] text-gray-400 truncate">{k.course}{k.page_start ? ` · 第 ${k.page_start}${k.page_end && k.page_end !== k.page_start ? `–${k.page_end}` : ""} 页` : ""}</p>
                            {k.note && <p className="text-xs text-gray-500 mt-1">{k.note}</p>}
                          </div>
                          <div className="flex flex-col items-end gap-1.5">
                            <MasteryBadge status={k.status} label={k.label} />
                            {k.due_today && <span className="text-[11px] text-gray-500">今天该复习</span>}
                          </div>
                        </div>
                        {(k.status === "weak" || k.status === "learning") && (
                          openKp === k.id ? (
                            <Remedial kp={k} onDone={() => toast("已记录，这个知识点的掌握情况会更新", "success")} />
                          ) : (
                            <button onClick={() => setOpenKp(k.id)}
                                    className={`mt-3 text-xs px-3 py-1.5 rounded-lg ${k.status === "weak" ? "bg-gray-900 text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
                              补一补：短讲解 + 一道新题
                            </button>
                          )
                        )}
                      </div>
                    ))}
                  </div>
                  <button onClick={loadKps} className="text-xs text-gray-500 hover:text-gray-800 mt-4 underline underline-offset-4 decoration-gray-300">刷新</button>
                </div>
              )
            )}

            {tab === "words" && (
              w ? (
                <div key={w.id} className="animate-fade-in">
                  <button onClick={() => setFlipped(!flipped)}
                          className="w-full min-h-[220px] p-6 rounded-2xl border border-gray-200 bg-white flex flex-col items-center justify-center text-center hover:border-gray-300">
                    <p className="text-xl text-gray-900">{w.word}</p>
                    {flipped ? (
                      <div className="mt-4 animate-fade-in">
                        <p className="font-serif text-base text-gray-700">{w.translation}</p>
                        {w.note && <p className="text-sm text-gray-500 mt-2">{w.note}</p>}
                        {w.example && <p className="text-sm text-gray-500 italic mt-2">{w.example}</p>}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400 mt-4">先想想中文意思，再点一下翻面</p>
                    )}
                  </button>
                  <p className="text-xs text-gray-400 text-center mt-2 tabular-nums">{wi + 1} / {words.length}</p>
                  {flipped && (
                    <div className="flex gap-3 mt-4">
                      <button onClick={() => rateWord(false)} disabled={rating} className="flex-1 py-2.5 text-sm border border-gray-200 rounded-xl text-gray-600 bg-white disabled:opacity-50">忘了</button>
                      <button onClick={() => rateWord(true)} disabled={rating} className="flex-1 py-2.5 text-sm bg-gray-900 text-white rounded-xl disabled:opacity-50">记得</button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-16">
                  <p className="text-sm text-gray-500">今天没有要复习的术语</p>
                  <p className="text-xs text-gray-400 mt-1">学习时在「本页术语」里点 ☆ 收藏</p>
                </div>
              )
            )}
          </>
        )}
      </div>
    </div>
  )
}
