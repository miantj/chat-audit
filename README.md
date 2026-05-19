# 一手聊天审计导出工具

面向业务人员的桌面工具（**Electron**）；核心导出逻辑在 `chat-audit-export/`（与 Cursor Skill 共用同一套 Node/Python 脚本）。

## 系统要求

- **macOS** 或 **Windows 10/11**
- **Google Chrome**（推荐；应用会启动专用配置目录，需用户本机已安装 Chrome）
- **Windows 额外需要**： [Git for Windows](https://git-scm.com/)（提供 `bash.exe`，用于导出脚本）

**开发模式**（`pnpm start`）仍使用本机 **Node.js 22+** 与 **Python 3.10+**（`pip install -r chat-audit-export/scripts/requirements-preflight.txt`）。

**安装包（方案 A）** 已内嵌 **Node 22** 与 **crm-preflight**（PyInstaller），一般**无需**用户再装 Node/Python。

## 项目结构

| 目录 | 说明 |
|------|------|
| `electron/` | 桌面 GUI（主入口） |
| `chat-audit-export/` | 导出引擎与 Skill 文档（`SKILL.md`） |

## 使用方法（最终用户）

### macOS 安装后提示「无法打开」？

本应用**未做 Apple 开发者签名/公证**。从 DMG 安装后若双击提示 *can't be opened*，任选其一即可：

1. **推荐**：在「应用程序」里找到 **一手聊天审计导出** → **右键** → **打开** → 再点「打开」（仅需首次）
2. 终端执行（把路径换成你的安装位置）：
   ```bash
   xattr -dr com.apple.quarantine "/Applications/一手聊天审计导出.app"
   open "/Applications/一手聊天审计导出.app"
   ```
3. **系统设置** → **隐私与安全性** → 若出现「仍要打开」，点允许

- **Apple 芯片（M1/M2/M3）** 请安装 `一手聊天审计导出-*-arm64.dmg`，不要用 x64 包。
- 对话框里若显示成「—手…」是系统字体问题，应用名仍是「一手聊天审计导出」。

重新打包后若仍被拦截，开发者可在 `electron` 目录执行 `pnpm run build:mac:arm64` 生成新的 arm64 安装包。

---

1. 安装并构建应用（见下方「开发者」），或运行打包后的安装包
2. 启动应用后会尝试打开**专用 Chrome**（`~/.chrome-chat-audit-profile`）；若见登录页，请在该窗口登录 CRM（验证码需人工输入）
3. 选择导出日期、部门与输出目录
4. 点击「开始导出」；失败时会尝试有限次自愈，并依赖 checkpoint 续跑；全部完成后自动生成 `chat-audit-日期.business.csv`

## 开发者

```bash
# 1. 安装 Electron 依赖
cd electron && pnpm install

# 2. 安装 Python 预检依赖（首次）
pip install -r ../chat-audit-export/scripts/requirements-preflight.txt

# 3. 开发运行
pnpm start
```

从仓库根目录也可：

```bash
pnpm --dir electron install
pnpm --dir electron start
```

### 打包（方案 A：内嵌 Node + 预检）

```bash
cd electron
pnpm install

# 1. 下载 Node 二进制 + PyInstaller 打包 crm-preflight（需本机 Python 3 + pip install pyinstaller websockets）
pnpm run prepare-runtime

# 2. 打安装包（会自动执行 prepare-runtime）
pnpm run build:mac          # macOS DMG（默认 arm64 + x64，体积较大）
pnpm run build:mac:arm64    # 仅 Apple 芯片（推荐在 M 系列 Mac 上打给同事用）
pnpm run build:mac:x64      # 仅 Intel Mac
pnpm run build       # Windows NSIS（须在 Windows 上执行）
```

打包会将 `chat-audit-export/scripts` → `resources/scripts`，`electron/runtime` → `resources/runtime`（内嵌 Node 与 crm-preflight）。

跨平台：在 Mac 上 `prepare-runtime` 只生成 darwin 运行时；Windows 包需在 Windows 上再跑一遍 `prepare-runtime` 后 `pnpm run build`。

## 无 GUI：Agent / CLI

无需 Electron，在 `chat-audit-export/scripts/` 下按 `chat-audit-export/SKILL.md` 执行 `crm-preflight.py`、`export-date-range.js`、`export-with-self-heal.sh` 等即可。

## 依赖说明

| 组件 | 说明 |
|------|------|
| Chrome | 远程调试默认 `http://127.0.0.1:9222`；应用会启动专用配置目录 |
| 内嵌 Node 22 | 安装包内 `resources/runtime/node-*`；开发态用系统 `node` |
| 内嵌 crm-preflight | 安装包内 PyInstaller 产物；开发态用系统 `python3` + `.py` |
| refresh-wecom-qr | 仍依赖系统 Python（仅手动排障时用） |
