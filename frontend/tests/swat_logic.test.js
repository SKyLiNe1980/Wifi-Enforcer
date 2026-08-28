/**
 * Standalone logic tests for the SWAT background-resilience patch.
 *
 * Reproduces the pure logic paths from src/lib/swatIrc.ts (parseIrcColored,
 * stripIrc, exponential-backoff computation) verbatim so we can validate
 * them without a bundler / RN runtime. This is the source-level verification
 * requested by the review (web preview cannot bundle due to expo-sqlite
 * wasm-worker issue, and the native SwatBus foreground service is APK-only).
 */
const assert = require("assert");

// ── verbatim copies from src/lib/swatIrc.ts ─────────────────────────────
function stripIrc(s) {
  return s.replace(/\x03\d{0,2}(,\d{1,2})?|[\x02\x0f\x1d\x1f\x16\x11]/g, "");
}

const MIRC = {
  0: "#ffffff", 1: "#c8d0cc", 2: "#5b8cff", 3: "#00ff66", 4: "#ff3860", 5: "#ff7a5c",
  6: "#c56bff", 7: "#ffb020", 8: "#ffd400", 9: "#7dff9a", 10: "#3ad7ff", 11: "#8bf0ff",
  12: "#7aa8ff", 13: "#ff77dd", 14: "#8aa39b", 15: "#c8d0cc",
};

function parseIrcColored(raw) {
  const segs = [];
  let cur = "";
  let color = null;
  const flush = () => { if (cur) { segs.push({ t: cur, color }); cur = ""; } };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\x03") {
      flush();
      let j = i + 1;
      let fg = "";
      while (j < raw.length && /\d/.test(raw[j]) && fg.length < 2) { fg += raw[j]; j += 1; }
      if (raw[j] === "," && /\d/.test(raw[j + 1] || "")) {
        j += 1;
        let bg = "";
        while (j < raw.length && /\d/.test(raw[j]) && bg.length < 2) { j += 1; bg += "x"; }
      }
      color = fg === "" ? null : (MIRC[parseInt(fg, 10)] ?? null);
      i = j - 1;
    } else if (ch === "\x0f") {
      flush();
      color = null;
    } else if ("\x02\x1d\x1f\x16\x11".includes(ch)) {
      // drop
    } else {
      cur += ch;
    }
  }
  flush();
  return segs.length ? segs : [{ t: raw, color: null }];
}

// exponential backoff formula from onclose handler (swatIrc.ts:334)
function backoffDelay(attempts) {
  return Math.min(60000, 1000 * 2 ** attempts);
}

// ── verbatim copies of the Phase-C logic (swatIrc.ts / swatOps.ts) ─────────
function utf8Bytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}
function b64(bytes) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]; const b1 = bytes[i + 1]; const b2 = bytes[i + 2];
    out += A[b0 >> 2];
    out += A[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? A[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : "=";
    out += i + 2 < bytes.length ? A[b2 & 63] : "=";
  }
  return out;
}
function saslPlainPayload(account, password) {
  return b64([0, ...utf8Bytes(account), 0, ...utf8Bytes(password)]);
}

// endpoint failover ring (swatIrc.ts endpoints())
function endpoints(cfg) {
  const list = [];
  const add = (h, p) => {
    const host = (h || "").trim();
    if (!host || !p) return;
    if (list.some((e) => e.host === host && e.port === p)) return;
    list.push({ host, port: p });
  };
  add(cfg.host, cfg.port);
  add(cfg.fallbackHost, cfg.fallbackPort);
  return list.length ? list : [{ host: cfg.host || "127.0.0.1", port: cfg.port || 7778 }];
}

// static commander authorization (swatOps.ts isSwatOp)
const SWAT_OPS = ["Maarten", "Enforcer-Operator"];
function isSwatOp(nick) {
  const n = (nick || "").trim().toLowerCase();
  if (!n) return false;
  return SWAT_OPS.some((o) => o.toLowerCase() === n);
}

// OPS echo parser (swatIrc.ts parseOpsEcho)
function parseOpsEcho(rawText) {
  const text = stripIrc(rawText || "").trim();
  const m = text.match(/^(?:ops|commanders?)\b[\s:=\-]*(.+)$/i);
  if (!m) return null;
  const nicks = m[1]
    .split(/[\s,]+/)
    .map((n) => n.replace(/^[@+%~&]+/, "").trim())
    .filter(Boolean);
  return nicks.length ? nicks : null;
}

// mention detection (swatIrc.ts maybeAlert)
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"); }
function isMention(me, text) {
  const m = (me || "").toLowerCase();
  return !!m && new RegExp(`(^|[^\\w])@?${escapeRe(m)}([^\\w]|$)`, "i").test(text);
}

// ── tests ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + " — " + e.message); fail++; }
};

console.log("stripIrc:");
t("removes color codes", () => assert.strictEqual(stripIrc("\x0303hello\x0f"), "hello"));
t("removes bold/italic/underline", () => assert.strictEqual(stripIrc("\x02b\x1di\x1fu\x0f"), "biu"));
t("removes fg,bg color", () => assert.strictEqual(stripIrc("\x034,1red on blue\x0f"), "red on blue"));
t("no-op on plain text", () => assert.strictEqual(stripIrc("plain"), "plain"));

console.log("parseIrcColored:");
t("plain text → single null-color segment",
  () => assert.deepStrictEqual(parseIrcColored("hello"), [{ t: "hello", color: null }]));
t("colored segment maps to palette",
  () => {
    const segs = parseIrcColored("\x0303green\x0f rest");
    assert.strictEqual(segs.length, 2);
    assert.strictEqual(segs[0].t, "green");
    assert.strictEqual(segs[0].color, "#00ff66");
    assert.strictEqual(segs[1].color, null);
  });
t("two-digit color code parses",
  () => {
    const segs = parseIrcColored("\x0310cyan");
    assert.strictEqual(segs[0].color, "#3ad7ff");
  });
t("fg,bg — bg is skipped, only fg colors segment",
  () => {
    const segs = parseIrcColored("\x034,1msg");
    assert.strictEqual(segs[0].color, "#ff3860");
    assert.strictEqual(segs[0].t, "msg");
  });
t("returns segments (non-empty) always",
  () => {
    const segs = parseIrcColored("");
    assert.ok(Array.isArray(segs) && segs.length >= 1);
  });

console.log("exponential backoff Math.min(60000, 1000*2**attempts):");
[[0, 1000], [1, 2000], [2, 4000], [3, 8000], [4, 16000], [5, 32000], [6, 60000], [7, 60000], [20, 60000]]
  .forEach(([a, exp]) => {
    t(`attempts=${a} → ${exp}ms`, () => assert.strictEqual(backoffDelay(a), exp));
  });

console.log("SASL PLAIN base64 payload (\\0account\\0password):");
// Reference values cross-checked with Buffer.from(...).toString("base64").
t("simple ascii creds", () => {
  const exp = Buffer.from("\x00enforcer\x00hunter2", "binary").toString("base64");
  assert.strictEqual(saslPlainPayload("enforcer", "hunter2"), exp);
});
t("empty account+password", () => {
  assert.strictEqual(saslPlainPayload("", ""), Buffer.from("\x00\x00", "binary").toString("base64"));
});
t("preserves NUL separators (decodes back)", () => {
  const dec = Buffer.from(saslPlainPayload("acc", "pw"), "base64").toString("binary");
  assert.strictEqual(dec, "\x00acc\x00pw");
});
t("utf-8 password", () => {
  const exp = Buffer.from("\x00acc\x00pä", "utf8").toString("base64");
  assert.strictEqual(saslPlainPayload("acc", "pä"), exp);
});

console.log("endpoint failover ring:");
t("primary + fallback → 2 endpoints in order", () => {
  const eps = endpoints({ host: "a", port: 1, fallbackHost: "b", fallbackPort: 2 });
  assert.deepStrictEqual(eps, [{ host: "a", port: 1 }, { host: "b", port: 2 }]);
});
t("blank fallback → primary only", () => {
  const eps = endpoints({ host: "a", port: 1, fallbackHost: "", fallbackPort: 0 });
  assert.deepStrictEqual(eps, [{ host: "a", port: 1 }]);
});
t("dedupes identical primary/fallback", () => {
  const eps = endpoints({ host: "a", port: 1, fallbackHost: "a", fallbackPort: 1 });
  assert.strictEqual(eps.length, 1);
});
t("idx rotation re-probes primary (idx%len cycles a→b→a)", () => {
  const eps = endpoints({ host: "a", port: 1, fallbackHost: "b", fallbackPort: 2 });
  assert.strictEqual(eps[0 % eps.length].host, "a");
  assert.strictEqual(eps[1 % eps.length].host, "b");
  assert.strictEqual(eps[2 % eps.length].host, "a");
});

console.log("static commander authorization (fail-open, local):");
t("known op (exact)", () => assert.strictEqual(isSwatOp("Maarten"), true));
t("known op (case-insensitive)", () => assert.strictEqual(isSwatOp("enforcer-operator"), true));
t("unknown nick → not a commander", () => assert.strictEqual(isSwatOp("randouser"), false));
t("empty/whitespace → false", () => { assert.strictEqual(isSwatOp(""), false); assert.strictEqual(isSwatOp("   "), false); });

console.log("OPS echo parser:");
t("OPS: space list", () => assert.deepStrictEqual(parseOpsEcho("OPS: Maarten Enforcer-Operator"), ["Maarten", "Enforcer-Operator"]));
t("commanders = comma list", () => assert.deepStrictEqual(parseOpsEcho("commanders = a, b, c"), ["a", "b", "c"]));
t("strips @+ prefixes", () => assert.deepStrictEqual(parseOpsEcho("ops @Maarten +bob"), ["Maarten", "bob"]));
t("non-ops line → null", () => assert.strictEqual(parseOpsEcho("STATUS all nodes green"), null));
t("mIRC colors stripped before parse", () => assert.deepStrictEqual(parseOpsEcho("\x0303OPS:\x0f Maarten"), ["Maarten"]));

console.log("mention detection:");
t("plain @nick", () => assert.strictEqual(isMention("Enforcer-Operator", "hey @Enforcer-Operator ping"), true));
t("bare nick word boundary", () => assert.strictEqual(isMention("bob", "bob check this"), true));
t("case-insensitive", () => assert.strictEqual(isMention("Bob", "BOB!"), true));
t("substring is NOT a mention", () => assert.strictEqual(isMention("bob", "bobcat prowls"), false));
t("empty me → false", () => assert.strictEqual(isMention("", "anything"), false));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
