import { bytesDigest, canonicalJson, isSha256Digest } from "../json.ts";
import type {
  V2WorkerInvocationHandle,
  V2WorkerInvocationRecord,
} from "../worker-invocation-port.ts";
import {
  containerParentIoMatchesRecord,
  containerParentIoScope,
  createV2ContainerConsumerParentIoQualifier,
  createV2ContainerParentIoQualifier,
  decodeV2ContainerConsumerParentIoBinding,
  decodeV2ContainerParentIoBinding,
  deriveContainerConsumerParentIoBinding,
  deriveContainerParentIoBinding,
  isContainerConsumerParentIoTarget,
  isContainerParentIoTarget,
  readV2ContainerConsumerParentIoOriginal,
  readV2ContainerParentIoOriginal,
  type V2ContainerConsumerParentIoReadback,
  type V2ContainerConsumerParentIoTarget,
  type V2ContainerParentIoBinding,
  type V2ContainerParentIoBindingScope,
  type V2ContainerParentIoClaim,
  type V2ContainerParentIoParent,
  type V2ContainerParentIoReadback,
  type V2ContainerParentIoTarget,
} from "./container-parent-completion.ts";

interface Transaction {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}
/** Owner-private atomic storage. A transaction resolves only after durable commit. */
export interface V2ContainerParentIoInventoryStorage extends Transaction {
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>;
  list(options: {
    readonly prefix: string;
    readonly startAfter?: string;
    readonly limit: number;
  }): Promise<Map<string, unknown>>;
}
export type V2ContainerParentIoInventoryReadback =
  | { readonly state: "absent" | "open" | "pending" | "unknown" }
  | { readonly state: "sealed_io_complete"; readonly childCount: number }
  /**
   * Every child completed its transport I/O or is `closed`: its fixed owner
   * durably recorded that no native request was ever made with its one-use key
   * (closedCount >= 1; with no closed child the read stays exactly
   * sealed_io_complete). Child I/O only, like sealed_io_complete.
   */
  | {
      readonly state: "sealed_io_settled";
      readonly childCount: number;
      readonly closedCount: number;
    };

/** Same durable storage port; @2 uses a separate keyspace, never a data migration. */
export type V2ContainerConsumerParentIoInventoryStorage = V2ContainerParentIoInventoryStorage;
export type V2ContainerConsumerParentIoInventoryReadback = V2ContainerParentIoInventoryReadback;

type ParentIoTarget = V2ContainerParentIoTarget | V2ContainerConsumerParentIoTarget;
type ParentIoClaim<T extends ParentIoTarget> = Omit<V2ContainerParentIoClaim, "target"> & {
  readonly target: T;
};
interface InventoryOptions<T extends ParentIoTarget> {
  readonly storage: V2ContainerParentIoInventoryStorage;
  readonly readParent: (
    handle: V2WorkerInvocationHandle,
  ) => Promise<V2WorkerInvocationRecord | null>;
  readonly authorize: (claim: ParentIoClaim<T>) => Promise<boolean>;
  /**
   * The fixed trusted owner's durable reader. With closeOriginal, its `absent`
   * becomes a close basis, so the owner invariant stated there applies to it.
   */
  readonly readOriginal: (binding: V2ContainerParentIoBinding) => Promise<unknown>;
  /**
   * Optional fixed trusted owner close: the same owner and journal keyspace as
   * readOriginal. It must durably consume the one-use send key only while that
   * key is still undefined (one compare-and-set against the presentation's
   * pending write), never rewrite a defined row, and return true only when the
   * key is now closed for this exact binding. Supplying it opts this instance
   * into closeUnsentAfterNativeRetirement and into reading unbound children
   * under their derived binding.
   *
   * Owner invariant this relies on: a defined one-use journal key never reverts
   * to undefined for the life of this inventory. No delete, reset, re-key,
   * prefix or version change, storage re-creation or class migration may
   * re-home a binding, so `absent` means never defined in this owner's durable
   * journal. readOriginal, closeOriginal and every presentation of a binding
   * must route to that same owner keyspace. The native journal pins what its
   * code controls; durable storage re-creation and class migration are outside
   * its reach and are deployment and Host-wiring preconditions.
   */
  readonly closeOriginal?: (binding: V2ContainerParentIoBinding) => Promise<boolean>;
}
interface InventoryProfile<T extends ParentIoTarget> {
  readonly prefix: string;
  readonly headerFormat: string;
  readonly childFormat: string;
  readonly isTarget: (value: unknown) => value is T;
  readonly qualifier: (
    ports: Pick<InventoryOptions<T>, "readParent" | "authorize">,
  ) => (
    claim: ParentIoClaim<T>,
  ) => Promise<
    (V2ContainerParentIoBinding & { readonly stillCurrent: () => Promise<boolean> }) | null
  >;
  readonly decode: (
    binding: V2ContainerParentIoBinding,
  ) => Promise<{ readonly parent: Header["parent"]; readonly target: T } | null>;
  readonly derive: (
    parent: Header["parent"],
    target: T,
  ) => Promise<V2ContainerParentIoBinding | null>;
  readonly readOriginal: (
    binding: V2ContainerParentIoBinding,
    reader: InventoryOptions<T>["readOriginal"],
  ) => Promise<V2ContainerParentIoReadback | V2ContainerConsumerParentIoReadback>;
}
const parentProfile: InventoryProfile<V2ContainerParentIoTarget> = {
  prefix: "container-parent-io/v1",
  headerFormat: "takoserver.container-parent-io-inventory@1",
  childFormat: "takoserver.container-parent-io-inventory-child@1",
  isTarget: isContainerParentIoTarget,
  qualifier: createV2ContainerParentIoQualifier,
  decode: decodeV2ContainerParentIoBinding,
  derive: deriveContainerParentIoBinding,
  readOriginal: readV2ContainerParentIoOriginal,
};
const consumerProfile: InventoryProfile<V2ContainerConsumerParentIoTarget> = {
  prefix: "container-parent-io/v2",
  headerFormat: "takoserver.container-parent-io-inventory@2",
  childFormat: "takoserver.container-parent-io-inventory-child@2",
  isTarget: isContainerConsumerParentIoTarget,
  qualifier: createV2ContainerConsumerParentIoQualifier,
  decode: decodeV2ContainerConsumerParentIoBinding,
  derive: deriveContainerConsumerParentIoBinding,
  readOriginal: readV2ContainerConsumerParentIoOriginal,
};
const PAGE_SIZE = 128; // A read page, not a limit on the number of admitted children.
interface Header {
  readonly format: string;
  readonly parent: V2ContainerParentIoBindingScope["parent"];
  readonly epoch: number;
  readonly state: "open" | "sealed";
  readonly next: number;
}
interface Child<T extends ParentIoTarget> {
  readonly format: string;
  readonly sequence: number;
  readonly epoch: number;
  readonly target: T;
  readonly binding: V2ContainerParentIoBinding | null;
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((k) => Object.hasOwn(value, k))
  );
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function header(
  value: unknown,
  parent: Header["parent"],
  profile: { readonly headerFormat: string },
): value is Header {
  return (
    exact(value, ["format", "parent", "epoch", "state", "next"]) &&
    value.format === profile.headerFormat &&
    canonicalJson(value.parent) === canonicalJson(parent) &&
    integer(value.epoch, 1) &&
    (value.state === "open" || value.state === "sealed") &&
    integer(value.next, 0)
  );
}
function child<T extends ParentIoTarget>(
  value: unknown,
  profile: InventoryProfile<T>,
): value is Child<T> {
  return (
    exact(value, ["format", "sequence", "epoch", "target", "binding"]) &&
    value.format === profile.childFormat &&
    integer(value.sequence, 0) &&
    integer(value.epoch, 1) &&
    profile.isTarget(value.target) &&
    (value.binding === null || exact(value.binding, ["producerId", "canonical", "digest"]))
  );
}
function childKey(key: string, sequence: number): string {
  return `${key}/child/${sequence.toString().padStart(16, "0")}`;
}

function nativeRetired(
  record: V2WorkerInvocationRecord | null,
): record is V2WorkerInvocationRecord & {
  readonly retirement: NonNullable<V2WorkerInvocationRecord["retirement"]>;
} {
  return (
    record !== null &&
    record.phase === "send_authorized" &&
    record.noNativeDispatchAtMs === null &&
    exact(record.retirement, ["retiredAtMs", "receiptDigest"]) &&
    integer(record.retirement.retiredAtMs, 1) &&
    isSha256Digest(record.retirement.receiptDigest)
  );
}

/**
 * Fixed Host source ports, never tenant-selected callbacks or RPC-ready data.
 * open must complete BEFORE parent native dispatch, and every actual Container
 * invocation must issue here BEFORE physical entry. NativeTail plus complete
 * source-path coverage are separate requirements for parent retirement/DELETE.
 * A sealed_io_complete result attests only this stored set of child transport I/O.
 * No raw custody or currentness closure is stored or returned by the storage port.
 * Construct once per physical owner; even a read-only reconstruction fences
 * the earlier issuer. Explicit native-retirement recovery closes admission only.
 * A false recovery acknowledgement may still leave the durable set sealed.
 */
export async function createV2ContainerParentIoInventory(options: {
  readonly storage: V2ContainerParentIoInventoryStorage;
  readonly readParent: (
    handle: V2WorkerInvocationHandle,
  ) => Promise<V2WorkerInvocationRecord | null>;
  readonly authorize: (claim: V2ContainerParentIoClaim) => Promise<boolean>;
  readonly readOriginal: (binding: V2ContainerParentIoBinding) => Promise<unknown>;
  readonly closeOriginal?: (binding: V2ContainerParentIoBinding) => Promise<boolean>;
}) {
  return createInventory(options, parentProfile);
}

/**
 * Explicit @2 inventory for accepted WorkerVersion 0.8 child I/O. Fixed source
 * ports, complete entry coverage and the exact Form's native producer remain
 * mandatory. Separate epochs fence only earlier @2 instances. An absent/empty
 * @2 set cannot discharge an @1 set or attest all-profile/parent retirement;
 * the Host must select the profile from genuine accepted source, not a DTO.
 */
export async function createV2ContainerConsumerParentIoInventory(
  options: InventoryOptions<V2ContainerConsumerParentIoTarget>,
) {
  return createInventory(options, consumerProfile);
}

async function createInventory<T extends ParentIoTarget>(
  options: InventoryOptions<T>,
  profile: InventoryProfile<T>,
) {
  const { storage, readParent, authorize, readOriginal, closeOriginal } = options;
  const epochKey = `${profile.prefix}/epoch`;
  if (
    !storage ||
    [
      storage.get,
      storage.put,
      storage.transaction,
      storage.list,
      readParent,
      authorize,
      readOriginal,
    ].some((port) => typeof port !== "function") ||
    (closeOriginal !== undefined && typeof closeOriginal !== "function")
  )
    throw new TypeError("Container inventory custody ports required");
  const epoch = await storage.transaction(async (tx) => {
    const previous = await tx.get(epochKey);
    if (previous !== undefined && !integer(previous, 1))
      throw new TypeError("Invalid inventory epoch");
    const next = (previous ?? 0) as number;
    if (next >= Number.MAX_SAFE_INTEGER) throw new TypeError("Inventory epoch exhausted");
    await tx.put(epochKey, next + 1);
    return next + 1;
  });
  async function scope(input: V2ContainerParentIoParent) {
    const parent = structuredClone(input);
    const derived = await containerParentIoScope(parent);
    if (!derived) return null;
    const record = structuredClone(await readParent(structuredClone(parent.handle)));
    if (!containerParentIoMatchesRecord(parent, record)) return null;
    const key = `${profile.prefix}/parent/${await bytesDigest(new TextEncoder().encode(derived.invocationId))}`;
    return { parent, derived, key, record };
  }
  async function current(
    tx: Transaction,
    key: string,
    parent: Header["parent"],
  ): Promise<Header | null> {
    if ((await tx.get(epochKey)) !== epoch) return null;
    const value = await tx.get(key);
    return header(value, parent, profile) ? value : null;
  }
  /**
   * The exact stored child at `seen` of sealed header h, and its binding; null
   * on any gap, surplus, re-key, foreign row or undecodable/mismatched binding.
   * An unbound child never left issue(): with an opted-in close port it is
   * addressed by the deterministic binding the qualifier would have produced;
   * otherwise it stays unresolved (null) exactly as before.
   */
  async function storedBinding(
    s: { readonly key: string },
    h: Header,
    key: string,
    raw: unknown,
    seen: number,
  ): Promise<V2ContainerParentIoBinding | null> {
    if (
      seen >= h.next ||
      key !== childKey(s.key, seen) ||
      !child(raw, profile) ||
      raw.sequence !== seen ||
      raw.epoch !== h.epoch ||
      (!raw.binding && closeOriginal === undefined)
    )
      return null;
    const c = structuredClone(raw);
    const binding = c.binding ?? (await profile.derive(h.parent, c.target));
    if (!binding) return null;
    const decoded = await profile.decode(binding);
    if (
      !decoded ||
      canonicalJson(decoded.parent) !== canonicalJson(h.parent) ||
      canonicalJson(decoded.target) !== canonicalJson(c.target)
    )
      return null;
    return binding;
  }
  const sendable = (record: V2WorkerInvocationRecord | null) =>
    record?.phase === "send_authorized" &&
    record.retirement === null &&
    record.noNativeDispatchAtMs === null;
  return Object.freeze({
    /**
     * Explicit recovery, never the old seal's implicit fallback. Only the fixed
     * Core parent reader can supply native retirement. An existing durable set
     * and the current owner epoch are mandatory; every old child stays retained.
     * This closes admission only, not child I/O or parent/process retirement.
     */
    async sealAfterNativeRetirement(input: V2ContainerParentIoParent): Promise<boolean> {
      try {
        const s = await scope(input);
        if (!s || !nativeRetired(s.record)) return false;
        const retirement = canonicalJson(s.record.retirement);
        const sealed = await storage.transaction(async (tx) => {
          const h = await current(tx, s.key, s.derived);
          if (!h) return false;
          // Preserve its epoch and full count: an old unresolved child cannot
          // disappear or be replayed just because the parent is now terminal.
          if (h.state === "open") await tx.put(s.key, { ...h, state: "sealed" });
          return true;
        });
        if (!sealed) return false;
        const latest = structuredClone(await readParent(structuredClone(s.parent.handle)));
        if (
          !containerParentIoMatchesRecord(s.parent, latest) ||
          !nativeRetired(latest) ||
          canonicalJson(latest.retirement) !== retirement
        )
          return false;
        return await storage.transaction(async (tx) => {
          const h = await current(tx, s.key, s.derived);
          return h !== null && h.state === "sealed";
        });
      } catch {
        return false;
      }
    },
    /**
     * Effect, never a verdict: `read` decides. Only with an opted-in fixed
     * closeOriginal, only when the fixed Core parent reader supplies the full
     * custody/selection AND a valid native retirement (monotonic, so observed
     * once first), and only over an existing sealed set. A close adds no send,
     * but it would refuse a live parent's later presentation; this
     * precondition is Core's, never the caller's.
     * Two passes. First the whole stored set is validated and every original
     * pre-read; any gap, surplus, count mismatch, foreign or undecodable child,
     * unreadable page or header change refuses with no owner close at all.
     * Then the owner is asked to close only children that read exactly
     * `absent`, which under closeOriginal's owner invariant means the key was
     * never defined. The owner's CAS still refuses any key defined since the
     * pre-read, so pending, unknown and complete rows are never touched, here
     * or there. Idempotent: an already-closed child is skipped.
     * The current-epoch checks before each owner call stop a superseded
     * instance only on a best-effort basis (a successor can be constructed
     * between a check and the call); safety rests on the native retirement.
     * True only when the whole set was validated and every child was complete,
     * closed, or acknowledged closed by this call.
     */
    async closeUnsentAfterNativeRetirement(input: V2ContainerParentIoParent): Promise<boolean> {
      try {
        if (closeOriginal === undefined) return false;
        const s = await scope(input);
        if (!s || !nativeRetired(s.record)) return false;
        const h = await storage.transaction(async (tx) => current(tx, s.key, s.derived));
        if (h?.state !== "sealed") return false;
        const unchanged = () =>
          storage.transaction(async (tx) => {
            const latest = await current(tx, s.key, s.derived);
            return latest !== null && canonicalJson(latest) === canonicalJson(h);
          });
        // Pass 1: validate the whole set and pre-read every original; no close yet.
        const absent: V2ContainerParentIoBinding[] = [];
        let seen = 0;
        let settled = true;
        let startAfter: string | undefined;
        while (true) {
          const page = await storage.list({
            prefix: `${s.key}/child/`,
            ...(startAfter === undefined ? {} : { startAfter }),
            limit: PAGE_SIZE,
          });
          if (!(page instanceof Map) || page.size > PAGE_SIZE || !(await unchanged())) return false;
          for (const [key, raw] of page) {
            const binding = await storedBinding(s, h, key, raw, seen);
            if (!binding) return false;
            const before = await profile.readOriginal(binding, readOriginal);
            // Stop contacting the owner once superseded (best-effort, as above).
            if (!(await unchanged())) return false;
            // `absent` is a close basis only under closeOriginal's owner invariant.
            if (before.state === "absent") absent.push(binding);
            else if (before.state !== "complete" && before.state !== "closed") settled = false;
            seen++;
            startAfter = key;
          }
          if (page.size < PAGE_SIZE) break;
        }
        if (seen !== h.next || !(await unchanged())) return false;
        // Pass 2: only the exactly-absent children of a fully validated set.
        for (const binding of absent) {
          if (!(await unchanged())) return false;
          let acknowledged = false;
          try {
            acknowledged = (await closeOriginal(structuredClone(binding))) === true;
          } catch {
            // A lost acknowledgement stays unsettled here; a retry reads it back.
          }
          if (!acknowledged) settled = false;
        }
        return settled;
      } catch {
        return false;
      }
    },
    async open(input: V2ContainerParentIoParent): Promise<boolean> {
      try {
        const s = await scope(input);
        if (!s || !sendable(s.record)) return false;
        const opened = await storage.transaction(async (tx) => {
          if ((await tx.get(epochKey)) !== epoch) return false;
          const previous = await tx.get(s.key);
          if (previous !== undefined)
            return (
              header(previous, s.derived, profile) &&
              previous.epoch === epoch &&
              previous.state === "open"
            );
          await tx.put(s.key, {
            format: profile.headerFormat,
            parent: s.derived,
            epoch,
            state: "open",
            next: 0,
          } satisfies Header);
          return true;
        });
        const latest = structuredClone(await readParent(structuredClone(s.parent.handle)));
        return opened && containerParentIoMatchesRecord(s.parent, latest) && sendable(latest);
      } catch {
        return false;
      }
    },
    async issue(input: V2ContainerParentIoParent, targetInput: Omit<T, "producerId">) {
      try {
        // Detach both inputs before any owner/storage await. IDs are Host-issued.
        const parent = structuredClone(input);
        const target = {
          ...structuredClone(targetInput),
          producerId: crypto.randomUUID(),
        };
        if (Object.hasOwn(targetInput, "producerId") || !profile.isTarget(target)) return null;
        const s = await scope(parent);
        if (!s || !sendable(s.record)) return null;
        const sequence = await storage.transaction(async (tx) => {
          const h = await current(tx, s.key, s.derived);
          if (!h || h.epoch !== epoch || h.state !== "open" || h.next >= Number.MAX_SAFE_INTEGER)
            return null;
          const key = childKey(s.key, h.next);
          if ((await tx.get(key)) !== undefined) return null;
          await tx.put(key, {
            format: profile.childFormat,
            sequence: h.next,
            epoch,
            target,
            binding: null,
          } satisfies Child<T>);
          await tx.put(s.key, { ...h, next: h.next + 1 });
          return h.next;
        });
        if (sequence === null) return null;
        const key = childKey(s.key, sequence);
        const admitted = () =>
          storage.transaction(async (tx) => {
            const h = await current(tx, s.key, s.derived);
            const c = await tx.get(key);
            return (
              !!h &&
              h.epoch === epoch &&
              h.state === "open" &&
              child(c, profile) &&
              c.epoch === epoch &&
              c.sequence === sequence &&
              canonicalJson(c.target) === canonicalJson(target)
            );
          });
        const qualify = profile.qualifier({
          readParent,
          authorize: async (claim) =>
            (await admitted()) && (await authorize(claim)) === true && (await admitted()),
        });
        const qualified = await qualify({ ...parent, target });
        if (!qualified) return null; // Durable unresolved issuance remains nonpositive.
        const binding = {
          producerId: qualified.producerId,
          canonical: qualified.canonical,
          digest: qualified.digest,
        };
        const committed = await storage.transaction(async (tx) => {
          const h = await current(tx, s.key, s.derived);
          const c = await tx.get(key);
          if (
            !h ||
            h.epoch !== epoch ||
            h.state !== "open" ||
            !child(c, profile) ||
            c.epoch !== epoch ||
            c.sequence !== sequence ||
            c.binding !== null ||
            canonicalJson(c.target) !== canonicalJson(target)
          )
            return false;
          await tx.put(key, { ...c, binding });
          return true;
        });
        if (!committed || !(await qualified.stillCurrent())) return null;
        return Object.freeze({
          ...binding,
          stillCurrent: qualified.stillCurrent,
        });
      } catch {
        return null;
      }
    },
    async seal(input: V2ContainerParentIoParent): Promise<boolean> {
      try {
        const s = await scope(input);
        if (!s) return false;
        return await storage.transaction(async (tx) => {
          const h = await current(tx, s.key, s.derived);
          if (!h || (h.state === "open" && h.epoch !== epoch)) return false;
          if (h.state === "open") await tx.put(s.key, { ...h, state: "sealed" });
          return true;
        });
      } catch {
        return false;
      }
    },
    async read(input: V2ContainerParentIoParent): Promise<V2ContainerParentIoInventoryReadback> {
      try {
        const s = await scope(input);
        if (!s) return { state: "unknown" };
        const h = await storage.transaction(async (tx) => current(tx, s.key, s.derived));
        if (!h)
          return {
            state:
              (await storage.get(epochKey)) === epoch && (await storage.get(s.key)) === undefined
                ? "absent"
                : "unknown",
          };
        if (h.state === "open") return { state: h.epoch === epoch ? "open" : "unknown" };
        const unchanged = () =>
          storage.transaction(async (tx) => {
            const latest = await current(tx, s.key, s.derived);
            return latest !== null && canonicalJson(latest) === canonicalJson(h);
          });
        let seen = 0;
        let closed = 0;
        let startAfter: string | undefined;
        while (true) {
          const page = await storage.list({
            prefix: `${s.key}/child/`,
            ...(startAfter === undefined ? {} : { startAfter }),
            limit: PAGE_SIZE,
          });
          if (!(page instanceof Map) || page.size > PAGE_SIZE || !(await unchanged()))
            return { state: "unknown" };
          for (const [key, raw] of page) {
            const binding = await storedBinding(s, h, key, raw, seen);
            if (!binding) return { state: "unknown" };
            const result = await profile.readOriginal(binding, readOriginal);
            if (!(await unchanged())) return { state: "unknown" };
            // Only complete and closed are terminal and settled; pending, unknown
            // and absent never settle.
            if (result.state === "closed") closed++;
            else if (result.state !== "complete") return { state: result.state };
            seen++;
            startAfter = key;
          }
          if (page.size < PAGE_SIZE) break;
        }
        const latest = structuredClone(await readParent(structuredClone(s.parent.handle)));
        if (
          seen !== h.next ||
          !(await unchanged()) ||
          !containerParentIoMatchesRecord(s.parent, latest)
        )
          return { state: "unknown" };
        return closed === 0
          ? { state: "sealed_io_complete", childCount: seen }
          : { state: "sealed_io_settled", childCount: seen, closedCount: closed };
      } catch {
        return { state: "unknown" };
      }
    },
  });
}
