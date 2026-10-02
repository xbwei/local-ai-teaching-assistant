import test from "node:test";
import assert from "node:assert/strict";
import { renderMessageText } from "../src/client/markdown.ts";

// Small DOM-construction spy; the opt-in browser suite also tests actual Chromium.
function fixture() {
  const doc = {
    createElement: (tag) => node(tag),
    createTextNode: (text) => node("#text", text),
    createDocumentFragment: () => node("#fragment"),
  };
  function node(tag, text = "") {
    return {
      tag,
      children: [],
      ownerDocument: doc,
      className: "",
      classList: { add() {} },
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren() {
        this.children = [];
      },
      set textContent(value) {
        this.children = [node("#text", value)];
      },
      get textContent() {
        return tag === "#text"
          ? text
          : this.children.map((n) => n.textContent).join("");
      },
      set innerHTML(_) {
        assert.fail("HTML parsing is forbidden");
      },
    };
  }
  return node("div");
}
function nodes(root, tag) {
  return [
    ...(root.tag === tag ? [root] : []),
    ...root.children.flatMap((n) => nodes(n, tag)),
  ];
}
test("assistant Markdown builds headings, nested lists, emphasis and literal code", () => {
  const root = fixture();
  renderMessageText(root, {
    role: "answer",
    text: "### Heading\n\n**Bold** and *italic* with `a < b`.\n\n- One\n  - Nested\n- Two\n\n3. Third\n4. Fourth\n\n```js\n<script>literal</script>\n```",
  });
  assert.equal(nodes(root, "h3")[0].textContent, "Heading");
  assert.equal(nodes(root, "strong")[0].textContent, "Bold");
  assert.equal(nodes(root, "em")[0].textContent, "italic");
  assert.equal(nodes(root, "ul").length, 2);
  assert.equal(nodes(root, "ol")[0].start, 3);
  assert.equal(nodes(root, "li").length, 5);
  assert.equal(nodes(root, "code")[0].textContent, "a < b");
  assert.equal(nodes(root, "pre")[0].textContent, "<script>literal</script>");
});
test("raw HTML, handlers and every link/image protocol remain inert text", () => {
  for (const text of [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg onload=alert(1)><foreignObject>unsafe</foreignObject></svg>",
    "[click](javascript:alert(1))",
    "[click](data:text/html,unsafe)",
    "![track](https://example.invalid/pixel)",
    "[link](https://example.invalid)",
    "<https://example.invalid>",
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  ]) {
    const root = fixture();
    renderMessageText(root, { role: "answer", text });
    for (const tag of ["script", "img", "svg", "a", "iframe", "foreignObject"])
      assert.equal(nodes(root, tag).length, 0);
    assert.equal(root.textContent, text);
  }
});
test("user questions and error copy always remain plain text", () => {
  const text = "### **Literal** <script>alert(1)</script>";
  for (const message of [
    { role: "question", text },
    { role: "answer", error: true, text },
  ]) {
    const root = fixture();
    renderMessageText(root, message);
    assert.equal(root.textContent, text);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].tag, "#text");
  }
});
