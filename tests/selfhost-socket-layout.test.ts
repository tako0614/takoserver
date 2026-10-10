import { expect, test } from "bun:test";
import {
  SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES,
  SELFHOST_ACTOR_TMPDIR_MAX_BYTES,
  SELFHOST_DATA_ROOT_SOCKET_BUDGET,
  SELFHOST_SOCKET_DIRECTORY_PREFIX,
  SELFHOST_TMPDIR_SOCKET_BUDGET,
  SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES,
  SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES,
  selfhostActorSocketDiagnostic,
  selfhostPrivateSocketRoot,
  selfhostSocketBudgetDiagnostic,
  selfhostWorkflowSocketDiagnostic,
} from "../src/selfhost-socket-layout.ts";

/** An absolute path of exactly `bytes` bytes. */
function pathOf(bytes: number): string {
  return `/${"r".repeat(bytes - 1)}`;
}

function worstCase(dataRoot: string, prefix: string, leaf: string): string {
  return `${selfhostPrivateSocketRoot(dataRoot)}/${prefix}XXXXXX/${leaf}`;
}

test("each budget leaves its worst-case socket exactly at the validator bound", () => {
  // The brokers refuse `>= 100`; their worst case at the budget is 99 bytes.
  const actor = worstCase(
    pathOf(SELFHOST_DATA_ROOT_SOCKET_BUDGET.actorBrokers),
    SELFHOST_SOCKET_DIRECTORY_PREFIX.actorBrokers,
    `${"0".repeat(20)}.u.sock`,
  );
  expect(Buffer.byteLength(actor)).toBe(SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES - 1);
  const workflow = worstCase(
    pathOf(SELFHOST_DATA_ROOT_SOCKET_BUDGET.workflowBrokers),
    SELFHOST_SOCKET_DIRECTORY_PREFIX.workflowBrokers,
    `${"0".repeat(22)}.sock`,
  );
  expect(Buffer.byteLength(workflow)).toBe(SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES - 1);
  // The execution guard and execution config refuse `> 100`.
  const execution = worstCase(
    pathOf(SELFHOST_DATA_ROOT_SOCKET_BUDGET.workflowExecution),
    SELFHOST_SOCKET_DIRECTORY_PREFIX.workflowExecution,
    "run.sock",
  );
  expect(Buffer.byteLength(execution)).toBe(SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES);
  const native = `${pathOf(SELFHOST_TMPDIR_SOCKET_BUDGET.actorNamespace)}/${
    SELFHOST_SOCKET_DIRECTORY_PREFIX.actorNamespace
  }XXXXXX/upgrade.sock`;
  expect(Buffer.byteLength(native)).toBe(SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES);
});

test("the published limits are the layout's, well above the former 26-byte data root", () => {
  // Pinned so a layout change is a reviewed, documented change of the limit.
  expect(SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES).toBe(61);
  expect(SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES).toBe(61);
  expect(SELFHOST_DATA_ROOT_SOCKET_BUDGET.workflowExecution).toBe(78);
  expect(SELFHOST_ACTOR_TMPDIR_MAX_BYTES).toBe(73);
  expect(selfhostPrivateSocketRoot("/srv/takoserver")).toBe("/srv/takoserver/s");
  expect(selfhostPrivateSocketRoot("/srv/takoserver/")).toBe("/srv/takoserver/s");
});

test("the diagnostic names the variable, value, length and maximum only when over budget", () => {
  const feature = "the v2 Workflow runtime (TAKOSERVER_V2_WORKER_RUNTIME_BOOT.workflow)";
  const fits = pathOf(SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES);
  expect(selfhostWorkflowSocketDiagnostic({ dataRoot: fits, feature })).toBeUndefined();
  const long = pathOf(SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES + 1);
  expect(selfhostWorkflowSocketDiagnostic({ dataRoot: long, feature })).toBe(
    `TAKOSERVER_DATA_ROOT is ${long} (62 bytes), but ${feature} places Unix sockets below it` +
      " and allows at most 61 bytes; choose a shorter TAKOSERVER_DATA_ROOT",
  );
  // Bytes, not characters: a multi-byte name is measured as the kernel does.
  const wide = `/${"é".repeat(31)}`;
  expect(wide.length).toBe(32);
  expect(selfhostWorkflowSocketDiagnostic({ dataRoot: wide, feature })).toContain("(63 bytes)");
  expect(
    selfhostWorkflowSocketDiagnostic({ dataRoot: wide.slice(0, -1), feature }),
  ).toBeUndefined();
  expect(
    selfhostSocketBudgetDiagnostic({
      variable: "TMPDIR",
      path: "relative/tmp",
      maximumBytes: 73,
      feature: "the Actor runtime",
    }),
  ).toBe('TMPDIR must be an absolute directory for the Actor runtime; it is "relative/tmp"');
});

test("an Actor runtime checks the data root first and then TMPDIR", () => {
  const feature = "the Actor runtime";
  const root = pathOf(SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES);
  const tmp = pathOf(SELFHOST_ACTOR_TMPDIR_MAX_BYTES);
  expect(
    selfhostActorSocketDiagnostic({ dataRoot: root, temporaryDirectory: tmp, feature }),
  ).toBeUndefined();
  expect(
    selfhostActorSocketDiagnostic({ dataRoot: `${root}r`, temporaryDirectory: `${tmp}t`, feature }),
  ).toStartWith("TAKOSERVER_DATA_ROOT is ");
  expect(
    selfhostActorSocketDiagnostic({ dataRoot: root, temporaryDirectory: `${tmp}t`, feature }),
  ).toStartWith(`TMPDIR is ${tmp}t (74 bytes), but the Actor runtime`);
});
