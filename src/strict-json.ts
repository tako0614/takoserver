export class StrictJsonError extends Error {}

const MAX_NESTING_DEPTH = 128;

export function parseStrictJson(bytes: Uint8Array, maxBytes: number): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new StrictJsonError();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new StrictJsonError();
  }
  assertNoDuplicateMembers(text);
  try {
    const value: unknown = JSON.parse(text);
    assertIJsonValue(value, 0);
    return value;
  } catch {
    throw new StrictJsonError();
  }
}

function assertNoDuplicateMembers(text: string): void {
  let offset = 0;
  const skipWhitespace = (): void => {
    while (offset < text.length && /[\t\n\r ]/u.test(text[offset] ?? "")) offset += 1;
  };
  const parseString = (): string => {
    if (text[offset] !== '"') throw new StrictJsonError();
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const char = text[offset];
      if (char === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          throw new StrictJsonError();
        }
      }
      if (char === "\\") {
        offset += 2;
        continue;
      }
      offset += 1;
    }
    throw new StrictJsonError();
  };
  const parseValue = (depth: number): void => {
    if (depth > MAX_NESTING_DEPTH) throw new StrictJsonError();
    skipWhitespace();
    const char = text[offset];
    if (char === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new StrictJsonError();
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") throw new StrictJsonError();
        offset += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new StrictJsonError();
        offset += 1;
      }
      throw new StrictJsonError();
    }
    if (char === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new StrictJsonError();
        offset += 1;
      }
      throw new StrictJsonError();
    }
    if (char === '"') {
      parseString();
      return;
    }
    const start = offset;
    while (offset < text.length && !/[\t\n\r ,\]}]/u.test(text[offset] ?? "")) offset += 1;
    if (start === offset) throw new StrictJsonError();
  };
  parseValue(0);
  skipWhitespace();
  if (offset !== text.length) throw new StrictJsonError();
}

function assertIJsonValue(value: unknown, depth: number): void {
  if (depth > MAX_NESTING_DEPTH) throw new StrictJsonError();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StrictJsonError();
    return;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertIJsonValue(entry, depth + 1);
    return;
  }
  if (typeof value !== "object") throw new StrictJsonError();
  for (const [key, entry] of Object.entries(value)) {
    assertUnicodeScalarString(key);
    assertIJsonValue(entry, depth + 1);
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code > 0xdbff) throw new StrictJsonError();
    const trailing = value.charCodeAt(index + 1);
    if (!Number.isInteger(trailing) || trailing < 0xdc00 || trailing > 0xdfff) {
      throw new StrictJsonError();
    }
    index += 1;
  }
}
