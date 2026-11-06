/**
 * 3.0 学习方式问卷：5 个问题，决定讲解怎么写、路线怎么排。随时可以改。
 */
import { useEffect, useState } from "react"
import { getLearnProfile, saveLearnProfile, toApiError, type LearnProfile } from "../api"
import Spinner from "./Spinner"
import { toast } from "./Toast"

export default function ProfileQuiz({ onSaved, onSkip, compact = false }: {
  onSaved?: (p: LearnProfile) => void
  onSkip?: () => void
  compact?: boolean
}) {
  const [profile, setProfile] = useState<LearnProfile | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState("")

  useEffect(() => {
    getLearnProfile().then((p) => { setProfile(p); setAnswers(p.answers) }).catch((e) => setErr(toApiError(e).message))
  }, [])

  const save = async () => {
    if (saving) return
    setSaving(true); setErr("")
    try {
      const p = await saveLearnProfile(answers)
      setProfile(p)
      toast("记住了，讲解和路线会按你的方式来", "success")
      onSaved?.(p)
    } catch (e) { setErr(toApiError(e).message) } finally { setSaving(false) }
  }

  if (!profile) {
    return err ? <p className="text-xs text-red-500">{err}</p>
      : <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-10 bg-gray-50 rounded-xl animate-pulse" />)}</div>
  }

  return (
    <div className="space-y-5">
      {profile.questions.map((q, qi) => (
        <fieldset key={q.key}>
          <legend className="text-sm text-gray-900 mb-2">
            <span className="font-serif text-gray-400 mr-2 tabular-nums">{qi + 1}</span>{q.title}
          </legend>
          <div className={`grid gap-2 ${compact ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-3"}`} role="radiogroup">
            {q.options.map((o) => {
              const on = answers[q.key] === o.value
              return (
                <button key={o.value} type="button" role="radio" aria-checked={on}
                        onClick={() => setAnswers((a) => ({ ...a, [q.key]: o.value }))}
                        className={`text-left px-3 py-2 rounded-xl border ${on ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:border-gray-300 bg-white"}`}>
                  <span className="block text-sm text-gray-900">{o.label}</span>
                  {o.hint && <span className="block text-[11px] text-gray-400 mt-0.5">{o.hint}</span>}
                </button>
              )
            })}
          </div>
        </fieldset>
      ))}
      {err && <p className="text-xs text-red-500">{err}</p>}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving}
                className="px-4 py-2 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-800 disabled:opacity-60 inline-flex items-center gap-1.5">
          {saving && <Spinner size={12} light />}{profile.completed ? "保存修改" : "就按这个来"}
        </button>
        {onSkip && <button onClick={onSkip} className="text-xs text-gray-500 hover:text-gray-800">先跳过，用默认方式</button>}
      </div>
    </div>
  )
}
