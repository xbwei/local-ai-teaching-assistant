/** A bounded, closed Canvas wrapper grammar, not a general HTML parser.
 * An anchor without href contributes only visible text. A present href must
 * match the visible URI. Attributes never authorize a target. */
export function submissionLinkText(body: string): {
  text: string;
  href: string | undefined;
} {
  const deny = (): never => {
    throw new Error("SOURCE_UNAVAILABLE");
  };
  if (Buffer.byteLength(body) > 16_000) return deny();
  // Reject invalid source characters before markup can consume or discard them.
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(body)) return deny();
  const markup = body.includes("<") || body.includes(">");
  const decode = (text: string): string => {
    // One HTML layer only: separators and ampersands, never encoded markup,
    // URI letters/delimiters or recursive entity repair.
    if (markup && /&(?!amp;|nbsp;|#38;|#[xX]26;|#160;|#[xX][aA]0;)/u.test(text))
      return deny();
    const value = markup
      ? text.replace(
          /&(amp|nbsp|#38|#[xX]26|#160|#[xX][aA]0);/gu,
          (_, entity) =>
            ["amp", "#38", "#x26", "#X26"].includes(entity) ? "&" : "\u00a0",
        )
      : text.replace(/&amp;/gu, "&");
    if (
      /&(?:#|[a-z][a-z0-9]*;)/iu.test(value) ||
      value.trim().includes("\u00a0")
    )
      return deny();
    return value;
  };
  const stack: string[] = [];
  const output: string[] = [];
  let anchor: { href: string | undefined; text: string } | undefined;
  let anchors = 0;
  let destination: string | undefined;
  // Inline decoration may surround a whole token, not splice fragments into a
  // URI or truncate it by manufacturing a separator. Block elements separate
  // visible paragraphs; every visible text node remains in the output.
  let previousText = "";
  let inlineBoundary = false;
  const inline = new Set(["span", "code", "b", "strong", "em", "i"]);
  const boundary = (name: string) => {
    if (inline.has(name)) inlineBoundary = true;
    else {
      previousText = "";
      inlineBoundary = false;
    }
    if (anchor) anchor.text += "\n";
    else output.push("\n");
  };
  for (const part of body.split(/(<[^<>]*>)/u)) {
    if (!part.startsWith("<")) {
      if (/[<>]/u.test(part)) return deny();
      const text = decode(part);
      if (
        text &&
        inlineBoundary &&
        /\S$/u.test(previousText) &&
        /^\S/u.test(text)
      )
        return deny();
      if (text) {
        previousText = text;
        inlineBoundary = false;
      }
      if (anchor) anchor.text += text;
      else output.push(text);
      continue;
    }
    const close =
      /^<\/(p|div|pre|code|span|b|strong|em|i|ul|ol|li|blockquote|a)[ \t\n]*>$/iu.exec(
        part,
      );
    if (close) {
      const name = close[1]!.toLowerCase();
      if (stack.pop() !== name) return deny();
      if (name === "a") {
        if (!anchor) return deny();
        if (anchor.href !== undefined) {
          if (anchor.text.trim() !== anchor.href) return deny();
          previousText = "";
        }
        inlineBoundary = anchor.href === undefined;
        output.push(anchor.text);
        anchor = undefined;
      } else boundary(name);
      continue;
    }
    if (/^<br[ \t\n]*\/?>$/iu.test(part)) {
      if (anchor) return deny();
      boundary("br");
      continue;
    }
    const open =
      /^<(p|div|pre|code|span|b|strong|em|i|ul|ol|li|blockquote)[ \t\n]*>$/iu.exec(
        part,
      );
    if (open) {
      const name = open[1]!.toLowerCase();
      if (anchor && !inline.has(name)) return deny();
      stack.push(name);
      boundary(name);
    } else {
      if (anchor) return deny();
      if (!/^<a[ \t\n>]/iu.test(part)) return deny();
      if (++anchors > 1) return deny();
      const attributes = part.slice(2, -1);
      const attribute =
        /[ \t\n]+([a-z][a-z0-9_-]{0,63})[ \t\n]*=[ \t\n]*(?:"([^"<>]*)"|'([^'<>]*)')/giy;
      const values = new Map<string, string>();
      let offset = 0;
      while (
        offset < attributes.length &&
        !/^[ \t\n]*$/u.test(attributes.slice(offset))
      ) {
        attribute.lastIndex = offset;
        const match = attribute.exec(attributes);
        if (!match) return deny();
        const name = match[1]!.toLowerCase();
        const value = decode(match[2] ?? match[3]!);
        if (values.has(name) || values.size >= 32) return deny();
        if (name !== "href") {
          // Metadata is never rendered, followed, passed to a driver or used as
          // authority. Classify its capability, not a Canvas spelling/value.
          // Reject executable, styling, hiding, resource/action and namespace
          // syntax. Nonsemantic quoted scalar metadata has no such capability.
          if (
            /^(?:on|src|form)/u.test(name) ||
            /^(?:style|ping|download|hidden|inert|contenteditable|xmlns)$/u.test(
              name,
            ) ||
            value.length > 1024 ||
            /[<>`\\%]/u.test(value) ||
            /[a-z][a-z0-9+.-]*:|\/\/|www\./iu.test(value)
          )
            return deny();
        }
        values.set(name, value);
        offset = attribute.lastIndex;
      }
      const href = values.get("href");
      if (href === "") return deny();
      // Treat the edges of a text-only anchor like inline decoration so they
      // cannot splice a token. Only a present href creates a destination claim.
      if (href === undefined) inlineBoundary = true;
      destination = href;
      anchor = { href, text: "" };
      stack.push("a");
    }
    if (stack.length > 8) return deny();
  }
  if (anchor) return deny();
  if (stack.length) return deny();
  return { text: output.join(""), href: destination };
}
