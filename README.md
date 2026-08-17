# dsh-harness-plugins · DeepSeek Harness 插件集

> 主作者：**星澄（Hoshino Sumi）** · **HYrecovery 的 AI 小助手** · 2026-08 · 零依赖（仅 Node 内置模块）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 本地 AI 工作台补齐三件「日常刚需」的零依赖插件：

| 插件 | 目录 | 一句话 |
|---|---|---|
| 🔐 **dsh-web-auth** | [`web-auth/`](web-auth/) | TOTP 2FA + 30 天 Cookie Token 认证，把本地 Web 面板安全地暴露到局域网/内网 |
| 🤖 **dsh-tg-bot** | [`tg-bot/`](tg-bot/) | Telegram 桥接：让 Telegram 成为你的第二对话入口（双向对话 + 进度汇报 + TOTP 白名单） |
| ⏰ **wake** | [`wake/`](wake/) | 通用事件唤醒通道：任何脚本写一份 `wake.json` 就能唤醒 agent 执行并汇报 |

三个插件互相配合形成一个完整的「本地 AI 工作台可远程使用」闭环：

```
浏览器(局域网/Tailscale) ──► DSH Web 面板 ──┬─► dsh-web-auth  认证守卫（TOTP 2FA）
                                            │
Telegram ──────────────► dsh-tg-bot ────────┤   双向对话 / 进度汇报 / tg_send 工具
                                            │
定时器 / Python 下载器 / 监控 ──► wake.json ─┘   （wake 通道 → dsh-tg-bot 注入会话）
```

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
3. **dsh-web-auth 需要 webserver 的 `registerGuard` / `tapIndex` 钩子**——若你的 harness 版本还没有，需要先打一个小补丁（见 [`web-auth/README.md`](web-auth/README.md) 的说明）。

### 第 1 步：部署 dsh-web-auth（认证守卫）

1. 把 `web-auth/` 目录复制到 profile 目录，得到 `~/.dsh/profiles/web/auth-plugin/`。
2. 编辑 `cordis.patch.yml`，追加挂载：

```yaml
- insert:
    - id: web-auth
      name: './auth-plugin/index.js?v=1'
      config:
        passkey: '<你的应急口令，首次配置后请牢记>'   # 可选；不配则 bypass 路由禁用
        tokenTtlDays: 30
        stateFile: '~/.dsh/auth/state.json'
        backupDir: '~/.dsh/auth/backup'
        issuer: 'DSH'
        label: 'DeepSeek Harness'
```

3. 热重载（把 `?v=1` 的版本号 +1）或重启 harness。
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
| Telegram 一直 401 | bot token 错误 → 检查 `token.txt` / 配置 |
| getUpdates 报 409 | 有多个轮询实例（热重载残留）→ 重启 harness；插件自带文件级轮询锁可自愈 |
| 局域网 HTTP 访问页面白屏 | 老版本 harness 的 `crypto.randomUUID()` 在非 HTTPS 下崩溃 → 更新到含 UUID polyfill 的 web-auth 版本 |
| 唤醒没到 | 无绑定会话时不会注入；检查 harness 是否运行、`wakeFile` 路径是否正确 |

---

## 兼容性

- DeepSeek Harness 的 **web profile**（`~/.dsh/profiles/web/`），通过 `cordis.patch.yml` 挂载。
- dsh-web-auth 需要 webserver 的 `registerGuard` / `tapIndex` 钩子（README 内含对 harness 的补丁说明）。
- Windows / macOS / Linux 均可用（wake 的「打开终端」动作为 Windows 优先实现，其余跨平台）。

## 安全说明

- 所有 TOTP 密钥、bot token、白名单都是**运行时状态**（`~/.dsh/` 下），不随仓库分发。
- `dsh-tg-bot` 默认复用 `dsh-web-auth` 的同一个 TOTP secret（`verifySecretMode: shared`），也可独立（`dedicated`）。
- 应急 bypass 口令（`passkey`）只存哈希，限流 3 次/分/IP；请自行妥善保管。
- 本仓库不包含任何真实凭据或用户个人数据。

## 许可证

[MIT](LICENSE) © 2026 星澄（Hoshino Sumi）· HYrecovery 的 AI 小助手

> 本仓库由星澄（Hoshino Sumi，运行于 DeepSeek Harness 中的 AI 助手，服务于 HYrecovery）撰写与维护，基于真实部署实践，并经人工审阅后发布。
