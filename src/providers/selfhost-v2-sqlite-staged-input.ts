import {
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// This is a transport bound derived from the published per-field maxima, not
// an additional SQL call-size limit. A JSON control byte may expand to six
// wire bytes (\\u0000); at most 100 statements have 100 one-million-byte
// values and 100,000 SQL bytes each. The remaining bytes cover fixed keys,
// separators, numbers, and the private envelope.
const MAX_STATEMENT_WIRE_BYTES = 6 * (100_000 + 100 * 1_000_000) + 100_000;
const MAX_CALL_WIRE_BYTES = 100 * MAX_STATEMENT_WIRE_BYTES + 100_000;
const INLINE_BYTES = 1_048_576;
const READ_CHUNK_BYTES = 65_536;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface Span {
  readonly start: number;
  readonly end: number;
}

export type SqlRequestBody =
  | { readonly kind: "inline"; readonly bytes: Uint8Array; readonly dispose: () => void }
  | {
      readonly kind: "staged";
      readonly protocol: string;
      readonly binding: string;
      readonly op: string;
      readonly count: number;
      readonly statementAt: (index: number) => unknown;
      readonly dispose: () => void;
    };

/** The operator supplies a real, pre-existing private directory, never a tenant path. */
export function checkedSqlStagingRoot(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new TypeError("an absolute private SQL staging root is required");
  }
  const root = resolve(path);
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || realpathSync(root) !== root) {
    throw new TypeError("SQL staging root must be a private real directory");
  }
  return root;
}

/**
 * A normal call stays in the old small-envelope path. A larger call is spooled
 * before any DB handle is opened, then indexed as at most 100 statement spans.
 * Only one decoded statement is held at a time during transaction execution.
 */
export async function readSqlRequestBody(request: Request, root: string): Promise<SqlRequestBody> {
  if (!request.body) throw new TypeError("missing SQL request body");
  const reader = request.body.getReader();
  const inline: Uint8Array[] = [];
  let length = 0;
  let directory: string | undefined;
  let path: string | undefined;
  let writer: number | undefined;
  let handedOff = false;
  const dispose = () => {
    if (writer !== undefined) {
      closeSync(writer);
      writer = undefined;
    }
    if (path !== undefined) {
      unlinkSync(path);
      path = undefined;
    }
    if (directory !== undefined) {
      rmdirSync(directory);
      directory = undefined;
    }
  };
  try {
    for (;;) {
      if (request.signal.aborted) throw new TypeError("SQL request aborted");
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || length + chunk.byteLength > MAX_CALL_WIRE_BYTES) {
        throw new TypeError("SQL request exceeds published field-derived wire bound");
      }
      length += chunk.byteLength;
      if (writer === undefined && length <= INLINE_BYTES) {
        inline.push(chunk);
        continue;
      }
      if (writer === undefined) {
        // The directory is external operator state, so verify its real/private
        // identity again at the moment of the first filesystem effect.
        checkedSqlStagingRoot(root);
        directory = mkdtempSync(join(root, "call-"));
        const metadata = lstatSync(directory);
        if (
          !metadata.isDirectory() ||
          (metadata.mode & 0o077) !== 0 ||
          realpathSync(directory) !== directory
        ) {
          throw new TypeError("SQL call stage is not private");
        }
        const file = join(directory, "input.json");
        writer = openSync(
          file,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        path = file;
        // The file remains readable through this private FD but has no name.
        // Process death therefore cannot strand tenant SQL bytes on disk.
        unlinkSync(file);
        path = undefined;
        for (const saved of inline) writeAll(writer, saved);
        inline.length = 0;
      }
      writeAll(writer, chunk);
    }
    if (request.signal.aborted) throw new TypeError("SQL request aborted");
    if (writer === undefined) {
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of inline) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      handedOff = true;
      return { kind: "inline", bytes, dispose: () => {} };
    }
    const spans = indexSqlEnvelope(writer, length);
    if (request.signal.aborted) throw new TypeError("SQL request aborted");
    handedOff = true;
    return {
      kind: "staged",
      protocol: spans.protocol,
      binding: spans.binding,
      op: spans.op,
      count: spans.statements.length,
      statementAt(index) {
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= spans.statements.length ||
          writer === undefined
        ) {
          throw new TypeError("invalid SQL statement index");
        }
        return parseSpan(writer, spans.statements[index] as Span);
      },
      dispose,
    };
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The failed stream is no longer an authority for this call.
    }
    throw error;
  } finally {
    reader.releaseLock();
    if (!handedOff) dispose();
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new TypeError("SQL staging write made no progress");
    offset += written;
  }
}

function parseSpan(fd: number, span: Span): unknown {
  const length = span.end - span.start;
  if (length < 1 || length > MAX_STATEMENT_WIRE_BYTES) throw new TypeError("invalid SQL span");
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, bytes, offset, length - offset, span.start + offset);
    if (read <= 0) throw new TypeError("incomplete SQL stage");
    offset += read;
  }
  return JSON.parse(decoder.decode(bytes));
}

class Cursor {
  position = 0;
  private readonly buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  private windowStart = -1;
  private windowLength = 0;

  constructor(
    private readonly fd: number,
    private readonly size: number,
  ) {}

  peek(): number {
    if (this.position >= this.size) return -1;
    if (this.position < this.windowStart || this.position >= this.windowStart + this.windowLength) {
      this.windowStart = this.position;
      this.windowLength = readSync(this.fd, this.buffer, 0, this.buffer.length, this.position);
      if (this.windowLength <= 0) throw new TypeError("incomplete SQL stage");
    }
    return this.buffer[this.position - this.windowStart] as number;
  }

  take(): number {
    const byte = this.peek();
    if (byte < 0) throw new TypeError("unexpected end of SQL envelope");
    this.position += 1;
    return byte;
  }

  whitespace(): void {
    while ([9, 10, 13, 32].includes(this.peek())) this.position += 1;
  }

  expect(byte: number): void {
    this.whitespace();
    if (this.take() !== byte) throw new TypeError("invalid SQL envelope");
  }

  string(maxBytes: number): string {
    this.whitespace();
    const start = this.position;
    if (this.take() !== 34) throw new TypeError("expected JSON string");
    for (;;) {
      const byte = this.take();
      if (byte === 34) break;
      if (byte === 92) this.take();
      if (this.position - start > maxBytes) throw new TypeError("SQL envelope string too large");
    }
    return parseSpan(this.fd, { start, end: this.position }) as string;
  }

  objectSpan(): Span {
    this.whitespace();
    const start = this.position;
    if (this.take() !== 123) throw new TypeError("expected SQL statement object");
    let depth = 1;
    let quoted = false;
    while (depth > 0) {
      const byte = this.take();
      if (quoted) {
        if (byte === 92) this.take();
        else if (byte === 34) quoted = false;
      } else if (byte === 34) quoted = true;
      else if (byte === 123 || byte === 91) depth += 1;
      else if (byte === 125 || byte === 93) depth -= 1;
      if (depth > 8 || this.position - start > MAX_STATEMENT_WIRE_BYTES) {
        throw new TypeError("SQL statement exceeds published field-derived bound");
      }
    }
    return { start, end: this.position };
  }
}

function indexSqlEnvelope(
  fd: number,
  size: number,
): {
  protocol: string;
  binding: string;
  op: string;
  statements: Span[];
} {
  const cursor = new Cursor(fd, size);
  const fields = new Map<string, string>();
  let statements: Span[] | undefined;
  let statement: Span | undefined;
  let afterComma = false;
  cursor.expect(123);
  for (;;) {
    cursor.whitespace();
    if (cursor.peek() === 125) {
      if (afterComma) throw new TypeError("trailing SQL envelope comma");
      cursor.take();
      break;
    }
    const key = cursor.string(128);
    if (
      fields.has(key) ||
      (key === "statements" && statements) ||
      (key === "statement" && statement)
    ) {
      throw new TypeError("duplicate SQL envelope key");
    }
    cursor.expect(58);
    afterComma = false;
    if (key === "protocol" || key === "binding" || key === "op") {
      fields.set(key, cursor.string(4096));
    } else if (key === "statement") {
      statement = cursor.objectSpan();
    } else if (key === "statements") {
      statements = [];
      cursor.expect(91);
      let afterStatementComma = false;
      for (;;) {
        cursor.whitespace();
        if (cursor.peek() === 93) {
          if (afterStatementComma) throw new TypeError("trailing SQL statements comma");
          cursor.take();
          break;
        }
        if (statements.length >= 100) throw new TypeError("too many SQL statements");
        statements.push(cursor.objectSpan());
        afterStatementComma = false;
        cursor.whitespace();
        if (cursor.peek() === 93) {
          cursor.take();
          break;
        }
        cursor.expect(44);
        afterStatementComma = true;
      }
    } else throw new TypeError("unknown SQL envelope key");
    cursor.whitespace();
    if (cursor.peek() === 125) {
      cursor.take();
      break;
    }
    cursor.expect(44);
    afterComma = true;
  }
  cursor.whitespace();
  if (
    cursor.peek() !== -1 ||
    !fields.has("protocol") ||
    !fields.has("binding") ||
    !fields.has("op")
  ) {
    throw new TypeError("incomplete SQL envelope");
  }
  const op = fields.get("op") as string;
  const selected =
    op === "transaction" && statements && !statement && statements.length > 0
      ? statements
      : (op === "execute" || op === "query") && statement && !statements
        ? [statement]
        : null;
  if (!selected) throw new TypeError("invalid SQL operation shape");
  return {
    protocol: fields.get("protocol") as string,
    binding: fields.get("binding") as string,
    op,
    statements: selected,
  };
}
