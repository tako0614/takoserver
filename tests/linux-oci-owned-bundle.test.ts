import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT, V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import { isJsonObject } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import {
  validateDockerContainerPrivateInputs,
  validateDockerContainerSpec,
} from "../src/providers/docker-container-configured-inputs.ts";
import type { DockerImageSupplyLimits } from "../src/providers/docker-container-image-supplier.ts";
import { createLinuxOciOwnedBundle } from "../src/providers/linux-oci-owned-bundle.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";

const limits: DockerImageSupplyLimits = {
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
};
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(
  corrupt = false,
  adversarial: {
    readonly extraImage?: boolean;
    readonly unsafeUnpackerParent?: boolean;
    readonly holdUnpacker?: boolean;
    readonly nativeMode?:
      | "stopped"
      | "foreign-id"
      | "closed-before-ack"
      | "mutated-execution"
      | "closed-during-spawn";
    readonly noPhysicalBinary?: boolean;
    readonly configuredKey?: "sql" | "selection" | "owner";
  } = {},
) {
  const scratch = await mkdtemp("/root/dev/tmp/linux-oci-owned-bundle-");
  await chmod(scratch, 0o700);
  const artifactRoot = join(scratch, "artifacts");
  const unpackerParent = adversarial.unsafeUnpackerParent ? join(scratch, "unsafe") : scratch;
  if (adversarial.unsafeUnpackerParent) {
    await mkdir(unpackerParent, { mode: 0o700 });
    await chmod(unpackerParent, 0o777);
  }
  const unpacker = join(unpackerParent, "umoci");
  const physicalBinary = join(scratch, "oci-physical");
  if (adversarial.nativeMode !== undefined && !adversarial.noPhysicalBinary)
    await writeFile(physicalBinary, "synthetic-unused-native-executable", { mode: 0o700 });
  await mkdir(artifactRoot, { mode: 0o700 });
  // The executable is never run. Only its raw child-process transport is modeled.
  await writeFile(unpacker, "synthetic-unused-executable", { mode: 0o700 });
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const comparison = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
  const config = new TextEncoder().encode(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
      config: {
        Entrypoint: ["/app", "日本語"],
        Env: ["BASE=image"],
        WorkingDir: "/",
        User: "123:456",
      },
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
  const alternativeManifest = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: digest(config),
        size: config.length,
      },
      layers: [],
      annotations: { synthetic: "other-pin" },
    }),
  );
  const source = new Map([
    [digest(manifest), manifest],
    [digest(alternativeManifest), alternativeManifest],
    [digest(config), config],
  ]);
  let reads = 0,
    unpacks = 0,
    uses = 0;
  let configuredReads = 0;
  const configuredInputs = {
    keyring: {
      current: { id: "synthetic-oci-transfer", key },
      keyForDecryption: (id: string) => (id === "synthetic-oci-transfer" ? key : undefined),
    },
    maxSecretBytes: 4096,
  };
  if (adversarial.configuredKey !== undefined)
    Object.defineProperty(configuredInputs, adversarial.configuredKey, {
      enumerable: true,
      get() {
        configuredReads++;
        throw new Error("unexpected extra configured field read");
      },
    });
  const artifactDigests: string[] = [];
  let composition: ReturnType<typeof createLinuxOciOwnedBundle>;
  try {
    composition = createLinuxOciOwnedBundle({
      sql,
      clock: () => new Date(),
      installationId: "synthetic-oci-installation",
      backendId: "synthetic-oci-backend",
      targetKey: "synthetic-oci-target",
      configuredInputs,
      artifactRoot,
      umociBinary: unpacker,
      ...(adversarial.nativeMode !== undefined && !adversarial.noPhysicalBinary
        ? { physicalBinary }
        : {}),
      memoryBytes: 268435456,
      nanoCpus: 500000000,
      pidsLimit: 128,
      images: Object.assign(
        {
          limits,
          source: {
            origin: "https://registry.example",
            async read(request: Request) {
              reads++;
              expect(request.method).toBe("GET");
              expect(request.redirect).toBe("manual");
              const hash = request.url.split("/").at(-1),
                bytes = hash === undefined ? undefined : source.get(hash);
              if (!bytes) return new Response(null, { status: 404 });
              const response = new Response(corrupt ? new Uint8Array([0]) : bytes, { status: 200 });
              Object.defineProperty(response, "url", { value: request.url });
              return response;
            },
            expand() {
              throw new Error("zero-layer fixture requires no decompressor");
            },
          },
        },
        adversarial.extraImage
          ? { image: `registry.example/app@${digest(alternativeManifest)}` }
          : {},
      ),
    });
  } catch (error: unknown) {
    database.close();
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  let nativeProcesses = 0,
    nativeExits = 0;
  const nativeRequests: string[] = [];
  let nativeClosing: Promise<void> | undefined;
  let rawChild: EventEmitter | undefined;
  let unpackerStarted = () => {};
  const unpackerEntered = new Promise<void>((resolve) => {
    unpackerStarted = resolve;
  });
  const raw = spyOn(childProcess, "spawn").mockImplementation(((
    file: string,
    args: readonly string[],
  ) => {
    if (file === physicalBinary) {
      expect(args).toEqual([]);
      nativeProcesses++;
      if (adversarial.nativeMode === "closed-during-spawn") {
        nativeClosing = composition.close();
        void nativeClosing.catch(() => undefined);
      }
      let created = false;
      const child = new EventEmitter();
      const stdout = new PassThrough(),
        stderr = new PassThrough();
      const reply = (value: unknown) => {
        const body = Buffer.from(JSON.stringify(value)),
          frame = Buffer.alloc(body.length + 4);
        frame.writeUInt32BE(body.length);
        body.copy(frame, 4);
        stdout.write(frame);
      };
      const stdin = new Writable({
        write(frame: Buffer, _encoding, done) {
          void (async () => {
            expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
            const request: unknown = JSON.parse(frame.subarray(4).toString("utf8"));
            if (!isJsonObject(request) || typeof request.kind !== "string")
              throw new Error("malformed raw request");
            nativeRequests.push(request.kind);
            if (request.kind === "linux-oci-create-stopped@1") {
              created = true;
              if (typeof request.claimId !== "string" || typeof request.allocationRoot !== "string")
                throw new Error("raw original allocation absent");
              const receipt: unknown = JSON.parse(
                await readFile(join(request.allocationRoot, ".tako-oci-artifact.json"), "utf8"),
              );
              if (!isJsonObject(receipt)) throw new Error("raw artifact receipt absent");
              expect(receipt.claimId).toBe(request.claimId);
              expect(request.sourceDigest).toBe(receipt.sourceDigest);
              expect(request.env).toEqual([
                "BASE=image",
                "MODE=synthetic-public",
                "SECRET=synthetic-loan",
              ]);
              if (adversarial.nativeMode === "closed-before-ack") {
                nativeClosing = composition.close();
                void nativeClosing.catch(() => undefined);
              } else if (adversarial.nativeMode === "mutated-execution") {
                if (!accepted) throw new Error("original execution absent");
                accepted.principal = "synthetic-foreign";
              }
              reply({
                kind: "linux-oci-created-stopped@1",
                nativeId:
                  adversarial.nativeMode === "foreign-id" ? "f".repeat(64) : request.claimId,
                namespaceDevice: 4,
                namespaceInode: 55,
                barrier: "unproven",
              });
            } else if (request.kind === "linux-oci-cancel@1") {
              reply({
                kind: "linux-oci-cancel-observation@1",
                stage: "cancel",
                errno: 0,
                custody: created ? "retained" : "released-uncreated",
                barrier: "unproven",
              });
            } else throw new Error("unexpected raw OCI operation");
            done();
          })().catch((error: unknown) => {
            done(error instanceof Error ? error : new Error("raw failure"));
          });
        },
      });
      stdin.on("finish", () => {
        if (!created) {
          nativeExits++;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        }
      });
      return Object.assign(child, {
        stdin,
        stdout,
        stderr,
        kill() {
          throw new Error("raw born owner cannot be killed");
        },
      });
    }
    if (file !== unpacker || args[0] !== "unpack" || args[1] !== "--image" || args.length !== 4)
      throw new Error("unexpected synthetic child");
    unpacks++;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        return true;
      },
    });
    rawChild = child;
    unpackerStarted();
    if (adversarial.holdUnpacker) return child;
    void (async () => {
      const bundle = args[3];
      if (bundle === undefined) throw new Error("missing synthetic output");
      await mkdir(join(bundle, "rootfs"), { recursive: true, mode: 0o755 });
      await writeFile(join(bundle, "rootfs", "synthetic-file"), "verified-image-model", {
        mode: 0o600,
      });
      await writeFile(
        join(bundle, "config.json"),
        JSON.stringify({
          process: {
            args: ["/app", "日本語"],
            env: ["BASE=image"],
            cwd: "/",
            user: { uid: 123, gid: 456 },
          },
        }),
        { mode: 0o600 },
      );
      child.emit("close", 0, null);
    })().catch((error: unknown) => {
      child.emit("error", error);
      child.emit("close", 1, null);
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  if (!Object.is(importedSpawn, raw)) throw new Error("raw child interception unavailable");
  let accepted: V2Execution | undefined;
  let duringLoan: ((execution: V2Execution, signal: AbortSignal) => Promise<void>) | undefined;
  let beforeLoan: ((execution: V2Execution) => Promise<void>) | undefined;
  const failures: unknown[] = [];
  const stopped: unknown[] = [];
  const dispatch = async (execution: V2Execution): Promise<V2BackendResult> => {
    accepted = execution;
    try {
      await beforeLoan?.(execution);
      if (adversarial.nativeMode !== undefined) {
        stopped.push(await composition.createAcceptedStopped(execution));
        return { kind: "continue" };
      }
      await composition.withAcceptedBundle(execution, async (bundle) => {
        uses++;
        await bundle.guard();
        expect(bundle.argv).toEqual(["/app", "日本語"]);
        expect(bundle.uid).toBe(123);
        expect(bundle.gid).toBe(456);
        expect(bundle.environment).toEqual([
          "BASE=image",
          "MODE=synthetic-public",
          "SECRET=synthetic-loan",
        ]);
        expect(bundle.record.state).toBe("pending");
        expect(bundle.record.nativeId).toBeNull();
        const receipt = await readFile(
          join(bundle.allocationRoot, ".tako-oci-artifact.json"),
          "utf8",
        );
        expect(receipt).toBe(JSON.stringify(bundle.receipt));
        artifactDigests.push(bundle.receipt.sourceDigest);
        expect(bundle.receipt.sourceDigest).toBe(digest(manifest));
        expect(bundle.receipt.configDigest).toBe(digest(config));
        expect(
          await readFile(join(bundle.allocationRoot, "rootfs", "synthetic-file"), "utf8"),
        ).toBe("verified-image-model");
        await duringLoan?.(execution, bundle.signal);
      });
      // A real bounded artifact step, never native CREATE/START/completion.
      return { kind: "continue" };
    } catch (error: unknown) {
      failures.push(error);
      return { kind: "unknown" };
    }
  };
  const engine = createTakoformV2Engine(
    {
      sql,
      authorize: async () => true,
      replayWindowSeconds: 3600,
      privateInputCustody: {
        transfer: { current: { id: "synthetic-oci-transfer", key } },
        comparison: { current: { id: "synthetic-oci-comparison", key: comparison } },
        transferTtlSeconds: 300,
      },
      forms: {
        [V2_CONTAINER_F2_FORM]: {
          validateCreate: (spec) => {
            validateDockerContainerSpec(spec);
          },
          validateUpdate: (_before, spec) => {
            validateDockerContainerSpec(spec);
          },
          privateInputs: {
            validateCreate: (spec, values) => {
              validateDockerContainerPrivateInputs(
                validateDockerContainerSpec(spec).requiredSensitiveVars,
                values,
              );
            },
            validateUpdate: (_before, spec, values) => {
              validateDockerContainerPrivateInputs(
                validateDockerContainerSpec(spec).requiredSensitiveVars,
                values,
              );
            },
            prepareCreate: composition.configuredInputs.prepareCreate,
            prepareUpdate: composition.configuredInputs.prepareUpdate,
          },
          backend: {
            id: "synthetic-oci-backend",
            targetKey: "synthetic-oci-target",
            execute: dispatch,
            reconcile: dispatch,
          },
        },
      },
    },
    composition.acceptance,
  );
  const fields = CONTAINER_CONTRACT.fields;
  return {
    sql,
    engine,
    composition,
    failures,
    artifactRoot,
    stopped,
    nativeCounts: () => ({ processes: nativeProcesses, requests: [...nativeRequests] }),
    nativeExits: () => nativeExits,
    nativeClosing: () => nativeClosing,
    unpackerEntered,
    releaseUnpacker() {
      rawChild?.emit("close", 1, null);
    },
    artifactDigests,
    acceptedDigest: digest(manifest),
    configuredReads: () => configuredReads,
    beforeLoan(callback: typeof beforeLoan) {
      beforeLoan = callback;
    },
    counts: () => ({ reads, unpacks, uses }),
    get execution() {
      return accepted;
    },
    onLoan(callback: typeof duringLoan) {
      duringLoan = callback;
    },
    create: () =>
      engine.acceptCreate({
        principal: "synthetic-oci-parent",
        key: crypto.randomUUID(),
        input: {
          form: V2_CONTAINER_F2_FORM,
          space: "synthetic-space",
          name: "synthetic-oci",
          spec: {
            [fields.image]: `registry.example/app@${digest(manifest)}`,
            [fields.httpPort]: 8080,
            [fields.healthPath]: "/health",
            [fields.workloadRevision]: "1".repeat(64),
            [fields.environment]: { MODE: "synthetic-public" },
            [fields.requiredSensitiveVars]: ["SECRET"],
            [fields.outboundInternet]: true,
          },
          privateInputs: { SECRET: "synthetic-loan" },
        },
      }),
    async close() {
      try {
        await composition.close();
      } finally {
        raw.mockRestore();
        database.close();
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

test("original accepted claim owns verified OCI rootfs and a scoped secret loan without native or terminal authority", async () => {
  const f = await fixture();
  try {
    await f.create();
    const result = await f.engine.runNext();
    if (f.failures[0] !== undefined) throw f.failures[0];
    expect(result?.effect).not.toBe("complete");
    expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 1 });
    expect(await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "pending", native_id: null },
    ]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
    const execution = f.execution;
    if (!execution) throw new Error("actual execution absent");
    const before = f.counts();
    await expect(
      f.composition.withAcceptedBundle(execution, async () => undefined),
    ).rejects.toThrow();
    expect(f.counts()).toEqual(before);
    const files = await readdir(f.artifactRoot);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}$/u);
  } finally {
    await f.close();
  }
});

test("a digest-mismatched source is refused before rootfs/native producer or original CREATE claim", async () => {
  const f = await fixture(true);
  try {
    await f.create();
    await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.counts()).toEqual({ reads: 1, unpacks: 0, uses: 0 });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_create_claims")).toEqual([
      { n: 0 },
    ]);
    expect(await readdir(f.artifactRoot)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("live foreign execution has no artifact effect and close cancels then joins the original secret scope", async () => {
  const f = await fixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let loanSignal: AbortSignal | undefined;
  f.onLoan(async (execution, signal) => {
    const before = f.counts();
    await expect(
      f.composition.withAcceptedBundle(
        { ...execution, principal: "synthetic-foreign" },
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(f.counts()).toEqual(before);
    loanSignal = signal;
    entered();
    await gate;
    expect(await f.sql.query("SELECT 1 AS still_open")).toEqual([{ still_open: 1 }]);
  });
  let running: ReturnType<typeof f.engine.runNext> | undefined;
  try {
    await f.create();
    running = f.engine.runNext();
    await waiting;
    const closing = f.composition.close();
    expect(f.composition.close()).toBe(closing);
    expect(loanSignal?.aborted).toBe(true);
    let joined = false;
    void closing.then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    const execution = f.execution;
    if (!execution) throw new Error("actual execution absent");
    const before = f.counts();
    await expect(
      f.composition.withAcceptedBundle(execution, async () => undefined),
    ).rejects.toThrow();
    expect(f.counts()).toEqual(before);
    release();
    await closing;
    const outcome = await running;
    expect(joined).toBe(true);
    expect(outcome?.effect).not.toBe("complete");
    expect(f.failures).toHaveLength(1);
  } finally {
    release();
    await running;
    await f.close();
  }
});

test("extra image input cannot replace the original accepted image pin", async () => {
  const f = await fixture(false, { extraImage: true });
  try {
    await f.create();
    const result = await f.engine.runNext();
    expect(f.artifactDigests).toEqual([f.acceptedDigest]);
    expect(f.failures).toEqual([]);
    expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 1 });
    expect(result?.effect).not.toBe("complete");
  } finally {
    await f.close();
  }
});

for (const configuredKey of ["sql", "selection", "owner"] as const) {
  test(`extra configured ${configuredKey} is never read or substituted for the original producer`, async () => {
    const f = await fixture(false, { configuredKey });
    try {
      await f.create();
      const result = await f.engine.runNext();
      expect(f.configuredReads()).toBe(0);
      expect(f.failures).toEqual([]);
      expect(f.artifactDigests).toEqual([f.acceptedDigest]);
      expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 1 });
      expect(result?.effect).not.toBe("complete");
    } finally {
      await f.close();
    }
  });
}

test("foreign execution is rejected before the first claim while the original execution still produces its artifact", async () => {
  const f = await fixture();
  let refusedBeforeFirstClaim = false;
  f.beforeLoan(async (execution) => {
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_create_claims")).toEqual([
      { n: 0 },
    ]);
    expect(f.counts()).toEqual({ reads: 0, unpacks: 0, uses: 0 });
    await expect(
      f.composition.withAcceptedBundle(
        { ...execution, principal: "synthetic-foreign" },
        async () => {
          throw new Error("foreign scope entered");
        },
      ),
    ).rejects.toThrow();
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_create_claims")).toEqual([
      { n: 0 },
    ]);
    expect(f.counts()).toEqual({ reads: 0, unpacks: 0, uses: 0 });
    refusedBeforeFirstClaim = true;
  });
  try {
    await f.create();
    const result = await f.engine.runNext();
    expect(refusedBeforeFirstClaim).toBe(true);
    expect(f.failures).toEqual([]);
    expect(f.artifactDigests).toEqual([f.acceptedDigest]);
    expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 1 });
    expect(result?.effect).not.toBe("complete");
  } finally {
    await f.close();
  }
});

test("a replaceable unpacker parent is refused before raw spawn or original claim", async () => {
  const f = await fixture(false, { unsafeUnpackerParent: true });
  try {
    await f.create();
    await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.counts()).toEqual({ reads: 2, unpacks: 0, uses: 0 });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_create_claims")).toEqual([
      { n: 0 },
    ]);
    expect(await readdir(f.artifactRoot)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("close refuses in finite time while the original callback remains held and preserves its Sql scope", async () => {
  const f = await fixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.onLoan(async () => {
    entered();
    await gate;
  });
  let running: ReturnType<typeof f.engine.runNext> | undefined;
  try {
    await f.create();
    running = f.engine.runNext();
    await waiting;
    const closing = f.composition.close();
    expect(f.composition.close()).toBe(closing);
    await expect(closing).rejects.toThrow("scope_custody_unknown");
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await f.sql.query("SELECT 1 AS still_open")).toEqual([{ still_open: 1 }]);
    release();
    await running;
    expect(f.failures).toHaveLength(1);
  } finally {
    release();
    await running;
    await f.close();
  }
});

test("an aborted unpacker without an actual close event retains its original child and private staging", async () => {
  const f = await fixture(false, { holdUnpacker: true });
  let running: ReturnType<typeof f.engine.runNext> | undefined;
  try {
    await f.create();
    running = f.engine.runNext();
    await f.unpackerEntered;
    await expect(f.composition.close()).rejects.toThrow("custody_unknown");
    const outcome = await running;
    expect(outcome?.effect).not.toBe("complete");
    expect(f.failures).toHaveLength(1);
    expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 0 });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_create_claims")).toEqual([
      { n: 0 },
    ]);
    const files = await readdir(f.artifactRoot);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\.oci-stage-/u);
    const before = f.counts();
    f.releaseUnpacker();
    await f.composition.close();
    expect(await readdir(f.artifactRoot)).toEqual([]);
    expect(f.counts()).toEqual(before);
    expect(await f.sql.query("SELECT 1 AS still_open")).toEqual([{ still_open: 1 }]);
  } finally {
    f.releaseUnpacker();
    await running;
    await f.close();
  }
});

test("the original accepted owner binds only its actual stopped OCI result and never STARTs or completes", async () => {
  const f = await fixture(false, { nativeMode: "stopped" });
  f.beforeLoan(async (execution) => {
    for (const changed of [
      { principal: "synthetic-foreign" },
      { backendId: "synthetic-other" },
      { targetKey: "synthetic-other" },
    ]) {
      await expect(
        f.composition.createAcceptedStopped({ ...execution, ...changed }),
      ).rejects.toThrow();
      expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
      expect(f.counts()).toEqual({ reads: 0, unpacks: 0, uses: 0 });
      expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_create_claims")).toEqual([
        { n: 0 },
      ]);
    }
  });
  try {
    await f.create();
    const result = await f.engine.runNext();
    expect(f.failures).toEqual([]);
    expect(f.stopped).toHaveLength(1);
    const claims = await f.sql.query(
      "SELECT claim_id,native_id,state FROM tf_v2_container_create_claims",
    );
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    if (!claim) throw new Error("original claim absent");
    expect(claim.state).toBe("bound");
    expect(claim.native_id).toBe(claim.claim_id);
    expect(f.stopped[0]).toMatchObject({
      kind: "linux-oci-created-stopped@1",
      nativeId: claim.claim_id,
      barrier: "unproven",
    });
    expect(f.nativeCounts()).toEqual({ processes: 1, requests: ["linux-oci-create-stopped@1"] });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    expect(result?.effect).not.toBe("complete");
    const execution = f.execution;
    if (!execution) throw new Error("original execution absent");
    const before = f.nativeCounts();
    await expect(f.composition.createAcceptedStopped(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
  } finally {
    // Disposable raw fixture teardown is not a native cleanup receipt.
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const nativeMode of ["foreign-id", "closed-before-ack", "mutated-execution"] as const) {
  test(`a ${nativeMode} stopped result keeps the original OCI claim unknown without binding or replay`, async () => {
    const f = await fixture(false, { nativeMode });
    try {
      await f.create();
      const result = await f.engine.runNext();
      await f.nativeClosing()?.catch(() => undefined);
      expect(f.failures).toHaveLength(1);
      expect(f.stopped).toEqual([]);
      expect(
        await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims"),
      ).toEqual([{ state: "pending", native_id: null }]);
      expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual(
        [{ n: 0 }],
      );
      expect(result?.effect).not.toBe("complete");
      const execution = f.execution;
      if (!execution) throw new Error("original execution absent");
      const before = f.nativeCounts();
      await expect(f.composition.createAcceptedStopped(execution)).rejects.toThrow();
      expect(f.nativeCounts()).toEqual(before);
      expect(before.processes).toBe(1);
      expect(before.requests.filter((kind) => kind === "linux-oci-create-stopped@1")).toHaveLength(
        1,
      );
    } finally {
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

test("missing explicit physical code selection refuses before image, original claim or native process", async () => {
  const f = await fixture(false, { nativeMode: "stopped", noPhysicalBinary: true });
  try {
    await f.create();
    await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.counts()).toEqual({ reads: 0, unpacks: 0, uses: 0 });
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_create_claims")).toEqual([
      { n: 0 },
    ]);
  } finally {
    await f.close();
  }
});

test("close joins a helper registered during raw spawn reentry before returning success", async () => {
  const f = await fixture(false, { nativeMode: "closed-during-spawn" });
  try {
    await f.create();
    const result = await f.engine.runNext();
    const closing = f.nativeClosing();
    if (!closing) throw new Error("original close absent");
    await closing;
    expect(f.failures).toHaveLength(1);
    expect(f.stopped).toEqual([]);
    expect(f.nativeCounts()).toEqual({ processes: 1, requests: ["linux-oci-cancel@1"] });
    expect(f.nativeExits()).toBe(1);
    expect(await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "pending", native_id: null },
    ]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
    expect(result?.effect).not.toBe("complete");
  } finally {
    await f.close();
  }
});
