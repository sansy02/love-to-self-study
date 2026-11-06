/**
 * 3.0 学习画像：只用你自己的学习数据，看清你是怎样学习的，以及爱学为你做了哪些调整。
 */
import { useEffect, useState } from "react"
import { getPortrait, type Portrait as PortraitData } from "../api"
import ErrorPanel from "../components/ErrorPanel"
import { MasteryBadge } from "../components/Learning"

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]

function shade(count: number): string {
  if (!count) return "bg-gray-100"
  if (count < 5) return "bg-blue-100"
  if (count < 15) return "bg-gray-400"
  return "bg-gray-800"
}

export default function Portrait({ onNavigate }: { onNavigate: (page: string, sessionId?: string, scope?: string) => void }) {
  const [data, setData] = useState<PortraitData | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const load = () => { setErr(null); getPortrait().then(setData).catch(setErr) }
  useEffect(load, [])

  if (err) return <div className="max-w-2xl mx-auto px-4 py-16"><ErrorPanel error={err} actions={{ onRetry: load }} /></div>
  if (!data) {
    return <div className="max-w-2xl mx-auto px-4 pt-10 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 bg-gray-50 border border-gray-100 rounded-2xl animate-pulse" />)}</div>
  }

  // 日历：按周排（周一在第一列），最后一列是今天所在的周
  const first = new Date(data.calendar[0].day + "T00:00:00")
  const offset = (first.getDay() + 6) % 7
  const cells: ({ day: string; count: number } | null)[] = [...Array(offset).fill(null), ...data.calendar]
  const maxReason = Math.max(1, ...data.reasons.map((r) => r.count))
  const totalReasons = data.reasons.reduce((n, r) => n + r.count, 0)

  return (
    <div className="max-w-2xl mx-auto px-4 pt-6 md:pt-10 pb-16 animate-fade-in">
      <h1 className="font-serif text-2xl text-gray-900 tracking-wide">学习画像</h1>
      <p className="text-xs text-gray-400 mt-1.5">只根据你自己的学习记录生成，别人看不到</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-6">
        {[
          [`${data.streak}`, "连续学习（天）"],
          [`${data.active_days}`, "最近 28 天学了（天）"],
          [`${data.answered}`, "做过的题"],
          [data.accuracy === null ? "—" : `${data.accuracy}%`, "正确率"],
        ].map(([v, l]) => (
          <div key={l} className="p-3 rounded-xl bg-gray-50 border border-gray-100 text-center">
            <p className="font-serif text-xl text-gray-900 tabular-nums">{v}</p>
            <p className="text-[11px] text-gray-500">{l}</p>
          </div>
        ))}
      </div>

      <section className="mt-8">
        <p className="text-xs text-gray-500 mb-2">最近 4 周</p>
        <div className="inline-flex flex-col gap-1" role="img" aria-label={`最近 28 天里有 ${data.active_days} 天在学习`}>
          {WEEKDAYS.map((w, row) => (
            <div key={w} className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400 w-4">{w}</span>
              {Array.from({ length: Math.ceil(cells.length / 7) }, (_, col) => {
                const c = cells[col * 7 + row]
                return <span key={col} title={c ? `${c.day}：${c.count ? `学习 ${c.count} 次` : "没有学习"}` : ""}
                             className={`w-4 h-4 rounded-[4px] ${c ? shade(c.count) : "bg-transparent"}`} />
              })}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 mt-2">颜色越深，那天学得越多（翻页、做题、复习都算）</p>
      </section>

      <section className="mt-8">
        <p className="text-xs text-gray-500 mb-3">你最常怎么错</p>
        {totalReasons === 0 ? (
          <p className="text-xs text-gray-400">还没有记录。答错时选一下「为什么错了」，这里就会有统计。</p>
        ) : (
          <div className="space-y-2">
            {data.reasons.map((r) => (
              <div key={r.key} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-28 shrink-0">{r.label}</span>
                <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full bg-gray-500 rounded-full" style={{ width: `${(r.count / maxReason) * 100}%` }} />
                </div>
                <span className="text-xs text-gray-500 w-6 text-right tabular-nums">{r.count}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {data.weak.length > 0 && (
        <section className="mt-8">
          <p className="text-xs text-gray-500 mb-2">最需要加强的知识点</p>
          <div className="space-y-2">
            {data.weak.map((w) => (
              <div key={w.name + w.course} className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-100 bg-white">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900">{w.name}</p>
                  <p className="text-[11px] text-gray-400 truncate">{w.course} · 答错 {w.wrong} 次</p>
                </div>
                <MasteryBadge status={w.status} label={w.label} />
              </div>
            ))}
          </div>
        </section>
      )}

      {data.courses.length > 0 && (
        <section className="mt-8">
          <p className="text-xs text-gray-500 mb-2">各门课掌握了多少</p>
          <div className="space-y-3">
            {data.courses.map((c) => (
              <div key={c.id}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-gray-800 truncate">{c.name}</span>
                  <span className="text-[11px] text-gray-500 shrink-0 tabular-nums">
                    已掌握 {c.mastered} / {c.total}{c.days_left !== null && c.days_left >= 0 ? ` · 距离考试 ${c.days_left} 天` : ""}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mt-1.5 flex">
                  <div className="h-full bg-gray-700" style={{ width: `${(c.mastered / c.total) * 100}%` }} />
                  <div className="h-full bg-blue-100" style={{ width: `${(c.learning / c.total) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-2">深色是已掌握，浅色是学习中</p>
        </section>
      )}

      <section className="mt-8 p-5 rounded-2xl border border-gray-200 bg-white">
        <p className="font-serif text-base text-gray-900">爱学为你做的调整</p>
        <p className="text-[11px] text-gray-400 mt-1 mb-3">根据你的学习方式（{data.style_summary}）和你答错的原因</p>
        <ul className="space-y-1.5">
          {data.adaptations.map((a) => (
            <li key={a} className="text-sm text-gray-700 flex gap-2"><span className="text-gray-400">·</span><span>{a}</span></li>
          ))}
        </ul>
        <button onClick={() => onNavigate("profile")} className="mt-4 text-xs text-gray-500 hover:text-gray-800 underline underline-offset-4 decoration-gray-300">
          {data.profile_completed ? "修改我的学习方式" : "回答 5 个问题，让调整更准"}
        </button>
      </section>
    </div>
  )
}
