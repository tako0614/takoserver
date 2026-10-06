import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";

const ORIGIN = "https://api.artifact-entry.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const ORGANIZATION = "org-artifact-entry";
const TOKEN = "artifact-entry-secret-for-http-test";
const READ_ONLY_TOKEN = "artifact-entry-read-only-secret";
const OTHER_TOKEN = "artifact-entry-other-organization-secret";
const OTHER_ORGANIZATION = "org-other-artifact-entry";
const FORMS = [
  SQLITE_MIGRATION_SET_FORM_URL,
  WORKER_BUNDLE_FORM_URL,
  STATIC_ASSET_BUNDLE_FORM_URL,
] as const;
const CASES = [
  {
    form: SQLITE_MIGRATION_SET_FORM_URL,
    slug: "sqlite",
    path: "0001.sql",
    mediaType: "application/sql",
    contents: "CREATE TABLE must_not_execute (id INTEGER);\n",
  },
  {
    form: WORKER_BUNDLE_FORM_URL,
    slug: "worker",
    path: "worker.js",
    mediaType: "application/javascript+module",
    contents: "export default { fetch() { return new Response('not executed'); } };\n",
  },
  {
    form: STATIC_ASSET_BUNDLE_FORM_URL,
    slug: "assets",
    path: "public/site.css",
    mediaType: "text/css",
    contents: "body { color: #124; }\n",
  },
] as const;

test("normal Worker entry exposes only configured artifact Forms through authenticated v2 HTTP", async () => {
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
      const manifestKey = `operator-held/${slug}/manifest`;
      const fileKey = `operator-held/${slug}/file`;
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
    sqliteMigrationSet: {
      targetKey: "entry-sqlite-v1",
      heldArtifacts: artifacts[0]?.heldArtifacts,
    },
    workerBundle: { targetKey: "entry-bundle-v1", heldArtifacts: artifacts[1]?.heldArtifacts },
    staticAssetBundle: { targetKey: "entry-assets-v1", heldArtifacts: artifacts[2]?.heldArtifacts },
  });
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "helpers/takoform-v2-entry-worker-miniflare.ts")],
    target: "browser",
    format: "esm",
  });
  expect(build.success).toBe(true);
  const bundle = build.outputs[0];
  if (!bundle) throw new Error("missing Worker entry test bundle");
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "artifact-entry-bindings-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: await bundle.text(),
              },
            },
          },
          env: {
            STATE_DB: { type: "d1", id: "artifact-entry-bindings-test" },
            OBJECTS: { type: "r2", name: "artifact-entry-bindings-test" },
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
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS) {
      for (const statement of splitMigration(migration.sql)) {
        await database.prepare(statement).run();
      }
    }
    const sql = createD1Sql(database);
    const now = new Date().toISOString();
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      [ORGANIZATION, "Artifact entry test", "principal-artifact-entry", now],
    );
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      [OTHER_ORGANIZATION, "Other artifact owner", "principal-other-artifact-entry", now],
    );
    for (const [secret, id, principal, organization, scope] of [
      [TOKEN, "key-artifact-entry", "principal-artifact-entry", ORGANIZATION, "resources:write"],
      [
        READ_ONLY_TOKEN,
        "key-artifact-reader",
        "principal-artifact-entry",
        ORGANIZATION,
        "resources:read",
      ],
      [
        OTHER_TOKEN,
        "key-artifact-other",
        "principal-other-artifact-entry",
        OTHER_ORGANIZATION,
        "resources:write",
      ],
    ] as const) {
      await sql.run(
        "INSERT INTO auth_tokens (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at, revoked_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, NULL)",
        [
          await bytesDigest(new TextEncoder().encode(secret)),
          id,
          principal,
          organization,
          id,
          JSON.stringify([scope]),
          now,
          new Date(Date.now() + 3_600_000).toISOString(),
        ],
      );
    }
    const bucket = await runtime.getR2Bucket("OBJECTS");
    for (const artifact of artifacts) {
      await bucket.put(artifact.manifestKey, artifact.manifestBytes);
      await bucket.put(artifact.fileKey, artifact.fileBytes);
    }
    const unauthenticated = await runtime.dispatchFetch(
      `${BASE}/support?form=${encodeURIComponent(FORMS[0])}`,
    );
    expect(unauthenticated.status).toBe(401);
    for (const form of FORMS) {
      const response = await runtime.dispatchFetch(
        `${BASE}/support?form=${encodeURIComponent(form)}`,
        {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ form, supported: true });
    }
    const auth = { authorization: `Bearer ${TOKEN}` };
    const workerExecution = await runtime.dispatchFetch(
      `${BASE}/support?form=${encodeURIComponent("https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/")}`,
      { headers: auth },
    );
    expect(workerExecution.status).toBe(200);
    expect(await workerExecution.json()).toMatchObject({ supported: false });
    const readOnlyCreate = await runtime.dispatchFetch(`${BASE}/resources`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${READ_ONLY_TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "artifact-entry-read-only-create-0001",
      },
      body: JSON.stringify({
        form: CASES[0].form,
        space: ORGANIZATION,
        name: "read-only-refused",
        spec: artifacts[0]?.spec,
      }),
    });
    expect(readOnlyCreate.status).toBe(403);
    for (const [index, artifactCase] of CASES.entries()) {
      const artifact = artifacts[index];
      if (!artifact) throw new Error("missing artifact fixture");
      const create = await runtime.dispatchFetch(`${BASE}/resources`, {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": `artifact-entry-create-${index}-0001`,
        },
        body: JSON.stringify({
          form: artifactCase.form,
          space: ORGANIZATION,
          name: `artifact-${index}`,
          spec: artifact.spec,
        }),
      });
      expect(create.status).toBe(202);
      const accepted = (await create.json()) as Record<string, unknown>;
      const uid = String(accepted.resourceUid);
      await settle(runtime, String(accepted.id));
      const resource = await runtime.dispatchFetch(`${BASE}/resources/${uid}`, { headers: auth });
      expect(resource.status).toBe(200);
      expect(await resource.json()).toMatchObject({
        uid,
        form: artifactCase.form,
        generation: 1,
        observedGeneration: 1,
        observed: { manifestSha256: artifact.spec.artifact.sha256 },
      });
      const otherOrganization = await runtime.dispatchFetch(`${BASE}/resources/${uid}`, {
        headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      });
      expect(otherOrganization.status).toBe(404);

      // A same-spec update must use the Host's held custody, not the original R2 source.
      await bucket.delete(artifact.manifestKey);
      await bucket.delete(artifact.fileKey);
      const update = await runtime.dispatchFetch(`${BASE}/resources/${uid}`, {
        method: "PUT",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": `artifact-entry-update-${index}-0001`,
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify({ spec: artifact.spec }),
      });
      expect(update.status).toBe(202);
      await settle(runtime, String(((await update.json()) as Record<string, unknown>).id));
      const updated = await runtime.dispatchFetch(`${BASE}/resources/${uid}`, { headers: auth });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ generation: 2, observedGeneration: 2 });

      const deletion = await runtime.dispatchFetch(`${BASE}/resources/${uid}`, {
        method: "DELETE",
        headers: {
          ...auth,
          "idempotency-key": `artifact-entry-delete-${index}-0001`,
          "takoform-expected-generation": "2",
        },
      });
      expect(deletion.status).toBe(202);
      await settle(runtime, String(((await deletion.json()) as Record<string, unknown>).id));
      const gone = await runtime.dispatchFetch(`${BASE}/resources/${uid}`, { headers: auth });
      expect(gone.status).toBe(410);
    }
  } finally {
    await runtime.dispose();
  }
}, 120_000);

async function settle(runtime: Miniflare, operationId: string): Promise<void> {
  for (let pass = 0; pass < 32; pass += 1) {
    const tick = await runtime.dispatchFetch(`${ORIGIN}/__test/run-scheduled`, { method: "POST" });
    expect(tick.status).toBe(204);
    const response = await runtime.dispatchFetch(`${BASE}/operations/${operationId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const operation = (await response.json()) as Record<string, unknown>;
    if (operation.status === "succeeded") {
      expect(operation.effect).toBe("complete");
      return;
    }
    if (operation.status === "failed") {
      throw new Error(`artifact operation ${operationId} failed: ${JSON.stringify(operation)}`);
    }
  }
  throw new Error(`artifact operation ${operationId} exceeded 32 scheduled passes`);
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
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
