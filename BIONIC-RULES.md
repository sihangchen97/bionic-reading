# Bionic Reading Rules — what this project does, and why

A one-page summary of the current rule set, so a reader can understand the
behavior of the extension without reading the source (rule tables W1–W10,
E1–E8). This file is the current reference; the original design doc
(`PLAN-bionic-chrome-extension.md`) and work tracker (`IMPROVEMENT-PLAN.md`)
were moved to `_tobedelete/` on 2026-11-07.

## The core transform

For every word in a page's body text, bold the **first `floor(len/2)`
letters**; the rest of the word stays plain. `bi**on**ic` →
`<b>bio</b>nic`. This gives the eye an anchor; peripheral vision finishes
the word.

- `MIN_LEN = 4` — words shorter than 4 letters stay plain (W3: `the`,
  `and`, `le`…). Short words bolded are pure visual noise.
- Apostrophe joins (`don't`, `c'est`, `you'll`): bold **only the first
  letter of the left word**, and wrap the whole `left + ' + right` in one
  `nowrap` span so it never breaks at the apostrophe.
- Punctuation, whitespace and markup pass through untouched. `textContent`
  is **never changed** — annotation offsets (e.g. RecogitoJS) stay valid.

## Word-level skip rules (W1–W10)

Decided per word, in `src/bionic.js` (`shouldSkip` + the two marking passes):

| # | Rule | Example left plain | Why |
|---|---|---|---|
| W1 | whitespace / single punctuation | `(`, `.` | not words |
| W2 | pure digits | `42` | bolding numbers is noise |
| W3 | length `< 4` | `the`, `a` | visual noise |
| W4 | all-caps, len ≥ 4 (accents count: `ÉLAN`) | `NASA`, `GPU`, `OK` | looks like emphasis, misleads |
| W5 | lowercase start + mid-word capital | `iPhone`, `macOS` | product/framework names |
| W6 | no letters at all (symbols/emoji) | `🎉`, `---` | not readable text |
| W7 | already bionic / author's whole-word bold | `<b>deci</b>sions`, author `<b>term</b>` | idempotency — re-running is a no-op |
| W8 | CJK ≥ 50% of the token | `这是一个中文段落` | CJK has no word-initial anchor |
| W9 | — short-run anchor (see below) | | |
| W10 | text directly inside a `flex` / `inline-flex` / `grid` parent | | splitting such text drops inter-item whitespace → "SupporttheAlumni" |

W4/W5 are per-**word**, not per-paragraph: `The GPU temperature was OK.`
bolds only `temp`erature, leaving `GPU`/`OK` plain.

**W9 (second pass):** a run of three *consecutive short plain* words (each
`< 4` letters, total letters ≥ 7) gets a first-letter anchor on its
**middle** word — `**t**he of and`. The two passes only mark positions on
one word array; `<b>` tags are inserted once, at the end, so no word is
ever bolded twice. The anchor biases toward the end of the run (where the
reader's eyes are), and a consumed triple cannot re-anchor (no overlaps).

## Element-level skip rules (E1–E8)

Decided per host block, in `src/extract.js` (`isSkipped` +
`SKIP_SELECTOR` / `PROTECTED_SELECTOR`). A block matching any rule is left
completely plain:

| # | Rule | Selector / check | Why |
|---|---|---|---|
| E1 | interactive/editable regions | `textarea`, `input`, `select`, `[contenteditable]`, `button` (descendants), `notranslate` class, `translate="no"`, shadow-DOM skip tables | not reading flow |
| E2/E3 | code & math | block containing `code`, `pre`, `kbd`, `math`, `.katex`, `.MathJax`, `.math-block`, `.mwe-math-element` | bolding code/formulas is noise |
| E4 | navigation & chrome | `nav`, `footer`, `aside`, `.social-share`, `.share-nav`, `.post__footer`, `.menu` — checked via `closest()`, so content *nested inside* a footer/aside is also plain | structure, not body text |
| E5 | invisible elements | `display:none`, `visibility:hidden`, `opacity:0`, zero size, no `offsetParent` | can't be read anyway |
| E6 | already-processed hosts | `data-bionic-applied="1"` marker | idempotency |
| E7 | headings | `h1–h6`, any ancestor | headings are scan targets, not reading flow |
| E8 | CJK-majority blocks | CJK chars > 50% of all letters (only for blocks with ≥ 8 letters) | W8 handles CJK runs; E8 kills mixed CJK blocks whole |

## DOM invariants (the easy-to-break part)

- Bolding happens at the **text-node level**, never by rewriting a host's
  `innerHTML` — a host can be a large live container (iframes, players,
  inputs).
- Every `<b>` we create carries `data-bionic`; each bolded word sits inside
  `<span data-brw="1" style="white-space:nowrap">` so lines can't break
  mid-word.
- Text inside a `data-brw` span, or inside the page's own `b/strong/mark`,
  is never re-processed (W7 at word level).
- Processed hosts get `data-bionic-applied="1"`.
- `clear()` unwraps all `data-brw` spans, then `normalize()`s the host so
  split text nodes merge back — otherwise the next scan would treat word
  halves as separate words.
- Bionicing is **idempotent**: `write()` on its own output is a no-op.
  This is done by re-merging completed bionic words into plain words
  (`<b>deci</b>sions` → `decisions`) *before* the marking pass, and by
  freezing author whole-word bolds with a placeholder.

## Paragraph extraction (how a "piece" is found)

`getPieces()` (ported from old-immersive-translate, MPL-2.0) walks the DOM
with three tag tables:

- **inline text tags** (`span`, `a`, `b`, `em`, …) — walked into, text
  stays in the current piece;
- **block/code tags** (`div`, `p`, plus `br`, `code`, `kbd`, `pre`, `wbr`)
  — split the piece;
- **no-translate tags** (`title`, `script`, `style`, `textarea`, `svg`) —
  subtree skipped.

A piece over 1000 characters is split into several pieces **with the same
host**; `scan()` gathers all text nodes per host, runs the guards
(visibility, `isSkipped`) on all hosts first, then writes — and on very
long pages it does this in idle chunks that a `generation` counter lets
`clear()` cancel mid-flight.

## Where the rules live

| Layer | File | Rules |
|---|---|---|
| algorithm (pure, browser-agnostic) | [`src/bionic.js`](src/bionic.js) | W1–W9 |
| extraction + DOM application | [`src/extract.js`](src/extract.js) (MPL-2.0) | E1–E8, W10 |
| HTML-string variants (test-only) | [`src/bionic-html.js`](src/bionic-html.js) | W7 re-merge |
| tests | [`tests/`](tests/) | `bionic.test.js` (algorithm), `extract.test.js` (blocks/scan), `extension.test.js` (glue) |

`chrome-extension/vendor/` is a **generated copy** of `src/bionic.js` and
`src/extract.js` (via `scripts/sync.sh`) — never edit it directly.
