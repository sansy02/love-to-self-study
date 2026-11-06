/**
 * 预览版入口：先装上假后端（mock.ts），再启动和正式网站一样的界面。
 * 打包命令见 build-preview.sh，产物是一个可以直接打开的网页。
 */
import "./mock"
import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import App from "../src/App"

function PreviewBar() {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <div role="note" style={{
      position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: "calc(76px + env(safe-area-inset-bottom, 0px))", zIndex: 90,
      width: "min(560px, calc(100vw - 32px))", background: "#2a2235", color: "#e4e0ea", fontSize: 12, lineHeight: "18px",
      padding: "10px 12px 10px 16px", borderRadius: 12, display: "flex", gap: 12, alignItems: "center", boxShadow: "0 6px 24px rgba(42,34,53,.18)",
    }}>
      <span style={{ flex: 1 }}>预览版：示例数据，不连接服务器和 AI，刷新后清空。真正的网站是 love-to-self-study.vercel.app</span>
      <button onClick={() => setOpen(false)} style={{ color: "#fff", background: "transparent", border: "1px solid #6d657a", borderRadius: 8, padding: "2px 10px", fontSize: 12 }}>知道了</button>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PreviewBar />
    <App />
  </StrictMode>,
)
