import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Clock, Sql } from "./ports.ts";
import { createSelfhostActorExecutionHost } from "./selfhost-actor-execution-host.ts";
import type { SelfhostEntryShutdown } from "./selfhost-entry-shutdown.ts";
import { createSelfhostV2ActorBoot } from "./selfhost-v2-actor-boot.ts";
import type { createSelfhostV2WorkerComposition } from "./selfhost-v2-worker-composition.ts";
import { createSelfhostV2WorkflowBoot } from "./selfhost-v2-workflow-boot.ts";
import { parseStrictJson } from "./strict-json.ts";
import { createV2ActorNamespaceGraphAuthority } from "./takoform-v2/actor-namespace-graph-authority.ts";
import type { WorkerdWorkerRuntimeOwner } from "./workerd-worker-runtime-owner.ts";

const CONFIG_NAME = "TAKOSERVER_V2_WORKER_RUNTIME_BOOT";
const MAX_CONFIG_BYTES = 4_096;
const MAX_WORKFLOW_REGISTRATIONS = 64;

export interface SelfhostV2RuntimeSelection {
  readonly actor?: true;
  readonly workflow?: { readonly maximumRegistrations: number };
}

/** No implicit runtime capability: the operator selects each exact boot port. */
export function parseSelfhostV2RuntimeBoot(
  raw: string | undefined,
): SelfhostV2RuntimeSelection | null {
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = parseStrictJson(new TextEncoder().encode(raw), MAX_CONFIG_BYTES);
  } catch {
    throw new TypeError(`${CONFIG_NAME} must be strict bounded JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${CONFIG_NAME} must select an exact runtime object`);
  const fields = Object.keys(value);
  if (fields.length === 0 || fields.some((field) => field !== "actor" && field !== "workflow"))
    throw new TypeError(`${CONFIG_NAME} has no selected capability or an unknown field`);
  const selected = value as Record<string, unknown>;
  if ("actor" in selected && selected.actor !== true)
    throw new TypeError(`${CONFIG_NAME}.actor must be true`);
  if ("workflow" in selected) {
    const workflow = selected.workflow;
    if (
      !workflow ||
      typeof workflow !== "object" ||
      Array.isArray(workflow) ||
      Object.keys(workflow).length !== 1 ||
      !Object.hasOwn(workflow, "maximumRegistrations") ||
      !Number.isSafeInteger((workflow as Record<string, unknown>).maximumRegistrations) ||
      Number((workflow as Record<string, unknown>).maximumRegistrations) < 1 ||
      Number((workflow as Record<string, unknown>).maximumRegistrations) >
        MAX_WORKFLOW_REGISTRATIONS
    )
      throw new TypeError(`${CONFIG_NAME}.workflow.maximumRegistrations must be 1..64`);
  }
  return Object.freeze({
    ...("actor" in selected ? { actor: true as const } : {}),
    ...("workflow" in selected
      ? {
          workflow: Object.freeze({
            maximumRegistrations: (selected.workflow as { maximumRegistrations: number })
              .maximumRegistrations,
          }),
        }
      : {}),
  });
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) ||
    (stat.mode & 0o077) !== 0
  )
    throw new TypeError("v2 runtime root must be an owned private real directory");
  return path;
}

function executable(path: string | null | undefined, name: string): string {
  if (!path || !isAbsolute(path))
    throw new TypeError(`${name} must be a selected absolute executable`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new TypeError(`${name} must be a real executable`);
  accessSync(path, constants.X_OK);
  return path;
}

/** App-only assembly; no public FormSupport is registered by this port. */
export function createSelfhostV2RuntimeBoot(options: {
  readonly selection: SelfhostV2RuntimeSelection;
  readonly sql: Sql;
  readonly clock: Clock;
  readonly targetKey: string;
  readonly dataRoot: string;
  readonly workerdBinary: string | null;
  readonly guardBinary?: string;
  readonly ownerForWorkerUid: (uid: string) => Promise<WorkerdWorkerRuntimeOwner | null>;
  readonly dataPlaneAddress?: string;
  /** Current v2 SQLite broker port selected by the private-plane boot. */
  readonly v2SqliteBindingAddress?: string;
}) {
  if (!options.selection.actor && !options.selection.workflow)
    throw new TypeError("v2 runtime boot requires an explicit capability");
  if (options.dataRoot === ":memory:")
    throw new TypeError("v2 runtime boot requires durable private storage");
  const binary = executable(options.workerdBinary, "v2 workerd");
  const guard = options.selection.workflow
    ? executable(options.guardBinary, "v2 Workflow guard")
    : undefined;
  if (options.selection.workflow && !guard) {
    throw new TypeError("v2 Workflow guard is unavailable");
  }
  const root = privateDirectory(join(resolve(options.dataRoot), "v2-runtime"));
  const actor = options.selection.actor
    ? (() => {
        const graph = createV2ActorNamespaceGraphAuthority({
          sql: options.sql,
          targetKey: options.targetKey,
          owner: { ownerForWorker: options.ownerForWorkerUid },
        });
        const physical = createSelfhostActorExecutionHost({
          runtimeRoot: privateDirectory(join(root, "actor-runtime")),
          storageRoot: privateDirectory(join(root, "actor-storage")),
          binary,
          authority: graph,
          ...(options.v2SqliteBindingAddress
            ? { v2SqliteBindingAddress: options.v2SqliteBindingAddress }
            : {}),
        });
        return {
          physical,
          boot: createSelfhostV2ActorBoot({
            sql: options.sql,
            targetKey: options.targetKey,
            namespaceGraph: graph,
            physical,
            privateSocketDirectory: privateDirectory(join(root, "actor-private-sockets")),
          }),
        };
      })()
    : undefined;
  // The v2 Workflow class must use the same current private SQLite listener
  // selected for its accepted WorkerVersion, not the legacy data-plane port.
  const address = options.v2SqliteBindingAddress ?? options.dataPlaneAddress;
  const workflow =
    options.selection.workflow && guard
      ? createSelfhostV2WorkflowBoot({
          sql: options.sql,
          clock: options.clock,
          targetKey: options.targetKey,
          randomId: () => crypto.randomUUID(),
          waitUntil: async (epochMs, signal) => {
            while (Date.now() < epochMs) {
              await delay(Math.min(epochMs - Date.now(), 60_000), undefined, {
                signal,
              });
            }
            if (signal.aborted) throw signal.reason;
          },
          guardBinary: guard,
          workerdBinary: binary,
          maximumRegistrations: options.selection.workflow.maximumRegistrations,
          privateSocketDirectory: privateDirectory(join(root, "workflow-private-sockets")),
          temporaryRoot: privateDirectory(join(root, "workflow-temporary")),
          ...(address ? { dataPlaneAddress: () => address } : {}),
        })
      : undefined;
  return Object.freeze({
    ...(actor ? { v2Actor: actor.boot } : {}),
    ...(workflow ? { v2Workflow: workflow } : {}),
    async closeActor() {
      await actor?.physical.close();
    },
  });
}

/** One tracked Cron pass, independent of settlement and other delivery lanes. */
export function startSelfhostV2ScheduledDuePass(
  shutdown: Pick<SelfhostEntryShutdown, "startInterval">,
  workers: Pick<ReturnType<typeof createSelfhostV2WorkerComposition>, "pollScheduledDue">,
  onFailure: (name: string) => void,
): void {
  shutdown.startInterval(
    "takoform-v2-scheduled-due",
    1_000,
    async () => {
      await workers.pollScheduledDue();
    },
    onFailure,
  );
}

/** One tracked named pass, independent of legacy settlement and Queue work. */
export function startSelfhostV2WorkflowDuePass(
  shutdown: Pick<SelfhostEntryShutdown, "startInterval">,
  workers: Pick<ReturnType<typeof createSelfhostV2WorkerComposition>, "pollWorkflowDue">,
  onFailure: (name: string) => void,
): void {
  shutdown.startInterval(
    "takoform-v2-workflow-due",
    1_000,
    async () => {
      await workers.pollWorkflowDue();
    },
    onFailure,
  );
}
