import subprocess
import sys
import json
import re
import threading
import atexit
import signal
import os
from typing import Callable, Optional, Dict, Any, List
from pathlib import Path
from app.logger import get_logger
from app.runtime_paths import find_node_exe, get_scripts_dir, script_path


class ExportOrchestrator:
    """导出流程编排器（支持进度事件解析与有限次自愈重试）。"""

    DEFAULT_MAX_RETRIES = 3

    def __init__(self, enable_self_heal: bool = True, max_retries: int = DEFAULT_MAX_RETRIES):
        self.logger = get_logger()
        self.process: Optional[subprocess.Popen] = None
        self._monitor_thread: Optional[threading.Thread] = None
        self.running = False
        self.enable_self_heal = enable_self_heal
        self.max_retries = max(1, max_retries)
        self._script_dir = get_scripts_dir()
        self._last_error_message: str = ""
        self._export_params: Optional[Dict[str, Any]] = None
        self._attempt = 0
        atexit.register(self._cleanup_on_exit)
        if os.name == "nt":
            signal.signal(signal.SIGBREAK, self._handle_signal)
        else:
            signal.signal(signal.SIGTERM, self._handle_signal)
            signal.signal(signal.SIGINT, self._handle_signal)
        self.logger.debug(f"脚本目录: {self._script_dir}")

    def _handle_signal(self, signum, frame):
        self.logger.info(f"收到信号 {signum}，正在停止导出")
        self.stop()

    def _cleanup_on_exit(self):
        if self.running:
            self.logger.info("程序退出，清理导出进程")
            self.stop()

    def start_export(
        self,
        start_date: str,
        end_date: str,
        output_dir: str,
        dept: str = "大客私域顾问-总",
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_complete: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_error: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        """启动导出流程（失败时可自愈重试，依赖 checkpoint 续跑）。"""
        self._export_params = {
            "start_date": start_date,
            "end_date": end_date,
            "output_dir": output_dir,
            "dept": dept,
            "on_progress": on_progress,
            "on_complete": on_complete,
            "on_error": on_error,
        }
        self._attempt = 0
        self._last_error_message = ""
        self._start_export_attempt()

    def _start_export_attempt(self):
        if not self._export_params:
            return

        params = self._export_params
        self._attempt += 1
        start_date = params["start_date"]
        end_date = params["end_date"]
        output_dir = params["output_dir"]
        dept = params.get("dept", "大客私域顾问-总")

        self.running = True
        output_file = Path(output_dir) / f"chat-audit-{start_date}.json"
        self.logger.info(
            f"启动导出 (尝试 {self._attempt}/{self.max_retries}): "
            f"start={start_date}, end={end_date}, dept={dept}, out={output_file}"
        )

        node_exe = find_node_exe()
        if not node_exe:
            self.logger.error("Node.js 未安装或不在 PATH 中")
            self.running = False
            if params["on_error"]:
                params["on_error"]({"event": "export-error", "message": "Node.js 未安装，请先安装 Node.js"})
            return

        export_script = self._script_dir / "export-date-range.js"
        if not export_script.exists():
            self.logger.error(f"导出脚本不存在: {export_script}")
            self.running = False
            if params["on_error"]:
                params["on_error"]({"event": "export-error", "message": f"导出脚本不存在: {export_script}"})
            return

        cmd: List[str] = [
            node_exe,
            str(export_script),
            f"--start={start_date}",
            f"--end={end_date}",
            f"--out={output_file}",
            "--skip-date-validation",
            "--all-employees",
        ]

        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                encoding="utf-8",
                errors="replace",
                cwd=str(self._script_dir),
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )

            buffer: List[str] = []

            def flush_buffer():
                nonlocal buffer
                if not buffer:
                    return None
                text = "".join(buffer)
                buffer = []
                return self.parse_event(text)

            def handle_event(event):
                if not event or not isinstance(event, dict):
                    return
                event_type = event.get("event")
                if event_type == "export-progress" and params["on_progress"]:
                    params["on_progress"](event)
                elif event_type in ("export-complete", "export-shutdown"):
                    self.running = False
                    if params["on_complete"]:
                        normalized = dict(event)
                        if "total" not in normalized and "conversations" in normalized:
                            normalized["total"] = normalized["conversations"]
                        params["on_complete"](normalized)
                elif event_type == "export-error":
                    self._last_error_message = event.get("message", "") or self._last_error_message
                    if params["on_progress"]:
                        params["on_progress"]({
                            "event": "export-progress",
                            "message": f"错误: {self._last_error_message[:120]}",
                        })

            def monitor():
                return_code = 1
                try:
                    if self.process and self.process.stdout:
                        for raw_line in self.process.stdout:
                            if not self.running:
                                if buffer:
                                    event = flush_buffer()
                                    if event:
                                        handle_event(event)
                                break
                            line = raw_line.strip()
                            if not line:
                                continue
                            if line.startswith("{"):
                                if buffer:
                                    event = flush_buffer()
                                    if event:
                                        handle_event(event)
                                buffer.append(line)
                                if line.endswith("}"):
                                    event = flush_buffer()
                                    if event:
                                        handle_event(event)
                            elif buffer:
                                buffer.append(line)
                                if line.endswith("}"):
                                    event = flush_buffer()
                                    if event:
                                        handle_event(event)
                            else:
                                self.logger.debug(f"非事件输出: {line[:100]}")

                    if self.process:
                        return_code = self.process.wait()
                        self.logger.debug(f"导出进程结束，返回码: {return_code}")
                        if buffer:
                            event = flush_buffer()
                            if event:
                                handle_event(event)

                    if return_code == 0:
                        return

                    if not self.running:
                        return

                    if self._try_self_heal_and_retry(start_date, end_date, params):
                        return

                    if params["on_error"]:
                        msg = self._last_error_message or f"导出进程异常退出，返回码: {return_code}"
                        params["on_error"]({"event": "export-error", "message": msg})
                except Exception as e:
                    self.logger.error(f"导出监控异常: {str(e)}", exc_info=True)
                    if params["on_error"]:
                        params["on_error"]({"event": "export-error", "message": str(e)})
                finally:
                    self.running = False

            self._monitor_thread = threading.Thread(target=monitor, daemon=True)
            self._monitor_thread.start()

        except FileNotFoundError:
            self.logger.error("Node.js 未找到")
            self.running = False
            if params["on_error"]:
                params["on_error"]({"event": "export-error", "message": "Node.js 未找到，请检查安装"})
        except Exception as e:
            self.logger.error(f"启动导出失败: {str(e)}", exc_info=True)
            self.running = False
            if params["on_error"]:
                params["on_error"]({"event": "export-error", "message": str(e)})

    def _try_self_heal_and_retry(self, start_date: str, end_date: str, params: Dict[str, Any]) -> bool:
        """自愈成功后重新拉起导出；返回 True 表示已调度重试或不应再 on_error。"""
        if not self.enable_self_heal or self._attempt >= self.max_retries:
            return False

        if not self._last_error_message:
            return False

        healed = self._run_self_heal(self._last_error_message, start_date, end_date)
        if not healed:
            return False

        self.logger.info(f"自愈成功，重试导出 ({self._attempt + 1}/{self.max_retries})")
        if params["on_progress"]:
            params["on_progress"]({
                "event": "export-progress",
                "message": f"已自愈，正在重试 ({self._attempt + 1}/{self.max_retries})…",
            })
        self._start_export_attempt()
        return True

    def _run_self_heal(self, error_message: str, start_date: str, end_date: str) -> bool:
        node_exe = find_node_exe()
        heal_script = script_path("heal-export-error.js")
        if not node_exe or not heal_script.exists():
            self.logger.warning("无法自愈：缺少 Node 或 heal-export-error.js")
            return False

        try:
            result = subprocess.run(
                [node_exe, str(heal_script), error_message, start_date, end_date],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(self._script_dir),
                timeout=120,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            self.logger.info(f"自愈脚本退出码: {result.returncode}")
            if result.stdout:
                self.logger.debug(result.stdout[:500])
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            self.logger.error("自愈脚本超时")
            return False
        except Exception as e:
            self.logger.error(f"自愈脚本异常: {e}", exc_info=True)
            return False

    def parse_event(self, line: str) -> Optional[Dict[str, Any]]:
        line = line.strip()
        if not line:
            return None
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            pass
        try:
            match = re.search(r"\{[\s\S]*\}", line)
            if match:
                return json.loads(match.group())
        except Exception:
            pass
        return None

    def stop(self):
        self.running = False
        self.logger.info("停止导出")

        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
            except Exception as e:
                self.logger.error(f"终止进程失败: {str(e)}")
            finally:
                self.process = None

        if self._monitor_thread and self._monitor_thread.is_alive():
            try:
                self._monitor_thread.join(timeout=3)
            except Exception:
                pass
