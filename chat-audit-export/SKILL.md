---
name: chat-audit-export
description: Export WeChat chat audit conversations from the 一手 clothing wholesale CRM (tmscrm.yishouapp.com) for a date range. Use when asked to export, scrape, or download chat records, conversation history, or audit data from the CRM. Login may require a captcha or SMS code; prompt the user to read it and send the code to the Agent for fill/submit.
compatibility: Requires Node.js 22+, Chrome with --remote-debugging-port=9222, Python 3 with websockets (`pip install -r scripts/requirements-preflight.txt`). Optional browser-use for ad-hoc navigation only.
metadata:
  source: tanmark-session
  version: "2.5"
---

> This document serves as both the OpenClaw skill definition and a generic README.
> The core scripts (Python, JS, shell) are fully decoupled and can be used by any AI agent
> (Claude Code, Cursor, OpenClaw, etc.) that can execute CLI tools and interact with Chrome CDP.

## Background

一手 is a clothing wholesale platform. CS talks to shop owners on WeChat. The CRM **chat audit** page only shows one conversation at a time; this skill drives **bulk export** via Chrome CDP + Node.

**Domain model:** Employee (main table row) → effective metric customer IDs (`总有效跟进好友数（人天）`, `总有效咨询好友数（人天）`) → searched external friend → Conversation (messages in `ww-open-data-frame` iframe). With `--all-customers` / `--no-effective-filter`, the exporter instead walks every `沟通内容` / `外部好友` entry for each employee. With `--targets-file`, it reads Excel/CSV `负责人` + `外部客户ID` pairs, matches owners by normalized exact name, skips metric discovery, and searches only the listed customer IDs. **Direction:** `left` / customer → `role: "customer"`; `right` / employee → `role: "official"`.

**Dataset shape** (one object per conversation): `conversation_id`, `employee_name`, `customer_name`, `started_at`, `ended_at`, `message_count`, `messages[]` (with `attachments`, `meta`), `source_meta`. Message export is date-bounded: after selecting a customer, the script scrolls the message area forward until it reaches the first message after the requested date range, then saves only messages inside the range. `source_meta` records the message date bounds, filtered count, observed count, and scroll stop reason. Export artifacts belong in the caller's workspace `exports/` directory, not in the skill install directory.

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 22+ | Export scripts (JS) |
| Python | 3.10+ | Preflight & CDP interaction |
| Chrome | any | Debug browser via CDP on port 9222 |
| `websockets` (Python) | — | `pip install -r scripts/requirements-preflight.txt` |

## Security (credentials)

- **Never** hardcode CRM username/password in commands, docs, or public reports.
- **Never** write export artifacts into the skill install directory. Use the caller's workspace `exports/`, `CHAT_AUDIT_EXPORT_DIR`, or an explicit `--out` path.
- **Ask the user** for username and password when on the login page; pass them **once** to the preflight script:  
  `python3 scripts/crm-preflight.py fill-login --username '...' --password '...'`  
  Optional one-shot env for the same shell only: `CHAT_AUDIT_CRM_USERNAME`, `CHAT_AUDIT_CRM_PASSWORD`.
- Do **not** echo passwords in export JSON, logs, or summaries.

## Scripts

| Script | Role |
|--------|------|
| `scripts/crm-preflight.py` | CDP: login, dates, department, **diagnose-state**, **gate-start-export**, **gate-check**, **gate-wecom** (subcommands) |
| `scripts/lib/cdp-bootstrap.mjs` | CDP URL probe + cold-start Chrome (no pkill); used by `export-with-self-heal.mjs` |
| `scripts/export-date-range.js` | Bulk export for `--start` / `--end` |
| `scripts/export-target-list-by-day.mjs` | Target-list date range export, one CRM search date per day |
| `scripts/merge-daily-exports.js` | Merge daily target-list JSON/JSONL files locally |
| `scripts/parse-target-list.py` | Excel/CSV target-list parser for `--targets-file` |
| `scripts/reconcile.js` | JSONL → deduped dataset JSON |
| `scripts/json-to-csv-business.js` | Business CSV + `transcript` column; can split by message date |
| `scripts/json-to-llm-chunks.js` | Local JSON/JSONL post-processing into LLM-friendly JSONL chunks |

Preflight deps: `pip install -r scripts/requirements-preflight.txt`.

**Further detail:** [references/cdp-preflight.md](references/cdp-preflight.md) · [references/chrome-cdp.md](references/chrome-cdp.md) · [references/troubleshooting.md](references/troubleshooting.md)

## Workflow

> **MANDATORY:** Complete Steps 1–3 and **Gate Check** before export. Starting export requires the CRM employee list to be ready; the WeCom message iframe is checked **after** a concrete customer is selected, because it is not reliable on the employee list page.

Progress:

- [ ] Step 1: **One long-lived** debug Chrome on CDP port (default 9222) + CRM logged in — keep this Chrome open across exports; do not rely on scripts restarting the browser
- [ ] Step 2: Date range on main table matches export day(s)
- [ ] Step 3: Department cascader = **大客私域顾问-总** (or user-chosen `--expect-dept`)
- [ ] Gate: `gate-check` exit 0
- [ ] Gate Start: `gate-start-export` exit 0 (or use `export-with-self-heal.mjs`, which runs it for you)
- [ ] Step 4: `export-with-self-heal.mjs` (self-iteration enabled) or plain `export-date-range.js`
- [ ] Step 5 (optional): `reconcile.js`
- [ ] Step 5b (optional): `json-to-csv-business.js`
- [ ] Step 6: Generate report ([references/report-template.md](references/report-template.md))
- [ ] Step 7: Leave the debug Chrome open for the next export. Do **not** close, quit, Ctrl-C, or otherwise stop the browser after a successful run; only close script/CDP websocket connections.

Work from a writable task/project workspace, not from the skill install directory. In this development repo the tracked `scripts/` directory is at the workspace root, so paths below assume `cd` to that workspace:

```bash
cd /path/to/chat-audit-export
```

If the skill is installed elsewhere, invoke the installed scripts by absolute path from the task workspace, or set `CHAT_AUDIT_EXPORT_DIR` / pass `--out` to a workspace-owned directory. The scripts refuse to write output inside a detected skill directory.

### Step 1 — Chrome + login

1. Start Chrome with `--remote-debugging-port=9222` once per session — see [references/chrome-cdp.md](references/chrome-cdp.md). If the port already answers CDP, **reuse** that Chrome; do not start a second debug instance.
2. `python3 scripts/crm-preflight.py check-page` — expect `STATUS: on chat audit page` to jump to Step 2, or `on login page` to continue here.
3. If login: `navigate-login` if the tab is not on CRM, then **ask the user** for username and password → `fill-login --username '…' --password '…'`.
4. Captcha: user sends code in chat → `submit-captcha --code '…'` (optional `screenshot-captcha` first). On failure, new code or manual login + **「已登录」**.
5. `python3 scripts/crm-preflight.py navigate-audit` then `check-page` should show chat audit.

### Step 2 — Department cascader (check before change)

**Set department FIRST, then date.** Setting the date picker triggers a page update that resets the cascader if done in reverse order.

Cascader checkbox is a **toggle** — do not click if already selected.

```bash
python3 scripts/crm-preflight.py check-department
# If tags already include 大客私域顾问-总, skip set.
python3 scripts/crm-preflight.py set-department --group '大客私域顾问-总'
```

### Step 3 — Date range (check before change)

**Only the outer date picker (next to the department selector) needs to be set.** The dialog's date picker syncs automatically from the outer picker's value — do NOT set the dialog date picker separately.

**Date gate:** all employee/customer dialogs must be closed before setting the date. `set-dates` fails if a visible dialog is open, because otherwise it may click the dialog date picker instead of the main table date picker.

Use simulated clicks (not Vue `$emit`) to set the date — this is more reliable and mirrors real user interaction.

```bash
python3 scripts/crm-preflight.py check-dates
# If both inputs already match the target day, skip set.
python3 scripts/crm-preflight.py set-dates --date YYYY-MM-DD
```

Wait 3–5s for the table to reload.

### Gate check (required)

```bash
python3 scripts/crm-preflight.py gate-check \
  --expect-dept '大客私域顾问-总' \
  --expect-date YYYY-MM-DD
```

Exit code **0** = proceed. Non-zero → fix Step 2/3 and repeat.

### Start gate (required before export)

Ensures the CRM is on the employee list with the expected main-table filters. It does **not** require `ww-open-data-frame`; the message iframe usually appears only after selecting a customer inside an employee dialog.

```bash
python3 scripts/crm-preflight.py gate-start-export \
  --expect-dept '大客私域顾问-总' \
  --expect-date YYYY-MM-DD
```

Use `diagnose-state` when a run gets stuck; it reports states like `AUDIT_EMPLOYEE_LIST_READY`, `METRIC_TABLE_OPEN`, `CUSTOMER_SELECTED_WECHAT_LOGIN_REQUIRED`, and `CUSTOMER_SELECTED_MESSAGE_READY`.

```bash
python3 scripts/crm-preflight.py diagnose-state \
  --expect-dept '大客私域顾问-总' \
  --expect-date YYYY-MM-DD
```

`gate-wecom` is now a customer-level check. It is meaningful after a customer has been selected; on the employee list page it may pass with “not required yet”.

### Step 4 — Export (with self-iteration)

**Preferred:** Use `export-with-self-heal.mjs` for automatic retry and self-recovery.

```bash
node scripts/export-with-self-heal.mjs \
  --start=YYYY-MM-DD \
  --end=YYYY-MM-DD \
  --keywords= \
  --max=2000 \
  --skip-date-validation
```

Use a larger `--max` for true all-customer exports; the default is 2000 conversations.

For Excel/CSV target-list exports, use `--targets-file`. The file must contain
`负责人` and `外部客户ID` columns. `.xlsx` reads the first sheet unless
`--targets-sheet=Sheet1` is provided. Owner matching is normalized exact
matching: whitespace is ignored, but substring matching is not used.

For target-list ranges longer than one day, **prefer the daily runner**. The CRM
external-friend search is scoped by the main table date; if the page date is
May 1, a customer who only chatted on May 2 may not appear in search. The daily
runner sets the CRM date separately for each day, scans that day's visible
external-friend list, intersects it with the target list, exports only matched
customers, and merges the daily outputs locally. This avoids waiting on hundreds
of target customers who simply did not chat on that specific day.

```bash
node scripts/export-target-list-by-day.mjs \
  --start=2026-05-01 \
  --end=2026-05-31 \
  --targets-file=/path/to/list.xlsx \
  --out-dir=exports/target-list-by-day-2026-05 \
  --basename=chat-audit-target-list-2026-05 \
  --max=20000 \
  --fast-paced
```

If the old one-ID-at-a-time search behavior is needed, pass
`--target-list-strategy=search`; the default is `visible`.

Merged outputs:

```text
exports/target-list-by-day-2026-05/chat-audit-target-list-2026-05-merged.json
exports/target-list-by-day-2026-05/chat-audit-target-list-2026-05-merged.jsonl
```

The merge combines messages from the same `客服 + 客户ID` across days. It also
keeps `progress.failed_daily_conversation_ids` with `__date_YYYY-MM-DD` suffixes,
so a customer that failed on one day but succeeded on another is not treated as
a final month-level failure.

```bash
node scripts/export-with-self-heal.mjs \
  --start=YYYY-MM-DD \
  --end=YYYY-MM-DD \
  --targets-file=/path/to/list.xlsx \
  --max=2000 \
  --skip-date-validation
```

Default output when `--out` is omitted:

```text
effective customers: $PWD/exports/chat-audit-YYYY-MM-DD.json
all customers:       $PWD/exports/chat-audit-all-customers-YYYY-MM-DD.json
```

Output resolution order:

1. `--out=/absolute/or/relative/file.json`
2. `OUTPUT_PATH=/absolute/or/relative/file.json`
3. `CHAT_AUDIT_EXPORT_DIR=/path/to/exports`
4. `$PWD/exports/chat-audit-YYYY-MM-DD.json` for effective-customer exports, or `$PWD/exports/chat-audit-all-customers-YYYY-MM-DD.json` for all-customer exports

Relative `--out` paths resolve from the caller's current workspace. Do not use a path inside `.agents/skills/chat-audit-export`, `$CODEX_HOME/skills/chat-audit-export`, or any installed skill directory.

The wrapper script:
1. Ensures CDP is reachable (cold-starts Chrome **only** if the debugger HTTP port is down; **no** `pkill`)
2. Runs **`gate-start-export`** before the first export attempt
3. Diagnoses page state on failure before choosing recovery
4. Detects blocking error type from `export-error` output and diagnosed state
5. Attempts self-heal (tab reopen / cascader cleanup / page reload — **not** killing Chrome when CDP is up) for self-healable errors
6. Retries up to 3 times for the same error type
7. Writes lesson notes to `docs/solutions/integration-issues/chat-audit-self-iter-YYYY-MM-DD.md` after 3 failures
8. For `WXWORK_LOGIN_EXPIRED` (selected customer shows WeCom login), stops immediately without CDP “restart” self-heal.

**Handling enterprise WeChat login expiry (WXWORK_LOGIN_EXPIRED):**
- **Never navigate to `work.weixin.qq.com`, `wxwork.com`, or any standalone WeCom login page.**
- Keep the CRM chat audit page open. The only valid login QR is the CRM-embedded `login.work.weixin.qq.com` iframe shown after a customer is selected.
- If the wrapper stops on the employee list, run the plain exporter with `CHAT_AUDIT_KEEP_DIALOG_OPEN_ON_ERROR=1` so the failing customer dialog remains open and exposes the embedded login iframe.
- Extract and send the embedded QR image with `python3 scripts/refresh-wecom-qr.py`; do not send a screenshot of a standalone WeCom page.
- If the QR expires, run `python3 scripts/refresh-wecom-qr.py` again; it refreshes only the CRM-embedded iframe and writes a new QR PNG.
- When user confirms login, do not ask them to scan more QR codes. Close the dialog or navigate back to CRM, re-apply filters (department + date), run gate-check, then resume export.
- Check for `ww-open-data-frame` only after a customer is selected; employee list pages can show stale `login.work.weixin.qq.com` targets without meaning the export should stop.

**Plain export (no self-iteration):** run `gate-start-export` (and `gate-check`) first, same as the mandatory workflow.

```bash
python3 scripts/crm-preflight.py gate-start-export \
  --expect-dept '大客私域顾问-总' \
  --expect-date YYYY-MM-DD
node scripts/export-date-range.js \
  --start=YYYY-MM-DD \
  --end=YYYY-MM-DD \
  --max=2000 \
  --skip-date-validation
```

`--skip-date-validation`: dialog date filter may not match Vue-set main table; export still scopes by `--start`/`--end`.

**Paced export:** Full exports enable paced delays by default to reduce page pressure and protect checkpoint progress. Tiny samples (`--max=1 --max-rows=1`) run fast unless `--paced` is passed. Use `--fast-paced` for day-to-day bulk exports when you want a faster DOM-driven mode; it keeps the safer small-step message scrolling but waits for real DOM/message changes instead of long fixed sleeps. Use `--no-paced` only for short debugging. Tunables:

```bash
CUSTOMER_DELAY_MIN_MS=1000
CUSTOMER_DELAY_MAX_MS=3000
CUSTOMERS_PER_BATCH=10
EMPLOYEE_DELAY_MIN_MS=5000
EMPLOYEE_DELAY_MAX_MS=5000
BATCH_REST_MS=5000
SEARCH_RESULT_DELAY_MIN_MS=1500
SEARCH_RESULT_DELAY_MAX_MS=4000
SELECT_FRIEND_DELAY_MIN_MS=2000
SELECT_FRIEND_DELAY_MAX_MS=5000
MESSAGE_SCROLL_DELAY_MIN_MS=1500
MESSAGE_SCROLL_DELAY_MAX_MS=4000
FAST_DOM_POLL_INTERVAL_MS=150
FAST_SEARCH_READY_TIMEOUT_MS=4000
FAST_SELECT_READY_TIMEOUT_MS=5000
FAST_MESSAGE_DOM_CHANGE_TIMEOUT_MS=1200
```

Fast-paced defaults are shorter (`customer=300-800ms`, `employee=1000-1500ms`, `batch=20/1000ms`, `search=600-1200ms`, `select=900-1800ms`, `messageScroll=600-1200ms`) and may still be overridden by the environment variables above.

If the page shows `请求过于频繁` / similar frequency warnings, export stops with `RATE_LIMITED`, saves JSON/checkpoint, and should be resumed later from the same output path.

**Traversal behavior:** By default, the exporter does **not** walk every friend under `沟通内容`. For each employee dialog it:
1. Clicks `总有效跟进好友数（人天）`, paginates the metric table, and extracts customer IDs from `客户信息`.
2. Clicks `总有效咨询好友数（人天）`, paginates the metric table, and extracts customer IDs from `客户信息`.
3. Deduplicates customers by employee + customer ID while preserving both metric categories in metadata.
4. Switches back to `沟通内容` / `外部好友`, searches the customer ID, selects the exact matching result, then extracts the conversation using the existing iframe logic.

With `--targets-file`, the exporter skips metric categories and uses the
Excel/CSV list as the customer source. Each exported conversation records
`source_meta.source_metric_categories=["target_file"]`; `metric_rows` contains
the source file path, sheet, row number, owner, and customer ID. Owners in the
file that are not found in the CRM main table are logged as unmatched.

To export every customer instead, add `--all-customers` or `--no-effective-filter`. In that mode the exporter switches to `沟通内容` / `外部好友`, paginates the full friend list, clicks each friend, and records friend-page checkpoints instead of metric checkpoints.

**Message date boundary:** After a customer is selected, the exporter must keep scrolling the WeCom message iframe forward and collecting rendered messages until it sees a message later than `--end 23:59:59` (for single-day exports, the next day's first message). It then filters out messages outside `--start 00:00:00` through `--end 23:59:59` and moves to the next customer. If no later message is available, it stops at the end of the loaded conversation and records `source_meta.scroll_stop_reason=no_more_messages`. If the scroll guard is hit, it records `scroll_stop_reason=max_scrolls` and treats that conversation as incomplete.

Probe the metric selectors without exporting messages:

```bash
node scripts/export-date-range.js \
  --start=YYYY-MM-DD \
  --end=YYYY-MM-DD \
  --keywords= \
  --skip-date-validation \
  --dry-run-targets \
  --max-rows=1
```

Probe an Excel/CSV target list without exporting messages:

```bash
node scripts/export-date-range.js \
  --start=YYYY-MM-DD \
  --end=YYYY-MM-DD \
  --targets-file=/path/to/list.xlsx \
  --skip-date-validation \
  --dry-run-targets \
  --max-rows=2
```

**Stdout events:** `export-start`, `export-progress`, `export-complete`, `export-error` (JSON lines).

**Artifacts:** `.json`, `.jsonl`, `.checkpoint.json` next to the resolved output path.

**Options:** `--keywords=`, `--targets-file=`, `--targets-sheet=`, `--category=` (department text), `--max=`, `--all-customers`, `--no-effective-filter`, `--paced`, `--fast-paced`, `--no-paced`. Full flags: `node scripts/export-date-range.js --help`.

**Self-heal state file:** `/tmp/chat-audit-self-heal-state.json` — clear to start fresh.

### Step 5 — Reconcile (optional)

```bash
node scripts/reconcile.js \
  --in=./exports/chat-audit-YYYY-MM-DD.json \
  --jsonl=./exports/chat-audit-YYYY-MM-DD.jsonl \
  --checkpoint
```

### Step 5b — Business CSV (optional)

```bash
node scripts/json-to-csv-business.js --in=./exports/chat-audit-YYYY-MM-DD.json
# Large runs:
node scripts/json-to-csv-business.js --in=./exports/chat-audit-YYYY-MM-DD.jsonl --out=./exports/chat-audit-YYYY-MM-DD.business.csv
# Split a multi-day export into one CSV per message date:
node scripts/json-to-csv-business.js --in=./exports/chat-audit-YYYY-MM-DD-to-YYYY-MM-DD.json --split-by-day
```

### Step 5c — LLM chunks (optional)

Use this after the full JSON/JSONL export is complete. It is a local
post-processing step and does not reopen CRM.

```bash
node scripts/json-to-llm-chunks.js \
  --in=./exports/chat-audit-YYYY-MM-DD-to-YYYY-MM-DD.json \
  --by=day,employee \
  --max-conversations=50
```

### Step 6 — Report

Generate a summary from the export results. Template at [references/report-template.md](references/report-template.md).
Include date range, conversation counts, output paths, and any errors — **no secrets**.

### Step 7 — Keep Chrome open

After export, reconciliation, CSV generation, and reporting, **keep the long-lived debug Chrome running**. Do not run `osascript` to quit Chrome, do not Ctrl-C a foreground Chrome session, and do not kill Chrome-related processes as cleanup. The next date export should reuse the existing CDP browser/session so CRM and enterprise WeChat login state are preserved.

## Runtime control (during export)

The export scripts respect these file-based signals (any agent can use them):

| User message | Action |
|--------|--------|
| `暂停导出` / `客服接管` | `touch /tmp/chat-audit-export-pause` |
| `继续导出` / `恢复导出` | `rm /tmp/chat-audit-export-pause` |
| `停止导出` / `终止导出` | `kill -9 $(pgrep -f "export-date-range")` |
| `导出进度` / `进度` | checkpoint + `wc -l` on jsonl |

## Gotchas

- **验证码 / SMS:** Human-in-the-loop; user must paste/type code for `submit-captcha`.
- **CDP port:** Export + preflight use `9222` (override with `--cdp` / `CHAT_AUDIT_CRM_CDP_BASE`).
- **Date picker:** Use `crm-preflight.py set-dates` which uses simulated clicks (open picker → click target cell). The Vue `$emit` approach was replaced (2026-04-29) because it doesn't properly trigger UI state updates.
- **Close dialogs before date:** `set-dates` refuses to run while a visible dialog is open; close the employee/customer dialog first so only the main table date picker remains.
- **Department → Date order:** Always set department FIRST, then date. Setting date resets the cascader.
- **Cascader stuck open:** If cascader dropdown stays open after selection, it blocks row clicks. Self-heal removes it from DOM. Manual fix: `document.querySelector('.el-cascader__dropdown')?.remove()`.
- **Vue 3 CRM upgrade** breaks `__vue__` scraping in Node export — update export scripts if upgraded.
- **Dedup:** Same message fingerprint → conversation skipped on re-run.
- **Voice / video in iframe:** "转文字" click + poll; video as poster `img` — see Node export libs.
- **Self-iteration state:** `/tmp/chat-audit-self-heal-state.json` — clear if you want a fresh retry cycle.
- **企业微信登录过期处理:**
  - **永远不要**打开或跳转到企业微信独立页面（`work.weixin.qq.com` / `wxwork.com`）。
  - 必须停留在 CRM 聊天审计页，通过选中客户触发 CRM 内嵌的 `login.work.weixin.qq.com` iframe。
  - 用 `python3 scripts/refresh-wecom-qr.py` 从 CRM 内嵌 iframe 直接提取二维码图片并发给用户。
  - 如果二维码过期，继续运行同一个脚本刷新 CRM 内嵌 iframe；不要发企业微信独立登录页截图。
  - 用户确认已登录后，不要要求用户再次扫码；回到 CRM 员工列表、重新确认部门和日期筛选，重新跑导出。

**Errors, zombies, JSONL/checkpoint behavior:** [references/troubleshooting.md](references/troubleshooting.md)

## Self-Iteration (v2.4)

The `export-with-self-heal.mjs` wrapper adds automatic retry and self-improvement:

| Error type | Self-healable | Max retries |
|---|---|---|
| `WXWORK_LOGIN_EXPIRED` | ❌ Human required | — |
| `CDP_NO_TARGET` | ✅ Reopen audit tab / cold-start only if CDP is down; do not kill Chrome | 3 |
| `CASCADER_STUCK_OPEN` | ✅ Remove dropdown DOM | 3 |
| `EXPORT_PAGE_CRASH` | ✅ Reload + re-apply filters | 3 |
| `DATE_PICKER_STUCK` | ✅ Just retry | 3 |
| `UNKNOWN` | ⚠️ May retry | 2 |

After 3 consecutive failures of the same type, the script:
1. Writes lesson notes to `docs/solutions/integration-issues/chat-audit-self-iter-YYYY-MM-DD.md`
2. Exits with code 1 and a summary
3. Clears retry state so next run starts fresh

**Knowledge accumulation:** Failed runs generate `.md` files in `docs/solutions/integration-issues/` that capture error patterns, symptoms, and lessons learned. Review and expand these after each major incident.

## Script help

```bash
node scripts/export-date-range.js --help
node scripts/reconcile.js --help
node scripts/json-to-csv-business.js --help
node scripts/json-to-llm-chunks.js --help
python3 scripts/crm-preflight.py --help
```
