// dsh-bt-skin —— 宝塔面板风格皮肤插件（背景图 + 毛玻璃遮罩 + 透明度遮罩）
// ============================================================================
//
// 做什么
//   1) 用 webServer.register 挂一条 prefix 路由 `/bt-skin/*`，提供：
//        /bt-skin/skin.css      → 皮肤样式表（读磁盘，改完刷新即生效）
//        /bt-skin/skin.js       → 运行时（背景图层 + 🎨 调参面板）
//        /bt-skin/bg/<preset>   → 背景图（宝塔面板自带的那几张）
//        /bt-skin/status        → 自检 JSON
//   2) 用 webServer.tapIndex 往 index.html 注入两行（<link> + <script defer>）。
//      注入内容极小且恒定 —— 真正的样式/脚本走上面的路由，所以**改皮肤不用重启 harness**，
//      浏览器刷新即可；历史残留的 tap 也不会造成版本错乱。
//
// 为什么这么写
//   - 不碰 DSH 源码：只吃公开 API（register / tapIndex），升级 harness 最多降级不崩。
//   - 零依赖：只用 node: 内置模块。
//   - 防御式：apply 整体 try/catch；任何一步失败只写日志，绝不让插件树 fatal。
//   - 幂等注入：html 里已带 marker 就直接返回，重复 tap 无副作用。
//
// 挂载（cordis.patch.yml）
//   - insert:
//       - id: bt-skin
//         name: ./bt-skin/index.js
//         config:
//           enabled: true
//           # 可选：把自检信息写到文件，排障时一眼看到实例 / 注册状态 / 预设
//           statusFile: /path/to/bt-skin-diag.json
//
// 注意：web-auth 的请求守卫在路由之前生效，/bt-skin/* 仍要求登录 cookie ——
//       浏览器在页面内发起的同源请求自带 cookie，所以不影响使用。

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const name = "bt-skin";
export const inject = ["webServer"];

const MARKER = "dsh-bt-skin";
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PREFIX = "/bt-skin";

// 预置壁纸表 = **示例**。真实部署请在 cordis.patch.yml 的 config.presets 里写自己的图
// （会整体覆盖这里）。每条可选带 tune = 该图自己的出厂参数 { bg, content, veil, blur }；
// 不写就落到 defaults 那一档。图片素材不进仓库（见 .gitignore），
// 一张图都没有时皮肤会落到永远存在的「内置渐变」预设。
const DEFAULT_PRESETS = [
  { id: "wallpaper-1", label: "Wallpaper 1", file: "wallpaper-1.jpg" },
  { id: "wallpaper-2", label: "Wallpaper 2", file: "wallpaper-2.webp" },
];

// 默认参数（宝塔面板主题的 content_opacity 默认就是 70，这里对齐）：
//   bg      背景图不透明度 0~1
//   content 内容区不透明度 %
//   veil    暗色不透明度遮罩 0~1
//   blur    毛玻璃模糊 px（建议 2~4；0 = 完全关闭）
const DEFAULT_DEFAULTS = { preset: "builtin-gradient", bg: 1, content: 70, veil: 0.08, blur: 3 };

// 单条预设可选携带的调参字段（写在 config.presets 的每一项里）
const TUNE_KEYS = ["bg", "content", "veil", "blur"];

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 取一条预设自带的可选调参字段（config.presets 里可以直接写 bg/content/veil/blur） */
function pickTune(p) {
  const tune = {};
  let any = false;
  for (const k of TUNE_KEYS) {
    if (p[k] === undefined || p[k] === null) continue;
    const n = Number(p[k]);
    if (!Number.isFinite(n)) continue;
    tune[k] = n;
    any = true;
  }
  return any ? tune : null;
}

function send(res, status, type, body, extraHeaders) {
  const headers = { "content-type": type, "cache-control": "no-cache, must-revalidate" };
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, MIME[".json"], JSON.stringify(obj, null, 2));
}

function applyImpl(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    prefix: String(config.routePrefix || DEFAULT_PREFIX).replace(/\/+$/, ""),
    skinDir: String(config.skinDir || join(SELF_DIR, "skin")),
    assetsDir: String(config.assetsDir || join(SELF_DIR, "assets")),
    showTuner: config.showTuner !== false,
    statusFile: config.statusFile ? String(config.statusFile) : "",
    runtimeFile: config.runtimeFile ? String(config.runtimeFile) : join(SELF_DIR, "runtime.json"),
    defaults: Object.assign({}, DEFAULT_DEFAULTS, config.defaults || {}),
    presets: Array.isArray(config.presets) && config.presets.length ? config.presets : DEFAULT_PRESETS,
  };

  const log = (...a) => {
    try {
      ctx.logger?.info("[bt-skin]", ...a);
    } catch {
      /* no logger */
    }
  };
  const warn = (...a) => {
    try {
      ctx.logger?.warn("[bt-skin]", ...a);
    } catch {
      /* no logger */
    }
  };

  const instanceId = `${process.pid}-${Date.now().toString(36)}`;
  const disposers = [];
  // 两条注册各自的结果（route 可能因热重载残留而失败；handler 与 diag 都要看它）
  const diagReg = { route: "", tap: "" };

  if (!cfg.enabled) {
    log("disabled by config");
    return { api: { config: () => cfg } };
  }

  // ── preset → 绝对路径（严格白名单，杜绝路径穿越） ───────────────────────
  const presetFile = new Map();
  const presetList = [];
  for (const p of cfg.presets) {
    if (!p || typeof p.id !== "string" || typeof p.file !== "string") continue;
    const abs = resolve(cfg.assetsDir, p.file);
    const root = resolve(cfg.assetsDir) + sep;
    if (!abs.startsWith(root)) {
      warn(`preset ${p.id}: file escapes assetsDir, skipped`);
      continue;
    }
    presetFile.set(p.id, abs);
    // 统一带上 abs（绝对路径）：effective() 无论走 runtime.json 还是走本实例，
    // 返回的每条预设都必须有 abs，否则 handler 里 existsSync(undefined) 会静默变 false
    presetList.push({ id: p.id, label: p.label || p.id, exists: existsSync(abs), abs, tune: pickTune(p) });
  }
  if (!presetFile.size) warn(`no usable presets under ${cfg.assetsDir}`);

  const firstOk = presetList.find((p) => p.exists)?.id;
  const defaults = { ...cfg.defaults };
  if (!presetFile.has(String(defaults.preset)) || !presetList.find((p) => p.id === defaults.preset)?.exists) {
    if (firstOk) defaults.preset = firstOk;
  }

  const skinCssPath = join(cfg.skinDir, "skin.css");
  const skinJsPath = join(cfg.skinDir, "skin.js");

  // ── runtime.json：给"僵尸路由"自愈用 ────────────────────────────────────
  // 背景：改 cordis.patch.yml 会热重载插件树，但**旧实例不会被 dispose**，它仍持有
  // 路由；新实例的 register 因 "(kind, path) 重复" 抛错 → 新配置永远不生效
  // （2026-09-24 实测：新实例 diag 里 disposers:0，旧实例继续用旧预设服务）。
  // 对策：把「预设表 + 默认值」这份**数据**落到 runtime.json，handler 每次请求按
  // mtime 重读 —— 于是哪怕路由是旧实例的，它读到的也是最新数据，不必重启 harness。
  // （代码本身变了仍然要重启；这里解决的是"改图/改默认值要重启"这个高频痛点。）
  const runtimeFile = cfg.runtimeFile || join(SELF_DIR, "runtime.json");

  function writeRuntime() {
    try {
      writeFileSync(
        runtimeFile,
        JSON.stringify(
          {
            writtenAt: new Date().toISOString(),
            instanceId,
            base: cfg.prefix,
            assetsDir: cfg.assetsDir,
            presets: presetList
              .filter((p) => p.exists)
              .map((p) => {
                const row = { id: p.id, label: p.label, file: presetFile.get(p.id) };
                if (p.tune) row.tune = p.tune;
                return row;
              }),
            defaults,
            showTuner: cfg.showTuner,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (error) {
      warn(`runtime.json write failed: ${error?.message || error}`);
    }
  }

  let runtimeCache = { at: -1, data: null };
  function readRuntime() {
    try {
      const st = statSync(runtimeFile);
      if (runtimeCache.data && runtimeCache.at === st.mtimeMs) return runtimeCache.data;
      const data = JSON.parse(readFileSync(runtimeFile, "utf8"));
      if (!data || !Array.isArray(data.presets) || !data.presets.length) return null;
      runtimeCache = { at: st.mtimeMs, data };
      return data;
    } catch {
      return null;
    }
  }

  /** 当前生效的预设/默认值：runtime.json 优先（可能是更新的实例写的），否则用本实例的 */
  function effective() {
    const rt = readRuntime();
    if (!rt) return { presets: presetList.filter((p) => p.exists), defaults, assetsDir: cfg.assetsDir, source: "self" };
    const list = [];
    for (const p of rt.presets) {
      if (!p || typeof p.id !== "string" || typeof p.file !== "string") continue;
      const row = { id: p.id, label: p.label || p.id, file: p.file, abs: p.file };
      if (p.tune) row.tune = p.tune;
      list.push(row);
    }
    return {
      presets: list,
      defaults: { ...defaults, ...(rt.defaults || {}) },
      assetsDir: rt.assetsDir || cfg.assetsDir,
      source: `runtime.json@${rt.writtenAt} (instance ${rt.instanceId})`,
    };
  }

  // ── routes ─────────────────────────────────────────────────────────────
  const handle = (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: "bad url" });
      return;
    }
    const rest = pathname.slice(cfg.prefix.length).replace(/^\/+/, "");
    const eff = effective();

    if (rest === "status" || rest === "") {
      sendJson(res, 200, {
        ok: true,
        instanceId,
        assetsDir: cfg.assetsDir,
        skinDir: cfg.skinDir,
        presets: eff.presets.map((p) => ({ id: p.id, label: p.label, exists: existsSync(p.abs) })),
        defaults: eff.defaults,
        showTuner: cfg.showTuner,
        skinCss: existsSync(skinCssPath),
        skinJs: existsSync(skinJsPath),
        effectiveFrom: eff.source,
        registration: diagReg,
      });
      return;
    }

    if (rest === "skin.css") {
      const text = readText(skinCssPath);
      if (text === null) {
        send(res, 404, "text/plain; charset=utf-8", "skin.css not found");
        return;
      }
      send(res, 200, MIME[".css"], text);
      return;
    }

    if (rest === "skin.js") {
      const raw = readText(skinJsPath);
      if (raw === null) {
        send(res, 404, "text/plain; charset=utf-8", "skin.js not found");
        return;
      }
      // tuning = 各图自带的出厂调档（config.presets 里逐条写），skin.js 用它做切图预设
      const tuning = {};
      for (const p of eff.presets) if (p.tune) tuning[p.id] = p.tune;
      const payload = {
        base: cfg.prefix,
        presets: eff.presets.map((p) => ({ id: p.id, label: p.label })),
        tuning,
        defaults: eff.defaults,
        showTuner: cfg.showTuner,
      };
      // JSON 里若含 </script> 会截断标签；这里做一次最小防御性转义
      const json = JSON.stringify(payload).replace(/<\//g, "<\\/");
      send(res, 200, MIME[".js"], raw.replace(/__BT_SKIN_CFG__/g, json));
      return;
    }

    if (rest.startsWith("bg/")) {
      const id = decodeURIComponent(rest.slice(3)).replace(/[^A-Za-z0-9_-]/g, "");
      // 优先按 runtime.json 解析（可能是更新的实例写的），再退回本实例的映射
      let abs = null;
      const fromRt = eff.presets.find((p) => p.id === id);
      if (fromRt && fromRt.abs) {
        const root = resolve(eff.assetsDir) + sep;
        const cand = resolve(eff.assetsDir, fromRt.abs);
        if (cand.startsWith(root)) abs = cand;
      }
      if (!abs) abs = presetFile.get(id) || null;
      if (!abs || !existsSync(abs)) {
        send(res, 404, "text/plain; charset=utf-8", "background not found");
        return;
      }
      let body;
      try {
        body = readFileSync(abs);
      } catch (error) {
        send(res, 500, "text/plain; charset=utf-8", `read failed: ${error?.message || error}`);
        return;
      }
      const mtime = (() => {
        try {
          return statSync(abs).mtimeMs;
        } catch {
          return Date.now();
        }
      })();
      send(res, 200, MIME[extname(abs).toLowerCase()] || "application/octet-stream", body, {
        "cache-control": "public, max-age=604800",
        etag: `"bt-skin-${id}-${Math.round(mtime)}"`,
      });
      return;
    }

    send(res, 404, "text/plain; charset=utf-8", "not found");
  };

  // 两条注册各自独立 try/catch：热重载时 `register` 可能因 "Duplicate (kind, path)"
  // 抛错（旧实例还没被 dispose），此时绝不能连带跳过 tapIndex —— 注入才是本体。
  const webServer = ctx.webServer;

  // 先把「预设表 + 默认值」落到 runtime.json：即使本次 register 失败（僵尸路由占着坑），
  // 旧实例的 handler 也会在下一次请求时读到这份新数据 —— 改图/改默认值不必重启。
  writeRuntime();

  if (webServer && typeof webServer.register === "function") {
    try {
      disposers.push(webServer.register({ kind: "prefix", path: cfg.prefix, handler: handle }));
      diagReg.route = "ok";
      log(`route registered: prefix ${cfg.prefix}`);
    } catch (error) {
      diagReg.route = `ERR ${error?.message || error}`;
      warn(`route registration failed (degraded, old instance may still serve): ${error?.message || error}`);
    }
  } else {
    diagReg.route = "missing";
    warn("webServer.register missing — routes skipped (degraded)");
  }

  // ── index 注入（幂等：html 里已有 marker 就跳过） ─────────────────────
  if (webServer && typeof webServer.tapIndex === "function") {
    const tags =
      `<link rel="stylesheet" href="${cfg.prefix}/skin.css" data-${MARKER}="1">` +
      `<script src="${cfg.prefix}/skin.js" defer data-${MARKER}="1"></script>`;
    try {
      disposers.push(
        webServer.tapIndex((html) => {
          try {
            if (typeof html !== "string" || html.includes(MARKER)) return html;
            const at = html.indexOf("</head>");
            if (at === -1) return html;
            return `${html.slice(0, at)}${tags}\n${html.slice(at)}`;
          } catch {
            return html;
          }
        })
      );
      diagReg.tap = "ok";
      log("index injection registered via tapIndex");
    } catch (error) {
      diagReg.tap = `ERR ${error?.message || error}`;
      warn(`tapIndex registration failed (degraded): ${error?.message || error}`);
    }
  } else {
    diagReg.tap = "missing";
    warn("webServer.tapIndex missing — index injection skipped (degraded)");
  }

  // ── 自检文件（便于"没重启/没生效"时一眼定位） ──────────────────────────
  const diag = {
    instanceId,
    appliedAt: new Date().toISOString(),
    pid: process.pid,
    prefix: cfg.prefix,
    assetsDir: cfg.assetsDir,
    skinDir: cfg.skinDir,
    presets: presetList,
    defaults,
    skinCss: existsSync(skinCssPath),
    skinJs: existsSync(skinJsPath),
    disposers: disposers.length,
    registration: diagReg,
    note: "route=ERR 通常意味着热重载残留了旧实例的路由（旧实例仍在正常服务，无害）；重启 harness 可合并为单实例。",
  };
  if (cfg.statusFile) {
    try {
      mkdirSync(dirname(cfg.statusFile), { recursive: true });
      writeFileSync(cfg.statusFile, JSON.stringify(diag, null, 2), "utf8");
      log(`diag written: ${cfg.statusFile}`);
    } catch (error) {
      warn(`diag write failed: ${error?.message || error}`);
    }
  }

  log(
    `loaded (prefix=${cfg.prefix}, presets=${presetList.filter((p) => p.exists).length}/${presetList.length}, tuner=${cfg.showTuner})`
  );

  ctx.on("dispose", () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
  });

  return { api: { diag: () => diag } };
}

// 防御式顶层包壳：绝不让皮肤问题拖垮插件树（与 web-auth / moments 同策略）
export function apply(ctx, config = {}) {
  try {
    return applyImpl(ctx, config);
  } catch (error) {
    try {
      ctx.logger?.error(`[bt-skin] apply failed (degraded, boot continues): ${error?.stack ?? error}`);
    } catch {
      console.error(`[bt-skin] apply failed: ${error?.stack ?? error}`);
    }
    return undefined;
  }
}

// 供离线自检脚本复用（不参与插件装载）
export const __testing = { DEFAULT_PRESETS, DEFAULT_DEFAULTS, MARKER, pathToFileURL };
