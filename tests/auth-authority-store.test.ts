import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CapturedAuthTokenRow } from "../src/auth.ts";
import { additiveAuthDDL } from "../src/auth-authority-schema-plan.ts";
import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  directCredentialCurrentness,
  directOwnerKeySourceCurrentness,
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
  type IdentityAuthorityDomain,
  localPrincipalCurrentness,
  type PrincipalAnchor,
  parseIdentityAuthorityDomain,
  type SharedPrincipalBinding,
  sharedPrincipalCurrentness,
} from "../src/shared-principal-authority.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

// Structural component fixtures only: no genuine identity/proof/payer enrollment.
const syntheticBase = readFileSync(
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
  db.exec(syntheticBase);
  db.exec(additiveAuthDDL);
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
function credentialOrigin(
  binding: Pick<SharedPrincipalBinding, "principalId" | "principalIncarnation" | "targetRef">,
  id = "one",
): CredentialAuthorityOrigin {
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
  binding: Pick<SharedPrincipalBinding, "principalId">,
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

test("Auth authority retained broker ref blocks synthetic direct reclassification atomically", async () => {
  const f = fixture();
  const b = await broker(f);
  const anchor = await syntheticLocal(f);
  if (anchor.originKind !== "fresh-local") throw new Error("Not local");
  const control = tokenIdentity("direct_control", digest("c"));
  const controlOrigin = directOrigin(anchor, "direct_control");
  await f.sql.batch([
    tokenInsert({ principalId: anchor.principalId }, control),
    f.classes.directKeyIssuanceStatement(
      controlOrigin,
      control,
      "org_original",
      anchor,
      anchor.verificationDomain,
    ),
  ]);
  expect((await f.classes.readRetained(controlOrigin.ref))?.class).toBe("direct-exact-org-key");
  const nextIdentity = tokenIdentity("two", digest("f"));
  const next = { ...directOrigin(anchor, "cross_class_ref"), ref: b.origin.ref };
  expect(nextIdentity.id).not.toBe(b.identity.id);
  expect(nextIdentity.digest).not.toBe(b.identity.digest);
  expect(
    await predicateResult(
      f.sql,
      await localPrincipalCurrentness(anchor, anchor.verificationDomain),
    ),
  ).toBe(1);
  await expect(
    f.sql.batch([
      tokenInsert({ principalId: anchor.principalId }, nextIdentity),
      f.classes.directKeyIssuanceStatement(
        next,
        nextIdentity,
        "org_original",
        anchor,
        anchor.verificationDomain,
      ),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens ORDER BY id")).toEqual([
    { id: control.id },
    { id: b.identity.id },
  ]);
  expect(await f.classes.readRetained(b.origin.ref)).toEqual(b.record);
  expect(await f.classes.readRetained(controlOrigin.ref)).not.toBeNull();
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
  const retired = await f.classes.readRetained(b.origin.ref);
  expect(retired?.state).toBe("retired");
  const anchor = await syntheticLocal(f);
  if (anchor.originKind !== "fresh-local") throw new Error("Not local");
  const control = tokenIdentity("direct_control", digest("f"));
  const controlOrigin = directOrigin(anchor, "direct_control");
  await f.sql.batch([
    tokenInsert({ principalId: anchor.principalId }, control),
    f.classes.directKeyIssuanceStatement(
      controlOrigin,
      control,
      "org_original",
      anchor,
      anchor.verificationDomain,
    ),
  ]);
  expect((await f.classes.readRetained(controlOrigin.ref))?.class).toBe("direct-exact-org-key");
  const reused = tokenIdentity("historical_digest", b.identity.digest);
  const next = directOrigin(anchor, "historical_digest");
  expect(reused.id).not.toBe(b.identity.id);
  expect(next.ref).not.toBe(b.origin.ref);
  expect(
    await f.sql.query("SELECT id FROM auth_tokens WHERE secret_digest=?", [reused.digest]),
  ).toEqual([]);
  await expect(
    f.sql.batch([
      tokenInsert({ principalId: anchor.principalId }, reused),
      f.classes.directKeyIssuanceStatement(
        next,
        reused,
        "org_original",
        anchor,
        anchor.verificationDomain,
      ),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens ORDER BY id")).toEqual([{ id: control.id }]);
  expect(await f.classes.readRetained(next.ref)).toBeNull();
  expect(await f.classes.readRetained(b.origin.ref)).toEqual(retired);
  expect(
    await f.sql.query(
      "SELECT token_digest FROM credential_authority_classes WHERE authority_ref=?",
      [b.origin.ref],
    ),
  ).toEqual([{ token_digest: b.identity.digest }]);
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

function domainFrom(body: readonly string[]): IdentityAuthorityDomain {
  return {
    body,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
  };
}
function localDomain(
  provider: "takos-id" | "google" | "github" = "takos-id",
  config = "https://issuer.example.test",
): IdentityAuthorityDomain {
  const body =
    provider === "takos-id"
      ? ["takoserver.identity-verification-domain.v1", "takos-id", "oidc", config, "client-1"]
      : provider === "google"
        ? [
            "takoserver.identity-verification-domain.v1",
            "google",
            "oidc",
            "accounts.google.com",
            "https://accounts.google.com",
            config,
          ]
        : [
            "takoserver.identity-verification-domain.v1",
            "github",
            "operator-assertion",
            config,
            "OKP",
            "Ed25519",
            "public-x",
          ];
  return domainFrom(body);
}
async function syntheticLocal(
  f: ReturnType<typeof fixture>,
  provider: "takos-id" | "google" | "github" = "takos-id",
  domain = localDomain(provider),
  id = "direct",
): Promise<PrincipalAnchor> {
  const principalId = `prn_${id}`;
  const incarnation = `${id}_inc`;
  await f.sql.batch([
    {
      sql: "INSERT INTO principals VALUES (?,?,?,'direct@example.test','Direct',?)",
      params: [principalId, provider, "direct-original-sub", "2026-09-01T00:00:00.000Z"],
    },
    {
      sql: `INSERT INTO auth_principal_incarnations
      (principal_id,principal_incarnation,identity_kind,identity_subject,principal_created_at,
       origin_kind,origin_ref,origin_digest,identity_authority_body,identity_authority_digest,enrolled_at)
      VALUES (?,?,?,?,?,'fresh-local',?,?,?,?,?)`,
      params: [
        principalId,
        incarnation,
        provider,
        "direct-original-sub",
        "2026-09-01T00:00:00.000Z",
        "synthetic:local-origin",
        digest("a"),
        JSON.stringify(domain.body),
        domain.digest,
        "2026-10-15T00:00:00.000Z",
      ],
    },
  ]);
  const anchor = await f.principals.readAnchor(principalId);
  if (!anchor || anchor.originKind !== "fresh-local")
    throw new Error("Missing synthetic local anchor");
  return anchor;
}
function directOrigin(anchor: PrincipalAnchor, id: string): CredentialAuthorityOrigin {
  return credentialOrigin(
    {
      principalId: anchor.principalId,
      principalIncarnation: anchor.incarnation,
      targetRef: "synthetic:server-target",
    },
    id,
  );
}

// A structural prerequisite only: this is not a private Accounts capture or
// enrolled Auth103 target, and cannot be used as an issuer permission.
async function syntheticDirectSource(f: ReturnType<typeof fixture>) {
  const anchor = await syntheticLocal(f);
  if (anchor.originKind !== "fresh-local") throw new Error("Not synthetic local");
  const session = { ...tokenIdentity("source_session"), id: "ses_source", scopesJson: "[]" };
  const selected = directOrigin(anchor, "source_session");
  await f.sql.batch([
    tokenInsert({ principalId: anchor.principalId }, session, "org_original", "session"),
    f.classes.localSessionIssuanceStatement(selected, session, anchor, anchor.verificationDomain),
  ]);
  await f.sql.batch([
    {
      sql: "INSERT INTO orgs VALUES (?,'Synthetic Org',?,?)",
      params: ["org_original", anchor.principalId, new Date().toISOString()],
    },
    {
      sql: "INSERT INTO org_memberships VALUES (?,?,'owner',?)",
      params: ["org_original", anchor.principalId, new Date().toISOString()],
    },
  ]);
  const row = (
    await f.sql.query(
      "SELECT id,secret_digest,kind,principal_id,org_id,scopes_json,created_at,expires_at FROM auth_tokens WHERE id=?",
      [session.id],
    )
  )[0];
  if (!row) throw new Error("Missing synthetic source session");
  const captured: CapturedAuthTokenRow = Object.freeze({
    tokenId: String(row.id),
    digest: String(row.secret_digest) as `sha256:${string}`,
    kind: "session",
    principalId: String(row.principal_id),
    organizationId: null,
    scopesJson: String(row.scopes_json),
    scopes: Object.freeze([]),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  });
  const record = await f.classes.readActiveDirectOwnerSessionByToken({
    id: captured.tokenId,
    digest: captured.digest,
  });
  if (!record) throw new Error("Missing synthetic direct source class");
  return { anchor, session, selected, captured, record };
}

function guardedSyntheticKeyInsert(
  anchor: PrincipalAnchor,
  key: TokenAuthorityIdentity,
  guard: {
    readonly sql: string;
    readonly params: readonly (string | number | null | ArrayBuffer)[];
  },
  exclusive = false,
): SqlStatement {
  return {
    sql: `INSERT INTO auth_tokens
      (secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at)
      SELECT ?,?,'api_key',?,?,'synthetic-key',?,?,?
      WHERE ${guard.sql}
        ${
          exclusive
            ? "AND NOT EXISTS (SELECT 1 FROM auth_tokens WHERE org_id=? AND kind='api_key' AND name='synthetic-key' AND revoked_at IS NULL)"
            : ""
        }`,
    params: [
      key.digest,
      key.id,
      anchor.principalId,
      "org_original",
      key.scopesJson,
      key.createdAt,
      new Date(Date.now() + 3600000).toISOString(),
      ...guard.params,
      ...(exclusive ? ["org_original"] : []),
    ],
  };
}

test("Auth authority exact direct source lookup and fixed owner predicate are structural only", async () => {
  const f = fixture();
  const source = await syntheticDirectSource(f);
  const { anchor, captured, record } = source;
  expect(record.class).toBe("direct-owner-session");
  expect(
    await f.classes.readActiveDirectOwnerSessionByToken({
      id: captured.tokenId,
      digest: digest("f"),
    }),
  ).toBeNull();
  expect(
    await f.classes.readActiveDirectOwnerSessionByToken({
      id: "ses_absent",
      digest: captured.digest,
    }),
  ).toBeNull();
  const guard = directOwnerKeySourceCurrentness(
    record,
    anchor,
    anchor.verificationDomain,
    captured,
    "org_original",
  );
  expect(await predicateResult(f.sql, guard)).toBe(1);
  expect(
    await predicateResult(
      f.sql,
      directOwnerKeySourceCurrentness(
        record,
        anchor,
        anchor.verificationDomain,
        { ...captured, expiresAt: "2026-10-15T00:00:00.000Z" },
        "org_original",
      ),
    ),
  ).toBe(0);
  for (const different of [
    { ...captured, tokenId: "ses_other" },
    { ...captured, digest: digest("f") },
    { ...captured, scopesJson: '["payments:write"]' },
    { ...captured, createdAt: "2026-10-15T00:00:00.000Z" },
    { ...captured, principalId: "prn_other" },
    { ...captured, organizationId: "org_original" },
    { ...captured, kind: "api_key" as const },
  ]) {
    expect(() =>
      directOwnerKeySourceCurrentness(
        record,
        anchor,
        anchor.verificationDomain,
        different,
        "org_original",
      ),
    ).toThrow();
  }
  await f.sql.run("UPDATE org_memberships SET role='member' WHERE org_id=?", ["org_original"]);
  expect(await predicateResult(f.sql, guard)).toBe(0);
  await f.sql.run("UPDATE org_memberships SET role='owner' WHERE org_id=?", ["org_original"]);
  await f.sql.run("UPDATE orgs SET owner_principal_id='prn_other' WHERE id=?", ["org_original"]);
  expect(await predicateResult(f.sql, guard)).toBe(0);
});

test("Auth authority source lookup refuses null, duplicate and inconsistent retained rows", async () => {
  const f = fixture();
  const { captured } = await syntheticDirectSource(f);
  await expect(
    f.classes.readActiveDirectOwnerSessionByToken({
      id: captured.tokenId,
      digest: null as unknown as `sha256:${string}`,
    }),
  ).rejects.toMatchObject({ code: "invalid" });
  const doubled: Sql = {
    query: async (query, params) => {
      const rows = await f.sql.query(query, params);
      return query.includes("class='direct-owner-session' AND state='active'")
        ? [...rows, ...rows]
        : rows;
    },
    run: f.sql.run,
    batch: f.sql.batch,
  };
  await expect(
    createCredentialAuthorityClassStore({ sql: doubled }).readActiveDirectOwnerSessionByToken({
      id: captured.tokenId,
      digest: captured.digest,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  const inconsistent: Sql = {
    query: async (query, params) => {
      const rows = await f.sql.query(query, params);
      return query.includes("class='direct-owner-session' AND state='active'")
        ? rows.map((row) => ({ ...row, token_kind: "api_key" }))
        : rows;
    },
    run: f.sql.run,
    batch: f.sql.batch,
  };
  await expect(
    createCredentialAuthorityClassStore({ sql: inconsistent }).readActiveDirectOwnerSessionByToken({
      id: captured.tokenId,
      digest: captured.digest,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
});

test("Auth authority synthetic source guard and mandatory class accept a current owner", async () => {
  const f = fixture();
  const { anchor, captured, record } = await syntheticDirectSource(f);
  const guard = directOwnerKeySourceCurrentness(
    record,
    anchor,
    anchor.verificationDomain,
    captured,
    "org_original",
  );
  const key = tokenIdentity("guarded_positive", digest("f"));
  const selected = directOrigin(anchor, "guarded_positive");
  const writes = await f.sql.batch([
    guardedSyntheticKeyInsert(anchor, key, guard),
    f.classes.directKeyFromOwnerSessionStatement(
      selected,
      key,
      "org_original",
      anchor,
      anchor.verificationDomain,
      record,
      captured,
      { name: "synthetic-key" },
    ),
  ]);
  expect(writes.map((write) => write.changes)).toEqual([1, 1]);
  expect((await f.classes.readRetained(selected.ref))?.class).toBe("direct-exact-org-key");
});

test("Auth authority exclusive-name zero row and exact preexisting ID cannot gain a class", async () => {
  const f = fixture();
  const { anchor, captured, record } = await syntheticDirectSource(f);
  const guard = directOwnerKeySourceCurrentness(
    record,
    anchor,
    anchor.verificationDomain,
    captured,
    "org_original",
  );
  const competing = tokenIdentity("competing", digest("b"));
  await f.sql.batch([
    {
      sql: `INSERT INTO auth_tokens
        (secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at)
        VALUES (?,?,'api_key',?,?,'synthetic-key',?,?,?)`,
      params: [
        competing.digest,
        competing.id,
        anchor.principalId,
        "org_original",
        competing.scopesJson,
        competing.createdAt,
        new Date(Date.now() + 3600000).toISOString(),
      ],
    },
  ]);
  const exclusive = tokenIdentity("exclusive_attempt", digest("f"));
  const exclusiveOrigin = directOrigin(anchor, "exclusive_attempt");
  await expect(
    f.sql.batch([
      guardedSyntheticKeyInsert(anchor, exclusive, guard, true),
      f.classes.directKeyFromOwnerSessionStatement(
        exclusiveOrigin,
        exclusive,
        "org_original",
        anchor,
        anchor.verificationDomain,
        record,
        captured,
        { name: "synthetic-key", exclusiveUnrevokedName: "synthetic-key" },
      ),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens WHERE id=?", [exclusive.id])).toEqual([]);
  expect(await f.classes.readRetained(exclusiveOrigin.ref)).toBeNull();
  await f.sql.run("UPDATE auth_tokens SET revoked_at=? WHERE id=?", [
    new Date().toISOString(),
    competing.id,
  ]);
  const exclusiveSuccess = tokenIdentity("exclusive_positive", digest("a"));
  const successOrigin = directOrigin(anchor, "exclusive_positive");
  const successWrites = await f.sql.batch([
    guardedSyntheticKeyInsert(anchor, exclusiveSuccess, guard, true),
    f.classes.directKeyFromOwnerSessionStatement(
      successOrigin,
      exclusiveSuccess,
      "org_original",
      anchor,
      anchor.verificationDomain,
      record,
      captured,
      { name: "synthetic-key", exclusiveUnrevokedName: "synthetic-key" },
    ),
  ]);
  expect(successWrites.map((write) => write.changes)).toEqual([1, 1]);
  expect((await f.classes.readRetained(successOrigin.ref))?.class).toBe("direct-exact-org-key");

  // The old ON CONFLICT DO NOTHING shape would skip this INSERT. The selected
  // shape must use a plain ID conflict so an exact unclassified row aborts.
  const preexisting = tokenIdentity("preexisting_exact", digest("c"));
  const preexistingInsert = guardedSyntheticKeyInsert(anchor, preexisting, guard);
  await f.sql.batch([preexistingInsert]);
  const preexistingOrigin = directOrigin(anchor, "preexisting_exact");
  await expect(
    f.sql.batch([
      preexistingInsert,
      f.classes.directKeyFromOwnerSessionStatement(
        preexistingOrigin,
        preexisting,
        "org_original",
        anchor,
        anchor.verificationDomain,
        record,
        captured,
        { name: "synthetic-key" },
      ),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.classes.readRetained(preexistingOrigin.ref)).toBeNull();
  expect(await f.sql.query("SELECT id FROM auth_tokens WHERE id=?", [preexisting.id])).toEqual([
    { id: preexisting.id },
  ]);
});

test("Auth authority changed source owner or revoked session aborts guarded key batch", async () => {
  const f = fixture();
  const source = await syntheticDirectSource(f);
  const { anchor, captured, record } = source;
  const guard = directOwnerKeySourceCurrentness(
    record,
    anchor,
    anchor.verificationDomain,
    captured,
    "org_original",
  );
  await f.sql.run("UPDATE org_memberships SET role='member' WHERE org_id=?", ["org_original"]);
  const first = tokenIdentity("guarded_first", digest("f"));
  const firstOrigin = directOrigin(anchor, "guarded_first");
  await expect(
    f.sql.batch([
      { sql: "UPDATE auth_guard_probe SET touched=touched+1 WHERE id=1" },
      guardedSyntheticKeyInsert(anchor, first, guard),
      f.classes.directKeyFromOwnerSessionStatement(
        firstOrigin,
        first,
        "org_original",
        anchor,
        anchor.verificationDomain,
        record,
        captured,
        { name: "synthetic-key" },
      ),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT touched FROM auth_guard_probe")).toEqual([{ touched: 0 }]);
  expect(await f.sql.query("SELECT id FROM auth_tokens WHERE id=?", [first.id])).toEqual([]);
  expect(await f.classes.readRetained(firstOrigin.ref)).toBeNull();
  await f.sql.run("UPDATE org_memberships SET role='owner' WHERE org_id=?", ["org_original"]);
  await f.sql.run("UPDATE auth_tokens SET revoked_at=? WHERE id=?", [
    new Date().toISOString(),
    captured.tokenId,
  ]);
  expect(
    await f.classes.readActiveDirectOwnerSessionByToken({
      id: captured.tokenId,
      digest: captured.digest,
    }),
  ).toBeNull();
  const second = tokenIdentity("guarded_second", digest("c"));
  const secondOrigin = directOrigin(anchor, "guarded_second");
  await expect(
    f.sql.batch([
      guardedSyntheticKeyInsert(anchor, second, guard),
      f.classes.directKeyFromOwnerSessionStatement(
        secondOrigin,
        second,
        "org_original",
        anchor,
        anchor.verificationDomain,
        record,
        captured,
        { name: "synthetic-key" },
      ),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens WHERE id=?", [second.id])).toEqual([]);
  expect(await f.classes.readRetained(secondOrigin.ref)).toBeNull();
  expect((await f.classes.readRetained(source.selected.ref))?.state).toBe("retired");
});

test("Auth authority guarded direct key unknown ACK is never resent", async () => {
  const f = fixture();
  const { anchor, captured, record } = await syntheticDirectSource(f);
  const guard = directOwnerKeySourceCurrentness(
    record,
    anchor,
    anchor.verificationDomain,
    captured,
    "org_original",
  );
  const key = tokenIdentity("unknown_ack", digest("f"));
  const selected = directOrigin(anchor, "unknown_ack");
  let batches = 0;
  const unknownAck: Sql = {
    query: f.sql.query,
    run: f.sql.run,
    async batch(statements) {
      batches += 1;
      await f.sql.batch(statements);
      throw new SqlError("unavailable", "synthetic ACK lost after direct batch commit");
    },
  };
  await expect(
    unknownAck.batch([
      guardedSyntheticKeyInsert(anchor, key, guard),
      f.classes.directKeyFromOwnerSessionStatement(
        selected,
        key,
        "org_original",
        anchor,
        anchor.verificationDomain,
        record,
        captured,
        { name: "synthetic-key" },
      ),
    ]),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(batches).toBe(1);
  expect(await f.sql.query("SELECT id FROM auth_tokens WHERE id=?", [key.id])).toEqual([
    { id: key.id },
  ]);
  expect((await f.classes.readRetained(selected.ref))?.class).toBe("direct-exact-org-key");
});

test("Auth authority proved legacy cannot mint direct class and token batch rolls back", async () => {
  const f = fixture();
  await f.sql.run(
    "INSERT INTO principals VALUES ('prn_legacy_direct','google','direct-original-sub','direct@example.test','Direct',?)",
    ["2026-09-01T00:00:00.000Z"],
  );
  const binding = await f.principals.bindLegacy({
    principalId: "prn_legacy_direct",
    principalIncarnation: "legacy_direct_inc",
    provider: "google",
    providerSubject: "direct-original-sub",
    createdAt: "2026-09-01T00:00:00.000Z",
    origin: { ref: "synthetic:proved-direct", digest: digest("a") },
    binding: fresh("direct").binding,
  });
  const anchor = await f.principals.readAnchor(binding.principalId);
  if (!anchor) throw new Error("Missing proved-legacy anchor");
  const forged = {
    ...anchor,
    originKind: "fresh-local" as const,
    identityKind: "google" as const,
    verificationDomain: localDomain("google"),
  };
  const session = { ...tokenIdentity("direct_session"), id: "ses_direct", scopesJson: "[]" };
  const selected = credentialOrigin(binding, "direct_session");
  await expect(
    f.sql.batch([
      tokenInsert(binding, session, "org_original", "session"),
      f.classes.localSessionIssuanceStatement(selected, session, forged, forged.verificationDomain),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens")).toEqual([]);
  expect(await f.classes.readRetained(selected.ref)).toBeNull();
  const key = tokenIdentity("direct_key", digest("f"));
  await expect(
    f.sql.batch([
      tokenInsert(binding, key),
      f.classes.directKeyIssuanceStatement(
        credentialOrigin(binding, "direct_key"),
        key,
        "org_original",
        forged,
        forged.verificationDomain,
      ),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens")).toEqual([]);
});

test("Auth authority synthetic fresh-local component accepts exact direct domain", async () => {
  const f = fixture();
  const anchor = await syntheticLocal(f);
  if (anchor.originKind !== "fresh-local") throw new Error("Not local");
  await expect(
    f.sql.run("UPDATE principals SET created_at='2026-09-01 00:00:00' WHERE id=?", [
      anchor.principalId,
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(
    await predicateResult(
      f.sql,
      await localPrincipalCurrentness(
        { ...anchor, principalCreatedAt: "2026-09-01 00:00:00" },
        anchor.verificationDomain,
      ),
    ),
  ).toBe(0);
  expect(Object.isFrozen(anchor.verificationDomain.body)).toBe(true);
  const sameDomain = localDomain();
  const nextAssertionDigest = digest("f");
  expect(nextAssertionDigest).not.toBe(anchor.origin.digest);
  // A new verified assertion changes historical evidence, not the stable domain.
  expect(await predicateResult(f.sql, await localPrincipalCurrentness(anchor, sameDomain))).toBe(1);
  for (const changed of [
    localDomain("takos-id", "https://issuer.other.test"),
    localDomain("google", "other-client"),
    localDomain("github", "other-audience"),
  ]) {
    if (changed.body[1] === "takos-id") {
      expect(await predicateResult(f.sql, await localPrincipalCurrentness(anchor, changed))).toBe(
        0,
      );
    } else {
      await expect(localPrincipalCurrentness(anchor, changed)).rejects.toMatchObject({
        code: "unavailable",
      });
    }
  }
  const session = { ...tokenIdentity("direct_session"), id: "ses_direct", scopesJson: "[]" };
  const selected = directOrigin(anchor, "direct_session");
  await f.sql.batch([
    tokenInsert({ principalId: anchor.principalId }, session, "org_original", "session"),
    f.classes.localSessionIssuanceStatement(selected, session, anchor, sameDomain),
  ]);
  const record = await f.classes.readRetained(selected.ref);
  if (!record || record.backend !== "auth-token") throw new Error("Missing synthetic direct class");
  expect(record.class).toBe("direct-owner-session");
  const expires = (
    await f.sql.query("SELECT expires_at FROM auth_tokens WHERE id=?", [session.id])
  )[0]?.expires_at;
  expect(
    await predicateResult(
      f.sql,
      directCredentialCurrentness(record, anchor, sameDomain, String(expires)),
    ),
  ).toBe(1);
  const key = tokenIdentity("direct_key", digest("f"));
  const keyOrigin = directOrigin(anchor, "direct_key");
  await f.sql.batch([
    tokenInsert({ principalId: anchor.principalId }, key),
    f.classes.directKeyIssuanceStatement(keyOrigin, key, "org_original", anchor, sameDomain),
  ]);
  const retainedKey = await f.classes.readRetained(keyOrigin.ref);
  expect(retainedKey?.class).toBe("direct-exact-org-key");
  const brokerKey = tokenIdentity("wrong_broker", digest("c"));
  const brokerOrigin = directOrigin(anchor, "wrong_broker");
  await expect(
    f.sql.batch([
      tokenInsert({ principalId: anchor.principalId }, brokerKey),
      f.classes.sharedBrokerIssuanceStatement(brokerOrigin, brokerKey, "org_original"),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sql.query("SELECT id FROM auth_tokens WHERE id=?", [brokerKey.id])).toEqual([]);
  expect(
    await f.sql.query(
      "SELECT origin_digest, identity_authority_digest FROM auth_principal_incarnations",
    ),
  ).toEqual([{ origin_digest: digest("a"), identity_authority_digest: sameDomain.digest }]);
});

test("Auth authority parser rejects noncanonical, malformed, changed and unknown domain bodies", async () => {
  const domain = localDomain();
  const canonical = JSON.stringify(domain.body);
  expect(await parseIdentityAuthorityDomain(canonical, domain.digest, "takos-id")).toEqual(domain);
  const invalid = [
    canonical.slice(0, -1),
    ` ${canonical}`,
    JSON.stringify([...domain.body, "extra"]),
    JSON.stringify([domain.body[0], domain.body[2], domain.body[1], ...domain.body.slice(3)]),
    JSON.stringify(["takoserver.identity-verification-domain.v2", ...domain.body.slice(1)]),
    JSON.stringify({ body: domain.body }),
  ];
  for (const body of invalid)
    await expect(
      parseIdentityAuthorityDomain(body, domain.digest, "takos-id"),
    ).rejects.toMatchObject({ code: "unavailable" });
  for (const badDigest of [null, digest("f"), "sha256:bad"])
    await expect(
      parseIdentityAuthorityDomain(canonical, badDigest, "takos-id"),
    ).rejects.toMatchObject({ code: "unavailable" });
});

test("Auth authority local currentness binds selected client, audience and public key", async () => {
  for (const [provider, original, changed] of [
    ["google", localDomain("google", "client-a"), localDomain("google", "client-b")],
    ["github", localDomain("github", "audience-a"), localDomain("github", "audience-b")],
    [
      "github",
      localDomain("github", "audience-a"),
      domainFrom([
        "takoserver.identity-verification-domain.v1",
        "github",
        "operator-assertion",
        "audience-a",
        "OKP",
        "Ed25519",
        "other-public-x",
      ]),
    ],
  ] as const) {
    const f = fixture();
    const anchor = await syntheticLocal(f, provider, original);
    expect(await predicateResult(f.sql, await localPrincipalCurrentness(anchor, original))).toBe(1);
    expect(await predicateResult(f.sql, await localPrincipalCurrentness(anchor, changed))).toBe(0);
  }
});

test("Auth authority candidate DDL refuses half-NULL local domains and terminal rewrite", async () => {
  const f = fixture();
  const good = localDomain();
  for (const [suffix, body, domainDigest] of [
    ["missing_body", null, good.digest],
    ["missing_digest", JSON.stringify(good.body), null],
    [
      "unknown_version",
      JSON.stringify(["takoserver.identity-verification-domain.v2", ...good.body.slice(1)]),
      good.digest,
    ],
  ] as const) {
    await expect(
      f.sql.batch([
        {
          sql: "INSERT INTO principals VALUES (?,'takos-id',?,'x@example.test','X',?)",
          params: [`prn_${suffix}`, `sub_${suffix}`, "2026-09-01T00:00:00.000Z"],
        },
        {
          sql: `INSERT INTO auth_principal_incarnations
        (principal_id,principal_incarnation,identity_kind,identity_subject,principal_created_at,
         origin_kind,origin_ref,origin_digest,identity_authority_body,identity_authority_digest,enrolled_at)
        VALUES (?,?,'takos-id',?,?,'fresh-local',?,?,?,?,?)`,
          params: [
            `prn_${suffix}`,
            `inc_${suffix}`,
            `sub_${suffix}`,
            "2026-09-01T00:00:00.000Z",
            `synthetic:${suffix}`,
            digest("a"),
            body,
            domainDigest,
            "2026-10-15T00:00:00.000Z",
          ],
        },
      ]),
    ).rejects.toMatchObject({ code: "constraint" });
    expect(await f.sql.query("SELECT id FROM principals WHERE id=?", [`prn_${suffix}`])).toEqual(
      [],
    );
  }
  const anchor = await syntheticLocal(f);
  if (anchor.originKind !== "fresh-local") throw new Error("Not local");
  await expect(
    f.sql.run(
      "UPDATE auth_principal_incarnations SET identity_authority_digest=NULL WHERE principal_id=?",
      [anchor.principalId],
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  await expect(
    f.sql.run(
      "UPDATE auth_principal_incarnations SET identity_authority_body=? WHERE principal_id=?",
      [JSON.stringify(localDomain("takos-id", "other").body), anchor.principalId],
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  await f.sql.run(
    `UPDATE auth_principal_incarnations SET state='retired', terminal_reason='synthetic',
       terminal_at='2026-10-15T01:00:00.000Z', terminal_ref='synthetic:close' WHERE principal_id=?`,
    [anchor.principalId],
  );
  expect(
    await predicateResult(
      f.sql,
      await localPrincipalCurrentness(anchor, anchor.verificationDomain),
    ),
  ).toBe(0);
  await expect(
    f.sql.run(
      "UPDATE auth_principal_incarnations SET identity_authority_digest=? WHERE principal_id=?",
      [digest("f"), anchor.principalId],
    ),
  ).rejects.toMatchObject({ code: "constraint" });
});

test("Auth authority test schema projects only one candidate DDL source", () => {
  expect(syntheticBase).not.toContain("CREATE TABLE auth_principal_incarnations");
  expect(additiveAuthDDL).toContain("CREATE TABLE auth_principal_incarnations");
  expect(additiveAuthDDL).toContain("identity_authority_body IS NOT OLD.identity_authority_body");
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
