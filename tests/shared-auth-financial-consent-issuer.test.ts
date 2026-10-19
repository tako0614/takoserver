import { describe, expect, it } from "bun:test";
import {
  createSharedAuthFinancialConsentIssuerSource,
  SharedAuthFinancialConsentIssuerUnavailable,
} from "../src/shared-auth-financial-consent-issuer.ts";
import {
  inspectSharedAuthFinancialConsentLeafSchema,
  SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS,
} from "../src/shared-auth-financial-consent-schema-plan.ts";
import { graphFixture, snapshot } from "./consent-request-graph-fixture.ts";

const request = () =>
  new Request("https://rp.example.invalid/auth/financial-confirmation", {
    method: "POST",
    body: "approve=yes",
  });

describe("RP consent issuer candidate leaf", () => {
  it("requires the exact expanded leaf catalog and rejects an unknown namespaced object", async () => {
    const f = await graphFixture();
    expect(await inspectSharedAuthFinancialConsentLeafSchema(f.sql)).toBe("leaf-present");
    f.db.exec("CREATE TABLE shared_auth_financial_consent_unexpected (id TEXT PRIMARY KEY)");
    await expect(inspectSharedAuthFinancialConsentLeafSchema(f.sql)).rejects.toMatchObject({
      code: "schema_conflict",
    });
  });

  it("keeps issuer rows immutable and refuses duplicate original registration", async () => {
    const f = await graphFixture();
    const insert = `INSERT INTO ${SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS} (registration_ref,incarnation,registration_digest,original_json) VALUES (?,?,?,?)`;
    const values = ["synthetic-test-issuer", "1", `sha256:${"a".repeat(64)}`, '{"test":true}'];
    f.db.query(insert).run(...values);
    expect(() => f.db.query(insert).run(...values)).toThrow();
    expect(() =>
      f.db.query(`UPDATE ${SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS} SET original_json=?`).run("{}"),
    ).toThrow();
    expect(() =>
      f.db.query(`DELETE FROM ${SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS}`).run(),
    ).toThrow();
  });

  it("rejects caller-shaped issuer and observation without SQL effect or body read", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    const effects = f.effects();
    const body = request();
    const source = createSharedAuthFinancialConsentIssuerSource(f.connection);
    const forged = Object.freeze({ registrationRef: "synthetic-test-issuer", incarnation: "1" });
    await expect(
      source.registerOriginal(body, f.input.pending.workspace_id, forged),
    ).rejects.toBeInstanceOf(SharedAuthFinancialConsentIssuerUnavailable);
    await expect(
      source.readCurrentOriginal(body, f.input.pending.workspace_id, forged),
    ).rejects.toBeInstanceOf(SharedAuthFinancialConsentIssuerUnavailable);
    await expect(
      source.currentness(body, f.input.pending.workspace_id, forged),
    ).rejects.toBeInstanceOf(SharedAuthFinancialConsentIssuerUnavailable);
    expect(body.bodyUsed).toBe(false);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
    expect(f.effects()).toEqual(effects);
  });
});
