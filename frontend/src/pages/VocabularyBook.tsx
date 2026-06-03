import { useState, useEffect } from "react"
import { getUserVocabulary, type VocabWord } from "../api"

interface VocabularyBookProps {
  onNavigate: (page: string) => void
}

interface DictData {
  phonetic: string
  meanings: { partOfSpeech: string; definitions: { definition: string; example?: string }[] }[]
}

export default function VocabularyBook({ onNavigate }: VocabularyBookProps) {
  const [words, setWords] = useState<VocabWord[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [dictCache, setDictCache] = useState<Record<number, DictData | null>>({})
  const [loadingDict, setLoadingDict] = useState<Record<number, boolean>>({})

  const fetchDict = async (wordId: number, word: string) => {
    if (dictCache[wordId] !== undefined) return
    setLoadingDict(p => ({ ...p, [wordId]: true }))
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)
      if (!res.ok) throw new Error("not found")
      const data = await res.json()
      const entry = data[0]
      setDictCache(p => ({
        ...p,
        [wordId]: {
          phonetic: entry.phonetics?.find((ph: any) => ph.text)?.text || entry.phonetic || "",
          meanings: entry.meanings?.slice(0, 3).map((m: any) => ({
            partOfSpeech: m.partOfSpeech,
            definitions: m.definitions.slice(0, 2).map((d: any) => ({
              definition: d.definition,
              example: d.example || "",
            })),
          })) || [],
        },
      }))
    } catch {
      setDictCache(p => ({ ...p, [wordId]: null }))
    }
    setLoadingDict(p => ({ ...p, [wordId]: false }))
  }

  useEffect(() => {
    getUserVocabulary()
      .then((data) => setWords(data.words))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* 顶部栏 */}
      <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-4">
        <button onClick={() => onNavigate("profile")} className="text-xs text-gray-400 hover:text-gray-600">← 返回</button>
        <h2 className="text-sm font-medium text-gray-800 flex-1">我的词汇收藏</h2>
        <span className="text-xs text-gray-300">{words.length} 词</span>
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-6">
        {words.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-4">📖</p>
            <p className="text-sm text-gray-400">还没有收藏的词汇</p>
            <p className="text-xs text-gray-300 mt-1">学习时点击 ☆ 即可收藏</p>
          </div>
        ) : (
          <div className="space-y-2">
            {words.map((w) => (
              <div key={w.id}
                   className="border border-gray-100 rounded-xl overflow-hidden transition-all">
                {/* 单词卡片头部 */}
                <button
                  onClick={() => {
                    const nextId = expandedId === w.id ? null : w.id
                    setExpandedId(nextId)
                    if (nextId !== null) fetchDict(w.id, w.word)
                  }}
                  className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors text-left"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{w.word}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{w.translation}</p>
                  </div>
                  <span className={`text-xs text-gray-300 transition-transform duration-200
                    ${expandedId === w.id ? 'rotate-180' : ''}`}>
                    ▼
                  </span>
                </button>

                {/* 展开详情 */}
                {expandedId === w.id && (
                  <div className="px-4 pb-4 border-t border-gray-50 pt-3 space-y-3">
                    {/* 词典数据 */}
                    {loadingDict[w.id] ? (
                      <div className="flex items-center gap-2 py-2">
                        <div className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                        <span className="text-xs text-gray-300">查询词典中...</span>
                      </div>
                    ) : dictCache[w.id] ? (
                      <>
                        {dictCache[w.id]!.phonetic && (
                          <div>
                            <p className="text-xs text-gray-400 mb-1">音标</p>
                            <p className="text-sm text-gray-700 font-mono">{dictCache[w.id]!.phonetic}</p>
                          </div>
                        )}
                        {dictCache[w.id]!.meanings.map((m, mi) => (
                          <div key={mi}>
                            <p className="text-xs text-gray-400 mb-1">
                              {m.partOfSpeech === "noun" ? "📗 名词" :
                               m.partOfSpeech === "verb" ? "📕 动词" :
                               m.partOfSpeech === "adjective" ? "📙 形容词" :
                               m.partOfSpeech === "adverb" ? "📘 副词" : `🔤 ${m.partOfSpeech}`}
                            </p>
                            {m.definitions.map((d, di) => (
                              <div key={di} className="ml-3 mb-1">
                                <p className="text-sm text-gray-700">{d.definition}</p>
                                {d.example && (
                                  <p className="text-xs text-gray-400 italic mt-0.5">"{d.example}"</p>
                                )}
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    ) : null}
                    {/* AI 生成的释义和例句 */}
                    <div className="border-t border-gray-100 pt-3">
                      <div>
                        <p className="text-xs text-gray-400 mb-1">AI 翻译</p>
                        <p className="text-sm text-gray-700">{w.translation}</p>
                      </div>
                      {w.example && (
                        <div className="mt-2">
                          <p className="text-xs text-gray-400 mb-1">AI 例句</p>
                          <p className="text-sm text-gray-600 italic leading-relaxed">{w.example}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
