#!/usr/bin/env bash
# 拉取当日七鱼会话 → 售前登记 CSV → 飞书表格
# launchd：每天 13:00 / 18:00 / 00:00（24 点）；也可手动：./scripts/daily-update.sh
# 手动可指定：./scripts/daily-update.sh 2026-09-28
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# launchd 环境极简，补上 Homebrew Node + 全局 npm（lark-cli）
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:$PATH"

# 默认今日；00 点（24 点档）取刚结束的那天
if [[ -n "${1:-}" ]]; then
  DAY="$1"
elif [[ "$(date +%H)" == "00" ]]; then
  DAY="$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d yesterday +%Y-%m-%d)"
else
  DAY="$(date +%Y-%m-%d)"
fi

LOG="$LOG_DIR/daily-update-$(date +%Y-%m-%d).log"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "找不到 node，请确认已安装并在 PATH 中" >&2
  exit 1
fi

{
  echo "==== $(date '+%Y-%m-%d %H:%M:%S %z') start day=$DAY ===="
  cd "$ROOT"
  set +e
  "$NODE" "$ROOT/scripts/download.mjs" --start "$DAY" --end "$DAY"
  code=$?
  set -e
  if [[ $code -eq 0 ]]; then
    echo "==== $(date '+%Y-%m-%d %H:%M:%S %z') done ===="
  else
    echo "==== $(date '+%Y-%m-%d %H:%M:%S %z') FAILED exit=$code ===="
  fi
  exit $code
} 2>&1 | tee -a "$LOG"
code=${PIPESTATUS[0]}
echo "日志: $LOG" >&2
exit "$code"
