import type { WorkspaceUsageAmounts, WorkspaceUsagePage, WorkspaceUsageRow } from "./api.ts";
import { signal } from "./reactive.ts";

/** What every page of one snapshot must repeat exactly. */
export interface WorkspaceUsageSnapshot {
  readonly snapshotAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totals: WorkspaceUsageAmounts;
  readonly unattributed: WorkspaceUsageAmounts;
}

export type WorkspaceUsageState =
  | { readonly status: "loading" }
  /** This Host has no per-Workspace breakdown (`not_found`); the section is hidden. */
  | { readonly status: "unavailable" }
  | { readonly status: "error"; readonly error: Error }
  | {
      readonly status: "ready";
      readonly snapshot: WorkspaceUsageSnapshot;
      /** Rows of one snapshot only, in the server's order, across loaded pages. */
      readonly rows: readonly WorkspaceUsageRow[];
      readonly cursor: string | null;
      readonly more:
        | { readonly status: "idle" }
        | { readonly status: "loading" }
        | { readonly status: "error"; readonly error: Error };
      /** Set when an expired or changed snapshot forced a restart from page one. */
      readonly restarted: boolean;
    };

export interface WorkspaceUsageControllerOptions {
  readonly organizationId: string;
  readonly api: {
    workspaceUsage(
      organizationId: string,
      query?: { readonly cursor?: string; readonly limit?: number },
    ): Promise<WorkspaceUsagePage>;
  };
  /** False once the page no longer shows this Organization; late answers are dropped. */
  readonly isCurrent?: () => boolean;
  readonly limit?: number;
}

/**
 * The read-only per-Workspace usage breakdown, one frozen snapshot at a time.
 *
 * A first page creates a server snapshot; "load more" continues that same
 * snapshot through its opaque cursor. Rows from two snapshots are never shown
 * together: an expired continuation (409) or a page whose snapshot context
 * differs from the first page's discards everything and starts again from page
 * one. Totals come from the snapshot and are never summed across pages.
 */
export function createWorkspaceUsageController(options: WorkspaceUsageControllerOptions) {
  const current = signal<WorkspaceUsageState>({ status: "loading" });
  const isCurrent = options.isCurrent ?? (() => true);
  const query = (cursor?: string) => ({
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  let generation = 0;

  const load = async (restarted: boolean): Promise<void> => {
    const mine = ++generation;
    current.set({ status: "loading" });
    try {
      const page = await options.api.workspaceUsage(options.organizationId, query());
      if (mine !== generation || !isCurrent()) return;
      current.set({
        status: "ready",
        snapshot: snapshotOf(page),
        rows: page.workspaces,
        cursor: page.cursor,
        more: { status: "idle" },
        restarted,
      });
    } catch (error) {
      if (mine !== generation || !isCurrent()) return;
      current.set(
        errorCode(error) === "not_found"
          ? { status: "unavailable" }
          : { status: "error", error: asError(error) },
      );
    }
  };

  const loadMore = async (): Promise<void> => {
    const shown = current();
    if (
      shown.status !== "ready" ||
      shown.cursor === null ||
      shown.more.status === "loading" ||
      !isCurrent()
    )
      return;
    const mine = generation;
    current.set({ ...shown, more: { status: "loading" } });
    let page: WorkspaceUsagePage;
    try {
      page = await options.api.workspaceUsage(options.organizationId, query(shown.cursor));
    } catch (error) {
      if (mine !== generation || !isCurrent()) return;
      if (errorStatus(error) === 409) {
        await load(true);
        return;
      }
      current.set({ ...shown, more: { status: "error", error: asError(error) } });
      return;
    }
    if (mine !== generation || !isCurrent()) return;
    const last = shown.rows.at(-1)?.workspaceRef;
    const first = page.workspaces[0]?.workspaceRef;
    if (
      !sameSnapshot(shown.snapshot, snapshotOf(page)) ||
      (last !== undefined && first !== undefined && first <= last)
    ) {
      await load(true);
      return;
    }
    current.set({
      ...shown,
      rows: [...shown.rows, ...page.workspaces],
      cursor: page.cursor,
      more: { status: "idle" },
    });
  };

  return {
    state: current,
    /** Discards every loaded page and asks for a new snapshot. */
    reload: () => void load(false),
    loadMore,
  };
}

function snapshotOf(page: WorkspaceUsagePage): WorkspaceUsageSnapshot {
  return {
    snapshotAt: page.snapshotAt,
    periodStart: page.periodStart,
    periodEnd: page.periodEnd,
    totals: page.totals,
    unattributed: page.unattributed,
  };
}

function sameAmounts(left: WorkspaceUsageAmounts, right: WorkspaceUsageAmounts): boolean {
  return (
    left.usedMicros === right.usedMicros &&
    left.heldMicros === right.heldMicros &&
    left.pendingMicros === right.pendingMicros
  );
}

function sameSnapshot(left: WorkspaceUsageSnapshot, right: WorkspaceUsageSnapshot): boolean {
  return (
    left.snapshotAt === right.snapshotAt &&
    left.periodStart === right.periodStart &&
    left.periodEnd === right.periodEnd &&
    sameAmounts(left.totals, right.totals) &&
    sameAmounts(left.unattributed, right.unattributed)
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function errorStatus(error: unknown): number | null {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : null;
}
