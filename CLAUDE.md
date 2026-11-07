# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension ("Bionic Reader") that bolds the leading half of each word in a page's body text. Headings, code, math, nav/footer/aside, share buttons, and CJK text are deliberately left untouched. No build step, no bundler — plain JS loaded directly by Chrome. `package.json` exists for the jsdom test dependency and the `npm test` script only.

## Commands

```sh
npm install                                  # jsdom (test-only, devDependency)
npm test                                     # sync --check, then every tests/*.test.js via node:test
node --test tests/bionic.test.js             # one suite (also: extract, extension)
node --test --test-name-pattern="flex"       # tests whose name matches
./scripts/sync.sh                            # copy src/bionic.js + src/extract.js -> chrome-extension/vendor/ and verify
./scripts/sync.sh --check                    # compare only, no copy — run first by `npm test`
node scripts/bench.js                        # scan() timing: synthetic 3000-paragraph page
git config core.hooksPath scripts/hooks      # one-time: enable the pre-commit sync hook
```

There is no lint config. Alt+B is a **manifest command** (`toggle-bionic` in `manifest.json`), handled by the service worker — the content script has NO keydown listener (a second one would double-toggle).

Manual check: load `chrome-extension/` via `chrome://extensions` → Developer mode → Load unpacked. After changing extension code, click reload on the extension card **and** reload the page (already-open tabs don't get the new content script; the popup then offers a Reload button). The page console logs the running build — `[bionic-reader] content script loaded, version X.Y.Z` (the manifest version, single source of truth; bump `manifest.json` `version` when behavior changes).

## Architecture

Two layers, with a hard boundary between them:

**Generic layer — `src/` (single source of truth, browser-agnostic)**
- `src/bionic.js` → `window.bionic` (`write`, `segments`). Pure string transform, rewritten for the browser based on `bionic-writer` (Rust, MIT). Two passes over one word array; `<b>` inserted once at the end. `segments(text)` is the token-level form extract.js uses to build the DOM directly (page text never goes back through the HTML parser). Skip rules are numbered **W4–W10** (all-caps, mid-capital like `iPhone`, symbols/emoji, idempotency, CJK-majority, short-word-run anchors, flex hosts) and referenced by those IDs in comments, tests and commit messages. Must be idempotent: running `write()` on its own output is a no-op.
- `src/bionic-html.js` → `window.bionic.writeHtml` / `writeHtmlPlain` (the HTML-STRING variants, incl. the W7 re-merge). Test-only: NOT copied into `vendor/` and not loaded by the extension.
- `src/extract.js` → `window.bionicExtract` (`getPieces`, `scan`, `clear`, …). `getPieces` is a port of `getAllNodes` from old-immersive-translate (**MPL-2.0** — this file alone is MPL; the rest of the repo is MIT). Ported code is tagged `[OLD: pageTranslator.js:N]`, our additions `[NEW]`; keep that tagging when editing. Element-level skip rules are numbered **E1–E8** (see `isSkipped`, `SKIP_SELECTOR`, `PROTECTED_SELECTOR`). `scan()` groups all text nodes per host (a >1000-char block is split into several pieces with the SAME host) and runs long pages in idle chunks; a `generation` counter lets `clear()` cancel in-flight chunks (R2).
- `scripts/sync.sh` fails if anything in `src/` references `chrome.*` / `browser.*` APIs; `--check` mode (compare only) runs first in `npm test`.

**Chrome glue — `chrome-extension/`**
- `vendor/` is a **generated copy** of `src/` — never edit it by hand; edit `src/` and run `sync.sh` (the pre-commit hook does this and stages `vendor/`).
- `content.js`: thin glue — state via runtime messages only, a debounced `MutationObserver` for SPA updates (batched across observer calls; added nodes that are, or descend from, our own `span[data-brw]` / `b[data-bionic]` are FILTERED out — R3), an orphan self-destruct when `chrome.runtime.id` disappears (extension reload under a live tab), and a `window.__bionicReader` guard so a tab never runs two live copies.
- `background.js` (service worker) is the **only** code that touches `chrome.storage`, because some pages block content scripts (and some extension UI contexts) from storage access. Message protocol (async dispatch table in `background.js`): content → `bionicGetState` (its tab = `sender.tab`); popup → `bionicGetPopup` / `bionicSetCurrent` / `bionicSetDefault` (the popup resolves its OWN active tab with `chrome.tabs.query({active:true, currentWindow:true})` and sends `tabId` — `MessageSender` has **no** `windowId`, the SW must not guess). Handlers `await` their write before reading the state they reply with (R5), so writes reply `{ ok, cur, def }` and the popup can confirm instead of guessing. SW → web tabs `{ bionic: bool }`, always each tab's *own* computed state — narrowed `storage.onChanged`: a per-tab change syncs ONLY that tab, a default change syncs all web tabs. The Alt+B manifest command flips the active web tab's state in the SW. Per-tab override lives in `storage.session["bionic-tab-<tabId>"]` (composite keys, since session storage has no per-tab API; cleaned on `tabs.onRemoved`); the global default in `storage.local["bionic-default-enabled"]` (default off) and affects **only tabs with no explicit override**. `content_scripts.matches` is `http(s)`-only (file:// needs 'Allow access to file URLs').
- `popup.html` / `popup.js`: status pill (ON/OFF/N-A), two whole-row-label switches, a "page not ready" banner with a Reload button (the tab is pinged with `bionicPing`; no live content script → show it), a footer showing the actual shortcut binding (`chrome.commands.getAll`) and the manifest version.

## DOM-mutation invariants (easy to break)

- Bolding happens at the **text-node level**, never by rewriting a host's `innerHTML` (hosts can be large containers holding iframes, players, inputs).
- Every `<b>` we create carries `data-bionic`, and each bolded word is wrapped in `<span data-brw="1" style="white-space:nowrap">` so lines can't break mid-word. Text already inside a `data-brw` span, or inside the page's own `b/strong/mark`, is never re-processed.
- Processed hosts get `data-bionic-applied="1"` (idempotency marker). `clear()` unwraps all `data-brw` spans in scope, then `normalize()`s the host so split text nodes merge back — otherwise the next `scan()` would treat word halves as separate words.
- Text directly inside `flex`/`inline-flex`/`grid` parents is skipped (W10): splitting it drops inter-item whitespace.
- `textContent` must be unchanged by bionicing; tests assert no lost spaces/words.

## Tests

Node's built-in `node:test` + `node:assert`, one file per subject, test names describe behavior (not bug IDs):
- `tests/bionic.test.js` — the algorithm (word bolding, apostrophes, skip rules W4–W9, idempotency).
- `tests/extract.test.js` — which blocks get bolded (E1–E8, W10), scan/clear round-trips, split blocks, chunked long-page scans, whitespace.
- `tests/extension.test.js` — popup, service worker and content script against a mocked chrome API.
- `tests/helpers/` — `dom.js` (jsdom + layout stubs), `extension.js` (chrome mock that runs the real glue code).

**Never commit saved copies of real web pages** (privacy): write a small inline HTML snippet with invented text that reproduces the structure instead.

## Reference material

`BIONIC-RULES.md` is the current rule reference (W1–W10, E1–E8, DOM invariants). The original design doc (`PLAN-bionic-chrome-extension.md`) and work tracker (`IMPROVEMENT-PLAN.md`) were moved to `_tobedelete/` (2026-11-07); that directory is **not tracked and not gitignored** — never `git add` it (add it to `.gitignore` if you want the protection). The `[OLD: …]`-tagged code in `src/extract.js` was ported from the MPL-2.0 upstream `https://github.com/immersive-translate/old-immersive-translate` (`src/contentScript/pageTranslator.js`); if you need to diff against the source, clone it somewhere **outside** the repo (e.g. `~/refs/old-immersive-translate`) so the checkout is not accidentally committed.
