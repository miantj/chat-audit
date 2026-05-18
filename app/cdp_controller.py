import requests
import subprocess
import os
import shutil
from typing import Optional
from app.logger import get_logger
from app.constants import (
    CDP_DEFAULT_PORT,
    CRM_URL,
    CHROME_ARGS,
    APP_DATA_DIR,
    CHROME_PROFILE_SUBDIR,
    EDGE_PROFILE_SUBDIR,
)

class CDPController:
    """Chrome DevTools Protocol 控制器"""

    def __init__(self, port: int = CDP_DEFAULT_PORT):
        self.port = port
        self.cdp_base = f"http://localhost:{port}"
        self.logger = get_logger()

    def check_chrome(self) -> bool:
        """检查 Chrome/Edge 是否在调试模式下运行"""
        try:
            resp = requests.get(f"{self.cdp_base}/json/version", timeout=2)
            result = resp.status_code == 200
            if result:
                self.logger.debug(f"CDP 连接成功: {self.cdp_base}")
            return result
        except requests.exceptions.Timeout:
            self.logger.debug(f"CDP 连接超时: {self.cdp_base}")
            return False
        except requests.exceptions.ConnectionError:
            self.logger.debug(f"CDP 连接失败: {self.cdp_base}")
            return False
        except Exception as e:
            self.logger.error(f"CDP 检查异常: {str(e)}", exc_info=True)
            return False

    def get_chrome_version(self) -> Optional[str]:
        """获取浏览器版本信息"""
        try:
            resp = requests.get(f"{self.cdp_base}/json/version", timeout=2)
            data = resp.json()
            version = data.get("Browser", "Unknown")
            self.logger.debug(f"浏览器版本: {version}")
            return version
        except requests.exceptions.RequestException as e:
            self.logger.debug(f"获取浏览器版本失败: {str(e)}")
            return None
        except Exception as e:
            self.logger.error(f"获取浏览器版本异常: {str(e)}", exc_info=True)
            return None

    def get_debugger_url(self) -> Optional[str]:
        """获取调试器 WebSocket URL"""
        try:
            resp = requests.get(f"{self.cdp_base}/json/new", timeout=2)
            url = resp.json().get("webSocketDebuggerUrl")
            if url:
                self.logger.debug(f"获取调试器 URL: {url[:50]}...")
            return url
        except requests.exceptions.RequestException as e:
            self.logger.debug(f"获取调试器 URL 失败: {str(e)}")
            return None
        except Exception as e:
            self.logger.error(f"获取调试器 URL 异常: {str(e)}", exc_info=True)
            return None

    def _get_app_data_path(self) -> str:
        """获取应用数据目录路径"""
        appdata = os.environ.get("APPDATA")
        if not appdata:
            appdata = os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
        return os.path.join(appdata, APP_DATA_DIR)

    def get_persistent_profile_dir(self, browser_path: str) -> str:
        """
        获取专用用户数据目录，与日常浏览器配置分离，避免多开冲突；
        同一路径反复启动可保留 Cookie、LocalStorage、缓存等登录状态。
        """
        base = self._get_app_data_path()
        low = (browser_path or "").lower().replace("/", os.sep)
        if "msedge" in low or "microsoft" + os.sep + "edge" in low:
            sub = EDGE_PROFILE_SUBDIR
        else:
            sub = CHROME_PROFILE_SUBDIR
        path = os.path.join(base, sub)
        os.makedirs(path, exist_ok=True)
        self.logger.info(f"浏览器用户数据目录: {path}")
        return path

    def _search_registry(self, key_path: str) -> Optional[str]:
        try:
            result = subprocess.run(
                ['reg', 'query', key_path],
                capture_output=True, encoding="gbk", errors="replace", timeout=5
            )
            for line in result.stdout.splitlines():
                if "Path" in line:
                    parts = line.split("Path", 1)
                    if len(parts) > 1:
                        path = parts[1].strip().split(";")[0].strip().strip('"')
                        if path and os.path.exists(path):
                            return path
        except subprocess.TimeoutExpired:
            self.logger.debug(f"注册表查询超时: {key_path}")
        except Exception as e:
            self.logger.debug(f"搜索注册表失败: {str(e)}")
        return None

    def find_chrome_path(self) -> Optional[str]:
        """查找 Chrome/Edge 浏览器路径"""
        if chrome_in_path := shutil.which("chrome") or shutil.which("google-chrome"):
            if os.path.exists(chrome_in_path):
                self.logger.info(f"从 PATH 找到 Chrome: {chrome_in_path}")
                return chrome_in_path

        if os.name == "nt":
            if edge_path := shutil.which("msedge") or shutil.which("MicrosoftEdge"):
                if os.path.exists(edge_path):
                    self.logger.info(f"从 PATH 找到 Edge: {edge_path}")
                    return edge_path

            if path := self._search_registry('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'):
                self.logger.info(f"从注册表找到 Chrome: {path}")
                return path

            if path := self._search_registry('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe'):
                self.logger.info(f"从注册表找到 Edge: {path}")
                return path

        common_paths = [
            os.path.join(os.environ.get("PROGRAMFILES", ""), "Google\\Chrome\\Application\\chrome.exe"),
            os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Google\\Chrome\\Application\\chrome.exe"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google\\Chrome\\Application\\chrome.exe"),
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            os.path.join(os.environ.get("PROGRAMFILES", ""), "Microsoft\\Edge\\Application\\msedge.exe"),
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
        for path in common_paths:
            if os.path.exists(path):
                self.logger.info(f"从常见路径找到浏览器: {path}")
                return path

        self.logger.warning("未找到任何浏览器 (Chrome/Edge)")
        return None

    def launch_chrome(self) -> bool:
        """启动浏览器并开启远程调试端口"""
        browser_path = self.find_chrome_path()
        if not browser_path:
            self.logger.error("无法启动浏览器：未找到浏览器路径")
            return False

        try:
            profile_dir = self.get_persistent_profile_dir(browser_path)
            cmd = [
                browser_path,
                f"--remote-debugging-port={self.port}",
                f"--user-data-dir={profile_dir}",
            ] + CHROME_ARGS + [CRM_URL]

            self.logger.info(f"启动浏览器: {browser_path}")
            self.logger.debug(f"浏览器启动参数: {' '.join(cmd)}")

            subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            return True

        except FileNotFoundError:
            self.logger.error(f"浏览器文件不存在: {browser_path}")
            return False
        except PermissionError:
            self.logger.error(f"没有权限启动浏览器: {browser_path}")
            return False
        except Exception as e:
            self.logger.error(f"启动浏览器异常: {str(e)}", exc_info=True)
            return False