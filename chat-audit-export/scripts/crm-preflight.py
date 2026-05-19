#!/usr/bin/env python3
"""
CDP helpers for 一手 CRM (tmscrm.yishouapp.com) chat-audit preflight: login, filters, gate.
Uses Chrome remote debugging (default http://localhost:9222) and websockets — no browser-use required.

Security: never hardcode credentials; pass --username/--password from user-provided values only.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import urllib.parse
import urllib.request
from typing import Any, Optional

# Default Chrome remote debugging base (override with --cdp or CHAT_AUDIT_CDP_BASE).
DEFAULT_CDP = os.environ.get("CHAT_AUDIT_CRM_CDP_BASE", "http://localhost:9222")

CHAT_AUDIT_URL = "https://tmscrm.yishouapp.com"
CHAT_AUDIT_HASH = (
    "https://tmscrm.yishouapp.com/#/salesQuality/chatAudit"
    "?guideToOpenFlag=false&_tab_key=Employee"
)


def _list_targets(cdp_base: str) -> list[dict[str, Any]]:
    # Chrome exposes debuggable pages at /json (same host as --remote-debugging-port).
    url = cdp_base.rstrip("/") + "/json"
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode())


def _pick_page_target(targets: list[dict[str, Any]], prefer_tmscrm: bool) -> Optional[dict[str, Any]]:
    """Pick a page target: prefer tmscrm URL when requested, else first 'page' type."""
    pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
    if not pages:
        return None
    if prefer_tmscrm:
        for t in pages:
            if "tmscrm" in (t.get("url") or ""):
                return t
    return pages[0]


def _pick_preferred_crm_page(targets: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """优先已登录的 chatAudit 标签，避免误选 #/login 空白页。"""
    pages = [
        t
        for t in targets
        if t.get("type") == "page"
        and t.get("webSocketDebuggerUrl")
        and "tmscrm" in (t.get("url") or "")
    ]
    if not pages:
        return _pick_page_target(targets, prefer_tmscrm=True) or _pick_page_target(
            targets, prefer_tmscrm=False
        )

    def _score(t: dict[str, Any]) -> int:
        url = (t.get("url") or "").lower()
        score = 0
        if "chataudit" in url.replace("_", ""):
            score += 100
        if "/login" in url or url.endswith("#/login"):
            score -= 80
        return score

    pages.sort(key=_score, reverse=True)
    return pages[0]


def _ensure_page_target(cdp_base: str, open_url: str = CHAT_AUDIT_HASH) -> dict[str, Any]:
    """若 CDP 无 page 目标（例如用户关光了标签），用 PUT /json/new 打开 CRM。"""
    targets = _list_targets(cdp_base)
    page = _pick_preferred_crm_page(targets)
    if page:
        return page
    new_url = cdp_base.rstrip("/") + "/json/new?" + urllib.parse.quote(open_url, safe="")
    req = urllib.request.Request(new_url, method="PUT")
    with urllib.request.urlopen(req, timeout=15) as resp:
        created = json.loads(resp.read().decode())
    if not created.get("webSocketDebuggerUrl"):
        print("ERROR: PUT /json/new 未返回可调试的标签页", file=sys.stderr)
        raise SystemExit(1)
    return created


_ROW_COUNT_EXPR = (
    "document.querySelectorAll('.el-table__body-wrapper .el-table__row').length"
)


async def _pick_crm_page_with_rows(
    cdp_base: str, *, min_rows: int = 1
) -> Optional[dict[str, Any]]:
    """Pick the tmscrm tab that already has the most employee table rows (avoids empty new tabs)."""
    targets = _list_targets(cdp_base)
    pages = [
        t
        for t in targets
        if t.get("type") == "page"
        and t.get("webSocketDebuggerUrl")
        and "tmscrm" in (t.get("url") or "")
    ]
    if not pages:
        return _pick_page_target(targets, prefer_tmscrm=True)

    best: Optional[dict[str, Any]] = None
    best_rows = -1
    for page in pages:
        try:
            async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
                await sess.send("Runtime.enable", {})
                n = await sess.evaluate(_ROW_COUNT_EXPR)
            count = int(n) if isinstance(n, (int, float)) else 0
        except Exception:
            count = 0
        if count > best_rows:
            best_rows = count
            best = page

    if best is not None and best_rows >= min_rows:
        return best
    return _pick_page_target(targets, prefer_tmscrm=True)


def _credentials(args: argparse.Namespace) -> tuple[str, str]:
    """Resolve username/password from CLI or env (never from repo)."""
    user = getattr(args, "username", None) or os.environ.get("CHAT_AUDIT_CRM_USERNAME")
    password = getattr(args, "password", None) or os.environ.get("CHAT_AUDIT_CRM_PASSWORD")
    if not user or not password:
        print(
            "ERROR: Missing credentials. Ask the user for CRM username and password, then pass:\n"
            "  --username ... --password ...\n"
            "or set CHAT_AUDIT_CRM_USERNAME / CHAT_AUDIT_CRM_PASSWORD in the shell for this run only.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return user, password


class CDPSession:
    # One page WebSocket = one tab; we send JSON-RPC and match responses by monotonic id.

    def __init__(self, ws_url: str):
        self.ws_url = ws_url
        self._ws: Any = None
        self._next_id = 1

    async def __aenter__(self) -> "CDPSession":
        import websockets

        self._ws = await websockets.connect(self.ws_url, max_size=50 * 1024 * 1024)
        return self

    async def __aexit__(self, *args: Any) -> None:
        if self._ws:
            await self._ws.close()

    async def send(self, method: str, params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        if params is None:
            params = {}
        msg_id = self._next_id
        self._next_id += 1
        await self._ws.send(json.dumps({"id": msg_id, "method": method, "params": params}))
        while True:
            raw = await self._ws.recv()
            data = json.loads(raw)
            # CDP pushes events without our id; only consume the reply for this request.
            if data.get("id") != msg_id:
                continue
            if "error" in data:
                raise RuntimeError(data["error"].get("message", str(data["error"])))
            return data.get("result", {})

    async def evaluate(self, expression: str, return_by_value: bool = True) -> Any:
        r = await self.send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": return_by_value, "awaitPromise": True},
        )
        inner = r.get("result", {})
        if inner.get("subtype") == "error":
            raise RuntimeError(inner.get("description", "evaluate failed"))
        return inner.get("value")

    async def navigate(self, url: str) -> None:
        await self.send("Page.navigate", {"url": url})
        # Drain navigation-related events until we get a command response pattern — simple sleep.
        await asyncio.sleep(0.5)


async def cmd_check_page(cdp_base: str) -> None:
    page = _ensure_page_target(cdp_base)
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Page.enable", {})
        await sess.send("Runtime.enable", {})
        href = await sess.evaluate("window.location.href")
        title = await sess.evaluate("document.title")
    print(f"URL: {href}")
    print(f"Title: {title}")
    u = (href or "").lower()
    if "login" in u:
        print("STATUS: on login page")
    elif "chataudit" in u.replace("_", "").lower():
        print("STATUS: on chat audit page")
    else:
        print("STATUS: other page")


async def cmd_navigate_login(cdp_base: str) -> None:
    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=False)
    if not page:
        raise SystemExit(1)
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Page.enable", {})
        await sess.send("Runtime.enable", {})
        await sess.navigate(CHAT_AUDIT_URL)
        await asyncio.sleep(2)
        href = await sess.evaluate("window.location.href")
        print(f"Current URL: {href}")


async def cmd_navigate_audit(cdp_base: str) -> None:
    page = _ensure_page_target(cdp_base)
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Page.enable", {})
        await sess.send("Runtime.enable", {})
        await sess.navigate(CHAT_AUDIT_HASH)
        await asyncio.sleep(3)
        href = await sess.evaluate("window.location.href")
        print(f"Navigated to: {href}")


async def cmd_fill_login(cdp_base: str, args: argparse.Namespace) -> None:
    user, password = _credentials(args)
    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if not page:
        raise SystemExit("ERROR: CRM page not found in CDP targets. Open tmscrm or run navigate-login.")
    # JSON-encode for safe embedding in JS source literals.
    u_js = json.dumps(user)
    p_js = json.dumps(password)
    expr = f"""
(function() {{
    var u = {u_js};
    var p = {p_js};
    var inputs = document.querySelectorAll("input[placeholder]");
    var loginForm = document.querySelector("form");
    if (loginForm && loginForm.__vue__) {{
        loginForm.__vue__.loginForm.username = u;
        loginForm.__vue__.loginForm.password = p;
        loginForm.__vue__.$forceUpdate();
        return "filled via Vue";
    }}
    for (var inp of inputs) {{
        if (inp.placeholder.includes("账号")) {{
            inp.value = u;
            inp.dispatchEvent(new Event("input", {{bubbles: true}}));
        }}
        if (inp.placeholder.includes("密码")) {{
            inp.value = p;
            inp.dispatchEvent(new Event("input", {{bubbles: true}}));
        }}
    }}
    return "filled via DOM";
}})()
"""
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        await sess.send("Page.enable", {})
        out = await sess.evaluate(expr)
        print(f"Fill result: {out}")


async def cmd_screenshot_captcha(cdp_base: str, out_path: str) -> None:
    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if not page:
        raise SystemExit(1)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Page.enable", {})
        await sess.send("Runtime.enable", {})
        r = await sess.send("Page.captureScreenshot", {"format": "png"})
        data = base64.b64decode(r["data"])
        with open(out_path, "wb") as f:
            f.write(data)
    print(f"Screenshot saved to {out_path}")


async def cmd_submit_captcha(cdp_base: str, code: str) -> None:
    code_js = json.dumps(code)
    expr = f"""
(function() {{
    var code = {code_js};
    var inputs = document.querySelectorAll("input[placeholder]");
    for (var inp of inputs) {{
        if (inp.placeholder.includes("验证码")) {{
            inp.value = code;
            inp.dispatchEvent(new Event("input", {{bubbles: true}}));
        }}
    }}
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {{
        var btn = buttons[i];
        if (btn.textContent && btn.textContent.includes("登录")) {{
            btn.click();
            return "submitted";
        }}
    }}
    return "login button not found";
}})()
"""
    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if not page:
        raise SystemExit(1)
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        await sess.send("Page.enable", {})
        out = await sess.evaluate(expr)
        print(f"Submit result: {out}")


async def cmd_check_dates(cdp_base: str) -> None:
    expr = """
(function(){
    var inputs = document.querySelectorAll('.el-date-editor--daterange input');
    var vals = [];
    for (var inp of inputs) vals.push(inp.value || '(empty)');
    return JSON.stringify(vals);
})()
"""
    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if not page:
        raise SystemExit(1)
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        raw = await sess.evaluate(expr)
    print(f"Current date inputs: {raw}")


async def cmd_set_dates(cdp_base: str, date_str: str) -> None:
    # Use simulated clicks to set the outer date picker (next to department selector).
    # Steps: click picker input -> click target date cell -> done.
    # NOT the dialog's date picker; the dialog syncs automatically from the outer picker.
    await cmd_close_dialog(cdp_base)

    parts = date_str.strip().split("-")
    if len(parts) != 3:
        raise SystemExit("ERROR: --date must be YYYY-MM-DD")
    year, month, day = int(parts[0]), int(parts[1]), int(parts[2])

    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if not page:
        raise SystemExit(1)

    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})

        dialog_guard_expr = """
(function(){
    var dialogs = Array.from(document.querySelectorAll('.el-dialog__wrapper,.el-overlay')).filter(function(el) {
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).map(function(el) {
        return (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    });
    return JSON.stringify({count: dialogs.length, dialogs: dialogs});
})()
"""
        dialog_state = json.loads(await sess.evaluate(dialog_guard_expr))
        if dialog_state["count"]:
            sample = dialog_state["dialogs"][0] if dialog_state["dialogs"] else "visible dialog"
            raise SystemExit(
                "ERROR: visible dialog is open; close the employee dialog before setting the main table date. "
                f"Detected: {sample}"
            )

        # Step 1: Click the outer date picker input to open the calendar
        click_expr = """
(function(){
    var picker = document.querySelector('.el-date-editor--daterange');
    if (!picker) return 'no picker';
    var inp = picker.querySelector('input');
    if (inp) { inp.click(); return 'clicked input'; }
    picker.click();
    return 'clicked picker';
})()
"""
        out = await sess.evaluate(click_expr)
        print(f"Click picker: {out}")
        await asyncio.sleep(0.8)

        # Step 2: Click the target date cell in the calendar panel
        click_day_expr = f"""
(function(){{
    var targetDay = {day};
    var panel = document.querySelector(".el-date-range-picker__content");
    if (!panel) return 'no panel';
    var cells = panel.querySelectorAll("td.available");
    for (var cell of cells) {{
        var span = cell.querySelector("span");
        if (!span) continue;
        var text = span.innerText.trim();
        if (parseInt(text) === targetDay) {{
            if (cell.className.includes('prev-month') || cell.className.includes('next-month')) continue;
            cell.click();
            return 'clicked day ' + targetDay;
        }}
    }}
    return 'day ' + targetDay + ' not found';
}})()
"""
        out2 = await sess.evaluate(click_day_expr)
        print(f"Click day: {out2}")
        await asyncio.sleep(0.5)

        # Same-day range selection needs both start and end clicks in Element UI.
        out3 = await sess.evaluate(click_day_expr)
        print(f"Click day again: {out3}")
        await asyncio.sleep(1.0)

        # Verify
        verify_expr = """
(function(){
    var inputs = document.querySelectorAll('.el-date-editor--daterange input');
    var vals = [];
    for (var inp of inputs) vals.push(inp.value || '(empty)');
    return JSON.stringify(vals);
})()
"""
        after = await sess.evaluate(verify_expr)
        print(f"After set: {after}")


async def cmd_check_department(cdp_base: str) -> None:
    expr = """
(function(){
    var tags = document.querySelectorAll('.hj-cascader .el-tag');
    var selected = [];
    for (var t of tags) selected.push(t.textContent.trim());
    var input = document.querySelector('.hj-cascader input');
    var inputVal = input ? input.value : '';
    return JSON.stringify({tags: selected, input: inputVal});
})()
"""
    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if not page:
        raise SystemExit(1)
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        raw = await sess.evaluate(expr)
    print(f"Current cascader state: {raw}")


async def cmd_set_department(cdp_base: str, group_name: str) -> None:
    group_js = json.dumps(group_name)
    open_expr = """
(function() {
    var trigger = document.querySelector('.hj-cascader .el-cascader__tags') ||
                  document.querySelector('.hj-cascader input');
    if (trigger) { trigger.click(); return 'opened'; }
    return 'trigger not found';
})()
"""
    select_expr = f"""
(function() {{
    var groupName = {group_js};
    var nodes = document.querySelectorAll('.el-cascader-node__label');
    for (var node of nodes) {{
        if (node.textContent.trim() === groupName) {{
            var parent = node.closest('.el-cascader-node');
            var checkbox = parent.querySelector('.el-checkbox__input');
            if (!checkbox) {{
                node.click();
                return 'clicked ' + node.textContent.trim();
            }}
            var isChecked = parent.querySelector('.el-checkbox.is-checked');
            if (isChecked) {{
                return 'already checked, skipping';
            }}
            checkbox.click();
            return 'checked ' + node.textContent.trim();
        }}
    }}
    return 'option not found';
}})()
"""
    close_expr = """
(function(){
    var m = document.querySelector('.el-main');
    if (m) m.click();
    return 'closed';
})()
"""
    verify_expr = f"""
(function() {{
    var groupName = {group_js};
    var nodes = document.querySelectorAll('.el-cascader-node__label');
    for (var node of nodes) {{
        if (node.textContent.trim() === groupName) {{
            var parent = node.closest('.el-cascader-node');
            var checkbox = parent.querySelector('.el-checkbox');
            return JSON.stringify({{
                checked: checkbox ? checkbox.className.includes('is-checked') : false
            }});
        }}
    }}
    return JSON.stringify({{checked: false, note: 'node not found'}});
}})()
"""
    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if not page:
        raise SystemExit(1)
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        await sess.evaluate(open_expr)
        await asyncio.sleep(1)
        sel = await sess.evaluate(select_expr)
        print(f"Select result: {sel}")
        await asyncio.sleep(1)
        await sess.evaluate(close_expr)
        await asyncio.sleep(2)
        ver = await sess.evaluate(verify_expr)
        print(f"Verify result: {ver}")


def _normalize_date_display(s: str) -> str:
    """Loose compare for Element UI date input vs YYYY-MM-DD."""
    s = (s or "").strip().replace("/", "-")
    return s


def _filters_ok(state: dict[str, Any], expect_dept: str, expect_date: Optional[str]) -> bool:
    if state.get("department") != [expect_dept]:
        return False
    if expect_date:
        dates = state.get("mainDates") or state.get("dates") or []
        d0 = _normalize_date_display(dates[0]) if dates else ""
        d1 = _normalize_date_display(dates[1]) if len(dates) > 1 else ""
        exp_n = _normalize_date_display(expect_date)
        if d0 != exp_n or d1 != exp_n:
            return False
    return int(state.get("rowCount") or 0) > 0


async def diagnose_state(cdp_base: str, expect_dept: str, expect_date: Optional[str]) -> dict[str, Any]:
    try:
        targets = _list_targets(cdp_base)
    except Exception as exc:
        return {
            "state": "UNKNOWN_BLOCKED",
            "reason": f"cannot reach CDP at {cdp_base}: {exc}",
            "cdp": cdp_base,
        }

    pages = [
        t for t in targets
        if t.get("type") == "page" and (
            "tmscrm.yishouapp.com" in (t.get("url") or "") or "chatAudit" in (t.get("url") or "")
        )
    ]
    audit_pages = [p for p in pages if "chatAudit" in (p.get("url") or "")]
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if audit_pages:
        page = audit_pages[0]

    if not page:
        return {
            "state": "CRM_LOGIN_REQUIRED",
            "reason": "no tmscrm/chatAudit page target",
            "pages": [{"id": p.get("id"), "url": p.get("url"), "title": p.get("title")} for p in pages],
        }

    dom_expr = """
(function(){
    function visible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    function text(el) {
        return (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
    }
    var dialogs = Array.from(document.querySelectorAll('.el-dialog.v-chat-moadl, .el-dialog__wrapper')).filter(visible);
    var dialog = dialogs.find(function(el){ return text(el).includes('沟通内容'); }) || null;
    var mainPickers = Array.from(document.querySelectorAll('.el-date-editor--daterange'));
    var mainInputs = mainPickers[0] ? Array.from(mainPickers[0].querySelectorAll('input')).map(function(inp){ return inp.value || '(empty)'; }) : [];
    var allInputs = Array.from(document.querySelectorAll('.el-date-editor--daterange input')).map(function(inp){ return inp.value || '(empty)'; });
    var tags = Array.from(document.querySelectorAll('.hj-cascader .el-tag')).map(function(t){ return text(t); });
    var rows = document.querySelectorAll('.el-table__body-wrapper .el-table__row');
    var dialogText = text(dialog);
    var activeMenu = text(Array.from(dialog?.querySelectorAll('.menu-li-active, .is-active, .active') || []).find(function(el){
        return ['沟通内容', '总有效跟进好友数（人天）', '总有效咨询好友数（人天）'].some(function(label){ return text(el).includes(label); });
    }));
    var activeTab = text(Array.from(dialog?.querySelectorAll('.tab-li-active, .is-active, .active') || []).find(function(el){
        return ['外部好友', '内部员工', '外部群', '内部群'].some(function(label){ return text(el).includes(label); });
    }));
    var friendItems = Array.from(dialog?.querySelectorAll('.friend-li') || []);
    var activeFriend = friendItems.find(function(el){
        return /active|is-active|selected|current/.test(el.className || '') ||
            el.getAttribute('aria-selected') === 'true';
    });
    var searchInputs = Array.from(dialog?.querySelectorAll('input') || []).filter(function(inp) {
        return /搜索|好友|备注|聊天记录/.test(inp.getAttribute('placeholder') || '');
    });
    var tableRows = Array.from(dialog?.querySelectorAll('.el-table__body-wrapper tbody tr') || []);
    var tableHeader = text(dialog?.querySelector('.el-table__header-wrapper'));
    return JSON.stringify({
        href: location.href,
        title: document.title,
        isLoginPage: !location.href.includes('chatAudit') && (/login/.test(location.href) || !!document.querySelector('input[type=password]')),
        isAuditPage: location.href.includes('chatAudit'),
        dates: allInputs,
        mainDates: mainInputs,
        department: tags,
        rowCount: rows.length,
        dialogVisible: !!dialog,
        dialogText: dialogText.slice(0, 160),
        activeMenu: activeMenu,
        activeTab: activeTab,
        metricTableOpen: !!dialog && tableRows.length > 0 && /客户信息|员工发起会话时间/.test(tableHeader),
        metricTableRows: tableRows.length,
        searchInputCount: searchInputs.length,
        friendItemCount: friendItems.length,
        activeFriendText: text(activeFriend).slice(0, 120)
    });
})()
"""
    try:
        async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
            await sess.send("Runtime.enable", {})
            dom = json.loads(await sess.evaluate(dom_expr))
    except Exception as exc:
        return {
            "state": "UNKNOWN_BLOCKED",
            "reason": f"failed to inspect CRM DOM: {exc}",
            "page": {"id": page.get("id"), "url": page.get("url"), "title": page.get("title")},
        }

    parent_ids = {p["id"] for p in audit_pages}

    def _scoped(ifr: dict[str, Any]) -> bool:
        pid = ifr.get("parentId")
        return pid is None or not parent_ids or pid in parent_ids

    iframes = [t for t in targets if t.get("type") == "iframe"]
    data_iframes = [
        t for t in iframes
        if "ww-open-data-frame" in (t.get("url") or "") and _scoped(t)
    ]
    login_iframes = [
        t for t in iframes
        if "login.work.weixin.qq.com" in (t.get("url") or "") and _scoped(t)
    ]

    dom.update({
        "pageTargetId": page.get("id"),
        "wecomDataIframeCount": len(data_iframes),
        "wecomLoginIframeCount": len(login_iframes),
        "expectDept": expect_dept,
        "expectDate": expect_date,
    })

    selected_customer = bool(dom.get("dialogVisible") and dom.get("activeFriendText"))
    filters_ok = _filters_ok(dom, expect_dept, expect_date)
    dom["filtersOk"] = filters_ok
    dom["selectedCustomer"] = selected_customer

    if dom.get("isLoginPage") and not dom.get("isAuditPage"):
        dom["state"] = "CRM_LOGIN_REQUIRED"
        dom["reason"] = "CRM page appears to be on login"
    elif not dom.get("isAuditPage"):
        dom["state"] = "UNKNOWN_BLOCKED"
        dom["reason"] = "current tmscrm page is not chatAudit"
    elif dom.get("dialogVisible") and selected_customer and login_iframes:
        dom["state"] = "CUSTOMER_SELECTED_WECHAT_LOGIN_REQUIRED"
        dom["reason"] = "customer selected but WeCom login iframe is shown"
    elif dom.get("dialogVisible") and selected_customer and data_iframes:
        dom["state"] = "CUSTOMER_SELECTED_MESSAGE_READY"
        dom["reason"] = "customer selected and WeCom message iframe is available"
    elif dom.get("dialogVisible") and dom.get("metricTableOpen"):
        dom["state"] = "METRIC_TABLE_OPEN"
        dom["reason"] = "employee dialog is showing a metric table"
    elif dom.get("dialogVisible") and dom.get("searchInputCount") and dom.get("friendItemCount"):
        dom["state"] = "CUSTOMER_SEARCH_READY"
        dom["reason"] = "employee dialog communication/search area is ready"
    elif dom.get("dialogVisible"):
        dom["state"] = "EMPLOYEE_DIALOG_OPEN"
        dom["reason"] = "employee dialog is open"
    elif not filters_ok:
        dom["state"] = "AUDIT_PAGE_WRONG_FILTERS"
        dom["reason"] = "main table date/department/rows do not match expectations"
    else:
        dom["state"] = "AUDIT_EMPLOYEE_LIST_READY"
        dom["reason"] = "main employee list is ready; WeCom iframe is not required yet"

    return dom


async def cmd_diagnose_state(cdp_base: str, expect_dept: str, expect_date: Optional[str]) -> int:
    state = await diagnose_state(cdp_base, expect_dept, expect_date)
    print(json.dumps(state, ensure_ascii=False, indent=2))
    return 0 if state.get("state") != "UNKNOWN_BLOCKED" else 1


async def cmd_gate_start_export(cdp_base: str, expect_dept: str, expect_date: Optional[str]) -> int:
    state = await diagnose_state(cdp_base, expect_dept, expect_date)
    print(f"State: {state.get('state')}")
    print(f"Reason: {state.get('reason')}")
    print(f"Dates: {state.get('mainDates') or state.get('dates')}")
    print(f"Department: {state.get('department')}")
    print(f"Rows visible: {state.get('rowCount')}")
    if state.get("state") == "AUDIT_EMPLOYEE_LIST_READY":
        print("\n✅ START GATE PASSED — employee list ready; WeCom iframe will be checked after selecting a customer")
        return 0
    print("\nSTART GATE FAILED:")
    if state.get("state") == "EMPLOYEE_DIALOG_OPEN":
        print("❌ Employee dialog is open; close it before starting a fresh export")
    elif state.get("state") == "AUDIT_PAGE_WRONG_FILTERS":
        print("❌ Main table filters are wrong; run set-department / set-dates and gate-check")
    elif state.get("state") == "CRM_LOGIN_REQUIRED":
        print("❌ CRM login is required")
    else:
        print(f"❌ Current state is {state.get('state')}: {state.get('reason')}")
    return 1


async def cmd_gate_wecom(cdp_base: str) -> int:
    """
    Customer-level WeCom check. Employee-list pages do not reliably have the
    message iframe yet, so only a selected-customer login iframe is fatal.
    """
    state = await diagnose_state(cdp_base, "大客私域顾问-总", None)
    if state.get("state") == "CUSTOMER_SELECTED_MESSAGE_READY":
        print("OK: 已选中客户并检测到企业微信消息 iframe (ww-open-data-frame)，可抓取该对话。")
        return 0
    if state.get("state") == "CUSTOMER_SELECTED_WECHAT_LOGIN_REQUIRED":
        print(
            "请在本机 Chrome（调试端口已连接）的当前客户会话中扫描企业微信二维码完成登录后再继续导出。",
            file=sys.stderr,
        )
        print("（已选中客户，检测到 login.work.weixin.qq.com，但未检测到可用的消息区 iframe。）", file=sys.stderr)
        return 3
    if state.get("state") == "AUDIT_EMPLOYEE_LIST_READY":
        print("OK: 当前在员工列表页；此阶段不要求企业微信消息 iframe。导出会在选中客户后再检查。")
        return 0
    print(
        f"ERROR: 当前页面状态不适合检查企业微信消息 iframe：{state.get('state')} — {state.get('reason')}",
        file=sys.stderr,
    )
    return 2


async def cmd_close_dialog(cdp_base: str) -> None:
    targets = _list_targets(cdp_base)
    page = _pick_page_target(targets, prefer_tmscrm=True)
    if not page:
        raise SystemExit("ERROR: CRM page not found in CDP targets.")
    expr = """
(function() {
    function visible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    var dialogs = Array.from(document.querySelectorAll('.el-dialog.v-chat-moadl, .el-dialog__wrapper')).filter(visible);
    var dialog = dialogs.find(function(el){ return (el.innerText || el.textContent || '').includes('沟通内容'); });
    if (!dialog) return JSON.stringify({ok: true, action: 'none', reason: 'no dialog'});
    var close = dialog.querySelector('.el-dialog__headerbtn, .el-dialog__close, [aria-label="Close"]');
    if (close) {
        close.click();
        return JSON.stringify({ok: true, action: 'clicked close'});
    }
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
    return JSON.stringify({ok: true, action: 'escape'});
})()
"""
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        result = await sess.evaluate(expr)
        await asyncio.sleep(1)
    print(result)


async def cmd_get_employees(cdp_base: str) -> int:
    """Extract employee rows from the main table for the orchestrator."""
    expr = """
(function(){
    var rows = document.querySelectorAll('.el-table__body-wrapper .el-table__row');
    var result = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        var nameCell = cells[0];
        var nameEl = nameCell.querySelector('.cell');
        var name = nameEl ? (nameEl.innerText || '').trim() : '';
        if (!name) continue;
        // Extract ID from row data attributes or cells
        var rowId = row.getAttribute('data-id') || '';
        var idCell = cells[1];
        var idEl = idCell ? (idCell.querySelector('.cell') || {}).innerText || '' : '';
        result.push({
            name: name,
            id: rowId || idEl.trim(),
            rowIndex: i
        });
    }
    return JSON.stringify(result);
})()
"""
    page = await _pick_crm_page_with_rows(cdp_base, min_rows=1)
    if not page:
        print("ERROR: No tmscrm page", file=sys.stderr)
        return 1
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        raw = await sess.evaluate(expr)
    try:
        employees = json.loads(raw)
    except Exception:
        print(f"ERROR: Failed to parse employee list", file=sys.stderr)
        return 1
    if not employees:
        print("[]")
        return 0
    print(json.dumps(employees, ensure_ascii=False))
    return 0


async def cmd_gate_check(cdp_base: str, expect_dept: str, expect_date: Optional[str]) -> int:
    expr = """
(function(){
    var inputs = document.querySelectorAll('.el-date-editor--daterange input');
    var dates = [];
    for (var inp of inputs) dates.push(inp.value || '(empty)');
    var tags = document.querySelectorAll('.hj-cascader .el-tag');
    var selected = [];
    for (var t of tags) selected.push(t.textContent.trim());
    var rows = document.querySelectorAll('.el-table__body-wrapper .el-table__row');
    return JSON.stringify({dates: dates, department: selected, rowCount: rows.length});
})()
"""
    page = await _pick_crm_page_with_rows(cdp_base, min_rows=0)
    if not page:
        print("ERROR: No tmscrm page")
        return 1
    async with CDPSession(page["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        raw = await sess.evaluate(expr)
    state = json.loads(raw)
    print(f"Dates: {state['dates']}")
    print(f"Department: {state['department']}")
    print(f"Rows visible: {state['rowCount']}")
    errors: list[str] = []
    # Department: exact tag list match (single expected tag).
    exp_tags = [expect_dept]
    if state["department"] != exp_tags:
        errors.append(f"❌ Department NOT set to {expect_dept} (got {state['department']})")
    else:
        print(f"✅ Department: {expect_dept}")
    if expect_date:
        d0 = _normalize_date_display(state["dates"][0]) if state["dates"] else ""
        d1 = _normalize_date_display(state["dates"][1]) if len(state["dates"]) > 1 else ""
        exp_n = _normalize_date_display(expect_date)
        if len(state["dates"]) == 2 and d0 == d1 == exp_n:
            print(f"✅ Date range: {expect_date}")
        else:
            errors.append(f"❌ Date range mismatch: {state['dates']} (expected single day {expect_date})")
    if state["rowCount"] == 0:
        errors.append("❌ No employee rows visible")
    if errors:
        print("\nGATE FAILED:")
        for e in errors:
            print(e)
        return 1
    print("\n✅ GATE PASSED — ready to export")
    return 0


def _add_cdp_arg(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--cdp",
        default=DEFAULT_CDP,
        help="Chrome DevTools HTTP base (default: env CHAT_AUDIT_CRM_CDP_BASE or http://localhost:9222)",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="CRM chat-audit CDP preflight (Chrome 9222).")
    _add_cdp_arg(parser)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_check = sub.add_parser("check-page", help="Print URL, title, STATUS (login / chat audit / other).")
    _add_cdp_arg(p_check)

    p_nav = sub.add_parser("navigate-login", help="Navigate active page to CRM root (login).")
    _add_cdp_arg(p_nav)

    p_audit = sub.add_parser("navigate-audit", help="Navigate to chatAudit hash URL.")
    _add_cdp_arg(p_audit)

    p_fill = sub.add_parser("fill-login", help="Fill username/password on login form (Vue or DOM).")
    _add_cdp_arg(p_fill)
    p_fill.add_argument("--username", default=None, help="CRM username (or CHAT_AUDIT_CRM_USERNAME).")
    p_fill.add_argument("--password", default=None, help="CRM password (or CHAT_AUDIT_CRM_PASSWORD).")

    p_cap = sub.add_parser("screenshot-captcha", help="Save PNG screenshot of current CRM page.")
    _add_cdp_arg(p_cap)
    p_cap.add_argument("--out", default="exports/captcha.png", help="Output PNG path.")

    p_sub = sub.add_parser("submit-captcha", help="Fill verification code and click login.")
    _add_cdp_arg(p_sub)
    p_sub.add_argument("--code", required=True, help="Captcha / SMS code from user.")

    p_cd = sub.add_parser("check-dates", help="Print current daterange input values.")
    _add_cdp_arg(p_cd)

    p_sd = sub.add_parser("set-dates", help="Set main table daterange via Vue $emit (single day).")
    _add_cdp_arg(p_sd)
    p_sd.add_argument("--date", required=True, help="YYYY-MM-DD (start and end both set to this day).")

    p_gd = sub.add_parser("check-department", help="Print cascader tags / input state.")
    _add_cdp_arg(p_gd)

    p_sd2 = sub.add_parser("set-department", help="Select cascader group if not already checked.")
    _add_cdp_arg(p_sd2)
    p_sd2.add_argument("--group", default="大客私域顾问-总", help="Exact cascader label text.")

    p_gate = sub.add_parser("gate-check", help="Validate dates, department tag, and row count before export.")
    _add_cdp_arg(p_gate)
    p_gate.add_argument("--expect-dept", default="大客私域顾问-总", help="Expected single cascader tag.")
    p_gate.add_argument(
        "--expect-date",
        default=None,
        help="If set, require both date inputs equal to this day (YYYY-MM-DD after normalize).",
    )

    p_wg = sub.add_parser(
        "gate-wecom",
        help="After selecting a customer: require ww-open-data-frame; employee list page does not require it.",
    )
    _add_cdp_arg(p_wg)

    p_close = sub.add_parser("close-dialog", help="Close the visible chat-audit employee dialog.")
    _add_cdp_arg(p_close)

    p_diag = sub.add_parser("diagnose-state", help="Print structured CRM/chat-audit page state as JSON.")
    _add_cdp_arg(p_diag)
    p_diag.add_argument("--expect-dept", default="大客私域顾问-总", help="Expected single cascader tag.")
    p_diag.add_argument("--expect-date", default=None, help="Expected main table single day.")

    p_start = sub.add_parser("gate-start-export", help="Validate CRM employee list is ready before export.")
    _add_cdp_arg(p_start)
    p_start.add_argument("--expect-dept", default="大客私域顾问-总", help="Expected single cascader tag.")
    p_start.add_argument("--expect-date", default=None, help="Expected main table single day.")

    p_emp = sub.add_parser("get-employees", help="Get employee list from main table.")
    _add_cdp_arg(p_emp)

    args = parser.parse_args()
    cdp = args.cdp

    async def run() -> Optional[int]:
        if args.cmd == "check-page":
            await cmd_check_page(cdp)
        elif args.cmd == "navigate-login":
            await cmd_navigate_login(cdp)
        elif args.cmd == "navigate-audit":
            await cmd_navigate_audit(cdp)
        elif args.cmd == "fill-login":
            await cmd_fill_login(cdp, args)
        elif args.cmd == "screenshot-captcha":
            await cmd_screenshot_captcha(cdp, args.out)
        elif args.cmd == "submit-captcha":
            await cmd_submit_captcha(cdp, args.code)
        elif args.cmd == "check-dates":
            await cmd_check_dates(cdp)
        elif args.cmd == "set-dates":
            await cmd_set_dates(cdp, args.date)
        elif args.cmd == "check-department":
            await cmd_check_department(cdp)
        elif args.cmd == "set-department":
            await cmd_set_department(cdp, args.group)
        elif args.cmd == "gate-check":
            return await cmd_gate_check(cdp, args.expect_dept, args.expect_date)
        elif args.cmd == "gate-wecom":
            return await cmd_gate_wecom(cdp)
        elif args.cmd == "close-dialog":
            await cmd_close_dialog(cdp)
        elif args.cmd == "diagnose-state":
            return await cmd_diagnose_state(cdp, args.expect_dept, args.expect_date)
        elif args.cmd == "gate-start-export":
            return await cmd_gate_start_export(cdp, args.expect_dept, args.expect_date)
        elif args.cmd == "get-employees":
            return await cmd_get_employees(cdp)
        return None

    try:
        rc = asyncio.run(run())
    except ImportError as e:
        print("ERROR: pip install websockets", file=sys.stderr)
        raise SystemExit(1) from e
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(1) from e
    if rc is not None:
        raise SystemExit(rc)


if __name__ == "__main__":
    main()
