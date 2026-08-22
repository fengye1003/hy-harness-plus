#!/usr/bin/env node
// apply-webserver-patch.mjs — re-apply the registerGuard guard hook to the
// DeepSeek Harness webserver (dsh-host-webserver).
//
// Why: a harness upgrade (npx reinstall) overwrites the npm cache with the
// official webserver, wiping the registerGuard hook that dsh-web-auth depends
// on. Before this script existed the plugin threw "registerGuard is not a
// function" and the whole plugin tree failed to boot. The companion plugin is
// now defensive (degrades with a warning instead of crashing), and this script
// makes re-applying the patch one idempotent command.
//
// Usage:
//   node apply-webserver-patch.mjs --check     # detect both install locations
//   node apply-webserver-patch.mjs --apply     # patch if missing (idempotent)
//   node apply-webserver-patch.mjs --verify    # syntax check + hash consistency
//
// It patches BOTH install locations: the npx cache copy (where the harness
// actually runs) and ~/.dsh/profiles/node_modules (junction fallback). Keep
// their hashes identical.
//
// Cross-platform: the npx cache root defaults to the per-user npm cache
// (%LOCALAPPDATA%\npm-cache\_npx on Windows, ~/.npm/_npx on macOS/Linux);
// override with DSH_NPX_ROOT if your layout differs.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── locate the two install locations ────────────────────────────────────
const home = homedir();
function defaultNpxRoot() {
  const win = process.platform === "win32";
  const base = win
    ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "npm-cache", "_npx")
    : join(home, ".npm", "_npx");
  return process.env.DSH_NPX_ROOT || base;
}
const npxRoot = defaultNpxRoot();
const REL = "node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js";

function listDirs(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}
function mtimeMs(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

function findNpxWebserver() {
  if (!existsSync(npxRoot)) return null;
  const cands = listDirs(npxRoot).map(d => join(npxRoot, d, REL)).filter(existsSync);
  if (!cands.length) return null;
  cands.sort((a, b) => mtimeMs(b) - mtimeMs(a));
  return cands[0];
}

function locate() {
  const targets = [];
  const npx = findNpxWebserver();
  if (npx) targets.push(npx);
  const profile = join(home, ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh-host-webserver", "lib", "index.js");
  if (existsSync(profile)) targets.push(profile);
  return targets;
}

// ── patch content (anchor insertion, idempotent) ────────────────────────
// Same shape as the manual 2026-08-16 patch: guards member / registerGuard
// method / HTTP handle guard / upgrade guard. Anchors have stayed stable
// across 0.1.0-rc.7 and 0.1.1-rc.2 (webserver moved into dsh-host-webserver
// in 0.1.1 — this script already targets the new path).
const MARK = "// [dsh-web-auth] registerGuard hook (patched by apply-webserver-patch.mjs)";

function patchSource(src) {
  if (src.includes("registerGuard")) return { ok: true, already: true, src };

  // 1) guards member: right after the indexTaps array declaration
  if (!src.includes("guards = []")) {
    const anchor1 = "indexTaps = [];";
    if (!src.includes(anchor1)) return { ok: false, error: `anchor1 missing: ${anchor1}` };
    src = src.replace(anchor1, anchor1 + `\n\t/** Optional request guards run before route dispatch (empty by default). */\n\tguards = [];`);
  }

  // 2) registerGuard method: right after registerFallback's closing brace
  const anchor2 = "return () => {\n\t\t\tthis.fallback = void 0;\n\t\t};\n\t}";
  const guardMethod = `
	/**
	* Register a request guard. Guards run before route dispatch for every
	* request (and upgrade); a guard returning false has handled the request
	* and stops dispatch. Empty by default; the web-auth plugin depends on it.
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
  if (!src.includes("registerGuard(guard)")) {
    if (!src.includes(anchor2)) return { ok: false, error: `anchor2 missing: ${anchor2}` };
    src = src.replace(anchor2, anchor2 + guardMethod);
  }

  // 3) HTTP handle guard: right after rawPath parse, before match
  const anchor3 = "const rawPath = new URL(req.url ?? \"/\", \"http://x\").pathname;\n\t\t\tconst route = this.match(rawPath);";
  const handleGuard = "const rawPath = new URL(req.url ?? \"/\", \"http://x\").pathname;\n\t\t\tfor (const guard of this.guards) {\n\t\t\t\tif (await guard.check(req, res, rawPath) === false) return;\n\t\t\t}\n\t\t\tconst route = this.match(rawPath);";
  if (!src.includes("for (const guard of this.guards) {")) {
    if (!src.includes(anchor3)) return { ok: false, error: `anchor3 missing: ${anchor3}` };
    src = src.replace(anchor3, handleGuard);
  }

  // 4) upgrade callback: make async + run guards
  if (!src.includes("async (req, socket, head) => {")) {
    const anchor4a = 'this.server.on("upgrade", (req, socket, head) => {';
    if (!src.includes(anchor4a)) return { ok: false, error: `anchor4a missing: ${anchor4a}` };
    src = src.replace(anchor4a, 'this.server.on("upgrade", async (req, socket, head) => {');
  }
  const anchor4b = `\t\t\tlet route;\n\t\t\ttry {\n\t\t\t\t/* v8 ignore next -- node:http always sets url on server requests. */\n\t\t\t\troute = this.upgrades.get(new URL(req.url ?? "/", "http://x").pathname);`;
  const upgradeGuard = `\t\t\tlet rawPath;\n\t\t\ttry {\n\t\t\t\t/* v8 ignore next -- node:http always sets url on server requests. */\n\t\t\t\trawPath = new URL(req.url ?? "/", "http://x").pathname;\n\t\t\t} catch (error) {\n\t\t\t\tthis.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));\n\t\t\t\tsocket.destroy();\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tfor (const guard of this.guards) {\n\t\t\t\tconst allow = guard.checkUpgrade ? await guard.checkUpgrade(req, socket, head, rawPath) : true;\n\t\t\t\tif (allow === false) return;\n\t\t\t}\n\t\t\tlet route;\n\t\t\ttry {\n\t\t\t\t/* v8 ignore next -- node:http always sets url on server requests. */\n\t\t\t\troute = this.upgrades.get(rawPath);`;
  if (!src.includes("guard.checkUpgrade ?")) {
    if (!src.includes(anchor4b)) return { ok: false, error: `anchor4b missing: ${anchor4b}` };
    src = src.replace(anchor4b, upgradeGuard);
  }

  // 5) marker
  src = src.replace("//#region lib/types/index.js", `${MARK}\n//#region lib/types/index.js`);
  return { ok: true, already: false, src };
}

// ── helpers ─────────────────────────────────────────────────────────────
function sha256(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
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

const targets = explicitPath ? [explicitPath] : locate();
if (targets.length === 0) {
  log("ERR", "could not find dsh-host-webserver/lib/index.js (neither npx cache nor profiles/node_modules)");
  process.exit(1);
}

let allOk = true;
for (const p of targets) {
  const src = readFileSync(p, "utf8");
  const has = src.includes("registerGuard");
  log("INFO", `${p}`);
  log("INFO", `  registerGuard: ${has ? "PRESENT" : "MISSING"}`);

  if (mode === "--check") continue;

  if (mode === "--apply") {
    const r = patchSource(src);
    if (!r.ok) { log("ERR", `  patch failed: ${r.error}`); allOk = false; continue; }
    if (r.already) { log("OK", "  already patched, skipping"); continue; }
    writeFileSync(p, r.src, "utf8");
    log("OK", "  patch written");
    continue;
  }

  if (mode === "--verify") {
    const ok = syntaxCheck(p);
    log(ok ? "OK" : "ERR", `  node --check: ${ok ? "passed" : "failed"}`);
    if (!ok) allOk = false;
    const has2 = readFileSync(p, "utf8").includes("registerGuard");
    if (!has2) { log("ERR", "  registerGuard missing"); allOk = false; }
  }
}

if (mode === "--verify" && targets.length >= 2) {
  const [h1, h2] = targets.map(sha256);
  log(h1 === h2 ? "OK" : "ERR", `both hashes ${h1 === h2 ? "match" : "MISMATCH!"}`);
  if (h1 !== h2) allOk = false;
}

if (mode === "--apply") {
  console.log("");
  log("INFO", "apply done, auto-verifying…");
  const { execSync } = await import("node:child_process");
  const extra = explicitPath ? ` --path ${JSON.stringify(explicitPath)}` : "";
  try { execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(__dirname, "apply-webserver-patch.mjs"))} --verify${extra}`, { stdio: "inherit" }); } catch { allOk = false; }
}

process.exit(allOk ? 0 : 1);
