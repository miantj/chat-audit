"""上次导出界面选项（日期、输出目录、部门）持久化到本地 JSON。"""
from __future__ import annotations

import json
import os
from typing import Any, Dict


def preferences_path() -> str:
    app_data = os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming"))
    base = os.path.join(app_data, "chat-audit-export")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "ui_preferences.json")


def load_ui_preferences() -> Dict[str, Any]:
    path = preferences_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_ui_preferences(data: Dict[str, Any]) -> None:
    path = preferences_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
