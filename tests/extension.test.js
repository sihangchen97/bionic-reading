// Tests for the Chrome glue: popup.html/popup.js, background.js (service
// worker) and content.js, run against a mocked chrome API
// (tests/helpers/extension.js). The popup's window has active tab 300; other
// windows have tab 100 (https) and tab 200 (chrome://). Tests run in order
// and share the extension state.
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { wait } = require("./helpers/dom");
const { createExtension } = require("./helpers/extension");

const ext = createExtension();
const { state } = ext;

describe("popup", () => {
  let popup;

  test("reads the current state on open", async () => {
    state.session["bionic-tab-300"] = false;
    popup = ext.makePopup();
    await wait();
    assert.equal(popup.cur.checked, false);
    assert.equal(popup.def.checked, false);
  });

  test("footer shows the bound shortcut and the version", async () => {
    await wait();
    const footer = popup.document.getElementById("footer").textContent;
    assert.ok(footer.includes("⌥") && footer.includes("0.1.0"), footer);
  });

  test("clicking the switch graphic toggles the popup's own tab only", async () => {
    popup.document.querySelector(".row #cur").closest(".switch").querySelector(".slider").click();
    await wait();
    assert.equal(state.session["bionic-tab-300"], true);
    assert.ok(!("bionic-tab-100" in state.session) && !("bionic-tab-200" in state.session));
  });

  test("a per-tab change is pushed to that tab only, and its badge updates", () => {
    assert.ok(state.pushed.some((x) => x.tabId === 300 && x.msg.bionic === true), JSON.stringify(state.pushed));
    assert.ok(!state.pushed.some((x) => x.tabId === 100 || x.tabId === 200), JSON.stringify(state.pushed));
    assert.equal(state.badges[300].text, "ON");
  });

  test("clicking the label text or anywhere on the row toggles too", async () => {
    popup.document.querySelector("label[for=cur] .label").click();
    await wait();
    assert.equal(state.session["bionic-tab-300"], false);
    popup.document.querySelector("label[for=cur]").click();
    await wait();
    assert.equal(state.session["bionic-tab-300"], true);
  });

  test("a new popup shows the stored state, and a write reply updates it", async () => {
    ext.pressShortcut(); // tab 300: true -> false
    await wait();
    const p = ext.makePopup();
    await wait();
    assert.equal(p.cur.checked, false);
    p.document.querySelector("label[for=cur] .label").click();
    await wait();
    assert.equal(state.session["bionic-tab-300"], true);
    assert.equal(p.cur.checked, true);
  });

  test("'On by default' is saved without overriding the current tab", async () => {
    popup.document.querySelector("label[for=def] .label").click();
    await wait();
    assert.equal(state.local["bionic-default-enabled"], true);
    assert.equal(state.session["bionic-tab-300"], true);
  });

  test("a tab without its own setting follows a default change", async () => {
    state.pushed.length = 0;
    delete state.session["bionic-tab-100"];
    ext.emitStorage({ "bionic-default-enabled": true }, "local");
    await wait(); await wait();
    assert.ok(state.pushed.some((x) => x.tabId === 100 && x.msg.bionic === true), JSON.stringify(state.pushed));
  });

  test("on a chrome:// page both switches are disabled", async () => {
    state.popupWindowId = 2;
    const p = ext.makePopup();
    await wait();
    assert.ok(p.cur.disabled && p.def.disabled);
    state.popupWindowId = 3;
  });

  test("the Reload button reloads the popup's tab", async () => {
    const p = ext.makePopup();
    await wait();
    state.reloaded = null;
    p.document.getElementById("reload").click();
    assert.equal(state.reloaded, 300);
  });
});

describe("content script", () => {
  let page;

  test("asks for its state on load and bolds the page", async () => {
    state.session["bionic-tab-300"] = true;
    page = ext.makePage();
    await wait(30);
    assert.notEqual(page.document.querySelector("#p1 b[data-bionic]"), null);
  });

  test("an OFF push clears the page, an ON push bolds it again", async () => {
    ext.pushToPage({ bionic: false });
    await wait(10);
    assert.equal(page.document.querySelector("#p1 b[data-bionic]"), null);
    ext.pushToPage({ bionic: true });
    await wait(10);
    assert.notEqual(page.document.querySelector("#p1 b[data-bionic]"), null);
  });

  test("nodes added at different times within the debounce window are all bolded", async () => {
    const a = page.document.createElement("p");
    a.textContent = "Another sentence that should be bionicized on the page now.";
    const b = page.document.createElement("p");
    b.textContent = "A third paragraph appended right after the previous one here.";
    page.document.body.appendChild(a);
    setTimeout(() => page.document.body.appendChild(b), 80);
    await wait(500);
    assert.notEqual(a.querySelector("b[data-bionic]"), null, a.innerHTML);
    assert.notEqual(b.querySelector("b[data-bionic]"), null, b.innerHTML);
  });

  test("our own inserted word spans are never re-scanned", async () => {
    // >400 paragraphs, so idle chunks insert spans while the observer is live;
    // re-scanning them would put data-bionic-applied on the span itself
    const big = ext.makePage();
    state.session["bionic-tab-300"] = true;
    for (let i = 0; i < 420; i++) {
      const p = big.document.createElement("p");
      p.textContent = `Another long sentence number ${i} that should get bionic bolding applied.`;
      big.document.body.appendChild(p);
    }
    await wait(600);
    assert.equal(big.document.querySelectorAll("span[data-brw][data-bionic-applied]").length, 0);
  });
});

describe("service worker", () => {
  test("a malformed message still gets a response (the port must not hang open)", async () => {
    // the popup's runtime.sendMessage; bionicGetPopup with a non-integer tabId
    // used to return early without sendResponse, leaving the callback hanging
    // while the listener returned true
    const p = ext.makePopup();
    const reply = await new Promise((res) => p.chrome.runtime.sendMessage({ bionicGetPopup: true, tabId: "nope" }, res));
    assert.deepEqual(reply, { ok: false, cur: false, def: false });
  });

  test("the keyboard shortcut flips the active tab once per press", async () => {
    state.session["bionic-tab-300"] = true;
    ext.pressShortcut();
    await wait();
    assert.equal(state.session["bionic-tab-300"], false);
  });

  test("closing a tab removes its setting without touching the closed tab", async () => {
    state.session["bionic-tab-100"] = true;
    state.badgeOnClosed.length = 0;
    ext.closeTab(100);
    await wait(); await wait();
    assert.ok(!("bionic-tab-100" in state.session));
    assert.deepEqual(state.badgeOnClosed, []);
  });
});
