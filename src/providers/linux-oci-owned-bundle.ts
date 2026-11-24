import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants, lstatSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { CONTAINER_CONTRACT, V2_CONTAINER_F2_FORM } from "../container-contract.ts";
import { canonicalDigest, canonicalJson, isJsonObject, type JsonObject } from "../json.ts";
import { parseStrictJson } from "../strict-json.ts";
import { inspectV2ContainerOwnerShutdownIoSchema } from "../takoform-v2/container-owner-schema.ts";
import type { V2BackendResult, V2Execution, V2Form } from "../takoform-v2/types.ts";
import {
  createDockerContainerConfiguredInputs,
  validateDockerContainerPrivateInputs,
  validateDockerContainerSpec,
} from "./docker-container-configured-inputs.ts";
import {
  createDockerContainerCoreOwner,
  type DockerContainerAcceptedExecution,
  type DockerContainerCoreOwner,
  type DockerContainerCoreOwnerOptions,
  type LinuxOciAllocationDisposalObservation,
  type LinuxOciDisposalProgress,
} from "./docker-container-core-owner.ts";
import type {
  DockerContainerCreateIntent,
  DockerContainerCreateRecord,
} from "./docker-container-create-custody.ts";
import {
  type DockerImageSourcePort,
  type DockerImageSupplyLimits,
  type DockerRetainedImageArchive,
  withDockerRetainedImageArchive,
} from "./docker-container-image-supplier.ts";
import { createLinuxOciContainerHttpRuntime } from "./linux-oci-container-http-runtime.ts";
import {
  LINUX_OCI_EGRESS_POLICY_FILE,
  type LinuxOciEgressLimits,
  serializeLinuxOciEgressPolicy,
  snapshotLinuxOciEgressLimits,
} from "./linux-oci-egress-policy.ts";
import {
  LINUX_OCI_HOST_TOPOLOGY_FILE,
  type LinuxOciHostTopology,
  linuxOciGenerationTopology,
  serializeLinuxOciHostTopology,
  snapshotLinuxOciHostTopology,
  snapshotLinuxOciTopologyPair,
} from "./linux-oci-host-topology.ts";
import { createLinuxOciHttpHealthProbe } from "./linux-oci-http-health.ts";
import {
  createLinuxOciParentBootstrap,
  createLinuxOciPhysicalSession,
  detachOriginalLinuxOciRuntimePeer,
  type LinuxOciApplicationOwnerExit,
  type LinuxOciCreateStoppedRequest,
  type LinuxOciDisposedHelperObservation,
  type LinuxOciHeldTopologyFile,
  type LinuxOciInitReapedObservation,
  type LinuxOciNamespaceLifetimeObservation,
  type LinuxOciOriginalLiveInit,
  LinuxOciParentBootstrap,
  type LinuxOciParentHResult,
  type LinuxOciPeerInitProgress,
  LinuxOciPhysicalSession,
  type LinuxOciStartedObservation,
  type LinuxOciStoppedObservation,
  prepareAuthenticatedLinuxOciApplicationOwnerReader,
  prepareAuthenticatedLinuxOciHeldLiveInitReader,
  prepareAuthenticatedLinuxOciLiveInitReader,
  prepareAuthenticatedLinuxOciPeerInit,
  prepareAuthenticatedLinuxOciPeerReader,
} from "./linux-oci-physical-session.ts";
import {
  LINUX_OCI_SERVICE_POLICY_FILE,
  serializeLinuxOciServicePolicy,
} from "./linux-oci-service-policy.ts";

type OriginalPeerRead = {
  readonly custody: object;
  readonly settlement: Promise<unknown>;
  /** Actual management producer, absent for a one-use readonly reader. */
  readonly management?: ReturnType<typeof prepareAuthenticatedLinuxOciPeerInit>;
};
type OriginalOciHttpRoute = {
  readonly nativeId: string;
  readonly endpoint: string;
  assertLocal(): void;
};

type OriginalOciSuccessorHttp = {
  read(signal: AbortSignal): Promise<OriginalOciHttpRoute>;
  close(): Promise<void>;
};

type OriginalOciCustody = {
  readonly core: DockerContainerCoreOwner;
  readonly runtime3: boolean;
  readonly isClosed: () => boolean;
  readonly artifactRoot: string;
  readonly physicalBinary: string | undefined;
  readonly hostTopology: LinuxOciHostTopology | undefined;
  readonly alternateHostTopology: LinuxOciHostTopology | undefined;
  readonly httpRecords: ReadonlyMap<string, DockerContainerCreateRecord>;
  readonly httpRuntimes: ReadonlyMap<string, ReturnType<typeof createLinuxOciContainerHttpRuntime>>;
  readonly successorHttp: ReadonlyMap<DockerContainerCreateRecord, OriginalOciSuccessorHttp>;
  readonly heldLiveInits: Set<{ close(): Promise<void> }>;
  readonly peerReads: Map<string, OriginalPeerRead>;
  readonly sessions: ReadonlyMap<string, LinuxOciPhysicalSession>;
  readonly parents: ReadonlyMap<
    string,
    {
      readonly parent: LinuxOciParentBootstrap;
      readonly record: DockerContainerCreateRecord;
      readonly receipt: LinuxOciArtifactReceipt;
    }
  >;

  readonly bindings: ReadonlyMap<string, string>;
  readonly signal: AbortSignal;
  readonly initStops: Set<string>;
  readonly namespaceReleases: Set<string>;
  readonly disposedHelpers: WeakSet<LinuxOciPhysicalSession>;
  readonly helperJoins: Map<string, LinuxOciDisposedHelperObservation>;
  readonly allocations: ReadonlyMap<string, OriginalOciAllocation>;
  readonly disposalSteps: Map<
    string,
    "begin" | "read" | "delete" | "join-delete" | "dispose" | "continue-dispose" | "join-helper"
  >;
};
// Populated ONLY inside the real creator below. There is no registration API
// and its opaque keys are never returned to a caller or serialized.
const originalOciCustodies = new WeakMap<object, OriginalOciCustody>();
const sealedCloseResumeBrand: unique symbol = Symbol("sealed-close-resume");
const sealedCloseResumeTokens = new WeakMap<
  object,
  {
    readonly original: object;
    readonly core: DockerContainerCoreOwner;
    readonly record: DockerContainerCreateRecord;
    readonly signal: AbortSignal;
  }
>();
// Only the current original CREATE loan may retain its environment-bearing
// request. The persistent management record never owns this transient value.
const originalParentRequests = new WeakMap<object, LinuxOciCreateStoppedRequest>();

/** Internal source lookup only. Endpoint data cannot register an owner: every
 * read requires the original creator key, same Core, bound original record and
 * still-held original session. Core separately samples accepted serving SQL. */
function originalLinuxOciHttpEndpoint(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  httpPort: number,
  signal: AbortSignal,
) {
  const custody = originalOciCustodies.get(original);
  if (
    !custody ||
    custody.core !== core ||
    custody.signal.aborted ||
    signal.aborted ||
    !custody.hostTopology ||
    !custody.sessions.has(record.claimId) ||
    custody.bindings.get(record.claimId) !== record.nativeId ||
    custody.httpRecords.get(record.claimId) !== record ||
    !Number.isInteger(httpPort) ||
    httpPort < 1 ||
    httpPort > 65535
  )
    return fail("http_custody");
  const captured = custody.allocations.get(record.claimId)?.topology;
  if (!captured && custody.alternateHostTopology !== undefined) return fail("http_custody");
  return `http://${(captured ?? custody.hostTopology).peerIpv4Guest}:${httpPort}/`;
}
/** The same creator revalidates either its original session or its private
 * successor source. Neither a record nor endpoint data can register either. */
export async function readOriginalLinuxOciHttpRoute(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
): Promise<OriginalOciHttpRoute> {
  const custody = originalOciCustodies.get(original);
  const successor = custody?.core === core && custody.successorHttp.get(record);
  if (successor) return successor.read(signal);
  const actual = await core.observeServingOciHttp(record, original, signal);
  const endpoint = () =>
    originalLinuxOciHttpEndpoint(original, core, record, actual.httpPort, signal);
  return {
    nativeId: actual.native.nativeId,
    endpoint: endpoint(),
    assertLocal() {
      endpoint();
    },
  };
}

/** Internal source lookup only. This is the already-owned application runtime,
 * never a replacement created from a claim or a positive retirement witness. */
export function originalLinuxOciHttpRetirementSource(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
) {
  const custody = originalOciCustodies.get(original);
  if (!custody || custody.core !== core || custody.signal.aborted || signal.aborted)
    return fail("http_custody");
  const captured = custody.httpRecords.get(record.claimId);
  const runtime = custody.httpRuntimes.get(record.claimId);
  // A fresh creator has no old application-I/O source. Preserve its safe
  // physical progress; absence never supplies an application join.
  if (!captured && !runtime) return;
  if (!captured || !runtime || canonicalJson(captured) !== canonicalJson(record))
    return fail("http_custody");
  return runtime;
}

const observeOriginalOciStarted = LinuxOciPhysicalSession.prototype.observeStarted;
const stopOriginalOciInit = LinuxOciPhysicalSession.prototype.stopInit;
const joinOriginalOciInit = LinuxOciPhysicalSession.prototype.joinInit;
const releaseOriginalOciNamespace = LinuxOciPhysicalSession.prototype.releaseNamespace;
const continueOriginalOciNamespace = LinuxOciPhysicalSession.prototype.continueNamespaceRelease;
const readOriginalOciNamespace = LinuxOciPhysicalSession.prototype.observeNamespaceLifetime;
const beginOriginalOciTrackedJoin = LinuxOciPhysicalSession.prototype.beginTrackedJoin;
const readOriginalOciTrackedJoin = LinuxOciPhysicalSession.prototype.readTrackedJoin;
const deleteOriginalOciBorn = LinuxOciPhysicalSession.prototype.deleteBorn;
const joinOriginalOciBornDelete = LinuxOciPhysicalSession.prototype.joinBornDelete;
const disposeOriginalOciBorn = LinuxOciPhysicalSession.prototype.disposeBorn;
const continueOriginalOciDisposal = LinuxOciPhysicalSession.prototype.continueBornDisposal;
const joinOriginalOciDisposedHelper = LinuxOciPhysicalSession.prototype.joinDisposedHelper;
const closeOriginalOciDisposedHelper = LinuxOciPhysicalSession.prototype.closeDisposedHelper;
const assertOriginalOciDisposedHelperClosed =
  LinuxOciPhysicalSession.prototype.assertDisposedHelperClosed;

const assertOriginalParent = LinuxOciParentBootstrap.prototype.assertCurrent;
const sealOriginalPeerParent = LinuxOciParentBootstrap.prototype.sealPeerControlBinding;
const sealOriginalParent = LinuxOciParentBootstrap.prototype.sealControlBinding;
const createOriginalParent = LinuxOciParentBootstrap.prototype.createStopped;
const finishOriginalParent = LinuxOciParentBootstrap.prototype.finishCreateScope;
const verifyOriginalParent = LinuxOciParentBootstrap.prototype.verifySealedControl;

/** Source-only same-key lookup for the Core's original won-claim save. No
 * caller registration, foreign parent/receipt or positive observation is used. */
export function originalLinuxOciParentControlSource(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
) {
  const custody = originalOciCustodies.get(original),
    entry = custody?.parents.get(record.claimId);
  if (
    !custody ||
    custody.core !== core ||
    custody.signal.aborted ||
    signal.aborted ||
    !entry ||
    entry.record !== record
  )
    return fail("parent_custody");
  assertOriginalParent.call(entry.parent, signal);
  return entry;
}
export async function sealOriginalLinuxOciParentControl(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  key: Parameters<LinuxOciParentBootstrap["sealControlBinding"]>[0],
  scope: string,
  signal: AbortSignal,
  peer = false,
) {
  const entry = originalLinuxOciParentControlSource(original, core, record, signal);
  const request = originalParentRequests.get(entry);
  if (!request) return fail("parent_custody");
  const allocation = originalOciCustodies.get(original)?.allocations.get(record.claimId);
  if (peer && (!allocation || allocation.cleanup !== "untouched")) return fail("parent_custody");
  const sealed = peer
    ? await sealOriginalPeerParent.call(
        entry.parent,
        key,
        scope,
        signal,
        request,
        capturedAllocationData(allocation!),
      )
    : await sealOriginalParent.call(entry.parent, key, scope, signal, request);
  if (originalLinuxOciParentControlSource(original, core, record, signal) !== entry)
    return fail("parent_custody");
  return sealed;
}

/** Fresh readback of this constructor's ORIGINAL allocation only. The
 * receipt is input to authenticated Sql context, never a session factory. */
export async function readOriginalLinuxOciControlArtifact(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
) {
  const custody = originalOciCustodies.get(original),
    allocation = custody?.allocations.get(record.claimId);
  if (
    !custody ||
    custody.core !== core ||
    custody.signal.aborted ||
    signal.aborted ||
    !allocation ||
    allocation.intent !== canonicalJson(record.intent) ||
    allocation.cleanup === "unknown"
  )
    return fail("parent_custody");
  if (allocation.cleanup === "removed") await assertOriginalAllocationAbsent(allocation);
  else {
    await assertOriginalAllocationParents(allocation);
    await privateDirectory(allocation.root.path);
    await assertOriginalFile(allocation.root, true);
    await assertOriginalFile(allocation.receipt, false);
    if ((await readFile(allocation.receipt.path, "utf8")) !== allocation.receiptBytes)
      return fail("allocation_identity");
    await assertOriginalFile(allocation.receipt, false);
  }
  const entry = custody.parents.get(record.claimId);
  if (
    !entry ||
    entry.record.claimId !== record.claimId ||
    canonicalJson(entry.record.intent) !== canonicalJson(record.intent) ||
    JSON.stringify(entry.receipt) !== allocation.receiptBytes ||
    custody.signal.aborted ||
    signal.aborted
  )
    return fail("parent_custody");
  if (custody.signal.aborted || signal.aborted) return fail("parent_custody");
  return entry.receipt;
}
/** Decrypted data is compared to the genuine in-memory P only. No successful
 * endpoint/ACK path or restart replacement is manufactured by this bridge. */
export function verifyOriginalLinuxOciParentControl(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  value: unknown,
  signal: AbortSignal,
) {
  const custody = originalOciCustodies.get(original),
    entry = custody?.parents.get(record.claimId);
  if (
    !custody ||
    custody.core !== core ||
    custody.signal.aborted ||
    signal.aborted ||
    !entry ||
    canonicalJson(entry.record.intent) !== canonicalJson(record.intent)
  )
    return fail("parent_custody");
  verifyOriginalParent.call(entry.parent, value, signal);
}

type OriginalFileIdentity = {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
};
type OriginalOciAllocation = {
  readonly topology?: Readonly<LinuxOciHostTopology>;
  readonly intent: string;
  readonly parents: readonly OriginalFileIdentity[];
  readonly root: OriginalFileIdentity;
  readonly rootfs: OriginalFileIdentity;
  readonly receipt: OriginalFileIdentity;
  readonly receiptBytes: string;
  cleanup: "untouched" | "authenticated" | "prepared" | "unknown" | "removed";
};
type CreatedOciAllocation = OriginalOciAllocation & {
  readonly manifestDigest: string;
};

async function originalFileIdentity(path: string, directory: boolean) {
  const stat = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    stat.uid !== BigInt(uid) ||
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    return fail("allocation_identity");
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino, uid: stat.uid });
}

async function assertOriginalFile(expected: OriginalFileIdentity, directory: boolean) {
  const current = await originalFileIdentity(expected.path, directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.uid !== expected.uid)
    return fail("allocation_identity");
}

async function captureOriginalAllocation(
  artifactRoot: string,
  bundle: LinuxOciBorrowedBundle,
  topology?: Readonly<LinuxOciHostTopology>,
) {
  if (bundle.allocationRoot !== join(artifactRoot, bundle.record.claimId))
    return fail("allocation_identity");
  await privateDirectory(artifactRoot);
  const parents: OriginalFileIdentity[] = [];
  let current = parse(artifactRoot).root;
  parents.push(await originalFileIdentity(current, true));
  for (const part of artifactRoot.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    parents.push(await originalFileIdentity(current, true));
  }
  await privateDirectory(bundle.allocationRoot);
  const root = await originalFileIdentity(bundle.allocationRoot, true),
    rootfs = await originalFileIdentity(join(bundle.allocationRoot, "rootfs"), true),
    receipt = await originalFileIdentity(
      join(bundle.allocationRoot, ".tako-oci-artifact.json"),
      false,
    ),
    receiptBytes = JSON.stringify(bundle.receipt);
  if ((await readFile(receipt.path, "utf8")) !== receiptBytes) return fail("allocation_identity");
  if (
    topology !== undefined &&
    (await readFile(join(bundle.allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE), "utf8")) !==
      serializeLinuxOciHostTopology(bundle.receipt, bundle.record, topology)
  )
    return fail("allocation_identity");
  const allocation: CreatedOciAllocation = {
    ...(topology === undefined ? {} : { topology }),
    intent: canonicalJson(bundle.record.intent),
    parents: Object.freeze(parents),
    root,
    rootfs,
    receipt,
    receiptBytes,
    manifestDigest: bundle.receipt.manifestDigest,
    cleanup: "untouched",
  };
  return allocation;
}

async function assertOriginalAllocationParents(allocation: OriginalOciAllocation) {
  for (const parent of allocation.parents) await assertOriginalFile(parent, true);
  await privateDirectory(allocation.parents.at(-1)?.path ?? "");
}

// Lossless original lstat history is encrypted with P/accepted/artifact binding.
function capturedAllocationData(allocation: OriginalOciAllocation) {
  const file = (v: OriginalFileIdentity) =>
    Object.freeze({ path: v.path, dev: String(v.dev), ino: String(v.ino), uid: String(v.uid) });
  return Object.freeze({
    kind: "linux-oci-original-allocation@1",
    ...(allocation.topology === undefined ? {} : { topology: allocation.topology }),
    intent: allocation.intent,
    parents: allocation.parents.map(file),
    root: file(allocation.root),
    rootfs: file(allocation.rootfs),
    receipt: file(allocation.receipt),
    receiptBytes: allocation.receiptBytes,
  });
}
function originalPeerCustody(
  original: object,
  core: DockerContainerCoreOwner,
  signal: AbortSignal,
) {
  const custody = originalOciCustodies.get(original);
  if (
    !custody ||
    custody.core !== core ||
    !custody.physicalBinary ||
    custody.signal.aborted ||
    signal.aborted
  )
    return fail("parent_custody");
  return { custody, binary: custody.physicalBinary };
}

async function readOriginalPeerAllocation(
  custody: OriginalOciCustody,
  record: DockerContainerCreateRecord,
  artifact: unknown,
  binding: unknown,
  allocationState: "present" | "closed",
) {
  const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
    isJsonObject(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k));
  if (
    !isJsonObject(binding) ||
    binding.claimId !== record.claimId ||
    binding.generation !== record.intent.policy.generation ||
    !exact(binding.allocation, [
      "kind",
      "intent",
      "parents",
      "root",
      "rootfs",
      "receipt",
      "receiptBytes",
      ...(isJsonObject(binding.allocation) && Object.hasOwn(binding.allocation, "topology")
        ? ["topology"]
        : []),
    ])
  )
    return fail("parent_custody");
  const a = binding.allocation;
  if (
    a.kind !== "linux-oci-original-allocation@1" ||
    a.intent !== canonicalJson(record.intent) ||
    typeof a.receiptBytes !== "string" ||
    canonicalJson(parseStrictJson(new TextEncoder().encode(a.receiptBytes), 65536)) !==
      canonicalJson(artifact) ||
    !Array.isArray(a.parents) ||
    !a.parents.length ||
    a.parents.length > 256
  )
    return fail("allocation_identity");
  const file = (v: unknown): OriginalFileIdentity => {
    if (
      !exact(v, ["path", "dev", "ino", "uid"]) ||
      typeof v.path !== "string" ||
      !isAbsolute(v.path)
    )
      return fail("allocation_identity");
    const number = (n: unknown) => {
      if (
        typeof n !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/u.test(n) ||
        BigInt(n) > 18446744073709551615n
      )
        return fail("allocation_identity");
      return BigInt(n);
    };
    return Object.freeze({
      path: v.path,
      dev: number(v.dev),
      ino: number(v.ino),
      uid: number(v.uid),
    });
  };
  const captured: OriginalOciAllocation = {
    ...(a.topology === undefined ? {} : { topology: snapshotLinuxOciHostTopology(a.topology) }),
    intent: canonicalJson(record.intent),
    parents: a.parents.map(file),
    root: file(a.root),
    rootfs: file(a.rootfs),
    receipt: file(a.receipt),
    receiptBytes: a.receiptBytes,
    cleanup: "authenticated",
  };
  const expectedParents: string[] = [];
  let path = parse(custody.artifactRoot).root;
  expectedParents.push(path);
  for (const part of custody.artifactRoot.slice(path.length).split("/").filter(Boolean)) {
    path = join(path, part);
    expectedParents.push(path);
  }
  const root = join(custody.artifactRoot, record.claimId);
  if (
    captured.parents.length !== expectedParents.length ||
    captured.parents.some((p, i) => p.path !== expectedParents[i]) ||
    captured.root.path !== root ||
    captured.rootfs.path !== join(root, "rootfs") ||
    captured.receipt.path !== join(root, ".tako-oci-artifact.json")
  )
    return fail("allocation_identity");
  if (allocationState === "closed") {
    // Core has authenticated both durable bindings for the same remove
    // operation. Absence is only a negative foreign-replacement fence; the
    // original executable/actual peer still supplies the read-only result.
    await assertOriginalAllocationAbsent(captured);
  } else {
    await assertOriginalAllocationParents(captured);
    await privateDirectory(root);
    await assertOriginalFile(captured.root, true);
    await assertOriginalFile(captured.rootfs, true);
    await assertOriginalFile(captured.receipt, false);
    if ((await readFile(captured.receipt.path, "utf8")) !== captured.receiptBytes)
      return fail("allocation_identity");
    await assertOriginalFile(captured.receipt, false);
  }
  return captured;
}

/** Called only after owning Core AEAD authentication, with the real creator
 * custody key. Data cannot register an allocation, session or replacement P. */
async function authenticatedOriginalPeerSource(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  artifact: unknown,
  binding: unknown,
  signal: AbortSignal,
  previous?: OriginalPeerRead,
  allocationState: "present" | "closed" = "present",
) {
  const { custody, binary } = originalPeerCustody(original, core, signal);
  if (custody.peerReads.get(record.claimId) !== previous) return fail("parent_custody");
  const allocation = await readOriginalPeerAllocation(
    custody,
    record,
    artifact,
    binding,
    allocationState,
  );
  if (
    custody.signal.aborted ||
    signal.aborted ||
    custody.peerReads.get(record.claimId) !== previous
  )
    return fail("parent_custody");
  return { custody, binary, allocation };
}

/** Negative-only fence for a caller that already read the fixed original owner. */
export function assertCurrentOriginalLinuxOciLiveInitCustody(
  original: object,
  core: DockerContainerCoreOwner,
  signal: AbortSignal,
): void {
  const { custody } = originalPeerCustody(original, core, signal);
  if (!custody.runtime3 || custody.isClosed()) fail("parent_custody");
}

/** Fixed observation after Core authenticates its current same-Sql record.
 * The opened binding is consumed here, outside all caller-provided callbacks. */
export async function readOriginalLinuxOciLiveInit(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  artifact: unknown,
  binding: unknown,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>,
): Promise<LinuxOciOriginalLiveInit> {
  const { custody, binary } = originalPeerCustody(original, core, signal);
  const assertOpen = () => {
    if (custody.isClosed() || custody.signal.aborted || signal.aborted) fail("parent_custody");
  };
  if (!custody.runtime3 || record.state !== "bound" || record.nativeId !== record.claimId)
    return fail("parent_custody");
  assertOpen();
  await readOriginalPeerAllocation(custody, record, artifact, binding, "present");
  await assertCurrent();
  assertOpen();
  const read = prepareAuthenticatedLinuxOciLiveInitReader(binary, binding, custody.signal);
  const fact = await read(signal);
  assertOpen();
  return fact;
}

export type LinuxOciHeldLiveInit = Omit<
  Awaited<ReturnType<ReturnType<typeof prepareAuthenticatedLinuxOciHeldLiveInitReader>>>,
  "readAdmittedTopology"
> & {
  readOriginalTopology(signal: AbortSignal): Promise<{
    readonly claimId: string;
    readonly generation: number;
    readonly namespaceDevice: string;
    readonly namespaceInode: string;
    readonly topology: Readonly<LinuxOciHostTopology>;
  }>;
};

function assertHeldTopologyFile(identity: LinuxOciHeldTopologyFile, stat: BigIntStats) {
  if (
    !stat.isFile() ||
    String(stat.dev) !== identity.device ||
    String(stat.ino) !== identity.inode ||
    String(stat.size) !== identity.size ||
    String(stat.uid) !== identity.uid ||
    String(stat.mode) !== identity.mode ||
    String(stat.nlink) !== identity.nlink ||
    String(stat.mtimeNs) !== identity.mtimeNs ||
    String(stat.ctimeNs) !== identity.ctimeNs
  )
    return fail("http_custody");
}

async function readOriginalHeldTopology(
  custody: OriginalOciCustody,
  record: DockerContainerCreateRecord,
  allocation: OriginalOciAllocation,
  observe: () => Promise<LinuxOciHeldTopologyFile>,
  assertCurrent: () => Promise<unknown>,
) {
  const { topology } = allocation;
  if (!topology || !custody.hostTopology) return fail("http_custody");
  const selected = linuxOciGenerationTopology(
    { primary: custody.hostTopology, alternate: custody.alternateHostTopology },
    record.intent.policy.generation,
  );
  if (canonicalJson(topology) !== canonicalJson(selected)) return fail("http_custody");
  // Keep the CREATE serializer's original receipt bytes. The bound claim
  // authenticated them in readOriginalPeerAllocation.
  const expected = Buffer.from(
    '{"kind":"linux-oci-owned-topology@1","artifact":' +
      allocation.receiptBytes +
      ',"topology":' +
      JSON.stringify(topology) +
      "}",
  );
  if (expected.length > 32768) return fail("http_custody");
  const path = join(allocation.root.path, LINUX_OCI_HOST_TOPOLOGY_FILE);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let identity: LinuxOciHeldTopologyFile;
  try {
    const original = await file.stat({ bigint: true });
    if (!original.isFile() || original.size !== BigInt(expected.length))
      return fail("http_custody");
    const bytes = Buffer.alloc(expected.length + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== expected.length || !bytes.subarray(0, bytesRead).equals(expected))
      return fail("http_custody");
    identity = await observe();
    assertHeldTopologyFile(identity, original);
    await assertCurrent();
    assertHeldTopologyFile(identity, await file.stat({ bigint: true }));
  } finally {
    // The creator joins this operation before closing the Native connector
    // or disposing the allocation. Keep the FD until both fences complete.
    await file.close();
  }
  // The SQL scope or key may change while the descriptor is being released.
  await assertCurrent();
  return { path, identity, topology };
}

/** Private bridge from the owning, authenticated Core to the exact original
 * allocation and held native reader. The readback never supplies a route. */
export async function openOriginalLinuxOciHeldLiveInit(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  artifact: unknown,
  binding: unknown,
  signal: AbortSignal,
  assertCurrent: (signal: AbortSignal) => Promise<void>,
): Promise<LinuxOciHeldLiveInit> {
  const { custody, binary } = originalPeerCustody(original, core, signal);
  if (record.state !== "bound" || record.nativeId !== record.claimId) return fail("parent_custody");
  const current = async (actualSignal: AbortSignal) => {
    assertCurrentOriginalLinuxOciLiveInitCustody(original, core, signal);
    if (!(actualSignal instanceof AbortSignal) || actualSignal.aborted) return fail("revoked");
    const allocation = await readOriginalPeerAllocation(
      custody,
      record,
      artifact,
      binding,
      "present",
    );
    await assertCurrent(actualSignal);
    assertCurrentOriginalLinuxOciLiveInitCustody(original, core, signal);
    if (actualSignal.aborted) return fail("revoked");
    return allocation;
  };
  await current(signal);
  const open = prepareAuthenticatedLinuxOciHeldLiveInitReader(binary, binding, custody.signal);
  // The creator owns the transport. Caller loss fences use and joins its close
  // through the same connection instead of treating bare stdin EOF as terminal.
  const transportSignal = new AbortController().signal;
  const revocation = new AbortController();
  let attempted = false;
  let checking: Promise<unknown> | undefined;
  let joining: Promise<void> | undefined;
  let rawRevocation: AbortSignal | undefined;
  const opening = Promise.resolve().then(() => {
    assertCurrentOriginalLinuxOciLiveInitCustody(original, core, signal);
    attempted = true;
    return open(transportSignal);
  });
  const source = {
    close() {
      if (!joining) {
        joining = Promise.resolve()
          .then(async () => {
            await checking?.catch(() => undefined);
            const held = await opening.catch((error: unknown) => {
              // An attempted opener rejection cannot prove no child was allocated.
              if (attempted) throw error;
              return undefined;
            });
            await held?.close();
            custody.heldLiveInits.delete(source);
          })
          .finally(() => {
            signal.removeEventListener("abort", revoke);
            rawRevocation?.removeEventListener("abort", revoke);
          });
        revocation.abort();
      }
      return joining;
    },
  };
  const revoke = () => {
    void source.close().catch(() => undefined);
  };
  // Own this opening before the subprocess starts, including any failure
  // between the first retained transport and a valid handoff.
  custody.heldLiveInits.add(source);
  signal.addEventListener("abort", revoke, { once: true });
  try {
    const held = await opening;
    rawRevocation = held.revocation;
    rawRevocation.addEventListener("abort", revoke, { once: true });
    if (rawRevocation.aborted) revoke();
    const assertLocal = (actualSignal: AbortSignal) => {
      assertCurrentOriginalLinuxOciLiveInitCustody(original, core, signal);
      if (actualSignal.aborted || revocation.signal.aborted) return fail("revoked");
    };
    const check = async <T, R>(
      actualSignal: AbortSignal,
      observe: (allocation: OriginalOciAllocation) => Promise<T>,
      finish: (value: T) => R,
    ) => {
      if (
        !(actualSignal instanceof AbortSignal) ||
        actualSignal.aborted ||
        revocation.signal.aborted ||
        checking
      )
        return fail("revoked");
      const running = Promise.resolve().then(async () => {
        if (held.identity.nativeId !== record.nativeId) return fail("parent_custody");
        const allocation = await current(actualSignal);
        assertLocal(actualSignal);
        return observe(allocation);
      });
      // Track the complete owned read, including the final authoritative check.
      checking = running;
      try {
        const value = await running;
        assertLocal(actualSignal);
        return finish(value);
      } catch (error) {
        await source.close().catch(() => undefined);
        throw error;
      } finally {
        checking = undefined;
      }
    };
    const assertHeldCurrent = (actualSignal: AbortSignal) =>
      check(
        actualSignal,
        async () => {
          await held.assertCurrent(transportSignal);
          assertLocal(actualSignal);
          await current(actualSignal);
          assertLocal(actualSignal);
        },
        () => undefined,
      );
    await assertHeldCurrent(signal);
    return Object.freeze({
      identity: held.identity,
      revocation: revocation.signal,
      assertCurrent: assertHeldCurrent,
      readOriginalTopology(actualSignal: AbortSignal) {
        return check(
          actualSignal,
          (allocation) =>
            readOriginalHeldTopology(
              custody,
              record,
              allocation,
              () => {
                assertLocal(actualSignal);
                return held.readAdmittedTopology(transportSignal);
              },
              () => {
                assertLocal(actualSignal);
                return current(actualSignal);
              },
            ),
          ({ path, identity, topology }) => {
            // Refuse replacement during asynchronous FD closure without
            // another await between this check and the private read result.
            assertHeldTopologyFile(identity, lstatSync(path, { bigint: true }));
            return Object.freeze({
              claimId: record.claimId,
              generation: record.intent.policy.generation,
              namespaceDevice: held.identity.namespaceDevice,
              namespaceInode: held.identity.namespaceInode,
              topology,
            });
          },
        );
      },
      close: source.close,
    });
  } catch (error) {
    await source.close().catch(() => undefined);
    throw error;
  }
}

export function prepareOriginalLinuxOciPeerRead(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  artifact: unknown,
  binding: unknown,
  signal: AbortSignal,
  allocationState: "present" | "closed" = "present",
) {
  return prepareOriginalReadonlyPeer(
    original,
    core,
    record,
    artifact,
    binding,
    signal,
    allocationState,
    prepareAuthenticatedLinuxOciPeerReader,
  );
}
export function prepareOriginalLinuxOciApplicationOwnerRead(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  artifact: unknown,
  binding: unknown,
  signal: AbortSignal,
) {
  return prepareOriginalReadonlyPeer(
    original,
    core,
    record,
    artifact,
    binding,
    signal,
    "present",
    prepareAuthenticatedLinuxOciApplicationOwnerReader,
  );
}
async function prepareOriginalReadonlyPeer<T>(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  artifact: unknown,
  binding: unknown,
  signal: AbortSignal,
  allocationState: "present" | "closed",
  prepare: (
    binary: string,
    value: unknown,
    lifetime: AbortSignal,
  ) => (signal: AbortSignal) => Promise<T>,
) {
  const { custody, binary } = await authenticatedOriginalPeerSource(
    original,
    core,
    record,
    artifact,
    binding,
    signal,
    undefined,
    allocationState,
  );
  return async (actualSignal: AbortSignal) => {
    if (custody.signal.aborted || actualSignal.aborted || custody.peerReads.has(record.claimId))
      return fail("parent_custody");
    const read = prepare(binary, binding, custody.signal);
    const settlement = Promise.resolve().then(() => read(actualSignal));
    custody.peerReads.set(record.claimId, Object.freeze({ custody: read, settlement }));
    return settlement;
  };
}

export interface LinuxOciSealedApplicationCloseResume {
  readonly kind: "linux-oci-sealed-same-operation-close@1";
  readonly [sealedCloseResumeBrand]: true;
  assertCurrent(actualSignal: AbortSignal): Promise<void>;
}

/** Create an unforgeable continuation token only for an extant original
 * runtime3 parent and its exact bound record. The caller's sealed-fact guard
 * is rechecked by the token; it does not select or emit a native command. */
export function createOriginalLinuxOciSealedApplicationCloseResume(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>,
): LinuxOciSealedApplicationCloseResume | undefined {
  const custody = originalOciCustodies.get(original);
  if (
    !custody ||
    custody.core !== core ||
    !custody.runtime3 ||
    custody.signal.aborted ||
    signal.aborted ||
    record.state !== "bound" ||
    !record.nativeId
  )
    return fail("parent_custody");
  // A still-owned original session must keep its established detach route.
  if (custody.sessions.has(record.claimId)) return undefined;
  const token = Object.freeze({
    kind: "linux-oci-sealed-same-operation-close@1" as const,
    [sealedCloseResumeBrand]: true as const,
    async assertCurrent(actualSignal: AbortSignal) {
      const latest = originalOciCustodies.get(original);
      if (
        actualSignal !== signal ||
        actualSignal.aborted ||
        latest !== custody ||
        latest.signal.aborted ||
        latest.core !== core ||
        !latest.runtime3 ||
        latest.sessions.has(record.claimId)
      )
        return fail("parent_custody");
      await assertCurrent();
    },
  });
  sealedCloseResumeTokens.set(token, { original, core, record, signal });
  return token;
}

export async function prepareOriginalLinuxOciPeerInit(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  artifact: unknown,
  binding: unknown,
  signal: AbortSignal,
  sealedCloseResume?: LinuxOciSealedApplicationCloseResume,
) {
  if (sealedCloseResume) {
    const token = sealedCloseResumeTokens.get(sealedCloseResume);
    if (
      !token ||
      token.original !== original ||
      token.core !== core ||
      token.record !== record ||
      token.signal !== signal
    )
      return fail("parent_custody");
  }
  const previous = originalOciCustodies.get(original)?.peerReads.get(record.claimId);
  if (previous) {
    if (
      !previous.management ||
      previous.custody !== previous.management ||
      previous.settlement !== previous.management.settlement
    )
      return fail("parent_custody");
    // Join the ORIGINAL connector's actual wait/dual-EOF/close result. The
    // old operation loan is normally aborted on scope exit; it cannot grant
    // current authority. Pending/rejected/UNKNOWN never replaces its slot.
    const pending = Symbol("pending-original-connector");
    const joined = await Promise.race([previous.management.settlement, Promise.resolve(pending)]);
    if (joined === pending) return fail("parent_custody");
  }
  const authenticated = await authenticatedOriginalPeerSource(
    original,
    core,
    record,
    artifact,
    binding,
    signal,
    previous,
  );
  const { custody, binary, allocation } = authenticated;
  if (
    custody.peerReads.get(record.claimId) !== previous ||
    signal.aborted ||
    custody.signal.aborted
  )
    return fail("parent_custody");
  const control = prepareAuthenticatedLinuxOciPeerInit(binary, binding, custody.signal);
  let preparedHelper: LinuxOciParentHResult | undefined;
  const peerAllocationCurrent = (actualSignal: AbortSignal) => {
    const held = custody.peerReads.get(record.claimId);
    if (
      signal !== actualSignal ||
      signal.aborted ||
      custody.signal.aborted ||
      !held ||
      held.custody !== control ||
      held.settlement !== control.settlement
    )
      return fail("parent_custody");
    const helper = control.observeHelperExited(actualSignal);
    if (preparedHelper && preparedHelper !== helper) return fail("parent_custody");
    return helper;
  };
  return Object.freeze({
    ...control,
    advanceNamespace(nativeId: string, actualSignal: AbortSignal) {
      const held = custody.peerReads.get(record.claimId);
      if (
        signal !== actualSignal ||
        signal.aborted ||
        custody.signal.aborted ||
        !held ||
        held.custody !== control ||
        held.settlement !== control.settlement
      )
        return fail("parent_custody");
      return control.advanceNamespace(nativeId, actualSignal);
    },
    async prepareAllocationDisposal(actualSignal: AbortSignal) {
      if (allocation.cleanup !== "authenticated") return fail("allocation_custody_unknown");
      const helper = peerAllocationCurrent(actualSignal);
      await control.settlement; // same exact joined/closed connector Promise
      await assertOriginalAllocationPresent(allocation);
      if (peerAllocationCurrent(actualSignal) !== helper) return fail("parent_custody");
      preparedHelper = helper;
      allocation.cleanup = "prepared";
    },
    async disposeAllocation(actualSignal: AbortSignal) {
      peerAllocationCurrent(actualSignal);
      if (!preparedHelper || allocation.cleanup !== "prepared")
        return fail("allocation_custody_unknown");
      await removePreparedOriginalAllocation(allocation, actualSignal);
      peerAllocationCurrent(actualSignal);
      return Object.freeze({
        kind: "linux-oci-original-allocation-disposal@1",
        barrier: "unproven",
      });
    },
    observeHelperExited(actualSignal: AbortSignal) {
      const held = custody.peerReads.get(record.claimId);
      if (
        signal !== actualSignal ||
        signal.aborted ||
        custody.signal.aborted ||
        !held ||
        held.custody !== control ||
        held.settlement !== control.settlement
      )
        return fail("parent_custody");
      return control.observeHelperExited(actualSignal);
    },
    observeJoined(actualSignal: AbortSignal) {
      const held = custody.peerReads.get(record.claimId);
      if (
        signal !== actualSignal ||
        signal.aborted ||
        custody.signal.aborted ||
        !held ||
        held.custody !== control ||
        held.settlement !== control.settlement
      )
        return fail("parent_custody");
      return control.observeJoined(actualSignal);
    },
    async begin(actualSignal: AbortSignal) {
      if (
        signal !== actualSignal ||
        custody.peerReads.get(record.claimId) !== previous ||
        actualSignal.aborted ||
        custody.signal.aborted
      )
        return fail("parent_custody");
      if (custody.runtime3) {
        const session = custody.sessions.get(record.claimId);
        if (session) {
          await detachOriginalLinuxOciRuntimePeer(session, actualSignal);
        } else {
          if (sealedCloseResume?.kind !== "linux-oci-sealed-same-operation-close@1")
            return fail("parent_custody");
          await sealedCloseResume.assertCurrent(actualSignal);
        }
        if (
          signal !== actualSignal ||
          custody.peerReads.get(record.claimId) !== previous ||
          actualSignal.aborted ||
          custody.signal.aborted
        )
          return fail("parent_custody");
      }
      custody.peerReads.set(
        record.claimId,
        Object.freeze({ custody: control, settlement: control.settlement, management: control }),
      );
      return control.begin(actualSignal);
    },
  });
}

async function assertOriginalAllocationAbsent(allocation: OriginalOciAllocation) {
  await assertOriginalAllocationParents(allocation);
  try {
    await lstat(allocation.root.path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  return fail("allocation_present");
}

function originalAllocation(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
) {
  const custody = originalOciCustodies.get(original),
    allocation = custody?.allocations.get(record.claimId),
    session = custody?.sessions.get(record.claimId);
  if (
    !custody ||
    custody.core !== core ||
    !allocation ||
    !session ||
    custody.signal.aborted ||
    signal.aborted ||
    !custody.disposedHelpers.has(session) ||
    custody.bindings.get(record.claimId) !== record.nativeId ||
    allocation.intent !== canonicalJson(record.intent) ||
    allocation.cleanup === "unknown"
  )
    return fail("allocation_custody_unknown");
  return { custody, allocation, session };
}

async function assertOriginalAllocationPresent(allocation: OriginalOciAllocation) {
  await assertOriginalAllocationParents(allocation);
  await privateDirectory(allocation.root.path);
  await assertOriginalFile(allocation.root, true);
  await assertOriginalFile(allocation.rootfs, true);
  await assertOriginalFile(allocation.receipt, false);
  if ((await readFile(allocation.receipt.path, "utf8")) !== allocation.receiptBytes)
    return fail("allocation_identity");
}

/** Internal original-key bridge. This preflight is not an authorization receipt. */
export async function prepareOriginalLinuxOciAllocationDisposal(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
) {
  const { allocation, session } = originalAllocation(original, core, record, signal);
  await closeOriginalOciDisposedHelper.call(session);
  if (allocation.cleanup === "removed") await assertOriginalAllocationAbsent(allocation);
  else await assertOriginalAllocationPresent(allocation);
  originalAllocation(original, core, record, signal);
  if (allocation.cleanup === "untouched") allocation.cleanup = "prepared";
}

async function removePreparedOriginalAllocation(
  allocation: OriginalOciAllocation,
  signal: AbortSignal,
) {
  if (allocation.cleanup === "prepared") {
    // Consumed before the first destructive await. Error/cancel/partial result
    // cannot be repaired by absence or another rm on a later Engine lease.
    allocation.cleanup = "unknown";
    await rm(allocation.root.path, { recursive: true, force: false });
    if (signal.aborted) return fail("revoked");
    await assertOriginalAllocationAbsent(allocation);
    allocation.cleanup = "removed";
  } else await assertOriginalAllocationAbsent(allocation);
}

/** Only the original prepared allocation may be removed once. A failed or
 * interrupted original removal stays unknown, even if its path later is absent. */
export async function disposeOriginalLinuxOciAllocation(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
): Promise<LinuxOciAllocationDisposalObservation> {
  const { allocation, session } = originalAllocation(original, core, record, signal);
  if (allocation.cleanup !== "prepared" && allocation.cleanup !== "removed")
    return fail("allocation_custody_unknown");
  assertOriginalOciDisposedHelperClosed.call(session);
  originalAllocation(original, core, record, signal);
  await removePreparedOriginalAllocation(allocation, signal);
  originalAllocation(original, core, record, signal);
  return Object.freeze({ kind: "linux-oci-original-allocation-disposal@1", barrier: "unproven" });
}

/** Exactly one next original operation per Core lease/currentness check.
 * The private route only prevents replay; every fact comes from the original
 * initialized physical session. No callback or public registration is accepted. */
export async function advanceOriginalLinuxOciOwnedDisposal(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
): Promise<LinuxOciDisposalProgress> {
  const custody = originalOciCustodies.get(original);
  if (!custody || custody.core !== core || !custody.initStops.has(record.claimId))
    return fail("retained_native_unknown");
  const session = custody.sessions.get(record.claimId),
    nativeId = custody.bindings.get(record.claimId);
  if (!session || nativeId === undefined || nativeId !== record.nativeId)
    return fail("retained_native_unknown");
  const local = () => {
    if (
      custody.signal.aborted ||
      signal.aborted ||
      custody.sessions.get(record.claimId) !== session ||
      custody.bindings.get(record.claimId) !== nativeId
    )
      return fail("revoked");
  };
  local();
  let observation: LinuxOciDisposalProgress;
  const step = custody.disposalSteps.get(record.claimId);
  if (step === undefined) {
    observation = await originalNamespaceObservation(original, core, record, signal, "release");
    custody.disposalSteps.set(record.claimId, "begin");
  } else if (step === "begin") {
    custody.disposalSteps.set(record.claimId, "read");
    observation = await beginOriginalOciTrackedJoin.call(session, signal);
  } else if (step === "read") {
    observation = await readOriginalOciTrackedJoin.call(session, signal);
    custody.disposalSteps.set(record.claimId, "delete");
  } else if (step === "delete") {
    custody.disposalSteps.set(record.claimId, "join-delete");
    observation = await deleteOriginalOciBorn.call(session, signal);
    custody.disposalSteps.set(record.claimId, "dispose");
  } else if (step === "join-delete") {
    observation = await joinOriginalOciBornDelete.call(session, signal);
    custody.disposalSteps.set(record.claimId, "dispose");
  } else if (step === "dispose") {
    custody.disposalSteps.set(record.claimId, "continue-dispose");
    observation = await disposeOriginalOciBorn.call(session, signal);
    custody.disposalSteps.set(record.claimId, "join-helper");
  } else if (step === "continue-dispose") {
    observation = await continueOriginalOciDisposal.call(session, signal);
    custody.disposalSteps.set(record.claimId, "join-helper");
  } else {
    const joined = custody.helperJoins.get(record.claimId);
    if (joined) {
      // Local allocation cleanup may already have sealed the session. Reassert
      // the original private child facts; never re-enter the old join/wire path.
      await closeOriginalOciDisposedHelper.call(session);
      observation = joined;
    } else {
      const originalJoin = await joinOriginalOciDisposedHelper.call(session, signal);
      observation = originalJoin;
      custody.disposedHelpers.add(session);
      custody.helperJoins.set(record.claimId, originalJoin);
    }
  }
  // Record consumed effects before refusing a cancelled return, so a later
  // genuine lease can only continue the original phase, never resend it.
  local();
  return observation;
}

async function originalNamespaceObservation(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
  mode: "release" | "observe",
): Promise<LinuxOciNamespaceLifetimeObservation> {
  const custody = originalOciCustodies.get(original);
  if (
    !custody ||
    custody.core !== core ||
    custody.signal.aborted ||
    signal.aborted ||
    !custody.initStops.has(record.claimId)
  )
    return fail("retained_native_unknown");
  const session = custody.sessions.get(record.claimId);
  const nativeId = custody.bindings.get(record.claimId);
  if (!session || nativeId === undefined || nativeId !== record.nativeId)
    return fail("retained_native_unknown");
  const attempted = custody.namespaceReleases.has(record.claimId);
  if (mode === "observe" && !attempted) return fail("retained_native_unknown");
  // This marker orders requests only. The SAME original physical owner decides
  // which unsent phase may continue and refuses a sent-unknown RELEASE replay.
  if (mode === "release") custody.namespaceReleases.add(record.claimId);
  const observe =
    mode === "observe"
      ? readOriginalOciNamespace
      : attempted
        ? continueOriginalOciNamespace
        : releaseOriginalOciNamespace;
  const observation = await observe.call(session, signal);
  if (
    custody.signal.aborted ||
    signal.aborted ||
    custody.sessions.get(record.claimId) !== session ||
    custody.bindings.get(record.claimId) !== nativeId ||
    observation.nativeId !== nativeId
  )
    return fail("revoked");
  return observation;
}

export function releaseOriginalLinuxOciOwnedNamespace(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
) {
  return originalNamespaceObservation(original, core, record, signal, "release");
}

export function observeOriginalLinuxOciOwnedNamespaceLifetime(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
) {
  return originalNamespaceObservation(original, core, record, signal, "observe");
}

/** Internal owner/producer bridge. The original creator must have completed
 * its actual CREATE and original bindNative CAS for this exact private key. */
export async function observeOriginalLinuxOciOwnedRunning(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
): Promise<LinuxOciStartedObservation> {
  const custody = originalOciCustodies.get(original);
  if (!custody || custody.core !== core || custody.signal.aborted || signal.aborted)
    return fail("retained_native_unknown");
  const session = custody.sessions.get(record.claimId);
  const nativeId = custody.bindings.get(record.claimId);
  if (!session || nativeId === undefined || nativeId !== record.nativeId)
    return fail("retained_native_unknown");
  const observed = await observeOriginalOciStarted.call(session, signal);
  if (
    custody.signal.aborted ||
    signal.aborted ||
    custody.sessions.get(record.claimId) !== session ||
    custody.bindings.get(record.claimId) !== nativeId ||
    observed.nativeId !== nativeId
  )
    return fail("revoked");
  return observed;
}

/** Same original private custody only. A retry joins the consumed attempt;
 * it cannot signal another init or recreate a lost/broken physical process. */
export async function stopOriginalLinuxOciOwnedInit(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
): Promise<LinuxOciInitReapedObservation> {
  const custody = originalOciCustodies.get(original);
  if (!custody || custody.core !== core || custody.signal.aborted || signal.aborted)
    return fail("retained_native_unknown");
  const session = custody.sessions.get(record.claimId);
  const nativeId = custody.bindings.get(record.claimId);
  if (!session || nativeId === undefined || nativeId !== record.nativeId)
    return fail("retained_native_unknown");
  const attempted = custody.initStops.has(record.claimId);
  custody.initStops.add(record.claimId);
  const observed = await (attempted ? joinOriginalOciInit : stopOriginalOciInit).call(
    session,
    signal,
  );
  if (
    custody.signal.aborted ||
    signal.aborted ||
    custody.sessions.get(record.claimId) !== session ||
    custody.bindings.get(record.claimId) !== nativeId ||
    observed.nativeId !== nativeId
  )
    return fail("revoked");
  return observed;
}

export async function observeOriginalLinuxOciOwnedInitReaped(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
  signal: AbortSignal,
): Promise<LinuxOciInitReapedObservation> {
  const custody = originalOciCustodies.get(original);
  if (
    !custody ||
    custody.core !== core ||
    custody.signal.aborted ||
    signal.aborted ||
    !custody.initStops.has(record.claimId)
  )
    return fail("retained_native_unknown");
  const session = custody.sessions.get(record.claimId);
  const nativeId = custody.bindings.get(record.claimId);
  if (!session || nativeId === undefined || nativeId !== record.nativeId)
    return fail("retained_native_unknown");
  const observed = await joinOriginalOciInit.call(session, signal);
  if (
    custody.signal.aborted ||
    signal.aborted ||
    custody.sessions.get(record.claimId) !== session ||
    custody.bindings.get(record.claimId) !== nativeId ||
    observed.nativeId !== nativeId
  )
    return fail("revoked");
  return observed;
}

export interface LinuxOciOwnedBundleOptions extends DockerContainerCoreOwnerOptions {
  /** Existing private Host spool. No caller rootfs or namespace is accepted. */
  readonly artifactRoot: string;
  readonly umociBinary: string;
  /** Explicit Host code choice only. Missing means no native process operation. */
  readonly physicalBinary?: string;
  readonly images: {
    readonly source: DockerImageSourcePort;
    readonly limits: DockerImageSupplyLimits;
  };
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  /** Optional explicit Host data for the closed-birth DROP producer only.
   * It neither changes accepted policyDigest nor supplies admission authority. */
  readonly egressLimits?: LinuxOciEgressLimits;
  /** Expected Host data only. The original native birth/controller must obtain
   * and match actual interface, namespace, address and route facts. */
  readonly hostTopology?: LinuxOciHostTopology;
}

export interface LinuxOciArtifactReceipt {
  readonly kind: "linux-oci-owned-artifact@1";
  readonly claimId: string;
  readonly installationId: string;
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly generation: number;
  readonly revision: string;
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly archiveDigest: string;
}

/** Callback-local data, never admission, a native observation or completion.
 * The original secret loan and same-Sql owner remain held throughout use. */
export interface LinuxOciBorrowedBundle {
  readonly allocationRoot: string;
  readonly receipt: LinuxOciArtifactReceipt;
  readonly record: DockerContainerCreateRecord;
  readonly argv: readonly string[];
  readonly environment: readonly string[];
  readonly cwd: string;
  readonly uid: number;
  readonly gid: number;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly signal: AbortSignal;
  guard(): Promise<void>;
}

const fail = (code = "unavailable"): never => {
  throw new Error(`linux_oci_owned_bundle_${code}`);
};
const utf8 = new TextDecoder("utf-8", { fatal: true });
function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= 65536 && !value.includes("\0");
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4096 || !value.every(text))
    return fail("image_config");
  return [...value];
}
function absolutePath(path: string) {
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    path.split("/").some((x) => x === "." || x === "..")
  )
    return fail("invalid_path");
}
async function ownedDirectory(path: string) {
  absolutePath(path);
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const st = await lstat(current);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      st.uid !== process.getuid?.() ||
      st.mode & 0o022
    )
      return fail("private_directory");
  }
}
async function privateDirectory(path: string) {
  await ownedDirectory(path);
  if (((await lstat(path)).mode & 0o777) !== 0o700) return fail("private_directory");
}

async function unpack(
  binary: string,
  layout: string,
  bundle: string,
  signal: AbortSignal,
  staging: string,
  children: Map<string, ChildProcess>,
  joinTimeoutMs: number,
) {
  absolutePath(binary);
  await ownedDirectory(dirname(binary));
  const executable = await lstat(binary);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    executable.uid !== process.getuid?.() ||
    executable.mode & 0o022
  )
    return fail("unpacker");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["unpack", "--image", `${layout}:owned`, bundle], {
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.create(null),
      signal,
    });
    children.set(staging, child);
    let bytes = 0,
      failed = false;
    let joining: ReturnType<typeof setTimeout> | undefined;
    const awaitExit = () => {
      failed = true;
      if (joining === undefined)
        joining = setTimeout(
          () => reject(new Error("linux_oci_owned_bundle_unpacker_custody_unknown")),
          joinTimeoutMs,
        );
    };
    signal.addEventListener("abort", awaitExit, { once: true });
    if (signal.aborted) awaitExit();
    const discard = (data: Buffer) => {
      bytes += data.length;
      if (bytes > 65536) {
        awaitExit();
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", discard);
    child.stderr.on("data", discard);
    child.on("error", awaitExit);
    child.on("close", (code) => {
      children.delete(staging);
      signal.removeEventListener("abort", awaitExit);
      clearTimeout(joining);
      if (code === 0 && !failed && !signal.aborted) resolve();
      else reject(new Error("linux_oci_owned_bundle_unpacker"));
    });
  });
}

/** Extract only the ORIGINAL supplier's generated regular-file OCI layout.
 * Layer contents are never interpreted as paths by this code. umoci performs
 * actual layer/whiteout extraction and independently verifies the diff IDs. */
async function layoutFromArchive(
  archive: DockerRetainedImageArchive,
  root: string,
  guard: () => Promise<void>,
) {
  const reader = archive.open().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      await guard();
      const next = await reader.read();
      await guard();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > archive.archiveBytes) return fail("archive");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (size !== archive.archiveBytes) return fail("archive");
  const bytes = Buffer.concat(chunks);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== archive.archiveDigest)
    return fail("archive");
  const seen = new Set<string>();
  const number = (field: Uint8Array) => {
    const value = utf8.decode(field).replace(/\0.*$/su, "").trim();
    if (!/^[0-7]+$/u.test(value)) return fail("archive");
    const result = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(result) || result < 0) return fail("archive");
    return result;
  };
  let offset = 0,
    pendingSize: number | undefined;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((x) => x === 0)) {
      if (
        pendingSize !== undefined ||
        bytes.length - offset < 512 ||
        !bytes.subarray(offset).every((x) => x === 0)
      )
        return fail("archive");
      offset = bytes.length;
      break;
    }
    let checksum = 0;
    for (let i = 0; i < header.length; i++) checksum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
    if (checksum !== number(header.subarray(148, 156))) return fail("archive");
    const name = utf8.decode(header.subarray(0, 100)).replace(/\0.*$/su, "");
    const entrySize = pendingSize ?? number(header.subarray(124, 136));
    pendingSize = undefined;
    if (offset + entrySize > bytes.length) return fail("archive");
    const content = bytes.subarray(offset, offset + entrySize);
    offset += Math.ceil(entrySize / 512) * 512;
    if (header[156] === 120) {
      const record = utf8.decode(content),
        match = /^(\d+) size=(\d+)\n$/u.exec(record);
      if (!match || Number(match[1]) !== content.length || name !== "PaxHeaders/size")
        return fail("archive");
      pendingSize = Number(match[2]);
      if (!Number.isSafeInteger(pendingSize) || pendingSize < 0) return fail("archive");
      continue;
    }
    if (
      header[156] !== 48 ||
      seen.has(name) ||
      !/^(?:oci-layout|index\.json|blobs\/sha256\/[a-f0-9]{64})$/u.test(name)
    )
      return fail("archive");
    seen.add(name);
    await guard();
    await writeFile(join(root, name), content, { mode: 0o600, flag: "wx" });
    await guard();
  }
  if (offset !== bytes.length || !seen.has("oci-layout") || !seen.has("index.json"))
    return fail("archive");
  const index: unknown = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  if (
    !isJsonObject(index) ||
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1 ||
    !isJsonObject(index.manifests[0]) ||
    index.manifests[0].digest !== archive.manifestDigest ||
    index.manifests[0].mediaType !== "application/vnd.oci.image.manifest.v1+json"
  )
    return fail("unsupported_image_media");
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({
      ...index,
      manifests: [
        { ...index.manifests[0], annotations: { "org.opencontainers.image.ref.name": "owned" } },
      ],
    }),
    { mode: 0o600 },
  );
}

/** Prepare a real verified artifact under ORIGINAL accepted/claim/secret custody.
 * No caller rootfs, owner port, native identity, ready/coverage flag or verification
 * callback can replace this producer. Its internal Form uses this same creator;
 * public support and ordinary Node entry activation remain separate choices. */
export function createLinuxOciOwnedBundle(options: LinuxOciOwnedBundleOptions) {
  const selectedEgressLimits = options.egressLimits;
  const egressLimits =
    selectedEgressLimits === undefined
      ? undefined
      : snapshotLinuxOciEgressLimits(selectedEgressLimits);
  const topologies = snapshotLinuxOciTopologyPair(
    options.hostTopology,
    options.alternateHostTopology,
  );
  const hostTopology = topologies?.primary;
  if (hostTopology !== undefined && egressLimits === undefined)
    return fail("host_topology_requires_egress");
  const { ociParentControl: parentMode, qualifiedPhysicalDigest } = options;
  const runtimeApplicationOwner = parentMode === "sealed-peer-runtime-application-owner@1";
  const core = createDockerContainerCoreOwner(
    runtimeApplicationOwner
      ? {
          ...options,
          ociParentControl: parentMode,
          qualifiedPhysicalDigest: qualifiedPhysicalDigest ?? fail("parent_selection"),
        }
      : options,
  );
  if (!options.configuredInputs) return fail("configured_inputs");
  const configured = createDockerContainerConfiguredInputs({
    sql: options.sql,
    selection: {
      providerInstallationId: options.installationId,
      backendId: options.backendId,
      targetKey: options.targetKey,
    },
    owner: core,
    keyring: options.configuredInputs.keyring,
    maxSecretBytes: options.configuredInputs.maxSecretBytes,
  });
  const { artifactRoot, umociBinary, physicalBinary, images, memoryBytes, nanoCpus, pidsLimit } =
    options;
  if (![memoryBytes, nanoCpus, pidsLimit].every((x) => Number.isSafeInteger(x) && x > 0))
    return fail("invalid_request");
  const timeout = images.limits.maxDurationMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
    return fail("invalid_request");
  if (physicalBinary !== undefined && (!text(physicalBinary) || !isAbsolute(physicalBinary)))
    return fail("invalid_request");
  const trackedPeer = parentMode === "sealed-peer-runtime@1" || runtimeApplicationOwner;
  const applicationOwnerPeer =
    parentMode === "sealed-peer-application-owner@1" || runtimeApplicationOwner;
  const peerMode =
    parentMode === "sealed-peer@1" ||
    trackedPeer ||
    parentMode === "sealed-peer-local-cleanup@1" ||
    applicationOwnerPeer;
  const nativeSessions = new Map<string, LinuxOciPhysicalSession>(),
    nativeBindings = new Map<string, string>();
  const parents = new Map<
    string,
    {
      readonly parent: LinuxOciParentBootstrap;
      readonly record: DockerContainerCreateRecord;
      readonly receipt: LinuxOciArtifactReceipt;
    }
  >();
  if (parentMode !== undefined && parentMode !== "sealed-original@1" && !peerMode)
    return fail("parent_selection");
  if (parentMode !== undefined && (!options.configuredInputs || physicalBinary === undefined))
    return fail("parent_selection");
  const disposedHelpers = new WeakSet<LinuxOciPhysicalSession>();
  const allocations = new Map<string, CreatedOciAllocation>();
  const sql = options.sql;
  core.acceptance.assertSql(sql);
  // A failed join retains this exact request. A fresh call cannot replace it
  // with another GET; original close may only join the original objects.
  const httpProbes = new Map<string, ReturnType<typeof createLinuxOciHttpHealthProbe>>();
  const httpRecords = new Map<string, DockerContainerCreateRecord>();
  const httpRuntimes = new Map<string, ReturnType<typeof createLinuxOciContainerHttpRuntime>>();
  const successorHttp = new Map<DockerContainerCreateRecord, OriginalOciSuccessorHttp>();
  const heldLiveInits: OriginalOciCustody["heldLiveInits"] = new Set();
  const originalNativeCustody = Object.freeze({});
  const nativeLifetime = new AbortController();
  originalOciCustodies.set(originalNativeCustody, {
    core,
    runtime3: trackedPeer,
    isClosed: () => closed,
    artifactRoot,
    physicalBinary,
    hostTopology,
    alternateHostTopology: topologies?.alternate,
    httpRecords,
    httpRuntimes,
    successorHttp,
    heldLiveInits,
    peerReads: new Map(),
    sessions: nativeSessions,
    parents,
    bindings: nativeBindings,
    signal: nativeLifetime.signal,
    initStops: new Set<string>(),
    namespaceReleases: new Set<string>(),
    disposedHelpers,
    helperJoins: new Map(),
    allocations,
    disposalSteps: new Map(),
  });
  let nativeClosing: Promise<void> | undefined;
  const joinTimeoutMs = Math.min(timeout, 1000);
  const children = new Map<string, ChildProcess>(),
    retainedStaging = new Set<string>();
  const scopes = new Set<Promise<unknown>>(),
    cancellation = new Set<AbortController>();
  let closed = false,
    cleanupFailed = false;
  let closing: Promise<void> | undefined;
  let originalSettlement: Promise<void> | undefined;
  async function acceptedPolicy(accepted: DockerContainerAcceptedExecution) {
    return {
      tenantRef: accepted.principal,
      generation: accepted.generation,
      outboundInternet: accepted.outboundInternet,
      policyDigest: await canonicalDigest({
        installationId: accepted.installationId,
        backendId: accepted.backendId,
        targetKey: accepted.targetKey,
        umociBinary,
        memoryBytes,
        nanoCpus,
        pidsLimit,
        ...(physicalBinary === undefined ? {} : { physicalBinary }),
      }),
    };
  }
  function retainedNamespaceObservations(
    execution: V2Execution,
    externalSignal: AbortSignal | undefined,
    mode: "release" | "observe",
  ): Promise<readonly LinuxOciNamespaceLifetimeObservation[]>;
  function retainedNamespaceObservations(
    execution: V2Execution,
    externalSignal: AbortSignal | undefined,
    mode: "dispose",
  ): Promise<readonly LinuxOciDisposedHelperObservation[]>;
  function retainedNamespaceObservations(
    execution: V2Execution,
    externalSignal: AbortSignal | undefined,
    mode: "allocation",
  ): Promise<readonly LinuxOciAllocationDisposalObservation[]>;
  function retainedNamespaceObservations(
    execution: V2Execution,
    externalSignal: AbortSignal | undefined,
    mode: "release" | "observe" | "dispose" | "allocation",
  ): Promise<
    readonly (
      | LinuxOciNamespaceLifetimeObservation
      | LinuxOciDisposedHelperObservation
      | LinuxOciAllocationDisposalObservation
    )[]
  > {
    if (closed) return Promise.reject(new Error("linux_oci_owned_bundle_closed"));
    if (physicalBinary === undefined)
      return Promise.reject(new Error("linux_oci_owned_bundle_physical_not_configured"));
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
      return Promise.reject(new Error("linux_oci_owned_bundle_revoked"));
    const cancel = new AbortController();
    cancellation.add(cancel);
    const abort = () => cancel.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    const running = Promise.resolve().then(() =>
      core.withExecution(execution, async () => {
        if (closed || cancel.signal.aborted) return fail("revoked");
        const accepted = await core.readAcceptedExecution(execution);
        if (accepted.action !== "delete" && accepted.action !== "update")
          return fail("not_retirement");
        const retained = accepted.retained.filter(
          ({ record }) => record.intent.policy.generation < accepted.generation,
        );
        if (!retained.length) return fail("retained_native_unknown");
        const expectedPolicy = await acceptedPolicy(accepted);
        for (const item of retained) {
          const { record } = item;
          if (
            item.removedAtMs !== null ||
            record.state !== "bound" ||
            record.nativeId === null ||
            record.intent.installationId !== accepted.installationId ||
            record.intent.resourceUid !== accepted.resourceUid ||
            record.intent.incarnationId !== accepted.incarnationId ||
            record.intent.policy.tenantRef !== accepted.principal ||
            record.intent.policy.policyDigest !== expectedPolicy.policyDigest ||
            !nativeSessions.has(record.claimId) ||
            nativeBindings.get(record.claimId) !== record.nativeId
          )
            return fail("retained_native_unknown");
        }
        const observations: (
          | LinuxOciNamespaceLifetimeObservation
          | LinuxOciDisposedHelperObservation
          | LinuxOciAllocationDisposalObservation
        )[] = [];
        for (const { record } of retained) {
          if (closed || cancel.signal.aborted) return fail("revoked");
          await core.owner.withAuthority(record, "remove", async (held) => {
            const loan = new AbortController();
            const revoke = () => loan.abort();
            cancel.signal.addEventListener("abort", revoke, { once: true });
            held.revocation.addEventListener("abort", revoke, { once: true });
            if (cancel.signal.aborted || held.revocation.aborted) revoke();
            try {
              if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
              let observation:
                | LinuxOciNamespaceLifetimeObservation
                | LinuxOciDisposedHelperObservation
                | LinuxOciAllocationDisposalObservation;
              if (mode === "allocation") {
                observation = await core.disposeRetainedAllocation(
                  execution,
                  record,
                  originalNativeCustody,
                  loan.signal,
                );
              } else if (mode === "dispose") {
                for (;;) {
                  // Each step re-enters the genuine Core current/START gate;
                  // the private creator route alone cannot authorize an effect.
                  const progress = await core.advanceRetainedBornDisposal(
                    execution,
                    record,
                    originalNativeCustody,
                    loan.signal,
                  );
                  if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                    return fail("revoked");
                  if (closed || loan.signal.aborted) return fail("revoked");
                  if (progress.kind === "linux-oci-disposed-helper-exit@1") {
                    observation = progress;
                    break;
                  }
                }
              } else
                observation = await (mode === "release"
                  ? core.releaseRetainedNamespace(
                      execution,
                      record,
                      originalNativeCustody,
                      loan.signal,
                    )
                  : core.observeRetainedNamespaceLifetime(
                      execution,
                      record,
                      originalNativeCustody,
                      loan.signal,
                    ));
              if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
              if (closed || loan.signal.aborted) return fail("revoked");
              observations.push(observation);
            } finally {
              loan.abort();
              cancel.signal.removeEventListener("abort", revoke);
              held.revocation.removeEventListener("abort", revoke);
            }
          });
          if (closed || cancel.signal.aborted) return fail("revoked");
        }
        if (closed || cancel.signal.aborted) return fail("revoked");
        return Object.freeze(observations);
      }),
    );
    scopes.add(running);
    void running
      .finally(() => {
        externalSignal?.removeEventListener("abort", abort);
        cancellation.delete(cancel);
        scopes.delete(running);
      })
      .catch(() => undefined);
    return running;
  }
  /** A fixed HTTP status fact under this original creator's current running
   * allocation. Selected-policy C observations require actual admission and
   * fresh original policy/uplink readback. Neither a status nor this result
   * publishes serving or completes an operation. The observations describe the
   * guarded exchange interval, not an atomic current-running handoff. A later
   * serving CAS must revalidate START and original native custody itself. */
  function observeAcceptedHttpHealth(
    execution: V2Execution,
    externalSignal?: AbortSignal,
  ): Promise<{ readonly nativeId: string; readonly statusCode: number }> {
    if (closed) return Promise.reject(new Error("linux_oci_owned_bundle_closed"));
    if (physicalBinary === undefined || hostTopology === undefined || egressLimits === undefined)
      return Promise.reject(new Error("linux_oci_owned_bundle_http_not_configured"));
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
      return Promise.reject(new Error("linux_oci_owned_bundle_revoked"));
    const cancel = new AbortController();
    const abort = () => cancel.abort();
    cancellation.add(cancel);
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    const timer = setTimeout(abort, timeout);
    const local = () => {
      if (closed || cancel.signal.aborted) return fail("revoked");
    };
    const running = Promise.resolve().then(async () => {
      const observed = await core.withExecution(execution, async () => {
        local();
        const accepted = await core.readAcceptedExecution(execution);
        if (accepted.action === "delete") return fail("not_create");
        const current = accepted.retained.find(
          ({ record }) => record.intent.policy.generation === accepted.generation,
        );
        const healthTopology =
          allocations.get(current?.record.claimId ?? "")?.topology ??
          (topologies?.alternate === undefined ? hostTopology : undefined);
        if (!healthTopology) return fail("http_custody");
        if (
          !current ||
          current.removedAtMs !== null ||
          current.record.state !== "bound" ||
          current.record.nativeId === null
        )
          return fail("retained_native_unknown");
        const { record } = current;
        const nativeId = nativeBindings.get(record.claimId),
          session = nativeSessions.get(record.claimId);
        if (
          !session ||
          nativeId === undefined ||
          nativeId !== record.nativeId ||
          record.intent.installationId !== accepted.installationId ||
          record.intent.resourceUid !== accepted.resourceUid ||
          record.intent.incarnationId !== accepted.incarnationId ||
          record.intent.revision !== accepted.revision ||
          canonicalJson(record.intent.policy) !== canonicalJson(await acceptedPolicy(accepted)) ||
          canonicalJson(record.intent.requiredSecretNames) !==
            canonicalJson(accepted.requiredSecretNames)
        )
          return fail("retained_native_unknown");
        validateDockerContainerSpec(accepted.spec);
        const { httpPort, healthPath } = accepted.spec;
        if (typeof httpPort !== "number" || typeof healthPath !== "string")
          return fail("invalid_request");
        const result = await core.owner.withAuthority(record, "reconcile", async (held) => {
          const value = await held.withEnvironment(async (_values, signal) => {
            const loan = new AbortController();
            const revoke = () => loan.abort();
            signal.addEventListener("abort", revoke, { once: true });
            cancel.signal.addEventListener("abort", revoke, { once: true });
            if (signal.aborted || cancel.signal.aborted) revoke();
            const guard = async () => {
              local();
              if (loan.signal.aborted || !(await held.stillCurrent())) return fail("revoked");
              const fresh = await core.readAcceptedExecution(execution);
              const saved = fresh.retained.find(
                ({ record: item }) => item.claimId === record.claimId,
              );
              if (
                fresh.generation !== accepted.generation ||
                fresh.revision !== accepted.revision ||
                fresh.incarnationId !== accepted.incarnationId ||
                !saved ||
                saved.removedAtMs !== null ||
                canonicalJson(saved.record) !== canonicalJson(record) ||
                nativeSessions.get(record.claimId) !== session ||
                nativeBindings.get(record.claimId) !== nativeId
              )
                return fail("revoked");
              // confirmAcceptedRunning is deliberately idempotent for exited
              // attempts too. Health requires an ACTUAL running row instead;
              // it never inserts, restarts or un-exits a START attempt.
              const attempts = await sql.query(
                "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?",
                [record.intent.resourceUid, record.intent.policy.generation],
              );
              const attempt = attempts[0];
              if (
                attempts.length !== 1 ||
                !attempt ||
                attempt.attempt !== 1 ||
                attempt.create_claim_id !== record.claimId ||
                attempt.native_id !== nativeId ||
                attempt.state !== "running" ||
                attempt.confirmed_exited_at_ms !== null ||
                typeof attempt.claimed_at_ms !== "number" ||
                !Number.isSafeInteger(attempt.claimed_at_ms) ||
                attempt.claimed_at_ms < 0 ||
                typeof attempt.confirmed_running_at_ms !== "number" ||
                !Number.isSafeInteger(attempt.confirmed_running_at_ms) ||
                attempt.confirmed_running_at_ms < attempt.claimed_at_ms
              )
                return fail("retained_start_unknown");
              local();
              if (loan.signal.aborted) return fail("revoked");
            };
            let probe: ReturnType<typeof createLinuxOciHttpHealthProbe> | undefined;
            try {
              await guard();
              if (httpProbes.has(record.claimId)) return fail("http_custody_retained");
              const before = await observeOriginalLinuxOciOwnedRunning(
                originalNativeCustody,
                core,
                record,
                loan.signal,
              );
              await guard();
              // No await from the final local fence through registration.
              // The HTTP helper registers its own active scope before IO.
              local();
              if (loan.signal.aborted) return fail("revoked");
              if (httpProbes.has(record.claimId)) return fail("http_custody_retained");
              probe = createLinuxOciHttpHealthProbe({
                address: healthTopology.peerIpv4Guest,
                httpPort,
                healthPath,
                timeoutMs: Math.min(timeout, 10_000),
              });
              httpProbes.set(record.claimId, probe);
              const fact = await probe.observe(loan.signal);
              await guard();
              const after = await observeOriginalLinuxOciOwnedRunning(
                originalNativeCustody,
                core,
                record,
                loan.signal,
              );
              if (
                after.nativeId !== before.nativeId ||
                after.namespaceDevice !== before.namespaceDevice ||
                after.namespaceInode !== before.namespaceInode
              )
                return fail("retained_native_unknown");
              await guard();
              return Object.freeze({ nativeId, statusCode: fact.statusCode });
            } finally {
              try {
                if (probe) {
                  await probe.close();
                  if (httpProbes.get(record.claimId) === probe) httpProbes.delete(record.claimId);
                }
              } finally {
                loan.abort();
                signal.removeEventListener("abort", revoke);
                cancel.signal.removeEventListener("abort", revoke);
              }
            }
          });
          local();
          if (held.revocation.aborted) return fail("revoked");
          return value;
        });
        // Original withAuthority performs a final awaited currentness read.
        local();
        return result;
      });
      local();
      return observed;
    });
    scopes.add(running);
    void running
      .finally(() => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
        cancellation.delete(cancel);
        scopes.delete(running);
      })
      .catch(() => undefined);
    return running;
  }

  const artifact = Object.freeze({
    acceptance: core.acceptance,
    configuredInputs: Object.freeze({
      prepareCreate: configured.prepareCreate,
      prepareUpdate: configured.prepareUpdate,
    }),
    withAcceptedBundle<T>(
      execution: V2Execution,
      use: (bundle: LinuxOciBorrowedBundle) => Promise<T>,
    ): Promise<T> {
      if (closed) return Promise.reject(new Error("linux_oci_owned_bundle_closed"));
      const cancel = new AbortController();
      cancellation.add(cancel);
      const timer = setTimeout(() => cancel.abort(), timeout);
      const running = Promise.resolve().then(() =>
        core.withExecution(execution, async () => {
          const accepted = await core.readAcceptedExecution(execution);
          if (accepted.action === "delete") return fail("not_create");
          const guard = async () => {
            if (closed || cancel.signal.aborted) return fail("closed");
            await core.readAcceptedExecution(execution);
            if (closed || cancel.signal.aborted) return fail("closed");
          };
          const identity = await canonicalDigest({
            installation: accepted.installationId,
            resource: accepted.resourceUid,
            incarnation: accepted.incarnationId,
            revision: accepted.revision,
          });
          const policy = await acceptedPolicy(accepted);
          const intent: DockerContainerCreateIntent = {
            installationId: accepted.installationId,
            resourceUid: accepted.resourceUid,
            incarnationId: accepted.incarnationId,
            revision: accepted.revision,
            nativeName: `takoserver-${identity.slice(7)}`,
            identityLabel: identity,
            revisionLabel: await canonicalDigest({
              spec: accepted.spec,
              policy,
              memoryBytes,
              nanoCpus,
              pidsLimit,
            }),
            policy,
            requiredSecretNames: accepted.requiredSecretNames,
          };
          if (await core.owner.read(intent)) return fail("retained_create_unknown");
          // Only the explicit singleton-topology branch moves its ORIGINAL
          // claim before artifact/image effects. A refused collision retains
          // that pending claim permanently; no empty-map/restart replay.
          let topologyClaim: Awaited<ReturnType<typeof core.owner.claim>> | undefined;
          if (hostTopology !== undefined) {
            topologyClaim = await core.claimAcceptedTopology(
              execution,
              intent,
              originalNativeCustody,
              cancel.signal,
            );
            await guard();
          }
          const image = accepted.spec.image;
          if (typeof image !== "string") return fail("image");
          await privateDirectory(artifactRoot);
          await guard();
          let temporary: string | undefined = await mkdtemp(join(artifactRoot, ".oci-stage-"));
          let outcome:
            | { readonly ok: true; readonly value: T }
            | { readonly ok: false; readonly error: unknown };
          let cleanupError = false;
          try {
            const staging = temporary;
            const layout = join(staging, "layout"),
              unpacked = join(staging, "unpacked");
            await mkdir(join(layout, "blobs", "sha256"), { recursive: true, mode: 0o700 });
            const value = await withDockerRetainedImageArchive(
              { guard, signal: cancel.signal },
              { image, source: images.source, limits: images.limits },
              async (archive) => {
                await layoutFromArchive(archive, layout, guard);
                await guard();
                await unpack(
                  umociBinary,
                  layout,
                  unpacked,
                  cancel.signal,
                  staging,
                  children,
                  joinTimeoutMs,
                );
                await guard();
                const config: unknown = JSON.parse(
                  await readFile(join(unpacked, "config.json"), "utf8"),
                );
                if (
                  !isJsonObject(config) ||
                  !isJsonObject(config.process) ||
                  !isJsonObject(config.process.user)
                )
                  return fail("image_config");
                const argv = strings(config.process.args),
                  inheritedEnvironment = strings(config.process.env);
                const { cwd, user } = config.process;
                if (
                  argv.length === 0 ||
                  !text(cwd) ||
                  !cwd.startsWith("/") ||
                  typeof user.uid !== "number" ||
                  typeof user.gid !== "number" ||
                  !Number.isSafeInteger(user.uid) ||
                  !Number.isSafeInteger(user.gid) ||
                  user.uid < 0 ||
                  user.uid > 0xffff_ffff ||
                  user.gid < 0 ||
                  user.gid > 0xffff_ffff
                )
                  return fail("image_config");
                const uid = user.uid,
                  gid = user.gid;
                const publicEnvironment = accepted.spec.environment ?? {};
                if (!isJsonObject(publicEnvironment)) return fail("image_config");
                const rootfs = await lstat(join(unpacked, "rootfs"));
                if (
                  !rootfs.isDirectory() ||
                  rootfs.isSymbolicLink() ||
                  rootfs.uid !== process.getuid?.() ||
                  rootfs.mode & 0o022
                )
                  return fail("rootfs");
                const claim = topologyClaim ?? (await core.owner.claim(intent));
                await guard();
                if (claim.status !== "won") return fail("retained_create_unknown");
                const { record } = claim;
                const allocationRoot = join(artifactRoot, record.claimId);
                // An exclusive destination is established before moving our private
                // rootfs. Existing/uncertain claims never overwrite another owner.
                await mkdir(allocationRoot, { mode: 0o700 });
                await rename(join(unpacked, "rootfs"), join(allocationRoot, "rootfs"));
                const receipt: LinuxOciArtifactReceipt = {
                  kind: "linux-oci-owned-artifact@1",
                  claimId: record.claimId,
                  installationId: accepted.installationId,
                  resourceUid: accepted.resourceUid,
                  incarnationId: accepted.incarnationId,
                  generation: accepted.generation,
                  revision: accepted.revision,
                  sourceDigest: archive.sourceDigest,
                  manifestDigest: archive.manifestDigest,
                  configDigest: archive.configDigest,
                  archiveDigest: archive.archiveDigest,
                };
                await writeFile(
                  join(allocationRoot, ".tako-oci-artifact.json"),
                  JSON.stringify(receipt),
                  { flag: "wx", mode: 0o600 },
                );
                await guard();
                return core.owner.withAuthority(record, "reconcile", async (held) => {
                  const heldGuard = async () => {
                    await guard();
                    const nativeId = nativeBindings.get(record.claimId);
                    const expected: DockerContainerCreateRecord =
                      nativeId === undefined ? record : { ...record, state: "bound", nativeId };
                    if (
                      held.revocation.aborted ||
                      !(await held.stillCurrent()) ||
                      canonicalJson(await core.owner.read(intent)) !== canonicalJson(expected)
                    )
                      return fail("revoked");
                  };
                  return held.withEnvironment(async (secrets, signal) => {
                    await heldGuard();
                    if (egressLimits !== undefined) {
                      // Original accepted record/digest are preserved. Limits
                      // are separately snapshotted Host data, not an authority
                      // replacement. The actual C owner still keeps birth shut.
                      await writeFile(
                        join(allocationRoot, LINUX_OCI_EGRESS_POLICY_FILE),
                        serializeLinuxOciEgressPolicy(receipt, record, egressLimits),
                        { flag: "wx", mode: 0o600 },
                      );
                      await heldGuard();
                    }
                    if (hostTopology !== undefined) {
                      if (topologies === undefined) return fail("http_custody");
                      await writeFile(
                        join(allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE),
                        serializeLinuxOciHostTopology(
                          receipt,
                          record,
                          linuxOciGenerationTopology(topologies, record.intent.policy.generation),
                        ),
                        { flag: "wx", mode: 0o600 },
                      );
                      await heldGuard();
                      // Only original accepted application data is supplied.
                      // Native policy still needs its own actual topology,
                      // installed rules/readback and closed-birth custody.
                      await writeFile(
                        join(allocationRoot, LINUX_OCI_SERVICE_POLICY_FILE),
                        serializeLinuxOciServicePolicy(receipt, record, accepted),
                        { flag: "wx", mode: 0o600 },
                      );
                      await heldGuard();
                    }
                    const loan = new AbortController();
                    const abort = () => loan.abort();
                    signal.addEventListener("abort", abort, { once: true });
                    cancel.signal.addEventListener("abort", abort, { once: true });
                    if (signal.aborted || cancel.signal.aborted) abort();
                    try {
                      const values = new Map<string, string>();
                      for (const entry of inheritedEnvironment) {
                        const at = entry.indexOf("=");
                        if (at < 1) return fail("image_config");
                        values.set(entry.slice(0, at), entry.slice(at + 1));
                      }
                      for (const [name, value] of Object.entries(publicEnvironment)) {
                        if (!text(value)) return fail("image_config");
                        values.set(name, value);
                      }
                      for (const [name, value] of Object.entries(secrets)) values.set(name, value);
                      const result = await use(
                        Object.freeze({
                          allocationRoot,
                          receipt: Object.freeze(receipt),
                          record,
                          argv: Object.freeze(argv),
                          environment: Object.freeze([...values].map(([k, v]) => `${k}=${v}`)),
                          cwd,
                          uid,
                          gid,
                          memoryBytes,
                          nanoCpus,
                          pidsLimit,
                          signal: loan.signal,
                          guard: heldGuard,
                        }),
                      );
                      await heldGuard();
                      return result;
                    } finally {
                      signal.removeEventListener("abort", abort);
                      cancel.signal.removeEventListener("abort", abort);
                      loan.abort();
                    }
                  });
                });
              },
            );
            outcome = { ok: true, value };
          } catch (error: unknown) {
            outcome = { ok: false, error };
          } finally {
            if (temporary && children.has(temporary)) {
              // A timeout/abort is not an actual child join. Keep its original
              // handle and private files; never remove beneath a live unpacker.
              retainedStaging.add(temporary);
              cleanupError = true;
            } else if (temporary) {
              const staging = temporary;
              try {
                await rm(staging, { recursive: true, force: true });
                temporary = undefined;
              } catch {
                cleanupFailed = true;
                retainedStaging.add(staging);
                cleanupError = true;
              }
            }
          }
          if (!outcome.ok) throw outcome.error;
          if (cleanupError) return fail("cleanup");
          return outcome.value;
        }),
      );
      scopes.add(running);
      void running
        .finally(() => {
          clearTimeout(timer);
          scopes.delete(running);
          cancellation.delete(cancel);
        })
        .catch(() => undefined);
      return running;
    },
    close(): Promise<void> {
      if (!closing) {
        closed = true;
        nativeLifetime.abort();
        for (const cancel of cancellation) cancel.abort();
        // Every rejoin waits this SAME original work, never another attempt.
        // The timeout below ends only this caller's wait, not ownership.
        originalSettlement ??= (async () => {
          await Promise.allSettled([...scopes]);
          await Promise.all(
            [...children.values()].map(
              (child) => new Promise<void>((resolve) => child.once("close", resolve)),
            ),
          );
          for (const staging of retainedStaging) {
            if (children.has(staging)) return fail("cleanup_custody_unknown");
            await rm(staging, { recursive: true, force: true });
            retainedStaging.delete(staging);
          }
          cleanupFailed = false;
        })();
        const settlement = originalSettlement;
        void settlement.catch(() => {
          if (originalSettlement === settlement) originalSettlement = undefined;
        });
        const attempt = new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("linux_oci_owned_bundle_scope_custody_unknown")),
            joinTimeoutMs,
          );
          void settlement.then(
            () => {
              clearTimeout(deadline);
              if (cleanupFailed || children.size || retainedStaging.size)
                reject(new Error("linux_oci_owned_bundle_cleanup_custody_unknown"));
              else resolve();
            },
            () => {
              clearTimeout(deadline);
              reject(new Error("linux_oci_owned_bundle_cleanup_custody_unknown"));
            },
          );
        });
        closing = attempt;
        void attempt.catch(() => {
          if (closing === attempt) closing = undefined;
        });
      }
      return closing;
    },
  });
  function readRetainedParentControls(
    execution: V2Execution,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    if (closed || parentMode !== "sealed-original@1")
      return Promise.reject(new Error("linux_oci_owned_bundle_parent_unavailable"));
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
      return Promise.reject(new Error("linux_oci_owned_bundle_revoked"));
    const cancel = new AbortController(),
      abort = () => cancel.abort();
    cancellation.add(cancel);
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    const timer = setTimeout(abort, timeout);
    const running = Promise.resolve().then(() =>
      core.withExecution(execution, async () => {
        if (closed || cancel.signal.aborted) return fail("revoked");
        const accepted = await core.readAcceptedExecution(execution);
        if (!accepted.retained.length) return fail("parent_unavailable");
        for (const item of accepted.retained) {
          const { record } = item;
          if (item.removedAtMs !== null || record.state === "removed")
            return fail("parent_unavailable");
          const phase =
            accepted.action === "delete" || record.intent.policy.generation < accepted.generation
              ? "remove"
              : "reconcile";
          await core.owner.withAuthority(record, phase, async (held) => {
            const loan = new AbortController(),
              revoke = () => loan.abort();
            cancel.signal.addEventListener("abort", revoke, { once: true });
            held.revocation.addEventListener("abort", revoke, { once: true });
            if (cancel.signal.aborted || held.revocation.aborted) revoke();
            try {
              if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
              await core.readAcceptedParentControl(
                execution,
                record,
                originalNativeCustody,
                loan.signal,
              );
              if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
            } finally {
              loan.abort();
              cancel.signal.removeEventListener("abort", revoke);
              held.revocation.removeEventListener("abort", revoke);
            }
          });
        }
        if (closed || cancel.signal.aborted) return fail("revoked");
      }),
    );
    scopes.add(running);
    void running
      .finally(() => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
        cancellation.delete(cancel);
        scopes.delete(running);
      })
      .catch(() => undefined);
    return running;
  }
  function readRetainedPeerResults(
    execution: V2Execution,
    externalSignal?: AbortSignal,
  ): Promise<readonly LinuxOciParentHResult[]> {
    if (closed || !peerMode)
      return Promise.reject(new Error("linux_oci_owned_bundle_parent_unavailable"));
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
      return Promise.reject(new Error("linux_oci_owned_bundle_revoked"));
    const cancel = new AbortController(),
      abort = () => cancel.abort();
    cancellation.add(cancel);
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    const timer = setTimeout(abort, timeout);
    const running = Promise.resolve().then(() =>
      core.withExecution(execution, async () => {
        if (closed || cancel.signal.aborted) return fail("revoked");
        const accepted = await core.readAcceptedExecution(execution);
        if (!accepted.retained.length) return fail("parent_unavailable");
        const observations: LinuxOciParentHResult[] = [];
        for (const item of accepted.retained) {
          const { record } = item;
          if (item.removedAtMs !== null || record.state === "removed")
            return fail("parent_unavailable");
          const phase =
            accepted.action === "delete" || record.intent.policy.generation < accepted.generation
              ? "remove"
              : "reconcile";
          await core.owner.withAuthority(record, phase, async (held) => {
            const loan = new AbortController(),
              revoke = () => loan.abort();
            cancel.signal.addEventListener("abort", revoke, { once: true });
            held.revocation.addEventListener("abort", revoke, { once: true });
            if (cancel.signal.aborted || held.revocation.aborted) revoke();
            try {
              if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
              const result = await core.readAcceptedParentControl(
                execution,
                record,
                originalNativeCustody,
                loan.signal,
              );
              if (!result || closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
              observations.push(result);
            } finally {
              loan.abort();
              cancel.signal.removeEventListener("abort", revoke);
              held.revocation.removeEventListener("abort", revoke);
            }
          });
        }
        if (closed || cancel.signal.aborted) return fail("revoked");
        return Object.freeze(observations);
      }),
    );
    scopes.add(running);
    void running
      .finally(() => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
        cancellation.delete(cancel);
        scopes.delete(running);
      })
      .catch(() => undefined);
    return running;
  }
  function manageRetainedPeerInit(
    execution: V2Execution,
    externalSignal?: AbortSignal,
  ): Promise<
    readonly (LinuxOciPeerInitProgress | LinuxOciParentHResult | LinuxOciApplicationOwnerExit)[]
  > {
    if (closed || !peerMode)
      return Promise.reject(new Error("linux_oci_owned_bundle_parent_unavailable"));
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
      return Promise.reject(new Error("linux_oci_owned_bundle_revoked"));
    const cancel = new AbortController(),
      abort = () => cancel.abort();
    cancellation.add(cancel);
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    const timer = setTimeout(abort, timeout);
    const running = Promise.resolve().then(() =>
      core.withExecution(execution, async () => {
        if (closed || cancel.signal.aborted) return fail("revoked");
        const accepted = await core.readAcceptedExecution(execution);
        if (
          (accepted.action !== "delete" && accepted.action !== "update") ||
          !accepted.retained.length
        )
          return fail("parent_unavailable");
        const observations: (
          | LinuxOciPeerInitProgress
          | LinuxOciParentHResult
          | LinuxOciApplicationOwnerExit
        )[] = [];
        for (const item of accepted.retained) {
          const { record } = item;
          if (record.intent.policy.generation >= accepted.generation) continue;
          if (
            trackedPeer &&
            (accepted.action === "delete" || accepted.action === "update") &&
            record.state === "removed" &&
            item.removedAtMs !== null
          )
            continue;
          if (
            item.removedAtMs !== null ||
            record.state !== "bound" ||
            record.nativeId === null ||
            record.intent.policy.generation >= accepted.generation
          )
            return fail("parent_unavailable");
          const phase =
            accepted.action === "delete" || record.intent.policy.generation < accepted.generation
              ? "remove"
              : "reconcile";
          await core.owner.withAuthority(record, phase, async (held) => {
            const loan = new AbortController(),
              revoke = () => loan.abort();
            cancel.signal.addEventListener("abort", revoke, { once: true });
            held.revocation.addEventListener("abort", revoke, { once: true });
            if (cancel.signal.aborted || held.revocation.aborted) revoke();
            try {
              if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
              // Close admission and start cancellation before native STOP.
              // An unjoined/unknown application stream must not block init
              // retirement. The same runtime retains its cached terminal
              // Promise; Core can save its fulfillment in the current stage
              // before H result, which still gates allocation cleanup.
              // Fresh creators gain no missing I/O fact.
              // The runtime handles rejection on its one cached close.
              void httpRuntimes.get(record.claimId)?.close();
              if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
              // Missing local runtime only selects recovery. Core authenticates
              // a saved same-operation close first, or reads the original process
              // only while that close fact is genuinely missing. Neither is a grant.
              let result:
                | LinuxOciPeerInitProgress
                | LinuxOciParentHResult
                | LinuxOciApplicationOwnerExit;
              if (applicationOwnerPeer && !httpRuntimes.has(record.claimId)) {
                result = await core.readAcceptedApplicationRecovery(
                  execution,
                  record,
                  originalNativeCustody,
                  loan.signal,
                );
              } else {
                result = await core.manageAcceptedPeerInit(
                  execution,
                  record,
                  originalNativeCustody,
                  loan.signal,
                );
              }
              if (!result || closed || loan.signal.aborted || !(await held.stillCurrent()))
                return fail("revoked");
              observations.push(result);
            } finally {
              loan.abort();
              cancel.signal.removeEventListener("abort", revoke);
              held.revocation.removeEventListener("abort", revoke);
            }
          });
        }
        if (closed || cancel.signal.aborted) return fail("revoked");
        return Object.freeze(observations);
      }),
    );
    scopes.add(running);
    void running
      .finally(() => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
        cancellation.delete(cancel);
        scopes.delete(running);
      })
      .catch(() => undefined);
    return running;
  }
  // The normal backend closes over this ORIGINAL creator. Its execution input
  // selects no owner, native session, health callback or publication receipt.
  async function dispatch(
    execution: V2Execution,
    mode: "execute" | "reconcile",
  ): Promise<V2BackendResult> {
    const unknown = (): V2BackendResult => ({ kind: "unknown" });
    if (closed) return unknown();
    const cancel = new AbortController();
    cancellation.add(cancel);
    const timer = setTimeout(() => cancel.abort(), timeout);
    const local = () => {
      if (closed || cancel.signal.aborted) return fail("revoked");
    };
    const running = Promise.resolve().then(async (): Promise<V2BackendResult> => {
      local();
      // Do not nest a second active execution around original creator methods.
      // Each stage enters its own original scope and rereads actual acceptance.
      const accepted = await core.withExecution(execution, () =>
        core.readAcceptedExecution(execution),
      );
      local();
      if (parentMode === "sealed-original@1" && accepted.retained.length) {
        await creator.readRetainedParentControls(execution, cancel.signal);
        local();
      }
      if (
        peerMode &&
        accepted.retained.some(
          (item) => item.record.intent.policy.generation < accepted.generation,
        ) &&
        (accepted.action === "delete" ||
          (accepted.action === "update" && accepted.servingConfirmedAtMs !== null))
      ) {
        await creator.manageRetainedPeerInit(execution, cancel.signal);
        local();
        if (trackedPeer && accepted.action === "delete") {
          await core.withExecution(execution, () =>
            core.finalizeAcceptedDelete(execution, originalNativeCustody, cancel.signal),
          );
          local();
          return { kind: "complete", observed: {}, output: {} };
        }
        if (!trackedPeer || accepted.action !== "update") return unknown();
        const after = await core.withExecution(execution, () =>
          core.readAcceptedExecution(execution),
        );
        local();
        if (
          after.retained.some(
            (item) =>
              item.record.intent.policy.generation < after.generation &&
              item.record.state !== "removed",
          )
        )
          return unknown();
      }
      if (accepted.action === "delete") {
        await creator.disposeRetainedBornOwners(execution, cancel.signal);
        local();
        await creator.disposeRetainedAllocations(execution, cancel.signal);
        local();
        // Original tracked destruction/local disposal/helper join are factual.
        // Full lifetime retirement and removed CAS are not supplied here.
        return unknown();
      }
      const current = accepted.retained.find(
        ({ record }) => record.intent.policy.generation === accepted.generation,
      );
      if (!current) {
        // A reconcile lease cannot infer that an earlier send cannot arrive.
        // Original CREATE and START run only on this first unsent dispatch.
        if (mode !== "execute" && !(trackedPeer && accepted.action === "update")) return unknown();
        await creator.createAcceptedStopped(execution);
        local();
        await creator.startAccepted(execution);
        local();
      } else if (
        current.removedAtMs !== null ||
        current.record.state !== "bound" ||
        current.record.nativeId === null ||
        !nativeSessions.has(current.record.claimId) ||
        nativeBindings.get(current.record.claimId) !== current.record.nativeId
      )
        return unknown();
      // Existing/pending claims never send CREATE or START. Only this private
      // creator's actual running attempt can pass the original HTTP publisher.
      await creator.publishAcceptedServing(execution, cancel.signal);
      local();
      if (
        trackedPeer &&
        accepted.action === "update" &&
        accepted.retained.some(
          (item) =>
            item.record.intent.policy.generation < accepted.generation &&
            item.record.state !== "removed",
        )
      )
        return unknown();
      const result = await core.withExecution(execution, async (): Promise<V2BackendResult> => {
        const fresh = await core.readAcceptedExecution(execution);
        const serving = fresh.retained.find(
          ({ record }) => record.intent.policy.generation === fresh.generation,
        );
        const allocation = serving && allocations.get(serving.record.claimId);
        if (
          fresh.action === "delete" ||
          fresh.servingConfirmedAtMs === null ||
          !serving ||
          serving.removedAtMs !== null ||
          serving.record.state !== "bound" ||
          serving.record.nativeId === null ||
          serving.record.intent.incarnationId !== fresh.incarnationId ||
          serving.record.intent.revision !== fresh.revision ||
          !allocation ||
          allocation.cleanup !== "untouched" ||
          allocation.intent !== canonicalJson(serving.record.intent) ||
          !nativeSessions.has(serving.record.claimId) ||
          nativeBindings.get(serving.record.claimId) !== serving.record.nativeId ||
          typeof fresh.spec.image !== "string"
        )
          return unknown();
        // readAcceptedExecution additionally requires the matching actual
        // running START row whenever this generation is published as serving.
        local();
        const fields = CONTAINER_CONTRACT.fields;
        return {
          kind: "complete",
          observed: {
            [fields.ready]: true,
            [fields.servingGeneration]: fresh.generation,
            [fields.imageDigest]: allocation.manifestDigest,
          },
          output: {},
        };
      });
      local();
      return result;
    });
    scopes.add(running);
    void running
      .finally(() => {
        clearTimeout(timer);
        cancellation.delete(cancel);
        scopes.delete(running);
      })
      .catch(() => undefined);
    try {
      const result = await running;
      local();
      return result;
    } catch {
      return unknown();
    }
  }
  const validate = (spec: JsonObject) => {
    validateDockerContainerSpec(spec);
  };
  const retainedForm: V2Form = Object.freeze({
    validateCreate: validate,
    validateUpdate(_previous: JsonObject, spec: JsonObject) {
      validate(spec);
    },
    privateInputs: Object.freeze({
      validateCreate(spec: JsonObject, values: V2Execution["privateInputs"]) {
        validateDockerContainerPrivateInputs(
          validateDockerContainerSpec(spec).requiredSensitiveVars,
          values,
        );
      },
      validateUpdate(
        _previous: JsonObject,
        spec: JsonObject,
        values: V2Execution["privateInputs"],
      ) {
        const names = validateDockerContainerSpec(spec).requiredSensitiveVars;
        if (values !== undefined) validateDockerContainerPrivateInputs(names, values);
      },
      prepareCreate: configured.prepareCreate,
      prepareUpdate: configured.prepareUpdate,
    }),
    rejectDeleteWhileReferenced: true,
    backend: Object.freeze({
      id: options.backendId,
      targetKey: options.targetKey,
      execute: (execution: V2Execution) => dispatch(execution, "execute"),
      reconcile: (execution: V2Execution) => dispatch(execution, "reconcile"),
    }),
  });
  function selectServingHttpRuntime(
    identity: { readonly resourceUid: string; readonly incarnationId: string },
    request: Request,
    expectedGeneration?: number,
  ) {
    if (closed || !identity || !(request instanceof Request))
      return Promise.reject(new Error("linux_oci_owned_bundle_revoked"));
    const selected = [...httpRecords.values()].filter(
      (record) =>
        record.intent.resourceUid === identity.resourceUid &&
        record.intent.incarnationId === identity.incarnationId &&
        (expectedGeneration === undefined ||
          record.intent.policy.generation === expectedGeneration),
    );
    // Core's fresh serving read chooses no fallback generation. If several
    // original revisions exist, only its actual serving generation can send.
    return (async () => {
      let selectedRuntime: ReturnType<typeof createLinuxOciContainerHttpRuntime> | undefined;
      for (const record of selected) {
        try {
          await core.observeServingOciHttp(record, originalNativeCustody, request.signal);
        } catch {
          continue;
        }
        if (selectedRuntime) return fail("http_custody");
        const runtime = httpRuntimes.get(record.claimId);
        if (!runtime) return fail("http_custody");
        selectedRuntime = runtime;
      }
      if (closed || request.signal.aborted || !selectedRuntime) return fail("http_custody");
      return selectedRuntime;
    })();
  }
  const creator = Object.freeze({
    /** Private observation of a current same-Sql original. The result does
     * not register a replacement session or enable the application transport. */
    async readCurrentLiveInit(
      identity: { readonly resourceUid: string; readonly incarnationId: string },
      signal: AbortSignal,
    ): Promise<LinuxOciOriginalLiveInit> {
      if (closed || !runtimeApplicationOwner || !physicalBinary) return fail("parent_custody");
      if (!(signal instanceof AbortSignal) || signal.aborted) return fail("revoked");
      const cancel = new AbortController();
      const abort = () => cancel.abort();
      cancellation.add(cancel);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeout);
      const running = core.readCurrentOciInitForResource(
        identity,
        originalNativeCustody,
        cancel.signal,
      );
      scopes.add(running);
      try {
        const fact = await running;
        if (closed || cancel.signal.aborted) return fail("revoked");
        return fact;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        cancellation.delete(cancel);
        scopes.delete(running);
      }
    },
    /** Private held source. This registration has no transport admission. */
    async openCurrentHeldLiveInit(
      identity: { readonly resourceUid: string; readonly incarnationId: string },
      signal: AbortSignal,
    ): Promise<LinuxOciHeldLiveInit> {
      if (closed || !runtimeApplicationOwner || !physicalBinary) return fail("parent_custody");
      if (!(signal instanceof AbortSignal) || signal.aborted) return fail("revoked");
      const cancel = new AbortController();
      const abort = () => cancel.abort();
      cancellation.add(cancel);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeout);
      let retained = false;
      const running = (async () => {
        const held = await core.openCurrentApplicationSuccessorLiveInit(
          identity,
          originalNativeCustody,
          cancel.signal,
        );
        if (closed || cancel.signal.aborted || held.revocation.aborted) {
          await held.close().catch(() => undefined);
          return fail("revoked");
        }
        held.revocation.addEventListener(
          "abort",
          () => signal.removeEventListener("abort", abort),
          { once: true },
        );
        retained = true;
        return held;
      })();
      scopes.add(running);
      try {
        return await running;
      } finally {
        clearTimeout(timer);
        cancellation.delete(cancel);
        scopes.delete(running);
        if (!retained) signal.removeEventListener("abort", abort);
      }
    },
    /** Private connection for a caller whose binding owner authorizes each
     * invocation. Its lifetime belongs to this creator, not a request. */
    async openCurrentSuccessorServingHttp(
      selector: {
        readonly resourceUid: string;
        readonly incarnationId: string;
        readonly generation: number;
      },
      signal: AbortSignal,
    ) {
      if (closed || !runtimeApplicationOwner || !physicalBinary) return fail("parent_custody");
      if (!(signal instanceof AbortSignal) || signal.aborted) return fail("revoked");
      const identity = Object.freeze({
        resourceUid: selector.resourceUid,
        incarnationId: selector.incarnationId,
      });
      const generation = selector.generation;
      const cancel = new AbortController();
      const abort = () => cancel.abort();
      cancellation.add(cancel);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeout);
      const running = (async () => {
        const { held, record, httpPort } = await core.openCurrentApplicationSuccessorHttp(
          identity,
          generation,
          originalNativeCustody,
          cancel.signal,
        );
        try {
          // The held read checks the original accepted topology and latest open
          // reservation. Its successful read alone never registers a runtime.
          await held.readOriginalTopology(cancel.signal);
          if (closed || cancel.signal.aborted || held.revocation.aborted) return fail("revoked");
          const runtime = createLinuxOciContainerHttpRuntime(originalNativeCustody, core, record);
          let reading = Promise.resolve();
          let joining: Promise<void> | undefined;
          const assertLocal = (actualSignal: AbortSignal) => {
            if (
              closed ||
              joining ||
              cancel.signal.aborted ||
              held.revocation.aborted ||
              actualSignal.aborted ||
              successorHttp.get(record) !== source
            )
              return fail("revoked");
          };
          const source: OriginalOciSuccessorHttp = {
            read(actualSignal) {
              const check = reading.then(async () => {
                assertLocal(actualSignal);
                // A caller cancellation cannot revoke the shared connector.
                const { topology } = await held.readOriginalTopology(cancel.signal);
                assertLocal(actualSignal);
                return {
                  nativeId: held.identity.nativeId,
                  endpoint: `http://${topology.peerIpv4Guest}:${httpPort}/`,
                  assertLocal: () => assertLocal(actualSignal),
                };
              });
              reading = check.then(
                () => undefined,
                () => undefined,
              );
              return check;
            },
            close() {
              joining ??= Promise.resolve().then(async () => {
                const [io] = await Promise.allSettled([runtime.close()]);
                await reading;
                const [connector] = await Promise.allSettled([held.close()]);
                if (io.status === "rejected") throw io.reason;
                if (connector.status === "rejected") throw connector.reason;
              });
              return joining;
            },
          };
          successorHttp.set(record, source);
          held.revocation.addEventListener(
            "abort",
            () => {
              void source.close().catch(() => undefined);
            },
            { once: true },
          );
          return Object.freeze({
            open: runtime.open,
            close: source.close,
          });
        } catch (error) {
          await held.close().catch(() => undefined);
          throw error;
        }
      })();
      scopes.add(running);
      try {
        return await running;
      } finally {
        clearTimeout(timer);
        cancellation.delete(cancel);
        signal.removeEventListener("abort", abort);
        scopes.delete(running);
      }
    },
    /** Internal application transport. Identity is a selector to revalidate,
     * never caller authorization; a real binding composition must authorize it. */
    fetchServingHttp(
      identity: { readonly resourceUid: string; readonly incarnationId: string },
      request: Request,
    ) {
      return selectServingHttpRuntime(identity, request).then((runtime) => runtime.fetch(request));
    },
    /** The binding has already selected a serving generation. The private
     * caller retains this same invocation through actual terminal I/O. */
    openServingHttp(
      identity: {
        readonly resourceUid: string;
        readonly incarnationId: string;
        readonly generation: number;
      },
      request: Request,
      refuseIfRevoked: () => void,
    ) {
      const generation = identity?.generation;
      if (!Number.isSafeInteger(generation) || generation < 1)
        return Promise.reject(new Error("linux_oci_owned_bundle_http_custody"));
      return selectServingHttpRuntime(identity, request, generation).then((runtime) =>
        runtime.open(request, refuseIfRevoked),
      );
    },
    /** Original same-Sql binding readback only; no restart peer/session adoption. */
    readRetainedParentControls,
    /** Authenticated original peer result data only; no native/removed adoption. */
    readRetainedPeerResults,
    /** Original same-P first init phase only; never an exited/removed Sql CAS. */
    manageRetainedPeerInit,
    /** Internal normal Form only; no registration or Node entry activation. */
    formUrl: V2_CONTAINER_F2_FORM,
    retainedForm,
    acceptance: artifact.acceptance,
    configuredInputs: artifact.configuredInputs,
    withAcceptedBundle: artifact.withAcceptedBundle,
    async createAcceptedStopped(execution: V2Execution): Promise<LinuxOciStoppedObservation> {
      if (physicalBinary === undefined) return fail("physical_not_configured");
      return artifact.withAcceptedBundle(execution, async (bundle) => {
        await bundle.guard();
        if (nativeSessions.has(bundle.record.claimId)) return fail("retained_create_unknown");
        const allocation = await captureOriginalAllocation(
          artifactRoot,
          bundle,
          topologies === undefined
            ? undefined
            : linuxOciGenerationTopology(topologies, bundle.record.intent.policy.generation),
        );
        await bundle.guard();
        // The preceding guard awaited Sql. Recheck synchronously before the
        // constructor's first process effect; registration below has no await.
        if (closed || bundle.signal.aborted) return fail("closed");
        if (allocations.has(bundle.record.claimId)) return fail("retained_create_unknown");
        allocations.set(bundle.record.claimId, allocation);
        // This exact original factory constructs the transport; callers cannot
        // supply an owner, process, physical observation or verification port.
        const { receipt } = bundle;
        const request: LinuxOciCreateStoppedRequest = {
          allocationRoot: bundle.allocationRoot,
          claimId: receipt.claimId,
          installationId: receipt.installationId,
          resourceUid: receipt.resourceUid,
          incarnationId: receipt.incarnationId,
          generation: receipt.generation,
          revision: receipt.revision,
          sourceDigest: receipt.sourceDigest,
          manifestDigest: allocation.manifestDigest,
          configDigest: receipt.configDigest,
          archiveDigest: receipt.archiveDigest,
          args: bundle.argv,
          env: bundle.environment,
          cwd: bundle.cwd,
          uid: bundle.uid,
          gid: bundle.gid,
          memoryBytes: bundle.memoryBytes,
          nanoCpus: bundle.nanoCpus,
          pidsLimit: bundle.pidsLimit,
        };
        let session: LinuxOciPhysicalSession;
        let observation: LinuxOciStoppedObservation;
        let parent: LinuxOciParentBootstrap | undefined;
        if (parentMode === "sealed-original@1" || peerMode) {
          parent = createLinuxOciParentBootstrap({
            binary: physicalBinary,
            ...(runtimeApplicationOwner && qualifiedPhysicalDigest !== undefined
              ? { qualifiedPhysicalDigest }
              : {}),
            ...(peerMode
              ? {
                  peerProfile:
                    parentMode === "sealed-peer-runtime-application-owner@1"
                      ? ("pidfs64-runtime-application-owner@1" as const)
                      : parentMode === "sealed-peer-application-owner@1"
                        ? ("pidfs64-application-owner@1" as const)
                        : parentMode === "sealed-peer-local-cleanup@1"
                          ? ("pidfs64-local-cleanup@1" as const)
                          : parentMode === "sealed-peer-runtime@1"
                            ? ("pidfs64-runtime@1" as const)
                            : ("pidfs64@1" as const),
                }
              : {}),
            claimId: receipt.claimId,
            generation: receipt.generation,
            capability: crypto.getRandomValues(new Uint8Array(32)),
            lifetimeSignal: nativeLifetime.signal,
          });
          const entry = Object.freeze({
            parent,
            record: bundle.record,
            receipt,
          });
          parents.set(bundle.record.claimId, entry);
          originalParentRequests.set(entry, Object.freeze(request));
          try {
            await parent.bootstrap(bundle.signal);
            await bundle.guard();
            await core.saveAcceptedParentControl(
              bundle.record,
              originalNativeCustody,
              bundle.signal,
            );
            await bundle.guard();
            assertOriginalParent.call(parent, bundle.signal);
            if (closed || bundle.signal.aborted) return fail("closed");
            const actual = await createOriginalParent.call(parent, request, bundle.signal);
            session = actual.session;
            observation = actual.observation;
          } finally {
            // Success, save failure, cancellation and unknown CREATE all end
            // the original environment loan without extending it to P lifetime.
            originalParentRequests.delete(entry);
          }
        } else {
          session = createLinuxOciPhysicalSession({ binary: physicalBinary });
          nativeSessions.set(bundle.record.claimId, session);
          observation = await session.createStopped(request, bundle.signal);
        }
        nativeSessions.set(bundle.record.claimId, session);
        await bundle.guard();
        if (parent) assertOriginalParent.call(parent, bundle.signal);
        await core.owner.bindNative(bundle.record, observation.nativeId);
        // Only the actual original process result + original owner CAS updates
        // this private expectation. A callback return/DTO never reaches it.
        nativeBindings.set(bundle.record.claimId, observation.nativeId);
        const httpRecord = Object.freeze({
          ...bundle.record,
          nativeId: observation.nativeId,
          state: "bound" as const,
        });
        httpRecords.set(bundle.record.claimId, httpRecord);
        // Pure construction before the next await: every possible invocation
        // and retirement sees THIS already-owned, irreversible admission gate.
        httpRuntimes.set(
          bundle.record.claimId,
          createLinuxOciContainerHttpRuntime(originalNativeCustody, core, httpRecord),
        );
        await bundle.guard();
        if (parent) finishOriginalParent.call(parent, bundle.signal);
        return observation;
      });
    },
    /** Start only this constructor's actual bound private OCI child. The
     * factual result grants no admission, serving publication or completion. */
    startAccepted(execution: V2Execution): Promise<LinuxOciStartedObservation> {
      if (closed) return Promise.reject(new Error("linux_oci_owned_bundle_closed"));
      if (physicalBinary === undefined)
        return Promise.reject(new Error("linux_oci_owned_bundle_physical_not_configured"));
      const cancel = new AbortController();
      cancellation.add(cancel);
      const timer = setTimeout(() => cancel.abort(), timeout);
      const running = Promise.resolve().then(() =>
        core.withExecution(execution, async () => {
          const accepted = await core.readAcceptedExecution(execution);
          if (accepted.action === "delete") return fail("not_create");
          const current = accepted.retained.find(
            ({ record }) => record.intent.policy.generation === accepted.generation,
          );
          if (
            !current ||
            current.record.state !== "bound" ||
            current.record.nativeId === null ||
            current.removedAtMs !== null
          )
            return fail("retained_native_unknown");
          const { record } = current;
          const nativeId = nativeBindings.get(record.claimId);
          const session = nativeSessions.get(record.claimId);
          if (
            !session ||
            nativeId === undefined ||
            nativeId !== record.nativeId ||
            record.intent.installationId !== accepted.installationId ||
            record.intent.resourceUid !== accepted.resourceUid ||
            record.intent.incarnationId !== accepted.incarnationId ||
            record.intent.revision !== accepted.revision ||
            canonicalJson(record.intent.policy) !== canonicalJson(await acceptedPolicy(accepted)) ||
            canonicalJson(record.intent.requiredSecretNames) !==
              canonicalJson(accepted.requiredSecretNames)
          )
            return fail("retained_native_unknown");
          return core.owner.withAuthority(record, "reconcile", async (held) =>
            held.withEnvironment(async (_values, signal) => {
              const loan = new AbortController();
              const abort = () => loan.abort();
              signal.addEventListener("abort", abort, { once: true });
              cancel.signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted || cancel.signal.aborted) abort();
              const guard = async () => {
                if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                  return fail("revoked");
                const fresh = await core.readAcceptedExecution(execution);
                const retained = fresh.retained.find(
                  ({ record: saved }) => saved.claimId === record.claimId,
                );
                if (
                  closed ||
                  loan.signal.aborted ||
                  fresh.generation !== accepted.generation ||
                  fresh.incarnationId !== accepted.incarnationId ||
                  fresh.revision !== accepted.revision ||
                  !retained ||
                  retained.removedAtMs !== null ||
                  canonicalJson(retained.record) !== canonicalJson(record) ||
                  nativeSessions.get(record.claimId) !== session ||
                  nativeBindings.get(record.claimId) !== nativeId
                )
                  return fail("revoked");
              };
              try {
                await guard();
                const stopped = await session.observeStopped(loan.signal);
                if (stopped.nativeId !== nativeId) return fail("retained_native_unknown");
                await guard();
                const claim = await core.claimAcceptedStart(record);
                if (claim !== "claimed") return fail("retained_start_unknown");
                await guard();
                const started = await session.startStopped(loan.signal);
                if (started.nativeId !== nativeId) return fail("retained_native_unknown");
                await guard();
                const fresh = await core.confirmAcceptedRunning(
                  record,
                  originalNativeCustody,
                  loan.signal,
                );
                if (fresh.nativeId !== nativeId) return fail("retained_native_unknown");
                await guard();
                return fresh;
              } finally {
                loan.abort();
                signal.removeEventListener("abort", abort);
                cancel.signal.removeEventListener("abort", abort);
              }
            }),
          );
        }),
      );
      // Register before the original first Sql await. Original close cancels and
      // joins this exact scope before collecting and closing private sessions.
      scopes.add(running);
      void running
        .finally(() => {
          clearTimeout(timer);
          cancellation.delete(cancel);
          scopes.delete(running);
        })
        .catch(() => undefined);
      return running;
    },
    observeAcceptedHttpHealth,
    /** Original fixed HTTP exchange followed by a fresh native/START-bound
     * serving CAS. No caller-supplied health/status receipt is consumed. */
    publishAcceptedServing(execution: V2Execution, externalSignal?: AbortSignal): Promise<void> {
      if (closed) return Promise.reject(new Error("linux_oci_owned_bundle_closed"));
      if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
        return Promise.reject(new Error("linux_oci_owned_bundle_revoked"));
      const cancel = new AbortController();
      const abort = () => cancel.abort();
      cancellation.add(cancel);
      externalSignal?.addEventListener("abort", abort, { once: true });
      if (externalSignal?.aborted) abort();
      const timer = setTimeout(abort, timeout);
      const local = () => {
        if (closed || cancel.signal.aborted) return fail("revoked");
      };
      const running = Promise.resolve().then(async () => {
        local();
        // This is the closed-over original implementation, not an overridable
        // method/callback or a returned status supplied by a caller.
        await observeAcceptedHttpHealth(execution, cancel.signal);
        local();
        await core.withExecution(execution, async () => {
          const accepted = await core.readAcceptedExecution(execution);
          if (accepted.action === "delete") return fail("not_create");
          const current = accepted.retained.find(
            ({ record }) => record.intent.policy.generation === accepted.generation,
          );
          if (
            !current ||
            current.removedAtMs !== null ||
            current.record.state !== "bound" ||
            current.record.nativeId === null
          )
            return fail("retained_native_unknown");
          const { record } = current;
          const session = nativeSessions.get(record.claimId),
            nativeId = nativeBindings.get(record.claimId);
          if (
            !session ||
            nativeId === undefined ||
            nativeId !== record.nativeId ||
            record.intent.installationId !== accepted.installationId ||
            record.intent.resourceUid !== accepted.resourceUid ||
            record.intent.incarnationId !== accepted.incarnationId ||
            record.intent.revision !== accepted.revision ||
            canonicalJson(record.intent.policy) !== canonicalJson(await acceptedPolicy(accepted)) ||
            canonicalJson(record.intent.requiredSecretNames) !==
              canonicalJson(accepted.requiredSecretNames)
          )
            return fail("retained_native_unknown");
          await core.owner.withAuthority(record, "reconcile", async (held) => {
            await held.withEnvironment(async (_values, signal) => {
              const loan = new AbortController();
              const revoke = () => loan.abort();
              signal.addEventListener("abort", revoke, { once: true });
              cancel.signal.addEventListener("abort", revoke, { once: true });
              if (signal.aborted || cancel.signal.aborted) revoke();
              const guard = async () => {
                local();
                if (loan.signal.aborted || !(await held.stillCurrent())) return fail("revoked");
                const fresh = await core.readAcceptedExecution(execution);
                const saved = fresh.retained.find(
                  ({ record: item }) => item.claimId === record.claimId,
                );
                if (
                  fresh.generation !== accepted.generation ||
                  fresh.revision !== accepted.revision ||
                  fresh.incarnationId !== accepted.incarnationId ||
                  !saved ||
                  saved.removedAtMs !== null ||
                  canonicalJson(saved.record) !== canonicalJson(record) ||
                  nativeSessions.get(record.claimId) !== session ||
                  nativeBindings.get(record.claimId) !== nativeId
                )
                  return fail("revoked");
                local();
                if (loan.signal.aborted) return fail("revoked");
              };
              try {
                await guard();
                await core.publishAcceptedOciServing(record, originalNativeCustody, loan.signal);
                await guard();
              } finally {
                loan.abort();
                signal.removeEventListener("abort", revoke);
                cancel.signal.removeEventListener("abort", revoke);
              }
            });
            local();
            if (held.revocation.aborted) return fail("revoked");
          });
          local();
        });
        local();
      });
      scopes.add(running);
      void running
        .finally(() => {
          clearTimeout(timer);
          externalSignal?.removeEventListener("abort", abort);
          cancellation.delete(cancel);
          scopes.delete(running);
        })
        .catch(() => undefined);
      return running;
    },
    /** Only the accepted retained generations eligible for the ORIGINAL
     * remove lease. Reaping records exit, never full drain or DELETE. */
    stopRetainedInit(
      execution: V2Execution,
      externalSignal?: AbortSignal,
    ): Promise<readonly LinuxOciInitReapedObservation[]> {
      if (closed) return Promise.reject(new Error("linux_oci_owned_bundle_closed"));
      if (physicalBinary === undefined)
        return Promise.reject(new Error("linux_oci_owned_bundle_physical_not_configured"));
      if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
        return Promise.reject(new Error("linux_oci_owned_bundle_revoked"));
      const cancel = new AbortController();
      cancellation.add(cancel);
      const abort = () => cancel.abort();
      externalSignal?.addEventListener("abort", abort, { once: true });
      if (externalSignal?.aborted) abort();
      const running = Promise.resolve().then(() =>
        core.withExecution(execution, async () => {
          if (closed || cancel.signal.aborted) return fail("revoked");
          const accepted = await core.readAcceptedExecution(execution);
          if (accepted.action !== "delete" && accepted.action !== "update")
            return fail("not_retirement");
          const retained = accepted.retained.filter(
            ({ record }) => record.intent.policy.generation < accepted.generation,
          );
          if (!retained.length) return fail("retained_native_unknown");
          const expectedPolicy = await acceptedPolicy(accepted);
          // Validate every original private association and policy before IO.
          // Current Host settings cannot stand in for a different old owner.
          for (const item of retained) {
            const { record } = item;
            if (
              item.removedAtMs !== null ||
              record.state !== "bound" ||
              record.nativeId === null ||
              record.intent.installationId !== accepted.installationId ||
              record.intent.resourceUid !== accepted.resourceUid ||
              record.intent.incarnationId !== accepted.incarnationId ||
              record.intent.policy.tenantRef !== accepted.principal ||
              record.intent.policy.policyDigest !== expectedPolicy.policyDigest ||
              !nativeSessions.has(record.claimId) ||
              nativeBindings.get(record.claimId) !== record.nativeId
            )
              return fail("retained_native_unknown");
          }
          const observations: LinuxOciInitReapedObservation[] = [];
          for (const { record } of retained) {
            if (closed || cancel.signal.aborted) return fail("revoked");
            await core.owner.withAuthority(record, "remove", async (held) => {
              const loan = new AbortController();
              const revoke = () => loan.abort();
              cancel.signal.addEventListener("abort", revoke, { once: true });
              held.revocation.addEventListener("abort", revoke, { once: true });
              if (cancel.signal.aborted || held.revocation.aborted) revoke();
              try {
                if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                  return fail("revoked");
                const observation = await core.stopRetainedInit(
                  execution,
                  record,
                  originalNativeCustody,
                  loan.signal,
                );
                if (closed || loan.signal.aborted || !(await held.stillCurrent()))
                  return fail("revoked");
                if (closed || loan.signal.aborted) return fail("revoked");
                observations.push(observation);
              } finally {
                loan.abort();
                cancel.signal.removeEventListener("abort", revoke);
                held.revocation.removeEventListener("abort", revoke);
              }
            });
            if (closed || cancel.signal.aborted) return fail("revoked");
          }
          if (closed || cancel.signal.aborted) return fail("revoked");
          return Object.freeze(observations);
        }),
      );
      // The response budget is the original physical session's 20 seconds per
      // request; C JOIN has a 10-second poll plus synchronous checks. Neither
      // elapsed time nor cancellation is a completed join/exit observation.
      scopes.add(running);
      void running
        .finally(() => {
          externalSignal?.removeEventListener("abort", abort);
          cancellation.delete(cancel);
          scopes.delete(running);
        })
        .catch(() => undefined);
      return running;
    },
    /** Factual cleanup only, under the ORIGINAL accepted/remove scope. */
    releaseRetainedNamespaces(execution: V2Execution, signal?: AbortSignal) {
      return retainedNamespaceObservations(execution, signal, "release");
    },
    /** Reads the same owner after a prior release request; never starts cleanup. */
    observeRetainedNamespaceLifetimes(execution: V2Execution, signal?: AbortSignal) {
      return retainedNamespaceObservations(execution, signal, "observe");
    },
    /** Original accepted/remove custody only. No returned fact grants removal. */
    disposeRetainedBornOwners(execution: V2Execution, signal?: AbortSignal) {
      return retainedNamespaceObservations(execution, signal, "dispose");
    },
    /** Local original allocation only; neither a claim tombstone nor slot reuse. */
    disposeRetainedAllocations(execution: V2Execution, signal?: AbortSignal) {
      return retainedNamespaceObservations(execution, signal, "allocation");
    },
    close(): Promise<void> {
      // Fence application admission/cancel real I/O immediately, rather than
      // waiting for an unrelated native/helper or artifact join to finish.
      const invocationJoins = Promise.allSettled(
        [...httpRuntimes.values()].map((runtime) => runtime.close()),
      );
      if (physicalBinary === undefined) return artifact.close();
      if (runtimeApplicationOwner) {
        closed = true;
        for (const cancel of cancellation) cancel.abort();
      }
      if (!nativeClosing) {
        const successorJoins = Promise.allSettled(
          [...successorHttp.values()].map((source) => source.close()),
        );
        const attempt = (async () => {
          if (runtimeApplicationOwner) {
            // Complete already-owned scopes without revoking the original
            // runtime identity needed to record the shutdown fact.
            await Promise.allSettled([...scopes]);
            const successorFailure = (await successorJoins).find(
              (result) => result.status === "rejected",
            );
            if (successorFailure) throw successorFailure.reason;
            if (heldLiveInits.size) {
              const held = await Promise.allSettled(
                [...heldLiveInits].map((source) => source.close()),
              );
              const heldFailure = held.find((outcome) => outcome.status === "rejected");
              if (heldFailure) throw heldFailure.reason;
            }
            if (parents.size || nativeSessions.size) {
              const custody = originalOciCustodies.get(originalNativeCustody);
              if (!custody || !(await inspectV2ContainerOwnerShutdownIoSchema(sql)))
                return fail("parent_control_retained");
              const claims = new Set([...parents.keys(), ...nativeSessions.keys()]);
              const outcomes = await Promise.allSettled(
                [...claims].map(async (claimId) => {
                  const record = httpRecords.get(claimId);
                  const session = nativeSessions.get(claimId);
                  const runtime = httpRuntimes.get(claimId);
                  if (!record || !session || !runtime || !parents.has(claimId))
                    return fail("parent_control_retained");
                  const rows = await sql.query(
                    "SELECT state,allocation_cleanup,removed_at_ms FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND native_id=?",
                    [
                      record.intent.resourceUid,
                      record.intent.policy.generation,
                      record.claimId,
                      record.nativeId,
                    ],
                  );
                  if (rows.length !== 1) return fail("parent_control_retained");
                  const current = rows[0];
                  if (
                    current?.state === "removed" &&
                    current.allocation_cleanup === "closed" &&
                    Number.isSafeInteger(current.removed_at_ms)
                  )
                    return; // Existing terminal custody belongs to this exact claim.
                  if (current?.state !== "bound" || custody.peerReads.has(claimId))
                    return fail("parent_control_retained");
                  await httpProbes.get(claimId)?.close();
                  await runtime.close();
                  // Save the I/O close only after the original P stdin has
                  // finished. The successor verifies the accepted DELETE
                  // and exact original P before issuing its first STOP.
                  await detachOriginalLinuxOciRuntimePeer(session, nativeLifetime.signal);
                  await core.saveOriginalShutdownIoClose(
                    record,
                    originalNativeCustody,
                    nativeLifetime.signal,
                  );
                }),
              );
              const rejected = outcomes.find((outcome) => outcome.status === "rejected");
              if (rejected) throw rejected.reason;
              return artifact.close();
            }
          }
          const original = await Promise.allSettled([artifact.close()]);
          // A constructor can reenter close through its raw spawn boundary.
          // Collect only AFTER original scopes join, never an initial empty map.
          const physical = await Promise.allSettled(
            [...nativeSessions.values()].map((session) =>
              disposedHelpers.has(session)
                ? closeOriginalOciDisposedHelper.call(session)
                : session.close(),
            ),
          );
          const http = await Promise.allSettled(
            [...httpProbes].map(async ([claimId, probe]) => {
              await probe.close();
              if (httpProbes.get(claimId) === probe) httpProbes.delete(claimId);
            }),
          );
          const peers = await Promise.allSettled(
            [...(originalOciCustodies.get(originalNativeCustody)?.peerReads.values() ?? [])].map(
              (entry) => entry.settlement,
            ),
          );
          const invocations = await Promise.allSettled(
            [...httpRuntimes.values()].map((runtime) => runtime.close()),
          );
          const rejected = [
            ...original,
            ...physical,
            ...http,
            ...peers,
            ...invocations,
            ...(await invocationJoins),
          ].find((result) => result.status === "rejected");
          if (rejected?.status === "rejected") throw rejected.reason;
          if (parents.size) return fail("parent_control_retained"); // P/result reader is a separate next producer.
        })();
        nativeClosing = attempt;
        void attempt.catch(() => {
          if (nativeClosing === attempt) nativeClosing = undefined;
        });
      }
      return nativeClosing;
    },
  });
  return creator;
}
