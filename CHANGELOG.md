# Changelog

## v0.1.0 — 2026-11-07

Initial release.

- Bionic reading implementation for web text: bolds the leading half of each word in a page's body text.
- Core library in `src/` (browser-agnostic): word-level rules W1–W10, element-level rules E1–E8 (see `BIONIC-RULES.md`).
- Manifest V3 Chrome extension in `chrome-extension/`: per-tab toggle (Alt+B), on-by-default, service worker owns all `chrome.storage`.
- Documentation: `README.md`, `BIONIC-RULES.md`, `CLAUDE.md`.
- Test suite: 120 tests via `node:test` + jsdom.
