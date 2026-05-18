"""脚本路径与 Node 可执行文件解析（开发态 / PyInstaller 打包共用）。"""
import os
import shutil
import sys
from pathlib import Path
from typing import Optional

_node_manager_instance = None


def get_scripts_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "scripts"
    return Path(__file__).resolve().parent.parent / "chat-audit-export" / "scripts"


def script_path(name: str) -> Path:
    return get_scripts_dir() / name


def find_node_exe() -> Optional[str]:
    """PATH 中的 node，或 NodeManager 安装的 node.exe。"""
    node_path = shutil.which("node")
    if node_path and os.path.exists(node_path):
        return node_path

    global _node_manager_instance
    if _node_manager_instance is None:
        from app.node_manager import NodeManager

        _node_manager_instance = NodeManager()
    if _node_manager_instance.check_node() and _node_manager_instance.node_path:
        return _node_manager_instance.node_path
    return None


def require_node_exe() -> str:
    path = find_node_exe()
    if not path:
        raise RuntimeError("Node.js 未安装，请先安装 Node.js")
    return path
