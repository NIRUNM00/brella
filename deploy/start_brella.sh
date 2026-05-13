#!/bin/bash
# Brella API 启动脚本 — 通用版
#
# 配置加载链: CLI 参数 > 环境变量(BRELLA_*) > .brellarc > ~/.brellarc > 默认值
#
# 用法:
#   ./deploy/start_brella.sh                        # 走 .brellarc / 默认
#   ./deploy/start_brella.sh -p 8899 -d /path/to/db
#   BRELLA_PORT=8899 BRELLA_DB_PATH=/db.sqlite ./deploy/start_brella.sh
#   ./deploy/start_brella.sh --port 8899 -c /etc/brella/config.json
#
# 日志:   logs/brella.log
# PID:    logs/brella.pid

set -euo pipefail

BRELLA_DIR="${BRELLA_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG_DIR="${LOG_DIR:-${BRELLA_DIR}/logs}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/brella.log}"
PID_FILE="${PID_FILE:-${LOG_DIR}/brella.pid}"

mkdir -p "$LOG_DIR"

# ---------- Parse args for port (needed to kill old process) ----------
TARGET_PORT="${BRELLA_PORT:-${PORT:-}}"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port) TARGET_PORT="$2"; ARGS+=("$1" "$2"); shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

if [ -z "$TARGET_PORT" ]; then
  TARGET_PORT="${BRELLA_PORT:-${PORT:-8898}}"
fi

# ---------- Pass BRELLA_DB_PATH as --db arg ----------
if [ -n "${BRELLA_DB_PATH:-}" ]; then
  ARGS+=("--db" "$BRELLA_DB_PATH")
fi

# ---------- Rotate log ----------
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
  cp "$LOG_FILE" "${LOG_FILE}.old" 2>/dev/null || true
fi
: > "$LOG_FILE"

# ---------- Kill old processes ----------
# 1) PID file
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[brella] stopping tracked process (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    for i in 1 2 3; do
      sleep 1
      kill -0 "$OLD_PID" 2>/dev/null || { echo "[brella] tracked process stopped"; break; }
    done
    kill -0 "$OLD_PID" 2>/dev/null && { echo "[brella] force kill tracked"; kill -9 "$OLD_PID" 2>/dev/null || true; }
  fi
  rm -f "$PID_FILE"
fi

# 2) Process name — kill all node dist/api/server.js
for pid in $(pgrep -f 'node.*dist/api/server\.js' 2>/dev/null || true); do
  echo "[brella] killing old server process (PID $pid)..."
  kill "$pid" 2>/dev/null || true
done
sleep 2
for pid in $(pgrep -f 'node.*dist/api/server\.js' 2>/dev/null || true); do
  echo "[brella] force killing remaining server (PID $pid)..."
  kill -9 "$pid" 2>/dev/null || true
done
sleep 1

# ---------- Start ----------
cd "$BRELLA_DIR"

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "[brella] starting — config chain: CLI args > env vars > .brellarc > defaults"
else
  echo "[brella] starting with: node dist/api/server.js ${ARGS[*]}"
fi

nohup node dist/api/server.js "${ARGS[@]}" > "$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"

# ---------- Health check ----------
echo "[brella] PID $PID — waiting for health check..."
sleep 2

PORT_FOUND=""
for i in 1 2 3 4 5; do
  PORT_FOUND=$(grep -oP 'http://0\.0\.0\.0:\K\d+' "$LOG_FILE" 2>/dev/null || echo "")
  if [ -n "$PORT_FOUND" ]; then
    if curl -sf "http://localhost:${PORT_FOUND}/v1/health" >/dev/null 2>&1; then
      echo "[brella] ✅ started — http://0.0.0.0:${PORT_FOUND}"
      echo "[brella]    DB: $(grep 'DB:' "$LOG_FILE" | head -1 | sed 's/.*DB: *//')"
      echo "[brella]    config: $(grep 'config:' "$LOG_FILE" | head -1 | sed 's/.*config: *//')"
      exit 0
    fi
  fi
  sleep 1
done

# Last attempt
if [ -n "$PORT_FOUND" ]; then
  if curl -sf "http://localhost:${PORT_FOUND}/v1/health" >/dev/null 2>&1; then
    echo "[brella] ✅ started (delayed) — http://0.0.0.0:${PORT_FOUND}"
    exit 0
  fi
fi

echo "[brella] ❌ startup FAILED — check log: $LOG_FILE"
tail -5 "$LOG_FILE" | sed 's/^/  | /'
exit 1
