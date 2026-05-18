# Chrome remote debugging for chat-audit export

Read this when Chrome is not on the debugger port or the Agent needs to start a debug profile.

## Long-lived session (attach-first)

Automation **prefers attaching** to Chrome that is already listening on the CDP HTTP port (default **9222**). Start debug Chrome **once per day** (or per machine session) and leave that window running across exports. Scripts **do not** `pkill` or restart Chrome when the debugger is reachable — only tab-level recovery (e.g. reopen the audit URL) runs so **企业微信** login state in the process is preserved.

- **Closing a CRM tab** is OK; `navigate-audit` / export can reopen the page in the **same** Chrome.
- **Quitting the entire debug Chrome window** can drop fragile WeCom session state — avoid during a batch of exports.

Shared probe / cold-start (no pkill): `scripts/cdp-probe.sh` is sourced by `export-with-self-heal.sh`. Env: `CHAT_AUDIT_CRM_CDP_BASE` (default `http://localhost:9222`), same as `crm-preflight.py`.

## Start Chrome (macOS)

Uses a **persistent profile** at `~/.chrome-chat-audit-profile` so cookies/sessions (WeChat Work login, CRM login) survive restarts.

**Does not kill your daily-use Chrome** — starts (or reuses) a **separate** debug instance. Cold start runs **only** when the CDP HTTP endpoint is **not** responding; there is **no** `pkill` in that path.

```bash
# Attach-first: skip launch when the debugger is already up
if curl -sf "${CHAT_AUDIT_CRM_CDP_BASE:-http://localhost:9222}/json/version" 2>/dev/null | grep -qi chrome; then
  echo "Chrome CDP already up — reuse this instance; do not start another."
else
  nohup /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --remote-debugging-port=9222 \
    --user-data-dir=$HOME/.chrome-chat-audit-profile \
    --new-window \
    > /tmp/chrome-debug.log 2>&1 &
  sleep 6
fi
```

> **Why persistent?** Previously used `/tmp/chrome-debug-profile` which gets wiped on reboot.
> The persistent profile keeps CRM + WeChat Work login sessions, so you don't need to re-login.

## Reset profile (if login state gets corrupted)

```bash
rm -rf ~/.chrome-chat-audit-profile
mkdir ~/.chrome-chat-audit-profile
```

Confirm `ws://127.0.0.1:9222` appears in `/tmp/chrome-debug.log`.

## Optional: page URL/title via browser-use

If `browser-use` is installed, you can still use it for ad-hoc navigation; **preflight and filters** should use `scripts/crm-preflight.py` so behavior stays consistent.

```bash
pip install -r scripts/requirements-preflight.txt
```

Override CDP base: `CHAT_AUDIT_CRM_CDP_BASE` or `python3 scripts/crm-preflight.py --cdp http://127.0.0.1:9222 ...`.
