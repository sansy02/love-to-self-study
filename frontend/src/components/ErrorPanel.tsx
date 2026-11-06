/**
 * 统一的错误面板：告诉学生「发生了什么、为什么、接下来怎么做」，并给出对应的按钮。
 * 只显示后端给的中文说明（后端保证不含内部报错、密钥和模型原始回复）。
 */
import { toApiError, type ApiError } from "../api"
import Spinner from "./Spinner"

export interface ErrorActions {
  onRetry?: () => void
  onUseKey?: () => void        // 额度用完：去填自己的 Key
  onSample?: () => void        // 额度用完：先看示例课程
  onHome?: () => void          // 找不到记录：回首页
  onPickFile?: () => void      // 上传失败：换一个文件
  retrying?: boolean
}

const TITLES: Record<string, string> = {
  quota_exceeded: "今天的免费次数用完了",
  ai_unavailable: "AI 暂时连不上",
  ai_bad_output: "AI 这次的回答格式不对",
  rate_limited: "操作太快了",
  save_failed: "刚才没有保存成功",
  network: "网络连接失败",
  service_unavailable: "服务器正在唤醒",
  not_found: "找不到这条记录",
  upload_bad_type: "这个文件格式不支持",
  upload_old_format: "这是旧版格式的文件",
  upload_too_large: "文件太大了",
  upload_empty: "文件是空的",
  upload_parse_failed: "课件读不出来",
  upload_no_text: "课件里没有读到文字",
  server_error: "服务器出了点问题",
}

const HINTS: Record<string, string> = {
  quota_exceeded: "已经生成过的讲解可以继续免费看。",
  ai_unavailable: "通常是免费模型太忙，等十几秒再试一般就好。",
  ai_bad_output: "没有保存这次的结果，再试一次通常就好。",
  rate_limited: "等一会儿再点。",
  save_failed: "你的操作没有生效，可以放心重试。",
  network: "检查一下网络，然后重试。",
  service_unavailable: "免费服务器闲置后会休眠，第一次打开要等 30 秒左右。",
}

export default function ErrorPanel({ error, actions = {}, compact = false }: { error: unknown; actions?: ErrorActions; compact?: boolean }) {
  const e: ApiError = toApiError(error)
  const title = TITLES[e.code] || "出了点问题"
  const hint = HINTS[e.code]
  const isUpload = e.code.startsWith("upload_")

  const btn = "text-xs px-3 py-1.5 rounded-lg disabled:opacity-50"
  return (
    <div className={`animate-fade-in border border-red-100 bg-red-50/70 rounded-xl ${compact ? "p-3" : "p-4"}`} role="alert">
      <p className="text-sm font-medium text-gray-800">{title}</p>
      {e.message && e.message !== title && <p className="text-xs text-gray-600 mt-1 leading-relaxed whitespace-pre-wrap">{e.message}</p>}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
      <div className="flex flex-wrap gap-2 mt-3">
        {e.code === "quota_exceeded" ? (
          <>
            {actions.onUseKey && <button onClick={actions.onUseKey} className={`${btn} bg-gray-900 text-white`}>填入自己的 Key</button>}
            {actions.onSample && <button onClick={actions.onSample} className={`${btn} border border-gray-200 bg-white text-gray-600`}>先看示例课程</button>}
          </>
        ) : e.code === "not_found" ? (
          actions.onHome && <button onClick={actions.onHome} className={`${btn} bg-gray-900 text-white`}>回到首页</button>
        ) : isUpload ? (
          actions.onPickFile && <button onClick={actions.onPickFile} className={`${btn} bg-gray-900 text-white`}>换一个文件</button>
        ) : (
          actions.onRetry && (
            <button onClick={actions.onRetry} disabled={actions.retrying} className={`${btn} bg-gray-900 text-white inline-flex items-center gap-1.5`}>
              {actions.retrying && <Spinner size={12} light />}重试
            </button>
          )
        )}
      </div>
    </div>
  )
}
