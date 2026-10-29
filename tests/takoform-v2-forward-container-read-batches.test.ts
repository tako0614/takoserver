import { expect, test } from "bun:test";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import type { Sql, SqlWrite } from "../src/ports.ts";
import {
  CONTAINER_0_2_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/container-consumer-specs.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { MODULE_WORKER_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2ForwardContainerBindingReader } from "../src/takoform-v2/index.ts";
import { containerConsumerFixture } from "./helpers/container-consumer-nonsecret.ts";
import {
  CONTAINER_BACKEND,
  fixture,
  PRINCIPAL,
  TARGET,
  WORKER_BACKEND,
} from "./helpers/forward-container-binding-authority.ts";

const makeReader = (
  sql: Sql,
  authorize: (p: string, s: string) => Promise<boolean> = async () => true,
) =>
  createV2ForwardContainerBindingReader({
    sql,
    targetKey: TARGET,
    workerBackendId: WORKER_BACKEND,
    containerBackendId: CONTAINER_BACKEND,
    authorize,
  });
const claimsFor = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.spec.containerBindings.map((binding) => ({
    ...f.claim,
    bindingName: binding.name,
    targetUid: binding.resource.resourceUid,
  }));

test("bulk reader validates every binding in one owner/Version snapshot, aliases and64distinct targets", async () => {
  for (const distinctTargets of [false, true]) {
    const f = await fixture({ bindingCount: 64, distinctTargets });
    try {
      let queries = 0,
        batches = 0,
        statements = 0;
      const sql: Sql = {
        ...f.sql,
        query: async (...args) => {
          queries++;
          return f.sql.query(...args);
        },
        batch: async (plans) => {
          batches++;
          statements += plans.length;
          return f.sql.batch(plans);
        },
      };
      const reader = makeReader(sql),
        claims = claimsFor(f),
        rows = await reader.readMany(claims);
      expect(rows).toHaveLength(64);
      expect(rows?.map((row) => row.targetUid)).toEqual(claims.map((claim) => claim.targetUid));
      expect(queries).toBe(2);
      expect(batches).toBe(1);
      expect(statements).toBe(distinctTargets ? 67 : 4);
      expect(await reader(f.claim)).not.toBeNull();
    } finally {
      f.close();
    }
  }
});

test("bulk scope is snapped before await; mixed owner/Version/operation, sparse, duplicate, oversized andunselected bindings refuse", async () => {
  const f = await fixture({ bindingCount: 2 });
  try {
    const claims = claimsFor(f);
    let authorizeCalls = 0,
      queries = 0;
    const sql: Sql = {
      ...f.sql,
      query: async (...args) => {
        queries++;
        return f.sql.query(...args);
      },
    };
    const reader = makeReader(sql, async () => {
      authorizeCalls++;
      return true;
    });
    const bad = [
      [],
      [claims[0], claims[0]],
      [claims[0], { ...claims[1], principal: "foreign" }],
      [claims[0], { ...claims[1], space: "foreign" }],
      [claims[0], { ...claims[1], workerVersionUid: "foreign" }],
      [claims[0], { ...claims[1], workerVersionGeneration: 2 }],
      [claims[0], { ...claims[1], operationId: "foreign" }],
      new Array(2),
      Array.from({ length: 65 }, (_, i) => ({ ...claims[0], bindingName: `B${i}` })),
    ];
    for (const input of bad) expect(await reader.readMany(input as typeof claims)).toBeNull();
    expect(authorizeCalls).toBe(0);
    expect(queries).toBe(0);
    const first = claims[0],
      second = claims[1];
    if (!first || !second) throw new Error("two fixture claims required");
    expect(await reader.readMany([first, { ...second, bindingName: "unselected" }])).toBeNull();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      blocked = new Promise<void>((r) => (release = r));
    const snapped = makeReader(f.sql, async () => {
      entered();
      await blocked;
      return true;
    });
    const mutable = claims.map((claim) => ({ ...claim }));
    const pending = snapped.readMany(mutable);
    await started;
    const changed = mutable[0];
    if (!changed) throw new Error("fixture claim missing");
    changed.targetUid = "foreign";
    mutable.reverse();
    release();
    expect((await pending)?.map((row) => row.targetUid)).toEqual(
      claims.map((claim) => claim.targetUid),
    );
  } finally {
    f.close();
  }
});

test("selected Core batch rejects malformed/truncated/sparse/reordered results and never retries query", async () => {
  const f = await fixture();
  try {
    const corrupt: ((rows: readonly SqlWrite[]) => unknown)[] = [
      () => [],
      (rows) => rows.slice(0, -1),
      (rows) => new Array(rows.length),
      (rows) => rows.map((r, i) => (i ? r : { ...r, rows: null })),
      (rows) => rows.map((r, i) => (i ? r : { ...r, rows: [null] })),
      (rows) => rows.map((r, i) => (i ? r : { ...r, rows: [[]] })),
      (rows) => rows.map((r, i) => (i ? r : { ...r, rows: new Array(1) })),
      (rows) => [...rows].reverse(),
      (rows) => rows.map((r, i) => (i ? r : { ...r, rows: [{ sealed: "1" }] })),
      (rows) => rows.map((r, i) => (i === rows.length - 1 ? { ...r, rows: [] } : r)),
    ];
    for (const mutate of corrupt) {
      let queries = 0,
        batches = 0;
      const sql: Sql = {
        ...f.sql,
        query: async (...args) => {
          queries++;
          return f.sql.query(...args);
        },
        batch: async (plans) => {
          batches++;
          return mutate(await f.sql.batch(plans)) as readonly SqlWrite[];
        },
      };
      expect(await makeReader(sql)(f.claim)).toBeNull();
      expect(queries).toBe(2);
      expect(batches).toBe(1);
    }
    let queries = 0;
    const rejecting: Sql = {
      ...f.sql,
      query: async (...args) => {
        queries++;
        return f.sql.query(...args);
      },
      batch: async () => {
        throw new Error("controlled batch failure");
      },
    };
    expect(await makeReader(rejecting)(f.claim)).toBeNull();
    expect(queries).toBe(2);
    const fallback = { ...f.sql, batch: undefined } as unknown as Sql;
    expect(await makeReader(fallback)(f.claim)).toEqual(await f.reader(f.claim));
    expect(() => makeReader({ ...f.sql, batch: 0 } as unknown as Sql)).toThrow();
  } finally {
    f.close();
  }
});

test("Core batch and receiver captured once", async () => {
  const f = await fixture({ bindingCount: 2, distinctTargets: true });
  try {
    let gets = 0,
      calls = 0;
    const selected: Sql = {
      ...f.sql,
      get batch() {
        gets++;
        return async function (this: Sql, plans: Parameters<Sql["batch"]>[0]) {
          expect(this).toBe(selected);
          calls++;
          return f.sql.batch(plans);
        };
      },
    };
    const reader = makeReader(selected);
    Object.defineProperty(selected, "batch", {
      value: async () => {
        throw new Error("late replacement");
      },
    });
    expect(await reader.readMany(claimsFor(f))).toHaveLength(2);
    expect(gets).toBe(1);
    expect(calls).toBe(1);
  } finally {
    f.close();
  }
});

test("bounded indexed bulk snapshot never consumes a caller supplied array iterator", async () => {
  const f = await fixture({ bindingCount: 2 });
  try {
    const claims = claimsFor(f);
    Object.defineProperty(claims, Symbol.iterator, {
      get() {
        throw new Error("caller iterator must not run");
      },
    });
    expect(await f.reader.readMany(claims)).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("two real pending and failed-none targets retain committed sources through one tail batch; rejected batch closes", async () => {
  for (const failed of [false, true]) {
    const f = await fixture({ bindingCount: 2, distinctTargets: true });
    try {
      const claims = claimsFor(f);
      f.setContainerUpdateOutcome("none");
      for (const [i, claim] of claims.entries()) {
        await f.engine.acceptUpdate({
          principal: PRINCIPAL,
          uid: claim.targetUid,
          key: `bulk-tail-update-${i}`,
          expectedGeneration: 1,
          spec: { revision: "next" },
        });
        if (failed) expect((await f.engine.runNext())?.status).toBe("failed");
      }
      let batches = 0,
        tailStatements = 0;
      const sql: Sql = {
        ...f.sql,
        batch: async (plans) => {
          batches++;
          if (plans.some((p) => p.sql.includes("COUNT(DISTINCT generation)"))) {
            tailStatements = plans.length;
          }
          return f.sql.batch(plans);
        },
      };
      const rows = await makeReader(sql).readMany(claims);
      expect(rows).toHaveLength(2);
      expect(rows?.map((r) => r.targetGeneration)).toEqual([1, 1]);
      expect(batches).toBe(2);
      expect(tailStatements).toBe(2);
      let tailRejects = 0;
      const rejected: Sql = {
        ...f.sql,
        batch: async (plans) => {
          if (plans.some((p) => p.sql.includes("COUNT(DISTINCT generation)"))) {
            tailRejects++;
            throw new Error("controlled tail rejection");
          }
          return f.sql.batch(plans);
        },
      };
      expect(await makeReader(rejected).readMany(claims)).toBeNull();
      expect(tailRejects).toBe(1);
    } finally {
      f.close();
    }
  }
});

test("0.8 bulk selects each exact target Form only after sealed references; invalid seal prevents targets", async () => {
  const f = await containerConsumerFixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker"),
      bundle = await f.create(WORKER_BUNDLE_FORM_URL, "bundle"),
      one = await f.create(C.formUrl, "one"),
      two = await f.create(CONTAINER_0_2_FORM_URL, "two");
    const version = await f.create(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      containerBindings: [
        { name: "LEGACY", resource: { resourceUid: one.resourceUid } },
        { name: "APP", resource: { resourceUid: two.resourceUid } },
      ],
    });
    const claims = [
      f.claimFor(version, "LEGACY", one.resourceUid),
      f.claimFor(version, "APP", two.resourceUid),
    ];
    let batches = 0,
      targetQueries = 0;
    const forms: unknown[] = [];
    const sql: Sql = {
      ...f.sql,
      batch: async (plans) => {
        batches++;
        for (const plan of plans)
          if (plan.sql.includes("JOIN tf_v2_operations observed")) {
            expect(batches).toBe(2);
            targetQueries++;
            forms.push(plan.params?.at(-1));
          }
        return f.sql.batch(plans);
      },
    };
    const rows = await makeReader(sql).readMany(claims);
    expect(rows?.map((r) => r.targetFormUrl)).toEqual([C.formUrl, CONTAINER_0_2_FORM_URL]);
    expect(forms).toEqual([C.formUrl, CONTAINER_0_2_FORM_URL]);
    expect(targetQueries).toBe(2);
    targetQueries = 0;
    const badSeal: Sql = {
      ...f.sql,
      batch: async (plans) => {
        for (const plan of plans)
          if (plan.sql.includes("JOIN tf_v2_operations observed")) targetQueries++;
        const rows = await f.sql.batch(plans);
        return rows.map((row, index) => (index ? row : { ...row, rows: [{ sealed: "1" }] }));
      },
    };
    expect(await makeReader(badSeal).readMany(claims)).toBeNull();
    expect(targetQueries).toBe(0);
  } finally {
    f.close();
  }
});
