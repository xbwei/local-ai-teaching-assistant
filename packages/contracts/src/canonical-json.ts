export function canonicalJson(value: unknown): string {
  type Frame =
    | { readonly kind: "VALUE"; readonly value: unknown }
    | { readonly kind: "TEXT"; readonly value: string }
    | { readonly kind: "LEAVE"; readonly value: object };
  const output: string[] = [];
  const active = new Set<object>();
  const stack: Frame[] = [{ kind: "VALUE", value }];
  let visited = 0;
  while (stack.length > 0) {
    if (++visited > 10_000) throw new Error("canonical value is too complex");
    const frame = stack.pop()!;
    if (frame.kind === "TEXT") {
      output.push(frame.value);
      continue;
    }
    if (frame.kind === "LEAVE") {
      active.delete(frame.value);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current !== "object") {
      const encoded = JSON.stringify(current);
      if (encoded === undefined) throw new Error("unsupported canonical value");
      output.push(encoded);
      continue;
    }
    if (active.has(current)) throw new Error("cyclic canonical value");
    active.add(current);
    stack.push({ kind: "LEAVE", value: current });
    if (Array.isArray(current)) {
      stack.push({ kind: "TEXT", value: "]" });
      for (let index = current.length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(current, index);
        if (!descriptor || !Object.hasOwn(descriptor, "value"))
          throw new Error("unsupported canonical value");
        stack.push({ kind: "VALUE", value: descriptor.value });
        if (index > 0) stack.push({ kind: "TEXT", value: "," });
      }
      stack.push({ kind: "TEXT", value: "[" });
      continue;
    }
    const keys = Object.keys(current).sort();
    stack.push({ kind: "TEXT", value: "}" });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value"))
        throw new Error("unsupported canonical value");
      stack.push({ kind: "VALUE", value: descriptor.value });
      stack.push({ kind: "TEXT", value: ":" });
      stack.push({ kind: "TEXT", value: JSON.stringify(key) });
      if (index > 0) stack.push({ kind: "TEXT", value: "," });
    }
    stack.push({ kind: "TEXT", value: "{" });
  }
  return output.join("");
}
