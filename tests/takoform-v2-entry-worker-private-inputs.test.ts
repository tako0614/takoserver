import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import { createD1Sql } from "../src/sql-d1.ts";

const ORIGIN = "https://api.private-entry.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const FORM = "https://forms.example.test/fixture/PrivateWorkerEntry/1.0.0";
const ORG = "org-private-entry";
const TOKEN = "synthetic-private-entry-api-key";
const SECRET = "synthetic-worker-entry-private-value";
const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

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

async function runtimeWithKey(
  name: string,
  keyring?: string,
  persistence?: string,
): Promise<Miniflare> {
  const build = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "helpers/takoform-v2-private-entry-worker-miniflare.ts"),
    ],
    target: "browser",
    format: "esm",
  });
  expect(build.success).toBe(true);
  const bundle = build.outputs[0];
  if (!bundle) throw new Error("private entry Worker bundle is unavailable");
  return new Miniflare({
    ...(persistence ? { resourcePersistencePath: persistence } : {}),
    workers: [
      {
        config: {
          name,
          type: "worker",
          compatibilityDate: "2026-08-17",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: await bundle.text() } },
          },
          env: {
            STATE_DB: { type: "d1", id: name },
            OBJECTS: { type: "r2", name },
            PUBLIC_ORIGIN: { type: "text", value: ORIGIN },
            WORKER_VERSION: { type: "json", value: { id: "00000000-0000-4000-8000-0000000000a1" } },
            TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: { type: "text", value: "A".repeat(43) },
            TAKOSERVER_TAKOFORM_V2_CONFIG: {
              type: "text",
              value: JSON.stringify({
                documentation: "https://docs.example.test/v2",
                authenticationDocumentation: "https://docs.example.test/v2/authentication",
              }),
            },
            ...(keyring
              ? { TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: { type: "text", value: keyring } }
              : {}),
          },
          triggers: [],
        },
      },
    ],
  });
}

async function seed(runtime: Miniflare): Promise<void> {
  const database = await runtime.getD1Database("STATE_DB");
  for (const migration of MIGRATIONS) {
    for (const statement of splitMigration(migration.sql)) await database.prepare(statement).run();
  }
  const sql = createD1Sql(database);
  const now = new Date().toISOString();
  await sql.run("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)", [
    ORG,
    "Private entry fixture",
    "principal-private-entry",
    now,
  ]);
  await sql.run(
    "INSERT INTO auth_tokens (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at, revoked_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, NULL)",
    [
      await bytesDigest(new TextEncoder().encode(TOKEN)),
      "key-private-entry",
      "principal-private-entry",
      ORG,
      "writer",
      JSON.stringify(["resources:write"]),
      now,
      new Date(Date.now() + 3_600_000).toISOString(),
    ],
  );
}

function request(
  runtime: Miniflare,
  path: string,
  init: {
    readonly method?: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
) {
  return runtime.dispatchFetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

test("real Worker entry admits private inputs only with operator keys and trusted Form hooks", async () => {
  const runtime = await runtimeWithKey(
    "v2-private-entry-miniflare",
    JSON.stringify({ current: { id: "fixture-a", key: KEY_A } }),
  );
  try {
    await seed(runtime);
    const support = await request(runtime, `/support?form=${encodeURIComponent(FORM)}`);
    expect(support.status).toBe(200);
    expect(await support.json()).toMatchObject({ supported: true, privateInputs: true });
    const body = {
      form: FORM,
      space: ORG,
      name: "secret-resource",
      spec: { kind: "fixture" },
      privateInputs: { TOKEN: SECRET },
    };
    const headers = { "idempotency-key": "private-entry-create-0001" };
    const first = await request(runtime, "/resources", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(202);
    await first.arrayBuffer(); // Simulate an accepted request whose response body was lost.
    const replay = await request(runtime, "/resources", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const accepted = (await replay.json()) as { id: string; resourceUid: string };
    expect(replay.status).toBe(202);
    expect(accepted.id).toBeTruthy();
    const tick = await runtime.dispatchFetch(`${ORIGIN}/__test/run-scheduled`, { method: "POST" });
    expect(tick.status).toBe(204);
    const operation = await request(runtime, `/operations/${accepted.id}`);
    expect(operation.status).toBe(200);
    const publicOperation = await operation.json();
    expect(publicOperation).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(JSON.stringify(publicOperation)).not.toContain(SECRET);
    const resource = await request(runtime, `/resources/${accepted.resourceUid}`);
    const publicResource = await resource.json();
    expect(publicResource).toMatchObject({ observed: { delivered: true } });
    expect(JSON.stringify(publicResource)).not.toContain(SECRET);
    const database = await runtime.getD1Database("STATE_DB");
    for (const table of ["tf_v2_operations", "tf_v2_resources", "tf_v2_private_inputs"]) {
      expect(JSON.stringify(await database.prepare(`SELECT * FROM ${table}`).all())).not.toContain(
        SECRET,
      );
    }
    expect((await (await runtime.getR2Bucket("OBJECTS")).list()).objects).toEqual([]);
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("missing keys and ordinary entry do not advertise or accept generic private inputs", async () => {
  const absent = await runtimeWithKey("v2-private-entry-no-key");
  try {
    await seed(absent);
    const support = await request(absent, `/support?form=${encodeURIComponent(FORM)}`);
    expect(await support.json()).toMatchObject({ supported: false, privateInputs: false });
    const discovery = await absent.dispatchFetch(`${ORIGIN}/.well-known/takoform/v2`);
    expect(await discovery.json()).toMatchObject({ capabilities: { privateInputs: false } });
    const refused = await request(absent, "/resources", {
      method: "POST",
      headers: { "idempotency-key": "private-entry-no-key-create" },
      body: JSON.stringify({
        form: FORM,
        space: ORG,
        name: "refused",
        spec: { kind: "fixture" },
        privateInputs: { TOKEN: SECRET },
      }),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "capability_required" });
  } finally {
    await absent.dispose();
  }

  const ordinary = await runtimeWithKey(
    "v2-private-entry-ordinary",
    JSON.stringify({ current: { id: "fixture-a", key: KEY_A } }),
  );
  try {
    await seed(ordinary);
    const support = await ordinary.dispatchFetch(
      `${ORIGIN}/__test/ordinary/apis/forms.takoform.com/v2/support?form=${encodeURIComponent(FORM)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(await support.json()).toMatchObject({ supported: false, privateInputs: false });
    const discovery = await ordinary.dispatchFetch(
      `${ORIGIN}/__test/ordinary/.well-known/takoform/v2`,
    );
    expect(await discovery.json()).toMatchObject({ capabilities: { privateInputs: false } });
  } finally {
    await ordinary.dispose();
  }
}, 120_000);

test("invalid operator ring refuses Worker startup before private acceptance", async () => {
  const runtime = await runtimeWithKey("v2-private-entry-invalid-key", "not-a-keyring");
  try {
    await seed(runtime);
    const response = await request(runtime, `/support?form=${encodeURIComponent(FORM)}`);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("runtime-configuration");
    expect(body).not.toContain("not-a-keyring");
    const database = await runtime.getD1Database("STATE_DB");
    expect(
      (await database.prepare("SELECT count(*) AS count FROM tf_v2_operations").all()).results,
    ).toEqual([{ count: 0 }]);
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("retained operator keys reopen accepted private input after Worker restart; removed history refuses replay", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "v2-private-entry-rotation-"));
  const name = "v2-private-entry-rotated";
  const old = JSON.stringify({ current: { id: "fixture-a", key: KEY_A } });
  const currentOnly = JSON.stringify({ current: { id: "fixture-b", key: KEY_B } });
  const retained = JSON.stringify({
    current: { id: "fixture-b", key: KEY_B },
    previous: [{ id: "fixture-a", key: KEY_A }],
  });
  const body = {
    form: FORM,
    space: ORG,
    name: "rotating-secret",
    spec: { kind: "fixture" },
    privateInputs: { TOKEN: SECRET },
  };
  const headers = { "idempotency-key": "private-entry-rotation-create" };
  try {
    const initial = await runtimeWithKey(name, old, persistence);
    let accepted: { id: string; resourceUid: string };
    try {
      await seed(initial);
      const response = await request(initial, "/resources", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(202);
      accepted = (await response.json()) as { id: string; resourceUid: string };
    } finally {
      await initial.dispose();
    }

    const missing = await runtimeWithKey(name, currentOnly, persistence);
    try {
      const replay = await request(missing, "/resources", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({
        code: "private_inputs_unverifiable",
        operationId: accepted.id,
      });
    } finally {
      await missing.dispose();
    }

    const rotated = await runtimeWithKey(name, retained, persistence);
    try {
      const replay = await request(rotated, "/resources", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({
        id: accepted.id,
        resourceUid: accepted.resourceUid,
      });
      expect(
        (await rotated.dispatchFetch(`${ORIGIN}/__test/run-scheduled`, { method: "POST" })).status,
      ).toBe(204);
      const resource = await request(rotated, `/resources/${accepted.resourceUid}`);
      expect(await resource.json()).toMatchObject({ observed: { delivered: true } });
      const update = await request(rotated, `/resources/${accepted.resourceUid}`, {
        method: "PUT",
        headers: {
          "idempotency-key": "private-entry-rotation-update",
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify({ spec: { kind: "fixture" }, privateInputs: { TOKEN: SECRET } }),
      });
      expect(update.status).toBe(202);
      const updated = (await update.json()) as { id: string };
      expect(
        (await rotated.dispatchFetch(`${ORIGIN}/__test/run-scheduled`, { method: "POST" })).status,
      ).toBe(204);
      expect(await (await request(rotated, `/operations/${updated.id}`)).json()).toMatchObject({
        status: "succeeded",
        effect: "complete",
      });
    } finally {
      await rotated.dispose();
    }
  } finally {
    await rm(persistence, { recursive: true, force: true });
  }
}, 120_000);
