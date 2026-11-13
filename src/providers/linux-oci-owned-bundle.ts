import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { canonicalDigest, canonicalJson, isJsonObject } from "../json.ts";
import type { V2Execution } from "../takoform-v2/types.ts";
import { createDockerContainerConfiguredInputs } from "./docker-container-configured-inputs.ts";
import {
  createDockerContainerCoreOwner,
  type DockerContainerAcceptedExecution,
  type DockerContainerCoreOwner,
  type DockerContainerCoreOwnerOptions,
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
import {
  LINUX_OCI_EGRESS_POLICY_FILE,
  type LinuxOciEgressLimits,
  serializeLinuxOciEgressPolicy,
  snapshotLinuxOciEgressLimits,
} from "./linux-oci-egress-policy.ts";
import {
  LINUX_OCI_HOST_TOPOLOGY_FILE,
  type LinuxOciHostTopology,
  serializeLinuxOciHostTopology,
  snapshotLinuxOciHostTopology,
} from "./linux-oci-host-topology.ts";
import {
  createLinuxOciPhysicalSession,
  type LinuxOciInitReapedObservation,
  type LinuxOciNamespaceLifetimeObservation,
  LinuxOciPhysicalSession,
  type LinuxOciStartedObservation,
  type LinuxOciStoppedObservation,
} from "./linux-oci-physical-session.ts";
import {
  LINUX_OCI_SERVICE_POLICY_FILE,
  serializeLinuxOciServicePolicy,
} from "./linux-oci-service-policy.ts";

type OriginalOciCustody = {
  readonly core: DockerContainerCoreOwner;
  readonly sessions: ReadonlyMap<string, LinuxOciPhysicalSession>;
  readonly bindings: ReadonlyMap<string, string>;
  readonly signal: AbortSignal;
  readonly initStops: Set<string>;
  readonly namespaceReleases: Set<string>;
};
// Populated ONLY inside the real creator below. There is no registration API
// and its opaque keys are never returned to a caller or serialized.
const originalOciCustodies = new WeakMap<object, OriginalOciCustody>();
const observeOriginalOciStarted = LinuxOciPhysicalSession.prototype.observeStarted;
const stopOriginalOciInit = LinuxOciPhysicalSession.prototype.stopInit;
const joinOriginalOciInit = LinuxOciPhysicalSession.prototype.joinInit;
const releaseOriginalOciNamespace = LinuxOciPhysicalSession.prototype.releaseNamespace;
const continueOriginalOciNamespace = LinuxOciPhysicalSession.prototype.continueNamespaceRelease;
const readOriginalOciNamespace = LinuxOciPhysicalSession.prototype.observeNamespaceLifetime;

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
 * callback can replace this producer. This is not a V2 backend or public support;
 * the next native consumer must use these borrowed bytes in this held callback. */
export function createLinuxOciOwnedBundle(options: LinuxOciOwnedBundleOptions) {
  const selectedEgressLimits = options.egressLimits;
  const egressLimits =
    selectedEgressLimits === undefined
      ? undefined
      : snapshotLinuxOciEgressLimits(selectedEgressLimits);
  const selectedHostTopology = options.hostTopology;
  const hostTopology =
    selectedHostTopology === undefined
      ? undefined
      : snapshotLinuxOciHostTopology(selectedHostTopology);
  if (hostTopology !== undefined && egressLimits === undefined)
    return fail("host_topology_requires_egress");
  const core = createDockerContainerCoreOwner(options);
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
  const nativeSessions = new Map<string, LinuxOciPhysicalSession>(),
    nativeBindings = new Map<string, string>();
  const originalNativeCustody = Object.freeze({});
  const nativeLifetime = new AbortController();
  originalOciCustodies.set(originalNativeCustody, {
    core,
    sessions: nativeSessions,
    bindings: nativeBindings,
    signal: nativeLifetime.signal,
    initStops: new Set<string>(),
    namespaceReleases: new Set<string>(),
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
  ): Promise<readonly LinuxOciNamespaceLifetimeObservation[]> {
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
        const observations: LinuxOciNamespaceLifetimeObservation[] = [];
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
              const observation = await (mode === "release"
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
                const claim = await core.owner.claim(intent);
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
                      await writeFile(
                        join(allocationRoot, LINUX_OCI_HOST_TOPOLOGY_FILE),
                        serializeLinuxOciHostTopology(receipt, record, hostTopology),
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
  return Object.freeze({
    acceptance: artifact.acceptance,
    configuredInputs: artifact.configuredInputs,
    withAcceptedBundle: artifact.withAcceptedBundle,
    async createAcceptedStopped(execution: V2Execution): Promise<LinuxOciStoppedObservation> {
      if (physicalBinary === undefined) return fail("physical_not_configured");
      return artifact.withAcceptedBundle(execution, async (bundle) => {
        await bundle.guard();
        if (nativeSessions.has(bundle.record.claimId)) return fail("retained_create_unknown");
        // The preceding guard awaited Sql. Recheck synchronously before the
        // constructor's first process effect; registration below has no await.
        if (closed || bundle.signal.aborted) return fail("closed");
        // This exact original factory constructs the transport; callers cannot
        // supply an owner, process, physical observation or verification port.
        const session = createLinuxOciPhysicalSession({ binary: physicalBinary });
        nativeSessions.set(bundle.record.claimId, session);
        const { receipt } = bundle;
        const observation = await session.createStopped(
          {
            allocationRoot: bundle.allocationRoot,
            claimId: receipt.claimId,
            installationId: receipt.installationId,
            resourceUid: receipt.resourceUid,
            incarnationId: receipt.incarnationId,
            generation: receipt.generation,
            revision: receipt.revision,
            sourceDigest: receipt.sourceDigest,
            manifestDigest: receipt.manifestDigest,
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
          },
          bundle.signal,
        );
        await bundle.guard();
        await core.owner.bindNative(bundle.record, observation.nativeId);
        // Only the actual original process result + original owner CAS updates
        // this private expectation. A callback return/DTO never reaches it.
        nativeBindings.set(bundle.record.claimId, observation.nativeId);
        await bundle.guard();
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
    close(): Promise<void> {
      const joined = artifact.close();
      if (physicalBinary === undefined) return joined;
      if (!nativeClosing) {
        const attempt = (async () => {
          const original = await Promise.allSettled([joined]);
          // A constructor can reenter close through its raw spawn boundary.
          // Collect only AFTER original scopes join, never an initial empty map.
          const physical = await Promise.allSettled(
            [...nativeSessions.values()].map((session) => session.close()),
          );
          const rejected = [...original, ...physical].find(
            (result) => result.status === "rejected",
          );
          if (rejected?.status === "rejected") throw rejected.reason;
        })();
        nativeClosing = attempt;
        void attempt.catch(() => {
          if (nativeClosing === attempt) nativeClosing = undefined;
        });
      }
      return nativeClosing;
    },
  });
}
