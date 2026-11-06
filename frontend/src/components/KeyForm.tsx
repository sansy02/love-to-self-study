/** 填入自己的 API Key（首页和「额度用完」时都会用到） */
import { useState, useRef, useEffect } from "react"
import { setApiKey, toApiError } from "../api"
import Spinner from "./Spinner"
import { toast } from "./Toast"

export default function KeyForm({ onSaved, onCancel, autoFocus = false }: {
  onSaved: (masked: string, provider: string) => void
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState("")
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  const save = async () => {
    if (!value.trim() || saving) return
    setSaving(true); setErr("")
    try {
      const r = await setApiKey(value.trim())
      setValue("")
      toast("Key 已加密保存，可以继续用了", "success")
      onSaved(r.masked, r.provider)
    } catch (e) {
      setErr(toApiError(e).message)
    } finally { setSaving(false) }
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-2">填入你自己的 DeepSeek Key（sk- 开头）或 Gemini Key（AIza 开头），不限次数，加密保存。</p>
      <div className="flex gap-2">
        <input ref={ref} type="password" value={value} onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") save() }}
               placeholder="粘贴 API Key" autoComplete="off"
               className="flex-1 min-w-0 px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none bg-white" />
        <button onClick={save} disabled={!value.trim() || saving}
                className="px-3 py-2 text-xs bg-gray-900 text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-1.5">
          {saving && <Spinner size={12} light />}{saving ? "保存中" : "保存"}
        </button>
        {onCancel && <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600 px-1">取消</button>}
      </div>
      {err && <p className="text-xs text-red-500 mt-2">{err}</p>}
    </div>
  )
}
