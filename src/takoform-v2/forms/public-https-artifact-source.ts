import {
  createV2HeldArtifactSource,
  readV2BoundedArtifactBytes,
  V2_ARTIFACT_SOURCE_MAX_BYTES,
  type V2ArtifactSource,
  V2ArtifactSourceError,
  type V2HeldArtifactSourceOptions,
} from "./artifact-source.ts";
import { isArtifactUrl } from "./artifact-validation.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAX_TIMEOUT_MILLISECONDS = 120_000;
const NONPUBLIC_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
];

/**
 * Trusted operator capability: its connection path must enforce public-only DNS
 * and IP resolution, including DNS rebinding. URL validation here cannot do so.
 * It must honor the Request's manual redirect and abort signal.
 */
export type V2PublicOnlyArtifactFetch = (request: Request) => Promise<Response>;

export interface V2PublicHttpsArtifactSourceOptions {
  readonly fetchPublic: V2PublicOnlyArtifactFetch;
  readonly timeoutMilliseconds?: number;
}

function publicArtifactUrl(value: unknown): value is string {
  if (!isArtifactUrl(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (
      url.href === value &&
      url.port === "" &&
      host.includes(".") &&
      !host.startsWith("[") &&
      !host.endsWith(".") &&
      !/^[0-9.]+$/u.test(host) &&
      !NONPUBLIC_SUFFIXES.some((suffix) => host.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function discard(body: ReadableStream<Uint8Array> | null): void {
  try {
    if (body) void body.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not expose a transport response or replace the safe error.
  }
}

/**
 * Anonymous public HTTPS acquisition; never selects global fetch by default.
 * This mode has no per-URL principal/Space grant: the accepted Host Operation
 * must already authorize its caller, and only code-selected policy enables it.
 * Private publisher credentials are not present in the Form or source port.
 */
export function createV2PublicHttpsArtifactSource(
  options: V2PublicHttpsArtifactSourceOptions,
): V2ArtifactSource {
  if (!options || typeof options.fetchPublic !== "function")
    throw new TypeError("public-only artifact transport is required");
  const fetchPublic = options.fetchPublic;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > MAX_TIMEOUT_MILLISECONDS
  )
    throw new TypeError("invalid public artifact source timeout");

  return {
    async read(input): Promise<Uint8Array> {
      if (
        !input ||
        typeof input.principal !== "string" ||
        input.principal.length === 0 ||
        typeof input.space !== "string" ||
        input.space.length === 0 ||
        !publicArtifactUrl(input.url) ||
        typeof input.sha256 !== "string" ||
        !SHA256.test(input.sha256) ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 0 ||
        input.maxBytes > V2_ARTIFACT_SOURCE_MAX_BYTES
      )
        throw new V2ArtifactSourceError("unavailable");

      const url = input.url;
      const sha256 = input.sha256;
      const maxBytes = input.maxBytes;
      const abort = new AbortController();
      return await readV2BoundedArtifactBytes({
        open: async () => {
          // Keep anonymous Fetch semantics for runtimes which support credentials;
          // Workers' RequestInit is narrower and has no cookie-jar option.
          const anonymousRequest = {
            method: "GET",
            headers: new Headers(),
            credentials: "omit" as const,
            redirect: "manual" as const,
            signal: abort.signal,
          };
          const request = new Request(url, anonymousRequest);
          const response = await fetchPublic(request);
          if (
            response.status !== 200 ||
            response.redirected ||
            (response.url !== "" && response.url !== url) ||
            !response.body
          ) {
            discard(response.body);
            return null;
          }
          return { body: response.body };
        },
        expectedSha256: sha256,
        maxBytes,
        timeoutMilliseconds,
        onTimeout: () => abort.abort(),
      });
    },
  };
}

/** Held URL ownership is exclusive, including wrong digests and denied grants. */
export function createV2HeldOrPublicArtifactSource(
  options: V2HeldArtifactSourceOptions & V2PublicHttpsArtifactSourceOptions,
): V2ArtifactSource {
  const entries = [...options.entries];
  const held = createV2HeldArtifactSource({
    objects: options.objects,
    entries,
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });
  const heldUrls = new Set(entries.map((entry) => entry.url));
  const publicHttps = createV2PublicHttpsArtifactSource(options);
  return {
    read: (input) => (heldUrls.has(input.url) ? held.read(input) : publicHttps.read(input)),
  };
}
