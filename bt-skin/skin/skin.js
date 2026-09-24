/* ============================================================================
 * dsh-bt-skin · 运行时（背景图层 + 毛玻璃参数 + 🎨 调参面板）
 * ----------------------------------------------------------------------------
 * 由 bt-skin 宿主插件以 /bt-skin/skin.js 提供；占位符 __BT_SKIN_CFG__ 在响应时
 * 被替换成真实配置 JSON。全部逻辑包在 try/catch 里：任何异常都只是"皮肤失效"，
 * 绝不影响 DSH 本体。
 * ========================================================================== */
(function () {
  "use strict";
  try {
    if (window.__DSH_BT_SKIN__) return;
    window.__DSH_BT_SKIN__ = true;

    var CFG = __BT_SKIN_CFG__;
    var BASE = (CFG && CFG.base) || "/bt-skin";
    var SHOW_TUNER = !(CFG && CFG.showTuner === false);

    /* 内置"无需图片"预设：仓库版不带任何壁纸素材（不夹带第三方素材、更不夹带私人图），
       所以永远挂一个纯 CSS 渐变兜底 —— 零素材时皮肤依然完整可用。
       它的 url 直接就是 CSS 值，不走 /bt-skin/bg/<id> 路由。 */
    var BUILTIN_GRADIENT = {
      id: "builtin-gradient",
      label: "内置渐变（无图）",
      url: "linear-gradient(160deg, #0b1220 0%, #16233c 45%, #24365c 100%)"
    };
    var PRESET_URLS = {};
    PRESET_URLS[BUILTIN_GRADIENT.id] = BUILTIN_GRADIENT.url;

    var DEF = (CFG && CFG.defaults) || {};
    var PRESETS = ((CFG && CFG.presets) || []).concat([
      { id: BUILTIN_GRADIENT.id, label: BUILTIN_GRADIENT.label }
    ]);

    // v1 → v2：2026-09-24 用户要求「毛玻璃质感调低到 5~10%」。
    // 旧 key 里可能存着 blur=18/20 的手调值，会让新默认被覆盖 → 直接换 key，
    // 让所有人都落到新的出厂调档上（旧值本来也是插件默认，不是用户特意选的）。
    var KEY = "dsh-bt-skin:v2";

    function clamp(v, lo, hi, dflt) {
      var n = Number(v);
      if (!isFinite(n)) n = dflt;
      return Math.min(hi, Math.max(lo, n));
    }

    function hasPreset(id) {
      for (var i = 0; i < PRESETS.length; i += 1) if (PRESETS[i].id === id) return true;
      return false;
    }

    /* ── 每张图的"出厂调档" ──────────────────────────────────────────────
       来源（优先级从高到低）：
         1) CFG.tuning —— 新宿主直接把 config.presets 里每条的 bg/content/veil/blur 传下来
         2) DEF.byPreset —— 兼容通道：宿主把整份 defaults 原样透传，于是
            "defaults.byPreset[<id>]" 这条旁路在**旧宿主实例**上也能生效（不用重启 harness）
       切图时自动套用，用户仍可手动微调。
       建议按壁纸**实测亮度**分档，不要凭眼睛猜：
         平均亮度 > 200（白底/浅色插画）→ veil 0.35~0.5，且顶部要多压
         平均亮度 < 80（深色壁纸）      → veil 0.1~0.2 */
    var TUNING = {};
    (function () {
      var src = [(CFG && CFG.tuning) || null, (DEF && DEF.byPreset) || null];
      for (var s = 0; s < src.length; s += 1) {
        var table = src[s];
        if (!table) continue;
        for (var id in table) if (Object.prototype.hasOwnProperty.call(table, id)) TUNING[id] = table[id];
      }
    })();
    // 内置渐变永远存在，给它一档兜底参数（纯渐变不需要压暗，也不需要模糊）
    if (!TUNING["builtin-gradient"]) TUNING["builtin-gradient"] = { bg: 1, content: 70, veil: 0.08, blur: 3 };

    // 毛玻璃的饱和度增益：原来 150% 是"厚磨砂"观感的一部分，一并压到 110%
    var SATURATE = 110;

    function tunedFor(id, base) {
      var t = TUNING[id] || {};
      return {
        preset: id,
        bg: t.bg != null ? t.bg : base.bg,
        content: t.content != null ? t.content : base.content,
        veil: t.veil != null ? t.veil : base.veil,
        blur: t.blur != null ? t.blur : base.blur
      };
    }

    function load() {
      var raw = null;
      try {
        raw = JSON.parse(localStorage.getItem(KEY) || "null");
      } catch (e) {
        raw = null;
      }
      // 首次访问：直接落到默认预设的"出厂调档"（各图亮度差很多，不能共用一个默认值）
      if (!raw || typeof raw !== "object") raw = tunedFor(DEF.preset, DEF);
      var s = {
        preset: typeof raw.preset === "string" ? raw.preset : DEF.preset,
        bg: clamp(raw.bg, 0, 1, DEF.bg),
        content: clamp(raw.content, 20, 100, DEF.content),
        veil: clamp(raw.veil, 0, 0.9, DEF.veil),
        blur: clamp(raw.blur, 0, 40, DEF.blur),
        hidden: raw.hidden === true,
        open: false
      };
      // 预设必须真实存在：配置里的默认图可能不存在（例如仓库版不带任何图片素材），
      // 这时落到永远存在的内置渐变，并把参数一并换成它那一档，避免"没有壁纸"。
      if (!hasPreset(s.preset)) {
        s.preset = hasPreset(DEF.preset) ? DEF.preset : BUILTIN_GRADIENT.id;
        var t = tunedFor(s.preset, DEF);
        s.bg = t.bg;
        s.content = t.content;
        s.veil = t.veil;
        s.blur = t.blur;
      }
      return s;
    }

    function save(s) {
      try {
        localStorage.setItem(
          KEY,
          JSON.stringify({
            preset: s.preset,
            bg: s.bg,
            content: s.content,
            veil: s.veil,
            blur: s.blur,
            hidden: s.hidden
          })
        );
      } catch (e) {
        /* private mode / quota */
      }
    }

    var state = load();

    function apply(s) {
      var r = document.documentElement;
      var p1 = Math.round(s.content);
      var direct = PRESET_URLS[s.preset];
      r.style.setProperty("--bt-bg-url", direct || 'url("' + BASE + "/bg/" + s.preset + '")');
      r.style.setProperty("--bt-bg-opacity", String(s.bg));
      r.style.setProperty("--bt-veil-alpha", String(s.veil));
      // 遮罩做成上重下轻：实测用户那张图"上亮下暗"，而顶部正好压着 DSH 的标题栏
      r.style.setProperty("--bt-veil-top", String(Math.min(0.95, s.veil * 1.25)));
      r.style.setProperty("--bt-veil-bottom", String(Math.max(0, s.veil * 0.85)));
      r.style.setProperty("--bt-p1", p1 + "%");
      r.style.setProperty("--bt-p2", Math.min(100, p1 + 8) + "%");
      r.style.setProperty("--bt-p3", Math.min(100, p1 + 16) + "%");
      r.style.setProperty("--bt-blur", Math.round(s.blur) + "px");
      // blur=0 必须写成 none：backdrop-filter 只要不是 none 就会建立 containing block
      var px = Math.round(s.blur);
      r.style.setProperty("--bt-filter", px > 0 ? "blur(" + px + "px) saturate(" + SATURATE + "%)" : "none");
    }

    /* ── 图层 DOM ─────────────────────────────────────────────────────── */
    function mountLayers() {
      if (!document.body) return;
      if (document.getElementById("dsh-bt-wall")) return;
      var wall = document.createElement("div");
      wall.id = "dsh-bt-wall";
      wall.setAttribute("aria-hidden", "true");
      var veil = document.createElement("div");
      veil.id = "dsh-bt-veil";
      veil.setAttribute("aria-hidden", "true");
      document.body.insertBefore(veil, document.body.firstChild);
      document.body.insertBefore(wall, veil);
    }

    /* ── 调参面板 ─────────────────────────────────────────────────────── */
    var SLIDERS = [
      { k: "bg", label: "背景图透明度", min: 0, max: 100, pct: true },
      { k: "content", label: "内容不透明度", min: 20, max: 100, pct: true },
      { k: "veil", label: "遮罩浓度", min: 0, max: 90, pct: true },
      { k: "blur", label: "毛玻璃模糊", min: 0, max: 40, unit: "px" }
    ];

    function sliderValue(k) {
      if (k === "bg") return Math.round(state.bg * 100);
      if (k === "veil") return Math.round(state.veil * 100);
      return Math.round(state[k]);
    }

    function setSlider(k, raw) {
      var n = Number(raw);
      if (k === "bg") state.bg = clamp(n, 0, 100, 78) / 100;
      else if (k === "veil") state.veil = clamp(n, 0, 90, 20) / 100;
      else state[k] = n;
    }

    // 把 state 回写到滑杆控件（切图/恢复默认后要同步，否则控件显示的还是旧值）
    var syncSliders = function () {};

    function mountTuner() {
      if (!SHOW_TUNER || !document.body || document.getElementById("dsh-bt-tuner")) return;

      var root = document.createElement("div");
      root.id = "dsh-bt-tuner";
      root.setAttribute("data-open", "0");
      root.setAttribute("data-hidden", state.hidden ? "1" : "0");

      var btn = document.createElement("button");
      btn.id = "dsh-bt-tuner-btn";
      btn.type = "button";
      btn.title = "界面皮肤（宝塔风）";
      btn.setAttribute("aria-label", "界面皮肤");
      btn.textContent = "🎨";

      var panel = document.createElement("div");
      panel.id = "dsh-bt-tuner-panel";

      var head = document.createElement("div");
      head.className = "bt-head";
      head.textContent = "界面皮肤 · 宝塔风";
      panel.appendChild(head);

      var presetBox = document.createElement("div");
      presetBox.className = "bt-presets";
      var presetEls = {};
      PRESETS.forEach(function (p) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "bt-preset";
        b.textContent = p.label || p.id;
        b.setAttribute("data-active", p.id === state.preset ? "1" : "0");
        b.addEventListener("click", function () {
          // 切图 = 换到那张图的出厂调档（各图亮度差异大，共用一套参数必翻车）
          var t = tunedFor(p.id, DEF);
          state.preset = t.preset;
          state.bg = t.bg;
          state.content = t.content;
          state.veil = t.veil;
          state.blur = t.blur;
          for (var id in presetEls) presetEls[id].setAttribute("data-active", id === p.id ? "1" : "0");
          syncSliders();
          apply(state);
          save(state);
        });
        presetEls[p.id] = b;
        presetBox.appendChild(b);
      });
      panel.appendChild(presetBox);

      var rangeEls = {};
      var valueEls = {};
      SLIDERS.forEach(function (s) {
        var row = document.createElement("label");
        row.className = "bt-row";
        var name = document.createElement("span");
        name.textContent = s.label;
        var input = document.createElement("input");
        input.type = "range";
        input.min = String(s.min);
        input.max = String(s.max);
        input.step = "1";
        input.value = String(sliderValue(s.k));
        var val = document.createElement("span");
        val.className = "bt-v";
        val.textContent = sliderValue(s.k) + (s.unit || "%");
        input.addEventListener("input", function () {
          setSlider(s.k, input.value);
          val.textContent = Math.round(Number(input.value)) + (s.unit || "%");
          apply(state);
        });
        input.addEventListener("change", function () {
          save(state);
        });
        rangeEls[s.k] = input;
        valueEls[s.k] = val;
        row.appendChild(name);
        row.appendChild(input);
        row.appendChild(val);
        panel.appendChild(row);
      });

      syncSliders = function () {
        SLIDERS.forEach(function (s) {
          var v = sliderValue(s.k);
          if (rangeEls[s.k]) rangeEls[s.k].value = String(v);
          if (valueEls[s.k]) valueEls[s.k].textContent = v + (s.unit || "%");
        });
      };

      var actions = document.createElement("div");
      actions.className = "bt-actions";

      var reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "恢复默认";
      reset.addEventListener("click", function () {
        var t = tunedFor(DEF.preset, DEF);
        state.preset = t.preset;
        state.bg = t.bg;
        state.content = t.content;
        state.veil = t.veil;
        state.blur = t.blur;
        for (var id in presetEls) presetEls[id].setAttribute("data-active", id === state.preset ? "1" : "0");
        syncSliders();
        apply(state);
        save(state);
      });

      var hide = document.createElement("button");
      hide.type = "button";
      hide.textContent = "隐藏按钮";
      hide.addEventListener("click", function () {
        state.hidden = true;
        root.setAttribute("data-hidden", "1");
        save(state);
      });

      actions.appendChild(reset);
      actions.appendChild(hide);
      panel.appendChild(actions);

      btn.addEventListener("click", function () {
        state.open = !state.open;
        root.setAttribute("data-open", state.open ? "1" : "0");
      });

      root.appendChild(btn);
      root.appendChild(panel);
      document.body.appendChild(root);
    }

    function boot() {
      mountLayers();
      apply(state);
      mountTuner();
      // 逃生口：地址栏加 #bt-skin 可让被隐藏的按钮重新出现
      try {
        if (String(location.hash).toLowerCase() === "#bt-skin") {
          if (state.hidden) {
            state.hidden = false;
            save(state);
          }
          var root = document.getElementById("dsh-bt-tuner");
          if (root) root.setAttribute("data-hidden", "0");
        }
      } catch (e) {
        /* ignore */
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
  } catch (error) {
    try {
      console.warn("[bt-skin] runtime degraded:", error);
    } catch (e) {
      /* ignore */
    }
  }
})();
