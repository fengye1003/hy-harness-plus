// 守卫凭证表重读补丁的**离线**验收测试。
//
// 复现的是线上真实症状：热重载留下多个 web-auth 实例 → 每个实例各有一个守卫，
// 守卫链要求"全部放行" → 新签发的 cookie 被**旧实例**拒掉（401），直到重启 harness。
//
// 用法：node test-guard-reload.mjs [插件 index.js 路径]
// 默认测线上那份（~/.dsh/profiles/web/auth-plugin/index.js）；状态文件用临时目录，不碰真实凭证。
//
// 断言：
//   1) 两个实例都能注册守卫（模拟僵尸）
//   2) 实例 B 签发的新 cookie，**实例 A 的守卫必须放行**（修复前会 401 —— 这就是线上那个 bug）
//   3) 伪造/空 cookie 仍被拒（fail closed 没被放宽）
//   4) 在 B 里撤销的 token，A 下次也必须拒（撤销能传播）
//   5) /auth/login 这类公开端点不受影响

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY =
  process.argv[2] || join(homedir(), ".dsh", "profiles", "web", "auth-plugin", "index.js");
const PASSKEY = "guard-reload-test-passkey";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function mockRes() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    setHeader(k, v) {
      out.headers[k.toLowerCase()] = v;
    },
    writeHead(status, headers) {
      out.status = status;
      if (headers) for (const k of Object.keys(headers)) out.headers[k.toLowerCase()] = headers[k];
    },
    end(body) {
      out.body = body;
      if (!out.status) out.status = 200;
    },
  };
}

function mockReq(url, cookie) {
  return {
    url,
    method: "GET",
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}

/** 装一个 web-auth 实例（各自独立的 mock ctx），返回它的 guard 与路由表 */
function mount(plugin, stateFile, backupDir, label) {
  const calls = { guards: [], routes: {}, taps: [] };
  const ctx = {
    webServer: {
      registerGuard(g) {
        calls.guards.push(g);
        return () => {};
      },
      register(route) {
        calls.routes[route.path] = route;
        return () => {};
      },
      tapIndex(fn) {
        calls.taps.push(fn);
        return () => {};
      },
    },
    logger: { info: () => {}, warn: (...a) => console.log(`  [warn:${label}]`, ...a) },
    effect(fn) {
      return fn();
    },
    on() {},
  };
  plugin.apply(ctx, { passkey: PASSKEY, tokenTtlDays: 30, stateFile, backupDir });
  return calls;
}

const tmp = mkdtempSync(join(tmpdir(), "dsh-guard-reload-"));
const stateFile = join(tmp, "state.json");
const backupDir = join(tmp, "backup");

console.log(`== web-auth 守卫重读补丁 · 离线验收 ==`);
console.log(`插件：${ENTRY}\n`);

const plugin = await import(pathToFileURL(ENTRY).href);

// 1) 先装 A（模拟"热重载前就存在、快照已过期"的旧守卫）
const A = mount(plugin, stateFile, backupDir, "A");
check("实例 A 注册了守卫", A.guards.length === 1);
check("实例 A 注册了应急通道", !!A.routes["/auth/templogin/sumisecret/gettokenbypasskey"]);

// 2) 再装 B（模拟热重载后新创建的实例）
const B = mount(plugin, stateFile, backupDir, "B");
check("实例 B 注册了守卫（模拟僵尸并存）", B.guards.length === 1);

// 3) B 通过应急通道签发一个新 cookie
const resLogin = mockRes();
await B.routes["/auth/templogin/sumisecret/gettokenbypasskey"].handler(
  mockReq(`/auth/templogin/sumisecret/gettokenbypasskey?passkey=${encodeURIComponent(PASSKEY)}`),
  resLogin
);
const setCookie = resLogin.out.headers["set-cookie"] || "";
const cookie = setCookie.split(";")[0];
check("B 签发出 cookie", /^dsh_auth=[0-9a-f]{64}$/.test(cookie), cookie ? cookie.slice(0, 20) + "…" : "(空)");

// 4) ★ 核心断言：**过期守卫 A 必须放行 B 签发的新 cookie**
const resA = mockRes();
const allowA = await A.guards[0].check(mockReq("/", cookie), resA, "/");
check(
  "★ 过期实例 A 放行 B 签发的新 cookie（修复点）",
  allowA === true && resA.out.status !== 401,
  `allow=${allowA} status=${resA.out.status}`
);
const resA2 = mockRes();
const allowA2 = await A.guards[0].checkUpgrade(mockReq("/api/remote.mux", cookie), { end() {}, destroy() {} }, null, "/api/remote.mux");
check("★ upgrade 守卫同样放行", allowA2 === true, `allow=${allowA2}`);

// 5) fail closed 没被放宽
const resBad = mockRes();
const allowBad = await A.guards[0].check(mockReq("/", "dsh_auth=" + "0".repeat(64)), resBad, "/");
check("伪造 cookie 仍被拒（401）", allowBad === false && resBad.out.status === 401, `allow=${allowBad} status=${resBad.out.status}`);
const resNone = mockRes();
const allowNone = await A.guards[0].check(mockReq("/"), resNone, "/");
check("无 cookie 仍被拒（401）", allowNone === false && resNone.out.status === 401, `status=${resNone.out.status}`);

// 6) 公开端点不受影响
const resPub = mockRes();
const allowPub = await A.guards[0].check(mockReq("/auth/login"), resPub, "/auth/login");
check("公开端点 /auth/login 直接放行", allowPub === true);

// 7) 撤销要能传播回旧实例
const resList = mockRes();
await B.routes["/auth/tokens"].handler(mockReq("/auth/tokens", cookie), resList);
const html = String(resList.out.body || "");
const idMatch = html.match(/name="id"\s+value="([0-9a-f]+)"/) || html.match(/value="([0-9a-f]{16})"/);
check("能在 /auth/tokens 页找到刚签发的 token id", !!idMatch, idMatch ? idMatch[1] : "(未找到)");
if (idMatch) {
  const resRevoke = mockRes();
  const form = `id=${idMatch[1]}`;
  const listeners = {};
  const postReq = {
    url: "/auth/tokens/revoke",
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    socket: { remoteAddress: "127.0.0.1" },
    // readBody 用的是 req.on("data"|"end"|"error") 事件式读取
    on(evt, cb) {
      listeners[evt] = cb;
      return this;
    },
    destroy() {},
  };
  const done = B.routes["/auth/tokens/revoke"].handler(postReq, resRevoke);
  setImmediate(() => {
    listeners.data?.(Buffer.from(form));
    listeners.end?.();
  });
  await done;

  const resAfter = mockRes();
  const allowAfter = await A.guards[0].check(mockReq("/", cookie), resAfter, "/");
  check("★ B 撤销后，A 也必须拒（撤销可传播）", allowAfter === false && resAfter.out.status === 401, `allow=${allowAfter} status=${resAfter.out.status}`);
}

try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
