"""把 app.js、app.css 和图片拼成一个网页（所有东西都内嵌，不需要服务器）"""
import base64, pathlib, sys

out = pathlib.Path(sys.argv[1])
root = pathlib.Path(__file__).resolve().parent.parent
js = (out / "app.js").read_text(encoding="utf-8").replace("</script", "<\\/script")
css = (out / "app.css").read_text(encoding="utf-8")
img = base64.b64encode((root / "public" / "onboarding-reader.png").read_bytes()).decode()
js = js.replace('"/onboarding-reader.png"', f'"data:image/png;base64,{img}"')
html = f"""<title>爱学预览</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;500&display=swap">
<style>{css}
html,body{{background:#fdfcfe}}</style>
<div id="root"></div>
<script>{js}</script>
"""
(out / "aixue-preview.html").write_text(html, encoding="utf-8")
print("preview:", out / "aixue-preview.html", round(len(html) / 1024), "KB")
