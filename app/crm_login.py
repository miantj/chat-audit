import os
import subprocess
from typing import Optional
from app.cdp_controller import CDPController
from app.credential_mgr import CredentialManager
from app.logger import get_logger
from app.runtime_paths import get_scripts_dir, script_path, require_node_exe
from logging import Logger


def _suppress_window() -> int:
    """返回 Windows 下隐藏子进程窗口的标志"""
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class CrmLogin:
    def __init__(self, cdp_controller: CDPController):
        self.cdp: CDPController = cdp_controller
        self.cred_mgr: CredentialManager = CredentialManager()
        self.logger: Logger = get_logger()
        self._script_dir = get_scripts_dir()
        self._node_script_path = script_path("crm-check.js")
        self.logger.debug(f"Node.js 脚本路径: {self._node_script_path}")

    def _node(self) -> str:
        return require_node_exe()

    def _run_node_script(self, command: str, args: Optional[list] = None) -> subprocess.CompletedProcess:
        node_exe = self._node()
        script = str(self._node_script_path)
        cmd = [node_exe, script, command]
        if args:
            cmd.extend(args)
        self.logger.debug(f"执行命令: {' '.join(cmd)}")
        self.logger.debug(f"Node.js 可执行文件: {node_exe}")
        self.logger.debug(f"脚本是否存在: {self._node_script_path.exists()}")
        try:
            return subprocess.run(
                cmd,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(self._script_dir),
                creationflags=_suppress_window(),
            )
        except FileNotFoundError as e:
            self.logger.error(f"找不到可执行文件: {node_exe}, 错误: {e}")
            raise RuntimeError(f"找不到 Node.js 可执行文件: {node_exe}") from e
        except Exception as e:
            self.logger.error(f"子进程执行异常: {type(e).__name__}: {e}")
            raise RuntimeError(f"子进程执行异常: {type(e).__name__}: {e}") from e

    def check_login_status(self) -> str:
        result = self._run_node_script("check-page")
        self.logger.debug(f"命令输出 stdout: {result.stdout[:500] if result.stdout else '(空)'}")
        self.logger.debug(f"命令输出 stderr: {result.stderr[:500] if result.stderr else '(空)'}")
        self.logger.debug(f"进程返回码: {result.returncode}")
        if result.returncode != 0:
            error_msg = result.stderr.strip() or result.stdout.strip() or "(无错误信息)"
            self.logger.error(f"crm-check check-page 失败 rc={result.returncode} stderr={result.stderr} stdout={result.stdout}")
            raise RuntimeError(f"crm-check.js failed: {error_msg}")
        output = result.stdout
        if "on login page" in output.lower():
            status = "login_required"
        elif "on chat audit page" in output.lower():
            status = "ready"
        else:
            status = "unknown"
        self.logger.info(f"CRM 登录状态: {status}")
        return status

    def login(self, username: Optional[str] = None, password: Optional[str] = None) -> None:
        if not username or not password:
            username, password = self.cred_mgr.load()
            if not username or not password:
                raise ValueError("No credentials available")
        result = self._run_node_script("fill-login", [
            "--username", username,
            "--password", password
        ])
        if result.returncode != 0:
            self.logger.error(f"crm-check fill-login 失败: {result.stderr}")
            raise RuntimeError(f"crm-check.js fill-login failed: {result.stderr}")
        self.logger.info("CRM 登录信息已填入浏览器")

    def navigate_to_audit(self) -> None:
        result = self._run_node_script("navigate-audit")
        if result.returncode != 0:
            self.logger.error(f"crm-check navigate-audit 失败: {result.stderr}")
            raise RuntimeError(f"crm-check.js navigate-audit failed: {result.stderr}")
        self.logger.info("已导航到聊天审计页面")

    def gate_check(self, dept: str, date: str) -> bool:
        result = self._run_node_script("gate-check", [
            "--expect-dept", dept,
            "--expect-date", date,
        ])
        gate_result = result.returncode == 0
        self.logger.info(f"Gate 检查: dept={dept}, date={date}, result={gate_result}")
        if not gate_result:
            self.logger.warning(f"gate-check 未通过 stderr={result.stderr} stdout={result.stdout}")
        return gate_result

    def gate_start_export(self, dept: str, date: str) -> bool:
        result = self._run_node_script("gate-start-export", [
            "--expect-dept", dept,
            "--expect-date", date,
        ])
        export_result = result.returncode == 0
        self.logger.info(f"Gate Start Export: dept={dept}, date={date}, result={export_result}")
        if not export_result:
            self.logger.warning(f"gate-start-export 未通过 stderr={result.stderr} stdout={result.stdout}")
        return export_result

    def set_dates(self, date: str) -> bool:
        result = self._run_node_script("set-dates", [
            "--date", date,
        ])
        success = result.returncode == 0
        self.logger.info(f"设置日期: {date}, result={success}")
        if not success:
            self.logger.warning(f"set-dates 失败 stderr={result.stderr} stdout={result.stdout}")
        return success

    def check_dates(self) -> str:
        result = self._run_node_script("check-dates")
        return result.stdout.strip() if result.returncode == 0 else ""

    def check_department(self) -> str:
        result = self._run_node_script("check-department")
        return result.stdout.strip() if result.returncode == 0 else ""

    def set_department(self, dept: str) -> bool:
        result = self._run_node_script("set-department", [
            "--group", dept,
        ])
        success = result.returncode == 0
        self.logger.info(f"设置部门: {dept}, result={success}")
        if not success:
            self.logger.warning(f"set-department 失败 stderr={result.stderr} stdout={result.stdout}")
        return success

    def diagnose_state(self, dept: str, date: str) -> dict:
        result = self._run_node_script("diagnose-state", [
            "--expect-dept", dept,
            "--expect-date", date,
        ])
        if result.returncode == 0:
            try:
                import json
                return json.loads(result.stdout)
            except:
                return {}
        return {}

    def navigate_audit(self) -> bool:
        result = self._run_node_script("navigate-audit")
        success = result.returncode == 0
        self.logger.info(f"导航到聊天审计页: result={success}")
        if not success:
            self.logger.warning(f"navigate-audit 失败 stderr={result.stderr} stdout={result.stdout}")
        return success