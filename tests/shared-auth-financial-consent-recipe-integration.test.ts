import { describe, expect, test } from "bun:test";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import type { Row, Sql } from "../src/ports.ts";
import {
  createSharedAuthFinancialActionConsentOriginalIdentity,
  parseSharedAuthFinancialActionConsentOriginal,
} from "../src/shared-auth-financial-consent-contract.ts";
import {
  captureSharedAuthFinancialConsentRequestCommandData,
  createSharedAuthFinancialConsentOriginalReader,
  createSharedAuthFinancialConsentRequestCommandRecovery,
  type SharedAuthFinancialConsentCaptureData,
  type SharedAuthFinancialConsentOriginalCommand,
} from "../src/shared-auth-financial-consent-store.ts";
import {
  bytes,
  captureInput,
  custodyHash,
  graphFixture,
  insert,
  rows,
  snapshot,
} from "./consent-request-graph-fixture.ts";

type Fixture = Awaited<ReturnType<typeof graphFixture>>;
async function original(f: Fixture) {
  return parseSharedAuthFinancialActionConsentOriginal(f.input.command.originalBytes);
}
async function replaceOriginal(
  f: Fixture,
  overrides: Record<string, unknown>,
): Promise<SharedAuthFinancialConsentCaptureData> {
  const { consentDigest: _digest, ...core } = await original(f);
  const identity = await createSharedAuthFinancialActionConsentOriginalIdentity({
    ...core,
    ...overrides,
  });
  const originalBytes = bytes(identity.canonicalOriginalJson);
  return {
    pending: f.input.pending,
    command: {
      ...f.input.command,
      originalBytes,
      originalDigest: identity.consentDigest,
      originalCustodySHA256: await custodyHash(originalBytes),
    },
  };
}
async function prewriteRefusal(f: Fixture, input: SharedAuthFinancialConsentCaptureData) {
  const before = snapshot(f.db);
  await expect(
    captureSharedAuthFinancialConsentRequestCommandData(f.connection, input),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.native.batchCalls).toBe(0);
  expect(f.native.calls).toEqual([]);
  expect(snapshot(f.db)).toEqual(before);
  expect(rows(f.db, "money_cutover_writer_permit")).toEqual([]);
}

// All cases SOURCE/UNRUN. Fixture constructors prove only local graph origin.
// Retained rows, registration/proof/Clock fields are synthetic DATA, not genuine
// producer/current permission. Raw historical INSERT setup below is before any
// effect/unknown, never SQL recovery or a bypass used by the product method.
describe("accepted v4 original recipe at actual capture and historical read", () => {
  test("independent RP issuer R versus Financial challenge A and opaque consent ref pass the actual write gate", async () => {
    const f = await graphFixture();
    const value = await original(f);
    expect(value.consentIssuer.registrationRef).toBe("rp_consent_registration");
    expect(value.challenge.registrationRef).toBe("financial_challenge_registration");
    expect(value.consentIssuer.registrationRef).not.toBe(value.challenge.registrationRef);
    expect(value.consentRef).toBe("opaque consent Ω 01");
    expect(value.principalBinding.incarnation).not.toBe(f.input.pending.principal_incarnation);
    const result = await captureSharedAuthFinancialConsentRequestCommandData(
      f.connection,
      captureInput(f.input),
    );
    expect(result.command.key.consentRef).toBe(value.consentRef);
    expect(f.native.batchCalls).toBe(1);
    expect(f.native.calls).toHaveLength(3);
    expect(rows(f.db, "shared_auth_financial_consent_commands")).toHaveLength(1);
    expect(rows(f.db, "shared_auth_financial_consent_originals")).toEqual([]);
  });

  test("consent core-domain digest full canonical custody and action fingerprint stay distinct without ref reconstruction", async () => {
    const f = await graphFixture();
    const value = await original(f);
    const consentDigest: string = value.consentDigest;
    expect(consentDigest).toBe(f.input.command.originalDigest);
    const custodyDigest: string = await bytesDigest(f.input.command.originalBytes);
    expect(custodyDigest).toBe(f.input.command.originalCustodySHA256);
    expect(value.consentDigest).not.toBe(f.input.command.originalCustodySHA256);
    expect(value.actionRequestFingerprint).not.toBe(value.consentDigest);
    expect(new TextDecoder().decode(f.input.command.originalBytes)).toBe(canonicalJson(value));
    expect(value.selectedTerms.ref).not.toBe(f.input.pending.disclosure_ref);
    expect(await bytesDigest(f.input.pending.terms_original_bytes)).toBe(
      value.selectedTerms.digest,
    );
  });

  test("valid codec originals with altered storage key issuer selectedscope or original digest refuse before SQL", async () => {
    for (const field of ["consentRef", "issuer", "scope", "digest"] as const) {
      const f = await graphFixture();
      const input = captureInput(f.input);
      const command: SharedAuthFinancialConsentOriginalCommand = {
        ...input.command,
        ...(field === "consentRef"
          ? { key: { ...input.command.key, consentRef: "other opaque ref" } }
          : {}),
        ...(field === "issuer"
          ? { key: { ...input.command.key, registrationRef: "borrowed RP issuer" } }
          : {}),
        ...(field === "scope"
          ? { selectedScope: { ...input.command.selectedScope, workspaceId: "other_scope" } }
          : {}),
        ...(field === "digest" ? { originalDigest: `sha256:${"0".repeat(64)}` } : {}),
      };
      await prewriteRefusal(f, { ...input, command });
    }
  });

  test("canonically valid changed action challenge or mapped Root metadata cannot borrow the original pending", async () => {
    for (const field of ["action", "challenge", "principal", "binding", "credential"] as const) {
      const f = await graphFixture();
      const value = await original(f);
      if (field === "action") {
        // Change only the pending original body while keeping old kind/ref and
        // a truthful raw custody digest: hash equality alone is insufficient.
        const actionBytes = bytes(canonicalJson({ ...value.action, amountMinor: 2000 }));
        await prewriteRefusal(f, {
          ...captureInput(f.input),
          pending: {
            ...f.input.pending,
            action_original_bytes: actionBytes,
            action_custody_sha256: await custodyHash(actionBytes),
          },
        });
      } else if (field === "challenge") {
        const challengeBytes = bytes(
          canonicalJson({
            ...value.challenge,
            registrationRef: "different_financial_registration",
          }),
        );
        await prewriteRefusal(f, {
          ...captureInput(f.input),
          pending: {
            ...f.input.pending,
            challenge_original_bytes: challengeBytes,
            challenge_custody_sha256: await custodyHash(challengeBytes),
          },
        });
      } else {
        const input = await replaceOriginal(
          f,
          field === "principal"
            ? { rpSession: { ...value.rpSession, observedPrincipalId: "borrowed_principal" } }
            : field === "binding"
              ? { principalBinding: { ...value.principalBinding, ref: "borrowed_binding" } }
              : {
                  credentialClass: { ...value.credentialClass, incarnation: "borrowed_credential" },
                },
        );
        await prewriteRefusal(f, input);
      }
    }
  });

  test("terms raw digest content and original selected digest must agree without disclosure aliases", async () => {
    const f = await graphFixture();
    const changed = bytes("Other unselected R1 terms");
    await prewriteRefusal(f, {
      ...captureInput(f.input),
      pending: {
        ...f.input.pending,
        terms_original_bytes: changed,
        terms_custody_sha256: await custodyHash(changed),
      },
    });
    const g = await graphFixture();
    const value = await original(g);
    await prewriteRefusal(
      g,
      await replaceOriginal(g, {
        selectedTerms: { ...value.selectedTerms, digest: `sha256:${"0".repeat(64)}` },
      }),
    );
  });

  test("old9c array envelope and noncanonical full JSON never enter the actual write path", async () => {
    for (const legacy of [true, false]) {
      const f = await graphFixture();
      const value = await original(f);
      const originalBytes = bytes(
        legacy
          ? canonicalJson(["takoserver-rp-explicit-financial-action-consent-original@v1", value])
          : JSON.stringify(value, null, 2),
      );
      await prewriteRefusal(f, {
        ...captureInput(f.input),
        command: {
          ...f.input.command,
          originalBytes,
          originalCustodySHA256: await custodyHash(originalBytes),
          ...(legacy ? { originalDigest: await bytesDigest(originalBytes) } : {}),
        },
      });
    }
  });

  test("valid wide codec opaque refs NUL and fullbytes are refused by the unchanged leaf storage subset", async () => {
    for (const consentRef of ["r".repeat(513), "opaque\0ref"]) {
      const f = await graphFixture();
      const input = await replaceOriginal(f, { consentRef });
      await prewriteRefusal(f, {
        ...input,
        command: { ...input.command, key: { ...input.command.key, consentRef } },
      });
    }
    const f = await graphFixture();
    const value = await original(f);
    const wide = "x".repeat(4000);
    const input = await replaceOriginal(f, {
      financialRealmRef: wide,
      consentIssuer: { ...value.consentIssuer, registrationDigest: wide },
      principalBinding: { ...value.principalBinding, digest: wide },
      credentialClass: { ...value.credentialClass, digest: wide },
    });
    expect(input.command.originalBytes.byteLength > 16384).toBe(true);
    expect(input.command.originalBytes.byteLength <= 65536).toBe(true);
    await prewriteRefusal(f, input);
  });

  test("unchanged raw terms must fit both leaf16KiB and displayed8192UTF16 units without truncation", async () => {
    for (const text of ["a".repeat(8193), "界".repeat(6000)]) {
      const f = await graphFixture();
      const value = await original(f);
      const terms = bytes(text);
      const digest = await custodyHash(terms);
      const changed = await replaceOriginal(f, {
        selectedTerms: { ...value.selectedTerms, digest },
      });
      await prewriteRefusal(f, {
        ...changed,
        pending: {
          ...changed.pending,
          terms_original_bytes: terms,
          terms_digest_original: digest,
          terms_custody_sha256: digest,
        },
      });
      expect(new TextDecoder().decode(terms)).toBe(text);
    }
  });

  test("valid positive three-row absence differs from invalid supplied original before any lookup", async () => {
    const f = await graphFixture({ seedPending: false });
    let queries = 0;
    const sql: Pick<Sql, "query"> = {
      async query(statement, params) {
        queries++;
        return Reflect.apply(f.sql.query, f.sql, [statement, params]);
      },
    };
    const reader = createSharedAuthFinancialConsentOriginalReader(sql);
    const bad = bytes('{"old":"invalid original"}');
    await expect(
      reader.readOriginal({
        ...f.input.command,
        originalBytes: bad,
        originalCustodySHA256: await custodyHash(bad),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(queries).toBe(0);
    expect(await reader.readOriginal(f.input.command)).toBeUndefined();
    expect(queries > 0).toBe(true);
    expect(f.native.batchCalls).toBe(0);
  });

  test("historical expired retired original is decoded with original timestamps without current authority", async () => {
    const f = await graphFixture({ at: Date.now() - 600_000 });
    const command = f.input.command;
    const p = f.input.pending;
    // Synthetic immutable historical seed, before this reader exists or any
    // unknown/effect. No actual capture/currentness qualification is claimed.
    insert(f.db, "shared_auth_financial_consent_commands", {
      command_ref: command.key.commandRef,
      transaction_ref: command.key.transactionRef,
      registration_ref: command.key.registrationRef,
      incarnation: command.key.incarnation,
      organization_id: command.selectedScope.organizationId,
      workspace_id: command.selectedScope.workspaceId,
      workspace_ref: command.selectedScope.workspaceRef,
      family: command.family,
      consent_ref: command.key.consentRef,
      receipt_ref: command.key.receiptRef,
      command_bytes: command.commandBytes,
      command_custody_sha256: command.commandCustodySHA256,
      original_bytes: command.originalBytes,
      original_digest: command.originalDigest,
      original_custody_sha256: command.originalCustodySHA256,
      captured_at: command.capturedAt,
    });
    insert(f.db, "shared_auth_financial_consent_originals", {
      consent_ref: command.key.consentRef,
      command_ref: command.key.commandRef,
      transaction_ref: command.key.transactionRef,
      receipt_ref: command.key.receiptRef,
      registration_ref: p.registration_ref,
      incarnation: p.incarnation,
      organization_id: p.organization_id,
      workspace_id: p.workspace_id,
      workspace_ref: p.workspace_ref,
      original_bytes: command.originalBytes,
      original_digest: command.originalDigest,
      original_custody_sha256: command.originalCustodySHA256,
      recorded_at: f.input.recordedAt,
      receipt_recorded_at: f.input.recordedAt,
    });
    f.db.exec(
      "UPDATE credential_authority_classes SET state='retired'; UPDATE shared_auth_sessions SET status='revoked'",
    );
    expect((await original(f)).expiresAt < Date.now()).toBe(true);
    const before = snapshot(f.db);
    const result = await createSharedAuthFinancialConsentRequestCommandRecovery(
      f.connection,
      command,
    ).readOriginalData();
    expect(result.command).toEqual(command);
    expect(result.receiptRef).toBe(command.key.receiptRef);
    expect(result.recordedAt).toBe(f.input.recordedAt);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("truthfully hashed but different pending action in stored readback is unavailable rather than absence", async () => {
    const f = await graphFixture({}, true);
    const value = await original(f);
    const changed = bytes(canonicalJson({ ...value.action, amountMinor: 2000 }));
    const hash = await custodyHash(changed);
    f.native.rowFault = (sql, returned): readonly Row[] =>
      sql.includes("FROM shared_auth_financial_consent_pending WHERE")
        ? returned.map((row) => ({
            ...row,
            action_original_bytes: changed,
            action_custody_sha256: hash,
          }))
        : returned;
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
      f.connection,
      f.input.command,
    );
    await expect(recovery.readOriginalData()).rejects.toMatchObject({ code: "unavailable" });
    expect(f.native.batchCalls).toBe(0);
    expect(rows(f.db, "shared_auth_financial_consent_originals")).toHaveLength(1);
  });

  test("lost ACK after valid canonical capture stays original GET-only and command-only never retries", async () => {
    const f = await graphFixture();
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
      f.connection,
      f.input.command,
    );
    f.native.afterBatch = () => {
      throw new Error("actual commit ACK lost");
    };
    await expect(
      captureSharedAuthFinancialConsentRequestCommandData(f.connection, captureInput(f.input)),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(rows(f.db, "shared_auth_financial_consent_commands")).toHaveLength(1);
    expect(rows(f.db, "shared_auth_financial_consent_originals")).toEqual([]);
    const before = snapshot(f.db);
    const count = f.native.batchCalls;
    await expect(recovery.readOriginalData()).rejects.toMatchObject({ code: "unavailable" });
    await expect(recovery.readOriginalData()).rejects.toMatchObject({ code: "unavailable" });
    expect(Object.keys(recovery)).toEqual(["readOriginalData"]);
    expect(f.native.batchCalls).toBe(count);
    expect(snapshot(f.db)).toEqual(before);
  });
});
