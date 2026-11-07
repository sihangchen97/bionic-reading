#!/usr/bin/env node
// Benchmark (Phase 2.4): scan() time + words bolded on a synthetic long page.
// Measure before/after performance changes:
//   node scripts/bench.js
// jsdom has no requestIdleCallback, so the CHUNKED scan path falls back to a
// setTimeout(fn, 16) chain — the bench awaits everything (drains timers).
const { makeDom } = require("../tests/helpers/dom");

// jsdom timers are real Node timers; the chunked-scan fallback (setTimeout
// chain) keeps going after scan() returns. Poll until the bolded-word count
// is stable across two reads, with a hard cap.
function drain(doc, maxMs = 30000) {
  const count = () => doc.querySelectorAll("b[data-bionic]").length;
  return new Promise((resolve) => {
    const t0 = Date.now();
    let last = count(), stable = 0;
    const id = setInterval(() => {
      const c = count();
      stable = c === last ? stable + 1 : 0;
      last = c;
      const timedOut = Date.now() - t0 > maxMs;
      if ((stable >= 2 && c > 0) || stable >= 4 || timedOut) {
        clearInterval(id);
        // a timeout means the count never stabilized — do not report a
        // legitimate ~maxMs measurement, flag it so a broken run is visible
        if (timedOut) console.warn(`drain: count did not stabilize within ${maxMs} ms (last=${c})`);
        resolve();
      }
    }, 50);
  });
}

function bench(name, html) {
  const { win, doc, X } = makeDom(html);
  if (!X || typeof X.scan !== "function") {
    throw new Error("bionicExtract not attached to window (check src/extract.js loaded)");
  }
  const rawText = doc.body.textContent;
  const words = rawText.replace(/\s+/g, " ").trim().split(" ").length;
  const t0 = process.hrtime.bigint();
  X.scan(doc.body);
  return drain(doc).then(() => {
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    const bolded = doc.querySelectorAll("b[data-bionic]").length;
    const spans = doc.querySelectorAll("span[data-brw]").length;
    const changed = rawText.length !== doc.body.textContent.length ? "!!TEXT CHANGED" : "ok";
    console.log(`${name}: ${ms.toFixed(1)} ms · ${rawText.length} chars / ${words} words · bolded ${bolded} words in ${spans} spans · text ${changed}`);
  });
}

(async () => {
  const para = "The quick brown fox jumps over the lazy dog while the server processes the entire batch of requests without a single timeout or retry.";
  const long = `<main>${Array.from({ length: 3000 }, () => `<p>${para}</p>`).join("")}</main>`;
  await bench("synthetic (3000 paragraphs)", long);
})().catch((err) => {
  console.error("bench failed:", err);
  process.exit(1);
});
