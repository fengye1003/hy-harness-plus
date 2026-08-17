"""
星澄唤醒通道 · Python 变式示例
================================
场景：Python 外置下载（requests / aria2 / yt-dlp / 自写下载器……）下载完成后，
调用通用唤醒通道（wake-util.mjs），让星澄醒来校验/整理/汇报，用户只需在
Telegram 等消息。

用法：
  python download-wake.py <url> <dest>
  # 或者在自己的下载脚本里：
  #   from download_wake import wake_sumichan
  #   wake_sumichan("下载完成：xxx", payload="D:/downloads/manifest.json")

原理：
  wake_sumichan() → node wake-util.mjs send ... → 写 wake.json
  → dsh-tg-bot 插件 v15+ 每 ~10s 消费 → followup/steer 注入星澄会话
  → 星澄醒来（读 payload 上下文文件）→ 校验 → tg_send 汇报你

依赖：仅本机 node（wake-util.mjs 零 npm 依赖）。Python 端零第三方依赖。

远程场景（下载器跑在别的机器/服务器）：
  把 wake/ 目录下的 wake-util.mjs 带过去（协议相同），
  或在该机器上写 wake.json 后通过任意通道（scp / MQTT / HTTP POST）
  落到本机 wake.json 同协议文件。协议见 README.md「wake.json 协议」。
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

# wake/ 目录 = 本文件所在目录（examples/）的上一级
WAKE_DIR = Path(__file__).resolve().parent.parent
WAKE_UTIL = WAKE_DIR / "wake-util.mjs"


def wake_sumichan(
    text: str,
    *,
    source: str = "python-download",
    payload: str | None = None,
    meta: dict | None = None,
    node: str = "node",
) -> bool:
    """调用通用唤醒通道，让星澄醒来处理。成功返回 True。

    text    注入给星澄的指令/提醒正文（必填）
    source  来源标识，如 "python-download" / "yt-dlp" / "watchdog"
    payload 绝对路径的上下文文件（manifest/清单），星澄醒来会读
    meta    任意键值，随事件附带（k=v）
    """
    cmd = [node, str(WAKE_UTIL), "send", text, "--source", source]
    if payload:
        cmd += ["--payload", str(payload)]
    for k, v in (meta or {}).items():
        cmd += ["--meta", f"{k}={v}"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=30)
    except Exception as e:  # noqa: BLE001
        print(f"[wake] 调用失败：{e}", file=sys.stderr)
        return False
    if r.returncode != 0:
        print(f"[wake] 失败：{r.stderr.strip()}", file=sys.stderr)
        return False
    print(r.stdout.strip())
    return True


def download_and_wake(url: str, dest: str) -> bool:
    """示例流程：下载 → 写 manifest → 唤醒星澄校验并汇报。

    把「下载」部分换成你的真实下载实现（requests / aria2 / yt-dlp / ...）。
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    # ── 你的下载实现（示例：模拟）────────────────────────────
    #   r = requests.get(url, stream=True)
    #   with open(dest, "wb") as f: ...
    time.sleep(1)  # 模拟下载耗时
    dest.write_bytes(b"\x00" * 1024)  # 占位内容
    # ─────────────────────────────────────────────────────────

    manifest = dest.with_name(dest.name + ".manifest.json")
    manifest.write_text(
        json.dumps(
            {
                "url": url,
                "dest": str(dest),
                "size": dest.stat().st_size,
                "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                "sha256": "（可选：填入哈希供星澄校验）",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    ok = wake_sumichan(
        f"下载完成：{dest.name}\n请校验文件（对照 manifest：大小/哈希），然后通过 TG 汇报结果。",
        source="python-download",
        payload=str(manifest),
        meta={"url": url, "dest": str(dest)},
    )
    if not ok:
        # 兜底：唤醒失败时直接打印提醒（若需 TG 兜底直发，参考 scheduler.mjs 的 fallbackTg）
        print(f"[wake] 唤醒失败，但文件已就绪：{dest}")
    return ok


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法：python download-wake.py <url> <dest>")
        sys.exit(2)
    sys.exit(0 if download_and_wake(sys.argv[1], sys.argv[2]) else 1)
