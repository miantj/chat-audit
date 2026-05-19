#!/bin/bash
# -----------------------------------------------------------------------
# export-with-self-heal.sh — Export with self-iteration and recovery
#
# Usage: ./scripts/export-with-self-heal.sh --start=YYYY-MM-DD --end=YYYY-MM-DD [export-date-range options]
#
# Self-iteration loop:
#   1. Run export-date-range.js
#   2. On failure, detect blocking error type
#   3. If self-healable and retry count < 3: attempt self-heal → retry
#   4. If non-self-healable (e.g. WeChat login): stop and ask user to re-login
#   5. If retry count >= 3 for same error: stop, summarize, write to knowledge base
#
# State is persisted in /tmp/chat-audit-self-heal-state.json between runs.
# Clear state with: rm /tmp/chat-audit-self-heal-state.json
# -----------------------------------------------------------------------

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_ROOT="$(dirname "$SCRIPT_DIR")"
# Shared CDP probe + cold-start (CHAT_AUDIT_CRM_CDP_BASE, default http://localhost:9222).
# shellcheck source=cdp-probe.sh
source "$SCRIPT_DIR/cdp-probe.sh"
if [[ -f "$SCRIPT_ROOT/SKILL.md" ]]; then
  SKILL_DIR="$SCRIPT_ROOT"
else
  SKILL_DIR=""
fi
CALLER_CWD="$(pwd)"
STATE_FILE="/tmp/chat-audit-self-heal-state.json"
EXPECT_DEPT="${CHAT_AUDIT_EXPECT_DEPT:-大客私域顾问-总}"
MAX_LOOP=25

# Default export options
DATE_START=""
DATE_END=""
EXPORT_OUT=""
EXPORT_KEYWORDS=""
SKIP_DATE_VALIDATION=""
EXPORT_PACED=""
RETRY_FAILED=""
EXPORT_FAST=""

mark_done() {
  rm -f "$STATE_FILE"
  echo "$(date '+%Y-%m-%d %H:%M:%S') completed" > "${EXPORT_OUT}.done"
}

# Generate business CSV after export (same columns as json-to-csv-business.js).
generate_business_csv() {
  local csv_out="${EXPORT_OUT%.json}.business.csv"
  local jsonl_path="${EXPORT_OUT%.json}.jsonl"
  local input="$EXPORT_OUT"

  if [[ ! -f "$input" ]] && [[ ! -f "$jsonl_path" ]]; then
    echo "⚠️  Skip CSV: no JSON/JSONL at $EXPORT_OUT"
    return 0
  fi

  if [[ ! -f "$input" ]]; then
    input="$jsonl_path"
  elif [[ -f "$jsonl_path" ]]; then
    local json_bytes
    json_bytes=$(stat -f '%z' "$input" 2>/dev/null || stat -c '%s' "$input" 2>/dev/null || echo 0)
    # Large dataset JSON: stream from JSONL to avoid loading entire file in Node.
    if [[ "$json_bytes" -gt 31457280 ]]; then
      echo "[csv] Large JSON (~$((json_bytes / 1048576))MB), using JSONL for CSV generation"
      input="$jsonl_path"
    fi
  fi

  echo "Generating business CSV..."
  cd "$SCRIPT_ROOT"
  set +e
  node scripts/json-to-csv-business.js --in="$input" --out="$csv_out" 2>&1
  local csv_code=$?
  set -e
  if [[ $csv_code -eq 0 ]] && [[ -f "$csv_out" ]]; then
    echo "✅ CSV written: $csv_out"
    CSV_OUT="$csv_out" python3 -c "import json,os; print(json.dumps({'event':'export-csv-complete','csvPath':os.environ['CSV_OUT']}))"
  else
    echo "⚠️  CSV generation failed (exit $csv_code); JSON export is still at $EXPORT_OUT"
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --start=*)
      DATE_START="${1#*=}"
      shift
      ;;
    --end=*)
      DATE_END="${1#*=}"
      shift
      ;;
    --out=*)
      EXPORT_OUT="${1#*=}"
      shift
      ;;
    --keywords=*)
      EXPORT_KEYWORDS="${1#*=}"
      shift
      ;;
    --skip-date-validation)
      SKIP_DATE_VALIDATION="--skip-date-validation"
      shift
      ;;
    --paced)
      EXPORT_PACED="--paced"
      shift
      ;;
    --no-paced)
      EXPORT_PACED="--no-paced"
      shift
      ;;
    --retry-failed)
      RETRY_FAILED="--retry-failed"
      shift
      ;;
    --fast)
      EXPORT_FAST="--fast"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$DATE_START" ]] || [[ -z "$DATE_END" ]]; then
  echo "Usage: $0 --start=YYYY-MM-DD --end=YYYY-MM-DD [--out=path] [--keywords=...] [--skip-date-validation] [--retry-failed] [--fast]"
  exit 1
fi

if [[ -z "$EXPORT_OUT" ]]; then
  EXPORT_BASE="${CHAT_AUDIT_EXPORT_DIR:-$CALLER_CWD/exports}"
  EXPORT_OUT="$EXPORT_BASE/chat-audit-${DATE_START}.json"
else
  # Resolve relative paths from the caller's workspace, not the skill install dir.
  if [[ "$EXPORT_OUT" != /* ]]; then
    EXPORT_OUT="$CALLER_CWD/$EXPORT_OUT"
  fi
fi

if [[ -n "$SKILL_DIR" ]]; then
  case "$EXPORT_OUT" in
    "$SKILL_DIR"/*)
      echo "Error: refusing to write export artifacts inside the skill directory."
      echo "Output path: $EXPORT_OUT"
      echo "Skill path: $SKILL_DIR"
      echo "Run from a project/workspace directory, pass --out=/path/to/exports/file.json,"
      echo "or set CHAT_AUDIT_EXPORT_DIR=/path/to/exports."
      exit 1
      ;;
  esac
fi

# Ensure export artifact dir
mkdir -p "$(dirname "$EXPORT_OUT")"

# ------------------------------------------------------------------
# Helper functions
# ------------------------------------------------------------------

clear_state() {
  rm -f "$STATE_FILE"
}

get_retry_count() {
  local error_id="$1"
  if [[ -f "$STATE_FILE" ]]; then
    python3 -c "
import json
state = json.load(open('$STATE_FILE'))
counts = state.get('error_counts', {})
print(counts.get('$error_id', 0))
" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

increment_retry() {
  local error_id="$1"
  python3 -c "
import json, os
state_file = '$STATE_FILE'
state = {}
if os.path.exists(state_file):
    state = json.load(open(state_file))
error_counts = state.get('error_counts', {})
last_error = state.get('last_error_type', '')
if last_error != '$error_id':
    error_counts = {}
    last_error = '$error_id'
error_counts['$error_id'] = error_counts.get('$error_id', 0) + 1
state = {'error_counts': error_counts, 'last_error_type': last_error}
json.dump(state, open(state_file, 'w'))
print(error_counts['$error_id'])
" 2>/dev/null
}

detect_error_type() {
  local error_msg="$1"
  # Same human handling as CRM gate-wecom / WxworkLoginRequiredError — never CDP-restart self-heal.
  if echo "$error_msg" | grep -q "企业微信登录会话已过期"; then
    echo "WXWORK_LOGIN_EXPIRED"
  elif echo "$error_msg" | grep -q "请在本机 Chrome.*企业微信\|未检测到企业微信消息区"; then
    echo "WXWORK_LOGIN_EXPIRED"
  elif echo "$error_msg" | grep -q "CDP\|No page target\|target not found\|pageClient.evaluate"; then
    echo "CDP_NO_TARGET"
  elif echo "$error_msg" | grep -q "RATE_LIMITED\|请求过于频繁\|操作过于频繁\|访问过于频繁\|请稍后再试"; then
    echo "RATE_LIMITED"
  elif echo "$error_msg" | grep -q "cascader\|级联选择器\|el-cascader__dropdown"; then
    echo "CASCADER_STUCK_OPEN"
  elif echo "$error_msg" | grep -q "date.*picker\|picker.*date\|日期选择器"; then
    echo "DATE_PICKER_STUCK"
  elif echo "$error_msg" | grep -q "crash\|navigation\|net::"; then
    echo "EXPORT_PAGE_CRASH"
  elif echo "$error_msg" | grep -q "ENOENT\|no such file\|ENOENT"; then
    echo "PATH_ERROR"
  else
    echo "UNKNOWN"
  fi
}

diagnose_state_json() {
  cd "$SCRIPT_ROOT"
  python3 scripts/crm-preflight.py diagnose-state \
    --cdp "${CHAT_AUDIT_CRM_CDP_BASE%/}" \
    --expect-dept "$EXPECT_DEPT" \
    --expect-date "$DATE_START" 2>/dev/null || true
}

diagnose_state_name() {
  diagnose_state_json | python3 -c "import json,sys; data=sys.stdin.read().strip(); print(json.loads(data).get('state','UNKNOWN_BLOCKED') if data else 'UNKNOWN_BLOCKED')" 2>/dev/null || echo "UNKNOWN_BLOCKED"
}

self_heal_cdp() {
  # When CDP HTTP is up: only tab-level recovery (never pkill / never restart Chrome).
  if chat_audit_cdp_probe; then
    echo "[self-heal] CDP endpoint up — reopening audit page (no Chrome restart)."
    cd "$SCRIPT_ROOT"
    python3 scripts/crm-preflight.py navigate-audit --cdp "${CHAT_AUDIT_CRM_CDP_BASE%/}" || return 1
    sleep 3
    return 0
  fi
  echo "[self-heal] CDP endpoint down — cold-start Chrome (no pkill)."
  chat_audit_cold_start_chrome
}

self_heal_cascader() {
  echo "[self-heal] Attempting to close cascader dropdown..."
  cd "$SCRIPT_ROOT"
  python3 -c "
import asyncio, urllib.request, json
async def main():
    with urllib.request.urlopen('http://localhost:9222/json/list') as r:
        targets = json.loads(r.read())
    page = next((t for t in targets if t['type'] == 'page' and 'chatAudit' in t.get('url','')), None)
    if not page:
        print('no page')
        return
    ws_url = page['webSocketDebuggerUrl']
    import websockets
    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({'id': 1, 'method': 'Runtime.enable'}))
        await ws.recv()
        js_expr = '(function(){ var d=document.querySelector('.el-cascader__dropdown'); if(d){d.remove();return 'removed';} return 'not found';})()'.replace(\"'\", '\\\\'')
        msg = json.dumps({'id': 2, 'method': 'Runtime.evaluate', 'params': {'expression': js_expr, 'returnByValue': True}})
        await ws.send(msg)
        resp = json.loads(await ws.recv())
        print(resp.get('result', {}).get('result', {}).get('value', 'error'))
asyncio.run(main())
" 2>&1 | tail -1
}

self_heal_page_reload() {
  echo "[self-heal] Reloading CRM page and re-applying filters..."
  cd "$SCRIPT_ROOT"
  python3 scripts/crm-preflight.py navigate-audit 2>&1 | head -3
  sleep 5
  python3 scripts/crm-preflight.py set-department --group "$EXPECT_DEPT" 2>&1 | head -3
  python3 scripts/crm-preflight.py set-dates --date "$DATE_START" 2>&1 | head -3
}

summarize_and_exit() {
  local error_type="$1"
  local error_msg="$2"
  local attempt_count="$3"

  echo ""
  echo "========================================"
  echo "Task aborted after $attempt_count attempts"
  echo "Error type: $error_type"
  echo "Error: $error_msg"
  echo "========================================"
  echo ""
  echo "Known blocking patterns that require human intervention:"
  echo "  - 企业微信登录会话已过期: keep CRM open, extract the embedded QR with scripts/refresh-wecom-qr.py"
  echo ""
  echo "Known self-healable patterns (retry may help):"
  echo "  - CDP_NO_TARGET: missing CDP page target (tab reopen / cold start only; Chrome is not killed when CDP is up)"
  echo "  - CASCADER_STUCK_OPEN: Cascader dropdown stuck open"
  echo "  - EXPORT_PAGE_CRASH: CRM page crashed"
  echo ""
  echo "To clear retry state and start fresh:"
  echo "  rm -f $STATE_FILE"

  # Write经验教训 to knowledge base
  local timestamp=$(date '+%Y-%m-%d')
  local doc_base="${SKILL_DIR:-$SCRIPT_ROOT}"
  local doc_path="$doc_base/../docs/solutions/integration-issues/chat-audit-self-iter-${timestamp}.md"
  mkdir -p "$(dirname "$doc_path")"
  cat > "$doc_path" << EOF
---
title: Chat Audit Export 自我迭代失败记录
date: $timestamp
tags: [chat-audit-export, self-iteration, blocking-error]
---

## 错误摘要

- **错误类型**: $error_type
- **错误信息**: $error_msg
- **重试次数**: $attempt_count
- **日期**: $DATE_START ~ $DATE_END

## 自我迭代过程

Attempted self-heal but failed after $attempt_count retries.

## 经验教训

<!-- 填写经验教训 -->

## 相关文件

- Skill: ${SKILL_DIR:-not running from an installed skill directory}
- Self-heal script: $SCRIPT_DIR/self-heal.js
- State file: $STATE_FILE
EOF

  echo ""
  echo "经验教训已记录到: $doc_path"
  echo "请人工审查并补充经验后，重试任务。"

  # Clear state so next run starts fresh
  clear_state
  exit 1
}

# ------------------------------------------------------------------
# Main self-iteration loop
# ------------------------------------------------------------------

MAX_RETRIES=3
FAILED_RETRY_MAX=3
failed_retry_count=0
attempt=0

failed_count_from_output() {
  local output="$1"
  echo "$output" | grep -E '"event":"export-complete"|"event":"export-shutdown"' | tail -1 | python3 -c "
import json, sys
line = sys.stdin.read().strip()
if not line:
    print(0)
else:
    try:
        d = json.loads(line)
        print(int(d.get('failed', 0) or 0))
    except Exception:
        print(0)
" 2>/dev/null || echo "0"
}

count_failed_conversations() {
  if [[ ! -f "$EXPORT_OUT" ]]; then
    echo "0"
    return
  fi
  EXPORT_OUT="$EXPORT_OUT" python3 -c "
import json, os
d=json.load(open(os.environ['EXPORT_OUT']))
print(len(d.get('progress',{}).get('failed_conversation_ids',[])))
" 2>/dev/null || echo "0"
}

# Returns 0 if another failed-list retry pass was scheduled (caller should continue loop).
maybe_schedule_failed_retry() {
  local output="${1:-}"
  local failed_count
  if [[ -n "$output" ]]; then
    failed_count=$(failed_count_from_output "$output")
  fi
  if [[ -z "${failed_count:-}" ]] || [[ "${failed_count:-0}" -eq 0 ]]; then
    failed_count=$(count_failed_conversations)
  fi
  if [[ "${failed_count:-0}" -le 0 ]]; then
    return 1
  fi
  if [[ "$failed_retry_count" -ge "$FAILED_RETRY_MAX" ]]; then
    echo "⚠️  ${failed_count} conversation(s) still failed after ${FAILED_RETRY_MAX} failed-list retry pass(es)."
    return 1
  fi
  failed_retry_count=$((failed_retry_count + 1))
  echo "⚠️  ${failed_count} conversation(s) failed; scheduling failed-list retry ${failed_retry_count}/${FAILED_RETRY_MAX}..."
  RETRY_FAILED="--retry-failed"
  EXPORT_FAST="--fast"
  return 0
}

# Attach-first: if debugger is down, cold-start once; never kill a healthy Chrome here.
if ! chat_audit_cdp_probe; then
  chat_audit_cold_start_chrome || {
    echo "ERROR: could not reach or start Chrome CDP (${CHAT_AUDIT_CRM_CDP_BASE})."
    exit 1
  }
fi
cd "$SCRIPT_ROOT"
# Export starts from the employee list. WeCom message iframe is only required
# after a concrete customer is selected inside the dialog.
if ! python3 scripts/crm-preflight.py gate-start-export \
  --cdp "${CHAT_AUDIT_CRM_CDP_BASE%/}" \
  --expect-dept "$EXPECT_DEPT" \
  --expect-date "$DATE_START"; then
  exit $?
fi

while true; do
  attempt=$((attempt + 1))
  if [[ "$attempt" -gt "$MAX_LOOP" ]]; then
    echo "ERROR: exceeded max loop iterations ($MAX_LOOP)"
    exit 1
  fi
  echo ""
  if [[ -n "$RETRY_FAILED" ]]; then
    echo "========== Retry failed conversations (${failed_retry_count}/${FAILED_RETRY_MAX}, loop $attempt) =========="
  else
    echo "========== Export attempt $attempt (self-heal max $MAX_RETRIES per error type) =========="
  fi
  echo "Date: $DATE_START ~ $DATE_END"
  echo "Output: $EXPORT_OUT"
  echo ""

  # Run export — ensure we're in the script root so "scripts/export-date-range.js" resolves
  # 勿用 output=$(node ...)：会缓冲到 node 结束，Electron/UI 无法实时看到 export-progress
  cd "$SCRIPT_ROOT"
  tmp_out=$(mktemp "${TMPDIR:-/tmp}/chat-audit-export.XXXXXX")
  set +e
  node scripts/export-date-range.js \
    --start="$DATE_START" \
    --end="$DATE_END" \
    --out="$EXPORT_OUT" \
    ${EXPORT_KEYWORDS+--keywords=$EXPORT_KEYWORDS} \
    $EXPORT_PACED \
    $SKIP_DATE_VALIDATION \
    $RETRY_FAILED \
    $EXPORT_FAST 2>&1 | tee "$tmp_out"
  exit_code=${PIPESTATUS[0]}
  set -e
  output=$(cat "$tmp_out")
  rm -f "$tmp_out"

  if [[ $exit_code -eq 0 ]]; then
    echo ""
    echo "✅ Export completed successfully!"
    clear_state
    if maybe_schedule_failed_retry "$output"; then
      continue
    fi
    generate_business_csv
    mark_done
    exit 0
  fi

  # Extract error message — ONLY from export-error JSON lines.
  error_msg=$(echo "$output" | grep '"event":"export-error"' | head -1 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('message',''))" 2>/dev/null)

  if [[ -z "$error_msg" ]]; then
    echo ""
    echo "⚠️  Export exited with code $exit_code but no export-error event."
    echo "    Checkpoint / JSONL preserved — click Start again to resume from checkpoint."
    clear_state
    exit 1
  fi

  echo "Export failed: $error_msg"

  error_type=$(detect_error_type "$error_msg")
  page_state=$(diagnose_state_name)
  echo "Diagnosed page state: $page_state"
  case "$page_state" in
    CUSTOMER_SELECTED_WECHAT_LOGIN_REQUIRED)
      error_type="WXWORK_LOGIN_EXPIRED"
      ;;
    AUDIT_PAGE_WRONG_FILTERS)
      error_type="EXPORT_PAGE_CRASH"
      ;;
    CRM_LOGIN_REQUIRED)
      error_type="CRM_LOGIN_REQUIRED"
      ;;
  esac
  echo "Detected error type: $error_type"

  # Check if retry count exceeded
  retry_count=$(increment_retry "$error_type")
  echo "Retry count for $error_type: $retry_count/$MAX_RETRIES"

  if [[ "$error_type" == "WXWORK_LOGIN_EXPIRED" ]]; then
    # Non-self-healable — require human intervention
    echo ""
    echo "⚠️  企业微信登录会话已过期，需要你重新扫码登录。"
    echo "请保留 CRM 页面，通过 CRM 内嵌企微二维码扫码；不要打开或跳转企业微信独立页面。"
    echo "若需要二维码图片，请先保留出错客户弹窗，再运行：python3 scripts/refresh-wecom-qr.py"
    clear_state
    exit 1
  fi

  if [[ "$error_type" == "CRM_LOGIN_REQUIRED" ]]; then
    echo ""
    echo "⚠️  CRM 登录已失效，需要先登录探马 CRM。"
    clear_state
    exit 1
  fi

  if [[ "$error_type" == "RATE_LIMITED" ]]; then
    echo ""
    echo "⚠️  页面提示请求过于频繁，已保留 JSONL/checkpoint。请稍后从断点继续。"
    clear_state
    exit 1
  fi

  if [[ $retry_count -ge $MAX_RETRIES ]]; then
    summarize_and_exit "$error_type" "$error_msg" "$retry_count"
  fi

  # Attempt self-heal based on error type
  heal_ok=false
  case $error_type in
    CDP_NO_TARGET)
      self_heal_cdp && heal_ok=true
      ;;
    CASCADER_STUCK_OPEN)
      self_heal_cascader && heal_ok=true
      ;;
    EXPORT_PAGE_CRASH)
      self_heal_page_reload && heal_ok=true
      ;;
    DATE_PICKER_STUCK)
      # Date picker stuck is usually harmless, just retry
      heal_ok=true
      ;;
    *)
      echo "[self-heal] No self-heal action for $error_type, retrying..."
      heal_ok=true
      ;;
  esac

  if $heal_ok; then
    echo "[self-heal] Self-heal successful, retrying... ($((attempt))/$MAX_RETRIES)"
  else
    echo "[self-heal] Self-heal failed, retrying... ($((attempt))/$MAX_RETRIES)"
  fi

  sleep 2
done
