/**
 * 极简 Markdown 渲染：段落、「- 」列表、「1. 」列表、**加粗**。
 * 不使用 innerHTML，AI 输出里的 HTML 不会被执行。
 */
import type { ReactNode } from "react"

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.filter(Boolean).map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      return <strong key={`${keyPrefix}-${i}`} className="font-semibold text-gray-900">{p.slice(2, -2)}</strong>
    }
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      return <code key={`${keyPrefix}-${i}`} className="px-1 py-0.5 bg-gray-100 rounded text-[0.85em]">{p.slice(1, -1)}</code>
    }
    return <span key={`${keyPrefix}-${i}`}>{p}</span>
  })
}

export default function RichText({ text, className = "" }: { text: string; className?: string }) {
  const lines = (text || "").replace(/\r/g, "").split("\n")
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushPara = () => {
    if (para.length) {
      const k = `p${blocks.length}`
      blocks.push(
        <p key={k} className="mb-3 last:mb-0">
          {para.map((l, i) => (
            <span key={i}>{inline(l, `${k}-${i}`)}{i < para.length - 1 && <br />}</span>
          ))}
        </p>,
      )
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      const k = `l${blocks.length}`
      const items = list.items.map((it, i) => <li key={i} className="mb-1">{inline(it, `${k}-${i}`)}</li>)
      blocks.push(list.ordered
        ? <ol key={k} className="list-decimal pl-5 mb-3 last:mb-0">{items}</ol>
        : <ul key={k} className="list-disc pl-5 mb-3 last:mb-0">{items}</ul>)
      list = null
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)、]\s+(.*)$/)
    if (!line.trim()) {
      flushPara(); flushList()
    } else if (bullet || numbered) {
      flushPara()
      const ordered = !!numbered
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push((bullet ? bullet[1] : numbered![1]).trim())
    } else {
      flushList()
      para.push(line.replace(/^#+\s*/, ""))
    }
  }
  flushPara(); flushList()

  return <div className={className}>{blocks}</div>
}
