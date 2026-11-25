import { Database } from "bun:sqlite";
import { expect, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { v2ContainerOwnerMigrationCandidate } from "../../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT, V2_CONTAINER_F2_FORM } from "../../src/container-contract.ts";
import { isJsonObject, type JsonObject } from "../../src/json.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import {
  validateDockerContainerPrivateInputs,
  validateDockerContainerSpec,
} from "../../src/providers/docker-container-configured-inputs.ts";
import type { DockerImageSupplyLimits } from "../../src/providers/docker-container-image-supplier.ts";
import type { LinuxOciEgressLimits } from "../../src/providers/linux-oci-egress-policy.ts";
import type { LinuxOciHostTopology } from "../../src/providers/linux-oci-host-topology.ts";
import {
  createLinuxOciOwnedBundle,
  type LinuxOciBorrowedBundle,
  type LinuxOciOwnedBundleOptions,
} from "../../src/providers/linux-oci-owned-bundle.ts";
import type { LinuxOciCreateStoppedRequest } from "../../src/providers/linux-oci-physical-session.ts";
import { createSelfhostLinuxOciContainerBackend } from "../../src/selfhost-linux-oci-container-backend.ts";
import { createSelfhostLinuxOciCore } from "../../src/selfhost-linux-oci-core.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../../src/takoform-v2/configured-update-inputs-schema.ts";
import {
  V2_CONTAINER_OWNER_ALLOCATION_EXPAND,
  V2_CONTAINER_OWNER_CONTROL_EXPAND,
} from "../../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Execution } from "../../src/takoform-v2/types.ts";

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

async function fixture(
  corrupt = false,
  adversarial: {
    readonly parentControl?: boolean;
    readonly parentPeer?: boolean;
    readonly parentPeerRuntime?: boolean;
    readonly qualifiedProducer?: boolean;
    readonly producerRevision?: "missing" | "wrong";
    readonly producerDigest?: "missing" | "wrong";
    readonly nativeStopWriteObserver?: {
      readonly producerDigest?: string;
      readonly record: NonNullable<LinuxOciOwnedBundleOptions["nativeStopWriteObserver"]>["record"];
    };
    readonly parentPeerLocal?: boolean;
    readonly parentPeerApplicationOwner?: boolean;
    readonly parentPeerRuntimeApplicationOwner?: boolean;
    readonly peerPending?: boolean;
    readonly peerManagementFault?: "incomplete" | "missing-reply" | "lost-reply";
    readonly peerJoinFault?: "foreign" | "refused" | "unknown" | "pidns";
    readonly peerNamespaceFault?:
      | "retained"
      | "lost"
      | "unreleased"
      | "foreign"
      | "malformed"
      | "unknown"
      | "cookie"
      | "regress";
    readonly peerRetirementFault?:
      | "begin-retained"
      | "read-pending"
      | "read-inconsistent"
      | "delete-retained"
      | "dispose-retained"
      | "begin-lost"
      | "delete-lost"
      | "dispose-lost"
      | "missing"
      | "wrong-phase";
    readonly peerHResultFault?: "stdout" | "stderr" | "nonzero" | "signal" | "unknown";
    readonly peerAllocationSchema?: boolean;
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
    readonly alternateHostTopology?: LinuxOciHostTopology;
    readonly outboundInternet?: boolean;
    readonly viaHostCreator?: boolean;
    readonly normalBackend?: boolean;
    readonly imageIndex?: boolean;
    readonly configuredKey?: "sql" | "selection" | "owner";
  } = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), "linux-oci-owned-bundle-"));
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
  if (adversarial.peerAllocationSchema)
    await sql.batch(V2_CONTAINER_OWNER_ALLOCATION_EXPAND.statements.map((sql) => ({ sql })));
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
  const index = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: digest(manifest),
          size: manifest.length,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    }),
  );
  const sourceDigest = digest(adversarial.imageIndex ? index : manifest);
  const source = new Map([
    [digest(manifest), manifest],
    [digest(alternativeManifest), alternativeManifest],
    [digest(config), config],
    [digest(index), index],
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
    const qualifiedPhysicalDigest =
      adversarial.qualifiedProducer && adversarial.producerDigest !== "missing"
        ? adversarial.producerDigest === "wrong"
          ? `sha256:${"0".repeat(64)}`
          : digest(await readFile(physicalBinary))
        : undefined;
    const observer = adversarial.nativeStopWriteObserver;
    const producerDigest = observer?.producerDigest ?? qualifiedPhysicalDigest;
    if (observer && !producerDigest) throw Error("NONSECRET observer digest absent");
    composition = compose({
      sql,
      clock: adversarial.normalBackend ? normalClock : () => new Date(),
      installationId: "synthetic-oci-installation",
      backendId: "synthetic-oci-backend",
      targetKey: "synthetic-oci-target",
      configuredInputs,
      ...(adversarial.parentPeer
        ? {
            ociParentControl: adversarial.parentPeerRuntimeApplicationOwner
              ? ("sealed-peer-runtime-application-owner@1" as const)
              : adversarial.parentPeerApplicationOwner
                ? ("sealed-peer-application-owner@1" as const)
                : adversarial.parentPeerLocal
                  ? ("sealed-peer-local-cleanup@1" as const)
                  : adversarial.parentPeerRuntime
                    ? ("sealed-peer-runtime@1" as const)
                    : ("sealed-peer@1" as const),
          }
        : adversarial.parentControl
          ? { ociParentControl: "sealed-original@1" as const }
          : {}),
      artifactRoot,
      umociBinary: unpacker,
      ...(adversarial.nativeMode !== undefined && !adversarial.noPhysicalBinary
        ? { physicalBinary }
        : {}),
      ...(qualifiedPhysicalDigest === undefined ? {} : { qualifiedPhysicalDigest }),
      ...(observer && producerDigest
        ? { nativeStopWriteObserver: { producerDigest, record: observer.record } }
        : {}),
      memoryBytes: 268435456,
      nanoCpus: 500000000,
      pidsLimit: 128,
      ...(adversarial.egressLimits === undefined ? {} : { egressLimits: adversarial.egressLimits }),
      ...(adversarial.hostTopology === undefined ? {} : { hostTopology: adversarial.hostTopology }),
      ...(adversarial.alternateHostTopology === undefined
        ? {}
        : { alternateHostTopology: adversarial.alternateHostTopology }),
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
  let heldPeerCommand: "linux-oci-stop-init@1" | "linux-oci-join-init@1" | undefined;
  let heldPeerReply: (() => void) | undefined;
  const unpackEnvironments: unknown[] = [];
  let unpackerStarted = () => {};
  const unpackerEntered = new Promise<void>((resolve) => {
    unpackerStarted = resolve;
  });
  type RawPeer = {
    originalPeerBootstrap?: Buffer;
    originalCreate?: JsonObject;
    peerReply: unknown;
    peerKind: number;
    peerEffects: number;
    peerBytes: number;
    peerHJoined: boolean;
    peerHStdoutEof: boolean;
    peerHStderrEof: boolean;
    inode: bigint;
  };
  const newPeer = (inode: bigint): RawPeer => ({
    peerReply: undefined,
    peerKind: 0,
    peerEffects: 0,
    peerBytes: 0,
    peerHJoined: false,
    peerHStdoutEof: false,
    peerHStderrEof: false,
    inode,
  });
  const legacyPeer = newPeer(0x123456789abcdef0n);
  const originalPeers = new Map<string, RawPeer>();
  let applicationOwnerExited = false;
  let applicationOwnerFault: "foreign" | "boot" | "lost" | "exit" | undefined;
  const peerProfile = adversarial.parentPeerRuntimeApplicationOwner
    ? { revision: 6, helper: "--persistent-parent-peer-runtime-application-owner" }
    : adversarial.parentPeerApplicationOwner
      ? { revision: 5, helper: "--persistent-parent-peer-application-owner" }
      : adversarial.parentPeerLocal
        ? { revision: 4, helper: "--persistent-parent-peer-local-cleanup" }
        : adversarial.parentPeerRuntime
          ? { revision: 3, helper: "--persistent-parent-peer-runtime" }
          : { revision: 2, helper: "--persistent-parent-peer" };
  const raw = spyOn(childProcess, "spawn").mockImplementation(((
    file: string,
    args: readonly string[],
    options: childProcess.SpawnOptions,
  ) => {
    if (file === physicalBinary) {
      const observingStop =
        adversarial.nativeStopWriteObserver !== undefined &&
        args[0] === "--parent-peer-manage-init-observe-stop";
      const managing =
        adversarial.parentPeer && (args[0] === "--parent-peer-manage-init" || observingStop);
      const applicationReader =
        peerProfile.revision >= 5 && args[0] === "--parent-peer-read-application-owner";
      const connector =
        adversarial.parentPeer &&
        (args[0] === "--parent-peer-read-result" || managing || applicationReader);
      expect(args).toEqual(
        connector
          ? [
              observingStop
                ? "--parent-peer-manage-init-observe-stop"
                : managing
                  ? "--parent-peer-manage-init"
                  : applicationReader
                    ? "--parent-peer-read-application-owner"
                    : "--parent-peer-read-result",
            ]
          : adversarial.parentPeer
            ? [peerProfile.helper]
            : adversarial.parentControl
              ? ["--persistent-parent"]
              : [],
      );
      let peer =
        adversarial.alternateHostTopology === undefined || connector
          ? legacyPeer
          : newPeer(0x123456789abcdef0n + BigInt(originalPeers.size));
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
        if (adversarial.parentPeer && !connector) peer.peerReply = value;
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
              const family = [
                "begin-tracked-join",
                "read-tracked-join",
                "delete-born",
                "join-born-delete",
                "dispose-born",
                "continue-born-disposal",
              ];
              const familyIndex = family.findIndex((op) => command.kind === `linux-oci-${op}@1`);
              if (command.kind === "linux-oci-parent-read-result@1") {
                if (Object.keys(command).length !== 1) throw Error("nonfixed H result read");
                nativeRequests.push(command.kind);
                const fault = adversarial.peerHResultFault;
                const known =
                  peer.peerHJoined && peer.peerHStdoutEof && peer.peerHStderrEof && !fault;
                reply({
                  kind: known
                    ? "linux-oci-parent-h-exited@1"
                    : "linux-oci-parent-h-result-refused@1",
                  error: known ? 0 : 11,
                  barrier: "unproven",
                });
                done();
                queueMicrotask(() => {
                  stdout.end();
                  stderr.end();
                  child.emit("exit", 0, null);
                  child.emit("close", 0, null);
                });
                return;
              }
              if (familyIndex !== -1) {
                if (Object.keys(command).length !== 1 || !(peer.peerEffects & (1 << 8)))
                  throw Error("nonfixed/early retirement command");
                const kind = familyIndex + 11,
                  op = family[familyIndex]!;
                if ([11, 13, 15].includes(kind) && peer.peerEffects & (1 << kind))
                  throw Error("retirement effect replay");
                if (
                  (kind === 12 && !(peer.peerEffects & (1 << 11))) ||
                  (kind === 14 && !(peer.peerEffects & (1 << 13))) ||
                  (kind === 16 && !(peer.peerEffects & (1 << 15)))
                )
                  throw Error("retirement observation before original effect");
                if (
                  (adversarial.parentPeerLocal || adversarial.parentPeerApplicationOwner) &&
                  kind === 15
                ) {
                  expect(peer.peerKind).toBe(11);
                  expect(peer.peerReply).toMatchObject({
                    kind: "linux-oci-tracked-join-handoff@1",
                  });
                  expect(nativeRequests.includes("linux-oci-read-tracked-join@1")).toBe(false);
                }
                const fault = adversarial.peerRetirementFault;
                const firstRead = kind === 12 && peer.peerKind !== 12;
                const readErrno = firstRead
                  ? fault === "read-pending"
                    ? 11
                    : fault === "read-inconsistent"
                      ? 117
                      : undefined
                  : undefined;
                nativeRequests.push(command.kind);
                peer.peerKind = kind;
                peer.peerBytes = frame.length;
                if ([11, 13, 15].includes(kind)) peer.peerEffects |= 1 << kind;
                const kinds = [
                  "linux-oci-tracked-join-handoff@1",
                  "linux-oci-tracked-owner-destruction@1",
                  "linux-oci-born-delete-observation@1",
                  "linux-oci-born-delete-join-observation@1",
                  "linux-oci-local-disposal@1",
                  "linux-oci-local-disposal-continuation@1",
                ];
                const selected =
                  kind === 11 ? "begin" : kind === 13 ? "delete" : kind === 15 ? "dispose" : "none";
                const retained = fault === `${selected}-retained` || readErrno !== undefined,
                  lost = fault === `${selected}-lost` || (fault === "missing" && kind === 11);
                peer.peerReply = retained
                  ? {
                      kind: "linux-oci-refused@1",
                      stage: op,
                      errno: readErrno ?? 11,
                      custody: "retained",
                      barrier: "unproven",
                    }
                  : { kind: kinds[familyIndex], barrier: "unproven" };
                if (fault === "wrong-phase" && kind === 11)
                  peer.peerReply = { kind: kinds[2], barrier: "unproven" };
                if (fault === "missing" && kind === 11) peer.peerReply = undefined;
                if (!retained && (kind === 15 || kind === 16)) {
                  // Raw P/H boundary facts are independent from connector exit.
                  const h = adversarial.peerHResultFault;
                  peer.peerHJoined = h !== "unknown";
                  peer.peerHStdoutEof = h !== "stdout";
                  peer.peerHStderrEof = h !== "stderr";
                }
                if (!lost) reply(peer.peerReply);
                done();
                queueMicrotask(() => {
                  stdout.end();
                  stderr.end();
                  child.emit("exit", lost ? 77 : 0, null);
                  child.emit("close", lost ? 77 : 0, null);
                });
                return;
              }
              if (
                [
                  "linux-oci-release-namespace@1",
                  "linux-oci-continue-namespace-release@1",
                ].includes(command.kind)
              ) {
                if (Object.keys(command).length !== 1 || !(peer.peerEffects & (1 << 6)))
                  throw Error("namespace before original STOP/JOIN");
                const release = command.kind === "linux-oci-release-namespace@1";
                if (release ? peer.peerEffects & (1 << 8) : !(peer.peerEffects & (1 << 8)))
                  throw Error("namespace effect replay or missing RELEASE");
                nativeRequests.push(command.kind);
                peer.peerKind = release ? 8 : 9;
                peer.peerEffects |= 1 << 8;
                peer.peerBytes = frame.length;
                if (!peer.originalCreate || typeof peer.originalCreate.claimId !== "string")
                  throw Error("original peer native absent");
                const fault = adversarial.peerNamespaceFault;
                peer.peerReply = {
                  kind: release
                    ? "linux-oci-namespace-release-observation@1"
                    : "linux-oci-namespace-release-continuation@1",
                  nativeId: fault === "foreign" ? "f".repeat(64) : peer.originalCreate.claimId,
                  namespaceDevice: 4,
                  namespaceInode: 55,
                  netCookie: !release && fault === "cookie" ? "2" : "18446744073709551615",
                  fullIpSockets: "2",
                  requests: fault === "malformed" ? 0 : "0",
                  timewait: "1",
                  packetGroups: "3",
                  born: 1,
                  releaseAttempted: 1,
                  referenceReleased:
                    (release && fault === "unreleased") || (!release && fault === "regress")
                      ? 0
                      : 1,
                  netGone: 0,
                  poisoned: 0,
                  barrier: "unproven",
                };
                if (release && fault === "retained")
                  peer.peerReply = {
                    kind: "linux-oci-refused@1",
                    stage: "release-namespace",
                    errno: 11,
                    custody: "retained",
                    barrier: "unproven",
                  };
                const lost = release && (fault === "lost" || fault === "unknown");
                if (release && fault === "unknown") peer.peerReply = undefined;
                if (!lost) reply(peer.peerReply);
                done();
                queueMicrotask(() => {
                  stdout.end();
                  stderr.end();
                  child.emit("exit", lost ? 77 : 0, null);
                  child.emit("close", lost ? 77 : 0, null);
                });
                return;
              }
              if (
                Object.keys(command).length !== 1 ||
                !["linux-oci-stop-init@1", "linux-oci-join-init@1"].includes(command.kind)
              )
                throw Error("nonfixed management command");
              const stop = command.kind === "linux-oci-stop-init@1";
              if (stop && peer.peerEffects & (1 << 6)) throw Error("replayed original STOP");
              if (!stop && !(peer.peerEffects & (1 << 6))) throw Error("JOIN before original STOP");
              nativeRequests.push(command.kind);
              peer.peerKind = stop ? 6 : 7;
              peer.peerEffects |= stop ? 1 << 6 : 0;
              peer.peerBytes = frame.length;
              if (!peer.originalCreate || typeof peer.originalCreate.claimId !== "string")
                throw Error("original peer native absent");
              peer.peerReply = {
                kind: stop ? "linux-oci-init-reaped@1" : "linux-oci-init-reaped-observation@1",
                nativeId:
                  !stop && adversarial.peerJoinFault === "foreign"
                    ? "f".repeat(64)
                    : peer.originalCreate.claimId,
                namespaceDevice: 4,
                namespaceInode: 55,
                pidNamespaceDevice: 6,
                pidNamespaceInode: !stop && adversarial.peerJoinFault === "pidns" ? 78 : 77,
                barrier: "unproven",
              };
              if (!stop && adversarial.peerJoinFault === "refused")
                peer.peerReply = {
                  kind: "linux-oci-refused@1",
                  stage: "join-init",
                  errno: 11,
                  custody: "retained",
                  barrier: "unproven",
                };
              const lost =
                (stop && adversarial.peerManagementFault === "lost-reply") ||
                (!stop && adversarial.peerJoinFault === "unknown");
              const sendInitReply = (value: unknown) => {
                reply(value);
                if (stop && observingStop)
                  reply({
                    kind: "linux-oci-parent-stop-write@1",
                    preMonotonicNs: "23",
                    postMonotonicNs: "29",
                    barrier: "unproven",
                  });
              };
              if (heldPeerCommand === command.kind) {
                heldPeerCommand = undefined;
                const originalReply = peer.peerReply;
                heldPeerReply = () => {
                  if (!lost) sendInitReply(originalReply);
                  queueMicrotask(() => {
                    stdout.end();
                    stderr.end();
                    child.emit("exit", lost ? 77 : 0, null);
                    child.emit("close", lost ? 77 : 0, null);
                  });
                };
                done();
                return;
              }
              if (!lost) sendInitReply(peer.peerReply);
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
                managing
                  ? "linux-oci-parent-read-outcome@2"
                  : applicationReader
                    ? "linux-oci-parent-read-application-owner@1"
                    : "linux-oci-parent-read-result@2",
              );
              if (adversarial.alternateHostTopology !== undefined) {
                const captured = originalPeers.get(frame.subarray(12, 76).toString("ascii"));
                if (!captured) throw Error("NONSECRET original P capture absent");
                peer = captured;
              }
              const original = peer.originalPeerBootstrap;
              const valid =
                original &&
                frame.length === 176 &&
                frame.subarray(4, 12).equals(Buffer.from("TKOPEER2")) &&
                frame.subarray(12, 84).equals(original.subarray(12, 84)) &&
                frame.subarray(92, 124).equals(original.subarray(84, 116)) &&
                frame.readBigUInt64BE(84) === 0xfedcba9876543210n &&
                frame.readBigUInt64BE(124) === 5n &&
                frame.readBigUInt64BE(132) === peer.inode &&
                frame.subarray(140).equals(Buffer.from("11111111-2222-4333-8444-555555555555"));
              if (valid && managing) {
                const body =
                    peer.peerReply === undefined
                      ? undefined
                      : Buffer.from(JSON.stringify(peer.peerReply)),
                  captured = body ? Buffer.alloc(body.length + 4) : Buffer.alloc(0);
                if (body) {
                  captured.writeUInt32BE(body.length);
                  body.copy(captured, 4);
                }
                const missing = adversarial.peerManagementFault === "missing-reply";
                reply({
                  kind: "linux-oci-parent-outcome@1",
                  requestKind: peer.peerKind,
                  effects: peer.peerEffects,
                  requestBytes: String(peer.peerBytes),
                  issuedBytes: String(
                    adversarial.peerManagementFault === "incomplete" ? 0 : peer.peerBytes,
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
              if (valid && applicationReader) {
                if (applicationOwnerFault !== "lost")
                  reply(
                    applicationOwnerExited
                      ? {
                          kind: "linux-oci-parent-application-owner-exited@1",
                          device: "5",
                          inode: applicationOwnerFault === "foreign" ? "99" : "1311768467463790321",
                          bootId:
                            applicationOwnerFault === "boot"
                              ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
                              : "11111111-2222-4333-8444-555555555555",
                          barrier: "unproven",
                        }
                      : {
                          kind: "linux-oci-parent-application-owner-refused@1",
                          barrier: "unproven",
                        },
                  );
              } else if (valid)
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
                child.emit("exit", valid && applicationOwnerFault !== "exit" ? 0 : 1, null);
                child.emit("close", valid && applicationOwnerFault !== "exit" ? 0 : 1, null);
              });
              return;
            }
            if (adversarial.parentPeer && frame.readUInt32BE(0) === 112) {
              expect(frame.subarray(4, 12).toString("ascii")).toBe(
                `TKOBIND${peerProfile.revision}`,
              );
              peer.originalPeerBootstrap = Buffer.from(frame);
              if (adversarial.alternateHostTopology !== undefined) {
                const claim = frame.subarray(12, 76).toString("ascii");
                if (originalPeers.has(claim)) throw Error("NONSECRET original P replacement");
                originalPeers.set(claim, peer);
              }
              nativeRequests.push(`linux-oci-parent-bootstrap@${peerProfile.revision}`);
              const producer =
                (peerProfile.revision === 6 ||
                  (peerProfile.revision === 3 && adversarial.qualifiedProducer)) &&
                adversarial.producerRevision !== "missing";
              const response = Buffer.alloc(
                144 + (peerProfile.revision >= 5 ? 16 : 0) + (producer ? 8 : 0),
              );
              response.writeUInt32BE(response.length - 4);
              response.write(`TKOINFO${peerProfile.revision}`, 4, "ascii");
              frame.copy(response, 12, 12, 84);
              response.writeBigUInt64BE(0xfedcba9876543210n, 84);
              response.writeBigUInt64BE(5n, 92);
              response.writeBigUInt64BE(peer.inode, 100);
              response.write("11111111-2222-4333-8444-555555555555", 108, "ascii");
              if (peerProfile.revision >= 5) {
                response.writeBigUInt64BE(5n, 144);
                response.writeBigUInt64BE(0x123456789abcdef1n, 152);
              }
              if (producer)
                response.write(
                  adversarial.producerRevision === "wrong" ? "NCLOSE00" : "NCLOSE01",
                  peerProfile.revision === 6 ? 160 : 144,
                  "ascii",
                );
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
              peer.peerKind = kinds[request.kind] ?? 0;
              peer.peerBytes = frame.length;
              if (peer.peerKind === 1 || peer.peerKind === 4)
                peer.peerEffects |= 1 << peer.peerKind;
            }
            if (request.kind === "linux-oci-create-stopped@1") {
              if (adversarial.peerAllocationSchema) {
                if (typeof request.claimId !== "string")
                  throw new Error("raw original allocation absent");
                const saved = (
                  await sql.query(
                    "SELECT allocation_cleanup,native_control FROM tf_v2_container_create_claims WHERE claim_id=?",
                    [request.claimId],
                  )
                )[0];
                expect(saved?.allocation_cleanup).toBe("untouched");
                expect(typeof saved?.native_control).toBe("string");
                expect(JSON.parse(String(saved?.native_control)).kind).toBe(
                  "linux-oci-sealed-control@1",
                );
              }
              if (nativeProcesses === 1) originalCreate = request;
              peer.originalCreate = request;
              created = true;
              if (typeof request.claimId !== "string" || typeof request.allocationRoot !== "string")
                throw new Error("raw original allocation absent");
              const receipt: unknown = JSON.parse(
                await readFile(join(request.allocationRoot, ".tako-oci-artifact.json"), "utf8"),
              );
              if (!isJsonObject(receipt)) throw new Error("raw artifact receipt absent");
              expect(receipt.claimId).toBe(request.claimId);
              expect(request.sourceDigest).toBe(receipt.sourceDigest);
              if (adversarial.alternateHostTopology === undefined)
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
        expect(bundle.receipt.sourceDigest).toBe(sourceDigest);
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
      return {
        engine: normalEngine(original),
        fetchServingHttp: original.fetchServingHttp,
        close: original.close,
      };
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
    applicationOwnerState(exited: boolean, fault?: typeof applicationOwnerFault) {
      applicationOwnerExited = exited;
      applicationOwnerFault = fault;
    },
    nativeCounts: () => ({ processes: nativeProcesses, requests: [...nativeRequests] }),
    holdPeerManagementReply(kind: "linux-oci-stop-init@1" | "linux-oci-join-init@1") {
      if (heldPeerCommand || heldPeerReply) throw Error("NONSECRET raw reply already held");
      heldPeerCommand = kind;
    },
    releasePeerManagementReply() {
      const original = heldPeerReply;
      heldPeerReply = undefined;
      original?.();
    },
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
    sourceDigest,
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
            [fields.image]: `registry.example/app@${sourceDigest}`,
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

export {
  acceptedHttpSelection,
  acceptedRawHttp,
  disposalWire,
  fixture as originalOwnedOciFixture,
  syntheticTopology,
};
