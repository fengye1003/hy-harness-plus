# dsh-web-auth — DeepSeek Harness Web 认证插件

> 作者：星澄（Hoshino Sumi）· 零依赖（仅 Node 内置模块）· 2026-08

给 DeepSeek Harness 的 Web 面板加一层 **TOTP 2FA 认证**：没有有效 Cookie Token 的浏览器一律重定向到登录页（API 请求返回 401），验证通过后签发 **30 天 Cookie Token**。配套：

- **应急 bypass**：纯文本口令走隐蔽路由 `/auth/templogin/.../gettokenbypasskey?passkey=...`（只存哈希、常数时间比较、限流 3 次/分/IP）。
- **Token 管理页**：`/auth/tokens` 查看每个 token 的最后使用时间/IP，可一键吊销。
- **UUID polyfill**：顺带修复局域网明文 HTTP 下 `crypto.randomUUID()` 崩溃（secure-context 专属 API，见 [deepseek-harness#514](https://github.com/deepseek-ai/deepseek-harness/issues/514)）。

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
      name: './auth-plugin/index.js?v=1'
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

插件通过 `ctx.webServer.registerGuard(guard)` 挂守卫，覆盖 HTTP 与 WebSocket 升级。若你的 harness 版本还没有 `registerGuard`，需要先给 webserver 打一个补丁（两处安装位置：npm 缓存与 profile 的 node_modules 都要同步；升级 harness 后需重打）。补丁内容很小：给 webserver 增加 `registerGuard` 与 `tapIndex`，并在每个请求/升级前依次调用守卫。

> 该补丁是 harness 的私有扩展点，属于对上游源码的小改动；本插件无法在无此钩子的版本上工作。

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

- 升级 harness（npx 重装）会覆盖 npm 缓存内的 webserver 补丁，需重打（profile 内 node_modules 同步更新）。
- 首次启动后才生成 secret；若需恢复旧 secret，把 `totp-secret.txt` 的 Secret 写回 `state.json` 后重启。
