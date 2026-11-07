// chrome-extension/popup.js — two switches + status pill + "page not ready".
// The popup never touches chrome.storage (some extension UI contexts are
// blocked). It looks up its OWN active tab (chrome.tabs.query with
// currentWindow — MessageSender has no windowId, so the SW must not guess),
// sends tabId with every message, and updates the switches from the
// { ok, cur, def } reply instead of guessing. It also pings the tab for a
// live content script; if none answers (page opened before an extension
// reload), it offers a Reload button.
const cur = document.getElementById("cur");
const def = document.getElementById("def");
const pill = document.getElementById("pill");
const status = document.getElementById("status");
const statusText = document.getElementById("status-text");
const reloadBtn = document.getElementById("reload");
const footer = document.getElementById("footer");
const versionEl = document.getElementById("version");

// R4: chrome.runtime.getManifest() is SYNCHRONOUS and takes no callback.
const { version } = chrome.runtime.getManifest();
versionEl.textContent = version;
// show the actually-bound shortcut (⌥B on macOS) from the manifest commands
let shortcut = "";
chrome.commands.getAll((cmds) => {
  const c = cmds.find((c) => c.name === "toggle-bionic");
  if (c && c.shortcut) {
    shortcut = c.shortcut.replace("MacCtrl", "⌃").replace("MacAlt", "⌥");
    renderFooter();
  }
});
function renderFooter() {
  // 6.6.3: build the footer from DOM nodes, not innerHTML string joins
  footer.textContent = "";
  for (const part of (shortcut ? shortcut.split("+") : [])) {
    const kbd = document.createElement("kbd");
    kbd.textContent = part;
    footer.appendChild(kbd);
    footer.appendChild(document.createTextNode("+"));
  }
  if (shortcut) footer.lastChild.remove(); // drop the trailing "+"
  footer.appendChild(document.createTextNode((shortcut ? " " : "") + "toggles the current page · v" + version));
}
renderFooter();

function render(r) { // { ok, cur, def } from the SW
  if (!r) return;
  cur.checked = !!r.cur;
  def.checked = !!r.def;
  pill.textContent = r.cur ? "ON" : "OFF";
  pill.classList.toggle("on", !!r.cur);
}
function disableRows(text) {
  for (const sw of [cur, def]) {
    sw.disabled = true;
    sw.parentElement.classList.add("disabled");
  }
  pill.textContent = "N/A";
  status.classList.add("show");
  statusText.textContent = text;
  reloadBtn.style.display = "none";
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const ok = tab && tab.id != null && /^https?:/.test(tab.url);
  if (!ok) {
    disableRows(tab && tab.url && tab.url.startsWith("file:")
      ? "Local files are not supported (enable 'Allow access to file URLs' for this extension to support them)."
      : "Bionic Reader can't run on browser pages (chrome://, Web Store).");
    return;
  }
  const tabId = tab.id;
  // one send() helper (6.6.2): every message carries tabId; the SW reply
  // (or nothing, if the SW is gone) drives the switches
  const send = (msg) => {
    chrome.runtime.sendMessage(Object.assign({ tabId }, msg), (r) => {
      if (chrome.runtime.lastError || !r) {
        // the SW is unreachable (e.g. the extension was just reloaded):
        // without this the switches would look dead with no explanation
        render(null);
        status.classList.add("show");
        statusText.textContent = "Extension is not ready. Close and reopen this popup.";
        return;
      }
      render(r);
    });
  };
  send({ bionicGetPopup: true });
  chrome.tabs.sendMessage(tabId, { bionicPing: true }, (r) => {
    if (chrome.runtime.lastError || !r) {
      status.classList.add("show");
      statusText.textContent = "This page was opened before the extension loaded.";
      reloadBtn.style.display = "";
    }
  });
  reloadBtn.addEventListener("click", () => chrome.tabs.reload(tabId));

  cur.addEventListener("change", () => send({ bionicSetCurrent: cur.checked }));
  def.addEventListener("change", () => send({ bionicSetDefault: def.checked }));
});
