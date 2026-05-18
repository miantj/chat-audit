import logging
import os
import re
from datetime import datetime
from typing import Optional

_SENSITIVE_PATTERNS = [
    re.compile(r'(password|pwd|secret)\s*[=:]\s*["\']?([^"\'\s]+)["\']?', re.IGNORECASE),
    re.compile(r'(token|api[_-]?key|secret[_-]?key|access[_-]?key)\s*[=:]\s*["\']?([^"\'\s]+)["\']?', re.IGNORECASE),
    re.compile(r'(cookie|session)\s*[=:]\s*["\']?([^"\'\s]+)["\']?', re.IGNORECASE),
    re.compile(r'[?&](password|token|secret)=([^&]+)', re.IGNORECASE),
]
_DAILY_LOG_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.log$")

def _sanitize_message(message: str) -> str:
    result = message
    for pattern in _SENSITIVE_PATTERNS:
        result = pattern.sub(r'\1=***', result)
    return result

class SanitizingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        original_message = record.getMessage()
        record.msg = _sanitize_message(original_message)
        return super().format(record)

def _get_log_dir() -> str:
    app_data = os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming"))
    log_dir = os.path.join(app_data, "chat-audit-export", "logs")
    os.makedirs(log_dir, exist_ok=True)
    return log_dir

def _get_latest_marker_path() -> str:
    return os.path.join(_get_log_dir(), ".latest")

def _read_latest_log() -> Optional[str]:
    marker = _get_latest_marker_path()
    if os.path.exists(marker):
        try:
            with open(marker, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            pass
    return None

def _write_latest_log(path: str) -> None:
    marker = _get_latest_marker_path()
    try:
        with open(marker, "w", encoding="utf-8") as f:
            f.write(path)
    except Exception:
        pass

def get_daily_log_path(for_date: Optional[datetime] = None) -> str:
    """按自然日一个文件，例如 2026-05-16.log"""
    day = (for_date or datetime.now()).strftime("%Y-%m-%d")
    return os.path.join(_get_log_dir(), f"{day}.log")

def _update_app_log_link(target: str) -> None:
    """维护 app.log 指向当天日志（便于手动查找）"""
    latest_link = os.path.join(_get_log_dir(), "app.log")
    if os.path.exists(latest_link):
        try:
            if os.path.islink(latest_link) or not os.path.samefile(latest_link, target):
                os.remove(latest_link)
            else:
                return
        except OSError:
            try:
                os.remove(latest_link)
            except OSError:
                pass
    try:
        os.symlink(target, latest_link)
    except OSError:
        _write_latest_log(target)

def get_log_file_path() -> str:
    """当天日志路径；同一天内多次启动写入同一文件"""
    log_file = get_daily_log_path()
    _update_app_log_link(log_file)
    return log_file

def get_latest_log_path() -> str:
    """获取最新日志文件路径（优先今天，不新建文件）"""
    today = get_daily_log_path()
    if os.path.isfile(today):
        return today

    log_dir = _get_log_dir()
    latest_link = os.path.join(log_dir, "app.log")
    if os.path.exists(latest_link):
        return os.path.realpath(latest_link) if os.path.islink(latest_link) else latest_link

    marker = _read_latest_log()
    if marker and os.path.exists(marker):
        return marker

    daily_logs = sorted(
        (
            os.path.join(log_dir, name)
            for name in os.listdir(log_dir)
            if _DAILY_LOG_RE.match(name)
        ),
        key=os.path.getmtime,
        reverse=True,
    )
    if daily_logs:
        return daily_logs[0]
    return today

def get_active_log_path() -> str:
    """当前 logger 正在写入的日志路径；若无 handler 则回退到当天/最新日志"""
    logger = logging.getLogger("chat-audit-export")
    for handler in logger.handlers:
        if isinstance(handler, logging.FileHandler):
            return handler.baseFilename
    return get_latest_log_path()

def _ensure_file_handler(logger: logging.Logger, log_file: str) -> None:
    """确保 file handler 指向指定日志文件（跨天自动切换）"""
    norm_target = os.path.normcase(os.path.abspath(log_file))
    for handler in list(logger.handlers):
        if not isinstance(handler, logging.FileHandler):
            continue
        if os.path.normcase(os.path.abspath(handler.baseFilename)) == norm_target:
            return
        logger.removeHandler(handler)
        handler.close()

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_format = SanitizingFormatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    file_handler.setFormatter(file_format)
    logger.addHandler(file_handler)

def get_logger(name: str = "chat-audit-export") -> logging.Logger:
    log_file = get_log_file_path()
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    _ensure_file_handler(logger, log_file)

    if not any(isinstance(h, logging.StreamHandler) for h in logger.handlers):
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        console_format = SanitizingFormatter("[%(levelname)s] %(message)s")
        console_handler.setFormatter(console_format)
        logger.addHandler(console_handler)

    return logger

def sanitize_text(text: str) -> str:
    return _sanitize_message(text)
