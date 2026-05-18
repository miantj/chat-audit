#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import urllib.request

module_path = Path(__file__).with_name("crm-preflight.py")
spec = importlib.util.spec_from_file_location("crm_preflight", module_path)
if not spec or not spec.loader:
    raise RuntimeError("Cannot load crm-preflight.py")
crm_preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crm_preflight)
CDPSession = crm_preflight.CDPSession


CDP_BASE = os.environ.get("CHAT_AUDIT_CRM_CDP_BASE", "http://localhost:9222")
DEFAULT_OUT = Path("exports/crm-wecom-qr.png")


def list_targets() -> list[dict]:
    with urllib.request.urlopen(CDP_BASE.rstrip("/") + "/json", timeout=10) as resp:
        return json.loads(resp.read().decode())


async def main() -> None:
    targets = list_targets()
    pages = [
        t
        for t in targets
        if t.get("type") == "page"
        and "tmscrm" in (t.get("url") or "")
        and t.get("webSocketDebuggerUrl")
    ]
    if not pages:
        raise SystemExit("No CRM page target found")

    login_targets = [
        t
        for t in targets
        if "login.work.weixin.qq.com" in (t.get("url") or "")
        and t.get("webSocketDebuggerUrl")
    ]
    if not login_targets:
        raise SystemExit("No WeCom login target found")

    async with CDPSession(pages[0]["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        result = await sess.evaluate(
            """
(function() {
  const frames = Array.from(document.querySelectorAll('iframe'));
  const frame = frames.find((el) => (el.src || '').includes('login.work.weixin.qq.com'));
  if (!frame) return { ok: false, reason: 'login iframe not found' };
  const url = new URL(frame.src);
  url.searchParams.set('_codex_refresh', String(Date.now()));
  frame.src = url.toString();
  return { ok: true, src: frame.src };
})()
""",
            return_by_value=True,
        )
        if not result or not result.get("ok"):
            raise SystemExit(json.dumps(result, ensure_ascii=False))
        await asyncio.sleep(2)

    # Re-read targets after the iframe refresh; then inspect the CRM-embedded
    # login iframe itself and extract its QR image URL. Do not open or navigate
    # to standalone WeCom pages.
    targets = list_targets()
    login_targets = [
        t
        for t in targets
        if "login.work.weixin.qq.com" in (t.get("url") or "")
        and t.get("webSocketDebuggerUrl")
    ]
    if not login_targets:
        raise SystemExit("No WeCom login target found after iframe refresh")

    async with CDPSession(login_targets[0]["webSocketDebuggerUrl"]) as sess:
        await sess.send("Runtime.enable", {})
        qr_src = await sess.evaluate(
            """
(function() {
  const img = document.querySelector('.wwLogin_qrcode_img') ||
    Array.from(document.images).find((el) => /qrcode/.test(el.src || ''));
  return img ? img.src : '';
})()
""",
            return_by_value=True,
        )
    if not qr_src:
        raise SystemExit("No embedded WeCom QR image found")

    with urllib.request.urlopen(qr_src, timeout=20) as resp:
        data = resp.read()

    out = Path(os.environ.get("CHAT_AUDIT_WECOM_QR_OUT", str(DEFAULT_OUT)))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print(json.dumps({
        "event": "wecom-qr-saved",
        "iframe": result.get("src"),
        "qrSrc": qr_src,
        "outputPath": str(out.resolve())
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
