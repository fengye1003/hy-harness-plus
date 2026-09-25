# dsh-bt-skin

> 宝塔面板（BaoTa Panel）风格的 **DeepSeek Harness Web 面板皮肤**：背景图 + 毛玻璃 + 可调透明度遮罩，外加一个实时调参面板。
>
> 零依赖（只用 Node 内置模块）· 不修改 Harness 任何源码 · 只使用两个公开 API

---

## 它做了什么

给 DSH 的 Web GUI 叠一层「壁纸 + 玻璃」的外观。四个可调要素，全部能在页面左下角的 🎨 面板里实时拖：

| 要素 | 说明 |
|---|---|
| **背景图** | 全屏固定图层，支持任意张（本地文件、自带各自的推荐参数） |
| **暗色遮罩** | 压在图上的半透明遮罩，**上重下轻的竖向渐变**（标题栏通常在顶部，而壁纸顶部往往最亮） |
| **内容不透明度** | DSH 所有"表面色"统一变成半透明玻璃 |
| **毛玻璃模糊** | 三栏（会话栏 / 对话区 / 右侧栏）加 `backdrop-filter` |

没有壁纸也能用：内置一个纯 CSS 渐变预设兜底，开箱即完整。

---

## 安装

### 0. 前置

- DeepSeek Harness，`web` profile（`dsh web`）
- 插件目录固定为 `<profile>/bt-skin/`（profile 一般在 `~/.dsh/profiles/web/`）

### 1. 放文件

```bash
# 把本目录整个拷成 <profile>/bt-skin/
cp -r bt-skin ~/.dsh/profiles/web/bt-skin
```

### 2. 挂载

编辑 `<profile>/cordis.patch.yml`，追加：

```yaml
- insert:
    - id: bt-skin
      name: ./bt-skin/index.js
      config:
        enabled: true
        routePrefix: /bt-skin
        showTuner: true
```

完整示例见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。

### 3. 重启 Harness

⚠️ **必须重启**。本 Harness 的 `patchReload: live` 只对补丁文件生效，而且**不会 dispose 旧插件实例**（详见下文「踩坑」）——新插件靠热重载挂不上。

重启后打开面板，左下角会出现 🎨 按钮。

---

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时插件不注册路由、不注入 |
| `routePrefix` | `/bt-skin` | 资源路由前缀（css / js / 背景图 / status） |
| `showTuner` | `true` | 是否显示左下角 🎨 调参面板 |
| `skinDir` | `<插件>/skin` | `skin.css` / `skin.js` 所在目录 |
| `assetsDir` | `<插件>/assets` | 壁纸目录（**不进仓库**，放你自己的图） |
| `runtimeFile` | `<插件>/runtime.json` | 运行时数据（见「自愈」） |
| `statusFile` | `""` | 可选：把自检信息写到指定文件，便于排障 |
| `presets` | 见下 | 预置壁纸表：`[{ id, label, file, bg?, content?, veil?, blur? }]` |
| `defaults` | 见下 | 默认参数：`{ preset, bg, content, veil, blur, byPreset? }` |

```yaml
      config:
        # 每条预设可以自带"出厂调档"（bg/content/veil/blur）——切到这张图时自动套用
        presets:
          - { id: aurora, label: 极光, file: aurora.jpg, bg: 0.9, content: 70, veil: 0.38, blur: 3 }
          - { id: city,   label: 城市夜景, file: city.webp, bg: 0.95, content: 76, veil: 0.12, blur: 3 }
        # bg=背景图不透明度 0~1 · content=内容不透明度 % · veil=暗色遮罩 0~1 · blur=毛玻璃 px
        defaults:
          preset: aurora
          bg: 0.9
          content: 70
          veil: 0.38
          blur: 3
```

`file` 相对 `assetsDir`；id 只允许 `[A-Za-z0-9_-]`，路由侧会做白名单 + 路径穿越校验。

> `defaults.byPreset` 是**兼容通道**：宿主会把整份 `defaults` 原样透传给浏览器，所以哪怕服务中的插件实例还不支持 `presets[].tune`，这份每图调档也照样到得了（不用重启）。正常情况下直接用 `presets[].bg/...` 即可，插件会自动生成 `byPreset`。

---

## 调参面板

左下角 🎨 → 一张表选壁纸、四根滑杆（背景图透明度 / 内容不透明度 / 遮罩浓度 / 毛玻璃模糊）、恢复默认、隐藏按钮。
设置存 `localStorage`，刷新不丢。按钮被隐藏后，地址栏加 `#bt-skin` 可唤回。

**建议值**：

- 毛玻璃 `blur`：**2~4px 即可**。再高就从"玻璃"变成"糊"。拖到 `0` 会整体退化成 `none`（这点很重要，见踩坑 ①）
- 内容不透明度 `content`：`70%` 左右，文字可读性与通透感的平衡点
- 暗色遮罩 `veil`：**看壁纸亮度定**——亮壁纸 0.3~0.5，暗壁纸 0.1~0.2。仓库自带一个亮度测量脚本的做法见下文

### 怎么定遮罩浓度（可复制的方法）

不要凭眼睛猜。缩放图片后按 Rec.709 加权算亮度，并切成上→下若干横带：

```
平均亮度 > 200  → 壁纸很亮（白底/浅色插画），veil 至少 0.35，且顶部要多压
平均亮度 < 80   → 深色壁纸，veil 0.1~0.2 就够
顶带明显高于底带 → 用渐变遮罩（本插件默认 ×1.25 / ×1.0 / ×0.85）
```

---

## 三条「生效规则」（很容易踩）

| 改了什么 | 怎么生效 |
|---|---|
| `skin/skin.css`、`skin/skin.js`、壁纸文件 | **浏览器刷新**即可（每次请求从磁盘读，`no-cache`） |
| `runtime.json` 里的预设表 / 默认值 | **浏览器刷新**即可（handler 每次请求按 mtime 重读） |
| `cordis.patch.yml`、`index.js` | **必须重启 Harness** |

---

## 实现要点

### 只用两个公开 API

```js
ctx.webServer.register({ kind: "prefix", path: "/bt-skin", handler })   // 发 css / js / 图片
ctx.webServer.tapIndex((html) => html.replace("</head>", tags + "</head>"))  // 往 <head> 插两行
```

**薄注入 + 动态资源**：注入物恒定（一个 `<link>` + 一个 `<script defer>`），真正的内容由路由在每次请求时从磁盘产出。好处是历史残留的注入不会造成版本错乱（靠 marker 幂等），而且改皮肤不用重启。

### 为什么覆盖 CSS 变量而不是写选择器

DSH 前端是 React + CSS Module，类名形如 `pI_x6G_frame`，**hash 每次构建都会变**；但所有表面色都走设计系统 token（`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-specific-sidebar-fill` …，定义在 `body` 上）。

- 覆盖 token → 一条规则管全部组件，且升级不失效；写类名则每次升级都碎
- 用 `html body { … !important }`：主题 CSS 是运行时 append 到 `<head>` 的，文档顺序在注入内容之后，所以要靠特异性 + `!important` 压过去
- 明/暗两套各自覆盖（`html body` / `html body[data-ds-dark-theme]`）
- **只改表面色**：文字色、状态色、弹窗蒙层、静态色板一律不动（静态色板被 `label-primary-foreground` 之类引用，改了按钮文字会变透明）

### 图层与层级

```
html              background-color: 画布底色
 └ body
    ├ #dsh-bt-wall   fixed; z-index:-2   壁纸
    ├ #dsh-bt-veil   fixed; z-index:-1   暗色遮罩（竖向渐变）
    └ #root …                            DSH 本体（表面半透明）
```

用**负 z-index** 而不是 `0 / #root{z-index:1}`：负 z-index 在层叠顺序里永远低于所有在流内容，于是挂在 `body` 上的 portal / 浮层依然在背景之上。同时必须把 `body` 自身背景设为透明，否则会盖住壁纸。

---

## 踩坑（都是实测撞出来的）

① **`backdrop-filter: blur(0px)` 不等于关闭** —— 只要不是 `none` 就会建立 containing block，可能让 `position: fixed` 的浮层跑位。所以"关掉模糊"要写成 `none`，插件用 `--bt-filter` 变量自动切换。

② **`register()` 对重复的 `(kind, path)` 会抛错** —— 热重载残留旧实例时，新实例注册会失败。所以两条注册各自独立 try/catch，且注入本身幂等。

③ **热重载不会 dispose 旧插件实例**（本项目最值钱的发现）—— 改 `cordis.patch.yml` 后新实例确实会被创建，但旧实例仍持有路由；实测新实例的 `disposers: 0`。**结论：改插件代码必须重启。**

④ **`runtime.json` 自愈** —— 针对 ③ 的补偿：把「预设表 + 默认值」这份**数据**在 apply 时落盘，路由 handler 每次请求按 mtime 重读。于是哪怕路由仍属于旧实例，它读到的也是最新数据 → **改图 / 改默认值不必重启**。（代码本身变了仍然要重启，这部分无解。）

⑤ **`existsSync(undefined)` 只警告不报错** —— 两条返回路径里漏了个字段，让所有预设都显示"不存在"（只有一条 `DEP0187` 警告）。所有预设对象统一带上绝对路径即可。

⑥ **认证守卫在路由之前** —— 如果 Harness 前面挂了 2FA 守卫，`/bt-skin/*` 同样要 cookie。浏览器页面内的同源请求自带，命令行裸请求会 401（写自动化测试时要记得先换 cookie）。

---

## 排障

| 症状 | 处理 |
|---|---|
| 完全没变化 | 先强刷；再看 `runtime.json` 与（若配了）`statusFile` |
| 改了配置/代码没反应 | 见「三条生效规则」——多半需要重启 |
| 面板长得怪 / 浮层跑位 | 把毛玻璃拖到 0（退化成 `none`）；仍不对就 `enabled: false` |
| 🎨 按钮不见了 | 地址栏加 `#bt-skin` |

`GET <routePrefix>/status` 会返回当前生效的数据来自哪个实例（`effectiveFrom`）、预设是否都存在。

---

## ⚠️ 装了「强制深色」扩展（Dark Reader 等）看不见壁纸？

**症状**：同一个面板，A 浏览器正常显示壁纸，B 浏览器什么都没有 —— 而 B 装了 Dark Reader（或同类"强制全局深色"扩展）。关掉扩展立刻恢复。

**机制**：这类扩展会**改写页面配色**。它的滤镜模式等于对整页做一次 `invert(1) hue-rotate(180deg)`，再把**真实图片元素**（`img/video/canvas`）反色回来 —— 而 **CSS `background-image` 不在它的"还原"名单里**。于是亮色壁纸被反成暗色，再叠上暗遮罩就基本看不见了。
（注意区分：**系统深色**只会向网站发送 `prefers-color-scheme` 建议，**不改写页面配色**，所以它不影响。）

**本插件的处理**：

1. **壁纸用真正的 `<img>` 元素**（`#dsh-bt-wall` 内），CSS `background-image` 只作首帧/内置渐变预设的兜底 —— 扩展会保留真实图片，壁纸能活下来。
2. **🎨 面板会检测并提示**：命中 `data-darkreader-*`、`style.darkreader` 或 `html` 上形如 `*darkreader*|force-dark*` 的属性时，面板顶部显示一行黄色提醒，建议对本站关闭该扩展。
3. 想更彻底：把面板加进该扩展的**站点白名单**（Dark Reader：站点列表 → 添加本站 → 设为"不应用"）。

> 如果你在自己写的插件里也画全屏背景图，建议照抄这条：**能被"反色扩展"正确还原的只有真实 `<img>`，不是 CSS 背景图。**

---

## 卸载

`cordis.patch.yml` 里删掉 `bt-skin` 段 → 重启 Harness。浏览器里残留的 `localStorage` 键是 `dsh-bt-skin:v2`，可随手清掉。

---

## 关于本仓库不附带壁纸

仓库**不包含任何壁纸图片**：不夹带第三方素材，也不夹带私人图片。请把你自己的图放进 `assetsDir` 并在 `config.presets` 里登记。
没放图也不会坏——内置渐变预设会兜底。

## License

MIT（见仓库根目录 LICENSE）。

---

> 由 **星澄（Hoshino Sumi）** 撰写，LLM 生成，基于真实实践并经人工审阅。
> 面向其他 Agent / Harness 开发者分享实现细节与踩坑记录。
