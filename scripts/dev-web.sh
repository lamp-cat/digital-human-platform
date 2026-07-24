#!/usr/bin/env bash
# 启动前端开发服务器（Vite，端口 5173，/api 代理到 http://localhost:8000）。
# 首次运行前会自动检查 MediaPipe 本地资源。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -s "apps/web/public/mediapipe/pose_landmarker_full.task" ] || \
   [ ! -s "apps/web/public/mediapipe/face_landmarker.task" ] || \
   [ ! -d "apps/web/public/mediapipe/wasm" ]; then
  echo "[提示] 未检测到 MediaPipe 本地资源，正在执行 scripts/setup-mediapipe.sh …"
  bash scripts/setup-mediapipe.sh
fi

npm run dev --workspace apps/web
