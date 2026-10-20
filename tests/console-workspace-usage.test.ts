import { expect, test } from "bun:test";
import { ApiError, type WorkspaceUsagePage, type WorkspaceUsageRow } from "../console/src/api.ts";
import { createWorkspaceUsageController } from "../console/src/workspace-usage.ts";

const organizationId = "org-example";
const path = `/v1/organizations/${organizationId}/wallet/usage-summary/workspaces`;

function row(workspaceRef: string, usedMicros = "1"): WorkspaceUsageRow {
  return { workspaceRef, usedMicros, heldMicros: "0", pendingMicros: "0" };
}

function page(
  workspaces: readonly WorkspaceUsageRow[],
  cursor: string | null,
  change: Partial<WorkspaceUsagePage> = {},
): WorkspaceUsagePage {
  return {
    organizationId,
    snapshotAt: "2026-10-15T00:00:00.000Z",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    unit: "USD-micros",
    totalsScope: "organization",
    totals: { usedMicros: "10", heldMicros: "0", pendingMicros: "0" },
    unattributed: { usedMicros: "2", heldMicros: "0", pendingMicros: "0" },
    workspaces,
    cursor,
    ...change,
  };
}

function harness(
  answer: (query: { readonly cursor?: string; readonly limit?: number }, call: number) => unknown,
  isCurrent: () => boolean = () => true,
) {
  const calls: { cursor?: string; limit?: number }[] = [];
  const controller = createWorkspaceUsageController({
    organizationId,
    isCurrent,
    limit: 2,
    api: {
      workspaceUsage: async (org, query = {}) => {
        expect(org).toBe(organizationId);
        calls.push({ ...query });
        const value = await answer(query, calls.length);
        if (value instanceof Error) throw value;
        return value as WorkspaceUsagePage;
      },
    },
  });
  return { controller, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("pages append rows of one snapshot while totals stay the snapshot's, never a page sum", async () => {
  const { controller, calls } = harness((query) =>
    query.cursor === undefined ? page([row("ws_a"), row("ws_b")], "c1") : page([row("ws_c")], null),
  );
  expect(controller.state()).toEqual({ status: "loading" });
  controller.reload();
  await settle();
  const first = controller.state();
  expect(first).toMatchObject({ status: "ready", cursor: "c1", restarted: false });
  await controller.loadMore();
  const loaded = controller.state();
  expect(loaded).toMatchObject({
    status: "ready",
    cursor: null,
    more: { status: "idle" },
    restarted: false,
    snapshot: {
      snapshotAt: "2026-10-15T00:00:00.000Z",
      totals: { usedMicros: "10", heldMicros: "0", pendingMicros: "0" },
      unattributed: { usedMicros: "2", heldMicros: "0", pendingMicros: "0" },
    },
  });
  if (loaded.status !== "ready") throw new Error("not ready");
  expect(loaded.rows.map((entry) => entry.workspaceRef)).toEqual(["ws_a", "ws_b", "ws_c"]);
  expect(calls).toEqual([{ limit: 2 }, { limit: 2, cursor: "c1" }]);
  // The last page has no cursor; nothing more is requested.
  await controller.loadMore();
  expect(calls).toHaveLength(2);
});

test("an expired continuation (409) restarts from page one and drops the old snapshot's rows", async () => {
  const { controller, calls } = harness((query, call) => {
    if (query.cursor !== undefined) return new ApiError("expired", 409, path);
    return call === 1
      ? page([row("ws_a"), row("ws_b")], "c1")
      : page([row("ws_x")], null, { snapshotAt: "2026-10-15T00:11:00.000Z" });
  });
  controller.reload();
  await settle();
  await controller.loadMore();
  await settle();
  const state = controller.state();
  expect(state).toMatchObject({ status: "ready", restarted: true, cursor: null });
  if (state.status !== "ready") throw new Error("not ready");
  expect(state.snapshot.snapshotAt).toBe("2026-10-15T00:11:00.000Z");
  expect(state.rows.map((entry) => entry.workspaceRef)).toEqual(["ws_x"]);
  expect(calls).toEqual([{ limit: 2 }, { limit: 2, cursor: "c1" }, { limit: 2 }]);
});

test("a continuation from a different snapshot is never merged; the view restarts instead", async () => {
  for (const change of [
    { snapshotAt: "2026-10-15T00:00:01.000Z" },
    { periodStart: "2026-10-02T00:00:00.000Z" },
    { totals: { usedMicros: "11", heldMicros: "0", pendingMicros: "0" } },
    { unattributed: { usedMicros: "3", heldMicros: "0", pendingMicros: "0" } },
  ] satisfies Partial<WorkspaceUsagePage>[]) {
    const { controller, calls } = harness((query, call) =>
      query.cursor !== undefined
        ? page([row("ws_c")], null, change)
        : page([row(call === 1 ? "ws_a" : "ws_0"), row("ws_b")], call === 1 ? "c1" : null),
    );
    controller.reload();
    await settle();
    await controller.loadMore();
    await settle();
    const state = controller.state();
    expect(state).toMatchObject({ status: "ready", restarted: true });
    if (state.status !== "ready") throw new Error("not ready");
    expect(state.rows.map((entry) => entry.workspaceRef)).toEqual(["ws_0", "ws_b"]);
    expect(calls).toHaveLength(3);
  }

  // Rows that do not continue strictly after the last shown reference also restart.
  const { controller } = harness((query, call) =>
    query.cursor !== undefined
      ? page([row("ws_b")], null)
      : page([row("ws_a"), row("ws_b")], call === 1 ? "c1" : null),
  );
  controller.reload();
  await settle();
  await controller.loadMore();
  await settle();
  expect(controller.state()).toMatchObject({ status: "ready", restarted: true, cursor: null });
});

test("a failed continuation keeps the shown page and retries the same cursor", async () => {
  let fail = true;
  const { controller, calls } = harness((query) => {
    if (query.cursor === undefined) return page([row("ws_a"), row("ws_b")], "c1");
    if (fail) return new ApiError("billing_unavailable", 503, path);
    return page([row("ws_c")], null);
  });
  controller.reload();
  await settle();
  await controller.loadMore();
  const failed = controller.state();
  expect(failed).toMatchObject({
    status: "ready",
    cursor: "c1",
    more: { status: "error", error: { code: "billing_unavailable" } },
    restarted: false,
  });
  if (failed.status !== "ready") throw new Error("not ready");
  expect(failed.rows).toHaveLength(2);
  fail = false;
  await controller.loadMore();
  expect(calls.map((call) => call.cursor)).toEqual([undefined, "c1", "c1"]);
  const state = controller.state();
  if (state.status !== "ready") throw new Error("not ready");
  expect(state.rows.map((entry) => entry.workspaceRef)).toEqual(["ws_a", "ws_b", "ws_c"]);
});

test("a Host without the breakdown hides it; other first-page failures are retryable errors", async () => {
  const absent = harness(() => new ApiError("not_found", 404, path));
  absent.controller.reload();
  await settle();
  expect(absent.controller.state()).toEqual({ status: "unavailable" });

  let call = 0;
  const flaky = harness(() =>
    ++call === 1 ? new ApiError("billing_unavailable", 503, path) : page([], null),
  );
  flaky.controller.reload();
  await settle();
  expect(flaky.controller.state()).toMatchObject({
    status: "error",
    error: { code: "billing_unavailable" },
  });
  flaky.controller.reload();
  await settle();
  expect(flaky.controller.state()).toMatchObject({ status: "ready", rows: [], cursor: null });
});

test("a refresh supersedes an in-flight continuation, and a left Organization ignores answers", async () => {
  let releaseMore: (value: WorkspaceUsagePage) => void = () => undefined;
  let firstPages = 0;
  const { controller } = harness((query) => {
    if (query.cursor !== undefined)
      return new Promise<WorkspaceUsagePage>((resolve) => {
        releaseMore = resolve;
      });
    firstPages += 1;
    return page([row(firstPages === 1 ? "ws_a" : "ws_new")], firstPages === 1 ? "c1" : null);
  });
  controller.reload();
  await settle();
  const more = controller.loadMore();
  controller.reload();
  await settle();
  releaseMore(page([row("ws_late")], null));
  await more;
  const state = controller.state();
  if (state.status !== "ready") throw new Error("not ready");
  expect(state.rows.map((entry) => entry.workspaceRef)).toEqual(["ws_new"]);

  let current = true;
  const left = harness(
    () => page([row("ws_a")], null),
    () => current,
  );
  current = false;
  left.controller.reload();
  await settle();
  expect(left.controller.state()).toEqual({ status: "loading" });
});
