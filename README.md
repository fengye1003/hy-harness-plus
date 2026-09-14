# dsh-harness-plugins · DeepSeek Harness 插件集

> 主作者：**星澄（Hoshino Sumi）** · **HYrecovery 的 AI 小助手** · 2026-08 · 零依赖（仅 Node 内置模块）
> 仓库地址：**https://github.com/fengye1003/hy-harness-plus**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 本地 AI 工作台补齐三件「日常刚需」的零依赖插件：

| 插件 | 目录 | 一句话 |
|---|---|---|
| 🔐 **dsh-web-auth** | [`web-auth/`](web-auth/) | TOTP 2FA + 30 天 Cookie Token 认证，把本地 Web 面板安全地暴露到局域网/内网 |
| 🤖 **dsh-tg-bot** | [`tg-bot/`](tg-bot/) | Telegram 桥接：让 Telegram 成为你的第二对话入口（双向对话 + 进度汇报 + TOTP 白名单） |
| ⏰ **wake** | [`wake/`](wake/) | 通用事件唤醒通道：任何脚本写一份 `wake.json` 就能唤醒 agent 执行并汇报 |
| 🧩 **dsh-no-token-auth** | [`no-token-auth/`](no-token-auth/) | 配套补丁：关掉 Harness 核心内置的 `?token=` 登录，让 2FA 守卫成为唯一门禁（**必须与 web-auth 守卫补丁 v2 配套**） |

三个插件互相配合形成一个完整的「本地 AI 工作台可远程使用」闭环：

```
浏览器(局域网/Tailscale) ──► DSH Web 面板 ──┬─► dsh-web-auth  认证守卫（TOTP 2FA）
                                            │
Telegram ──────────────► dsh-tg-bot ────────┤   双向对话 / 进度汇报 / tg_send 工具
                                            │
定时器 / Python 下载器 / 监控 ──► wake.json ─┘   （wake 通道 → dsh-tg-bot 注入会话）
```

## ⚠️ 重要更正（2026-09-14）：`web-auth` 历史上的一个致命坑

如果你用 `web-auth` 把面板暴露到内网，并打算**关掉 Harness 核心内置的 `?token=` 登录**（让 2FA 成为唯一门禁），请务必：

1. 使用配套补丁 [`no-token-auth/`](no-token-auth/)（**marker 版**）；
2. 把 [`web-auth/apply-webserver-patch.mjs`](web-auth/apply-webserver-patch.mjs) 更新到 **v2**（含 `guard-passed` 标记；`--check` 会打印 `guard-passed marker:` 状态）。

**旧组合（v1 守卫补丁 + 关掉 token 校验）的症状**：服务在跑、页面能开，但 `/api/*` **全部 400 空响应**、WebSocket `/api/remote.mux` **一连就断**（控制台刷 `connection lost, retry #1…#11`）、`/open-in-app/apps` 也 400。

**根因不是守卫补丁**，而是补丁里那行 `this.ctx?.webServer?.guards`：cordis 对**未 `inject` 的服务属性访问会直接抛错**（`cannot get property "webServer" without inject`），`?.` 救不了——抛错的是 getter 本身。`dsh-client-connection` 只 inject 了 `credentials`，于是 `requestRejection()` 每次调用都在第一行抛异常，异常被 webserver 的兜底 catch 变成裸 400、被 upgrade 的 catch 变成 `socket.destroy()`。

**修法（v2）**：守卫放行后给请求打 `req[Symbol.for("dsh.guardPassed")] = true`（**只在 `guards.length > 0` 时打**，无守卫就回退核心门禁 = fail closed），业务层只读这个标记、不再碰 cordis 服务表。另一个附带修复：浏览器抓 `/manifest.webmanifest` **不带 cookie**，需要给守卫加公开路径白名单，否则永远 401。

**一条方法论（比结论更重要）**：`curl` 探针（`/`→401/302、`/auth/login`→200）**不能证明前端可用**——这个坑当年就是被 curl 探针判成「已修复」的。正确验收 = 真实浏览器登录 + WebSocket 保持连接 + 真发一条消息并收到回复（判据建议读会话落盘记录里的 `assistant` 消息，而不是页面文本）。

**版本与「降级」的真实含义（2026-09-14 补记）**：

- 本仓库最后一次**完整**验证是在 **DSH 0.1.5-rc.1 / `dsh-*` 0.1.5-rc.2** 上（真实浏览器 + 真实 TOTP 登录 + 真发真收）；下文与各插件 README 里「兼容 0.1.0-rc.7 ~ 0.1.1-rc.2」之类的旧声明只作历史参考。
- ⚠️ **降级 ≠ 安全**：当 webserver 补丁缺失（升级后被官方原版覆盖）时，插件会「路由注册但**没有请求守卫**」——**面板与 `/api/*` 在没有 TOTP 的情况下就能访问**（只剩核心的 Host/Origin 围栏与浏览器 cookie）。所以暴露到网络前，务必先 `node web-auth/apply-webserver-patch.mjs --check` 看到 `guard-passed marker: PRESENT`。
- `web-auth/test/test-integration.mjs` 用的是 **mock ctx**，结构上**无法**发现 cordis 的 inject 违规或 `/api/*` 400 这类问题，**不能当作端到端验证**（它只证明算法与路由逻辑）。

## 作者

**星澄（Hoshino Sumi）** —— HYrecovery 的 AI 小助手，运行于 DeepSeek Harness 之中。

本仓库的三个插件都出自星澄之手：从「给本地 AI 工作台加一道锁」的 dsh-web-auth 开始，到「让 AI 随时能被找到」的 dsh-tg-bot，再到「让任何脚本都能叫醒 AI」的 wake——都是在真实环境里一步步踩坑、修好、验证过的实践产物。

## 设计原则

- **零依赖**：全部只用 `node:` 内置模块，`npm install` 都不需要，复制即用。
- **不阻塞**：`apply` 不碰网络，轮询/汇报全异步，Telegram 或代理不可达只改状态重试，harness 照常工作。
- **安全优先**：验证路径纯代码（RFC 6238 TOTP），绝不经过 LLM——没有提示词注入面；凭据全部从配置/环境变量/状态文件读取，代码里零硬编码。

---

## 部署教程（从零到全链路）

> 目标环境：Windows / macOS / Linux 上运行 DeepSeek Harness **web profile**（`~/.dsh/profiles/web/`）。
> 全程约 15 分钟，不需要安装任何 npm 包。

### 第 0 步：确认前置条件

1. DeepSeek Harness 正常运行，Web 面板可访问（`http://127.0.0.1:8088` 或自定义端口）。
2. 找到你的 profile 目录：`~/.dsh/profiles/web/`，里面有 `cordis.patch.yml` 和 `node_modules/`。
3. **dsh-web-auth 需要 webserver 的 `registerGuard` / `tapIndex` 钩子**——若你的 harness 版本还没有，需要先打一个小补丁（一键脚本见 [`web-auth/apply-webserver-patch.mjs`](web-auth/apply-webserver-patch.mjs)，说明见 [`web-auth/README.md`](web-auth/README.md)）。

### 第 1 步：部署 dsh-web-auth（认证守卫）

1. 把 `web-auth/` 目录复制到 profile 目录，得到 `~/.dsh/profiles/web/auth-plugin/`。
2. 编辑 `cordis.patch.yml`，追加挂载：

```yaml
- insert:
    - id: web-auth
      name: './auth-plugin/index.js?v=3'
      config:
        passkey: '<你的应急口令，首次配置后请牢记>'   # 可选；不配则 bypass 路由禁用
        tokenTtlDays: 30
        stateFile: '~/.dsh/auth/state.json'
        backupDir: '~/.dsh/auth/backup'
        issuer: 'DSH'
        label: 'DeepSeek Harness'
```

3. 热重载（把 `?v=3` 的版本号 +1）或重启 harness。
4. 首次启动自动生成 TOTP 密钥：日志打印 `otpauth://totp/...` URI，同时备份到 `backupDir`（`totp-secret.txt`）。用身份验证器 App（Google Authenticator / 1Password / Aegis……）扫码添加。
5. 浏览器访问面板 → 输入 6 位动态码 → 完成。访问 `/auth/tokens` 可管理登录 Token。

✅ **验收**：无 cookie 访问面板被重定向到 `/auth/login`；输错验证码被拒绝；输入正确码后进入。

### 第 2 步：部署 dsh-tg-bot（Telegram 桥接，可选但推荐）

1. 找 [@BotFather](https://t.me/BotFather) 创建 Bot，拿到 token（形如 `123456789:AAF...`）。
2. 把 `tg-bot/` 目录复制到 profile 目录，得到 `~/.dsh/profiles/web/tg-bot/`。
3. 把 token 写入 `~/.dsh/tg-bot/token.txt`（或用配置项 `token` / 环境变量 `DSH_TG_BOT_TOKEN`）。
4. 在 `cordis.patch.yml` 追加挂载（示例见 [`tg-bot/examples/cordis.patch.yml`](tg-bot/examples/cordis.patch.yml)），热重载或重启。
5. Telegram 私聊你的 bot：`/start` → 用身份验证器 App（与第 1 步同一个）发 `/verify <6位码>` → 白名单落盘，之后免验证。

✅ **验收**：Telegram 里直接发消息，agent 回合结束自动回传回复；`/status` 显示桥接与连接状态。

> 无公网 IP 的机器默认走本地混合代理 `http://127.0.0.1:7897` 访问 Telegram API（`proxy` 配置项可改，空字符串 = 直连）。

### 第 3 步：部署 wake（通用事件唤醒，可选）

1. 把 `wake/` 目录复制到任何方便的位置（脚本可写即可），例如 `~/wake/`。
2. 在 `cordis.patch.yml` 的 `tg-bot` 配置块里加一行，指向 wake.json：

```yaml
        wakeFile: 'C:/path/to/wake/wake.json'   # 绝对路径；不配则默认在 stateDir 下
```

3. 测试：`node scheduler.mjs add "3h" "提醒我喝水" --open-terminal` → 到点后 agent 被唤醒并通过 TG 汇报。
4. （Windows）注册每分钟检查的计划任务，见 [`wake/README.md`](wake/README.md) 第四节。

✅ **验收**：`node wake-util.mjs status` 能看到未消费/已消费的唤醒信号；到点提醒到达 Telegram。

### 常见问题

| 现象 | 原因与解法 |
|---|---|
| 插件没生效 | `cordis.patch.yml` 挂载后未热重载/重启；`?v=N` 版本号没 +1 |
| 插件降级告警（`registerGuard missing`） | harness 升级冲掉了 webserver 补丁 → 跑 `node web-auth/apply-webserver-patch.mjs --apply` 重打，重启 |
| Telegram 一直 401 | bot token 错误 → 检查 `token.txt` / 配置 |
| getUpdates 报 409 | 有多个轮询实例（热重载残留）→ 重启 harness；插件自带文件级轮询锁可自愈 |
| 局域网 HTTP 访问页面白屏 | 老版本 harness 的 `crypto.randomUUID()` 在非 HTTPS 下崩溃 → 更新到含 UUID polyfill 的 web-auth 版本 |
| 唤醒没到 | 无绑定会话时不会注入；检查 harness 是否运行、`wakeFile` 路径是否正确 |

## 升级维护（重要）

- **DSH 升级（npx 重装）会覆盖 npm 缓存里的 webserver 补丁**——`registerGuard` 钩子随之丢失。web-auth 插件是**防御性加载**的：钩子缺失只降级告警、harness 照常启动（不会像旧版那样 fatal），但认证不生效。
- 恢复：`node web-auth/apply-webserver-patch.mjs --apply`（幂等，自动定位 npm 缓存与 profile 两处安装位置并保持 hash 一致），然后**重启 harness**。
- 2026-08-18 曾因升级冲掉补丁导致插件树 fatal、harness 无法启动；v3 防御性加载 + 补丁脚本就是为了让这类升级「只降级、不死机、一键恢复」。

### 最坏情况兜底（fatal 也救得回）

防御性加载之后理论上不会再 fatal，但**万一**真的撞上 harness 无法启动：**绝不删任何东西**——

1. 先重命名备份整个配置目录（不是删除）：`Rename-Item "$env:USERPROFILE\.dsh" "$env:USERPROFILE\.dsh.bak-<日期>"`；
2. 用新 harness 实例（此时无 `.dsh`，以全新默认配置启动，保证能 boot）去修复 `.dsh`：让新实例分析备份、还原数据（可 `robocopy` 恢复并跳过 `node_modules`，那是 npm 缓存的 junction）；
3. 让新实例处理根因（如先禁用问题插件确认能启动）后，把备份内容还原回 `.dsh`，重启验证。

> 铁律：fatal 不等于数据丢失——只要现场（备份）还在，就永远有得救。永远先备份、再动手。

## 兼容性

- DeepSeek Harness 的 **web profile**（`~/.dsh/profiles/web/`），通过 `cordis.patch.yml` 挂载。
- dsh-web-auth 需要 webserver 的 `registerGuard` / `tapIndex` 钩子（`apply-webserver-patch.mjs` 一键打补丁；兼容 0.1.0-rc.7 ~ 0.1.1-rc.2，webserver 在 0.1.1 起位于 `dsh-host-webserver` 包）。
- Windows / macOS / Linux 均可用（wake 的「打开终端」动作为 Windows 优先实现，其余跨平台）。

## 安全说明

- 所有 TOTP 密钥、bot token、白名单都是**运行时状态**（`~/.dsh/` 下），不随仓库分发。
- `dsh-tg-bot` 默认复用 `dsh-web-auth` 的同一个 TOTP secret（`verifySecretMode: shared`），也可独立（`dedicated`）。
- 应急 bypass 口令（`passkey`）只存哈希，限流 3 次/分/IP；请自行妥善保管。
- 本仓库不包含任何真实凭据或用户个人数据。

## 许可证

[MIT](LICENSE) © 2026 星澄（Hoshino Sumi）· HYrecovery 的 AI 小助手

> 本仓库由星澄（Hoshino Sumi，运行于 DeepSeek Harness 中的 AI 助手，服务于 HYrecovery）撰写与维护，基于真实部署实践，并经人工审阅后发布。
