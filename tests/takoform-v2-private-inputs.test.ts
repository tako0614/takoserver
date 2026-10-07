import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createTakoformV2Host } from "../src/takoform-v2/host.ts";
import type { V2PrivateInputCustody } from "../src/takoform-v2/private-inputs.ts";
import { TakoformV2Error, type V2Backend, type V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/SecretFixture/1.0.0";
const BASE = "https://host.example/apis/forms.takoform.com/v2";
const KEY = "private-test-key-00000001";
const CURSOR = new Uint8Array(32).fill(0x45);
const ORIGINAL = { password: "horse-battery-秘密", token: "token:never-public" };

async function keys(previous?: V2PrivateInputCustody): Promise<V2PrivateInputCustody> {
  const [transfer, comparison] = await Promise.all([
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  ]);
  return {
    transfer: {
      current: { id: previous ? "transfer-next" : "transfer-first", key: transfer },
      ...(previous ? { previous: [previous.transfer.current] } : {}),
    },
    comparison: {
      current: { id: previous ? "comparison-next" : "comparison-first", key: comparison },
      ...(previous ? { previous: [previous.comparison.current] } : {}),
    },
    transferTtlSeconds: 2,
  };
}

function fixture(
  database: Database,
  custody?: V2PrivateInputCustody,
  configuredKey?: CryptoKey,
  beforePreparedUpdate?: () => Promise<void>,
  formPrivateInputs = true,
) {
  let nowMs = Date.parse("2026-10-07T00:00:00.000Z");
  const sent: Array<{ action: string; values: Readonly<Record<string, string>> | undefined }> = [];
  const reconciled: Array<Readonly<Record<string, string>> | undefined> = [];
  const configuredDispatch: string[] = [];
  let unknown = false;
  const sql = createSqliteSql(database);
  const stableAad = (identity: {
    principal: string;
    space: string;
    name: string;
    form: string;
    resourceUid: string;
  }) =>
    new TextEncoder().encode(
      JSON.stringify([
        identity.principal,
        identity.space,
        identity.name,
        identity.form,
        identity.resourceUid,
      ]),
    );
  const decode64 = (value: string) => {
    const base = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base.padEnd(Math.ceil(base.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };
  const encode64 = (value: ArrayBuffer | Uint8Array) => {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  };
  const decryptConfigured = async (
    identity: { principal: string; space: string; name: string; form: string; resourceUid: string },
    sealed: { nonce: string; ciphertext: string } | null,
  ) => {
    if (!configuredKey || !sealed) throw new TakoformV2Error("temporarily_unavailable", 503);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode64(sealed.nonce), additionalData: stableAad(identity) },
      configuredKey,
      decode64(sealed.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
  };
  const backend: V2Backend = {
    id: "secret-fixture-backend",
    targetKey: "secret-fixture-target",
    async execute(input) {
      sent.push({ action: input.action, values: input.privateInputs });
      if (configuredKey && input.action === "update" && input.privateInputs === undefined) {
        const identity = {
          principal: input.principal,
          space: input.space,
          name: input.name,
          form: input.form,
          resourceUid: input.resourceUid,
        };
        const sealed = await readV2ConfiguredPrivateInputs(sql, identity);
        const preserved = await decryptConfigured(identity, sealed);
        configuredDispatch.push(preserved.password ?? "");
      }
      if (unknown)
        return { kind: "unknown", code: "outcome_unconfirmed", message: "Outcome unconfirmed" };
      return { kind: "complete", observed: { ready: true }, output: {} };
    },
    async reconcile(input) {
      reconciled.push(input.privateInputs);
      return { kind: "complete", observed: { ready: true }, output: {} };
    },
  };
  const form: V2Form = {
    validateCreate(spec) {
      if (spec.mode !== "secret") throw new Error("fixture requires secret mode");
    },
    validateUpdate(_previous, spec) {
      if (spec.mode !== "secret") throw new Error("fixture requires secret mode");
    },
    ...(formPrivateInputs
      ? {
          privateInputs: {
            validateCreate(_spec, inputs) {
              if (!inputs || Object.keys(inputs).sort().join(",") !== "password,token") {
                throw new Error("fixture requires the exact private names");
              }
            },
            validateUpdate(_previous, _spec, inputs) {
              if (
                inputs !== undefined &&
                Object.keys(inputs).sort().join(",") !== "password,token"
              ) {
                throw new Error("fixture rejects extra private names");
              }
            },
            ...(configuredKey
              ? ({
                  async prepareCreate(input) {
                    if (!input.privateInputs) throw new TakoformV2Error("invalid_spec", 422);
                    const nonce = crypto.getRandomValues(new Uint8Array(12));
                    const ciphertext = await crypto.subtle.encrypt(
                      { name: "AES-GCM", iv: nonce, additionalData: stableAad(input) },
                      configuredKey,
                      new TextEncoder().encode(JSON.stringify(input.privateInputs)),
                    );
                    return {
                      keyId: "configured-fixture-key",
                      nonce: encode64(nonce),
                      ciphertext: encode64(ciphertext),
                    };
                  },
                  async prepareUpdate(input) {
                    const retained = await decryptConfigured(input, input.configured);
                    if (
                      input.privateInputs !== undefined &&
                      JSON.stringify(input.privateInputs) !== JSON.stringify(retained)
                    ) {
                      throw new TakoformV2Error("invalid_spec", 422);
                    }
                    await beforePreparedUpdate?.();
                  },
                } satisfies Pick<
                  NonNullable<V2Form["privateInputs"]>,
                  "prepareCreate" | "prepareUpdate"
                >)
              : {}),
          },
        }
      : {}),
    backend,
  };
  const host = createTakoformV2Host({
    sql,
    now: () => new Date(nowMs),
    replayWindowSeconds: 300,
    leaseMilliseconds: 1,
    authorize: async (principal, space) => principal === "org:one" && space === "one",
    forms: { [FORM]: form },
    ...(custody ? { privateInputCustody: custody } : {}),
    baseUrl: BASE,
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/v2/auth",
    authenticationSchemes: ["Bearer"],
    maxRequestBytes: 4_096,
    maxPageSize: 10,
    cursorSigningKey: CURSOR,
    authenticate: async (request) => {
      switch (request.headers.get("authorization")) {
        case "Bearer old":
        case "Bearer rotated":
          return { principal: "org:one", access: "write" };
        case "Bearer reader":
          return { principal: "org:one", access: "read" };
        case "Bearer another":
          return { principal: "org:two", access: "write" };
        default:
          return null;
      }
    },
  });
  return {
    host,
    sent,
    reconciled,
    configuredDispatch,
    advance(ms: number) {
      nowMs += ms;
    },
    setUnknown(value: boolean) {
      unknown = value;
    },
  };
}

function request(
  path: string,
  method: string,
  body?: unknown,
  key?: string,
  auth = "old",
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function fetch(host: ReturnType<typeof createTakoformV2Host>, req: Request) {
  const response = await host.fetch(req);
  if (!response) throw new Error("v2 route was not handled");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function createBody(privateInputs: unknown = ORIGINAL) {
  return { form: FORM, space: "one", name: "secret-one", spec: { mode: "secret" }, privateInputs };
}

test("v2 private map survives lost HTTP response and SQLite process restart without public leakage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v2-private-"));
  const path = join(directory, "state.sqlite");
  const custody = await keys();
  let database = new Database(path);
  try {
    migrateSqlite(database);
    let runtime = fixture(database, custody);
    const discovery = await fetch(
      runtime.host,
      new Request("https://host.example/.well-known/takoform/v2"),
    );
    expect((discovery.body.capabilities as Record<string, unknown>).privateInputs).toBe(true);
    const support = await fetch(
      runtime.host,
      request(`/support?form=${encodeURIComponent(FORM)}`, "GET"),
    );
    expect(support.body.privateInputs).toBe(true);

    const accepted = await fetch(runtime.host, request("/resources", "POST", createBody(), KEY));
    expect(accepted.status).toBe(202);
    expect(accepted.body.status).toBe("queued");
    const originalId = accepted.body.id as string;
    const uid = accepted.body.resourceUid as string;
    const publicRows =
      JSON.stringify(database.query("SELECT * FROM tf_v2_operations").all()) +
      JSON.stringify(database.query("SELECT * FROM tf_v2_resources").all());
    expect(publicRows).not.toContain(ORIGINAL.password);
    expect(publicRows).not.toContain(ORIGINAL.token);
    const privateRow = database.query("SELECT * FROM tf_v2_private_inputs").get() as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(privateRow)).not.toContain(ORIGINAL.password);
    expect(JSON.stringify(privateRow)).not.toContain(ORIGINAL.token);
    database.close();

    database = new Database(path);
    migrateSqlite(database);
    runtime = fixture(database, custody);
    const replay = await fetch(
      runtime.host,
      request(
        "/resources",
        "POST",
        createBody({ token: ORIGINAL.token, password: ORIGINAL.password }),
        KEY,
        "rotated",
      ),
    );
    expect(replay.body.id).toBe(originalId);
    expect(replay.body.resourceUid).toBe(uid);
    const conflict = await fetch(
      runtime.host,
      request("/resources", "POST", createBody({ ...ORIGINAL, token: "other" }), KEY),
    );
    expect(conflict.body.code).toBe("idempotency_conflict");
    expect(await runtime.host.runNext()).toMatchObject({ id: originalId, status: "succeeded" });
    expect(runtime.sent).toEqual([{ action: "create", values: ORIGINAL }]);
    expect(database.query("SELECT transfer_ciphertext FROM tf_v2_private_inputs").get()).toEqual({
      transfer_ciphertext: null,
    });
    const resource = await fetch(runtime.host, request(`/resources/${uid}`, "GET"));
    expect(JSON.stringify(resource.body)).not.toContain(ORIGINAL.password);
    expect(JSON.stringify(resource.body)).not.toContain(ORIGINAL.token);
    const terminalReplay = await fetch(
      runtime.host,
      request("/resources", "POST", createBody(), KEY, "rotated"),
    );
    expect(terminalReplay.body).toMatchObject({ id: originalId, status: "succeeded" });
    expect(runtime.sent).toHaveLength(1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired unsent transfer waits, whole-map replenishment queues the same Operation, and executes once", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const runtime = fixture(database, await keys());
  try {
    const accepted = await fetch(runtime.host, request("/resources", "POST", createBody(), KEY));
    const id = accepted.body.id as string;
    runtime.advance(2_100);
    expect(await runtime.host.runNext()).toMatchObject({
      id,
      status: "waiting_input",
      inputRequired: { names: ["password", "token"], reason: "expired" },
    });
    expect(runtime.sent).toEqual([]);
    const wrong = await fetch(
      runtime.host,
      request(`/operations/${id}/private-inputs`, "PUT", {
        privateInputs: { ...ORIGINAL, token: "wrong" },
      }),
    );
    expect(wrong.body).toMatchObject({ code: "private_inputs_conflict", operationId: id });
    const partial = await fetch(
      runtime.host,
      request(`/operations/${id}/private-inputs`, "PUT", {
        privateInputs: { password: ORIGINAL.password },
      }),
    );
    expect(partial.body.code).toBe("private_inputs_conflict");
    const queued = await fetch(
      runtime.host,
      request(
        `/operations/${id}/private-inputs`,
        "PUT",
        { privateInputs: ORIGINAL },
        undefined,
        "rotated",
      ),
    );
    expect(queued).toMatchObject({ status: 200, body: { id, status: "queued" } });
    const again = await fetch(
      runtime.host,
      request(`/operations/${id}/private-inputs`, "PUT", { privateInputs: ORIGINAL }),
    );
    expect(again.body).toMatchObject({ id, status: "queued" });
    expect(await runtime.host.runNext()).toMatchObject({ id, status: "succeeded" });
    expect(runtime.sent).toEqual([{ action: "create", values: ORIGINAL }]);
    const terminal = await fetch(
      runtime.host,
      request(`/operations/${id}/private-inputs`, "PUT", { privateInputs: ORIGINAL }),
    );
    expect(terminal.body).toMatchObject({ code: "operation_terminal", operationId: id });
  } finally {
    database.close();
  }
});

test("comparison loss is unverifiable with known operationId; revoked/read-only authority cannot replenish", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const runtime = fixture(database, await keys());
  try {
    const accepted = await fetch(runtime.host, request("/resources", "POST", createBody(), KEY));
    const id = accepted.body.id as string;
    expect(
      (
        await fetch(
          runtime.host,
          request(
            `/operations/${id}/private-inputs`,
            "PUT",
            { privateInputs: ORIGINAL },
            undefined,
            "another",
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          runtime.host,
          request(
            `/operations/${id}/private-inputs`,
            "PUT",
            { privateInputs: ORIGINAL },
            undefined,
            "reader",
          ),
        )
      ).status,
    ).toBe(403);
    database.query("DELETE FROM tf_v2_private_inputs WHERE operation_id = ?").run(id);
    const replay = await fetch(runtime.host, request("/resources", "POST", createBody(), KEY));
    expect(replay.body).toMatchObject({ code: "private_inputs_unverifiable", operationId: id });
    const replenish = await fetch(
      runtime.host,
      request(`/operations/${id}/private-inputs`, "PUT", { privateInputs: ORIGINAL }),
    );
    expect(replenish.body).toMatchObject({ code: "private_inputs_unverifiable", operationId: id });
    expect(await runtime.host.runNext()).toMatchObject({ id, status: "failed", effect: "none" });
    expect(runtime.sent).toEqual([]);
  } finally {
    database.close();
  }
});

test("dispatched unknown never becomes waiting_input and reconcile cannot receive plaintext", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const runtime = fixture(database, await keys());
  try {
    runtime.setUnknown(true);
    const accepted = await fetch(runtime.host, request("/resources", "POST", createBody(), KEY));
    const id = accepted.body.id as string;
    expect(await runtime.host.runNext()).toMatchObject({ id, status: "reconciling" });
    expect(database.query("SELECT transfer_ciphertext FROM tf_v2_private_inputs").get()).toEqual({
      transfer_ciphertext: null,
    });
    runtime.advance(5_000);
    const unchanged = await fetch(
      runtime.host,
      request(`/operations/${id}/private-inputs`, "PUT", { privateInputs: ORIGINAL }),
    );
    expect(unchanged.body).toMatchObject({ id, status: "reconciling" });
    expect(await runtime.host.runNext()).toMatchObject({ id, status: "succeeded" });
    expect(runtime.sent).toHaveLength(1);
    expect(runtime.reconciled).toEqual([undefined]);
  } finally {
    database.close();
  }
});

test("missing or replaced old comparison key refuses replay while retained rotation succeeds", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const original = await keys();
  try {
    const first = fixture(database, original);
    const accepted = await fetch(first.host, request("/resources", "POST", createBody(), KEY));
    const id = accepted.body.id as string;
    const rotated = fixture(database, await keys(original));
    expect(
      (await fetch(rotated.host, request("/resources", "POST", createBody(), KEY))).body.id,
    ).toBe(id);
    // Even accidentally reusing the old key ID with new bytes is not a
    // false private_inputs_conflict: the retained comparison tag authenticates itself.
    const lost = fixture(database, await keys());
    expect(
      (await fetch(lost.host, request("/resources", "POST", createBody(), KEY))).body,
    ).toMatchObject({
      code: "private_inputs_unverifiable",
      operationId: id,
    });
  } finally {
    database.close();
  }
});

test("missing transfer key before any dispatch waits unavailable, then replenishes with rotated custody", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const original = await keys();
  try {
    const first = fixture(database, original);
    const accepted = await fetch(first.host, request("/resources", "POST", createBody(), KEY));
    const id = accepted.body.id as string;
    const next = await keys(original);
    const rotatedCustody: V2PrivateInputCustody = {
      ...next,
      transfer: { current: next.transfer.current },
    };
    const rotated = fixture(database, rotatedCustody);
    expect(await rotated.host.runNext()).toMatchObject({
      id,
      status: "waiting_input",
      inputRequired: { reason: "unavailable" },
    });
    expect(rotated.sent).toEqual([]);
    expect(
      (
        await fetch(
          rotated.host,
          request(`/operations/${id}/private-inputs`, "PUT", { privateInputs: ORIGINAL }),
        )
      ).body.status,
    ).toBe("queued");
    expect(await rotated.host.runNext()).toMatchObject({ id, status: "succeeded" });
    expect(rotated.sent).toEqual([{ action: "create", values: ORIGINAL }]);
  } finally {
    database.close();
  }
});

test("concurrent copies of one private create key accept one UID, Operation, and custody row", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const runtime = fixture(database, await keys());
  try {
    const [first, second] = await Promise.all([
      fetch(runtime.host, request("/resources", "POST", createBody(), KEY)),
      fetch(runtime.host, request("/resources", "POST", createBody(), KEY, "rotated")),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.id).toBe(second.body.id);
    expect(first.body.resourceUid).toBe(second.body.resourceUid);
    expect(database.query("SELECT COUNT(*) AS count FROM tf_v2_operations").get()).toEqual({
      count: 1,
    });
    expect(database.query("SELECT COUNT(*) AS count FROM tf_v2_private_inputs").get()).toEqual({
      count: 1,
    });
  } finally {
    database.close();
  }
});

test("private field presence, even empty, is distinct from omission and requires explicit custody", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  try {
    const disabled = fixture(database);
    const empty = await fetch(disabled.host, request("/resources", "POST", createBody({}), KEY));
    expect(empty.body.code).toBe("capability_required");
    const malformed = await fetch(
      disabled.host,
      request("/resources", "POST", createBody({ password: 1 }), KEY),
    );
    expect(malformed.body.code).toBe("capability_required");
    const nullMap = await fetch(
      disabled.host,
      request("/resources", "POST", createBody(null), KEY),
    );
    expect(nullMap.body.code).toBe("capability_required");
    const formDisabled = fixture(database, await keys(), undefined, undefined, false);
    const formNull = await fetch(
      formDisabled.host,
      request("/resources", "POST", createBody(null), KEY),
    );
    expect(formNull.body.code).toBe("capability_required");
    const plain = await fetch(
      formDisabled.host,
      request(
        "/resources",
        "POST",
        { form: FORM, space: "one", name: "plain", spec: { mode: "secret" } },
        KEY,
      ),
    );
    expect(plain.status).toBe(202);
    expect(await formDisabled.host.runNext()).toMatchObject({ status: "succeeded" });
    const formUpdateNull = await fetch(
      formDisabled.host,
      new Request(`${BASE}/resources/${plain.body.resourceUid}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer old",
          "content-type": "application/json",
          "idempotency-key": "form-disabled-update-0001",
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify({ spec: { mode: "secret" }, privateInputs: null }),
      }),
    );
    expect(formUpdateNull.body.code).toBe("capability_required");
  } finally {
    database.close();
  }
});

test("accepted-key replay precedes changed Host or Form private capability", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const custody = await keys();
  try {
    const original = fixture(database, custody);
    const created = await fetch(original.host, request("/resources", "POST", createBody(), KEY));
    expect(created.status).toBe(202);
    const createdId = created.body.id as string;
    const uid = created.body.resourceUid as string;
    const withoutHostCustody = fixture(database);
    const unknownCreate = await fetch(
      withoutHostCustody.host,
      request("/resources", "POST", createBody(), KEY),
    );
    expect(unknownCreate.body).toMatchObject({
      code: "private_inputs_unverifiable",
      operationId: createdId,
    });
    const withoutFormPolicy = fixture(database, custody, undefined, undefined, false);
    const knownCreate = await fetch(
      withoutFormPolicy.host,
      request("/resources", "POST", createBody(), KEY),
    );
    expect(knownCreate.body.id).toBe(createdId);
    const changedCreateEnvelope = await fetch(
      withoutFormPolicy.host,
      request("/resources", "POST", { ...createBody(), extra: 1 }, KEY),
    );
    expect(changedCreateEnvelope.body.code).toBe("idempotency_conflict");
    expect(
      (
        await fetch(
          withoutFormPolicy.host,
          request("/resources", "POST", { ...createBody(), privateInputs: [] }, KEY),
        )
      ).body.code,
    ).toBe("idempotency_conflict");
    expect(await original.host.runNext()).toMatchObject({ status: "succeeded" });
    const updateBody = { spec: { mode: "secret" }, privateInputs: ORIGINAL };
    const updateRequest = (body: unknown = updateBody) =>
      new Request(`${BASE}/resources/${uid}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer old",
          "content-type": "application/json",
          "idempotency-key": "private-update-replay-0001",
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify(body),
      });
    const updated = await fetch(original.host, updateRequest());
    expect(updated.status).toBe(202);
    const updatedId = updated.body.id as string;
    const unknownUpdate = await fetch(withoutHostCustody.host, updateRequest());
    expect(unknownUpdate.body).toMatchObject({
      code: "private_inputs_unverifiable",
      operationId: updatedId,
    });
    const knownUpdate = await fetch(withoutFormPolicy.host, updateRequest());
    expect(knownUpdate.body.id).toBe(updatedId);
    const changedUpdateEnvelope = await fetch(
      withoutFormPolicy.host,
      updateRequest({ ...updateBody, extra: 1 }),
    );
    expect(changedUpdateEnvelope.body.code).toBe("idempotency_conflict");
    expect(
      (await fetch(withoutFormPolicy.host, updateRequest({ ...updateBody, privateInputs: [] })))
        .body.code,
    ).toBe("idempotency_conflict");
  } finally {
    database.close();
  }
});

test("public HTTP replay retains pre-private zero-secret Create and Update fingerprints", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const runtime = fixture(database, undefined, undefined, undefined, false);
  try {
    const body = { form: FORM, space: "one", name: "plain", spec: { mode: "secret" } };
    const created = await fetch(runtime.host, request("/resources", "POST", body, KEY));
    expect(created.status).toBe(202);
    expect(
      database
        .query("SELECT request_fingerprint FROM tf_v2_operations WHERE id = ?")
        .get(created.body.id as string),
    ).toEqual({
      request_fingerprint: canonicalJson({ method: "POST", path: "/resources", query: {}, body }),
    });
    expect((await fetch(runtime.host, request("/resources", "POST", body, KEY))).body.id).toBe(
      created.body.id,
    );
    expect(await runtime.host.runNext()).toMatchObject({ status: "succeeded" });
    const uid = created.body.resourceUid as string;
    const updateBody = { spec: { mode: "secret" } };
    const updateRequest = () =>
      new Request(`${BASE}/resources/${uid}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer old",
          "content-type": "application/json",
          "idempotency-key": "zero-secret-update-0001",
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify(updateBody),
      });
    const updated = await fetch(runtime.host, updateRequest());
    expect(updated.status).toBe(202);
    expect(
      database
        .query("SELECT request_fingerprint FROM tf_v2_operations WHERE id = ?")
        .get(updated.body.id as string),
    ).toEqual({
      request_fingerprint: canonicalJson({
        method: "PUT",
        path: `/resources/${uid}`,
        query: {},
        expectedGeneration: 1,
        body: updateBody,
      }),
    });
    expect((await fetch(runtime.host, updateRequest())).body.id).toBe(updated.body.id);
  } finally {
    database.close();
  }
});

test("omitted private field preserves the exact pre-private v2 replay fingerprint bytes", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  try {
    const engine = createTakoformV2Engine({
      sql: createSqliteSql(database),
      replayWindowSeconds: 300,
      authorize: async () => true,
      forms: {
        [FORM]: {
          validateCreate() {},
          validateUpdate() {},
          backend: {
            id: "plain-fixture",
            targetKey: "plain-target",
            async execute() {
              return { kind: "complete", observed: {}, output: {} };
            },
            async reconcile() {
              return { kind: "complete", observed: {}, output: {} };
            },
          },
        },
      },
    });
    const input = { form: FORM, space: "one", name: "plain", spec: { value: 1 } };
    const created = await engine.acceptCreate({ principal: "org:one", key: KEY, input });
    const fingerprint = database
      .query("SELECT request_fingerprint FROM tf_v2_operations WHERE id = ?")
      .get(created.id);
    expect(fingerprint).toEqual({
      request_fingerprint: canonicalJson({
        method: "POST",
        path: "/resources",
        query: {},
        body: input,
      }),
    });
    await engine.runNext();
    const updated = await engine.acceptUpdate({
      principal: "org:one",
      key: "plain-update-key-0000001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { value: 2 },
    });
    expect(
      database
        .query("SELECT request_fingerprint FROM tf_v2_operations WHERE id = ?")
        .get(updated.id),
    ).toEqual({
      request_fingerprint: canonicalJson({
        method: "PUT",
        path: `/resources/${created.resourceUid}`,
        query: {},
        expectedGeneration: 1,
        body: { spec: { value: 2 } },
      }),
    });
  } finally {
    database.close();
  }
});

test("Form-sealed configured values commit with CREATE, survive transfer erasure, and preserve omitted UPDATE", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const configuredKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const runtime = fixture(database, await keys(), configuredKey);
  try {
    const accepted = await fetch(runtime.host, request("/resources", "POST", createBody(), KEY));
    expect(accepted.status).toBe(202);
    const uid = accepted.body.resourceUid as string;
    const stored = database
      .query(
        "SELECT key_id, nonce, ciphertext FROM tf_v2_configured_private_inputs WHERE resource_uid = ?",
      )
      .get(uid) as Record<string, unknown>;
    expect(stored.key_id).toBe("configured-fixture-key");
    expect(JSON.stringify(stored)).not.toContain(ORIGINAL.password);
    expect(await runtime.host.runNext()).toMatchObject({ status: "succeeded" });
    const omitted = new Request(`${BASE}/resources/${uid}`, {
      method: "PUT",
      headers: {
        authorization: "Bearer rotated",
        "content-type": "application/json",
        "idempotency-key": "private-update-omitted-0001",
        "takoform-expected-generation": "1",
      },
      body: JSON.stringify({ spec: { mode: "secret" } }),
    });
    expect((await fetch(runtime.host, omitted)).body.status).toBe("queued");
    const sameKeyDifferentPresence = new Request(`${BASE}/resources/${uid}`, {
      method: "PUT",
      headers: {
        authorization: "Bearer old",
        "content-type": "application/json",
        "idempotency-key": "private-update-omitted-0001",
        "takoform-expected-generation": "1",
      },
      body: JSON.stringify({ spec: { mode: "secret" }, privateInputs: {} }),
    });
    expect((await fetch(runtime.host, sameKeyDifferentPresence)).body.code).toBe(
      "idempotency_conflict",
    );
    expect(await runtime.host.runNext()).toMatchObject({ status: "succeeded" });
    expect(runtime.configuredDispatch).toEqual([ORIGINAL.password]);
    expect(runtime.sent.at(-1)).toEqual({ action: "update", values: undefined });
    const changed = new Request(`${BASE}/resources/${uid}`, {
      method: "PUT",
      headers: {
        authorization: "Bearer old",
        "content-type": "application/json",
        "idempotency-key": "private-update-changed-0001",
        "takoform-expected-generation": "2",
      },
      body: JSON.stringify({
        spec: { mode: "secret" },
        privateInputs: { ...ORIGINAL, token: "changed" },
      }),
    });
    expect((await fetch(runtime.host, changed)).body.code).toBe("invalid_spec");
    expect(database.query("SELECT generation FROM tf_v2_resources WHERE uid = ?").get(uid)).toEqual(
      { generation: 2 },
    );
    expect(
      database.query("SELECT COUNT(*) AS count FROM tf_v2_configured_private_inputs").get(),
    ).toEqual({ count: 1 });
    const deleted = new Request(`${BASE}/resources/${uid}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer old",
        "idempotency-key": "private-delete-000000001",
        "takoform-expected-generation": "2",
      },
    });
    expect((await fetch(runtime.host, deleted)).body.status).toBe("queued");
    expect(await runtime.host.runNext()).toMatchObject({ status: "succeeded" });
    expect(
      database.query("SELECT COUNT(*) AS count FROM tf_v2_configured_private_inputs").get(),
    ).toEqual({ count: 0 });
  } finally {
    database.close();
  }
});

test("direct engine snapshots private maps before async Form policy mutates caller aliases", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const createMap = { password: "create-original" };
  const updateMap = { password: "update-original" };
  const sent: Array<string | undefined> = [];
  const engine = createTakoformV2Engine({
    sql: createSqliteSql(database),
    replayWindowSeconds: 300,
    authorize: async () => true,
    privateInputCustody: await keys(),
    forms: {
      [FORM]: {
        validateCreate() {},
        validateUpdate() {},
        privateInputs: {
          validateCreate() {},
          validateUpdate() {},
          async prepareCreate(input) {
            expect(Object.isFrozen(input.privateInputs)).toBe(true);
            createMap.password = "changed-after-seal";
            await Promise.resolve();
            expect(input.privateInputs?.password).toBe("create-original");
            return { keyId: "form-key", nonce: "form-nonce", ciphertext: "form-cipher" };
          },
          async prepareUpdate(input) {
            expect(Object.isFrozen(input.privateInputs)).toBe(true);
            expect(Object.isFrozen(input.configured)).toBe(true);
            expect(input.configured?.ciphertext).toBe("form-cipher");
            updateMap.password = "changed-after-seal";
            await Promise.resolve();
            expect(input.privateInputs?.password).toBe("update-original");
          },
        },
        backend: {
          id: "snapshot-fixture",
          targetKey: "snapshot-target",
          async execute(input) {
            sent.push(input.privateInputs?.password);
            return { kind: "complete", observed: {}, output: {} };
          },
          async reconcile() {
            return { kind: "complete", observed: {}, output: {} };
          },
        },
      },
    },
  });
  try {
    const created = await engine.acceptCreate({
      principal: "org:one",
      key: KEY,
      input: {
        form: FORM,
        space: "one",
        name: "snapshot",
        spec: {},
        privateInputs: createMap,
      },
    });
    expect(await engine.runNext()).toMatchObject({ status: "succeeded" });
    expect(sent).toEqual(["create-original"]);
    expect(
      await engine.acceptCreate({
        principal: "org:one",
        key: KEY,
        input: {
          form: FORM,
          space: "one",
          name: "snapshot",
          spec: {},
          privateInputs: { password: "create-original" },
        },
      }),
    ).toMatchObject({ id: created.id });
    const updated = await engine.acceptUpdate({
      principal: "org:one",
      key: "snapshot-update-key-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: {},
      privateInputs: updateMap,
    });
    expect(await engine.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });
    expect(sent).toEqual(["create-original", "update-original"]);
    expect(
      await engine.acceptUpdate({
        principal: "org:one",
        key: "snapshot-update-key-0001",
        uid: created.resourceUid,
        expectedGeneration: 1,
        spec: {},
        privateInputs: { password: "update-original" },
      }),
    ).toMatchObject({ id: updated.id });
  } finally {
    database.close();
  }
});

test("configured custody replacement during async UPDATE policy cannot pass acceptance CAS", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const configuredKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const runtime = fixture(database, await keys(), configuredKey, async () => {
    entered();
    await held;
  });
  try {
    const created = await fetch(runtime.host, request("/resources", "POST", createBody(), KEY));
    expect(created.status).toBe(202);
    expect(await runtime.host.runNext()).toMatchObject({ status: "succeeded" });
    const uid = created.body.resourceUid as string;
    const pending = fetch(
      runtime.host,
      new Request(`${BASE}/resources/${uid}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer old",
          "content-type": "application/json",
          "idempotency-key": "interleaved-update-key-0001",
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify({ spec: { mode: "secret" } }),
      }),
    );
    await ready;
    database.exec("DROP TRIGGER tf_v2_configured_private_immutable");
    database
      .query("UPDATE tf_v2_configured_private_inputs SET ciphertext = ? WHERE resource_uid = ?")
      .run("replaced-by-privileged-sql", uid);
    resume();
    expect((await pending).status).toBe(409);
    expect(database.query("SELECT generation FROM tf_v2_resources WHERE uid = ?").get(uid)).toEqual(
      { generation: 1 },
    );
    expect(database.query("SELECT COUNT(*) AS count FROM tf_v2_operations").get()).toEqual({
      count: 1,
    });
  } finally {
    resume();
    database.close();
  }
});
