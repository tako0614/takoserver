import type { ResourceSummary } from "./api.ts";

/** Display only states the v2 Resource actually reports. */
export type Phase = "Ready" | "NotReady" | "Pending" | "Failed" | "Deleting" | "Unknown";

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
  if (resource.observedAt !== null && resource.observed.ready === true) {
    return { phase: "Ready", tone: "ok", reason: null, message: null, stale };
  }
  if (resource.observedAt !== null && resource.observed.ready === false) {
    return { phase: "NotReady", tone: "warn", reason: null, message: null, stale };
  }
  return { phase: "Unknown", tone: "idle", reason: null, message: null, stale };
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
