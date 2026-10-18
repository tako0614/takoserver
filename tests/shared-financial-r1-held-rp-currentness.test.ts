import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { additiveAuthDDL } from "../src/auth-authority-schema-plan.ts";
import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  type RpAuthorityIdentity,
  sharedRpCredentialCurrentness,
} from "../src/credential-authority-class.ts";
import {
  type AuthAuthorityDigest,
  createSharedPrincipalAuthorityStore,
  type FreshSharedPrincipal,
} from "../src/shared-principal-authority.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

// Synthetic SQLite authority rows only. This tests the real Root predicate,
// not a genuine RP capture, native D1, consent, or NEW admission.
const baseSchema = readFileSync(
  new URL("./fixtures/auth-authority-candidate-schema.sql", import.meta.url),
  "utf8",
);
const digest = (seed: string): AuthAuthorityDigest => `sha256:${seed.repeat(64)}`;
const idleMs = 12 * 60 * 60 * 1000;
const marginMs = 2500;

async function setup(kind: "absolute" | "idle" | "retouched") {
  const db = new Database(":memory:");
  try {
    const sql = createSqliteSql(db);
    db.exec(baseSchema);
    db.exec(additiveAuthDDL);
    const principals = createSharedPrincipalAuthorityStore({ sql });
    const classes = createCredentialAuthorityClassStore({ sql });
    const principal: FreshSharedPrincipal = {
      principalId: "prn_original",
      principalIncarnation: "principal_inc_original",
      createdAt: "2026-10-15T00:00:00.000Z",
      origin: { ref: "synthetic:origin:original", digest: digest("a") },
      binding: {
        ref: "binding_original",
        issuer: "https://issuer.invalid",
        subject: "account_original",
        controllerIncarnation: "controller_1",
        targetRef: "synthetic:server-target",
        evidence: { ref: "synthetic:verified-binding:original:1", digest: digest("b") },
        enrolledAt: "2026-10-15T00:00:00.000Z",
      },
    };
    const binding = await principals.createFresh(principal);
    const observed = Date.now();
    const lastUsedAt = kind === "idle" ? observed - idleMs + marginMs : observed;
    const current = {
      version: 7,
      lastUsedAt,
      absoluteExpiresAt: kind === "absolute" ? observed + marginMs : observed + 3600000,
    };
    const identity: RpAuthorityIdentity = {
      principalBindingRef: binding.ref,
      registrationRef: "synthetic:rp-registration",
      registrationDigest: digest("d"),
      sessionDigest: digest("e"),
      sessionCreatedAt: lastUsedAt - 1000,
      enrolledSessionVersion: current.version,
      issuer: binding.issuer,
      clientId: "synthetic:rp-client",
      subject: binding.subject,
      issuerSessionId: "synthetic:sid",
      authTime: Math.floor(observed / 1000),
      accountId: binding.subject,
      workspaceId: "workspace_original",
      workspaceRef: "synthetic:workspace-ref",
    };
    const origin: CredentialAuthorityOrigin = {
      ref: "authority_one",
      incarnation: "credential_inc_one",
      targetRef: binding.targetRef,
      principalId: binding.principalId,
      principalIncarnation: binding.principalIncarnation,
      issuanceRef: "synthetic:issuance:one",
      issuanceDigest: digest("d"),
      issuedAt: new Date(observed).toISOString(),
    };
    await sql.batch([
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
          observed,
          current.version,
          "active",
        ],
      },
      classes.sharedRpIssuanceStatement(origin, identity, "org_original"),
    ]);
    const record = await classes.readRetained(origin.ref);
    if (!record || record.backend !== "shared-rp-session") throw Error("missing RP class");
    const guard = sharedRpCredentialCurrentness(record, current, "org_original");
    const valid = async () =>
      Number((await sql.query(`SELECT ${guard.sql} AS valid`, guard.params))[0]?.valid);
    const row = async () =>
      await sql.query(
        "SELECT version,absolute_expires_at,last_used_at FROM shared_auth_sessions WHERE digest=?",
        [identity.sessionDigest],
      );
    return { db, sql, current, identity, valid, row };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function waitPast(unixMilliseconds: number) {
  await Bun.sleep(Math.max(0, unixMilliseconds - Date.now() + 250));
}

test("held RP tuple refuses absolute expiry using the real SQLite currentness predicate", async () => {
  const f = await setup("absolute");
  try {
    expect(await f.valid()).toBe(1);
    const unchanged = await f.row();
    await waitPast(f.current.absoluteExpiresAt);
    expect(await f.row()).toEqual(unchanged);
    expect(await f.valid()).toBe(0);
  } finally {
    f.db.close();
  }
});

test("held RP tuple refuses idle expiry using the real SQLite currentness predicate", async () => {
  const f = await setup("idle");
  try {
    expect(await f.valid()).toBe(1);
    const unchanged = await f.row();
    await waitPast(f.current.lastUsedAt + idleMs);
    expect(await f.row()).toEqual(unchanged);
    expect(await f.valid()).toBe(0);
  } finally {
    f.db.close();
  }
});

test("held RP tuple refuses a later session version using the real SQLite currentness predicate", async () => {
  const f = await setup("retouched");
  try {
    expect(await f.valid()).toBe(1);
    const changed = await f.sql.run(
      "UPDATE shared_auth_sessions SET version=version+1 WHERE digest=?",
      [f.identity.sessionDigest],
    );
    expect(changed.changes).toBe(1);
    expect(await f.valid()).toBe(0);
  } finally {
    f.db.close();
  }
});
