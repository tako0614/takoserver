import type { DockerContainerCreateSession } from "./docker-container-create-custody.ts";
import type { DockerImageAcquisitionTarget } from "./docker-container-image-acquisition.ts";
import type {
  DockerImageSourcePort,
  DockerImageSupplyLimits,
} from "./docker-container-image-supplier.ts";
import { expandDockerRegistryLayer } from "./docker-registry-codec.ts";
import {
  captureDockerRegistryWireHeaders,
  DockerRegistrySourceError,
  type DockerRegistryWire,
  type DockerRegistryWireReply,
  dockerRegistryLocalAddresses,
  isDockerRegistryPublicAddress,
  nodeDockerRegistryWire,
  registryFailure,
  sameDockerRegistryAddress,
} from "./docker-registry-wire.ts";

type Credentials =
  | { readonly kind: "anonymous" }
  | { readonly kind: "basic"; readonly username: string; readonly password: string };
/** Host-owned credential loan. The implementation must reacquire the original
 * accepted operator origin/repository, await use exactly once, and close its
 * loan only after that callback settles. No tenant credential/DTO is accepted. */
export interface DockerRegistryCredentialOwner {
  withCredentials<T>(
    session: DockerContainerCreateSession,
    target: DockerImageAcquisitionTarget,
    scope: { readonly origin: string; readonly repository: string },
    use: (credentials: Credentials) => Promise<T>,
  ): Promise<T>;
}
export interface DockerRegistrySourcePolicy {
  readonly maxConcurrentTransfers: number;
  readonly maxDnsAnswers: number;
  readonly maxRequests: number;
  readonly maxWireBytes: number;
  readonly maxChunks: number;
  readonly chunkBytes: number;
  readonly maxTokenBytes: number;
  readonly maxCodecFrames: number;
  readonly maxCodecHeaderBytes: number;
  readonly maxCodecWindowBytes: number;
  readonly deniedHosts: readonly string[];
  readonly deniedAddresses: readonly string[];
  /** Exact Host-owned token endpoints, never a registry-directed credential grant. */
  readonly tokenRealms: readonly { readonly url: string; readonly service?: string }[];
}
const REF =
  /^([a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?)\/([a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*)@(sha256:[a-f0-9]{64})$/u;
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((char) => {
      const point = char.charCodeAt(0);
      return point < 32 || point === 127;
    })
  );
}
const safeError = (error: unknown) =>
  error instanceof DockerRegistrySourceError ? error : new DockerRegistrySourceError("unavailable");
function checkedUrl(raw: string) {
  if (!text(raw, 4096) || /[\\\s]/u.test(raw)) return registryFailure("invalid_request");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return registryFailure("invalid_request");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1))
  )
    return registryFailure("invalid_request");
  return url;
}
function challenge(raw: string, repository: string) {
  if (!text(raw, 4096)) return registryFailure("conflict");
  if (/^Basic(?:\s|$)/iu.test(raw)) return { kind: "basic" as const };
  if (!/^Bearer\s+/iu.test(raw)) return registryFailure("conflict");
  const rest = raw.replace(/^Bearer\s+/iu, ""),
    values = new Map<string, string>();
  let at = 0;
  for (const match of rest.matchAll(/([a-z]+)="([^"\\]*)"(?:\s*,\s*|\s*$)/giu)) {
    const key = match[1]!.toLowerCase();
    if (match.index !== at || values.has(key) || !["realm", "service", "scope"].includes(key))
      return registryFailure("conflict");
    values.set(key, match[2]!);
    at += match[0].length;
  }
  if (
    at !== rest.length ||
    !values.has("realm") ||
    (values.has("scope") && values.get("scope") !== `repository:${repository}:pull`)
  )
    return registryFailure("conflict");
  const realm = checkedUrl(values.get("realm")!);
  const service = values.get("service");
  if (service !== undefined && !text(service, 512)) return registryFailure("conflict");
  return { kind: "bearer" as const, realm, service };
}

/** One shared transfer budget per Host runtime factory. Exhaustion refuses;
 * it never creates an unbounded queue or retries an unknown wire operation. */
/**
 * The original concrete Node wire has no browser cookie jar and receives only freshly captured
 * headers. Request.credentials is not an authority input on that path: Bun ignores this metadata.
 * Generic injected ports retain the original omit-only admission contract and gain no concrete
 * no-ambient guarantee from a caller flag, wrapper, or claimed transport capability.
 */
export function createDockerRegistrySourceFactory(options: {
  readonly credentials: DockerRegistryCredentialOwner;
  readonly limits: DockerImageSupplyLimits;
  readonly policy: DockerRegistrySourcePolicy;
  readonly wire?: DockerRegistryWire;
}) {
  const policy = Object.freeze({
    ...options.policy,
    deniedHosts: [...options.policy.deniedHosts],
    deniedAddresses: [...options.policy.deniedAddresses],
    tokenRealms: options.policy.tokenRealms.map((value) => Object.freeze({ ...value })),
  });
  const limits = Object.freeze({ ...options.limits }),
    wire = options.wire ?? nodeDockerRegistryWire;
  const numeric = [
    policy.maxConcurrentTransfers,
    policy.maxDnsAnswers,
    policy.maxRequests,
    policy.maxWireBytes,
    policy.maxChunks,
    policy.chunkBytes,
    policy.maxTokenBytes,
    policy.maxCodecFrames,
    policy.maxCodecHeaderBytes,
    policy.maxCodecWindowBytes,
    limits.maxDurationMs,
  ];
  if (
    numeric.some((n) => !Number.isSafeInteger(n) || n < 1) ||
    policy.chunkBytes > 65536 ||
    policy.chunkBytes < 64 ||
    policy.maxCodecHeaderBytes < 18 ||
    policy.maxCodecWindowBytes > 2 ** 30 ||
    policy.maxTokenBytes > 65536 ||
    limits.maxDurationMs > 2_147_483_647
  )
    return registryFailure("invalid_request");
  for (const realm of policy.tokenRealms) {
    const url = checkedUrl(realm.url);
    if (url.href !== realm.url || (realm.service !== undefined && !text(realm.service, 512)))
      return registryFailure("invalid_request");
  }
  if (
    policy.deniedHosts.some((host) => !text(host, 253) || !/^[a-z0-9.-]+$/u.test(host)) ||
    policy.deniedAddresses.some((ip) => !text(ip, 64))
  )
    return registryFailure("invalid_request");
  const deniedAddresses = [...policy.deniedAddresses, ...dockerRegistryLocalAddresses()];
  let inFlight = 0;
  return (
    session: DockerContainerCreateSession,
    target: DockerImageAcquisitionTarget,
  ): DockerImageSourcePort => {
    const match = REF.exec(target.image);
    if (!match || target.image.length > 512) return registryFailure("invalid_request");
    const origin = new URL(`https://${match[1]}`).origin,
      repository = match[2]!,
      prefix = `/v2/${repository}/`;
    const signal = session.signal,
      deadline = performance.now() + limits.maxDurationMs;
    for (const key of [
      "installationId",
      "resourceUid",
      "incarnationId",
      "revision",
      "identityLabel",
      "revisionLabel",
    ] as const)
      if (target[key] !== session.record.intent[key]) return registryFailure("conflict");
    let requests = 0,
      wireBytes = 0,
      bodyChunks = 0,
      reading = false;
    const check = () => {
      if (signal.aborted || performance.now() >= deadline) return registryFailure();
    };
    const guard = async () => {
      check();
      await session.guard();
      check();
    };
    async function dial(
      url: URL,
      headers: Readonly<Record<string, string>>,
      maxBytes: number,
      abort: AbortSignal,
    ) {
      const activeGuard = async () => {
        if (abort.aborted) return registryFailure();
        await guard();
        if (abort.aborted) return registryFailure();
      };
      await activeGuard();
      if (
        ++requests > policy.maxRequests ||
        policy.maxWireBytes <= wireBytes ||
        policy.maxChunks <= bodyChunks
      )
        return registryFailure("conflict");
      const host = url.hostname.toLowerCase();
      if (policy.deniedHosts.includes(host)) return registryFailure("conflict");
      const addresses = await wire.resolve(host, abort, deadline);
      await activeGuard();
      if (
        !addresses.length ||
        addresses.length > policy.maxDnsAnswers ||
        addresses.some(
          (peer) =>
            ![4, 6].includes(peer.family) ||
            !isDockerRegistryPublicAddress(peer.address) ||
            deniedAddresses.some((ip) => sameDockerRegistryAddress(ip, peer.address)),
        )
      )
        return registryFailure("conflict");
      const peer = addresses[0]!;
      const reply = await wire.get({
        url,
        peer,
        headers: captureDockerRegistryWireHeaders(headers),
        signal: abort,
        deadline,
        maxBytes: Math.min(maxBytes, policy.maxWireBytes - wireBytes),
        maxChunks: policy.maxChunks - bodyChunks,
        chunkBytes: policy.chunkBytes,
        guard: activeGuard,
      });
      try {
        await activeGuard();
        if (
          !sameDockerRegistryAddress(reply.remoteAddress, peer.address) ||
          !isDockerRegistryPublicAddress(reply.remoteAddress) ||
          deniedAddresses.some((ip) => sameDockerRegistryAddress(ip, reply.remoteAddress)) ||
          reply.response.redirected ||
          reply.response.url !== url.href ||
          (reply.response.status >= 300 && reply.response.status < 400)
        )
          return registryFailure("conflict");
        return reply;
      } catch (error) {
        await reply.close();
        throw error;
      }
    }
    async function* bytes(reply: DockerRegistryWireReply, cap: number) {
      const reader = reply.response.body?.getReader();
      if (!reader) return registryFailure("conflict");
      let total = 0,
        empty = 0;
      try {
        for (;;) {
          await guard();
          const next = await reader.read();
          await guard();
          if (next.done) break;
          if (
            !(next.value instanceof Uint8Array) ||
            next.value.byteLength > cap - total ||
            next.value.byteLength > policy.maxWireBytes - wireBytes ||
            ++bodyChunks > policy.maxChunks
          )
            return registryFailure("conflict");
          if (!next.value.byteLength) {
            if (++empty > 64) return registryFailure("conflict");
            continue;
          }
          empty = 0;
          total += next.value.byteLength;
          wireBytes += next.value.byteLength;
          yield next.value;
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
          await reply.close();
        }
      }
    }
    return Object.freeze({
      origin,
      async read(request: Request) {
        await guard();
        if (request.signal.aborted) return registryFailure();
        const url = checkedUrl(request.url);
        if (
          url.origin !== origin ||
          url.search ||
          !url.pathname.startsWith(prefix) ||
          !/^(?:manifests|blobs)\/sha256:[a-f0-9]{64}$/u.test(url.pathname.slice(prefix.length)) ||
          request.method !== "GET" ||
          request.body !== null ||
          request.redirect !== "manual" ||
          !["omit", "same-origin", "include"].includes(request.credentials) ||
          (wire !== nodeDockerRegistryWire && request.credentials !== "omit") ||
          [...request.headers.keys()].some((key) => key !== "accept") ||
          !text(request.headers.get("accept"), 2048) ||
          reading ||
          inFlight >= policy.maxConcurrentTransfers
        )
          return registryFailure("conflict");
        reading = true;
        inFlight++;
        const cap = url.pathname.slice(prefix.length).startsWith("manifests/")
          ? limits.maxManifestBytes
          : Math.max(limits.maxConfigBytes, limits.maxLayerCompressedBytes);
        const cancellation = new AbortController();
        const abort = () => {
          cancellation.abort();
          release();
        };
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const timer = setTimeout(abort, Math.max(1, Math.floor(deadline - performance.now())));
        signal.addEventListener("abort", abort, { once: true });
        request.signal.addEventListener("abort", abort, { once: true });
        let deliver!: (response: Response) => void,
          refuse!: (error: unknown) => void,
          delivered = false,
          invocations = 0,
          ownerEnded = false,
          current: DockerRegistryWireReply | undefined;
        const ready = new Promise<Response>((resolve, reject) => {
          deliver = resolve;
          refuse = reject;
        });
        const heldGuard = async () => {
          if (ownerEnded || cancellation.signal.aborted) return registryFailure();
          await guard();
          if (ownerEnded || cancellation.signal.aborted) return registryFailure();
        };
        const loan = Promise.resolve().then(() =>
          options.credentials.withCredentials(
            session,
            target,
            { origin, repository },
            async (credentials) => {
              if (invocations++ !== 0 || ownerEnded) return registryFailure();
              await heldGuard();
              if (
                !credentials ||
                typeof credentials !== "object" ||
                !["anonymous", "basic"].includes(credentials.kind)
              )
                return registryFailure("conflict");
              let basic: string | undefined;
              if (credentials.kind === "basic") {
                if (
                  !text(credentials.username, 512) ||
                  credentials.username.includes(":") ||
                  !text(credentials.password, 8192)
                )
                  return registryFailure("conflict");
                basic = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
              }
              const headers = { accept: request.headers.get("accept")! };
              current = await dial(url, headers, cap, cancellation.signal);
              await heldGuard();
              if (current.response.status === 401) {
                const auth = challenge(
                  current.response.headers.get("www-authenticate") ?? "",
                  repository,
                );
                await current.close();
                current = undefined;
                await heldGuard();
                let authorization: string;
                if (auth.kind === "basic") {
                  if (!basic) return registryFailure("conflict");
                  authorization = basic;
                } else {
                  if (
                    basic &&
                    !policy.tokenRealms.some(
                      (value) => value.url === auth.realm.href && value.service === auth.service,
                    )
                  )
                    return registryFailure("conflict");
                  const tokenUrl = new URL(auth.realm);
                  if (auth.service !== undefined)
                    tokenUrl.searchParams.set("service", auth.service);
                  tokenUrl.searchParams.set("scope", `repository:${repository}:pull`);
                  current = await dial(
                    tokenUrl,
                    { accept: "application/json", ...(basic ? { authorization: basic } : {}) },
                    policy.maxTokenBytes,
                    cancellation.signal,
                  );
                  if (current.response.status !== 200) return registryFailure("conflict");
                  const chunks: Uint8Array[] = [];
                  let length = 0;
                  for await (const chunk of bytes(current, policy.maxTokenBytes)) {
                    chunks.push(chunk);
                    length += chunk.byteLength;
                  }
                  current = undefined;
                  const body = new Uint8Array(length);
                  let at = 0;
                  for (const chunk of chunks) {
                    body.set(chunk, at);
                    at += chunk.byteLength;
                  }
                  let value: unknown;
                  try {
                    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
                  } catch {
                    return registryFailure("conflict");
                  }
                  if (typeof value !== "object" || value === null || Array.isArray(value))
                    return registryFailure("conflict");
                  const tokens = value as { token?: unknown; access_token?: unknown };
                  const token = tokens.token ?? tokens.access_token;
                  if (
                    !text(token, policy.maxTokenBytes) ||
                    !/^[A-Za-z0-9._~+/-]+=*$/u.test(token) ||
                    (tokens.token !== undefined &&
                      tokens.access_token !== undefined &&
                      tokens.token !== tokens.access_token)
                  )
                    return registryFailure("conflict");
                  authorization = `Bearer ${token}`;
                }
                await heldGuard();
                current = await dial(url, { ...headers, authorization }, cap, cancellation.signal);
                await heldGuard();
              }
              if (current.response.status !== 200) return registryFailure("conflict");
              const input = bytes(current, cap),
                reply = current;
              const response = new Response(
                new ReadableStream<Uint8Array>(
                  {
                    async pull(output) {
                      try {
                        await heldGuard();
                        const next = await input.next();
                        if (next.done) {
                          release();
                          await loan;
                          output.close();
                        } else output.enqueue(next.value);
                      } catch (error) {
                        release();
                        await loan.catch(() => {});
                        output.error(safeError(error));
                      }
                    },
                    async cancel() {
                      release();
                      await reply.close();
                      await input.return(undefined);
                      await loan;
                    },
                  },
                  { highWaterMark: 0 },
                ),
                { status: 200, headers: current.response.headers },
              );
              Object.defineProperty(response, "url", { value: url.href });
              delivered = true;
              deliver(response);
              await released;
              await current.close();
              await heldGuard();
            },
          ),
        );
        const finished = loan
          .then(
            () => {
              if (invocations !== 1 || !delivered) return registryFailure();
            },
            (error) => {
              throw error;
            },
          )
          .finally(async () => {
            ownerEnded = true;
            cancellation.abort();
            release();
            try {
              await current?.close();
            } finally {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
              request.signal.removeEventListener("abort", abort);
              reading = false;
              inFlight--;
            }
          });
        void finished.catch((error) => {
          if (!delivered) refuse(safeError(error));
        });
        // Replace the callback's loan completion with the full owner-finalizer
        // join at the boundary returned to the supplier.
        const response = await ready;
        const reader = response.body!.getReader();
        const output = new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (next.done) {
                    await finished;
                    reader.releaseLock();
                    controller.close();
                  } else controller.enqueue(next.value);
                } catch (error) {
                  await finished.catch(() => {});
                  reader.releaseLock();
                  controller.error(safeError(error));
                }
              },
              async cancel() {
                try {
                  await reader.cancel();
                } finally {
                  reader.releaseLock();
                  await finished;
                }
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200, headers: response.headers },
        );
        Object.defineProperty(output, "url", { value: url.href });
        return output;
      },
      expand(
        codec: Parameters<DockerImageSourcePort["expand"]>[0],
        compressed: Parameters<DockerImageSourcePort["expand"]>[1],
        codecSignal: Parameters<DockerImageSourcePort["expand"]>[2],
      ) {
        check();
        return expandDockerRegistryLayer(
          codec,
          compressed,
          codecSignal,
          {
            maxCompressedBytes: limits.maxLayerCompressedBytes,
            maxExpandedBytes: limits.maxLayerExpandedBytes,
            maxWindowBytes: policy.maxCodecWindowBytes,
            maxFrames: policy.maxCodecFrames,
            maxChunks: policy.maxChunks,
            chunkBytes: policy.chunkBytes,
            maxHeaderBytes: policy.maxCodecHeaderBytes,
            timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
          },
          guard,
        );
      },
    });
  };
}
