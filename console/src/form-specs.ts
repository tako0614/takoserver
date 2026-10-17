const EDGE = "https://edge.forms.takoform.com/forms";
const form = (kind: string, version: string): string => `${EDGE}/${kind}/${version}/`;

const MODULE_WORKER = form("ModuleWorker", "0.3.0");
export const WORKER_BUNDLE = form("WorkerBundle", "0.2.0");
export const WORKER_VERSION = form("WorkerVersion", "0.5.0");
export const WORKER_DEPLOYMENT = form("WorkerDeployment", "0.4.0");
export const WORKER_ENDPOINT = form("WorkerEndpoint", "0.3.0");
const SQLITE_DATABASE = form("SQLiteDatabase", "0.2.0");
const SQLITE_MIGRATION_SET = form("SQLiteMigrationSet", "0.2.0");
const CURRENT_SQLITE_MIGRATION_SET = form("SQLiteMigrationSet", "0.4.0");
const AT_LEAST_ONCE_QUEUE = form("AtLeastOnceQueue", "0.2.0");

/**
 * Forms whose Resources this Host never lets change: a version and the
 * artifacts it names are new Resources each time, not edits. An update of one
 * can only send its same spec again.
 */
const UNCHANGEABLE = new Set([
  WORKER_VERSION,
  WORKER_BUNDLE,
  form("StaticAssetBundle", "0.2.0"),
  SQLITE_MIGRATION_SET,
  CURRENT_SQLITE_MIGRATION_SET,
]);

/** Whether an update of a Resource of this exact Form can change anything. */
export function acceptsChanges(formUrl: string): boolean {
  return !UNCHANGEABLE.has(formUrl);
}

/** One place in a spec that names another Resource by UID. */
export interface ReferenceSlot {
  /** Where the UID goes, for example `["versions", 0, "workerVersion", "resourceUid"]`. */
  readonly path: readonly (string | number)[];
  /** The exact Form the Host requires the named Resource to have. */
  readonly form: string;
}

/**
 * Where to start writing one Form's spec: the smallest spec this Host accepts,
 * with an empty string wherever the person has to supply a value, and the
 * places that name another Resource.
 */
export interface StarterSpec {
  readonly spec: Record<string, unknown>;
  readonly references: readonly ReferenceSlot[];
}

const ref = (...path: (string | number)[]) => [...path, "resourceUid"];
const artifact = (): StarterSpec => ({
  spec: { artifact: { url: "", sha256: "" } },
  references: [],
});
const empty = (): StarterSpec => ({ spec: {}, references: [] });
const workerOnly = (extra: Record<string, unknown> = {}): StarterSpec => ({
  spec: { worker: { resourceUid: "" }, ...extra },
  references: [{ path: ref("worker"), form: MODULE_WORKER }],
});
const migrationApplication = (migrationSetForm: string): StarterSpec => ({
  spec: { database: { resourceUid: "" }, migrationSet: { resourceUid: "" } },
  references: [
    { path: ref("database"), form: SQLITE_DATABASE },
    { path: ref("migrationSet"), form: migrationSetForm },
  ],
});

/**
 * Starters for the Forms the Console offers, written from this Host's own
 * validators (src/takoform-v2/forms); a test runs each one through them.
 */
const STARTERS: Readonly<Record<string, () => StarterSpec>> = {
  [WORKER_BUNDLE]: artifact,
  [form("StaticAssetBundle", "0.2.0")]: artifact,
  [SQLITE_MIGRATION_SET]: artifact,
  [CURRENT_SQLITE_MIGRATION_SET]: artifact,
  [MODULE_WORKER]: empty,
  [WORKER_VERSION]: () => ({
    spec: { worker: { resourceUid: "" }, bundle: { resourceUid: "" }, handlers: ["fetch"] },
    references: [
      { path: ref("worker"), form: MODULE_WORKER },
      { path: ref("bundle"), form: WORKER_BUNDLE },
    ],
  }),
  [WORKER_DEPLOYMENT]: () => ({
    spec: {
      worker: { resourceUid: "" },
      versions: [{ workerVersion: { resourceUid: "" }, weight: 10000 }],
    },
    references: [
      { path: ref("worker"), form: MODULE_WORKER },
      { path: ref("versions", 0, "workerVersion"), form: WORKER_VERSION },
    ],
  }),
  // A schedule is the person's decision, so it is left for them to write.
  [form("WorkerCronTrigger", "0.3.0")]: () => workerOnly({ cron: "" }),
  [WORKER_ENDPOINT]: () => workerOnly(),
  [SQLITE_DATABASE]: empty,
  [form("SQLiteMigrationApplication", "0.2.0")]: () => migrationApplication(SQLITE_MIGRATION_SET),
  [form("SQLiteMigrationApplication", "0.4.0")]: () =>
    migrationApplication(CURRENT_SQLITE_MIGRATION_SET),
  [form("EdgeKVNamespace", "0.2.0")]: empty,
  [form("ObjectBucket", "0.2.0")]: empty,
  [AT_LEAST_ONCE_QUEUE]: () => ({ spec: { messageRetentionSeconds: 345600 }, references: [] }),
  [form("QueueConsumer", "0.3.0")]: () => ({
    spec: {
      queue: { resourceUid: "" },
      worker: { resourceUid: "" },
      maxBatchSize: 10,
      maxBatchTimeoutSeconds: 5,
      maxConcurrency: 1,
      maxRetries: 3,
      retryDelaySeconds: 0,
    },
    references: [
      { path: ref("queue"), form: AT_LEAST_ONCE_QUEUE },
      { path: ref("worker"), form: MODULE_WORKER },
    ],
  }),
  [form("ActorNamespace", "0.3.0")]: () => workerOnly({ className: "" }),
  [form("DurableWorkflow", "0.3.0")]: () => workerOnly({ className: "" }),
};

/** A fresh starter for an exact Form URL, or null for a Form the Console does not know. */
export function starterSpec(formUrl: string): StarterSpec | null {
  return STARTERS[formUrl]?.() ?? null;
}

/** The value at a path, or undefined where the spec has no such place. */
export function valueAt(spec: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = spec;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/**
 * A copy of the spec with one value replaced. Only an existing place is
 * written, so a person's own edits to the shape are never filled back in.
 */
export function withValueAt(
  spec: Record<string, unknown>,
  path: readonly (string | number)[],
  value: unknown,
): Record<string, unknown> | null {
  const copy = structuredClone(spec);
  let current: unknown = copy;
  for (const [index, key] of path.entries()) {
    if (current === null || typeof current !== "object" || !(key in current)) return null;
    if (index === path.length - 1) {
      (current as Record<string | number, unknown>)[key] = value;
      return copy;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return null;
}

/**
 * "versions[0].workerVersion" for a place, as a person reads it. A reference's
 * own `resourceUid` key is left off: the place names the Resource.
 */
export function pathLabel(path: readonly (string | number)[]): string {
  const keys = path.at(-1) === "resourceUid" ? path.slice(0, -1) : path;
  return keys
    .map((key, index) => (typeof key === "number" ? `[${key}]` : index === 0 ? key : `.${key}`))
    .join("");
}

export function slotLabel(slot: ReferenceSlot): string {
  return pathLabel(slot.path);
}

/** Every place in a spec that still holds the empty string a starter leaves to fill. */
export function blankPaths(
  spec: unknown,
  at: readonly (string | number)[] = [],
): (string | number)[][] {
  if (spec === "") return [[...at]];
  if (Array.isArray(spec)) return spec.flatMap((value, index) => blankPaths(value, [...at, index]));
  if (spec !== null && typeof spec === "object")
    return Object.entries(spec).flatMap(([key, value]) => blankPaths(value, [...at, key]));
  return [];
}
