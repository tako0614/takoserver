/**
 * Shared harness for running Takoform's Host API v2 HTTP baseline probe
 * against real `bun src/entry-bun.ts` processes.
 *
 * The probe is Takoform's (`conformance/v2/host-api.mjs`), vendored byte-exact
 * under `vendor/takoform/host-api-v2-conformance/`. Its manifest is pinned here
 * by size and SHA-256, and every listed file is verified before the probe is
 * imported, so a drifted or substituted copy never runs. This module only boots
 * the Host, provisions the documented operator path (first boot, operator
 * assertion, organization, API key, held artifacts) and gives the probe a
 * loopback transport; it adds no assertions of its own to the probe's.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { base64UrlEncode } from "../../src/json.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { signOperatorAssertion } from "../../src/operator-key.ts";

const REPOSITORY_ROOT = join(import.meta.dir, "..", "..");
const VENDOR_ROOT = join(REPOSITORY_ROOT, "vendor", "takoform", "host-api-v2-conformance");
const MANIFEST_SIZE = 569;
const MANIFEST_SHA256 = "b5af2fdb9f6f670b56688edde95097cf9c17d1374816dd33cc60a66c80797c5d";
const SOURCE_REPOSITORY = "https://github.com/tako0614/takoform.git";
const SOURCE_COMMIT = "ba0bf1c4c7f1f89f7ebc4b7082a169760c904d54";
const PROBE_SOURCE = "conformance/v2/host-api.mjs";

export const CONFORMANCE_PUBLIC_ORIGIN = "https://conformance.takoserver.test";
const PUBLIC_HOST = "conformance.takoserver.test";
const CURSOR_KEY = base64UrlEncode(new Uint8Array(32).fill(0x63));
/** A well-formed Form URL this Host has never implemented. */
const UNKNOWN_FORM = "https://forms.example.test/conformance/unimplemented/0.1.0";

export const CONFORMANCE_DOCUMENTATION = {
  documentation: "https://docs.example.test/takoform-v2",
  authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
} as const;

/** What the probe returns when its mandatory sequence passes; nothing more is claimed. */
export const BASELINE_PASSED = {
  baseline: "passed",
  fullConformance: false,
  gaps: {
    restart: "not-tested",
    faultInjection: "not-tested",
    concurrentRequests: "not-tested",
    crossPrincipal: "not-tested",
    optionalFeatures: "not-tested",
    formSpecific: "not-tested",
  },
} as const;

type Json = Record<string, unknown>;

interface ProbeTransportRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly authenticated: boolean;
  readonly signal: AbortSignal;
}

export interface ProbeResult {
  readonly baseline: string;
  readonly fullConformance: boolean;
  readonly gaps: Readonly<Record<string, string>>;
}

export type RunHostApiV2 = (input: {
  readonly origin: string;
  readonly transport: (request: ProbeTransportRequest) => Promise<Response>;
  readonly fixture: Json;
  readonly maxPolls?: number;
  readonly timeoutMs?: number;
  readonly pollDelayMs?: number;
}) => Promise<ProbeResult>;

interface SourceManifest {
  readonly format: string;
  readonly repository: string;
  readonly tag: string | null;
  readonly commit: string;
  readonly files: readonly {
    readonly local: string;
    readonly source: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
/** First boot prints an operator sign-in assertion; never echo it in a failure. */
const redacted = (output: string): string =>
  output.replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, "[redacted]");

/** Refuse drifted or substituted probe bytes before any of them run. */
export async function loadPinnedHostApiV2Probe(): Promise<RunHostApiV2> {
  const manifestBytes = new Uint8Array(await readFile(join(VENDOR_ROOT, "source-manifest.json")));
  if (manifestBytes.byteLength !== MANIFEST_SIZE || sha256(manifestBytes) !== MANIFEST_SHA256) {
    throw new Error("takoform_v2_conformance_source_manifest_mismatch");
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SourceManifest;
  if (
    manifest.format !== "takoserver.vendored-takoform-source@v1" ||
    manifest.repository !== SOURCE_REPOSITORY ||
    manifest.tag !== null ||
    manifest.commit !== SOURCE_COMMIT ||
    manifest.files.length !== 2 ||
    !manifest.files.some((file) => file.local === "host-api.mjs" && file.source === PROBE_SOURCE)
  ) {
    throw new Error("takoform_v2_conformance_source_authority_mismatch");
  }
  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9._-]+$/u.test(file.local)) {
      throw new Error("takoform_v2_conformance_source_path_invalid");
    }
    const bytes = new Uint8Array(await readFile(join(VENDOR_ROOT, file.local)));
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) {
      throw new Error(`takoform_v2_conformance_source_bytes_mismatch:${file.local}`);
    }
  }
  const module = (await import(pathToFileURL(join(VENDOR_ROOT, "host-api.mjs")).href)) as {
    runHostApiV2?: unknown;
  };
  if (typeof module.runHostApiV2 !== "function") {
    throw new Error("takoform_v2_conformance_probe_export_missing");
  }
  return module.runHostApiV2 as RunHostApiV2;
}

function requestAt(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", PUBLIC_HOST);
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
}

async function jsonAt(
  port: number,
  path: string,
  wantedStatus: number,
  body: Json,
  headers: Record<string, string> = {},
): Promise<Json> {
  const response = await requestAt(port, path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== wantedStatus) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof problem?.code === "string" ? ` (${problem.code})` : "";
    throw new Error(`POST ${path} returned ${response.status}${code}`);
  }
  return (await response.json()) as Json;
}

/** One loopback port that is not in `excluded`; the choice is added to it. */
export async function reserveConformancePort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const port = reservation.port;
    await reservation.stop(true);
    if (port !== undefined && !excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error("conformance port allocation unavailable");
}

export interface ConformanceHost {
  readonly child: ReturnType<typeof Bun.spawn>;
}

export async function startConformanceHost(
  root: string,
  port: number,
  config: Json,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<ConformanceHost> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: REPOSITORY_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      TMPDIR: root,
      CI: "1",
      NO_COLOR: "1",
      PORT: String(port),
      TAKOSERVER_DATA_ROOT: root,
      TAKOSERVER_PUBLIC_ORIGIN: CONFORMANCE_PUBLIC_ORIGIN,
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify(config),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
      ...extraEnv,
    },
  });
  let captured = "";
  const drain = async (stream: ReadableStream<Uint8Array> | undefined | number | null) => {
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      captured = (captured + decoder.decode(chunk, { stream: true })).slice(-20_000);
    }
  };
  void drain(child.stdout as ReadableStream<Uint8Array>);
  void drain(child.stderr as ReadableStream<Uint8Array>);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Bun entry exited during startup:\n${redacted(captured.slice(-4_000))}`);
    }
    try {
      const ready = await requestAt(port, "/_takoserver/health/ready");
      await ready.arrayBuffer();
      if (ready.status === 200) return { child };
    } catch {
      // The listener may not have bound yet.
    }
    await Bun.sleep(100);
  }
  child.kill("SIGKILL");
  await child.exited;
  throw new Error(`Bun entry readiness deadline exceeded:\n${redacted(captured.slice(-4_000))}`);
}

export async function stopConformanceHost(host: ConformanceHost | null): Promise<void> {
  if (!host || host.child.exitCode !== null) return;
  host.child.kill("SIGTERM");
  const graceful = await Promise.race([host.child.exited, Bun.sleep(15_000).then(() => null)]);
  if (graceful !== null) return;
  host.child.kill("SIGKILL");
  await Promise.race([host.child.exited, Bun.sleep(3_000)]);
  throw new Error("Bun entry did not stop gracefully");
}

/**
 * Documented first boot: sign in with the installation's operator key and
 * create an organization and a write API key. Held-artifact grants name that
 * organization, so the configured Host can start only after it exists.
 */
export async function bootstrapConformanceOwner(
  root: string,
  port: number,
): Promise<{ readonly space: string; readonly token: string }> {
  const host = await startConformanceHost(root, port, CONFORMANCE_DOCUMENTATION);
  try {
    const assertion = await signOperatorAssertion({
      privateJwk: await readFile(join(root, "operator-key.jwk"), "utf8"),
      claims: {
        purpose: "sign-in",
        aud: CONFORMANCE_PUBLIC_ORIGIN,
        provider: "google",
        subject: "v2-conformance-owner",
        email: "v2-conformance-owner@localhost",
        displayName: "V2 Conformance Owner",
      },
      nowSeconds: Math.floor(Date.now() / 1_000),
      lifetimeSeconds: 60,
    });
    const session = await jsonAt(port, "/v1/sessions", 200, {
      provider: "google",
      method: "operator-assertion",
      assertion,
      sessionTtlSeconds: 60,
    });
    const sessionAuth = { authorization: `Bearer ${String(session.sessionToken)}` };
    const created = await jsonAt(
      port,
      "/v1/organizations",
      201,
      { name: "V2 conformance owner" },
      sessionAuth,
    );
    const space = String((created.organization as Json).id);
    const key = await jsonAt(
      port,
      `/v1/organizations/${space}/api-keys`,
      201,
      { name: "v2 conformance writer", scopes: ["resources:write"], expiresInSeconds: 3_600 },
      sessionAuth,
    );
    return { space, token: String(key.secret) };
  } finally {
    await stopConformanceHost(host);
  }
}

export interface HeldArtifact {
  readonly url: string;
  readonly sha256: string;
  readonly objectKey: string;
  readonly grants: readonly { readonly principal: string; readonly space: string }[];
}

/** Operator-owned seeding: exact manifest and payload bytes in the Host's object store. */
export async function seedHeldArtifact(
  root: string,
  space: string,
  name: string,
  file: { readonly path: string; readonly text: string; readonly mediaType: string },
  entrypoint?: string,
): Promise<{ readonly spec: Json; readonly held: readonly HeldArtifact[] }> {
  const objects = createFileObjectStore({ root });
  const grants = [{ principal: `org:${space}`, space }];
  const bytes = utf8(file.text);
  const fileUrl = `https://artifacts.example.test/conformance/${name}/${file.path}`;
  const fileKey = `operator-held/conformance/${name}/${file.path}`;
  if (!(await objects.create(fileKey, bytes, { contentType: file.mediaType }))) {
    throw new Error(`held artifact ${fileKey} already exists`);
  }
  const manifestBytes = utf8(
    JSON.stringify({
      ...(entrypoint === undefined ? {} : { entrypoint }),
      files: [{ path: file.path, url: fileUrl, sha256: sha256(bytes), mediaType: file.mediaType }],
    }),
  );
  const manifestUrl = `https://artifacts.example.test/conformance/${name}/manifest.json`;
  const manifestKey = `operator-held/conformance/${name}/manifest.json`;
  if (!(await objects.create(manifestKey, manifestBytes, { contentType: "application/json" }))) {
    throw new Error(`held artifact ${manifestKey} already exists`);
  }
  return {
    spec: { artifact: { url: manifestUrl, sha256: sha256(manifestBytes) } },
    held: [
      { url: manifestUrl, sha256: sha256(manifestBytes), objectKey: manifestKey, grants },
      { url: fileUrl, sha256: sha256(bytes), objectKey: fileKey, grants },
    ],
  };
}

/** The three held-artifact Form fixtures every v2 self-host profile can carry. */
export async function seedArtifactFormFixtures(root: string, space: string) {
  const migration = await seedHeldArtifact(root, space, "migration-set", {
    path: "0001.sql",
    text: "CREATE TABLE conformance_probe (id INTEGER);\n",
    mediaType: "application/sql",
  });
  const bundle = await seedHeldArtifact(
    root,
    space,
    "worker-bundle",
    {
      path: "worker.js",
      text: "export default { fetch() { return new Response('not executed'); } };\n",
      mediaType: "application/javascript+module",
    },
    "worker.js",
  );
  const assets = await seedHeldArtifact(root, space, "static-assets", {
    path: "public/site.css",
    text: "body { color: #124; }\n",
    mediaType: "text/css",
  });
  return { migration, bundle, assets };
}

/**
 * Run the probe once for one Form against the Host on `port`. On failure the
 * error carries the probe's own reason and a method/path/status trace; bodies,
 * headers and Host output are withheld because they can carry credentials.
 */
export async function runHostApiV2Baseline(
  probe: RunHostApiV2,
  input: {
    readonly port: number;
    readonly token: string;
    readonly space: string;
    readonly form: string;
    readonly name: string;
    readonly spec: Json;
    readonly expectedSpec?: Json;
  },
): Promise<ProbeResult> {
  const trace: string[] = [];
  const transport = async (request: ProbeTransportRequest): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== CONFORMANCE_PUBLIC_ORIGIN) throw new Error("probe left the Host origin");
    const headers = new Headers(request.headers);
    if (request.authenticated) headers.set("authorization", `Bearer ${input.token}`);
    const response = await requestAt(input.port, `${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: request.signal,
    });
    trace.push(`${request.method} ${url.pathname} -> ${response.status}`);
    return response;
  };
  try {
    return await probe({
      origin: CONFORMANCE_PUBLIC_ORIGIN,
      transport,
      fixture: {
        disposable: true,
        form: input.form,
        unknownForm: UNKNOWN_FORM,
        space: input.space,
        name: input.name,
        spec: input.spec,
        ...(input.expectedSpec === undefined ? {} : { expectedSpec: input.expectedSpec }),
      },
      maxPolls: 100,
      pollDelayMs: 200,
      timeoutMs: 10_000,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "probe failed";
    throw new Error(`${reason}\ntrace:\n  ${trace.join("\n  ")}`);
  }
}
