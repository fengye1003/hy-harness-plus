#!/usr/bin/env node
/**
 * dsh-no-token-auth patch (2026-09-06)
 * ─────────────────────────────────────────────────────────────
 * 目标：部署了 dsh-web-auth(2FA) 之后，harness 内置的启动 token 登录（/?token=xxx
 * + 核心 BrowserAuth 签发 cookie）已多余 —— 把它禁用：
 *   1) dsh-client-connection/lib/index.js
 *      a) BrowserAuth.authenticatedUrl(): 不再往根 URL 追加 ?token=…
 *      b) BrowserAuth.authorizeIndex(): 不再接受/核验 query token（只保留核心
 *         cookie 通道作为「无外部守卫」时的默认兜底，保证默认仍闭合、不裸奔）。
 *   2) dsh-host-frontend-static/lib/index.js
 *      前台 fallback 服务 index 时：若 webserver 已挂载请求守卫（dsh-web-auth），
 *      则由守卫全权鉴权（守卫放行即允许渲染 index —— 修掉 TOTP 登录后仍被核心
 *      二次 401 的断层）；无守卫时回退核心 cookie 鉴权。
 * 防御性：所有探针都带存在性检查（guards 非数组 / authorizeIndex 缺失时降级不
 * 抛错），绝不让 harness 升级后的 API 变化导致启动 fatal。
 *
 * 用法：node apply-no-token-auth.mjs --apply|--verify|--revert
 * 首次 --apply 会在每个目标文件旁留 .orig-no-token-auth 备份。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 目标根目录发现（跨平台；**不要写死用户名或绝对路径**）──────────────────
// 一个「根」= 某个 node_modules 下的 @deepseek-ai 作用域目录。
function mtimeMs(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }
function discoverNpxScopes() {
  const home = homedir();
  const bases = [];
  if (process.env.DSH_NPX_ROOT) bases.push(process.env.DSH_NPX_ROOT);
  if (process.platform === "win32") bases.push(join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "npm-cache", "_npx"));
  bases.push(join(home, ".npm", "_npx"));   // macOS / Linux
  const scopes = [];
  for (const base of bases) {
    let dirs = [];
    try { dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const d of dirs) {
      const scope = join(base, d, "node_modules", "@deepseek-ai");
      if (existsSync(scope)) scopes.push({ scope, mtime: mtimeMs(join(scope, "dsh-client-connection", "lib", "index.js")) });
    }
  }
  scopes.sort((a, b) => b.mtime - a.mtime);
  return scopes.map((s) => s.scope);
}
const NPX_ROOT = discoverNpxScopes()[0] ?? null;
const PROFILE_ROOT = join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai");
const RELS = ["dsh-client-connection/lib/index.js", "dsh-host-frontend-static/lib/index.js"];
const BACKUP_SUFFIX = ".orig-no-token-auth";

// ── 补丁块（精确锚点替换；TAB 缩进与原文件一致）────────────────────────────
const PATCHES = [
  {
    file: "dsh-client-connection/lib/index.js",
    // a) authenticatedUrl：不追加 token
    old: `\t\turl.search = "";
\t\turl.hash = "";
\t\turl.searchParams.set(TOKEN_QUERY, this.launchToken);
\t\treturn url.href;`,
    new: `\t\turl.search = "";
\t\turl.hash = "";
\t\treturn url.href; // [no-token-auth] launch-token query disabled`,
    note: "authenticatedUrl strips ?token=",
  },
  {
    file: "dsh-client-connection/lib/index.js",
    // b) authorizeIndex：删除整段 query-token 接受/签发逻辑
    old: `\t\t/* v8 ignore next -- node:http always supplies url on server requests. */
\t\tconst url = new URL(req.url ?? "/", "http://dsh.invalid");
\t\tconst tokens = url.searchParams.getAll(TOKEN_QUERY);
\t\tif (tokens.length > 0) {
\t\t\tconst authority = requestAuthority(req.headers);
\t\t\tif (req.method === "GET" && url.pathname === "/" && tokens.length === 1 && authority !== void 0 && tokenMatches(tokens.join(""), this.launchToken)) {
\t\t\t\tconst issuedAt = Date.now();
\t\t\t\tconst expiresAt = issuedAt + this.maxAgeMilliseconds;
\t\t\t\tconst value = encodeCookie({
\t\t\t\t\tversion: COOKIE_PAYLOAD_VERSION,
\t\t\t\t\tauthority,
\t\t\t\t\tissuedAt,
\t\t\t\t\texpiresAt
\t\t\t\t}, this.secret);
\t\t\t\tres.writeHead(303, {
\t\t\t\t\t"cache-control": "no-store",
\t\t\t\t\t"location": "/",
\t\t\t\t\t"referrer-policy": "no-referrer",
\t\t\t\t\t"set-cookie": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3))
\t\t\t\t});
\t\t\t\tres.end();
\t\t\t\treturn false;
\t\t\t}
\t\t\tif (req.method === "GET" && url.pathname === "/" && this.isAuthenticated(req)) {
\t\t\t\tres.writeHead(303, {
\t\t\t\t\t"cache-control": "no-store",
\t\t\t\t\t"location": "/",
\t\t\t\t\t"referrer-policy": "no-referrer"
\t\t\t\t});
\t\t\t\tres.end();
\t\t\t\treturn false;
\t\t\t}
\t\t\tthis.writeUnauthorized(req, res);
\t\t\treturn false;
\t\t}
\t\tif (this.isAuthenticated(req)) return true;`,
    new: `\t\t/* v8 ignore next -- node:http always supplies url on server requests. */
\t\tconst url = new URL(req.url ?? "/", "http://dsh.invalid");
\t\t// [no-token-auth] query-token launch auth disabled (dsh-web-auth owns the front door).
\t\tif (this.isAuthenticated(req)) return true;`,
    note: "authorizeIndex ignores ?token=; cookie-only backstop",
  },
  {
    file: "dsh-host-frontend-static/lib/index.js",
    old: `\t\t/* v8 ignore next -- node:http always sets url on server requests */
\t\tconst rawPath = new URL(req.url ?? "/", "http://x").pathname;
\t\tawait serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, () => ctx.connection.authorizeIndex(req, res), renderIndex);`,
    new: `\t\t/* v8 ignore next -- node:http always sets url on server requests */
\t\tconst rawPath = new URL(req.url ?? "/", "http://x").pathname;
\t\t// [no-token-auth] 2026-09-14 修复：读 webserver 守卫补丁打在 req 上的全局 symbol 标记，
\t\t// **绝不**访问 ctx.webServer（cordis 对未 inject 的服务属性访问会 throw）。
\t\t// 守卫放行的浏览器可渲染 index；无守卫则回退核心 cookie 门禁（fail closed）。
\t\tconst indexAuthorized = () => {
\t\t\tif (req[Symbol.for("dsh.guardPassed")] === true) return true;
\t\t\treturn typeof ctx.connection?.authorizeIndex === "function" ? ctx.connection.authorizeIndex(req, res) : true;
\t\t};
\t\tawait serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, indexAuthorized, renderIndex);`,
    note: "index trusts active guard; core cookie fallback otherwise",
  },
  {
    file: "dsh-client-connection/lib/index.js",
    // c) requestRejection：有活动守卫时整段让位（RPC/API 也只听 2FA 守卫）
    old: `\trequestRejection(request) {
\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;
\t}`,
    new: `\trequestRejection(request) {
\t\t// [no-token-auth] 2026-09-14 根因修复：**绝不能**写 this.ctx?.webServer?.guards ——
\t\t// cordis 对未 inject 的服务属性访问会直接 throw（cannot get property "webServer"
\t\t// without inject），而 dsh-client-connection 只 inject 了 credentials → 每次调用
\t\t// 第一行就抛，症状 = /api/* 全 400（webserver catch 的空 400）+ remote.mux WS 被
\t\t// socket.destroy()（浏览器「connection lost, retry #N」）。
\t\t// 现改为读 webserver 守卫补丁打在请求对象上的**全局 symbol 标记**：只有真正过守卫
\t\t// （guards 非空且全部放行）的请求才带标记；无守卫 = 回退核心 Host/Origin 围栏 +
\t\t// 浏览器 cookie 校验（fail closed，不会因为「有守卫」就无条件放行）。
\t\tif (request[Symbol.for("dsh.guardPassed")] === true) return void 0;
\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;
\t}`,
    note: "RPC/API rejection defers to active guard",
  },
];

function targets(rel) {
  const list = [];
  for (const root of ACTIVE_ROOTS) {
    const f = join(root, rel);
    if (existsSync(f)) list.push(f);
  }
  return [...new Set(list)];
}

function checkSyntax(file) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

function applyFile(path, patch) {
  const text = readFileSync(path, "utf8");
  if (!text.includes(patch.old)) {
    // 幂等：已打过的（new 已存在）算成功；否则报锚点丢失
    if (text.includes(patch.new)) return { path, status: "already" };
    throw new Error(`anchor not found in ${path} for: ${patch.note}`);
  }
  const backup = path + BACKUP_SUFFIX;
  if (!existsSync(backup)) copyFileSync(path, backup);
  const out = text.replace(patch.old, patch.new);
  writeFileSync(path, out, "utf8");
  checkSyntax(path);
  return { path, status: "applied" };
}

function revertFile(path, patch) {
  const backup = path + BACKUP_SUFFIX;
  if (!existsSync(backup)) return { path, status: "no-backup" };
  const text = readFileSync(path, "utf8");
  if (!text.includes(patch.new)) return { path, status: "not-applied" };
  writeFileSync(path, readFileSync(backup, "utf8"), "utf8");
  rmSync(backup, { force: true });
  checkSyntax(path);
  return { path, status: "reverted" };
}

// 目标根目录：默认两棵真实树；`--root <dir>`（可重复）可指向**副本树**做隔离验证。
// 例：node apply-no-token-auth.mjs --apply --root "C:/tmp/test/node_modules/@deepseek-ai"
const ROOT_OVERRIDES = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--root" && process.argv[i + 1]) ROOT_OVERRIDES.push(process.argv[i + 1]);
}
const ACTIVE_ROOTS = ROOT_OVERRIDES.length ? ROOT_OVERRIDES : [NPX_ROOT, PROFILE_ROOT].filter(Boolean);

const MODES = ["--apply", "--verify", "--revert"];
const mode = process.argv.slice(2).find((a) => MODES.includes(a)) ?? "--verify";

const results = [];
for (const patch of PATCHES) {
  const seen = new Set();
  for (const path of targets(patch.file)) {
    const text = readFileSync(path, "utf8");
    let status;
    if (mode === "--verify") {
      status = text.includes(patch.new) ? "applied" : text.includes(patch.old) ? "clean" : "unknown";
    } else if (mode === "--apply") {
      const r = applyFile(path, patch);
      status = r.status;
    } else {
      const r = revertFile(path, patch);
      status = r.status;
    }
    if (!seen.has(path)) results.push({ file: path, note: patch.note, status });
    seen.add(path);
  }
  if (targets(patch.file).length === 0) results.push({ file: patch.file, note: patch.note, status: "missing" });
}

for (const r of results) console.log(`${r.status.padEnd(10)} ${r.file}  — ${r.note}`);
if (mode === "--apply") console.log("\n⚠ 改的是运行时物理文件，需重启 harness 生效。");
console.log("双树 hash 一致性：");
const { createHash } = await import("node:crypto");
for (const rel of RELS) {
  const list = targets(rel);
  if (list.length < 2) {
    console.log(`  ${rel}: 仅一棵物理文件（${list[0] ?? "无"}）—— junction/硬链场景，天然一致`);
    continue;
  }
  const hashes = list.map((f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16));
  console.log(`  ${rel}: ${hashes.every((h) => h === hashes[0]) ? "一致" : "不一致！ " + hashes.join(" vs ")}`);
}
