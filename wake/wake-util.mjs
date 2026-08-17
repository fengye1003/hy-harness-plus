#!/usr/bin/env node
// ============================================================================
// 星澄通用唤醒通道 (wake-util.mjs) — 零依赖
//
// 这是「外部事件 → 唤醒星澄」的唯一入口。任何脚本/程序（定时任务、Python
// 下载器、目录 watcher、CI 钩子……）都可以通过它，把一个事件变成星澄的
// 一个新回合：
//
//   # CLI 方式（任何语言都能用 subprocess 调用）
//   node wake-util.mjs send "下载完成，请校验" --source python-download \
//        --payload "D:/downloads/manifest.json"
//
//   # 模块方式（其他 .mjs 脚本内 import）
//   import { wake } from "./wake-util.mjs";
//   await wake("下载完成，请校验", { source: "python-download", payload: "..." });
//
// 协议（wake.json，本目录）：
//   { v, eventId, text, source, payload?, meta?, ts, processed, processedAt }
//   - dsh-tg-bot 插件 v15+ 每 ~10s 轮询消费：标记 processed:true 并把 text
//     注入绑定会话（运行中 steer / 空闲 followup），星澄醒来执行。
//   - 若 harness 未运行（插件无法消费），由发起方负责兜底（如 scheduler.mjs
//     10 分钟后直发 TG）。
//
// 命令：send <text> / show / status / clear
// 选项：--source <名>  --payload <绝对路径>  --meta key=value(可多次)  --session <id>
// ============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const DIR = dirname(fileURLToPath(import.meta.url));
export const WAKE_FILE = join(DIR, "wake.json");

function loadJson(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  } catch { /* ignore */ }
  return fallback;
}

export function readWake() {
  const w = loadJson(WAKE_FILE, null);
  return w && typeof w === "object" ? w : null;
}

export function clearWake() {
  try { rmSync(WAKE_FILE, { force: true }); } catch { /* ignore */ }
  if (existsSync(WAKE_FILE)) {
    // 删除被拒（如沙箱内 Node 的 rm 被拦）→ 降级为墓碑标记，
    // 防止旧信号被误读/误合并（下次 wake() 写新事件会直接覆盖）。
    try {
      writeFileSync(WAKE_FILE, JSON.stringify({ v: 2, tombstone: true, ts: Date.now() }), "utf8");
    } catch { /* ignore */ }
  }
  return true;
}

function isUsableSignal(w) {
  return !!(w && !w.processed && !w.tombstone);
}

/**
 * 发送一次唤醒请求（幂等：wake.json 尚有一个未消费的请求时，合并为追加说明）。
 * @param {string} text 注入给星澄的指令/提醒正文
 * @param {{source?: string, payload?: string, meta?: object, session?: string}} opts
 * @returns {{ok: boolean, eventId: string, merged?: boolean, error?: string}}
 */
export function wake(text, opts = {}) {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, error: "text required" };
  const existing = readWake();
  if (isUsableSignal(existing)) {
    // 已有未消费请求：合并（保留原事件，附加新说明），避免覆盖丢失
    existing.text += `\n\n（合并 ${opts.source || "other"} 事件：${body}）`;
    existing.merged = true;
    existing.mergedAt = Date.now();
    writeFileSync(WAKE_FILE, JSON.stringify(existing, null, 2), "utf8");
    return { ok: true, eventId: existing.eventId, merged: true };
  }
  const event = {
    v: 2,
    eventId: "ev" + Date.now().toString(36) + randomBytes(2).toString("hex"),
    text: body,
    source: opts.source ?? "manual",
    payload: opts.payload && isAbsolute(opts.payload) ? opts.payload : (opts.payload ? null : undefined),
    meta: opts.meta ?? {},
    session: opts.session ?? undefined,
    ts: Date.now(),
    processed: false,
    processedAt: null,
  };
  // payload 非绝对路径时警告但不阻断
  if (opts.payload && !event.payload) {
    event.meta.payloadRaw = opts.payload;
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(WAKE_FILE, JSON.stringify(event, null, 2), "utf8");
  return { ok: true, eventId: event.eventId };
}

// ── CLI（仅直接执行本文件时运行；被其他 .mjs import 时不抢参数）───────────
import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  function parseOpts(argv) {
    const opts = { meta: {} };
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === "--source") opts.source = argv[++i];
      else if (a === "--payload") opts.payload = argv[++i];
      else if (a === "--session") opts.session = argv[++i];
      else if (a === "--meta") {
        const kv = String(argv[++i] ?? "").split(/=(.*)/s);
        if (kv[0]) opts.meta[kv[0].trim()] = (kv[1] ?? "").trim();
      }
    }
    return opts;
  }

  switch (cmd) {
    case "send": {
      const pos = args.filter((a) => !a.startsWith("--"));
      if (pos.length < 1) { console.error("用法：node wake-util.mjs send \"指令正文\" [--source 名] [--payload 绝对路径] [--meta k=v]"); process.exit(2); }
      const opts = parseOpts(args);
      const r = wake(pos.join(" "), opts);
      if (!r.ok) { console.error("❌ " + r.error); process.exit(1); }
      console.log(`${r.merged ? "🔀" : "🔔"} 唤醒请求已写入（${r.eventId}${r.merged ? "，合并到未消费事件" : ""}），等待插件注入星澄…`);
      break;
    }
    case "show": {
      const w = readWake();
      console.log(w ? JSON.stringify(w, null, 2) : "（无唤醒信号）");
      break;
    }
    case "status": {
      const w = readWake();
      if (!w) { console.log("无唤醒信号"); break; }
      if (w.tombstone) { console.log("🪦 墓碑（旧信号已被清除，等待覆盖）"); break; }
      console.log(`eventId   ：${w.eventId}`);
      console.log(`source    ：${w.source}`);
      console.log(`processed ：${w.processed}${w.processedAt ? " @" + new Date(w.processedAt).toLocaleString("zh-CN") : ""}`);
      console.log(`payload   ：${w.payload ?? "（无）"}`);
      const firstLine = String(w.text ?? "").split("\n")[0] || "（空）";
      console.log(`text      ：${firstLine}${String(w.text ?? "").includes("\n") ? "…" : ""}`);
      break;
    }
    case "clear": {
      clearWake();
      console.log("🧹 已清除唤醒信号");
      break;
    }
    default:
      console.error(`未知命令：${cmd ?? ""}（send / show / status / clear）`);
      process.exit(2);
  }
}
