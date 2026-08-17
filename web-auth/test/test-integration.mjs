// Integration smoke test: run the plugin's apply() against a mock cordis ctx,
// then exercise the guard + token lifecycle with mock req/res objects.
// Uses a temp state file so the real ~/.dsh/auth state is untouched.
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "dsh-web-auth-test-"));
const stateFile = join(tmp, "state.json");
const backupDir = join(tmp, "backup");

const calls = { guards: [], routes: [], disposed: 0, taps: [] };
const ctx = {
  webServer: {
    registerGuard(g) { calls.guards.push(g); return () => {}; },
    register(route) { calls.routes.push(route); return () => {}; },
    tapIndex(fn) { calls.taps.push(fn); return () => {}; },
  },
  logger: {
    info: (...a) => console.log("  [info]", ...a),
    warn: (...a) => console.log("  [warn]", ...a),
  },
  effect(fn) { return fn(); },
  on(evt) { if (evt === "dispose") calls.disposed += 1; },
};

const plugin = await import(new URL("../index.js", import.meta.url).href);
plugin.apply(ctx, {
  passkey: "integration-test-passkey",
  tokenTtlDays: 30,
  stateFile,
  backupDir,
});

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed += 1;
};

check("one guard registered", calls.guards.length === 1);
const guard = calls.guards[0];
check("guard has check + checkUpgrade", typeof guard.check === "function" && typeof guard.checkUpgrade === "function");

// ── index polyfill tap ────────────────────────────────────────────────────
check("tapIndex registered", calls.taps.length === 1);
const indexHtml = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><div id="root"></div></body></html>`;
const patched = calls.taps[0](indexHtml);
check("polyfill injected into <head>", patched.includes("dsh-web-auth-uuid-polyfill") && patched.indexOf("dsh-web-auth-uuid-polyfill") < patched.indexOf("</head>"));
check("original html preserved", patched.includes('<title>t</title>') && patched.includes('<div id="root"></div>'));
check("idempotent (no double injection)", calls.taps[0](patched) === patched);
const noHead = "<html><body>x</body></html>";
check("missing </head> left untouched", calls.taps[0](noHead) === noHead);

const routePaths = calls.routes.map((r) => r.path);
for (const p of [
  "/auth/login",
  "/auth/verify",
  "/auth/logout",
  "/auth/tokens",
  "/auth/tokens/revoke",
  "/auth/templogin/sumisecret/gettokenbypasskey",
]) check(`route registered: ${p}`, routePaths.includes(p));

// backup file written on first launch
check("backup totp-secret.txt written", existsSync(join(backupDir, "totp-secret.txt")));
const backup = readFileSync(join(backupDir, "totp-secret.txt"), "utf8");
check("backup contains base32 secret", /TOTP Secret \(Base32\): [A-Z2-7]{16,}/.test(backup));

// state file written
const state = JSON.parse(readFileSync(stateFile, "utf8"));
check("state has secret + no tokens", typeof state.secret === "string" && Object.keys(state.tokens).length === 0);

// ── guard behaviour ───────────────────────────────────────────────────────
const makeRes = () => {
  const res = { status: 0, headers: {}, body: "", ended: false };
  res.writeHead = (s, h) => { res.status = s; Object.assign(res.headers, h); };
  res.end = (b = "") => { res.body = b; res.ended = true; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
};
const makeReq = (cookie, accept = "application/json") => ({
  headers: { cookie: cookie || "", accept },
  socket: { remoteAddress: "::ffff:192.168.1.50" },
  url: "/",
});

// unauthenticated → 401 JSON
let res = makeRes();
await guard.check(makeReq(null), res, "/");
check("no cookie -> 401", res.status === 401);

// unauthenticated browser → 302 to login
res = makeRes();
await guard.check(makeReq(null, "text/html"), res, "/chat");
check("no cookie html -> 302 login", res.status === 302 && res.headers.location?.startsWith("/auth/login"));

// login endpoints pass through
res = makeRes();
await guard.check(makeReq(null), res, "/auth/login");
check("/auth/login passes", res.status === 0 && !res.ended);

// create a token through the bypass route (simulated): call state directly is
// not exported, so go through the bypass route handler with a mock.
const bypassRoute = calls.routes.find((r) => r.path === "/auth/templogin/sumisecret/gettokenbypasskey");
res = makeRes();
const bypassReq = makeReq(null);
bypassReq.url = "/auth/templogin/sumisecret/gettokenbypasskey?passkey=integration-test-passkey";
await bypassRoute.handler(bypassReq, res);
check("bypass issues token (302)", res.status === 302);
const cookieHeader = res.headers["set-cookie"] || "";
const m = cookieHeader.match(/dsh_auth=([0-9a-f]+)/);
check("bypass sets dsh_auth cookie", !!m);
const token = m?.[1];

// authenticated request passes
res = makeRes();
await guard.check(makeReq(`dsh_auth=${token}`), res, "/");
check("valid token -> pass through", res.status === 0 && !res.ended);

// wrong passkey rejected (fresh bucket; different ip to dodge rate limit)
const wrongRoute = calls.routes.find((r) => r.path === "/auth/templogin/sumisecret/gettokenbypasskey");
res = makeRes();
const wrongReq = makeReq(null);
wrongReq.socket = { remoteAddress: "::ffff:10.0.0.9" };
wrongReq.url = "/auth/templogin/sumisecret/gettokenbypasskey?passkey=WRONG";
await wrongRoute.handler(wrongReq, res);
check("wrong passkey -> 403", res.status === 403);

// revoke then token stops working
const revokeRoute = calls.routes.find((r) => r.path === "/auth/tokens/revoke");
const state2 = JSON.parse(readFileSync(stateFile, "utf8"));
const tokenId = Object.keys(state2.tokens)[0];
res = makeRes();
const revokeReq = makeReq(null);
revokeReq.headers["content-type"] = "application/x-www-form-urlencoded";
revokeReq.on = (evt, cb) => {
  if (evt === "data") cb(Buffer.from(`id=${tokenId}`));
  if (evt === "end") cb();
};
await revokeRoute.handler(revokeReq, res);
check("revoke redirects", res.status === 302);

res = makeRes();
await guard.check(makeReq(`dsh_auth=${token}`), res, "/");
check("revoked token -> rejected", res.status === 401);

// upgrade guard rejects without token
let destroyed = false;
const fakeSocket = {
  end: () => {},
  destroy: () => { destroyed = true; },
};
await guard.checkUpgrade(makeReq(null), fakeSocket, Buffer.alloc(0), "/api/mux");
check("upgrade without token destroys socket", destroyed);

// wrong TOTP rejected via verify route
const verifyRoute = calls.routes.find((r) => r.path === "/auth/verify");
res = makeRes();
const verifyReq = makeReq(null);
verifyReq.headers["content-type"] = "application/x-www-form-urlencoded";
verifyReq.socket = { remoteAddress: "::ffff:192.168.1.60" };
verifyReq.on = (evt, cb) => {
  if (evt === "data") cb(Buffer.from("code=000000&next=/"));
  if (evt === "end") cb();
};
await verifyRoute.handler(verifyReq, res);
check("wrong TOTP -> 302 back with error=1", res.status === 302 && res.headers.location.includes("error=1"));

rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\nALL INTEGRATION CHECKS PASS" : `\n${failed} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);
