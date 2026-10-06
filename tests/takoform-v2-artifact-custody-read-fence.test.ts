import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bytesDigest } from "../src/json.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createSqlArtifactCustody } from "../src/takoform-v2/forms/artifact-custody.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";

const TARGET_FORM = "https://forms.example.test/unit/HeldArtifact/1.0.0/";
const CONSUMER_FORM = "https://forms.example.test/unit/Consumer/1.0.0/";
const MANIFEST_URL = "https://artifacts.example.test/read-fence/manifest.json";
const FILE_URL = "https://artifacts.example.test/read-fence/payload.bin";

interface Probe {
  readSucceeded: boolean;
  readError?: unknown;
  graphAuthorizationCalls: number;
}

async function fixture(
  input: {
    beforeRead?: (context: {
      db: Database;
      execution: V2Execution;
      advance: (ms: number) => void;
    }) => void;
    onChunkRead?: (context: {
      advance: (ms: number) => void;
      db: Database;
      targetUid: string;
    }) => Promise<void>;
    afterAuthorizationQuery?: (context: {
      call: number;
      advance: (ms: number) => void;
    }) => Promise<void>;
    readMode?: "reference" | "graph";
    graphAuthorized?: (call: number) => boolean;
    graphExpectedSpec?: JsonObject;
    mutateExecution?: (execution: V2Execution) => V2Execution;
  } = {},
): Promise<Probe> {
  const db = new Database(":memory:");
  try {
    for (const name of [
      "0070_takoform_v2.sql",
      "0071_v2_sqlite_migration_set_custody.sql",
      "0072_v2_artifact_custody.sql",
      "0073_v2_reference_acceptance.sql",
      "0075_v2_artifact_progress.sql",
    ])
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const base = createSqliteSql(db);
    let nowMs = Date.now();
    let chunkReadArmed = false;
    let authorizationCalls = 0;
    let targetUid = "";
    const advance = (ms: number) => {
      nowMs += ms;
    };
    const sql: Sql = {
      async query(statement, params) {
        if (chunkReadArmed && statement.includes("SELECT chunk_index, bytes")) {
          chunkReadArmed = false;
          await input.onChunkRead?.({ advance, db, targetUid });
        }
        const rows = await base.query(statement, params);
        if (statement.includes("SELECT op.accepted_spec_json")) {
          authorizationCalls += 1;
          await input.afterAuthorizationQuery?.({ call: authorizationCalls, advance });
        }
        return rows;
      },
      run: (statement, params) => base.run(statement, params),
      batch: (statements) => base.batch(statements),
    };
    const payload = new TextEncoder().encode("immutable artifact bytes");
    const fileSha256 = (await bytesDigest(payload)).slice(7);
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        files: [{ url: FILE_URL, sha256: fileSha256 }],
      }),
    );
    const manifestSha256 = (await bytesDigest(manifest)).slice(7);
    const blobs = new Map([
      [MANIFEST_URL, manifest],
      [FILE_URL, payload],
    ]);
    const custody = createSqlArtifactCustody({
      sql,
      now: () => new Date(nowMs),
      source: {
        async read({ url }) {
          const bytes = blobs.get(url);
          if (!bytes) throw new Error("source gone");
          return bytes;
        },
      },
      layout: "artifact-0072",
      formUrl: TARGET_FORM,
      limits: { manifestBytes: 1024, fileBytes: 1024, aggregateBytes: 1024 },
      parseSpec(spec: JsonObject) {
        return spec as unknown as { artifact: { url: string; sha256: string } };
      },
      parseManifest(bytes) {
        return JSON.parse(new TextDecoder().decode(bytes)) as {
          files: readonly { url: string; sha256: string }[];
        };
      },
      async validatePayload() {
        return { observed: { ready: true }, output: {} };
      },
      async projectVerified() {
        return { observed: { ready: true }, output: {} };
      },
      invalidArtifact: () => new Error("invalid artifact"),
      invalidManifest: () => new Error("invalid manifest"),
      failureNoun: "Artifact",
    });
    const probe: Probe = { readSucceeded: false, graphAuthorizationCalls: 0 };
    const targetSpec: JsonObject = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
    const targetForm: V2Form = {
      validateCreate() {},
      validateUpdate() {},
      backend: {
        id: "held-artifact-fixture",
        targetKey: "fixture-sqlite",
        execute: custody.execute,
        reconcile: custody.execute,
      },
    };
    const consumerForm: V2Form = {
      validateCreate() {},
      validateUpdate() {},
      references() {
        return [{ resourceUid: targetUid, formUrl: TARGET_FORM, readiness: "ready" }];
      },
      backend: {
        id: "consumer-fixture",
        targetKey: "fixture-sqlite",
        async execute(execution) {
          input.beforeRead?.({ db, execution, advance });
          chunkReadArmed = input.onChunkRead !== undefined;
          try {
            const read =
              input.readMode === "graph"
                ? await custody.readHeldVerified({
                    targetResourceUid: targetUid,
                    principal: execution.principal,
                    space: execution.space,
                    expectedSpec: input.graphExpectedSpec ?? targetSpec,
                    expectedObserved: { ready: true },
                    stillAuthorized: async () => {
                      probe.graphAuthorizationCalls += 1;
                      return input.graphAuthorized?.(probe.graphAuthorizationCalls) ?? true;
                    },
                  })
                : await custody.readVerified({
                    execution: input.mutateExecution?.(execution) ?? execution,
                    targetResourceUid: targetUid,
                  });
            probe.readSucceeded =
              read.files.length === 1 &&
              new TextDecoder().decode(read.files[0]) === "immutable artifact bytes";
          } catch (error) {
            probe.readError = error;
          }
          return { kind: "complete" as const, observed: {}, output: {} };
        },
        async reconcile(execution) {
          return await this.execute(execution);
        },
      },
    };
    const engine = createTakoformV2Engine({
      sql,
      now: () => new Date(nowMs),
      replayWindowSeconds: 3600,
      leaseMilliseconds: 60_000,
      authorize: async () => true,
      forms: { [TARGET_FORM]: targetForm, [CONSUMER_FORM]: consumerForm },
    });
    const target = await engine.acceptCreate({
      principal: "alice",
      key: "target-artifact-create-key",
      input: { form: TARGET_FORM, space: "prod", name: "artifact", spec: targetSpec },
    });
    targetUid = target.resourceUid;
    expect(await engine.runNext()).toMatchObject({ id: target.id, status: "succeeded" });
    blobs.clear();
    const consumer = await engine.acceptCreate({
      principal: "alice",
      key: "consumer-artifact-create-key",
      input: { form: CONSUMER_FORM, space: "prod", name: "consumer", spec: {} },
    });
    expect(await engine.runNext()).toMatchObject({ id: consumer.id, status: "succeeded" });
    return probe;
  } finally {
    db.close();
  }
}

test("a current dispatched claim reads the exact held artifact", async () => {
  const probe = await fixture();
  expect(probe.readSucceeded).toBe(true);
  expect(probe.readError).toBeUndefined();
});

test("expired but unreclaimed lease cannot read held bytes", async () => {
  const probe = await fixture({ beforeRead: ({ advance }) => advance(60_001) });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
});

test("a claim without dispatch authority cannot read held bytes", async () => {
  const probe = await fixture({
    beforeRead({ db, execution }) {
      db.query("UPDATE tf_v2_operations SET dispatch_possible = 0 WHERE id = ?").run(
        execution.operationId,
      );
    },
  });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
});

test("an action-mismatched execution cannot read held bytes", async () => {
  const probe = await fixture({
    mutateExecution: (execution) => ({ ...execution, action: "update" }),
  });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
});

test("accepted spec and current consumer Resource spec must still match", async () => {
  const probe = await fixture({
    beforeRead({ db, execution }) {
      db.query("UPDATE tf_v2_resources SET spec_json = ? WHERE uid = ?").run(
        '{"tampered":true}',
        execution.resourceUid,
      );
    },
  });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
});

test("lease expiry during an awaited chunk read fences final projection", async () => {
  const probe = await fixture({
    async onChunkRead({ advance }) {
      await Promise.resolve();
      advance(60_001);
    },
  });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
});

test("lease expiry while the final authorization SQL result is in flight fences projection", async () => {
  const probe = await fixture({
    async afterAuthorizationQuery({ call, advance }) {
      if (call === 2) {
        await Promise.resolve();
        advance(60_001);
      }
    },
  });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
});

test("internal graph read rejects a caller projection that differs from held target spec", async () => {
  const probe = await fixture({ readMode: "graph", graphExpectedSpec: {} });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
});

test("internal graph read rejects target mutation during awaited byte inspection", async () => {
  const probe = await fixture({
    readMode: "graph",
    async onChunkRead({ db, targetUid }) {
      await Promise.resolve();
      db.query("UPDATE tf_v2_resources SET spec_json = ? WHERE uid = ?").run(
        '{"artifact":{"url":"https://other.example.test/","sha256":"bad"}}',
        targetUid,
      );
    },
  });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
});

test("the internal graph read uses only held verified bytes after source removal", async () => {
  const probe = await fixture({ readMode: "graph" });
  expect(probe.readSucceeded).toBe(true);
  expect(probe.readError).toBeUndefined();
  expect(probe.graphAuthorizationCalls).toBe(2);
});

test("the internal graph read requires an authorized graph before custody access", async () => {
  const probe = await fixture({ readMode: "graph", graphAuthorized: () => false });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
  expect(probe.graphAuthorizationCalls).toBe(1);
});

test("the internal graph read fences a graph that changes while bytes are awaited", async () => {
  const probe = await fixture({ readMode: "graph", graphAuthorized: (call) => call === 1 });
  expect(probe.readSucceeded).toBe(false);
  expect(probe.readError).toBeDefined();
  expect(probe.graphAuthorizationCalls).toBe(2);
});
