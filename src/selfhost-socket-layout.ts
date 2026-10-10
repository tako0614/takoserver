/**
 * Where the self-host Host puts the Unix sockets it binds, and how long the
 * directories above them may be.
 *
 * A Unix socket pathname is short: Linux's `sun_path` holds 107 bytes and
 * macOS's 103, and every socket validator in this Host enforces one bound below
 * both. The private Actor and Workflow listeners live below the data root (and
 * the native Actor namespace processes below `TMPDIR`), so the length of those
 * two directories is part of whether a configured feature can work at all.
 * This module owns the layout and derives each budget from it, so the
 * directory names the runtimes create and the limit the entry enforces at boot
 * cannot drift apart.
 *
 * Every directory named here is recreated per Host incarnation with
 * `mkdtemp`, and no durable record carries a pathname below it.
 */

/** The longest socket pathname any self-host validator accepts. */
export const SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES = 100;

/** The private (0700, owned, canonical) directory under the data root. */
export const SELFHOST_SOCKET_ROOT_NAME = "s";

/** `mkdtemp` appends exactly this many random characters to a prefix. */
const MKDTEMP_RANDOM_CHARACTERS = 6;

/** Per-incarnation directory prefixes; each directory is created by `mkdtemp`. */
export const SELFHOST_SOCKET_DIRECTORY_PREFIX = Object.freeze({
  /** Actor forward HTTP and upgrade brokers, below the socket root. */
  actorBrokers: "a",
  /** Workflow Binding brokers, below the socket root. */
  workflowBrokers: "w",
  /** One private directory per Workflow execution, below the socket root. */
  workflowExecution: "twf-",
  /** One private directory per native Actor namespace process, below `TMPDIR`. */
  actorNamespace: "tactor-",
});

/** The longest leaf each directory holds, and whether its validator admits the bound itself. */
const WORST_CASE = Object.freeze({
  // `<20 hex>.h.sock` / `<20 hex>.u.sock`; the brokers refuse `>= 100`.
  actorBrokers: { leaf: `${"0".repeat(20)}.u.sock`, inclusive: false },
  // `<22 hex>.sock`; the v2 boot refuses `>= 100` (the dormant v1 serving
  // module's `<20 hex>.sock` under `> 100` is shorter).
  workflowBrokers: { leaf: `${"0".repeat(22)}.sock`, inclusive: false },
  // `run.sock` and the guard's `s<0..63>.sock`; both refuse `> 100`.
  workflowExecution: { leaf: "run.sock", inclusive: true },
  // `run.sock` and `upgrade.sock`; the execution config refuses `> 100`.
  actorNamespace: { leaf: "upgrade.sock", inclusive: true },
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function budget(
  directory: keyof typeof SELFHOST_SOCKET_DIRECTORY_PREFIX,
  belowSocketRoot: boolean,
): number {
  const { leaf, inclusive } = WORST_CASE[directory];
  const suffix = `${belowSocketRoot ? `/${SELFHOST_SOCKET_ROOT_NAME}` : ""}/${
    SELFHOST_SOCKET_DIRECTORY_PREFIX[directory]
  }${"X".repeat(MKDTEMP_RANDOM_CHARACTERS)}/${leaf}`;
  return SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES - (inclusive ? 0 : 1) - byteLength(suffix);
}

/** The longest data root (in bytes) each socket-bearing directory leaves room for. */
export const SELFHOST_DATA_ROOT_SOCKET_BUDGET = Object.freeze({
  actorBrokers: budget("actorBrokers", true),
  workflowBrokers: budget("workflowBrokers", true),
  workflowExecution: budget("workflowExecution", true),
});

/** The longest `TMPDIR` (in bytes) the native Actor namespace processes leave room for. */
export const SELFHOST_TMPDIR_SOCKET_BUDGET = Object.freeze({
  actorNamespace: budget("actorNamespace", false),
});

/** The longest data root an Actor runtime admits. */
export const SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES = SELFHOST_DATA_ROOT_SOCKET_BUDGET.actorBrokers;

/** The longest data root a Workflow runtime admits. */
export const SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES = Math.min(
  SELFHOST_DATA_ROOT_SOCKET_BUDGET.workflowBrokers,
  SELFHOST_DATA_ROOT_SOCKET_BUDGET.workflowExecution,
);

/** The longest `TMPDIR` an Actor runtime admits. */
export const SELFHOST_ACTOR_TMPDIR_MAX_BYTES = SELFHOST_TMPDIR_SOCKET_BUDGET.actorNamespace;

/** `<data root>/s`: the one parent of every per-incarnation listener directory. */
export function selfhostPrivateSocketRoot(dataRoot: string): string {
  return `${dataRoot.endsWith("/") ? dataRoot.slice(0, -1) : dataRoot}/${SELFHOST_SOCKET_ROOT_NAME}`;
}

/**
 * The sentence an operator needs when a directory is too long (or not
 * absolute) for a configured feature, or `undefined` when it fits.
 *
 * It names the variable, the value, its length and the maximum, because the
 * failure it replaces surfaced much later as an unconfirmed publication or an
 * "authority unavailable" refusal that named none of them.
 */
export function selfhostSocketBudgetDiagnostic(input: {
  /** The environment variable the operator sets, e.g. `TAKOSERVER_DATA_ROOT`. */
  readonly variable: string;
  /** The value actually used (the resolved data root, or `os.tmpdir()`). */
  readonly path: string;
  readonly maximumBytes: number;
  /** The configured feature, including what enabled it. */
  readonly feature: string;
}): string | undefined {
  if (!input.path.startsWith("/")) {
    return `${input.variable} must be an absolute directory for ${input.feature}; it is ${JSON.stringify(input.path)}`;
  }
  const bytes = byteLength(input.path);
  if (bytes <= input.maximumBytes) return undefined;
  return (
    `${input.variable} is ${input.path} (${bytes} bytes), but ${input.feature} places Unix ` +
    `sockets below it and allows at most ${input.maximumBytes} bytes; choose a shorter ${input.variable}`
  );
}

/** Both directories an Actor runtime binds below, checked in that order. */
export function selfhostActorSocketDiagnostic(input: {
  readonly dataRoot: string;
  readonly temporaryDirectory: string;
  readonly feature: string;
}): string | undefined {
  return (
    selfhostSocketBudgetDiagnostic({
      variable: "TAKOSERVER_DATA_ROOT",
      path: input.dataRoot,
      maximumBytes: SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES,
      feature: input.feature,
    }) ??
    selfhostSocketBudgetDiagnostic({
      variable: "TMPDIR",
      path: input.temporaryDirectory,
      maximumBytes: SELFHOST_ACTOR_TMPDIR_MAX_BYTES,
      feature: input.feature,
    })
  );
}

/** The data root a Workflow runtime binds below. */
export function selfhostWorkflowSocketDiagnostic(input: {
  readonly dataRoot: string;
  readonly feature: string;
}): string | undefined {
  return selfhostSocketBudgetDiagnostic({
    variable: "TAKOSERVER_DATA_ROOT",
    path: input.dataRoot,
    maximumBytes: SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES,
    feature: input.feature,
  });
}
