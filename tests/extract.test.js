// Tests for src/extract.js: which blocks get bolded (element skip rules
// E1–E8, W10), scan/clear round-trips, idempotency, and the chunked scan of
// long pages. Tests in a describe share one page and run in order.
const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");
const { makeDom, wait } = require("./helpers/dom");

const marked = (el) => el.hasAttribute("data-bionic-applied");
const bolded = (el) => el.querySelector("b[data-bionic]") !== null;
const plain = (el) => !bolded(el) && !marked(el);

describe("skip rules and scan/clear on one page", () => {
  const { X, doc } = makeDom(`
<div id="root">
  <h1>Page Title Heading</h1>
  <h2>Another section heading</h2>
  <nav>Home About Contact Links</nav>
  <footer>Copyright 2026 something</footer>
  <p class="social-share">Share this article on socials</p>
  <p id="codehost">run the code below <code>console.log(42)</code> to see</p>
  <pre id="pre">preformatted code block that must stay intact here</pre>
  <p id="kbd">press <kbd>Ctrl</kbd><kbd>C</kbd> to copy the text</p>
  <p id="nt" class="notranslate">do not bionic me I am marked notranslate</p>
  <p id="tn" translate="no">translate no attribute keeps me plain text</p>
  <div id="ed" contenteditable="true">editable region must not be touched here</div>
  <p id="hidden" style="display:none">invisible paragraph that should stay untouched</p>
  <p id="cn">这是一个中文段落用来测试插件行为是否符合我们的预期设计要求要求</p>
  <p id="jp">これは日本語の段落です読みやすさのためのテストです長文</p>
  <p id="ok1">bonjour monde comment ça va aujourd'hui en français vraiment</p>
  <p id="ok2">The HTTP request to NASA failed badly on the server today.</p>
  <footer id="foot"><div class="svg-pattern"><h2>Campuses</h2><ul><li><a href="/a">North Campus</a></li><li><a href="/b">City Campus</a></li></ul><p>Copyright 2026 Example University</p></div></footer>
  <aside id="side"><div class="block formatting"><h3>Right menu</h3><ul><li><a href="/c">Quick links item one</a></li><li><a href="/d">Another sidebar link</a></li></ul></div></aside>
  <p id="long">${"lorem ipsum dolor sit amet ".repeat(60).trim()}</p>
</div>`);
  const q = (s) => doc.querySelector(s);
  const root = q("#root");
  const OK1_TEXT = "bonjour monde comment ça va aujourd'hui en français vraiment";

  test("getPieces finds the text blocks", () => {
    const pieces = X.getPieces(root);
    assert.ok(pieces.length > 0);
    assert.ok(pieces.every((p) => p.nodes.length > 0), "every piece has a text node");
    assert.ok(pieces.some((p) => p.nodes.some((n) => /HTTP request/.test(n.textContent))));
    assert.ok(pieces.some((p) => /^H[1-6]$/.test((p.parentElement || p.topElement).nodeName)),
      "heading pieces are found (and skipped later, in scan)");
  });

  test("scan bolds ordinary paragraphs and marks them", () => {
    X.scan(root);
    assert.ok(bolded(q("#ok1")) && marked(q("#ok1")), q("#ok1").innerHTML);
    assert.ok(bolded(q("#ok2")));
    assert.ok(/HTTP/.test(q("#ok2").innerHTML) && !/<b[^>]*>H<\/b>/.test(q("#ok2").innerHTML), "HTTP stays plain (W4)");
  });

  for (const [what, sel] of [
    ["h1", "#root h1"], ["h2", "#root h2"], ["nav", "nav"], ["footer", "footer"],
    ["share buttons", ".social-share"], ["inline <code> itself", "#codehost code"], ["pre", "#pre"],
    ["inline <kbd> itself", "#kbd kbd"], ["class=notranslate", "#nt"], ["translate=no", "#tn"],
    ["contenteditable", "#ed"], ["display:none", "#hidden"], ["chinese (E8)", "#cn"], ["japanese (E8)", "#jp"],
  ]) {
    test(`leaves ${what} plain`, () => assert.ok(plain(q(sel)), q(sel).innerHTML));
  }
  // position:fixed elements have offsetParent === null but are still visible —
  // visible() must not classify them as invisible
  test("a position:fixed block is still bioniced", () => {
    const fixed = doc.createElement("div");
    fixed.style.position = "fixed";
    fixed.textContent = "a sticky reading pane that must be bionicized here";
    doc.body.appendChild(fixed);
    Object.defineProperty(fixed, "offsetParent", { get: () => null }); // the real DOM case
    X.scan(fixed);
    assert.ok(bolded(fixed), "fixed block should be bolded: " + fixed.innerHTML);
    X.clear(fixed);
  });

  // code/pre/kbd are excluded at the piece level (htmlTagsInlineIgnore), so the
  // surrounding prose of a block that merely embeds inline code IS bolded —
  // the old host-level skip dropped the whole paragraph.
  test("prose around inline <code>/<kbd> is bolded; only the code/kbd stays plain", () => {
    assert.ok(bolded(q("#codehost")), "#codehost prose should be bolded: " + q("#codehost").innerHTML);
    assert.ok(bolded(q("#kbd")), "#kbd prose should be bolded: " + q("#kbd").innerHTML);
    assert.ok(!bolded(q("#codehost code")), "the <code> itself must stay plain");
    assert.ok(!bolded(q("#kbd kbd")), "the <kbd> itself must stay plain");
  });
  test("leaves content nested deep inside <footer> / <aside> plain", () => {
    assert.ok(!bolded(q("#foot")));
    assert.ok(!bolded(q("#side")));
  });

  test("a paragraph over 1000 chars is bolded and marked once, as one block", () => {
    const el = q("#long");
    assert.ok(bolded(el));
    assert.ok(marked(el));
    assert.equal(el.querySelectorAll("[data-bionic-applied]").length, 0);
  });

  test("a second scan changes nothing", () => {
    const before = root.innerHTML;
    X.scan(root);
    assert.equal(root.innerHTML, before);
  });

  test("a word's plain tail is never re-bolded, even without the host marker", () => {
    // the host marker alone would stop a rescan; drop it so the word-span
    // guard in bionicText is what is tested (<b>deci</b>sions must not
    // become <b>deci</b><b>si</b>ons)
    const p = doc.createElement("p");
    p.textContent = "the decisions were made today";
    root.appendChild(p);
    X.scan(p);
    const once = p.innerHTML;
    assert.match(once, /<b[^>]*>deci<\/b>sions/);
    p.removeAttribute("data-bionic-applied");
    X.scan(p);
    p.removeAttribute("data-bionic-applied");
    assert.equal(p.innerHTML, once);
    X.clear(p);
  });

  test("each bolded word sits in one nowrap span; spaces stay outside", () => {
    const span = q("#ok1").querySelector("span[data-brw='1']");
    assert.equal(span.style.whiteSpace, "nowrap");
    assert.match(span.innerHTML, /^<b[^>]*>\p{L}+<\/b>\p{L}*$/u);
    assert.match(span.textContent, /jour$/);
    assert.match(q("#ok1").innerHTML, /<\/span> <span data-brw="1"/);
  });

  test("clear removes spans, bold and markers and restores the text", () => {
    X.clear(root);
    assert.equal(q("#ok1").querySelector("span[data-brw]"), null);
    assert.equal(q("#ok1").textContent, OK1_TEXT);
    assert.equal(root.querySelectorAll("[data-bionic-applied]").length, 0);
  });

  test("the page's own <b> survives scan, clear and on -> off -> on", () => {
    const p = doc.createElement("p");
    p.innerHTML = "plain <b>author</b> bold here now";
    root.appendChild(p);
    X.scan(root);
    assert.ok(bolded(p) && p.innerHTML.includes("<b>author</b>"), p.innerHTML);
    X.clear(root);
    assert.equal(p.innerHTML, "plain <b>author</b> bold here now");
    X.scan(root); X.clear(root); X.scan(root);
    assert.ok(bolded(q("#ok1")) && marked(q("#ok1")));
    assert.ok(p.innerHTML.includes("<b>author</b>") && !p.innerHTML.includes('data-bionic="1">author</b>'));
  });

  test("DOM left by the v1 build is healed (stray span marker, orphan span)", () => {
    const span = doc.createElement("span");
    span.setAttribute("data-brw", "1");
    span.setAttribute("data-bionic-applied", "1"); // v1 put the marker on the span
    const b = doc.createElement("b");
    b.setAttribute("data-bionic", "1");
    b.textContent = "Sel";
    span.append(b, "ect");
    const a = doc.createElement("a");
    a.append(span, " now"); // host unmarked, as v1 left it
    root.appendChild(a);
    X.scan(a);
    assert.ok(!span.hasAttribute("data-bionic-applied"));
    assert.equal(b.textContent, "Sel");
    X.clear(a);
    assert.equal(a.textContent.trim(), "Select now");
    assert.equal(a.querySelector("span[data-brw], [data-bionic-applied]"), null);
  });

  test("W10: text directly in a flex container is left alone", () => {
    // flex drops whitespace text nodes between items: splitting the text
    // rendered "SupporttheAlumniAppeal"
    const a = doc.createElement("a");
    a.style.display = "flex";
    a.textContent = "Support the Alumni Appeal";
    root.appendChild(a);
    X.scan(a);
    assert.equal(a.textContent, "Support the Alumni Appeal");
    assert.equal(a.querySelector("span[data-brw], b[data-bionic]"), null);
    X.clear(a);
    assert.equal(a.textContent, "Support the Alumni Appeal");
  });
});

describe("blocks split into several pieces", () => {
  test("text after a <br> is bolded too", () => {
    const { X, doc } = makeDom(`<p id="p">first line of prose here<br>second line of prose words</p>`);
    X.scan(doc.body);
    const bolds = [...doc.querySelectorAll("#p b[data-bionic]")].map((b) => b.textContent);
    assert.ok(bolds.includes("sec"), `bolds=${bolds}`);
    assert.ok(bolds.length >= 6, `bolds=${bolds}`);
  });

  test("a block over 1000 chars spread across many nodes is bolded to the end", () => {
    const spans = Array.from({ length: 130 }, (_, i) => `<span>word${i} xyz</span>`).join(" ");
    const { X, doc } = makeDom(`<p id="p">${spans}</p>`);
    X.scan(doc.body);
    assert.ok(doc.querySelectorAll("#p b[data-bionic]").length >= 100);
    assert.notEqual(doc.querySelector("#p span:last-child b[data-bionic]"), null);
  });
});

describe("long pages: scan continues in idle-time chunks", () => {
  const paragraphs = Array.from({ length: 900 }, (_, i) =>
    `<p>paragraph number ${i} with a decent sentence for bionic reading</p>`).join("");

  test("clear() cancels the chunks still queued", async () => {
    const { X, doc } = makeDom(paragraphs);
    X.scan(doc.body);
    X.clear(doc.body);
    assert.equal(doc.querySelectorAll("b[data-bionic], span[data-brw]").length, 0);
    await wait(300);
    assert.equal(doc.querySelectorAll("b[data-bionic], span[data-brw]").length, 0, "queued chunks bolded again after clear()");
  });

  test("a later scan() does not cancel an earlier scan's chunks", async () => {
    // the content script's SPA observer calls scan(addedNode) while the page
    // scan may still be running
    const { X, doc } = makeDom(paragraphs + `<div id="spa"></div>`);
    X.scan(doc.body);
    const spa = doc.getElementById("spa");
    spa.innerHTML = "<p>freshly added content arrives from the app</p>";
    X.scan(spa);
    await wait(300);
    const plainCount = [...doc.querySelectorAll("p")].filter((p) => !bolded(p)).length;
    assert.equal(plainCount, 0);
  });
});

describe("no lost spaces or words", () => {
  let X, win;
  before(() => ({ X, win } = makeDom(`
    <p id="cta"><a id="link" href="/enrol">Select courses now</a></p>
    <p id="l2">Complete your enrolment by selecting your courses—once you’ve received your Offer of Place.</p>
    <p id="l3">If you're returning to do Honours or start a Master's degree, your first step is to apply.</p>`)));

  for (const id of ["#link", "#l2", "#l3"]) {
    test(id, () => {
      const el = win.document.querySelector(id);
      const text = el.textContent;
      X.scan(el);
      assert.ok(bolded(el));
      assert.equal(el.textContent, text);
      X.clear(el);
      assert.equal(el.textContent, text);
    });
  }
});
