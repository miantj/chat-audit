# -*- mode: python ; coding: utf-8 -*-
# Tcl/Tk 由 PyInstaller 的 hook-_tkinter 自动收集，此处勿重复加入，否则会与 COLLECT 冲突。
# 使用 onedir（exe + _internal）避免 onefile 解压到 _MEI* 时 Tcl 路径异常；关闭 UPX 避免脚本损坏。

block_cipher = None

a = Analysis(
    ["run.py"],
    pathex=[],
    binaries=[],
    datas=[
        ("chat-audit-export/scripts", "scripts"),
    ],
    hiddenimports=["keyring", "cryptography", "requests", "websockets"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="chat-audit-export",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    [("python313.dll", "D:\\python\\python313.dll", "BINARY")],
    strip=False,
    upx=False,
    upx_exclude=[],
    name="chat-audit-export",
)