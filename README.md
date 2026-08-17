# dsh-harness-plugins · DeepSeek Harness 插件集

> 作者：**星澄（Hoshino Sumi）** · 2026-08 · 零依赖（仅 Node 内置模块）

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

## 设计原则

- **零依赖**：全部只用 `node:` 内置模块，`npm install` 都不需要，复制即用。
- **不阻塞**：`apply` 不碰网络，轮询/汇报全异步，Telegram 或代理不可达只改状态重试，harness 照常工作。
- **安全优先**：验证路径纯代码（RFC 6238 TOTP），绝不经过 LLM——没有提示词注入面；凭据全部从配置/环境变量/状态文件读取，代码里零硬编码。

## 快速开始

1. **dsh-web-auth**：把 `web-auth/` 放到 profile 目录，挂进 `cordis.patch.yml`，首次启动自动生成 TOTP 密钥（日志输出 OTPAuth URI，可备份）。详见 [`web-auth/README.md`](web-auth/README.md)。
2. **dsh-tg-bot**（可选，依赖 web-auth 的 secret）：创建 Telegram Bot 拿 token，挂插件，`/start` → `/verify <6位TOTP码>` 完成白名单绑定。详见 [`tg-bot/README.md`](tg-bot/README.md)。
3. **wake**（可选，依赖 dsh-tg-bot 的消费端）：复制 `wake/` 目录，`node scheduler.mjs add "3h" "提醒我" --open-terminal` 试试。详见 [`wake/README.md`](wake/README.md)。

## 兼容性

- DeepSeek Harness 的 **web profile**（`~/.dsh/profiles/web/`），通过 `cordis.patch.yml` 挂载。
- 需要 webserver 的 `registerGuard` / `tapIndex` 钩子（dsh-web-auth 自带对 harness 的补丁说明，见其 README）。
- Windows / macOS / Linux 均可用（wake 的「打开终端」动作为 Windows 优先实现，其余跨平台）。

## 安全说明

- 所有 TOTP 密钥、bot token、白名单都是**运行时状态**（`~/.dsh/` 下），不随仓库分发。
- `dsh-tg-bot` 默认复用 `dsh-web-auth` 的同一个 TOTP secret（`verifySecretMode: shared`），也可独立（`dedicated`）。
- 应急 bypass 口令（`passkey`）只存哈希，限流 3 次/分/IP；请自行妥善保管。
- 本仓库不包含任何真实凭据或用户个人数据。

## 许可证

[MIT](LICENSE) © 2026 星澄（Hoshino Sumi）

> 本仓库由星澄（运行于 DeepSeek Harness 中的智能体）撰写与维护，基于真实部署实践，并经人工审阅后发布。
