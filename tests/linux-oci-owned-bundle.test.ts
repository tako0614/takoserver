import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as filesystem from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT, V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import { isJsonObject, type JsonObject } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import {
  validateDockerContainerPrivateInputs,
  validateDockerContainerSpec,
} from "../src/providers/docker-container-configured-inputs.ts";
import { createDockerContainerCoreOwner } from "../src/providers/docker-container-core-owner.ts";
import type { DockerImageSupplyLimits } from "../src/providers/docker-container-image-supplier.ts";
import {
  LINUX_OCI_EGRESS_POLICY_FILE,
  type LinuxOciEgressLimits,
  snapshotLinuxOciEgressLimits,
} from "../src/providers/linux-oci-egress-policy.ts";
import {
  LINUX_OCI_HOST_TOPOLOGY_FILE,
  type LinuxOciHostTopology,
  snapshotLinuxOciHostTopology,
} from "../src/providers/linux-oci-host-topology.ts";
import {
  createLinuxOciOwnedBundle,
  type LinuxOciBorrowedBundle,
  type LinuxOciOwnedBundleOptions,
} from "../src/providers/linux-oci-owned-bundle.ts";
import {
  createLinuxOciPhysicalSession,
  type LinuxOciCreateStoppedRequest,
} from "../src/providers/linux-oci-physical-session.ts";
import {
  LINUX_OCI_SERVICE_POLICY_FILE,
  serializeLinuxOciServicePolicy,
} from "../src/providers/linux-oci-service-policy.ts";
import { createSelfhostLinuxOciContainerBackend } from "../src/selfhost-linux-oci-container-backend.ts";
import { createSelfhostLinuxOciCore } from "../src/selfhost-linux-oci-core.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { V2_CONTAINER_OWNER_CONTROL_EXPAND } from "../src/takoform-v2/container-owner-schema.ts";
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
    readonly parentControl?: boolean;
    readonly parentPeer?: boolean;
    readonly peerPending?: boolean;
    readonly peerManagementFault?: "incomplete" | "missing-reply" | "lost-reply";
    readonly parentFault?: "foreign-claim" | "foreign-generation";
    readonly fixedKeys?: { readonly key: CryptoKey; readonly comparison: CryptoKey };
    readonly extraImage?: boolean;
    readonly unsafeUnpackerParent?: boolean;
    readonly holdUnpacker?: boolean;
    readonly nativeMode?:
      | "stopped"
      | "foreign-id"
      | "closed-before-ack"
      | "mutated-execution"
      | "closed-during-spawn"
      | "start"
      | "start-foreign-id"
      | "start-mutated"
      | "start-observation-foreign-id"
      | "start-observation-mutated"
      | "start-retire"
      | "start-retire-unknown"
      | "start-retire-foreign-id"
      | "start-retire-mutated"
      | "retire-pending";
    readonly noPhysicalBinary?: boolean;
    readonly nativeObservationFaultAt?: number;
    readonly nativeObservationRefusalAt?: number;
    readonly changingSql?: boolean;
    readonly namespaceMode?: "success" | "retained" | "foreign" | "unknown";
    readonly disposalMode?:
      | "success"
      | "begin-retained"
      | "delete-retained"
      | "dispose-retained"
      | "unknown";
    readonly disposalExit?: "nonzero" | "close-only";
    readonly allocationDisposal?: boolean;
    readonly egressLimits?: LinuxOciEgressLimits;
    readonly hostTopology?: LinuxOciHostTopology;
    readonly outboundInternet?: boolean;
    readonly viaHostCreator?: boolean;
    readonly normalBackend?: boolean;
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
  if (adversarial.parentControl || adversarial.parentPeer)
    await sql.batch(V2_CONTAINER_OWNER_CONTROL_EXPAND.statements.map((sql) => ({ sql })));
  const key =
    adversarial.fixedKeys?.key ??
    (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]));
  const comparison =
    adversarial.fixedKeys?.comparison ??
    (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, [
      "sign",
      "verify",
    ]));
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
  let normalTime = Date.now();
  const normalClock = () => new Date(normalTime);
  let recreateNormal: (() => ReturnType<typeof createSelfhostLinuxOciContainerBackend>) | undefined;
  let recreateParent: (() => ReturnType<typeof createLinuxOciOwnedBundle>) | undefined;
  const compose = (
    options: LinuxOciOwnedBundleOptions & {
      readonly configuredInputs: NonNullable<LinuxOciOwnedBundleOptions["configuredInputs"]>;
    },
  ) => {
    if (adversarial.changingSql) {
      let reads = 0;
      const originalSql = options.sql;
      const otherPort = createSqliteSql(database);
      Object.defineProperty(options, "sql", {
        enumerable: true,
        get() {
          // Original Core and configured-input source see the true port. The
          // later health-only capture must independently prove same identity.
          return ++reads < 3 ? originalSql : otherPort;
        },
      });
    }
    if (adversarial.parentControl || adversarial.parentPeer)
      recreateParent = () => createLinuxOciOwnedBundle(options);
    if (adversarial.parentPeer) {
      const { sql, clock, ...selection } = options;
      recreateNormal = () => createSelfhostLinuxOciContainerBackend({ sql, clock, selection });
    }
    if (adversarial.normalBackend) {
      const { sql, clock, ...selection } = options;
      recreateNormal = () => createSelfhostLinuxOciContainerBackend({ sql, clock, selection });
      return createSelfhostLinuxOciContainerBackend({ sql, clock, selection });
    }
    if (!adversarial.viaHostCreator) return createLinuxOciOwnedBundle(options);
    const { sql, clock, ...selection } = options;
    const selected = createSelfhostLinuxOciCore({ sql, clock, selection });
    if (!selected) throw new Error("original Host-selected OCI creator absent");
    return selected;
  };
  let composition: ReturnType<typeof createLinuxOciOwnedBundle>;
  try {
    composition = compose({
      sql,
      clock: adversarial.normalBackend ? normalClock : () => new Date(),
      installationId: "synthetic-oci-installation",
      backendId: "synthetic-oci-backend",
      targetKey: "synthetic-oci-target",
      configuredInputs,
      ...(adversarial.parentPeer
        ? { ociParentControl: "sealed-peer@1" as const }
        : adversarial.parentControl
          ? { ociParentControl: "sealed-original@1" as const }
          : {}),
      artifactRoot,
      umociBinary: unpacker,
      ...(adversarial.nativeMode !== undefined && !adversarial.noPhysicalBinary
        ? { physicalBinary }
        : {}),
      memoryBytes: 268435456,
      nanoCpus: 500000000,
      pidsLimit: 128,
      ...(adversarial.egressLimits === undefined ? {} : { egressLimits: adversarial.egressLimits }),
      ...(adversarial.hostTopology === undefined ? {} : { hostTopology: adversarial.hostTopology }),
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
    nativeExits = 0,
    nativeStartedObservations = 0;
  const nativeRequests: string[] = [];
  let originalCreate: JsonObject | undefined;
  let nativeClosing: Promise<void> | undefined;
  let rawChild: EventEmitter | undefined;
  let originalNativeStdout: PassThrough | undefined;
  const unpackEnvironments: unknown[] = [];
  let unpackerStarted = () => {};
  const unpackerEntered = new Promise<void>((resolve) => {
    unpackerStarted = resolve;
  });
  let originalPeerBootstrap: Buffer | undefined;
  let peerReply: unknown,
    peerKind = 0,
    peerEffects = 0,
    peerBytes = 0;
  const raw = spyOn(childProcess, "spawn").mockImplementation(((
    file: string,
    args: readonly string[],
    options: childProcess.SpawnOptions,
  ) => {
    if (file === physicalBinary) {
      const managing = adversarial.parentPeer && args[0] === "--parent-peer-manage-init";
      const connector =
        adversarial.parentPeer && (args[0] === "--parent-peer-read-result" || managing);
      expect(args).toEqual(
        connector
          ? [managing ? "--parent-peer-manage-init" : "--parent-peer-read-result"]
          : adversarial.parentPeer
            ? ["--persistent-parent-peer"]
            : adversarial.parentControl
              ? ["--persistent-parent"]
              : [],
      );
      nativeProcesses++;
      if (adversarial.nativeMode === "closed-during-spawn") {
        nativeClosing = composition.close();
        void nativeClosing.catch(() => undefined);
      }
      let managementReady = false,
        managementSent = false;
      let created = false;
      let disposalRefused = false;
      let nativeId: string | undefined;
      const child = new EventEmitter();
      const stdout = new PassThrough(),
        stderr = new PassThrough();
      if (nativeProcesses === 1) originalNativeStdout = stdout;
      const reply = (value: unknown) => {
        if (adversarial.parentPeer && !connector) peerReply = value;
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
            if (managing && managementReady) {
              managementSent = true;
              const command = JSON.parse(frame.subarray(4).toString("utf8"));
              if (
                Object.keys(command).length !== 1 ||
                !["linux-oci-stop-init@1", "linux-oci-join-init@1"].includes(command.kind)
              )
                throw Error("nonfixed management command");
              const stop = command.kind === "linux-oci-stop-init@1";
              if (stop && peerEffects & (1 << 6)) throw Error("replayed original STOP");
              if (!stop && !(peerEffects & (1 << 6))) throw Error("JOIN before original STOP");
              nativeRequests.push(command.kind);
              peerKind = stop ? 6 : 7;
              peerEffects |= stop ? 1 << 6 : 0;
              peerBytes = frame.length;
              if (!originalCreate || typeof originalCreate.claimId !== "string")
                throw Error("original peer native absent");
              peerReply = {
                kind: stop ? "linux-oci-init-reaped@1" : "linux-oci-init-reaped-observation@1",
                nativeId: originalCreate.claimId,
                namespaceDevice: 4,
                namespaceInode: 55,
                pidNamespaceDevice: 6,
                pidNamespaceInode: 77,
                barrier: "unproven",
              };
              const lost = stop && adversarial.peerManagementFault === "lost-reply";
              if (!lost) reply(peerReply);
              done();
              queueMicrotask(() => {
                stdout.end();
                stderr.end();
                child.emit("exit", lost ? 77 : 0, null);
                child.emit("close", lost ? 77 : 0, null);
              });
              return;
            }
            if (connector) {
              nativeRequests.push(
                managing ? "linux-oci-parent-read-outcome@2" : "linux-oci-parent-read-result@2",
              );
              const original = originalPeerBootstrap;
              const valid =
                original &&
                frame.length === 176 &&
                frame.subarray(4, 12).equals(Buffer.from("TKOPEER2")) &&
                frame.subarray(12, 84).equals(original.subarray(12, 84)) &&
                frame.subarray(92, 124).equals(original.subarray(84, 116)) &&
                frame.readBigUInt64BE(84) === 0xfedcba9876543210n &&
                frame.readBigUInt64BE(124) === 5n &&
                frame.readBigUInt64BE(132) === 0x123456789abcdef0n &&
                frame.subarray(140).equals(Buffer.from("11111111-2222-4333-8444-555555555555"));
              if (valid && managing) {
                const body = Buffer.from(JSON.stringify(peerReply)),
                  captured = Buffer.alloc(body.length + 4);
                captured.writeUInt32BE(body.length);
                body.copy(captured, 4);
                const missing = adversarial.peerManagementFault === "missing-reply";
                reply({
                  kind: "linux-oci-parent-outcome@1",
                  requestKind: peerKind,
                  effects: peerEffects,
                  requestBytes: String(peerBytes),
                  issuedBytes: String(
                    adversarial.peerManagementFault === "incomplete" ? 0 : peerBytes,
                  ),
                  deliveryUnknown: 1,
                  replyBytes: String(missing ? 0 : captured.length),
                  barrier: "unproven",
                });
                if (!missing) stdout.write(captured);
                managementReady = true;
                done();
                return;
              }
              if (valid)
                reply(
                  adversarial.peerPending
                    ? {
                        kind: "linux-oci-parent-h-result-refused@1",
                        error: 11,
                        barrier: "unproven",
                      }
                    : { kind: "linux-oci-parent-h-exited@1", error: 0, barrier: "unproven" },
                );
              done();
              queueMicrotask(() => {
                stdout.end();
                stderr.end();
                child.emit("exit", valid ? 0 : 1, null);
                child.emit("close", valid ? 0 : 1, null);
              });
              return;
            }
            if (adversarial.parentPeer && frame.readUInt32BE(0) === 112) {
              expect(frame.subarray(4, 12).equals(Buffer.from("TKOBIND2"))).toBe(true);
              originalPeerBootstrap = Buffer.from(frame);
              nativeRequests.push("linux-oci-parent-bootstrap@2");
              const response = Buffer.alloc(144);
              response.writeUInt32BE(140);
              response.write("TKOINFO2", 4, "ascii");
              frame.copy(response, 12, 12, 84);
              response.writeBigUInt64BE(0xfedcba9876543210n, 84);
              response.writeBigUInt64BE(5n, 92);
              response.writeBigUInt64BE(0x123456789abcdef0n, 100);
              response.write("11111111-2222-4333-8444-555555555555", 108, "ascii");
              stdout.write(response);
              done();
              return;
            }
            if (adversarial.parentControl && frame.readUInt32BE(0) === 112) {
              expect(frame.subarray(4, 12).equals(Buffer.from("TKOBIND1"))).toBe(true);
              nativeRequests.push("linux-oci-parent-bootstrap@1");
              const response = Buffer.alloc(92);
              response.writeUInt32BE(88);
              response.write("TKOINFO1", 4, "ascii");
              frame.copy(response, 12, 12, 84);
              response.writeBigUInt64BE(0xfedcba9876543210n, 84);
              if (adversarial.parentFault === "foreign-claim") response.fill(0x66, 12, 76);
              if (adversarial.parentFault === "foreign-generation")
                response.writeBigUInt64BE(2n, 76);
              stdout.write(response);
              done();
              return;
            }
            const request: unknown = JSON.parse(frame.subarray(4).toString("utf8"));
            if (!isJsonObject(request) || typeof request.kind !== "string")
              throw new Error("malformed raw request");
            nativeRequests.push(request.kind);
            if (adversarial.parentPeer && !connector) {
              const kinds: Record<string, number> = {
                "linux-oci-create-stopped@1": 1,
                "linux-oci-observe-stopped@1": 2,
                "linux-oci-start@1": 4,
                "linux-oci-observe-started@1": 5,
              };
              peerKind = kinds[request.kind] ?? 0;
              peerBytes = frame.length;
              if (peerKind === 1 || peerKind === 4) peerEffects |= 1 << peerKind;
            }
            if (request.kind === "linux-oci-create-stopped@1") {
              if (nativeProcesses === 1) originalCreate = request;
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
              nativeId = request.claimId;
              reply({
                kind: "linux-oci-created-stopped@1",
                nativeId:
                  adversarial.nativeMode === "foreign-id" ? "f".repeat(64) : request.claimId,
                namespaceDevice: 4,
                namespaceInode: 55,
                barrier: "unproven",
              });
            } else if (
              request.kind === "linux-oci-observe-stopped@1" ||
              request.kind === "linux-oci-start@1" ||
              request.kind === "linux-oci-observe-started@1"
            ) {
              if (!nativeId) throw new Error("raw original stopped identity absent");
              if (request.kind === "linux-oci-observe-started@1") nativeStartedObservations++;
              if (
                request.kind === "linux-oci-observe-started@1" &&
                adversarial.nativeObservationRefusalAt === nativeStartedObservations
              ) {
                reply({
                  kind: "linux-oci-refused@1",
                  stage: "observe-started",
                  errno: 5,
                  custody: "retained",
                  barrier: "unproven",
                });
                done();
                return;
              }
              if (
                (request.kind === "linux-oci-start@1" &&
                  adversarial.nativeMode === "start-mutated") ||
                (request.kind === "linux-oci-observe-started@1" &&
                  adversarial.nativeMode === "start-observation-mutated")
              ) {
                if (!accepted) throw new Error("original execution absent");
                accepted.principal = "synthetic-foreign";
              }
              reply({
                kind:
                  request.kind === "linux-oci-observe-stopped@1"
                    ? "linux-oci-stopped-observation@1"
                    : request.kind === "linux-oci-start@1"
                      ? "linux-oci-started@1"
                      : "linux-oci-started-observation@1",
                nativeId:
                  (request.kind === "linux-oci-start@1" &&
                    adversarial.nativeMode === "start-foreign-id") ||
                  (request.kind === "linux-oci-observe-started@1" &&
                    (adversarial.nativeMode === "start-observation-foreign-id" ||
                      adversarial.nativeObservationFaultAt === nativeStartedObservations))
                    ? "f".repeat(64)
                    : nativeId,
                namespaceDevice: 4,
                namespaceInode: 55,
                barrier: "unproven",
              });
            } else if (
              request.kind === "linux-oci-stop-init@1" ||
              request.kind === "linux-oci-join-init@1"
            ) {
              if (!nativeId) throw new Error("raw original init absent");
              if (
                request.kind === "linux-oci-stop-init@1" &&
                adversarial.nativeMode === "start-retire-unknown"
              ) {
                reply({
                  kind: "linux-oci-refused@1",
                  stage: "stop-init",
                  errno: 110,
                  custody: "retained",
                  barrier: "unproven",
                });
              } else {
                if (
                  request.kind === "linux-oci-stop-init@1" &&
                  adversarial.nativeMode === "start-retire-mutated"
                ) {
                  if (!accepted) throw new Error("original delete execution absent");
                  accepted.principal = "synthetic-foreign";
                }
                reply({
                  kind:
                    request.kind === "linux-oci-stop-init@1"
                      ? "linux-oci-init-reaped@1"
                      : "linux-oci-init-reaped-observation@1",
                  nativeId:
                    request.kind === "linux-oci-stop-init@1" &&
                    adversarial.nativeMode === "start-retire-foreign-id"
                      ? "f".repeat(64)
                      : nativeId,
                  namespaceDevice: 4,
                  namespaceInode: 55,
                  pidNamespaceDevice: 6,
                  pidNamespaceInode: 77,
                  barrier: "unproven",
                });
              }
            } else if (
              request.kind === "linux-oci-release-namespace@1" ||
              request.kind === "linux-oci-continue-namespace-release@1" ||
              request.kind === "linux-oci-observe-namespace-lifetime@1"
            ) {
              if (!nativeId || !adversarial.namespaceMode)
                throw new Error("original namespace fixture absent");
              expect(Object.keys(request)).toEqual(["kind"]);
              if (
                request.kind === "linux-oci-release-namespace@1" &&
                adversarial.namespaceMode === "retained"
              )
                reply({
                  kind: "linux-oci-refused@1",
                  stage: "release-namespace",
                  errno: 5,
                  custody: "retained",
                  barrier: "unproven",
                });
              else if (
                request.kind === "linux-oci-release-namespace@1" &&
                adversarial.namespaceMode === "unknown"
              )
                stdout.end();
              else
                reply({
                  kind:
                    request.kind === "linux-oci-release-namespace@1"
                      ? "linux-oci-namespace-release-observation@1"
                      : request.kind === "linux-oci-continue-namespace-release@1"
                        ? "linux-oci-namespace-release-continuation@1"
                        : "linux-oci-namespace-lifetime-observation@1",
                  nativeId: adversarial.namespaceMode === "foreign" ? "f".repeat(64) : nativeId,
                  namespaceDevice: 4,
                  namespaceInode: 55,
                  netCookie: "18446744073709551615",
                  fullIpSockets: "2",
                  requests: "0",
                  timewait: "1",
                  packetGroups: "3",
                  born: 1,
                  releaseAttempted: 1,
                  referenceReleased: 1,
                  netGone: 0,
                  poisoned: 0,
                  barrier: "unproven",
                });
            } else if (disposalWire.some(([kind]) => kind === request.kind)) {
              if (!nativeId) throw new Error("original disposal native identity absent");
              expect(Object.keys(request)).toEqual(["kind"]);
              const selected = disposalWire.find(([kind]) => kind === request.kind);
              if (!selected) throw new Error("original disposal operation absent");
              const [kind, replyKind, stage] = selected;
              const mode = adversarial.disposalMode;
              if (
                mode === undefined ||
                (!disposalRefused &&
                  ((mode === "begin-retained" && stage === "begin-tracked-join") ||
                    (mode === "delete-retained" && stage === "delete-born") ||
                    (mode === "dispose-retained" && stage === "dispose-born")))
              ) {
                disposalRefused = true;
                reply({
                  kind: "linux-oci-refused@1",
                  stage,
                  errno: 11,
                  custody: "retained",
                  barrier: "unproven",
                });
              } else if (mode === "unknown" && stage === "begin-tracked-join") stdout.end();
              else {
                reply({ kind: replyKind, barrier: "unproven" });
                if (
                  kind === "linux-oci-dispose-born@1" ||
                  kind === "linux-oci-continue-born-disposal@1"
                ) {
                  stdout.end();
                  if (adversarial.disposalExit !== "close-only") {
                    nativeExits++;
                    child.emit("exit", adversarial.disposalExit === "nonzero" ? 1 : 0, null);
                  }
                  child.emit("close", 0, null);
                }
              }
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
        if (managing && !managementSent) {
          stdout.end();
          stderr.end();
          child.emit("exit", 77, null);
          child.emit("close", 77, null);
          return;
        }
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
    unpackEnvironments.push(options.env);
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
  let duringLoan:
    | ((
        execution: V2Execution,
        signal: AbortSignal,
        bundle: LinuxOciBorrowedBundle,
      ) => Promise<void>)
    | undefined;
  let beforeLoan: ((execution: V2Execution) => Promise<void>) | undefined;
  const failures: unknown[] = [];
  const stopped: unknown[] = [];
  const started: unknown[] = [];
  const reaped: unknown[] = [];
  const namespaces: unknown[] = [];
  const disposals: unknown[] = [];
  const allocations: unknown[] = [];
  let beforeAllocation: ((execution: V2Execution) => Promise<void>) | undefined;
  let retireSignal: AbortSignal | undefined;
  let beforeRetire: ((execution: V2Execution) => Promise<void>) | undefined;
  let afterRetire: ((execution: V2Execution) => Promise<void>) | undefined;
  let beforeStart: ((execution: V2Execution) => Promise<void>) | undefined;
  let afterStart: ((execution: V2Execution) => Promise<void>) | undefined;
  const dispatch = async (execution: V2Execution): Promise<V2BackendResult> => {
    accepted = execution;
    try {
      await beforeLoan?.(execution);
      if (adversarial.parentControl && execution.action === "delete") {
        await beforeRetire?.(execution);
        return composition.retainedForm.backend.execute(execution);
      }
      if (adversarial.nativeMode !== undefined) {
        if (
          execution.action === "delete" &&
          (adversarial.nativeMode.startsWith("start-retire") ||
            adversarial.nativeMode === "retire-pending")
        ) {
          await beforeRetire?.(execution);
          if (adversarial.disposalMode) {
            disposals.push(
              ...(await composition.disposeRetainedBornOwners(execution, retireSignal)),
            );
            if (adversarial.allocationDisposal) {
              await beforeAllocation?.(execution);
              allocations.push(
                ...(await composition.disposeRetainedAllocations(execution, retireSignal)),
              );
            }
            await afterRetire?.(execution);
          } else if (adversarial.namespaceMode) {
            namespaces.push(
              ...(await composition.releaseRetainedNamespaces(execution, retireSignal)),
            );
            await afterRetire?.(execution);
          } else
            reaped.push(
              ...(await (retireSignal === undefined
                ? composition.stopRetainedInit(execution)
                : composition.stopRetainedInit(execution, retireSignal))),
            );
          return { kind: "continue" };
        }
        stopped.push(await composition.createAcceptedStopped(execution));
        if (adversarial.nativeMode === "retire-pending") {
          await beforeStart?.(execution);
          return {
            kind: "partial",
            code: "start_not_dispatched",
            message: "Original stopped CREATE finished before the START dispatch fault",
          };
        }
        if (adversarial.nativeMode.startsWith("start")) {
          await beforeStart?.(execution);
          started.push(await composition.startAccepted(execution));
          await afterStart?.(execution);
        }
        if (adversarial.nativeMode.startsWith("start-retire"))
          return {
            kind: "partial",
            code: "admission_not_composed",
            message: "Original init started; network admission and serving are not composed",
          };
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
        await duringLoan?.(execution, bundle.signal, bundle);
      });
      // A real bounded artifact step, never native CREATE/START/completion.
      return { kind: "continue" };
    } catch (error: unknown) {
      failures.push(error);
      return { kind: "unknown" };
    }
  };
  // Only the new private peer normal-form fixture captures the actual engine
  // execution for await-boundary refusal tests, then calls the real backend.
  const normalForm = (backend: ReturnType<typeof createLinuxOciOwnedBundle>) => {
    if (!adversarial.parentPeer) return backend.retainedForm;
    const invoke = async (execution: V2Execution, phase: "execute" | "reconcile") => {
      accepted = execution;
      if (execution.action === "delete") await beforeRetire?.(execution);
      return backend.retainedForm.backend[phase](execution);
    };
    return {
      ...backend.retainedForm,
      backend: {
        ...backend.retainedForm.backend,
        execute: (execution: V2Execution) => invoke(execution, "execute"),
        reconcile: (execution: V2Execution) => invoke(execution, "reconcile"),
      },
    };
  };
  const normalEngine = (backend: ReturnType<typeof createLinuxOciOwnedBundle>) =>
    createTakoformV2Engine(
      {
        sql,
        now: normalClock,
        authorize: async () => true,
        replayWindowSeconds: 3600,
        privateInputCustody: {
          transfer: { current: { id: "synthetic-oci-transfer", key } },
          comparison: { current: { id: "synthetic-oci-comparison", key: comparison } },
          transferTtlSeconds: 300,
        },
        forms: { [V2_CONTAINER_F2_FORM]: normalForm(backend) },
      },
      backend.acceptance,
    );
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
      ...(adversarial.normalBackend
        ? { now: normalClock, forms: { [V2_CONTAINER_F2_FORM]: normalForm(composition) } }
        : {}),
    },
    composition.acceptance,
  );
  const fields = CONTAINER_CONTRACT.fields;
  return {
    sql,
    engine,
    composition,
    configuredInputs,
    advanceNormalClock(milliseconds: number) {
      normalTime += milliseconds;
    },
    reconstructParent() {
      if (!recreateParent) throw new Error("original parent selection absent");
      return recreateParent();
    },
    reconstructNormal() {
      if (!recreateNormal) throw new Error("normal backend mode absent");
      const original = recreateNormal();
      return { engine: normalEngine(original), close: original.close };
    },
    physicalBinary,
    recordedCreate(): LinuxOciCreateStoppedRequest {
      const data = originalCreate;
      if (!data) throw new Error("original raw CREATE absent");
      const text = (key: string) => {
        const value = data[key];
        if (typeof value !== "string") throw new Error("original raw field absent");
        return value;
      };
      const integer = (key: string) => {
        const value = data[key];
        if (typeof value !== "number") throw new Error("original raw number absent");
        return value;
      };
      const strings = (key: string) => {
        const value = data[key];
        if (
          !Array.isArray(value) ||
          !value.every((part): part is string => typeof part === "string")
        )
          throw new Error("original raw array absent");
        return value;
      };
      return {
        allocationRoot: text("allocationRoot"),
        claimId: text("claimId"),
        installationId: text("installationId"),
        resourceUid: text("resourceUid"),
        incarnationId: text("incarnationId"),
        generation: integer("generation"),
        revision: text("revision"),
        sourceDigest: text("sourceDigest"),
        manifestDigest: text("manifestDigest"),
        configDigest: text("configDigest"),
        archiveDigest: text("archiveDigest"),
        args: strings("args"),
        env: strings("env"),
        cwd: text("cwd"),
        uid: integer("uid"),
        gid: integer("gid"),
        memoryBytes: integer("memoryBytes"),
        nanoCpus: integer("nanoCpus"),
        pidsLimit: integer("pidsLimit"),
      };
    },
    failures,
    artifactRoot,
    stopped,
    started,
    reaped,
    namespaces,
    disposals,
    allocations,
    beforeAllocation(callback: typeof beforeAllocation) {
      beforeAllocation = callback;
    },
    retireSignal(signal: AbortSignal) {
      retireSignal = signal;
    },
    beforeRetire(callback: typeof beforeRetire) {
      beforeRetire = callback;
    },
    afterRetire(callback: typeof afterRetire) {
      afterRetire = callback;
    },
    beforeStart(callback: typeof beforeStart) {
      beforeStart = callback;
    },
    afterStart(callback: typeof afterStart) {
      afterStart = callback;
    },
    nativeCounts: () => ({ processes: nativeProcesses, requests: [...nativeRequests] }),
    nativeExits: () => nativeExits,
    nativeTrailingByte() {
      if (!originalNativeStdout) throw new Error("original raw native stream absent");
      originalNativeStdout.emit("data", Buffer.from([0]));
    },
    nativeClosing: () => nativeClosing,
    unpackerEntered,
    unpackEnvironments,
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
            [fields.outboundInternet]: adversarial.outboundInternet ?? true,
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

test("accepted OCI running records the original fresh child fact without replay or publication", async () => {
  const f = await fixture(false, { nativeMode: "start" });
  f.beforeStart(async (execution) => {
    const before = f.nativeCounts();
    for (const changed of [
      { principal: "synthetic-foreign" },
      { backendId: "synthetic-foreign" },
      { targetKey: "synthetic-foreign" },
    ])
      await expect(f.composition.startAccepted({ ...execution, ...changed })).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
  });
  f.afterStart(async (execution) => {
    const before = f.nativeCounts();
    await expect(f.composition.startAccepted(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
  });
  try {
    await f.create();
    const result = await f.engine.runNext();
    expect(f.failures).toEqual([]);
    expect(f.started).toHaveLength(1);
    const rows = await f.sql.query(
      "SELECT q.claim_id,q.native_id,q.state,s.attempt,s.state AS start_state,s.claimed_at_ms,s.confirmed_running_at_ms,s.confirmed_exited_at_ms FROM tf_v2_container_create_claims q JOIN tf_v2_container_start_attempts s USING(resource_uid,generation)",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("original bound claim absent");
    expect(row.native_id).toBe(row.claim_id);
    expect(row).toMatchObject({
      state: "bound",
      attempt: 1,
      start_state: "running",
      confirmed_exited_at_ms: null,
    });
    if (typeof row.claimed_at_ms !== "number" || typeof row.confirmed_running_at_ms !== "number")
      throw new Error("original running observation absent");
    expect(row.confirmed_running_at_ms).toBeGreaterThanOrEqual(row.claimed_at_ms);
    expect(f.started[0]).toEqual({
      kind: "linux-oci-started-observation@1",
      nativeId: row.native_id,
      namespaceDevice: 4,
      namespaceInode: 55,
      barrier: "unproven",
    });
    expect(f.nativeCounts()).toEqual({
      processes: 1,
      requests: [
        "linux-oci-create-stopped@1",
        "linux-oci-observe-stopped@1",
        "linux-oci-start@1",
        "linux-oci-observe-started@1",
      ],
    });
    expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 0 });
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    expect(result?.effect).not.toBe("complete");
    const execution = f.execution;
    if (!execution) throw new Error("original execution absent");
    const before = f.nativeCounts();
    await expect(f.composition.startAccepted(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const nativeMode of ["start-foreign-id", "start-mutated"] as const) {
  test(`accepted OCI START ${nativeMode} retains its original one-use UNKNOWN without replay`, async () => {
    const f = await fixture(false, { nativeMode });
    try {
      await f.create();
      const result = await f.engine.runNext();
      expect(f.failures).toHaveLength(1);
      expect(f.started).toEqual([]);
      expect(await f.sql.query("SELECT state FROM tf_v2_container_create_claims")).toEqual([
        { state: "bound" },
      ]);
      expect(
        await f.sql.query(
          "SELECT attempt,state,confirmed_running_at_ms FROM tf_v2_container_start_attempts",
        ),
      ).toEqual([{ attempt: 1, state: "pending", confirmed_running_at_ms: null }]);
      expect(f.nativeCounts()).toEqual({
        processes: 1,
        requests: [
          "linux-oci-create-stopped@1",
          "linux-oci-observe-stopped@1",
          "linux-oci-start@1",
        ],
      });
      expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual(
        [{ serving_generation: null }],
      );
      expect(result?.effect).not.toBe("complete");
      const execution = f.execution;
      if (!execution) throw new Error("original execution absent");
      const before = f.nativeCounts();
      await expect(f.composition.startAccepted(execution)).rejects.toThrow();
      expect(f.nativeCounts()).toEqual(before);
    } finally {
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

test("accepted OCI START after close refuses before consuming the original SQL attempt or sending START", async () => {
  const f = await fixture(false, { nativeMode: "start" });
  let closing: Promise<void> | undefined;
  f.beforeStart(async () => {
    closing = f.composition.close();
    void closing.catch(() => undefined);
  });
  try {
    await f.create();
    const result = await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.started).toEqual([]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
    expect(f.nativeCounts().requests.filter((x) => x === "linux-oci-start@1")).toEqual([]);
    expect(result?.effect).not.toBe("complete");
    if (!closing) throw new Error("original close absent");
    await expect(closing).rejects.toThrow("custody_retained");
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const nativeMode of ["start-observation-foreign-id", "start-observation-mutated"] as const) {
  test(`accepted OCI running ${nativeMode} refuses the fresh fact before its SQL transition`, async () => {
    const f = await fixture(false, { nativeMode });
    try {
      await f.create();
      const result = await f.engine.runNext();
      expect(f.failures).toHaveLength(1);
      expect(f.started).toEqual([]);
      expect(
        await f.sql.query(
          "SELECT attempt,state,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts",
        ),
      ).toEqual([
        {
          attempt: 1,
          state: "pending",
          confirmed_running_at_ms: null,
          confirmed_exited_at_ms: null,
        },
      ]);
      expect(f.nativeCounts()).toEqual({
        processes: 1,
        requests: [
          "linux-oci-create-stopped@1",
          "linux-oci-observe-stopped@1",
          "linux-oci-start@1",
          "linux-oci-observe-started@1",
        ],
      });
      expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual(
        [{ serving_generation: null }],
      );
      expect(result?.effect).not.toBe("complete");
      const execution = f.execution;
      if (!execution) throw new Error("original execution absent");
      const before = f.nativeCounts();
      await expect(f.composition.startAccepted(execution)).rejects.toThrow();
      expect(f.nativeCounts()).toEqual(before);
    } finally {
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

test("accepted OCI running rejects a separate initialized session with the original claim before reading it", async () => {
  const f = await fixture(false, { nativeMode: "start" });
  const foreign = createDockerContainerCoreOwner({
    sql: f.sql,
    clock: () => new Date(),
    installationId: "synthetic-oci-installation",
    backendId: "synthetic-oci-backend",
    targetKey: "synthetic-oci-target",
    configuredInputs: f.configuredInputs,
  });
  let separate: ReturnType<typeof createLinuxOciPhysicalSession> | undefined;
  let checked = false;
  f.afterStart(async (execution) => {
    await foreign.withExecution(execution, async () => {
      const accepted = await foreign.readAcceptedExecution(execution);
      const current = accepted.retained.find(
        ({ record }) => record.intent.policy.generation === execution.generation,
      );
      if (!current) throw new Error("original bound record absent");
      const request = f.recordedCreate();
      expect(request.claimId).toBe(current.record.claimId);
      const signal = new AbortController().signal;
      const session = createLinuxOciPhysicalSession({ binary: f.physicalBinary });
      separate = session;
      await session.createStopped(request, signal);
      await session.startStopped(signal);
      await foreign.owner.withAuthority(current.record, "reconcile", async () => {
        const before = f.nativeCounts();
        await expect(
          foreign.confirmAcceptedRunning(current.record, session, signal),
        ).rejects.toThrow();
        expect(f.nativeCounts()).toEqual(before);
        checked = true;
      });
    });
  });
  try {
    await f.create();
    const result = await f.engine.runNext();
    expect(f.failures).toEqual([]);
    expect(checked).toBe(true);
    expect(f.started).toHaveLength(1);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    expect(result?.effect).not.toBe("complete");
  } finally {
    if (separate) await expect(separate.close()).rejects.toThrow("custody_retained");
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("accepted OCI retained init exits only after factual partial settlement and original DELETE acceptance", async () => {
  const f = await fixture(false, { nativeMode: "start-retire" });
  f.afterStart(async (execution) => {
    const before = f.nativeCounts();
    await expect(f.composition.stopRetainedInit(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
  });
  f.beforeRetire(async (execution) => {
    const before = f.nativeCounts();
    for (const changed of [
      { principal: "synthetic-foreign" },
      { backendId: "synthetic-foreign" },
      { targetKey: "synthetic-foreign" },
    ])
      await expect(f.composition.stopRetainedInit({ ...execution, ...changed })).rejects.toThrow();
    const cancel = new AbortController();
    cancel.abort();
    await expect(f.composition.stopRetainedInit(execution, cancel.signal)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
  });
  try {
    await f.create();
    const partial = await f.engine.runNext();
    expect(partial).toMatchObject({ status: "failed", effect: "partial" });
    expect(f.failures).toEqual([]);
    const created = f.execution;
    if (!created) throw new Error("original CREATE execution absent");
    const deletion = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
    });
    expect(deletion.action).toBe("delete");
    const result = await f.engine.runNext();
    expect(f.failures).toEqual([]);
    expect(f.reaped).toHaveLength(1);
    const rows = await f.sql.query(
      "SELECT q.claim_id,q.native_id,q.state,s.attempt,s.state AS start_state,s.confirmed_running_at_ms,s.confirmed_exited_at_ms FROM tf_v2_container_create_claims q JOIN tf_v2_container_start_attempts s USING(resource_uid,generation)",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("original retained row absent");
    expect(row).toMatchObject({ state: "bound", attempt: 1, start_state: "exited" });
    expect(row.native_id).toBe(row.claim_id);
    if (
      typeof row.confirmed_running_at_ms !== "number" ||
      typeof row.confirmed_exited_at_ms !== "number"
    )
      throw new Error("original exit observation absent");
    expect(row.confirmed_exited_at_ms).toBeGreaterThanOrEqual(row.confirmed_running_at_ms);
    expect(f.reaped[0]).toEqual({
      kind: "linux-oci-init-reaped-observation@1",
      nativeId: row.native_id,
      namespaceDevice: 4,
      namespaceInode: 55,
      pidNamespaceDevice: 6,
      pidNamespaceInode: 77,
      barrier: "unproven",
    });
    expect(f.nativeCounts()).toEqual({
      processes: 1,
      requests: [
        "linux-oci-create-stopped@1",
        "linux-oci-observe-stopped@1",
        "linux-oci-start@1",
        "linux-oci-observe-started@1",
        "linux-oci-stop-init@1",
        "linux-oci-join-init@1",
      ],
    });
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    expect(result?.effect).not.toBe("complete");
    const execution = f.execution;
    if (!execution) throw new Error("original DELETE execution absent");
    const before = f.nativeCounts();
    await expect(f.composition.stopRetainedInit(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const nativeMode of ["start-retire-unknown", "start-retire-mutated"] as const) {
  test(`accepted OCI retained init recovery ${nativeMode} joins the original attempt without repeating STOP`, async () => {
    const f = await fixture(false, { nativeMode });
    try {
      await f.create();
      expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
      const created = f.execution;
      if (!created) throw new Error("original CREATE execution absent");
      const deletion = await f.engine.acceptDelete({
        principal: "synthetic-oci-parent",
        key: crypto.randomUUID(),
        uid: created.resourceUid,
        expectedGeneration: 1,
      });
      const unknown = await f.engine.runNext();
      expect(unknown?.effect).not.toBe("complete");
      expect(f.failures).toHaveLength(1);
      expect(f.reaped).toEqual([]);
      expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
        { state: "running" },
      ]);
      expect(
        f.nativeCounts().requests.filter((kind) => kind === "linux-oci-stop-init@1"),
      ).toHaveLength(1);
      expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-join-init@1")).toEqual(
        [],
      );
      // Only the synthetic retry schedule changes. The real engine reclaims the
      // same accepted DELETE; no accepted/retention/START authority row is made.
      expect(
        await f.sql.run(
          "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
          [deletion.id],
        ),
      ).toMatchObject({ changes: 1 });
      const result = await f.engine.runNext();
      expect(f.failures).toHaveLength(1);
      expect(f.reaped).toHaveLength(1);
      expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
        { state: "exited" },
      ]);
      expect(f.nativeCounts()).toEqual({
        processes: 1,
        requests: [
          "linux-oci-create-stopped@1",
          "linux-oci-observe-stopped@1",
          "linux-oci-start@1",
          "linux-oci-observe-started@1",
          "linux-oci-stop-init@1",
          "linux-oci-join-init@1",
          "linux-oci-join-init@1",
        ],
      });
      expect(
        await f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"),
      ).toEqual([{ state: "bound", removed_at_ms: null }]);
      expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual(
        [{ serving_generation: null }],
      );
      expect(result?.effect).not.toBe("complete");
    } finally {
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

test("accepted OCI retained init foreign reap stays UNKNOWN on its original broken stream without STOP replay", async () => {
  const f = await fixture(false, { nativeMode: "start-retire-foreign-id" });
  try {
    await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
    const created = f.execution;
    if (!created) throw new Error("original CREATE execution absent");
    const deletion = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
    });
    await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.reaped).toEqual([]);
    const before = f.nativeCounts();
    expect(before.requests.at(-1)).toBe("linux-oci-stop-init@1");
    await f.sql.run(
      "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
      [deletion.id],
    );
    const result = await f.engine.runNext();
    expect(f.failures).toHaveLength(2);
    expect(f.reaped).toEqual([]);
    expect(f.nativeCounts()).toEqual(before);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
    expect(
      await f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"),
    ).toEqual([{ state: "bound", removed_at_ms: null }]);
    expect(result?.effect).not.toBe("complete");
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("accepted OCI retained init closed creator refuses STOP and preserves its running ledger", async () => {
  const f = await fixture(false, { nativeMode: "start-retire" });
  let closing: Promise<void> | undefined;
  f.beforeRetire(async () => {
    closing = f.composition.close();
    void closing.catch(() => undefined);
  });
  try {
    await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
    const created = f.execution;
    if (!created) throw new Error("original CREATE execution absent");
    await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
    });
    const result = await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.reaped).toEqual([]);
    expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-stop-init@1")).toEqual(
      [],
    );
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
    expect(result?.effect).not.toBe("complete");
    if (!closing) throw new Error("original close absent");
    await expect(closing).rejects.toThrow("custody_retained");
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("accepted OCI retained init pending START never becomes an exited SQL attempt", async () => {
  const f = await fixture(false, { nativeMode: "retire-pending" });
  const storage = createDockerContainerCoreOwner({
    sql: f.sql,
    clock: () => new Date(),
    installationId: "synthetic-oci-installation",
    backendId: "synthetic-oci-backend",
    targetKey: "synthetic-oci-target",
    configuredInputs: f.configuredInputs,
  });
  f.beforeStart(async (execution) => {
    await storage.withExecution(execution, async () => {
      const accepted = await storage.readAcceptedExecution(execution);
      const current = accepted.retained.find(
        ({ record }) => record.intent.policy.generation === execution.generation,
      );
      if (!current) throw new Error("original bound CREATE absent");
      await storage.owner.withAuthority(current.record, "reconcile", async () => {
        expect(await storage.claimAcceptedStart(current.record)).toBe("claimed");
      });
    });
  });
  try {
    await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
    expect(f.started).toEqual([]);
    const created = f.execution;
    if (!created) throw new Error("original CREATE execution absent");
    await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
    });
    const result = await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.reaped).toEqual([]);
    expect(
      await f.sql.query(
        "SELECT state,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts",
      ),
    ).toEqual([{ state: "pending", confirmed_running_at_ms: null, confirmed_exited_at_ms: null }]);
    expect(f.nativeCounts()).toEqual({
      processes: 1,
      requests: ["linux-oci-create-stopped@1", "linux-oci-stop-init@1", "linux-oci-join-init@1"],
    });
    expect(
      await f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"),
    ).toEqual([{ state: "bound", removed_at_ms: null }]);
    expect(result?.effect).not.toBe("complete");
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const boundary of [3, 4] as const) {
  for (const action of ["cancel", "close"] as const) {
    test(`accepted OCI retained init final current read ${boundary} ${action} never returns a positive reap after cancellation`, async () => {
      const f = await fixture(false, { nativeMode: "start-retire" });
      const cancel = new AbortController();
      f.retireSignal(cancel.signal);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let closing: Promise<void> | undefined;
      let restore = () => {};
      let finalReads = 0;
      let exited = false;
      try {
        await f.create();
        expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
        const created = f.execution;
        if (!created) throw new Error("original CREATE execution absent");
        await f.engine.acceptDelete({
          principal: "synthetic-oci-parent",
          key: crypto.randomUUID(),
          uid: created.resourceUid,
          expectedGeneration: 1,
        });
        const originalRun = f.sql.run.bind(f.sql);
        const originalQuery = f.sql.query.bind(f.sql);
        const run = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
          const result = await originalRun(statement, params);
          if (
            statement.startsWith("UPDATE tf_v2_container_start_attempts SET state='exited'") &&
            result.changes === 1
          )
            exited = true;
          return result;
        });
        const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
          const rows = await originalQuery(statement, params);
          // These are unchanged actual Sql rows. The first two reads after the
          // exit CAS belong to its readback/current guard. Reads 3/4 are the
          // final callback stillCurrent and outer original withAuthority guard.
          if (exited && statement.includes(" FROM tf_v2_container_instances i JOIN ")) {
            finalReads++;
            if (finalReads === boundary) {
              entered();
              await gate;
            }
          }
          return rows;
        });
        restore = () => {
          query.mockRestore();
          run.mockRestore();
        };
        const pass = f.engine.runNext();
        await Promise.race([
          reached,
          pass.then(() => {
            throw new Error("original final current Sql boundary was not reached");
          }),
        ]);
        expect(exited).toBe(true);
        expect(finalReads).toBe(boundary);
        if (action === "cancel") cancel.abort();
        else {
          closing = f.composition.close();
          void closing.catch(() => undefined);
        }
        release();
        const result = await pass;
        expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
          { state: "exited" },
        ]);
        expect(f.nativeCounts().processes).toBe(1);
        expect(
          f.nativeCounts().requests.filter((kind) => kind === "linux-oci-stop-init@1"),
        ).toHaveLength(1);
        expect(
          f.nativeCounts().requests.filter((kind) => kind === "linux-oci-join-init@1"),
        ).toHaveLength(1);
        expect(f.failures).toHaveLength(1);
        expect(f.reaped).toEqual([]);
        expect(result?.effect).not.toBe("complete");
        expect(
          await f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"),
        ).toEqual([{ state: "bound", removed_at_ms: null }]);
        if (closing) await expect(closing).rejects.toThrow("custody_retained");
      } finally {
        release();
        restore();
        await expect(f.close()).rejects.toThrow("custody_retained");
      }
    });
  }
}

test("the genuine OCI unpack child receives a fresh empty environment without inherited keys", async () => {
  const f = await fixture();
  try {
    await f.create();
    const result = await f.engine.runNext();
    expect(f.failures).toEqual([]);
    expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 1 });
    expect(f.unpackEnvironments).toHaveLength(1);
    const environment = f.unpackEnvironments[0];
    if (environment === null || typeof environment !== "object")
      throw new Error("original unpack environment absent");
    expect(Reflect.ownKeys(environment)).toEqual([]);
    expect(Object.getPrototypeOf(environment)).toBeNull();
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
    expect(result?.effect).not.toBe("complete");
  } finally {
    await f.close();
  }
});

const namespaceKinds: [string, string, string] = [
  "linux-oci-release-namespace@1",
  "linux-oci-continue-namespace-release@1",
  "linux-oci-observe-namespace-lifetime@1",
];
async function acceptNamespaceDelete(f: Awaited<ReturnType<typeof fixture>>) {
  await f.create();
  expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
  const execution = f.execution;
  if (!execution) throw new Error("original CREATE execution absent");
  return f.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid: execution.resourceUid,
    expectedGeneration: 1,
  });
}
async function assertNamespaceRetained(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
    { state: "exited" },
  ]);
  expect(
    await f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"),
  ).toEqual([{ state: "bound", removed_at_ms: null }]);
  expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
    { serving_generation: null },
  ]);
  expect(f.nativeCounts().processes).toBe(1);
  expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-stop-init@1")).toHaveLength(
    1,
  );
  expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-join-init@1")).toHaveLength(
    1,
  );
}

test("accepted OCI namespace release reaps the original running init, then reads without task replay or deletion", async () => {
  const f = await fixture(false, { nativeMode: "start-retire", namespaceMode: "success" });
  f.afterStart(async (execution) => {
    const before = f.nativeCounts();
    await expect(f.composition.releaseRetainedNamespaces(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
  });
  f.beforeRetire(async (execution) => {
    const before = f.nativeCounts();
    for (const changed of [
      { principal: "synthetic-foreign" },
      { backendId: "synthetic-foreign" },
      { targetKey: "synthetic-foreign" },
    ])
      await expect(
        f.composition.releaseRetainedNamespaces({ ...execution, ...changed }),
      ).rejects.toThrow();
    const cancel = new AbortController();
    cancel.abort();
    await expect(
      f.composition.releaseRetainedNamespaces(execution, cancel.signal),
    ).rejects.toThrow();
    // A read cannot initiate STOP, JOIN, namespace release or any other cleanup.
    await expect(f.composition.observeRetainedNamespaceLifetimes(execution)).rejects.toThrow();
    const foreign = createDockerContainerCoreOwner({
      sql: f.sql,
      clock: () => new Date(),
      installationId: "synthetic-oci-installation",
      backendId: "synthetic-oci-backend",
      targetKey: "synthetic-oci-target",
      configuredInputs: f.configuredInputs,
    });
    await foreign.withExecution(execution, async () => {
      const accepted = await foreign.readAcceptedExecution(execution);
      const old = accepted.retained.find(({ record }) => record.intent.policy.generation === 1);
      if (!old) throw new Error("original retained record absent");
      await foreign.owner.withAuthority(old.record, "remove", async (held) => {
        // A real same-Sql owner/lease and matching record still lack the creator's private key.
        await expect(
          foreign.releaseRetainedNamespace(
            execution,
            old.record,
            Object.freeze({}),
            held.revocation,
          ),
        ).rejects.toThrow();
      });
    });
    expect(f.nativeCounts()).toEqual(before);
  });
  let read: unknown;
  f.afterRetire(async (execution) => {
    const before = await f.sql.query("SELECT * FROM tf_v2_container_start_attempts");
    const requests = f.nativeCounts().requests;
    read = await f.composition.observeRetainedNamespaceLifetimes(execution);
    expect(await f.sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual(before);
    expect(f.nativeCounts().requests).toEqual([...requests, namespaceKinds[2]]);
  });
  try {
    await acceptNamespaceDelete(f);
    const result = await f.engine.runNext();
    expect(f.failures).toEqual([]);
    expect(f.namespaces).toHaveLength(1);
    expect(f.namespaces[0]).toMatchObject({
      kind: "linux-oci-namespace-release-observation@1",
      fullIpSockets: "2",
      packetGroups: "3",
      barrier: "unproven",
    });
    expect(read).toMatchObject([{ kind: "linux-oci-namespace-lifetime-observation@1" }]);
    await assertNamespaceRetained(f);
    expect(f.nativeCounts().requests.filter((kind) => namespaceKinds.includes(kind))).toEqual([
      namespaceKinds[0],
      namespaceKinds[2],
    ]);
    expect(result?.effect).not.toBe("complete");
    const execution = f.execution;
    if (!execution) throw new Error("original DELETE execution absent");
    const before = f.nativeCounts();
    await expect(f.composition.releaseRetainedNamespaces(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("accepted OCI namespace decoded retained refusal resumes only through the same child's unsent continuation", async () => {
  const f = await fixture(false, { nativeMode: "start-retire", namespaceMode: "retained" });
  f.afterRetire(async (execution) => {
    const snapshot = await f.composition.observeRetainedNamespaceLifetimes(execution);
    expect(snapshot).toHaveLength(1);
  });
  try {
    const deletion = await acceptNamespaceDelete(f);
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toHaveLength(1);
    expect(f.namespaces).toEqual([]);
    await assertNamespaceRetained(f);
    await f.sql.run(
      "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
      [deletion.id],
    );
    const result = await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(f.namespaces).toHaveLength(1);
    expect(f.namespaces[0]).toMatchObject({
      kind: "linux-oci-namespace-release-continuation@1",
      barrier: "unproven",
    });
    await assertNamespaceRetained(f);
    expect(f.nativeCounts().requests.filter((kind) => namespaceKinds.includes(kind))).toEqual(
      namespaceKinds,
    );
    expect(result?.effect).not.toBe("complete");
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const namespaceMode of ["unknown", "foreign"] as const) {
  test(`accepted OCI namespace ${namespaceMode} keeps the original broken child without RELEASE or STOP replay`, async () => {
    const f = await fixture(false, { nativeMode: "start-retire", namespaceMode });
    try {
      const deletion = await acceptNamespaceDelete(f);
      await f.engine.runNext();
      expect(f.failures).toHaveLength(1);
      expect(f.namespaces).toEqual([]);
      await assertNamespaceRetained(f);
      const before = f.nativeCounts();
      await f.sql.run(
        "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
        [deletion.id],
      );
      expect((await f.engine.runNext())?.effect).not.toBe("complete");
      expect(f.failures).toHaveLength(2);
      expect(f.namespaces).toEqual([]);
      expect(f.nativeCounts()).toEqual(before);
      await assertNamespaceRetained(f);
    } finally {
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

for (const phase of ["missing", "pending"] as const) {
  test(`accepted OCI namespace ${phase} START refuses task and namespace IO before any fabricated exit`, async () => {
    const f = await fixture(false, { nativeMode: "retire-pending", namespaceMode: "success" });
    if (phase === "pending") {
      const storage = createDockerContainerCoreOwner({
        sql: f.sql,
        clock: () => new Date(),
        installationId: "synthetic-oci-installation",
        backendId: "synthetic-oci-backend",
        targetKey: "synthetic-oci-target",
        configuredInputs: f.configuredInputs,
      });
      f.beforeStart(async (execution) =>
        storage.withExecution(execution, async () => {
          const accepted = await storage.readAcceptedExecution(execution);
          const current = accepted.retained.find(
            ({ record }) => record.intent.policy.generation === execution.generation,
          );
          if (!current) throw new Error("original CREATE absent");
          await storage.owner.withAuthority(current.record, "reconcile", async () => {
            expect(await storage.claimAcceptedStart(current.record)).toBe("claimed");
          });
        }),
      );
    }
    try {
      await acceptNamespaceDelete(f);
      const before = f.nativeCounts();
      expect((await f.engine.runNext())?.effect).not.toBe("complete");
      expect(f.failures).toHaveLength(1);
      expect(f.namespaces).toEqual([]);
      expect(f.nativeCounts()).toEqual(before);
      expect(before.requests).toEqual(["linux-oci-create-stopped@1"]);
      expect(
        await f.sql.query(
          "SELECT state,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts",
        ),
      ).toEqual(
        phase === "missing"
          ? []
          : [{ state: "pending", confirmed_running_at_ms: null, confirmed_exited_at_ms: null }],
      );
    } finally {
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

for (const boundary of [2, 3] as const) {
  for (const action of ["cancel", "close"] as const) {
    test(`accepted OCI namespace final current read ${boundary} ${action} retains facts without returning a cancelled snapshot`, async () => {
      const f = await fixture(false, { nativeMode: "start-retire", namespaceMode: "success" });
      const cancel = new AbortController();
      f.retireSignal(cancel.signal);
      let entered = () => {},
        release = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let closing: Promise<void> | undefined,
        restore = () => {},
        reads = 0;
      try {
        await acceptNamespaceDelete(f);
        const originalQuery = f.sql.query.bind(f.sql);
        const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
          const rows = await originalQuery(statement, params);
          if (
            f.nativeCounts().requests.includes(namespaceKinds[0]) &&
            statement.includes(" FROM tf_v2_container_instances i JOIN ")
          ) {
            reads++;
            if (reads === boundary) {
              entered();
              await gate;
            }
          }
          return rows;
        });
        restore = () => query.mockRestore();
        const pass = f.engine.runNext();
        await Promise.race([
          reached,
          pass.then(() => {
            throw new Error("original namespace final Sql boundary absent");
          }),
        ]);
        expect(reads).toBe(boundary);
        if (action === "cancel") cancel.abort();
        else {
          closing = f.composition.close();
          void closing.catch(() => undefined);
        }
        release();
        const result = await pass;
        expect(f.failures).toHaveLength(1);
        expect(f.namespaces).toEqual([]);
        await assertNamespaceRetained(f);
        expect(f.nativeCounts().requests.filter((kind) => namespaceKinds.includes(kind))).toEqual([
          namespaceKinds[0],
        ]);
        expect(result?.effect).not.toBe("complete");
        if (closing) await expect(closing).rejects.toThrow("custody_retained");
      } finally {
        release();
        restore();
        await expect(f.close()).rejects.toThrow("custody_retained");
      }
    });
  }
}

for (const outboundInternet of [false, true]) {
  test(`accepted OCI egress metadata preserves the actual accepted outbound=${outboundInternet} policy and isolated Host limits`, async () => {
    const selected = { maxConnections: 9, packetLimitBytes: 65536 };
    const f = await fixture(false, {
      egressLimits: selected,
      outboundInternet,
      viaHostCreator: !outboundInternet,
    });
    selected.maxConnections = 65535;
    selected.packetLimitBytes = Number.MAX_SAFE_INTEGER;
    let visited = false;
    f.onLoan(async (_execution, signal, bundle) => {
      await bundle.guard();
      expect(signal.aborted).toBe(false);
      const receipt = await readFile(
        join(bundle.allocationRoot, ".tako-oci-artifact.json"),
        "utf8",
      );
      const text = await readFile(
        join(bundle.allocationRoot, LINUX_OCI_EGRESS_POLICY_FILE),
        "utf8",
      );
      const metadata: unknown = JSON.parse(text);
      if (!isJsonObject(metadata)) throw new Error("original egress metadata absent");
      expect(Object.keys(metadata)).toEqual(["kind", "artifact", "policy", "limits"]);
      expect(metadata.kind).toBe("linux-oci-owned-egress@1");
      expect(JSON.stringify(metadata.artifact)).toBe(receipt);
      expect(metadata.policy).toEqual({
        tenantRef: bundle.record.intent.policy.tenantRef,
        generation: bundle.record.intent.policy.generation,
        policyDigest: bundle.record.intent.policy.policyDigest,
        outboundInternet: bundle.record.intent.policy.outboundInternet,
      });
      expect(bundle.record.intent.policy.tenantRef).toBe("synthetic-oci-parent");
      expect(bundle.record.intent.policy.generation).toBe(1);
      expect(bundle.record.intent.policy.outboundInternet).toBe(outboundInternet);
      expect(metadata.limits).toEqual({ maxConnections: 9, packetLimitBytes: 65536 });
      expect(text).toBe(JSON.stringify(metadata));
      const stat = await lstat(join(bundle.allocationRoot, LINUX_OCI_EGRESS_POLICY_FILE));
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
      const owner = process.getuid?.();
      if (owner === undefined) throw new Error("original host uid unavailable");
      expect(stat.uid).toBe(owner);
      await bundle.guard();
      visited = true;
    });
    try {
      await f.create();
      const result = await f.engine.runNext();
      expect(f.failures).toEqual([]);
      expect(visited).toBe(true);
      expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 1 });
      expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
      expect(
        await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims"),
      ).toEqual([{ state: "pending", native_id: null }]);
      expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual(
        [{ n: 0 }],
      );
      expect(result?.effect).not.toBe("complete");
    } finally {
      await f.close();
    }
  });
}

test("accepted OCI egress absent Host limits leaves the original private artifact without policy file or native installation", async () => {
  const f = await fixture();
  let visited = false;
  f.onLoan(async (_execution, _signal, bundle) => {
    const files = await readdir(bundle.allocationRoot);
    expect(files.sort()).toEqual([".tako-oci-artifact.json", "rootfs"]);
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toEqual([]);
    expect(visited).toBe(true);
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
  } finally {
    await f.close();
  }
});

test("accepted OCI egress Host limits reject unknown fields and accessors without inventing accepted policy", async () => {
  let reads = 0;
  for (const invalid of [
    { maxConnections: 1 },
    { maxConnections: -1, packetLimitBytes: 1 },
    { maxConnections: 65536, packetLimitBytes: 1 },
    { maxConnections: 1, packetLimitBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxConnections: 1, packetLimitBytes: 1.5 },
    { maxConnections: 1, packetLimitBytes: 1, tenantRef: "synthetic-foreign" },
    Object.create({ maxConnections: 1, packetLimitBytes: 1 }),
    Object.defineProperty({ packetLimitBytes: 1 }, "maxConnections", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    }),
  ])
    expect(() => snapshotLinuxOciEgressLimits(invalid)).toThrow("linux_oci_egress_policy_invalid");
  expect(reads).toBe(0);
  const zero = snapshotLinuxOciEgressLimits({ maxConnections: 0, packetLimitBytes: 0 });
  expect(zero).toEqual({ maxConnections: 0, packetLimitBytes: 0 });
  expect(Object.isFrozen(zero)).toBe(true);
  const extra = { maxConnections: 1, packetLimitBytes: 1, outboundInternet: true };
  await expect(fixture(false, { egressLimits: extra })).rejects.toThrow(
    "linux_oci_egress_policy_invalid",
  );
});

function syntheticTopology() {
  // Selection data only: no actual interface, route or native observation.
  return {
    interfaceName: "uplink0",
    interfaceIndex: 7,
    interfaceMac: "02:10:20:30:40:50",
    ipv4Address: "192.0.2.10/24",
    ipv4Gateway: "192.0.2.1",
    ipv6Address: "2001:db8:1::10/64",
    ipv6Gateway: "fe80::1",
    peerIpv4Host: "10.240.0.2",
    peerIpv4Guest: "10.240.0.3",
    peerIpv6Host: "fd60:1234::2",
    peerIpv6Guest: "fd60:1234::3",
  };
}

test("accepted OCI topology binds snapshotted Host selection to the original artifact without native facts", async () => {
  const selected = syntheticTopology(),
    expected = { ...selected };
  const f = await fixture(false, {
    hostTopology: selected,
    egressLimits: { maxConnections: 9, packetLimitBytes: 65536 },
    viaHostCreator: true,
  });
  selected.interfaceIndex++;
  selected.peerIpv4Guest = "10.240.0.4";
  let visited = false;
  f.onLoan(async (_execution, signal, bundle) => {
    await bundle.guard();
    const receipt = await readFile(join(bundle.allocationRoot, ".tako-oci-artifact.json"), "utf8");
    const file = join(bundle.allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE),
      text = await readFile(file, "utf8"),
      metadata: unknown = JSON.parse(text);
    if (!isJsonObject(metadata)) throw new Error("original topology selection absent");
    expect(Object.keys(metadata)).toEqual(["kind", "artifact", "topology"]);
    expect(metadata.kind).toBe("linux-oci-owned-topology@1");
    expect(JSON.stringify(metadata.artifact)).toBe(receipt);
    expect(metadata.topology).toEqual(expected);
    expect(text).toBe(JSON.stringify(metadata));
    const stat = await lstat(file);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("original host uid unavailable");
    expect(stat.uid).toBe(uid);
    expect(signal.aborted).toBe(false);
    await bundle.guard();
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toEqual([]);
    expect(visited).toBe(true);
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
    expect(await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "pending", native_id: null },
    ]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
  } finally {
    await f.close();
  }
});

test("accepted OCI topology absent selection leaves policy-only original allocation and no native link", async () => {
  const f = await fixture(false, { egressLimits: { maxConnections: 0, packetLimitBytes: 0 } });
  let visited = false;
  f.onLoan(async (_execution, _signal, bundle) => {
    expect((await readdir(bundle.allocationRoot)).sort()).toEqual([
      ".tako-oci-artifact.json",
      LINUX_OCI_EGRESS_POLICY_FILE,
      "rootfs",
    ]);
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toEqual([]);
    expect(visited).toBe(true);
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
  } finally {
    await f.close();
  }
});

test("accepted OCI topology requires explicit safe data and the original closed-birth policy selection", async () => {
  let reads = 0;
  for (const invalid of [
    {},
    { ...syntheticTopology(), interfaceIndex: 0 },
    { ...syntheticTopology(), interfaceName: "lo" },
    { ...syntheticTopology(), interfaceMac: "01:10:20:30:40:50" },
    { ...syntheticTopology(), ipv4Address: "192.0.2.0/24" },
    { ...syntheticTopology(), ipv4Gateway: "198.51.100.1" },
    { ...syntheticTopology(), ipv6Address: "2001:DB8:1::10/64" },
    { ...syntheticTopology(), ipv6Gateway: "2001:db8:2::1" },
    { ...syntheticTopology(), peerIpv4Guest: "10.240.0.4" },
    { ...syntheticTopology(), peerIpv4Host: "192.0.2.2", peerIpv4Guest: "192.0.2.3" },
    { ...syntheticTopology(), peerIpv6Guest: "fd60:1234::4" },
    { ...syntheticTopology(), peerIpv6Host: "2001:db8:2::2", peerIpv6Guest: "2001:db8:2::3" },
    { ...syntheticTopology(), owner: {} },
    Object.assign(Object.create({ inherited: true }), syntheticTopology()),
    Object.defineProperty(syntheticTopology(), "interfaceName", {
      enumerable: true,
      get() {
        reads++;
        return "uplink0";
      },
    }),
  ])
    expect(() => snapshotLinuxOciHostTopology(invalid)).toThrow("linux_oci_host_topology_invalid");
  expect(reads).toBe(0);
  const snapshot = snapshotLinuxOciHostTopology(syntheticTopology());
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(snapshot).toEqual(syntheticTopology());
  await expect(
    fixture(false, { hostTopology: syntheticTopology(), viaHostCreator: true }),
  ).rejects.toThrow("linux_oci_owned_bundle_host_topology_requires_egress");
});

test("accepted OCI topology close revokes the loan, retains the claimed allocation and joins private staging", async () => {
  const f = await fixture(false, {
    hostTopology: syntheticTopology(),
    egressLimits: { maxConnections: 9, packetLimitBytes: 65536 },
    viaHostCreator: true,
  });
  let allocation: string | undefined, closing: Promise<void> | undefined;
  f.onLoan(async (_execution, signal, bundle) => {
    allocation = bundle.allocationRoot;
    expect((await lstat(join(allocation, LINUX_OCI_HOST_TOPOLOGY_FILE))).isFile()).toBe(true);
    closing = f.composition.close();
    void closing.catch(() => undefined);
    expect(signal.aborted).toBe(true);
    await expect(bundle.guard()).rejects.toThrow();
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    await closing;
    if (allocation === undefined) throw new Error("original topology loan was not reached");
    expect(f.failures).toHaveLength(1);
    expect((await lstat(allocation)).isDirectory()).toBe(true);
    expect((await readdir(allocation)).sort()).toEqual([
      ".tako-oci-artifact.json",
      LINUX_OCI_EGRESS_POLICY_FILE,
      LINUX_OCI_SERVICE_POLICY_FILE,
      LINUX_OCI_HOST_TOPOLOGY_FILE,
      "rootfs",
    ]);
    expect(
      (await readdir(f.artifactRoot)).filter((name) => name.startsWith(".oci-stage-")),
    ).toEqual([]);
    expect(await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "pending", native_id: null },
    ]);
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
  } finally {
    await f.close();
  }
});

test("accepted OCI topology rejects zero-network uplink selections before original ownership", () => {
  for (const [ipv4Address, ipv4Gateway] of [
    ["0.1.2.3/24", "0.1.2.1"],
    ["0.2.0.1/16", "0.2.0.2"],
  ])
    expect(() =>
      snapshotLinuxOciHostTopology({ ...syntheticTopology(), ipv4Address, ipv4Gateway }),
    ).toThrow("linux_oci_host_topology_invalid");
});

test("accepted OCI service data binds the original HTTP spec to the claimed private artifact", async () => {
  const f = await fixture(false, {
    hostTopology: syntheticTopology(),
    egressLimits: { maxConnections: 9, packetLimitBytes: 65536 },
    viaHostCreator: true,
  });
  let visited = false;
  f.onLoan(async (_execution, signal, bundle) => {
    await bundle.guard();
    const receipt = await readFile(join(bundle.allocationRoot, ".tako-oci-artifact.json"), "utf8");
    const path = join(bundle.allocationRoot, LINUX_OCI_SERVICE_POLICY_FILE);
    const bytes = await readFile(path, "utf8");
    const data: unknown = JSON.parse(bytes);
    if (!isJsonObject(data)) throw new Error("original service data absent");
    expect(Object.keys(data)).toEqual(["kind", "artifact", "service"]);
    expect(data.kind).toBe("linux-oci-owned-service@1");
    expect(JSON.stringify(data.artifact)).toBe(receipt);
    expect(data.service).toEqual({ httpPort: 8080, healthPath: "/health" });
    expect(bytes).toBe(JSON.stringify(data));
    const egress: unknown = JSON.parse(
      await readFile(join(bundle.allocationRoot, LINUX_OCI_EGRESS_POLICY_FILE), "utf8"),
    );
    if (!isJsonObject(egress) || !isJsonObject(egress.policy))
      throw new Error("original policy absent");
    expect(egress.policy.policyDigest).toBe(bundle.record.intent.policy.policyDigest);
    expect(egress.limits).toEqual({ maxConnections: 9, packetLimitBytes: 65536 });
    const stat = await lstat(path);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("original host uid unavailable");
    expect(stat.uid).toBe(uid);
    expect(signal.aborted).toBe(false);
    await bundle.guard();
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(visited).toBe(true);
    expect(f.failures).toEqual([]);
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
    expect(await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "pending", native_id: null },
    ]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
  } finally {
    await f.close();
  }
});

test("accepted OCI service serialization rejects mismatched original records and invalid HTTP data", async () => {
  const f = await fixture(false, {
    hostTopology: syntheticTopology(),
    egressLimits: { maxConnections: 9, packetLimitBytes: 65536 },
  });
  const storage = createDockerContainerCoreOwner({
    sql: f.sql,
    clock: () => new Date(),
    installationId: "synthetic-oci-installation",
    backendId: "synthetic-oci-backend",
    targetKey: "synthetic-oci-target",
    configuredInputs: f.configuredInputs,
  });
  let visited = false;
  f.onLoan(async (execution, _signal, bundle) => {
    await storage.withExecution(execution, async () => {
      const accepted = await storage.readAcceptedExecution(execution);
      const serialized = serializeLinuxOciServicePolicy(bundle.receipt, bundle.record, accepted);
      expect(serialized).toBe(
        await readFile(join(bundle.allocationRoot, LINUX_OCI_SERVICE_POLICY_FILE), "utf8"),
      );
      for (const changed of [
        { ...accepted, principal: "another-parent" },
        { ...accepted, generation: accepted.generation + 1 },
        { ...accepted, resourceUid: "another-resource" },
        { ...accepted, outboundInternet: !accepted.outboundInternet },
      ])
        expect(() =>
          serializeLinuxOciServicePolicy(bundle.receipt, bundle.record, changed),
        ).toThrow("linux_oci_service_policy_invalid");
      expect(() =>
        serializeLinuxOciServicePolicy(
          { ...bundle.receipt, claimId: "0".repeat(64) },
          bundle.record,
          accepted,
        ),
      ).toThrow("linux_oci_service_policy_invalid");
      for (const spec of [
        { ...accepted.spec, httpPort: 0 },
        { ...accepted.spec, httpPort: 65536 },
        { ...accepted.spec, healthPath: "//foreign.example/" },
        { ...accepted.spec, healthPath: "/%2e%2e/" },
      ])
        expect(() =>
          serializeLinuxOciServicePolicy(bundle.receipt, bundle.record, { ...accepted, spec }),
        ).toThrow();
      let reads = 0;
      const spec = { ...accepted.spec };
      Object.defineProperty(spec, "httpPort", {
        enumerable: true,
        get() {
          reads++;
          return 8080;
        },
      });
      expect(() =>
        serializeLinuxOciServicePolicy(bundle.receipt, bundle.record, { ...accepted, spec }),
      ).toThrow();
      expect(reads).toBe(0);
    });
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toEqual([]);
    expect(visited).toBe(true);
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
  } finally {
    await f.close();
  }
});

test("accepted OCI service is absent without explicit Host topology selection", async () => {
  const f = await fixture(false, { egressLimits: { maxConnections: 9, packetLimitBytes: 65536 } });
  let visited = false;
  f.onLoan(async (_execution, _signal, bundle) => {
    expect((await readdir(bundle.allocationRoot)).sort()).toEqual([
      ".tako-oci-artifact.json",
      LINUX_OCI_EGRESS_POLICY_FILE,
      "rootfs",
    ]);
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toEqual([]);
    expect(visited).toBe(true);
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
  } finally {
    await f.close();
  }
});

// Raw HTTP/stdio facts model transport only. The selected-policy C admission
// producer is a separate source dependency; these cases certify no OPEN,
// actual network path, all-flow coverage, serving or operation completion.
function acceptedRawHttp() {
  const request = new EventEmitter(),
    response = new EventEmitter();
  const calls: unknown[] = [];
  let ends = 0,
    requestDestroy = 0,
    responseDestroy = 0;
  let onEnd = () => {};
  Object.assign(request, {
    end() {
      ends++;
      onEnd();
      return request;
    },
    destroy() {
      requestDestroy++;
      return request;
    },
  });
  Object.assign(response, {
    statusCode: 204,
    destroy() {
      responseDestroy++;
      return response;
    },
  });
  // Cast only the raw Node overload boundary, never an owner/probe/guard.
  const raw = spyOn(http, "request").mockImplementation(((options: unknown) => {
    calls.push(options);
    return request;
  }) as unknown as typeof http.request);
  if (!Object.is(importedRequest, raw)) throw new Error("raw HTTP interception absent");
  return {
    calls,
    request,
    response,
    counts: () => ({ ends, requestDestroy, responseDestroy }),
    onEnd(callback: () => void) {
      onEnd = callback;
    },
    reply() {
      request.emit("response", response);
    },
    join() {
      response.emit("close");
      request.emit("close");
    },
    restore() {
      raw.mockRestore();
    },
  };
}
function acceptedHttpSelection() {
  return {
    nativeMode: "start" as const,
    hostTopology: syntheticTopology(),
    egressLimits: { maxConnections: 9, packetLimitBytes: 65536 },
  };
}
const startedObservations = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.nativeCounts().requests.filter((kind) => kind === "linux-oci-observe-started@1").length;

test("accepted OCI HTTP uses the original running allocation and fixed GET bookends without publishing", async () => {
  const f = await fixture(false, acceptedHttpSelection());
  const raw = acceptedRawHttp();
  let visited = false;
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  f.afterStart(async (execution) => {
    expect(startedObservations(f)).toBe(1);
    const before = await f.sql.query("SELECT * FROM tf_v2_container_start_attempts");
    const result = await f.composition.observeAcceptedHttpHealth(execution);
    expect(result).toEqual({ nativeId: f.recordedCreate().claimId, statusCode: 204 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(await f.sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual(before);
    expect(startedObservations(f)).toBe(3);
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    if (f.failures[0]) throw f.failures[0];
    expect(visited).toBe(true);
    expect(raw.calls).toEqual([
      {
        protocol: "http:",
        hostname: "10.240.0.3",
        family: 4,
        port: 8080,
        path: "/health",
        method: "GET",
        agent: false,
        maxHeaderSize: 8192,
        headers: { Connection: "close" },
      },
    ]);
    expect(raw.counts()).toEqual({ ends: 1, requestDestroy: 1, responseDestroy: 1 });
    expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(
      1,
    );
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    const execution = f.execution;
    if (!execution) throw new Error("original execution absent");
    const counts = f.nativeCounts();
    await expect(f.composition.observeAcceptedHttpHealth(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(counts);
    expect(raw.calls).toHaveLength(1);
  } finally {
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("accepted OCI HTTP rejects foreign execution before IO and preserves the actual original execution", async () => {
  const f = await fixture(false, acceptedHttpSelection()),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let visited = false;
  f.afterStart(async (execution) => {
    const counts = f.nativeCounts();
    await expect(
      f.composition.observeAcceptedHttpHealth({ ...execution, principal: "foreign" }),
    ).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(counts);
    expect(raw.calls).toEqual([]);
    expect((await f.composition.observeAcceptedHttpHealth(execution)).statusCode).toBe(204);
    visited = true;
  });
  try {
    await f.create();
    await f.engine.runNext();
    if (f.failures[0]) throw f.failures[0];
    expect(visited).toBe(true);
    expect(raw.calls).toHaveLength(1);
  } finally {
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const mode of ["unconfigured", "pending"] as const) {
  test(`accepted OCI HTTP rejects ${mode} before native observation or HTTP`, async () => {
    const f = await fixture(
      false,
      mode === "pending"
        ? { ...acceptedHttpSelection(), nativeMode: "retire-pending" }
        : { nativeMode: "start" },
    );
    const raw = acceptedRawHttp();
    let visited = false;
    const check = async (execution: V2Execution) => {
      const before = f.nativeCounts();
      await expect(f.composition.observeAcceptedHttpHealth(execution)).rejects.toThrow();
      expect(f.nativeCounts()).toEqual(before);
      expect(raw.calls).toEqual([]);
      visited = true;
    };
    if (mode === "pending") f.beforeStart(check);
    else f.afterStart(check);
    try {
      await f.create();
      await f.engine.runNext();
      if (f.failures[0]) throw f.failures[0];
      expect(visited).toBe(true);
      expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual(
        mode === "pending" ? [] : [{ state: "running" }],
      );
    } finally {
      raw.restore();
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

for (const faultAt of [2, 3]) {
  test(`accepted OCI HTTP refuses foreign native bookend ${faultAt} from the same original transport`, async () => {
    const f = await fixture(false, {
      ...acceptedHttpSelection(),
      nativeObservationFaultAt: faultAt,
    });
    const raw = acceptedRawHttp();
    raw.onEnd(() => {
      raw.reply();
      raw.join();
    });
    let visited = false;
    f.afterStart(async (execution) => {
      await expect(f.composition.observeAcceptedHttpHealth(execution)).rejects.toThrow();
      expect(raw.calls).toHaveLength(faultAt === 2 ? 0 : 1);
      expect(startedObservations(f)).toBe(faultAt);
      visited = true;
    });
    try {
      await f.create();
      await f.engine.runNext();
      if (f.failures[0]) throw f.failures[0];
      expect(visited).toBe(true);
      expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
        { state: "running" },
      ]);
    } finally {
      raw.join();
      raw.restore();
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

for (const boundary of ["running-read", "outer-lease"] as const) {
  for (const action of ["cancel", "close"] as const) {
    test(`accepted OCI HTTP ${boundary} ${action} after real Sql read refuses a positive observation`, async () => {
      const f = await fixture(false, acceptedHttpSelection()),
        raw = acceptedRawHttp();
      const cancel = new AbortController();
      let reached = false,
        healthReadbacks = 0,
        joined = false;
      let closing: Promise<void> | undefined;
      let restore = () => {};
      raw.onEnd(() => {
        raw.reply();
        raw.join();
        joined = true;
      });
      f.afterStart(async (execution) => {
        const query = f.sql.query.bind(f.sql);
        const mock = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
          const rows = await query(statement, params);
          if (joined && statement.startsWith("SELECT attempt,create_claim_id,native_id,state,"))
            healthReadbacks++;
          const target =
            joined &&
            !reached &&
            (boundary === "running-read"
              ? healthReadbacks === 2 &&
                statement.startsWith("SELECT attempt,create_claim_id,native_id,state,")
              : healthReadbacks === 2 &&
                statement.includes(" FROM tf_v2_container_instances i JOIN "));
          if (target) {
            reached = true;
            // Same actual unchanged rows; only their await is extended. The
            // producer/START state and original currentness result stay real.
            await Promise.resolve();
            if (action === "cancel") cancel.abort();
            else {
              closing = f.composition.close();
              void closing.catch(() => undefined);
            }
          }
          return rows;
        });
        restore = () => mock.mockRestore();
        await expect(
          f.composition.observeAcceptedHttpHealth(execution, cancel.signal),
        ).rejects.toThrow();
        expect(reached).toBe(true);
        expect(raw.calls).toHaveLength(1);
        expect(startedObservations(f)).toBe(3);
        expect(await query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
          { state: "running" },
        ]);
      });
      try {
        await f.create();
        await f.engine.runNext();
        if (f.failures[0]) throw f.failures[0];
        expect(reached).toBe(true);
        expect(raw.counts().ends).toBe(1);
        if (closing) await expect(closing).rejects.toThrow("custody_retained");
      } finally {
        restore();
        raw.join();
        raw.restore();
        await expect(f.close()).rejects.toThrow("custody_retained");
      }
    });
  }
}

test("accepted OCI HTTP retains an unjoined original request through close without a replacement GET", async () => {
  const f = await fixture(false, acceptedHttpSelection()),
    raw = acceptedRawHttp();
  const cancel = new AbortController();
  let visited = false;
  raw.onEnd(() => {
    raw.reply();
    cancel.abort();
  });
  f.afterStart(async (execution) => {
    await expect(
      f.composition.observeAcceptedHttpHealth(execution, cancel.signal),
    ).rejects.toThrow();
    expect(raw.counts()).toEqual({ ends: 1, requestDestroy: 1, responseDestroy: 1 });
    const before = f.nativeCounts();
    await expect(f.composition.observeAcceptedHttpHealth(execution)).rejects.toThrow(
      "Container configured inputs unavailable",
    );
    expect(f.nativeCounts()).toEqual(before);
    expect(raw.calls).toHaveLength(1);
    visited = true;
  });
  try {
    await f.create();
    await f.engine.runNext();
    if (f.failures[0]) throw f.failures[0];
    expect(visited).toBe(true);
    await expect(f.composition.close()).rejects.toThrow("custody_retained");
    expect(raw.calls).toHaveLength(1);
    raw.join();
    await expect(f.composition.close()).rejects.toThrow("custody_retained");
    expect(raw.counts()).toEqual({ ends: 1, requestDestroy: 1, responseDestroy: 1 });
    // HTTP actually joins late. The distinct born native owner still retains
    // custody, so this is not whole-owner/DB shutdown or terminal success.
  } finally {
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
}, 10_000);

test("accepted OCI HTTP rejects a later Sql-port substitution before artifact or native IO", async () => {
  // Both are actual SqliteSql ports for the same disposable private database.
  // Neither is a callback/factory/row stub; original owner identity decides.
  await expect(
    fixture(false, { changingSql: true }).then(async (f) => {
      expect(f.counts()).toEqual({ reads: 0, unpacks: 0, uses: 0 });
      expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
      await f.close();
    }),
  ).rejects.toThrow("Sql");
});

// Publication follows the actual original HTTP implementation. These original
// engine/Sql + raw HTTP/stdio journeys prove source binding and SQL effects;
// their raw replies establish no real C admission, network or terminal proof.
test("accepted OCI serving publisher uses actual HTTP and original native START before the shared CAS", async () => {
  const f = await fixture(false, acceptedHttpSelection()),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let visited = false;
  f.afterStart(async (execution) => {
    await f.composition.publishAcceptedServing(execution);
    expect(
      await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: 1, runtime_epoch: 1 }]);
    expect(await f.sql.query("SELECT retention FROM tf_v2_container_revisions")).toEqual([
      { retention: "serving" },
    ]);
    expect(startedObservations(f)).toBe(6);
    // A new explicit observation may recheck the same serving generation, but
    // cannot re-START, re-OPEN or increment the original publication epoch.
    await f.composition.publishAcceptedServing(execution);
    expect(
      await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: 1, runtime_epoch: 1 }]);
    expect(startedObservations(f)).toBe(10);
    expect(raw.calls).toHaveLength(2);
    expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(
      1,
    );
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    if (f.failures[0]) throw f.failures[0];
    expect(visited).toBe(true);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
  } finally {
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("accepted OCI serving publisher rejects genuine unstarted allocation before HTTP or publication", async () => {
  const f = await fixture(false, { ...acceptedHttpSelection(), nativeMode: "retire-pending" }),
    raw = acceptedRawHttp();
  let visited = false;
  f.beforeStart(async (execution) => {
    const before = f.nativeCounts();
    await expect(f.composition.publishAcceptedServing(execution)).rejects.toThrow();
    expect(f.nativeCounts()).toEqual(before);
    expect(raw.calls).toEqual([]);
    visited = true;
  });
  try {
    await f.create();
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    if (f.failures[0]) throw f.failures[0];
    expect(visited).toBe(true);
    expect(
      await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: null, runtime_epoch: 0 }]);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([]);
  } finally {
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("accepted OCI serving publisher reasserts actual original native after the HTTP exchange", async () => {
  const f = await fixture(false, { ...acceptedHttpSelection(), nativeObservationFaultAt: 4 }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let visited = false;
  f.afterStart(async (execution) => {
    await expect(f.composition.publishAcceptedServing(execution)).rejects.toThrow();
    expect(raw.calls).toHaveLength(1);
    expect(startedObservations(f)).toBe(4);
    visited = true;
  });
  try {
    await f.create();
    await f.engine.runNext();
    if (f.failures[0]) throw f.failures[0];
    expect(visited).toBe(true);
    expect(
      await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: null, runtime_epoch: 0 }]);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
  } finally {
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("accepted OCI serving publisher rejects foreign constructor custody inside genuine current execution and lease", async () => {
  const f = await fixture(false, acceptedHttpSelection()),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let visited = false;
  f.afterStart(async (execution) => {
    const foreign = createDockerContainerCoreOwner({
      sql: f.sql,
      clock: () => new Date(),
      installationId: "synthetic-oci-installation",
      backendId: "synthetic-oci-backend",
      targetKey: "synthetic-oci-target",
      configuredInputs: f.configuredInputs,
    });
    await foreign.withExecution(execution, async () => {
      const accepted = await foreign.readAcceptedExecution(execution);
      const current = accepted.retained.find(
        ({ record }) => record.intent.policy.generation === accepted.generation,
      );
      if (!current) throw new Error("genuine current retained row absent");
      await foreign.owner.withAuthority(current.record, "reconcile", async (held) => {
        expect(await held.stillCurrent()).toBe(true);
        const before = f.nativeCounts();
        await expect(
          foreign.publishAcceptedOciServing(current.record, Object.freeze({}), held.revocation),
        ).rejects.toThrow();
        expect(f.nativeCounts()).toEqual(before);
        expect(raw.calls).toEqual([]);
        visited = true;
      });
    });
    // The same actual execution remains eligible for its ORIGINAL producer.
    await f.composition.publishAcceptedServing(execution);
    expect(raw.calls).toHaveLength(1);
  });
  try {
    await f.create();
    await f.engine.runNext();
    if (f.failures[0]) throw f.failures[0];
    expect(visited).toBe(true);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 1 },
    ]);
  } finally {
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const boundary of ["before-CAS", "after-CAS"] as const) {
  for (const action of ["cancel", "close"] as const) {
    test(`accepted OCI serving publisher ${boundary} ${action} retains actual SQL effects without positive return or replay`, async () => {
      const f = await fixture(false, acceptedHttpSelection()),
        raw = acceptedRawHttp();
      const cancel = new AbortController();
      let visited = false,
        changed = false,
        joined = false;
      let closing: Promise<void> | undefined;
      let restore = () => {};
      raw.onEnd(() => {
        raw.reply();
        raw.join();
        joined = true;
      });
      f.afterStart(async (execution) => {
        const originalQuery = f.sql.query.bind(f.sql),
          originalBatch = f.sql.batch.bind(f.sql);
        const revoke = () => {
          if (visited) return;
          visited = true;
          if (action === "cancel") cancel.abort();
          else {
            closing = f.composition.close();
            void closing.catch(() => undefined);
          }
        };
        const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
          const rows = await originalQuery(statement, params);
          if (
            boundary === "before-CAS" &&
            joined &&
            startedObservations(f) === 4 &&
            statement.startsWith("SELECT attempt,create_claim_id,native_id,state,")
          ) {
            // Actual unchanged private Sql result crosses the await boundary.
            await Promise.resolve();
            revoke();
          }
          return rows;
        });
        const batch = spyOn(f.sql, "batch").mockImplementation(async (statements) => {
          const rows = await originalBatch(statements);
          if (
            statements.some(({ sql }) =>
              sql.startsWith("UPDATE tf_v2_container_instances SET serving_generation="),
            )
          ) {
            changed = rows.some(({ changes }) => changes === 1);
            if (boundary === "after-CAS" && changed) {
              await Promise.resolve();
              revoke();
            }
          }
          return rows;
        });
        restore = () => {
          query.mockRestore();
          batch.mockRestore();
        };
        await expect(
          f.composition.publishAcceptedServing(execution, cancel.signal),
        ).rejects.toThrow();
        expect(visited).toBe(true);
        expect(changed).toBe(boundary === "after-CAS");
        expect(raw.calls).toHaveLength(1);
        expect(
          await originalQuery(
            "SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances",
          ),
        ).toEqual([
          boundary === "after-CAS"
            ? { serving_generation: 1, runtime_epoch: 1 }
            : { serving_generation: null, runtime_epoch: 0 },
        ]);
      });
      try {
        await f.create();
        expect((await f.engine.runNext())?.effect).not.toBe("complete");
        if (f.failures[0]) throw f.failures[0];
        expect(visited).toBe(true);
        expect(
          f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1"),
        ).toHaveLength(1);
        if (closing) await expect(closing).rejects.toThrow("custody_retained");
      } finally {
        restore();
        raw.join();
        raw.restore();
        await expect(f.close()).rejects.toThrow("custody_retained");
      }
    });
  }
}

for (const action of ["cancel", "close"] as const) {
  test(`accepted OCI serving publisher final shared current ${action} refuses CAS after revocation in original Sql await`, async () => {
    const f = await fixture(false, acceptedHttpSelection()),
      raw = acceptedRawHttp(),
      cancel = new AbortController();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter = () => {};
    const reached = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let closing: Promise<void> | undefined;
    let visited = false,
      changed = false,
      finalLoads = 0,
      configuredReads = 0;
    let restore = () => {};
    raw.onEnd(() => {
      raw.reply();
      raw.join();
    });
    f.afterStart(async (execution) => {
      const originalQuery = f.sql.query.bind(f.sql),
        originalBatch = f.sql.batch.bind(f.sql);
      const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
        const rows = await originalQuery(statement, params);
        if (startedObservations(f) === 5) {
          if (statement.includes(" FROM tf_v2_container_instances i JOIN ")) finalLoads++;
          // After the second original native verification, load #1 is its own
          // current guard. Load #2 is the shared helper's FINAL current await.
          // Its second configured read is load's last Sql await, with actual
          // unchanged rows. No fake lease/owner/START/CAS result is supplied.
          if (
            finalLoads === 2 &&
            statement.startsWith("SELECT material.key_id, material.nonce, material.ciphertext") &&
            ++configuredReads === 2
          ) {
            enter();
            await gate;
          }
        }
        return rows;
      });
      const batch = spyOn(f.sql, "batch").mockImplementation(async (statements) => {
        const rows = await originalBatch(statements);
        if (
          statements.some(({ sql }) =>
            sql.startsWith("UPDATE tf_v2_container_instances SET serving_generation="),
          )
        )
          changed ||= rows.some(({ changes }) => changes === 1);
        return rows;
      });
      restore = () => {
        query.mockRestore();
        batch.mockRestore();
      };
      const publishing = f.composition.publishAcceptedServing(execution, cancel.signal);
      await Promise.race([
        reached,
        publishing.then(() => {
          throw new Error("original final shared current Sql await was not reached");
        }),
      ]);
      expect(finalLoads).toBe(2);
      expect(configuredReads).toBe(2);
      expect(startedObservations(f)).toBe(5);
      if (action === "cancel") cancel.abort();
      else {
        closing = f.composition.close();
        void closing.catch(() => undefined);
      }
      release();
      await expect(publishing).rejects.toThrow();
      expect(changed).toBe(false);
      expect(
        await originalQuery(
          "SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances",
        ),
      ).toEqual([{ serving_generation: null, runtime_epoch: 0 }]);
      expect(raw.calls).toHaveLength(1);
      visited = true;
    });
    try {
      await f.create();
      expect((await f.engine.runNext())?.effect).not.toBe("complete");
      if (f.failures[0]) throw f.failures[0];
      expect(visited).toBe(true);
      expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(
        1,
      );
      expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
        { state: "running" },
      ]);
      if (closing) await expect(closing).rejects.toThrow("custody_retained");
    } finally {
      release();
      restore();
      raw.join();
      raw.restore();
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

test("normal OCI backend completes genuine accepted CREATE only after original START HTTP publisher and fresh serving read", async () => {
  const f = await fixture(false, { ...acceptedHttpSelection(), normalBackend: true }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    const resources = await f.sql.query("SELECT observed_json FROM tf_v2_resources");
    const saved = resources[0]?.observed_json;
    if (typeof saved !== "string") throw new Error("original observed row absent");
    const fields = CONTAINER_CONTRACT.fields;
    expect(JSON.parse(saved)).toEqual({
      [fields.ready]: true,
      [fields.servingGeneration]: 1,
      [fields.imageDigest]: f.acceptedDigest,
    });
    expect(
      await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: 1, runtime_epoch: 1 }]);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
    expect(f.nativeCounts().processes).toBe(1);
    expect(
      f.nativeCounts().requests.filter((kind) => kind === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
    expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(
      1,
    );
    expect(raw.calls).toHaveLength(1);
    expect(f.counts().unpacks).toBe(1);
    expect(f.recordedCreate().env).toEqual([
      "BASE=image",
      "MODE=synthetic-public",
      "SECRET=synthetic-loan",
    ]);
  } finally {
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("normal OCI backend reconciles the original running child after retained refusal and rejects a fresh foreign creator without IO", async () => {
  const f = await fixture(false, {
      ...acceptedHttpSelection(),
      normalBackend: true,
      nativeObservationRefusalAt: 6,
    }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let reconstructed: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    // This is the actual successful publisher CAS before its last native read
    // refused. No accepted, START, serving or Operation row is hand-written.
    expect(
      await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: 1, runtime_epoch: 1 }]);
    const before = f.nativeCounts();
    reconstructed = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    expect(await reconstructed.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.nativeCounts()).toEqual(before);
    expect(raw.calls).toHaveLength(1);
    // A new genuine engine lease over the ORIGINAL private controller can
    // observe and finish without another CREATE, START or publication epoch.
    f.advanceNormalClock(61_000);
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(f.nativeCounts().processes).toBe(1);
    expect(
      f.nativeCounts().requests.filter((kind) => kind === "linux-oci-create-stopped@1"),
    ).toHaveLength(1);
    expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(
      1,
    );
    expect(raw.calls).toHaveLength(2);
    expect(
      await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: 1, runtime_epoch: 1 }]);
  } finally {
    await reconstructed?.close();
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

for (const nativeMode of ["foreign-id", "start-foreign-id"] as const) {
  test(`normal OCI backend retains ${nativeMode} uncertainty without replaying CREATE or pending START on reconcile`, async () => {
    const f = await fixture(false, { ...acceptedHttpSelection(), normalBackend: true, nativeMode }),
      raw = acceptedRawHttp();
    try {
      const accepted = await f.create();
      expect(await f.engine.runNext()).toMatchObject({
        id: accepted.id,
        status: "reconciling",
        effect: "unknown",
      });
      const before = f.nativeCounts();
      f.advanceNormalClock(61_000);
      expect(await f.engine.runNext()).toMatchObject({
        id: accepted.id,
        status: "reconciling",
        effect: "unknown",
      });
      expect(f.nativeCounts()).toEqual(before);
      expect(raw.calls).toEqual([]);
      expect(
        await f.sql.query("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
      ).toEqual([{ serving_generation: null, runtime_epoch: 0 }]);
      expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual(
        nativeMode === "foreign-id" ? [] : [{ state: "pending" }],
      );
      expect(
        f.nativeCounts().requests.filter((kind) => kind === "linux-oci-create-stopped@1"),
      ).toHaveLength(1);
      expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(
        nativeMode === "foreign-id" ? 0 : 1,
      );
    } finally {
      raw.restore();
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

test("normal OCI backend preserves genuine accepted DELETE cleanup as noncomplete without a terminal lifetime producer", async () => {
  const f = await fixture(false, {
      ...acceptedHttpSelection(),
      normalBackend: true,
      namespaceMode: "success",
    }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    const deletion = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: deletion.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "exited" },
    ]);
    expect(
      await f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"),
    ).toEqual([{ state: "bound", removed_at_ms: null }]);
    expect(
      f.nativeCounts().requests.filter((kind) => kind === "linux-oci-stop-init@1"),
    ).toHaveLength(1);
    expect(
      f.nativeCounts().requests.filter((kind) => kind === "linux-oci-join-init@1"),
    ).toHaveLength(1);
    expect(
      f.nativeCounts().requests.filter((kind) => kind === "linux-oci-release-namespace@1"),
    ).toHaveLength(1);
    expect(raw.calls).toHaveLength(1);
  } finally {
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("normal OCI backend close during final original serving read refuses completion and retains the matched SQL publication", async () => {
  const f = await fixture(false, { ...acceptedHttpSelection(), normalBackend: true }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  const originalQuery = f.sql.query.bind(f.sql);
  let finalReads = 0;
  let closing: Promise<void> | undefined;
  const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
    const rows = await originalQuery(statement, params);
    if (
      startedObservations(f) === 6 &&
      statement.startsWith("SELECT attempt,create_claim_id,native_id,state,") &&
      ++finalReads === 3
    ) {
      // Original publisher's final verify and its final accepted guard precede
      // this distinct normal backend serving read. Keep the real rows intact.
      await Promise.resolve();
      closing = f.composition.close();
      void closing.catch(() => undefined);
    }
    return rows;
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(finalReads).toBe(3);
    expect(closing).toBeDefined();
    if (closing) await expect(closing).rejects.toThrow("custody_retained");
    expect(
      await originalQuery("SELECT serving_generation,runtime_epoch FROM tf_v2_container_instances"),
    ).toEqual([{ serving_generation: 1, runtime_epoch: 1 }]);
    expect(await originalQuery("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
    expect(f.nativeCounts().requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(
      1,
    );
    expect(raw.calls).toHaveLength(1);
  } finally {
    query.mockRestore();
    raw.join();
    raw.restore();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("singleton OCI topology claim checks the original durable pending winner before image allocation effects", async () => {
  const selected = syntheticTopology();
  const f = await fixture(false, {
    hostTopology: selected,
    egressLimits: { maxConnections: 9, packetLimitBytes: 65536 },
  });
  const query = f.sql.query.bind(f.sql);
  let checked = false;
  const observed = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
    const rows = await query(statement, params);
    if (
      statement.startsWith(
        "SELECT q.resource_uid,q.generation,q.installation_id,q.claim_id,q.state,q.native_id,q.claimed_at_ms,",
      )
    ) {
      expect(checked).toBe(false);
      checked = true;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("pending");
      expect(rows[0]?.native_id).toBeNull();
      expect(f.counts()).toEqual({ reads: 0, unpacks: 0, uses: 0 });
      expect(await readdir(f.artifactRoot)).toEqual([]);
    }
    return rows;
  });
  f.onLoan(async (_execution, _signal, bundle) => {
    expect(checked).toBe(true);
    const raw: unknown = JSON.parse(
      await readFile(join(bundle.allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE), "utf8"),
    );
    if (!isJsonObject(raw) || !isJsonObject(raw.artifact))
      throw new Error("original claim topology file absent");
    expect(raw.artifact.claimId).toBe(bundle.record.claimId);
    expect(raw.topology).toEqual(selected);
    expect(
      await query("SELECT claim_id,state,native_id FROM tf_v2_container_create_claims"),
    ).toEqual([{ claim_id: bundle.record.claimId, state: "pending", native_id: null }]);
  });
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      effect: "unknown",
      status: "reconciling",
    });
    expect(f.failures).toEqual([]);
    expect(checked).toBe(true);
    expect(f.counts()).toEqual({ reads: 2, unpacks: 1, uses: 1 });
    expect(f.nativeCounts()).toEqual({ processes: 0, requests: [] });
  } finally {
    observed.mockRestore();
    await f.close();
  }
});

test("singleton OCI topology claim retains second-generation and foreign pending collisions without restart replay", async () => {
  const f = await fixture(false, { ...acceptedHttpSelection(), normalBackend: true }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  const originalQuery = f.sql.query.bind(f.sql);
  const checked: number[] = [];
  const observed = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
    const rows = await originalQuery(statement, params);
    if (
      statement.startsWith(
        "SELECT q.resource_uid,q.generation,q.installation_id,q.claim_id,q.state,q.native_id,q.claimed_at_ms,",
      )
    )
      checked.push(rows.length);
    return rows;
  });
  let restarted: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    const first = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: first.id,
      effect: "complete",
      status: "succeeded",
    });
    expect(checked).toEqual([1]);
    const counts = f.counts(),
      native = f.nativeCounts(),
      files = await readdir(f.artifactRoot);
    const row = (
      await originalQuery("SELECT spec_json FROM tf_v2_resources WHERE uid=?", [first.resourceUid])
    )[0];
    if (typeof row?.spec_json !== "string") throw new Error("original accepted spec absent");
    const spec: unknown = JSON.parse(row.spec_json);
    if (!isJsonObject(spec)) throw new Error("original accepted spec malformed");
    const updated = await f.engine.acceptUpdate({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: first.resourceUid,
      expectedGeneration: 1,
      spec: { ...spec, [CONTAINER_CONTRACT.fields.workloadRevision]: "2".repeat(64) },
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: updated.id,
      effect: "unknown",
      status: "reconciling",
    });
    expect(checked).toEqual([1, 2]);
    expect(f.counts()).toEqual(counts);
    expect(f.nativeCounts()).toEqual(native);
    expect(await readdir(f.artifactRoot)).toEqual(files);
    expect(raw.calls).toHaveLength(1);
    const foreign = await f.engine.acceptCreate({
      principal: "synthetic-foreign-parent",
      key: crypto.randomUUID(),
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: "synthetic-space",
        name: "other-resource",
        spec,
        privateInputs: { SECRET: "synthetic-other-loan" },
      },
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: foreign.id,
      effect: "unknown",
      status: "reconciling",
    });
    expect(checked).toEqual([1, 2, 3]);
    expect(f.counts()).toEqual(counts);
    expect(f.nativeCounts()).toEqual(native);
    expect(await readdir(f.artifactRoot)).toEqual(files);
    const claims = await originalQuery(
      "SELECT resource_uid,generation,state,native_id FROM tf_v2_container_create_claims ORDER BY resource_uid,generation",
    );
    expect(claims).toHaveLength(3);
    expect(
      claims.filter(({ state }) => state === "pending").map(({ native_id }) => native_id),
    ).toEqual([null, null]);
    expect(
      claims.find(
        ({ resource_uid, generation }) => resource_uid === first.resourceUid && generation === 1,
      )?.state,
    ).toBe("bound");
    expect(
      await originalQuery("SELECT generation,state FROM tf_v2_container_start_attempts"),
    ).toEqual([{ generation: 1, state: "running" }]);
    restarted = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    expect(await restarted.engine.runNext()).toMatchObject({
      effect: "unknown",
      status: "reconciling",
    });
    expect(checked).toEqual([1, 2, 3]);
    expect(f.counts()).toEqual(counts);
    expect(f.nativeCounts()).toEqual(native);
    expect(
      await originalQuery(
        "SELECT resource_uid,generation,state,native_id FROM tf_v2_container_create_claims ORDER BY resource_uid,generation",
      ),
    ).toEqual(claims);
    expect(raw.calls).toHaveLength(1);
  } finally {
    observed.mockRestore();
    raw.join();
    raw.restore();
    await restarted?.close();
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

// Closed C28 facts are raw IO here, never native/terminal qualifications.
const disposalWire = [
  ["linux-oci-begin-tracked-join@1", "linux-oci-tracked-join-handoff@1", "begin-tracked-join"],
  ["linux-oci-read-tracked-join@1", "linux-oci-tracked-owner-destruction@1", "read-tracked-join"],
  ["linux-oci-delete-born@1", "linux-oci-born-delete-observation@1", "delete-born"],
  ["linux-oci-join-born-delete@1", "linux-oci-born-delete-join-observation@1", "join-born-delete"],
  ["linux-oci-dispose-born@1", "linux-oci-local-disposal@1", "dispose-born"],
  [
    "linux-oci-continue-born-disposal@1",
    "linux-oci-local-disposal-continuation@1",
    "continue-born-disposal",
  ],
] as const;
const disposalRequests = (f: Awaited<ReturnType<typeof fixture>>) =>
  f
    .nativeCounts()
    .requests.filter((kind) => disposalWire.some(([requestKind]) => kind === requestKind));

test("original OCI disposal binds genuine accepted exit to same original owner progress and child join without removal", async () => {
  const f = await fixture(false, {
    nativeMode: "start-retire",
    namespaceMode: "success",
    disposalMode: "success",
  });
  try {
    await acceptNamespaceDelete(f);
    const outcome = await f.engine.runNext();
    expect(f.failures).toEqual([]);
    expect(f.disposals).toEqual([
      { kind: "linux-oci-disposed-helper-exit@1", barrier: "unproven" },
    ]);
    expect(disposalRequests(f)).toEqual([
      disposalWire[0][0],
      disposalWire[1][0],
      disposalWire[2][0],
      disposalWire[4][0],
    ]);
    expect(f.nativeCounts().requests.filter((kind) => namespaceKinds.includes(kind))).toEqual([
      namespaceKinds[0],
    ]);
    expect(f.nativeExits()).toBe(1);
    await assertNamespaceRetained(f);
    expect(outcome?.effect).not.toBe("complete");
  } finally {
    await f.close();
  }
});

for (const disposalMode of ["begin-retained", "delete-retained", "dispose-retained"] as const) {
  test(`original OCI disposal ${disposalMode} resumes only original READ JOIN or continuation under a new genuine lease`, async () => {
    const f = await fixture(false, {
      nativeMode: "start-retire",
      namespaceMode: "success",
      disposalMode,
    });
    try {
      const deletion = await acceptNamespaceDelete(f);
      expect((await f.engine.runNext())?.effect).not.toBe("complete");
      expect(f.failures).toHaveLength(1);
      expect(f.disposals).toEqual([]);
      const first = disposalRequests(f);
      await f.sql.run(
        "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
        [deletion.id],
      );
      expect((await f.engine.runNext())?.effect).not.toBe("complete");
      expect(f.failures).toHaveLength(1);
      expect(f.disposals).toEqual([
        { kind: "linux-oci-disposed-helper-exit@1", barrier: "unproven" },
      ]);
      const all = disposalRequests(f);
      const suffix = all.slice(first.length);
      expect(suffix[0]).toBe(
        disposalMode === "begin-retained"
          ? disposalWire[1][0]
          : disposalMode === "delete-retained"
            ? disposalWire[3][0]
            : disposalWire[5][0],
      );
      for (const effect of [disposalWire[0][0], disposalWire[2][0], disposalWire[4][0]])
        expect(all.filter((kind) => kind === effect)).toHaveLength(1);
      expect(f.nativeCounts().requests.filter((kind) => namespaceKinds.includes(kind))).toEqual([
        namespaceKinds[0],
      ]);
      await assertNamespaceRetained(f);
    } finally {
      await f.close();
    }
  });
}

test("original OCI disposal broken original stream remains unknown without any effect replay", async () => {
  const f = await fixture(false, {
    nativeMode: "start-retire",
    namespaceMode: "success",
    disposalMode: "unknown",
  });
  try {
    const deletion = await acceptNamespaceDelete(f);
    await f.engine.runNext();
    expect(f.disposals).toEqual([]);
    const sent = f.nativeCounts();
    await f.sql.run(
      "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
      [deletion.id],
    );
    await f.engine.runNext();
    expect(f.disposals).toEqual([]);
    expect(f.nativeCounts()).toEqual(sent);
    expect(disposalRequests(f)).toEqual([disposalWire[0][0]]);
    await assertNamespaceRetained(f);
  } finally {
    await expect(f.close()).rejects.toThrow("custody_retained");
  }
});

test("original OCI disposal rejects foreign opaque custody even with real sameSql execution and remove lease before native IO", async () => {
  const f = await fixture(false, {
    nativeMode: "start-retire",
    namespaceMode: "success",
    disposalMode: "success",
  });
  const foreign = createDockerContainerCoreOwner({
    sql: f.sql,
    clock: () => new Date(),
    installationId: "synthetic-oci-installation",
    backendId: "synthetic-oci-backend",
    targetKey: "synthetic-oci-target",
    configuredInputs: f.configuredInputs,
  });
  f.beforeRetire(async (execution) => {
    const before = f.nativeCounts();
    await foreign.withExecution(execution, async () => {
      const accepted = await foreign.readAcceptedExecution(execution);
      const old = accepted.retained.find(({ record }) => record.intent.policy.generation === 1);
      if (!old) throw new Error("genuine retained record absent");
      await foreign.owner.withAuthority(old.record, "remove", async () => {
        await expect(
          foreign.advanceRetainedBornDisposal(
            execution,
            old.record,
            Object.freeze({}),
            new AbortController().signal,
          ),
        ).rejects.toThrow();
      });
    });
    expect(f.nativeCounts()).toEqual(before);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_start_attempts")).toEqual([
      { state: "running" },
    ]);
  });
  try {
    await acceptNamespaceDelete(f);
    await f.engine.runNext();
    expect(f.failures).toEqual([]);
    expect(f.disposals).toHaveLength(1);
    await assertNamespaceRetained(f);
  } finally {
    await f.close();
  }
});

for (const action of ["cancel", "close"] as const) {
  test(`original OCI disposal ${action} during actual currentSql read prevents the next unrequested DELETE`, async () => {
    const f = await fixture(false, {
      nativeMode: "start-retire",
      namespaceMode: "success",
      disposalMode: "success",
    });
    const cancel = new AbortController();
    f.retireSignal(cancel.signal);
    let entered = () => {},
      release = () => {};
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closing: Promise<void> | undefined,
      held = false,
      restore = () => {};
    try {
      await acceptNamespaceDelete(f);
      const original = f.sql.query.bind(f.sql);
      const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
        const rows = await original(statement, params);
        if (
          !held &&
          disposalRequests(f).includes(disposalWire[1][0]) &&
          statement.includes(" FROM tf_v2_container_instances i JOIN ")
        ) {
          held = true;
          entered();
          await gate;
        }
        return rows;
      });
      restore = () => query.mockRestore();
      const pending = f.engine.runNext();
      await Promise.race([
        reached,
        pending.then(() => {
          throw new Error("original current Sql boundary absent");
        }),
      ]);
      if (action === "cancel") cancel.abort();
      else {
        closing = f.composition.close();
        closing.catch(() => {});
      }
      release();
      expect((await pending)?.effect).not.toBe("complete");
      expect(held).toBe(true);
      expect(f.disposals).toEqual([]);
      expect(disposalRequests(f)).toEqual([disposalWire[0][0], disposalWire[1][0]]);
      await assertNamespaceRetained(f);
      if (closing) await expect(closing).rejects.toThrow("custody_retained");
    } finally {
      release();
      restore();
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

test("original OCI disposal normal DELETE rejects a reconstructed creator and resumes the original child without removal", async () => {
  const f = await fixture(false, {
      ...acceptedHttpSelection(),
      normalBackend: true,
      namespaceMode: "success",
      disposalMode: "begin-retained",
    }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let reconstructed: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    const deletion = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: deletion.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(disposalRequests(f)).toEqual([disposalWire[0][0]]);
    const before = f.nativeCounts();
    reconstructed = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    expect(await reconstructed.engine.runNext()).toMatchObject({
      id: deletion.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.nativeCounts()).toEqual(before);
    f.advanceNormalClock(61_000);
    expect(await f.engine.runNext()).toMatchObject({
      id: deletion.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(disposalRequests(f)).toEqual([
      disposalWire[0][0],
      disposalWire[1][0],
      disposalWire[2][0],
      disposalWire[4][0],
    ]);
    expect(f.nativeExits()).toBe(1);
    await assertNamespaceRetained(f);
    expect(raw.calls).toHaveLength(1);
  } finally {
    await reconstructed?.close();
    raw.join();
    raw.restore();
    await f.close();
  }
});

test("disposed creator local close joins the original helper without wire and retains allocation and Core claim", async () => {
  const f = await fixture(false, {
    nativeMode: "start-retire",
    namespaceMode: "success",
    disposalMode: "success",
  });
  try {
    await acceptNamespaceDelete(f);
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toEqual([]);
    expect(f.disposals).toEqual([
      { kind: "linux-oci-disposed-helper-exit@1", barrier: "unproven" },
    ]);
    const before = f.nativeCounts(),
      files = await readdir(f.artifactRoot),
      original = f.recordedCreate();
    expect(files).toContain(original.claimId);
    await f.composition.close();
    await f.composition.close();
    expect(f.nativeCounts()).toEqual(before);
    expect(f.nativeExits()).toBe(1);
    expect(await readdir(f.artifactRoot)).toEqual(files);
    expect(await readFile(join(original.allocationRoot, "rootfs", "synthetic-file"), "utf8")).toBe(
      "verified-image-model",
    );
    await assertNamespaceRetained(f);
  } finally {
    await f.close();
  }
});

for (const mode of ["unknown", "nonzero", "close-only"] as const) {
  test(`disposed creator local close retains ${mode} original child without legacy IO escape`, async () => {
    const f = await fixture(false, {
      nativeMode: "start-retire",
      namespaceMode: "success",
      disposalMode: mode === "unknown" ? "unknown" : "success",
      ...(mode === "unknown" ? {} : { disposalExit: mode }),
    });
    try {
      await acceptNamespaceDelete(f);
      expect((await f.engine.runNext())?.effect).not.toBe("complete");
      expect(f.failures).toHaveLength(1);
      expect(f.disposals).toEqual([]);
      const before = f.nativeCounts();
      await expect(f.composition.close()).rejects.toThrow("custody_retained");
      expect(f.nativeCounts()).toEqual(before);
      await assertNamespaceRetained(f);
    } finally {
      await expect(f.close()).rejects.toThrow("custody_retained");
    }
  });
}

test("disposed creator local close cannot lend original custody to a reconstructed normal backend", async () => {
  const f = await fixture(false, {
      ...acceptedHttpSelection(),
      normalBackend: true,
      namespaceMode: "success",
      disposalMode: "success",
    }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let reconstructed: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    const deletion = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: deletion.id,
      status: "reconciling",
      effect: "unknown",
    });
    const before = f.nativeCounts();
    reconstructed = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    expect(await reconstructed.engine.runNext()).toMatchObject({
      id: deletion.id,
      status: "reconciling",
      effect: "unknown",
    });
    // The new creator closes its own empty graph, not the original helper.
    await reconstructed.close();
    expect(f.nativeCounts()).toEqual(before);
    await f.composition.close();
    expect(f.nativeCounts()).toEqual(before);
    await assertNamespaceRetained(f);
    expect(raw.calls).toHaveLength(1);
  } finally {
    await reconstructed?.close();
    raw.join();
    raw.restore();
    await f.close();
  }
});

test("original allocation cleanup removes only the captured root once and keeps Core bound across a new genuine lease", async () => {
  const f = await fixture(false, {
    nativeMode: "start-retire",
    namespaceMode: "success",
    disposalMode: "success",
    allocationDisposal: true,
  });
  const actualRm = filesystem.rm.bind(filesystem);
  let restore = () => {};
  try {
    const sibling = join(f.artifactRoot, "unowned-sibling");
    await mkdir(sibling, { mode: 0o700 });
    await writeFile(join(sibling, "preserved"), "unowned");
    const deletion = await acceptNamespaceDelete(f),
      root = f.recordedCreate().allocationRoot;
    let removals = 0;
    const removing = spyOn(filesystem, "rm").mockImplementation((path, options) => {
      if (path === root) removals++;
      return actualRm(path, options);
    });
    restore = () => removing.mockRestore();
    expect(Object.is(rm, removing)).toBe(true);
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toEqual([]);
    expect(f.allocations).toEqual([
      { kind: "linux-oci-original-allocation-disposal@1", barrier: "unproven" },
    ]);
    expect(removals).toBe(1);
    await expect(filesystem.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(sibling, "preserved"), "utf8")).toBe("unowned");
    const native = f.nativeCounts();
    await f.sql.run(
      "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
      [deletion.id],
    );
    expect((await f.engine.runNext())?.effect).not.toBe("complete");
    expect(f.failures).toEqual([]);
    expect(f.allocations).toHaveLength(2);
    expect(removals).toBe(1);
    expect(f.nativeCounts()).toEqual(native);
    await assertNamespaceRetained(f);
  } finally {
    restore();
    await f.close();
  }
});

for (const tamper of ["root", "rootfs", "receipt"] as const) {
  test(`original allocation cleanup rejects captured ${tamper} tampering before removal and preserves its original sibling`, async () => {
    const f = await fixture(false, {
      nativeMode: "start-retire",
      namespaceMode: "success",
      disposalMode: "success",
      allocationDisposal: true,
    });
    const actualRm = filesystem.rm.bind(filesystem);
    let restore = () => {};
    try {
      const deletion = await acceptNamespaceDelete(f),
        root = f.recordedCreate().allocationRoot;
      let altered = false,
        removals = 0;
      f.beforeAllocation(async () => {
        if (altered) return;
        altered = true;
        if (tamper === "receipt")
          await writeFile(join(root, ".tako-oci-artifact.json"), "tampered");
        else {
          const path = tamper === "root" ? root : join(root, "rootfs");
          await filesystem.rename(path, `${path}.original`);
          await mkdir(path, { mode: 0o700 });
          await writeFile(join(path, "unowned"), "preserved");
        }
      });
      const removing = spyOn(filesystem, "rm").mockImplementation((path, options) => {
        if (path === root) removals++;
        return actualRm(path, options);
      });
      restore = () => removing.mockRestore();
      await f.engine.runNext();
      expect(f.failures).toHaveLength(1);
      expect(f.allocations).toEqual([]);
      expect(removals).toBe(0);
      await f.sql.run(
        "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
        [deletion.id],
      );
      await f.engine.runNext();
      expect(f.failures).toHaveLength(2);
      expect(removals).toBe(0);
      expect(f.allocations).toEqual([]);
      if (tamper !== "receipt") {
        const path = tamper === "root" ? root : join(root, "rootfs");
        expect(await readFile(join(path, "unowned"), "utf8")).toBe("preserved");
        expect((await filesystem.lstat(`${path}.original`)).isDirectory()).toBe(true);
      }
      await assertNamespaceRetained(f);
    } finally {
      restore();
      await f.close();
    }
  });
}

test("original allocation cleanup refuses a real sameSql foreign owner and fake key before filesystem effects", async () => {
  const f = await fixture(false, {
    nativeMode: "start-retire",
    namespaceMode: "success",
    disposalMode: "success",
    allocationDisposal: true,
  });
  const foreign = createDockerContainerCoreOwner({
    sql: f.sql,
    clock: () => new Date(),
    installationId: "synthetic-oci-installation",
    backendId: "synthetic-oci-backend",
    targetKey: "synthetic-oci-target",
    configuredInputs: f.configuredInputs,
  });
  let visited = false;
  f.beforeAllocation(async (execution) => {
    const before = f.nativeCounts(),
      root = f.recordedCreate().allocationRoot;
    await foreign.withExecution(execution, async () => {
      const accepted = await foreign.readAcceptedExecution(execution),
        old = accepted.retained[0];
      if (!old) throw new Error("original retained record absent");
      await foreign.owner.withAuthority(old.record, "remove", async () => {
        await expect(
          foreign.disposeRetainedAllocation(
            execution,
            old.record,
            Object.freeze({}),
            new AbortController().signal,
          ),
        ).rejects.toThrow();
      });
    });
    expect((await filesystem.lstat(root)).isDirectory()).toBe(true);
    expect(f.nativeCounts()).toEqual(before);
    visited = true;
  });
  try {
    await acceptNamespaceDelete(f);
    await f.engine.runNext();
    expect(visited).toBe(true);
    expect(f.failures).toEqual([]);
    expect(f.allocations).toHaveLength(1);
    await assertNamespaceRetained(f);
  } finally {
    await f.close();
  }
});

for (const partial of ["partial", "absent-after-error"] as const) {
  test(`original allocation cleanup ${partial} remains sticky unknown without replay or absence-only success`, async () => {
    const f = await fixture(false, {
      nativeMode: "start-retire",
      namespaceMode: "success",
      disposalMode: "success",
      allocationDisposal: true,
    });
    const actualRm = filesystem.rm.bind(filesystem);
    let restore = () => {};
    try {
      const deletion = await acceptNamespaceDelete(f),
        root = f.recordedCreate().allocationRoot;
      let removals = 0;
      const removing = spyOn(filesystem, "rm").mockImplementation(async (path, options) => {
        if (path !== root) return actualRm(path, options);
        removals++;
        if (partial === "partial") await actualRm(join(root, "rootfs", "synthetic-file"));
        else await actualRm(path, options);
        throw new Error("modeled original partial removal failure");
      });
      restore = () => removing.mockRestore();
      await f.engine.runNext();
      expect(removals).toBe(1);
      expect(f.failures).toHaveLength(1);
      expect(f.allocations).toEqual([]);
      if (partial === "partial") expect((await filesystem.lstat(root)).isDirectory()).toBe(true);
      else await expect(filesystem.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      const native = f.nativeCounts();
      await f.sql.run(
        "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
        [deletion.id],
      );
      await f.engine.runNext();
      expect(f.failures).toHaveLength(2);
      expect(f.allocations).toEqual([]);
      expect(removals).toBe(1);
      expect(f.nativeCounts()).toEqual(native);
      await assertNamespaceRetained(f);
    } finally {
      restore();
      await f.close();
    }
  });
}

test("original allocation cleanup cancellation after original rm stays unknown across a new genuine lease", async () => {
  const f = await fixture(false, {
      nativeMode: "start-retire",
      namespaceMode: "success",
      disposalMode: "success",
      allocationDisposal: true,
    }),
    cancel = new AbortController();
  f.retireSignal(cancel.signal);
  const actualRm = filesystem.rm.bind(filesystem);
  let restore = () => {};
  try {
    const deletion = await acceptNamespaceDelete(f),
      root = f.recordedCreate().allocationRoot;
    let removals = 0;
    const removing = spyOn(filesystem, "rm").mockImplementation(async (path, options) => {
      if (path !== root) return actualRm(path, options);
      removals++;
      await actualRm(path, options);
      cancel.abort();
    });
    restore = () => removing.mockRestore();
    await f.engine.runNext();
    expect(f.allocations).toEqual([]);
    expect(removals).toBe(1);
    await expect(filesystem.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    f.retireSignal(new AbortController().signal);
    await f.sql.run(
      "UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=? AND status='reconciling'",
      [deletion.id],
    );
    await f.engine.runNext();
    expect(f.allocations).toEqual([]);
    expect(removals).toBe(1);
    await assertNamespaceRetained(f);
  } finally {
    restore();
    await f.close();
  }
});

test("original allocation cleanup normal DELETE rejects reconstructed custody before the original controller removes its root", async () => {
  const f = await fixture(false, {
      ...acceptedHttpSelection(),
      normalBackend: true,
      namespaceMode: "success",
      disposalMode: "begin-retained",
    }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let reconstructed: ReturnType<typeof f.reconstructNormal> | undefined;
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ effect: "complete", status: "succeeded" });
    const root = f.recordedCreate().allocationRoot;
    const deletion = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    await f.engine.runNext();
    expect((await filesystem.lstat(root)).isDirectory()).toBe(true);
    const before = f.nativeCounts();
    reconstructed = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    expect(await reconstructed.engine.runNext()).toMatchObject({
      id: deletion.id,
      effect: "unknown",
      status: "reconciling",
    });
    expect(f.nativeCounts()).toEqual(before);
    expect((await filesystem.lstat(root)).isDirectory()).toBe(true);
    f.advanceNormalClock(61_000);
    expect(await f.engine.runNext()).toMatchObject({
      id: deletion.id,
      effect: "unknown",
      status: "reconciling",
    });
    await expect(filesystem.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await assertNamespaceRetained(f);
  } finally {
    await reconstructed?.close();
    raw.join();
    raw.restore();
    await f.close();
  }
});

for (const action of ["cancel", "late-byte"] as const) {
  test(`original allocation last SQL fence ${action} refuses destructive removal after private preflight`, async () => {
    const f = await fixture(false, {
        nativeMode: "start-retire",
        namespaceMode: "success",
        disposalMode: "success",
        allocationDisposal: true,
      }),
      cancel = new AbortController();
    f.retireSignal(cancel.signal);
    let ready = false,
      held = false,
      entered = () => {},
      release = () => {};
    const reached = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const actualRead = filesystem.readFile.bind(filesystem),
      actualRm = filesystem.rm.bind(filesystem),
      actualQuery = f.sql.query.bind(f.sql);
    let restore = () => {};
    try {
      await acceptNamespaceDelete(f);
      const root = f.recordedCreate().allocationRoot;
      let removals = 0;
      const reading = spyOn(filesystem, "readFile").mockImplementation(
        new Proxy(actualRead, {
          apply(target, thisArg, args) {
            return Reflect.apply(target, thisArg, args).then((value: unknown) => {
              if (args[0] === join(root, ".tako-oci-artifact.json")) ready = true;
              return value;
            });
          },
        }),
      );
      const removing = spyOn(filesystem, "rm").mockImplementation((path, options) => {
        if (path === root) removals++;
        return actualRm(path, options);
      });
      const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
        const rows = await actualQuery(statement, params);
        if (ready && !held && statement.includes(" FROM tf_v2_container_instances i JOIN ")) {
          held = true;
          entered();
          await gate;
        }
        return rows;
      });
      restore = () => {
        reading.mockRestore();
        removing.mockRestore();
        query.mockRestore();
      };
      const pending = f.engine.runNext();
      await Promise.race([
        reached,
        pending.then(() => {
          throw new Error("last Core current Sql fence absent");
        }),
      ]);
      if (action === "cancel") cancel.abort();
      else f.nativeTrailingByte();
      release();
      expect((await pending)?.effect).not.toBe("complete");
      expect(held).toBe(true);
      expect(removals).toBe(0);
      expect(f.allocations).toEqual([]);
      expect((await filesystem.lstat(root)).isDirectory()).toBe(true);
      await assertNamespaceRetained(f);
    } finally {
      release();
      restore();
      if (action === "late-byte") await expect(f.close()).rejects.toThrow("custody_retained");
      else await f.close();
    }
  });
}

test("original allocation last SQL fence loses the real Engine lease without deleting or replaying original custody", async () => {
  const f = await fixture(false, {
      ...acceptedHttpSelection(),
      normalBackend: true,
      namespaceMode: "success",
      disposalMode: "success",
    }),
    raw = acceptedRawHttp();
  raw.onEnd(() => {
    raw.reply();
    raw.join();
  });
  let reconstructed: ReturnType<typeof f.reconstructNormal> | undefined;
  let ready = false,
    held = false,
    entered = () => {},
    release = () => {};
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const actualRead = filesystem.readFile.bind(filesystem),
    actualRm = filesystem.rm.bind(filesystem),
    actualQuery = f.sql.query.bind(f.sql);
  let restore = () => {};
  try {
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    const root = f.recordedCreate().allocationRoot;
    const deletion = await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    let removals = 0;
    const reading = spyOn(filesystem, "readFile").mockImplementation(
      new Proxy(actualRead, {
        apply(target, thisArg, args) {
          return Reflect.apply(target, thisArg, args).then((value: unknown) => {
            if (args[0] === join(root, ".tako-oci-artifact.json")) ready = true;
            return value;
          });
        },
      }),
    );
    const removing = spyOn(filesystem, "rm").mockImplementation((path, options) => {
      if (path === root) removals++;
      return actualRm(path, options);
    });
    const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
      const rows = await actualQuery(statement, params);
      if (ready && !held && statement.includes(" FROM tf_v2_container_instances i JOIN ")) {
        held = true;
        entered();
        await gate;
      }
      return rows;
    });
    restore = () => {
      reading.mockRestore();
      removing.mockRestore();
      query.mockRestore();
    };
    const pending = f.engine.runNext();
    await Promise.race([
      reached,
      pending.then(() => {
        throw new Error("original allocation Sql fence absent");
      }),
    ]);
    const native = f.nativeCounts();
    reconstructed = f.reconstructNormal();
    f.advanceNormalClock(61_000);
    expect(await reconstructed.engine.runNext()).toMatchObject({
      id: deletion.id,
      effect: "unknown",
      status: "reconciling",
    });
    release();
    expect((await pending)?.effect).not.toBe("complete");
    expect(removals).toBe(0);
    expect(f.nativeCounts()).toEqual(native);
    expect((await filesystem.lstat(root)).isDirectory()).toBe(true);
    await assertNamespaceRetained(f);
  } finally {
    release();
    restore();
    await reconstructed?.close();
    raw.join();
    raw.restore();
    await f.close();
  }
});

// Reuse the genuine engine/Sql/artifact/raw-stream fixture without calling its old cases.
export { acceptedHttpSelection, acceptedRawHttp, fixture as originalOwnedOciFixture };
