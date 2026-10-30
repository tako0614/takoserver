/**
 * A request body that records how much of it was pulled and whether it was
 * cancelled. It asks for nothing ahead of a reader (highWaterMark 0), so pulls
 * reflect consumption. Compare pulls against a baseline taken after the
 * Request exists rather than assuming zero: a runtime may prefetch on its own.
 * An optional `leading` chunk (such as a JSON document) precedes the filler,
 * which is whitespace, so the whole body stays valid JSON when it is one.
 */
export function instrumentedBodyStream(input: {
  readonly chunkBytes: number;
  readonly totalChunks: number;
  readonly leading?: Uint8Array;
}) {
  const counters = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (counters.pulls >= input.totalChunks) {
          controller.close();
          return;
        }
        counters.pulls += 1;
        controller.enqueue(
          counters.pulls === 1 && input.leading
            ? input.leading
            : new Uint8Array(input.chunkBytes).fill(0x20),
        );
      },
      cancel() {
        counters.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const totalBytes = input.leading
    ? input.leading.byteLength + input.chunkBytes * (input.totalChunks - 1)
    : input.chunkBytes * input.totalChunks;
  return { stream, counters, totalBytes };
}
