// src/bionic.js — Bionic Reading (bold the leading half of each word)
// Rewritten for the browser based on bionic-writer (MIT,
// https://github.com/u8slvn/bionic-writer), a Python/Rust module that
// cannot run in the browser; exposed as a plain `window.bionic` helper.
//
//   bionic.write(text)                -> text with <b>…</b> around the
//                                         first floor(len/2) chars of each word
//   bionic.segments(text)             -> token-level form (used by extract.js
//                                         to build the DOM directly; this is
//                                         what the extension actually runs)
// The HTML-STRING variants (writeHtml / writeHtmlPlain) live in
// src/bionic-html.js — test-only, not shipped in the extension's vendor/.
//
// Only words are touched; punctuation, whitespace and markup are emitted
// verbatim, so textContent is unchanged -> RecogitoJS offsets stay valid.
//
// TWO PASSES in one call, both only MARK positions on the SAME word array;
// <b> tags are inserted exactly ONCE at the end (a word is never bolded twice):
//   Pass 1 (front -> back): bold the first floor(len/2) letters of every long
//     word; W4~W8 skips; apostrophe-joined words bold only the LEFT first letter.
//   Pass 2 (back -> front, W9): a run of three consecutive short plain words
//     (total letters >= 7) gets a first-letter anchor on its MIDDLE word, so a
//     run of short words still yields a reading anchor. Anchors bias to the END
//     of each run (where the reader's eyes are); a consumed triple cannot
//     re-anchor.
// Idempotency (W7): before marking, completed bionic words are re-merged into
// plain words (<b>deci</b>sions -> decisions) and author whole-word bolds are
// protected, so the mark decision depends only on the plain word stream —
// re-running write() / writeHtml() on their own output is a no-op.
//
// Skip rules (BIONIC-RULES.md, W4~W8):
//   W4  all-caps words (>=4, accented É/Ü included) stay plain
//   W5  lowercase-start words with a mid-word capital (iPhone, macOS) stay plain
//   W6  pure symbol / emoji tokens stay plain
//   W7  already-bionic / author-bold words are atomic (idempotent)
//   W8  CJK-majority tokens (Han/Hiragana/Katakana/Hangul >= 50%) stay plain
//   W9  pass 2 (above)
(function () {
  const WORDS = /[\p{L}\p{N}]+|[\s\S]/gu; // \w+|\W|\s, Unicode-aware (accents)
  const MIN_LEN = 4; // words shorter than this stay plain (le/la/de)
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  // W4~W8: should a single word be left plain (not bolded at all)?
  function shouldSkip(word) {
    const chars = [...word];
    if (!/[\p{L}]/u.test(word)) return true;                                      // W6 symbols/emoji
    if (/^[\p{Lu}\p{N}][\p{Lu}\p{N}\-'.]*$/u.test(word) &&                       // W4 all-caps
        /[\p{Lu}]/u.test(word) && chars.length >= MIN_LEN) return true;
    if (/^[\p{Ll}]/u.test(word) && /[\p{Lu}]/u.test(word.slice(1))) return true; // W5 mid-capital
    const cjk = word.match(CJK);
    if (cjk && cjk.length >= chars.length / 2) return true;                        // W8 CJK-majority
    return false;
  }
  // The two passes + single apply, on plain text (no tags).
  // Token-level form (used by extract.js to build the DOM directly — page
  // text never goes back through the HTML parser):
  //   segments(text) -> { tokens: [{ text, bold: null | { head, tail } }],
  //                       spans: [[i0, i1], ...] }
  //   tokens: one entry per WORDS match (word or single non-word char);
  //           bold = the head/tail split for words that get a <b>
  //   spans:  token ranges to wrap in one nowrap span — the bolded word plus,
  //           for an apostrophe join, the ' + the (plain) right word
  function segments(text) {
    WORDS.lastIndex = 0;
    const w = []; let m;
    while ((m = WORDS.exec(text))) w.push(m[0]);
    const n = w.length;
    // 6.3.2: one isWord pass per token — cpLen[i] > 0 already means "word",
    // so the loops below test the array, not the regex, every time.
    const isWord = new Array(n);
    const cpLen = new Array(n);
    for (let i = 0; i < n; i++) {
      isWord[i] = /^[\p{L}\p{N}]+$/u.test(w[i]);
      cpLen[i] = isWord[i] ? [...w[i]].length : 0;
    }
    // mark[i]: 0 none · 1 first-letter bold · 2 first-half bold · 3 left plain
    const mark = new Array(n).fill(0);
    // ── Pass 1 (front -> back): apostrophe joins + long-word bolding ──────────
    // Apostrophe joins (left word + ' + right word): bold ONLY the first letter
    // of the LEFT word. Triggers: 1+3 / 2+2 / 3+1 (c'est, don't, we've) and
    // 2+3 / 3+2 (you're, you'll) — total 4 or 5, no side shorter than 2 in the
    // 5 case (keeps 1+4 / 4+1 plain).
    for (let i = 1; i < n - 1; i++) {
      if ((w[i] === "'" || w[i] === "\u2019") && isWord[i - 1] && isWord[i + 1]) {
        const l = cpLen[i - 1], r = cpLen[i + 1];
        if ((l + r === 4 || (l + r === 5 && l >= 2 && r >= 2)) &&
            mark[i - 1] === 0 && mark[i + 1] === 0) { mark[i - 1] = 1; mark[i + 1] = 3; }
      }
    }
    for (let i = 0; i < n; i++) {
      if (mark[i] !== 0 || !isWord[i] || cpLen[i] < MIN_LEN || shouldSkip(w[i])) continue;
      mark[i] = 2;
    }
    // ── Pass 2 (W9, back -> front): short-run middle anchor ──────────────────
    // Three ADJACENT words in the word stream (spaces are separate tokens).
    const ws = [];
    for (let i = 0; i < n; i++) if (isWord[i]) ws.push(i);
    const free = j => mark[j] === 0 && cpLen[j] < MIN_LEN;
    for (let k = ws.length - 3; k >= 0; k--) {
      const a = ws[k], b = ws[k + 1], c = ws[k + 2];
      if (free(a) && free(b) && free(c) && cpLen[a] + cpLen[b] + cpLen[c] >= 7) {
        mark[b] = 1;
        mark[a] = mark[c] = 3; // consume the triple (no overlapping anchors)
        k -= 2;
      }
    }
    // ── Apply (once): one <b> per marked word; nowrap span = the bolded
    // word, or for an apostrophe join (mark[i]=1, w[i+1]=', mark[i+2]=3) the
    // whole left word + ' + right word so it never breaks at the apostrophe ──
    const tokens = new Array(n);
    const spans = [];
    for (let i = 0; i < n; i++) {
      if (mark[i] === 0 || mark[i] === 3) { tokens[i] = { text: w[i], bold: null }; continue; } // 3 = left plain (consumed)
      const c = [...w[i]];
      const firstLetterOnly = mark[i] === 1 || c.length === MIN_LEN;
      const cut = firstLetterOnly ? 1 : Math.floor(c.length / 2);
      tokens[i] = { text: w[i], bold: { head: c.slice(0, cut).join(""), tail: c.slice(cut).join("") } };
      const joined = mark[i] === 1 && i + 2 < n &&
        (w[i + 1] === "'" || w[i + 1] === "\u2019") && mark[i + 2] === 3;
      spans.push([i, joined ? i + 2 : i]);
    }
    return { tokens, spans };
  }

  function write(text) {
    const { tokens } = segments(text);
    return tokens.map((t) => t.bold
      ? "<b>" + t.bold.head + "</b>" + t.bold.tail
      : t.text).join("");
  }

  // writeHtml / writeHtmlPlain are attached by src/bionic-html.js
  window.bionic = { MIN_LEN, segments, write };
})();
