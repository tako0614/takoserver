/** The default JSON request budget; a route with its own limit passes that instead. */
export const MAX_JSON_REQUEST_BODY_BYTES = 64 * 1_024;

/**
 * The request bytes, or `null` as soon as they would pass `limit`; the rest is
 * cancelled, never buffered. An absent body and an empty stream are the same
 * zero bytes: Bun presents a bodiless POST as `null`, but workerd presents it
 * as a stream that ends at once, so `request.body !== null` never means "has
 * a body" on a Worker.
 */
export async function readBoundedRequestBody(
  request: Request,
  limit: number,
): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > limit - total) {
        // A cloned Request tees its body: cancellation may wait for the unread
        // sibling. Refusal must not await that sibling or drain it.
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(part.value);
      total += part.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
