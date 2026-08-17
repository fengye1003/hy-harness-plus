#!/usr/bin/env node
// ============================================================================
// 星澄定时任务调度器 (scheduler.mjs) — 零依赖 · 独立 CLI
//
// 定时触发器：到期时调用通用唤醒通道（wake-util.mjs）唤醒星澄；若 harness
// 未运行（插件无法消费 wake.json），10 分钟后兜底直发 Telegram。
//
// 用法：
//   node scheduler.mjs add "3h" "提醒我喝水" [--open-terminal] [--no-tg-fallback]
//   node scheduler.mjs add --at "21:00" "今晚提醒" [--open-terminal]
//   node scheduler.mjs add --at "2026-08-18 09:00" "明早提醒" [--open-terminal]
//   node scheduler.mjs list / status / cancel <id> / clear-done
//   node scheduler.mjs check        ← Windows 计划任务每分钟调用（幂等）
//
// 数据：tasks.json（本目录）+ wake.json（wake-util.mjs 维护）
// ============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { homedir } from "node:os";
import { wake as sendWake, readWake, clearWake, WAKE_FILE } from "./wake-util.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = join(DIR, "tasks.json");
const PROXY = process.env.DSH_TG_PROXY || "http://127.0.0.1:7897"; // 默认本地混合代理端口；可用 DSH_TG_PROXY 覆盖（空字符串 = 直连）
const WAKE_TIMEOUT_MS = 10 * 60 * 1000; // 等待插件消费的超时（超时 → 兜底直发 TG）
const DEFAULT_OWNER_UID = process.env.DSH_TG_OWNER_UID || ""; // 兜底直发目标 uid；建议通过环境变量 DSH_TG_OWNER_UID 配置

// ── JSON store ─────────────────────────────────────────────────────────────
function loadJson(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) { console.error(`⚠️ 读取 ${file} 失败（${e.message}），按空数据继续`); }
  return fallback;
}
function saveJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function loadTasks() {
  const store = loadJson(TASKS_FILE, { version: 1, tasks: [] });
  if (!Array.isArray(store.tasks)) store.tasks = [];
  return store;
}
function saveTasks(store) { saveJson(TASKS_FILE, store); }

// ── 时间解析 ───────────────────────────────────────────────────────────────
function parseDelay(s) {
  const m = /^(\d+)(s|m|h|d)$/i.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = n * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
function parseWhen(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{1,2}:\d{2}$/.test(s)) { // HH:MM → 今天，已过则明天
    const [h, mi] = s.split(":").map(Number);
    const d = new Date();
    d.setHours(h, mi, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(s)) { // YYYY-MM-DD HH:MM
    const d = new Date(s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

// ── Telegram 兜底直发（走 7897 代理；实现与 dsh-tg-bot 插件一致）───────────
function createProxyTunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(proxyUrl); } catch (e) { reject(e); return; }
    const req = httpRequest({
      host: u.hostname, port: u.port ? Number(u.port) : 7897,
      method: "CONNECT", path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      ...(u.username ? { auth: `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` } : {}),
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("proxy CONNECT timeout")));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`)); return; }
      socket.setTimeout(0);
      resolve(socket);
    });
    req.on("error", reject);
    req.end();
  });
}
function wrapTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, servername: host });
    const timer = setTimeout(() => tlsSocket.destroy(new Error("TLS handshake timeout")), timeoutMs);
    tlsSocket.once("secureConnect", () => { clearTimeout(timer); resolve(tlsSocket); });
    tlsSocket.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function tgRequest(urlStr, { method = "POST", headers = {}, body, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const doRequest = (createConnection) => {
      const req = httpsRequest({
        host: u.hostname, port: Number(u.port || 443), path: u.pathname + u.search, method,
        headers: { ...headers, "content-length": Buffer.byteLength(body ?? "") },
        ...(createConnection ? { createConnection } : {}),
      });
      const deadline = setTimeout(() => req.destroy(new Error("request deadline exceeded")), timeoutMs + 5000);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
      req.on("response", (res) => {
        clearTimeout(deadline);
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
          catch { reject(new Error(`telegram returned non-JSON (HTTP ${res.statusCode})`)); }
        });
        res.on("error", reject);
      });
      req.on("error", (e) => { clearTimeout(deadline); reject(e); });
      if (body) req.write(body);
      req.end();
    };
    createProxyTunnel(PROXY, u.hostname, Number(u.port || 443), timeoutMs)
      .then((socket) => wrapTls(socket, u.hostname, timeoutMs))
      .then((tlsSocket) => doRequest(() => tlsSocket))
      .catch(reject);
  });
}
function readToken() {
  const candidates = [join(homedir(), ".dsh", "tg-bot", "token.txt"), process.env.DSH_TG_BOT_TOKEN];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const t = readFileSync(c, "utf8").trim();
      if (t) return t;
    } catch { /* ignore */ }
  }
  return null;
}
function readPrimaryChatId() {
  try {
    const wl = loadJson(join(homedir(), ".dsh", "tg-bot", "whitelist.json"), null);
    if (wl?.users) {
      const users = Object.values(wl.users).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
      if (users[0]?.uid) return String(users[0].uid);
    }
  } catch { /* ignore */ }
  return DEFAULT_OWNER_UID;
}
async function fallbackTg(text) {
  const token = readToken();
  if (!token) return { ok: false, error: "no bot token" };
  const chatId = readPrimaryChatId();
  if (!chatId) return { ok: false, error: "no chat id (run /verify on Telegram first, or set DSH_TG_OWNER_UID)" };
  try {
    const { status, json } = await tgRequest(`https://api.telegram.org/bot${token}/sendMessage`, {
      body: JSON.stringify({ chat_id: chatId, text }),
      headers: { "content-type": "application/json" },
    });
    return { ok: status === 200 && json?.ok === true, status, json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 打开终端（Windows）────────────────────────────────────────────────────
function openTerminal() {
  return new Promise((resolve) => {
    const attempts = [
      ["wt.exe", []], // Windows Terminal
      ["powershell.exe", ["-NoExit", "-Command", "Write-Host '⏰ 定时任务到点，终端已为你打开（星澄自动）' -ForegroundColor Cyan"]],
    ];
    let i = 0;
    const next = () => {
      if (i >= attempts.length) { resolve({ ok: false, error: "all terminal launches failed" }); return; }
      const [cmd, args] = attempts[i++];
      let settled = false;
      try {
        const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: false });
        child.on("error", () => { if (!settled) { settled = true; next(); } });
        child.unref();
        setTimeout(() => { if (!settled) { settled = true; resolve({ ok: true, cmd }); } }, 500);
      } catch {
        if (!settled) { settled = true; next(); }
      }
    };
    next();
  });
}

// ── CLI 命令 ───────────────────────────────────────────────────────────────
function newId() { return "t" + Date.now().toString(36) + randomBytes(2).toString("hex"); }

function cmdAdd(args) {
  const openTerm = args.includes("--open-terminal");
  const noFallback = args.includes("--no-tg-fallback");
  const rest = args.filter((a) => !a.startsWith("--"));
  if (rest.length < 2) {
    console.error("用法：node scheduler.mjs add \"3h\" \"提醒文本\" [--open-terminal]");
    console.error("      node scheduler.mjs add --at \"21:00\" \"提醒文本\" [--open-terminal]");
    process.exit(2);
  }
  const atIdx = args.indexOf("--at");
  let due;
  if (atIdx !== -1 && args[atIdx + 1]) {
    due = parseWhen(args[atIdx + 1]);
    if (!due) { console.error("❌ 无法解析 --at 时间：" + args[atIdx + 1]); process.exit(2); }
  } else {
    const ms = parseDelay(rest[0]);
    if (!ms) { console.error("❌ 无法解析延迟：" + rest[0] + "（支持 30s/5m/3h/2d）"); process.exit(2); }
    due = new Date(Date.now() + ms);
  }
  const text = rest[1];
  const actions = [];
  if (openTerm) actions.push("open-terminal");
  if (!noFallback) actions.push("tg-fallback");
  const task = {
    id: newId(), text, actions,
    dueAt: due.getTime(), createdAt: Date.now(),
    state: "pending", // pending | done | cancelled
    wakeEventId: null, wakeWrittenAt: null,
    terminalOpened: false, fallbackSent: false, doneAt: null,
  };
  const store = loadTasks();
  store.tasks.push(task);
  saveTasks(store);
  console.log(`✅ 已预约定时任务`);
  console.log(`   任务 ID ：${task.id}`);
  console.log(`   提醒内容：${text}`);
  console.log(`   触发时间：${due.toLocaleString("zh-CN")}（${Math.max(0, Math.round((due - Date.now()) / 1000))} 秒后）`);
  console.log(`   动作    ：${actions.length ? actions.join("、") : "（仅唤醒星澄）"}`);
  return task;
}

function cmdList() {
  const store = loadTasks();
  if (!store.tasks.length) { console.log("（暂无任务）"); return; }
  const now = Date.now();
  store.tasks.sort((a, b) => a.dueAt - b.dueAt);
  for (const t of store.tasks) {
    const left = t.dueAt - now;
    const timeStr = left > 0 ? `剩余 ${Math.floor(left / 60000)}m ${Math.floor((left % 60000) / 1000)}s` : "已到期";
    console.log(`[${t.state === "pending" ? "⏳" : t.state === "done" ? "✅" : "⛔"}] ${t.id}  ${timeStr}  ${t.text}${t.actions.length ? "  （" + t.actions.join("、") + "）" : ""}`);
  }
}

function cmdCancel(id) {
  const store = loadTasks();
  const t = store.tasks.find((x) => x.id === id);
  if (!t) { console.error(`❌ 未找到任务 ${id}`); process.exit(1); }
  if (t.state !== "pending") { console.error(`⚠️ 任务 ${id} 已 ${t.state}，无需取消`); return; }
  t.state = "cancelled";
  saveTasks(store);
  console.log(`⛔ 已取消任务 ${id}（${t.text}）`);
}

function cmdClearDone() {
  const store = loadTasks();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => t.state !== "done");
  saveTasks(store);
  console.log(`🧹 已清理 ${before - store.tasks.length} 个已完成任务`);
}

function cmdStatus() {
  const store = loadTasks();
  const pending = store.tasks.filter((t) => t.state === "pending");
  const wake = readWake();
  console.log(`任务总数：${store.tasks.length}（待执行 ${pending.length}）`);
  for (const t of pending) {
    const past = t.dueAt <= Date.now();
    console.log(`  ${past ? "⚡ 已到期" : "⏳"} ${t.id} ${t.text}（${new Date(t.dueAt).toLocaleString("zh-CN")}）${t.wakeEventId ? "· 唤醒已发" : ""}${t.fallbackSent ? "· 兜底已发" : ""}`);
  }
  console.log(`唤醒信号：${wake ? `eventId=${wake.eventId} processed=${wake.processed}${wake.processedAt ? " @" + new Date(wake.processedAt).toLocaleString("zh-CN") : ""}` : "无"}`);
}

// ── check：核心到期处理（幂等，Windows 计划任务每分钟调用）────────────────
async function cmdCheck() {
  const store = loadTasks();
  const now = Date.now();
  const due = store.tasks.filter((t) => t.state === "pending" && t.dueAt <= now);
  let changed = false;

  for (const task of due) {
    // ① 打开终端（一次性）
    if (task.actions.includes("open-terminal") && !task.terminalOpened) {
      const r = await openTerminal();
      task.terminalOpened = true;
      changed = true;
      console.log(`🖥  [${task.id}] 打开终端：${r.ok ? "OK（" + r.cmd + "）" : "失败 - " + r.error}`);
    }

    const wake = readWake();

    // ② 星澄已接手（插件消费该事件的唤醒信号）→ 任务完成
    if (task.wakeEventId && wake && wake.eventId === task.wakeEventId && wake.processed) {
      task.state = "done";
      task.doneAt = now;
      changed = true;
      console.log(`🤖 [${task.id}] 唤醒已由星澄接管（processed）→ 任务完成`);
      continue;
    }

    // ③ 首次到期：通过通用唤醒通道发信号
    if (!task.wakeEventId) {
      const r = sendWake(task.text, { source: "scheduler", meta: { taskId: task.id, actions: task.actions } });
      if (r.ok) {
        task.wakeEventId = r.eventId;
        task.wakeWrittenAt = now;
        changed = true;
        console.log(`⏰ [${task.id}] 唤醒信号已写（${r.eventId}），等待星澄接管（${task.text}）`);
      } else {
        console.error(`❌ [${task.id}] 唤醒信号写入失败：${r.error}`);
      }
    } else if (now - task.wakeWrittenAt > WAKE_TIMEOUT_MS && !task.fallbackSent) {
      // ④ 超时兜底：插件没消费（harness 未运行）→ 直发 TG
      const msg = `⏰ 定时提醒（星澄自动兜底，harness 未响应）：${task.text}`;
      const r = await fallbackTg(msg);
      task.fallbackSent = true;
      task.state = "done";
      task.doneAt = now;
      changed = true;
      console.log(`📡 [${task.id}] 兜底直发 TG：${r.ok ? "OK" : "失败 - " + (r.error || r.status)}`);
    } else if (now - task.wakeWrittenAt > WAKE_TIMEOUT_MS) {
      task.state = "done";
      task.doneAt = now;
      changed = true;
      console.log(`📡 [${task.id}] 兜底已发过，收尾标记完成`);
    }
  }

  // 清理残留唤醒信号（已处理且对应任务已完成 / 任务不存在）
  const wake = readWake();
  if (wake && wake.processed) {
    const t = store.tasks.find((x) => x.id === (wake.meta?.taskId));
    if (!t || t.state !== "pending") {
      clearWake();
      console.log(`🧹 已清理已处理的唤醒信号`);
    }
  }
  if (wake && !wake.processed) {
    const t = store.tasks.find((x) => x.id === (wake.meta?.taskId));
    if (!t || t.state !== "pending") {
      clearWake();
      console.log(`🧹 已清理失效唤醒信号`);
    }
  }

  if (changed) saveTasks(store);
  console.log(`check 完成：处理 ${due.length} 个到期任务（${now.toLocaleString("zh-CN")}）`);
}

// ── main ───────────────────────────────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "add": cmdAdd(args); break;
  case "list": cmdList(); break;
  case "cancel": cmdCancel(args[0]); break;
  case "clear-done": cmdClearDone(); break;
  case "status": cmdStatus(); break;
  case "check": await cmdCheck(); break;
  case "help":
  case undefined:
  case "--help":
    console.log(`星澄定时任务调度器（通用唤醒通道的定时触发器）
用法：
  add "3h" "提醒文本" [--open-terminal] [--no-tg-fallback]
  add --at "21:00" "提醒文本" [--open-terminal]
  list / status / cancel <id> / clear-done / check`);
    break;
  default:
    console.error(`❌ 未知命令：${cmd}（试试 help）`);
    process.exit(2);
}
