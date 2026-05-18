# 一手聊天审计导出工具（Windows GUI 版）

面向业务人员的 Windows 桌面工具；核心导出逻辑在 `chat-audit-export/`（与 Cursor Skill 共用同一套 Node 脚本）。

## 系统要求

- Windows 10/11
- Google Chrome 或 Microsoft Edge
- 网络（首次使用可自动下载 Node.js）

## 依赖说明

| 组件 | 说明 |
|------|------|
| Chrome/Edge | 远程调试端口默认 `9222`；应用可一键启动专用配置目录 |
| Node.js 22+ | 导出与 CRM 预检脚本需要；应用内可自动安装到 `%APPDATA%\chat-audit-export\nodejs` |
| Python 3 | 仅开发/打包 GUI 时需要；最终用户运行 `chat-audit-export.exe` 可不装 Python |

## 使用方法

1. 双击 `dist/chat-audit-export/chat-audit-export.exe`（或开发态运行 `python run.py`）
2. 若提示 Chrome 未连接，点击「启动 Chrome」或手动：`chrome.exe --remote-debugging-port=9222`
3. 在浏览器中登录 CRM（验证码需人工输入）
4. 选择日期范围、部门与输出目录
5. 点击「开始导出」；失败时应用会尝试有限次自愈并重试（依赖 checkpoint 续跑）

## 开发者 / Agent 直接使用 Skill

无需 GUI，在 `chat-audit-export/scripts/` 下按 `chat-audit-export/SKILL.md` 执行 `crm-check.js`、`export-date-range.js` 等即可。
