import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ObjectStoreAccess, StoredObjectBody } from "../../ports.ts";
import { isV2HttpsUrl } from "../identity.ts";
import { ARTIFACT_URL_MAX_ASCII_BYTES } from "./artifact-validation.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
/** Generic reader ceiling; each Form supplies its own stricter artifact bound. */
const MAX_HOST_HELD_ARTIFACT_READ_BYTES = 134_217_728;
const DEFAULT_READ_TIMEOUT_MILLISECONDS = 30_000;
const MAX_READ_TIMEOUT_MILLISECONDS = 120_000;
const READ_YIELD_INTERVAL = 1_024;
const MAX_PENDING_CHUNKS = 1_024;

export interface V2ArtifactSource {
  read(input: {
    readonly principal: string;
    readonly space: string;
    readonly url: string;
    readonly sha256: string;
    readonly maxBytes: number;
  }): Promise<Uint8Array>;
}

export interface V2HeldArtifactGrant {
  readonly principal: string;
  readonly space: string;
}

/** One exact source identity mapped to bytes already held by the Host. */
export interface V2HeldArtifactEntry {
  readonly url: string;
  readonly sha256: string;
  readonly objectKey: string;
  readonly grants: readonly V2HeldArtifactGrant[];
}

export interface V2HeldArtifactSourceOptions {
  readonly objects: Pick<ObjectStoreAccess, "get">;
  readonly entries: readonly V2HeldArtifactEntry[];
  /** Whole-read deadline covering object lookup and streamed byte consumption. */
  readonly timeoutMilliseconds?: number;
}

export type V2ArtifactSourceErrorCode =
  | "unavailable"
  | "too_large"
  | "integrity_failure"
  | "timeout";

/** Safe, payload-free failure from the Host-held artifact source. */
export class V2ArtifactSourceError extends Error {
  constructor(readonly code: V2ArtifactSourceErrorCode) {
    super(code);
    this.name = "V2ArtifactSourceError";
  }
}

interface SnapshotEntry {
  readonly objectKey: string;
  readonly grants: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Resolve only operator-configured, pre-held objects. The caller supplies the
 * exact source identity and authorization context, never an object key.
 */
export function createV2HeldArtifactSource(options: V2HeldArtifactSourceOptions): V2ArtifactSource {
  if (!options || !Array.isArray(options.entries) || !options.objects) {
    throw new TypeError("invalid held artifact source configuration");
  }

  const objects = options.objects;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_READ_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > MAX_READ_TIMEOUT_MILLISECONDS
  ) {
    throw new TypeError("invalid held artifact source timeout");
  }
  const entries = new Map<string, Map<string, SnapshotEntry>>();
  for (const configured of options.entries) {
    if (
      !configured ||
      !isValidArtifactUrl(configured.url) ||
      typeof configured.sha256 !== "string" ||
      !SHA256.test(configured.sha256) ||
      typeof configured.objectKey !== "string" ||
      configured.objectKey.length === 0 ||
      !Array.isArray(configured.grants) ||
      configured.grants.length === 0
    ) {
      throw new TypeError("invalid held artifact source configuration");
    }

    let byDigest = entries.get(configured.url);
    if (!byDigest) {
      byDigest = new Map();
      entries.set(configured.url, byDigest);
    }
    if (byDigest.has(configured.sha256)) {
      throw new TypeError("duplicate held artifact source identity");
    }

    const grants = new Map<string, Set<string>>();
    for (const grant of configured.grants) {
      if (
        !grant ||
        typeof grant.principal !== "string" ||
        grant.principal.length === 0 ||
        typeof grant.space !== "string" ||
        grant.space.length === 0
      ) {
        throw new TypeError("invalid held artifact source grant");
      }
      let spaces = grants.get(grant.principal);
      if (!spaces) {
        spaces = new Set();
        grants.set(grant.principal, spaces);
      }
      spaces.add(grant.space);
    }

    byDigest.set(configured.sha256, {
      objectKey: configured.objectKey,
      grants,
    });
  }

  return {
    async read(input): Promise<Uint8Array> {
      if (
        !input ||
        typeof input.principal !== "string" ||
        typeof input.space !== "string" ||
        typeof input.url !== "string" ||
        typeof input.sha256 !== "string" ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 0 ||
        input.maxBytes > MAX_HOST_HELD_ARTIFACT_READ_BYTES
      ) {
        throw new V2ArtifactSourceError("unavailable");
      }

      const entry = entries.get(input.url)?.get(input.sha256);
      if (!entry?.grants.get(input.principal)?.has(input.space)) {
        throw new V2ArtifactSourceError("unavailable");
      }

      return await readHeldBytes({
        objects,
        objectKey: entry.objectKey,
        expectedSha256: input.sha256,
        maxBytes: input.maxBytes,
        timeoutMilliseconds,
      });
    },
  };
}

async function readHeldBytes(input: {
  readonly objects: Pick<ObjectStoreAccess, "get">;
  readonly objectKey: string;
  readonly expectedSha256: string;
  readonly maxBytes: number;
  readonly timeoutMilliseconds: number;
}): Promise<Uint8Array> {
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let storedPromise: Promise<StoredObjectBody | null> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + input.timeoutMilliseconds;
  const expire = (): V2ArtifactSourceError => {
    timedOut = true;
    if (reader) cancelReader(reader);
    return new V2ArtifactSourceError("timeout");
  };

  const work = async (): Promise<Uint8Array> => {
    let stored: StoredObjectBody | null;
    try {
      storedPromise = input.objects.get(input.objectKey);
      stored = await storedPromise;
    } catch {
      throw new V2ArtifactSourceError("unavailable");
    }
    if (timedOut || Date.now() >= deadline) {
      timedOut = true;
      if (stored) cancelBody(stored.body);
      throw new V2ArtifactSourceError("timeout");
    }
    if (!stored) throw new V2ArtifactSourceError("unavailable");

    try {
      reader = stored.body.getReader();
    } catch {
      throw new V2ArtifactSourceError("unavailable");
    }
    const chunks: Uint8Array[] = [];
    const pendingChunks: Uint8Array[] = [];
    const hash = sha256.create();
    let totalBytes = 0;
    let pendingBytes = 0;
    let iterations = 0;
    try {
      while (true) {
        if (timedOut || Date.now() >= deadline) throw expire();
        iterations += 1;
        const result = await reader.read();
        if (timedOut || Date.now() >= deadline) throw expire();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) {
          cancelReader(reader);
          throw new V2ArtifactSourceError("unavailable");
        }
        const chunk = result.value;
        if (chunk.byteLength > input.maxBytes - totalBytes) {
          cancelReader(reader);
          throw new V2ArtifactSourceError("too_large");
        }
        if (chunk.byteLength === 0) {
          if (iterations % READ_YIELD_INTERVAL === 0) await yieldToTimers();
          continue;
        }
        const copy = chunk.slice();
        hash.update(copy);
        pendingChunks.push(copy);
        pendingBytes += copy.byteLength;
        totalBytes += copy.byteLength;
        if (pendingChunks.length >= MAX_PENDING_CHUNKS) {
          chunks.push(compactChunks(pendingChunks, pendingBytes));
          pendingChunks.length = 0;
          pendingBytes = 0;
        }
        if (iterations % READ_YIELD_INTERVAL === 0) await yieldToTimers();
      }
    } catch (error) {
      if (error instanceof V2ArtifactSourceError) throw error;
      throw new V2ArtifactSourceError("unavailable");
    }

    if (timedOut || Date.now() >= deadline) throw expire();
    if (pendingChunks.length > 0) chunks.push(compactChunks(pendingChunks, pendingBytes));
    if (bytesToHex(hash.digest()) !== input.expectedSha256) {
      throw new V2ArtifactSourceError("integrity_failure");
    }
    if (timedOut || Date.now() >= deadline) throw expire();

    const output = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (timedOut || Date.now() >= deadline) throw expire();
    return output;
  };

  const timed = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(expire());
    }, input.timeoutMilliseconds);
  });
  try {
    return await Promise.race([work(), timed]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // A pending read may make release unavailable; the deadline still wins.
      }
    }
    // Observe a late rejection and dispose a body that arrives after timeout.
    if (timedOut && storedPromise) {
      void storedPromise.then(
        (stored) => {
          if (stored) cancelBody(stored.body);
        },
        () => undefined,
      );
    }
  }
}

function compactChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();
  const compact = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    compact.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return compact;
}

function yieldToTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup is best-effort and must never replace the safe source error.
  }
}

function cancelBody(body: ReadableStream<Uint8Array>): void {
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Cleanup is best-effort and must never replace the safe source error.
  }
}

function isValidArtifactUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ARTIFACT_URL_MAX_ASCII_BYTES &&
    isV2HttpsUrl(value) &&
    !value.includes("?") &&
    !value.includes("#")
  );
}
