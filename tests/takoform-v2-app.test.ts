import { expect, test } from "bun:test";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql } from "../src/ports.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";

const ORIGIN = "https://api.takoserver.test";
const MANIFEST_URL = "https://artifacts.example.test/manifest.json";
const FILE_URL = "https://artifacts.example.test/0001.sql";
const identity = {
  async verify() {
    return { providerSubject: "owner", email: "owner@example.test", displayName: "Owner" };
  },
};
const settlement = {
  async verify() {
    throw new Error("not configured");
  },
};

test("normal app serves one v2 Host and dispatches a held SQLite Migration Set independently", async () => {
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  const accounts = createAccounts({ sql, identity });
  const signedIn = await accounts.signIn({ provider: "google", assertion: "owner" });
  const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!actor) throw new Error("owner did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: "Migration owner" });
  const key = await accounts.createApiKey({
    actor,
    organizationId: organization.id,
    name: "migration writer",
    scopes: ["resources:write"],
    expiresInSeconds: 3_600,
  });
  const fileBytes = new TextEncoder().encode("CREATE TABLE never_execute (id INTEGER);\n");
  const fileSha256 = (await bytesDigest(fileBytes)).slice(7);
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      files: [
        { path: "0001.sql", url: FILE_URL, sha256: fileSha256, mediaType: "application/sql" },
      ],
    }),
  );
  const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
  await objects.create("held/manifest", manifestBytes, { contentType: "application/json" });
  await objects.create("held/file", fileBytes, { contentType: "application/sql" });
  const grants = [{ principal: `org:${organization.id}`, space: organization.id }];
  const app = buildApp({
    sql,
    objects,
    identity,
    settlement,
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2: {
      cursorSigningKey: new Uint8Array(32).fill(0x5a),
      documentation: "https://docs.example.test/takoform-v2",
      authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
      sqliteMigrationSet: {
        targetKey: "app-test-sql-target",
        heldArtifacts: [
          { url: MANIFEST_URL, sha256: manifestSha256, objectKey: "held/manifest", grants },
          { url: FILE_URL, sha256: fileSha256, objectKey: "held/file", grants },
        ],
      },
    },
  });
  const fetch = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${ORIGIN}${path}`, init));
  expect((await fetch("/.well-known/takoform/v1")).status).toBe(404);
  expect((await fetch("/apis/forms.takoform.com/v1/forms")).status).toBe(404);
  expect((await fetch("/.well-known/takoform/v2")).status).toBe(200);
  expect((await fetch("/.well-known/takoserver")).status).toBe(200);

  const create = await fetch("/apis/forms.takoform.com/v2/resources", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key.secret}`,
      "content-type": "application/json",
      "idempotency-key": "normal-app-migration-create-0001",
    },
    body: JSON.stringify({
      form: SQLITE_MIGRATION_SET_FORM_URL,
      space: organization.id,
      name: "migrations",
      spec: { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } },
    }),
  });
  expect(create.status).toBe(202);
  const accepted = (await create.json()) as { id: string; resourceUid: string };
  expect(await app.tickTakoformV2()).toMatchObject({ id: accepted.id, status: "succeeded" });
  expect(await app.tickTakoformV2()).toBeNull();
  await app.tick();
  const operation = await fetch(`/apis/forms.takoform.com/v2/operations/${accepted.id}`, {
    headers: { authorization: `Bearer ${key.secret}` },
  });
  expect(operation.status).toBe(200);
  expect(await operation.json()).toMatchObject({ status: "succeeded", effect: "complete" });
  const resource = await fetch(`/apis/forms.takoform.com/v2/resources/${accepted.resourceUid}`, {
    headers: { authorization: `Bearer ${key.secret}` },
  });
  expect(resource.status).toBe(200);
  expect(await resource.json()).toMatchObject({ observed: { manifestSha256, fileCount: 1 } });
});

test("v2 executor failure does not prevent the independent legacy repair tick", async () => {
  const durable = createEphemeralSql();
  const sql: Sql = {
    query(statement, params) {
      if (statement.includes("SELECT * FROM tf_v2_operations")) {
        throw new Error("v2 query unavailable");
      }
      return durable.query(statement, params);
    },
    run: (statement, params) => durable.run(statement, params),
    batch: (statements) => durable.batch(statements),
  };
  let legacyDrainCalls = 0;
  let legacyUnavailable = false;
  let legacyRejectsUndefined = false;
  const app = buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    offerings: [],
    driver: new InMemoryTakoformResourceDriver(),
    v2: {
      cursorSigningKey: new Uint8Array(32).fill(0x5a),
      documentation: "https://docs.example.test/takoform-v2",
      authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
    },
    takoformHost: {
      async handle() {
        throw new Error("legacy HTTP must not be called");
      },
      maintenance: {
        async drainProviderRepairs() {
          legacyDrainCalls += 1;
          if (legacyUnavailable) throw new Error("legacy repair unavailable");
          if (legacyRejectsUndefined) return Promise.reject(undefined);
          return { candidates: 0, acquired: 0, settled: 0, pending: 0 };
        },
      },
    },
  });
  const v2Failure = app.tickTakoformV2().then(
    () => null,
    (error: unknown) => error,
  );
  await app.tick();
  expect(await v2Failure).toBeInstanceOf(Error);
  expect(legacyDrainCalls).toBe(1);
  legacyUnavailable = true;
  await expect(app.tick()).rejects.toThrow("legacy Takoform repair drain failed");
  expect(legacyDrainCalls).toBe(2);
  legacyUnavailable = false;
  legacyRejectsUndefined = true;
  await expect(app.tick()).rejects.toThrow("legacy Takoform repair drain failed");
  expect(legacyDrainCalls).toBe(3);
});

test("a stalled v2 source never stalls legacy repair or control maintenance", async () => {
  const sql = createEphemeralSql();
  const backingObjects = createMemoryObjectStore();
  let sourceEntered!: () => void;
  let releaseSource!: () => void;
  const entered = new Promise<void>((resolve) => {
    sourceEntered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseSource = resolve;
  });
  const objects = {
    ...backingObjects,
    async get(key: string) {
      if (key === "blocked/manifest") {
        sourceEntered();
        await held;
      }
      return backingObjects.get(key);
    },
  };
  const accounts = createAccounts({ sql, identity });
  const signedIn = await accounts.signIn({ provider: "google", assertion: "stalled-owner" });
  const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!actor) throw new Error("owner did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: "Stalled owner" });
  const key = await accounts.createApiKey({
    actor,
    organizationId: organization.id,
    name: "stalled writer",
    scopes: ["resources:write"],
    expiresInSeconds: 3_600,
  });
  let legacyDrainCalls = 0;
  const app = buildApp({
    sql,
    objects,
    identity,
    settlement,
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    offerings: [],
    driver: new InMemoryTakoformResourceDriver(),
    v2: {
      cursorSigningKey: new Uint8Array(32).fill(0x5a),
      documentation: "https://docs.example.test/takoform-v2",
      authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
      sqliteMigrationSet: {
        targetKey: "stalled-app-target",
        heldArtifacts: [
          {
            url: MANIFEST_URL,
            sha256: "0".repeat(64),
            objectKey: "blocked/manifest",
            grants: [{ principal: `org:${organization.id}`, space: organization.id }],
          },
        ],
      },
    },
    takoformHost: {
      async handle() {
        throw new Error("legacy HTTP must not be called");
      },
      maintenance: {
        async drainProviderRepairs() {
          legacyDrainCalls += 1;
          return { candidates: 0, acquired: 0, settled: 0, pending: 0 };
        },
      },
    },
  });
  const create = await app.fetch(
    new Request(`${ORIGIN}/apis/forms.takoform.com/v2/resources`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.secret}`,
        "content-type": "application/json",
        "idempotency-key": "stalled-source-create-0001",
      },
      body: JSON.stringify({
        form: SQLITE_MIGRATION_SET_FORM_URL,
        space: organization.id,
        name: "stalled",
        spec: { artifact: { url: MANIFEST_URL, sha256: "0".repeat(64) } },
      }),
    }),
  );
  expect(create.status).toBe(202);
  await create.arrayBuffer();
  const v2Work = app.tickTakoformV2();
  const withinTwoSeconds = <T>(work: Promise<T>) =>
    Promise.race([
      work,
      Bun.sleep(2_000).then(() => {
        throw new Error("independent maintenance deadline exceeded");
      }),
    ]);
  try {
    await withinTwoSeconds(entered);
    const report = await withinTwoSeconds(app.tick());
    expect(report.providerRepairs).toEqual({
      candidates: 0,
      acquired: 0,
      settled: 0,
      pending: 0,
    });
    expect(legacyDrainCalls).toBe(1);
  } finally {
    releaseSource();
    expect(await v2Work).toMatchObject({ status: "failed", effect: "none" });
  }
});
