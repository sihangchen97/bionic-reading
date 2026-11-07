// chrome-extension/background.js — service worker: the ONLY code that touches
// chrome.storage. Some pages and some extension UI contexts block storage
// access directly, so content scripts and the popup speak to us with runtime
// messages:
//   content script (sender.tab = that tab):
//     bionicGetState        -> { on }          (its own effective state)
//   popup (sends its own active tab's tabId, found via
//   chrome.tabs.query({active, currentWindow})):
//     bionicGetPopup {tabId}      -> { ok, cur, def }
//     bionicSetCurrent {tabId}    -> { ok, cur, def }
//     bionicSetDefault {tabId}    -> { ok, cur, def }
//   us -> web tabs: { bionic: bool } — always that tab's OWN computed state
//   (a storage change carries one tab's raw value; never broadcast).
//
// State model. storage.session has NO per-tab option (get/set take only
// items), so per-tab state is emulated with composite keys:
//   - per-tab override -> storage.session["bionic-tab-<tabId>"]  (cleaned on
//     tab close; session clears on browser restart / extension reload)
//   - on by default    -> storage.local["bionic-default-enabled"]
// The default only affects tabs with NO explicit override (fresh pages and
// pages the user never toggled); a toggled tab keeps its own choice.
const DEFAULT_KEY = "bionic-default-enabled";
const tabKey = (id) => "bionic-tab-" + id;

function isWeb(tab) { return /^https?:/.test((tab && tab.url) || ""); }

// one tab's effective state: { cur: on?, def: default? } — read the default
// ONCE per call (6.4.2), not once per tab.
function readState(tabId) {
  const k = tabKey(tabId);
  return Promise.all([
    chrome.storage.session.get({ [k]: null }),
    chrome.storage.local.get({ [DEFAULT_KEY]: false }),
  ]).then(([s, l]) => {
    const def = !!l[DEFAULT_KEY];
    return { cur: s[k] === null ? def : !!s[k], def };
  });
}

// badges + { bionic } push to the given web tabs (6.4.3: one loop, one
// default read per sync)
function syncTabs(tabIds, push) {
  let def = null;
  return chrome.storage.local.get({ [DEFAULT_KEY]: false }).then((l) => {
    def = !!l[DEFAULT_KEY];
    return Promise.all(tabIds.map((t) =>
      chrome.storage.session.get({ [tabKey(t.id)]: null }).then((s) => {
        const on = s[tabKey(t.id)] === null ? def : !!s[tabKey(t.id)];
        setBadge(t.id, on);
        if (push) chrome.tabs.sendMessage(t.id, { bionic: on }).catch(() => {});
      }).catch(() => {})
    ));
  }).catch(() => {});
}
function allWebTabs() {
  return new Promise((res) => {
    chrome.tabs.query({}, (tabs) => res((tabs || []).filter((t) => isWeb(t) && t.id != null)));
  });
}
// a tab can still close between the query and the badge call — ignore that
function setBadge(tabId, on) {
  const noop = () => {};
  Promise.resolve(chrome.action.setBadgeText({ text: on ? "ON" : "OFF", tabId })).catch(noop);
  Promise.resolve(chrome.action.setBadgeBackgroundColor({ color: on ? "#2e7d32" : "#9e9e9e", tabId })).catch(noop);
}

// 6.4.4: narrow onChanged. A per-tab change touches ONLY that tab; a default
// change touches every web tab. (Today every tab close and every toggle
// re-messages every tab.)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session") {
    // a removal (no newValue) only happens on tab close — that tab is gone,
    // and syncing it would make setBadgeText reject ("No tab with id")
    const ids = Object.keys(changes)
      .filter((k) => k.startsWith("bionic-tab-") && changes[k].newValue !== undefined)
      .map((k) => Number(k.slice("bionic-tab-".length)));
    if (ids.length) syncTabs(ids.map((id) => ({ id })), true);
  } else if (area === "local" && DEFAULT_KEY in changes) {
    allWebTabs().then((tabs) => syncTabs(tabs, true));
  }
});
// fresh navigation: the re-injected content script asks for its state
// itself; just make sure the badge is up to date.
chrome.tabs.onUpdated.addListener((_id, _info, tab) => {
  if (tab.status === "loading" && isWeb(tab) && tab.id != null) syncTabs([{ id: tab.id }], false);
});
// a closed tab's override is dead weight in the in-memory session space
chrome.tabs.onRemoved.addListener((tabId) => {
  try { chrome.storage.session.remove(tabKey(tabId)); } catch (_) {}
});

// 6.4.5: async dispatch table (R5) — each handler AWAITs its write before
// reading the state it replies with; the listener is one line.
const handlers = {
  bionicGetState(msg, sender, sendResponse) {
    // the outer listener returns true (async response), so every path must
    // call sendResponse — an early return without it leaves the sender hanging
    if (!sender.tab || !isWeb(sender.tab)) { sendResponse({ on: false }); return; }
    readState(sender.tab.id)
      .then((s) => sendResponse({ on: s.cur }))
      .catch(() => sendResponse({ on: false }));
  },
  bionicGetPopup(msg, _sender, sendResponse) {
    if (!Number.isInteger(msg.tabId)) { sendResponse({ ok: false, cur: false, def: false }); return; }
    readState(msg.tabId)
      .then((s) => sendResponse({ ok: true, cur: s.cur, def: s.def }))
      .catch(() => sendResponse({ ok: false, cur: false, def: false }));
  },
  bionicSetCurrent(msg, _sender, sendResponse) {
    if (!Number.isInteger(msg.tabId)) { sendResponse({ ok: false, cur: false, def: false }); return; }
    // a rejected write must surface as ok:false, not be swallowed
    chrome.storage.session.set({ [tabKey(msg.tabId)]: !!msg.bionicSetCurrent })
      .then(() => readState(msg.tabId))
      .then((s) => sendResponse({ ok: true, cur: s.cur, def: s.def }))
      .catch(() => sendResponse({ ok: false, cur: false, def: false }));
  },
  bionicSetDefault(msg, _sender, sendResponse) {
    if (!Number.isInteger(msg.tabId)) { sendResponse({ ok: false, cur: false, def: false }); return; }
    // "on by default" only affects tabs with no override of their own
    chrome.storage.local.set({ [DEFAULT_KEY]: !!msg.bionicSetDefault })
      .then(() => readState(msg.tabId))
      .then((s) => sendResponse({ ok: true, cur: s.cur, def: s.def }))
      .catch(() => sendResponse({ ok: false, cur: false, def: false }));
  },
};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.id) return;
  for (const name of Object.keys(handlers)) {
    if (msg[name] === undefined) continue;
    handlers[name](msg, sender, sendResponse);
    return true; // respond asynchronously
  }
});
// Alt+B (manifest commands, user-rebindable at chrome://extensions/shortcuts):
// flip the state of the active web tab of the focused window. The SW is the
// only writer, so one key press = one toggle even while a popup is open.
chrome.commands.onCommand.addListener((name) => {
  if (name !== "toggle-bionic") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs && tabs[0];
    if (!t || !isWeb(t) || t.id == null) return;
    readState(t.id).then((s) => {
      chrome.storage.session.set({ [tabKey(t.id)]: !s.cur }).catch(() => {});
    }).catch(() => {});
  });
});
chrome.runtime.onStartup.addListener(() => allWebTabs().then((tabs) => syncTabs(tabs, false)));
chrome.runtime.onInstalled.addListener(() => allWebTabs().then((tabs) => syncTabs(tabs, false)));
allWebTabs().then((tabs) => syncTabs(tabs, false));
