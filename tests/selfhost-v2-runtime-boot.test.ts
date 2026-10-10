import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostEntryShutdown } from "../src/selfhost-entry-shutdown.ts";
import {
  SELFHOST_ACTOR_TMPDIR_MAX_BYTES,
  SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES,
  selfhostPrivateSocketRoot,
} from "../src/selfhost-socket-layout.ts";
import {
  assertSelfhostV2RuntimeSocketBudget,
  createSelfhostV2RuntimeBoot,
  parseSelfhostV2RuntimeBoot,
  startSelfhostV2ScheduledDuePass,
  startSelfhostV2WorkflowDuePass,
} from "../src/selfhost-v2-runtime-boot.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { mkdtempForSockets } from "./helpers/socket-temp-root.ts";

const TARGET = "selfhost-v2-worker-primary";

test("runtime boot config selects only exact explicit Actor and bounded Workflow ports", () => {
  expect(parseSelfhostV2RuntimeBoot(undefined)).toBeNull();
  expect(
    parseSelfhostV2RuntimeBoot('{"actor":true,"workflow":{"maximumRegistrations":4}}'),
  ).toEqual({
    actor: true,
    workflow: { maximumRegistrations: 4 },
  });
  for (const invalid of [
    "{}",
    '{"actor":false}',
    '{"workflow":{}}',
    '{"workflow":{"maximumRegistrations":0}}',
    '{"workflow":{"maximumRegistrations":65}}',
    '{"actor":true,"endpoint":true}',
    '{"actor":true,"actor":true}',
  ]) {
    expect(() => parseSelfhostV2RuntimeBoot(invalid)).toThrow();
  }
});

test("selected native ports fail before storage effects without executable or guard authority", () => {
  const database = new Database(":memory:");
  try {
    const sql = createSqliteSql(database);
    const base = {
      sql,
      clock: () => new Date(),
      targetKey: TARGET,
      dataRoot: ":memory:",
      ownerForWorkerUid: async () => null,
    };
    expect(() =>
      createSelfhostV2RuntimeBoot({
        ...base,
        dataRoot: tmpdir(),
        selection: { actor: true },
        workerdBinary: null,
      }),
    ).toThrow("v2 workerd");
    expect(() =>
      createSelfhostV2RuntimeBoot({
        ...base,
        selection: { workflow: { maximumRegistrations: 2 } },
        workerdBinary: process.execPath,
      }),
    ).toThrow("v2 runtime boot requires durable private storage");
    expect(() =>
      createSelfhostV2RuntimeBoot({
        ...base,
        dataRoot: tmpdir(),
        selection: { workflow: { maximumRegistrations: 2 } },
        workerdBinary: process.execPath,
      }),
    ).toThrow("v2 Workflow guard");
  } finally {
    database.close();
  }
});

test("stalled Cron poll is tracked independently and drained before shutdown", async () => {
  let pollRun: (() => void | Promise<void>) | undefined;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const shutdown = createSelfhostEntryShutdown({
    stopIngress: async () => {
      order.push("ingress");
    },
    finishShutdown: async () => {
      order.push("closed");
    },
    onFailure: () => {},
    onSuccess: () => {},
  });
  startSelfhostV2ScheduledDuePass(
    {
      startInterval(name, milliseconds, run) {
        expect(name).toBe("takoform-v2-scheduled-due");
        expect(milliseconds).toBe(1_000);
        pollRun = run;
      },
    },
    {
      pollScheduledDue: async () => {
        order.push("cron-start");
        await stalled;
        order.push("cron-end");
        return {
          recorded: 0,
          claimed: 0,
          resolved: 0,
          rejected: 0,
          unknown: 0,
          scanComplete: true,
          hasMore: false,
          continuation: null,
        };
      },
    },
    () => {},
  );
  if (!pollRun) throw new Error("Cron pass was not registered");
  const running = shutdown.runPass("takoform-v2-scheduled-due", pollRun);
  await Promise.resolve();
  await shutdown.runPass("takoform-v2", async () => {
    order.push("ordinary-pass");
  });
  const closing = shutdown.shutdown();
  await Promise.resolve();
  expect(order).toContain("ordinary-pass");
  expect(order).not.toContain("closed");
  release();
  await running;
  expect(await closing).toBe(true);
  expect(order.indexOf("cron-end")).toBeLessThan(order.indexOf("closed"));

  startSelfhostV2ScheduledDuePass(
    {
      startInterval(_name, _milliseconds, run) {
        pollRun = run;
      },
    },
    {
      pollScheduledDue: async () => {
        throw new Error("poll rejected");
      },
    },
    () => {},
  );
  await expect(pollRun?.()).rejects.toThrow("poll rejected");
});

test("stalled or rejected Workflow poll is an independent tracked pass", async () => {
  let pollRun: (() => void | Promise<void>) | undefined;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const shutdown = createSelfhostEntryShutdown({
    stopIngress: async () => {
      order.push("ingress");
    },
    finishShutdown: async () => {
      order.push("closed");
    },
    onFailure: () => {
      order.push("failure");
    },
    onSuccess: () => {
      order.push("success");
    },
  });
  startSelfhostV2WorkflowDuePass(
    {
      startInterval(name, milliseconds, run) {
        expect(name).toBe("takoform-v2-workflow-due");
        expect(milliseconds).toBe(1_000);
        pollRun = run;
      },
    },
    {
      pollWorkflowDue: async () => {
        order.push("workflow-start");
        await stalled;
        order.push("workflow-end");
        return { examined: 0, selected: 0, outcomes: [] };
      },
    },
    () => {
      order.push("poll-failure");
    },
  );
  if (!pollRun) throw new Error("Workflow pass was not registered");
  const running = shutdown.runPass("takoform-v2-workflow-due", pollRun);
  await Promise.resolve();
  await shutdown.runPass("takoform-v2", async () => {
    order.push("ordinary-pass");
  });
  const closing = shutdown.shutdown();
  await Promise.resolve();
  expect(order).toContain("ordinary-pass");
  expect(order).not.toContain("closed");
  release();
  await running;
  expect(await closing).toBe(true);
  expect(order.indexOf("workflow-end")).toBeLessThan(order.indexOf("closed"));

  startSelfhostV2WorkflowDuePass(
    {
      startInterval(_name, _milliseconds, run) {
        pollRun = run;
      },
    },
    {
      pollWorkflowDue: async () => {
        throw new Error("poll rejected");
      },
    },
    () => {},
  );
  await expect(pollRun?.()).rejects.toThrow("poll rejected");
});

test("selected runtime ports restore on one SQLite and close Workflow before the Worker owner", async () => {
  const root = await mkdtempForSockets("svrb-", SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES);
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    let workers: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    const selection = parseSelfhostV2RuntimeBoot(
      '{"actor":true,"workflow":{"maximumRegistrations":2}}',
    );
    if (!selection) throw new Error("test selection is required");
    const boot = createSelfhostV2RuntimeBoot({
      selection,
      sql,
      clock,
      targetKey: TARGET,
      dataRoot: root,
      workerdBinary: process.execPath,
      guardBinary: process.execPath,
      ownerForWorkerUid: async (uid) => (workers ? await workers.ownerForWorkerUid(uid) : null),
    });
    expect(boot.v2Actor).toBeDefined();
    expect(boot.v2Workflow).toBeDefined();
    // Listener directories share the data root's one short private socket root.
    expect(statSync(selfhostPrivateSocketRoot(root)).mode & 0o777).toBe(0o700);
    for (const former of [
      "actor-private-sockets",
      "workflow-private-sockets",
      "workflow-temporary",
    ])
      expect(existsSync(join(root, "v2-runtime", former))).toBe(false);
    workers = createSelfhostV2WorkerComposition({
      sql,
      objects,
      clock,
      config: {
        cursorSigningKey: new Uint8Array(32).fill(7),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/auth",
        workerBundle: { targetKey: TARGET, heldArtifacts: [] },
      },
      targetKey: TARGET,
      rootDirectory: join(root, "worker-owners"),
      workerdBinary: process.execPath,
      ...(boot.v2Actor ? { v2Actor: boot.v2Actor } : {}),
      ...(boot.v2Workflow ? { v2Workflow: boot.v2Workflow } : {}),
    });
    expect(await workers.restoreOwners()).toEqual([]);
    expect(await workers.pollWorkflowDue()).toEqual({ examined: 0, selected: 0, outcomes: [] });
    await workers.closeWorkflowHost();
    await expect(workers.pollWorkflowDue()).rejects.toThrow("unavailable");
    await workers.suspendOwnersRetainingCustody();
    await boot.closeActor();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a selected capability refuses a data root or TMPDIR its sockets cannot fit, by name and before storage", async () => {
  const base = await mkdtempForSockets("svrl-", SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES - 2);
  const database = new Database(":memory:");
  try {
    const exact = join(
      base,
      "d".repeat(SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES - Buffer.byteLength(base) - 1),
    );
    const options = {
      selection: { workflow: { maximumRegistrations: 1 } },
      sql: createSqliteSql(database),
      clock: () => new Date(),
      targetKey: TARGET,
      workerdBinary: process.execPath,
      guardBinary: process.execPath,
      ownerForWorkerUid: async () => null,
    };
    const over = `${exact}x`;
    expect(() => createSelfhostV2RuntimeBoot({ ...options, dataRoot: over })).toThrow(
      `TAKOSERVER_DATA_ROOT is ${over} (62 bytes), but the v2 Workflow runtime ` +
        "(TAKOSERVER_V2_WORKER_RUNTIME_BOOT.workflow) places Unix sockets below it and allows " +
        "at most 61 bytes; choose a shorter TAKOSERVER_DATA_ROOT",
    );
    expect(existsSync(over)).toBe(false);
    expect(createSelfhostV2RuntimeBoot({ ...options, dataRoot: exact }).v2Workflow).toBeDefined();
    expect(existsSync(selfhostPrivateSocketRoot(exact))).toBe(true);
    // An Actor also binds below TMPDIR; a Workflow-only selection does not.
    const longTemporary = `/${"t".repeat(SELFHOST_ACTOR_TMPDIR_MAX_BYTES)}`;
    expect(() =>
      assertSelfhostV2RuntimeSocketBudget({ actor: true }, exact, longTemporary),
    ).toThrow(`TMPDIR is ${longTemporary} (74 bytes), but the v2 Actor runtime`);
    expect(() =>
      assertSelfhostV2RuntimeSocketBudget(
        { workflow: { maximumRegistrations: 1 } },
        exact,
        longTemporary,
      ),
    ).not.toThrow();
    expect(() => assertSelfhostV2RuntimeSocketBudget({ actor: true }, exact, "/tmp")).not.toThrow();
  } finally {
    database.close();
    await rm(base, { recursive: true, force: true });
  }
});
