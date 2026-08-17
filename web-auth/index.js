// dsh-web-auth — TOTP 2FA + cookie-token authentication for the DeepSeek
// Harness web surface.
//
// Zero-dependency: uses only node: builtins, so it never needs a package
// install. Mounted through the profile patch layer (cordis.patch.yml) with
// `name: './auth-plugin/index.js'`.
//
// Flow:
//   1. A browser (or API client) without a valid `dsh_auth` cookie is
//      redirected (HTML) or answered 401 (JSON) by the webserver guard.
//   2. GET  /auth/login                     → the TOTP entry page.
//   3. POST /auth/verify  (code)            → checks the 6-digit TOTP, then
//                                             issues a 30-day cookie token.
//   4. GET  /auth/templogin/sumisecret/gettokenbypasskey?passkey=…
//                                             → emergency plain-text bypass.
//   5. GET  /auth/tokens + POST /auth/tokens/revoke → token management UI.
//   6. POST /auth/logout                    → revokes the current token.
//
// The first launch generates the TOTP secret, prints the otpauth URI to the
// log, and writes a recovery copy to `backupDir` (configured to the vault).
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const name = "web-auth";
export const inject = ["webServer"];

// ── constants ─────────────────────────────────────────────────────────────
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // ±1 step of slack
const COOKIE_NAME = "dsh_auth";
const AUTH_PREFIX = "/auth";
const LOGIN_ENDPOINTS = new Set([
  "/auth/login",
  "/auth/verify",
  "/auth/templogin/sumisecret/gettokenbypasskey",
]);
const FLUSH_INTERVAL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 3_600_000;
const RATE_CLEANUP_MS = 600_000;

// ── base32 (RFC 4648, unpadded) ───────────────────────────────────────────
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/g, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ────────────────────────────────
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return (code % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

function totpAt(secret, timeSec) {
  return hotp(secret, Math.floor(timeSec / TOTP_PERIOD));
}

function verifyTotp(secret, code, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i += 1) {
    if (totpAt(secret, nowSec + i * TOTP_PERIOD) === code) return true;
  }
  return false;
}

// ── tiny helpers ──────────────────────────────────────────────────────────
function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  const addr = req.socket?.remoteAddress;
  if (!addr) return "unknown";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(text, contentType = "") {
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text || ""));
}

function sanitizeNext(next) {
  if (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\")) {
    return next;
  }
  return "/";
}

function esc(html) {
  return String(html).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function setAuthCookie(res, raw, ttlDays) {
  const maxAge = Math.max(1, Math.floor(ttlDays * 86400));
  res.setHeader("set-cookie", `${COOKIE_NAME}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearAuthCookie(res) {
  res.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function rejectUnauthenticated(req, res, rawPath) {
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/html")) {
    const next = encodeURIComponent(rawPath);
    res.writeHead(302, { location: `/auth/login?next=${next}` });
    res.end();
    return;
  }
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized", need: "totp", login: "/auth/login" }));
}

function sendTooMany(res) {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "too many attempts, try again later" }));
}

// ── rate limiting (per key, in-memory) ────────────────────────────────────
const rateBuckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

function sweepRateBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}

// ── auth state (tokens + TOTP secret) ─────────────────────────────────────
function defaultStateFile() {
  return join(homedir(), ".dsh", "auth", "state.json");
}

class AuthState {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.secret = null;
    this.ttlMs = 30 * 86_400_000;
    this.lastFlush = 0;
  }

  load() {
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, "utf8"));
      } catch (error) {
        throw new Error(`web-auth: cannot parse state file ${this.file}: ${String(error)}`);
      }
      if (!this.data || typeof this.data !== "object" || !this.data.secret) {
        throw new Error(`web-auth: state file ${this.file} is missing the "secret" field`);
      }
    } else {
      this.data = {
        version: 1,
        secret: base32Encode(randomBytes(20)),
        createdAt: Date.now(),
        tokens: {},
      };
      this.save();
    }
    this.secret = base32Decode(this.data.secret);
    return this;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
    this.lastFlush = Date.now();
  }

  maybeFlush() {
    if (Date.now() - this.lastFlush >= FLUSH_INTERVAL_MS) this.save();
  }

  createToken(note) {
    const raw = randomBytes(32).toString("hex");
    const id = randomBytes(8).toString("hex");
    const now = Date.now();
    this.data.tokens[id] = {
      hash: sha256(raw),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastUsedAt: now,
      lastIp: null,
      note: note || "",
      revoked: false,
    };
    this.save();
    return { id, raw };
  }

  /** Return the token id whose hash matches, or null. */
  findToken(raw) {
    if (!raw) return null;
    const want = sha256(raw);
    for (const [id, token] of Object.entries(this.data.tokens)) {
      if (token.revoked) continue;
      if (safeEqual(token.hash, want)) return id;
    }
    return null;
  }

  /** Record usage; false when the token is gone/revoked/expired. */
  touch(id, ip) {
    const token = this.data.tokens[id];
    if (!token || token.revoked) return false;
    if (Date.now() > token.expiresAt) return false;
    token.lastUsedAt = Date.now();
    token.lastIp = ip;
    this.maybeFlush();
    return true;
  }

  revoke(id) {
    const token = this.data.tokens[id];
    if (!token) return false;
    token.revoked = true;
    this.save();
    return true;
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [id, token] of Object.entries(this.data.tokens)) {
      if (token.revoked || now > token.expiresAt) {
        delete this.data.tokens[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

// ── recovery backup (written to the vault via backupDir) ──────────────────
function otpauthUri(secretB32, issuer, label) {
  const labelEnc = encodeURIComponent(label);
  const issuerEnc = encodeURIComponent(issuer);
  return `otpauth://totp/${labelEnc}?secret=${secretB32}&issuer=${issuerEnc}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

const RECOVERY_README = `# DSH Web 认证恢复资料

此目录保存 DeepSeek Harness Web 界面的 2FA 认证恢复资料（仅供重建/恢复使用）。

- \`totp-secret.txt\` — TOTP 密钥（Base32）与 OTPAuth URI。
- 用途：设备或 DSH 安装损毁后重建时，恢复身份验证器 App 的同步密钥。

## 恢复步骤
1. 重建 DSH Web 后，插件首次启动会自动生成新密钥；
   如需恢复旧密钥，把 \`totp-secret.txt\` 中的 Secret 写入状态文件
   \`~/.dsh/auth/state.json\` 的 \`secret\` 字段，然后重启 DSH。
2. 或在身份验证器 App 中手动添加 OTPAuth URI（扫码或粘贴）。

## 安全提示
- 本目录包含敏感凭据，请勿外传、勿提交到公开仓库。
- 应急 bypass 口令（纯文本）保存在 profile 配置
  \`~/.dsh/profiles/web/cordis.patch.yml\` 的 web-auth 行中，需要时自行修改。
`;

function writeBackup(dir, secretB32, issuer, label, logger) {
  try {
    mkdirSync(dir, { recursive: true });
    const uri = otpauthUri(secretB32, issuer, label);
    const lines = [
      "DeepSeek Harness Web — TOTP 认证恢复资料",
      `生成时间: ${new Date().toISOString()}`,
      "",
      `TOTP Secret (Base32): ${secretB32}`,
      `OTPAuth URI: ${uri}`,
      "",
      "恢复方法：把上面 Secret 写入 ~/.dsh/auth/state.json 的 secret 字段后重启 DSH；",
      "或在身份验证器 App 中扫码/手动输入 OTPAuth URI。",
      "",
    ];
    writeFileSync(join(dir, "totp-secret.txt"), lines.join("\n"), "utf8");
    writeFileSync(join(dir, "README.md"), RECOVERY_README, "utf8");
    logger?.info(`web-auth: TOTP secret backed up to ${dir}`);
  } catch (error) {
    logger?.warn(`web-auth: backup failed: ${String(error)}`);
  }
}

// ── index.html UUID polyfill (insecure-context LAN HTTP fix) ──────────────
// crypto.randomUUID() is a secure-context-only Web API (exists only on HTTPS
// or localhost). Visiting the GUI over plain HTTP on a LAN/tailnet IP (e.g.
// http://192.168.x.x:3080) crashes the browser bundle at the first RPC.
// Discussion: deepseek-ai/deepseek-harness#514. We inject a
// crypto.getRandomValues()-based UUID v4 polyfill into every served
// index.html before any module script runs (a sync <script> in <head>).
const UUID_POLYFILL_MARKER = "dsh-web-auth-uuid-polyfill";
const UUID_POLYFILL_SCRIPT = `<script data-${UUID_POLYFILL_MARKER}="1">/* ${UUID_POLYFILL_MARKER}: crypto.randomUUID() is secure-context-only (HTTPS/localhost); polyfill via crypto.getRandomValues() so LAN plain-HTTP works */if(globalThis.crypto&&!globalThis.crypto.randomUUID){try{globalThis.crypto.randomUUID=function(){var b=globalThis.crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=x.length<2?"0"+x:x}return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}catch(e){}}</script>`;

function injectUuidPolyfill(html) {
  if (!html || html.includes(UUID_POLYFILL_MARKER)) return html;
  const at = html.indexOf("</head>");
  if (at === -1) return html;
  return html.slice(0, at) + UUID_POLYFILL_SCRIPT + "\n" + html.slice(at);
}

// ── pages ─────────────────────────────────────────────────────────────────
const PAGE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f1115; color: #e6e8eb; padding: 16px; }
main { width: min(94vw, 440px); padding: 32px; border-radius: 16px; background: #171a21; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
h1 { font-size: 20px; margin: 0 0 6px; }
p { color: #9aa1ab; margin: 0 0 18px; font-size: 14px; line-height: 1.6; }
input[type=text], input[type=password], input:not([type]) { width: 100%; padding: 12px 14px; font-size: 22px; letter-spacing: 8px; text-align: center; border-radius: 10px; border: 1px solid #2a2f3a; background: #0f1115; color: #fff; outline: none; }
input:focus { border-color: #4f7cff; }
button { padding: 10px 16px; font-size: 14px; font-weight: 600; border: 0; border-radius: 10px; background: #4f7cff; color: #fff; cursor: pointer; }
button:hover { background: #3f6ae8; }
button.danger { background: #c0392b; }
button.danger:hover { background: #a93226; }
button.ghost { background: transparent; border: 1px solid #2a2f3a; color: #9aa1ab; }
form.inline { display: inline; }
.error { color: #ff6b6b; margin-top: 14px; }
.hint { font-size: 12px; color: #6b7280; margin-top: 16px; text-align: center; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #242a35; vertical-align: top; }
th { color: #9aa1ab; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .4px; }
code { background: #0f1115; padding: 2px 6px; border-radius: 6px; font-size: 12px; }
.actions { margin-top: 20px; display: flex; gap: 10px; align-items: center; }
a { color: #4f7cff; text-decoration: none; font-size: 13px; }
a:hover { text-decoration: underline; }
`;

function pageShell(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>${body}</main>
</body>
</html>`;
}

function loginPage(next, error) {
  const errHtml = error ? '<p class="error">口令无效或已过期，请重试。</p>' : "";
  return pageShell("DSH 认证", `
<h1>DeepSeek Harness</h1>
<p>此服务受 2FA 保护。请输入身份验证器应用中的 6 位动态口令。</p>
<form method="post" action="/auth/verify">
<input type="hidden" name="next" value="${esc(next)}">
<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus>
<p></p>
<button type="submit">验证并进入</button>
</form>
${errHtml}
<p class="hint">验证成功后，浏览器将保存约 30 天的登录状态</p>
`);
}

function tokensPage(state) {
  const tokens = Object.entries(state.data.tokens).filter(([, t]) => !t.revoked);
  const rows = tokens.map(([id, t]) => `
<tr>
<td><code>${esc(id.slice(0, 8))}…</code></td>
<td>${fmtTime(t.createdAt)}</td>
<td>${fmtTime(t.expiresAt)}</td>
<td>${fmtTime(t.lastUsedAt)}</td>
<td>${esc(t.lastIp || "—")}</td>
<td>${esc(t.note || "—")}</td>
<td><form class="inline" method="post" action="/auth/tokens/revoke"><input type="hidden" name="id" value="${esc(id)}"><button class="danger" type="submit">吊销</button></form></td>
</tr>`).join("\n");
  return pageShell("Token 管理", `
<h1>会话与 Token 管理</h1>
<p>共 ${tokens.length} 个有效 token。过期或已吊销的 token 会被自动清理；吊销后该 token 立即失效。</p>
<table>
<thead><tr><th>ID</th><th>创建时间</th><th>过期时间</th><th>最后使用</th><th>最后 IP</th><th>备注</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">暂无有效 token</td></tr>'}</tbody>
</table>
<div class="actions">
<a href="/">返回 Harness</a>
<form class="inline" method="post" action="/auth/logout"><button class="ghost" type="submit">登出</button></form>
</div>
`);
}

// ── plugin ────────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  const cfg = {
    passkeyHash: config.passkeyHash ?? (config.passkey ? sha256(config.passkey) : null),
    tokenTtlDays: Number(config.tokenTtlDays) || 30,
    stateFile: config.stateFile || defaultStateFile(),
    backupDir: config.backupDir || join(dirname(defaultStateFile()), "backup"),
    issuer: config.issuer || "DSH",
    label: config.label || "DeepSeek Harness",
  };

  // Register the index.html UUID polyfill FIRST: it is the LAN-HTTP fix, and
  // every webserver build (with or without registerGuard) has tapIndex, so
  // this applies even on a process that predates the guard patch.
  ctx.webServer.tapIndex(injectUuidPolyfill);

  const state = new AuthState(cfg.stateFile).load();
  state.ttlMs = cfg.tokenTtlDays * 86_400_000;

  // First-launch backup only (do not overwrite an existing recovery file).
  const backupFile = join(cfg.backupDir, "totp-secret.txt");
  if (!existsSync(backupFile)) {
    writeBackup(cfg.backupDir, state.data.secret, cfg.issuer, cfg.label, ctx.logger);
  }

  ctx.logger.info(`web-auth: TOTP 2FA active (issuer=${cfg.issuer}, ttl=${cfg.tokenTtlDays}d, state=${cfg.stateFile})`);
  if (!cfg.passkeyHash) {
    ctx.logger.warn("web-auth: no passkey configured — the emergency bypass route is disabled");
  }

  // ── guard: everything except the login endpoints requires a valid token ──
  const guard = {
    name: "web-auth",
    check: async (req, res, rawPath) => {
      if (LOGIN_ENDPOINTS.has(rawPath)) return true;
      const raw = parseCookies(req)[COOKIE_NAME];
      const id = state.findToken(raw);
      if (id !== null && state.touch(id, clientIp(req))) return true;
      rejectUnauthenticated(req, res, rawPath);
      return false;
    },
    checkUpgrade: async (req, socket, head, rawPath) => {
      if (LOGIN_ENDPOINTS.has(rawPath)) return true;
      const raw = parseCookies(req)[COOKIE_NAME];
      const id = state.findToken(raw);
      if (id !== null && state.touch(id, clientIp(req))) return true;
      try {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      } catch {
        /* socket already gone */
      }
      socket.destroy();
      return false;
    },
  };
  ctx.webServer.registerGuard(guard);

  // ── routes ──────────────────────────────────────────────────────────────
  const routes = {
    "/auth/login": async (req, res) => {
      const u = new URL(req.url || "/", "http://x");
      const next = sanitizeNext(u.searchParams.get("next") || "/");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(loginPage(next, u.searchParams.get("error") === "1"));
    },

    "/auth/verify": async (req, res) => {
      const ip = clientIp(req);
      if (!rateLimit(`totp:${ip}`, 5, 60_000)) {
        sendTooMany(res);
        return;
      }
      let form;
      try {
        const text = await readBody(req);
        form = parseForm(text, req.headers["content-type"] || "");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
        return;
      }
      const code = String(form.code || "").trim();
      const next = sanitizeNext(form.next || "/");
      if (!verifyTotp(state.secret, code)) {
        res.writeHead(302, { location: `/auth/login?next=${encodeURIComponent(next)}&error=1` });
        res.end();
        return;
      }
      const { raw } = state.createToken("browser login");
      setAuthCookie(res, raw, cfg.tokenTtlDays);
      res.writeHead(302, { location: next });
      res.end();
    },

    "/auth/logout": async (req, res) => {
      const raw = parseCookies(req)[COOKIE_NAME];
      const id = state.findToken(raw);
      if (id !== null) state.revoke(id);
      clearAuthCookie(res);
      res.writeHead(302, { location: "/auth/login" });
      res.end();
    },

    "/auth/tokens": async (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(tokensPage(state));
    },

    "/auth/tokens/revoke": async (req, res) => {
      let form;
      try {
        const text = await readBody(req);
        form = parseForm(text, req.headers["content-type"] || "");
      } catch {
        form = {};
      }
      const id = String(form.id || "");
      if (id) state.revoke(id);
      res.writeHead(302, { location: "/auth/tokens" });
      res.end();
    },

    "/auth/templogin/sumisecret/gettokenbypasskey": async (req, res) => {
      const ip = clientIp(req);
      if (!rateLimit(`passkey:${ip}`, 3, 60_000)) {
        sendTooMany(res);
        return;
      }
      if (!cfg.passkeyHash) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }
      const u = new URL(req.url || "/", "http://x");
      const passkey = u.searchParams.get("passkey") || "";
      if (!safeEqual(sha256(passkey), cfg.passkeyHash)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }
      const { raw } = state.createToken("bypass recovery");
      setAuthCookie(res, raw, cfg.tokenTtlDays);
      res.writeHead(302, { location: "/" });
      res.end();
    },
  };

  for (const [path, handler] of Object.entries(routes)) {
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path, handler }), `web-auth: ${path}`);
  }

  // Periodic cleanup of expired tokens and rate-limit buckets.
  const sweeper = setInterval(() => {
    state.cleanup();
    sweepRateBuckets();
  }, CLEANUP_INTERVAL_MS);
  if (typeof sweeper.unref === "function") sweeper.unref();
  ctx.on("dispose", () => clearInterval(sweeper));
}
