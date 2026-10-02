import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chunksFor, courseLimits } from "../dist/index.js";
// JSON includes every chunk's text, path, section and
// normalized text, so it catches changes beyond the top three retrieved sources.
const expected = {
  empty: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  ascii: "26647fd6f1368d0336d87aa1d0c1a161c4fee4dc03a53ae08bf0b1743915c425",
  chinese: "291e02e4be7944c57d3380d0f61ad35b5e8912f1d3c4a8cb5c9a39717d4af724",
  mixedEmoji:
    "3b8b99533652bd5a460721fba92a26f2f1a270d2d4b24d6cdb1ee2ddbf2d8ad8",
  whitespaceHeadings:
    "ef47409d9637e853e08edce1a1dc3e199c828378037dcce046a7bed4b386d285",
  byteEdges: "2300ba56360a164b4ceee8cd369d2720d76bd1d344435a0555cac20b95432e65",
  longParagraph:
    "b3fcbc31520be786b762ccc21f54f6723bc857adffffac6db92e049e2a778cbd",
  manyShortParagraphs:
    "84fadde135a49f67659158631238750f5741c5a4c1f84b1366d73a5733b8897d",
  nearCourseLimit:
    "f08a88353ca9e14600417b70fd6f17cdc4396319caf17acf4b9205821ba79f64",
};

function fill(target, heading, phrase, separator = "") {
  let text = heading;
  while (Buffer.byteLength(text + phrase + separator) <= target)
    text += phrase + separator;
  return text;
}

const fixture = {
  empty: [["README.md", ""]],
  ascii: [["README.md", "# Overview\nPlain ASCII text.\n\nSecond paragraph."]],
  chinese: [
    ["docs/index.md", "# 课程介绍\n" + "公开数据分析与实践。".repeat(170)],
  ],
  mixedEmoji: [
    [
      "docs/modules/module-1/index.md",
      "# Mixed 中文 😀\n" + "English 中文 😀🚀 data. ".repeat(140),
    ],
  ],
  whitespaceHeadings: [
    [
      "README.md",
      "Intro  \n\n  \n## **Heading**  \n  alpha \t beta  \n\n\n### `Next`\n\n trailing  \n\n# Empty\n   ",
    ],
  ],
  byteEdges: [
    [
      "README.md",
      "# Bounds\n" +
        "a".repeat(898) +
        "中" +
        "e".repeat(899) +
        "😀" +
        "z".repeat(901),
    ],
  ],
  longParagraph: [
    [
      "docs/index.md",
      "# Long\n" + "English 中文 😀 with spaces and data. ".repeat(300),
    ],
  ],
  manyShortParagraphs: [
    [
      "docs/modules/module-1/index.md",
      "# Many\n" +
        Array.from(
          { length: 450 },
          (_, i) => `Paragraph ${i}: English 中文 😀 data.`,
        ).join("\n\n"),
    ],
  ],
  nearCourseLimit: [
    [
      "README.md",
      fill(
        190 * 1024,
        "# IA340\n## Course Overview\n",
        "Long ASCII paragraph with public data analysis. ",
      ),
    ],
    [
      "docs/index.md",
      fill(
        190 * 1024,
        "# 首页\n## 课程介绍\n",
        "中文资料与数据分析以及数据库练习。",
      ),
    ],
    [
      "docs/modules/module-1/index.md",
      fill(
        190 * 1024,
        "# Module 1\n## Mixed\n",
        "English 中文 emoji 😀🚀 data. ",
      ),
    ],
    [
      "docs/assignments/lab-5/index.md",
      fill(
        190 * 1024,
        "# Lab 5\n\n",
        "Short English 中文 😀 paragraph.",
        "\n\n",
      ),
    ],
  ],
};

for (const [name, files] of Object.entries(fixture)) {
  test(`chunk equivalence: ${name}`, () => {
    const totalBytes = files.reduce(
      (sum, [, text]) => sum + Buffer.byteLength(text),
      0,
    );
    assert.ok(totalBytes <= courseLimits.maxCourseBytes);
    assert.ok(
      files.every(
        ([, text]) => Buffer.byteLength(text) <= courseLimits.maxFileBytes,
      ),
    );
    if (name === "nearCourseLimit")
      assert.ok(totalBytes > courseLimits.maxCourseBytes * 0.98);
    const chunks = files.flatMap(([filePath, text]) =>
      chunksFor(filePath, text),
    );
    assert.ok(
      chunks.every(
        (chunk) =>
          Buffer.byteLength(chunk.text) <= courseLimits.maxExcerptBytes,
      ),
    );
    assert.ok(
      chunks.every((chunk) =>
        files.some(([filePath]) => filePath === chunk.path),
      ),
    );
    const digest = createHash("sha256")
      .update(JSON.stringify(chunks))
      .digest("hex");
    assert.equal(
      digest,
      expected[name],
      `${name}: complete chunk identity changed`,
    );
  });
}

function hasUnpairedSurrogate(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

test("long excerpts preserve evidence across UTF-8 and whitespace boundaries", () => {
  const cases = {
    leadingAscii: ` ${"a".repeat(899)}${"b".repeat(910)}`,
    whitespacePrefix: `${"\u3000".repeat(400)}${"a".repeat(899)}${"b".repeat(910)}`,
    exactBoundary: ` ${"a".repeat(895)}😀${"b".repeat(910)}`,
    beforeBoundary: ` ${"a".repeat(894)}😀${"b".repeat(910)}`,
    afterBoundary: ` ${"a".repeat(896)}😀${"b".repeat(910)}`,
    trailingWhitespace: ` ${"a".repeat(893)}😀  ${"b".repeat(910)}`,
    ideographicWhitespace: `\u3000\u3000${"a".repeat(889)}😀${"b".repeat(910)}`,
    nonbreakingWhitespace: `\u00a0\u00a0${"a".repeat(891)}😀${"b".repeat(910)}`,
    chineseEmoji: ` ${"中".repeat(297)}aaaa😀${"b".repeat(910)}`,
    mixedUtf8: ` ${"a中".repeat(223)}aaa😀${"b".repeat(910)}`,
  };
  for (const [name, paragraph] of Object.entries(cases)) {
    const chunks = chunksFor(
      "docs/index.md",
      `# Boundary\nIntro\n\n${paragraph}`,
    );
    assert.ok(chunks.length >= 3, name);
    assert.ok(
      chunks.every(
        (chunk) =>
          chunk.path === "docs/index.md" && chunk.section === "Boundary",
      ),
      name,
    );
    assert.ok(
      chunks.every(
        (chunk) =>
          Buffer.byteLength(chunk.text) <= courseLimits.maxExcerptBytes,
      ),
      name,
    );
    assert.ok(
      chunks.every((chunk) => !hasUnpairedSurrogate(chunk.text)),
      name,
    );
    assert.ok(
      chunks.every((chunk) => !chunk.text.includes("\ufffd")),
      name,
    );
    assert.equal(
      chunks.reduce(
        (count, chunk) =>
          count +
          [...chunk.text].filter((character) => character === "😀").length,
        0,
      ),
      [...paragraph].filter((character) => character === "😀").length,
      name,
    );
    assert.equal(
      chunks
        .slice(1)
        .map((chunk) => chunk.text)
        .join("")
        .replace(/\s/gu, ""),
      paragraph.replace(/\s/gu, ""),
      `${name}: evidence characters must appear exactly once and in order`,
    );
  }
});
