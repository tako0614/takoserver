import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import {
  type RuntimeInputSealKeyDatabase,
  type RuntimeInputSealKeyProcess,
  runRuntimeInputSealKey,
} from "../scripts/deploy/runtime-input-seal-key.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WorkerState } from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import type { RuntimeInputSealKeyRingDescriptor } from "../src/runtime-input-seal-keyring.ts";

const COMMIT = "a".repeat(40);
const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const KEYRING = JSON.stringify({
  current: { id: "runtime-2026-08", key: KEY_A },
  previous: [{ id: "runtime-2026-07", key: KEY_B }],
});
const DESCRIPTOR = {
  currentKeyId: "runtime-2026-08",
  previousKeyIds: ["runtime-2026-07"],
  commitment: "sha256:905db07db0c8aae9d27f3bfbe2f6513ac125428626c4ae3a70ec8a3b8c2b4376",
} as const satisfies RuntimeInputSealKeyRingDescriptor;
const OLD_DESCRIPTOR = {
  currentKeyId: "runtime-2026-07",
  previousKeyIds: [],
  commitment: `sha256:${"2".repeat(64)}`,
} as const satisfies RuntimeInputSealKeyRingDescriptor;
const BUNDLE = "export default {async fetch(){return new Response('ok')}};\n";
const BUNDLE_DIGEST = createHash("sha256").update(BUNDLE).digest("hex");
const VERSION_BEFORE = "11111111-1111-4111-8111-111111111111";
const VERSION_AFTER = "22222222-2222-4222-8222-222222222222";
const MIGRATIONS = readdirSync(join(import.meta.dir, "..", "migrations")).sort();

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "signing-current" },
  edgeSupplies: {} as NonNullable<DeployTarget["edgeSupplies"]>,
  workerEndpointSuffix: "integration.example.workers.dev",
  runtimeInputSealKeyring: DESCRIPTOR,
} satisfies DeployTarget;

class FakeDatabase implements RuntimeInputSealKeyDatabase {
  schema = MIGRATIONS;
  usages: readonly { readonly keyId: string; readonly rowCount: number }[] = [];
  usageReads = 0;

  async readSchemaState() {
    return { applied: this.schema, shape: "[]\n", shapeDigest: `sha256:${"0".repeat(64)}` };
  }

  async readLiveKeyUsage() {
    this.usageReads += 1;
    return this.usages;
  }
}

function stateFixture(input: {
  readonly initialDescriptor: RuntimeInputSealKeyRingDescriptor | null;
  readonly uploaded: () => boolean;
  readonly message: () => string | null;
  readonly raceDescriptor?: () => RuntimeInputSealKeyRingDescriptor | null;
}): WorkerState {
  let versionReads = 0;
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      return input.uploaded()
        ? [
            deployment("deployment-after", VERSION_AFTER, "2026-08-31T02:00:00Z"),
            deployment("deployment-before", VERSION_BEFORE, "2026-08-31T01:00:00Z"),
          ]
        : [deployment("deployment-before", VERSION_BEFORE, "2026-08-31T01:00:00Z")];
    },
    async workerVersion(_workerName, versionId) {
      versionReads += 1;
      const descriptor =
        versionId === VERSION_AFTER
          ? DESCRIPTOR
          : (input.raceDescriptor?.() ?? input.initialDescriptor);
      const selected = targetForDescriptor(descriptor);
      const message =
        versionId === VERSION_AFTER
          ? (input.message() ?? `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`)
          : `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`;
      return workerVersion(selected, message, `script-etag-${versionId}`, versionReads);
    },
    async workerSecrets() {
      const descriptor = input.uploaded()
        ? DESCRIPTOR
        : (input.raceDescriptor?.() ?? input.initialDescriptor);
      return expectedWorkerSecrets(targetForDescriptor(descriptor)).map((name) => ({
        name,
        type: "secret_text",
      }));
    },
  };
}

function processFixture(
  input: { readonly onUpload?: () => void; readonly uploadExitCode?: number } = {},
) {
  const calls: { readonly command: string[]; readonly env?: Readonly<Record<string, string>> }[] =
    [];
  let message: string | null = null;
  const run: RuntimeInputSealKeyProcess = async (command, options): Promise<CommandResult> => {
    calls.push({
      command: [...command],
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
    const joined = command.join(" ");
    if (joined === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (joined === "git branch --show-current") return ok("feature/TASK-0042-seal\n");
    if (joined === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (joined === "bun run check") return ok("checked\n");
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("missing dry-run output directory");
      writeFileSync(join(out, "index.js"), BUNDLE);
      return ok("built\n");
    }
    if (command.includes("deploy") && command.includes("--secrets-file")) {
      message = command[command.indexOf("--message") + 1] ?? null;
      const secretsPath = command[command.indexOf("--secrets-file") + 1];
      const configPath = command[command.indexOf("--config") + 1];
      expect(command).toContain("--no-bundle");
      expect(command).toContain("--strict");
      expect(lstatSync(secretsPath as string).mode & 0o777).toBe(0o400);
      expect(lstatSync(configPath as string).mode & 0o777).toBe(0o400);
      expect(JSON.parse(readFileSync(secretsPath as string, "utf8"))).toEqual({
        TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: KEYRING,
      });
      input.onUpload?.();
      return {
        exitCode: input.uploadExitCode ?? 0,
        stdout: input.uploadExitCode ? `failed ${KEY_A}` : "uploaded\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${joined}`);
  };
  return { run, calls, message: () => message };
}

describe("runtime-input seal-key deployment authority", () => {
  test("status recognizes only the exact secret-and-metadata legacy predecessor as bootstrap-required", async () => {
    const database = new FakeDatabase();
    const uploaded = false;
    const process = processFixture();
    const status = await runRuntimeInputSealKey(
      {
        surface: "takoserver-runtime-input-seal-key",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      {
        database,
        state: stateFixture({
          initialDescriptor: null,
          uploaded: () => uploaded,
          message: process.message,
        }),
        run: process.run,
        fetcher: productFetcher,
      },
    );
    expect(status).toMatchObject({
      kind: "takoserver.runtime-input-seal-key-status@v1",
      state: "bootstrap-required",
      schemaReady: true,
      sealedRows: { total: 0, byKeyId: [] },
      applyReady: true,
      ready: false,
    });
    expect(process.calls).toHaveLength(0);
  });

  test("safe bootstrap uploads candidate code/config and only the keyring secret once", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-runtime-seal-"));
    let uploaded = false;
    const process = processFixture({ onUpload: () => (uploaded = true) });
    try {
      const keyringPath = writeKeyring(root);
      const result = await runRuntimeInputSealKey(
        {
          surface: "takoserver-runtime-input-seal-key",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: new FakeDatabase(),
          state: stateFixture({
            initialDescriptor: null,
            uploaded: () => uploaded,
            message: process.message,
          }),
          run: process.run,
          fetcher: productFetcher,
          keyringPath,
          review: "independent-reviewer",
          outputDirectory: join(root, "output"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.runtime-input-seal-key-apply@v1",
        transition: "bootstrap",
        previousVersionId: VERSION_BEFORE,
        versionId: VERSION_AFTER,
        reviewer: "independent-reviewer",
      });
      expect(JSON.stringify(result)).not.toContain(KEY_A);
      expect(JSON.stringify(result)).not.toContain(KEY_B);
      expect(
        process.calls.filter(({ command }) => command.includes("--secrets-file")),
      ).toHaveLength(1);
      expect(
        process.calls.some(({ command }) => command.includes("secret") && command.includes("put")),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("safe rotation retains every live sealed-row key and uses the same one-shot mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-runtime-seal-rotation-"));
    let uploaded = false;
    const process = processFixture({ onUpload: () => (uploaded = true) });
    const database = new FakeDatabase();
    database.usages = [{ keyId: "runtime-2026-07", rowCount: 4 }];
    try {
      const result = await runRuntimeInputSealKey(
        {
          surface: "takoserver-runtime-input-seal-key",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database,
          state: stateFixture({
            initialDescriptor: OLD_DESCRIPTOR,
            uploaded: () => uploaded,
            message: process.message,
          }),
          run: process.run,
          fetcher: productFetcher,
          keyringPath: writeKeyring(root),
          review: "independent-reviewer",
          outputDirectory: join(root, "output"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        },
      );
      expect(result).toMatchObject({
        transition: "rotation",
        sealedRows: {
          total: 4,
          byKeyId: [{ keyId: "runtime-2026-07", count: 4 }],
        },
      });
      expect(
        process.calls.filter(({ command }) => command.includes("--secrets-file")),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing 0032 is not ready and never queries it as an empty table", async () => {
    const database = new FakeDatabase();
    database.schema = MIGRATIONS.filter((name) => name < "0032_");
    const process = processFixture();
    const status = await runRuntimeInputSealKey(
      {
        surface: "takoserver-runtime-input-seal-key",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      {
        database,
        state: stateFixture({
          initialDescriptor: null,
          uploaded: () => false,
          message: process.message,
        }),
        run: process.run,
        fetcher: productFetcher,
      },
    );
    expect(status).toMatchObject({
      schemaReady: false,
      sealedRows: null,
      applyReady: false,
      ready: false,
    });
    expect(database.usageReads).toBe(0);
  });

  test("bootstrap rows and rotation keys omitted from desired current/previous ids block mutation", async () => {
    for (const [initialDescriptor, usages] of [
      [null, [{ keyId: "runtime-2026-07", rowCount: 1 }]],
      [OLD_DESCRIPTOR, [{ keyId: "runtime-2026-06", rowCount: 2 }]],
    ] as const) {
      const database = new FakeDatabase();
      database.usages = usages;
      const process = processFixture();
      const status = await runRuntimeInputSealKey(
        {
          surface: "takoserver-runtime-input-seal-key",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database,
          state: stateFixture({
            initialDescriptor,
            uploaded: () => false,
            message: process.message,
          }),
          run: process.run,
          fetcher: productFetcher,
        },
      );
      expect(status).toMatchObject({ applyReady: false, ready: false });
      expect(status).not.toHaveProperty("ciphertext");
    }
  });

  test("apply refuses wrong ownership, links, mode, size, canonicalization, and descriptor mismatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-runtime-seal-file-"));
    try {
      const good = writeKeyring(root);
      const wrongMode = join(root, "wrong-mode.json");
      writeFileSync(wrongMode, KEYRING, { mode: 0o644 });
      const symlink = join(root, "symlink.json");
      symlinkSync(good, symlink);
      const hardSource = join(root, "hard-source.json");
      const hardlink = join(root, "hardlink.json");
      writeFileSync(hardSource, KEYRING, { mode: 0o600 });
      linkSync(hardSource, hardlink);
      const oversized = join(root, "oversized.json");
      writeFileSync(oversized, "x".repeat(20_000), { mode: 0o600 });
      const noncanonical = join(root, "noncanonical.json");
      writeFileSync(noncanonical, `${KEYRING}\n`, { mode: 0o600 });
      const mismatch = join(root, "mismatch.json");
      writeFileSync(mismatch, JSON.stringify({ current: { id: "runtime-2026-09", key: KEY_A } }), {
        mode: 0o600,
      });
      const rejectedPaths = [wrongMode, symlink, hardlink, oversized, noncanonical, mismatch];
      if (process.getuid?.() === 0) {
        const foreignOwner = join(root, "foreign-owner.json");
        writeFileSync(foreignOwner, KEYRING, { mode: 0o600 });
        chownSync(foreignOwner, 1, process.getgid?.() ?? 0);
        rejectedPaths.push(foreignOwner);
      }

      for (const keyringPath of rejectedPaths) {
        const process = processFixture();
        const failure = await runRuntimeInputSealKey(
          {
            surface: "takoserver-runtime-input-seal-key",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: new FakeDatabase(),
            state: stateFixture({
              initialDescriptor: null,
              uploaded: () => false,
              message: process.message,
            }),
            run: process.run,
            fetcher: productFetcher,
            keyringPath,
            review: "independent-reviewer",
            outputDirectory: join(root, `output-${keyringPath.split("/").at(-1)}`),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          },
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(DeployError);
        expect((failure as Error).message).not.toContain(KEY_A);
        expect(process.calls.some(({ command }) => command.includes("--secrets-file"))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pre-upload row race is re-read and refuses rotation before mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-runtime-seal-race-"));
    const database = new FakeDatabase();
    database.usages = [];
    const process = processFixture();
    const originalRead = database.readLiveKeyUsage.bind(database);
    database.readLiveKeyUsage = async () => {
      const value = await originalRead();
      return database.usageReads > 1 ? [{ keyId: "dropped-key", rowCount: 1 }] : value;
    };
    try {
      const failure = await runRuntimeInputSealKey(
        {
          surface: "takoserver-runtime-input-seal-key",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database,
          state: stateFixture({
            initialDescriptor: OLD_DESCRIPTOR,
            uploaded: () => false,
            message: process.message,
          }),
          run: process.run,
          fetcher: productFetcher,
          keyringPath: writeKeyring(root),
          review: "independent-reviewer",
          outputDirectory: join(root, "output"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(process.calls.some(({ command }) => command.includes("--secrets-file"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("acknowledgement loss redacts secret bytes and exact status settles the successor without retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-runtime-seal-ack-"));
    let uploaded = false;
    const process = processFixture({ onUpload: () => (uploaded = true), uploadExitCode: 1 });
    const state = stateFixture({
      initialDescriptor: null,
      uploaded: () => uploaded,
      message: process.message,
    });
    try {
      const failure = await runRuntimeInputSealKey(
        {
          surface: "takoserver-runtime-input-seal-key",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: new FakeDatabase(),
          state,
          run: process.run,
          fetcher: productFetcher,
          keyringPath: writeKeyring(root),
          review: "independent-reviewer",
          outputDirectory: join(root, "output"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).phase).toBe("mutation");
      expect(
        `${(failure as DeployError).message}${(failure as DeployError).detail ?? ""}`,
      ).not.toContain(KEY_A);

      const status = await runRuntimeInputSealKey(
        {
          surface: "takoserver-runtime-input-seal-key",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        { database: new FakeDatabase(), state, run: process.run, fetcher: productFetcher },
      );
      expect(status).toMatchObject({ state: "desired-current", ready: true, applyReady: false });
      expect(
        process.calls.filter(({ command }) => command.includes("--secrets-file")),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function targetForDescriptor(descriptor: RuntimeInputSealKeyRingDescriptor | null): DeployTarget {
  const { runtimeInputSealKeyring: _runtimeInputSealKeyring, ...withoutDescriptor } = target;
  return descriptor === null
    ? withoutDescriptor
    : { ...withoutDescriptor, runtimeInputSealKeyring: descriptor };
}

function workerVersion(selected: DeployTarget, message: string, scriptEtag: string, _read: number) {
  const match = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u.exec(message);
  if (!match?.[1] || !match[2]) throw new Error("invalid test annotation");
  const closure = expectedExactBindingClosure(selected, {
    signingKeyId: selected.signing.currentKeyId,
    workerArtifactDigest: `sha256:${match[2]}`,
  });
  return {
    annotations: { "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: {
      script: { etag: scriptEtag },
      bindings: Object.entries(closure).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function deployment(id: string, versionId: string, createdOn: string) {
  return { id, created_on: createdOn, versions: [{ version_id: versionId, percentage: 100 }] };
}

function writeKeyring(root: string): string {
  const path = join(root, "keyring.json");
  writeFileSync(path, KEYRING, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

async function productFetcher(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  if (url.pathname === "/.well-known/takoserver") {
    return Response.json({
      product: "takoserver",
      apiVersion: "v1",
      endpoints: { api: target.publicOrigin, openapi: `${target.publicOrigin}/openapi.json` },
    });
  }
  if (url.pathname === "/openapi.json") {
    return Response.json({ servers: [{ url: target.publicOrigin }] });
  }
  return new Response("not found", { status: 404 });
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
