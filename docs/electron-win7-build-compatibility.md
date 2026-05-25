# Electron Windows / Win7 打包兼容性问题备忘

本文档记录 `chat-audit` 项目在 Windows 上打包、运行及兼容 **Windows 7（64 位）** 时遇到的问题、原因与解决方案，便于后续复现与排障。

**当前推荐配置（Win7 x64 目标）**

| 组件 | 版本 / 说明 |
|------|-------------|
| Electron | `22.3.27`（v23+ 不再支持 Win7/8/8.1） |
| 内置 Node | `16.20.2`（`runtime/node-win32-x64`） |
| 打包架构 | 仅 `x64`（64 位 Win7） |
| 主进程入口 | `main.cjs` → 从 `app.asar.unpacked` 加载 `main.mjs`（ESM） |
| 预检打包 Python | **3.8.x 64 位**（勿用 3.14 打 PyInstaller） |
| 安装包产物 | `electron/dist/一手聊天审计导出 Setup 1.0.0.exe` |

**标准构建命令（在 Windows 上）**

```bat
cd C:\dev\chat-audit\electron
py -3.8 -m pip install pyinstaller websockets
node scripts\prepare-runtime.cjs --win-x64 --force
pnpm build
```

---

## 1. Node 运行时下载 404

### 现象

```text
Error: HTTP 404 for https://nodejs.org/dist/v22.14.0/node-v22.14.0-win32-x64.zip
```

### 原因

`prepare-runtime.cjs` 将 Windows 包名拼成 `win32-x64`，而 Node 官方发行包使用 **`win-x64`** / **`win-x86`**（`ia32` 对应 x86）。

### 解决方案

- `nodeDist()` 中：`platform === 'win32'` 时 `os = 'win'`，`ia32` → `x86`
- macOS 使用 `.tar.gz`（非 `.tar.xz`）
- Windows 解压后 `node.exe` 在目录根下，不在 `bin/` 下

**相关文件：** `electron/scripts/prepare-runtime.cjs`、`electron/src/lib/runtime-paths.js`

---

## 2. electron-builder：winCodeSign 解压失败（符号链接权限）

### 现象

```text
ERROR: Cannot create symbolic link : 客户端没有所需的特权
... darwin\10.12\lib\libcrypto.dylib
```

### 原因

`electron-builder` 下载的 `winCodeSign-2.6.0.7z` 内含 macOS 符号链接；在 Windows 上解压需要**创建符号链接**权限，普通终端默认没有。

### 解决方案（任选其一）

1. **管理员终端** 执行 `pnpm build`（`Win + X` →「终端(管理员)」，或开始菜单搜索 cmd 右键以管理员运行）
2. 开启 **开发人员模式**：设置 → 隐私和安全性 → 面向开发人员 → 开发人员模式，然后**新开**普通终端再构建
3. 失败时清理缓存后重试：
   ```bat
   rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
   ```
4. （可选）在 `package.json` 的 `build.win` 中设置 `signAndEditExecutable: false`、`signExecutable: false`，跳过依赖 winCodeSign 的步骤（无代码签名证书时通常可接受）

---

## 3. Win7 上提示「不是有效的 Win32 应用程序」

### 现象

双击 `ChatAuditExport.exe` 提示不是有效的 Win32 应用程序。

### 原因

1. **Electron 33+** 不支持 Windows 7（自 Electron 23 起官方放弃 Win7/8/8.1）
2. 构建产物为 **x64**，在 **32 位 Win7** 上无法运行
3. 只复制了 `win-unpacked\ChatAuditExport.exe` 单文件，未带完整目录（应使用安装包或整个 `win-unpacked`）

### 解决方案

- 将 `electron` 依赖固定为 **`electron@22.3.27`**
- 内置 Node 降为 **`16.20.2`**
- `pnpm build` 仅打 **`--win --x64`**
- 分发给用户：**`dist\一手聊天审计导出 Setup 1.0.0.exe`**，不要只拷单个 exe

**说明：** 代码里的 `win32` 表示「Windows 平台」，不等于 32 位程序。

---

## 4. Electron 22 + ESM 主进程：`ERR_REQUIRE_ESM`

### 现象

```text
Error [ERR_REQUIRE_ESM]: require() of ES Module ...\main.js ... not supported
```

### 原因

`package.json` 含 `"type": "module"`，`main.js` 为 ES Module；Electron 22 主进程入口仍通过 **`require()`** 加载，不兼容。

### 解决方案

- 新增 `electron/main.cjs`，内容为 `import('./main.js')`
- `package.json` 的 `"main"` 改为 `"main.cjs"`

**相关文件：** `electron/main.cjs`、`electron/package.json`

---

## 4.1 安装包 / win-unpacked 双击无反应：`ERR_MODULE_NOT_FOUND`（main.js）

### 现象

`pnpm start` 正常，但 `dist\win-unpacked\ChatAuditExport.exe` 或 NSIS 安装版无窗口；命令行可见：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\app.asar\main.js' imported from ...\main.cjs
```

`%APPDATA%\chat-audit-export\logs` 可能不存在（主进程在写日志前就退出）。

或 `bootstrap.log` 出现：

```text
SyntaxError: Cannot use import statement outside a module
```

（`main.js` 在 `app.asar.unpacked` 仍可能被 Electron 当 CJS 加载；改用 **`main.mjs`**。）

### 原因

1. `main.cjs` 使用 **动态** `import()`，electron-builder 依赖分析可能 **不把** 主进程源码打进 `app.asar`
2. Electron 22 在 **asar 内** 对 ESM 做动态 `import()` 可能解析失败，需将主进程放到 `app.asar.unpacked`
3. 即便 unpack 了 `package.json`，从 CJS 动态 `import('.../main.js')` 仍可能报 **`Cannot use import statement outside a module`**；入口须为 **`main.mjs`**

### 解决方案

- `package.json` → `build.files` 显式包含 `main.mjs`、`src/**/*`、`renderer/**/*`、`preload.cjs`
- `build.asarUnpack` 包含 **`package.json`**、`main.mjs`、`src/**`、`renderer/**`（`package.json` 供 `src/**/*.js` 作 ESM 解析）
- `main.cjs` 从 **`app.asar.unpacked/main.mjs`** 动态 import（asar 内文件无法 dynamic import）
- `main.mjs` 用 **`createRequire(app.asar/package.json)`** 加载 `electron-log`（unpacked 入口解析不到 asar 内 `node_modules`）

修改后重新打包：

```bat
cd electron
pnpm build
dist\win-unpacked\ChatAuditExport.exe
```

**相关文件：** `electron/package.json`、`electron/main.cjs`

### 4.2 win-unpacked 正常、NSIS 安装版双击无反应

#### 现象

- `dist\win-unpacked\ChatAuditExport.exe` 能打开
- 安装到 `AppData\Local\Programs\ChatAuditExport` 后，双击桌面/开始菜单图标无反应

#### 常见原因

1. **未卸载旧版本**：旧安装目录缺少 `app.asar.unpacked`，新 Setup 未完全覆盖
2. **快捷方式仍指向旧路径**（例如旧的 `一手聊天审计导出` 目录）
3. **安装目录资源不完整**（NSIS 装完后缺 `resources\app.asar.unpacked`）

#### 排查步骤

**1. 先卸载，再删残留目录，再重装**

```bat
:: 控制面板卸载 ChatAuditExport，然后手动删残留
rmdir /s /q "%LOCALAPPDATA%\Programs\ChatAuditExport"
rmdir /s /q "%LOCALAPPDATA%\Programs\一手聊天审计导出"

:: 用刚 build 出来的 Setup 重装
dist\一手聊天审计导出 Setup 1.0.0.exe
```

**2. 用命令行启动安装版（不要双击快捷方式）**

```bat
"%LOCALAPPDATA%\Programs\ChatAuditExport\ChatAuditExport.exe" --enable-logging
```

- 命令行能开、双击不能 → 快捷方式目标错了，删桌面/开始菜单旧快捷方式，从新安装目录重新创建
- 命令行也不能开 → 对比安装目录与 win-unpacked 是否一致

**3. 对比关键文件是否存在**

```bat
dir "%LOCALAPPDATA%\Programs\ChatAuditExport\resources\app.asar.unpacked\main.mjs"
dir "C:\dev\electron\dist\win-unpacked\resources\app.asar.unpacked\main.mjs"
```

**4. 看启动诊断日志**

```bat
type "%APPDATA%\chat-audit-export\logs\bootstrap.log"
```

若 `resolveMainEntry FAILED`，说明安装目录缺 `app.asar.unpacked`，需完整重装。

**5. 快速验证是否为 NSIS 安装问题**

把 win-unpacked 整目录覆盖到安装目录（仅本机调试）：

```bat
xcopy /E /Y "C:\dev\electron\dist\win-unpacked\*" "%LOCALAPPDATA%\Programs\ChatAuditExport\"
```

覆盖后能开 → 说明之前安装目录内容不对或未更新；应走「卸载 + 删目录 + 重装新 Setup」。

---

## 5. crm-preflight：`prepare-export` 无效子命令

### 现象

```text
crm-preflight.py: error: argument cmd: invalid choice: 'prepare-export'
```

### 原因

1. 源码 `chat-audit-export/scripts/crm-preflight.py` **已有** `prepare-export`
2. 实际运行的是旧的 **`crm-preflight.exe`**（PyInstaller 缓存），构建时因「已存在」跳过重新打包

### 解决方案

1. 强制重打预检：
   ```bat
   node scripts\prepare-runtime.cjs --win-x64 --force
   ```
2. 脚本已增加：对比 `crm-preflight.py` 的 SHA256，源码变更则自动重打包
3. `preflight-runner.js` 在检测到 `invalid choice: 'prepare-export'` 时，回退到 `navigate-audit` → `close-dialog` → `set-department` → `set-dates` → `gate-start-export` 组合命令

**相关文件：** `electron/scripts/prepare-runtime.cjs`、`electron/src/lib/preflight-runner.js`

---

## 6. 导出阶段：`ENOENT: mkdir '\\?'`

### 现象

预检显示「预检通过，开始导出」后报错：

```text
ENOENT: no such file or directory, mkdir '\\?'
```

### 原因（推断）

输出目录路径在 Windows 上被错误解析（例如长路径前缀 `\\?\` 被截断），`path.resolve` / `mkdir` 收到非法路径。常见于：

- 输出目录未正确选择或保存了异常字符串
- 环境变量 `OUTPUT_PATH` / `CHAT_AUDIT_EXPORT_DIR` 异常

### 解决方案

1. 在应用内**重新选择**合法输出目录（如 `D:\chat-audit-export`）
2. 确认界面「输出目录」不为空、无乱码
3. 使用完整安装包安装后再运行，勿只复制单个 exe
4. 若仍出现，检查 `chat-audit-export/scripts/lib/export-path.js` 对 Windows 路径的规范化逻辑

---

## 7. prepare-runtime：PowerShell 解压参数为空

### 现象

```text
Expand-Archive : 无法对参数“LiteralPath”执行参数验证。参数为 Null 或空
Expand-Archive -LiteralPath $args[0] ...
```

### 原因

`execFileSync('powershell', ['-Command', '... $args[0] ...', archivePath, dest])` 中，**`-Command` 不会把后续 argv 传给 `$args`**，路径实际为空。

### 解决方案

将路径写入命令字符串（使用 `JSON.stringify` 转义）：

```javascript
const ps = `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(RUNTIME_ROOT)} -Force`;
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], ...);
```

**相关文件：** `electron/scripts/prepare-runtime.cjs` → `extractArchive()`

---

## 8. prepare-runtime：`EPERM` 重命名 Node 目录失败

### 现象

```text
EPERM: operation not permitted, rename '...\node-v16.20.2-win-x64' -> '...\node-win32-x64'
```

### 原因

解压**之前**已 `mkdir` 创建了空的 `node-win32-x64`；Windows 无法将文件夹 `rename` 到**已存在**的目录名上。

### 解决方案

- 解压前**不要**创建目标目录 `destDir`
- 解压前删除可能残留的 `node-v16.20.2-win-x64` 与旧的 `node-win32-x64`
- 解压完成后再 `renameSync(extracted, destDir)`

手动清理后重试：

```bat
rmdir /s /q runtime\node-win32-x64
rmdir /s /q runtime\node-v16.20.2-win-x64
node scripts\prepare-runtime.cjs --win-x64 --force
```

---

## 9. PyInstaller 与 Python 版本（Win7 关键）

### 现象

- 构建日志显示 `Python: 3.14.5`，打包成功
- Win7 上 `crm-preflight.exe` 无法运行或预检失败

### 原因

PyInstaller 打出的 exe **内嵌构建机 Python 运行时**。Python 3.14 **不支持 Windows 7**；在 Win7 目标环境必须用 **Python 3.8.x**（或项目验证过的其它仍支持 Win7 的版本）执行打包。

### 解决方案

1. 安装 [Python 3.8.10 64-bit](https://www.python.org/downloads/release/python-3810/)（可与 3.14 并存，无需卸载）
2. 安装依赖：
   ```bat
   py -3.8 -m pip install pyinstaller websockets
   ```
3. 将 3.8 的 `pyinstaller` 置于 PATH 最前，或显式用 `py -3.8 -m PyInstaller` 打包后复制到 `runtime\python-win32-x64\`
4. 执行 `node scripts\prepare-runtime.cjs --win-x64 --force` 再 `pnpm build`

### 验证

```bat
runtime\python-win32-x64\crm-preflight.exe --help
```

应能看到子命令列表（含 `prepare-export`）。

### 其它提示

```text
DEPRECATION: Running PyInstaller as admin is not necessary...
```

仅为警告；建议使用**非管理员**终端打包。

---

## 10. pnpm 11：`onlyBuiltDependencies` 警告

### 现象

```text
The "pnpm" field in package.json is no longer read ... "pnpm.onlyBuiltDependencies"
```

### 原因

pnpm 11 不再从 `package.json` 的 `pnpm` 字段读取该配置。

### 解决方案

在 `electron/.npmrc` 中配置：

```ini
onlyBuiltDependencies[]=electron
```

并执行 `pnpm rebuild electron` 确保 Electron 二进制正确下载。

---

## 11. 构建产物与「是否打包成功」

### 成功标志

日志末尾类似：

```text
building target=nsis file=dist\一手聊天审计导出 Setup 1.0.0.exe
building block map ...
```

且无 `⨯` / `[ELIFECYCLE] Command failed`。

### 产物位置

| 文件 | 用途 |
|------|------|
| `dist\一手聊天审计导出 Setup 1.0.0.exe` | **给最终用户安装** |
| `dist\win-unpacked\` | 绿色目录，本机调试 |

### Win7 支持范围说明

| 场景 | 是否支持 |
|------|----------|
| 64 位 Windows 7 + 当前 x64 安装包 | ✅（需 Electron 22 + Node 16 + Python 3.8 打的 preflight） |
| 32 位 Windows 7 | ❌ 需单独打 `ia32` 架构（当前 `pnpm build` 未包含） |
| Windows 10/11 x64 | ✅ |

---

## 12. 配置变更清单（便于 Code Review）

| 文件 | 变更要点 |
|------|----------|
| `electron/package.json` | `electron@22.3.27`；`main: main.cjs`；`files`/`asarUnpack` 显式包含主进程 ESM；`build` 仅 `--win --x64` |
| `electron/main.cjs` | 解析 `app.asar.unpacked/main.mjs` 后动态 import |
| `electron/scripts/prepare-runtime.cjs` | Node 16.20.2；Win 包名 `win-x64`；PowerShell 解压；rename 流程；preflight 源码 hash |
| `electron/src/lib/runtime-paths.js` | Win 下 `node.exe` 路径 |
| `electron/src/lib/preflight-runner.js` | `prepare-export` 失败时 legacy 回退 |
| `electron/.npmrc` | `onlyBuiltDependencies[]=electron`、镜像配置 |

---

## 13. 常见排障命令速查

```bat
:: 查看系统位数（Win7）
systeminfo | findstr /C:"系统类型"

:: 确认 Electron 版本
cd electron
pnpm exec electron --version

:: 强制重做 runtime
node scripts\prepare-runtime.cjs --win-x64 --force

:: 清理 electron-builder 签名工具缓存
rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"

:: 完整 Windows 安装包构建
pnpm build
```

---

## 14. 参考链接

- [Electron Breaking Changes — Removed Windows 7/8/8.1 support (v23+)](https://github.com/electron/electron/blob/main/docs/breaking-changes.md)
- [electron-builder #8149 — winCodeSign symlink on Windows](https://github.com/electron-userland/electron-builder/issues/8149)
- [Node.js 16.20.2 下载](https://nodejs.org/dist/v16.20.2/)
- [Python 3.8.10 下载](https://www.python.org/downloads/release/python-3810/)

---

*文档整理自 2026-05 前后 Win7 兼容打包实践，随仓库配置演进请同步更新本节「当前推荐配置」。*
