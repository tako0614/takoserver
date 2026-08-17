import type { Condition, ResourceSummary } from "./api.ts";

/**
 * What a resource's conditions add up to.
 *
 * Takoform reports state as conditions, which is the right wire shape and the
 * wrong thing to put in a table cell. A person scanning a list wants one word,
 * and it has to be the honest one: a resource whose Ready is False because it
 * failed is not the same as one still being made, and neither is "not ready".
 *
 * `Ready=Unknown` deliberately reads as Pending rather than as trouble — it is
 * what the Host says while it has not observed the backend yet.
 */

export type Phase = "Ready" | "Pending" | "Failed" | "Deleting" | "Unknown";

export interface Health {
  readonly phase: Phase;
  readonly tone: "ok" | "warn" | "bad" | "idle";
  readonly reason: string | null;
  readonly message: string | null;
  /** True when the last declaration has not been acted on yet. */
  readonly stale: boolean;
}

export function health(resource: ResourceSummary): Health {
  const conditions = resource.status?.conditions ?? [];
  const ready = find(conditions, "Ready");
  const deleting = find(conditions, "Deleting");
  const observed = resource.status?.observedGeneration ?? ready?.observedGeneration;
  const stale = observed !== undefined && observed !== resource.metadata.generation;

  if (deleting?.status === "True") {
    return present("Deleting", "warn", deleting, stale);
  }
  if (!ready) {
    return { phase: "Unknown", tone: "idle", reason: null, message: null, stale };
  }
  if (ready.status === "True") {
    return present("Ready", "ok", ready, stale);
  }
  if (ready.status === "Unknown") {
    return present("Pending", "warn", ready, stale);
  }
  // Ready=False splits on why: still being made, or given up on.
  const provisioning = /provision|creat|pending|progress|updat/iu.test(ready.reason ?? "");
  return present(provisioning ? "Pending" : "Failed", provisioning ? "warn" : "bad", ready, stale);
}

function present(phase: Phase, tone: Health["tone"], from: Condition, stale: boolean): Health {
  return {
    phase,
    tone,
    reason: from.reason ?? null,
    message: from.message ?? null,
    stale,
  };
}

function find(conditions: readonly Condition[], type: string): Condition | undefined {
  return conditions.find((condition) => condition.type === type);
}

/** Groups resources by kind, in a stable order, for overview counts. */
export function byKind(resources: readonly ResourceSummary[]): readonly {
  readonly kind: string;
  readonly total: number;
  readonly failing: number;
}[] {
  const counts = new Map<string, { total: number; failing: number }>();
  for (const resource of resources) {
    const entry = counts.get(resource.kind) ?? { total: 0, failing: 0 };
    entry.total += 1;
    if (health(resource).phase === "Failed") entry.failing += 1;
    counts.set(resource.kind, entry);
  }
  return [...counts.entries()]
    .map(([kind, entry]) => ({ kind, ...entry }))
    .sort((left, right) => right.total - left.total || left.kind.localeCompare(right.kind));
}
