#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# cdp-probe.sh — Shared CDP reachability + cold-start Chrome for chat-audit-export
#
# Mirrors crm-preflight.py defaults: CHAT_AUDIT_CRM_CDP_BASE (default
# http://localhost:9222). Used by export-with-self-heal.sh so attach-first and
# cold-start logic stay consistent.
#
# Cold start does NOT pkill Chrome — only launches a debug instance when the
# debugger HTTP endpoint is unreachable (preserves WeCom / CRM session when
# Chrome is already running).
# ---------------------------------------------------------------------------

: "${CHAT_AUDIT_CRM_CDP_BASE:=http://localhost:9222}"
# Normalized base without trailing slash (safe for "${BASE}/json/version").
export CHAT_AUDIT_CRM_CDP_BASE
_CHAT_AUDIT_CDP_BASE="${CHAT_AUDIT_CRM_CDP_BASE%/}"

# Extract TCP port from CHAT_AUDIT_CRM_CDP_BASE for --remote-debugging-port (default 9222).
chat_audit_cdp_port() {
  if [[ "${_CHAT_AUDIT_CDP_BASE}" =~ :([0-9]+)(/|$) ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "9222"
  fi
}

# Returns 0 when Chrome exposes a JSON /json/version payload (CDP HTTP endpoint up).
chat_audit_cdp_probe() {
  curl -sf "${_CHAT_AUDIT_CDP_BASE}/json/version" 2>/dev/null | grep -qi chrome
}

# Start one debug Chrome with the persistent chat-audit profile; no pkill.
chat_audit_cold_start_chrome() {
  local port
  port="$(chat_audit_cdp_port)"
  echo "[cdp] No debugger at ${_CHAT_AUDIT_CDP_BASE}; starting Chrome (port ${port}, profile ~/.chrome-chat-audit-profile, no pkill)."
  # macOS: separate Chrome user-data-dir so daily Chrome is untouched.
  open -a "Google Chrome" --args "--remote-debugging-port=${port}" "--user-data-dir=${HOME}/.chrome-chat-audit-profile" 2>/dev/null &
  sleep 4
  if chat_audit_cdp_probe; then
    echo "[cdp] Chrome CDP is up."
    return 0
  fi
  echo "[cdp] Chrome CDP still not reachable after start." >&2
  return 1
}
