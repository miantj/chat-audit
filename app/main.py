import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import datetime
import os
import threading
import time
from typing import Optional
from app.cdp_controller import CDPController
from app.crm_login import CrmLogin
from app.export_orchestrator import ExportOrchestrator
from app.node_manager import NodeManager
from app.ui_components import ErrorDialog
from app.logger import get_logger, get_active_log_path
from app.ui_preferences import load_ui_preferences, save_ui_preferences
from app.constants import (
    APP_DISPLAY_NAME,
    DEFAULT_DEPT,
    BROWSER_START_TIMEOUT,
)

class DatePicker(ttk.Frame):
    """自定义日期选择器组件"""

    def __init__(self, parent, on_change=None, **kwargs):
        super().__init__(parent, **kwargs)
        self._date: Optional[datetime.date] = None
        self._on_change = on_change
        self.logger = get_logger()
        self._build_ui()

    def _build_ui(self):
        """构建日期选择器 UI"""
        self._date_var = tk.StringVar()
        entry = ttk.Entry(self, textvariable=self._date_var, width=12, font=("Microsoft YaHei", 11))
        entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        if self._on_change:
            entry.bind("<FocusOut>", lambda e: self._on_change())

        self._cal_btn = ttk.Button(self, text="日历", width=6, command=self._show_calendar)
        self._cal_btn.pack(side=tk.RIGHT)

        # 设置默认日期为今天（不触发 on_change）
        self.set_date(datetime.date.today(), suppress_callback=True)
        self.logger.debug(f"DatePicker 初始化完成，日期={self._date_var.get()}")

    def get_date(self) -> str:
        """获取当前日期字符串"""
        result = self._date_var.get()
        self.logger.debug(f"获取日期: {result}")
        return result

    def set_date(self, date, suppress_callback=False):
        """设置日期"""
        if isinstance(date, str):
            try:
                date = datetime.datetime.strptime(date, "%Y-%m-%d").date()
            except ValueError:
                date = datetime.date.today()
        self._date = date
        self._date_var.set(date.strftime("%Y-%m-%d"))
        if not suppress_callback and self._on_change:
            self._on_change()

    def _show_calendar(self):
        """显示日历弹窗"""
        self.logger.debug("显示日历弹窗")
        CalendarDialog(self.winfo_toplevel(), self._set_date)

    def _set_date(self, date):
        """设置选中的日期"""
        self.logger.debug(f"选择日期: {date}")
        self._date = date
        self._date_var.set(date.strftime("%Y-%m-%d"))
        if self._on_change:
            self._on_change()


class CalendarDialog:
    """日历选择弹窗"""

    def __init__(self, parent, callback):
        self.callback = callback
        self.date = datetime.date.today()

        self.win = tk.Toplevel(parent)
        self.win.title("选择日期")
        self.win.geometry("300x320")
        self.win.resizable(False, False)
        self.win.transient(parent)
        self.win.grab_set()

        self._build_ui()

    def _build_ui(self):
        """构建日历 UI"""
        # 标题栏
        title_frame = tk.Frame(self.win, bg="#3498db", height=40)
        title_frame.pack(fill=tk.X)
        title_frame.pack_propagate(False)

        self._prev_btn = tk.Button(
            title_frame, text="◀", bd=0, bg="#3498db", fg="white",
            font=("Microsoft YaHei", 12), command=self._prev_month
        )
        self._prev_btn.pack(side=tk.LEFT, padx=10, pady=8)

        self._month_label = tk.Label(
            title_frame, bg="#3498db", fg="white",
            font=("Microsoft YaHei", 14, "bold")
        )
        self._month_label.pack(side=tk.LEFT, expand=True)

        self._next_btn = tk.Button(
            title_frame, text="▶", bd=0, bg="#3498db", fg="white",
            font=("Microsoft YaHei", 12), command=self._next_month
        )
        self._next_btn.pack(side=tk.RIGHT, padx=10, pady=8)

        # 星期标题
        days_frame = tk.Frame(self.win)
        days_frame.pack(fill=tk.X, pady=(10, 0))
        for i, day in enumerate(["一", "二", "三", "四", "五", "六", "日"]):
            tk.Label(days_frame, text=day, font=("Microsoft YaHei", 10), width=4).grid(row=0, column=i)

        # 日期网格
        self._grid_frame = tk.Frame(self.win)
        self._grid_frame.pack(padx=10, pady=10)

        self._build_grid()

    def _build_grid(self):
        """构建日期网格"""
        # 清空现有控件
        for widget in self._grid_frame.winfo_children():
            widget.destroy()

        self._month_label.config(text=f"{self.date.year}年{self.date.month}月")

        # 获取月首和月末
        first_day = datetime.date(self.date.year, self.date.month, 1)
        if self.date.month == 12:
            last_day = datetime.date(self.date.year + 1, 1, 1) - datetime.timedelta(days=1)
        else:
            last_day = datetime.date(self.date.year, self.date.month + 1, 1) - datetime.timedelta(days=1)

        # 月首日是星期几
        start_weekday = first_day.weekday()

        # 构建网格
        row = 0
        col = start_weekday
        for day in range(1, last_day.day + 1):
            date = datetime.date(self.date.year, self.date.month, day)
            btn = tk.Button(
                self._grid_frame, text=str(day), font=("Microsoft YaHei", 10),
                width=4, height=2, bg="#ecf0f1", activebackground="#3498db",
                command=lambda d=date: self._select(d)
            )
            btn.grid(row=row, column=col, padx=2, pady=2)
            col += 1
            if col > 6:
                col = 0
                row += 1

    def _prev_month(self):
        """切换到上一月"""
        if self.date.month == 1:
            self.date = datetime.date(self.date.year - 1, 12, 1)
        else:
            self.date = datetime.date(self.date.year, self.date.month - 1, 1)
        self._build_grid()

    def _next_month(self):
        """切换到下一月"""
        if self.date.month == 12:
            self.date = datetime.date(self.date.year + 1, 1, 1)
        else:
            self.date = datetime.date(self.date.year, self.date.month + 1, 1)
        self._build_grid()

    def _select(self, date):
        """选择日期"""
        self.callback(date)
        self.win.destroy()


class MainWindow:
    """主窗口类"""

    def __init__(self):
        self.logger = get_logger()
        self.logger.info("应用启动")

        self.root = tk.Tk()
        self.root.title(APP_DISPLAY_NAME)
        self.root.geometry("680x600")
        self.root.configure(bg="#f5f6fa")

        self.cdp = CDPController()
        self.login = CrmLogin(self.cdp)
        self.orchestrator = ExportOrchestrator()
        self.node_manager = NodeManager()
        self.export_process = None

        # 样式配置
        self._style = ttk.Style()
        self._style.configure("Title.TLabel", font=("Microsoft YaHei", 16, "bold"), background="#f5f6fa")
        self._style.configure("Header.TLabel", font=("Microsoft YaHei", 12, "bold"), background="#f5f6fa", foreground="#2c3e50")
        self._style.configure("Info.TLabel", font=("Microsoft YaHei", 10), background="#f5f6fa", foreground="#7f8c8d")
        self._style.configure("Card.TFrame", background="#ffffff", relief=tk.RAISED, borderwidth=1)

        self._build_ui()

    def _build_ui(self):
        """构建主界面"""
        # 标题栏
        title_frame = tk.Frame(self.root, bg="#3498db", height=60)
        title_frame.pack(fill=tk.X)
        title_frame.pack_propagate(False)
        title_label = tk.Label(
            title_frame, text=APP_DISPLAY_NAME, bg="#3498db", fg="white",
            font=("Microsoft YaHei", 20, "bold")
        )
        title_label.pack(pady=15)

        # 主内容区
        content = tk.Frame(self.root, bg="#f5f6fa")
        content.pack(fill=tk.BOTH, expand=True, padx=20, pady=20)

        # === 状态卡片 ===
        status_card = ttk.Frame(content, style="White.TFrame")
        status_card.pack(fill=tk.X, pady=(0, 15))
        self._style.configure("White.TFrame", background="white")

        tk.Label(status_card, text="系统状态", font=("Microsoft YaHei", 12, "bold"), fg="#2c3e50", bg="white") \
            .grid(row=0, column=0, columnspan=4, padx=15, pady=(12, 8), sticky="w")

        # Chrome 状态
        tk.Label(status_card, text="Chrome:", font=("Microsoft YaHei", 11)) \
            .grid(row=1, column=0, padx=(15, 5), pady=5, sticky="w")
        self.chrome_status = tk.Label(status_card, text="● 检测中", font=("Microsoft YaHei", 11), fg="#7f8c8d")
        self.chrome_status.grid(row=1, column=1, padx=(0, 20), sticky="w")
        chrome_btn_row = tk.Frame(status_card)
        chrome_btn_row.grid(row=1, column=2, padx=(0, 5), pady=5, sticky="w")
        tk.Button(chrome_btn_row, text="启动 Chrome", command=self._start_chrome, width=11).pack(side=tk.LEFT, padx=(0, 6))
        tk.Button(chrome_btn_row, text="打开日志", command=self._open_log_file, width=9).pack(side=tk.LEFT)

        # Node.js 状态
        tk.Label(status_card, text="Node.js:", font=("Microsoft YaHei", 11)) \
            .grid(row=2, column=0, padx=(15, 5), pady=(0, 12), sticky="w")
        self.node_status = tk.Label(status_card, text="● 检测中", font=("Microsoft YaHei", 11), fg="#7f8c8d")
        self.node_status.grid(row=2, column=1, padx=(0, 20), sticky="w")
        self.node_progress = ttk.Progressbar(status_card, mode="determinate", length=120)
        self.node_progress.grid(row=2, column=2, padx=(0, 5), pady=(0, 5))

        # CRM 状态
        tk.Label(status_card, text="CRM:", font=("Microsoft YaHei", 11)) \
            .grid(row=3, column=0, padx=(15, 5), pady=(0, 12), sticky="w")
        self.crm_status_label = tk.Label(status_card, text="● 未检测", font=("Microsoft YaHei", 11), fg="#7f8c8d")
        self.crm_status_label.grid(row=3, column=1, padx=(0, 10), pady=(0, 12), sticky="w")
        tk.Label(
            status_card,
            text="请在浏览器中登录 CRM；通过「启动 Chrome」打开的窗口会保存登录状态。",
            font=("Microsoft YaHei", 9),
            fg="#7f8c8d",
            wraplength=400,
            justify=tk.LEFT,
        ).grid(row=4, column=0, columnspan=2, padx=(15, 5), pady=(0, 8), sticky="w")
        tk.Button(status_card, text="刷新 CRM 状态", command=self._refresh_crm_status, width=14) \
            .grid(row=3, column=2, rowspan=2, padx=(0, 15), pady=(0, 12), sticky="ne")

        # === 导出设置卡片 ===
        export_card = ttk.Frame(content, style="White.TFrame")
        export_card.pack(fill=tk.X, pady=(0, 15))

        export_card.columnconfigure(1, weight=1)
        export_card.columnconfigure(3, weight=1)

        tk.Label(export_card, text="导出设置", font=("Microsoft YaHei", 12, "bold"), fg="#2c3e50", bg="white") \
            .grid(row=0, column=0, columnspan=4, padx=15, pady=(12, 2), sticky="w")
        tk.Label(
            export_card,
            text="已自动记住上次开始/结束日期、输出目录与部门（关闭窗口时也会保存）",
            font=("Microsoft YaHei", 9),
            fg="#95a5a6",
            bg="white",
        ).grid(row=1, column=0, columnspan=4, padx=15, pady=(0, 8), sticky="w")

        # 日期设置
        tk.Label(export_card, text="开始日期:", font=("Microsoft YaHei", 11)) \
            .grid(row=2, column=0, padx=(15, 5), pady=5, sticky="w")
        self.start_date_picker = DatePicker(export_card, on_change=self._schedule_save_ui_preferences)
        self.start_date_picker.grid(row=2, column=1, padx=(0, 20), sticky="ew")

        tk.Label(export_card, text="结束日期:", font=("Microsoft YaHei", 11)) \
            .grid(row=2, column=2, padx=(0, 5), sticky="w")
        self.end_date_picker = DatePicker(export_card, on_change=self._schedule_save_ui_preferences)
        self.end_date_picker.grid(row=2, column=3, padx=(0, 15), sticky="ew")

        # 部门设置
        tk.Label(export_card, text="部门:", font=("Microsoft YaHei", 11)) \
            .grid(row=3, column=0, padx=(15, 5), pady=(5, 12), sticky="w")
        self.dept_var = tk.StringVar(value=DEFAULT_DEPT)
        dept_entry = tk.Entry(export_card, textvariable=self.dept_var, width=25, font=("Microsoft YaHei", 11))
        dept_entry.grid(row=3, column=1, columnspan=3, padx=(0, 15), pady=(5, 12), sticky="w")
        dept_entry.bind("<FocusOut>", lambda e: self._schedule_save_ui_preferences())

        # 输出目录设置
        tk.Label(export_card, text="输出目录:", font=("Microsoft YaHei", 11)) \
            .grid(row=4, column=0, padx=(15, 5), pady=(0, 12), sticky="w")
        self.output_dir_var = tk.StringVar()
        output_entry = tk.Entry(export_card, textvariable=self.output_dir_var, width=25, font=("Microsoft YaHei", 11))
        output_entry.grid(row=4, column=1, padx=(0, 5), pady=(0, 12), sticky="ew")
        output_entry.bind("<FocusOut>", lambda e: self._schedule_save_ui_preferences())
        tk.Button(export_card, text="选择...", command=self._select_output_dir, width=8) \
            .grid(row=4, column=2, padx=(0, 15), pady=(0, 12), sticky="w")

        # === 按钮区 ===
        btn_frame = tk.Frame(content, bg="#f5f6fa")
        btn_frame.pack(pady=(5, 0))

        self.start_btn = tk.Button(
            btn_frame, text="开始导出", command=self._start_export,
            bg="#3498db", fg="white", font=("Microsoft YaHei", 14, "bold"),
            width=15, height=2, bd=0, activebackground="#2980b9"
        )
        self.start_btn.pack(side=tk.LEFT, padx=10)

        self.stop_btn = tk.Button(
            btn_frame, text="停止", command=self._stop_export,
            bg="#e74c3c", fg="white", font=("Microsoft YaHei", 14, "bold"),
            width=15, height=2, bd=0, state=tk.DISABLED, activebackground="#c0392b"
        )
        self.stop_btn.pack(side=tk.LEFT, padx=10)

        # === 进度展示 ===
        progress_frame = tk.Frame(content, bg="#f5f6fa")
        progress_frame.pack(fill=tk.X, pady=(15, 0))

        self.progress_label = tk.Label(progress_frame, text="", font=("Microsoft YaHei", 11), bg="#f5f6fa")
        self.progress_label.pack(anchor="w")

        self.progress_bar = ttk.Progressbar(progress_frame, mode="determinate", length=620)
        self.progress_bar.pack(pady=(5, 0))

        self.detail_label = tk.Label(progress_frame, text="", font=("Microsoft YaHei", 9), fg="#7f8c8d", bg="#f5f6fa")
        self.detail_label.pack(anchor="w", pady=(3, 0))

        # 初始化状态
        self._prefs_loading = False
        self._save_prefs_job = None
        self._apply_ui_preferences()

        # 启动检查
        self._check_chrome()
        self._refresh_crm_status()
        self._check_node()

    def _apply_ui_preferences(self):
        """应用保存的界面偏好"""
        prefs = load_ui_preferences()
        if not prefs:
            return
        self._prefs_loading = True
        try:
            if prefs.get("start_date"):
                self.start_date_picker.set_date(prefs["start_date"], suppress_callback=True)
            if prefs.get("end_date"):
                self.end_date_picker.set_date(prefs["end_date"], suppress_callback=True)
            if prefs.get("dept"):
                self.dept_var.set(prefs["dept"])
            od = (prefs.get("output_dir") or "").strip()
            if od:
                self.output_dir_var.set(od)
        finally:
            self._prefs_loading = False
        self.logger.info("已加载上次保存的导出设置")

    def _schedule_save_ui_preferences(self):
        """延迟保存界面偏好（防抖）"""
        if getattr(self, "_prefs_loading", False):
            return
        job = getattr(self, "_save_prefs_job", None)
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass
        self._save_prefs_job = self.root.after(400, self._save_ui_preferences)

    def _collect_ui_preferences(self) -> dict:
        """收集当前界面偏好"""
        return {
            "start_date": self.start_date_picker.get_date(),
            "end_date": self.end_date_picker.get_date(),
            "output_dir": self.output_dir_var.get().strip(),
            "dept": self.dept_var.get().strip(),
        }

    def _save_ui_preferences(self):
        """保存界面偏好"""
        self._save_prefs_job = None
        if getattr(self, "_prefs_loading", False):
            return
        try:
            save_ui_preferences(self._collect_ui_preferences())
        except Exception as e:
            self.logger.debug("保存界面偏好失败: %s", e)

    def _on_close(self):
        """窗口关闭处理"""
        try:
            if self.orchestrator and self.orchestrator.running:
                self.logger.info("窗口关闭，停止导出进程")
                self.orchestrator.stop()
            self._save_ui_preferences()
        except Exception:
            pass
        self.root.destroy()

    def _open_log_file(self):
        """打开当前会话日志文件（不新建空文件）"""
        path = get_active_log_path()
        self.logger.info(f"用户打开日志: {path}")
        try:
            if not os.path.isfile(path):
                messagebox.showwarning(
                    "日志",
                    f"日志文件尚不存在或尚未写入：\n{path}\n\n请先执行导出等操作后再查看。",
                )
                return
            if os.path.getsize(path) == 0:
                messagebox.showinfo(
                    "日志",
                    f"日志文件为空：\n{path}\n\n若刚启动应用，请先操作后再打开。",
                )
            if os.name == "nt":
                os.startfile(path)
            else:
                import subprocess
                subprocess.Popen(["xdg-open", path])
        except Exception as e:
            self.logger.exception("打开日志失败")
            messagebox.showerror("错误", f"无法打开日志文件:\n{path}\n\n{e}")

    def _check_chrome(self):
        """检查 Chrome CDP 连接状态（后台执行，不阻塞 UI）"""
        threading.Thread(target=self._check_chrome_worker, daemon=True).start()

    def _check_chrome_worker(self):
        """Chrome 检查工作线程"""
        result = self.cdp.check_chrome()
        if result:
            self.root.after(0, lambda: [
                self.chrome_status.config(text="● 已连接", fg="#27ae60"),
                self._refresh_crm_status(),
            ])
            self.logger.info("Chrome CDP 已连接")
        else:
            self.root.after(0, lambda: [
                self.chrome_status.config(text="● 未启动", fg="#e74c3c"),
                self.crm_status_label.config(text="● 请先连接浏览器", fg="#7f8c8d"),
            ])
            self.logger.info("Chrome CDP 未连接 (端口 9222)")

    def _refresh_crm_status(self):
        """刷新 CRM 登录状态（后台执行，不阻塞 UI）"""
        threading.Thread(target=self._refresh_crm_status_worker, daemon=True).start()

    def _refresh_crm_status_worker(self):
        """CRM 状态检查工作线程"""
        if not self.cdp.check_chrome():
            self.root.after(0, lambda: self.crm_status_label.config(text="● 请先启动并连接浏览器", fg="#7f8c8d"))
            return
        try:
            status = self.login.check_login_status()
            if status == "ready":
                self.root.after(0, lambda: self.crm_status_label.config(text="● 已在聊天审计页，可导出", fg="#27ae60"))
            elif status == "login_required":
                self.root.after(0, lambda: self.crm_status_label.config(text="● 请在浏览器中完成登录并进入聊天审计页", fg="#f39c12"))
            else:
                self.root.after(0, lambda: self.crm_status_label.config(text="● 请在浏览器中打开 CRM 聊天审计页面", fg="#e74c3c"))
        except Exception as e:
            self.logger.error(f"CRM 状态检查失败: {e}")
            error_msg = str(e)
            if "crm-preflight.py failed:" in error_msg:
                error_msg = error_msg.split("crm-preflight.py failed:")[-1].strip()[:50]
            else:
                error_msg = "检查脚本执行失败"
            self.root.after(0, lambda msg=error_msg: self.crm_status_label.config(text=f"● {msg}", fg="#e74c3c"))

    def _wait_for_chrome(self) -> bool:
        """等待浏览器启动（带超时轮询）"""
        start_time = time.time()
        while time.time() - start_time < BROWSER_START_TIMEOUT:
            if self.cdp.check_chrome():
                return True
            time.sleep(0.5)
        return False

    def _start_chrome(self):
        """启动 Chrome 浏览器"""
        self.logger.info("尝试启动 Chrome...")
        if self.cdp.check_chrome():
            self.chrome_status.config(text="● 已连接", fg="#27ae60")
            return

        browser_path = self.cdp.find_chrome_path()
        if not browser_path:
            self.logger.error("找不到 Chrome/Edge，请手动启动浏览器并添加 --remote-debugging-port=9222 参数")
            messagebox.showwarning(
                "提示",
                "找不到 Chrome/Edge 浏览器。\n\n"
                "请手动打开 Chrome/Edge，在快捷方式「目标」末尾追加：\n"
                "--remote-debugging-port=9222\n\n"
                "若需保留登录状态，请同时追加专用配置目录，例如：\n"
                "--user-data-dir=\"%APPDATA%\\chat-audit-export\\chrome-cdp-profile\"\n\n"
                "保存后重启浏览器。",
            )
            return

        self.logger.info(f"启动浏览器: {browser_path}")
        success = self.cdp.launch_chrome()
        if success:
            self.chrome_status.config(text="● 启动中...", fg="#f39c12")
            self.crm_status_label.config(text="● 等待浏览器就绪…", fg="#f39c12")
            # 使用带超时的轮询检查
            def check_after_launch():
                if self._wait_for_chrome():
                    self.chrome_status.config(text="● 已连接", fg="#27ae60")
                    self._refresh_crm_status()
                else:
                    self.chrome_status.config(text="● 启动超时", fg="#e74c3c")
                    self.logger.warning("浏览器启动超时")
            # 延迟一秒后开始检查（给浏览器启动时间）
            self.root.after(1000, check_after_launch)
        else:
            self.logger.error(f"启动浏览器失败: {browser_path}")
            messagebox.showerror("错误", f"无法启动浏览器：\n{browser_path}\n\n请手动启动 Chrome/Edge 并确保添加 --remote-debugging-port=9222 参数")

    def _check_node(self):
        """检查 Node.js 安装状态"""
        result = self.node_manager.check_node()
        if result:
            self.node_status.config(text="● 已安装", fg="#27ae60")
            self.node_progress.pack_forget()
        else:
            self.node_status.config(text="● 正在安装...", fg="#f39c12")
            self.node_progress["value"] = 0
            self._install_node()

    def _install_node(self):
        """安装 Node.js"""
        self.logger.info("开始安装 Node.js...")

        def on_progress(progress):
            """进度回调"""
            self.root.after(0, lambda p=progress: self.node_progress.config(value=p))

        def install_complete(success):
            """安装完成回调"""
            if success:
                self.node_status.config(text="● 已安装", fg="#27ae60")
                self.node_progress.pack_forget()
            else:
                self.node_status.config(text="● 安装失败", fg="#e74c3c")
                messagebox.showerror("错误", "Node.js 安装失败，请检查网络后重试")

        # 在后台线程执行安装
        def install_thread():
            success = self.node_manager.install_node(progress_callback=on_progress)
            self.root.after(0, lambda: install_complete(success))

        threading.Thread(target=install_thread, daemon=True).start()

    def _select_output_dir(self):
        """选择输出目录"""
        init = self.output_dir_var.get().strip()
        if init and os.path.isdir(init):
            directory = filedialog.askdirectory(initialdir=init)
        else:
            directory = filedialog.askdirectory()
        self.logger.info(f"选择目录: {directory}")
        if directory:
            self.output_dir_var.set(directory)
            self.logger.info(f"已设置目录: {self.output_dir_var.get()}")
            self._schedule_save_ui_preferences()

    def _start_export(self):
        """开始导出流程"""
        if not self.node_manager.check_node():
            messagebox.showwarning("警告", "Node.js 未安装，请等待安装完成")
            return

        start_date = self.start_date_picker.get_date()
        end_date = self.end_date_picker.get_date()
        output_dir = self.output_dir_var.get()
        dept = self.dept_var.get()

        self.logger.info(f"开始导出: {start_date} ~ {end_date}, 部门: {dept}")

        if not start_date or not end_date:
            messagebox.showwarning("警告", "请选择日期范围")
            return
        if not output_dir:
            messagebox.showwarning("警告", "请选择输出目录")
            return

        self._save_ui_preferences()

        # Chrome 提示必须在主线程
        if not self.cdp.check_chrome():
            result = messagebox.askyesno("Chrome 未启动", "Chrome 未启动或未连接，是否自动启动？")
            if result:
                self._start_chrome()
                self.root.after(BROWSER_START_TIMEOUT * 1000 + 500, self._start_export_after_chrome_launch)
            return
        self._run_export_preflight(start_date, end_date, output_dir, dept)

    def _start_export_after_chrome_launch(self):
        """Chrome 启动后继续导出（使用轮询等待而非固定延迟）"""
        if self.cdp.check_chrome():
            start_date = self.start_date_picker.get_date()
            end_date = self.end_date_picker.get_date()
            output_dir = self.output_dir_var.get()
            dept = self.dept_var.get()
            self._run_export_preflight(start_date, end_date, output_dir, dept)
        else:
            messagebox.showwarning("警告", "Chrome 启动超时，请手动启动后重试")

    def _run_export_preflight(self, start_date, end_date, output_dir, dept):
        self.start_btn.config(state=tk.DISABLED, bg="#95a5a6")
        self.progress_label.config(text="正在检查 CRM 与页面状态…")
        self.detail_label.config(text="可在浏览器中登录；检查在后台进行，窗口应保持可操作")
        self.root.update_idletasks()

        t = threading.Thread(
            target=self._export_preflight_worker,
            args=(start_date, end_date, output_dir, dept),
            daemon=True,
        )
        t.start()

    def _export_preflight_worker(self, start_date, end_date, output_dir, dept):
        """导出预检工作线程"""
        try:
            if not self.cdp.check_chrome():
                self.root.after(0, self._on_export_preflight_failed_chrome)
                return
            status = self.login.check_login_status()
            if status == "login_required":
                self.root.after(0, lambda: self._on_export_preflight_failed_crm("login_required"))
                return
            elif status == "unknown":
                self.logger.info("当前不在聊天审计页，尝试自动导航...")
                self.root.after(0, lambda: self._on_try_navigate_to_audit(start_date, end_date, output_dir, dept))
                return
            if not self.login.gate_check(dept, start_date):
                self.logger.info("Gate 检查失败，尝试自动设置部门和日期")
                self.root.after(0, lambda: self._on_gate_check_failed_auto_fix(dept, start_date, start_date, end_date, output_dir, dept))
                return
            if not self.login.gate_start_export(dept, start_date):
                self.root.after(0, self._on_export_preflight_failed_start_gate)
                return
        except Exception as e:
            self.logger.exception("导出预检异常")
            self.root.after(0, lambda msg=str(e): self._on_export_preflight_failed_exception(msg))
            return

        self.root.after(
            0,
            lambda sd=start_date, ed=end_date, od=output_dir, d=dept: self._start_export_after_preflight_ok(
                sd, ed, od, d
            ),
        )

    def _on_try_navigate_to_audit(self, start_date, end_date, output_dir, dept):
        """尝试导航到聊天审计页"""
        self.logger.info("正在导航到聊天审计页...")

        def do_navigate():
            try:
                import time
                success = self.login.navigate_audit()
                if success:
                    self.logger.info("导航命令已发送，等待页面加载...")
                    time.sleep(3)
                    status = self.login.check_login_status()
                    if status == "ready":
                        self.logger.info("导航成功，继续导出流程")
                        self.root.after(0, lambda: self._retry_export(start_date, end_date, output_dir, dept))
                    else:
                        self.logger.warning(f"导航后状态仍是: {status}")
                        self.root.after(0, lambda s=status: self._on_export_preflight_failed_crm(s))
                else:
                    self.logger.error("导航失败")
                    self.root.after(0, lambda s="导航失败": self._on_export_preflight_failed_crm(s))
            except Exception as e:
                self.logger.exception("导航异常")
                self.root.after(0, lambda s=str(e): self._on_export_preflight_failed_crm(s))

        threading.Thread(target=do_navigate, daemon=True).start()

    def _retry_export(self, start_date, end_date, output_dir, dept):
        """重试导出流程"""
        self.logger.info("重试导出流程...")
        t = threading.Thread(
            target=self._export_preflight_worker,
            args=(start_date, end_date, output_dir, dept),
            daemon=True,
        )
        t.start()

    def _on_gate_check_failed_auto_fix(self, original_dept, original_date, start_date, end_date, output_dir, dept):
        """Gate 检查失败后自动修复"""
        self.logger.info("自动设置 CRM 筛选条件...")

        def do_auto_fix():
            try:
                for attempt in range(3):
                    self.logger.info(f"自动修复尝试 {attempt + 1}/3...")
                    self.login.set_department(dept)
                    time.sleep(1)
                    self.login.set_dates(start_date)
                    time.sleep(3)

                    if self.login.gate_check(dept, start_date):
                        self.logger.info("Gate 检查通过")
                        if self.login.gate_start_export(dept, start_date):
                            self.root.after(0, lambda: self._start_export_after_preflight_ok(start_date, end_date, output_dir, dept))
                        else:
                            self.root.after(0, self._on_export_preflight_failed_start_gate)
                        return
                    else:
                        self.logger.warning(f"Gate 检查失败，尝试重新设置 (attempt {attempt + 1})")
                        if attempt < 2:
                            time.sleep(2)
            except Exception as e:
                self.logger.exception("自动修复失败")
            self._on_export_preflight_failed_gate()

        threading.Thread(target=do_auto_fix, daemon=True).start()

    def _reset_export_start_button(self):
        """重置导出按钮状态"""
        self.start_btn.config(state=tk.NORMAL, bg="#3498db")

    def _on_export_preflight_failed_chrome(self):
        """Chrome 预检失败处理"""
        self._reset_export_start_button()
        self.progress_label.config(text="")
        self.detail_label.config(text="")
        self._schedule_save_ui_preferences()
        messagebox.showwarning("警告", "Chrome 仍未连接，请确认已启动调试端口后重试。")

    def _on_export_preflight_failed_crm(self, status):
        """CRM 预检失败处理"""
        self._reset_export_start_button()
        self.progress_label.config(text="")
        self.detail_label.config(text="")
        self._schedule_save_ui_preferences()
        if status == "login_required":
            messagebox.showwarning(
                "警告",
                "当前为登录页或尚未进入聊天审计页。\n请在浏览器中完成登录并打开聊天审计页面，然后点击「刷新 CRM 状态」后再导出。",
            )
        else:
            messagebox.showwarning("警告", "请在浏览器中打开 CRM 聊天审计页面后再导出。")
        self._refresh_crm_status()

    def _on_export_preflight_failed_gate(self):
        """Gate 检查失败处理"""
        self._reset_export_start_button()
        self.progress_label.config(text="")
        self.detail_label.config(text="")
        self._schedule_save_ui_preferences()
        messagebox.showwarning("警告", "CRM 筛选条件不符合，请检查部门和日期设置")

    def _on_export_preflight_failed_start_gate(self):
        """Start Gate 检查失败处理"""
        self._reset_export_start_button()
        self.progress_label.config(text="")
        self.detail_label.config(text="")
        self._schedule_save_ui_preferences()
        messagebox.showwarning("警告", "CRM 未准备好导出，请稍后重试")

    def _on_export_preflight_failed_exception(self, msg):
        """预检异常处理"""
        self._reset_export_start_button()
        self.progress_label.config(text="")
        self.detail_label.config(text="")
        self._schedule_save_ui_preferences()
        self.logger.error(f"CRM 状态检查失败: {msg}")
        messagebox.showwarning("警告", f"无法连接 CRM: {msg}")

    def _start_export_after_preflight_ok(self, start_date, end_date, output_dir, dept):
        """预检通过后启动导出"""
        self.logger.info("CRM 预检通过，启动导出")
        self._save_ui_preferences()
        self.stop_btn.config(state=tk.NORMAL, bg="#e74c3c")
        self.progress_label.config(text="正在导出...")
        self.progress_bar["value"] = 0
        self.detail_label.config(text="")

        def on_progress(event):
            """进度更新回调"""
            ev = dict(event)
            c, t, e, cu, msg = (
                ev.get("current", 0),
                ev.get("total", 0),
                ev.get("employee", ""),
                ev.get("customer", ""),
                ev.get("message", ""),
            )
            self.root.after(
                0,
                lambda c=c, t=t, e=e, cu=cu, msg=msg: self._update_progress(c, t, e, cu, msg),
            )

        def on_complete(event):
            """导出完成回调"""
            ev = dict(event)
            tot = ev.get("total") or ev.get("conversations", 0)
            fail = ev.get("failed", 0)
            self.root.after(0, lambda e=ev, tot=tot, fail=fail: self._export_complete(tot, fail, e))

        def on_error(event):
            """导出错误回调"""
            msg = event.get("message", "未知错误")
            self.root.after(0, lambda m=msg: self._show_error(m))

        self.orchestrator.start_export(
            start_date,
            end_date,
            output_dir,
            dept,
            on_progress=on_progress,
            on_complete=on_complete,
            on_error=on_error,
        )

    def _update_progress(self, current, total, emp, cust, message=""):
        """更新导出进度"""
        if total > 0:
            self.progress_bar["value"] = min(100, (current / total) * 100)
        if emp or cust:
            suffix = f" ({current}/{total})" if total > 0 else ""
            self.detail_label.config(text=f"正在导出：{emp} ↔ {cust}{suffix}".strip())
        elif message:
            self.detail_label.config(text=message[:240])
        elif total > 0:
            self.detail_label.config(text=f"进度 {current}/{total}")

    def _stop_export(self):
        """停止导出"""
        self.logger.info("导出已停止")
        self.orchestrator.stop()
        self._schedule_save_ui_preferences()
        self.start_btn.config(state=tk.NORMAL, bg="#3498db")
        self.stop_btn.config(state=tk.DISABLED, bg="#95a5a6")
        self.progress_label.config(text="已停止")

    def _export_complete(self, total, failed, event=None):
        """导出完成处理"""
        self.logger.info(f"导出完成: 总计={total}, 失败={failed}")
        self._save_ui_preferences()
        self.start_btn.config(state=tk.NORMAL, bg="#3498db")
        self.stop_btn.config(state=tk.DISABLED, bg="#95a5a6")
        self.progress_bar["value"] = 100
        event = event or {}
        if total == 0 and not event.get("exportAllEmployees", True):
            keywords = event.get("targetKeywords") or []
            kw_text = "、".join(keywords) if keywords else "（无）"
            messagebox.showwarning(
                "导出完成（0 条）",
                f"未导出任何对话。\n"
                f"当前仅导出姓名包含以下关键字的员工：{kw_text}\n"
                f"请确认当日主表是否有数据，或联系管理员调整导出范围。",
            )
            return
        if total == 0:
            messagebox.showwarning(
                "导出完成（0 条）",
                "未导出任何对话。\n"
                "请确认：\n"
                "1. 主表日期、部门筛选与 Gate 检查一致；\n"
                "2. 当日员工行有「总有效跟进/咨询」等指标客户；\n"
                "3. 企业微信会话 iframe 可正常打开。",
            )
            return
        if failed > 0:
            messagebox.showinfo("完成", f"导出完成\n总计: {total}\n失败: {failed}")
        else:
            messagebox.showinfo("完成", f"导出完成\n总计: {total}")

    def _show_error(self, message):
        """显示错误信息"""
        self.logger.error(f"导出错误: {message}")
        self._save_ui_preferences()
        self.start_btn.config(state=tk.NORMAL, bg="#3498db")
        self.stop_btn.config(state=tk.DISABLED, bg="#95a5a6")
        ErrorDialog(self.root, "导出错误", message, on_retry=self._start_export)

    def run(self):
        """运行主窗口"""
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.mainloop()