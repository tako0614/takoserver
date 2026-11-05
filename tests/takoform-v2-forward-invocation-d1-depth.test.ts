import { expect, test } from "bun:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { root0106Recipe } from "../scripts/deploy/root0106-recipe.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { type Sql, SqlError, type SqlParam, type SqlWrite } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { createContainerConsumerWorkerNativeSourceRecipe } from "../src/takoform-v2/forward-worker-native-schema.ts";
import {
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/worker-form-contract.ts";
import { createForwardV2WorkerInvocationLifecycle } from "../src/takoform-v2/worker-invocation-custody.ts";
import { createV2WorkerNativeIdentityMigrationRecipe } from "../src/takoform-v2/worker-native-identity-schema.ts";
import type { V2WorkerInvocationRetirementIdentity } from "../src/worker-invocation-port.ts";

type LocalD1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;

async function withNativeD1(
  work: (db: LocalD1) => Promise<void>,
  progress?: (phase: string, ordinal?: number) => void,
) {
  progress?.("runtime-create-start");
  const runtime = new Miniflare({
    cf: false,
    log: new Log(LogLevel.ERROR),
    workers: [
      {
        config: {
          name: "forward-invocation-depth",
          type: "worker",
          compatibilityDate: "2026-08-18",
          triggers: [],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('local fixture');}};",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "forward-invocation-depth" } },
        },
      },
    ],
  });
  progress?.("runtime-created");
  try {
    const db = await runtime.getD1Database("STATE_DB");
    progress?.("database-ready");
    // Existing source recipes in fresh local D1 only; no live migration.
    for (const [index, migration] of MIGRATIONS.entries()) {
      for (const statement of frameHostMigrationSql(migration.sql))
        await db.prepare(statement).run();
      if ((index + 1) % 10 === 0 || index + 1 === MIGRATIONS.length)
        progress?.("migration-complete", index + 1);
    }
    progress?.("identity-source-start");
    await db.batch(
      createV2WorkerNativeIdentityMigrationRecipe()
        .steps.flatMap((step) => step.statements)
        .map((sql) => db.prepare(sql)),
    );
    // Select the existing exact registered bytes as well as the new runtime
    // expression. A runtime optimization must never silently repin a recipe.
    await db.batch(frameHostMigrationSql(root0106Recipe().sql).map((sql) => db.prepare(sql)));
    progress?.("native-source-ready");
    await work(db);
    progress?.("work-complete");
  } finally {
    progress?.("dispose-start");
    await runtime.dispose();
    progress?.("dispose-complete");
  }
}

test("Forward invocation authorization compiles within local D1 expression depth and refuses an absent parent", async () => {
  await withNativeD1(async (db) => {
    const raw = createD1Sql(db);
    const errors: string[] = [];
    const changes: number[] = [];
    let phase = "beginSend";
    const statements: { phase: string; bytes: number; parameters: number }[] = [];
    const observe = (statement: string, parameters = 0) => {
      statements.push({ phase, bytes: new TextEncoder().encode(statement).byteLength, parameters });
    };
    const sql: Sql = {
      query(statement, params) {
        observe(statement, params?.length);
        return raw.query(statement, params);
      },
      batch(statements) {
        for (const { sql, params } of statements) observe(sql, params?.length);
        return raw.batch(statements);
      },
      async run(statement, params) {
        observe(statement, params?.length);
        try {
          const result = await raw.run(statement, params);
          changes.push(result.changes);
          return result;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    };
    const lifecycle = createForwardV2WorkerInvocationLifecycle({ sql });
    expect(
      await lifecycle.beginSend({ invocationId: "absent-parent", custodyToken: "fixture-only" }),
    ).toBe(false);
    // False alone can hide a swallowed D1 parse error. The real guarded UPDATE
    // must execute and report zero changes without any parent authority.
    expect(errors).toEqual([]);
    expect(changes).toEqual([0]);
    const handle = { invocationId: "absent-parent", custodyToken: "fixture-only-custody" };
    phase = "read";
    expect(await lifecycle.read(handle)).toBeNull();
    phase = "readPresence";
    expect(await lifecycle.readPresence?.(handle)).toEqual({ kind: "missing" });
    phase = "refuseBeforeSend";
    expect(await lifecycle.refuseBeforeSend(handle)).toBe(false);
    phase = "confirmNoNativeDispatch";
    expect(await lifecycle.confirmNoNativeDispatch(handle)).toBe(false);
    phase = "observeBody";
    expect(await lifecycle.observeBody(handle, "finished")).toBe(false);
    phase = "admitCron";
    const selected = {
      versionUid: "absent-version",
      versionGeneration: 1,
      scriptName: "absent-script",
      weight: 10_000,
      descriptorDigest: `sha256:${"a".repeat(64)}` as const,
      providerEtag: "absent-receipt",
    };
    // Structurally valid negative input reaches the actual SQL, whose accepted
    // graph is absent. This DTO grants no Cron or parent authority.
    expect(
      await lifecycle.admitCron({
        handle,
        match: {
          matchId: `sha256:${"b".repeat(64)}`,
          leaseToken: "fixture-only-lease-token",
          attempt: 1,
        },
        route: {
          targetKey: "absent-target",
          workerUid: "absent-worker",
          deploymentUid: "absent-deployment",
          deploymentGeneration: 1,
          sourceOperationId: "absent-operation",
          releases: [selected],
        },
        selected,
      }),
    ).toEqual({ kind: "unavailable" });
    expect(errors).toEqual([]);
    expect(changes).toEqual([0, 0, 0, 0, 0]);
    const maxBytes = Math.max(...statements.map(({ bytes }) => bytes));
    console.info(
      JSON.stringify({
        kind: "invocation-d1-statement-budget",
        maxBytes,
        headroomBytes: 100_000 - maxBytes,
        phases: [...new Set(statements.map(({ phase }) => phase))].map((phase) => ({
          phase,
          maxBytes: Math.max(...statements.filter((s) => s.phase === phase).map((s) => s.bytes)),
        })),
      }),
    );
    // Local D1 compilation does not prove the hosted API's byte/parameter caps.
    // https://developers.cloudflare.com/d1/platform/limits/ (100 KB / 100 bindings).
    expect(maxBytes).toBeLessThanOrEqual(100_000);
    expect(Math.max(...statements.map(({ parameters }) => parameters))).toBeLessThanOrEqual(100);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM tf_v2_worker_invocations").first())?.n,
    ).toBe(0);
  });
}, 60_000);

test("Forward and consumer SQLite drain and retirement SQL compiles without granting an absent parent", async () => {
  const started = performance.now();
  const progress = (phase: string, ordinal?: number) =>
    console.info(
      JSON.stringify({
        kind: "local-d1-fixture-phase",
        phase,
        ...(ordinal === undefined ? {} : { ordinal }),
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  await withNativeD1(async (db) => {
    for (const profile of [
      {
        name: "forward",
        version: FORWARD_WORKER_VERSION_FORM_URL,
        deployment: FORWARD_WORKER_DEPLOYMENT_FORM_URL,
      },
      {
        name: "consumer",
        version: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
        deployment: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      },
    ] as const) {
      if (profile.name === "consumer")
        await db.batch(
          createContainerConsumerWorkerNativeSourceRecipe()
            .steps.flatMap((step) => step.statements)
            .map((sql) => db.prepare(sql)),
        );
      const raw = createD1Sql(db, { acknowledgement: "explicit-d1-result" });
      const statements: {
        phase: string;
        bytes: number;
        parameters: number;
        verb: "update" | "insert" | "read";
        invocationRowRead: boolean;
      }[] = [];
      const changes: number[] = [];
      const errors: { phase: string; code: string }[] = [];
      let phase = "setup";
      const observe = (statement: string, parameters = 0) => {
        const text = statement.trimStart();
        statements.push({
          phase,
          bytes: new TextEncoder().encode(statement).byteLength,
          parameters,
          invocationRowRead: text.startsWith("SELECT * FROM tf_v2_worker_invocations"),
          verb: text.startsWith("UPDATE")
            ? "update"
            : text.startsWith("INSERT")
              ? "insert"
              : "read",
        });
      };
      const failed = (error: unknown) => {
        errors.push({ phase, code: error instanceof SqlError ? error.code : "unknown" });
      };
      const execute = async (
        statement: string,
        params?: readonly SqlParam[],
      ): Promise<SqlWrite> => {
        observe(statement, params?.length);
        try {
          const result = await raw.run(statement, params);
          changes.push(result.changes);
          return result;
        } catch (error) {
          failed(error);
          throw error;
        }
      };
      const sql: Sql = {
        async query(statement, params) {
          // query and run use the same real D1 .all() operation. Retain its
          // explicit metadata as well as returning the original rows.
          return (await execute(statement, params)).rows;
        },
        run: execute,
        async batch(items) {
          for (const { sql, params } of items) observe(sql, params?.length);
          try {
            const result = await raw.batch(items);
            changes.push(...result.map(({ changes }) => changes));
            return result;
          } catch (error) {
            failed(error);
            throw error;
          }
        },
      };
      const lifecycle = createForwardV2WorkerInvocationLifecycle({
        sql,
        selectedVersionForm: profile.version,
        deploymentForm: profile.deployment,
      });
      const handle = { invocationId: "absent-parent", custodyToken: "fixture-only-custody" };
      // Negative structural input only: no Native Tail, drain or parent receipt
      // is supplied. Every statement must resolve the missing accepted row.
      const expected: V2WorkerInvocationRetirementIdentity = {
        backendId: "absent-backend",
        targetKey: "absent-target",
        principal: "absent-principal",
        space: "absent-space",
        workerUid: "absent-worker",
        deploymentUid: "absent-deployment",
        deploymentGeneration: 1,
        sourceOperationId: "absent-operation",
        ingress: { kind: "endpoint", endpointUid: "absent-endpoint", endpointGeneration: 1 },
        versionUid: "absent-version",
        versionGeneration: 1,
        versionOperationId: "absent-version-operation",
        nativeIdentity: "absent-native",
        closureDigest: `sha256:${"c".repeat(64)}`,
        confirmedReceipt: "absent-receipt",
      };
      const receiptDigest = `sha256:${"d".repeat(64)}` as const;
      const probe = async (name: string, operation: () => Promise<void>) => {
        phase = name;
        progress(`${profile.name}.${name}`);
        const before = statements.length;
        await operation();
        // A false return is insufficient when custody catches a SQL failure.
        expect(statements.length).toBeGreaterThan(before);
        expect(errors).toEqual([]);
        expect(changes.every((value) => value === 0)).toBe(true);
      };
      await probe("armSQLiteExternalUse", async () => {
        expect(await lifecycle.armSQLiteExternalUse({ handle, expected })).toBe(false);
      });
      await probe("confirmSQLiteDrained", async () => {
        expect(await lifecycle.confirmSQLiteDrained({ handle, expected, receiptDigest })).toBe(
          false,
        );
      });
      await probe("confirmNativeRetirement", async () => {
        expect(await lifecycle.confirmNativeRetirement({ handle, expected, receiptDigest })).toBe(
          false,
        );
      });
      await probe("inspectDeployment", async () => {
        expect(await lifecycle.inspectDeployment("absent-deployment")).toEqual({
          outstanding: 0,
          bodyFinished: 0,
        });
      });
      for (const name of [
        "armSQLiteExternalUse",
        "confirmSQLiteDrained",
        "confirmNativeRetirement",
      ]) {
        const observed = statements.filter((item) => item.phase === name);
        expect(observed.some(({ verb }) => verb === "update")).toBe(true);
        expect(observed.some(({ invocationRowRead }) => invocationRowRead)).toBe(true);
      }
      const maxBytes = Math.max(...statements.map(({ bytes }) => bytes));
      const maxParameters = Math.max(...statements.map(({ parameters }) => parameters));
      console.info(
        JSON.stringify({
          kind: "invocation-d1-sqlite-retirement-budget",
          profile: profile.name,
          maxBytes,
          headroomBytes: 100_000 - maxBytes,
          maxParameters,
          phases: [...new Set(statements.map(({ phase }) => phase))].map((phase) => ({
            phase,
            statements: statements.filter((item) => item.phase === phase).length,
            maxBytes: Math.max(
              ...statements.filter((item) => item.phase === phase).map((item) => item.bytes),
            ),
          })),
        }),
      );
      expect(maxBytes).toBeLessThanOrEqual(100_000);
      expect(maxParameters).toBeLessThanOrEqual(100);
      expect(
        (await db.prepare("SELECT count(*) AS n FROM tf_v2_worker_invocations").first())?.n,
      ).toBe(0);
    }
  }, progress);
}, 60_000);
