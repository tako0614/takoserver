import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Accounts, ExternalIdentityVerifier } from "../src/auth.ts";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2AccountAccess } from "../src/takoform-v2/accounts.ts";
import { createV2HeldArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { createSQLiteMigrationSetForm } from "../src/takoform-v2/forms/sqlite-migration-set-backend.ts";
import { createTakoformV2Host } from "../src/takoform-v2/host.ts";

const BASE_URL = "https://host.example/custom/takoform-v2";
const ROOT = "/custom/takoform-v2";
const MANIFEST_URL = "https://artifacts.example.test/manifest.json";
const FILE_URL = "https://artifacts.example.test/0001.sql";
const MANIFEST_KEY = "operator-seed/migrations/manifest";
const FILE_KEY = "operator-seed/migrations/0001.sql";
const CURSOR_KEY = new Uint8Array(32).fill(0x5a);
const FILE_BYTES = new TextEncoder().encode(
  "CREATE TABLE artifact_payload_must_not_execute (id INTEGER);\n",
);

const identity: ExternalIdentityVerifier = {
  async verify({ provider, assertion }) {
    return {
      providerSubject: `${provider}:${assertion}`,
      email: `${assertion}@example.com`,
      displayName: assertion,
    };
  },
};

async function ownerWithOrganization(accounts: Accounts, assertion: string) {
  const signedIn = await accounts.signIn({ provider: "google", assertion });
  const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!actor) throw new Error("fixture owner session did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: `${assertion} Org` });
  return { ...signedIn, actor, organization };
}

function request(
  path: string,
  token: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request(`https://host.example${ROOT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

async function response(host: ReturnType<typeof createTakoformV2Host>, requestValue: Request) {
  const result = await host.fetch(requestValue);
  if (!result) throw new Error("expected the v2 Host to handle request");
  return result;
}

test("organization credentials retain SQLite Migration Set custody across source loss and key rotation", async () => {
  const database = new Database(":memory:");
  const tempRoot = await mkdtemp(join(tmpdir(), "takoserver-v2-organization-migration-"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const accounts = createAccounts({ sql, identity });
    const owner = await ownerWithOrganization(accounts, "migration-owner");
    const otherOrganization = await accounts.createOrganization({
      actor: owner.actor,
      name: "Second organization",
    });
    const firstKey = await accounts.createApiKey({
      actor: owner.actor,
      organizationId: owner.organization.id,
      name: "first migration writer",
      scopes: ["resources:write"],
      expiresInSeconds: 3_600,
    });
    const otherKey = await accounts.createApiKey({
      actor: owner.actor,
      organizationId: otherOrganization.id,
      name: "other organization writer",
      scopes: ["resources:write"],
      expiresInSeconds: 3_600,
    });

    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        files: [
          {
            path: "migrations/0001.sql",
            url: FILE_URL,
            sha256: (await bytesDigest(FILE_BYTES)).slice(7),
            mediaType: "application/sql",
          },
        ],
      }),
    );
    const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
    const fileSha256 = (await bytesDigest(FILE_BYTES)).slice(7);
    const objects = createFileObjectStore({ root: join(tempRoot, "objects") });
    expect(
      await objects.create(MANIFEST_KEY, manifestBytes, { contentType: "application/json" }),
    ).not.toBeNull();
    expect(
      await objects.create(FILE_KEY, FILE_BYTES, { contentType: "application/sql" }),
    ).not.toBeNull();

    const grants = [
      { principal: `org:${owner.organization.id}`, space: owner.organization.id },
      { principal: `org:${otherOrganization.id}`, space: otherOrganization.id },
    ];
    const source = createV2HeldArtifactSource({
      objects,
      entries: [
        { url: MANIFEST_URL, sha256: manifestSha256, objectKey: MANIFEST_KEY, grants },
        { url: FILE_URL, sha256: fileSha256, objectKey: FILE_KEY, grants },
      ],
    });
    const form = createSQLiteMigrationSetForm({
      sql,
      source,
      targetKey: "test-sqlite-migration-target",
    });
    const access = createTakoformV2AccountAccess(accounts);
    const host = createTakoformV2Host({
      sql,
      authorize: access.authorize,
      forms: { [SQLITE_MIGRATION_SET_FORM_URL]: form },
      baseUrl: BASE_URL,
      documentation: "https://docs.example/takoform-v2",
      authenticationDocumentation: "https://docs.example/takoform-v2/authentication",
      authenticationSchemes: ["Bearer"],
      maxRequestBytes: 4_096,
      maxPageSize: 10,
      replayWindowSeconds: 300,
      cursorSigningKey: CURSOR_KEY,
      authenticate: access.authenticate,
    });
    const spec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };

    const firstCreate = await response(
      host,
      request("/resources", firstKey.secret, {
        method: "POST",
        headers: { "idempotency-key": "organization-migration-create-0001" },
        body: JSON.stringify({
          form: SQLITE_MIGRATION_SET_FORM_URL,
          space: owner.organization.id,
          name: "migrations",
          spec,
        }),
      }),
    );
    expect(firstCreate.status).toBe(202);
    const firstOperation = (await firstCreate.json()) as { id: string; resourceUid: string };
    expect(await host.runNext()).toMatchObject({ id: firstOperation.id, status: "succeeded" });

    const firstRead = await response(
      host,
      request(`/resources/${firstOperation.resourceUid}`, firstKey.secret),
    );
    expect(firstRead.status).toBe(200);
    expect(await firstRead.json()).toMatchObject({
      space: owner.organization.id,
      name: "migrations",
      observed: {
        manifestSha256,
        fileCount: 1,
        totalBytes: FILE_BYTES.byteLength,
        files: [
          {
            path: "migrations/0001.sql",
            sha256: fileSha256,
            mediaType: "application/sql",
            byteSize: FILE_BYTES.byteLength,
          },
        ],
      },
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE name = 'artifact_payload_must_not_execute'")
        .all(),
    ).toEqual([]);
    const heldManifest = database
      .query("SELECT manifest_bytes FROM tf_v2_migration_set_owners WHERE resource_uid = ?")
      .get(firstOperation.resourceUid) as { manifest_bytes: Uint8Array };
    const heldFile = database
      .query(
        "SELECT bytes FROM tf_v2_migration_set_chunks WHERE resource_uid = ? AND file_index = 0 ORDER BY chunk_index",
      )
      .all(firstOperation.resourceUid) as { bytes: Uint8Array }[];
    expect(new Uint8Array(heldManifest.manifest_bytes)).toEqual(manifestBytes);
    expect(new Uint8Array(heldFile[0]?.bytes ?? [])).toEqual(FILE_BYTES);

    const otherCreate = await response(
      host,
      request("/resources", otherKey.secret, {
        method: "POST",
        headers: { "idempotency-key": "second-org-migration-create-001" },
        body: JSON.stringify({
          form: SQLITE_MIGRATION_SET_FORM_URL,
          space: otherOrganization.id,
          name: "migrations",
          spec,
        }),
      }),
    );
    expect(otherCreate.status).toBe(202);
    const otherOperation = (await otherCreate.json()) as { id: string; resourceUid: string };
    expect(otherOperation.resourceUid).not.toBe(firstOperation.resourceUid);
    expect(await host.runNext()).toMatchObject({ id: otherOperation.id, status: "succeeded" });
    expect(
      await (
        await response(host, request(`/resources/${otherOperation.resourceUid}`, otherKey.secret))
      ).json(),
    ).toMatchObject({ space: otherOrganization.id, name: "migrations" });

    const replacement = await accounts.createApiKey({
      actor: owner.actor,
      organizationId: owner.organization.id,
      name: "replacement migration writer",
      scopes: ["resources:write"],
      expiresInSeconds: 3_600,
    });
    await accounts.revokeApiKey({
      actor: owner.actor,
      organizationId: owner.organization.id,
      apiKeyId: firstKey.apiKey.id,
    });
    expect(await objects.delete(MANIFEST_KEY)).toBe(true);
    expect(await objects.delete(FILE_KEY)).toBe(true);

    const replacementRead = await response(
      host,
      request(`/resources/${firstOperation.resourceUid}`, replacement.secret),
    );
    expect(replacementRead.status).toBe(200);
    expect(await replacementRead.json()).toMatchObject({
      observed: { manifestSha256, files: [{ sha256: fileSha256 }] },
    });

    const sameSpecUpdate = await response(
      host,
      request(`/resources/${firstOperation.resourceUid}`, replacement.secret, {
        method: "PUT",
        headers: {
          "idempotency-key": "organization-migration-update-0001",
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify({ spec }),
      }),
    );
    expect(sameSpecUpdate.status).toBe(202);
    const updateOperation = (await sameSpecUpdate.json()) as { id: string };
    expect(await host.runNext()).toMatchObject({ id: updateOperation.id, status: "succeeded" });

    const deletion = await response(
      host,
      request(`/resources/${firstOperation.resourceUid}`, replacement.secret, {
        method: "DELETE",
        headers: {
          "idempotency-key": "organization-migration-delete-0001",
          "takoform-expected-generation": "2",
        },
      }),
    );
    expect(deletion.status).toBe(202);
    const deleteOperation = (await deletion.json()) as { id: string };
    expect(await host.runNext()).toMatchObject({ id: deleteOperation.id, status: "succeeded" });
    expect(
      (
        await response(
          host,
          request(`/resources/${firstOperation.resourceUid}`, replacement.secret),
        )
      ).status,
    ).toBe(410);
    expect(
      (await response(host, request(`/resources/${otherOperation.resourceUid}`, otherKey.secret)))
        .status,
    ).toBe(200);
  } finally {
    database.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
