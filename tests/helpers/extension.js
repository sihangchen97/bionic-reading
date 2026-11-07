// tests/helpers/extension.js — runs the real extension code against a mocked
// chrome API: background.js in this Node realm, popup.html/popup.js and
// content.js each in their own jsdom window.
//
// Three windows are open; the popup belongs to window 3, whose active tab is
// 300. Window 2's active tab is a chrome:// page.
const { JSDOM } = require("jsdom");
const { read, stubLayout } = require("./dom");

function createExtension() {
  // the popup window's active tab; throws (with the mock's own state in the
  // message) if popupWindowId was pointed at a window that doesn't exist
  function popupWindowActive() {
    const w = state.windows.find((w) => w.id === state.popupWindowId);
    if (!w) throw new Error("mock: popupWindowId " + state.popupWindowId + " is not in state.windows");
    return w.active;
  }
  const state = {
    session: {},
    local: {},
    windows: [
      { id: 1, active: { id: 100, url: "https://example.com/window-one" } },
      { id: 2, active: { id: 200, url: "chrome://extensions" } },
      { id: 3, active: { id: 300, url: "https://example.com/popup-window" } },
    ],
    popupWindowId: 3,
    pushed: [],          // chrome.tabs.sendMessage calls made by the SW
    reloaded: null,      // last chrome.tabs.reload tab id
    badges: {},          // tabId -> { text }
    closed: new Set(),   // tabs already closed (badge calls on them reject)
    badgeOnClosed: [],   // setBadgeText calls that hit a closed tab
  };
  const sw = { onMessage: [], onCommand: [] };
  const storageListeners = [];
  const tabListeners = { onUpdated: [], onRemoved: [] };
  let pageListener = null; // the content script's runtime.onMessage listener

  // the changed-map shape the real API uses: { key: { oldValue?, newValue? } }
  function emitStorage(items, area) {
    const change = {};
    for (const [k, v] of Object.entries(items)) change[k] = { newValue: v };
    storageListeners.forEach((l) => l(change, area));
  }
  function storageArea(name) {
    const data = () => state[name];
    return {
      get(defaults, cb) {
        const out = {};
        for (const k of Object.keys(defaults)) out[k] = k in data() ? data()[k] : defaults[k];
        setTimeout(() => cb && cb(out), 0);
        return Promise.resolve(out);
      },
      // resolves LATER than get(), so a reply that does not await its write
      // would read the old value
      set(items, cb) {
        return new Promise((res) => setTimeout(() => {
          Object.assign(data(), items);
          emitStorage(items, name);
          cb && cb();
          res();
        }, 5));
      },
      // a removal carries oldValue only, no newValue
      remove(k, cb) {
        const oldValue = data()[k];
        delete data()[k];
        storageListeners.forEach((l) => l({ [k]: { oldValue } }, name));
        setTimeout(() => cb && cb(), 0);
        return Promise.resolve();
      },
    };
  }
  // route a runtime message to the SW's listeners, like Chrome does. A
  // sendResponse (sync or async) fires the sender's callback exactly once —
  // the first wins, later calls are ignored (Chrome closes the port after the
  // first reply). If no listener ever replies, the callback fires with
  // undefined (Chrome's "no reply" case).
  function toServiceWorker(msg, sender, cb) {
    let replied = false;
    for (const l of sw.onMessage) {
      const reply = (v) => {
        if (replied) return;
        replied = true;
        setTimeout(() => cb && cb(v), 0);
      };
      if (l(msg, sender, reply) === true) break;
    }
    if (!replied) setTimeout(() => cb && cb(undefined), 0);
  }

  const chrome = {
    storage: {
      session: storageArea("session"),
      local: storageArea("local"),
      onChanged: { addListener(l) { storageListeners.push(l); } },
    },
    tabs: {
      query(q, cb) {
        const tabs = q.active && q.currentWindow
          ? [popupWindowActive()]
          : state.windows.map((w) => w.active);
        setTimeout(() => cb(tabs), 0);
      },
      sendMessage(tabId, msg, cb) {
        state.pushed.push({ tabId, msg });
        setTimeout(() => cb && cb({}), 0);
        return Promise.resolve({});
      },
      reload(tabId) { state.reloaded = tabId; },
      onUpdated: { addListener(l) { tabListeners.onUpdated.push(l); } },
      onRemoved: { addListener(l) { tabListeners.onRemoved.push(l); } },
    },
    action: {
      setBadgeText(d) {
        if (state.closed.has(d.tabId)) {
          state.badgeOnClosed.push(d.tabId);
          return Promise.reject(new Error("No tab with id: " + d.tabId));
        }
        (state.badges[d.tabId] = state.badges[d.tabId] || {}).text = d.text;
        return Promise.resolve();
      },
      setBadgeBackgroundColor() { return Promise.resolve(); },
    },
    runtime: {
      id: "test-ext",
      onMessage: { addListener(l) { sw.onMessage.push(l); } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      // from the popup: no sender.tab
      sendMessage(msg, cb) { toServiceWorker(msg, { id: "test-ext", tab: null }, cb); },
      // like the real API: synchronous, no callback
      getManifest() { return { version: "0.1.0" }; },
    },
    commands: {
      onCommand: { addListener(l) { sw.onCommand.push(l); } },
      getAll(cb) { setTimeout(() => cb([{ name: "toggle-bionic", shortcut: "MacAlt+B" }]), 0); },
    },
  };

  // the service worker runs in this realm (it must not need a DOM)
  global.chrome = chrome;
  (0, eval)(read("chrome-extension/background.js"));

  function makePopup() {
    const html = read("chrome-extension/popup.html").replace(/<script src="popup\.js"><\/script>/, "");
    const win = new JSDOM(html, { runScripts: "outside-only" }).window;
    win.chrome = chrome;
    win.eval(read("chrome-extension/popup.js"));
    return win;
  }

  // a page in tab 300 with the shipped vendor scripts + content.js
  function makePage(bodyHtml = `<p id="p1">The HTTP request to NASA failed badly on the server today.</p>`) {
    const win = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, { runScripts: "outside-only" }).window;
    stubLayout(win);
    win.eval(read("chrome-extension/vendor/bionic.js"));
    win.eval(read("chrome-extension/vendor/extract.js"));
    win.chrome = {
      runtime: {
        id: "test-ext",
        getManifest: () => ({ version: "0.1.0" }),
        onMessage: { addListener(l) { pageListener = l; } },
        // the page's tab is derived from state (the popup window's active
        // tab), so closeTab() / window changes are reflected in the sender
        sendMessage(msg, cb) {
          toServiceWorker(msg, { id: "test-ext", tab: popupWindowActive() }, cb);
        },
      },
    };
    win.eval(read("chrome-extension/content.js"));
    return win;
  }

  return {
    state,
    emitStorage,
    makePopup,
    makePage,
    pressShortcut: () => sw.onCommand.forEach((l) => l("toggle-bionic")),
    closeTab: (id) => { state.closed.add(id); tabListeners.onRemoved.forEach((l) => l(id)); },
    pushToPage: (msg) => pageListener(msg, {}, () => {}),
  };
}

module.exports = { createExtension };
