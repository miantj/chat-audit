# `crm-preflight.py` command reference

Run from skill root. Requires `pip install -r scripts/requirements-preflight.txt`.

| Command | Purpose |
|--------|---------|
| `check-page` | URL, title, `STATUS:` login / chat audit / other |
| `navigate-login` | Open CRM root in the active Chrome tab |
| `navigate-audit` | Open chat audit hash route |
| `fill-login --username U --password P` | Fill login form (credentials from user only) |
| `screenshot-captcha --out exports/captcha.png` | Full-page PNG for user to read |
| `submit-captcha --code CODE` | Fill 验证码 + click 登录 |
| `check-dates` | Print `.el-date-editor--daterange` values |
| `set-dates --date YYYY-MM-DD` | Vue `$emit('input', [d,d])` for that calendar day |
| `check-department` | Print cascader tags JSON |
| `set-department --group '大客私域顾问-总'` | Open cascader; check only if unchecked |
| `gate-check --expect-dept '…' [--expect-date YYYY-MM-DD]` | Exit 0 only if UI matches |
| `diagnose-state` | Print structured CRM/chat-audit state (`AUDIT_EMPLOYEE_LIST_READY`, `CUSTOMER_SELECTED_WECHAT_LOGIN_REQUIRED`, etc.) |
| `gate-start-export` | Exit 0 when the employee list has the expected department/date/rows; does not require WeCom iframe |
| `gate-wecom` | Customer-level check after selecting a customer; employee list pages do not require `ww-open-data-frame` |

Date rule: do **not** set daterange via raw `input.value` — Vue 2 v-model ignores it; always use `set-dates` (Vue emit path).
