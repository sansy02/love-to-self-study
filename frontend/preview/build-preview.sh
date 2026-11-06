#!/bin/bash
# 把当前界面打包成一个单独的预览网页：preview/dist/aixue-preview.html
# 需要：esbuild、tailwindcss（本地 npm install 之后就有）
set -e
cd "$(dirname "$0")/.."
OUT=preview/dist
mkdir -p $OUT
ESBUILD=${ESBUILD:-npx esbuild}
$ESBUILD preview/main.tsx --bundle --outfile=$OUT/app.js --format=iife --jsx=automatic --loader:.css=empty \
  --define:import.meta.env.VITE_API_URL='"/api"' --define:import.meta.env.VITE_ENABLE_LOGIN='"false"' \
  --define:process.env.NODE_ENV='"production"' --minify --log-level=warning
${TAILWIND_CMD:-npx @tailwindcss/cli -i src/index.css -o $OUT/app.css --minify}
python3 preview/assemble.py $OUT
