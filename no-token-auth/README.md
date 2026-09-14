# dsh-no-token-auth — 关掉 Harness 内置「启动 token 登录」的配套补丁

> 作者：星澄（Hoshino Sumi）· 零依赖（仅 Node 内置模块）· 2026-09
> 仓库：https://github.com/fengye1003/hy-harness-plus （`no-token-auth/`）
> ⚠️ **必须与 [`web-auth/apply-webserver-patch.mjs`](../web-auth/apply-webserver-patch.mjs) 的 v2（guard-passed 标记版）配套使用**。单独使用、或与 v1 守卫补丁搭配，会让面板「服务在跑、前端全废」。

## 这是什么

DeepSeek Harness 核心自带一套登录：启动时打印的 URL 带 `?token=…`，浏览器访问后核心换发一个 cookie，`/api/*` 与 WebSocket 都用这个 cookie 校验。

装了 [`dsh-web-auth`](../web-auth/)（TOTP 2FA 守卫）之后，这套内置登录就多余了，而且带来两个问题：

1. **与「2FA 是唯一前台」冲突**：拿到那条带 token 的 URL 就能进，等于多了一把不经过 2FA 的钥匙；
2. **TOTP 登录后会撞核心第二次校验**：守卫放行了，但核心 cookie 从未签发，于是 `/api/*` 401。

本补丁把内置 token 通道关掉，让 2FA 守卫成为**唯一**门禁：

| 改动 | 目标文件 | 作用 |
|---|---|---|
| a) `authenticatedUrl` 不再往 URL 追加 `?token=` | `dsh-client-connection/lib/index.js` | 启动打印的链接里不再带 token |
| b) `authorizeIndex` 不再接受 query token（只留 cookie 兜底） | 同上 | 关掉「URL 换 cookie」这条路 |
| c) `requestRejection` 只认「守卫放行标记」 | 同上 | 让 `/api` RPC 通道与 WebSocket upgrade 听 2FA 守卫的 |
| d) 首页渲染只认「守卫放行标记」 | `dsh-host-frontend-static/lib/index.js` | 修掉「TOTP 登录后仍被核心二次 401」的断层 |

## ⚠️ 血泪教训：不能用「有没有守卫」来判断放行

本补丁最初写的是「只要存在守卫，就整段让位」：

```js
// ❌ 错误写法：会导致 /api/* 全部 400（空响应）、WebSocket 一连就断
const guards = this.ctx?.webServer?.guards;
if (Array.isArray(guards) && guards.length > 0) return void 0;
```

在 cordis（DSH 的插件框架）里，**访问一个自己从未 `inject` 过的服务属性会直接抛错**，而不是返回 `undefined`：

```
cannot get property "webServer" without inject
```

`?.` 救不了——**抛错的是 getter 本身**。而 `dsh-client-connection` 只声明了 `inject = ["credentials"]`，从来没有注入 `webServer`。于是 `requestRejection()` **每次调用都在第一行抛异常**：

| 现象 | 机制 |
|---|---|
| `/api/*` 全部 **400，响应体为空** | 异常冒泡到 webserver 兜底 catch → `res.writeHead(400); res.end()` |
| `/api/remote.mux` WebSocket **建连即断**（控制台刷 `connection lost, retry #1…#11`） | upgrade 路由里也调同一方法 → 同步抛出 → `socket.destroy()` |
| `/open-in-app/apps` 也 400 | 另一个包（`dsh-host-open-in-app`）同样调它 |

**最坑的是它看起来「像好了」**：`curl http://<host>:<port>/` 返回 401/302、`/auth/login` 返回 200，curl 层面全绿——**只有真实浏览器里才看得到满屏 400**。所以：**别用 curl 验收这套东西。**

> 顺带纠正一个曾经流传的说法：「守卫补丁和 webauth 缺一不可」。守卫补丁本身是好的（HTTP 与 upgrade 两条通道都覆盖到了），真正坏的是上面那行服务访问。

## ✅ 正确写法：让守卫给请求打标记（v2）

守卫补丁（v2）在放行之后打一个**跨包共享的全局 symbol**：

```js
// dsh-host-webserver 补丁 v2：守卫循环放行之后
if (this.guards.length > 0) {
  for (const guard of this.guards) {
    if (await guard.check(req, res, rawPath) === false) return;
  }
  req[Symbol.for("dsh.guardPassed")] = true;
}
```

本补丁只读这个标记，**完全不碰 cordis 服务表**：

```js
// dsh-client-connection / dsh-host-frontend-static
if (request[Symbol.for("dsh.guardPassed")] === true) return void 0;
if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
```

三个设计点：

1. **用 `Symbol.for(...)` 而不是 `Symbol(...)`**：前者走全局注册表，两个不同的包**不需要互相 import** 就能拿到同一个 key；
2. **只在 `guards.length > 0` 时才打标记**：没装守卫时标记不存在 → 自动回退到核心 Host/Origin 围栏 + cookie 校验，**fail closed**（绝不会因为「注册过守卫」就无条件放行）；
3. **标记打在 Node 的 request 对象上**：HTTP 与 upgrade 两条路都能带上，`requestRejection()` 的所有调用点（`/api` 前缀路由、通用 RPC 通道、api-gateway 的 upgrade、open-in-app）都能读到。

## 用法

```bash
node no-token-auth/apply-no-token-auth.mjs --verify   # 只看状态（只读，不改文件）
node no-token-auth/apply-no-token-auth.mjs --apply    # 打补丁（幂等；首次自动留 .orig-no-token-auth 备份）
node no-token-auth/apply-no-token-auth.mjs --revert   # 回滚
# 指向特定副本（例如做隔离验证时）：
node no-token-auth/apply-no-token-auth.mjs --apply --root "<某个 node_modules 下的 @deepseek-ai 目录>"
```

- 目标位置**自动发现**：npx 缓存（Windows `%LOCALAPPDATA%\npm-cache\_npx`，macOS/Linux `~/.npm/_npx`）+ `~/.dsh/profiles/node_modules`；可用环境变量 `DSH_NPX_ROOT` 覆盖。脚本里**不写死任何用户名或绝对路径**。
- 每个目标文件都会先做 `node --check` 语法校验。
- ⚠️ **补丁是「启动时读」→ 必须重启 harness 才生效。**

## 正确的验收方式

1. 无 cookie 打开面板 → 应 **302 到 `/auth/login`**（不是 401 纯文本）；
2. 输入 6 位 TOTP → 应进入主界面；
3. **登录后 `/api/*` 必须 200**（不是 400、不是 401），WebSocket `/api/remote.mux` 必须**保持连接**；
4. **真发一条消息并收到回复**；判据建议直接读「会话落盘记录」里是否出现 `assistant` 消息——页面上的会话标题与你自己那条消息也含同样文字，只看页面文本会假阳性。

> 更好的做法（本项目采用）：把运行时的 `@deepseek-ai` 作用域**整份拷贝**到一个隔离目录（只 junction 不拷贝没用——Node 会按 realpath 解析回真实树），`DSH_HOME` 指向临时目录、TOTP state 显式指向副本，然后用真实浏览器（Chrome DevTools Protocol）完成一次真实 TOTP 登录 + 发消息，全绿后再把**同一份字节**部署到真树并逐文件比对 sha256。

## 配套关系（重要）

```
web-auth/apply-webserver-patch.mjs (v2，含 guard-passed 标记) ─┐
                                                              ├─► 必须一起用
no-token-auth/apply-no-token-auth.mjs (只读该标记)             ─┘
```

- **只装 `web-auth`、不装 `no-token-auth`**：2FA 能登录，但 `/api/*` 会撞核心 cookie 校验 → 401（得靠 URL 里的 `?token=` 才能换到核心 cookie）。
- **只装 `no-token-auth`、守卫补丁是旧版或没装**：本补丁读不到标记 → 回退核心校验（不会裸奔，但 2FA 不生效）。
- 另外：浏览器抓取 `/manifest.webmanifest` 时**不携带 cookie**，会被守卫永远拦成 401（噪音 + PWA 清单失效）。`web-auth` 插件已内置公开路径白名单（`/manifest.webmanifest`、`/favicon.ico`、`/favicon.svg`）。

## 许可

与仓库其他部分一致（见仓库根 `LICENSE`）。
