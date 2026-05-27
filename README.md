# 一手聊天审计导出工具

Electron 桌面壳 + `chat-audit-export/` 导出脚本（与 Skill 共用）。

| 目录 | 说明 |
|------|------|
| `electron/` | GUI、打包 |
| `electron/docs/win7-build-compatibility.md` | **Windows / Win7 打包与排障（案例）** |
| `chat-audit-export/` | 导出引擎、`SKILL.md` |

## 环境

| 场景 | 要求 |
|------|------|
| 开发 `pnpm start` | Node 20+、Python 3.8+、`pip install -r chat-audit-export/scripts/requirements-preflight.txt`、本机 Chrome |
| 安装包（用户） | 仅 Chrome；内嵌 Node 16 + `crm-preflight.exe` |
| Win7 目标 | 64 位；Electron 22 + Node 16（自动 `NODE_SKIP_PLATFORM_CHECK`）+ Python 3.8 打 preflight → [win7 文档](electron/docs/win7-build-compatibility.md) |

## 用户

1. 安装打包产物（macOS：DMG；Windows：`一手聊天审计导出 Setup *.exe`）
2. 启动后登录专用 Chrome 窗口中的 CRM
3. 选日期、部门、输出目录 → 开始导出

**macOS 提示「无法打开」**（未公证）：

```bash
xattr -dr com.apple.quarantine "/Applications/一手聊天审计导出.app"
open "/Applications/一手聊天审计导出.app"
# 或：应用程序 → 右键 → 打开（仅首次）
```

Apple 芯片用 `*-arm64.dmg`，勿装 x64 包。

## 开发

```bash
cd electron && pnpm install
pip install -r ../chat-audit-export/scripts/requirements-preflight.txt
pnpm start
```

```bash
pnpm --dir electron install
pnpm --dir electron start
```

## 打包

### macOS

```bash
cd electron
pnpm install
pnpm run prepare-runtime          # 或 prebuild:mac
pnpm run build:mac:arm64          # M 系列推荐
# pnpm run build:mac:x64
```

### Windows（须在 Windows 上）

```bat
cd electron
pnpm install
py -3.8 -m pip install pyinstaller websockets
node scripts\prepare-runtime.cjs --win-x64 --force
pnpm build
```

产物：`dist\一手聊天审计导出 Setup 1.0.0.exe`（用户）、`dist\win-unpacked\`（调试）。

**Windows 装后打不开、无日志：** 直接查 [electron/docs/win7-build-compatibility.md](electron/docs/win7-build-compatibility.md) → [B1 主进程打包](electron/docs/win7-build-compatibility.md#b1-主进程打包)、[B2 安装版无反应](electron/docs/win7-build-compatibility.md#b2-安装版无反应)。

```bat
type "%APPDATA%\chat-audit-export\logs\bootstrap.log"
"%LOCALAPPDATA%\Programs\ChatAuditExport\ChatAuditExport.exe" --enable-logging
```

Mac 上 `prepare-runtime` 只生成 darwin runtime；Windows 包须在 Windows 重跑 `prepare-runtime` 再 `pnpm build`。

## 发布 Release

GitHub Actions 会在推送 `v*` 标签时自动构建 macOS / Windows 安装包，并发布到 [Releases](https://github.com/miantj/chat-audit/releases)。

### 自动发布（推荐）

```bash
# 1. 更新 electron/package.json 中的 version（可选，CI 会按 tag 同步）
# 2. 提交并打标签
git tag v1.0.1
git push origin v1.0.1
```

### 手动触发

在 GitHub → Actions → **Release** → **Run workflow**，填写版本号（如 `1.0.1`）。

### 本地发布

需先设置 `GH_TOKEN`（GitHub Personal Access Token，含 `repo` 权限）：

```bash
export GH_TOKEN=ghp_xxxx

# macOS
pnpm release:mac

# Windows
pnpm release:win
```

产物：macOS `*.dmg`（arm64 + x64）、Windows `一手聊天审计导出 Setup *.exe`。

## 无 GUI

见 `chat-audit-export/SKILL.md`（`crm-preflight.py`、`export-with-self-heal.mjs` 等）。

## 运行时依赖

| 组件 | 说明 |
|------|------|
| Chrome | 默认 CDP `http://127.0.0.1:9222`，专用 profile |
| 内嵌 Node 16 | `resources/runtime/node-win32-x64`（安装包） |
| 内嵌 crm-preflight | `resources/runtime/python-win32-x64`（安装包） |
| refresh-wecom-qr | 排障用，需系统 Python |
