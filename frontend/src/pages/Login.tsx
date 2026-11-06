import { useState, useEffect } from "react"

interface LoginProps {
  onLogin: (token: string, user: { email: string; grade: string; major: string; subject: string }) => void
}

export default function Login({ onLogin }: LoginProps) {
  const [mode, setMode] = useState<"login" | "register">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [grade, setGrade] = useState("")
  const [major, setMajor] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [warming, setWarming] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)

  // 页面打开时预热后端 + 恢复记住的邮箱
  useEffect(() => {
    const savedEmail = localStorage.getItem("savedEmail")
    if (savedEmail) setEmail(savedEmail)
  }, [])
  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL || "/api"}/health`)
      .then(() => setWarming(false))
      .catch(() => setWarming(false))
  }, [])

  const handleSubmit = async () => {
    setError("")
    if (!email || !password) { setError("请填写邮箱和密码"); return }
    if (mode === "register" && password !== confirmPassword) { setError("两次输入的密码不一致"); return }
    if (mode === "register" && password.length < 6) { setError("密码至少需要6位"); return }

    setLoading(true)
    try {
      const API_BASE = import.meta.env.VITE_API_URL || "/api"
      const endpoint = `${API_BASE}/auth/${mode === "login" ? "login" : "register"}`
      const body = mode === "login"
        ? JSON.stringify({ email, password })
        : JSON.stringify({ email, password, confirm_password: confirmPassword, grade, major })

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
      // 检查响应是否为 JSON，避免解析 HTML 错误页时报错
      const contentType = res.headers.get("content-type") || ""
      if (!contentType.includes("application/json")) {
        throw new Error("服务器返回了无效响应，请确认后端服务是否正常运行")
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || "请求失败")

      localStorage.setItem("token", data.token)
      if (rememberMe) {
        localStorage.setItem("savedEmail", email)
      } else {
        localStorage.removeItem("savedEmail")
      }
      onLogin(data.token, data.user)
    } catch (err: any) {
      setError(err.message)
    } finally { setLoading(false) }
  }

  const GRADES = ["大一", "大二", "大三", "大四", "研一", "研二", "研三", "其他"]

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-white">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <div className="text-5xl mb-4">📚</div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">欢迎访问爱学助手</h1>
          <p className="text-sm text-gray-400">
            {warming ? "⏳ 服务器唤醒中..." : mode === "login" ? "欢迎回来" : "创建账号开始学习"}
          </p>
        </div>

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-xs text-gray-400 mb-1">邮箱</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                   placeholder="your@email.com"
                   className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-gray-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">密码</label>
            <div className="relative">
              <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                     placeholder="至少6位密码"
                     className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-xl outline-none focus:border-gray-400" />
              <button type="button" onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-base"
                      tabIndex={-1}>
                {showPassword ? "🙈" : "👁"}
              </button>
            </div>
          </div>

          {mode === "register" && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1">确认密码</label>
                <div className="relative">
                  <input type={showConfirmPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                         placeholder="再次输入密码"
                         className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-xl outline-none focus:border-gray-400" />
                  <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-base"
                          tabIndex={-1}>
                    {showConfirmPassword ? "🙈" : "👁"}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">年级（可选）</label>
                <select value={grade} onChange={(e) => setGrade(e.target.value)}
                        className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none bg-white">
                  <option value="">选择年级</option>
                  {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">专业（可选）</label>
                <input type="text" value={major} onChange={(e) => setMajor(e.target.value)}
                       placeholder="你的专业"
                       className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-gray-400" />
              </div>
            </>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-xl">
            <p className="text-xs text-red-500">{error}</p>
          </div>
        )}

        {mode === "login" && (
          <label className="flex items-center gap-2 mb-4 cursor-pointer">
            <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)}
                   className="w-3.5 h-3.5 rounded border-gray-300 text-gray-900 accent-gray-900" />
            <span className="text-xs text-gray-400">记住登录状态</span>
          </label>
        )}

        <button onClick={handleSubmit} disabled={loading}
                className="w-full py-3 bg-gray-900 text-white text-sm font-medium rounded-xl
                           hover:bg-gray-800 disabled:opacity-50 transition-colors">
          {loading ? "处理中..." : mode === "login" ? "登录" : "注册"}
        </button>

        <p className="text-center text-xs text-gray-400 mt-6">
          {mode === "login" ? "还没有账号？" : "已有账号？"}
          <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError("") }}
                  className="text-gray-800 underline ml-1">
            {mode === "login" ? "注册" : "登录"}
          </button>
        </p>

        <p className="text-center text-xs text-gray-400 mt-8">
          由 <span className="text-gray-400 font-medium">sansy02</span> 开发
        </p>
      </div>
    </div>
  )
}
