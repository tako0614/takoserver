import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { canonicalDigest, canonicalJson, isJsonObject } from "../json.ts";
import type { V2Execution } from "../takoform-v2/types.ts";
import { createDockerContainerConfiguredInputs } from "./docker-container-configured-inputs.ts";
import {
  createDockerContainerCoreOwner,
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
  createLinuxOciPhysicalSession,
  type LinuxOciPhysicalSession,
  type LinuxOciStoppedObservation,
} from "./linux-oci-physical-session.ts";

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
      env: {},
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
          const policy = {
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
