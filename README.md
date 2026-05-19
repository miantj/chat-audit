# 一手聊天审计导出工具

面向业务人员的桌面工具（**Electron**）；核心导出逻辑在 `chat-audit-export/`（与 Cursor Skill 共用同一套 Node/Python 脚本）。

## 系统要求

- **macOS** 或 **Windows 10/11**
- Google Chrome（推荐）或 Chromium
- **Node.js 22+**（运行导出脚本）
- **Python 3.10+**（仅 CRM 预检脚本 `crm-preflight.py` 等，需 `pip install -r chat-audit-export/scripts/requirements-preflight.txt`）

## 项目结构

| 目录 | 说明 |
|------|------|
| `electron/` | 桌面 GUI（主入口） |
| `chat-audit-export/` | 导出引擎与 Skill 文档（`SKILL.md`） |

## 使用方法（最终用户）

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

### 打包

```bash
cd electron
pnpm run build      # Windows NSIS
pnpm run build:mac  # macOS DMG
```

打包产物会将 `chat-audit-export/scripts` 打入 `resources/scripts`。

## 无 GUI：Agent / CLI

无需 Electron，在 `chat-audit-export/scripts/` 下按 `chat-audit-export/SKILL.md` 执行 `crm-preflight.py`、`export-date-range.js`、`export-with-self-heal.sh` 等即可。

## 依赖说明

| 组件 | 说明 |
|------|------|
| Chrome | 远程调试默认 `http://127.0.0.1:9222`；应用会启动专用配置目录 |
| Node.js 22+ | `export-date-range.js` 等 |
| Python 3 + websockets | `crm-preflight.py`、`refresh-wecom-qr.py` |
