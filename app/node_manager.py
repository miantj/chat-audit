import os
import subprocess
import urllib.request
import zipfile
import shutil
import time
from typing import Optional, Callable
from pathlib import Path
from app.logger import get_logger
from app.constants import (
    NODE_VERSION,
    NODE_URL_BASE,
    NODE_ALT_URL_BASE,
    NODE_ZIP_NAME,
    NODE_DIR_NAME,
    APP_DATA_DIR,
    NODE_INSTALL_SUBDIR,
)

class NodeManager:
    """Node.js 安装和管理"""

    def __init__(self):
        self.node_path: Optional[str] = None
        self.app_data = os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming"))
        self.install_base = os.path.join(self.app_data, APP_DATA_DIR)
        self.node_install_dir = os.path.join(self.install_base, NODE_INSTALL_SUBDIR)
        self.logger = get_logger()

    def check_node(self) -> bool:
        """检查 Node.js 是否已安装"""
        # 先检查 PATH
        node_path = shutil.which("node")
        self.logger.debug(f"检查 Node.js: path={node_path}")
        if node_path and os.path.exists(node_path):
            self.node_path = node_path
            self.logger.info(f"在 PATH 中找到 Node.js: {node_path}")
            return True

        # 检查自定义安装位置（即使 PATH 未刷新也能找到）
        custom_node = os.path.join(self.node_install_dir, "node.exe")
        if os.path.exists(custom_node):
            self.node_path = custom_node
            self.logger.info(f"在自定义位置找到 Node.js: {custom_node}")
            # 更新当前进程的 PATH（Windows）
            self._refresh_path()
            return True

        return False

    def _refresh_path(self):
        """从注册表刷新当前进程的 PATH"""
        try:
            result = subprocess.run(
                ["powershell", "-Command", "[Environment]::GetEnvironmentVariable('Path', 'User')"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            user_path = result.stdout.strip()
            if user_path:
                os.environ["PATH"] = os.environ.get("PATH", "") + ";" + user_path
                self.logger.debug("已刷新进程 PATH")
        except subprocess.TimeoutExpired:
            self.logger.debug("刷新 PATH 超时")
        except Exception as e:
            self.logger.debug(f"刷新 PATH 失败: {str(e)}")

    def get_download_url(self, use_mirror: bool = False) -> str:
        """获取 Node.js 下载 URL"""
        base = NODE_ALT_URL_BASE if use_mirror else NODE_URL_BASE
        return f"{base}/{NODE_ZIP_NAME}"

    def _ensure_directory(self, path: str):
        """确保目录存在"""
        os.makedirs(path, exist_ok=True)

    def _add_to_user_path(self, install_dir: str):
        """将 Node.js 添加到用户 PATH"""
        node_exe_dir = install_dir

        try:
            # 获取当前用户 PATH
            result = subprocess.run(
                ["powershell", "-Command", "[Environment]::GetEnvironmentVariable('Path', 'User')"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            current_path = result.stdout.strip()

            # 如果不在 PATH 中则添加
            if node_exe_dir not in current_path:
                new_path = f"{current_path};{node_exe_dir}" if current_path else node_exe_dir
                subprocess.run(
                    ["setx", "Path", new_path],
                    capture_output=True,
                    timeout=30,
                )
                self.logger.info(f"已将 Node.js 添加到用户 PATH: {node_exe_dir}")
            else:
                self.logger.debug("Node.js 已在用户 PATH 中")

            # 立即添加到当前进程 PATH，确保本次运行可用
            current_process_path = os.environ.get("PATH", "")
            if node_exe_dir not in current_process_path:
                os.environ["PATH"] = f"{current_process_path};{node_exe_dir}"
                self.logger.debug(f"已将 Node.js 添加到当前进程 PATH")
        except subprocess.TimeoutExpired:
            self.logger.error("设置 PATH 超时")
        except Exception as e:
            self.logger.error(f"设置 PATH 失败: {str(e)}")

    def install_node(self, progress_callback: Optional[Callable[[int], None]] = None) -> bool:
        """下载并安装 Node.js"""
        if self.check_node():
            self.logger.info("Node.js 已安装，跳过安装步骤")
            return True

        self.logger.info(f"开始下载 Node.js {NODE_VERSION}...")

        self._ensure_directory(self.install_base)

        zip_path = os.path.join(self.install_base, NODE_ZIP_NAME)
        extract_dir = self.node_install_dir

        def report_progress(block_num: int, block_size: int, total_size: int):
            if progress_callback and callable(progress_callback) and total_size > 0:
                progress = int((block_num * block_size) / total_size * 100)
                progress_callback(progress)

        # 先尝试主站下载
        download_succeeded = False
        try:
            url = self.get_download_url(use_mirror=False)
            self.logger.info(f"从主站下载: {url}")
            urllib.request.urlretrieve(url, zip_path, reporthook=report_progress)
            download_succeeded = True
        except urllib.error.HTTPError as e:
            self.logger.warning(f"主站下载失败 ({e.code})，尝试镜像站")
        except urllib.error.URLError as e:
            self.logger.warning(f"主站下载失败 ({str(e)})，尝试镜像站")
        except Exception as e:
            self.logger.warning(f"主站下载失败: {str(e)}，尝试镜像站")

        # 主站失败则尝试镜像站
        if not download_succeeded:
            try:
                url = self.get_download_url(use_mirror=True)
                self.logger.info(f"从镜像站下载: {url}")
                urllib.request.urlretrieve(url, zip_path, reporthook=report_progress)
                download_succeeded = True
            except Exception as e:
                self.logger.error(f"镜像站下载也失败: {str(e)}")
                return False

        # 解压安装
        try:
            self.logger.info(f"开始解压 Node.js 到: {extract_dir}")
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(self.install_base)

            # 重命名目录
            extracted_path = os.path.join(self.install_base, NODE_DIR_NAME)
            if os.path.exists(extract_dir):
                shutil.rmtree(extract_dir)
            os.rename(extracted_path, extract_dir)

            # 清理安装包
            os.remove(zip_path)
            self.logger.debug(f"已删除安装包: {zip_path}")

            # 添加到 PATH
            self._add_to_user_path(extract_dir)

            self.node_path = os.path.join(extract_dir, "node.exe")
            self.logger.info(f"Node.js {NODE_VERSION} 安装成功: {self.node_path}")
            return True

        except zipfile.BadZipFile:
            self.logger.error("下载的安装包损坏")
            return False
        except PermissionError:
            self.logger.error("没有权限解压或写入文件")
            return False
        except Exception as e:
            self.logger.error(f"安装 Node.js 异常: {str(e)}", exc_info=True)
            return False

    def verify_install(self) -> bool:
        """验证 Node.js 是否可执行"""
        if not self.node_path:
            return False
        try:
            result = subprocess.run(
                [self.node_path, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                version = result.stdout.strip()
                self.logger.debug(f"Node.js 版本验证通过: {version}")
                return True
            else:
                self.logger.warning(f"Node.js 执行失败: {result.stderr}")
                return False
        except FileNotFoundError:
            self.logger.error(f"Node.js 文件不存在: {self.node_path}")
            return False
        except subprocess.TimeoutExpired:
            self.logger.error("Node.js 版本检查超时")
            return False
        except Exception as e:
            self.logger.error(f"验证 Node.js 异常: {str(e)}", exc_info=True)
            return False
        return False

    def wait_for_install(self, timeout: int = 120) -> bool:
        """等待 Node.js 安装完成（带超时）"""
        start_time = time.time()
        while time.time() - start_time < timeout:
            if self.check_node():
                return True
            time.sleep(1)
        self.logger.error(f"Node.js 安装超时 ({timeout}秒)")
        return False