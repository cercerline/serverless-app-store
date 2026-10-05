// Headless smoke test: run every frame of the animation against a stubbed canvas.
// Catches reference errors, typos and NaN/Infinity coordinates without a browser.
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../animation.html", import.meta.url), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error("no <script> block found");
const src = m[1];

const problems = [];
let calls = 0;

const NUMERIC_METHODS = [
  "arc", "arcTo", "moveTo", "lineTo", "rect", "fillRect", "strokeRect", "clearRect",
  "ellipse", "roundRect", "fillText", "strokeText", "bezierCurveTo", "quadraticCurveTo",
];
const SETTERS = [
  "globalAlpha", "lineWidth", "shadowBlur", "lineDashOffset", "miterLimit", "font",
  "fillStyle", "strokeStyle", "shadowColor", "lineCap", "lineJoin", "globalCompositeOperation",
  "textAlign", "textBaseline", "lineDash",
];

function makeCtx(label) {
  const target = {};
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (prop === "canvas") return { width: 1600, height: 900 };
      if (typeof prop === "symbol") return undefined;
      if (prop === "measureText") {
        return (str) => ({ width: String(str).length * 12 });
      }
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return (...args) => {
          for (const a of args) {
            if (typeof a === "number" && !Number.isFinite(a)) {
              problems.push(`${label}: ${String(prop)} got non-finite arg ${a}`);
            }
          }
          return { addColorStop: (o, c) => {
            if (!Number.isFinite(o)) problems.push(`${label}: addColorStop offset ${o}`);
            if (typeof c !== "string") problems.push(`${label}: addColorStop color ${c}`);
          } };
        };
      }
      if (prop === "createPattern") return () => ({});
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (prop in t) return t[prop];
      return (...args) => {
        calls++;
        if (NUMERIC_METHODS.includes(prop)) {
          for (const a of args) {
            if (typeof a === "number" && !Number.isFinite(a)) {
              problems.push(`${label}: ctx.${String(prop)}(${args.join(",")}) has non-finite arg`);
              break;
            }
          }
        }
        if (prop === "drawImage") {
          const img = args[0];
          if (!img || !img.width) problems.push(`${label}: drawImage with invalid source`);
        }
        return undefined;
      };
    },
    set(t, prop, value) {
      if (SETTERS.includes(prop)) {
        if (prop === "globalAlpha" && (typeof value !== "number" || value < 0 || value > 1 || !Number.isFinite(value))) {
          problems.push(`${label}: globalAlpha set to ${value}`);
        }
        if (["lineWidth", "shadowBlur"].includes(prop) &&
            (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          problems.push(`${label}: ${prop} set to ${value}`);
        }
        // lineDashOffset is legitimately negative (dash animation direction).
      }
      t[prop] = value;
      return true;
    },
  });
  return ctx;
}

/** Minimal element stub. */
function makeEl(tag, label) {
  const listeners = {};
  const el = {
    tagName: tag,
    style: {},
    width: 1600,
    height: 900,
    textContent: "",
    classList: { add() {}, remove() {}, contains: () => true },
    getContext: () => makeCtx(label),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    requestFullscreen: () => Promise.resolve(),
    appendChild: () => {},
  };
  el._listeners = listeners;
  return el;
}

const elements = {
  cv: makeEl("canvas", "main"),
  stage: makeEl("div", "stage"),
  splash: makeEl("div", "splash"),
  btnPause: makeEl("button", "btnPause"),
  btnReplay: makeEl("button", "btnReplay"),
  btnFull: makeEl("button", "btnFull"),
  btnPlay: makeEl("button", "btnPlay"),
};

const winListeners = {};
const docListeners = {};

const documentStub = {
  getElementById: (id) => elements[id] || makeEl("div", id),
  createElement: (tag) => makeEl(tag, "offscreen-" + tag),
  body: { classList: { add() {}, remove() {}, contains: () => true } },
  addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
  exitFullscreen: () => Promise.resolve(),
  fullscreenElement: null,
};

const windowStub = {
  innerWidth: 1920,
  innerHeight: 1080,
  devicePixelRatio: 1,
  addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
  requestAnimationFrame: () => 0,
};

/* The animation resolves its QR target from location.search at load time, so the
   sandbox needs a file-like URL. Override with QR_TEST_URL to exercise ?qr=... */
const locationStub = new URL(process.env.QR_TEST_URL || "file:///promo/animation.html");
const performanceStub = { now: () => 0 };

let rafCallback = null;
const requestAnimationFrame = (fn) => { rafCallback = fn; return 1; };

// Run the script body with browser globals injected.
const factory = new Function(
  "window", "document", "requestAnimationFrame", "console", "location", "performance",
  src + "\n;return { render, DURATION, SCENES, QR_PAYLOAD, QR_DISPLAY, QR };",
);

let api;
try {
  api = factory(windowStub, documentStub, requestAnimationFrame, console, locationStub, performanceStub);
} catch (err) {
  console.error("Script threw during initial execution:", err);
  process.exit(1);
}

if (!api || typeof api.render !== "function") {
  console.error("render() was not reachable");
  process.exit(1);
}

// Step the whole timeline, including scene boundaries, at 120 fps.
const DURATION = api.DURATION;
const step = 1 / 120;
let frames = 0;
for (let t = 0; t <= DURATION + step; t += step) {
  try {
    api.render(t);
    frames++;
  } catch (err) {
    problems.push(`render(${t.toFixed(3)}) threw: ${err.message}`);
    console.error(`\n=== render(${t.toFixed(3)}) stack ===\n${err.stack}\n`);
    break;
  }
}

// Also hit the exact scene start times and loop seam.
for (const sc of api.SCENES) {
  for (const t of [sc.start - 0.001, sc.start, sc.start + 0.001]) {
    try { api.render(Math.max(0, t)); } catch (err) { problems.push(`scene ${sc.name} @${t}: ${err.message}`); }
  }
}

console.log(`frames rendered: ${frames}, canvas calls: ${calls}`);
console.log(`QR target: ${api.QR_PAYLOAD}`);
console.log(`QR on screen: "${api.QR_DISPLAY}" -> v${api.QR.version}, ${api.QR.px}px panel`);

const unique = [...new Set(problems)];
if (unique.length) {
  // Group by message shape so one systemic bug does not flood the output.
  const groups = new Map();
  for (const p of unique) {
    const key = p.replace(/-?\d+(\.\d+)?(e-?\d+)?/g, "N");
    if (!groups.has(key)) groups.set(key, { count: 0, sample: p });
    groups.get(key).count++;
  }
  console.log(`\n${groups.size} distinct problem kind(s):`);
  for (const [key, info] of groups) {
    console.log(`  - [${info.count}x] ${key}\n      e.g. ${info.sample}`);
  }
  process.exit(1);
}
console.log("\nNo runtime errors, no non-finite coordinates, no invalid alpha/lineWidth.");
