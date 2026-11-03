#!/usr/bin/env bash
# 按天重拉 → CSV → 飞书；一天成功再下一天。日志: logs/backfill-sep/
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs/backfill-sep"
mkdir -p "$LOG_DIR"
SUMMARY="$LOG_DIR/summary.tsv"
RUNLOG="$LOG_DIR/runner.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:$PATH"

START_DAY="${1:-2026-09-01}"
END_DAY="${2:-2026-09-29}"
MAX_RETRY="${3:-2}"

if [[ ! -f "$SUMMARY" ]]; then
  printf 'date\tstatus\texit\trows\tseconds\turl\tnote\n' > "$SUMMARY"
fi

log() { printf '%s\n' "$*" >> "$RUNLOG"; echo "$*"; }

log "==== backfill loop start $(date '+%Y-%m-%d %H:%M:%S %z') range=$START_DAY..$END_DAY ===="

cur="$START_DAY"
while [[ "$cur" < "$END_DAY" || "$cur" == "$END_DAY" ]]; do
  day="$cur"
  # skip if already OK in summary
  if awk -F'\t' -v d="$day" '$1==d && $2=="OK"{found=1} END{exit !found}' "$SUMMARY"; then
    log "DAY=$day SKIP already OK in summary"
    if date -j -f '%Y-%m-%d' "$day" +%Y-%m-%d >/dev/null 2>&1; then
      cur=$(date -j -v+1d -f '%Y-%m-%d' "$day" +%Y-%m-%d)
    else
      cur=$(date -d "$day +1 day" +%Y-%m-%d)
    fi
    continue
  fi

  attempt=0
  ok=0
  rows=""
  url=""
  note=""
  code=1
  t0=$(date +%s)
  while [[ $attempt -le $MAX_RETRY ]]; do
    attempt=$((attempt + 1))
    log "---- DAY=$day attempt=$attempt/$((MAX_RETRY+1)) START=$(date '+%H:%M:%S') ----"
    set +e
    "$ROOT/scripts/daily-update.sh" "$day" >> "$RUNLOG" 2>&1
    code=$?
    set -e
    if [[ $code -eq 0 ]]; then
      ok=1
      csv="$ROOT/exports/售前登记摘录-$day.csv"
      if [[ -f "$csv" ]]; then
        rows=$(($(wc -l < "$csv") - 1))
      fi
      url=$(python3 - <<PY
import json,re,pathlib
p=pathlib.Path("$ROOT/logs/daily-update-$(date +%Y-%m-%d).log")
text=p.read_text(encoding='utf-8', errors='ignore') if p.exists() else ''
urls=re.findall(r'https://yb7ao262ru\.feishu\.cn/wiki/[^\s"]+', text)
print(urls[-1] if urls else '')
PY
)
      note="ok attempt=$attempt"
      break
    fi
    note="fail exit=$code attempt=$attempt"
    log "DAY=$day FAILED exit=$code attempt=$attempt"
    if [[ $attempt -le $MAX_RETRY ]]; then
      sleep $((15 * attempt))
    fi
  done
  t1=$(date +%s)
  secs=$((t1 - t0))
  status=$([ $ok -eq 1 ] && echo OK || echo FAIL)
  # replace prior row for same date if any
  tmp=$(mktemp)
  awk -F'\t' -v d="$day" 'NR==1 || $1!=d' "$SUMMARY" > "$tmp"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$day" "$status" "$code" "$rows" "$secs" "$url" "$note" >> "$tmp"
  mv "$tmp" "$SUMMARY"
  log "DAY=$day $status secs=$secs rows=$rows"
  if date -j -f '%Y-%m-%d' "$day" +%Y-%m-%d >/dev/null 2>&1; then
    cur=$(date -j -v+1d -f '%Y-%m-%d' "$day" +%Y-%m-%d)
  else
    cur=$(date -d "$day +1 day" +%Y-%m-%d)
  fi
  # brief pause between days to avoid 8003
  sleep 5
done

log "==== backfill loop end $(date '+%Y-%m-%d %H:%M:%S %z') ===="
