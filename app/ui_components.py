import tkinter as tk
from tkinter import ttk
from typing import Optional, Callable

class ErrorDialog:
    def __init__(self, master: tk.Tk, title: str, message: str, on_retry: Optional[Callable[[], None]] = None):
        self.master: tk.Tk = master
        self.title: str = title
        self.message: str = message
        self.on_retry: Optional[Callable[[], None]] = on_retry
        self.root: tk.Toplevel = tk.Toplevel(master)
        self.root.title(title)
        self.root.geometry("400x150")
        self.root.resizable(False, False)

        label = tk.Label(self.root, text=message, wraplength=350, pady=20)
        label.pack()

        btn_frame = tk.Frame(self.root)
        btn_frame.pack(pady=10)

        tk.Button(btn_frame, text="确定", command=self.root.destroy).pack(side=tk.LEFT, padx=10)
        if on_retry:
            tk.Button(btn_frame, text="重试", command=self.on_retry_click).pack(side=tk.LEFT, padx=10)

    def on_retry_click(self) -> None:
        self.root.destroy()
        if self.on_retry:
            self.on_retry()

class ProgressWindow:
    def __init__(self, master: tk.Tk):
        self.master: tk.Tk = master
        self.root: tk.Toplevel = tk.Toplevel(master)
        self.root.title("导出中...")
        self.root.geometry("500x200")

        self.status_label: tk.Label = tk.Label(self.root, text="准备中...", anchor="w")
        self.status_label.pack(fill=tk.X, padx=20, pady=(20, 5))

        self.progress: ttk.Progressbar = ttk.Progressbar(self.root, mode="determinate", length=460)
        self.progress.pack(padx=20, pady=10)

        self.detail_label: tk.Label = tk.Label(self.root, text="", anchor="w", fg="gray")
        self.detail_label.pack(fill=tk.X, padx=20, pady=(0, 20))

        self._running: bool = True

    def update(self, current: int, total: int, status: str, detail: str = "") -> None:
        self.status_label.config(text=status)
        self.progress["value"] = (current / total) * 100 if total > 0 else 0
        self.detail_label.config(text=detail)
        self.root.update()

    def close(self) -> None:
        self.root.destroy()