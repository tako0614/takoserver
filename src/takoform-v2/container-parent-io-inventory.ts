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
  | { readonly state: "sealed_io_complete"; readonly childCount: number };

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
  readonly readOriginal: (binding: V2ContainerParentIoBinding) => Promise<unknown>;
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
  readOriginal: readV2ContainerParentIoOriginal,
};
const consumerProfile: InventoryProfile<V2ContainerConsumerParentIoTarget> = {
  prefix: "container-parent-io/v2",
  headerFormat: "takoserver.container-parent-io-inventory@2",
  childFormat: "takoserver.container-parent-io-inventory-child@2",
  isTarget: isContainerConsumerParentIoTarget,
  qualifier: createV2ContainerConsumerParentIoQualifier,
  decode: decodeV2ContainerConsumerParentIoBinding,
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
  const { storage, readParent, authorize, readOriginal } = options;
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
    ].some((port) => typeof port !== "function")
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
            if (
              seen >= h.next ||
              key !== childKey(s.key, seen) ||
              !child(raw, profile) ||
              raw.sequence !== seen ||
              raw.epoch !== h.epoch ||
              !raw.binding
            )
              return { state: "unknown" };
            const c = structuredClone(raw);
            const binding = c.binding;
            if (!binding) return { state: "unknown" };
            const decoded = await profile.decode(binding);
            if (
              !decoded ||
              canonicalJson(decoded.parent) !== canonicalJson(h.parent) ||
              canonicalJson(decoded.target) !== canonicalJson(c.target)
            )
              return { state: "unknown" };
            const result = await profile.readOriginal(binding, readOriginal);
            if (!(await unchanged())) return { state: "unknown" };
            if (result.state !== "complete") return { state: result.state };
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
        return { state: "sealed_io_complete", childCount: seen };
      } catch {
        return { state: "unknown" };
      }
    },
  });
}
