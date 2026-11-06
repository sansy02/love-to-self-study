/** 小圆圈加载动画（按钮里、页面里通用） */
export default function Spinner({ size = 16, light = false }: { size?: number; light?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-full animate-spin shrink-0 border-2 ${light ? "border-white/40 border-t-white" : "border-gray-200 border-t-gray-600"}`}
      style={{ width: size, height: size }}
    />
  )
}
