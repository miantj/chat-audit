# Chat Audit Export - 三Tab并行架构设计

**日期：** 2026-05-18
**状态：** 设计中
**版本：** v1.0

---

## 1. 背景与目标

当前架构是单 tab 串行处理，导致导出速度慢（10个客户需要很久）。目标是提升 3-5x 速度，同时保留断点续跑机制和现有的自愈能力。

**核心约束：**
- 企业微信扫码登录按 Chrome Profile 计，不是按 Tab，3 个 tab 共用同一登录态
- CRM 可能对多 tab 并发操作做限制，3 个 tab 是安全上限
- checkpoint 机制必须跨 tab 续跑
- WeCom iframe 登录刷新需要知道操作哪个 tab

---

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process                                   │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Orchestrator (新)                                 │  │
│  │  ├─ TabManager: 管理 3 个 CDP 连接                 │  │
│  │  ├─ EmployeeDistributor: 分发员工给各 tab          │  │
│  │  ├─ SharedState: checkpoint + WeCom 登录状态       │  │
│  │  └─ SelfHealCoordinator: 跨 tab 的自愈协调         │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────────┐  │
│  │  Tab 1        │  │  Tab 2        │  │  Tab 3      │  │
│  │  CDP Client 1 │  │  CDP Client 2 │  │  CDP Client 3│  │
│  │  员工 1-N/3  │  │  员工 N/3+1-2N/3 │ │  员工 2N/3+1-N │  │
│  └───────────────┘  └───────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                    │                   │
         └────────────────────┴───────────────────┘
                    Chrome (同一 Profile)
```

---

## 3. 核心组件设计

### 3.1 TabManager

管理 3 个 CDP 连接的生命周期：

```typescript
class TabManager {
  private tabs: CDPClient[] = [];
  private tabIndex = 0;  // 用于轮询分发员工

  async initialize(cdpBase: string): Promise<void> {
    // 从 Chrome /json 获取 3 个 page target
    // 创建 3 个 CDPClient 并连接
    // 设置各 tab 的初始页面为 CRM 聊天审计页
  }

  getNextTab(): CDPClient {
    // 轮询返回下一个可用的 tab
    const tab = this.tabs[this.tabIndex];
    this.tabIndex = (this.tabIndex + 1) % this.tabs.length;
    return tab;
  }

  async executeOnTab(tabIndex: number, fn: (client: CDPClient) => Promise<void>): Promise<void> {
    // 在指定 tab 上执行操作
    // 失败时记录，并标记该 tab 不可用
  }

  async closeAll(): Promise<void> {
    // 关闭所有 CDP 连接，但不关 Chrome
  }
}
```

**启动顺序：**
1. CDP probe 检查 Chrome 是否可达
2. 调用 Chrome `/json/new` 创建 3 个新 tab
3. 分别 navigate 到 CRM 聊天审计页
4. 确认每个 tab 的 `check-page` 返回 `on chat audit page`

### 3.2 EmployeeDistributor

将员工列表分组，分配给 3 个 tab：

```typescript
class EmployeeDistributor {
  constructor(
    private employees: Employee[],
    private tabCount: number
  ) {}

  getAssignments(): Map<number, Employee[]> {
    // 将员工列表均分给 3 个 tab
    // 例如：员工 [A,B,C,D,E,F,G,H,I]，tab数=3
    // 结果：tab0=[A,B,D,E,G,H], tab1=[B,E,H], tab2=[C,F,I]（错开发送减少冲突）
    // 或者简单均分：tab0=[A,D,G], tab1=[B,E,H], tab2=[C,F,I]
  }
}
```

### 3.3 SharedState

跨进程/线程共享状态：

```typescript
class SharedState {
  // checkpoint 文件路径（各 tab 读写同一个文件）
  checkpointPath: string;

  // WeCom 登录状态（哪个 tab 当前有有效的 iframe）
  activeLoginTab: number | null;

  // 当前进度（已完成的 conversation_id 列表）
  completedIds: Set<string>;

  async loadCheckpoint(): Promise<Checkpoint> {}
  async saveCheckpoint(cp: Checkpoint): Promise<void> {}
  async markCompleted(conversationId: string): Promise<void> {}

  setActiveLoginTab(tabIndex: number): void {}
  getActiveLoginTab(): number | null {}
}
```

**checkpoint 续跑逻辑：**
- 各 tab 读取同一个 checkpoint 文件
- `shouldSkip*BeforeCheckpoint` 逻辑不需要改
- 每个 conversation 完成后 `markCompleted` 写入 checkpoint
- 理论上可以 3 个 tab 同时写，但需要文件锁保护（Node.js `fs` 不支持文件锁，改为 append-only JSONL + reconcile）

### 3.4 SelfHealCoordinator

跨 tab 的自愈协调：

```
当 tab0 失败：
  1. diagnose-state 获取当前状态
  2. 判断错误类型
  3. 如果是 CDP_NO_TARGET → 在 tab0 上重新 navigate
  4. 如果是 CASCADER_STUCK → 在 tab0 上移除 dropdown
  5. 其他 tab 不受影响，继续处理

当 WeCom 登录过期（WXWORK_LOGIN_EXPIRED）：
  1. 找到当前持有 activeLoginTab 的 tab
  2. 在该 tab 上执行 refresh-wecom-qr.py
  3. 通知用户扫码
  4. 用户确认后，3 个 tab 全部需要重新验证 WeCom iframe
```

### 3.5 并行化后的时间线对比

**单 tab（当前）：**
```
t=0    员工A-客户1 打开dialog
t=5    获取metric客户
t=10   搜索客户，打开iframe
t=15   滚动消息
t=25   完成客户1，切换客户2
t=30   ...（串行）
```

**三 tab 并行：**
```
t=0    Tab0:员工A-客户1  Tab1:员工B-客户1  Tab2:员工C-客户1
t=5    Tab0:完成客户1   Tab1:完成客户1   Tab2:完成客户1
t=10   Tab0:员工A-客户2  Tab1:员工B-客户2  Tab2:员工C-客户2
       （每个tab处理自己的员工客户，互不阻塞）
```

---

## 4. 延迟优化（非并行，仅削减浪费）

在不影响可靠性的前提下削减等待时间：

| 当前值 | 优化后 | 场景 |
|--------|--------|------|
| `STABLE_POLL_MS=1200`, `ATTEMPTS=12` (共14.4s) | 6次，共7.2s | 消息不稳定时 |
| `MESSAGE_SCROLL_DELAY_MIN_MS=1500` | 500ms | 滚动间隔 |
| `SELECT_FRIEND_DELAY_MAX_MS=5000` | 2000ms | 选好友后 |
| `SEARCH_RESULT_DELAY_MAX_MS=4000` | 1500ms | 搜索结果等待 |
| `CUSTOMER_DELAY_MAX_MS=3000` | 1500ms | 客户间延迟 |

**原则：** 保留稳定性检测机制，但缩短超时时间让问题早暴露早重试。

---

## 5. WeCom 登录状态共享

**问题：** 3 个 tab 共享同一 Chrome profile，WeCom 登录状态是共享的。

**设计方案：**
- `SharedState.activeLoginTab` 记录"当前哪个 tab 的 WeCom iframe 处于可交互状态"
- 正常情况下，所有 tab 的 WeCom iframe 都应该是登录态（因为同一 profile）
- 当某个 tab 检测到 `login.work.weixin.qq.com` iframe 出现：
  - 设置 `activeLoginTab = 该tab的index`
  - 暂停该 tab 的任务
  - 用户在主 UI 看到"需要扫码"提示
  - `refresh-wecom-qr.py` 在该 tab 上刷新 iframe 并提取 QR
  - 用户确认扫码成功后，清除 `activeLoginTab`，3 个 tab 恢复工作

---

## 6. 断点续跑兼容性

现有 checkpoint 逻辑完全兼容，只需要修改写入时机：

| 场景 | 当前行为 | 并行后行为 |
|------|---------|-----------|
| checkpoint 读取 | 单进程读一次 | 每个 tab 启动时读一次 |
| checkpoint 写入 | 每个 conversation 后写 | append-only JSONL，每个 conversation 后追加 |
| resume | 从 checkpoint 文件恢复 | 从 JSONL + checkpoint 两个源 reconciled |
| 3个tab同时写 | 不可能 | 不可能（轮流写，或靠 JSONL append-only 天然安全）|

**JSONL append-only 天然线程安全：** 每个 tab 只做 `fs.appendFile`，不 rewrite，不会丢失数据。

---

## 7. 错误处理

| 错误类型 | Tab 内处理 | 跨 Tab 处理 |
|---------|-----------|------------|
| `CDP_NO_TARGET` | 在该 tab 重试 1 次，无效则标记 tab 不可用 | 其他 tab 继续工作 |
| `CASCADER_STUCK_OPEN` | 在该 tab 执行 DOM cleanup | 其他 tab 继续工作 |
| `RATE_LIMITED` | 所有 tab 立即停止，写 checkpoint，退出 | - |
| `WXWORK_LOGIN_EXPIRED` | 暂停该 tab，等待用户在 UI 操作 | 其他 tab 暂停 |
| `DIALOG_OPEN_FAIL` | 在该 tab 重试 3 次 | 其他 tab 继续工作 |

---

## 8. Electron 集成

**进程模型：**
```
Main Process (Electron)
├── Orchestrator (Node.js)
│   ├── TabManager
│   ├── EmployeeDistributor
│   ├── SharedState
│   └── SelfHealCoordinator
└── Renderer Process (UI)
    ├── 当前进度显示
    ├── 日志输出
    └── 用户操作按钮（暂停/停止/刷新QR）
```

**IPC：**
- Main → Renderer：进度更新（`ipc:export-progress`）
- Renderer → Main：用户操作（`ipc:pause`, `ipc:stop`, `ipc:refresh-qr`）

---

## 9. 打包方案

**Electron + electron-builder：**
```bash
npm install electron electron-builder
npx electron-builder --win --publish never
```

**输出：** Electron 打包产物（`electron/dist/`，如 macOS DMG / Windows NSIS）

**包含内容：**
- Node.js 22 + Chromium（Electron 内置）
- Python 3（需要单独打包或用户安装）
- `scripts/` 目录（打包进 asar）

**Python 依赖问题：**
- 方案 1：用户需要安装 Python 3（运行时检测提示安装）
- 方案 2：用 PyInstaller 打包 Python 解释器进 Electron
- 方案 3：将 Python 脚本全部重写为 Node.js（成本高）

**推荐方案 2：** 用 `electron-python-shell` 或 PyInstaller + 打包脚本，让用户第一次运行时自动安装 Python（或用 zip 打包一个预编译的 Python 3）。

---

## 10. 实施步骤（待确认后细化）

1. **新建 Electron 项目** (`electron/`) 并验证 Chrome CDP 连接
2. **实现 TabManager** — 3 tab 创建、CDP 连接管理
3. **实现并行调度** — EmployeeDistributor + SharedState
4. **移植自愈逻辑** — SelfHealCoordinator
5. **延迟优化** — 削减浪费等待时间
6. **WeCom 登录集成** — activeLoginTab + UI 扫码流程
7. **Electron UI** — 进度、日志、操作按钮
8. **打包测试** — electron-builder 打包 + Windows 测试

---

## 11. 待确认问题

- [ ] Python 运行时：用户已有 Python 3，还是需要打包进 exe？
- [ ] 日志详细程度：export-progress 的更新频率（当前每10个客户一次）
- [ ] UI 风格：深色/浅色？中文 only？