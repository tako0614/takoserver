import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { takoformCoreVerifierArtifactDigest } from "./deploy/form-authority.ts";

/** Explicit native integration command, not a test double or deploy surface.
 * Run inside a disposable, loopback-only network namespace with verified local
 * tools. The real Host, Core verifier and released Provider own every write.
 * This qualifies storage CRUD, not Worker/Container or Cloudflare execution.
 */
const ORIGIN = "http://127.0.0.1:8787";
const CORE = "http://127.0.0.1:8080";
const REPOSITORY = resolve(import.meta.dir, "..");
const PROVIDER = "registry.terraform.io/tako0614/takoform";
const LIMIT = 1024 * 1024;
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
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const path = args[i + 1];
    requireTrue(
      key && ["--tofu", "--provider-mirror", "--core-verifier"].includes(key),
      "unknown_argument",
    );
    requireTrue(path && isAbsolute(path) && !values.has(key), "invalid_path_argument");
    requireTrue(realpathSync(path) === path, "tool_path_not_canonical");
    const info = statSync(path);
    requireTrue(
      key === "--provider-mirror" ? info.isDirectory() : info.isFile() && (info.mode & 0o111) !== 0,
      "tool_unavailable",
    );
    values.set(key, path);
  }
  requireTrue(values.size === 3, "required_arguments: --tofu --provider-mirror --core-verifier");
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
  // Explicit Bun flags prevent loading any checkout's dotenv configuration.
  const bun = [process.execPath, "--no-env-file"];
  const root = mkdtempSync(join(tmpdir(), "selfhost-opentofu-"));
  const workspace = join(root, "tofu");
  mkdirSync(workspace, { mode: 0o700 });
  const env = environment(root);
  const hostEnv = environment(root, {
    TAKOSERVER_DATA_ROOT: join(root, "host"),
    TAKOSERVER_PUBLIC_ORIGIN: ORIGIN,
    PORT: "8787",
  });
  let host: ReturnType<typeof start> | undefined;
  let verifier: ReturnType<typeof start> | undefined;
  try {
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
    await runTofu(["plan", "-input=false", "-no-color", "-detailed-exitcode"]);
    const created = resources(await runTofu(["show", "-json"]));
    requireTrue(created.length === 2, "expected_two_resources");
    // Independent expectations from the published Provider 4 mapping. Do not
    // let the Provider's own state choose what this integration claims to test.
    const expectedResources = [
      {
        address: "takoform_edge_kv_namespace.kv",
        name: "interop-kv",
        kind: "EdgeKVNamespace",
        schemaDigest: "sha256:1a3f5d50bde53b4f743334dba3b0d0d28c1516727ca76d266beb61c5ee210022",
      },
      {
        address: "takoform_sqlite_database.sqlite",
        name: "interop-sqlite",
        kind: "SQLiteDatabase",
        schemaDigest: "sha256:c72eeb66ef96c4679b5c724fa1219d71c89bb7eeb9e543d73d868ec41bddddfe",
      },
    ];
    const readbacks: { address: string; uid: string; url: string }[] = [];
    for (const expected of expectedResources) {
      const { address, name, kind, schemaDigest } = expected;
      const matches = created.filter((entry) => entry.address === address);
      requireTrue(matches.length === 1, "unexpected_resource_identity");
      const state = object(object(matches[0]).values);
      requireTrue(
        state.name === name &&
          state.space === "default" &&
          state.form_api_version === "edge.forms.takoform.com" &&
          state.form_kind === kind &&
          state.form_definition_version === "0.1.0" &&
          state.form_schema_digest === schemaDigest,
        "provider_form_mapping_mismatch",
      );
      requireTrue(
        state.ready === true && state.pending_operation_id == null,
        "resource_not_settled",
      );
      const uid = text(state.uid);
      const url = new URL(
        `${ORIGIN}/apis/forms.takoform.com/v1/resources/edge.forms.takoform.com/${kind}/${name}`,
      );
      url.search = new URLSearchParams({
        space: "default",
        definitionVersion: "0.1.0",
        schemaDigest,
      }).toString();
      const live = await request(url.href, 200, token);
      requireTrue(object(live.metadata).uid === uid, "host_provider_uid_mismatch");
      readbacks.push({ address, uid, url: url.href });
    }
    checkpoint("provider-destroy");
    await runTofu(["destroy", "-auto-approve", "-input=false", "-no-color"]);
    requireTrue(resources(await runTofu(["show", "-json"])).length === 0, "state_not_empty");
    for (const resource of readbacks) {
      const missing = await request(resource.url, 404, token);
      requireTrue(object(missing.error).code === "resource_not_found", "host_absence_not_proven");
    }
    process.stdout.write(
      `${JSON.stringify({ status: "passed", scope: "selfhost-storage-interop", tofu: "1.12.5", provider: "4.0.0", resources: readbacks.map(({ address, uid }) => ({ address, uid })), stateEmpty: true, liveCloudVerified: false })}\n`,
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
