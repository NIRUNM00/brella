#!/bin/bash
# Brella API 保活守护 — shell daemon，零 token 消耗
# 每 30 秒检查 health 端点，挂了就重启
#
# 环境变量: BRELLA_DIR, BRELLA_PORT, LOG_DIR
#
# 用法:
#   ./deploy/brella-keepalive.sh &             # 后台运行
#   BRELLA_PORT=8899 ./deploy/brella-keepalive.sh &

PORT="${BRELLA_PORT:-8898}"
BRELLA_DIR="${BRELLA_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
START_SCRIPT="${BRELLA_DIR}/deploy/start_brella.sh"
LOG_DIR="${LOG_DIR:-${BRELLA_DIR}/logs}"
LOG_FILE="${LOG_DIR}/brella-keepalive.log"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

while true; do
  if ! curl -sf "http://localhost:${PORT}/v1/health" >/dev/null 2>&1; then
    # Health failed — maybe port changed, try to detect from log
    REAL_PORT=$(tail -20 "${LOG_DIR}/brella.log" 2>/dev/null | grep -oP 'http://0\.0\.0\.0:\K\d+' | tail -1)
    if [ -n "$REAL_PORT" ] && [ "$REAL_PORT" != "$PORT" ]; then
      PORT="$REAL_PORT"
      log "detected port change → :${PORT}"
    fi

    # One more try
    if curl -sf "http://localhost:${PORT}/v1/health" >/dev/null 2>&1; then
      sleep 30
      continue
    fi

    log "Brella API down (port ${PORT}), restarting..."
    bash "$START_SCRIPT" 2>&1 | while read -r line; do log "startup: $line"; done

    sleep 3
    if curl -sf "http://localhost:${PORT}/v1/health" >/dev/null 2>&1; then
      log "✅ restarted OK on :${PORT}"
    else
      NEW_PORT=$(tail -5 "${LOG_DIR}/brella.log" 2>/dev/null | grep -oP 'http://0\.0\.0\.0:\K\d+' | tail -1)
      if [ -n "$NEW_PORT" ] && [ "$NEW_PORT" != "$PORT" ]; then
        PORT="$NEW_PORT"
        if curl -sf "http://localhost:${PORT}/v1/health" >/dev/null 2>&1; then
          log "✅ restarted OK on :${PORT} (port changed)"
        else
          log "❌ restart FAILED on :${PORT}"
        fi
      else
        log "❌ restart FAILED"
      fi
    fi
  fi
  sleep 30
done
