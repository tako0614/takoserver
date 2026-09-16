import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { takoformCoreVerifierArtifactDigest } from "./deploy/form-authority.ts";

/** Explicit native integration command, not a test double or deploy surface.
 * Run inside a disposable, loopback-only network namespace with verified local
 * tools. The real Host, Core verifier and released Provider own every write.
 * The default qualifies storage CRUD; the optional workerd lane additionally
 * proves one Worker fetch and its declared KV/SQLite bindings.
 */
const ORIGIN = "http://127.0.0.1:8787";
const CORE = "http://127.0.0.1:8080";
const REPOSITORY = resolve(import.meta.dir, "..");
const PROVIDER = "registry.terraform.io/tako0614/takoform";
const LIMIT = 1024 * 1024;
const WORKER_MODULE = `export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/") {
      return new Response("not_found", { status: 404 });
    }
    await env.KV.put("interop-key", "interop-value");
    const kv = await env.KV.get("interop-key");
    const written = await env.DB.execute(
      "INSERT OR REPLACE INTO interop_messages (id, body) VALUES (?, ?)",
      [1, "interop-value"],
    );
    const read = await env.DB.query(
      "SELECT id, body FROM interop_messages WHERE id = ?",
      [1],
    );
    return Response.json({
      kv: kv === null ? null : new TextDecoder().decode(kv),
      sql: { rows: read.rows, rowsWritten: written.rowsWritten },
    });
  },
};
`;
const SQLITE_MIGRATION = `CREATE TABLE interop_messages (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);
`;
const secrets: string[] = [];
let phase = "preflight";

class JourneyError extends Error {}
function requireTrue(value: unknown, message: string): asserts value {
  if (!value) throw new JourneyError(message);
}
function object(value: unknown): Record<string, unknown> {
  requireTrue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected_object",
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  requireTrue(typeof value === "string" && value.length > 0, "expected_string");
  return value;
}
function safe(message: string): string {
  for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
  return message.slice(0, 1600);
}
function checkpoint(name: string): void {
  phase = name;
  process.stdout.write(`${JSON.stringify({ phase })}\n`);
}

function argumentsOf(): Map<string, string> {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const allowed = new Set([
    "--tofu",
    "--provider-mirror",
    "--core-verifier",
    "--workerd",
    "--openssl",
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const path = args[i + 1];
    requireTrue(typeof key === "string" && allowed.has(key), "unknown_argument");
    requireTrue(path && isAbsolute(path) && !values.has(key), "invalid_path_argument");
    requireTrue(realpathSync(path) === path, "tool_path_not_canonical");
    const info = statSync(path);
    requireTrue(
      key === "--provider-mirror" ? info.isDirectory() : info.isFile() && (info.mode & 0o111) !== 0,
      "tool_unavailable",
    );
    values.set(key, path);
  }
  for (const required of ["--tofu", "--provider-mirror", "--core-verifier"]) {
    requireTrue(values.has(required), `required_argument_${required.slice(2)}`);
  }
  requireTrue(
    values.has("--workerd") === values.has("--openssl"),
    "worker_arguments_must_be_supplied_together",
  );
  return values;
}

async function bounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        throw new JourneyError("output_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function environment(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    TMPDIR: root,
    CI: "1",
    NO_COLOR: "1",
    CHECKPOINT_DISABLE: "1",
    TF_IN_AUTOMATION: "1",
    ...extra,
  };
}

type Child = Pick<Bun.Subprocess, "exited" | "exitCode" | "kill">;
async function stop(child: Child | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

function start(command: string[], env: Record<string, string>) {
  // entry-bun prints a valid operator assertion. Never forward its output.
  return Bun.spawn(command, {
    cwd: REPOSITORY,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function command(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  expected = 0,
): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JourneyError("command_timeout")), 120_000);
      }),
    ]);
    requireTrue(code === expected, `command_exit_${code}: ${safe(stderr || stdout)}`);
    return stdout;
  } finally {
    if (timer) clearTimeout(timer);
    await stop(child);
  }
}

async function generateTls(
  root: string,
  openssl: string,
  env: Record<string, string>,
): Promise<{ certificate: string; privateKey: string }> {
  const certificate = join(root, "worker-cert.pem");
  const privateKey = join(root, "worker-key.pem");
  // TLS hostname checking rejects two-label wildcards such as *.localhost.
  await command(
    [
      openssl,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      privateKey,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=*.app.localhost",
      "-addext",
      "subjectAltName=DNS:*.app.localhost",
    ],
    root,
    env,
  );
  chmodSync(privateKey, 0o600);
  chmodSync(certificate, 0o600);
  requireTrue(
    statSync(privateKey).isFile() && (statSync(privateKey).mode & 0o077) === 0,
    "tls_key_permissions",
  );
  requireTrue(
    statSync(certificate).isFile() && (statSync(certificate).mode & 0o077) === 0,
    "tls_certificate_permissions",
  );
  return { certificate, privateKey };
}

function workerRequest(
  hostname: string,
  certificatePath: string,
  path = "/",
): Promise<{ status: number; body: string }> {
  const certificate = readFileSync(certificatePath, "utf8");
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: JourneyError, response?: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectResponse(error);
      else if (response) resolveResponse(response);
      else rejectResponse(new JourneyError("worker_transport"));
    };
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: hostname,
        path,
        method: "GET",
        headers: { host: hostname, accept: "application/json" },
        ca: certificate,
      },
      (response) => {
        const declared = response.headers["content-length"];
        if (
          (typeof declared === "string" && /^\d+$/u.test(declared) && Number(declared) > LIMIT) ||
          (Array.isArray(declared) &&
            declared.some((value) => /^\d+$/u.test(value) && Number(value) > LIMIT))
        ) {
          response.destroy();
          finish(new JourneyError("worker_body_too_large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > LIMIT) {
            response.destroy();
            finish(new JourneyError("worker_body_too_large"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          const status = response.statusCode;
          if (typeof status !== "number" || !Number.isInteger(status)) {
            finish(new JourneyError("worker_malformed_response"));
            return;
          }
          finish(undefined, { status, body: Buffer.concat(chunks).toString("utf8") });
        });
        response.on("error", () => finish(new JourneyError("worker_transport")));
      },
    );
    timer = setTimeout(() => {
      request.destroy();
      finish(new JourneyError("worker_timeout"));
    }, 5_000);
    request.on("error", (error: unknown) => {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      const diagnostic =
        typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "unknown";
      finish(
        new JourneyError(
          code === "ECONNREFUSED" ? "worker_connection_refused" : `worker_transport:${diagnostic}`,
        ),
      );
    });
    request.end();
  });
}

async function request(
  url: string,
  expected: number,
  token?: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const data = object(JSON.parse(response.body ? await bounded(response.body) : "{}"));
  requireTrue(
    response.status === expected,
    `http_${response.status}: ${safe(JSON.stringify(data))}`,
  );
  return data;
}

async function ready(child: Child, url: string): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    requireTrue(child.exitCode === null, `service_exited_${child.exitCode}`);
    try {
      await request(url, 200);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new JourneyError("service_not_ready");
}

function resources(state: string): Record<string, unknown>[] {
  const document = object(JSON.parse(state));
  requireTrue(typeof document.format_version === "string", "invalid_state_format");
  if (document.values === undefined) return [];
  const root = object(object(document.values).root_module);
  requireTrue(root.child_modules === undefined, "unexpected_child_modules");
  const entries = root.resources ?? [];
  requireTrue(Array.isArray(entries), "invalid_state_resources");
  return entries.map(object);
}

async function main(): Promise<void> {
  const args = argumentsOf();
  const interfaces = Object.values(networkInterfaces()).flat();
  requireTrue(
    interfaces.some((address) => address?.address === "127.0.0.1") &&
      interfaces.every((address) => address?.internal),
    "network_not_loopback_only",
  );
  const tofu = text(args.get("--tofu"));
  const mirror = text(args.get("--provider-mirror"));
  const coreBinary = text(args.get("--core-verifier"));
  const workerd = args.get("--workerd");
  const openssl = args.get("--openssl");
  const workerMode = workerd !== undefined;
  // Explicit Bun flags prevent loading any checkout's dotenv configuration.
  const bun = [process.execPath, "--no-env-file"];
  const root = mkdtempSync(join(tmpdir(), "selfhost-opentofu-"));
  chmodSync(root, 0o700);
  const workspace = join(root, "tofu");
  mkdirSync(workspace, { mode: 0o700 });
  const env = environment(root);
  let host: ReturnType<typeof start> | undefined;
  let verifier: ReturnType<typeof start> | undefined;
  let tls: { certificate: string; privateKey: string } | undefined;
  try {
    if (workerMode) {
      checkpoint("worker-tls");
      tls = await generateTls(root, text(openssl), env);
      writeFileSync(join(workspace, "worker.mjs"), WORKER_MODULE, { mode: 0o600 });
      writeFileSync(join(workspace, "0001-interop.sql"), SQLITE_MIGRATION, { mode: 0o600 });
    }
    const hostEnv = environment(root, {
      TAKOSERVER_DATA_ROOT: join(root, "host"),
      TAKOSERVER_PUBLIC_ORIGIN: ORIGIN,
      PORT: "8787",
      ...(workerMode && tls
        ? {
            TAKOSERVER_WORKERD_BINARY: text(workerd),
            TAKOSERVER_WORKERD_PORT: "443",
            TAKOSERVER_WORKER_ENDPOINT_PORT: "443",
            TAKOSERVER_WORKER_ENDPOINT_SUFFIX: "app.localhost",
            TAKOSERVER_WORKERD_TLS_CERT_FILE: tls.certificate,
            TAKOSERVER_WORKERD_TLS_KEY_FILE: tls.privateKey,
          }
        : {}),
    });
    checkpoint("host-bootstrap");
    host = start([...bun, "src/entry-bun.ts"], hostEnv);
    await ready(host, `${ORIGIN}/.well-known/takoform/v1`);
    const assertion = await signOperatorAssertion({
      privateJwk: readFileSync(join(root, "host/operator-key.jwk"), "utf8"),
      claims: {
        purpose: "sign-in",
        aud: ORIGIN,
        provider: "google",
        subject: "operator",
        email: "operator@localhost",
        displayName: "Operator",
      },
      nowSeconds: Math.floor(Date.now() / 1000),
      lifetimeSeconds: 60,
    });
    secrets.push(assertion);
    const session = text(
      (
        await request(`${ORIGIN}/v1/sessions`, 200, undefined, {
          provider: "google",
          method: "operator-assertion",
          assertion,
          sessionTtlSeconds: 60,
        })
      ).sessionToken,
    );
    secrets.push(session);
    const org = text(
      object(
        (
          await request(`${ORIGIN}/v1/organizations`, 201, session, {
            name: "Self-host interoperability",
          })
        ).organization,
      ).id,
    );
    const token = text(
      (
        await request(
          `${ORIGIN}/v1/organizations/${encodeURIComponent(org)}/api-keys`,
          201,
          session,
          { name: "local-interop", scopes: ["resources:write"], expiresInSeconds: 600 },
        )
      ).secret,
    );
    secrets.push(token);

    checkpoint("real-core-admission");
    await stop(host);
    host = undefined;
    verifier = start(
      [coreBinary],
      environment(root, {
        TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: takoformCoreVerifierArtifactDigest(),
      }),
    );
    await ready(verifier, `${CORE}/v1/identity`);
    // Admission checks the released Core identity and raw signed closure. No
    // in-memory verifier or direct SQL/state seeding is used here.
    const admitted = await command(
      [
        ...bun,
        "scripts/selfhost-form-admission.ts",
        org,
        "default",
        "--apply",
        "--data-root",
        join(root, "host"),
        "--host-id",
        ORIGIN,
        "--core-verifier",
        CORE,
      ],
      REPOSITORY,
      env,
    );
    requireTrue(/^apply: converged \(/mu.test(admitted), "admission_not_converged");
    await stop(verifier);
    verifier = undefined;
    host = start([...bun, "src/entry-bun.ts"], hostEnv);
    await ready(host, `${ORIGIN}/.well-known/takoform/v1`);

    writeFileSync(
      join(workspace, "main.tf.json"),
      JSON.stringify({
        terraform: {
          required_version: "= 1.12.5",
          required_providers: { takoform: { source: PROVIDER, version: "= 4.0.0" } },
        },
        provider: { takoform: { endpoint: ORIGIN, space: "default" } },
        resource: {
          takoform_edge_kv_namespace: { kv: { name: "interop-kv" } },
          takoform_sqlite_database: { sqlite: { name: "interop-sqlite" } },
          ...(workerMode
            ? {
                takoform_sqlite_migration_set: {
                  migrations: {
                    name: "interop-migrations",
                    files: [
                      {
                        path: "0001-interop.sql",
                        media_type: "application/sql",
                        content_file: join(workspace, "0001-interop.sql"),
                      },
                    ],
                    create_timeout: "60s",
                    delete_timeout: "60s",
                  },
                },
                takoform_sqlite_migration_application: {
                  migration: {
                    name: "interop-migration-application",
                    database: "interop-sqlite",
                    migration_set: "interop-migrations",
                    create_timeout: "60s",
                    delete_timeout: "60s",
                    depends_on: [
                      "takoform_sqlite_database.sqlite",
                      "takoform_sqlite_migration_set.migrations",
                    ],
                  },
                },
                takoform_module_worker: {
                  worker: {
                    name: "interop-worker",
                    create_timeout: "60s",
                    delete_timeout: "60s",
                  },
                },
                takoform_worker_bundle: {
                  bundle: {
                    name: "interop-bundle",
                    main_module: "worker.mjs",
                    modules: [
                      {
                        name: "worker.mjs",
                        content_type: "application/javascript+module",
                        content_file: join(workspace, "worker.mjs"),
                      },
                    ],
                    create_timeout: "60s",
                    delete_timeout: "60s",
                  },
                },
                takoform_worker_version: {
                  version: {
                    name: "interop-version",
                    worker: "interop-worker",
                    bundle: "interop-bundle",
                    handlers: ["fetch"],
                    kv_bindings: [{ name: "KV", target_name: "interop-kv" }],
                    sqlite_bindings: [{ name: "DB", target_name: "interop-sqlite" }],
                    actor_bindings: [],
                    external_services: [],
                    queue_producer_bindings: [],
                    service_bindings: [],
                    workflow_bindings: [],
                    create_timeout: "60s",
                    delete_timeout: "60s",
                    depends_on: [
                      "takoform_sqlite_migration_application.migration",
                      "takoform_module_worker.worker",
                      "takoform_worker_bundle.bundle",
                      "takoform_edge_kv_namespace.kv",
                      "takoform_sqlite_database.sqlite",
                    ],
                  },
                },
                takoform_worker_deployment: {
                  deployment: {
                    name: "interop-deployment",
                    worker: "interop-worker",
                    versions: [{ worker_version: "interop-version", weight: 10_000 }],
                    create_timeout: "60s",
                    update_timeout: "60s",
                    delete_timeout: "60s",
                    depends_on: [
                      "takoform_module_worker.worker",
                      "takoform_worker_version.version",
                    ],
                  },
                },
                takoform_worker_endpoint: {
                  endpoint: {
                    name: "interop-endpoint",
                    worker: "interop-worker",
                    create_timeout: "60s",
                    delete_timeout: "60s",
                    depends_on: ["takoform_worker_deployment.deployment"],
                  },
                },
              }
            : {}),
        },
      }),
      { mode: 0o600 },
    );
    const config = join(workspace, "tofu.tfrc");
    writeFileSync(
      config,
      `provider_installation {\n filesystem_mirror {\n path = ${JSON.stringify(mirror)}\n include = ["${PROVIDER}"]\n }\n}\n`,
      { mode: 0o600 },
    );
    const tofuEnv = environment(root, { TF_CLI_CONFIG_FILE: config, TAKOFORM_TOKEN: token });
    const runTofu = (args: string[], expected = 0) =>
      command([tofu, ...args], workspace, tofuEnv, expected);
    checkpoint("provider-init");
    const version = object(JSON.parse(await runTofu(["version", "-json"])));
    requireTrue(version.terraform_version === "1.12.5", "unexpected_tofu_version");
    await runTofu(["init", "-get=false", "-input=false", "-no-color"]);
    // The mirror is pre-verified by the caller; init may create a local lock,
    // but has no direct registry installation fallback.
    requireTrue(
      realpathSync(join(workspace, ".terraform/providers", PROVIDER, "4.0.0/linux_amd64")) ===
        join(mirror, PROVIDER, "4.0.0/linux_amd64"),
      "provider_not_from_selected_mirror",
    );
    checkpoint("provider-plan-apply");
    await runTofu(
      ["plan", "-input=false", "-no-color", "-out=apply.tfplan", "-detailed-exitcode"],
      2,
    );
    await runTofu(["apply", "-input=false", "-no-color", "apply.tfplan"]);
    checkpoint("provider-noop-and-readback");
    await runTofu([
      "plan",
      "-input=false",
      "-no-color",
      "-detailed-exitcode",
      "-out=readback.tfplan",
    ]);
    // A no-op plan refreshes resources but does not persist the refreshed state.
    // ModuleWorker was created before its Deployment, so the old state can still
    // say Provisioning. Inspect the plan's observed prior state, not its proposed
    // values or the stale state file; no second apply is needed to make it Ready.
    const readback = object(JSON.parse(await runTofu(["show", "-json", "readback.tfplan"])));
    const created = resources(JSON.stringify(object(readback.prior_state)));
    const expectedCount = workerMode ? 9 : 2;
    requireTrue(created.length === expectedCount, `expected_${expectedCount}_resources`);
    // Independent expectations from the published Provider 4 mapping. Do not
    // let the Provider's own state choose what this integration claims to test.
    const expectedResources = [
      {
        address: "takoform_edge_kv_namespace.kv",
        name: "interop-kv",
        kind: "EdgeKVNamespace",
        definitionVersion: "0.1.0",
        schemaDigest: "sha256:1a3f5d50bde53b4f743334dba3b0d0d28c1516727ca76d266beb61c5ee210022",
      },
      {
        address: "takoform_sqlite_database.sqlite",
        name: "interop-sqlite",
        kind: "SQLiteDatabase",
        definitionVersion: "0.1.0",
        schemaDigest: "sha256:c72eeb66ef96c4679b5c724fa1219d71c89bb7eeb9e543d73d868ec41bddddfe",
      },
      ...(workerMode
        ? [
            {
              address: "takoform_sqlite_migration_set.migrations",
              name: "interop-migrations",
              kind: "SQLiteMigrationSet",
              definitionVersion: "0.1.0",
              schemaDigest:
                "sha256:05a4aa2ebd8fbf659f05ae378288d9c9657cc7478e1437f013732199bfcce7b9",
            },
            {
              address: "takoform_sqlite_migration_application.migration",
              name: "interop-migration-application",
              kind: "SQLiteMigrationApplication",
              definitionVersion: "0.1.0",
              schemaDigest:
                "sha256:f3b42ede7bad664e494a04ea6f0fd167082988688fe96f4ec1fbb80db13a8e01",
            },
            {
              address: "takoform_module_worker.worker",
              name: "interop-worker",
              kind: "ModuleWorker",
              definitionVersion: "0.1.0",
              schemaDigest:
                "sha256:049df2fb1eda53e4ccb0d646022a3ded8bc17c44eb433fa2e5ac0861efe42ac7",
            },
            {
              address: "takoform_worker_bundle.bundle",
              name: "interop-bundle",
              kind: "WorkerBundle",
              definitionVersion: "0.1.0",
              schemaDigest:
                "sha256:cb21984a579ae2706bddada8b44a22c0f8390994550c10d7c65df82edfa1141b",
            },
            {
              address: "takoform_worker_version.version",
              name: "interop-version",
              kind: "WorkerVersion",
              definitionVersion: "0.3.0",
              schemaDigest:
                "sha256:65870343bfab512fe5e7ae6faea8b3dbc48f9c9de0d4d9349dcbfd819f06d365",
            },
            {
              address: "takoform_worker_deployment.deployment",
              name: "interop-deployment",
              kind: "WorkerDeployment",
              definitionVersion: "0.2.0",
              schemaDigest:
                "sha256:3d5174bf2c3f351cf1468607689019e9eaa503a353eceb3095cf3d31bad62081",
            },
            {
              address: "takoform_worker_endpoint.endpoint",
              name: "interop-endpoint",
              kind: "WorkerEndpoint",
              definitionVersion: "0.1.0",
              schemaDigest:
                "sha256:732f60aba45ce360d5ebbc6ac2e55fe4d59b65d353f4628e93960d71fbc2870f",
            },
          ]
        : []),
    ];
    const readbacks: { address: string; uid: string; url: string }[] = [];
    let endpointProbe: { hostname: string; certificate: string } | undefined;
    for (const expected of expectedResources) {
      const { address, name, kind, definitionVersion, schemaDigest } = expected;
      const matches = created.filter((entry) => entry.address === address);
      requireTrue(matches.length === 1, "unexpected_resource_identity");
      const state = object(object(matches[0]).values);
      requireTrue(
        state.name === name &&
          state.space === "default" &&
          state.form_api_version === "edge.forms.takoform.com" &&
          state.form_kind === kind &&
          state.form_definition_version === definitionVersion &&
          state.form_schema_digest === schemaDigest,
        "provider_form_mapping_mismatch",
      );
      if (state.ready !== true || state.pending_operation_id != null) {
        const conditions = Array.isArray(state.conditions)
          ? state.conditions.map((value) => {
              const condition = object(value);
              return {
                type: condition.type,
                status: condition.status,
                reason: condition.reason,
                hostReason: condition.host_reason,
              };
            })
          : null;
        throw new JourneyError(
          `resource_not_settled:${address}:${safe(JSON.stringify({ ready: state.ready, pendingOperation: state.pending_operation_id != null, conditions }))}`,
        );
      }
      const uid = text(state.uid);
      const url = new URL(
        `${ORIGIN}/apis/forms.takoform.com/v1/resources/edge.forms.takoform.com/${kind}/${name}`,
      );
      url.search = new URLSearchParams({
        space: "default",
        definitionVersion,
        schemaDigest,
      }).toString();
      const live = await request(url.href, 200, token);
      const metadata = object(live.metadata);
      const status = object(live.status);
      requireTrue(metadata.uid === uid, "host_provider_uid_mismatch");
      const readyConditions = Array.isArray(status.conditions)
        ? status.conditions.map(object).filter((condition) => condition.type === "Ready")
        : [];
      requireTrue(
        readyConditions.length === 1 &&
          readyConditions[0]?.status === "True" &&
          text(status.observedGeneration) === text(metadata.generation) &&
          status.operationId == null,
        `host_resource_not_settled:${address}`,
      );
      if (kind === "WorkerEndpoint") {
        requireTrue(workerMode && tls !== undefined, "worker_endpoint_without_tls");
        const hostname = text(state.hostname);
        const endpointUrl = text(state.url);
        requireTrue(
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.app\.localhost$/u.test(hostname),
          "invalid_worker_endpoint_hostname",
        );
        requireTrue(endpointUrl === `https://${hostname}/`, "invalid_worker_endpoint_url");
        const parsed = new URL(endpointUrl);
        requireTrue(
          parsed.protocol === "https:" &&
            parsed.hostname === hostname &&
            parsed.port === "" &&
            parsed.pathname === "/" &&
            parsed.search === "" &&
            parsed.hash === "",
          "invalid_worker_endpoint_origin",
        );
        const outputs = object(object(live.status).outputs);
        requireTrue(
          outputs.hostname === hostname && outputs.url === endpointUrl,
          "worker_endpoint_output_mismatch",
        );
        endpointProbe = { hostname, certificate: tls.certificate };
      }
      readbacks.push({ address, uid, url: url.href });
    }
    if (endpointProbe) {
      checkpoint("worker-http-proof");
      const answered = await workerRequest(endpointProbe.hostname, endpointProbe.certificate);
      requireTrue(answered.status === 200, `worker_http_${answered.status}`);
      const proof = object(JSON.parse(answered.body));
      requireTrue(proof.kv === "interop-value", "worker_kv_proof_failed");
      const sql = object(proof.sql);
      const rows = sql.rows;
      requireTrue(Array.isArray(rows) && rows.length === 1, "worker_sql_proof_failed");
      requireTrue(sql.rowsWritten === 1, "worker_sql_write_proof_failed");
      const row = object(rows[0]);
      requireTrue(row.id === 1 && row.body === "interop-value", "worker_sql_readback_failed");
    }
    checkpoint("provider-destroy");
    await runTofu(["destroy", "-auto-approve", "-input=false", "-no-color"]);
    requireTrue(resources(await runTofu(["show", "-json"])).length === 0, "state_not_empty");
    for (const resource of readbacks) {
      const missing = await request(resource.url, 404, token);
      requireTrue(object(missing.error).code === "resource_not_found", "host_absence_not_proven");
    }
    if (endpointProbe) {
      try {
        const former = await workerRequest(endpointProbe.hostname, endpointProbe.certificate);
        requireTrue(former.status === 404, "worker_endpoint_still_serving");
      } catch (error) {
        requireTrue(
          error instanceof JourneyError && error.message === "worker_connection_refused",
          "worker_endpoint_stop_unproven",
        );
      }
    }
    process.stdout.write(
      `${JSON.stringify({ status: "passed", scope: workerMode ? "selfhost-storage-worker-interop" : "selfhost-storage-interop", tofu: "1.12.5", provider: "4.0.0", resources: readbacks.map(({ address, uid }) => ({ address, uid })), stateEmpty: true, liveCloudVerified: false })}\n`,
    );
  } finally {
    // A failed apply/destroy is not silently retried. This whole local Host
    // and its data are disposable; directory removal is not a destroy proof.
    await stop(host);
    await stop(verifier);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ status: "failed", phase, detail: error instanceof JourneyError ? safe(error.message) : "unexpected_error" })}\n`,
    );
    process.exitCode = 1;
  }
}
