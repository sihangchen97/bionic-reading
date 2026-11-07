// src/extract.js — paragraph extraction + bionic application.
//
// ═══════════════════════════════════════════════════════════════════════════════
// LICENSE (file-scoped: Modifications of Covered Software stay under
// MPL-2.0 per §1.4; the rest of the repo is the Larger Work per §3.3)
// ───────────────────────────────────────────────────────────────────────────────
// This file is licensed under the Mozilla Public License 2.0 (MPL-2.0)
// because it contains code ported from:
//
//   https://github.com/immersive-translate/old-immersive-translate
//   file: src/contentScript/pageTranslator.js
//
// The ported ranges are marked below with  [OLD: line N]  tags. Those parts
// are (C) their original authors and remain under MPL-2.0. The surrounding
// glue that this file adds for Bionic Reading is our own work and is marked
// [NEW]. The rest of the repository is MIT — see the root LICENSE.
//
// Attribution:
//   old-immersive-translate (a.k.a. "translate-web-pages"), MPL-2.0,
//   license at https://github.com/immersive-translate/old-immersive-translate/blob/main/LICENSE.
// ═══════════════════════════════════════════════════════════════════════════════
//
// Depends on src/bionic.js (window.bionic). Exposes window.bionicExtract:
//   bionicExtract.getPieces(root)  -> [{ parentElement, topElement, bottomElement, nodes }]
//   bionicExtract.scan(root)       -> apply bionic to every eligible piece
//   bionicExtract.clear(root)      -> remove our <b> tags + markers
(function () {
  // ── [OLD: pageTranslator.js:225-227] tag classification tables ────────────
  // Inline tags that KEEP the text inside the current piece (do not split).
  const htmlTagsInlineText = ['#text', 'A', 'ABBR', 'ACRONYM', 'B', 'BDO', 'BIG', 'CITE', 'DFN', 'EM', 'I', 'LABEL', 'Q', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U', 'TT', 'VAR'];
  // [OLD: pageTranslator.js:226] Block-ish / code tags that START A NEW piece.
  // CODE, KBD, WBR, BR break a paragraph; PRE likewise (we never translate
  // code, so PRE stays in the ignore list — [NEW] decision, matches the
  // old default when translateTag_pre != "yes": pageTranslator.js:241-243).
  const htmlTagsInlineIgnore = ['BR', 'CODE', 'KBD', 'WBR', 'PRE'];
  // [OLD: pageTranslator.js:227] Elements whose whole subtree is skipped.
  const htmlTagsNoTranslate = ['TITLE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'SVG', 'svg'];

  const MARK = 'data-bionic-applied'; // [NEW] idempotency marker (E6)
  const MAX_PIECE_CHARS = 1000;       // [OLD: pageTranslator.js:508] per-piece size cap

  // [NEW] extra skip signals layered on top of the old tables (E1~E8, see BIONIC-RULES.md).
  // These are our own additions, not from the old repo.
  // note: aside is skipped (site sidebars, e.g. a right-hand menu, are narrow
  // link columns, not body text); a content <aside> with real prose is the only
  // case this is too aggressive.
  const SKIP_SELECTOR = 'nav, footer, .social-share, .share-nav, .post__footer, aside, .menu, '
    + 'h1, h2, h3, h4, h5, h6, [contenteditable="true"], [contenteditable=""], button';
  // [NEW] host-level math guard only. The piece walk already excludes
  // code/pre/kbd text (they are in htmlTagsInlineIgnore and never collected
  // into a piece), so they need no host-level skip; only math — which the walk
  // DOES descend into — does. (The old code/pre/kbd here were redundant and
  // over-skipped whole paragraphs that merely embed inline code.)
  const PROTECTED_SELECTOR = 'math, .katex, .MathJax, .math-block, .mwe-math-element';

  // ── [NEW] visibility + CJK helpers (E5 / E8) ───────────────────────────────
  function visible(el) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    const cs = window.getComputedStyle(el);
    // position:fixed elements have offsetParent === null but are still visible
    if (cs.position !== 'fixed' && el.offsetParent === null) return false;
    return !(cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0');
  }
  const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu;
  function isCJKMajority(el) {
    const text = el.textContent || '';
    const letters = text.match(/\p{L}/gu);
    if (!letters || letters.length < 8) return false; // tiny: let token-level W8 decide
    const cjk = text.match(CJK);
    return !!cjk && cjk.length > letters.length / 2;
  }
  // ── [OLD: pageTranslator.js:394-535] getAllNodes -> getPieces ──────────────
  // Ported 1:1 from the old repo's getAllNodes (the "find every translatable
  // text block" walk). Signature adapted: takes `root`, returns pieces.
  function getPieces(root = document.body) {
    // [NEW] one constructor for the five piece literals below (6.2.4)
    const newPiece = (top = null) => ({ parentElement: null, topElement: top, bottomElement: null, nodes: [] });
    const pieces = [newPiece()];
    let index = 0;
    let currentParagraphSize = 0;

    // [OLD: pageTranslator.js:405]
    const getAllNodes = function (node, lastHTMLElement = null, lastSelectOrDataListElement = null) {
      if (node.nodeType == 1 || node.nodeType == 11) {
        if (node.nodeType == 11) {
          // [OLD: pageTranslator.js:407-408] shadow root -> its host
          lastHTMLElement = node.host;
          lastSelectOrDataListElement = null;
        } else if (node.nodeType == 1) {
          lastHTMLElement = node;
          // [OLD: pageTranslator.js:412] SELECT/DATALIST remembered for OPTION text
          if (node.nodeName === 'SELECT' || node.nodeName === 'DATALIST') lastSelectOrDataListElement = node;
          // [OLD: pageTranslator.js:414-418] skip: inline-ignore / no-translate /
          // notranslate class / translate="no" / editable
          if (htmlTagsInlineIgnore.indexOf(node.nodeName) !== -1 ||
            htmlTagsNoTranslate.indexOf(node.nodeName) !== -1 ||
            node.classList.contains('notranslate') ||
            node.getAttribute('translate') === 'no' ||
            node.isContentEditable) {
            if (pieces[index].nodes.length > 0) {
              currentParagraphSize = 0;
              pieces[index].bottomElement = lastHTMLElement;
              pieces.push(newPiece());
              index++;
            }
            return;
          }
        }

        function getAllChilds(childNodes) {
          Array.from(childNodes).forEach((_node) => {
            if (_node.nodeType == 1) {
              lastHTMLElement = _node;
              if (_node.nodeName === 'SELECT' || _node.nodeName === 'DATALIST') lastSelectOrDataListElement = _node;
            }
            // [OLD: pageTranslator.js:442-453] a non-inline child splits the piece
            if (htmlTagsInlineText.indexOf(_node.nodeName) == -1) {
              if (pieces[index].nodes.length > 0) {
                currentParagraphSize = 0;
                pieces[index].bottomElement = lastHTMLElement;
                pieces.push(newPiece());
                index++;
              }
              getAllNodes(_node, lastHTMLElement, lastSelectOrDataListElement);
              if (pieces[index].nodes.length > 0) {
                currentParagraphSize = 0;
                pieces[index].bottomElement = lastHTMLElement;
                pieces.push(newPiece());
                index++;
              }
            } else {
              // [OLD: pageTranslator.js:471-472] inline child: keep walking into it
              getAllNodes(_node, lastHTMLElement, lastSelectOrDataListElement);
            }
          });
        }

        getAllChilds(node.childNodes);
        // [OLD: pageTranslator.js:478-480] close out bottomElement
        if (!pieces[index].bottomElement) pieces[index].bottomElement = node;
        // [OLD: pageTranslator.js:481-486] also walk an open shadowRoot
        if (node.shadowRoot) {
          getAllChilds(node.shadowRoot.childNodes);
          if (!pieces[index].bottomElement) pieces[index].bottomElement = node;
        }
      } else if (node.nodeType == 3) {
        // [OLD: pageTranslator.js:487-525] text node -> append to current piece
        if (node.textContent.trim().length > 0) {
          if (!pieces[index].parentElement) {
            if (node && node.parentNode && node.parentNode.nodeName === 'OPTION' && lastSelectOrDataListElement) {
              // [OLD: pageTranslator.js:490-492] OPTION text belongs to its SELECT
              pieces[index].parentElement = lastSelectOrDataListElement;
              pieces[index].bottomElement = lastSelectOrDataListElement;
              pieces[index].topElement = lastSelectOrDataListElement;
            } else {
              // [OLD: pageTranslator.js:495-503] climb to the enclosing block
              let temp = node.parentNode;
              while (temp && temp != root && (htmlTagsInlineText.indexOf(temp.nodeName) != -1 || htmlTagsInlineIgnore.indexOf(temp.nodeName) != -1)) {
                temp = temp.parentNode;
              }
              if (temp && temp.nodeType === 11) temp = temp.host;
              pieces[index].parentElement = temp;
            }
          }
          if (!pieces[index].topElement) pieces[index].topElement = lastHTMLElement;
          // [OLD: pageTranslator.js:508-521] oversized piece -> start a new one
          if (currentParagraphSize > MAX_PIECE_CHARS) {
            currentParagraphSize = 0;
            pieces[index].bottomElement = lastHTMLElement;
            const pieceInfo = newPiece(lastHTMLElement);
            pieceInfo.parentElement = pieces[index].parentElement;
            pieces.push(pieceInfo);
            index++;
          }
          currentParagraphSize += node.textContent.length;
          pieces[index].nodes.push(node);
          pieces[index].bottomElement = null;
        }
      }
    };

    // [OLD: pageTranslator.js:528-535]
    getAllNodes(root);
    if (pieces.length > 0 && pieces[pieces.length - 1].nodes.length == 0) pieces.pop();
    return pieces;
  }

  // ── [NEW] guard for a host block (the old walk splits at CODE/PRE/etc, so a
  // piece's host may still contain code/math as siblings — E2/E3) ─────────────
  function isSkipped(host) {
    if (host.hasAttribute(MARK)) return true;                  // E6 idempotency
    if (host.closest && host.closest(SKIP_SELECTOR)) return true; // E1/E4/E7 (ours): the block ITSELF or any ancestor (content nested inside <footer>/<aside>/<nav> stays plain)
    if (!host.matches('article, section, main') &&
        host.querySelector(PROTECTED_SELECTOR)) return true;   // E2/E3 math (code/pre/kbd excluded at the piece level)
    if (!visible(host)) return true;                           // E5
    if (isCJKMajority(host)) return true;                      // E8
    return false;
  }

  // Bionic at the TEXT-NODE level (like the old repo / IT do), NOT by
  // rewriting host.innerHTML: many pieces' host is a big container (even
  // <body>), and re-serializing its whole innerHTML would destroy live page
  // state (iframes, video players, inputs, the user's controls).
  const OUR_B = 'data-bionic'; // tags <b> elements we create, so clear() never
                                // unwraps a page's own author <b>
  // 2.1: style reads force layout; cache each parent's display once so a scan
  // of a long page does one layout flush, not one per text node.
  const FLEX_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);
  // 6.2.7: the display cache is PER SCAN (created in scan(), closed over by
  // bionicText below) — a module-wide cache would keep an old display after a
  // responsive layout change, so a block that became flex could still split.
  let displayCache = new WeakMap();
  function displayOf(p) {
    let d = displayCache.get(p);
    if (d === undefined) { d = getComputedStyle(p).display; displayCache.set(p, d); }
    return d;
  }
  function bionicText(tn) {
    // leave text already wrapped in the page's own bold/emphasis alone
    if (tn.parentElement && tn.parentElement.matches('b, strong, mark')) return;
    // W7 word-level: a node inside one of OUR nowrap word spans is the bolded
    // half or the plain SUFFIX of a completed bionic word — bionicing the
    // suffix again ("<b>acce</b>lerate" -> "<b>acce</b><b>le</b>rate") is the
    // "word bolded in two passes" bug; freeze it.
    if (tn.parentElement && tn.parentElement.hasAttribute && tn.parentElement.hasAttribute('data-brw')) return;
    // W10 flex: a flex/inline-flex/grid container DROPS the whitespace text
    // nodes between its items, so splitting this node into segments (even a
    // lone <b>) renders "SupporttheAlumniAppeal" — leave flex text alone.
    const p = tn.parentElement;
    if (p && FLEX_DISPLAYS.has(displayOf(p))) return;
    // 2.3: build the replacement fragment DIRECTLY from the token segments —
    // the page's own text is never serialized to an HTML string and parsed
    // back (createContextualFragment used to do that for every node).
    const { tokens, spans } = window.bionic.segments(tn.data);
    if (spans.length === 0) return;
    const spanOf = new Map();
    for (const [a, b] of spans) spanOf.set(a, b);
    const frag = document.createDocumentFragment();
    let text = '';
    const flushText = () => { if (text) { frag.appendChild(document.createTextNode(text)); text = ''; } };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const end = spanOf.get(i);
      if (end !== undefined) {
        // nowrap span: the whole bionic word, or the whole apostrophe join
        // (left word + ' + right word) so it never breaks mid-word
        flushText();
        const span = document.createElement('span');
        span.setAttribute('data-brw', '1');
        span.style.whiteSpace = 'nowrap';
        for (let j = i; j <= end; j++) appendWord(span, tokens[j]);
        frag.appendChild(span);
        i = end;
      } else {
        text += t.text;
      }
    }
    flushText();
    if (frag.firstChild) tn.replaceWith(frag);
  }
  // one token into a word span: <b>head</b> + plain tail (or plain text, for
  // the ' and the right word of an apostrophe join)
  function appendWord(span, t) {
    if (!t.bold) { if (t.text) span.appendChild(document.createTextNode(t.text)); return; }
    const b = document.createElement('b');
    b.setAttribute(OUR_B, '1');
    b.textContent = t.bold.head;
    span.appendChild(b);
    if (t.bold.tail) span.appendChild(document.createTextNode(t.bold.tail));
  }

  function bionicOne(host, nodes) {
    host.setAttribute(MARK, '1');
    for (const tn of nodes) if (tn && tn.isConnected) bionicText(tn);
  }

  // 6.2.2: a clear generation. ONLY clear() bumps it; a still-running idle
  // chunk notices it is stale and stops (R2: turning the page off on a long
  // page used to leave the tail partly bolded). scan() must NOT bump it: the
  // SPA observer's scan(addedNode) would cancel the page scan's remaining
  // chunks and leave most of a long page plain (R6).
  let generation = 0;

  function scan(root) {
    if (!root || !root.querySelectorAll) return 0;
    // heal DOM left by the v1 build (marker ON the word span, not the host).
    // Kept for one release: tabs opened under v1 still carry the stray marker.
    for (const s of root.querySelectorAll('span[data-brw="1"][' + MARK + '="1"]')) s.removeAttribute(MARK);
    const gen = generation;
    displayCache = new WeakMap(); // 6.2.7: per scan, not per module
    // 2.1/6.2.1: gather ALL text nodes per host. A >1000-char block is split
    // into several pieces with the SAME host — deduping hosts and keeping only
    // the FIRST piece dropped everything after a <br>/the size split (R1).
    // All READS (guards, visibility) first, then all WRITES. One walk:
    // host -> its text nodes, or null once the host was judged skipped.
    const byHost = new Map();
    for (const piece of getPieces(root)) {
      const host = piece.parentElement || piece.topElement;
      if (!host || host.nodeType !== 1) continue;
      if (!byHost.has(host)) {
        const ok = host.isConnected && !isSkipped(host) && host.textContent.trim();
        byHost.set(host, ok ? [] : null);
      }
      const nodes = byHost.get(host);
      if (nodes) nodes.push(...piece.nodes);
    }
    const nodesByHost = new Map([...byHost].filter(([, nodes]) => nodes));
    // 2.2: very long pages — bold a first chunk synchronously (so the feature
    // is visible at once), the rest in idle time, so turning it on does not
    // freeze the tab. A chunk that outlived a clear() (stale generation) stops.
    const work = [...nodesByHost.entries()];
    const CHUNK = 400;
    let i = 0;
    const step = () => {
      if (gen !== generation) return; // clear() happened while chunks were queued
      const end = Math.min(i + CHUNK, work.length);
      while (i < end) { bionicOne(work[i][0], work[i][1]); i++; }
      if (i < work.length) idle(step);
    };
    step();
    return work.length;
  }
  function idle(fn) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn);
    else setTimeout(fn, 16);
  }

  function clear(root) {
    // R2: cancel in-flight idle chunks before unwrapping — a stale chunk must
    // not re-bold behind the clear (content.js always clears document.body).
    generation++;
    // unwrap EVERY word span in scope (our own + orphans left by older builds;
    // a page span never carries data-brw, so this is safe) -> one text node
    const scope = root || document;
    for (const span of Array.from(scope.querySelectorAll('span[data-brw="1"]'))) {
      span.replaceWith(document.createTextNode(span.textContent));
    }
    for (const host of scope.querySelectorAll('[' + MARK + '="1"]')) {
      // merge the adjacent text nodes left behind ("bon"+"jour" -> "bonjour"),
      // otherwise the next scan() bionics them as two separate words
      host.normalize();
      host.removeAttribute(MARK);
    }
  }

  window.bionicExtract = { getPieces, scan, clear, visible, isCJKMajority, SKIP_SELECTOR };
})();
