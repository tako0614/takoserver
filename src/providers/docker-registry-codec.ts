import type { Transform, TransformOptions } from "node:stream";
import {
  constants,
  createInflateRaw,
  createZstdDecompress,
  type ZlibOptions,
  type ZstdOptions,
} from "node:zlib";
import { DockerRegistrySourceError, registryFailure } from "./docker-registry-wire.ts";

export interface DockerRegistryCodecLimits {
  readonly maxCompressedBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxWindowBytes: number;
  readonly maxFrames: number;
  readonly maxChunks: number;
  readonly chunkBytes: number;
  readonly maxHeaderBytes: number;
  readonly timeoutMs: number;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(state: number, bytes: Uint8Array) {
  for (const byte of bytes) state = crcTable[(state ^ byte) & 255]! ^ (state >>> 8);
  return state >>> 0;
}
const MASK = (1n << 64n) - 1n,
  P1 = 11400714785074694791n,
  P2 = 14029467366897019727n,
  P3 = 1609587929392839161n,
  P4 = 9650029242287828579n,
  P5 = 2870177450012600261n;
const rot = (v: bigint, n: bigint) => ((v << n) | (v >> (64n - n))) & MASK;
const u64 = (b: Uint8Array, at: number) => {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[at + i]!);
  return n;
};
const u32 = (b: Uint8Array, at = 0) =>
  (b[at]! + b[at + 1]! * 256 + b[at + 2]! * 65536 + b[at + 3]! * 16777216) >>> 0;
const round = (a: bigint, b: bigint) => (rot((a + b * P2) & MASK, 31n) * P1) & MASK;
/** Seed-zero streaming XXH64, used for the Zstandard content checksum. */
class Xxh64 {
  #v = [(P1 + P2) & MASK, P2, 0n, -P1 & MASK];
  #tail = new Uint8Array(32);
  #used = 0;
  #total = 0;
  update(bytes: Uint8Array) {
    this.#total += bytes.byteLength;
    let at = 0;
    if (this.#used) {
      const n = Math.min(32 - this.#used, bytes.byteLength);
      this.#tail.set(bytes.subarray(0, n), this.#used);
      this.#used += n;
      at = n;
      if (this.#used === 32) {
        this.#stripe(this.#tail, 0);
        this.#used = 0;
      }
    }
    while (at + 32 <= bytes.byteLength) {
      this.#stripe(bytes, at);
      at += 32;
    }
    if (at < bytes.byteLength) {
      this.#tail.set(bytes.subarray(at), 0);
      this.#used = bytes.byteLength - at;
    }
  }
  #stripe(bytes: Uint8Array, at: number) {
    for (let n = 0; n < 4; n++) this.#v[n] = round(this.#v[n]!, u64(bytes, at + n * 8));
  }
  digest() {
    let h =
      this.#total >= 32
        ? (rot(this.#v[0]!, 1n) +
            rot(this.#v[1]!, 7n) +
            rot(this.#v[2]!, 12n) +
            rot(this.#v[3]!, 18n)) &
          MASK
        : P5;
    if (this.#total >= 32) for (const v of this.#v) h = ((h ^ round(0n, v)) * P1 + P4) & MASK;
    h = (h + BigInt(this.#total)) & MASK;
    let at = 0;
    while (at + 8 <= this.#used) {
      h = (rot(h ^ round(0n, u64(this.#tail, at)), 27n) * P1 + P4) & MASK;
      at += 8;
    }
    if (at + 4 <= this.#used) {
      h = (rot(h ^ ((BigInt(u32(this.#tail, at)) * P1) & MASK), 23n) * P2 + P3) & MASK;
      at += 4;
    }
    while (at < this.#used) {
      h = (rot(h ^ ((BigInt(this.#tail[at++]!) * P5) & MASK), 11n) * P1) & MASK;
    }
    h ^= h >> 33n;
    h = (h * P2) & MASK;
    h ^= h >> 29n;
    h = (h * P3) & MASK;
    h ^= h >> 32n;
    return h & MASK;
  }
}

type CodecWait = <T>(pending: Promise<T>, cleanup?: boolean) => Promise<T>;
type CodecJoin = (pending: readonly Promise<unknown>[]) => Promise<void>;

class Cursor {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #limits: DockerRegistryCodecLimits;
  readonly #check: () => void;
  readonly #wait: CodecWait;
  #back: Uint8Array[] = [];
  #pending: Uint8Array | undefined;
  #at = 0;
  #bytes = 0;
  #chunks = 0;
  #empty = 0;
  #done = false;
  #closing: Promise<void> | undefined;
  constructor(
    source: ReadableStream<Uint8Array>,
    limits: DockerRegistryCodecLimits,
    check: () => void,
    wait: CodecWait,
  ) {
    this.#reader = source.getReader();
    this.#limits = limits;
    this.#check = check;
    this.#wait = wait;
  }
  unread(bytes: Uint8Array) {
    if (bytes.byteLength) this.#back.unshift(bytes);
  }
  async chunk(max = this.#limits.chunkBytes): Promise<Uint8Array | null> {
    this.#check();
    if (this.#back.length) {
      const first = this.#back.shift()!;
      if (first.byteLength > max) this.#back.unshift(first.subarray(max));
      return first.subarray(0, max);
    }
    while (!this.#pending || this.#at === this.#pending.byteLength) {
      if (this.#done) return null;
      const next = await this.#wait(this.#reader.read());
      this.#check();
      if (next.done) {
        this.#done = true;
        return null;
      }
      if (
        !(next.value instanceof Uint8Array) ||
        next.value.byteLength > this.#limits.maxCompressedBytes - this.#bytes ||
        ++this.#chunks > this.#limits.maxChunks
      )
        return registryFailure("conflict");
      this.#bytes += next.value.byteLength;
      if (!next.value.byteLength) {
        if (++this.#empty > 64) return registryFailure("conflict");
        continue;
      }
      this.#empty = 0;
      this.#pending = next.value;
      this.#at = 0;
    }
    const end = Math.min(this.#pending.byteLength, this.#at + max),
      part = this.#pending.subarray(this.#at, end);
    this.#at = end;
    return part;
  }
  async exact(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.#limits.maxHeaderBytes)
      return registryFailure("conflict");
    const bytes = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const part = await this.chunk(n - at);
      if (!part) return registryFailure("conflict");
      bytes.set(part, at);
      at += part.byteLength;
    }
    return bytes;
  }
  close() {
    this.#closing ??= (async () => {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => this.#reader.cancel()),
        Promise.resolve().then(() => this.#reader.releaseLock()),
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) return registryFailure();
    })();
    return this.#closing;
  }
}

/** One native streaming decoder, with bounded output buffers/backpressure.
 * Gzip uses raw DEFLATE so its complete framing is verified here rather than
 * accepting Gunzip's concatenation/padding/trailing-input behavior. */
async function* decode(
  stream: Transform & { readonly bytesWritten: number },
  input: AsyncIterable<Uint8Array>,
  check: () => void,
  chunkBytes: number,
  cancelInput: () => Promise<void>,
  wait: CodecWait,
  join: CodecJoin,
  onUnused?: (bytes: Uint8Array) => void,
): AsyncGenerator<Uint8Array> {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  stream.once("close", resolveClosed);
  stream.on("error", () => {});
  const write = (chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) =>
      stream.write(chunk, (error) => (error ? reject(error) : resolve())),
    );
  const end = () =>
    new Promise<void>((resolve, reject) => {
      if (stream.destroyed) return reject(new Error("codec closed"));
      const clean = () => {
        stream.off("finish", finished);
        stream.off("error", failed);
        stream.off("close", earlyClose);
      };
      const failed = (error: Error) => {
          clean();
          reject(error);
        },
        finished = () => {
          clean();
          resolve();
        },
        earlyClose = () => failed(new Error("codec closed"));
      stream.once("error", failed);
      stream.once("finish", finished);
      stream.once("close", earlyClose);
      stream.end();
    });
  const pumping = (async () => {
    for await (const chunk of input) {
      check();
      if (stream.readableEnded) {
        if (!onUnused) return registryFailure("conflict");
        onUnused(chunk);
        break;
      }
      const before = stream.bytesWritten;
      await wait(write(chunk));
      check();
      const consumed = stream.bytesWritten - before;
      if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > chunk.byteLength)
        return registryFailure("conflict");
      if (consumed < chunk.byteLength) {
        if (!onUnused) return registryFailure("conflict");
        onUnused(chunk.subarray(consumed));
        break;
      }
    }
    check();
    await wait(end());
    check();
  })();
  void pumping.catch(() => stream.destroy());
  let complete = false;
  const output = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      check();
      const next = await wait(output.next());
      if (next.done) break;
      const raw = next.value;
      check();
      if (!(raw instanceof Uint8Array)) return registryFailure("conflict");
      for (let at = 0; at < raw.byteLength; at += chunkBytes) {
        yield raw.subarray(at, Math.min(raw.byteLength, at + chunkBytes));
        check();
      }
    }
    await wait(pumping);
    complete = true;
  } catch (error) {
    if (error instanceof DockerRegistrySourceError) throw error;
    return registryFailure("conflict");
  } finally {
    const cleanup: Promise<unknown>[] = [
      Promise.resolve().then(() => {
        stream.destroy();
      }),
      pumping.then(
        () => {},
        () => {},
      ),
      closed,
      Promise.resolve().then(() => output.return?.()),
    ];
    if (!complete) cleanup.push(Promise.resolve().then(cancelInput));
    await join(cleanup);
  }
}

/** Native APIs are used only after independently parsing finite framing/window
 * bounds. Expanded-byte/hash/DiffID admission is also enforced by supplier R2. */
export function expandDockerRegistryLayer(
  codec: "gzip" | "zstd",
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limits: DockerRegistryCodecLimits,
  guard: () => Promise<void>,
): ReadableStream<Uint8Array> {
  if (
    Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) ||
    limits.timeoutMs > 2_147_483_647 ||
    limits.chunkBytes > 65536 ||
    limits.chunkBytes < 64 ||
    limits.maxHeaderBytes < 18 ||
    limits.maxWindowBytes > 2 ** 30
  )
    return registryFailure("invalid_request");
  const deadline = performance.now() + limits.timeoutMs,
    controller = new AbortController();
  const check = () => {
    if (signal.aborted || controller.signal.aborted || performance.now() >= deadline)
      return registryFailure();
  };
  const wait: CodecWait = (pending, cleanup = false) =>
    new Promise((resolve, reject) => {
      let settled = false;
      let alarm: ReturnType<typeof setTimeout> | undefined;
      const finish = (work: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(alarm);
        controller.signal.removeEventListener("abort", aborted);
        work();
      };
      const aborted = () => finish(() => reject(new DockerRegistrySourceError("unavailable")));
      pending.then(
        (value) => {
          if (
            performance.now() >= deadline ||
            (!cleanup && (signal.aborted || controller.signal.aborted))
          )
            aborted();
          else finish(() => resolve(value));
        },
        (error: unknown) => finish(() => reject(error)),
      );
      const remaining = deadline - performance.now();
      if (remaining <= 0 || (!cleanup && (signal.aborted || controller.signal.aborted))) aborted();
      else {
        if (!cleanup) controller.signal.addEventListener("abort", aborted, { once: true });
        alarm = setTimeout(aborted, remaining);
      }
    });
  const join: CodecJoin = async (pending) => {
    const outcomes = await wait(Promise.allSettled(pending), true);
    if (outcomes.some((outcome) => outcome.status === "rejected")) return registryFailure();
  };
  const cursor = new Cursor(source, limits, check, wait);
  let active: Transform | undefined,
    total = 0,
    frames = 0;
  let cancelling: Promise<void> | undefined;
  const closeInput = () => {
    cancelling ??= cursor.close();
    return cancelling;
  };
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (!cancellation) {
      controller.abort();
      cancellation = join([
        Promise.resolve().then(() => {
          active?.destroy();
        }),
        Promise.resolve().then(closeInput),
      ]);
    }
    return cancellation;
  };
  const onAbort = () => {
    void cancel().catch(() => {});
    detach();
  };
  const detach = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, limits.timeoutMs);
  if (signal.aborted) onAbort();
  const current = async () => {
    check();
    try {
      await wait(guard());
    } catch {
      return registryFailure();
    }
    check();
  };
  async function* expanded() {
    let complete = false;
    try {
      for (;;) {
        await current();
        const first = await cursor.chunk(1);
        if (!first) {
          if (!frames) return registryFailure("conflict");
          break;
        }
        cursor.unread(first);
        if (++frames > limits.maxFrames) return registryFailure("conflict");
        if (codec === "gzip") {
          let headerBytes = 0,
            headerCrc = 0xffffffff;
          const header = async (n: number) => {
            if (n > limits.maxHeaderBytes - headerBytes) return registryFailure("conflict");
            const bytes = await cursor.exact(n);
            headerBytes += n;
            headerCrc = crc(headerCrc, bytes);
            return bytes;
          };
          const fixed = await header(10),
            flags = fixed[3]!;
          if (fixed[0] !== 31 || fixed[1] !== 139 || fixed[2] !== 8 || flags & 0xe0)
            return registryFailure("conflict");
          if (flags & 4) {
            const size = await header(2);
            let remain = size[0]! + size[1]! * 256;
            while (remain) {
              const n = Math.min(remain, limits.chunkBytes);
              await header(n);
              remain -= n;
            }
          }
          for (const flag of [8, 16])
            if (flags & flag) {
              while ((await header(1))[0] !== 0) check();
            }
          if (flags & 2) {
            if (headerBytes > limits.maxHeaderBytes - 2) return registryFailure("conflict");
            const expected = (headerCrc ^ 0xffffffff) & 65535;
            const bytes = await cursor.exact(2);
            if (bytes[0]! + bytes[1]! * 256 !== expected) return registryFailure("conflict");
          }
          const inflateOptions: ZlibOptions & TransformOptions = {
            chunkSize: limits.chunkBytes,
            highWaterMark: limits.chunkBytes,
            finishFlush: constants.Z_FINISH,
          };
          active = createInflateRaw(inflateOptions);
          let memberBytes = 0,
            memberCrc = 0xffffffff;
          const input = {
            async *[Symbol.asyncIterator]() {
              for (;;) {
                await current();
                const bytes = await cursor.chunk();
                if (!bytes) break;
                yield bytes;
              }
            },
          };
          for await (const bytes of decode(
            active as Transform & { readonly bytesWritten: number },
            input,
            check,
            limits.chunkBytes,
            cancel,
            wait,
            join,
            (bytes) => cursor.unread(bytes),
          )) {
            await current();
            if (bytes.byteLength > limits.maxExpandedBytes - total)
              return registryFailure("conflict");
            total += bytes.byteLength;
            memberBytes += bytes.byteLength;
            memberCrc = crc(memberCrc, bytes);
            yield bytes;
          }
          active = undefined;
          const footer = await cursor.exact(8);
          if (
            u32(footer) !== (memberCrc ^ 0xffffffff) >>> 0 ||
            u32(footer, 4) !== memberBytes >>> 0
          )
            return registryFailure("conflict");
        } else {
          const magic = await cursor.exact(4),
            mark = u32(magic);
          if (mark >= 0x184d2a50 && mark <= 0x184d2a5f) {
            let remain = u32(await cursor.exact(4));
            while (remain) {
              await current();
              const bytes = await cursor.chunk(Math.min(remain, limits.chunkBytes));
              if (!bytes) return registryFailure("conflict");
              remain -= bytes.byteLength;
            }
            continue;
          }
          if (mark !== 0xfd2fb528 || typeof createZstdDecompress !== "function")
            return registryFailure("conflict");
          const desc = await cursor.exact(1),
            flag = desc[0]!;
          if (flag & 0x18) return registryFailure("conflict");
          const single = (flag & 32) !== 0,
            fcsFlag = flag >>> 6,
            window = single ? new Uint8Array() : await cursor.exact(1);
          const dictionary = await cursor.exact([0, 1, 2, 4][flag & 3]!);
          if (dictionary.some((byte) => byte !== 0)) return registryFailure("conflict");
          const fcs = await cursor.exact([single ? 1 : 0, 2, 4, 8][fcsFlag]!);
          let content = 0n;
          for (let n = fcs.length - 1; n >= 0; n--) content = (content << 8n) | BigInt(fcs[n]!);
          if (fcsFlag === 1) content += 256n;
          let windowBytes = content;
          if (!single) {
            const log = 10 + (window[0]! >>> 3),
              base = 1n << BigInt(log);
            windowBytes = base + (base >> 3n) * BigInt(window[0]! & 7);
          }
          if (
            windowBytes > BigInt(limits.maxWindowBytes) ||
            (fcs.byteLength && content > BigInt(limits.maxExpandedBytes - total))
          )
            return registryFailure("conflict");
          let checksum: Uint8Array | undefined;
          const xxh = new Xxh64();
          let frameBytes = 0;
          const input = {
            async *[Symbol.asyncIterator]() {
              for (const bytes of [magic, desc, window, dictionary, fcs])
                if (bytes.byteLength) yield bytes;
              let last = false;
              while (!last) {
                await current();
                const block = await cursor.exact(3),
                  value = block[0]! + block[1]! * 256 + block[2]! * 65536;
                last = (value & 1) !== 0;
                const kind = (value >>> 1) & 3,
                  size = value >>> 3;
                if (kind === 3 || size > 131072 || BigInt(size) > windowBytes)
                  return registryFailure("conflict");
                yield block;
                let remain = kind === 1 ? 1 : size;
                while (remain) {
                  const bytes = await cursor.chunk(Math.min(remain, limits.chunkBytes));
                  if (!bytes) return registryFailure("conflict");
                  remain -= bytes.byteLength;
                  yield bytes;
                }
              }
              if (flag & 4) {
                checksum = await cursor.exact(4);
                yield checksum;
              }
            },
          };
          const windowLog = Math.max(10, Math.ceil(Math.log2(limits.maxWindowBytes)));
          const zstdOptions: ZstdOptions & TransformOptions = {
            chunkSize: limits.chunkBytes,
            highWaterMark: limits.chunkBytes,
            finishFlush: constants.ZSTD_e_end,
            params: { [constants.ZSTD_d_windowLogMax]: windowLog },
          };
          active = createZstdDecompress(zstdOptions);
          for await (const bytes of decode(
            active as Transform & { readonly bytesWritten: number },
            input,
            check,
            limits.chunkBytes,
            cancel,
            wait,
            join,
          )) {
            await current();
            if (bytes.byteLength > limits.maxExpandedBytes - total)
              return registryFailure("conflict");
            total += bytes.byteLength;
            frameBytes += bytes.byteLength;
            xxh.update(bytes);
            yield bytes;
          }
          active = undefined;
          if (
            (fcs.byteLength && BigInt(frameBytes) !== content) ||
            (checksum && u32(checksum) !== Number(xxh.digest() & 0xffffffffn))
          )
            return registryFailure("conflict");
        }
      }
      await current();
      complete = true;
    } finally {
      if (!complete) void cancel().catch(() => {});
      await join([closeInput()]);
    }
  }
  const iterator = expanded();
  return new ReadableStream<Uint8Array>(
    {
      async pull(output) {
        try {
          const next = await wait(iterator.next());
          if (next.done) {
            detach();
            output.close();
          } else output.enqueue(next.value);
        } catch (error) {
          void join([
            Promise.resolve().then(cancel),
            Promise.resolve().then(() => iterator.return(undefined)),
          ]).catch(() => {});
          detach();
          output.error(error);
        }
      },
      async cancel() {
        const cleanup = [
          Promise.resolve().then(cancel),
          Promise.resolve().then(() => iterator.return(undefined)),
        ];
        try {
          await join(cleanup);
        } finally {
          detach();
        }
      },
    },
    { highWaterMark: 0 },
  );
}
