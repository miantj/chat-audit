#!/usr/bin/env python3
"""runtime_paths 与导出事件解析"""
import sys

sys.path.insert(0, ".")

from app.runtime_paths import get_scripts_dir, script_path, find_node_exe
from app.export_orchestrator import ExportOrchestrator


def test_scripts_dir_exists():
    d = get_scripts_dir()
    assert d.is_dir(), d
    assert script_path("export-date-range.js").exists()
    assert script_path("crm-check.js").exists()
    assert script_path("heal-export-error.js").exists()


def test_parse_export_progress_event():
    orch = ExportOrchestrator(enable_self_heal=False)
    raw = '{"event":"export-progress","current":3,"total":100,"employee":"张三","customer":"wxid_1"}'
    ev = orch.parse_event(raw)
    assert ev["event"] == "export-progress"
    assert ev["current"] == 3
    assert ev["total"] == 100
    assert ev["employee"] == "张三"


def test_find_node_optional():
    path = find_node_exe()
    if path:
        low = path.lower().replace("\\", "/")
        assert low.endswith("node") or low.endswith("node.exe")


if __name__ == "__main__":
    test_scripts_dir_exists()
    test_parse_export_progress_event()
    test_find_node_optional()
    print("ok")
