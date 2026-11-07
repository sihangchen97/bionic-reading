// src/bionic-html.js — HTML-STRING variants of the bionic writer:
//   bionic.writeHtml(html)       -> <b>…</b> around the first floor(len/2)
//                                  chars of each word in every text part
//   bionic.writeHtmlPlain(html)  -> same with <strong>
// Kept for the W7 idempotency tests; the extension uses segments() only and
// does NOT ship this file (scripts/sync.sh excludes it from vendor/).
// Needs window.bionic (src/bionic.js) to be loaded first.
(function () {
  const { write } = window.bionic;
  // A completed bionic word (<b>head</b>tail, tail may be empty) OR an author's
  // whole-word bold (<b>word</b>, no word-char tail). Lookbehind: must START a
  // word (not preceded by a letter/digit), so mid-word emphasis (hel<b>lo</b>)
  // is NOT matched and is re-processed normally.
  const BOLD_WORD = /(?<![\p{L}\p{N}])<(b|strong)>([\p{L}\p{N}]+)<\/\1>([\p{L}\p{N}]*)/gu;
  // ── Idempotency (W7): re-merge completed bionic words across the WHOLE html
  // BEFORE tag-masking splits them (the mask would cut "<b>deci</b>sions" into
  // "<b>" | "deci" | "</b>" | "sions" and re-bold each half again); protect
  // author whole-word bolds (no word-char tail) with a \x02 placeholder. ──────
  function remerge(html) {
    BOLD_WORD.lastIndex = 0;
    const frozen = [];
    const text = html.replace(BOLD_WORD, (m, tag, head, tail) =>
      tail ? head + tail : (frozen.push(m), "\x02"));
    return { text, frozen };
  }
  function unmerge(text, frozen) {
    return frozen.length ? text.replace(/\x02/g, () => frozen.shift()) : text;
  }
  // apply to text nodes only; keep every tag (paragraph structure) intact
  function writeHtml(html, tag) {
    const open = "<" + tag + ">", close = "</" + tag + ">";
    const { text, frozen } = remerge(html);
    const out = text
      .replace(/(<[^>]*>)/g, t => "\x00" + t + "\x01")
      .split(/(\x00[^]*?\x01)/)
      .map(part => /^\x00/.test(part)
        ? part.slice(1, -1)
        : write(part).replace(/<b>/g, open).replace(/<\/b>/g, close))
      .join("");
    return unmerge(out, frozen);
  }
  window.bionic.writeHtml = (h) => writeHtml(h, "b");
  window.bionic.writeHtmlPlain = (h) => writeHtml(h, "strong");
})();
