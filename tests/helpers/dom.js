// tests/helpers/dom.js — shared jsdom setup.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

// jsdom performs no layout: stub the offset props to mean "visible unless
// display:none" (visible() in extract.js reads them + getComputedStyle).
function stubLayout(win) {
  const hidden = (el) => el.style && el.style.display === "none";
  for (const [prop, val] of [
    ["offsetWidth", (el) => (hidden(el) ? 0 : 120)],
    ["offsetHeight", (el) => (hidden(el) ? 0 : 48)],
    ["offsetParent", (el) => (hidden(el) ? null : win.document.body)],
  ]) {
    Object.defineProperty(win.HTMLElement.prototype, prop, { configurable: true, get() { return val(this); } });
  }
}

// A page with src/bionic.js + src/extract.js loaded.
function makeDom(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, { runScripts: "outside-only" });
  const win = dom.window;
  stubLayout(win);
  win.eval(read("src/bionic.js"));
  win.eval(read("src/extract.js"));
  return { dom, win, doc: win.document, X: win.bionicExtract };
}

// jsdom has no requestIdleCallback, so long scans continue in setTimeout(16)
// chunks; tests wait for those with this.
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, read, stubLayout, makeDom, wait };
