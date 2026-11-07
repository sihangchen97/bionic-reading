# Bionic Reader

An implementation of [Bionic Reading](https://www.bionic-reading.com/). The core in `src/` is a plain, browser-agnostic library; the current product built on it is the Manifest V3 Chrome extension in `chrome-extension/`.

## What is bionic reading?

Bionic reading was developed by Renato Casuot. The idea: when you read, your eyes don't take in every letter — they make a few short **fixation points** per word and the brain completes the rest. If a word can't be "completed" easily, your eye moves on and reading slows down.

Bionic reading implements this by adding artificial fixation points — the bold leading letters — so your eye lands on the bold part and your peripheral vision fills in the rest without extra eye movements.

> **Bio**nic **rea**ding is **qui**etly **dif**ferent from **reg**ular text.

Compared with the original product (a paid web service), this implementation is unbranded, privacy-friendly and offline: it runs entirely in your browser, on any page, with no server in the loop.

The full rule set (word-level rules W1–W10, element-level rules E1–E8, DOM invariants) is documented in [`BIONIC-RULES.md`](BIONIC-RULES.md).

## Install (developer mode)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this repo's `chrome-extension/` directory
3. **Reload the pages you already had open** — content scripts only inject into tabs opened *after* the extension loads. If the popup shows "This page was opened before the extension loaded", use its Reload button.

## Using it

- Toolbar badge: `ON` / `OFF` per tab.
- Popup: two switches — **Current page** (this tab's state, per-tab) and **On by default** (new pages start bolded; a tab that has its own explicit choice keeps it).
- **Alt+B** (⌥B on macOS) toggles the current page from anywhere. It's a manifest command — rebind it at `chrome://extensions/shortcuts`. The popup footer shows the actual binding.
- Doesn't run on `chrome://` / Web Store pages, and not on local files unless you enable "Allow access to file URLs".

## Development

```sh
npm install        # jsdom (test-only)
npm test           # vendor check + all test suites (node:test)
bash scripts/sync.sh   # src/*.js -> chrome-extension/vendor/ + integrity check
node scripts/bench.js  # scan() timing on synthetic pages
git config core.hooksPath scripts/hooks   # one-time: pre-commit runs sync.sh
```

- **Single source of truth:** `src/bionic.js` (the algorithm) and `src/extract.js` (paragraph extraction + guards). `chrome-extension/vendor/` is a **generated copy** — never edit it by hand; edit `src/` and run `sync.sh` (the pre-commit hook does this automatically).
- After changing `chrome-extension/` code: reload the extension in `chrome://extensions`, then reload the page. The page console logs the running extension version (`[bionic-reader] content script loaded, version 0.1.0`).
- `CLAUDE.md` holds the architecture and DOM-mutation invariants for contributors and AI assistants.

## License

MIT — except [`src/extract.js`](src/extract.js), which is **MPL-2.0** because it ports code from [old-immersive-translate](https://github.com/immersive-translate/old-immersive-translate) (marked line-by-line with `[OLD: …]` / `[NEW]` tags). See `LICENSE` for the precise per-file rules.
