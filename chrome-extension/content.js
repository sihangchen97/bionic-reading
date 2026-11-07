// chrome-extension/content.js — thin glue layer.
// All extraction logic lives in vendor/extract.js (generic, reusable by any
// browser); all bolding logic in vendor/bionic.js. This file only wires the
// two together with Chrome APIs: per-tab state + SPA updates.
//
// State model, owned by the SERVICE WORKER: some pages/contexts block content
// scripts from extension storage ("Access to storage is not allowed from this
// context"), so this script never touches chrome.storage — it speaks runtime
// messages only:
//   - on load      : bionicGetState  -> { on }          (its effective state)
//   - popup ping   : bionicPing      -> { ok: true }   (page is scriptable)
//   - on change    : receives { bionic } from the SW whenever any state write
//                    affects this tab (always this tab's OWN value)
//   Alt+B lives in the manifest's `commands` (toggle-bionic) and is handled
//   by the SW — NOT here. A content-script keydown listener would fire
//   alongside the command and double-toggle.
// "on by default"    = storage.local["bionic-default-enabled"]
// per-tab override   = storage.session["bionic-tab-<tabId>"] (composite key:
//                      the session API has no per-tab option)
//
// Guards:
//   - re-entry: a tab must run at most ONE live copy (double injection would
//     break idempotency) — window.__bionicReader.
//   - orphan: after an extension reload the old context's chrome.runtime.id
//     is undefined; when that happens this copy stops its observer/timers so
//     it can't fight a fresh one.
//   - self-edits: the SPA observer FILTERS out our own word spans (R3)
//     instead of a paused flag — spans inserted late by an idle scan chunk
//     would otherwise come back as work items and get the host marker.
(function () {
  if (window.__bionicReader) return; // already running in this tab
  window.__bionicReader = true;

  let enabled = false; // default OFF (until state resolves)
  let alive = typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;

  // ── orphan self-destruction (extension reloaded under a live tab) ─────────
  function checkOrphan() {
    if (alive && (!chrome.runtime || !chrome.runtime.id)) {
      alive = false;
      mo.disconnect();
      clearTimeout(timer);
      pending.clear();
      console.warn("[bionic-reader] extension context gone (reload) — this copy is now inert");
    }
  }

  function apply(v) { // render only — the SW is the source of truth
    if (v === enabled) return;
    enabled = !!v;
    if (!document.body) return;
    if (!window.bionicExtract) { // vendor/extract.js failed to load — fail loudly
      console.warn("[bionic-reader] vendor/extract.js failed to load; bionicing disabled");
      return;
    }
    if (!enabled) {
      // 6.5.2: a queued re-scan must not run after the page is turned off
      clearTimeout(timer);
      pending.clear();
    }
    window.bionicExtract[enabled ? "scan" : "clear"](document.body);
  }

  function askState() {
    if (!alive) return;
    try {
      chrome.runtime.sendMessage({ bionicGetState: true }, (r) => {
        checkOrphan();
        if (!alive || chrome.runtime.lastError || !r) return;
        if (typeof r.on === "boolean") apply(r.on);
      });
    } catch (_) { /* SW gone */ }
  }

  // replies to the SW's pushes and to the popup's liveness ping
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      checkOrphan();
      if (msg && typeof msg.bionic === "boolean") apply(msg.bionic);
      if (msg && msg.bionicPing) {
        try { sendResponse({ ok: true }); } catch (_) {}
        return true;
      }
    });
  }

  // build stamp: the extension's actual version (manifest is single source of truth)
  let version = "?";
  try { version = chrome.runtime.getManifest().version; } catch (_) {}
  console.info("[bionic-reader] content script loaded, version " + version);

  askState();

  // SPA: newly added elements get bioniced (debounced). Batches accumulate in
  // a Set across observer calls, so nothing added during the 300 ms window is
  // dropped; attribute changes are NOT watched (every hover/animation would
  // fire a re-scan — not worth it).
  // R3/6.5.1: added nodes that are (or descend from) one of OUR word spans or
  // <b>s are filtered out — those are the spans an idle scan chunk inserts
  // late, and letting them re-enter scan() would mark the span itself.
  let timer = null;
  const pending = new Set();
  const ours = (n) => n.nodeType === 1 &&
    ((n.hasAttribute && (n.hasAttribute("data-brw") || n.hasAttribute("data-bionic"))) ||
     (n.closest && n.closest("span[data-brw], b[data-bionic]")));
  const mo = new MutationObserver((muts) => {
    if (!alive || !enabled) return;
    for (const m of muts)
      if (m.type === "childList")
        for (const n of m.addedNodes)
          if (n.nodeType === 1 && n.isConnected && !ours(n)) pending.add(n);
    if (pending.size === 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const nodes = [...pending];
      pending.clear();
      if (!window.bionicExtract) return; // vendor load failed — warn once in apply()
      for (const n of nodes) if (n.isConnected) window.bionicExtract.scan(n);
    }, 300);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
