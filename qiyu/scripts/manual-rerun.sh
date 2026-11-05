#!/usr/bin/env bash
# 手动补跑售前登记（AI 降级/漏跑后常用）
#
# 用法:
#   ./scripts/manual-rerun.sh                 # 默认：昨天
#   ./scripts/manual-rerun.sh 2026-11-02      # 指定日期
#   ./scripts/manual-rerun.sh 2026-11-02 --force-download  # 强制重新导出七鱼
#   ./scripts/manual-rerun.sh --dry-run           # 只打日志退出（测服务用）
#   ./scripts/manual-rerun.sh --help
#
# 行为: 优先复用 exports/历史会话按日-DATE.xlsx → to-register（AI 重试后可降级无法判定）→ 飞书；
#       没有按日 xlsx 时走与 daily-update 相同的 download 全流程。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:$PATH"

# 额外重试次数，默认 2 → 共 3 次（与 download.mjs / backfill 对齐）
MAX_RETRY="${QIYU_REGISTER_MAX_RETRY:-2}"
FORCE_DOWNLOAD=0
DRY_RUN=0
DAY=""

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \?//'
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --force-download) FORCE_DOWNLOAD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) DAY="$arg" ;;
    *)
      echo "未知参数: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$DAY" ]]; then
  if date -v-1d +%Y-%m-%d >/dev/null 2>&1; then
    DAY="$(date -v-1d +%Y-%m-%d)"
  else
    DAY="$(date -d yesterday +%Y-%m-%d)"
  fi
fi

if [[ ! "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "日期格式应为 YYYY-MM-DD，收到: $DAY" >&2
  exit 2
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "找不到 node" >&2
  exit 1
fi

LOG="$LOG_DIR/manual-rerun-$DAY-$(date +%H%M%S).log"
XLSX_DAY="$ROOT/exports/历史会话按日-$DAY.xlsx"
CSV="$ROOT/exports/售前登记摘录-$DAY.csv"

log() { printf '%s\n' "$*" | tee -a "$LOG"; }

find_xlsx() {
  if [[ -f "$XLSX_DAY" ]]; then
    printf '%s\n' "$XLSX_DAY"
    return 0
  fi
  # 兼容九月补跑 map
  local mapped
  mapped=$(python3 - <<PY
import json, pathlib
p = pathlib.Path("$ROOT/exports/._day-xlsx-map.jsonl")
if not p.exists():
    raise SystemExit(0)
day = "$DAY"
hit = ""
for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        j = json.loads(line)
    except Exception:
        continue
    if j.get("day") == day and j.get("xlsx"):
        hit = j["xlsx"]
print(hit)
PY
)
  if [[ -n "${mapped:-}" && -f "$mapped" ]]; then
    printf '%s\n' "$mapped"
    return 0
  fi
  return 1
}

run_register_retry() {
  local xlsx="$1"
  local attempt=0
  local code=1
  while [[ $attempt -le $MAX_RETRY ]]; do
    attempt=$((attempt + 1))
    log "---- to-register attempt=$attempt/$((MAX_RETRY+1)) $(date '+%F %T %z') ----"
    set +e
    "$NODE" "$ROOT/scripts/to-register.mjs" --in "$xlsx" --out "$CSV" >>"$LOG" 2>&1
    code=$?
    set -e
    if [[ $code -eq 0 ]]; then
      return 0
    fi
    log "to-register FAILED exit=$code attempt=$attempt"
    if [[ $attempt -le $MAX_RETRY ]]; then
      local wait=$((15 * attempt))
      log "等待 ${wait}s 后重试…"
      sleep "$wait"
    fi
  done
  return "$code"
}

run_lark() {
  set +e
  "$NODE" "$ROOT/scripts/to-lark-sheet.mjs" --in "$CSV" --date "$DAY" >>"$LOG" 2>&1
  local code=$?
  set -e
  return "$code"
}

extract_url() {
  python3 - <<PY
import re, pathlib
text = pathlib.Path("$LOG").read_text(encoding="utf-8", errors="ignore")
urls = re.findall(r"https://yb7ao262ru\\.feishu\\.cn/wiki/[^\\s\"\\\\]+", text)
print(urls[-1] if urls else "")
PY
}

log "==== manual-rerun start day=$DAY $(date '+%F %T %z') ===="
cd "$ROOT"

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY_RUN day=$DAY force=$FORCE_DOWNLOAD — skip work"
  log "OK day=$DAY rows=0"
  exit 0
fi

if [[ $FORCE_DOWNLOAD -eq 1 ]]; then
  log "强制重新导出：调用 download.mjs（内含 AI 重试 + 写飞书）"
  set +e
  "$NODE" "$ROOT/scripts/download.mjs" --start "$DAY" --end "$DAY" >>"$LOG" 2>&1
  code=$?
  set -e
  url="$(extract_url)"
  if [[ $code -eq 0 ]]; then
    rows=0
    [[ -f "$CSV" ]] && rows=$(($(wc -l < "$CSV") - 1))
    log "OK day=$DAY rows=$rows"
    [[ -n "$url" ]] && log "飞书: $url"
    log "日志: $LOG"
    exit 0
  fi
  log "FAILED exit=$code day=$DAY"
  log "日志: $LOG"
  exit "$code"
fi

xlsx="$(find_xlsx || true)"
if [[ -z "${xlsx:-}" ]]; then
  log "未找到按日 xlsx，改为全量导出 download.mjs（与定时任务相同）"
  set +e
  "$NODE" "$ROOT/scripts/download.mjs" --start "$DAY" --end "$DAY" >>"$LOG" 2>&1
  code=$?
  set -e
  url="$(extract_url)"
  if [[ $code -eq 0 ]]; then
    rows=0
    [[ -f "$CSV" ]] && rows=$(($(wc -l < "$CSV") - 1))
    log "OK day=$DAY rows=$rows"
    [[ -n "$url" ]] && log "飞书: $url"
    log "日志: $LOG"
    exit 0
  fi
  log "FAILED exit=$code day=$DAY"
  log "日志: $LOG"
  exit "$code"
fi

log "复用 xlsx: $xlsx"
if ! run_register_retry "$xlsx"; then
  log "FAILED to-register 重试用尽 day=$DAY"
  log "日志: $LOG"
  exit 1
fi

if ! run_lark; then
  log "FAILED to-lark-sheet day=$DAY（CSV 已生成: $CSV）"
  log "日志: $LOG"
  exit 1
fi

rows=$(($(wc -l < "$CSV") - 1))
url="$(extract_url)"
log "OK day=$DAY rows=$rows"
[[ -n "$url" ]] && log "飞书: $url"
log "日志: $LOG"
exit 0
