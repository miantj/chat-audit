"""项目常量定义"""
from typing import Final

# 应用名称
APP_NAME: Final[str] = "chat-audit-export"
APP_DISPLAY_NAME: Final[str] = "一手聊天审计导出工具"

# CDP 配置
CDP_DEFAULT_PORT: Final[int] = 9222
CDP_TIMEOUT: Final[int] = 2  # 连接超时时间（秒）

# CRM 配置
CRM_URL: Final[str] = "https://tmscrm.yishouapp.com/"

# Node.js 配置
NODE_VERSION: Final[str] = "22.13.1"
NODE_URL_BASE: Final[str] = f"https://nodejs.org/dist/v{NODE_VERSION}"
NODE_ALT_URL_BASE: Final[str] = f"https://npmmirror.com/mirrors/node/v{NODE_VERSION}"
NODE_ZIP_NAME: Final[str] = f"node-v{NODE_VERSION}-win-x64.zip"
NODE_DIR_NAME: Final[str] = f"node-v{NODE_VERSION}-win-x64"

# 默认值
DEFAULT_DEPT: Final[str] = "大客私域顾问-总"
DEFAULT_OUTPUT_DIR: Final[str] = ""

# 浏览器启动参数
CHROME_ARGS: Final[list] = [
    "--remote-allow-origins=*",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-infobars",
    "--disable-extensions",
    "--disable-popup-blocking",
]

# 路径相关
APP_DATA_DIR: Final[str] = "chat-audit-export"
CHROME_PROFILE_SUBDIR: Final[str] = "chrome-cdp-profile"
EDGE_PROFILE_SUBDIR: Final[str] = "edge-cdp-profile"
NODE_INSTALL_SUBDIR: Final[str] = "nodejs"
LOGS_SUBDIR: Final[str] = "logs"

# 错误消息
ERROR_BROWSER_NOT_FOUND: Final[str] = "找不到 Chrome/Edge 浏览器"
ERROR_NODE_INSTALL_FAILED: Final[str] = "Node.js 安装失败，请检查网络后重试"
ERROR_CHROME_NOT_CONNECTED: Final[str] = "Chrome 未连接，请确认已启动调试端口"
ERROR_CRM_NOT_READY: Final[str] = "CRM 未准备好，请检查登录状态"

# 超时设置
BROWSER_START_TIMEOUT: Final[int] = 15  # 浏览器启动超时（秒）
EXPORT_TIMEOUT: Final[int] = 3600  # 导出超时（秒）