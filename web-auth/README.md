# dsh-web-auth 鈥?DeepSeek Harness Web 璁よ瘉鎻掍欢

> 浣滆€咃細鏄熸緞锛圚oshino Sumi锛壜?闆朵緷璧栵紙浠?Node 鍐呯疆妯″潡锛壜?2026-08
> 浠撳簱锛歨ttps://github.com/fengye1003/hy-harness-plus 锛坄web-auth/`锛?
缁?DeepSeek Harness 鐨?Web 闈㈡澘鍔犱竴灞?**TOTP 2FA 璁よ瘉**锛氭病鏈夋湁鏁?Cookie Token 鐨勬祻瑙堝櫒涓€寰嬮噸瀹氬悜鍒扮櫥褰曢〉锛圓PI 璇锋眰杩斿洖 401锛夛紝楠岃瘉閫氳繃鍚庣鍙?**30 澶?Cookie Token**銆傞厤濂楋細

- **搴旀€?bypass**锛氱函鏂囨湰鍙ｄ护璧伴殣钄借矾鐢?`/auth/templogin/.../gettokenbypasskey?passkey=...`锛堝彧瀛樺搱甯屻€佸父鏁版椂闂存瘮杈冦€侀檺娴?3 娆?鍒?IP锛夈€?- **Token 绠＄悊椤?*锛歚/auth/tokens` 鏌ョ湅姣忎釜 token 鐨勬渶鍚庝娇鐢ㄦ椂闂?IP锛屽彲涓€閿悐閿€銆?- **UUID polyfill**锛氶『甯︿慨澶嶅眬鍩熺綉鏄庢枃 HTTP 涓?`crypto.randomUUID()` 宕╂簝锛坰ecure-context 涓撳睘 API锛岃 [deepseek-harness#514](https://github.com/deepseek-ai/deepseek-harness/issues/514)锛夈€?- **闃插尽鎬у姞杞斤紙v3锛?*锛歚registerGuard` / `tapIndex` / `register` 鍏ㄩ儴鍏堟帰娴嬪啀璋冪敤锛岀己澶卞彧闄嶇骇鍛婅銆?*缁濅笉 fatal**鈥斺€攈arness 鍗囩骇鍐叉帀 webserver 琛ヤ竵鏃惰璇佹殏鏃堕檷绾с€佷絾鏁翠釜 harness 鐓у父鍚姩銆?
## 璁よ瘉娴佺▼

```
娴忚鍣?鏃?cookie) 鈹€鈹€鈻?guard 妫€鏌?鈹€鈹€鈻?302 鈫?/auth/login锛圚TML锛夋垨 401锛圝SON锛?                                     鈹?POST /auth/verify (6浣峊OTP鐮?
                                     鈻?                             绛惧彂 30 澶?dsh_auth cookie锛堝彧瀛?SHA-256 鍝堝笇锛?```

## 瀹夎

1. 鎶婃湰鐩綍澶嶅埗鍒?profile 鐩綍锛屼緥濡?`~/.dsh/profiles/web/auth-plugin/`銆?2. 鍦?`~/.dsh/profiles/web/cordis.patch.yml` 杩藉姞锛?
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

3. 鐑噸杞斤紙bump `?v=N`锛夋垨閲嶅惎 harness銆?4. 棣栨鍚姩鑷姩鐢熸垚 TOTP 瀵嗛挜锛氭棩蹇椾細鎵撳嵃 `otpauth://totp/...` URI锛屽悓鏃跺浠藉埌 `backupDir`锛坄totp-secret.txt`锛夈€傜敤韬唤楠岃瘉鍣?App 鎵爜鎴栨墜鍔ㄦ坊鍔犮€?5. 娴忚鍣ㄨ闂潰鏉?鈫?杈撳叆 6 浣嶅姩鎬佺爜 鈫?瀹屾垚銆?
## webserver 瀹堝崼閽╁瓙锛坮egisterGuard锛夎鏄?
鎻掍欢閫氳繃 `ctx.webServer.registerGuard(guard)` 鎸傚畧鍗紝瑕嗙洊 HTTP 涓?WebSocket 鍗囩骇銆傝嫢浣犵殑 harness 鐗堟湰杩樻病鏈?`registerGuard`锛岄渶瑕佸厛缁?webserver 鎵撲竴涓皬琛ヤ竵锛堜袱澶勫畨瑁呬綅缃細npm 缂撳瓨涓?profile 鐨?node_modules 閮借鍚屾锛?*鍗囩骇 harness 鍚庨渶閲嶆墦**锛夈€?
**涓€閿ˉ涓佽剼鏈紙鎺ㄨ崘锛?*锛?
```bash
node web-auth/apply-webserver-patch.mjs --check   # 妫€娴嬩袱澶勮ˉ涓佺姸鎬?node web-auth/apply-webserver-patch.mjs --apply   # 缂哄け鍒欒嚜鍔ㄩ噸鎵擄紙骞傜瓑锛?node web-auth/apply-webserver-patch.mjs --verify  # 璇硶妫€鏌?+ 涓ゅ hash 涓€鑷存€?```

- 鍏煎 0.1.0-rc.7 ~ 0.1.1-rc.2锛坵ebserver 鍦?0.1.1 璧蜂綅浜?`@deepseek-ai/dsh-host-webserver` 鍖咃紱鑴氭湰鑷姩瀹氫綅锛夈€?- Windows 榛樿鎵?`%LOCALAPPDATA%\npm-cache\_npx`锛宮acOS/Linux 鎵?`~/.npm/_npx`锛涘竷灞€涓嶅悓鐢ㄧ幆澧冨彉閲?`DSH_NPX_ROOT` 瑕嗙洊銆?
> 璇ヨˉ涓佹槸 harness 鐨勭鏈夋墿灞曠偣锛屽睘浜庡涓婃父婧愮爜鐨勫皬鏀瑰姩锛涙湰鎻掍欢鍦ㄦ棤姝ら挬瀛愮殑鐗堟湰涓婁細闄嶇骇杩愯锛堣矾鐢辨敞鍐屼絾鏃犺姹傚畧鍗級骞舵墦璀﹀憡鏃ュ織銆?
## 娴嬭瘯

```bash
node test/test-rfc6238.mjs     # TOTP 绠楁硶瀵圭収 RFC 6238 瀹樻柟鍚戦噺锛?/6锛?node test/test-integration.mjs # 闆嗘垚鍐掔儫锛歮ock ctx 璺?apply()锛岃鐩栧畧鍗?鐧诲綍/bypass/鍚婇攢/鍗囩骇鎷掔粷
```

## 閰嶇疆椤?
| 閿?| 榛樿 | 璇存槑 |
|---|---|---|
| `passkey` | 鏃?| 搴旀€?bypass 鍙ｄ护锛堝彧瀛?SHA-256锛?|
| `tokenTtlDays` | `30` | Cookie Token 鏈夋晥鏈燂紙澶╋級 |
| `stateFile` | `~/.dsh/auth/state.json` | 鐘舵€侊紙secret + tokens锛?|
| `backupDir` | `~/.dsh/auth/backup` | 棣栨鍚姩澶囦唤 OTPAuth URI |
| `issuer` / `label` | `DSH` / `DeepSeek Harness` | 楠岃瘉鍣?App 鏄剧ず鍚?|

## 瀹夊叏瑕佺偣

- Token 鍙瓨鍝堝笇锛涘悐閿€绔嬪嵆鐢熸晥锛涜繃鏈?token 鑷姩娓呯悊銆?- TOTP 楠岃瘉甯?卤1 绐楀彛 + 鐧诲綍闄愭祦锛? 娆?鍒?IP锛夈€?- 搴旀€?bypass 闄愭祦 3 娆?鍒?IP + 甯告暟鏃堕棿姣旇緝銆?- 璁よ瘉鐘舵€佷笉缁忚繃浠讳綍 LLM鈥斺€旀棤鎻愮ず璇嶆敞鍏ラ潰銆?
## 宸茬煡闄愬埗

- 鍗囩骇 harness锛坣px 閲嶈锛変細瑕嗙洊 npm 缂撳瓨鍐呯殑 webserver 琛ヤ竵锛岄渶閲嶆墦锛坄apply-webserver-patch.mjs --apply`锛沺rofile 鍐?node_modules 鍚屾鏇存柊锛夈€?- 棣栨鍚姩鍚庢墠鐢熸垚 secret锛涜嫢闇€鎭㈠鏃?secret锛屾妸 `totp-secret.txt` 鐨?Secret 鍐欏洖 `state.json` 鍚庨噸鍚€?
## 鍗囩骇缁存姢锛坴0.1.x 瀹炴祴娴佺▼锛?
1. 鍗囩骇鍚庡厛璺?`node web-auth/apply-webserver-patch.mjs --check`鈥斺€擿MISSING` 琛ㄧず琛ヤ竵琚啿鎺夛紱
2. `--apply` 閲嶆墦涓ゅ 鈫?`--verify` 纭 node --check 閫氳繃 + 涓ゅ hash 涓€鑷达紱
3. 閲嶅惎 harness 鈫?楠岃瘉 `GET /` 鏃?cookie 杩斿洖 401锛堝畧鍗湪绾匡級銆乣/auth/login` 200銆?
> 2026-08-18 鏇惧洜鍗囩骇鍐叉帀琛ヤ竵銆佹彃浠剁‖璋冪敤 API 瀵艰嚧鎻掍欢鏍?fatal銆乭arness 鏃犳硶鍚姩锛泇3 闃插尽鎬у姞杞斤紙鏈粨搴撳綋鍓嶇増鏈級璁╂绫诲崌绾у彧闄嶇骇銆佷笉姝绘満锛岄厤鍚堣ˉ涓佽剼鏈竴閿仮澶嶃€?026-08-22 鍦?v0.1.1-rc.2 涓婂疄娴嬪叏娴佺▼锛堥殧绂诲啋鐑?15/15锛夈€?