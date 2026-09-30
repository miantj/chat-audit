---
name: qiyu
description: >-
  网易七鱼：CDP 控制本机 Chrome 打开后台并导出会话。
  提到七鱼、qiyu、会话记录、导出会话时使用。
---

# 七鱼

## 转登记摘录

```bash
node scripts/to-register.mjs
# → exports/售前登记摘录-YYYY-MM-DD.csv
```

列：AI咨询分类、七鱼咨询分类、日期、会话结束时间、一手用户id、会话id、是否疑似c端、货号、用户问题。
**AI咨询分类**：优先文档「11. 分类」关键词（可多选逗号拼接）；无法判断/问题太短/无关键词 → 七鱼路径的三级分类。
**七鱼咨询分类**：只展示七鱼导出路径的第三级；四级及以上截断到三级，缺少三级的路径留空。多个货号在同一单元格内换行，用户问题也在同一单元格内换行。
**会话结束时间**：优先用「访客首条消息时间 + 会话时长」计算；缺少计算字段时回退七鱼字段，保留到分钟（`YYYY-MM-DD HH:mm`）。

## 异步导出（推荐）

已登录专用 Chrome 后：

```bash
cd qiyu
node scripts/download.mjs         # 默认昨天；可 --start/--end YYYY-MM-DD
```

流程：`POST /chat/api/session/download` 发起 → `GET /api/download/task/list` 轮询 `status=2` → 下 `url` 到 `exports/`。  
下载完成后生成 CSV，并写入飞书知识库表格 [售前登记摘录](https://yb7ao262ru.feishu.cn/wiki/Y8niwzMiliLdyUkb21VcMVqHnMe?sheet=ej5BzF)：  
- 子表名 = 下载日（如 `2026-09-27`），同日多次覆盖  
- 可用环境变量 `QIYU_LARK_SHEET_URL` 覆盖目标表格  
筛选默认：有效会话 + 商详 5 类 category（面料/尺码/配件/颜色/款式）。

如果会话过期，脚本会读取 `.env` 中的 `QIYU_USERNAME` / `QIYU_PASSWORD` 自动填账号密码：登录按钮可点就直接点；不可点才等易盾「点击/滑块」（需你在专用 Chrome 里完成）。未配置账号时先执行 `node scripts/browser.mjs login`。

## 每天 13 / 18 / 24 点自动更新当日

本机 launchd（需用户已登录；依赖专用 Chrome + Node）：

```bash
cd qiyu
./scripts/install-daily-update.sh          # 安装并启用
./scripts/daily-update.sh                  # 立刻试跑（默认今日）
./scripts/install-daily-update.sh uninstall
```

- 13:00、18:00：拉**当天**数据，同名飞书子表覆盖  
- 00:00（24 点）：拉**刚结束的那天**（收口）  
日志在 `qiyu/logs/daily-update-YYYY-MM-DD.log`。
## 浏览器控制（CDP）

专用 Chrome：`~/.chrome-qiyu-profile`，调试口 **9333**。

```bash
node scripts/browser.mjs open
node scripts/browser.mjs login
node scripts/browser.mjs status
```
