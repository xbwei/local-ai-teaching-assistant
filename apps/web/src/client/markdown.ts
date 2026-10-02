import { Lexer, type Token } from "marked";

/** Parse Markdown syntax, but never parse/insert model-generated HTML or URLs. */
export function renderMessageText(
  container: HTMLElement,
  message: { role: "question" | "answer"; text: string; error?: boolean },
) {
  container.replaceChildren();
  container.className = "message-text";
  if (message.role === "question" || message.error) {
    container.textContent = message.text;
    return;
  }
  const doc = container.ownerDocument;
  function append(tokens: Token[], parent: HTMLElement | DocumentFragment) {
    for (const token of tokens) {
      const element = (tag: string, children?: Token[]) => {
        const node = doc.createElement(tag);
        if (children) append(children, node);
        parent.append(node);
        return node;
      };
      switch (token.type) {
        case "space":
          break;
        case "heading":
          element(`h${Math.min(6, Math.max(1, token.depth))}`, token.tokens);
          break;
        case "paragraph":
          element("p", token.tokens);
          break;
        case "list": {
          const list = element(token.ordered ? "ol" : "ul");
          if (token.ordered && Number.isSafeInteger(token.start))
            (list as HTMLOListElement).start = Number(token.start);
          for (const item of token.items) {
            const li = doc.createElement("li");
            append(item.tokens, li);
            list.append(li);
          }
          break;
        }
        case "strong":
        case "em":
          element(token.type, token.tokens);
          break;
        case "code": {
          const code = doc.createElement("code");
          code.textContent = token.text;
          element("pre").append(code);
          break;
        }
        case "codespan":
          element("code").textContent = token.text;
          break;
        case "br":
          element("br");
          break;
        case "text":
          if (token.tokens) append(token.tokens, parent);
          else parent.append(doc.createTextNode(token.text));
          break;
        default:
          // Raw HTML, links/images and unsupported syntax remain inert text.
          parent.append(doc.createTextNode(token.raw));
      }
    }
  }
  try {
    const fragment = doc.createDocumentFragment();
    append(Lexer.lex(message.text, { gfm: false }), fragment);
    container.append(fragment);
    container.classList.add("markdown");
  } catch {
    container.textContent = message.text;
  }
}
