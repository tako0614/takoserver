import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  type RpAuthorityIdentity,
  sharedBrokerCredentialCurrentness,
  sharedRpCredentialCurrentness,
  type TokenAuthorityIdentity,
} from "../src/credential-authority-class.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import {
  type AuthAuthorityDigest,
  createSharedPrincipalAuthorityStore,
  type FreshSharedPrincipal,
  type SharedPrincipalBinding,
  sharedPrincipalCurrentness,
} from "../src/shared-principal-authority.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

// Structural component fixtures only: no genuine identity/proof/payer enrollment.
const schema = readFileSync(
  new URL("./fixtures/auth-authority-candidate-schema.sql", import.meta.url),
  "utf8",
);
const opened = new Set<Database>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});
const digest = (value: string): AuthAuthorityDigest => {
  if (!/^[a-f]$/u.test(value)) throw new Error("Synthetic digest seed");
  return `sha256:${value.repeat(64)}`;
};
function fixture() {
  const db = new Database(":memory:");
  opened.add(db);
  const sql = createSqliteSql(db);
  db.exec(schema);
  db.exec(
    "CREATE TABLE auth_guard_probe (id INTEGER PRIMARY KEY,touched INTEGER NOT NULL); INSERT INTO auth_guard_probe VALUES(1,0)",
  );
  return {
    db,
    sql,
    principals: createSharedPrincipalAuthorityStore({ sql }),
    classes: createCredentialAuthorityClassStore({ sql }),
  };
}
function fresh(id = "original"): FreshSharedPrincipal {
  return {
    principalId: `prn_${id}`,
    principalIncarnation: `principal_inc_${id}`,
    createdAt: "2026-10-15T00:00:00.000Z",
    origin: { ref: `synthetic:origin:${id}`, digest: digest("a") },
    binding: {
      ref: `binding_${id}`,
      issuer: "https://issuer.invalid",
      subject: `account_${id}`,
      controllerIncarnation: "controller_1",
      targetRef: "synthetic:server-target",
      evidence: { ref: `synthetic:verified-binding:${id}:1`, digest: digest("b") },
      enrolledAt: "2026-10-15T00:00:00.000Z",
    },
  };
}
const closure = {
  reason: "synthetic:controller-transition",
  at: "2026-10-15T01:00:00.000Z",
  ref: "synthetic:retirement:1",
};
function successor(ref = "binding_next", controller = "controller_2") {
  return {
    ref,
    controllerIncarnation: controller,
    evidence: { ref: `synthetic:verified:${ref}`, digest: digest("c") },
    enrolledAt: "2026-10-15T02:00:00.000Z",
  };
}
async function root(f: ReturnType<typeof fixture>) {
  return await f.principals.createFresh(fresh());
}
async function retiredRoot(f: ReturnType<typeof fixture>) {
  const r = await root(f);
  return await f.principals.retireBinding(r.ref, r.evidence, closure);
}
function credentialOrigin(binding: SharedPrincipalBinding, id = "one"): CredentialAuthorityOrigin {
  return {
    ref: `authority_${id}`,
    incarnation: `credential_inc_${id}`,
    targetRef: binding.targetRef,
    principalId: binding.principalId,
    principalIncarnation: binding.principalIncarnation,
    issuanceRef: `synthetic:issuance:${id}`,
    issuanceDigest: digest("d"),
    issuedAt: new Date().toISOString(),
  };
}
function tokenIdentity(id = "one", secret = digest("e")): TokenAuthorityIdentity {
  return {
    id: `key_${id}`,
    digest: secret,
    scopesJson: '["payments:write"]',
    createdAt: new Date(Date.now() - 1000).toISOString(),
  };
}
function tokenInsert(
  binding: SharedPrincipalBinding,
  identity: TokenAuthorityIdentity,
  organization = "org_original",
  kind = "api_key",
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
): SqlStatement {
  return {
    sql: `INSERT INTO auth_tokens
    (secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at)
    VALUES (?,?,?,?,?,'synthetic-key',?,?,?)`,
    params: [
      identity.digest,
      identity.id,
      kind,
      binding.principalId,
      kind === "session" ? null : organization,
      identity.scopesJson,
      identity.createdAt,
      expiresAt,
    ],
  };
}
async function broker(f: ReturnType<typeof fixture>) {
  const binding = await root(f);
  const identity = tokenIdentity();
  const origin = credentialOrigin(binding);
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  await f.sql.batch([
    tokenInsert(binding, identity, "org_original", "api_key", expiresAt),
    f.classes.sharedBrokerIssuanceStatement(origin, identity, "org_original"),
  ]);
  const record = await f.classes.readRetained(origin.ref);
  if (!record || record.backend !== "auth-token") throw new Error("Missing synthetic class");
  return { binding, identity, origin, record, expiresAt };
}
async function predicateResult(
  sql: Sql,
  predicate: {
    readonly sql: string;
    readonly params: readonly (string | number | null | ArrayBuffer)[];
  },
) {
  return Number(
    (await sql.query(`SELECT ${predicate.sql} AS current`, predicate.params))[0]?.current,
  );
}

// SOURCE2 successor cases exercise the actual product store, not a parallel model.
test("Auth authority successor retains original Principal and root across two controllers", async () => {
  const f = fixture();
  const old = await retiredRoot(f);
  const principal = await f.sql.query("SELECT * FROM principals");
  const anchor = await f.principals.readAnchor(old.principalId);
  const second = await f.principals.appendSuccessor(old, successor());
  const secondClosed = await f.principals.retireBinding(second.ref, second.evidence, {
    ...closure,
    ref: "synthetic:retirement:2",
    at: "2026-10-15T03:00:00.000Z",
  });
  const third = await f.principals.appendSuccessor(secondClosed, {
    ...successor("binding_third", "controller_3"),
    evidence: { ref: "synthetic:verified:third", digest: digest("f") },
    enrolledAt: "2026-10-15T04:00:00.000Z",
  });
  expect(await f.sql.query("SELECT * FROM principals")).toEqual(principal);
  expect(await f.principals.readAnchor(old.principalId)).toEqual(anchor);
  expect(await f.principals.readBinding(old.ref)).toEqual(old);
  expect(await f.principals.readBinding(second.ref)).toEqual(secondClosed);
  expect(third.previousRef).toBe(second.ref);
  expect(third.principalId).toBe(old.principalId);
  expect(third.state).toBe("active");
});

test("Auth authority active predecessor refuses successor without changing old state", async () => {
  const f = fixture();
  const old = await root(f);
  await expect(f.principals.appendSuccessor(old, successor())).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await f.principals.readBinding(old.ref)).toEqual(old);
  expect(await f.principals.readBinding("binding_next")).toBeNull();
});

test("Auth authority wrong-Principal predecessor snapshot cannot adopt retained identity", async () => {
  const f = fixture();
  const old = await retiredRoot(f);
  const other = await f.principals.createFresh(fresh("other"));
  await expect(
    f.principals.appendSuccessor(
      { ...old, principalId: other.principalId, principalIncarnation: other.principalIncarnation },
      successor(),
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.principals.readBinding(old.ref)).toEqual(old);
  expect(await f.principals.readBinding("binding_next")).toBeNull();
});

test("Auth authority new root cannot reset a previously retained canonical identity", async () => {
  const f = fixture();
  const old = await retiredRoot(f);
  const candidate = fresh("replacement");
  await expect(
    f.principals.createFresh({
      ...candidate,
      binding: {
        ...candidate.binding,
        issuer: old.issuer,
        subject: old.subject,
        controllerIncarnation: "controller_2",
      },
    }),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(
    await f.sql.query("SELECT id FROM principals WHERE id=?", [candidate.principalId]),
  ).toEqual([]);
  expect(await f.principals.readAnchor(candidate.principalId)).toBeNull();
  expect(await f.principals.readBinding(old.ref)).toEqual(old);
});

test("Auth authority foreign identity target or original evidence cannot become successor", async () => {
  const f = fixture();
  const old = await retiredRoot(f);
  for (const forged of [
    { ...old, targetRef: "synthetic:foreign" },
    { ...old, issuer: "https://foreign.invalid" },
    { ...old, subject: "account_other" },
    { ...old, principalIncarnation: "foreign_inc" },
  ]) {
    await expect(f.principals.appendSuccessor(forged, successor())).rejects.toMatchObject({
      code: "constraint",
    });
  }
  await expect(
    f.principals.appendSuccessor(old, {
      ...successor(),
      controllerIncarnation: old.controllerIncarnation,
    }),
  ).rejects.toMatchObject({ code: "constraint" });
  await expect(
    f.principals.appendSuccessor(old, { ...successor(), evidence: old.evidence }),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.principals.readBinding("binding_next")).toBeNull();
});

test("Auth authority consumed predecessor cannot fork after its valid successor retires", async () => {
  const f = fixture();
  const old = await retiredRoot(f);
  const next = await f.principals.appendSuccessor(old, successor());
  await f.principals.retireBinding(next.ref, next.evidence, {
    ...closure,
    ref: "synthetic:retirement:2",
  });
  await expect(
    f.principals.appendSuccessor(old, successor("binding_fork", "controller_3")),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.principals.readBinding("binding_fork")).toBeNull();
});

test("Auth authority successor requires exact retired body and closure snapshot", async () => {
  const f = fixture();
  const old = await retiredRoot(f);
  await expect(
    f.principals.appendSuccessor(
      { ...old, terminal: { ...closure, ref: "synthetic:wrong-retirement" } },
      successor(),
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.principals.readBinding("binding_next")).toBeNull();
});

test("Auth authority proved legacy binding preserves original Principal Org membership and token rows", async () => {
  const f = fixture();
  await f.sql.batch([
    {
      sql: "INSERT INTO principals VALUES ('prn_legacy','google','original-google-sub','person@example.test','Original',?)",
      params: ["2026-09-01T00:00:00.000Z"],
    },
    {
      sql: "INSERT INTO orgs VALUES ('org_legacy','Original','prn_legacy',?)",
      params: ["2026-09-01T00:00:00.000Z"],
    },
    {
      sql: "INSERT INTO org_memberships VALUES ('org_legacy','prn_legacy','owner',?)",
      params: ["2026-09-01T00:00:00.000Z"],
    },
  ]);
  const before = await f.sql.query("SELECT * FROM principals");
  const orgs = await f.sql.query("SELECT * FROM orgs");
  const members = await f.sql.query("SELECT * FROM org_memberships");
  const bound = await f.principals.bindLegacy({
    principalId: "prn_legacy",
    principalIncarnation: "legacy_inc",
    provider: "google",
    providerSubject: "original-google-sub",
    createdAt: "2026-09-01T00:00:00.000Z",
    origin: { ref: "synthetic:verified-original-account", digest: digest("a") },
    binding: fresh("legacy").binding,
  });
  expect(bound.principalId).toBe("prn_legacy");
  expect(await f.sql.query("SELECT * FROM principals")).toEqual(before);
  expect(await f.sql.query("SELECT * FROM orgs")).toEqual(orgs);
  expect(await f.sql.query("SELECT * FROM org_memberships")).toEqual(members);
  expect(await f.sql.query("SELECT * FROM auth_tokens")).toEqual([]);
});

test("Auth authority zero-row legacy origin fails mandatory final INSERT and rolls back", async () => {
  const f = fixture();
  await f.sql.run(
    "INSERT INTO principals VALUES ('prn_legacy','github','exact-original-sub','same@example.test','Original',?)",
    ["2026-09-01T00:00:00.000Z"],
  );
  await expect(
    f.principals.bindLegacy({
      principalId: "prn_legacy",
      principalIncarnation: "legacy_inc",
      provider: "github",
      providerSubject: "wrong-sub-despite-email",
      createdAt: "2026-09-01T00:00:00.000Z",
      origin: { ref: "synthetic:wrong-local-proof", digest: digest("a") },
      binding: fresh("legacy").binding,
    }),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.principals.readAnchor("prn_legacy")).toBeNull();
  expect(await f.principals.readBinding("binding_legacy")).toBeNull();
});

test("Auth authority token and immutable broker class issue in one real Sql.batch", async () => {
  const f = fixture();
  const b = await broker(f);
  expect(b.record.class).toBe("official-shared-broker");
  expect(b.record.origin.issuanceRef).toBe(b.origin.issuanceRef);
  expect(b.record.token.digest).toBe(b.identity.digest);
  expect(
    await predicateResult(
      f.sql,
      sharedBrokerCredentialCurrentness(b.record, b.expiresAt, "org_original"),
    ),
  ).toBe(1);
  expect(Object.isFrozen(b.record)).toBe(true);
  expect(Object.isFrozen(b.record.origin)).toBe(true);
});

test("Auth authority zero-row token issuance rolls earlier batch writes back", async () => {
  const f = fixture();
  const binding = await root(f);
  const identity = tokenIdentity();
  const origin = credentialOrigin(binding);
  await expect(
    f.sql.batch([
      { sql: "UPDATE auth_guard_probe SET touched=touched+1 WHERE id=1" },
      { sql: "INSERT INTO auth_tokens SELECT * FROM auth_tokens WHERE 0" },
      f.classes.sharedBrokerIssuanceStatement(origin, identity, "org_original"),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.classes.readRetained(origin.ref)).toBeNull();
  expect(await f.sql.query("SELECT touched FROM auth_guard_probe")).toEqual([{ touched: 0 }]);
  expect(await f.sql.query("SELECT id FROM auth_tokens")).toEqual([]);
});

test("Auth authority class collision aborts actual token INSERT without reclassification", async () => {
  const f = fixture();
  const b = await broker(f);
  const nextIdentity = tokenIdentity("two", digest("f"));
  await expect(
    f.sql.batch([
      tokenInsert(b.binding, nextIdentity),
      f.classes.directKeyIssuanceStatement(b.origin, nextIdentity, "org_original"),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens ORDER BY id")).toEqual([
    { id: b.identity.id },
  ]);
  expect(await f.classes.readRetained(b.origin.ref)).toEqual(b.record);
});

test("Auth authority committed unknown ACK recovers retained original without another INSERT", async () => {
  const f = fixture();
  const binding = await root(f);
  const identity = tokenIdentity();
  const selected = credentialOrigin(binding);
  let batches = 0;
  const unknownAck: Sql = {
    query: f.sql.query,
    run: f.sql.run,
    async batch(statements) {
      batches += 1;
      await f.sql.batch(statements);
      throw new SqlError("unavailable", "synthetic ACK lost after real commit");
    },
  };
  const classes = createCredentialAuthorityClassStore({ sql: unknownAck });
  await expect(
    unknownAck.batch([
      tokenInsert(binding, identity),
      classes.sharedBrokerIssuanceStatement(selected, identity, "org_original"),
    ]),
  ).rejects.toMatchObject({ code: "unavailable" });
  const retained = await classes.readRetained(selected.ref);
  expect(retained?.origin).toEqual(selected);
  expect(batches).toBe(1);
  expect(await f.sql.query("SELECT count(*) AS n FROM auth_tokens")).toEqual([{ n: 1 }]);
});

test("Auth authority revoke during awaited material denies final same-Sql mutation and retains history", async () => {
  const f = fixture();
  const b = await broker(f);
  const transport = sharedBrokerCredentialCurrentness(b.record, b.expiresAt, "org_original");
  const human = sharedPrincipalCurrentness(b.binding);
  // This is a local structural race, not a genuine proof-loader or Financial CAS.
  await (async () => {
    await Promise.resolve();
    await f.sql.run("UPDATE auth_tokens SET revoked_at=? WHERE id=?", [
      new Date().toISOString(),
      b.identity.id,
    ]);
  })();
  const write = await f.sql.run(
    `UPDATE auth_guard_probe SET touched=touched+1 WHERE id=1 AND ${transport.sql} AND ${human.sql}`,
    [...transport.params, ...human.params],
  );
  expect(write.changes).toBe(0);
  const retained = await f.classes.readRetained(b.origin.ref);
  expect(retained?.state).toBe("retired");
  expect(retained?.origin).toEqual(b.record.origin);
  expect(await f.sql.query("SELECT touched FROM auth_guard_probe")).toEqual([{ touched: 0 }]);
});

test("Auth authority same token ID with new digest needs a new class incarnation", async () => {
  const f = fixture();
  const b = await broker(f);
  await f.sql.run("DELETE FROM auth_tokens WHERE id=?", [b.identity.id]);
  const replacement = tokenIdentity("one", digest("f"));
  const next = credentialOrigin(b.binding, "replacement");
  await f.sql.batch([
    tokenInsert(b.binding, replacement),
    f.classes.sharedBrokerIssuanceStatement(next, replacement, "org_original"),
  ]);
  expect((await f.classes.readRetained(b.origin.ref))?.state).toBe("retired");
  expect((await f.classes.readRetained(next.ref))?.origin.incarnation).toBe(next.incarnation);
  expect(
    await predicateResult(
      f.sql,
      sharedBrokerCredentialCurrentness(b.record, b.expiresAt, "org_original"),
    ),
  ).toBe(0);
});

test("Auth authority retired digest cannot be reissued under another class", async () => {
  const f = fixture();
  const b = await broker(f);
  await f.sql.run("DELETE FROM auth_tokens WHERE id=?", [b.identity.id]);
  const next = credentialOrigin(b.binding, "replacement");
  await expect(
    f.sql.batch([
      tokenInsert(b.binding, b.identity),
      f.classes.directKeyIssuanceStatement(next, b.identity, "org_original"),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens")).toEqual([]);
  expect((await f.classes.readRetained(b.origin.ref))?.state).toBe("retired");
});

test("Auth authority Principal deletion fences classes preserves history and blocks enrolled ID reuse", async () => {
  const f = fixture();
  const b = await broker(f);
  await f.sql.run("DELETE FROM principals WHERE id=?", [b.binding.principalId]);
  expect((await f.principals.readAnchor(b.binding.principalId))?.state).toBe("retired");
  expect((await f.principals.readBinding(b.binding.ref))?.state).toBe("retired");
  expect((await f.classes.readRetained(b.origin.ref))?.state).toBe("retired");
  await expect(
    f.sql.run("INSERT INTO principals VALUES (?,'shared-account',?,NULL,NULL,?)", [
      b.binding.principalId,
      b.binding.ref,
      "2026-10-15T00:00:00.000Z",
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
});

test("Auth authority wrong scope Org target or direct class cannot satisfy shared broker guard", async () => {
  const f = fixture();
  const b = await broker(f);
  expect(() => sharedBrokerCredentialCurrentness(b.record, b.expiresAt, "org_other")).toThrow();
  expect(
    await predicateResult(
      f.sql,
      sharedBrokerCredentialCurrentness(
        { ...b.record, origin: { ...b.record.origin, targetRef: "synthetic:foreign" } },
        b.expiresAt,
        "org_original",
      ),
    ),
  ).toBe(0);
  expect(() =>
    sharedBrokerCredentialCurrentness(
      { ...b.record, class: "direct-exact-org-key" },
      b.expiresAt,
      "org_original",
    ),
  ).toThrow();
  const noPayments = tokenIdentity("readonly", digest("f"));
  const selected = credentialOrigin(b.binding, "readonly");
  const readonlyToken = { ...noPayments, scopesJson: '["wallet:read"]' };
  const expiry = new Date(Date.now() + 3600000).toISOString();
  await f.sql.batch([
    tokenInsert(b.binding, readonlyToken, "org_original", "api_key", expiry),
    f.classes.sharedBrokerIssuanceStatement(selected, readonlyToken, "org_original"),
  ]);
  const record = await f.classes.readRetained(selected.ref);
  if (!record || record.backend !== "auth-token") throw new Error("Missing structural class");
  expect(
    await predicateResult(f.sql, sharedBrokerCredentialCurrentness(record, expiry, "org_original")),
  ).toBe(0);
});

test("Auth authority immutable class cannot mutate direct/shared or original credential fields", async () => {
  const f = fixture();
  const b = await broker(f);
  await expect(
    f.sql.run(
      "UPDATE credential_authority_classes SET class='direct-exact-org-key' WHERE authority_ref=?",
      [b.origin.ref],
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  await expect(
    f.sql.run("UPDATE auth_tokens SET scopes_json='[]' WHERE id=?", [b.identity.id]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.classes.readRetained(b.origin.ref)).toEqual(b.record);
});

test("Auth authority RP helper requires actual current version and never invents auth_tokens", async () => {
  const f = fixture();
  const binding = await root(f);
  const selected = credentialOrigin(binding);
  const now = Date.now();
  const identity: RpAuthorityIdentity = {
    principalBindingRef: binding.ref,
    registrationRef: "synthetic:rp-registration",
    registrationDigest: digest("d"),
    sessionDigest: digest("e"),
    sessionCreatedAt: now - 1000,
    enrolledSessionVersion: 7,
    issuer: binding.issuer,
    clientId: "synthetic:rp-client",
    subject: binding.subject,
    issuerSessionId: "synthetic:sid",
    authTime: Math.floor(now / 1000),
    accountId: binding.subject,
    workspaceId: "workspace_original",
    workspaceRef: "synthetic:workspace-ref",
  };
  const current = { version: 7, absoluteExpiresAt: now + 3600000, lastUsedAt: now };
  await f.sql.batch([
    {
      sql: "INSERT INTO shared_auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      params: [
        identity.sessionDigest,
        identity.accountId,
        binding.principalId,
        identity.workspaceId,
        "synthetic-encrypted-payload",
        identity.sessionCreatedAt,
        current.lastUsedAt,
        current.absoluteExpiresAt,
        now,
        current.version,
        "active",
      ],
    },
    f.classes.sharedRpIssuanceStatement(selected, identity, "org_original"),
  ]);
  const record = await f.classes.readRetained(selected.ref);
  if (!record || record.backend !== "shared-rp-session")
    throw new Error("Missing structural RP class");
  const guard = sharedRpCredentialCurrentness(record, current, "org_original");
  expect(await predicateResult(f.sql, guard)).toBe(1);
  await f.sql.run("UPDATE shared_auth_sessions SET version=version+1 WHERE digest=?", [
    identity.sessionDigest,
  ]);
  expect(await predicateResult(f.sql, guard)).toBe(0);
  expect(await f.sql.query("SELECT id FROM auth_tokens")).toEqual([]);
  expect((await f.classes.readRetained(selected.ref))?.origin).toEqual(selected);
});

test("Auth authority retained class closure requires exact original issuance and is terminal", async () => {
  const f = fixture();
  const b = await broker(f);
  await expect(
    f.classes.retire({ ...b.origin, issuanceRef: "synthetic:wrong" }, closure),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await f.classes.readRetained(b.origin.ref))?.state).toBe("active");
  await f.classes.retire(b.origin, closure);
  expect((await f.classes.readRetained(b.origin.ref))?.terminal).toEqual(closure);
  await expect(f.classes.retire(b.origin, closure)).rejects.toMatchObject({ code: "conflict" });
});

test("Auth authority missing schema is unavailable and never bootstraps itself", async () => {
  const db = new Database(":memory:");
  opened.add(db);
  const sql = createSqliteSql(db);
  await expect(
    createCredentialAuthorityClassStore({ sql }).readRetained("authority_absent"),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await sql.query("SELECT name FROM sqlite_schema WHERE type='table'")).toEqual([]);
});

test("Auth authority fixed direct issuer statements remain distinct from shared broker", async () => {
  const f = fixture();
  await f.sql.run(
    "INSERT INTO principals VALUES ('prn_direct','google','direct-original-sub','direct@example.test','Direct',?)",
    ["2026-09-01T00:00:00.000Z"],
  );
  const binding = await f.principals.bindLegacy({
    principalId: "prn_direct",
    principalIncarnation: "direct_inc",
    provider: "google",
    providerSubject: "direct-original-sub",
    createdAt: "2026-09-01T00:00:00.000Z",
    origin: { ref: "synthetic:proved-direct", digest: digest("a") },
    binding: fresh("direct").binding,
  });
  const session = { ...tokenIdentity("direct_session"), id: "ses_direct", scopesJson: "[]" };
  const sessionOrigin = credentialOrigin(binding, "direct_session");
  await f.sql.batch([
    tokenInsert(binding, session, "org_original", "session"),
    f.classes.localSessionIssuanceStatement(sessionOrigin, session),
  ]);
  const key = tokenIdentity("direct_key", digest("f"));
  const keyOrigin = credentialOrigin(binding, "direct_key");
  await f.sql.batch([
    tokenInsert(binding, key),
    f.classes.directKeyIssuanceStatement(keyOrigin, key, "org_original"),
  ]);
  const s = await f.classes.readRetained(sessionOrigin.ref);
  const k = await f.classes.readRetained(keyOrigin.ref);
  if (!s || s.backend !== "auth-token" || !k || k.backend !== "auth-token")
    throw new Error("Missing direct rows");
  expect(s.class).toBe("direct-owner-session");
  expect(s.organizationId).toBeNull();
  expect(k.class).toBe("direct-exact-org-key");
  expect(k.organizationId).toBe("org_original");
  expect(() =>
    sharedBrokerCredentialCurrentness(
      k,
      new Date(Date.now() + 3600000).toISOString(),
      "org_original",
    ),
  ).toThrow();
});

test("Auth authority broker owner cannot be relabeled as the independent human binding", async () => {
  const f = fixture();
  const b = await broker(f);
  const human = await f.principals.createFresh(fresh("human"));
  const original = sharedBrokerCredentialCurrentness(b.record, b.expiresAt, "org_original");
  const relabeled = sharedBrokerCredentialCurrentness(
    {
      ...b.record,
      origin: {
        ...b.record.origin,
        principalId: human.principalId,
        principalIncarnation: human.principalIncarnation,
      },
    },
    b.expiresAt,
    "org_original",
  );
  expect(await predicateResult(f.sql, original)).toBe(1);
  expect(await predicateResult(f.sql, relabeled)).toBe(0);
  expect(await predicateResult(f.sql, sharedPrincipalCurrentness(human))).toBe(1);
  // Both independent currentness facts still need Financial's actual verified
  // source and explicit payer/consent/realm/history guard at its own CAS.
  expect((await f.classes.readRetained(b.origin.ref))?.origin.principalId).toBe(
    b.binding.principalId,
  );
});

test("Auth authority legacy creation text is retained byte-for-byte without invented chronology", async () => {
  const f = fixture();
  const originalText = "2026-09-01 00:00:00";
  await f.sql.run(
    "INSERT INTO principals VALUES ('prn_history','github','history-sub','history@example.test','History',?)",
    [originalText],
  );
  await f.principals.bindLegacy({
    principalId: "prn_history",
    principalIncarnation: "history_inc",
    provider: "github",
    providerSubject: "history-sub",
    createdAt: originalText,
    origin: { ref: "synthetic:proved-history", digest: digest("a") },
    binding: fresh("history").binding,
  });
  expect((await f.principals.readAnchor("prn_history"))?.principalCreatedAt).toBe(originalText);
  expect(await f.sql.query("SELECT created_at FROM principals WHERE id='prn_history'")).toEqual([
    { created_at: originalText },
  ]);
});
