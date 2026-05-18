# chat-audit-export-gui/run.py
import os
import sys
import ctypes
import ctypes.wintypes as wintypes

APP_MUTEX_NAME = "Global\\ChatAuditExport_SingleInstance"

class SingleInstance:
    def __init__(self):
        self.mutex = None
        self.acquired = False

    def acquire(self) -> bool:
        kernel32 = ctypes.windll.kernel32
        self.mutex = kernel32.CreateMutexW(None, False, APP_MUTEX_NAME)
        if not self.mutex:
            return False

        ERROR_ALREADY_EXISTS = 183
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(self.mutex)
            self.mutex = None
            return False

        self.acquired = True
        return True

    def release(self):
        if self.mutex:
            ctypes.windll.kernel32.CloseHandle(self.mutex)
            self.mutex = None
            self.acquired = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()


if __name__ == "__main__":
    instance = SingleInstance()
    if not instance.acquire():
        ctypes.windll.user32.MessageBoxW(0, "程序已在运行中，请勿重复启动。", "提示", 0x30)
        sys.exit(1)

    try:
        from app.main import MainWindow
        app = MainWindow()
        app.run()
    finally:
        instance.release()