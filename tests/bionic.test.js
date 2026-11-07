// Tests for the bolding algorithm: src/bionic.js (shipped) and
// src/bionic-html.js (HTML-string variants, test/library only).
//
// Algorithm facts:
//   - a word of n code points: the first floor(n/2) are bolded
//   - n < MIN_LEN (4): plain; n == MIN_LEN: first letter only
//   - an apostrophe is a separate token; left+right == 4, or 5 split 2+3/3+2,
//     bolds only the left word's first letter (c'est, you're)
//   - numbers, whitespace and single non-word chars stay plain
//   - skip rules W4–W9 (all-caps, mid-capital, symbols, idempotency, CJK,
//     short-word-run anchors)
//   - with the tags stripped, the output text equals the input
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const { read } = require("./helpers/dom");

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(read("src/bionic.js") + "\n;" + read("src/bionic-html.js"), sandbox);
const { bionic } = sandbox.window;
const stripTags = (s) => s.replace(/<\/?(?:b|strong)>/g, "");

// [name, input, expected writeHtml() output]
function cases(list) {
  for (const [name, input, expected] of list) {
    test(name, () => assert.equal(bionic.writeHtml(input), expected));
  }
}

describe("word bolding", () => {
  cases([
    ["5 letters -> 2 bold", "hello", "<b>he</b>llo"],
    ["6 letters -> 3 bold", "mondes", "<b>mon</b>des"],
    ["7 letters -> 3 bold", "bonjour", "<b>bon</b>jour"],
    ["8 letters -> 4 bold", "français", "<b>fran</b>çais"],
    ["an accent counts as one code point", "température", "<b>tempé</b>rature"],
    ["2 letters stay plain", "le", "le"],
    ["3 letters stay plain", "est", "est"],
    ["4 letters -> first letter only", "fait", "<b>f</b>ait"],
    ["4 letters with accent -> first letter only", "café", "<b>c</b>afé"],
    ["4-letter word after a tab", "tab\there", "tab\t<b>h</b>ere"],
    ["naïve -> 2 bold (code points, not code units)", "naïve", "<b>na</b>ïve"],
    ["straße -> 3 bold", "straße", "<b>str</b>aße"],
    ["mwenzi -> 3 bold", "mwenzi", "<b>mwe</b>nzi"],
  ]);
  for (const s of ["12345", "1969", "!", "a  b", "a\nb", "", "   "]) {
    test(`stays plain: ${JSON.stringify(s)}`, () => assert.equal(bionic.writeHtml(s), s));
  }
});

describe("apostrophes", () => {
  cases([
    ["c'est (1+3) -> left first letter", "c'est", "<b>c</b>'est"],
    ["l'été (1+3) -> left first letter", "l'été", "<b>l</b>'été"],
    ["qu'on (2+2) -> left first letter", "qu'on", "<b>q</b>u'on"],
    ["you're (3+2) -> left first letter", "you're", "<b>y</b>ou're"],
    ["it's (2+1) stays plain", "it's", "it's"],
    ["qu'attend (2+6) -> normal rules on each side", "qu'attend", "qu'<b>att</b>end"],
    ["curly apostrophes: qu’aujourd’hui", "qu’aujourd’hui", "qu’<b>auj</b>ourd’hui"],
  ]);
  test("overlapping apostrophe joins do not overwrite each other", () => {
    // the second join (i at the second ') must not re-mark the middle word
    // of the first join — only the left word of the first join is bolded
    assert.equal(bionic.write("ab'cd'ef"), "<b>a</b>b'cd'ef");
  });
});

describe("sentences and punctuation", () => {
  cases([
    ["sentence", "bonjour monde !", "<b>bon</b>jour <b>mo</b>nde !"],
    ["guillemets", "« bonsoir »", "« <b>bon</b>soir »"],
    ["trailing punctuation", "température.", "<b>tempé</b>rature."],
    ["hyphenated word: each side on its own", "anti-bloc", "<b>a</b>nti-<b>b</b>loc"],
  ]);
});

describe("writeHtml keeps markup", () => {
  cases([
    ["paragraph", "<p>bonjour monde</p>", "<p><b>bon</b>jour <b>mo</b>nde</p>"],
    ["attributes", '<a href="/x">bonjour</a>', '<a href="/x"><b>bon</b>jour</a>'],
    ["nested tags", "<div><span>bonjour</span> monde</div>", "<div><span><b>bon</b>jour</span> <b>mo</b>nde</div>"],
    ["void tags", '<br> monde <img src="x.png">', '<br> <b>mo</b>nde <img src="x.png">'],
    ["data attributes", '<div data-x="1">monde</div>', '<div data-x="1"><b>mo</b>nde</div>'],
    ["script content untouched", "<script>x.y()</script> monde", "<script>x.y()</script> <b>mo</b>nde"],
    ["only tags", "<div></div>", "<div></div>"],
    ["an author's whole-word bold is kept", "<b>already</b> bold", "<b>already</b> <b>b</b>old"],
  ]);
  test("writeHtmlPlain uses <strong>", () => {
    assert.equal(bionic.writeHtmlPlain("<p>bonjour</p>"), "<p><strong>bon</strong>jour</p>");
  });
});

describe("text is unchanged (only tags are added)", () => {
  for (const s of [
    "bonjour monde",
    "c'est qu'on l'été naïve français",
    "1969 ! « » —",
    '<p class="a" data-b="c">hello monde</p>',
    "<div>tab\tnewline\nend</div>",
    "éèàùîöä ẁ",
    "<script>var x=1</script> fin",
    "qu’aujourd’hui l’été naïve",
  ]) {
    test(JSON.stringify(s), () => assert.equal(stripTags(bionic.writeHtml(s)), s));
  }
});

describe("skip rules", () => {
  cases([
    ["W4 all-caps: NASA", "NASA", "NASA"],
    ["W4 all-caps with accent: ÉLAN", "ÉLAN", "ÉLAN"],
    ["W4 all-caps inside a sentence", "The HTTP request failed.", "The HTTP <b>req</b>uest <b>fai</b>led."],
    ["W5 mid-capital: iPhone", "iPhone", "iPhone"],
    ["W5 mid-capital: macOS", "macOS", "macOS"],
    ["W5 mid-capital: iPhone17", "iPhone17", "iPhone17"],
    ["W5 does not apply to an uppercase start", "BionicReader", "<b>Bionic</b>Reader"],
    ["W6 emoji", "🎉🎊", "🎉🎊"],
    ["W6 symbols", "+++---", "+++---"],
    // W8: CJK test inputs are written as \u escapes to keep the source ASCII
    ["W8 chinese", "这是一个中文段落用来测试插件行为", "这是一个中文段落用来测试插件行为"],
    ["W8 japanese", "これは日本語の段落です", "これは日本語の段落です"],
    ["W8 korean", "이것은 한국어입니다", "이것은 한국어입니다"],
    ["W8 mixed: CJK plain, latin bolded", "使用 bionic reading 阅读中文内容", "使用 <b>bio</b>nic <b>rea</b>ding 阅读中文内容"],
    ["W8 latin text with one hanzi word", "hello 世界 monde", "<b>he</b>llo 世界 <b>mo</b>nde"],
    ["W9 short-word run anchored on its middle word", "the of and", "the <b>o</b>f and"],
    ["W9 anchors are placed from the end of the run", "the of and is at but or", "the of <b>a</b>nd is at <b>b</b>ut or"],
    ["W9 run shorter than 7 letters stays plain", "a b c", "a b c"],
    ["W9 a CJK run is not a short word", "使用 bionic 阅读", "使用 <b>bio</b>nic 阅读"],
    ["W9 skipped words (W4/W5) do not anchor", "HTTP NASA iPhone fin", "HTTP NASA iPhone fin"],
  ]);
});

describe("W7 idempotency: running twice changes nothing", () => {
  for (const s of ["<p>bonjour</p>", "<p>HTTP NASA iPhone fin</p>", "日本語 mix English", "c'est bonjour"]) {
    test(JSON.stringify(s), () => {
      const once = bionic.writeHtml(s);
      assert.equal(bionic.writeHtml(once), once);
      assert.equal(stripTags(once), s);
    });
  }
  test("write() after a W9 anchor", () => {
    const once = bionic.write("the of and");
    assert.equal(bionic.write(once), once);
  });
});
