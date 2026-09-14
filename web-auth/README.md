# dsh-web-auth — DeepSeek Harness Web 认证插件

> 作者：星澄（Hoshino Sumi）· 零依赖（仅 Node 内置模块）· 2026-08
> 仓库：https://github.com/fengye1003/hy-harness-plus （`web-auth/`）

给 DeepSeek Harness 的 Web 面板加一层 **TOTP 2FA 认证**：没有有效 Cookie Token 的浏览器一律重定向到登录页（API 请求返回 401），验证通过后签发 **30 天 Cookie Token**。配套：

- **应急 bypass**：纯文本口令走隐蔽路由 `/auth/templogin/.../gettokenbypasskey?passkey=...`（只存哈希、常数时间比较、限流 3 次/分/IP）。
- **Token 管理页**：`/auth/tokens` 查看每个 token 的最后使用时间/IP，可一键吊销。
- **UUID polyfill**：顺带修复局域网明文 HTTP 下 `crypto.randomUUID()` 崩溃（secure-context 专属 API，见 [deepseek-harness#514](https://github.com/deepseek-ai/deepseek-harness/issues/514)）。
- **防御性加载（v3）**：`registerGuard` / `tapIndex` / `register` 全部先探测再调用，缺失只降级告警、**绝不 fatal**——harness 升级冲掉 webserver 补丁时认证暂时降级、但整个 harness 照常启动。

## ⚠️ 重要（2026-09-14 更正）：打算「关掉核心内置 token 登录」的读者先读这里

本插件只负责**守门**；Harness 核心自带的那套 `?token=` 登录仍在它后面。如果你要让 2FA 成为**唯一**门禁，必须：

1. 使用配套补丁 [`../no-token-auth/`](../no-token-auth/)（**marker 版**）；
2. 确保本目录的 `apply-webserver-patch.mjs` 是 **v2（含 `guard-passed` 标记）**——用 `--check` 看输出里 `guard-passed marker: PRESENT/MISSING`。

致命的旧组合（v1 守卫补丁 + 关掉 token 校验）的症状是：**服务在跑、页面能开，但 `/api/*` 全部 400 空响应、WebSocket 一连就断**。那不是守卫的问题，而是补丁里去读「未注入的服务属性」触发了 cordis 硬报错（`cannot get property "webServer" without inject`，`?.` 也救不了）。完整根因与正确写法见 [`../no-token-auth/README.md`](../no-token-auth/README.md)。

还有一条方法论：**curl 探针（`/`→401/302、`/auth/login`→200）不能证明前端可用**——这个坑正是被 curl 探针判成「已修复」的。验收请走真实浏览器登录 + 真发一条消息 + 读会话落盘记录。

**版本与「降级」的真实含义（2026-09-14 补记）**：

- 最后一次**完整**验证在 **DSH 0.1.5-rc.1 / `dsh-*` 0.1.5-rc.2**（真实浏览器 + 真实 TOTP → 登录后 `/api/*` 零 400/401 + WebSocket 稳定 + 真发真收）；本文旧处的「兼容 0.1.0-rc.7 ~ 0.1.1-rc.2」仅作历史参考。
- ⚠️ **降级 ≠ 安全**：`registerGuard` 缺失时插件是「路由注册、**没有请求守卫**」——此时**面板与 `/api/*` 无需 TOTP 即可访问**（只剩核心围栏 + cookie）。暴露到网络前请先 `--check` 看到 `guard-passed marker: PRESENT`。
- `test/test-integration.mjs` 用 mock ctx，**结构上无法**发现 cordis inject 违规、`/api/*` 400 或 WebSocket 被 `socket.destroy()` 这类问题，**不能当作端到端验证**。

## 认证流程

```
浏览器(无 cookie) ──► guard 检查 ──► 302 → /auth/login（HTML）或 401（JSON）
                                     │ POST /auth/verify (6位TOTP码)
                                     ▼
                             签发 30 天 dsh_auth cookie（只存 SHA-256 哈希）
```

## 安装

1. 把本目录复制到 profile 目录，例如 `~/.dsh/profiles/web/auth-plugin/`。
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

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

3. 热重载（bump `?v=N`）或重启 harness。
4. 首次启动自动生成 TOTP 密钥：日志会打印 `otpauth://totp/...` URI，同时备份到 `backupDir`（`totp-secret.txt`）。用身份验证器 App 扫码或手动添加。
5. 浏览器访问面板 → 输入 6 位动态码 → 完成。

## webserver 守卫钩子（registerGuard）说明

插件通过 `ctx.webServer.registerGuard(guard)` 挂守卫，覆盖 HTTP 与 WebSocket 升级。若你的 harness 版本还没有 `registerGuard`，需要先给 webserver 打一个小补丁（两处安装位置：npm 缓存与 profile 的 node_modules 都要同步；**升级 harness 后需重打**）。

**一键补丁脚本（推荐）**：

```bash
node web-auth/apply-webserver-patch.mjs --check   # 检测两处补丁状态
node web-auth/apply-webserver-patch.mjs --apply   # 缺失则自动重打（幂等）
node web-auth/apply-webserver-patch.mjs --verify  # 语法检查 + 两处 hash 一致性
```

- 兼容 0.1.0-rc.7 ~ 0.1.1-rc.2（webserver 在 0.1.1 起位于 `@deepseek-ai/dsh-host-webserver` 包；脚本自动定位）。
- Windows 默认找 `%LOCALAPPDATA%\npm-cache\_npx`，macOS/Linux 找 `~/.npm/_npx`；布局不同用环境变量 `DSH_NPX_ROOT` 覆盖。

> 该补丁是 harness 的私有扩展点，属于对上游源码的小改动；本插件在无此钩子的版本上会降级运行（路由注册但无请求守卫）并打警告日志。

## 测试

```bash
node test/test-rfc6238.mjs     # TOTP 算法对照 RFC 6238 官方向量（6/6）
node test/test-integration.mjs # 集成冒烟：mock ctx 跑 apply()，覆盖守卫/登录/bypass/吊销/升级拒绝
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `passkey` | 无 | 应急 bypass 口令（只存 SHA-256） |
| `tokenTtlDays` | `30` | Cookie Token 有效期（天） |
| `stateFile` | `~/.dsh/auth/state.json` | 状态（secret + tokens） |
| `backupDir` | `~/.dsh/auth/backup` | 首次启动备份 OTPAuth URI |
| `issuer` / `label` | `DSH` / `DeepSeek Harness` | 验证器 App 显示名 |

## 安全要点

- Token 只存哈希；吊销立即生效；过期 token 自动清理。
- TOTP 验证带 ±1 窗口 + 登录限流（5 次/分/IP）。
- 应急 bypass 限流 3 次/分/IP + 常数时间比较。
- 认证状态不经过任何 LLM——无提示词注入面。

## 已知限制

- 升级 harness（npx 重装）会覆盖 npm 缓存内的 webserver 补丁，需重打（`apply-webserver-patch.mjs --apply`；profile 内 node_modules 同步更新）。
- 首次启动后才生成 secret；若需恢复旧 secret，把 `totp-secret.txt` 的 Secret 写回 `state.json` 后重启。

## 升级维护（v0.1.x 实测流程）

1. 升级后先跑 `node web-auth/apply-webserver-patch.mjs --check`——`MISSING` 表示补丁被冲掉；
2. `--apply` 重打两处 → `--verify` 确认 node --check 通过 + 两处 hash 一致；
3. 重启 harness → 验证 `GET /` 无 cookie 返回 401（守卫在线）、`/auth/login` 200。

### 最坏情况兜底（fatal 也救得回）

防御性加载之后理论上不会再 fatal，但**万一**真的撞上 harness 无法启动：**绝不删任何东西**——

1. 先重命名备份整个配置目录（不是删除）：`Rename-Item "$env:USERPROFILE\.dsh" "$env:USERPROFILE\.dsh.bak-<日期>"`；
2. 用新 harness 实例（此时无 `.dsh`，以全新默认配置启动，保证能 boot）去修复 `.dsh`：让新实例分析备份、还原数据（可 `robocopy` 恢复并跳过 `node_modules`，那是 npm 缓存的 junction）；
3. 让新实例处理根因（如先禁用问题插件确认能启动）后，把备份内容还原回 `.dsh`，重启验证。

> 2026-08-18 曾因升级冲掉补丁、插件硬调用 API 导致插件树 fatal、harness 无法启动（用户靠上述兜底独自救回）；v3 防御性加载（本仓库当前版本）让此类升级只降级、不死机，配合补丁脚本一键恢复。2026-08-22 在 v0.1.1-rc.2 上实测全流程（隔离冒烟 15/15）。
