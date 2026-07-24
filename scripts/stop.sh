#!/bin/bash
# 停止平台：杀掉占用 8000/5173 端口的进程
for port in 8000 5173; do
  pids=$(lsof -ti tcp:$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null && echo "已停止端口 $port 的进程: $pids"
  else
    echo "端口 $port 无运行进程"
  fi
done
