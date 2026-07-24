#!/bin/bash
# 数字人平台一键启动脚本（可在任意目录执行）
# 自动完成：依赖检查/安装 → 启动后端(8000) → 启动前端(5173) → 打开浏览器
# 停止：在本终端按 Ctrl+C（前后端会一起退出）

set -e
# 脚本自身所在目录的上一级即项目根（与调用时所在目录无关）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY=/usr/local/bin/python3.11
API_DIR="$ROOT/apps/api"
VENV="$API_DIR/.venv"

echo "==> 项目目录: $ROOT"

# 1. 前端依赖
if [ ! -d "$ROOT/node_modules" ]; then
  echo "==> 安装前端依赖 (npm install)..."
  npm install --no-audit --no-fund
fi

# 2. 姿态模型本地化（已存在则跳过）
if [ ! -f "$ROOT/apps/web/public/mediapipe/pose_landmarker_full.task" ]; then
  echo "==> 下载浏览器端姿态模型..."
  bash "$ROOT/scripts/setup-mediapipe.sh"
fi

# 3. 后端 venv 与依赖
if [ ! -d "$VENV" ]; then
  echo "==> 创建后端虚拟环境并安装依赖..."
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$API_DIR/requirements.txt"
fi

# 4. 启动后端
echo "==> 启动后端 API  http://localhost:8000"
(cd "$API_DIR" && exec "$VENV/bin/uvicorn" app.main:app --port 8000) &
API_PID=$!

# 5. 启动前端
echo "==> 启动前端 Web  http://localhost:5173"
npm run dev:web &
WEB_PID=$!

# Ctrl+C 时一起关闭前后端
trap 'echo; echo "==> 正在停止..."; kill $API_PID $WEB_PID 2>/dev/null; exit 0' INT TERM

# 6. 等待前端就绪后打开浏览器
for i in $(seq 1 30); do
  if curl -s -m 1 -o /dev/null http://localhost:5173/; then
    echo "==> 已就绪，打开浏览器。账号 demo@dhp.local / demo123456（管理员 admin@dhp.local / admin123456）"
    open http://localhost:5173/ 2>/dev/null || true
    break
  fi
  sleep 1
done

wait
