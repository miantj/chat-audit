# Chat audit export — troubleshooting and resilience

Use when `export-error` appears, gate-check fails, or runs stall.

## Login and captcha (human-in-the-loop)

- Ask the user to read the captcha (or SMS) and **send the code in chat**; then:
  - `python3 scripts/crm-preflight.py screenshot-captcha --out exports/captcha.png` (optional)
  - `python3 scripts/crm-preflight.py submit-captcha --code 'PASTED_CODE'`
- If login fails, captchas may have rotated — ask for a **new** code or have the user log in manually in Chrome and reply **「已登录」**, then continue from filters / gate-check.

## Resilience (export script)

- **JSONL append-only:** Each conversation is written as one JSONL line; crashes do not lose prior lines.
- **Checkpoint resume:** `{ employee_name, friend_page, friend_index, conversation_id }` — re-run with the same `--out` skips completed conversations.
- **Message stability:** Up to ~12 polls (1200ms) until two consecutive fingerprints match and no "消息内容正在加载" placeholder; otherwise the conversation is marked failed and the run continues.

## Error recovery (stdout `export-error` lines)

1. Read the `export-error` JSON line from stdout.
2. Match `message`:
   - **`企业微信登录会话已过期`** — WeChat Work session expired; the export **aborts immediately**. Never open or navigate to standalone WeCom pages (`work.weixin.qq.com` / `wxwork.com`). Keep the CRM chat audit page open, select/retain the failing customer so the embedded `login.work.weixin.qq.com` iframe appears, then run `python3 scripts/refresh-wecom-qr.py` and send the generated QR PNG to the user. Do NOT retry the export until the user confirms login.
   - **`chatAudit page target not found`** — Chrome not running, wrong tab, or still on login. Fix login (preflight), `navigate-audit`, then retry.
   - **`dialog filters mismatch`** — Page filters wrong; re-run `check-dates` / `set-dates` and `gate-check`.
   - **`message iframe target not found`** — Iframe slow or login expired; re-run is safe if login is confirmed (checkpoint skips completed work).
   - **`target not found`** / **`friend-missing`** — Transient UI; script often auto-skips; retry export.
3. For non-login errors, retry the **same** `node scripts/export-date-range.js ...` command up to **3** times.
4. If still failing, stop and report the issue to the user.
5. **Zombie Node processes:** `pgrep -fl export-date-range`; use `kill -9` if needed. Multiple processes on one CDP port corrupt dialogs.
6. **Pause / resume / stop:** See main SKILL control table (`/tmp/chat-audit-export-pause`, `kill -9`).

## UI / stack assumptions (for maintainers)

- Vue 2 + Element UI: export uses `__vue__` on table/dialog; Vue 3 upgrade breaks selectors.
- Dialog: `.el-dialog.v-chat-moadl` + text `沟通内容` / `客户详情` — see `scripts/export-current-page.js` (`visibleDialogExpr`).
- Iframe: `ww-open-data-frame`; message nodes `.qw-msg-wrap`, direction `.qw-msg-wrap-left` / `-right`.

## Deduplication

- Reconcile/upsert dedupes by `conversation_id` only. Do not dedupe across different customers by message fingerprint; distinct customers can have identical short conversations and must remain separate audit records.
