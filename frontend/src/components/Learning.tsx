/**
 * 知识点相关的小组件：知识点标签、错误原因选择、掌握度标签
 */
import { useState } from "react"
import { ERROR_REASONS, setErrorReason, type KpRef, type MasteryStatus } from "../api"
import { toast } from "./Toast"

export function KpChips({ kps, className = "" }: { kps?: KpRef[]; className?: string }) {
  const list = (kps || []).filter((k) => k.name)
  if (!list.length) return null
  return (
    <span className={`inline-flex flex-wrap gap-1.5 ${className}`}>
      {list.map((k) => (
        <span key={k.id} className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100">{k.name}</span>
      ))}
    </span>
  )
}

const STATUS_STYLE: Record<MasteryStatus, string> = {
  new: "bg-gray-50 text-gray-500 border-gray-200",
  learning: "bg-blue-50 text-blue-600 border-blue-100",
  weak: "bg-red-50 text-red-600 border-red-100",
  mastered: "bg-green-50 text-green-600 border-green-100",
}

export function MasteryBadge({ status, label }: { status: MasteryStatus; label: string }) {
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLE[status]}`}>{label}</span>
}

/**
 * 错误原因：AI 先猜一个（标明「AI 猜测」），学生可以自己改。
 */
export function ErrorReasonPicker({ attemptId, value, source, onChange }: {
  attemptId?: number | null
  value?: string
  source?: string
  onChange?: (v: string) => void
}) {
  const [current, setCurrent] = useState(value || "")
  const [mine, setMine] = useState(source === "user")
  const [saving, setSaving] = useState("")
  if (!attemptId) return null

  const pick = async (key: string) => {
    if (saving) return
    const next = key === current && mine ? "" : key
    setSaving(key)
    try {
      await setErrorReason(attemptId, next)
      setCurrent(next); setMine(!!next)
      onChange?.(next)
      toast(next ? "已记下错误原因" : "已清除错误原因", "success")
    } catch {
      toast("没保存成功，请再点一次", "error")
    } finally { setSaving("") }
  }

  return (
    <div className="mt-3">
      <p className="text-[11px] text-gray-400 mb-1.5">
        为什么错了？{current && !mine ? "（下面高亮的是 AI 猜测，不对可以改）" : current ? "（你选的）" : "（选一个，复习时更有针对性）"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {ERROR_REASONS.map((r) => {
          const on = current === r.key
          return (
            <button key={r.key} onClick={() => pick(r.key)} disabled={!!saving}
                    aria-pressed={on}
                    className={`text-[11px] px-2.5 py-1 rounded-full border disabled:opacity-60
                      ${on ? (mine ? "bg-gray-900 text-white border-gray-900" : "bg-blue-50 text-blue-600 border-blue-100 border-dashed")
                           : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"}`}>
              {r.label}{on && !mine && " · AI 猜测"}
            </button>
          )
        })}
      </div>
    </div>
  )
}
