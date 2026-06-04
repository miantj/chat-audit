# Windows / Win7 打包排障

面向 **64 位 Win7+** 的 Electron 安装包。现象 → 命令，少叙述。

## 为什么「pnpm build 一直成功」却装后很多错？

**两类问题，不要混在一起：**

| 类型 | 何时出现 | 典型报错 | 是否代码回归 |
|------|----------|----------|--------------|
| **A. 构建机环境** | 执行 `pnpm build` 时 | NSIS 下载 `EOF`、winCodeSign 符号链接、Electron 404 | ❌ 网络/权限，与业务代码无关 |
| **B. 安装包运行时** | 安装后启动 / 点导出 | `export-json-stats`、ESM/CJS、`ERR_MODULE_NOT_FOUND` | ⚠️ 自 electron 首版就存在的架构隐患，开发态不易发现 |

**B 类根因（git `3a3fd66` 首版即有）：**

安装包内是**两套独立目录**：

```text
resources/
  app.asar.unpacked/     ← Electron 主进程（main.mjs、src/lib/…）
  scripts/               ← extraResources 拷贝的 chat-audit-export/scripts（给子进程 node 用）
```

旧版 `run-export-engine.js` 在**主进程启动时**从 `resources/scripts/lib/*.js` 做 `dynamic import`，想复用 CLI 脚本里的工具函数。

| 环境 | `scripts/lib/*.js` 如何解析 | 结果 |
|------|------------------------------|------|
| 开发 `pnpm start` | 路径在 `chat-audit-export/scripts/`，上级有 `package.json` `"type":"module"` | ✅ 正常 |
| 安装版 | 只有 `resources/scripts/`，**没有**上级 `package.json` | ❌ `.js` 当 CJS → `Cannot use import statement outside a module` |

因此：**构建成功 ≠ 安装版主进程能加载导出逻辑**。`bootstrap.log` 里先出现 `resolveMainEntry ok`，约 0.5s 后仍可能在加载 `run-export-engine` 时失败（bootstrap 只表示找到了 `main.mjs`，不表示应用已完全启动）。

**当前修复（须拉最新并重打包）：**

1. `prebuild` 跑 `sync-export-lib.cjs`，把 4 个公共 `.mjs` 拷进 `electron/src/lib/export-script-lib/`
2. 主进程**静态 import** 上述目录（随 `app.asar.unpacked` 打包，不再依赖 `resources/scripts`）
3. `resources/scripts` 仍只给 **子进程** `export-with-self-heal.mjs` 等使用

**装后必查（B 类）：**

```bat
dir "%LOCALAPPDATA%\Programs\ChatAuditExport\resources\app.asar.unpacked\src\lib\export-script-lib\export-json-stats.mjs"
```

有文件 → 主进程路径正确；没有 → 用了旧代码或未跑 `sync-export-lib` 的构建。

## 版本与产物

| 项 | 值 |
|----|-----|
| Electron | `22.3.27`（≥23 不支持 Win7） |
| 内嵌 Node | `16.20.2` → `runtime/node-win32-x64` |
| 架构 | 仅 `x64` |
| 主进程 | `main.cjs` → `app.asar.unpacked/main.mjs` |
| 预检 Python | **3.8.x 64 位** 打 PyInstaller（勿用 3.14） |
| 安装包 | `dist\一手聊天审计导出 Setup *.exe`（版本见 `electron/package.json`） |
| 绿色版 | `dist\win-unpacked\ChatAuditExport.exe` |
| 日志 | `%APPDATA%\chat-audit-export\logs\`（`bootstrap.log` / `main.log`） |

| 目标系统 | 支持 |
|----------|------|
| Win7/10/11 x64 | ✅ |
| Win7/10/11 x86 | ❌（未打 ia32） |

---

## 标准流程（Windows 构建机）

```bat
cd C:\dev\chat-audit\electron

:: 依赖
pnpm install
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm rebuild electron
pnpm exec electron --version

:: runtime（Win7 必须用 3.8 打 preflight）
py -3.8 -m pip install pyinstaller websockets
node scripts\prepare-runtime.cjs --win-x64 --force
runtime\python-win32-x64\crm-preflight.exe --help

:: 打包（prebuild 含 sync-export-lib + copy-ws）
rmdir /s /q dist
pnpm build

:: 本机验证（须能打开窗口且 bootstrap 无 export-json-stats 报错）
dist\win-unpacked\ChatAuditExport.exe --enable-logging
dir dist\win-unpacked\resources\app.asar.unpacked\src\lib\export-script-lib\export-json-stats.mjs
type "%APPDATA%\chat-audit-export\logs\bootstrap.log"
```

**安装给用户：** 只发 `dist\一手聊天审计导出 Setup *.exe`，勿只拷单个 exe。

**构建机目录（须完整仓库，不能只有 electron 文件夹）：**

```text
chat-audit-export-electron/
  electron/              ← 在此 pnpm build
  chat-audit-export/
    scripts/lib/*.mjs    ← sync-export-lib 源
```

**重装前清残留：**

```bat
rmdir /s /q "%LOCALAPPDATA%\Programs\ChatAuditExport"
rmdir /s /q "%LOCALAPPDATA%\Programs\一手聊天审计导出"
```

---

## 现象速查

| 日志 / 现象 | 节 |
|-------------|-----|
| `pnpm build` 成功但装后 `export-json-stats` 报错 | [根因说明](#为什么pnpm-build-一直成功却装后很多错) · [B1](#b1-主进程打包) |
| NSIS / `nsis-3.0.4.1.7z` 下载 `EOF` | [A5](#a5-nsis-下载) |
| `node-v22...-win32-x64.zip` HTTP 404 | [A1](#a1-node-404) |
| `Cannot create symbolic link` / winCodeSign | [A2](#a2-winCodeSign) |
| `Electron failed to install correctly` | [A3](#a3-electron-安装) |
| `not a valid Win32 application`（Win7） | [A4](#a4-win7-无效程序) |
| `ERR_MODULE_NOT_FOUND` … `main.js` | [B1](#b1-主进程打包) |
| `Cannot use import statement outside a module` | [B1](#b1-主进程打包) |
| `Cannot find package 'electron-log'` | [B1](#b1-主进程打包) |
| `Cannot find module '...\app.asar\main.mjs'` | [B1](#b1-主进程打包) |
| `WebSocketImpl is not a constructor` / `active chatAudit page not found` | [C4](#c4-ws-cdp) |
| `bootstrap v4: unpacked-first` 仍打不开 | [B2](#b2-安装版无反应) |
| `invalid choice: 'prepare-export'` | [C1](#c1-preflight) |
| 导出失败 `exit 216` / `only supported on Windows 8.1` | [C2](#c2-node-win7) |
| `ENOENT: mkdir '\\?'` | [C3](#c3-输出路径) |
| `Expand-Archive` / `LiteralPath` 为空 | [D1](#d1-powershell) |
| `EPERM` rename `node-v16...` | [D2](#d2-rename) |
| PyInstaller `Python: 3.14` | [D3](#d3-python-38) |
| pnpm 11 未允许 electron 构建脚本 | [D4](#d4-pnpm11) |
| `building target=nsis` 无 `⨯` | 成功 |

---

## A. 环境与安装

### A1 Node 404 {#a1-node-404}

```text
HTTP 404 for .../node-v22.14.0-win32-x64.zip
```

Node 官方 Win 包名为 `win-x64`，不是 `win32-x64`。已在 `prepare-runtime.cjs` 修复；拉最新代码后 `--force` 重跑。

```bat
node scripts\prepare-runtime.cjs --win-x64 --force
```

### A2 winCodeSign {#a2-winCodeSign}

```text
Cannot create symbolic link : 客户端没有所需的特权
```

任选：

```bat
:: 管理员终端
pnpm build

:: 或清缓存后重试
rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
pnpm build
```

或：设置 → 开发人员模式 → **新开**终端再 build。

### A3 Electron 安装 {#a3-electron-安装}

```text
Electron failed to install correctly
```

```bat
cd electron
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_CUSTOM_DIR=22.3.27
rmdir /s /q node_modules
pnpm install
pnpm rebuild electron
pnpm exec electron --version
```

pnpm 11 另需 `electron/pnpm-workspace.yaml` 含 `allowBuilds: electron: true`（仓库已配）。

### A4 Win7 无效程序 {#a4-win7-无效程序}

- Electron 须 **22.x**，且安装包为 **x64**
- 分发 **Setup.exe** 或整个 `win-unpacked`，勿只拷 `ChatAuditExport.exe`

### A5 NSIS 下载 {#a5-nsis-下载}

```text
Get "https://github.com/.../nsis-3.0.4.1.7z": EOF
```

打包已在 `win-unpacked` 阶段完成，**仅安装包（Setup.exe）步骤失败**，属 GitHub 网络中断，非代码问题。

```bat
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\nsis"
pnpm build
```

急用：直接发 `dist\win-unpacked\` 整目录或 zip；或 `pnpm run build:dir` 跳过 NSIS。

---

## B. 打包后启动

### B1 主进程打包 {#b1-主进程打包}

**`pnpm start` 正常，`win-unpacked` / 安装版无窗口** — 看日志：

```bat
type "%APPDATA%\chat-audit-export\logs\bootstrap.log"
```

| bootstrap / 报错 | 处理 |
|------------------|------|
| `ERR_MODULE_NOT_FOUND` … `main.js` | 拉最新代码；`build.files` 须含 `main.mjs`；`pnpm build` |
| `Cannot use import statement outside a module` … `main.js` | 入口须 **`main.mjs`**，勿 `main.js` |
| `Cannot use import statement outside a module` … `resources\scripts\lib\*.js` | 主进程已改从 **`app.asar.unpacked\src\lib\export-script-lib\`** 静态加载；`prebuild` 会跑 `sync-export-lib.cjs` |
| `ERR_MODULE_NOT_FOUND` … `resources\scripts\lib\export-json-stats.mjs` | 旧包主进程仍从 extraResources 加载；拉最新并重打包（须含 `sync-export-lib`） |
| `Cannot find package 'electron-log'` | 须 **v4**：`unpacked/main.mjs` + `createRequire(app.asar/package.json)` |
| `Cannot find module '...\app.asar\main.mjs'` | 勿从 asar 做 dynamic import；须 **unpacked-first** |
| `chosen=...\main.js`（旧包） | 未同步代码或未重装；见 [B2](#b2-安装版无反应) |
| 应有 `bootstrap v4: unpacked-first` + `chosen=...\app.asar.unpacked\main.mjs` | 正确 |

**装后文件检查：**

```bat
dir "%LOCALAPPDATA%\Programs\ChatAuditExport\resources\app.asar.unpacked\main.mjs"
dir "%LOCALAPPDATA%\Programs\ChatAuditExport\resources\app.asar.unpacked\package.json"
dir "%LOCALAPPDATA%\Programs\ChatAuditExport\resources\app.asar.unpacked\src\lib\export-script-lib\export-json-stats.mjs"
```

**开发机对比：**

```bat
findstr "bootstrap v4" main.cjs
findstr "createAppRequire" main.mjs
```

### B2 安装版无反应 {#b2-安装版无反应}

`win-unpacked` 能开、安装版不能：

```bat
:: 1. 命令行启动（不要双击旧快捷方式）
"%LOCALAPPDATA%\Programs\ChatAuditExport\ChatAuditExport.exe" --enable-logging

:: 2. 对比目录
dir "%LOCALAPPDATA%\Programs\ChatAuditExport\resources\app.asar.unpacked\main.mjs"
dir "C:\dev\electron\dist\win-unpacked\resources\app.asar.unpacked\main.mjs"

:: 3. 日志
type "%APPDATA%\chat-audit-export\logs\bootstrap.log"
type "%APPDATA%\chat-audit-export\logs\main.log"
```

| 结果 | 处理 |
|------|------|
| cmd 能开、双击不能 | 删桌面/开始菜单旧快捷方式；从新 Setup 重装 |
| 缺 `app.asar.unpacked\main.mjs` | 卸载 → 删 `Programs\ChatAuditExport` → 用**最新** Setup 重装 |
| 仍异常 | `xcopy /E /Y dist\win-unpacked\* "%LOCALAPPDATA%\Programs\ChatAuditExport\"` 验证是否为 NSIS 残留问题 |

---

## C. 运行时

### C1 preflight {#c1-preflight}

```text
invalid choice: 'prepare-export'
```

旧 `crm-preflight.exe` 缓存：

```bat
node scripts\prepare-runtime.cjs --win-x64 --force
pnpm build
```

### C2 Node Win7（exit 216）{#c2-node-win7}

```text
导出失败 (exit 216)
Node.js is only supported on Windows 8.1, Windows Server 2012 R2, or higher.
Setting the NODE_SKIP_PLATFORM_CHECK environment variable to 1 skips this check
```

内嵌 **Node 16.20.2 官方包**在 Win7 上会拒绝启动（非脚本 bug）。应用已对 Windows 导出子进程设置 `NODE_SKIP_PLATFORM_CHECK=1`（见 `runtime-paths.js`）。

**须用含该修复的安装包**；旧包请重新 `pnpm build` 并安装。

本机验证内嵌 Node：

```bat
set NODE_SKIP_PLATFORM_CHECK=1
"%LOCALAPPDATA%\Programs\ChatAuditExport\resources\runtime\node-win32-x64\node.exe" -v
```

应输出 `v16.20.2` 而非 216。若仍失败，考虑换 Win10+ 或自行替换为 [node16-win7](https://github.com/Alex313031/node16-win7) 构建的 `node.exe` 后重打 `prepare-runtime`。

### C4 ws / CDP（Win7 Node 16）{#c4-ws-cdp}

```text
[CDP] Failed to inspect target: ... Error: TypeError: WebSocketImpl is not a constructor
Export failed: active chatAudit page not found
Diagnosed page state: AUDIT_EMPLOYEE_LIST_READY
```

预检（Python）正常，但 Node 16 上 `globalThis.WebSocket` 常为不可用占位，误用会报 `not a constructor`。

**当前逻辑（`cdp.js`）**：优先 `require(ws/index.js)`；找不到则使用内置零依赖 `node-ws-client.js`（不再回退 globalThis）。

导出日志应出现一行诊断，例如：

```text
[CDP] ws backend=node-ws source=...\ws\index.js ...
[CDP] ws backend=builtin source=node-ws-client.js ...
```

若仍为 `not a constructor` → 安装包内 `cdp.js` 过旧，请同步仓库后重装。

`ECONNREFUSED 127.0.0.1:80`：Chrome 返回的 `webSocketDebuggerUrl` 常无端口，旧版会误连 80。新版 `cdp.js` 会按 `CHAT_AUDIT_CRM_CDP_BASE` 补 `:9222`。

```bat
cd C:\dev\electron
node scripts\copy-ws-to-scripts.cjs
rmdir /s /q dist
pnpm build
dir dist\win-unpacked\resources\scripts\node_modules\ws\index.js
dir dist\win-unpacked\resources\scripts\lib\node-ws-client.js
```

### C3 输出路径 {#c3-输出路径}

```text
ENOENT: no such file or directory, mkdir '\\?'
```

应用内重选合法目录（如 `D:\chat-audit-export`）；检查环境变量 `OUTPUT_PATH` / `CHAT_AUDIT_EXPORT_DIR` 是否异常。

---

## D. prepare-runtime / 构建

### D1 PowerShell {#d1-powershell}

```text
Expand-Archive : 参数“LiteralPath”为 Null 或空
```

`prepare-runtime.cjs` 须把路径写进 `-Command` 字符串（`JSON.stringify`），不能指望 `$args[0]`。

### D2 rename {#d2-rename}

```text
EPERM: rename '...\node-v16.20.2-win-x64' -> '...\node-win32-x64'
```

```bat
rmdir /s /q runtime\node-win32-x64
rmdir /s /q runtime\node-v16.20.2-win-x64
node scripts\prepare-runtime.cjs --win-x64 --force
```

### D3 Python 3.8 {#d3-python-38}

构建日志出现 `Python: 3.14` → Win7 上 preflight 会挂。

```bat
py -3.8 -m pip install pyinstaller websockets
node scripts\prepare-runtime.cjs --win-x64 --force
runtime\python-win32-x64\crm-preflight.exe --help
```

### D4 pnpm 11 {#d4-pnpm11}

Electron 二进制未下载 / 构建脚本被拦：

```yaml
# electron/pnpm-workspace.yaml
nodeLinker: hoisted
allowBuilds:
  electron: true
```

```bat
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm rebuild electron
```

镜像：`electron/.npmrc`。

---

## 命令速查

```bat
systeminfo | findstr /C:"系统类型"
pnpm exec electron --version
node scripts\prepare-runtime.cjs --win-x64 --force
rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
rmdir /s /q dist && pnpm build
type "%APPDATA%\chat-audit-export\logs\bootstrap.log"
```

**打包成功：**

```text
building target=nsis file=dist\一手聊天审计导出 Setup 1.0.0.exe
```

---

## 参考

- [Electron：Win7/8/8.1 支持移除（v23+）](https://github.com/electron/electron/blob/main/docs/breaking-changes.md)
- [electron-builder #8149 winCodeSign](https://github.com/electron-userland/electron-builder/issues/8149)
- [Node 16.20.2](https://nodejs.org/dist/v16.20.2/) · [Python 3.8.10](https://www.python.org/downloads/release/python-3810/)
