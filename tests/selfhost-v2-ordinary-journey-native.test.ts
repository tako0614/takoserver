/**
 * One ordinary self-host journey through the documented operator path
 * (docs/self-host-operations.md): first boot from an empty directory, sign in
 * with the assertion the process prints, configure the complete local Worker
 * profile, create and serve a Worker (fetch + queue + SQLite Binding), update
 * it, SIGKILL the Host while an update Operation is unsettled, recover, and
 * delete everything in reference order.
 *
 * Everything runs as real `bun src/entry-bun.ts` processes and real workerd
 * children. The only fixtures are the held artifact bytes the operator seeds
 * and the self-signed endpoint certificate. It is a local, loopback-only
 * proof: no public DNS/TLS trust, no Cloudflare, no host reboot.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/actor-namespace.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/takoform-v2/forms/durable-workflow.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { OBJECT_BUCKET_FORM_URL } from "../src/takoform-v2/forms/object-bucket.ts";
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { linuxProcessLiveness } from "../src/workerd-linux-process.ts";

const OPT_IN = process.env.TAKOSERVER_V2_ENTRY_NATIVE;
const PUBLIC_ORIGIN = "https://journey.takoserver.test";
const PUBLIC_HOST = "journey.takoserver.test";
const V2 = "/apis/forms.takoform.com/v2";
const WORKER_TARGET = "selfhost-v2-worker-primary";
const WORKER_SUFFIX = "workers.native.test";
const CURSOR_KEY = base64UrlEncode(new Uint8Array(32).fill(0x4a));
const COMPLETE_WORKER_FORM_URLS = [
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_CRON_TRIGGER_FORM_URL,
  ACTOR_NAMESPACE_FORM_URL,
  DURABLE_WORKFLOW_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  SQLITE_DATABASE_FORM_URL,
  EDGE_KV_NAMESPACE_FORM_URL,
  OBJECT_BUCKET_FORM_URL,
  AT_LEAST_ONCE_QUEUE_FORM_URL,
  QUEUE_CONSUMER_FORM_URL,
] as const;

type Json = Record<string, unknown>;

interface Host {
  readonly child: ReturnType<typeof Bun.spawn>;
  /** Bounded copy of everything the process wrote to stdout and stderr. */
  output(): string;
}

/** Every Host this journey started, so a failure can keep their output. */
const startedHosts: Host[] = [];

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function workerModule(label: string): string {
  return `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/version") return new Response("${label}");
    if (path === "/rows") {
      const result = await env.DB.query("SELECT value FROM item ORDER BY rowid");
      return Response.json(result.rows);
    }
    if (path === "/receipts") {
      const result = await env.DB.query("SELECT value, handler FROM receipt ORDER BY id");
      return Response.json(result.rows);
    }
    if (path === "/send") {
      const id = await env.TASKS.send(url.searchParams.get("value") || "unnamed");
      return Response.json({ id });
    }
    return new Response("${label}:" + path);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const value = new TextDecoder().decode(message.body);
      await env.DB.execute("INSERT INTO receipt(value, handler) VALUES (?, ?)", [value, "${label}"]);
    }
    await batch.acknowledgeAll();
  }
};
`;
}

const MIGRATION_SQL =
  "CREATE TABLE item (value TEXT NOT NULL); INSERT INTO item VALUES ('seed'); " +
  "CREATE TABLE receipt (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL, handler TEXT NOT NULL);";

interface HeldArtifact {
  readonly url: string;
  readonly sha256: string;
  readonly objectKey: string;
  readonly grants: readonly { principal: string; space: string }[];
}

interface SeededArtifact {
  readonly manifestUrl: string;
  readonly manifestSha256: string;
  readonly held: readonly HeldArtifact[];
}

/** Operator-owned tooling: put exact manifest and payload bytes in the object store. */
async function seedArtifact(
  root: string,
  name: string,
  files: readonly { path: string; bytes: Uint8Array; mediaType: string }[],
  entrypoint: string | null,
  space: string,
): Promise<SeededArtifact> {
  const objects = createFileObjectStore({ root });
  const grants = [{ principal: `org:${space}`, space }];
  const held: HeldArtifact[] = [];
  const manifestFiles = [];
  for (const file of files) {
    const url = `https://artifacts.example.test/${name}/${file.path}`;
    const objectKey = `operator-held/journey/${name}/${file.path}`;
    expect(
      await objects.create(objectKey, file.bytes, { contentType: file.mediaType }),
    ).not.toBeNull();
    held.push({ url, sha256: sha256(file.bytes), objectKey, grants });
    manifestFiles.push({
      path: file.path,
      url,
      sha256: sha256(file.bytes),
      mediaType: file.mediaType,
    });
  }
  const manifestBytes = utf8(
    JSON.stringify(
      entrypoint === null ? { files: manifestFiles } : { entrypoint, files: manifestFiles },
    ),
  );
  const manifestUrl = `https://artifacts.example.test/${name}/manifest.json`;
  const manifestKey = `operator-held/journey/${name}/manifest.json`;
  expect(
    await objects.create(manifestKey, manifestBytes, { contentType: "application/json" }),
  ).not.toBeNull();
  const manifestSha256 = sha256(manifestBytes);
  return {
    manifestUrl,
    manifestSha256,
    held: [{ url: manifestUrl, sha256: manifestSha256, objectKey: manifestKey, grants }, ...held],
  };
}

function journeyConfig(
  migrations: readonly SeededArtifact[],
  bundles: readonly SeededArtifact[],
): string {
  return JSON.stringify({
    documentation: "https://docs.example.test/takoform-v2",
    authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
    ...(migrations.length === 0
      ? {}
      : {
          sqliteMigrationSet: {
            targetKey: "journey-local-sqlite-v1",
            heldArtifacts: migrations.flatMap((migration) => migration.held),
          },
        }),
    workerBundle: {
      targetKey: WORKER_TARGET,
      heldArtifacts: bundles.flatMap((bundle) => bundle.held),
    },
    // The complete Worker profile requires the asset Form on the same target.
    staticAssetBundle: { targetKey: WORKER_TARGET, heldArtifacts: [] },
  });
}

function requestAt(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", PUBLIC_HOST);
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
}

async function jsonAt(
  port: number,
  method: string,
  path: string,
  wantedStatus: number,
  body?: Json,
  headers: Record<string, string> = {},
): Promise<Json> {
  const response = await requestAt(port, path, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== wantedStatus) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof problem?.code === "string" ? ` (${problem.code})` : "";
    throw new Error(
      `${method} ${path.split("?")[0]} returned ${response.status}${code}, expected ${wantedStatus}`,
    );
  }
  return (await response.json()) as Json;
}

async function reservePort(excluded: Set<number>): Promise<number> {
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
  throw new Error("journey port allocation unavailable");
}

function endpointGet(
  hostname: string,
  certificate: Buffer,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: hostname,
        path,
        headers: { host: hostname },
        ca: certificate,
        rejectUnauthorized: true,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("journey Endpoint timed out")));
    request.once("error", reject);
    request.end();
  });
}

/** Retry only transport-level absence; any HTTP answer is returned as it is. */
async function endpointEventually(
  hostname: string,
  certificate: Buffer,
  path: string,
  predicate: (response: { status: number; body: string }) => boolean,
  budgetMs = 20_000,
): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + budgetMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await endpointGet(hostname, certificate, path);
      if (predicate(response)) return response;
      last = `${response.status} ${response.body.slice(0, 80)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "transport error";
    }
    await Bun.sleep(250);
  }
  throw new Error(`journey Endpoint ${path} did not reach the expected answer: ${last}`);
}

function withControl<T>(root: string, read: (database: Database) => T): T {
  const database = new Database(join(root, "control.sqlite"), { readonly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

/**
 * The Host owns every write to control.sqlite. Its bounded busy timeout turns
 * a short read here into a delay of a Host commit, and a read held past that
 * bound into a failed one, so a hot polling loop still slows the Host under
 * test. Poll slowly, and never from a hot loop.
 */
async function waitForQueueReceipt(
  root: string,
  messageId: string,
  executionState: "send_authorized" | "retired",
  budgetMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let last: Json | null = null;
  while (Date.now() < deadline) {
    await Bun.sleep(750);
    try {
      last = withControl(
        root,
        (database) =>
          database
            .query(
              `SELECT receipt.state AS receipt_state, execution.state AS execution_state
               FROM queue_v2_batch_settlements receipt
               JOIN queue_v2_batch_executions execution ON execution.batch_id = receipt.batch_id
               WHERE receipt.message_id = ? ORDER BY execution.reserved_at_ms DESC LIMIT 1`,
            )
            .get(messageId) as Json | null,
      );
    } catch {
      continue;
    }
    if (last?.receipt_state === "settled" && last.execution_state === executionState) return;
  }
  throw new Error(
    `journey Queue message ${messageId} did not settle with ${executionState}: ${JSON.stringify(last)}`,
  );
}

async function startHost(
  root: string,
  port: number,
  config: string,
  extraEnv: Record<string, string>,
): Promise<Host> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: join(import.meta.dir, ".."),
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
      TAKOSERVER_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      TAKOSERVER_TAKOFORM_V2_CONFIG: config,
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
      ...extraEnv,
    },
  });
  let captured = "";
  const drain = async (stream: ReadableStream<Uint8Array> | undefined | number | null) => {
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      captured = (captured + decoder.decode(chunk, { stream: true })).slice(-200_000);
    }
  };
  void drain(child.stdout as ReadableStream<Uint8Array>);
  void drain(child.stderr as ReadableStream<Uint8Array>);
  const host: Host = { child, output: () => captured };
  startedHosts.push(host);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Bun entry exited during startup:\n${captured.slice(-4000)}`);
    }
    try {
      const ready = await requestAt(port, "/_takoserver/health/ready");
      await ready.arrayBuffer();
      if (ready.status === 200) return host;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error(`Bun entry readiness deadline exceeded:\n${captured.slice(-4000)}`);
}

async function stopHost(host: Host | null): Promise<void> {
  if (!host || host.child.exitCode !== null) return;
  host.child.kill("SIGTERM");
  const graceful = await Promise.race([host.child.exited, Bun.sleep(15_000).then(() => null)]);
  if (graceful !== null) return;
  host.child.kill("SIGKILL");
  await Promise.race([host.child.exited, Bun.sleep(3_000)]);
  throw new Error("Bun entry did not stop gracefully");
}

async function killHost(host: Host): Promise<void> {
  if (host.child.exitCode !== null) throw new Error("Bun entry exited before the crash fence");
  host.child.kill("SIGKILL");
  const exited = await Promise.race([
    host.child.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!exited) throw new Error("Bun entry survived SIGKILL");
}

/** Descendant processes of one pid, by /proc, with their command lines. */
async function descendants(rootPid: number): Promise<{ pid: number; command: string }[]> {
  const parents = new Map<number, number>();
  const commands = new Map<number, string>();
  for (const entry of await readdir("/proc")) {
    if (!/^[0-9]+$/u.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(entry), Number(afterName[1]));
      commands.set(
        Number(entry),
        (await readFile(`/proc/${entry}/cmdline`, "utf8")).replaceAll("\0", " "),
      );
    } catch {
      // The process exited while scanning.
    }
  }
  const found: { pid: number; command: string }[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.pop() as number;
    for (const [pid, ppid] of parents) {
      if (ppid === parent) {
        found.push({ pid, command: commands.get(pid) ?? "" });
        queue.push(pid);
      }
    }
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Accept a create over real HTTP and keep the 202 identity for the replay. */
async function postWithoutResponse(
  port: number,
  path: string,
  body: Json,
  token: string,
  key: string,
): Promise<{ id: string; resourceUid: string }> {
  const response = await requestAt(port, path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 202) throw new Error(`journey create returned ${response.status}`);
  const accepted = (await response.json()) as Json;
  return { id: String(accepted.id), resourceUid: String(accepted.resourceUid) };
}

/**
 * Wait over the public API (no database reader) until the Host reports the
 * Operation as started but not settled, so the next step can crash it.
 */
async function waitUntilOperationUnsettled(
  port: number,
  token: string,
  operationId: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const operation = await jsonAt(port, "GET", `${V2}/operations/${operationId}`, 200, undefined, {
      authorization: `Bearer ${token}`,
    });
    if (operation.status === "succeeded" || operation.status === "failed") {
      throw new Error(`journey Operation settled (${String(operation.status)}) before the crash`);
    }
    if (operation.status === "running" || operation.status === "reconciling") {
      return String(operation.status);
    }
    await Bun.sleep(25);
  }
  throw new Error("journey Operation never started");
}

async function settled(port: number, token: string, operationId: string): Promise<Json> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const operation = await jsonAt(port, "GET", `${V2}/operations/${operationId}`, 200, undefined, {
      authorization: `Bearer ${token}`,
    });
    if (operation.status === "succeeded") return operation;
    if (operation.status === "failed") throw new Error("journey Operation failed");
    await Bun.sleep(250);
  }
  throw new Error("journey Operation settlement deadline exceeded");
}

async function terminal(port: number, token: string, operationId: string): Promise<Json> {
  // A killed Host's claim is retried only after its lease expires.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const operation = await jsonAt(port, "GET", `${V2}/operations/${operationId}`, 200, undefined, {
      authorization: `Bearer ${token}`,
    });
    if (operation.status === "succeeded" || operation.status === "failed") return operation;
    await Bun.sleep(250);
  }
  throw new Error("journey Operation terminal deadline exceeded");
}

interface OwnerRecord {
  readonly operationId: string;
  readonly status: string;
  readonly identity: unknown;
  readonly processIdentity: { pid: number; startTimeTicks?: string; bootId?: string } | null;
}

async function ownerState(
  root: string,
  workerUid: string,
): Promise<{ activeOperationId: string | null; incarnations: OwnerRecord[] }> {
  return JSON.parse(
    await readFile(
      join(
        root,
        "v2-worker-owners",
        createHash("sha256").update(workerUid, "utf8").digest("hex"),
        "runtime-owner.json",
      ),
      "utf8",
    ),
  );
}

interface Environment {
  readonly root: string;
  readonly port: number;
  readonly certificate: Buffer;
  readonly fullBoot: Record<string, string>;
}

async function prepareEnvironment(): Promise<Environment> {
  const workerd = process.env.TAKOSERVER_WORKERD_BINARY;
  const guard = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;
  if (!workerd || !guard) throw new Error("exact native workerd and Workflow guard are required");
  const root = await mkdtemp(join(tmpdir(), "jr-"));
  const chosen = new Set<number>([443]);
  const port = await reservePort(chosen);
  const workerdPort = await reservePort(chosen);
  const dataPlanePort = await reservePort(chosen);
  const privatePorts = await Promise.all(Array.from({ length: 5 }, () => reservePort(chosen)));
  const keys = join(root, "keys");
  await mkdir(keys, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "staging"), { recursive: true, mode: 0o700 });
  const names = ["sqlite", "kv", "objectBucket", "queue", "queueProducer"] as const;
  const keyFile = (name: string) => join(keys, `${name}.key`);
  for (const [index, name] of names.entries()) {
    await writeFile(keyFile(name), new Uint8Array(32).fill(0x41 + index), { mode: 0o600 });
  }
  const certificateFile = join(root, "cert.pem");
  const tlsKeyFile = join(root, "tls.key");
  const openssl = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      tlsKeyFile,
      "-out",
      certificateFile,
      "-days",
      "2",
      "-subj",
      `/CN=*.${WORKER_SUFFIX}`,
      "-addext",
      `subjectAltName=DNS:*.${WORKER_SUFFIX}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await openssl.exited) !== 0) throw new Error("journey Endpoint certificate unavailable");
  return {
    root,
    port,
    certificate: await readFile(certificateFile),
    fullBoot: {
      TAKOSERVER_WORKERD_BINARY: workerd,
      TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY: guard,
      TAKOSERVER_WORKERD_PORT: String(workerdPort),
      TAKOSERVER_DATA_PLANE_PORT: String(dataPlanePort),
      TAKOSERVER_V2_WORKER_RUNTIME_BOOT: JSON.stringify({
        actor: true,
        workflow: { maximumRegistrations: 64 },
      }),
      TAKOSERVER_V2_WORKER_PRIVATE_PLANES: JSON.stringify({
        sqlite: {
          privatePort: privatePorts[0],
          signingKeyFile: keyFile("sqlite"),
          stagingRoot: join(root, "staging"),
        },
        kv: { privatePort: privatePorts[1], signingKeyFile: keyFile("kv") },
        objectBucket: { privatePort: privatePorts[2], signingKeyFile: keyFile("objectBucket") },
        queue: { privatePort: privatePorts[3], signingKeyFile: keyFile("queue") },
        queueProducer: { privatePort: privatePorts[4], signingKeyFile: keyFile("queueProducer") },
      }),
      TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS: "1",
      TAKOSERVER_WORKER_ENDPOINT_SUFFIX: WORKER_SUFFIX,
      TAKOSERVER_WORKERD_TLS_CERT_FILE: certificateFile,
      TAKOSERVER_WORKERD_TLS_KEY_FILE: tlsKeyFile,
      TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: JSON.stringify({
        current: { id: "journey-fixture", key: base64UrlEncode(new Uint8Array(32).fill(0x6a)) },
      }),
    },
  };
}

/**
 * Documented first boot: an empty data root, the printed operator assertion,
 * a session, an organization and an organization API key (guide steps 1-2).
 */
async function firstBoot(environment: Environment): Promise<{
  space: string;
  token: string;
  auth: Record<string, string>;
  printedAssertion: string;
}> {
  const { root, port } = environment;
  expect(await readdir(root)).not.toContain("control.sqlite");
  const host = await startHost(root, port, journeyConfig([], []), {});
  try {
    const output = host.output();
    expect(output).toContain("applied ");
    expect(output).toContain("generated an operator key at ");
    expect(output).toContain("bun scripts/operator-key.ts sign-in google operator");
    const printed =
      /Operator sign-in assertion \(valid 10 minutes\):\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/u.exec(
        output,
      );
    if (!printed?.[1]) throw new Error("first boot did not print an operator sign-in assertion");
    // The liveness probe does not touch SQLite or workerd; readiness already passed.
    expect((await requestAt(port, "/_takoserver/health/live")).status).toBe(200);
    expect(await jsonAt(port, "GET", "/_takoserver/health/ready", 200)).toMatchObject({
      database: "readable",
      workerRuntime: "not-required",
    });
    const discovery = await requestAt(port, "/.well-known/takoform/v2");
    expect(discovery.status).toBe(200);
    await discovery.arrayBuffer();
    const session = await jsonAt(port, "POST", "/v1/sessions", 200, {
      provider: "google",
      method: "operator-assertion",
      assertion: printed[1],
    });
    const sessionAuth = { authorization: `Bearer ${String(session.sessionToken)}` };
    const created = await jsonAt(
      port,
      "POST",
      "/v1/organizations",
      201,
      { name: "Journey organization" },
      sessionAuth,
    );
    const space = String((created.organization as Json).id);
    const key = await jsonAt(
      port,
      "POST",
      `/v1/organizations/${space}/api-keys`,
      201,
      { name: "journey writer", scopes: ["resources:write"], expiresInSeconds: 7200 },
      sessionAuth,
    );
    const token = String(key.secret);
    return {
      space,
      token,
      auth: { authorization: `Bearer ${token}` },
      printedAssertion: printed[1],
    };
  } finally {
    await stopHost(host);
  }
}

function endpointFixture(label: string): Uint8Array {
  return utf8(`export default { fetch() { return new Response("${label}"); } };\n`);
}

test.skipIf(OPT_IN !== "1")(
  "ordinary self-host journey: install, serve, update, SIGKILL mid-Operation, recover, delete",
  async () => {
    startedHosts.length = 0;
    const environment = await prepareEnvironment();
    const { root, port, certificate, fullBoot } = environment;
    let host: Host | null = null;
    let completed = false;
    try {
      // ---- 1-2. First boot from an empty directory, sign in, organization, key ----
      const { space, token, auth } = await firstBoot(environment);

      // The printed "later ones" command signs a fresh assertion for the same
      // operator account from the installation's own key.
      const signer = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "scripts/operator-key.ts",
          "sign-in",
          "google",
          "operator",
          "operator@localhost",
          "Operator",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: root,
            TAKOSERVER_OPERATOR_KEY: join(root, "operator-key.jwk"),
            TAKOSERVER_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
          },
        },
      );
      const laterAssertion = (await new Response(signer.stdout).text()).trim();
      expect(await signer.exited).toBe(0);
      expect(laterAssertion).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

      // ---- 3. Operator seeds held artifacts and starts the complete profile ----
      const migration = await seedArtifact(
        root,
        "migration",
        [{ path: "0001.sql", bytes: utf8(MIGRATION_SQL), mediaType: "application/sql" }],
        null,
        space,
      );
      // 5 MiB exceeds the guarded writes of one pass, so its Operation must
      // durably stage a prefix and yield before it can settle.
      const bigBytes = new Uint8Array(5 * 1_024 * 1_024).fill(0x78);
      bigBytes[0] = 0x2d;
      bigBytes[1] = 0x2d;
      bigBytes[bigBytes.length - 1] = 0x0a;
      const bigMigration = await seedArtifact(
        root,
        "big-migration",
        [{ path: "0001.sql", bytes: bigBytes, mediaType: "application/sql" }],
        null,
        space,
      );
      const bundleV1 = await seedArtifact(
        root,
        "worker-v1",
        [
          {
            path: "worker.js",
            bytes: utf8(workerModule("journey-v1")),
            mediaType: "application/javascript+module",
          },
        ],
        "worker.js",
        space,
      );
      const configV1 = journeyConfig([migration, bigMigration], [bundleV1]);
      host = await startHost(root, port, configV1, fullBoot);
      const laterSession = await jsonAt(port, "POST", "/v1/sessions", 200, {
        provider: "google",
        method: "operator-assertion",
        assertion: laterAssertion,
      });
      const me = await jsonAt(port, "GET", "/v1/me", 200, undefined, {
        authorization: `Bearer ${String(laterSession.sessionToken)}`,
      });
      expect(JSON.stringify(me)).toContain(space);
      const support = async (form: string) =>
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(form)}`,
          200,
          undefined,
          auth,
        );
      for (const form of COMPLETE_WORKER_FORM_URLS) {
        expect(await support(form)).toMatchObject({ supported: true });
      }
      expect(await support(SQLITE_MIGRATION_APPLICATION_FORM_URL)).toMatchObject({
        supported: true,
      });
      // Nothing is published yet, so the runtime is correctly not required.
      expect(await jsonAt(port, "GET", "/_takoserver/health/ready", 200)).toMatchObject({
        status: "ready",
        workerRuntime: "not-required",
      });

      // ---- 4. Create and serve --------------------------------------------------
      const create = async (form: string, name: string, spec: Json) => {
        const body = { form, space, name, spec };
        const headers = { ...auth, "idempotency-key": `journey-${name}-create` };
        const accepted = await jsonAt(port, "POST", `${V2}/resources`, 202, body, headers);
        expect(await settled(port, token, String(accepted.id))).toMatchObject({
          effect: "complete",
        });
        return { body, headers, uid: String(accepted.resourceUid), id: String(accepted.id) };
      };
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const database = await create(SQLITE_DATABASE_FORM_URL, "database", {});
      const databaseDirectory = join(root, "v2-sqlite-databases", "resources", database.uid);
      expect((await stat(join(databaseDirectory, "database.sqlite"))).isFile()).toBe(true);
      const migrationSet = await create(SQLITE_MIGRATION_SET_FORM_URL, "migration-set", {
        artifact: { url: migration.manifestUrl, sha256: migration.manifestSha256 },
      });
      const applicationSpec = {
        database: { resourceUid: database.uid },
        migrationSet: { resourceUid: migrationSet.uid },
      };
      const application = await create(
        SQLITE_MIGRATION_APPLICATION_FORM_URL,
        "migration-application",
        applicationSpec,
      );
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${application.uid}`, 200, undefined, auth),
      ).toMatchObject({ observed: { ready: true } });
      const queue = await create(AT_LEAST_ONCE_QUEUE_FORM_URL, "queue", {
        messageRetentionSeconds: 3600,
      });
      const bundle1 = await create(WORKER_BUNDLE_FORM_URL, "bundle-v1", {
        artifact: { url: bundleV1.manifestUrl, sha256: bundleV1.manifestSha256 },
      });
      const versionSpec = (bundleUid: string): Json => ({
        worker: { resourceUid: worker.uid },
        bundle: { resourceUid: bundleUid },
        handlers: ["fetch", "queue"],
        sqliteBindings: [{ name: "DB", resource: { resourceUid: database.uid } }],
        queueProducerBindings: [{ name: "TASKS", resource: { resourceUid: queue.uid } }],
      });
      const version1 = await create(
        WORKER_VERSION_FORM_URL,
        "version-v1",
        versionSpec(bundle1.uid),
      );
      const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.uid },
        versions: [{ workerVersion: { resourceUid: version1.uid }, weight: 10_000 }],
      });
      const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: worker.uid },
      });
      const consumer = await create(QUEUE_CONSUMER_FORM_URL, "consumer", {
        queue: { resourceUid: queue.uid },
        worker: { resourceUid: worker.uid },
        maxBatchSize: 1,
        maxBatchTimeoutSeconds: 0,
        maxConcurrency: 1,
        // A rejected attempt is retried; a message that exhausts its retries
        // without a dead-letter queue is dropped by design.
        maxRetries: 5,
        retryDelaySeconds: 0,
      });
      const endpointRead = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${endpoint.uid}`,
        200,
        undefined,
        auth,
      );
      const hostname = String((endpointRead.output as Json).hostname);
      expect(hostname.endsWith(`.${WORKER_SUFFIX}`)).toBe(true);
      const get = async (path: string, wanted = (_: { status: number; body: string }) => true) =>
        await endpointEventually(hostname, certificate, path, wanted);
      expect(await get("/version", (r) => r.status === 200)).toEqual({
        status: 200,
        body: "journey-v1",
      });
      expect(await get("/rows")).toEqual({ status: 200, body: '[{"value":"seed"}]' });
      const sent = async (value: string) => {
        const response = await get(`/send?value=${value}`, (r) => r.status === 200);
        return String((JSON.parse(response.body) as Json).id);
      };
      // Observe a message through the Worker's own effect first, so the control
      // database is not read inside the dispatch write window.
      const handled = async (value: string, budgetMs = 30_000) =>
        await endpointEventually(
          hostname,
          certificate,
          "/receipts",
          (r) => r.status === 200 && r.body.includes(`"${value}"`),
          budgetMs,
        );
      const firstMessage = await sent("m-first");
      await handled("m-first");
      await waitForQueueReceipt(root, firstMessage, "retired");
      expect(await get("/receipts")).toEqual({
        status: 200,
        body: '[{"value":"m-first","handler":"journey-v1"}]',
      });

      // ---- 5. Update: operator seeds new bytes, restarts, deploys a new Version --
      await stopHost(host);
      host = null;
      const bundleV2 = await seedArtifact(
        root,
        "worker-v2",
        [
          {
            path: "worker.js",
            bytes: utf8(workerModule("journey-v2")),
            mediaType: "application/javascript+module",
          },
        ],
        "worker.js",
        space,
      );
      const configV2 = journeyConfig([migration, bigMigration], [bundleV1, bundleV2]);
      host = await startHost(root, port, configV2, fullBoot);
      // A graceful restart keeps the published Worker without client republish.
      expect(await get("/version", (r) => r.status === 200)).toEqual({
        status: 200,
        body: "journey-v1",
      });
      const bundle2 = await create(WORKER_BUNDLE_FORM_URL, "bundle-v2", {
        artifact: { url: bundleV2.manifestUrl, sha256: bundleV2.manifestSha256 },
      });
      const version2 = await create(
        WORKER_VERSION_FORM_URL,
        "version-v2",
        versionSpec(bundle2.uid),
      );
      const toV2 = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${deployment.uid}`,
        202,
        {
          spec: {
            worker: { resourceUid: worker.uid },
            versions: [{ workerVersion: { resourceUid: version2.uid }, weight: 10_000 }],
          },
        },
        {
          ...auth,
          "idempotency-key": "journey-deployment-to-v2",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, token, String(toV2.id))).toMatchObject({ effect: "complete" });
      expect(await get("/version", (r) => r.body === "journey-v2")).toEqual({
        status: 200,
        body: "journey-v2",
      });
      const secondMessage = await sent("m-second");
      await handled("m-second");
      await waitForQueueReceipt(root, secondMessage, "retired");
      expect(JSON.parse((await get("/receipts")).body)).toEqual([
        { value: "m-first", handler: "journey-v1" },
        { value: "m-second", handler: "journey-v2" },
      ]);
      // Reference protection: the bundle still has a live Version.
      await jsonAt(port, "DELETE", `${V2}/resources/${bundle1.uid}`, 409, undefined, {
        ...auth,
        "idempotency-key": "journey-bundle-v1-premature-delete",
        "takoform-expected-generation": "1",
      });

      // ---- 6. SIGKILL while an Operation is durably unsettled -------------------
      // Messages are in flight and a large artifact Operation has staged only a
      // prefix of its chunks while the Worker keeps serving.
      const inFlight = ["m-flight-1", "m-flight-2", "m-flight-3"];
      const flightIds: string[] = [];
      for (const value of inFlight) flightIds.push(await sent(value));
      const bigKey = "journey-big-migration-set-create";
      const bigBody = {
        form: SQLITE_MIGRATION_SET_FORM_URL,
        space,
        name: "big-migration-set",
        spec: { artifact: { url: bigMigration.manifestUrl, sha256: bigMigration.manifestSha256 } },
      };
      const bigAccepted = await postWithoutResponse(
        port,
        `${V2}/resources`,
        bigBody,
        token,
        bigKey,
      );
      const statusAtCrash = await waitUntilOperationUnsettled(port, token, bigAccepted.id);
      const checkpoint = { operationId: bigAccepted.id, resourceUid: bigAccepted.resourceUid };
      // The Worker was serving while the Operation was partial.
      expect((await get("/version", (r) => r.status === 200)).body).toBe("journey-v2");
      const hostPid = host.child.pid;
      const children = (await descendants(hostPid)).filter((entry) =>
        entry.command.includes("workerd"),
      );
      expect(children.length).toBeGreaterThan(0);
      await killHost(host);
      host = null;
      // The Host is gone, so its database can be read without disturbing it.
      const atCrash = withControl(
        root,
        (control) =>
          control
            .query(
              `SELECT op.status AS status,
                      (SELECT count(*) FROM tf_v2_migration_set_chunks chunk
                       WHERE chunk.resource_uid = op.resource_uid) AS staged
               FROM tf_v2_operations op WHERE op.replay_key = ?`,
            )
            .all(bigKey) as Json[],
      );
      expect(atCrash).toHaveLength(1);
      expect(["queued", "running", "reconciling"]).toContain(String(atCrash[0]?.status));
      expect(Number(atCrash[0]?.staged)).toBeLessThan(Math.ceil(bigBytes.byteLength / 65_536));
      process.stdout.write(
        `journey: SIGKILL while Operation was ${statusAtCrash}/${String(atCrash[0]?.status)} with ${String(atCrash[0]?.staged)} of ${Math.ceil(bigBytes.byteLength / 65_536)} chunks staged\n`,
      );
      // Nothing from the dead Host's process tree may outlive it.
      const survivorDeadline = Date.now() + 10_000;
      while (children.some((child) => alive(child.pid)) && Date.now() < survivorDeadline) {
        await Bun.sleep(100);
      }
      expect(children.filter((child) => alive(child.pid))).toEqual([]);

      host = await startHost(root, port, configV2, fullBoot);
      expect(host.child.pid).not.toBe(hostPid);
      // Same key, same body: the replay answers with the original Operation.
      const replay = await requestAt(port, `${V2}/resources`, {
        method: "POST",
        headers: {
          ...auth,
          "idempotency-key": bigKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(bigBody),
      });
      expect([200, 202]).toContain(replay.status);
      expect(await replay.json()).toMatchObject({
        id: checkpoint.operationId,
        resourceUid: checkpoint.resourceUid,
        generation: 1,
      });
      expect(await settled(port, token, checkpoint.operationId)).toMatchObject({
        id: checkpoint.operationId,
        effect: "complete",
      });
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/resources/${checkpoint.resourceUid}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({
        generation: 1,
        observedGeneration: 1,
        observed: { manifestSha256: bigMigration.manifestSha256, totalBytes: bigBytes.byteLength },
      });
      withControl(root, (control) => {
        expect(
          control
            .query("SELECT count(*) AS n FROM tf_v2_operations WHERE replay_key = ?")
            .get(bigKey),
        ).toEqual({ n: 1 });
        expect(
          control
            .query("SELECT count(*) AS n FROM tf_v2_migration_set_chunks WHERE resource_uid = ?")
            .get(checkpoint.resourceUid),
        ).toEqual({ n: Math.ceil(bigBytes.byteLength / 65_536) });
        expect(
          control
            .query("SELECT count(*) AS n FROM tf_v2_artifact_progress WHERE operation_id = ?")
            .get(checkpoint.operationId),
        ).toEqual({ n: 0 });
      });
      // The Worker kept its publication across the crash without a client republish.
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${deployment.uid}`, 200, undefined, auth),
      ).toMatchObject({ generation: 2, observedGeneration: 2 });
      expect(await get("/version", (r) => r.body === "journey-v2")).toEqual({
        status: 200,
        body: "journey-v2",
      });
      // A batch reserved but not yet sent at the crash is held by its 120 s
      // reservation before redelivery, so allow for it.
      for (const value of inFlight) await handled(value, 240_000);
      for (const id of flightIds) await waitForQueueReceipt(root, id, "retired", 240_000);
      const receipts = JSON.parse((await get("/receipts")).body) as {
        value: string;
        handler: string;
      }[];
      for (const value of inFlight) {
        // At-least-once: a lost ACK may repeat a handler effect, never lose one.
        expect(receipts.filter((receipt) => receipt.value === value).length).toBeGreaterThanOrEqual(
          1,
        );
      }
      // A rejected attempt settles `retry` in its own batch and the message is
      // redelivered, so each message ends with exactly one terminal ack and no
      // execution is left unretired.
      for (const id of [firstMessage, secondMessage, ...flightIds]) {
        expect(
          withControl(
            root,
            (control) =>
              control
                .query(
                  `SELECT count(*) AS n FROM queue_v2_batch_settlements
                   WHERE message_id = ? AND state = 'settled' AND outcome = 'ack'`,
                )
                .get(id) as Json,
          ),
        ).toEqual({ n: 1 });
      }
      expect(
        withControl(
          root,
          (control) =>
            control
              .query(
                `SELECT count(*) AS n FROM queue_v2_batch_executions
                 WHERE state NOT IN ('retired', 'pre_effect_refused')`,
              )
              .get() as Json,
        ),
      ).toEqual({ n: 0 });
      const afterRestartMessage = await sent("m-after-restart");
      await handled("m-after-restart");
      await waitForQueueReceipt(root, afterRestartMessage, "retired");

      // ---- 7. Delete in reference order -------------------------------------------
      const remove = async (uid: string, generation: number, name: string) => {
        const accepted = await jsonAt(port, "DELETE", `${V2}/resources/${uid}`, 202, undefined, {
          ...auth,
          "idempotency-key": `journey-${name}-delete`,
          "takoform-expected-generation": String(generation),
        });
        expect(await settled(port, token, String(accepted.id))).toMatchObject({
          effect: "complete",
        });
      };
      await remove(endpoint.uid, 1, "endpoint");
      const gone = await endpointGet(hostname, certificate, "/version").catch(() => null);
      expect(gone === null || !gone.body.startsWith("journey-")).toBe(true);
      await remove(consumer.uid, 1, "consumer");
      await remove(deployment.uid, 2, "deployment");
      await remove(version2.uid, 1, "version-v2");
      await remove(version1.uid, 1, "version-v1");
      await remove(bundle2.uid, 1, "bundle-v2");
      await remove(bundle1.uid, 1, "bundle-v1");
      await remove(checkpoint.resourceUid, 1, "big-migration-set");
      await remove(application.uid, 1, "migration-application");
      await remove(migrationSet.uid, 1, "migration-set");
      await remove(queue.uid, 1, "queue");
      await remove(database.uid, 1, "database");
      await expect(stat(databaseDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await remove(worker.uid, 1, "worker");

      // ---- 8. No residue --------------------------------------------------------
      const everything = [
        endpoint.uid,
        consumer.uid,
        deployment.uid,
        version2.uid,
        version1.uid,
        bundle2.uid,
        bundle1.uid,
        checkpoint.resourceUid,
        application.uid,
        migrationSet.uid,
        queue.uid,
        database.uid,
        worker.uid,
      ];
      for (const uid of everything) {
        const read = await requestAt(port, `${V2}/resources/${uid}`, { headers: auth });
        await read.arrayBuffer();
        expect(read.status).toBe(410);
      }
      withControl(root, (control) => {
        for (const table of [
          "tf_v2_artifact_owners",
          "tf_v2_artifact_chunks",
          "tf_v2_migration_set_owners",
          "tf_v2_migration_set_chunks",
          "tf_v2_artifact_progress",
        ]) {
          expect(control.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
      });
      const serving = (await descendants(host.child.pid)).filter((entry) =>
        entry.command.includes("workerd"),
      );
      expect(serving).toEqual([]);
      await stopHost(host);
      host = null;
      const vacant = Bun.serve({
        hostname: "127.0.0.1",
        port: 443,
        fetch: () => new Response(null, { status: 503 }),
      });
      await vacant.stop(true);
      completed = true;
    } finally {
      await Promise.allSettled([stopHost(host)]);
      if (completed) await rm(root, { recursive: true, force: true });
      else {
        for (const [index, started] of startedHosts.entries()) {
          await writeFile(join(root, `host-${index}.log`), started.output()).catch(() => undefined);
        }
        process.stderr.write(`journey: data root and host logs retained at ${root}\n`);
      }
    }
  },
  900_000,
);

/**
 * A Host that stops (SIGKILL here, SIGTERM behaves the same) while a
 * WorkerDeployment or WorkerEndpoint Operation for a published Worker is only
 * queued must boot again. Boot recovery adopts the committed incarnation that
 * was serving (the queued Operation has recorded no dispatch, so it cannot
 * have changed native state), and the normal Operation engine then runs the
 * queued Operation exactly once.
 *
 * Scope of the proof, by crash window:
 *  - queued: accepted, no dispatch recorded. Boot adopts the committed
 *    incarnation and the engine runs the Operation once.
 *  - dispatched, owner untouched: the engine recorded the dispatch
 *    (`reconciling`, simulated here with the two engine writes that precede the
 *    native send) but the owner had persisted nothing. The owner vouches that
 *    the Operation never served, boot adopts the committed incarnation and the
 *    engine re-drives the Operation once through a fresh incarnation.
 *  - dispatched, candidate persisted (real SIGKILL once the owner persisted a
 *    candidate incarnation and its child): boot abandons the dead candidate and
 *    serves the committed incarnation. The Operation ID is never given a second
 *    incarnation; the engine settles it failed with effect none, the Worker
 *    keeps serving the committed graph, and a re-apply publishes once.
 *  - dispatched AND already activated by the owner but unsettled in SQL, or a
 *    DELETE that started: still refused at boot (docs/self-host-operations.md).
 * The test refuses to run (inconclusive) rather than count a crash that landed
 * in a different window than the one it names.
 */
const PENDING_VARIANTS = [
  { pending: "deployment-update", signal: "SIGKILL", window: "queued" },
  { pending: "endpoint-update", signal: "SIGKILL", window: "queued" },
  // A graceful stop suspends the owner and takes the same recovery path.
  { pending: "deployment-update", signal: "SIGTERM", window: "queued" },
  // The Operation engine marks a dispatch (claim, then `reconciling` with
  // dispatch_possible=1) just before the native send.
  { pending: "deployment-update", signal: "SIGKILL", window: "dispatched" },
  { pending: "deployment-update", signal: "SIGKILL", window: "candidate" },
] as const;
for (const { pending, signal, window } of PENDING_VARIANTS) {
  test.skipIf(OPT_IN !== "1")(
    window === "candidate"
      ? `a ${pending} killed with its candidate incarnation persisted fails without effect, keeps serving, and a re-apply publishes once`
      : window === "dispatched"
        ? `a dispatched ${pending} that never reached the owner at ${signal} boots again and runs once`
        : `a queued ${pending} at ${signal} boots again and runs once`,
    async () => {
      startedHosts.length = 0;
      const environment = await prepareEnvironment();
      const { root, port, certificate, fullBoot } = environment;
      let host: Host | null = null;
      let completed = false;
      try {
        const { space, token, auth } = await firstBoot(environment);
        const bundle = await seedArtifact(
          root,
          "gap-worker-v1",
          [
            {
              path: "worker.js",
              bytes: endpointFixture("gap-v1"),
              mediaType: "application/javascript+module",
            },
          ],
          "worker.js",
          space,
        );
        const bundleNext = await seedArtifact(
          root,
          "gap-worker-v2",
          [
            {
              path: "worker.js",
              bytes: endpointFixture("gap-v2"),
              mediaType: "application/javascript+module",
            },
          ],
          "worker.js",
          space,
        );
        const config = journeyConfig([], [bundle, bundleNext]);
        host = await startHost(root, port, config, fullBoot);
        const create = async (form: string, name: string, spec: Json) => {
          const accepted = await jsonAt(
            port,
            "POST",
            `${V2}/resources`,
            202,
            { form, space, name, spec },
            { ...auth, "idempotency-key": `gap-${name}-create` },
          );
          expect(await settled(port, token, String(accepted.id))).toMatchObject({
            effect: "complete",
          });
          return String(accepted.resourceUid);
        };
        const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
        const bundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
          artifact: { url: bundle.manifestUrl, sha256: bundle.manifestSha256 },
        });
        const version = await create(WORKER_VERSION_FORM_URL, "version", {
          worker: { resourceUid: worker },
          bundle: { resourceUid: bundleUid },
          handlers: ["fetch"],
        });
        const nextBundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle-next", {
          artifact: { url: bundleNext.manifestUrl, sha256: bundleNext.manifestSha256 },
        });
        const nextVersion = await create(WORKER_VERSION_FORM_URL, "version-next", {
          worker: { resourceUid: worker },
          bundle: { resourceUid: nextBundleUid },
          handlers: ["fetch"],
        });
        const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
          worker: { resourceUid: worker },
          versions: [{ workerVersion: { resourceUid: version }, weight: 10_000 }],
        });
        const endpointUid = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
          worker: { resourceUid: worker },
        });
        const endpointRead = await jsonAt(
          port,
          "GET",
          `${V2}/resources/${endpointUid}`,
          200,
          undefined,
          auth,
        );
        const hostname = String((endpointRead.output as Json).hostname);
        expect(
          await endpointEventually(hostname, certificate, "/", (r) => r.body === "gap-v1"),
        ).toEqual({ status: 200, body: "gap-v1" });

        const updateKey = `gap-${pending}`;
        const target = pending === "deployment-update" ? deploymentUid : endpointUid;
        const spec: Json =
          pending === "deployment-update"
            ? {
                worker: { resourceUid: worker },
                versions: [{ workerVersion: { resourceUid: nextVersion }, weight: 10_000 }],
              }
            : { worker: { resourceUid: worker } };
        const update = await jsonAt(
          port,
          "PUT",
          `${V2}/resources/${target}`,
          202,
          { spec },
          { ...auth, "idempotency-key": updateKey, "takoform-expected-generation": "1" },
        );
        if (window === "candidate") {
          // Kill as soon as the owner has persisted a candidate incarnation and
          // recorded its child, and before it can be activated.
          const deadline = Date.now() + 60_000;
          let seen = false;
          while (Date.now() < deadline && !seen) {
            const owner = await ownerState(root, worker).catch(() => null);
            if (owner !== null) {
              seen = owner.incarnations.some(
                (item) =>
                  item.operationId === String(update.id) &&
                  item.status === "candidate" &&
                  item.processIdentity !== null,
              );
            }
            if (!seen) await Bun.sleep(2);
          }
          if (!seen)
            throw new Error("inconclusive: the update never reached a candidate incarnation");
        }
        if (signal === "SIGKILL") await killHost(host);
        else await stopHost(host);
        host = null;
        const atCrash = withControl(
          root,
          (control) =>
            control
              .query(
                "SELECT id, status, effect, dispatch_possible FROM tf_v2_operations WHERE replay_key = ?",
              )
              .all(updateKey) as Json[],
        );
        expect(atCrash).toHaveLength(1);
        expect(atCrash[0]?.id).toBe(String(update.id));
        if (window === "candidate") {
          // The engine recorded the dispatch before the owner persisted the candidate.
          if (atCrash[0]?.status !== "reconciling" || atCrash[0]?.dispatch_possible !== 1) {
            throw new Error(
              `inconclusive: Operation was ${String(atCrash[0]?.status)} (dispatch_possible=${String(atCrash[0]?.dispatch_possible)})`,
            );
          }
        } else if (
          // Queued case: the crash must land before any dispatch was recorded.
          !["queued", "running", "waiting_input"].includes(String(atCrash[0]?.status)) ||
          atCrash[0]?.dispatch_possible !== 0
        ) {
          throw new Error(
            `inconclusive: Operation was ${String(atCrash[0]?.status)} (dispatch_possible=${String(atCrash[0]?.dispatch_possible)})`,
          );
        }

        if (window === "dispatched") {
          // Reproduce exactly the two engine writes that precede a native send,
          // on the durable queued Operation the crash left behind.
          const writable = new Database(join(root, "control.sqlite"));
          try {
            writable
              .query(
                `UPDATE tf_v2_operations SET status = 'running', effect = 'none',
                   lease_token = 'crash-lease', lease_until_ms = 1
                 WHERE id = ? AND status = 'queued'`,
              )
              .run(String(update.id));
            writable
              .query(
                `UPDATE tf_v2_operations SET status = 'reconciling', effect = 'unknown',
                   dispatch_possible = 1 WHERE id = ? AND status = 'running'`,
              )
              .run(String(update.id));
          } finally {
            writable.close();
          }
        }
        host = await startHost(root, port, config, fullBoot);
        expect(host.output()).not.toContain("ownership_uncertain");
        if (window === "candidate") {
          // The owner proved the candidate never served and retired it under
          // the Operation's own ID; the engine settles that Operation through
          // its normal failure path, with no effect, exactly once.
          expect(await terminal(port, token, String(update.id))).toMatchObject({
            status: "failed",
            effect: "none",
          });
          expect(
            withControl(
              root,
              (control) =>
                control
                  .query(
                    "SELECT status, effect, error_code FROM tf_v2_operations WHERE replay_key = ?",
                  )
                  .all(updateKey) as Json[],
            ),
          ).toEqual([
            {
              status: "failed",
              effect: "none",
              error_code: "worker_incarnation_retired_before_activation",
            },
          ]);
          // The committed graph keeps serving: the failed update changed nothing.
          expect(
            await endpointEventually(hostname, certificate, "/", (r) => r.body === "gap-v1"),
          ).toEqual({ status: 200, body: "gap-v1" });
          // The user re-applies; a fresh Operation publishes once.
          const reapply = await jsonAt(
            port,
            "PUT",
            `${V2}/resources/${target}`,
            202,
            { spec },
            {
              ...auth,
              "idempotency-key": `${updateKey}-reapply`,
              "takoform-expected-generation": "2",
            },
          );
          expect(await settled(port, token, String(reapply.id))).toMatchObject({
            effect: "complete",
          });
          expect(
            await endpointEventually(hostname, certificate, "/", (r) => r.body === "gap-v2"),
          ).toEqual({ status: 200, body: "gap-v2" });
          expect(
            withControl(
              root,
              (control) =>
                control
                  .query(
                    "SELECT status, effect FROM tf_v2_operations WHERE resource_uid = ? AND action = 'update' ORDER BY generation",
                  )
                  .all(target) as Json[],
            ),
          ).toEqual([
            { status: "failed", effect: "none" },
            { status: "succeeded", effect: "complete" },
          ]);
          const owner = await ownerState(root, worker);
          expect(owner.activeOperationId).toBe(String(reapply.id));
          expect(
            owner.incarnations.filter((item) => item.operationId === String(update.id)),
          ).toMatchObject([{ status: "retired", identity: null }]);
          expect(
            owner.incarnations.filter((item) => item.operationId === String(reapply.id)),
          ).toMatchObject([{ status: "active" }]);
          // The replaced incumbent may legitimately keep draining (waitUntil
          // grace); nothing else is between serving and retired.
          expect(
            owner.incarnations.filter(
              (item) => item.status !== "active" && item.status !== "retired",
            ).length,
          ).toBeLessThanOrEqual(1);
          expect(
            owner.incarnations.filter(
              (item) => item.status === "uncertain" || item.status === "candidate",
            ),
          ).toEqual([]);
          // No child of a retired incarnation, including the abandoned candidate, is left running.
          for (const record of owner.incarnations) {
            if (record.status !== "retired" || !record.processIdentity) continue;
            expect(await linuxProcessLiveness(record.processIdentity as never)).toBe("stale");
          }
          completed = true;
          return;
        }
        expect(await settled(port, token, String(update.id))).toMatchObject({
          effect: "complete",
        });
        const expected = pending === "deployment-update" ? "gap-v2" : "gap-v1";
        expect(
          await endpointEventually(hostname, certificate, "/", (r) => r.body === expected),
        ).toEqual({ status: 200, body: expected });

        // Exactly one Operation carries the update; it ran to completion once.
        expect(
          withControl(
            root,
            (control) =>
              control
                .query("SELECT status, effect FROM tf_v2_operations WHERE replay_key = ?")
                .all(updateKey) as Json[],
          ),
        ).toEqual([{ status: "succeeded", effect: "complete" }]);
        expect(
          withControl(
            root,
            (control) =>
              control
                .query(
                  "SELECT COUNT(*) AS count FROM tf_v2_operations WHERE resource_uid = ? AND action = 'update'",
                )
                .all(target) as Json[],
          ),
        ).toEqual([{ count: 1 }]);
        // The owner published this exact Operation once and it is what serves,
        // which also distinguishes an Endpoint update that serves the same bytes.
        const owner = await ownerState(root, worker);
        expect(owner.activeOperationId).toBe(String(update.id));
        expect(
          owner.incarnations.filter((item) => item.operationId === String(update.id)),
        ).toMatchObject([{ status: "active" }]);
        completed = true;
      } finally {
        await Promise.allSettled([stopHost(host)]);
        // A Host a failed assertion left running is not always in `host`;
        // never leak it, its port or its children.
        for (const started of startedHosts) {
          if (started.child.exitCode !== null) continue;
          started.child.kill("SIGKILL");
          await Promise.race([started.child.exited, Bun.sleep(5_000)]);
        }
        if (completed) await rm(root, { recursive: true, force: true });
        else {
          for (const [index, started] of startedHosts.entries()) {
            await writeFile(join(root, `host-${index}.log`), started.output()).catch(
              () => undefined,
            );
          }
          process.stderr.write(`journey: data root and host logs retained at ${root}\n`);
        }
      }
    },
    300_000,
  );
}
