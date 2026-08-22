# dsh-harness-plugins 路 DeepSeek Harness 鎻掍欢闆?
> 涓讳綔鑰咃細**鏄熸緞锛圚oshino Sumi锛?* 路 **HYrecovery 鐨?AI 灏忓姪鎵?* 路 2026-08 路 闆朵緷璧栵紙浠?Node 鍐呯疆妯″潡锛?> 浠撳簱鍦板潃锛?*https://github.com/fengye1003/hy-harness-plus**

缁?[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 鏈湴 AI 宸ヤ綔鍙拌ˉ榻愪笁浠躲€屾棩甯稿垰闇€銆嶇殑闆朵緷璧栨彃浠讹細

| 鎻掍欢 | 鐩綍 | 涓€鍙ヨ瘽 |
|---|---|---|
| 馃攼 **dsh-web-auth** | [`web-auth/`](web-auth/) | TOTP 2FA + 30 澶?Cookie Token 璁よ瘉锛屾妸鏈湴 Web 闈㈡澘瀹夊叏鍦版毚闇插埌灞€鍩熺綉/鍐呯綉 |
| 馃 **dsh-tg-bot** | [`tg-bot/`](tg-bot/) | Telegram 妗ユ帴锛氳 Telegram 鎴愪负浣犵殑绗簩瀵硅瘽鍏ュ彛锛堝弻鍚戝璇?+ 杩涘害姹囨姤 + TOTP 鐧藉悕鍗曪級 |
| 鈴?**wake** | [`wake/`](wake/) | 閫氱敤浜嬩欢鍞ら啋閫氶亾锛氫换浣曡剼鏈啓涓€浠?`wake.json` 灏辫兘鍞ら啋 agent 鎵ц骞舵眹鎶?|

涓変釜鎻掍欢浜掔浉閰嶅悎褰㈡垚涓€涓畬鏁寸殑銆屾湰鍦?AI 宸ヤ綔鍙板彲杩滅▼浣跨敤銆嶉棴鐜細

```
娴忚鍣?灞€鍩熺綉/Tailscale) 鈹€鈹€鈻?DSH Web 闈㈡澘 鈹€鈹€鈹攢鈻?dsh-web-auth  璁よ瘉瀹堝崼锛圱OTP 2FA锛?                                            鈹?Telegram 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈻?dsh-tg-bot 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?  鍙屽悜瀵硅瘽 / 杩涘害姹囨姤 / tg_send 宸ュ叿
                                            鈹?瀹氭椂鍣?/ Python 涓嬭浇鍣?/ 鐩戞帶 鈹€鈹€鈻?wake.json 鈹€鈹?  锛坵ake 閫氶亾 鈫?dsh-tg-bot 娉ㄥ叆浼氳瘽锛?```

## 浣滆€?
**鏄熸緞锛圚oshino Sumi锛?* 鈥斺€?HYrecovery 鐨?AI 灏忓姪鎵嬶紝杩愯浜?DeepSeek Harness 涔嬩腑銆?
鏈粨搴撶殑涓変釜鎻掍欢閮藉嚭鑷槦婢勪箣鎵嬶細浠庛€岀粰鏈湴 AI 宸ヤ綔鍙板姞涓€閬撻攣銆嶇殑 dsh-web-auth 寮€濮嬶紝鍒般€岃 AI 闅忔椂鑳借鎵惧埌銆嶇殑 dsh-tg-bot锛屽啀鍒般€岃浠讳綍鑴氭湰閮借兘鍙啋 AI銆嶇殑 wake鈥斺€旈兘鏄湪鐪熷疄鐜閲屼竴姝ユ韪╁潙銆佷慨濂姐€侀獙璇佽繃鐨勫疄璺典骇鐗┿€?
## 璁捐鍘熷垯

- **闆朵緷璧?*锛氬叏閮ㄥ彧鐢?`node:` 鍐呯疆妯″潡锛宍npm install` 閮戒笉闇€瑕侊紝澶嶅埗鍗崇敤銆?- **涓嶉樆濉?*锛歚apply` 涓嶇缃戠粶锛岃疆璇?姹囨姤鍏ㄥ紓姝ワ紝Telegram 鎴栦唬鐞嗕笉鍙揪鍙敼鐘舵€侀噸璇曪紝harness 鐓у父宸ヤ綔銆?- **瀹夊叏浼樺厛**锛氶獙璇佽矾寰勭函浠ｇ爜锛圧FC 6238 TOTP锛夛紝缁濅笉缁忚繃 LLM鈥斺€旀病鏈夋彁绀鸿瘝娉ㄥ叆闈紱鍑嵁鍏ㄩ儴浠庨厤缃?鐜鍙橀噺/鐘舵€佹枃浠惰鍙栵紝浠ｇ爜閲岄浂纭紪鐮併€?
---

## 閮ㄧ讲鏁欑▼锛堜粠闆跺埌鍏ㄩ摼璺級

> 鐩爣鐜锛歐indows / macOS / Linux 涓婅繍琛?DeepSeek Harness **web profile**锛坄~/.dsh/profiles/web/`锛夈€?> 鍏ㄧ▼绾?15 鍒嗛挓锛屼笉闇€瑕佸畨瑁呬换浣?npm 鍖呫€?
### 绗?0 姝ワ細纭鍓嶇疆鏉′欢

1. DeepSeek Harness 姝ｅ父杩愯锛學eb 闈㈡澘鍙闂紙`http://127.0.0.1:8088` 鎴栬嚜瀹氫箟绔彛锛夈€?2. 鎵惧埌浣犵殑 profile 鐩綍锛歚~/.dsh/profiles/web/`锛岄噷闈㈡湁 `cordis.patch.yml` 鍜?`node_modules/`銆?3. **dsh-web-auth 闇€瑕?webserver 鐨?`registerGuard` / `tapIndex` 閽╁瓙**鈥斺€旇嫢浣犵殑 harness 鐗堟湰杩樻病鏈夛紝闇€瑕佸厛鎵撲竴涓皬琛ヤ竵锛堜竴閿剼鏈 [`web-auth/apply-webserver-patch.mjs`](web-auth/apply-webserver-patch.mjs)锛岃鏄庤 [`web-auth/README.md`](web-auth/README.md)锛夈€?
### 绗?1 姝ワ細閮ㄧ讲 dsh-web-auth锛堣璇佸畧鍗級

1. 鎶?`web-auth/` 鐩綍澶嶅埗鍒?profile 鐩綍锛屽緱鍒?`~/.dsh/profiles/web/auth-plugin/`銆?2. 缂栬緫 `cordis.patch.yml`锛岃拷鍔犳寕杞斤細

```yaml
- insert:
    - id: web-auth
      name: './auth-plugin/index.js?v=3'
      config:
        passkey: '<浣犵殑搴旀€ュ彛浠わ紝棣栨閰嶇疆鍚庤鐗㈣>'   # 鍙€夛紱涓嶉厤鍒?bypass 璺敱绂佺敤
        tokenTtlDays: 30
        stateFile: '~/.dsh/auth/state.json'
        backupDir: '~/.dsh/auth/backup'
        issuer: 'DSH'
        label: 'DeepSeek Harness'
```

3. 鐑噸杞斤紙鎶?`?v=1` 鐨勭増鏈彿 +1锛夋垨閲嶅惎 harness銆?4. 棣栨鍚姩鑷姩鐢熸垚 TOTP 瀵嗛挜锛氭棩蹇楁墦鍗?`otpauth://totp/...` URI锛屽悓鏃跺浠藉埌 `backupDir`锛坄totp-secret.txt`锛夈€傜敤韬唤楠岃瘉鍣?App锛圙oogle Authenticator / 1Password / Aegis鈥︹€︼級鎵爜娣诲姞銆?5. 娴忚鍣ㄨ闂潰鏉?鈫?杈撳叆 6 浣嶅姩鎬佺爜 鈫?瀹屾垚銆傝闂?`/auth/tokens` 鍙鐞嗙櫥褰?Token銆?
鉁?**楠屾敹**锛氭棤 cookie 璁块棶闈㈡澘琚噸瀹氬悜鍒?`/auth/login`锛涜緭閿欓獙璇佺爜琚嫆缁濓紱杈撳叆姝ｇ‘鐮佸悗杩涘叆銆?
### 绗?2 姝ワ細閮ㄧ讲 dsh-tg-bot锛圱elegram 妗ユ帴锛屽彲閫変絾鎺ㄨ崘锛?
1. 鎵?[@BotFather](https://t.me/BotFather) 鍒涘缓 Bot锛屾嬁鍒?token锛堝舰濡?`123456789:AAF...`锛夈€?2. 鎶?`tg-bot/` 鐩綍澶嶅埗鍒?profile 鐩綍锛屽緱鍒?`~/.dsh/profiles/web/tg-bot/`銆?3. 鎶?token 鍐欏叆 `~/.dsh/tg-bot/token.txt`锛堟垨鐢ㄩ厤缃」 `token` / 鐜鍙橀噺 `DSH_TG_BOT_TOKEN`锛夈€?4. 鍦?`cordis.patch.yml` 杩藉姞鎸傝浇锛堢ず渚嬭 [`tg-bot/examples/cordis.patch.yml`](tg-bot/examples/cordis.patch.yml)锛夛紝鐑噸杞芥垨閲嶅惎銆?5. Telegram 绉佽亰浣犵殑 bot锛歚/start` 鈫?鐢ㄨ韩浠介獙璇佸櫒 App锛堜笌绗?1 姝ュ悓涓€涓級鍙?`/verify <6浣嶇爜>` 鈫?鐧藉悕鍗曡惤鐩橈紝涔嬪悗鍏嶉獙璇併€?
鉁?**楠屾敹**锛歍elegram 閲岀洿鎺ュ彂娑堟伅锛宎gent 鍥炲悎缁撴潫鑷姩鍥炰紶鍥炲锛沗/status` 鏄剧ず妗ユ帴涓庤繛鎺ョ姸鎬併€?
> 鏃犲叕缃?IP 鐨勬満鍣ㄩ粯璁よ蛋鏈湴娣峰悎浠ｇ悊 `http://127.0.0.1:7897` 璁块棶 Telegram API锛坄proxy` 閰嶇疆椤瑰彲鏀癸紝绌哄瓧绗︿覆 = 鐩磋繛锛夈€?
### 绗?3 姝ワ細閮ㄧ讲 wake锛堥€氱敤浜嬩欢鍞ら啋锛屽彲閫夛級

1. 鎶?`wake/` 鐩綍澶嶅埗鍒颁换浣曟柟渚跨殑浣嶇疆锛堣剼鏈彲鍐欏嵆鍙級锛屼緥濡?`~/wake/`銆?2. 鍦?`cordis.patch.yml` 鐨?`tg-bot` 閰嶇疆鍧楅噷鍔犱竴琛岋紝鎸囧悜 wake.json锛?
```yaml
        wakeFile: 'C:/path/to/wake/wake.json'   # 缁濆璺緞锛涗笉閰嶅垯榛樿鍦?stateDir 涓?```

3. 娴嬭瘯锛歚node scheduler.mjs add "3h" "鎻愰啋鎴戝枬姘? --open-terminal` 鈫?鍒扮偣鍚?agent 琚敜閱掑苟閫氳繃 TG 姹囨姤銆?4. 锛圵indows锛夋敞鍐屾瘡鍒嗛挓妫€鏌ョ殑璁″垝浠诲姟锛岃 [`wake/README.md`](wake/README.md) 绗洓鑺傘€?
鉁?**楠屾敹**锛歚node wake-util.mjs status` 鑳界湅鍒版湭娑堣垂/宸叉秷璐圭殑鍞ら啋淇″彿锛涘埌鐐规彁閱掑埌杈?Telegram銆?
### 甯歌闂

| 鐜拌薄 | 鍘熷洜涓庤В娉?|
|---|---|
| 鎻掍欢娌＄敓鏁?| `cordis.patch.yml` 鎸傝浇鍚庢湭鐑噸杞?閲嶅惎锛沗?v=N` 鐗堟湰鍙锋病 +1 |
| 鎻掍欢闄嶇骇鍛婅锛坄registerGuard missing`锛墊 harness 鍗囩骇鍐叉帀浜?webserver 琛ヤ竵 鈫?璺?`node web-auth/apply-webserver-patch.mjs --apply` 閲嶆墦锛岄噸鍚?|
| Telegram 涓€鐩?401 | bot token 閿欒 鈫?妫€鏌?`token.txt` / 閰嶇疆 |
| getUpdates 鎶?409 | 鏈夊涓疆璇㈠疄渚嬶紙鐑噸杞芥畫鐣欙級鈫?閲嶅惎 harness锛涙彃浠惰嚜甯︽枃浠剁骇杞閿佸彲鑷剤 |
| 灞€鍩熺綉 HTTP 璁块棶椤甸潰鐧藉睆 | 鑰佺増鏈?harness 鐨?`crypto.randomUUID()` 鍦ㄩ潪 HTTPS 涓嬪穿婧?鈫?鏇存柊鍒板惈 UUID polyfill 鐨?web-auth 鐗堟湰 |
| 鍞ら啋娌″埌 | 鏃犵粦瀹氫細璇濇椂涓嶄細娉ㄥ叆锛涙鏌?harness 鏄惁杩愯銆乣wakeFile` 璺緞鏄惁姝ｇ‘ |

### 鍗囩骇缁存姢锛堥噸瑕侊級

- **DSH 鍗囩骇锛坣px 閲嶈锛変細瑕嗙洊 npm 缂撳瓨閲岀殑 webserver 琛ヤ竵**鈥斺€擿registerGuard` 閽╁瓙闅忎箣涓㈠け銆倃eb-auth 鎻掍欢鏄?*闃插尽鎬у姞杞?*鐨勶細閽╁瓙缂哄け鍙檷绾у憡璀︺€乭arness 鐓у父鍚姩锛堜笉浼氬儚鏃х増閭ｆ牱 fatal锛夛紝浣嗚璇佷笉鐢熸晥銆?- 鎭㈠锛歚node web-auth/apply-webserver-patch.mjs --apply`锛堝箓绛夛紝鑷姩瀹氫綅 npm 缂撳瓨涓?profile 涓ゅ瀹夎浣嶇疆骞朵繚鎸?hash 涓€鑷达級锛岀劧鍚?*閲嶅惎 harness**銆?- 2026-08-18 鏇惧洜鍗囩骇鍐叉帀琛ヤ竵瀵艰嚧鎻掍欢鏍?fatal銆乭arness 鏃犳硶鍚姩锛泇3 闃插尽鎬у姞杞?+ 琛ヤ竵鑴氭湰灏辨槸涓轰簡璁╄繖绫诲崌绾с€屽彧闄嶇骇銆佷笉姝绘満銆佷竴閿仮澶嶃€嶃€?
---

## 鍏煎鎬?
- DeepSeek Harness 鐨?**web profile**锛坄~/.dsh/profiles/web/`锛夛紝閫氳繃 `cordis.patch.yml` 鎸傝浇銆?- dsh-web-auth 闇€瑕?webserver 鐨?`registerGuard` / `tapIndex` 閽╁瓙锛坄apply-webserver-patch.mjs` 涓€閿墦琛ヤ竵锛涘吋瀹?0.1.0-rc.7 ~ 0.1.1-rc.2锛寃ebserver 鍦?0.1.1 璧蜂綅浜?`dsh-host-webserver` 鍖咃級銆?- Windows / macOS / Linux 鍧囧彲鐢紙wake 鐨勩€屾墦寮€缁堢銆嶅姩浣滀负 Windows 浼樺厛瀹炵幇锛屽叾浣欒法骞冲彴锛夈€?
## 瀹夊叏璇存槑

- 鎵€鏈?TOTP 瀵嗛挜銆乥ot token銆佺櫧鍚嶅崟閮芥槸**杩愯鏃剁姸鎬?*锛坄~/.dsh/` 涓嬶級锛屼笉闅忎粨搴撳垎鍙戙€?- `dsh-tg-bot` 榛樿澶嶇敤 `dsh-web-auth` 鐨勫悓涓€涓?TOTP secret锛坄verifySecretMode: shared`锛夛紝涔熷彲鐙珛锛坄dedicated`锛夈€?- 搴旀€?bypass 鍙ｄ护锛坄passkey`锛夊彧瀛樺搱甯岋紝闄愭祦 3 娆?鍒?IP锛涜鑷濡ュ杽淇濈銆?- 鏈粨搴撲笉鍖呭惈浠讳綍鐪熷疄鍑嵁鎴栫敤鎴蜂釜浜烘暟鎹€?
## 璁稿彲璇?
[MIT](LICENSE) 漏 2026 鏄熸緞锛圚oshino Sumi锛壜?HYrecovery 鐨?AI 灏忓姪鎵?
> 鏈粨搴撶敱鏄熸緞锛圚oshino Sumi锛岃繍琛屼簬 DeepSeek Harness 涓殑 AI 鍔╂墜锛屾湇鍔′簬 HYrecovery锛夋挵鍐欎笌缁存姢锛屽熀浜庣湡瀹為儴缃插疄璺碉紝骞剁粡浜哄伐瀹￠槄鍚庡彂甯冦€?