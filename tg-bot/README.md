# dsh-tg-bot — DeepSeek Harness Telegram 桥接插件

> 作者：星澄（Hoshino Sumi）· 零依赖（仅 Node 内置模块）· 2026-08

挂在 DeepSeek Harness **web profile** 的零依赖 Cordis 插件，把 Telegram 变成你的第二对话入口：

- **双向对话**：白名单用户在 Telegram 发消息 → 注入 harness 会话（运行中 `steer` 软中断、空闲 `followup` 排队；`interruptMode: "cancel"` 可改硬中断）；每轮结束自动把 agent 回复回传 Telegram（`echoReplies`）。
- **主动汇报**：`session/event` + `agent/status` + `agent/error` 事件驱动（turn 结束/出错/状态切换），外加 `tg_send` 工具让 agent 随时主动推送消息。
- **鉴权**：程序化 TOTP（RFC 6238，默认**复用 dsh-web-auth 的同一个 secret**，共享模式零额外配置）+ uid/username 白名单持久化 + **失败 5 次锁 2 小时**。验证全程纯代码，不经过 LLM（无提示词注入面）。
- **面板**：`/tg-bot`（受 web-auth 守卫保护，需 TOTP 登录）——开关、状态、绑定会话、白名单管理、锁定解除。
- **不阻塞承诺**：轮询循环独立异步 + 指数退避 + 硬超时；`apply` 不碰网络；Telegram/代理不可达只改状态重试，harness 照常工作。

## 安装

前置：**dsh-web-auth** 已安装（shared 模式读取它的 TOTP secret；也可用 `dedicated` 模式独立密钥）。

1. 创建 Telegram Bot（找 [@BotFather](https://t.me/BotFather)），拿到 token。
2. 把本目录复制到 profile 目录，例如 `~/.dsh/profiles/web/tg-bot/`。
3. 把 token 写入 `~/.dsh/tg-bot/token.txt`（或配置 `token` / 环境变量 `DSH_TG_BOT_TOKEN`）。
4. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加挂载片段（见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)），热重载或重启。
5. Telegram 私聊你的 bot：`/start` → 用身份验证器 App（web 面板同一个）发 `/verify <6位码>` → 白名单落盘，之后免验证。

## 使用

- **发消息 = 对话**：直接打字即注入 agent 会话（**静默接收**，不回复确认；处理完自动回传回复）。
- **常用指令**（白名单用户）：

| 指令 | 作用 |
|---|---|
| `/status` | 🟢正在执行 / ⚪空闲 / 绑定会话 / 白名单数 |
| `/newsession [路径]` | 创建并绑定新会话（默认沿用当前工作目录） |
| `/sessions` | 列出可绑定会话 |
| `/bind <会话ID>` / `/unbind` | 绑定 / 解除绑定（自动选最近活跃） |
| `/on` / `/off` | 启用 / 停用桥接（等同面板开关） |
| `/cancel` | 立即中断当前操作（硬中断） |
| `/verify <码>` / `/help` | 验证 / 帮助 |

- **面板**：浏览器登录 web 面板后访问 `/tg-bot`。

## 关键配置（patch config）

| 键 | 默认 | 说明 |
|---|---|---|
| `proxy` | `http://127.0.0.1:7897` | Telegram API 代理（无公网 IP 的机器必须走本地代理）；`''` = 直连 |
| `verifySecretMode` | `shared` | `shared` = 复用 web-auth secret；`dedicated` = 独立 secret |
| `maxFailures` / `lockoutMs` | `5` / `7200000` | 验证失败锁定（5 次锁 2 小时） |
| `interruptMode` | `steer` | `steer` = 软中断（当前动作结束后先读你的指示）；`cancel` = 硬中断 |
| `echoReplies` / `echoMaxChars` | `true` / `1500` | 每轮结束回传 agent 回复 |
| `panelPath` | `/tg-bot` | 面板路由 |
| `sessionId` | 自动 | 显式绑定会话；`/bind` 可改 |
| `wakeFile` | 无 | 通用唤醒通道文件（配合 [`wake/`](../wake/) 使用） |

## 网络实现（零依赖代理隧道）

Telegram Bot API 走 HTTPS，本机无公网 IP 时必须经本地混合代理出网。插件用 `node:http` 发 **CONNECT 隧道**，再用 `node:tls` 的 `tls.connect({ socket, servername })` 手动包一层 TLS（SNI 指向 `api.telegram.org`），全程零第三方依赖。

## 踩坑记录（写插件时踩过的）

1. **代理隧道必须手动 TLS 包装**：`https.request` 的 `createConnection` 返回裸 socket 不会自动加 TLS → 明文打到 HTTPS 端口（nginx 400）。解法：`tls.connect({ socket, servername })` 包一层再交给 `createConnection`。
2. **getUpdates 409 处理不能调 deleteWebhook**：409 分支里 deleteWebhook + 无退避紧循环会**自激冲突**。正确做法：固定等 10s 重试。
3. **请求要有硬性总超时**：自定义 createConnection 场景下 socket 空闲超时可能不触发 → 悬挂长轮询占住 Telegram 槽位。加 deadline timer 兜底。
4. **热重载多次 bump 会留旧实例**：`?v=N` 迭代期间旧轮询器可能残留（409 互抢）→ 重启 harness 清场。本插件带文件级轮询锁（`poll.lock`，90s 心跳）+ 新实例 yield 信号，多实例可自愈交接。
5. **注入必须传 UserMessage 对象**：`agent.steer()/followup()` 直接传字符串会触发 harness 内部 `Cannot read properties of undefined (reading 'kind')`。用 `makeUserMessage()` 构造对象（`role: "user"` + `content: [{type:"text",text}]`）再注入。

## 测试

仓库内为现场验收脚本（需要真实部署环境：TOTP 密钥、bot token、运行中的 harness），不随发布；插件核心逻辑（TOTP 算法）与 dsh-web-auth 共用同一实现，其 RFC 6238 官方向量测试见 [`../web-auth/test/`](../web-auth/test/)。
