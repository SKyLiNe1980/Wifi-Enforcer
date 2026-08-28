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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
