import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import { type JsonObject, type Sql, SqlError } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Backend, V2Form } from "../src/takoform-v2/types.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const targetKey = "current-serving-budget-d1";

async function exercise(versionCount: 2 | 8, largeVars = false): Promise<void> {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-current-serving-budget-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-current-serving-budget-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS.filter(({ name }) => /^00(?:7\d|8\d)_/u.test(name))) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    const base = createD1Sql(database);
    let counting = false;
    let statements = 0;
    const count = (quantity = 1) => {
      if (counting) statements += quantity;
    };
    const sql: Sql = {
      async query(statement, params) {
        count();
        const rows = await base.query(statement, params);
        // Miniflare accepts oversized result rows. Apply D1's published row
        // ceiling only to the new fence to catch JSON double-escaping here.
        // This is not live D1 admission proof: the existing replay query also
        // returns the large request fingerprint beside accepted_spec_json.
        if (largeVars && statement.includes("SELECT kind, body FROM (")) {
          for (const row of rows) {
            const bytes = Object.entries(row).reduce(
              (total, [key, value]) =>
                total +
                key.length +
                (typeof value === "string"
                  ? new TextEncoder().encode(value).byteLength
                  : Array.isArray(value)
                    ? value.length
                    : 8),
              0,
            );
            if (bytes > 2_000_000) throw new SqlError("unavailable", "D1 result row exceeds 2 MB");
          }
        }
        return rows;
      },
      async run(statement, params) {
        count();
        return base.run(statement, params);
      },
      async batch(batch) {
        count(batch.length);
        return base.batch(batch);
      },
    };
    const source = new Map<string, Uint8Array>();
    const bundleHost = createWorkerBundleHost({
      sql,
      targetKey,
      source: {
        async read({ url }) {
          const bytes = source.get(url);
          if (!bytes) throw new Error("fixture source unavailable");
          return bytes;
        },
      },
    });
    const backend: V2Backend = {
      id: "current-serving-budget-fixture",
      targetKey,
      async execute(input) {
        return {
          kind: "complete",
          observed:
            input.form === WORKER_VERSION_FORM_URL
              ? { ready: true, resolvedBindings: true, bundleVerified: true }
              : input.form === WORKER_DEPLOYMENT_FORM_URL
                ? { ready: true, active: true, selectedVersions: [] }
                : { ready: true },
          output: input.previousOutput,
        };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    };
    const form = (references?: V2Form["references"]): V2Form => ({
      validateCreate() {},
      validateUpdate() {},
      backend,
      ...(references ? { references } : {}),
    });
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3600,
      authorize: async () => true,
      forms: {
        [MODULE_WORKER_FORM_URL]: form(),
        [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
        [WORKER_VERSION_FORM_URL]: form((spec) => [
          {
            resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
            formUrl: MODULE_WORKER_FORM_URL,
            readiness: "observed",
          },
          {
            resourceUid: (spec.bundle as { resourceUid: string }).resourceUid,
            formUrl: WORKER_BUNDLE_FORM_URL,
            readiness: "observed",
          },
        ]),
        [WORKER_DEPLOYMENT_FORM_URL]: form((spec) => [
          {
            resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
            formUrl: MODULE_WORKER_FORM_URL,
            readiness: "observed",
          },
          ...(spec.versions as { workerVersion: { resourceUid: string } }[]).map((item) => ({
            resourceUid: item.workerVersion.resourceUid,
            formUrl: WORKER_VERSION_FORM_URL,
            readiness: "ready" as const,
            targetSpecMatch: {
              path: ["worker", "resourceUid"],
              equals: (spec.worker as { resourceUid: string }).resourceUid,
            },
          })),
        ]),
      },
    });
    let nextKey = 0;
    const create = async (formUrl: string, name: string, spec: JsonObject) => {
      const accepted = await engine.acceptCreate({
        principal: "org-budget",
        key: `budget-create-operation-${++nextKey}`,
        input: { form: formUrl, space: "prod", name, spec },
      });
      expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
      return accepted;
    };
    const digest = async (bytes: Uint8Array) => (await bytesDigest(bytes)).slice(7);
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bundles = [];
    const versions = [];
    for (let v = 0; v < versionCount; v += 1) {
      const files = [];
      for (let i = 0; i < 2; i += 1) {
        const path = i === 0 ? "index.mjs" : "helper.mjs";
        const url = `https://artifacts.example.test/budget-${v}/${path}`;
        const bytes = new TextEncoder().encode(
          i === 0
            ? "import './helper.mjs'; export default { fetch() { return new Response('ok'); } };"
            : `export const version = ${v};`,
        );
        source.set(url, bytes);
        files.push({
          path,
          url,
          sha256: await digest(bytes),
          mediaType: "application/javascript+module",
        });
      }
      const manifestUrl = `https://artifacts.example.test/budget-${v}/manifest.json`;
      const manifest = new TextEncoder().encode(JSON.stringify({ entrypoint: "index.mjs", files }));
      source.set(manifestUrl, manifest);
      const bundle = await create(WORKER_BUNDLE_FORM_URL, `bundle-${v}`, {
        artifact: { url: manifestUrl, sha256: await digest(manifest) },
      });
      bundles.push(bundle);
      const vars =
        largeVars && v === 0
          ? Object.fromEntries(
              Array.from({ length: 64 }, (_, index) => [
                `V${String(index).padStart(2, "0")}`,
                "\\".repeat(7_950),
              ]),
            )
          : {};
      const spec = {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
        ...(largeVars && v === 0 ? { vars } : {}),
      };
      if (largeVars && v === 0) {
        expect(parseWorkerVersionSpec(spec).vars).toHaveProperty("V00");
        const specBytes = new TextEncoder().encode(canonicalJson(spec)).byteLength;
        expect(specBytes).toBeGreaterThan(1_000_000);
        expect(specBytes).toBeLessThanOrEqual(1_048_576);
      }
      versions.push(await create(WORKER_VERSION_FORM_URL, `version-${v}`, spec));
    }
    source.clear(); // Serving must use held bytes, not the external source.
    const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: versions.map((version, index) => ({
        workerVersion: { resourceUid: version.resourceUid },
        weight: versionCount === 2 ? 5_000 : index === 7 ? 3_000 : 1_000,
      })),
    });
    const reader = createV2WorkerPublicationState({ sql, bundleCustody: bundleHost.custody });
    counting = true;
    const ready = await reader.resolveCurrentServing({
      workerUid: worker.resourceUid,
      targetKey,
      sourceOperationId: deployment.id,
      expectedIdentity: {
        generation: `takoserver-v2-operation:${deployment.id}`,
        workerResourceUid: worker.resourceUid,
        hostnames: [],
        versions: versions.map((version, index) => ({
          workerVersionUid: version.resourceUid,
          weight: versionCount === 2 ? 5_000 : index === 7 ? 3_000 : 1_000,
        })),
      },
    });
    if (ready.kind !== "ready") throw new Error(`${ready.code}: ${ready.message}`);
    const firstVersion = versions[0];
    const secondVersion = versions[1];
    const secondBundle = bundles[1];
    if (!firstVersion || !secondVersion || !secondBundle)
      throw new Error("weighted fixture is incomplete");
    for (let i = 0; i < (largeVars ? 1 : 5); i += 1) expect(await ready.stillCurrent()).toBe(true);
    expect((await ready.readVersionMaterials(firstVersion.resourceUid)).bundle?.files.length).toBe(
      2,
    );
    counting = false;
    // This is only the Core part of the private caller pattern. Keep at least
    // 300 of D1's 1000 statements for private Queue/native custody and readback;
    // the owning private caller still needs its own whole-invocation check.
    expect(statements).toBeLessThan(versionCount === 2 ? 300 : 700);
    await sql.run("UPDATE tf_v2_resources SET output_json = ? WHERE uid = ?", [
      JSON.stringify({ unexpected: true }),
      secondVersion.resourceUid,
    ]);
    expect(await ready.stillCurrent()).toBe(false);
    await sql.run("UPDATE tf_v2_resources SET output_json = '{}' WHERE uid = ?", [
      secondVersion.resourceUid,
    ]);
    expect(await ready.stillCurrent()).toBe(true);
    const observed = (
      await sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
        secondVersion.resourceUid,
      ])
    )[0]?.observed_json;
    if (typeof observed !== "string") throw new Error("Version observation is unavailable");
    await sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      JSON.stringify({ ready: false, resolvedBindings: false, bundleVerified: false }),
      secondVersion.resourceUid,
    ]);
    expect(await ready.stillCurrent()).toBe(false);
    await sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      observed,
      secondVersion.resourceUid,
    ]);
    expect(await ready.stillCurrent()).toBe(true);
    await sql.run("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ? AND file_index = 1", [
      secondBundle.resourceUid,
    ]);
    expect(await ready.stillCurrent()).toBe(false);
  } finally {
    await runtime.dispose();
  }
}

test(
  "real D1 rechecks a weighted two-Version multi-file serving graph across native awaits",
  () => exercise(2),
  60_000,
);
test(
  "real D1 keeps eight weighted multi-file Versions within the Core query budget",
  () => exercise(8),
  60_000,
);
test(
  "the D1 fence keeps a Form-legal escaped Version spec below the result-row cap",
  () => exercise(2, true),
  60_000,
);

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
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
