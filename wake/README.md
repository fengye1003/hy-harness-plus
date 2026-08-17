# wake — 通用事件唤醒通道

> 作者：星澄（Hoshino Sumi）· 零依赖 · 2026-08

把「事件触发」与「agent 执行」解耦：**任何脚本**（定时器、Python 下载器、目录 watcher、CI 钩子……）写一份 `wake.json`，消费端（`dsh-tg-bot` 插件）轮询后把事件注入 agent 会话——agent 醒来执行动作并通过 TG 汇报。

## 一、架构

```
┌─ 触发器（任选其一）──────────────────────────────┐
│ ① scheduler.mjs  定时任务（add "3h" "…"）        │
│ ② wake-util.mjs  CLI：任何语言 subprocess 调用    │
│ ③ 直接写 wake.json（协议公开，见下）              │
└──────────────┬───────────────────────────────────┘
               │ 写 wake.json（本目录）
               ▼
┌─ dsh-tg-bot 插件（每 ~10s 轮询）──────────────────┐
│ 标记 processed:true                               │
│ running → agent.steer() ｜ idle → agent.followup()│
└──────────────┬───────────────────────────────────┘
               │ 注入绑定会话（UserMessage 对象）
               ▼
┌─ agent（星澄）───────────────────────────────────┐
│ 醒来 → 读 payload 上下文文件 → 执行动作           │
│ → tg_send 汇报用户（Telegram 双份同步）            │
└──────────────────────────────────────────────────┘

兜底：若 harness 未运行（消费端不消费），scheduler 在唤醒信号发出 10 分钟后
直发 Telegram（走代理），保证提醒不丢。
```

## 二、wake.json 协议（v2）

```json
{
  "v": 2,
  "eventId": "evXXXX",
  "text": "注入给 agent 的指令/提醒正文（必填）",
  "source": "scheduler | python-download | manual | …",
  "payload": "绝对路径的上下文文件（可选，agent 醒来可读）",
  "meta": { "任意": "键值" },
  "ts": 1786950000000,
  "processed": false,
  "processedAt": null
}
```

- `wake-util.mjs` 负责维护此文件；已有未消费事件时**合并**而非覆盖（不丢事件）。
- 消费端消费 = `processed:true` + `processedAt`（脚本可据此判断 agent 是否已接手）。

## 三、通用唤醒工具 wake-util.mjs（零依赖）

```bash
# CLI（任何语言都可 subprocess 调用）
node wake-util.mjs send "下载完成，请校验" --source python-download \
     --payload "D:/downloads/manifest.json" --meta url=https://…

node wake-util.mjs status    # 看当前唤醒信号/是否已消费
node wake-util.mjs show      # 看完整 JSON
node wake-util.mjs clear     # 清除残留信号
```

```js
// 模块方式（其他 .mjs 脚本）
import { wake, readWake, clearWake } from "./wake-util.mjs";
await wake("下载完成，请校验", { source: "python-download", payload: "D:/x.json" });
```

## 四、定时触发器 scheduler.mjs（零依赖）

```bash
node scheduler.mjs add "3h" "提醒我喝水" --open-terminal   # 3 小时后：开终端 + 唤醒
node scheduler.mjs add --at "21:00" "今晚提醒"              # 指定时刻（过点→明天）
node scheduler.mjs add --at "2026-08-18 09:00" "明早提醒"
node scheduler.mjs list / status / cancel <id> / clear-done
node scheduler.mjs check        # 计划任务每分钟调用（幂等）
```

到期动作：① 弹终端窗口（`--open-terminal`，Windows Terminal 优先）② 写 wake.json 唤醒 agent → agent 通过 TG 提醒你 ③ harness 未运行 → 10 分钟后自动兜底直发 TG（`--no-tg-fallback` 可关）。

任务队列 `tasks.json`（本目录，已 gitignore）。

### 计划任务注册（Windows 示例）

> ⚠️ 直接跑 `run-check.cmd` 每分钟会弹 cmd 黑窗 → 用 `run-check-hidden.vbs`（wscript 隐藏窗口，纯 ASCII）包装。计划任务动作 = `wscript.exe <run-check-hidden.vbs>`。

```powershell
schtasks /Create /TN "wake-scheduler" /SC MINUTE /MO 1 /F /TR `
  "wscript.exe `"C:\path\to\wake\run-check-hidden.vbs`""

schtasks /Query /TN "wake-scheduler" /XML   # 查看动作
schtasks /Run    /TN "wake-scheduler"        # 手动触发测试
schtasks /Delete /TN "wake-scheduler" /F     # 卸载
```

> 注意：VBS 文件必须**纯 ASCII**（wscript 按 ANSI 解析，UTF-8 中文会字节错位导致 `Object required` 类报错）。

## 五、变式示例：Python 下载完成 → 唤醒 + 通知

见 [`examples/download-wake.py`](examples/download-wake.py)（含可复用函数 `wake_sumichan()`）：

```python
from download_wake import wake_sumichan
wake_sumichan("下载完成：xxx，请校验", source="yt-dlp", payload="D:/dl/manifest.json")
```

下载完成后 agent 被唤醒 → 读 manifest → 校验 → TG 汇报。远程机器上只需把 `wake-util.mjs` 带过去（协议同），或经任意通道（scp / MQTT / HTTP POST）把 wake.json 落回本机。

## 六、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_TG_PROXY` | `http://127.0.0.1:7897` | Telegram 兜底直发的代理（空字符串 = 直连） |
| `DSH_TG_OWNER_UID` | 空 | 兜底直发目标 uid（优先读 dsh-tg-bot 的 `whitelist.json`） |

## 七、已知边界

- 消费端 `enabled=false`（TG `/off`）时不消费 wake，由 scheduler 兜底直发。
- 无绑定会话时消费端不注入，scheduler 10 分钟后兜底。
- 消息合并：wake.json 未消费期间多次 send 会合并为一条注入（防事件丢失）。
- **注入必须走对象**：消费端用 `makeUserMessage()` 构造 UserMessage 对象再 `steer/followup`（字符串会触发 harness 崩溃，见 [`tg-bot/README.md`](../tg-bot/README.md) 踩坑 5）。
- **墓碑**：`clearWake` 在沙箱内删除失败时降级写 `{tombstone:true}`（Node `rmSync` 被拦时）；消费端跳过墓碑；手动清理：`Remove-Item wake.json`。
- **会话切换 → 唤醒目标漂移**：唤醒注入目标是「当前绑定/最近活跃会话」，而非创建任务时的会话——切换 session 后唤醒会漂到新会话。任务文本写作纪律：**必要上下文写进 text 或 payload 文件，不依赖会话记忆**。
