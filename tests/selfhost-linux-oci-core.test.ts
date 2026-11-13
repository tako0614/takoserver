import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT, V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import {
  validateDockerContainerPrivateInputs,
  validateDockerContainerSpec,
} from "../src/providers/docker-container-configured-inputs.ts";
import {
  createSelfhostLinuxOciCore,
  type SelfhostLinuxOciCoreSelection,
} from "../src/selfhost-linux-oci-core.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";

const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const refusedSql: Sql = {
  query: async () => {
    throw new Error("unexpected Sql IO");
  },
  run: async () => {
    throw new Error("unexpected Sql IO");
  },
  batch: async () => {
    throw new Error("unexpected Sql IO");
  },
};
const clock = () => new Date();

async function settings() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const config = new TextEncoder().encode(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
      config: { Entrypoint: ["/app"], Env: [], WorkingDir: "/", User: "123:456" },
    }),
  );
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: digest(config),
        size: config.length,
      },
      layers: [],
    }),
  );
  const bytes = new Map([
    [digest(manifest), manifest],
    [digest(config), config],
  ]);
  let reads = 0;
  const selection: SelfhostLinuxOciCoreSelection = {
    installationId: "synthetic-host-oci-installation",
    backendId: "synthetic-host-oci-backend",
    targetKey: "synthetic-host-oci-target",
    configuredInputs: {
      keyring: {
        current: { id: "synthetic-host-oci-key", key },
        keyForDecryption(id) {
          return id === this.current.id ? this.current.key : undefined;
        },
      },
      maxSecretBytes: 4096,
    },
    artifactRoot: "/synthetic/not-opened/artifacts",
    umociBinary: "/synthetic/not-executed/umoci",
    images: {
      source: {
        origin: "https://registry.example",
        async read(request) {
          reads++;
          expect(request.method).toBe("GET");
          expect(request.redirect).toBe("manual");
          expect(request.url.startsWith(`${this.origin}/`)).toBe(true);
          const value = bytes.get(request.url.split("/").at(-1) ?? "");
          const response = new Response(value ?? null, { status: value ? 200 : 404 });
          Object.defineProperty(response, "url", { value: request.url });
          return response;
        },
        expand() {
          throw new Error("zero-layer image must not invoke a codec");
        },
      },
      limits: {
        maxManifestBytes: 8192,
        maxConfigBytes: 8192,
        maxLayerCompressedBytes: 8192,
        maxTotalCompressedBytes: 16384,
        maxLayerExpandedBytes: 8192,
        maxTotalExpandedBytes: 16384,
        maxExpansionRatio: 100,
        maxLayers: 4,
        maxIndexEntries: 4,
        maxArchiveBytes: 65536,
        maxRetainedBytes: 131072,
        maxDurationMs: 5000,
      },
    },
    memoryBytes: 268435456,
    nanoCpus: 500000000,
    pidsLimit: 128,
  };
  return { selection, key, manifestDigest: digest(manifest), reads: () => reads };
}

test("disabled OCI Host selection reads neither Sql nor clock", () => {
  expect(
    createSelfhostLinuxOciCore({
      get sql(): Sql {
        throw new Error("disabled Sql read");
      },
      get clock(): typeof clock {
        throw new Error("disabled clock read");
      },
      selection: undefined,
    }),
  ).toBeUndefined();
});

test("OCI Host selection accessor is refused without invoking it", () => {
  let reads = 0;
  const input = {
    sql: refusedSql,
    clock,
    get selection(): SelfhostLinuxOciCoreSelection | undefined {
      reads++;
      throw new Error("selection getter invoked");
    },
  };
  expect(() => createSelfhostLinuxOciCore(input)).toThrow("invalid_selection");
  expect(reads).toBe(0);
});

test("OCI Host closed selection refuses authority fields and nested accessors before original factory IO", async () => {
  const f = await settings();
  let reads = 0;
  for (const name of [
    "owner",
    "createCustody",
    "custody",
    "acceptance",
    "readiness",
    "coverage",
    "ready",
    "acceptedExecution",
    "sql",
    "clock",
  ]) {
    const selected = { ...f.selection };
    Object.defineProperty(selected, name, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("forbidden field read");
      },
    });
    expect(() =>
      createSelfhostLinuxOciCore({ sql: refusedSql, clock, selection: selected }),
    ).toThrow("invalid_selection");
  }
  const configured = { ...f.selection.configuredInputs, owner: {} };
  expect(() =>
    createSelfhostLinuxOciCore({
      sql: refusedSql,
      clock,
      selection: { ...f.selection, configuredInputs: configured },
    }),
  ).toThrow("invalid_selection");
  const source = { ...f.selection.images.source };
  Object.defineProperty(source, "read", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("source getter invoked");
    },
  });
  expect(() =>
    createSelfhostLinuxOciCore({
      sql: refusedSql,
      clock,
      selection: { ...f.selection, images: { ...f.selection.images, source } },
    }),
  ).toThrow("invalid_selection");
  const limits = { ...f.selection.images.limits };
  Object.defineProperty(limits, "maxDurationMs", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("limit getter invoked");
    },
  });
  expect(() =>
    createSelfhostLinuxOciCore({
      sql: refusedSql,
      clock,
      selection: { ...f.selection, images: { ...f.selection.images, limits } },
    }),
  ).toThrow("invalid_selection");
  expect(reads).toBe(0);
  expect(f.reads()).toBe(0);
});

test("OCI Host selection refuses missing, symbolic and inherited fields before IO", async () => {
  const f = await settings();
  const missing = { ...f.selection };
  Reflect.deleteProperty(missing, "configuredInputs");
  const symbolic = { ...f.selection, [Symbol("owner")]: {} };
  const inherited = Object.create(f.selection);
  for (const selection of [missing, symbolic, inherited])
    expect(() => createSelfhostLinuxOciCore({ sql: refusedSql, clock, selection })).toThrow(
      "invalid_selection",
    );
  expect(f.reads()).toBe(0);
});

test("OCI Host creator preserves original same-Sql acceptance, configured secret loan and accepted artifact method", async () => {
  const f = await settings();
  const root = await mkdtemp("/root/dev/tmp/selfhost-oci-core-");
  await chmod(root, 0o700);
  const artifactRoot = join(root, "artifacts"),
    umociBinary = join(root, "umoci");
  await mkdir(artifactRoot, { mode: 0o700 });
  await writeFile(umociBinary, "synthetic executable never run", { mode: 0o700 });
  const database = new Database(":memory:");
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const child = Object.defineProperties(new childProcess.ChildProcess(), {
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  const raw = spyOn(childProcess, "spawn").mockReturnValue(child);
  let unpackStarted = false;
  const failures: unknown[] = [];
  stdout.on("newListener", (event) => {
    if (event !== "data" || unpackStarted) return;
    unpackStarted = true;
    queueMicrotask(() => {
      void (async () => {
        const args = raw.mock.calls[0]?.[1];
        if (!Array.isArray(args) || typeof args[3] !== "string")
          throw new Error("raw unpack path absent");
        await mkdir(join(args[3], "rootfs"), { recursive: true, mode: 0o700 });
        await writeFile(
          join(args[3], "config.json"),
          JSON.stringify({
            process: { args: ["/app"], env: [], cwd: "/", user: { uid: 123, gid: 456 } },
          }),
          { mode: 0o600 },
        );
        child.emit("close", 0, null);
      })().catch((error: unknown) => {
        failures.push(error);
        child.emit("close", 1, null);
      });
    });
  });
  let composition: ReturnType<typeof createSelfhostLinuxOciCore>;
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    await sql.batch(
      frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
    );
    await sql.batch(v2ContainerOwnerMigrationCandidate());
    const selected = { ...f.selection, artifactRoot, umociBinary };
    composition = createSelfhostLinuxOciCore({ sql, clock, selection: selected });
    if (!composition) throw new Error("selected creator absent");
    const original = composition;
    expect(() => original.acceptance.assertSql(sql)).not.toThrow();
    expect(() => original.acceptance.assertSql(createSqliteSql(database))).toThrow();
    const comparison = await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
    let execution: V2Execution | undefined;
    let used = 0;
    const dispatch = async (actual: V2Execution): Promise<V2BackendResult> => {
      execution = actual;
      try {
        await expect(
          original.withAcceptedBundle(
            { ...actual, targetKey: "foreign-target" },
            async () => undefined,
          ),
        ).rejects.toThrow();
        await original.withAcceptedBundle(actual, async (bundle) => {
          await bundle.guard();
          expect(bundle.environment).toEqual(["SECRET=synthetic-host-local-loan"]);
          expect(bundle.record.state).toBe("pending");
          expect(bundle.receipt.installationId).toBe(selected.installationId);
          expect(bundle.receipt.manifestDigest).toBe(f.manifestDigest);
          used++;
        });
      } catch (error: unknown) {
        failures.push(error);
      }
      return { kind: "unknown" };
    };
    const engine = createTakoformV2Engine(
      {
        sql,
        authorize: async (principal, space) =>
          principal === "host-local-principal" && space === "host-local-space",
        replayWindowSeconds: 3600,
        privateInputCustody: {
          transfer: { current: { id: "synthetic-host-oci-key", key: f.key } },
          comparison: { current: { id: "synthetic-host-comparison", key: comparison } },
          transferTtlSeconds: 300,
        },
        forms: {
          [V2_CONTAINER_F2_FORM]: {
            validateCreate: (spec) => {
              validateDockerContainerSpec(spec);
            },
            validateUpdate: (_old, spec) => {
              validateDockerContainerSpec(spec);
            },
            privateInputs: {
              validateCreate: (spec, values) => {
                validateDockerContainerPrivateInputs(
                  validateDockerContainerSpec(spec).requiredSensitiveVars,
                  values,
                );
              },
              validateUpdate: (_old, spec, values) => {
                validateDockerContainerPrivateInputs(
                  validateDockerContainerSpec(spec).requiredSensitiveVars,
                  values,
                );
              },
              prepareCreate: original.configuredInputs.prepareCreate,
              prepareUpdate: original.configuredInputs.prepareUpdate,
            },
            backend: {
              id: selected.backendId,
              targetKey: selected.targetKey,
              execute: dispatch,
              reconcile: dispatch,
            },
          },
        },
      },
      original.acceptance,
    );
    const fields = CONTAINER_CONTRACT.fields;
    await engine.acceptCreate({
      principal: "host-local-principal",
      key: "host-local-create",
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: "host-local-space",
        name: "host-local-oci",
        spec: {
          [fields.image]: `registry.example/app@${f.manifestDigest}`,
          [fields.httpPort]: 8080,
          [fields.healthPath]: "/health",
          [fields.workloadRevision]: "1".repeat(64),
          [fields.environment]: {},
          [fields.requiredSensitiveVars]: ["SECRET"],
          [fields.outboundInternet]: false,
        },
        privateInputs: { SECRET: "synthetic-host-local-loan" },
      },
    });
    const outcome = await engine.runNext();
    if (failures[0] !== undefined) throw failures[0];
    expect(used).toBe(1);
    expect(f.reads()).toBe(2);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(outcome?.effect).not.toBe("complete");
    expect(await sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "pending", native_id: null },
    ]);
    expect(await sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
    if (!execution) throw new Error("actual accepted execution absent");
    await original.close();
    await expect(original.withAcceptedBundle(execution, async () => undefined)).rejects.toThrow(
      "closed",
    );
    await expect(original.startAccepted(execution)).rejects.toThrow("closed");
    expect(raw).toHaveBeenCalledTimes(1);
    expect(f.reads()).toBe(2);
  } finally {
    try {
      await composition?.close();
    } finally {
      raw.mockRestore();
      stdout.destroy();
      stderr.destroy();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
