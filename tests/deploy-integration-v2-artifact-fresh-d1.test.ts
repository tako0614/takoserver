import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import type { FreshV2DataReadback } from "../scripts/deploy/fresh-v2-data-readback.ts";
import {
  type IntegrationStorageGenerationProcess,
  runIntegrationStorageGeneration,
  verifyFreshV2ArtifactIntegrationStorageTarget,
  verifyFreshV2IntegrationStorageTarget,
} from "../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape } from "../scripts/deploy/migrations.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";

const ORIGIN = "https://api.fresh-v2-d1.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const GENERATION = "a".repeat(32);
const NAME = `takoserver-i-${GENERATION}`;
const DATABASE_ID = "00000000-0000-4000-8000-000000000075";
const ORGANIZATION = "org-fresh-v2-d1";
const TOKEN = "fresh-v2-d1-test-token";
const CASES = [
  {
    form: SQLITE_MIGRATION_SET_FORM_URL,
    slug: "sqlite",
    path: "0001.sql",
    mediaType: "application/sql",
    contents: "CREATE TABLE not_executed (id INTEGER);\n",
  },
  {
    form: WORKER_BUNDLE_FORM_URL,
    slug: "worker",
    path: "worker.js",
    mediaType: "application/javascript+module",
    contents: "export default { fetch() { return new Response('not run'); } };\n",
  },
  {
    form: STATIC_ASSET_BUNDLE_FORM_URL,
    slug: "assets",
    path: "public/site.css",
    mediaType: "text/css",
    contents: "body { color: #123; }\n",
  },
] as const;

test("fresh selected 0075 payload on real Miniflare D1 serves artifact Forms after local 0081 closure", async () => {
  const artifacts = await Promise.all(
    CASES.map(async ({ slug, path, mediaType, contents }) => {
      const fileBytes = new TextEncoder().encode(contents);
      const fileSha256 = (await bytesDigest(fileBytes)).slice(7);
      const fileUrl = `https://artifacts.example.test/${slug}/${path}`;
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          ...(slug === "worker" ? { entrypoint: path } : {}),
          files: [{ path, url: fileUrl, sha256: fileSha256, mediaType }],
        }),
      );
      const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
      const manifestUrl = `https://artifacts.example.test/${slug}/manifest.json`;
      const manifestKey = `held/${slug}/manifest`;
      const fileKey = `held/${slug}/file`;
      const grants = [{ principal: `org:${ORGANIZATION}`, space: ORGANIZATION }];
      return {
        spec: { artifact: { url: manifestUrl, sha256: manifestSha256 } },
        manifestKey,
        fileKey,
        manifestBytes,
        fileBytes,
        heldArtifacts: [
          { url: manifestUrl, sha256: manifestSha256, objectKey: manifestKey, grants },
          { url: fileUrl, sha256: fileSha256, objectKey: fileKey, grants },
        ],
      };
    }),
  );
  const config = JSON.stringify({
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/v2/authentication",
    sqliteMigrationSet: { targetKey: "fresh-sqlite", heldArtifacts: artifacts[0]?.heldArtifacts },
    workerBundle: { targetKey: "fresh-worker", heldArtifacts: artifacts[1]?.heldArtifacts },
    staticAssetBundle: { targetKey: "fresh-assets", heldArtifacts: artifacts[2]?.heldArtifacts },
  });
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "helpers/takoform-v2-entry-worker-miniflare.ts")],
    target: "browser",
    format: "esm",
  });
  expect(build.success).toBe(true);
  const bundle = build.outputs[0];
  if (!bundle) throw new Error("missing Worker test bundle");
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "fresh-v2-artifact-entry",
          type: "worker",
          compatibilityDate: "2026-08-17",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: await bundle.text() } },
          },
          env: {
            STATE_DB: { type: "d1", id: NAME },
            OBJECTS: { type: "r2", name: NAME },
            PUBLIC_ORIGIN: { type: "text", value: ORIGIN },
            WORKER_VERSION: {
              type: "json",
              value: { id: "00000000-0000-4000-8000-0000000000a1" },
            },
            TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: { type: "text", value: "A".repeat(43) },
            TAKOSERVER_TAKOFORM_V2_CONFIG: { type: "text", value: config },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    const d1 = await runtime.getD1Database("STATE_DB");
    const target = {
      kind: "takoserver.deploy-target@v2",
      environment: "integration",
      accountId: "b".repeat(32),
      workerName: "takoserver-api-integration",
      d1: {
        databaseName: "takoserver-runtime-integration",
        databaseId: "00000000-0000-4000-8000-000000000001",
      },
      r2: { bucketName: "takoserver-objects-integration" },
      publicOrigin: ORIGIN,
      signing: { currentKeyId: "integration-current" },
    } satisfies DeployTarget;
    let d1Created = false;
    let r2Created = false;
    let importCount = 0;
    const provider = {
      async listD1(name: string) {
        expect(name).toBe(NAME);
        return d1Created ? [{ name, uuid: DATABASE_ID }] : [];
      },
      async getD1(id: string) {
        expect(id).toBe(DATABASE_ID);
        return { name: NAME, uuid: DATABASE_ID };
      },
      async createD1(name: string) {
        expect(name).toBe(NAME);
        d1Created = true;
        return { name, uuid: DATABASE_ID };
      },
      async listR2(name: string) {
        expect(name).toBe(NAME);
        return r2Created ? [{ name }] : [];
      },
      async getR2(name: string) {
        expect(name).toBe(NAME);
        return { name };
      },
      async createR2(name: string) {
        expect(name).toBe(NAME);
        expect(importCount).toBe(1);
        r2Created = true;
        return { name };
      },
    };
    const run: IntegrationStorageGenerationProcess = async (command) => {
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(`${"c".repeat(40)}\n`);
      if (key === "git branch --show-current") return ok("fresh-v2-test\n");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
      if (key === "bun run check:migrations") return ok("green\n");
      if (command.includes("execute") && command.includes("--file")) {
        const file = command[command.indexOf("--file") + 1];
        if (!file) throw new Error("no sealed import path");
        importCount += 1;
        await applySealedD1Prefix(d1, file, 75);
        return ok("imported\n");
      }
      throw new Error(`unexpected local test command ${key}`);
    };
    const invocation = {
      action: "apply",
      environment: "integration",
      commit: "c".repeat(40),
      generation: GENERATION,
      freshLineage: "v2-artifacts-0075",
    } as const;
    const result = await runIntegrationStorageGeneration(invocation, target, {
      provider,
      run,
      review: "test-review",
      reader: { read: async () => await d1State(d1) },
    });
    expect(result).toMatchObject({ freshLineage: "v2-artifacts-0075" });
    expect((result.appliedMigrations as string[]).at(-1)).toBe("0075_v2_artifact_progress.sql");
    expect(importCount).toBe(1);
    const generatedTarget = {
      ...target,
      d1: { databaseName: NAME, databaseId: DATABASE_ID },
      r2: { bucketName: NAME },
    } satisfies DeployTarget;
    const proof = await verifyFreshV2ArtifactIntegrationStorageTarget(
      generatedTarget,
      "integration",
      { provider, reader: { read: async () => await d1State(d1) } },
    );
    expect(result.migrationDigest).toBe(proof.migrationDigest);
    const sql = createD1Sql(d1);
    const now = new Date().toISOString();
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      [ORGANIZATION, "Fresh v2 D1", "principal-fresh-v2", now],
    );
    await sql.run(
      "INSERT INTO auth_tokens (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at, revoked_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, NULL)",
      [
        await bytesDigest(new TextEncoder().encode(TOKEN)),
        "key-fresh-v2",
        "principal-fresh-v2",
        ORGANIZATION,
        "fresh-v2-test",
        JSON.stringify(["resources:write"]),
        now,
        new Date(Date.now() + 3_600_000).toISOString(),
      ],
    );
    const r2 = await runtime.getR2Bucket("OBJECTS");
    for (const artifact of artifacts) {
      await r2.put(artifact.manifestKey, artifact.manifestBytes);
      await r2.put(artifact.fileKey, artifact.fileBytes);
    }
    const unclosedSupport = await runtime.dispatchFetch(
      `${BASE}/support?form=${encodeURIComponent(SQLITE_MIGRATION_SET_FORM_URL)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(unclosedSupport.status).toBe(503);
    expect(await sql.query("SELECT count(*) AS count FROM tf_v2_operations")).toEqual([
      { count: 0 },
    ]);
    // The 0075 generation proof above is unchanged. The current Host needs the
    // later source-only 0081 closure before this local D1 fixture may serve.
    const closure = MIGRATIONS.findIndex(({ name }) => name === "0081_v2_private_inputs.sql");
    if (closure < 75) throw new Error("missing 0081 fixture closure");
    for (const migration of MIGRATIONS.slice(75, closure + 1)) {
      for (const statement of splitMigration(migration.sql)) {
        await d1.prepare(statement).run();
      }
      await d1.prepare('INSERT INTO "d1_migrations" (name) VALUES (?)').bind(migration.name).run();
    }
    for (const [index, fixture] of CASES.entries()) {
      const artifact = artifacts[index];
      if (!artifact) throw new Error("missing artifact fixture");
      const authorization = `Bearer ${TOKEN}`;
      const created = await runtime.dispatchFetch(`${BASE}/resources`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": `fresh-v2-create-${index}`,
        },
        body: JSON.stringify({
          form: fixture.form,
          space: ORGANIZATION,
          name: `fresh-${index}`,
          spec: artifact.spec,
        }),
      });
      expect(created.status).toBe(202);
      const accepted = (await created.json()) as { id: string; resourceUid: string };
      await settle(runtime, accepted.id);
      const read = await runtime.dispatchFetch(`${BASE}/resources/${accepted.resourceUid}`, {
        headers: { authorization },
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ generation: 1, observedGeneration: 1 });
      await r2.delete(artifact.manifestKey);
      await r2.delete(artifact.fileKey);
      const updated = await runtime.dispatchFetch(`${BASE}/resources/${accepted.resourceUid}`, {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": `fresh-v2-update-${index}`,
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify({ spec: artifact.spec }),
      });
      expect(updated.status).toBe(202);
      await settle(runtime, String(((await updated.json()) as { id: string }).id));
      const deleted = await runtime.dispatchFetch(`${BASE}/resources/${accepted.resourceUid}`, {
        method: "DELETE",
        headers: {
          authorization,
          "idempotency-key": `fresh-v2-delete-${index}`,
          "takoform-expected-generation": "2",
        },
      });
      expect(deleted.status).toBe(202);
      await settle(runtime, String(((await deleted.json()) as { id: string }).id));
      const gone = await runtime.dispatchFetch(`${BASE}/resources/${accepted.resourceUid}`, {
        headers: { authorization },
      });
      expect(gone.status).toBe(410);
    }
    expect(
      await sql
        .query("SELECT count(*) AS count FROM not_executed")
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("partial real D1 import remains quarantined: status diagnoses, apply cannot adopt or retry", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "fresh-v2-partial-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "fresh-v2-partial-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const d1 = await runtime.getD1Database("STATE_DB");
    const target = {
      kind: "takoserver.deploy-target@v2",
      environment: "integration",
      accountId: "b".repeat(32),
      workerName: "takoserver-api-integration",
      d1: {
        databaseName: "takoserver-runtime-integration",
        databaseId: "00000000-0000-4000-8000-000000000001",
      },
      r2: { bucketName: "takoserver-objects-integration" },
      publicOrigin: ORIGIN,
      signing: { currentKeyId: "integration-current" },
    } satisfies DeployTarget;
    let created = false;
    let r2Creates = 0;
    let importCalls = 0;
    const provider = {
      async listD1() {
        return created ? [{ name: NAME, uuid: DATABASE_ID }] : [];
      },
      async getD1() {
        return { name: NAME, uuid: DATABASE_ID };
      },
      async createD1() {
        created = true;
        return { name: NAME, uuid: DATABASE_ID };
      },
      async listR2() {
        return [];
      },
      async getR2() {
        return { name: NAME };
      },
      async createR2() {
        r2Creates += 1;
        return { name: NAME };
      },
    };
    const run: IntegrationStorageGenerationProcess = async (command) => {
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(`${"c".repeat(40)}\n`);
      if (key === "git branch --show-current") return ok("fresh-v2-test\n");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
      if (key === "bun run check:migrations") return ok("green\n");
      if (command.includes("execute") && command.includes("--file")) {
        const path = command[command.indexOf("--file") + 1];
        if (!path) throw new Error("no import path");
        importCalls += 1;
        await applySealedD1Prefix(d1, path, 70);
        return { exitCode: 1, stdout: "untrusted output", stderr: "untrusted error" };
      }
      throw new Error(`unexpected local test command ${key}`);
    };
    const invocation = {
      action: "apply",
      environment: "integration",
      commit: "c".repeat(40),
      generation: GENERATION,
      freshLineage: "v2-artifacts-0075",
    } as const;
    await expect(
      runIntegrationStorageGeneration(invocation, target, {
        provider,
        run,
        review: "test-review",
        reader: { read: async () => await d1State(d1) },
      }),
    ).rejects.toMatchObject({ phase: "mutation" });
    expect(importCalls).toBe(1);
    expect(r2Creates).toBe(0);
    const status = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      target,
      { provider, run, reader: { read: async () => await d1State(d1) } },
    );
    expect(status).toMatchObject({
      d1: { databaseId: DATABASE_ID },
      schemaReadback: "incomplete-or-divergent",
      readyForApply: false,
    });
    await expect(
      runIntegrationStorageGeneration(invocation, target, {
        provider,
        run,
        review: "test-review",
        reader: { read: async () => await d1State(d1) },
      }),
    ).rejects.toThrow("never adopted");
    expect(importCalls).toBe(1);
    expect(r2Creates).toBe(0);
  } finally {
    await runtime.dispose();
  }
}, 120_000);

/** A production D1 identity the staging guard compares against; never touched. */
const PRODUCTION_D1 = {
  databaseName: "takoserver-runtime",
  databaseId: "85c5a15d-a80f-42fe-a907-7ec0d86e008e",
} as const;

for (const lineage of ["v2-0088", "v2-0089", "v2-0091", "v2-0092"] as const) {
  const count =
    lineage === "v2-0092" ? 92 : lineage === "v2-0091" ? 91 : lineage === "v2-0089" ? 89 : 88;
  test(`fresh selected ${lineage} payload serves artifact Forms with no local schema closure`, async () => {
    const artifacts = await Promise.all(
      CASES.map(async ({ slug, path, mediaType, contents }) => {
        const fileBytes = new TextEncoder().encode(contents);
        const fileSha256 = (await bytesDigest(fileBytes)).slice(7);
        const fileUrl = `https://artifacts.example.test/${slug}/${path}`;
        const manifestBytes = new TextEncoder().encode(
          JSON.stringify({
            ...(slug === "worker" ? { entrypoint: path } : {}),
            files: [{ path, url: fileUrl, sha256: fileSha256, mediaType }],
          }),
        );
        const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
        const manifestUrl = `https://artifacts.example.test/${slug}/manifest.json`;
        const manifestKey = `held/${slug}/manifest`;
        const fileKey = `held/${slug}/file`;
        const grants = [{ principal: `org:${ORGANIZATION}`, space: ORGANIZATION }];
        return {
          spec: { artifact: { url: manifestUrl, sha256: manifestSha256 } },
          manifestKey,
          fileKey,
          manifestBytes,
          fileBytes,
          heldArtifacts: [
            { url: manifestUrl, sha256: manifestSha256, objectKey: manifestKey, grants },
            { url: fileUrl, sha256: fileSha256, objectKey: fileKey, grants },
          ],
        };
      }),
    );
    const config = JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
      sqliteMigrationSet: { targetKey: "fresh-sqlite", heldArtifacts: artifacts[0]?.heldArtifacts },
      workerBundle: { targetKey: "fresh-worker", heldArtifacts: artifacts[1]?.heldArtifacts },
      staticAssetBundle: { targetKey: "fresh-assets", heldArtifacts: artifacts[2]?.heldArtifacts },
    });
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "helpers/takoform-v2-entry-worker-miniflare.ts")],
      target: "browser",
      format: "esm",
    });
    expect(build.success).toBe(true);
    const bundle = build.outputs[0];
    if (!bundle) throw new Error("missing Worker test bundle");
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: `fresh-${lineage}-entry`,
            type: "worker",
            compatibilityDate: "2026-08-17",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: await bundle.text() } },
            },
            env: {
              STATE_DB: { type: "d1", id: `${NAME}-${count}` },
              OBJECTS: { type: "r2", name: `${NAME}-${count}` },
              PUBLIC_ORIGIN: { type: "text", value: ORIGIN },
              WORKER_VERSION: {
                type: "json",
                value: { id: "00000000-0000-4000-8000-0000000000a1" },
              },
              TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: { type: "text", value: "A".repeat(43) },
              TAKOSERVER_TAKOFORM_V2_CONFIG: { type: "text", value: config },
            },
            triggers: [],
          },
        },
      ],
    });
    try {
      const d1 = await runtime.getD1Database("STATE_DB");
      const target = {
        kind: "takoserver.deploy-target@v2",
        environment: "integration",
        accountId: "b".repeat(32),
        workerName: "takoserver-api-integration",
        d1: {
          databaseName: "takoserver-runtime-integration",
          databaseId: "00000000-0000-4000-8000-000000000001",
        },
        r2: { bucketName: "takoserver-objects-integration" },
        publicOrigin: ORIGIN,
        signing: { currentKeyId: "integration-current" },
      } satisfies DeployTarget;
      let d1Created = false;
      let r2Created = false;
      let importCount = 0;
      const provider = {
        async listD1(name: string) {
          return d1Created ? [{ name, uuid: DATABASE_ID }] : [];
        },
        async getD1() {
          return { name: NAME, uuid: DATABASE_ID };
        },
        async createD1(name: string) {
          d1Created = true;
          return { name, uuid: DATABASE_ID };
        },
        async listR2(name: string) {
          return r2Created ? [{ name }] : [];
        },
        async getR2(name: string) {
          return { name };
        },
        async createR2(name: string) {
          // R2 is created only after the schema and seeded-data proofs.
          expect(importCount).toBe(1);
          r2Created = true;
          return { name };
        },
      };
      const run: IntegrationStorageGenerationProcess = async (command) => {
        const key = command.join(" ");
        if (key === "git rev-parse HEAD") return ok(`${"c".repeat(40)}\n`);
        if (key === "git branch --show-current") return ok("fresh-v2-test\n");
        if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
        if (key === "bun run check:migrations") return ok("green\n");
        if (command.includes("execute") && command.includes("--file")) {
          const file = command[command.indexOf("--file") + 1];
          if (!file) throw new Error("no sealed import path");
          importCount += 1;
          await applySealedD1Prefix(d1, file, count, count);
          return ok("imported\n");
        }
        throw new Error(`unexpected local test command ${key}`);
      };
      const reader = { read: async () => await d1State(d1) };
      const freshV2DataReader = { read: async () => await miniflareFreshV2Data(d1) };
      const invocation = {
        action: "apply",
        environment: "integration",
        commit: "c".repeat(40),
        generation: GENERATION,
        freshLineage: lineage,
      } as const;
      const result = await runIntegrationStorageGeneration(invocation, target, {
        provider,
        run,
        review: "test-review",
        reader,
        freshV2DataReader,
        productionD1: PRODUCTION_D1,
      });
      expect(result).toMatchObject({
        freshLineage: lineage,
        productionD1Guard: {
          compared: "naming-and-production-target",
          productionDatabaseName: PRODUCTION_D1.databaseName,
          productionDatabaseId: PRODUCTION_D1.databaseId,
        },
      });
      expect((result.appliedMigrations as string[]).length).toBe(count);
      expect((result.appliedMigrations as string[]).at(-1)).toBe(MIGRATIONS[count - 1]?.name);
      expect(importCount).toBe(1);
      expect(r2Created).toBe(true);
      const status = await runIntegrationStorageGeneration(
        { ...invocation, action: "status" },
        target,
        { provider, run, reader, freshV2DataReader },
      );
      expect(status).toMatchObject({
        schemaReadback: `complete-${String(count).padStart(4, "0")}`,
        dataReadback: "empty-seeded",
        readyForApply: false,
      });
      const generatedTarget = {
        ...target,
        d1: { databaseName: NAME, databaseId: DATABASE_ID },
        r2: { bucketName: NAME },
        takoformV2: { config, storageLineage: lineage },
      } satisfies DeployTarget;
      const proof = await verifyFreshV2IntegrationStorageTarget(
        generatedTarget,
        "integration",
        lineage,
        { provider, reader },
      );
      expect(proof).toMatchObject({
        freshLineage: lineage,
        migrationDigest: result.migrationDigest,
      });
      // An operator-provisioned staging pair over the same exact database
      // passes the same content proofs, but only on the staging-only lineage.
      const STAGING = "takoserver-staging-throwaway-0091-test";
      const stagingProvider = {
        async getD1() {
          return { name: STAGING, uuid: DATABASE_ID };
        },
        async getR2(name: string) {
          return { name };
        },
      };
      const stagingTarget = {
        ...generatedTarget,
        d1: { databaseName: STAGING, databaseId: DATABASE_ID },
        r2: { bucketName: STAGING },
      } satisfies DeployTarget;
      if (lineage === "v2-0091" || lineage === "v2-0092") {
        expect(
          await verifyFreshV2IntegrationStorageTarget(stagingTarget, "integration", lineage, {
            provider: stagingProvider as never,
            reader,
          }),
        ).toMatchObject({
          generation: STAGING,
          freshLineage: lineage,
          d1: { databaseName: STAGING, databaseId: DATABASE_ID },
          migrationDigest: result.migrationDigest,
        });
      } else {
        await expect(
          verifyFreshV2IntegrationStorageTarget(stagingTarget, "integration", lineage, {
            provider: stagingProvider as never,
            reader,
          }),
        ).rejects.toThrow("generated D1/R2 storage pair");
      }
      // The historical selectors never qualify this generation.
      await expect(
        verifyFreshV2ArtifactIntegrationStorageTarget(generatedTarget, "integration", {
          provider,
          reader,
        }),
      ).rejects.toThrow("0001-0075 lineage");
      await expect(
        verifyFreshV2IntegrationStorageTarget(
          generatedTarget,
          "integration",
          lineage === "v2-0088" ? "v2-0089" : "v2-0088",
          { provider, reader },
        ),
      ).rejects.toThrow("lineage");

      const sql = createD1Sql(d1);
      const now = new Date().toISOString();
      await sql.run(
        "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
        [ORGANIZATION, "Fresh v2 D1", "principal-fresh-v2", now],
      );
      // After any application row exists the schema is still complete, but the
      // generation is in use: status says so instead of asking for quarantine.
      const written = await runIntegrationStorageGeneration(
        { ...invocation, action: "status" },
        target,
        { provider, run, reader, freshV2DataReader },
      );
      expect(written).toMatchObject({
        schemaReadback: `complete-${String(count).padStart(4, "0")}`,
        dataReadback: "present",
      });
      expect(String(written.resume)).toContain("in use");
      await sql.run(
        "INSERT INTO auth_tokens (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at, revoked_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, NULL)",
        [
          await bytesDigest(new TextEncoder().encode(TOKEN)),
          "key-fresh-v2",
          "principal-fresh-v2",
          ORGANIZATION,
          "fresh-v2-test",
          JSON.stringify(["resources:write"]),
          now,
          new Date(Date.now() + 3_600_000).toISOString(),
        ],
      );
      const r2 = await runtime.getR2Bucket("OBJECTS");
      for (const artifact of artifacts) {
        await r2.put(artifact.manifestKey, artifact.manifestBytes);
        await r2.put(artifact.fileKey, artifact.fileBytes);
      }
      // Unlike the 0075 payload, no local 0076-0081 closure is applied here.
      for (const [index, fixture] of CASES.entries()) {
        const artifact = artifacts[index];
        if (!artifact) throw new Error("missing artifact fixture");
        const authorization = `Bearer ${TOKEN}`;
        const support = await runtime.dispatchFetch(
          `${BASE}/support?form=${encodeURIComponent(fixture.form)}`,
          { headers: { authorization } },
        );
        expect(support.status).toBe(200);
        const created = await runtime.dispatchFetch(`${BASE}/resources`, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            "idempotency-key": `fresh-${lineage}-create-${index}`,
          },
          body: JSON.stringify({
            form: fixture.form,
            space: ORGANIZATION,
            name: `fresh-${index}`,
            spec: artifact.spec,
          }),
        });
        expect(created.status).toBe(202);
        const accepted = (await created.json()) as { id: string; resourceUid: string };
        await settle(runtime, accepted.id);
        const deleted = await runtime.dispatchFetch(`${BASE}/resources/${accepted.resourceUid}`, {
          method: "DELETE",
          headers: {
            authorization,
            "idempotency-key": `fresh-${lineage}-delete-${index}`,
            "takoform-expected-generation": "1",
          },
        });
        expect(deleted.status).toBe(202);
        await settle(runtime, String(((await deleted.json()) as { id: string }).id));
      }
    } finally {
      await runtime.dispose();
    }
  }, 180_000);
}

async function miniflareFreshV2Data(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
): Promise<FreshV2DataReadback> {
  const tables = (
    await database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);
  const tableCounts: Record<string, number> = {};
  for (const name of tables) {
    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM "${name}"`)
      .first<{ count: number }>();
    tableCounts[name] = row?.count ?? -1;
  }
  const ledger = await database
    .prepare("SELECT COUNT(*) AS count FROM d1_migrations")
    .first<{ count: number }>();
  const foreignKeys = await database
    .prepare("SELECT 1 AS violation FROM pragma_foreign_key_check LIMIT 1")
    .all();
  const invocationEpoch = await database
    .prepare(
      "SELECT singleton, epoch_id, state, opened_at_ms, closed_at_ms FROM tf_cloudflare_provider_invocation_epoch LIMIT 2",
    )
    .all<Record<string, unknown>>();
  const acceptanceCounter = await database
    .prepare(
      "SELECT id, last_order, last_operation_id FROM tf_v2_operation_acceptance_counter LIMIT 2",
    )
    .all<Record<string, unknown>>();
  return {
    tableCounts,
    ledgerRows: ledger?.count ?? -1,
    foreignKeyViolations: foreignKeys.results.length,
    invocationEpoch: invocationEpoch.results,
    acceptanceCounter: acceptanceCounter.results,
  };
}

async function d1State(database: Awaited<ReturnType<Miniflare["getD1Database"]>>) {
  const tables = await database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  const tableNames = tables.results.map((row) => row.name);
  const applied = tableNames.includes("d1_migrations")
    ? (
        await database.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()
      ).results.map((row) => row.name)
    : [];
  const rows = await database
    .prepare(
      "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all<{ type: string; name: string; tbl_name: string; sql: string }>();
  // Miniflare's local D1 emulation adds _cf_METADATA. The production
  // schema reader compares application objects and does not own this row.
  const shape = canonicalSchemaShape(rows.results.filter((row) => row.name !== "_cf_METADATA"));
  return {
    applied,
    shape,
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
  };
}

async function settle(runtime: Miniflare, id: string): Promise<void> {
  for (let pass = 0; pass < 32; pass += 1) {
    const tick = await runtime.dispatchFetch(`${ORIGIN}/__test/run-scheduled`, { method: "POST" });
    expect(tick.status).toBe(204);
    const response = await runtime.dispatchFetch(`${BASE}/operations/${id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const operation = (await response.json()) as { status: string; effect?: string };
    if (operation.status === "succeeded") {
      expect(operation.effect).toBe("complete");
      return;
    }
    if (operation.status === "failed") throw new Error(`operation ${id} failed`);
  }
  throw new Error(`operation ${id} did not settle`);
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

async function applySealedD1Prefix(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  importPath: string,
  count: number,
  sealedLength = 75,
): Promise<void> {
  const importSql = readFileSync(importPath, "utf8");
  expect(importSql).toContain("0075_v2_artifact_progress.sql");
  // Miniflare D1 .exec is line-oriented and cannot consume Wrangler's
  // one-file import transport. Feed the same sealed migration bytes into
  // actual D1 statements with the exact ordered ledger names. This is
  // D1 runtime proof, not remote Wrangler /import qualification.
  await database
    .prepare(
      'CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    )
    .run();
  const migrationDirectory = join(dirname(importPath), "migrations");
  const names = Array.from(
    importSql.matchAll(/values \('([0-9]{4}_[a-z0-9_]+\.sql)'\);/gu),
    (match) => match[1],
  );
  expect(names).toHaveLength(sealedLength);
  for (const name of names.slice(0, count)) {
    if (!name) throw new Error("missing sealed migration name");
    for (const statement of splitMigration(readFileSync(join(migrationDirectory, name), "utf8"))) {
      await database.prepare(statement).run();
    }
    await database.prepare('INSERT INTO "d1_migrations" (name) VALUES (?)').bind(name).run();
  }
}

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    statements.push(rest.slice(0, boundary + 1).trim());
    rest = rest.slice(boundary + 1).trim();
  }
  return statements.filter(Boolean);
}
