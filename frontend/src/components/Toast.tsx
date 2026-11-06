/**
 * 轻提示：toast("已收藏") 在页面底部显示 2.5 秒后自动消失。
 * 在 App 里放一个 <Toaster />，任何页面都可以直接调用 toast()。
 */
import { useEffect, useState } from "react"

type Kind = "info" | "success" | "error"
interface Item { id: number; text: string; kind: Kind }

let nextId = 1
const listeners = new Set<(item: Item) => void>()

export function toast(text: string, kind: Kind = "info") {
  const item = { id: nextId++, text, kind }
  listeners.forEach((l) => l(item))
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([])

  useEffect(() => {
    const add = (item: Item) => {
      setItems((list) => [...list.slice(-2), item])
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== item.id)), item.kind === "error" ? 4000 : 2500)
    }
    listeners.add(add)
    return () => { listeners.delete(add) }
  }, [])

  return (
    <div className="fixed bottom-6 inset-x-0 z-[100] flex flex-col items-center gap-2 pointer-events-none px-4"
         role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id}
             className={`animate-toast-in pointer-events-auto max-w-sm px-4 py-2.5 rounded-xl text-sm shadow-sm border
               ${t.kind === "error" ? "bg-red-50 border-red-100 text-red-600"
                 : t.kind === "success" ? "bg-white border-gray-200 text-gray-800" : "bg-gray-900 border-gray-900 text-white"}`}>
          {t.kind === "success" && <span className="text-green-600 mr-1.5">✓</span>}
          {t.text}
        </div>
      ))}
    </div>
  )
}
