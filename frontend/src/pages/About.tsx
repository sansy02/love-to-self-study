interface AboutProps {
  onNavigate: (page: string) => void
}

export default function About({ onNavigate }: AboutProps) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶部栏 */}
      <div className="max-w-2xl mx-auto w-full px-4 pt-6 md:pt-10 flex items-center gap-4">
        <button onClick={() => onNavigate("profile")}
                className="text-xs text-gray-400 hover:text-gray-600">← 返回</button>
        <h1 className="font-serif text-2xl text-gray-900 tracking-wide flex-1">关于我</h1>
      </div>

      <div className="max-w-2xl mx-auto w-full px-4 py-8 space-y-6">
        {/* 开发者信息 */}
        <div className="p-4 bg-gray-50 rounded-xl">
          <p className="text-sm text-gray-800 font-medium mb-2">开发者</p>
          <a href="https://github.com/sansy02" target="_blank" rel="noopener noreferrer"
             className="text-sm text-blue-500 hover:text-blue-700 underline inline-flex items-center gap-1">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub: sansy02 →
          </a>
        </div>

        {/* 关于爱学 */}
        <div className="p-4 bg-gray-50 rounded-xl">
          <p className="text-sm text-gray-800 font-medium mb-2">关于爱学助手</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            爱学助手是一款面向大学生的 AI 辅助学习工具。上传 PPT 或输入任意学习话题，
            AI 将自动生成结构化的教学内容、专业英语词汇和配套练习题，帮你高效掌握知识。
          </p>
        </div>

        {/* 预留扩展位 */}
        <div className="p-4 bg-gray-50 rounded-xl opacity-50">
          <p className="text-sm text-gray-800 font-medium mb-2">更多功能</p>
          <p className="text-xs text-gray-400">敬请期待...</p>
        </div>
      </div>
    </div>
  )
}
