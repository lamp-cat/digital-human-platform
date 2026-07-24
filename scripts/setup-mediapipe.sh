#!/usr/bin/env bash
# 本地化 MediaPipe 姿态模型与 wasm 运行时（比赛离线运行要求）。
# 用法：bash scripts/setup-mediapipe.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/apps/web/public/mediapipe"
WASM_SRC="$ROOT_DIR/node_modules/@mediapipe/tasks-vision/wasm"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task"
MODEL_HEAVY_URL="https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task"
HAND_MODEL_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"

mkdir -p "$TARGET_DIR"

# 1. 姿态模型（full 约 9MB / heavy 约 29MB，运行时按"流畅/精准"档切换）
if [ -s "$TARGET_DIR/pose_landmarker_full.task" ]; then
  echo "[skip] pose_landmarker_full.task 已存在"
else
  echo "[下载] $MODEL_URL"
  curl -fSL --retry 3 -o "$TARGET_DIR/pose_landmarker_full.task" "$MODEL_URL"
fi
if [ -s "$TARGET_DIR/pose_landmarker_heavy.task" ]; then
  echo "[skip] pose_landmarker_heavy.task 已存在"
else
  echo "[下载] $MODEL_HEAVY_URL"
  curl -fSL --retry 3 -o "$TARGET_DIR/pose_landmarker_heavy.task" "$MODEL_HEAVY_URL"
fi

# 1b. 手部模型（约 7.8MB，动作模式"手部追踪"实验性功能）
if [ -s "$TARGET_DIR/hand_landmarker.task" ]; then
  echo "[skip] hand_landmarker.task 已存在"
else
  echo "[下载] $HAND_MODEL_URL"
  curl -fSL --retry 3 -o "$TARGET_DIR/hand_landmarker.task" "$HAND_MODEL_URL"
fi

# 2. wasm 运行时（从 npm 包拷贝，约 32MB）
if [ ! -d "$WASM_SRC" ]; then
  echo "[错误] 未找到 $WASM_SRC，请先在 monorepo 根目录执行 npm install" >&2
  exit 1
fi
rm -rf "$TARGET_DIR/wasm"
cp -R "$WASM_SRC" "$TARGET_DIR/wasm"

echo "[完成] MediaPipe 资源已本地化到 apps/web/public/mediapipe/"
ls -la "$TARGET_DIR" "$TARGET_DIR/wasm"
