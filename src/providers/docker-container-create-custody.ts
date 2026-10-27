import { isJsonObject } from "../json.ts";
import type {
  DockerContainerNativeIdentity,
  DockerContainerRuntimePolicy,
} from "./docker-container-runtime-preparation.ts";

/** Host-internal native target. This is neither a Form nor a tenant authority grant. */
export interface DockerContainerCreateTarget {
  readonly installationId: string;
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly revision: string;
  readonly nativeName: string;
  readonly identityLabel: string;
  readonly revisionLabel: string;
}

export interface DockerContainerCreateIntent extends DockerContainerCreateTarget {
  readonly policy: DockerContainerRuntimePolicy;
  readonly requiredSecretNames: readonly string[];
}

/** Nonsecret metadata only. The producer privately retains the original accepted
 * principal/space/operation/backend/generation and sealed reference by claimId.
 * A bound native ID records identity, never readiness or authority.
 */
export interface DockerContainerCreateRecord {
  /** Independent cryptographic random 32 bytes, encoded as 64 lowercase hex. */
  readonly claimId: string;
  readonly intent: DockerContainerCreateIntent;
  readonly nativeId: string | null;
  readonly state: "pending" | "bound" | "removed";
}

export type DockerContainerCreatePhase = "reconcile" | "observe" | "remove";

export interface DockerContainerCreateHeldAuthority {
  readonly revocation: AbortSignal;
  stillCurrent(): Promise<boolean>;
  withEnvironment<T>(
    use: (values: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

/** A real Host producer must atomically retain CREATE claims, including unknown
 * ACKs and terminal records, without TTL replay. It must reacquire the SAME held
 * accepted scope/reference on every use; echoed metadata/booleans are not grants.
 * CREATE and START are separate claims in that same owner ledger. Revocation or
 * channel loss must cancel every held invocation, including incumbent serving IO.
 * The public helper supplies no producer, secret store, keyring or grant minting.
 */
export interface DockerContainerCreateOwnerPort {
  read(intent: DockerContainerCreateIntent): Promise<DockerContainerCreateRecord | null>;
  claim(intent: DockerContainerCreateIntent): Promise<{
    readonly status: "won" | "existing" | "unknown";
    readonly record: DockerContainerCreateRecord;
  }>;
  withAuthority<T>(
    record: DockerContainerCreateRecord,
    phase: DockerContainerCreatePhase,
    use: (held: DockerContainerCreateHeldAuthority) => Promise<T>,
  ): Promise<T>;
  bindNative(record: DockerContainerCreateRecord, nativeId: string): Promise<void>;
  /** Called only under the held remove authority, only after this helper itself
   * observed the exact bound native object with a positive non-running state, and
   * before any native DELETE. The owner records that observed exit durably for the
   * exact start attempt of this claim; a 404, a timeout, a stop or DELETE ACK, or a
   * caller-supplied boolean is never an observation. It never licenses a restart
   * or another CREATE.
   */
  confirmStopped(
    record: DockerContainerCreateRecord,
    observation: DockerContainerStoppedObservation,
  ): Promise<void>;
  /** Called only after this helper's definite DELETE ACK and exact-ID GET404.
   * This commits a terminal tombstone; it never licenses another CREATE. The owner's
   * schema fence still refuses removal while a start attempt of the claim is pending or
   * running; it is only as good as the exit recorded by confirmStopped, which rests on
   * this helper's observation.
   */
  confirmRemoved(record: DockerContainerCreateRecord, nativeId: string): Promise<void>;
}

/** The exact native identity this helper inspected, with the positive state it saw. */
export interface DockerContainerStoppedObservation {
  readonly native: DockerContainerNativeIdentity;
  readonly state: "stopped";
}

export interface DockerContainerCreateInspection {
  readonly native: DockerContainerNativeIdentity;
  readonly state: "stopped" | "running";
}

/** Trusted Host transport, not a tenant callback. inspect must query nativeId
 * once bound, otherwise the original unique claim-owned name; it must validate
 * image/network/resources/labels before returning. Raw Config.Env is consumed
 * only inside the helper's transient secret callback. Docker necessarily retains
 * plaintext Config.Env; this interface promises no physical zeroization.
 */
export interface DockerContainerCreateDriver {
  inspect(
    record: DockerContainerCreateRecord,
    signal: AbortSignal,
  ): Promise<
    | (DockerContainerCreateInspection & {
        readonly claimId: string;
        readonly environment: readonly string[];
      })
    | null
  >;
  create(
    record: DockerContainerCreateRecord,
    secretOverrides: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<string>;
  /** Stops the exact bound native object. Its ACK is never an observation: the helper
   * inspects the exact ID again and needs a positive non-running state before the owner
   * records an exit.
   */
  stop(
    record: DockerContainerCreateRecord,
    nativeId: string,
    signal: AbortSignal,
  ): Promise<"stopped" | "not-found">;
  /** Deletes the exact bound native object. It never stops it. */
  remove(
    record: DockerContainerCreateRecord,
    nativeId: string,
    signal: AbortSignal,
  ): Promise<"deleted" | "not-found">;
}

/** Usable only within withAuthority. No secret map or borrowed lease escapes. */
export interface DockerContainerCreateSession {
  readonly record: DockerContainerCreateRecord;
  readonly signal: AbortSignal;
  guard(): Promise<void>;
  inspect(): Promise<DockerContainerCreateInspection | null>;
  ensureCreated(): Promise<DockerContainerCreateInspection | null>;
  remove(nativeId: string): Promise<void>;
}

export interface DockerContainerCreateCustodyOptions {
  readonly policy: DockerContainerRuntimePolicy;
  readonly requiredSecretNames: readonly string[];
  readonly owner: DockerContainerCreateOwnerPort;
}

export class DockerContainerCreateCustodyError extends Error {
  constructor(readonly code: "invalid_request" | "conflict" | "unavailable") {
    super(code);
    this.name = "DockerContainerCreateCustodyError";
  }
}

const TARGET_KEYS = [
  "installationId",
  "resourceUid",
  "incarnationId",
  "revision",
  "nativeName",
  "identityLabel",
  "revisionLabel",
] as const;
const POLICY_KEYS = ["tenantRef", "generation", "policyDigest", "outboundInternet"] as const;
const INTENT_KEYS = [...TARGET_KEYS, "policy", "requiredSecretNames"] as const;
const NATIVE_KEYS = [
  "backend",
  "installationId",
  "resourceUid",
  "incarnationId",
  "revision",
  "nativeId",
  "network",
  "networkId",
  "image",
  "imageId",
  "identityLabel",
  "revisionLabel",
] as const;
const ID = /^[a-f0-9]{64}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

function fail(code: "invalid_request" | "conflict" | "unavailable"): never {
  throw new DockerContainerCreateCustodyError(code);
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    })
  );
}
function text(value: unknown, max = 256): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (const char of value) {
    const point = char.charCodeAt(0);
    if (point < 32 || point === 127) return false;
  }
  return true;
}
function policySnapshot(value: DockerContainerRuntimePolicy): DockerContainerRuntimePolicy {
  if (
    !closed(value, POLICY_KEYS) ||
    !text(value.tenantRef) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !SHA256.test(value.policyDigest) ||
    typeof value.outboundInternet !== "boolean"
  )
    return fail("invalid_request");
  return Object.freeze({ ...value });
}
function namesSnapshot(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((name) => typeof name !== "string" || !NAME.test(name)) ||
    new Set(value).size !== value.length
  )
    return fail("invalid_request");
  return Object.freeze([...value]);
}
function targetSnapshot(value: DockerContainerCreateTarget): DockerContainerCreateTarget {
  if (
    !closed(value, TARGET_KEYS) ||
    !TARGET_KEYS.every((key) => text(value[key])) ||
    !/^(?:(?:integration|staging)-)?takoserver-[A-Za-z0-9_.-]+$/u.test(value.nativeName) ||
    !SHA256.test(value.identityLabel) ||
    !SHA256.test(value.revisionLabel)
  )
    return fail("invalid_request");
  return Object.freeze({ ...value });
}
function sameIntent(value: unknown, expected: DockerContainerCreateIntent): boolean {
  if (!closed(value, INTENT_KEYS) || !closed(value.policy, POLICY_KEYS)) return false;
  const policy = value.policy;
  return (
    TARGET_KEYS.every((key) => value[key] === expected[key]) &&
    POLICY_KEYS.every((key) => policy[key] === expected.policy[key]) &&
    Array.isArray(value.requiredSecretNames) &&
    value.requiredSecretNames.length === expected.requiredSecretNames.length &&
    value.requiredSecretNames.every((name, index) => name === expected.requiredSecretNames[index])
  );
}
function recordSnapshot(
  value: unknown,
  intent: DockerContainerCreateIntent,
  claimId?: string,
): DockerContainerCreateRecord {
  if (
    !closed(value, ["claimId", "intent", "nativeId", "state"]) ||
    typeof value.claimId !== "string" ||
    !ID.test(value.claimId) ||
    (claimId !== undefined && value.claimId !== claimId) ||
    !sameIntent(value.intent, intent) ||
    !(
      (value.state === "pending" && value.nativeId === null) ||
      ((value.state === "bound" || value.state === "removed") &&
        typeof value.nativeId === "string" &&
        ID.test(value.nativeId))
    )
  )
    return fail("conflict");
  return Object.freeze({
    claimId: value.claimId,
    intent,
    nativeId: value.nativeId as string | null,
    state: value.state as DockerContainerCreateRecord["state"],
  });
}
function environmentSnapshot(
  value: unknown,
  names: readonly string[],
): Readonly<Record<string, string>> {
  if (!closed(value, names)) return fail("unavailable");
  const copy: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const name of names) {
    const entry = value[name];
    if (typeof entry !== "string" || entry.includes("\0")) return fail("unavailable");
    bytes += new TextEncoder().encode(entry).byteLength;
    if (bytes > 1024 * 1024) return fail("unavailable");
    copy[name] = entry;
  }
  return Object.freeze(copy);
}
function matchesEnvironment(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (!Array.isArray(value)) return false;
  const entries = new Map<string, string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.includes("\0")) return false;
    const equals = entry.indexOf("=");
    if (equals < 1) return false;
    const name = entry.slice(0, equals);
    // Docker public/image environment names can include dots. Only declared
    // secret names use NAME; preserve existing public/image keys without
    // accepting ambiguous duplicates or malformed native entries.
    if (entries.has(name)) return false;
    entries.set(name, entry.slice(equals + 1));
  }
  return Object.keys(expected).every((name) => entries.get(name) === expected[name]);
}
function nativeSnapshot(
  value: unknown,
  record: DockerContainerCreateRecord,
): DockerContainerNativeIdentity {
  if (
    !closed(value, NATIVE_KEYS) ||
    value.backend !== "docker" ||
    !NATIVE_KEYS.every((key) => text(value[key], key === "image" ? 512 : 256)) ||
    !ID.test(String(value.nativeId)) ||
    !ID.test(String(value.networkId)) ||
    !SHA256.test(String(value.imageId)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(String(value.image)) ||
    ["host", "bridge", "none"].includes(String(value.network)) ||
    (record.nativeId !== null && value.nativeId !== record.nativeId) ||
    !(
      [
        "installationId",
        "resourceUid",
        "incarnationId",
        "revision",
        "identityLabel",
        "revisionLabel",
      ] as const
    ).every((key) => value[key] === record.intent[key])
  )
    return fail("conflict");
  return Object.freeze({ ...value }) as unknown as DockerContainerNativeIdentity;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DockerContainerCreateCustodyError("unavailable"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    // Attach both branches even when already aborted, retaining late rejection
    // custody. Cancellation wins if both were settled before this race.
    return await Promise.race([cancelled, promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class DockerContainerCreateCustody {
  readonly policy: DockerContainerRuntimePolicy;
  readonly requiredSecretNames: readonly string[];
  readonly #owner: DockerContainerCreateOwnerPort;

  constructor(options: DockerContainerCreateCustodyOptions) {
    try {
      this.policy = policySnapshot(options.policy);
      this.requiredSecretNames = namesSnapshot(options.requiredSecretNames);
      const owner = options.owner;
      if (
        !owner ||
        !["read", "claim", "withAuthority", "bindNative", "confirmStopped", "confirmRemoved"].every(
          (key) => typeof owner[key as keyof DockerContainerCreateOwnerPort] === "function",
        )
      )
        fail("invalid_request");
      this.#owner = Object.freeze({
        read: owner.read.bind(owner),
        claim: owner.claim.bind(owner),
        withAuthority: owner.withAuthority.bind(owner),
        bindNative: owner.bindNative.bind(owner),
        confirmStopped: owner.confirmStopped.bind(owner),
        confirmRemoved: owner.confirmRemoved.bind(owner),
      });
      Object.freeze(this);
    } catch {
      fail("invalid_request");
    }
  }

  async withAuthority<T>(
    target: DockerContainerCreateTarget,
    phase: DockerContainerCreatePhase,
    driver: DockerContainerCreateDriver,
    use: (session: DockerContainerCreateSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal !== undefined && (!(signal instanceof AbortSignal) || phase !== "remove"))
      return fail("invalid_request");
    if (signal?.aborted) return fail("unavailable");
    let driverSnapshot: DockerContainerCreateDriver;
    let intent: DockerContainerCreateIntent;
    try {
      if (
        !["reconcile", "observe", "remove"].includes(phase) ||
        typeof use !== "function" ||
        !driver ||
        typeof driver.inspect !== "function" ||
        typeof driver.create !== "function" ||
        typeof driver.stop !== "function" ||
        typeof driver.remove !== "function"
      )
        fail("invalid_request");
      intent = Object.freeze({
        ...targetSnapshot(target),
        policy: this.policy,
        requiredSecretNames: this.requiredSecretNames,
      });
      driverSnapshot = Object.freeze({
        inspect: driver.inspect.bind(driver),
        create: driver.create.bind(driver),
        stop: driver.stop.bind(driver),
        remove: driver.remove.bind(driver),
      });
    } catch {
      return fail("invalid_request");
    }
    const owner = this.#owner;
    let record: DockerContainerCreateRecord;
    let won = false;
    try {
      const previous = signal
        ? await abortable(owner.read(intent), signal)
        : await owner.read(intent);
      if (previous !== null) {
        record = recordSnapshot(previous, intent);
      } else {
        if (phase !== "reconcile") return fail("unavailable");
        const claim = await owner.claim(intent);
        if (!closed(claim, ["status", "record"])) return fail("unavailable");
        record = recordSnapshot(claim.record, intent);
        if (!["won", "existing", "unknown"].includes(String(claim.status)))
          return fail("unavailable");
        won = claim.status === "won";
        if (won && record.state !== "pending") return fail("conflict");
      }
      if (record.state === "removed" && phase !== "remove") return fail("conflict");
      let ownerFinished = false;
      let cancelHeld: () => void = () => undefined;
      let invocations = 0;
      let complete = false;
      let result: T | undefined;
      try {
        const heldWork = owner.withAuthority(record, phase, async (held) => {
          if (ownerFinished || signal?.aborted || invocations++ !== 0) return fail("unavailable");
          let active = true;
          const lifetime = new AbortController();
          cancelHeld = () => lifetime.abort();
          let unsubscribe: () => void = () => undefined;
          try {
            const revocation = held.revocation;
            const current = held.stillCurrent;
            const loan = held.withEnvironment;
            if (
              !(revocation instanceof AbortSignal) ||
              typeof current !== "function" ||
              typeof loan !== "function"
            )
              return fail("unavailable");
            const stillCurrent = current.bind(held);
            const withEnvironment = loan.bind(held);
            const revoke = () => lifetime.abort();
            revocation.addEventListener("abort", revoke, { once: true });
            signal?.addEventListener("abort", revoke, { once: true });
            unsubscribe = () => {
              revocation.removeEventListener("abort", revoke);
              signal?.removeEventListener("abort", revoke);
            };
            if (revocation.aborted || signal?.aborted) lifetime.abort();
            const guard = async () => {
              if (ownerFinished || !active || lifetime.signal.aborted) return fail("unavailable");
              const current = await abortable(stillCurrent(), lifetime.signal);
              if (current !== true || ownerFinished || !active || lifetime.signal.aborted)
                return fail("unavailable");
            };
            const transient = async <R>(
              work: (
                environment: Readonly<Record<string, string>>,
                signal: AbortSignal,
              ) => Promise<R>,
            ): Promise<R> => {
              await guard();
              let calls = 0;
              let ended = false;
              let succeeded = false;
              let value: R | undefined;
              try {
                await abortable(
                  withEnvironment(async (environment, secretSignal) => {
                    if (ended || calls++ !== 0 || !(secretSignal instanceof AbortSignal))
                      return fail("unavailable");
                    const values = environmentSnapshot(environment, this.requiredSecretNames);
                    const io = new AbortController();
                    const cancel = () => io.abort();
                    lifetime.signal.addEventListener("abort", cancel, { once: true });
                    secretSignal.addEventListener("abort", cancel, { once: true });
                    if (lifetime.signal.aborted || secretSignal.aborted) io.abort();
                    try {
                      await guard();
                      if (io.signal.aborted) return fail("unavailable");
                      value = await abortable(work(values, io.signal), io.signal);
                      await guard();
                      if (io.signal.aborted) return fail("unavailable");
                      succeeded = true;
                      return value;
                    } finally {
                      io.abort();
                      lifetime.signal.removeEventListener("abort", cancel);
                      secretSignal.removeEventListener("abort", cancel);
                    }
                  }),
                  lifetime.signal,
                );
              } finally {
                ended = true;
              }
              if (calls !== 1 || !succeeded) return fail("unavailable");
              return value as R;
            };
            const bind = async (nativeId: string) => {
              await guard();
              if (record.nativeId !== null && record.nativeId !== nativeId) return fail("conflict");
              if (record.nativeId === null) {
                await abortable(owner.bindNative(record, nativeId), lifetime.signal);
                await guard();
                const saved = recordSnapshot(
                  await abortable(owner.read(intent), lifetime.signal),
                  intent,
                  record.claimId,
                );
                await guard();
                if (saved.state !== "bound" || saved.nativeId !== nativeId) return fail("conflict");
                record = saved;
              }
            };
            const inspect = async (
              environment: Readonly<Record<string, string>>,
              signal: AbortSignal,
            ): Promise<DockerContainerCreateInspection | null> => {
              await guard();
              const raw = await abortable(driverSnapshot.inspect(record, signal), signal);
              await guard();
              if (raw === null) return null;
              if (
                !closed(raw, ["native", "state", "claimId", "environment"]) ||
                raw.claimId !== record.claimId ||
                (raw.state !== "stopped" && raw.state !== "running") ||
                !matchesEnvironment(raw.environment, environment)
              )
                return fail("conflict");
              const native = nativeSnapshot(raw.native, record);
              await bind(native.nativeId);
              return Object.freeze({ native, state: raw.state });
            };
            // Cleanup does not need to open or compare secret values. The
            // original remove hold, exact claim/native identity and immutable
            // intent labels remain mandatory before and after every read/write.
            // A pending claim may only bind an actually discovered same-claim
            // native; GET404 never constitutes retirement.
            const inspectRemoval = async (): Promise<DockerContainerCreateInspection | null> => {
              await guard();
              if (phase !== "remove") return fail("conflict");
              const raw = await abortable(
                driverSnapshot.inspect(record, lifetime.signal),
                lifetime.signal,
              );
              await guard();
              if (raw === null) return null;
              if (
                !closed(raw, ["native", "state", "claimId", "environment"]) ||
                raw.claimId !== record.claimId ||
                (raw.state !== "stopped" && raw.state !== "running")
              )
                return fail("conflict");
              const native = nativeSnapshot(raw.native, record);
              await bind(native.nativeId);
              await guard();
              return Object.freeze({ native, state: raw.state });
            };
            let ensuring: Promise<DockerContainerCreateInspection | null> | undefined;
            let spent = false;
            const session: DockerContainerCreateSession = Object.freeze({
              get record() {
                return record;
              },
              signal: lifetime.signal,
              guard,
              inspect: () => {
                if (record.state === "removed")
                  return Promise.reject(new DockerContainerCreateCustodyError("conflict"));
                return phase === "remove" ? inspectRemoval() : transient(inspect);
              },
              ensureCreated: async () => {
                await guard();
                if (phase !== "reconcile") return fail("conflict");
                ensuring ??= transient(async (environment, signal) => {
                  const existing = await inspect(environment, signal);
                  if (existing !== null || !won || spent) return existing;
                  spent = true;
                  await guard();
                  let acknowledged = false;
                  try {
                    const nativeId = await abortable(
                      driverSnapshot.create(record, environment, signal),
                      signal,
                    );
                    await guard();
                    if (typeof nativeId !== "string" || !ID.test(nativeId)) return null;
                    acknowledged = true;
                    // Pin a known ACK before any subsequent readback. Binding ACK
                    // uncertainty cannot permit following a name replacement.
                    await bind(nativeId);
                  } catch (error) {
                    await guard();
                    // A lost CREATE ACK keeps the original claim. A known ACK or
                    // uncertain binding must not fall back to name discovery.
                    if (
                      acknowledged ||
                      record.nativeId !== null ||
                      error instanceof DockerContainerCreateCustodyError
                    )
                      throw error;
                  }
                  return inspect(environment, signal);
                });
                return ensuring;
              },
              remove: async (nativeId: string) => {
                await guard();
                if (phase !== "remove" || record.nativeId !== nativeId) return fail("conflict");
                if (record.state === "removed") {
                  // A terminal commit can outlive its ACK or the caller's final
                  // guard. Reacquire real cleanup authority and re-read only the
                  // saved exact ID; no secret loan, DELETE, adoption or replay.
                  const absent = await abortable(
                    driverSnapshot.inspect(record, lifetime.signal),
                    lifetime.signal,
                  );
                  await guard();
                  if (absent !== null) return fail("conflict");
                  const saved = recordSnapshot(
                    await abortable(owner.read(intent), lifetime.signal),
                    intent,
                    record.claimId,
                  );
                  await guard();
                  if (saved.state !== "removed" || saved.nativeId !== nativeId)
                    return fail("conflict");
                  record = saved;
                  return;
                }
                if (record.state !== "bound") return fail("conflict");
                // The bound exact ID is already fenced by the original
                // remove authority. No keyring/Env callback is involved.
                {
                  const signal = lifetime.signal;
                  let observed = await inspectRemoval();
                  await guard();
                  if (observed !== null && observed.native.nativeId !== nativeId)
                    return fail("conflict");
                  if (observed !== null && observed.state === "running") {
                    const stopped = await abortable(
                      driverSnapshot.stop(record, nativeId, signal),
                      signal,
                    );
                    await guard();
                    if (stopped !== "stopped" && stopped !== "not-found")
                      return fail("unavailable");
                    // The stop ACK is not an observation. Look at the exact ID again.
                    observed = await inspectRemoval();
                    await guard();
                    if (observed !== null && observed.native.nativeId !== nativeId)
                      return fail("conflict");
                  }
                  if (observed !== null) {
                    // Only a positive non-running state of the exact bound object is
                    // recorded as an exit, and only before the native DELETE. A still
                    // running object is never deleted or recorded. An object that is
                    // already absent proves nothing here: the owner's own removal
                    // fence decides, and no exit is invented for it.
                    if (observed.state !== "stopped") return fail("unavailable");
                    await abortable(
                      owner.confirmStopped(record, { native: observed.native, state: "stopped" }),
                      signal,
                    );
                    await guard();
                    const acknowledgement = await abortable(
                      driverSnapshot.remove(record, nativeId, signal),
                      signal,
                    );
                    await guard();
                    if (acknowledgement !== "deleted" && acknowledgement !== "not-found")
                      return fail("unavailable");
                  }
                  if ((await inspectRemoval()) !== null) return fail("conflict");
                  await guard();
                  await abortable(owner.confirmRemoved(record, nativeId), signal);
                  const removed = recordSnapshot(
                    await abortable(owner.read(intent), signal),
                    intent,
                    record.claimId,
                  );
                  await guard();
                  if (removed.state !== "removed" || removed.nativeId !== nativeId)
                    return fail("conflict");
                  record = removed;
                }
              },
            });
            await guard();
            result = await use(session);
            await guard();
            complete = true;
            return result;
          } finally {
            active = false;
            lifetime.abort();
            unsubscribe();
          }
        });
        if (signal) await abortable(heldWork, signal);
        else await heldWork;
      } finally {
        ownerFinished = true;
        cancelHeld();
      }
      if (signal?.aborted || invocations !== 1 || !complete) return fail("unavailable");
      return result as T;
    } catch (error) {
      if (error instanceof DockerContainerCreateCustodyError) throw error;
      return fail("unavailable");
    }
  }
}

export function createDockerContainerCreateCustody(
  options: DockerContainerCreateCustodyOptions,
): DockerContainerCreateCustody {
  return new DockerContainerCreateCustody(options);
}
