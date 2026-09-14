#!/usr/bin/env node
// apply-webserver-patch.mjs — 给 dsh-host-webserver 打 registerGuard 守卫钩子补丁（v2）
//
// 背景（2026-08-18 事故复盘）：harness 升级（npx 重装）会把 npm 缓存里的
// webserver 覆盖成官方原版，registerGuard 钩子随之丢失 → web-auth 插件调用
// ctx.webServer.registerGuard 抛 TypeError → 整个插件树加载失败 → harness 无法启动。
//
// v2（2026-09-14，根因修复）——**必须与 dsh-no-token-auth 的 marker 版配套**：
//   守卫放行后给请求对象打一个跨包共享的全局 symbol 标记：
//       req[Symbol.for("dsh.guardPassed")] = true
//   为什么需要它：旧版 no-token-auth 让 client-connection 读 `this.ctx.webServer.guards`
//   来判断「有没有守卫」，但 cordis 对**未 inject 的服务属性访问会直接 throw**
//   （cannot get property "webServer" without inject）→ requestRejection 每次调用都在
//   第一行抛错 → /api/* 全 400（webserver catch 写空 400）、remote.mux WS 被
//   socket.destroy()（浏览器 connection lost, retry #N）。改用「请求上的标记」后，
//   client-connection 既不需要 inject webServer，也不用碰 cordis 服务表。
//   ⚠️ 标记只在 `guards.length > 0`（真有守卫且全部放行）时打 —— 无守卫 = 回退核心
//   Host/Origin 围栏 + cookie 校验，fail closed，绝不因为「注册过守卫」就无条件放行。
//
// 用法：
//   node apply-webserver-patch.mjs --check     # 只检测
//   node apply-webserver-patch.mjs --apply     # 幂等打补丁（v1 → v2 自动就地升级）
//   node apply-webserver-patch.mjs --verify    # 语法 + hash + 结构断言
//   --path <file>                              # 只处理指定文件（隔离验证副本用）
//
// 配套：插件本身是防御性加载（registerGuard 缺失时降级告警，不 fatal），见
// auth-plugin/index.js 的 apply()。两个安装位置都要打，保持 hash 一致。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 定位两个安装位置 ──────────────────────────────────────────────
const home = homedir();
// npx 缓存根：跨平台推导 + 可用 DSH_NPX_ROOT 覆盖（**不要写死用户名或绝对路径**）
const npxRoots = (() => {
  const out = [];
  if (process.env.DSH_NPX_ROOT) out.push(process.env.DSH_NPX_ROOT);
  if (process.platform === "win32") out.push(join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "npm-cache", "_npx"));
  out.push(join(home, ".npm", "_npx"));   // macOS / Linux
  return [...new Set(out)];
})();
const REL = "node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js";

function listDirs(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}
function mtimeMs(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

function findNpxWebserver() {
  const cands = [];
  for (const root of npxRoots) {
    if (!existsSync(root)) continue;
    for (const d of listDirs(root)) cands.push(join(root, d, REL));
  }
  const found = cands.filter(existsSync);
  if (!found.length) return null;
  found.sort((a, b) => mtimeMs(b) - mtimeMs(a));
  return found[0];
}

function locate() {
  const targets = [];
  const npx = findNpxWebserver();
  if (npx) targets.push(npx);
  const profile = join(home, ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh-host-webserver", "lib", "index.js");
  if (existsSync(profile)) targets.push(profile);
  return targets;
}

// ── 补丁内容 ──────────────────────────────────────────────────────
const MARK = "// [dsh-web-auth] registerGuard hook v2 (guard-passed marker) — patched by apply-webserver-patch.mjs";
const MARKER_EXPR = 'req[Symbol.for("dsh.guardPassed")] = true;';

// v2 HTTP 钩子（守卫在路由派发之前；只有真的有守卫且全部放行才打标记）
const V2_HTTP_HOOK = "const rawPath = new URL(req.url ?? \"/\", \"http://x\").pathname;\n"
  + "\t\t\tif (this.guards.length > 0) {\n"
  + "\t\t\t\tfor (const guard of this.guards) {\n"
  + "\t\t\t\t\tif (await guard.check(req, res, rawPath) === false) return;\n"
  + "\t\t\t\t}\n"
  + "\t\t\t\t" + MARKER_EXPR + "\n"
  + "\t\t\t}\n"
  + "\t\t\tconst route = this.match(rawPath);";

// v2 upgrade 钩子
const V2_UP_HOOK = "\t\t\tif (this.guards.length > 0) {\n"
  + "\t\t\t\tfor (const guard of this.guards) {\n"
  + "\t\t\t\t\tconst allow = guard.checkUpgrade ? await guard.checkUpgrade(req, socket, head, rawPath) : true;\n"
  + "\t\t\t\t\tif (allow === false) return;\n"
  + "\t\t\t\t}\n"
  + "\t\t\t\t" + MARKER_EXPR + "\n"
  + "\t\t\t}";

// v1 旧钩子文本（用于 v1 → v2 就地升级）
const V1_HTTP_HOOK = "\t\t\tfor (const guard of this.guards) {\n\t\t\t\tif (await guard.check(req, res, rawPath) === false) return;\n\t\t\t}";
const V1_UP_HOOK = "\t\t\tfor (const guard of this.guards) {\n\t\t\t\tconst allow = guard.checkUpgrade ? await guard.checkUpgrade(req, socket, head, rawPath) : true;\n\t\t\t\tif (allow === false) return;\n\t\t\t}";

function patchSource(src) {
  const hasMarker = src.includes(MARKER_EXPR);
  const hasGuardMethod = src.includes("registerGuard(guard)");
  if (hasGuardMethod && hasMarker) return { ok: true, already: true, src };
  const upgradedFromV1 = hasGuardMethod && !hasMarker;

  // 1) guards 成员：跟在 indexTaps 数组声明后（仅全新安装需要）
  if (!src.includes("guards = []")) {
    const anchor1 = "indexTaps = [];";
    if (!src.includes(anchor1)) return { ok: false, error: `anchor1 missing: ${anchor1}` };
    src = src.replace(anchor1, anchor1 + `\n\t/** Optional request guards run before route dispatch (empty by default). */\n\tguards = [];`);
  }

  // 2) registerGuard 方法：跟在 registerFallback 方法结束后（仅全新安装需要）
  if (!hasGuardMethod) {
    const anchor2 = "return () => {\n\t\t\tthis.fallback = void 0;\n\t\t};\n\t}";
    const guardMethod = `
	/**
	* Register a request guard. Guards run before route dispatch for every
	* request (and upgrade); a guard returning false has handled the request
	* and stops dispatch. Empty by default; the web-auth plugin depends on it.
	* Guard-passed requests are marked with Symbol.for("dsh.guardPassed") so the
	* client-connection RPC gate can defer to the guard without touching the
	* cordis service table.
	* @param guard - { check(req,res,pathname), checkUpgrade?(req,socket,head,pathname) }.
	* @returns the disposer removing the guard.
	*/
	registerGuard(guard) {
		this.guards.push(guard);
		return () => {
			const at = this.guards.indexOf(guard);
			if (at !== -1) this.guards.splice(at, 1);
		};
	}`;
    if (!src.includes(anchor2)) return { ok: false, error: `anchor2 missing: ${anchor2}` };
    src = src.replace(anchor2, anchor2 + guardMethod);
  }

  // 3) HTTP handle 守卫：rawPath 解析后、match 之前
  if (!hasMarker) {
    if (src.includes(V1_HTTP_HOOK)) {
      src = src.replace(V1_HTTP_HOOK, V2_HTTP_HOOK.slice(V2_HTTP_HOOK.indexOf("if (this.guards.length > 0)")));
    } else {
      const anchor3 = "const rawPath = new URL(req.url ?? \"/\", \"http://x\").pathname;\n\t\t\tconst route = this.match(rawPath);";
      if (!src.includes(anchor3)) return { ok: false, error: `anchor3 missing: ${anchor3}` };
      src = src.replace(anchor3, V2_HTTP_HOOK);
    }
  }

  // 4) upgrade 回调：async + 守卫
  if (!hasMarker) {
    if (!src.includes("async (req, socket, head) => {")) {
      const anchor4a = 'this.server.on("upgrade", (req, socket, head) => {';
      if (!src.includes(anchor4a)) return { ok: false, error: `anchor4a missing: ${anchor4a}` };
      src = src.replace(anchor4a, 'this.server.on("upgrade", async (req, socket, head) => {');
    }
    if (src.includes(V1_UP_HOOK)) {
      src = src.replace(V1_UP_HOOK, V2_UP_HOOK);
    } else {
      const anchor4b = `\t\t\tlet route;\n\t\t\ttry {\n\t\t\t\t/* v8 ignore next -- node:http always sets url on server requests. */\n\t\t\t\troute = this.upgrades.get(new URL(req.url ?? "/", "http://x").pathname);`;
      const upgradeGuard = `\t\t\tlet rawPath;\n\t\t\ttry {\n\t\t\t\t/* v8 ignore next -- node:http always sets url on server requests. */\n\t\t\t\trawPath = new URL(req.url ?? "/", "http://x").pathname;\n\t\t\t} catch (error) {\n\t\t\t\tthis.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));\n\t\t\t\tsocket.destroy();\n\t\t\t\treturn;\n\t\t\t}\n${V2_UP_HOOK}\n\t\t\tlet route;\n\t\t\ttry {\n\t\t\t\t/* v8 ignore next -- node:http always sets url on server requests. */\n\t\t\t\troute = this.upgrades.get(rawPath);`;
      if (!src.includes(anchor4b)) return { ok: false, error: `anchor4b missing: ${anchor4b}` };
      src = src.replace(anchor4b, upgradeGuard);
    }
  }

  // 5) 标记
  if (src.includes("//#region lib/types/index.js")) {
    src = src.replace("//#region lib/types/index.js", `${MARK}\n//#region lib/types/index.js`);
  } else if (!src.startsWith(MARK)) {
    src = MARK + "\n" + src;
  }
  return { ok: true, already: false, src, upgraded: upgradedFromV1 ? "v1->v2" : "fresh" };
}

// ── 工具 ─────────────────────────────────────────────────────────
function sha256(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function syntaxCheck(p) {
  try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); return true; } catch { return false; }
}
function log(prefix, msg) { console.log(`[${prefix}] ${msg}`); }

const mode = process.argv[2] || "--check";
if (!["--check", "--apply", "--verify"].includes(mode)) {
  console.error("usage: node apply-webserver-patch.mjs <--check|--apply|--verify> [--path <file>]");
  process.exit(2);
}
const pathIdx = process.argv.indexOf("--path");
const explicitPath = pathIdx !== -1 ? process.argv[pathIdx + 1] : null;
const noBackup = process.argv.includes("--no-backup");

const targets = explicitPath ? [explicitPath] : locate();
if (targets.length === 0) {
  log("ERR", "找不到 dsh-host-webserver/lib/index.js（npx 缓存或 profiles/node_modules 均无）");
  process.exit(1);
}

let allOk = true;
for (const p of targets) {
  const src = readFileSync(p, "utf8");
  const hasMethod = src.includes("registerGuard(guard)");
  const hasMarker = src.includes(MARKER_EXPR);
  log("INFO", `${p}`);
  log("INFO", `  registerGuard: ${hasMethod ? "PRESENT" : "MISSING"}   guard-passed marker: ${hasMarker ? "PRESENT" : "MISSING"}`);

  if (mode === "--check") continue;

  if (mode === "--apply") {
    const r = patchSource(src);
    if (!r.ok) { log("ERR", `  打补丁失败: ${r.error}`); allOk = false; continue; }
    if (r.already) { log("OK", "  已是最新（v2），跳过"); continue; }
    if (!noBackup && !existsSync(p + ".orig-webserver-patch")) copyFileSync(p, p + ".orig-webserver-patch");
    writeFileSync(p, r.src, "utf8");
    if (!syntaxCheck(p)) { log("ERR", "  写入后 node --check 失败！"); allOk = false; continue; }
    log("OK", `  补丁已写入（${r.upgraded}）`);
    continue;
  }

  if (mode === "--verify") {
    const ok = syntaxCheck(p);
    log(ok ? "OK" : "ERR", `  node --check: ${ok ? "通过" : "失败"}`);
    if (!ok) allOk = false;
    const now = readFileSync(p, "utf8");
    if (!now.includes("registerGuard(guard)")) { log("ERR", "  registerGuard 缺失"); allOk = false; }
    if (!now.includes(MARKER_EXPR)) { log("ERR", "  guard-passed marker 缺失（v1 未升级？）"); allOk = false; }
    if (!now.includes("if (this.guards.length > 0) {")) { log("ERR", "  守卫循环未包 guards.length>0 判断（会 fail-open！）"); allOk = false; }
  }
}

if (mode === "--verify" && targets.length >= 2) {
  const [h1, h2] = targets.map(sha256);
  log(h1 === h2 ? "OK" : "ERR", `两处 hash ${h1 === h2 ? "一致" : "不一致!"}`);
  if (h1 !== h2) allOk = false;
}

if (mode === "--apply") {
  console.log("");
  log("INFO", "应用完成，自动 verify…");
  const { execSync } = await import("node:child_process");
  const extra = explicitPath ? ` --path ${JSON.stringify(explicitPath)}` : "";
  try { execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(__dirname, "apply-webserver-patch.mjs"))} --verify${extra}`, { stdio: "inherit" }); } catch { allOk = false; }
}

process.exit(allOk ? 0 : 1);
