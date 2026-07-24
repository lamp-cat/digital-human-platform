#!/usr/bin/env bash
# 一键启动 API 开发服务：建 venv → 装依赖 → uvicorn --reload
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$SCRIPT_DIR/../apps/api"
PY_BIN="${PYTHON:-/usr/local/bin/python3.11}"

cd "$API_DIR"

if [ ! -d .venv ]; then
  echo "[dev-api] 创建虚拟环境 .venv"
  "$PY_BIN" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "[dev-api] 安装依赖"
pip install --quiet -r requirements.txt

# 根目录 .env 存在则加载（不覆盖已存在的环境变量）
if [ -f "$SCRIPT_DIR/../.env" ]; then
  echo "[dev-api] 加载根目录 .env"
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../.env"
  set +a
fi

echo "[dev-api] 启动 uvicorn: http://localhost:${PORT:-8000}"
exec uvicorn app.main:app --reload --port "${PORT:-8000}"
