import type { ResourceSummary } from "./api.ts";
import { formName } from "./forms.ts";
import { tr } from "./i18n.ts";
import { MODULE_WORKER, WORKER_ENDPOINT } from "./references.ts";

/** Display only states the v2 Resource actually reports. */
export type Phase =
  | "Ready"
  | "Applied"
  | "NotReady"
  | "Pending"
  | "Failed"
  | "Deleting"
  | "Unknown";

export interface Health {
  readonly phase: Phase;
  readonly tone: "ok" | "warn" | "bad" | "idle";
  readonly reason: string | null;
  readonly message: string | null;
  readonly stale: boolean;
}

export function health(resource: ResourceSummary): Health {
  const stale = resource.observedGeneration < resource.generation;
  if (resource.phase === "deleting") {
    return { phase: "Deleting", tone: "warn", reason: null, message: null, stale };
  }
  if (resource.phase === "error") {
    return { phase: "Failed", tone: "bad", reason: null, message: null, stale };
  }
  if (resource.phase === "pending" || stale) {
    return { phase: "Pending", tone: "warn", reason: null, message: null, stale };
  }
  // A Form names its readiness `ready`; a WorkerEndpoint reports whether its
  // active Deployment's route is ready.
  const ready =
    "ready" in resource.observed
      ? resource.observed.ready
      : WORKER_ENDPOINT.test(resource.form)
        ? resource.observed.activeDeploymentRouteReady
        : undefined;
  if (resource.observedAt !== null && ready === true) {
    return { phase: "Ready", tone: "ok", reason: null, message: null, stale };
  }
  if (resource.observedAt !== null && ready === false) {
    return { phase: "NotReady", tone: "warn", reason: null, message: null, stale };
  }
  // Idle with the latest generation observed is the Host's settled state.
  // A Form that has no notion of readiness (an artifact bundle, say) ends
  // here, and saying "Unknown" about a finished create misleads. A Form
  // that reports any top-level flag as false (a SQLiteDatabase whose
  // database is gone reports databaseExists: false) is not called Applied.
  if (
    resource.observedAt !== null &&
    !("ready" in resource.observed) &&
    !Object.values(resource.observed).includes(false)
  ) {
    return { phase: "Applied", tone: "ok", reason: null, message: null, stale };
  }
  return { phase: "Unknown", tone: "idle", reason: null, message: null, stale };
}

/**
 * Whether a ModuleWorker has not recorded the Deployment that serves it. The
 * Host writes a Worker's observation only when the Worker's own operation
 * settles, so a Worker created before its Deployment keeps reporting not
 * ready, and keeps no active Deployment for WorkerCronTrigger to run, until
 * it is updated with the same spec.
 */
export function unrecordedDeployment(
  worker: ResourceSummary,
  deployment: ResourceSummary | null | undefined,
): deployment is ResourceSummary {
  return (
    MODULE_WORKER.test(worker.form) &&
    deployment !== null &&
    deployment !== undefined &&
    health(worker).phase === "NotReady" &&
    health(deployment).phase === "Ready" &&
    deployment.observed.active === true &&
    worker.observed.activeDeploymentUid !== deployment.uid
  );
}

export function phaseLabel(phase: Phase): string {
  const japanese = {
    Ready: "稼働中",
    Applied: "反映済み",
    NotReady: "非稼働",
    Pending: "処理中",
    Failed: "失敗",
    Deleting: "削除中",
    Unknown: "不明",
  } as const;
  return tr(japanese[phase], phase);
}

/** Counts by exact Form URL; a shared noun is not a Form identity. */
export function byForm(resources: readonly ResourceSummary[]): readonly {
  readonly form: string;
  readonly total: number;
  readonly attention: number;
}[] {
  const counts = new Map<string, { total: number; attention: number }>();
  for (const resource of resources) {
    const entry = counts.get(resource.form) ?? { total: 0, attention: 0 };
    entry.total += 1;
    if (["Failed", "NotReady"].includes(health(resource).phase)) entry.attention += 1;
    counts.set(resource.form, entry);
  }
  return [...counts.entries()]
    .map(([form, entry]) => ({ form, ...entry }))
    .sort((left, right) => right.total - left.total || left.form.localeCompare(right.form));
}

/** Resources whose name, exact Form URL or Form as the list shows it contain the term. */
export function matchingResources(
  resources: readonly ResourceSummary[],
  needle: string,
): readonly ResourceSummary[] {
  const term = needle.trim().toLowerCase();
  if (term === "") return resources;
  return resources.filter(
    (entry) =>
      entry.name.toLowerCase().includes(term) ||
      entry.form.toLowerCase().includes(term) ||
      formName(entry.form).toLowerCase().includes(term),
  );
}
