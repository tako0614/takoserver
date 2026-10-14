import { describe, expect, test } from "bun:test";
import type { EdgeObjects } from "../src/providers/edge-objects-adapter.ts";
import fixture from "./fixtures/stream-unknown-length/vectors.json";

type ErrorCode = "invalid_body" | "value_too_large" | "invalid_part" | "backend_unavailable";
type Expected = { size: number } | { error: { name: ErrorCode; message: ErrorCode } };
interface SourceSpec {
  segments: number[];
  chunkBytes: number;
  producerDelayMs?: number;
  disconnectAfterBytes?: number;
  invalidChunkAfterBytes?: number;
}
interface Vector {
  id: string;
  operation: "put" | "upload";
  transport: "chunked" | "readable-stream";
  sources: SourceSpec[];
  sinkDelayMs: number;
  expected: Expected;
  expectCancellation: boolean;
}
interface SourceProbe {
  emittedChunks: number;
  acceptedChunks: number;
  emittedBytes: number;
  maxOutstandingChunks: number;
  cancelled: boolean;
}
interface SinkProbe {
  visibleSize: number;
  stagedParts: number;
  objectCommits: number;
}
interface SinkContext {
  headers: Headers;
  sinkDelayMs: number;
  acknowledge(body: ReadableStream<Uint8Array>): void;
}
type FixtureSink = Pick<
  EdgeObjects,
  "put" | "createMultipartUpload" | "uploadPart" | "completeMultipartUpload"
> & { inspect(): SinkProbe };

const limits = fixture.limits;
const previousObjectSize = 23;
const vectors = fixture.vectors as Vector[];

function namedError(code: ErrorCode): Error {
  const error = new Error(code);
  error.name = code;
  return error;
}

/** Test-only reference sink. Replace the createSink factory with the F4 adapter bridge. */
function createMockSink(context: SinkContext): FixtureSink {
  const probe: SinkProbe = {
    visibleSize: previousObjectSize,
    stagedParts: 0,
    objectCommits: 0,
  };
  const parts = new Map<number, { etag: string; size: number }>();

  async function consume(
    body: ReadableStream<Uint8Array> | ArrayBuffer | string,
    maximum: number,
    overflow: ErrorCode,
  ): Promise<number> {
    if (!(body instanceof ReadableStream) || context.headers.has("content-length")) {
      throw namedError("invalid_body");
    }
    const reader = body.getReader();
    let size = 0;
    try {
      while (true) {
        let item: Awaited<ReturnType<typeof reader.read>>;
        try {
          item = await reader.read();
        } catch {
          // Producer exceptions must not expose provider messages or arbitrary error names.
          throw namedError("backend_unavailable");
        }
        if (item.done) return size;
        if (!(item.value instanceof Uint8Array)) throw namedError("invalid_body");
        if (item.value.byteLength > maximum - size) throw namedError(overflow);
        if (context.sinkDelayMs > 0) await Bun.sleep(context.sinkDelayMs);
        size += item.value.byteLength;
        context.acknowledge(body);
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Cancellation failure cannot replace the portable operation error.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  return {
    async put(_key, body) {
      const size = await consume(body, limits.singlePutBytes, "value_too_large");
      probe.visibleSize = size;
      probe.objectCommits += 1;
      return { etag: '"put-etag"', size };
    },
    async createMultipartUpload() {
      return { uploadId: "fixture-upload" };
    },
    async uploadPart(_key, _uploadId, partNumber, body) {
      const size = await consume(body, limits.objectBytes, "invalid_body");
      const etag = `"part-${partNumber}-${size}"`;
      parts.set(partNumber, { etag, size });
      probe.stagedParts = parts.size;
      return { etag, partNumber };
    },
    async completeMultipartUpload(_key, _uploadId, selected) {
      if (selected.length < 1 || selected.length > limits.maximumParts) {
        throw namedError("invalid_part");
      }
      let size = 0;
      let previousPart = 0;
      for (let index = 0; index < selected.length; index += 1) {
        const part = selected[index];
        const recorded = part ? parts.get(part.partNumber) : undefined;
        if (
          !part ||
          !recorded ||
          part.etag !== recorded.etag ||
          part.partNumber <= previousPart ||
          (index < selected.length - 1 && recorded.size < limits.minimumNonFinalPartBytes)
        ) {
          throw namedError("invalid_part");
        }
        if (recorded.size > limits.objectBytes - size) throw namedError("value_too_large");
        size += recorded.size;
        previousPart = part.partNumber;
      }
      probe.visibleSize = size;
      probe.objectCommits += 1;
      return { etag: '"complete-etag"', size };
    },
    inspect() {
      return { ...probe };
    },
  };
}

// A future implementation changes this factory only; vectors and assertions stay fixed.
const createSink: (context: SinkContext) => FixtureSink = createMockSink;

function createSource(spec: SourceSpec): {
  body: ReadableStream<Uint8Array>;
  probe: SourceProbe;
} {
  const probe: SourceProbe = {
    emittedChunks: 0,
    acceptedChunks: 0,
    emittedBytes: 0,
    maxOutstandingChunks: 0,
    cancelled: false,
  };
  // Reuse one real byte buffer. Logical segments are split into bounded chunks,
  // so the real 5 GiB boundary is counted without allocating a 5 GiB body.
  const block = new Uint8Array(spec.chunkBytes).fill(0xa5);
  let segmentIndex = 0;
  let segmentRemaining = spec.segments[0] ?? 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (spec.producerDelayMs) await Bun.sleep(spec.producerDelayMs);
        if (
          spec.disconnectAfterBytes !== undefined &&
          probe.emittedBytes >= spec.disconnectAfterBytes
        ) {
          controller.error(new Error("private upstream disconnect diagnostic"));
          return;
        }
        if (
          spec.invalidChunkAfterBytes !== undefined &&
          probe.emittedBytes >= spec.invalidChunkAfterBytes
        ) {
          controller.enqueue("not bytes" as unknown as Uint8Array);
          return;
        }
        if (segmentIndex >= spec.segments.length) {
          controller.close();
          return;
        }
        let length = Math.min(segmentRemaining, spec.chunkBytes);
        if (spec.disconnectAfterBytes !== undefined) {
          length = Math.min(length, spec.disconnectAfterBytes - probe.emittedBytes);
        }
        if (spec.invalidChunkAfterBytes !== undefined) {
          length = Math.min(length, spec.invalidChunkAfterBytes - probe.emittedBytes);
        }
        controller.enqueue(block.subarray(0, length));
        probe.emittedBytes += length;
        probe.emittedChunks += 1;
        probe.maxOutstandingChunks = Math.max(
          probe.maxOutstandingChunks,
          probe.emittedChunks - probe.acceptedChunks,
        );
        segmentRemaining -= length;
        if (segmentRemaining === 0) {
          segmentIndex += 1;
          segmentRemaining = spec.segments[segmentIndex] ?? 0;
        }
      },
      cancel() {
        probe.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, probe };
}

describe("F4 proposed unknown-length stream acceptance", () => {
  test("fixture inventory covers both operations, transports, and actual byte ceilings", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
    expect(new Set(vectors.map((vector) => vector.id)).size).toBe(vectors.length);
    expect(limits).toEqual({
      singlePutBytes: 314_572_800,
      objectBytes: 5_368_709_120,
      minimumNonFinalPartBytes: 5_242_880,
      maximumParts: 10_000,
    });
    for (const operation of ["put", "upload"] as const) {
      for (const transport of ["chunked", "readable-stream"] as const) {
        const selected = vectors.filter(
          (vector) => vector.operation === operation && vector.transport === transport,
        );
        const maximum = operation === "put" ? limits.singlePutBytes : limits.objectBytes;
        expect(
          selected.some((vector) => "size" in vector.expected && vector.expected.size === 0),
        ).toBe(true);
        expect(
          selected.some((vector) => "size" in vector.expected && vector.expected.size === maximum),
        ).toBe(true);
        expect(
          selected.some(
            (vector) =>
              "error" in vector.expected &&
              vector.sources[0]?.segments.reduce((total, size) => total + size, 0) === maximum + 1,
          ),
        ).toBe(true);
        expect(selected.some((vector) => vector.sources[0]?.producerDelayMs)).toBe(true);
        expect(selected.some((vector) => vector.sinkDelayMs > 0)).toBe(true);
        expect(
          selected.some((vector) => vector.sources[0]?.disconnectAfterBytes !== undefined),
        ).toBe(true);
      }
    }
    expect(vectors.filter((vector) => vector.id.includes("d05")).length).toBe(8);
  });

  for (const vector of vectors) {
    test(vector.id, async () => {
      const sources = vector.sources.map(createSource);
      const probes = new Map(sources.map((source) => [source.body, source.probe]));
      const headers = new Headers();
      if (vector.transport === "chunked") headers.set("transfer-encoding", "chunked");
      expect(headers.has("content-length")).toBe(false);
      expect(headers.get("transfer-encoding")).toBe(
        vector.transport === "chunked" ? "chunked" : null,
      );
      const sink = createSink({
        headers,
        sinkDelayMs: vector.sinkDelayMs,
        acknowledge(body) {
          const probe = probes.get(body);
          if (!probe) throw new Error("unexpected body");
          probe.acceptedChunks += 1;
        },
      });
      let result: Expected;
      try {
        if (vector.operation === "put") {
          const source = sources[0];
          if (!source) throw new Error("missing put source");
          const written = await sink.put("existing-key", source.body);
          expect(written.etag).toBeString();
          result = { size: written.size };
        } else {
          const upload = await sink.createMultipartUpload("existing-key");
          const parts = [];
          for (let index = 0; index < sources.length; index += 1) {
            const source = sources[index];
            if (!source) throw new Error("missing part source");
            parts.push(
              await sink.uploadPart("existing-key", upload.uploadId, index + 1, source.body),
            );
          }
          const written = await sink.completeMultipartUpload(
            "existing-key",
            upload.uploadId,
            parts,
          );
          expect(written.etag).toBeString();
          result = { size: written.size };
        }
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const portable = error as Error;
        result = {
          error: { name: portable.name as ErrorCode, message: portable.message as ErrorCode },
        };
      }
      expect(result).toEqual(vector.expected);
      const snapshot = sink.inspect();
      if ("size" in vector.expected) {
        expect(snapshot.visibleSize).toBe(vector.expected.size);
        expect(snapshot.objectCommits).toBe(1);
        for (const [index, source] of sources.entries()) {
          const spec = vector.sources[index];
          if (!spec) throw new Error("missing source specification");
          expect(source.probe.emittedBytes).toBe(
            spec.segments.reduce((total, size) => total + size, 0),
          );
          expect(source.probe.acceptedChunks).toBe(source.probe.emittedChunks);
        }
      } else {
        expect(snapshot.visibleSize).toBe(previousObjectSize);
        expect(snapshot.objectCommits).toBe(0);
        if (sources.length === 1) expect(snapshot.stagedParts).toBe(0);
      }
      expect(sources.some((source) => source.probe.cancelled)).toBe(vector.expectCancellation);
      for (const source of sources) {
        expect(source.probe.maxOutstandingChunks).toBeLessThanOrEqual(1);
        expect(source.body.locked).toBe(false);
      }
    });
  }
});
