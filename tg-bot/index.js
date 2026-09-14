// dsh-tg-bot — Telegram bridge plugin for the DeepSeek Harness web profile.
//
// Zero-dependency: uses only node: builtins (plus one best-effort optional
// dynamic import of @deepseek-ai/dsh-tools to register the `tg_send` tool),
// so it never needs a package install. Mounted through the profile patch
// layer (cordis.patch.yml) with `name: './tg-bot/index.js'`.
//
// Responsibilities:
//  1. Long-poll the Telegram Bot API through a configurable HTTP proxy
//     (default http://127.0.0.1:7897) and forward whitelisted users' messages
//     into the harness agent conversation: `agent.steer()` while running (the
//     reply is read before the next action), `agent.followup()` while idle
//     (queued as the next turn), or cancel+followup in "hard" interrupt mode.
//  2. Report progress back to Telegram: turn completion echo, agent errors,
//     status transitions, plus a `tg_send` tool the model can call to push a
//     message at any time.
//  3. Verification: programmatic TOTP (RFC 6238, by default the SAME secret as
//     dsh-web-auth) with a persisted uid+username whitelist, per-user failure
//     counting, and a 2-hour lockout after `maxFailures` failures. The
//     verification path never touches an LLM — no prompt-injection surface.
//  4. A web panel (default /tg-bot) behind the web-auth guard to toggle the
//     plugin and inspect whitelist / binding / status / lockouts.
//
// Non-blocking contract: `apply` never awaits the network. The polling loop is
// a detached async task with exponential backoff; every failure only updates
// the plugin status and retries. The harness keeps working even when Telegram
// or the proxy is unreachable.
//
// First-launch flow:
//   - The owner opens a private chat with the bot, sends /start then
//     `/verify <6-digit TOTP>`; the code is checked against the shared
//     web-auth secret (or a dedicated secret in "dedicated" mode), the uid +
//     username are persisted to the whitelist, and further messages are
//     injected into the harness conversation.

import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

export const name = "tg-bot";
export const inject = ["webServer", "tools"];

// ── constants ────────────────────────────────────────────────────────────
const TG_API_HOST = "api.telegram.org";
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // ±1 step of slack (same as dsh-web-auth)
const DEFAULT_PROXY = "http://127.0.0.1:7897";
const MAX_MSG_LEN = 4000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const STATE_VERSION = 1;
const WHITELIST_VERSION = 1;

// ── base32 (RFC 4648, unpadded) ──────────────────────────────────────────
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 window) ────────────────────
function hotp(secret, counter) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const buf = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    buf[7 - i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (code % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

function totpAt(secret, timeSec) {
  return hotp(secret, Math.floor(timeSec / TOTP_PERIOD));
}

function verifyTotp(secret, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  const expected = Buffer.from(totpAt(secret, nowSec));
  const actual = Buffer.from(code);
  if (timingSafeEqual(expected, actual)) return true;
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i += 1) {
    if (i === 0) continue;
    const cand = totpAt(secret, nowSec + i * TOTP_PERIOD);
    const a = Buffer.from(cand);
    if (a.length === actual.length && timingSafeEqual(a, actual)) return true;
  }
  return false;
}

function generateSecretB32(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

// ── tiny utilities ───────────────────────────────────────────────────────
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function truncate(str, max) {
  const s = String(str ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep that resolves early when the poll abort signal fires (fast dispose). */
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function splitMessage(text, max = MAX_MSG_LEN) {
  const parts = [];
  let rest = String(text ?? "");
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

function makeUserMessage(text, source) {
  return deepFreeze(structuredClone({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: String(text) }],
    source: { kind: "user", via: "telegram", ...(source || {}) },
  }));
}

// ── small JSON store (atomic-ish write) ───────────────────────────────────
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = null;
    this.defaults = defaults;
  }
  load() {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        if (parsed && typeof parsed === "object") {
          this.data = parsed;
          return this;
        }
      }
    } catch (error) {
      // corrupt state: fall through to defaults (keep a copy of the bad file)
      try {
        writeFileSync(`${this.file}.corrupt-${now()}`, readFileSync(this.file, "utf8"), "utf8");
      } catch { /* ignore */ }
    }
    this.data = structuredClone(this.defaults);
    this.save();
    return this;
  }
  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (error) {
      // never let persistence break the plugin
      console.error(`[tg-bot] state save failed: ${error?.message || error}`);
    }
  }
}

// ── Telegram HTTP over an optional HTTP CONNECT proxy (zero-dep) ──────────
function createProxyTunnel(proxyUrl, host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(proxyUrl);
    } catch (error) {
      reject(new Error(`invalid proxy URL "${proxyUrl}": ${error?.message}`));
      return;
    }
    const req = httpRequest({
      host: u.hostname,
      port: u.port ? Number(u.port) : 7897,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      ...(u.username ? { auth: `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` } : {}),
      ...(signal ? { signal } : {}),
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("proxy CONNECT timeout")));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
        return;
      }
      socket.setTimeout(0);
      resolve(socket);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Wrap a proxy-tunneled plain socket in TLS (SNI against the target host). */
function wrapTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, servername: host });
    let timer = null;
    const cleanup = () => {
      tlsSocket.removeListener("error", onError);
      tlsSocket.removeListener("secureConnect", onSecure);
      if (timer) clearTimeout(timer);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onSecure = () => {
      cleanup();
      resolve(tlsSocket);
    };
    timer = setTimeout(() => tlsSocket.destroy(new Error("TLS handshake timeout")), timeoutMs);
    tlsSocket.once("error", onError);
    tlsSocket.once("secureConnect", onSecure);
  });
}

function requestJson(urlStr, options = {}) {
  const { method = "POST", headers = {}, body, proxy, timeoutMs = 35000, signal } = options;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (error) {
      reject(new Error(`invalid URL "${urlStr}": ${error?.message}`));
      return;
    }
    const doRequest = (createConnection) => {
      const req = httpsRequest({
        host: u.hostname,
        port: Number(u.port || 443),
        path: u.pathname + u.search,
        method,
        headers: { ...headers, "content-length": Buffer.byteLength(body ?? "") },
        ...(createConnection ? { createConnection } : {}),
        ...(signal ? { signal } : {}),
      });
      // Hard overall deadline: guarantees no call can hang the poll loop even
      // if the socket idle timeout never fires (custom createConnection case).
      const deadline = setTimeout(() => req.destroy(new Error(`request deadline exceeded after ${timeoutMs + 5000}ms`)), timeoutMs + 5000);
      const clearDeadline = () => clearTimeout(deadline);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
      req.on("response", (res) => {
        clearDeadline();
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`telegram returned non-JSON (HTTP ${res.statusCode})`));
          }
        });
        res.on("error", reject);
      });
      req.on("error", (error) => {
        clearDeadline();
        reject(error);
      });
      if (body) req.write(body);
      req.end();
    };
    if (proxy) {
      createProxyTunnel(proxy, u.hostname, Number(u.port || 443), timeoutMs, signal)
        .then((socket) => wrapTls(socket, u.hostname, timeoutMs))
        .then((tlsSocket) => doRequest(() => tlsSocket))
        .catch(reject);
    } else {
      doRequest(null);
    }
  });
}

// ── plugin apply ──────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  const homedirPath = homedir();
  const cfg = {
    token: config.token ?? "",
    tokenFile: config.tokenFile ?? join(homedirPath, ".dsh", "tg-bot", "token.txt"),
    stateDir: config.stateDir ?? join(homedirPath, ".dsh", "tg-bot"),
    webAuthStateFile: config.webAuthStateFile ?? join(homedirPath, ".dsh", "auth", "state.json"),
    verifySecretMode: config.verifySecretMode ?? "shared", // "shared" | "dedicated"
    dedicatedSecretBackupDir: config.dedicatedSecretBackupDir ?? null,
    maxFailures: Number(config.maxFailures ?? 5),
    lockoutMs: Number(config.lockoutMs ?? 2 * 60 * 60 * 1000),
    proxy: config.proxy === "" ? null : (config.proxy ?? DEFAULT_PROXY),
    pollTimeoutSec: Number(config.pollTimeoutSec ?? 30),
    autoReport: config.autoReport !== false,
    reportTurnStart: config.reportTurnStart === true,
    echoReplies: config.echoReplies !== false,
    echoMaxChars: Number(config.echoMaxChars ?? 1500),
    interruptMode: config.interruptMode ?? "steer", // "steer" | "cancel"
    panelPath: config.panelPath ?? "/tg-bot",
    sessionId: config.sessionId ?? "",
    ownerUid: config.ownerUid ? String(config.ownerUid) : "",
    chatId: config.chatId ? String(config.chatId) : "",
    // 通用唤醒通道：外部脚本（定时任务/下载器/监控）写 wake.json → 插件消费
    // 并注入绑定会话（running=steer / idle=followup），实现「事件唤醒星澄」。
    wakeFile: config.wakeFile ? String(config.wakeFile) : "",
    wakePollSec: Math.max(3, Number(config.wakePollSec ?? 10)),
  };

  let token = readToken(cfg);
  // wake.json 默认落在 stateDir（与 token/state 同目录）；也可配置绝对路径
  // 指向你自己的唤醒信号文件（例如 <你的工作区>/wake/wake.json），便于外部脚本写入。
  const WAKE_FILE = cfg.wakeFile || join(cfg.stateDir, "wake.json");
  let disposed = false;
  let pollRunning = false;
  let pollTimer = null;
  let lastSendAt = 0;
  let pollAttempts = 0;
  let lastPollAt = 0;
  const pollAbort = new AbortController();
  const backoff = { ms: BACKOFF_BASE_MS };
  const instanceId = randomUUID();
  const appliedAt = now(); // used to detect yield signals from newer instances

  mkdirSync(cfg.stateDir, { recursive: true });
  const state = new JsonStore(join(cfg.stateDir, "state.json"), {
    version: STATE_VERSION,
    enabled: true,
    bindSessionId: cfg.sessionId || null,
    status: "idle",
    lastError: null,
    lastUpdateId: 0,
    secret: null, // dedicated mode only
    createdAt: now(),
    verifyFailures: {}, // uid -> { count, lastAt }
    lockouts: {}, // uid -> until (ms epoch)
  }).load();
  const whitelist = new JsonStore(join(cfg.stateDir, "whitelist.json"), {
    version: WHITELIST_VERSION,
    users: {}, // uid -> { uid, username, firstName, verifiedAt, lastSeenAt }
  }).load();

  const log = (...args) => { try { ctx.logger?.info("[tg-bot]", ...args); } catch { /* no logger */ } };
  const warn = (...args) => { try { ctx.logger?.warn("[tg-bot]", ...args); } catch { /* no logger */ } };

  const setStatus = (status, lastError = null, rawError = null) => {
    const err = lastError ? truncate(String(lastError), 300) : null;
    const raw = rawError ? truncate(String(rawError), 400) : (err ?? state.data.lastErrorRaw ?? null);
    const changed = state.data.status !== status || (err !== null && state.data.lastError !== err) || raw !== state.data.lastErrorRaw;
    if (changed) {
      state.data.status = status;
      if (err) {
        state.data.lastError = err;
        state.data.lastErrorRaw = raw;
      } else {
        // healthy transition clears stale error history
        state.data.lastError = null;
        state.data.lastErrorRaw = null;
      }
      state.save();
    }
  };

  // ── secret resolution (programmatic; never an LLM) ─────────────────────
  function resolveSecret() {
    if (cfg.verifySecretMode === "dedicated") {
      if (!state.data.secret) {
        const secret = generateSecretB32();
        state.data.secret = secret;
        if (cfg.dedicatedSecretBackupDir) {
          try {
            mkdirSync(cfg.dedicatedSecretBackupDir, { recursive: true });
            const backupFile = join(cfg.dedicatedSecretBackupDir, "totp-secret.txt");
            if (!existsSync(backupFile)) {
              const uri = `otpauth://totp/DSH%20Telegram?secret=${secret}&issuer=DSH&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
              writeFileSync(backupFile, [
                "DeepSeek Harness Telegram — TOTP 认证恢复资料（dedicated 模式）",
                "",
                `TOTP Secret (Base32): ${secret}`,
                `OTPAuth URI: ${uri}`,
              ].join("\n"), "utf8");
              log(`dedicated TOTP secret backed up to ${backupFile}`);
            }
          } catch (error) {
            warn(`dedicated secret backup failed: ${error?.message || error}`);
          }
        }
        state.save();
      }
      return state.data.secret;
    }
    // shared mode: reuse the dsh-web-auth secret (our TOTP scheme)
    try {
      if (!existsSync(cfg.webAuthStateFile)) return null;
      const parsed = JSON.parse(readFileSync(cfg.webAuthStateFile, "utf8"));
      return parsed && typeof parsed.secret === "string" && parsed.secret ? parsed.secret : null;
    } catch (error) {
      warn(`cannot read web-auth state (${error?.message || error})`);
      return null;
    }
  }

  // ── Telegram outbound ───────────────────────────────────────────────────
  async function tgApi(method, params, timeoutMs) {
    const res = await requestJson(`https://${TG_API_HOST}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(params ?? {}),
      proxy: cfg.proxy,
      timeoutMs: timeoutMs ?? (cfg.pollTimeoutSec + 20) * 1000,
      signal: pollAbort.signal,
    });
    if (!res || res.ok !== true) {
      const desc = res?.description ? `: ${res.description}` : "";
      throw new Error(`telegram ${method} failed (${res?.error_code ?? "?"})${desc}`);
    }
    return res.result;
  }

  async function sendMessage(chatId, text) {
    if (!token || !chatId) return false;
    const parts = splitMessage(text);
    try {
      for (let i = 0; i < parts.length; i += 1) {
        const suffix = parts.length > 1 ? `\n（${i + 1}/${parts.length}）` : "";
        await tgApi("sendMessage", { chat_id: String(chatId), text: parts[i] + suffix }, 20000);
      }
      return true;
    } catch (error) {
      warn(`sendMessage failed: ${error?.message || error}`);
      return false;
    }
  }

  // ── session / agent helpers ─────────────────────────────────────────────
  function sessionsSvc() {
    return ctx.get("sessions");
  }
  function agentsSvc() {
    return ctx.get("agents");
  }
  /**
   * 兼容 harness 会话事件读取（2026-09-06 修：DSH 0.1.2-rc.1 重构 Session，
   * 不再暴露 .events 数组 → 改为内部 log + snapshotEvents()；保留 .events 兜底以防回退旧版）。
   */
  function sessionEventsOf(session) {
    if (!session) return [];
    if (Array.isArray(session.events)) return session.events;
    if (typeof session.snapshotEvents === "function") {
      try {
        return session.snapshotEvents();
      } catch { /* 降级为空 */ }
    }
    return [];
  }
  function sessionLastTime(session) {
    const events = sessionEventsOf(session);
    const last = events.length > 0 ? events[events.length - 1] : null;
    return last?.time ?? session?.header?.createdAt ?? 0;
  }
  function liveAgents() {
    const out = [];
    const sessions = sessionsSvc();
    const agents = agentsSvc();
    if (!sessions || !agents) return out;
    for (const session of sessions.list()) {
      if (session?.header?.origin === "subagent") continue;
      const agent = agents.get(session.id);
      if (agent && agent.session === session) {
        out.push({
          session,
          agent,
          lastTime: sessionLastTime(session),
        });
      }
    }
    return out.sort((a, b) => b.lastTime - a.lastTime);
  }
  function resolveBound() {
    const id = state.data.bindSessionId;
    if (id) {
      const agent = agentsSvc()?.get(id);
      if (agent) return agent;
    }
    const top = liveAgents()[0];
    if (top) {
      if (state.data.bindSessionId !== top.session.id) {
        state.data.bindSessionId = top.session.id;
        state.save();
      }
      return top.agent;
    }
    return null;
  }
  function boundId() {
    return state.data.bindSessionId;
  }
  function boundInfo() {
    const id = boundId();
    if (!id) return null;
    const agent = agentsSvc()?.get(id);
    const session = sessionsSvc()?.get(id);
    return {
      sessionId: id,
      cwd: session?.header?.cwd ?? agent?.session?.header?.cwd ?? null,
      running: agent ? agent.status === "running" : null,
      attached: !!agent,
    };
  }

  function primaryChatId() {
    if (cfg.chatId) return cfg.chatId;
    if (cfg.ownerUid) return cfg.ownerUid;
    const users = Object.values(whitelist.data.users).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
    return users[0]?.uid ?? null;
  }

  function throttledSend(text) {
    const ts = now();
    if (ts - lastSendAt < 1200) return; // drop bursts; progress summaries are low-frequency
    lastSendAt = ts;
    const chatId = primaryChatId();
    if (chatId) sendMessage(chatId, text).catch(() => {});
  }

  // ── Telegram inbound ────────────────────────────────────────────────────
  async function handleMessage(message) {
    const from = message?.from;
    if (!from || from.is_bot) return;
    const chat = message?.chat;
    if (!chat || chat.type !== "private") return; // v1: private chats only
    const text = String(message.text ?? "").trim();
    if (!text) return;
    const uid = String(from.id);
    const entry = whitelist.data.users[uid];
    if (entry) {
      entry.lastSeenAt = now();
      whitelist.save();
    }
    const cmd = text.startsWith("/") ? text.split(/\s+/)[0] : null;
    if (cmd && PLUGIN_COMMANDS.has(cmd)) {
      await handleCommand(cmd, text, from, chat, entry);
      return;
    }
    if (!entry) {
      await sendMessage(chat.id, "🔐 你还没通过验证。请发送 /start 查看验证方式。");
      return;
    }
    if (!cmd) await forwardToAgent(uid, text, chat.id);
    else await handleCommand(cmd, text, from, chat, entry);
  }

  const PLUGIN_COMMANDS = new Set(["/start", "/verify", "/help", "/status", "/sessions", "/bind", "/unbind", "/on", "/off", "/cancel", "/newsession"]);

  async function doVerify(uid, codeArg, chatId, from) {
    const code = String(codeArg || "").trim();
    if (!/^\d{6}$/.test(code)) {
      await sendMessage(chatId, "❌ 格式错误：请发送 /verify 后跟 6 位验证码，例如 /verify 123456");
      return;
    }
    const lockUntil = state.data.lockouts[uid];
    if (lockUntil && lockUntil > now()) {
      const mins = Math.ceil((lockUntil - now()) / 60000);
      await sendMessage(chatId, `🔒 验证已锁定（失败次数过多），请 ${mins} 分钟后再试。`);
      return;
    }
    const secret = resolveSecret();
    if (!secret) {
      await sendMessage(chatId, "⚠️ 验证服务暂不可用（未配置 TOTP 密钥），请联系管理员。");
      return;
    }
    if (verifyTotp(secret, code)) {
      delete state.data.verifyFailures[uid];
      delete state.data.lockouts[uid];
      whitelist.data.users[uid] = {
        uid,
        username: from?.username ?? "",
        firstName: from?.first_name ?? "",
        verifiedAt: now(),
        lastSeenAt: now(),
      };
      whitelist.save();
      state.save();
      await sendMessage(chatId, "✅ 验证通过，你已加入白名单！之后无需再次验证。\n现在直接发消息就能和我对话。发送 /help 查看可用指令。");
      return;
    }
    const f = state.data.verifyFailures[uid] ?? { count: 0, lastAt: 0 };
    f.count += 1;
    f.lastAt = now();
    if (f.count >= cfg.maxFailures) {
      state.data.lockouts[uid] = now() + cfg.lockoutMs;
      delete state.data.verifyFailures[uid];
      state.save();
      await sendMessage(chatId, `❌ 验证码错误。已连续失败 ${cfg.maxFailures} 次，验证锁定 2 小时（如需立即恢复请联系管理员在面板解除）。`);
    } else {
      state.data.verifyFailures[uid] = f;
      state.save();
      await sendMessage(chatId, `❌ 验证码错误（第 ${f.count}/${cfg.maxFailures} 次）。`);
    }
  }

  async function forwardToAgent(uid, text, chatId) {
    const agent = resolveBound();
    if (!agent) {
      await sendMessage(chatId, "⚠️ 当前没有已激活的会话。可 /newsession 新建一个，或用 /sessions 查看、/bind 指定。");
      return;
    }
    const message = makeUserMessage(text, { telegramUid: uid });
    try {
      if (agent.status === "running") {
        if (cfg.interruptMode === "cancel") {
          agent.cancel({ kind: "user" }, { keepInbox: true });
          agent.followup(message);
          await sendMessage(chatId, "⏹ 已中断当前操作，开始处理你的新指示。");
        } else {
          // 静默注入（steer 软中断）：不发送「收到」确认，避免刷屏
          agent.steer(message);
        }
      } else {
        // 静默入队（followup）：不发送「收到」确认
        agent.followup(message);
      }
    } catch (error) {
      await sendMessage(chatId, `❌ 注入失败：${truncate(error?.message || error, 200)}`);
    }
  }

  function hardCancel(chatId) {
    const agent = resolveBound();
    if (!agent) {
      sendMessage(chatId, "⚠️ 当前没有可中断的会话。").catch(() => {});
      return;
    }
    if (agent.status !== "running") {
      sendMessage(chatId, "ℹ️ 当前没有正在进行的操作。").catch(() => {});
      return;
    }
    agent.cancel({ kind: "user" }, { keepInbox: true });
    sendMessage(chatId, "⏹ 已请求中断当前操作。").catch(() => {});
  }

  /** /newsession [path] — create a fresh agent+session (same preset/cwd model as the host) and bind it. */
  async function handleNewsession(arg, chatId) {
    try {
      const agents = ctx.get("agents");
      const presets = ctx.get("agentPresets");
      if (!agents || !presets) {
        await sendMessage(chatId, "⚠️ 会话创建服务当前不可用（agents/presets 未就绪）。");
        return;
      }
      const sessionId = `session-${randomUUID()}`;
      let cwd = String(arg || "").trim();
      if (cwd && !isAbsolute(cwd)) {
        await sendMessage(chatId, "⚠️ 参数应为绝对路径（或留空沿用当前工作目录）。例：/newsession D:/projects/foo");
        return;
      }
      const bound = resolveBound();
      cwd = cwd || bound?.session?.header?.cwd || process.cwd();
      let presetId = "standard";
      try { presetId = bound?.session?.header?.agentPreset || "standard"; } catch { /* ignore */ }
      const resolved = await presets.resolve(presetId);
      try { mkdirSync(cwd, { recursive: true }); } catch { /* dir may exist / be read-only; agent handles it */ }
      let agentOptions = {};
      try {
        const sel = ctx.get("agentDefaultModel")?.currentSelection?.();
        if (sel && sel.provider && sel.model) agentOptions = { provider: sel.provider, model: sel.model };
      } catch { /* empty options → agentLoop default model route */ }
      const { agent } = await agents.create({
        sessionId,
        agentOptions,
        meta: { cwd, agentPreset: resolved.id },
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, resolved.id);
        },
      });
      state.data.bindSessionId = sessionId;
      state.save();
      log(`/newsession created ${sessionId} (cwd=${cwd}, preset=${resolved.id})`);
      await sendMessage(chatId, `✅ 已创建并绑定新会话\n• ID：${sessionId}\n• 工作目录：${cwd}\n• 预设：${resolved.id}\n直接发消息即可开始（新会话从零开始）。`);
    } catch (error) {
      await sendMessage(chatId, `❌ 创建失败：${truncate(error?.message || String(error), 200)}`);
    }
  }

  function setEnabled(value) {
    state.data.enabled = !!value;
    if (!state.data.enabled) setStatus("disabled", null);
    state.save();
    if (state.data.enabled && token) startPolling();
    log(`polling ${state.data.enabled ? "enabled" : "disabled"}`);
  }

  async function handleCommand(cmd, fullText, from, chat, entry) {
    const uid = String(from.id);
    const arg = fullText.slice(cmd.length).trim();
    if (cmd === "/start") {
      await sendMessage(chat.id, [
        "🤖 你好，我是星澄（Hoshino Sumi）的 Telegram 桥接。",
        "",
        "首次使用需要验证：用你的身份验证器 App 生成 6 位动态码，发送：",
        "/verify 123456",
        "",
        "验证通过后，你在这里发的每条消息都会进入我的工作对话（运行中我会先读你的指示再继续）。",
      ].join("\n"));
      return;
    }
    if (cmd === "/verify") {
      await doVerify(uid, arg, chat.id, from);
      return;
    }
    if (!entry) {
      await sendMessage(chat.id, "🔐 未验证。请发送 /verify <6位TOTP码> 完成绑定。");
      return;
    }
    switch (cmd) {
      case "/help":
        await sendMessage(chat.id, [
          "📋 可用指令：",
          "/status — 是否正在执行任务/会话状态",
          "/newsession [路径] — 创建新会话并绑定（默认沿用当前工作目录）",
          "/sessions — 列出可绑定的会话",
          "/bind <会话ID> — 绑定到指定会话",
          "/unbind — 解除绑定（自动选最近活跃会话）",
          "/on / /off — 启用/停用桥接（等同 Web 面板开关）",
          "/cancel — 立即中断当前操作",
          "",
          "直接发消息 = 给我下达指示/对话（静默接收，不回复确认）。",
        ].join("\n"));
        break;
      case "/status": {
        const info = boundInfo();
        const users = Object.values(whitelist.data.users);
        const agent = resolveBound();
        const running = agent?.status === "running";
        await sendMessage(chat.id, [
          "📊 状态：",
          `• 任务执行：${running ? "🟢 正在执行" : "⚪ 空闲（等待你的指示）"}`,
          `• 绑定会话：${info ? info.sessionId : "未绑定"}（${info?.cwd ?? "?"}）`,
          `• 桥接：${state.data.enabled ? "✅ 启用" : "⛔ 停用"} / Telegram：${state.data.status}`,
          state.data.lastError ? `• 最近错误：${truncate(state.data.lastError, 150)}` : null,
          `• 白名单用户：${users.length} 人`,
        ].filter(Boolean).join("\n"));
        break;
      }
      case "/newsession": {
        await handleNewsession(arg, chat.id);
        break;
      }
      case "/sessions": {
        const tops = liveAgents().slice(0, 10);
        if (tops.length === 0) {
          await sendMessage(chat.id, "⚠️ 当前没有已激活的会话。请先在 Web 面板打开一个会话。");
          break;
        }
        const lines = tops.map((t, i) => `${i + 1}. ${t.session.id}\n   ↳ ${t.session.header?.cwd ?? "?"}（${t.agent.status === "running" ? "运行中" : "空闲"}）`);
        await sendMessage(chat.id, `🗂 活跃会话（可 /bind <会话ID>）：\n\n${lines.join("\n")}`);
        break;
      }
      case "/bind": {
        if (!arg) {
          await sendMessage(chat.id, "用法：/bind <会话ID>（用 /sessions 查看）");
          break;
        }
        const id = arg.split(/\s+/)[0];
        const agent = agentsSvc()?.get(id);
        if (!agent) {
          await sendMessage(chat.id, `❌ 会话 ${id} 不存在或未激活。用 /sessions 查看。`);
          break;
        }
        state.data.bindSessionId = id;
        state.save();
        await sendMessage(chat.id, `✅ 已绑定会话 ${id}（${agent.session?.header?.cwd ?? "?"}）。`);
        break;
      }
      case "/unbind":
        state.data.bindSessionId = null;
        state.save();
        await sendMessage(chat.id, "✅ 已解除绑定，将自动选择最近活跃会话。");
        break;
      case "/on":
        if (!token) {
          await sendMessage(chat.id, "⚠️ 未配置 bot token，无法启用。");
          break;
        }
        setEnabled(true);
        await sendMessage(chat.id, "✅ 桥接已启用。");
        break;
      case "/off":
        setEnabled(false);
        await sendMessage(chat.id, "⛔ 桥接已停用（不再轮询 Telegram；Web 面板可随时重新启用）。");
        break;
      case "/cancel":
        hardCancel(chat.id);
        break;
      default:
        await sendMessage(chat.id, "❓ 未知指令。发送 /help 查看可用指令。");
    }
  }

  // ── poll claim (single-poller lock across plugin instances) ─────────────
  // Hot reloads / duplicate instances leave multiple pollers that fight over
  // Telegram's one getUpdates slot (409). A file claim with heartbeat makes
  // every instance agree on ONE poller, no matter how many copies exist.
  const POLL_CLAIM_FILE = join(cfg.stateDir, "poll.lock");
  const POLL_CLAIM_STALE_MS = 90_000; // steal a claim older than this

  function readClaim() {
    try {
      if (existsSync(POLL_CLAIM_FILE)) {
        return JSON.parse(readFileSync(POLL_CLAIM_FILE, "utf8"));
      }
    } catch { /* corrupt/absent → treat as free */ }
    return null;
  }
  function writeClaim() {
    try {
      mkdirSync(cfg.stateDir, { recursive: true });
      writeFileSync(POLL_CLAIM_FILE, JSON.stringify({ owner: instanceId, ts: now() }), "utf8");
    } catch (error) {
      warn(`poll claim write failed: ${error?.message || error}`);
    }
  }
  function tryAcquireClaim() {
    const claim = readClaim();
    if (claim && claim.owner !== instanceId && typeof claim.ts === "number" && now() - claim.ts < POLL_CLAIM_STALE_MS) {
      return false; // another live instance owns the poller
    }
    writeClaim();
    return true;
  }

  // ── yield signal: let a NEWER instance take over polling without a restart ──
  // New instances write poll.yield ({ts, from}) at apply. The CURRENT claim
  // holder checks it on every cycle: a signal from someone else with a ts newer
  // than its own apply time means a newer instance wants to take over → it
  // releases the claim and exits. The newcomer's waiting loop then acquires the
  // freed claim within ~15s. All instances carrying this logic hot-swap cleanly.
  const POLL_YIELD_FILE = join(cfg.stateDir, "poll.yield");
  function writeYieldSignal() {
    try {
      mkdirSync(cfg.stateDir, { recursive: true });
      writeFileSync(POLL_YIELD_FILE, JSON.stringify({ ts: now(), from: instanceId }), "utf8");
    } catch { /* best-effort */ }
  }
  function readYieldSignal() {
    try {
      if (existsSync(POLL_YIELD_FILE)) {
        return JSON.parse(readFileSync(POLL_YIELD_FILE, "utf8"));
      }
    } catch { /* absent/corrupt */ }
    return null;
  }
  function clearYieldSignal() {
    try {
      if (existsSync(POLL_YIELD_FILE)) writeFileSync(POLL_YIELD_FILE, JSON.stringify({ ts: 0, from: "clear" }), "utf8");
    } catch { /* best-effort */ }
  }
  function shouldYield() {
    const signal = readYieldSignal();
    return !!signal && signal.from !== instanceId && typeof signal.ts === "number" && signal.ts > appliedAt;
  }
  function releaseClaim() {
    try {
      const claim = readClaim();
      if (claim && claim.owner === instanceId && existsSync(POLL_CLAIM_FILE)) {
        writeFileSync(POLL_CLAIM_FILE, JSON.stringify({ owner: "free", ts: 0 }), "utf8");
      }
    } catch { /* best-effort */ }
  }

  // ── polling loop (detached, non-blocking) ───────────────────────────────
  async function pollLoop() {
    if (pollRunning) return;
    pollRunning = true;
    let offset = Number(state.data.lastUpdateId ?? 0);
    try {
      while (!disposed && state.data.enabled && token) {
        // A newer instance asked us to step aside → release and exit (hot swap).
        if (shouldYield()) {
          releaseClaim();
          setStatus("waiting", "yielded polling to a newer instance");
          log("yielded polling to newer instance (hot reload handoff)");
          return;
        }
        if (!tryAcquireClaim()) {
          // Another instance owns polling (e.g. a reload left a stale copy).
          // Stand by, never touch Telegram.
          if (state.data.status !== "waiting") setStatus("waiting", "another tg-bot instance owns polling; standing by");
          await sleepAbortable(15000, pollAbort.signal);
          if (disposed) return;
          continue;
        }
        clearYieldSignal(); // we hold the claim now; silence any old signal
        pollAttempts += 1;
        lastPollAt = now();
        try {
          const updates = await tgApi("getUpdates", {
            offset: offset + 1,
            timeout: cfg.pollTimeoutSec,
            allowed_updates: ["message"],
          });
          backoff.ms = BACKOFF_BASE_MS;
          if (state.data.status !== "connected") setStatus("connected", null);
          if (Array.isArray(updates)) {
            for (const update of updates) {
              if (update?.update_id == null) continue;
              offset = Math.max(offset, update.update_id);
              if (update.message) {
                try {
                  await handleMessage(update.message);
                } catch (error) {
                  warn(`message handler error: ${error?.message || error}`);
                }
              }
            }
            if (state.data.lastUpdateId !== offset) {
              state.data.lastUpdateId = offset;
              state.save();
            }
          }
        } catch (error) {
          const msg = String(error?.message || error);
          let waitMs;
          if (msg.includes("401")) {
            setStatus("token-invalid", "bot token rejected by Telegram (401)", msg);
            waitMs = backoff.ms;
          } else if (msg.includes("409")) {
            // Another getUpdates poller is active (e.g. a previous instance
            // still draining, or an external poller). Do NOT call
            // deleteWebhook — that churns 409s and can self-sustain the
            // conflict. Wait LONGER than one server-side long-poll session
            // (pollTimeoutSec) so our own previous session expires first.
            setStatus("conflict", "another getUpdates poller is active; waiting and retrying", msg);
            waitMs = Math.max(10000, (cfg.pollTimeoutSec + 10) * 1000);
          } else {
            setStatus("disconnected", msg, msg);
            waitMs = backoff.ms;
          }
          await sleepAbortable(waitMs, pollAbort.signal);
          if (disposed) return;
          if (!msg.includes("409")) backoff.ms = Math.min(backoff.ms * 2, BACKOFF_MAX_MS);
        }
        writeClaim(); // heartbeat: proves liveness to other instances
      }
    } finally {
      pollRunning = false;
    }
  }

  function startPolling() {
    if (pollRunning) return;
    if (!state.data.enabled || !token) return;
    pollLoop().catch((error) => {
      warn(`poll loop crashed: ${error?.message || error}`);
      setStatus("disconnected", error?.message || String(error), error?.message || String(error));
      // Self-heal: restart the loop after a backoff beat unless disposed/disabled.
      if (!disposed && state.data.enabled && token) {
        pollTimer = setTimeout(() => {
          pollTimer = null;
          if (!disposed && state.data.enabled && token) startPolling();
        }, BACKOFF_MAX_MS);
      }
    });
  }

  // ── progress reporting ──────────────────────────────────────────────────
  function lastAssistantText(session) {
    const events = sessionEventsOf(session);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type === "turn/start") break;
      if (event.type === "assistant/message") {
        const blocks = event.data?.message?.content;
        if (Array.isArray(blocks)) {
          const text = blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n").trim();
          if (text) return text;
        }
      }
    }
    return null;
  }

  const subscriptions = [];
  /** Only the poll-claim owner may push to Telegram (single-writer across instances). */
  const ownsPollClaim = () => {
    const claim = readClaim();
    return !!claim && claim.owner === instanceId;
  };
  if (cfg.autoReport) {
    subscriptions.push(ctx.on("session/event", (session, event) => {
      if (disposed || !state.data.enabled) return;
      if (!ownsPollClaim()) return; // 非持锁实例不推送，防多实例重复
      if (session.id !== boundId()) return;
      if (event.type === "turn/start") {
        if (cfg.reportTurnStart) throttledSend(`▶️ 开始第 ${event.data?.turn ?? "?"} 轮…`);
      } else if (event.type === "turn/end") {
        const reason = event.data?.reason;
        const kind = reason?.kind ?? "?";
        if (kind === "error") return; // agent/error reports it
        if (kind === "aborted" || kind === "blocked") {
          throttledSend(kind === "aborted" ? "⏹️ 操作已中断。" : "⏸️ 操作被阻塞。");
          return;
        }
        const reply = cfg.echoReplies ? lastAssistantText(session) : null;
        if (reply) {
          // 完整回复分段发送：sendMessage 内部按 MAX_MSG_LEN(4000)/段拆分并带
          // （i/N）后缀，不再截断指向 Web 面板；不走 throttledSend（其 1200ms
          // burst-drop 会丢掉后续分段）。
          const chatId = primaryChatId();
          if (chatId) sendMessage(chatId, reply).catch(() => {});
        } else {
          throttledSend(`✅ 第 ${event.data?.turn ?? "?"} 轮完成。`);
        }
      }
    }));
    subscriptions.push(ctx.on("agent/status", ({ agent, status }) => {
      if (disposed || !state.data.enabled) return;
      if (!ownsPollClaim()) return;
      if (agent.id !== boundId()) return;
      if (status === "running" && cfg.reportTurnStart) throttledSend("▶️ 开始处理…");
    }));
    subscriptions.push(ctx.on("agent/error", ({ agent, error }) => {
      if (disposed || !state.data.enabled) return;
      if (!ownsPollClaim()) return;
      if (agent.id !== boundId()) return;
      throttledSend(`❌ 出错：${truncate(error instanceof Error ? error.message : String(error), 300)}`);
    }));
  }

  // ── wake.json 消费（通用唤醒通道：外部脚本事件 → 星澄回合）───────────────
  // 外部脚本（wake/ 目录的 scheduler.mjs、wake-util.mjs、Python 下载器等）
  // 写 wake.json { v, eventId, text, source, payload, meta, ts, processed }。
  // 插件轮询消费：标记 processed 并把 text 注入绑定会话 —— running 用 steer
  // （软中断，下一动作前读到），idle 用 followup（入队为下一回合）。
  //
  // ⚠️ v16 修复（2026-08-17 实测踩坑）：注入必须用 makeUserMessage() 构造
  // UserMessage 对象再传 steer/followup —— 直接传字符串会触发 harness 内部
  // `Cannot read properties of undefined (reading 'kind')`（回合被 error 切断，
  // 见 05-断点恢复说明.md §v16）。用户消息路径一直传对象所以从未崩过。
  let wakeTimer = null;
  async function processWakeSignal() {
    if (disposed || !state.data.enabled) return;
    // 只有持锁实例消费，防多实例重复注入
    if (!ownsPollClaim()) return;
    let wake;
    try {
      if (!existsSync(WAKE_FILE)) return;
      wake = JSON.parse(readFileSync(WAKE_FILE, "utf8"));
    } catch { return; }
    // 跳过墓碑（clearWake 删除失败时留下的占位）与已处理信号
    if (!wake || wake.processed || wake.tombstone) return;
    const body = String(wake.text ?? "").trim();
    if (!body) {
      // 空指令：标记 processed 防重复消费，不注入
      wake.processed = true;
      wake.processedAt = now();
      try { writeFileSync(WAKE_FILE, JSON.stringify(wake, null, 2), "utf8"); } catch { /* ignore */ }
      return;
    }
    const agent = resolveBound();
    if (!agent) {
      log("wake: no bound agent yet, will retry next tick");
      return; // 无会话可注入 → 不标 processed，等 scheduler 兜底
    }
    const payloadLine = wake.payload ? `\n📎 上下文文件：${wake.payload}` : "";
    const text = `🔔 唤醒请求（来源 ${wake.source || "unknown"}）：${body}${payloadLine}`;
    // UserMessage 对象注入（与用户消息路径一致），source 保留 kind:"user"/via:"telegram"
    const message = makeUserMessage(text, { wakeEventId: wake.eventId, wakeSource: wake.source });
    try {
      if (agent.status === "running") agent.steer(message);
      else agent.followup(message);
    } catch (error) {
      warn(`wake inject failed: ${error?.message || error}`);
      return;
    }
    wake.processed = true;
    wake.processedAt = now();
    try { writeFileSync(WAKE_FILE, JSON.stringify(wake, null, 2), "utf8"); } catch { /* ignore */ }
    log(`wake consumed ${wake.eventId || "?"} (${wake.source}) -> ${truncate(wake.text, 60)}`);
  }
  function startWakePolling() {
    if (wakeTimer) return;
    processWakeSignal();
    wakeTimer = setInterval(processWakeSignal, cfg.wakePollSec * 1000);
  }

  // ── tg_send tool (best-effort; lets the model push messages proactively) ─
  const toolDiag = { state: "not-run", toolsService: !!ctx.get("tools"), globalVisible: false, error: null, at: now() };
  function registerSendTool() {
    toolDiag.state = "started";
    toolDiag.toolsService = !!ctx.get("tools");
    try {
      if (ctx.get("tools") === void 0) {
        toolDiag.state = "skipped-no-tools-service";
        return;
      }
      import("@deepseek-ai/dsh-tools")
        .then(({ defineTool }) => {
          if (disposed) return;
          try {
            ctx.tools.register(defineTool({
              name: "tg_send",
              description: "Push a message to the owner's Telegram chat through the dsh-tg-bot bridge. Use it to report progress, ask for confirmation, or notify the user — e.g. when a long task finishes or a decision is needed.",
              parameters: {
                text: { type: "string", required: true, description: "Message text to send (plain text; no markdown needed)." },
              },
              output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
              },
              async execute(args) {
                const text = String(args?.text ?? "").trim();
                if (!text) throw new Error("tg_send: text is required");
                if (!token) throw new Error("tg_send: bot token not configured");
                const chatId = primaryChatId();
                if (!chatId) throw new Error("tg_send: no whitelisted chat yet — the owner must run /verify on Telegram first");
                const sent = await sendMessage(chatId, text);
                if (!sent) throw new Error("tg_send: Telegram send failed (see plugin status)");
                return { sent: true, chars: text.length };
              },
            }));
            toolDiag.state = "registered";
            try {
              const view = ctx.tools.view(void 0);
              toolDiag.globalVisible = view.visible.has("tg_send");
              toolDiag.globalToolCount = view.visible.size;
            } catch (e) {
              toolDiag.globalCheckError = String(e?.message || e);
            }
            log("tg_send tool registered");
          } catch (error) {
            toolDiag.state = "register-error";
            toolDiag.error = String(error?.message || error);
            warn(`tg_send tool registration failed: ${error?.message || error}`);
          }
        })
        .catch((error) => {
          toolDiag.state = "import-error";
          toolDiag.error = String(error?.message || error);
          warn(`tg_send tool import skipped (${error?.message || error})`);
        });
    } catch (error) {
      toolDiag.state = "sync-error";
      toolDiag.error = String(error?.message || error);
      warn(`tg_send tool skipped (${error?.message || error})`);
    }
  }

  // ── web panel (behind the web-auth guard) ───────────────────────────────
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }
  function sendHtml(res, html) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }

  function statusPayload() {
    const users = Object.values(whitelist.data.users).map((u) => ({
      uid: u.uid,
      username: u.username,
      firstName: u.firstName,
      verifiedAt: u.verifiedAt,
      lastSeenAt: u.lastSeenAt,
    }));
    return {
      ok: true,
      plugin: "dsh-tg-bot",
      version: 1,
      instanceId,
      enabled: state.data.enabled,
      tokenConfigured: !!token,
      status: state.data.status,
      lastError: state.data.lastError,
      lastErrorRaw: state.data.lastErrorRaw ?? null,
      pollRunning,
      pollAttempts,
      lastPollAt,
      toolDiag,
      proxy: cfg.proxy,
      verifySecretMode: cfg.verifySecretMode,
      secretReady: cfg.verifySecretMode === "shared" ? existsSync(cfg.webAuthStateFile) : !!state.data.secret,
      maxFailures: cfg.maxFailures,
      lockoutMs: cfg.lockoutMs,
      interruptMode: cfg.interruptMode,
      autoReport: cfg.autoReport,
      echoReplies: cfg.echoReplies,
      bound: boundInfo(),
      sessions: liveAgents().slice(0, 20).map((t) => ({
        sessionId: t.session.id,
        cwd: t.session.header?.cwd ?? null,
        running: t.agent.status === "running",
        lastTime: t.lastTime,
      })),
      whitelist: users,
      lockouts: state.data.lockouts,
      verifyFailures: state.data.verifyFailures,
      now: now(),
    };
  }

  const routes = {
    [`GET ${cfg.panelPath}`]: async (req, res) => {
      sendHtml(res, panelHtml(cfg.panelPath));
    },
    [`GET ${cfg.panelPath}/api/status`]: async (req, res) => {
      sendJson(res, 200, statusPayload());
    },
    [`POST ${cfg.panelPath}/api/toggle`]: async (req, res) => {
      let body = {};
      try {
        body = JSON.parse(await readBody(req) || "{}");
      } catch { /* malformed body */ }
      const value = body.enabled === true;
      setEnabled(value);
      sendJson(res, 200, { ok: true, enabled: state.data.enabled });
    },
    [`POST ${cfg.panelPath}/api/bind`]: async (req, res) => {
      let body = {};
      try {
        body = JSON.parse(await readBody(req) || "{}");
      } catch { /* malformed body */ }
      const id = String(body.sessionId ?? "").trim();
      if (id === "") {
        state.data.bindSessionId = null;
        state.save();
        return sendJson(res, 200, { ok: true, bound: null });
      }
      const agent = agentsSvc()?.get(id);
      if (!agent) return sendJson(res, 400, { ok: false, error: `session ${id} not active` });
      state.data.bindSessionId = id;
      state.save();
      sendJson(res, 200, { ok: true, bound: boundInfo() });
    },
    [`POST ${cfg.panelPath}/api/revoke`]: async (req, res) => {
      let body = {};
      try {
        body = JSON.parse(await readBody(req) || "{}");
      } catch { /* malformed body */ }
      const uid = String(body.uid ?? "").trim();
      if (!uid) return sendJson(res, 400, { ok: false, error: "uid required" });
      delete whitelist.data.users[uid];
      whitelist.save();
      sendJson(res, 200, { ok: true });
    },
    [`POST ${cfg.panelPath}/api/reset-lockouts`]: async (req, res) => {
      state.data.lockouts = {};
      state.data.verifyFailures = {};
      state.save();
      sendJson(res, 200, { ok: true });
    },
  };

  for (const [routeKey, handler] of Object.entries(routes)) {
    const [method, path] = routeKey.split(" ");
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path, handler }), `tg-bot: ${method} ${path}`);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  ctx.on("dispose", () => {
    disposed = true;
    try { pollAbort.abort(); } catch { /* ignore */ }
    // Release the poll claim if this instance owns it, so a successor
    // (post-reload instance) can take over polling immediately.
    try {
      const claim = readClaim();
      if (claim && claim.owner === instanceId && existsSync(POLL_CLAIM_FILE)) {
        writeFileSync(POLL_CLAIM_FILE, JSON.stringify({ owner: "free", ts: 0 }), "utf8");
      }
    } catch { /* ignore */ }
    if (pollTimer) clearTimeout(pollTimer);
    if (wakeTimer) clearInterval(wakeTimer);
    for (const dispose of subscriptions) {
      try { dispose(); } catch { /* ignore */ }
    }
  });

  // ── startup ─────────────────────────────────────────────────────────────
  log(`plugin loaded (enabled=${state.data.enabled}, token=${token ? "yes" : "no"}, proxy=${cfg.proxy ?? "direct"}, verify=${cfg.verifySecretMode}, interrupt=${cfg.interruptMode})`);
  registerSendTool();
  startWakePolling(); // 通用唤醒通道常开：enabled=false 时 processWakeSignal 自行短路
  if (state.data.enabled && token) {
    // Announce to any older claim-holding instance: step aside so the NEWEST
    // code takes over polling (hot reload without a restart).
    writeYieldSignal();
    setTimeout(() => {
      if (disposed) return;
      const bound = resolveBound();
      if (bound) log(`auto-bound to session ${bound.id}`);
      startPolling();
    }, 500);
  } else if (!token) {
    setStatus("no-token", "bot token not configured");
    warn("no bot token configured — set config.token, env DSH_TG_BOT_TOKEN, or tokenFile");
  } else {
    setStatus("disabled", null);
  }
}

function readToken(cfg) {
  if (cfg.token) return String(cfg.token);
  if (process.env.DSH_TG_BOT_TOKEN) return process.env.DSH_TG_BOT_TOKEN;
  try {
    if (cfg.tokenFile && existsSync(cfg.tokenFile)) {
      const t = readFileSync(cfg.tokenFile, "utf8").trim();
      if (t) return t;
    }
  } catch { /* ignore */ }
  return null;
}

// ── panel HTML (self-contained, no framework) ─────────────────────────────
function panelHtml(panelPath) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TG 桥接 · dsh-tg-bot</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b93a7; font-size: 13px; margin-bottom: 20px; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 12px; color: #9fb2d9; text-transform: uppercase; letter-spacing: .05em; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed #232936; }
  .row:last-child { border-bottom: none; }
  .label { color: #8b93a7; font-size: 13px; }
  .val { font-family: ui-monospace, Consolas, monospace; font-size: 13px; word-break: break-all; text-align: right; }
  .ok { color: #4ade80; } .bad { color: #f87171; } .warn { color: #fbbf24; } .muted { color: #64748b; }
  button { background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
  button.off { background: #dc2626; } button.ghost { background: #2a3040; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  input, select { background: #0f1115; color: #e6e6e6; border: 1px solid #2a3040; border-radius: 6px; padding: 7px 10px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #232936; }
  th { color: #8b93a7; font-weight: 500; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1c2536; border: 1px solid #3b4a63; padding: 10px 18px; border-radius: 8px; font-size: 13px; display: none; }
  .flex { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
</head>
<body>
<h1>🤖 dsh-tg-bot · Telegram 桥接</h1>
<div class="sub">随 harness 启动 · 断连不阻塞 · TOTP 白名单验证 · 手动开关</div>

<div class="card">
  <h2>运行状态</h2>
  <div class="row"><span class="label">桥接开关</span><span class="val"><span id="enabled">…</span></span></div>
  <div class="row"><span class="label">Telegram 连接</span><span class="val" id="status">…</span></div>
  <div class="row"><span class="label">最近错误</span><span class="val muted" id="lastError">—</span></div>
  <div class="row"><span class="label">Token</span><span class="val" id="token">…</span></div>
  <div class="row"><span class="label">代理</span><span class="val" id="proxy">…</span></div>
  <div class="row"><span class="label">验证模式 / 锁定策略</span><span class="val" id="verify">…</span></div>
  <div class="row"><span class="label">中断模式 / 汇报</span><span class="val" id="mode">…</span></div>
  <div class="flex" style="margin-top:14px">
    <button id="toggleBtn">…</button>
    <button class="ghost" onclick="refresh()">刷新</button>
  </div>
</div>

<div class="card">
  <h2>绑定会话</h2>
  <div class="row"><span class="label">当前绑定</span><span class="val" id="bound">…</span></div>
  <div class="flex" style="margin-top:10px">
    <select id="sessionSelect" style="flex:1; min-width:200px"></select>
    <button class="ghost" onclick="doBind()">绑定</button>
    <button class="ghost" onclick="doUnbind()">自动</button>
  </div>
</div>

<div class="card">
  <h2>白名单（uid + username，验证通过后免验证）</h2>
  <table><thead><tr><th>uid</th><th>username</th><th>名称</th><th>验证时间</th><th></th></tr></thead>
  <tbody id="wlBody"><tr><td colspan="5" class="muted">加载中…</td></tr></tbody></table>
</div>

<div class="card">
  <h2>验证锁定 / 失败计数（N 次失败锁 2 小时）</h2>
  <div id="lockouts" class="muted">无</div>
  <button class="ghost" style="margin-top:10px" onclick="resetLockouts()">清除全部锁定</button>
</div>

<div class="toast" id="toast"></div>

<script>
const API = ${JSON.stringify(panelPath)};
let state = null;
function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.style.display = "block"; setTimeout(() => t.style.display = "none", 2500); }
async function api(path, opts) {
  const res = await fetch(API + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
function fmtTime(ts) { if (!ts) return "—"; return new Date(ts).toLocaleString(); }
function lockLeft(until) { const ms = until - Date.now(); if (ms <= 0) return "已过期"; const m = Math.floor(ms / 60000); return m >= 60 ? Math.floor(m / 60) + " 小时 " + (m % 60) + " 分" : m + " 分钟"; }
async function refresh() {
  try {
    state = await api("/api/status");
    const s = state;
    document.getElementById("enabled").innerHTML = s.enabled ? '<span class="ok">✅ 启用</span>' : '<span class="bad">⛔ 停用</span>';
    const stEl = document.getElementById("status");
    const stMap = { connected: ["✅ 已连接", "ok"], disconnected: ["⚠️ 断开（重试中）", "warn"], "no-token": ["❌ 未配置 Token", "bad"], "token-invalid": ["❌ Token 无效", "bad"], conflict: ["⚠️ 轮询冲突", "warn"], waiting: ["⏳ 等待轮询权（另一实例在跑）", "warn"], disabled: ["⏸ 已停用", "muted"], idle: ["… 启动中", "muted"] };
    const [txt, cls] = stMap[s.status] || [s.status, "muted"];
    stEl.innerHTML = '<span class="' + cls + '">' + txt + '</span>';
    document.getElementById("lastError").textContent = s.lastError || "—";
    document.getElementById("token").innerHTML = s.tokenConfigured ? '<span class="ok">已配置</span>' : '<span class="bad">未配置</span>';
    document.getElementById("proxy").textContent = s.proxy || "直连";
    document.getElementById("verify").textContent = (s.verifySecretMode === "shared" ? "复用 Web TOTP" : "独立 TOTP") + " · 失败 " + s.maxFailures + " 次锁 " + Math.round(s.lockoutMs / 3600000) + "h" + (s.secretReady ? "" : "（⚠️ 密钥不可用）");
    document.getElementById("mode").textContent = (s.interruptMode === "steer" ? "软中断" : "硬中断") + " · 自动汇报" + (s.echoReplies ? "+回复回传" : "") + (s.autoReport ? "" : "（关）");
    const b = s.bound;
    document.getElementById("bound").textContent = b ? b.sessionId + "（" + (b.cwd || "?") + "，" + (b.running ? "运行中" : "空闲") + "）" : "未绑定（自动选最近活跃）";
    const sel = document.getElementById("sessionSelect");
    sel.innerHTML = s.sessions.map(x => '<option value="' + esc(x.sessionId) + '">' + esc(x.sessionId) + " · " + esc(x.cwd || "?") + (x.running ? " · RUN" : "") + "</option>").join("") || '<option value="">（无活跃会话）</option>';
    const tb = document.getElementById("wlBody");
    if (s.whitelist.length === 0) tb.innerHTML = '<tr><td colspan="5" class="muted">空 — 在 Telegram 发送 /verify &lt;6位码&gt; 完成首次验证</td></tr>';
    else tb.innerHTML = s.whitelist.map(u => "<tr><td>" + esc(u.uid) + '</td><td>@' + esc(u.username || "—") + "</td><td>" + esc(u.firstName || "—") + "</td><td>" + fmtTime(u.verifiedAt) + '</td><td><button class="ghost" onclick="revoke(\'' + esc(u.uid) + '\')">吊销</button></td></tr>').join("");
    const lo = document.getElementById("lockouts");
    const lockEntries = Object.entries(s.lockouts || {});
    const failEntries = Object.entries(s.verifyFailures || {});
    if (lockEntries.length === 0 && failEntries.length === 0) lo.textContent = "无";
    else {
      lo.innerHTML = "";
      lockEntries.forEach(([uid, until]) => { const div = document.createElement("div"); div.className = "row"; div.innerHTML = '<span class="label">🔒 ' + esc(uid) + '</span><span class="val bad">' + lockLeft(until) + '</span>'; lo.appendChild(div); });
      failEntries.forEach(([uid, f]) => { const div = document.createElement("div"); div.className = "row"; div.innerHTML = '<span class="label">' + esc(uid) + " 失败计数</span><span class='val warn'>" + f.count + "/" + s.maxFailures + "</span>"; lo.appendChild(div); });
    }
    const btn = document.getElementById("toggleBtn");
    btn.textContent = s.enabled ? "⛔ 停用桥接" : "✅ 启用桥接";
    btn.className = s.enabled ? "off" : "";
    btn.onclick = () => api("/api/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) }).then(() => { toast("已切换"); refresh(); }).catch(e => toast(e.message));
  } catch (e) {
    document.getElementById("status").textContent = "加载失败：" + e.message;
  }
}
async function doBind() {
  const v = document.getElementById("sessionSelect").value;
  if (!v) return toast("没有可选会话");
  try { await api("/api/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: v }) }); toast("已绑定"); refresh(); } catch (e) { toast(e.message); }
}
async function doUnbind() { try { await api("/api/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "" }) }); toast("已切换为自动"); refresh(); } catch (e) { toast(e.message); } }
async function revoke(uid) { try { await api("/api/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid }) }); toast("已吊销"); refresh(); } catch (e) { toast(e.message); } }
async function resetLockouts() { try { await api("/api/reset-lockouts", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); toast("已清除锁定"); refresh(); } catch (e) { toast(e.message); } }
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
