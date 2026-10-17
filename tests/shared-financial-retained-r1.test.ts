import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  assertHostedBillingFinancialRealm,
  verifyHostedBillingFinancialRealm,
} from "../src/hosted-billing-realm.ts";
import { base64UrlEncode, bytesDigest, canonicalDigest, canonicalJson } from "../src/json.ts";
import {
  assertMoneyCutoverSqlOrigin,
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import {
  createSharedFinancialActionIdentity,
  type SharedFinancialAction,
} from "../src/shared-financial-action.ts";
import {
  buildFinancialR1MechanicalBatch,
  createFinancialRetainedR1Store,
  type FinancialR1WriteCommand,
  type SelectedEconomicR1,
} from "../src/shared-financial-retained-r1.ts";
import {
  createFinancialPreproofChallengeStore,
  FINANCIAL_SOURCE_ENROLLMENT_DDL,
  type FinancialEnrollmentComponentOptions,
  type FinancialPreproofScope,
} from "../src/shared-financial-source-enrollment.ts";
import { FINANCIAL_SOURCE_GENESIS_DDL } from "../src/shared-financial-source-genesis-admission.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";

const AT = "2026-10-15T00:00:00.000Z";
const EPOCH = `sha256:${"c".repeat(64)}` as const;
const SCOPE: FinancialPreproofScope = {
  registrationRef: "identity-registration:test",
  clientId: "client:test",
  workspaceId: "workspace:test",
  organizationId: "org:test",
  workspaceRef: "workspace-ref:test",
};
const ACTIONS: readonly SharedFinancialAction[] = [
  {
    kind: "topup",
    organizationId: SCOPE.organizationId,
    reference: "topup:test",
    amountMinor: 500,
  },
  {
    kind: "subscription-start",
    organizationId: SCOPE.organizationId,
    reference: "start:test",
    planKey: "starter",
  },
  {
    kind: "card-setup",
    organizationId: SCOPE.organizationId,
    reference: "card:test",
    setupDisclosureRevision: "disclosure:test",
  },
  {
    kind: "plan-change",
    organizationId: SCOPE.organizationId,
    reference: "change:test",
    planKey: "pro",
    expectedSubscriptionRef: `sra_${"a".repeat(64)}`,
  },
  {
    kind: "cancel",
    organizationId: SCOPE.organizationId,
    reference: "cancel:test",
    cancelAtPeriodEnd: true,
    expectedSubscriptionRef: `sra_${"a".repeat(64)}`,
  },
];
function economic(action: SharedFinancialAction): SelectedEconomicR1 {
  switch (action.kind) {
    case "topup":
      return {
        kind: "topup",
        amountMinor: action.amountMinor,
        currency: "USD",
        pricingRevision: "pricing:test",
        purchaseCreditExpiry: { kind: "none" },
        minimumMinor: 50,
        maximumMinor: 10000,
      };
    case "subscription-start":
      return {
        kind: "subscription-start",
        planKey: action.planKey,
        pricingRevision: "pricing:test",
        priceId: "price_enrollment",
        priceAmountMinor: 1000,
        includedMinor: 100,
        currency: "USD",
        periodMonths: 1,
      };
    case "card-setup":
      return {
        kind: "card-setup",
        setupDisclosureRevision: action.setupDisclosureRevision,
        onDemandTermsRevision: "on-demand:test",
      };
    case "plan-change":
      return {
        kind: "plan-change",
        expectedSubscriptionRef: action.expectedSubscriptionRef,
        targetSubscriptionId: "sub:test",
        targetGeneration: 1,
        targetPeriodStart: AT,
        targetPeriodEnd: "2026-11-15T00:00:00.000Z",
        planKey: action.planKey,
        pricingRevision: "pricing:test",
        priceId: "price_enrollment",
        priceAmountMinor: 1000,
        includedMinor: 100,
        currency: "USD",
      };
    case "cancel":
      return {
        kind: "cancel",
        expectedSubscriptionRef: action.expectedSubscriptionRef,
        targetSubscriptionId: "sub:test",
        targetGeneration: 1,
        branch: "legacy",
        pendingReference: null,
        scheduleId: null,
        cancelAtPeriodEnd: true,
      };
  }
}
async function fixture() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  db.exec(
    readFileSync(
      new URL("./fixtures/shared-financial-source-component-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
  db.exec(MONEY_CUTOVER_FREEZE_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
  db.exec(FINANCIAL_SOURCE_ENROLLMENT_DDL);
  db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
  db.exec(
    readFileSync(
      new URL("./fixtures/shared-financial-retained-r1-component-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  const base = createSqliteSql(db);
  let writes = 0,
    providerRequests = 0,
    clocks = 0,
    unknownQuery = false;
  const raw: Sql = {
    query: (query, params) => {
      if (unknownQuery) {
        unknownQuery = false;
        throw new SqlError("unavailable", "unknown GET");
      }
      return base.query(query, params);
    },
    run: (query, params) => {
      writes++;
      return base.run(query, params);
    },
    batch: (statements) => {
      writes++;
      return base.batch(statements);
    },
  };
  const sql = createMoneyCutoverSql(raw, EPOCH);
  assertMoneyCutoverSqlOrigin(sql, { writerEpoch: EPOCH });
  await base.run("INSERT INTO stripe_mode_realm VALUES(1,'test',?)", [AT]);
  await base.run(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_enrollment','test','enrollment',?)",
    [AT],
  );
  await base.run("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)", [EPOCH]);
  const client = createStripeBillingClient({
    secretKey: "sk_test_component_fixture",
    async fetch(request) {
      providerRequests++;
      const url = new URL(request.url);
      if (request.method !== "GET") throw Error("provider command forbidden");
      if (url.pathname === "/v1/account")
        return Response.json({ object: "account", id: "acct_enrollment" });
      if (url.pathname === "/v1/prices/price_enrollment")
        return Response.json({
          object: "price",
          id: "price_enrollment",
          livemode: false,
          currency: "usd",
          type: "recurring",
          billing_scheme: "per_unit",
          unit_amount: 1000,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      throw Error("unexpected provider read");
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: "acct_enrollment", mode: "test", billingAuthority: "enrollment" },
    prices: [{ priceId: "price_enrollment", monthlyAmountMinor: 1000 }],
  });
  const options: FinancialEnrollmentComponentOptions & { scope: FinancialPreproofScope } = {
    sql,
    client,
    realm,
    writerEpoch: EPOCH,
    receiverRef: "receiver:test",
    targetRef: "target:test",
    scope: SCOPE,
    clock: () => {
      clocks++;
      return new Date(AT);
    },
  };
  const store = createFinancialRetainedR1Store(options);
  // Frozen C0 v3 embeds reserved-table SQL that Root S rejects. Keep that older
  // C0 prepare as an explicitly mechanical generic-R fixture on this same primary;
  // R1 registration/original/receipt writes below use the actual S wrapper only.
  const c0FixtureRealm = await verifyHostedBillingFinancialRealm({
    sql: raw,
    reader: { client },
    expected: { accountId: "acct_enrollment", mode: "test", billingAuthority: "enrollment" },
    prices: [{ priceId: "price_enrollment", monthlyAmountMinor: 1000 }],
  });
  const c0 = createFinancialPreproofChallengeStore({ ...options, sql: raw, realm: c0FixtureRealm });
  const sourceBody = {
    version: "financial-action-registration-canonical-v1",
    registrationRef: "action-registration:test",
    incarnation: "incarnation:test",
    sourceRef: "action-source:test",
    originRef: "origin:test",
    financialRealm: realm.financialRealm,
    organizationId: SCOPE.organizationId,
    workspaceId: SCOPE.workspaceId,
    workspaceRef: SCOPE.workspaceRef,
  };
  const registrationDigest = await canonicalDigest([
    "financial-action-registration-canonical-v1",
    sourceBody,
  ]);
  const registerFixtureData = async () => {
    await sql.run(
      `INSERT INTO financial_action_source_registrations
      (registration_ref,incarnation,registration_digest,digest_recipe,registration_json,created_at)
      VALUES(?,?,?,?,?,?)`,
      [
        sourceBody.registrationRef,
        sourceBody.incarnation,
        registrationDigest,
        "financial-action-registration-canonical-v1",
        canonicalJson(sourceBody),
        AT,
      ],
    );
  };
  async function command(
    action: SharedFinancialAction,
    suffix: string = action.kind,
    termsText = `Terms for ${action.kind}: exact historical display.`,
  ): Promise<FinancialR1WriteCommand> {
    const identity = await createSharedFinancialActionIdentity(action);
    const bytes = new TextEncoder().encode(termsText);
    const termsDigest = await bytesDigest(bytes);
    const selectedAt = Date.parse(AT) - 1;
    const sourceImage = {
      version: "financial-selected-action-source-canonical-v1",
      ref: sourceBody.sourceRef,
      registrationRef: sourceBody.registrationRef,
      registrationDigest,
      incarnation: sourceBody.incarnation,
      originRef: sourceBody.originRef,
      financialRealm: realm.financialRealm,
      organizationId: SCOPE.organizationId,
      workspaceId: SCOPE.workspaceId,
      workspaceRef: SCOPE.workspaceRef,
      selectedAt,
    };
    const sourceDigest = await canonicalDigest([
      "financial-selected-action-source-canonical-v1",
      sourceImage,
    ]);
    const c0Input = {
      preparationRef: `preparation:${suffix}`,
      receiptRef: `c0-receipt:${suffix}`,
      challenge: {
        v: 1 as const,
        challengeRef: `challenge:${suffix}`,
        ...SCOPE,
        requestFingerprint: identity.requestFingerprint,
        createdAt: Date.parse(AT),
        expiresAt: Date.parse(AT) + 300_000,
      },
      selection: {
        action: {
          kind: action.kind,
          ref: action.reference,
          body: action,
          requestFingerprint: identity.requestFingerprint,
        },
        customer: {
          requestRef: `customer:${suffix}`,
          idempotencyKey: `customer-key:${suffix}`,
          requestFingerprint: identity.requestFingerprint,
          financialRealm: realm.financialRealm,
        },
        business: { ref: `business:${suffix}`, requestFingerprint: identity.requestFingerprint },
        terms: { ref: `terms:${suffix}`, digest: termsDigest },
        carrier: {
          issuerRef: "issuer:test",
          requestRef: `request:${suffix}`,
          carrierRef: "carrier:test",
          contextRef: "context:test",
          createdAt: AT,
        },
        billingBinding: {
          bindingRef: "binding:test",
          organizationId: SCOPE.organizationId,
          workspaceId: SCOPE.workspaceId,
          workspaceRef: SCOPE.workspaceRef,
        },
      },
    };
    const scopeRealm = {
      ...SCOPE,
      accountId: realm.accountId,
      mode: realm.mode,
      billingAuthority: realm.billingAuthority,
      financialRealm: realm.financialRealm,
      writerEpoch: EPOCH,
      receiverRef: options.receiverRef,
      targetRef: options.targetRef,
    };
    const r1Ref = `r1:${suffix}`,
      r1ReceiptRef = `r1-receipt:${suffix}`;
    return {
      key: {
        challengeRef: c0Input.challenge.challengeRef,
        preparationRef: c0Input.preparationRef,
        r1Ref,
      },
      r1ReceiptRef,
      original: {
        version: "takoserver-financial-retained-r1-v1",
        r1Ref,
        challengeRef: c0Input.challenge.challengeRef,
        preparationRef: c0Input.preparationRef,
        c0ReceiptRef: c0Input.receiptRef,
        c0: c0Input,
        scopeRealm,
        economic: economic(action),
        selectedTerms: {
          ref: c0Input.selection.terms.ref,
          digest: termsDigest,
          mediaType: "text/plain; charset=utf-8",
          locale: "en-US",
          bodyUtf8Base64url: base64UrlEncode(bytes),
          bodyByteLength: bytes.length,
          digestRecipe: "financial-terms-utf8-sha256-v1",
        },
        actionSource: {
          ref: sourceBody.sourceRef,
          digest: sourceDigest,
          registrationRef: sourceBody.registrationRef,
          registrationDigest,
          incarnation: sourceBody.incarnation,
          originRef: sourceBody.originRef,
          financialRealm: realm.financialRealm,
          organizationId: SCOPE.organizationId,
          workspaceId: SCOPE.workspaceId,
          workspaceRef: SCOPE.workspaceRef,
          selectedAt,
        },
      },
    };
  }
  return {
    db,
    base,
    raw,
    sql,
    options,
    store,
    c0,
    c0FixtureRealm,
    client,
    command,
    registerFixtureData,
    unknownQuery: () => {
      unknownQuery = true;
    },
    get writes() {
      return writes;
    },
    get providerRequests() {
      return providerRequests;
    },
    get clocks() {
      return clocks;
    },
    close: () => db.close(),
  };
}
function count(db: Database, table: string): number {
  return (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
async function withoutGuard(db: Database, name: string, mutation: () => unknown): Promise<void> {
  const row = db
    .query("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
    .get(name) as { sql: string } | null;
  if (!row) throw Error(`missing guard ${name}`);
  db.exec(`DROP TRIGGER ${name}`);
  try {
    await mutation();
  } finally {
    db.exec(row.sql);
  }
}

// Direct registration-row inserts below are fixtures only. They do not qualify a Financial source producer.
describe("private Financial R1 mechanical custody", () => {
  test("literal independent UTF-8 and domain-separated R1 digest vectors", async () => {
    // Expected bytes/digests were calculated with Python hashlib + sorted compact UTF-8 JSON,
    // not with this module's command fixture or its canonicalDigest implementation.
    const terms = new TextEncoder().encode("決済条件📄");
    expect(terms.length).toBe(16);
    expect(await bytesDigest(terms)).toBe(
      "sha256:3cdc7714f2981d77e22ae3e8af26819b8e5c20977a2446ab5195ffe665d4d0f0",
    );
    expect(await bytesDigest(new TextEncoder().encode("x".repeat(32_768)))).toBe(
      "sha256:427965f49a857174e308658227325dbd23ff4eccbe399d5ad4817dda3ec79f87",
    );
    const registration = {
      version: "financial-action-registration-canonical-v1",
      registrationRef: "action-registration:vector",
      incarnation: "incarnation:vector",
      sourceRef: "action-source:vector",
      originRef: "origin:vector",
      financialRealm: "financial-realm:vector",
      organizationId: "org:vector",
      workspaceId: "workspace:vector",
      workspaceRef: "workspace-ref:vector",
    };
    const registrationPreimage = ["financial-action-registration-canonical-v1", registration];
    expect(canonicalJson(registrationPreimage)).toBe(
      '["financial-action-registration-canonical-v1",{"financialRealm":"financial-realm:vector","incarnation":"incarnation:vector","organizationId":"org:vector","originRef":"origin:vector","registrationRef":"action-registration:vector","sourceRef":"action-source:vector","version":"financial-action-registration-canonical-v1","workspaceId":"workspace:vector","workspaceRef":"workspace-ref:vector"}]',
    );
    const registrationDigest =
      "sha256:f74dccc090c3b1429150887cbd4d4a672e7b6ca0dc654e6e167e638b40d9690d";
    expect(await canonicalDigest(registrationPreimage)).toBe(registrationDigest);
    const source = {
      version: "financial-selected-action-source-canonical-v1",
      ref: registration.sourceRef,
      registrationRef: registration.registrationRef,
      registrationDigest,
      incarnation: registration.incarnation,
      originRef: registration.originRef,
      financialRealm: registration.financialRealm,
      organizationId: registration.organizationId,
      workspaceId: registration.workspaceId,
      workspaceRef: registration.workspaceRef,
      selectedAt: 1,
    };
    const sourcePreimage = ["financial-selected-action-source-canonical-v1", source];
    expect(canonicalJson(sourcePreimage)).toBe(
      '["financial-selected-action-source-canonical-v1",{"financialRealm":"financial-realm:vector","incarnation":"incarnation:vector","organizationId":"org:vector","originRef":"origin:vector","ref":"action-source:vector","registrationDigest":"sha256:f74dccc090c3b1429150887cbd4d4a672e7b6ca0dc654e6e167e638b40d9690d","registrationRef":"action-registration:vector","selectedAt":1,"version":"financial-selected-action-source-canonical-v1","workspaceId":"workspace:vector","workspaceRef":"workspace-ref:vector"}]',
    );
    expect(await canonicalDigest(sourcePreimage)).toBe(
      "sha256:008f28aeb022081294311f84d1fe53c116daf149167dde775477856e3622aa60",
    );
    expect(await canonicalDigest([source.version, source])).not.toBe(registrationDigest);
    const f = await fixture();
    try {
      expect(f.options.realm.financialRealm).toBe(
        "realm:ec396e3bcd7da0ae606d1f006009dd5e0b270993dc58036f69936c103e833eaa",
      );
      const command = await f.command(ACTIONS[0]!);
      expect(command.original.selectedTerms.digest).toBe(
        "sha256:38272eca34a61ca5987d8d107ee71d0e73286ed25ed4058f321aeb0d7f50f5cd",
      );
      expect(command.original.actionSource.registrationDigest).toBe(
        "sha256:9f5bfad418e40558ce9ffeb3eb94bb9eff726f98e7138ee99638e7edfbf56643",
      );
      expect(command.original.actionSource.digest).toBe(
        "sha256:6f686060ca9927f3a3bba22f3d7ba7094ce4cbf6f541c1314ea8841930515422",
      );
    } finally {
      f.close();
    }
  });

  test("all five closed actions retain exact R1/mandatory receipt before C0; joined C0 is historical data only", async () => {
    for (const action of ACTIONS) {
      const f = await fixture();
      try {
        await f.registerFixtureData();
        const command = await f.command(action);
        expect(await f.store.readRetainedR1Original(command)).toEqual({ status: "not-found" });
        const statements = await buildFinancialR1MechanicalBatch(f.options, command);
        expect(statements).toHaveLength(2);
        await f.sql.batch(statements); // Explicit isolated mechanical fixture, not qualified prepare.
        const prior = await f.store.readRetainedR1Original(command);
        expect(prior.status).toBe("found");
        if (prior.status !== "found") throw Error("missing R1 fixture");
        expect(prior.original).toEqual(command.original);
        expect(Object.isFrozen(prior.original.selectedTerms)).toBe(true);
        expect(prior.receipt.r1ReceiptRef).toBe(command.r1ReceiptRef);
        expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
        expect(count(f.db, "financial_retained_r1_receipts")).toBe(1);
        await expect(
          f.store.readJoinedRetainedR1Data(command.key.challengeRef),
        ).rejects.toMatchObject({ code: "unavailable" });
        await f.c0.prepare(command.original.c0);
        const readsAt = f.writes,
          clocksAt = f.clocks,
          providerAt = f.providerRequests;
        const joined = await f.store.readJoinedRetainedR1Data(command.key.challengeRef);
        await expect(
          f.store.readRetainedActionConsentR1(command.key.challengeRef),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect(joined.status).toBe("found");
        if (joined.status !== "found") throw Error("joined fixture missing");
        expect(joined.original.selectedTerms).toEqual(command.original.selectedTerms);
        expect(joined.original.actionSource.registrationDigest).toBe(
          command.original.actionSource.registrationDigest,
        );
        expect(joined.actionIdentity.action.kind).toBe(action.kind);
        expect(f.writes).toBe(readsAt);
        expect(f.clocks).toBe(clocksAt);
        expect(f.providerRequests).toBe(providerAt);
      } finally {
        f.close();
      }
    }
  });

  test("qualified prepare is unavailable and positive R1 absence is GET-only, not a retry capability", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!);
      expect(await f.store.readRetainedR1Original(command)).toEqual({ status: "not-found" });
      await expect(f.store.prepare(command)).rejects.toMatchObject({ code: "unavailable" });
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
      expect(f.writes).toBe(0);
      f.unknownQuery();
      await expect(f.store.readRetainedR1Original(command)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("R1 constructor and builder reject raw R and a real S with a different captured writer epoch", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "origin-negative");
      const rawOptions = { ...f.options, sql: f.raw, realm: f.c0FixtureRealm };
      assertHostedBillingFinancialRealm(f.c0FixtureRealm, {
        sql: f.raw,
        client: f.client,
        billingAuthority: f.c0FixtureRealm.billingAuthority,
      });
      expect(f.c0FixtureRealm.financialRealm).toBe(f.options.realm.financialRealm);
      expect(() => createFinancialRetainedR1Store(rawOptions)).toThrow("unavailable");
      await expect(buildFinancialR1MechanicalBatch(rawOptions, command)).rejects.toMatchObject({
        code: "unavailable",
      });

      const wrongEpoch: `sha256:${string}` = `sha256:${"d".repeat(64)}`;
      const wrongOptions = { ...f.options, writerEpoch: wrongEpoch };
      assertMoneyCutoverSqlOrigin(f.sql, { writerEpoch: EPOCH });
      assertHostedBillingFinancialRealm(f.options.realm, {
        sql: f.sql,
        client: f.client,
        billingAuthority: f.options.realm.billingAuthority,
      });
      const sameImageAtWrongEpoch = structuredClone(command);
      (sameImageAtWrongEpoch.original.scopeRealm as { writerEpoch: string }).writerEpoch =
        wrongEpoch;
      expect(() => createFinancialRetainedR1Store(wrongOptions)).toThrow("unavailable");
      await expect(
        buildFinancialR1MechanicalBatch(wrongOptions, sameImageAtWrongEpoch),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      expect(f.writes).toBe(0); // Both failures precede a builder result or SQL write.
    } finally {
      f.close();
    }
  });

  test("S-built pair submitted directly to the same primary raw R without a permit rolls back", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!, "raw-without-permit");
      const statements = await buildFinancialR1MechanicalBatch(f.options, command);
      await expect(f.raw.batch(statements)).rejects.toThrow();
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(0);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("a captured historical R1 GET keeps exact original bytes after authorized epoch rotation", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!, "historical-epoch", "決済条件📄");
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      const storedBefore = f.db
        .query("SELECT original_json FROM financial_retained_r1_originals WHERE r1_ref=?")
        .get(command.key.r1Ref) as { original_json: string } | null;
      expect(storedBefore?.original_json).toBe(canonicalJson(command.original));
      await f.base.run(
        "UPDATE money_cutover_authorized_epoch SET writer_epoch=? WHERE singleton=1",
        [`sha256:${"d".repeat(64)}`],
      );
      const writesAt = f.writes;
      const read = await f.store.readRetainedR1Original(command);
      expect(read.status).toBe("found");
      if (read.status !== "found") throw Error("historical original absent");
      expect(canonicalJson(read.original)).toBe(canonicalJson(command.original));
      expect(read.original.selectedTerms.bodyUtf8Base64url).toBe(
        command.original.selectedTerms.bodyUtf8Base64url,
      );
      expect(read.receipt.r1ReceiptRef).toBe(command.r1ReceiptRef);
      const storedAfter = f.db
        .query("SELECT original_json FROM financial_retained_r1_originals WHERE r1_ref=?")
        .get(command.key.r1Ref) as { original_json: string } | null;
      expect(storedAfter?.original_json).toBe(storedBefore?.original_json);
      expect(f.writes).toBe(writesAt);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("joined absence requires both stores absent; a C0-only pair or a different C0 selection is unavailable/conflict", async () => {
    const f = await fixture();
    try {
      const onlyC0 = await f.command(ACTIONS[0]!, "c0-only");
      expect(await f.store.readJoinedRetainedR1Data(onlyC0.key.challengeRef)).toEqual({
        status: "not-found",
      });
      await f.c0.prepare(onlyC0.original.c0);
      await expect(f.store.readJoinedRetainedR1Data(onlyC0.key.challengeRef)).rejects.toMatchObject(
        { code: "unavailable" },
      );
      await f.registerFixtureData();
      const retained = await f.command(ACTIONS[1]!, "mismatch");
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, retained));
      const differentC0 = structuredClone(retained.original.c0);
      (differentC0.selection.terms as { ref: string }).ref = "terms:changed";
      await f.c0.prepare(differentC0);
      await expect(
        f.store.readJoinedRetainedR1Data(retained.key.challengeRef),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      f.close();
    }
  });

  test("joined positive absence rejects a key occupied in another R1 ref role", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const retained = await f.command(ACTIONS[0]!, "joined-cross-role");
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, retained));
      for (const occupied of [
        retained.key.r1Ref,
        retained.key.preparationRef,
        retained.r1ReceiptRef,
      ]) {
        await expect(f.store.readJoinedRetainedR1Data(occupied)).rejects.toMatchObject({
          code: "conflict",
        });
      }
      expect(await f.store.readJoinedRetainedR1Data("challenge:completely-absent")).toEqual({
        status: "not-found",
      });
      await expect(
        f.store.readJoinedRetainedR1Data(retained.key.challengeRef),
      ).rejects.toMatchObject({ code: "unavailable" }); // R1 exists; C0 still absent.
    } finally {
      f.close();
    }
  });

  test("R1 and account-realm missing guards reject reads until each exact trigger is restored", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!, "schema-guard");
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      await withoutGuard(f.db, "financial_retained_r1_originals_no_update", async () => {
        const reading = f.store.readRetainedR1Original(command);
        // Keep the guard absent through the read even when Bun's matcher returns void.
        await reading.catch(() => undefined);
        await expect(reading).rejects.toMatchObject({ code: "unavailable" });
      });
      for (const name of [
        "financial_action_source_registrations_money_fence",
        "financial_retained_r1_originals_money_fence",
        "financial_retained_r1_receipts_money_fence",
      ]) {
        await withoutGuard(f.db, name, async () => {
          const reading = f.store.readRetainedR1Original(command);
          // Keep the guard absent through the read even when Bun's matcher returns void.
          await reading.catch(() => undefined);
          await expect(reading).rejects.toMatchObject({ code: "unavailable" });
        });
      }
      const corruptName = "financial_retained_r1_receipts_money_fence";
      const stored = f.db
        .query("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
        .get(corruptName) as { sql: string } | null;
      if (!stored) throw Error("missing source fence");
      f.db.exec(`DROP TRIGGER ${corruptName}`);
      try {
        f.db.exec(`CREATE TRIGGER ${corruptName} BEFORE INSERT ON financial_retained_r1_receipts
          BEGIN SELECT 1; END`);
        await expect(f.store.readRetainedR1Original(command)).rejects.toMatchObject({
          code: "unavailable",
        });
      } finally {
        f.db.exec(`DROP TRIGGER IF EXISTS ${corruptName}`);
        f.db.exec(stored.sql);
      }
      await withoutGuard(f.db, "stripe_billing_account_realms_no_update", async () => {
        const reading = f.store.readRetainedR1Original(command);
        // Keep the guard absent through the read even when Bun's matcher returns void.
        await reading.catch(() => undefined);
        await expect(reading).rejects.toMatchObject({ code: "unavailable" });
      });
      expect((await f.store.readRetainedR1Original(command)).status).toBe("found");
    } finally {
      f.close();
    }
  });

  test("zero-row original admission aborts receipt in the same batch", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!);
      const statements = await buildFinancialR1MechanicalBatch(f.options, command);
      await expect(f.sql.batch(statements)).rejects.toThrow(); // Registration fixture absent.
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("actual Money S wraps both R1 statements; stale epoch and freeze reject without residual permit", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!, "money-fence");
      const statements = await buildFinancialR1MechanicalBatch(f.options, command);
      for (const statement of statements) {
        expect(statement.sql).not.toMatch(
          /\b(?:money_cutover_freeze|money_cutover_writer_permit|money_cutover_authorized_epoch)\b/u,
        );
        expect(statement.params?.length ?? 0).toBeLessThanOrEqual(100);
      }
      const rotated = `sha256:${"d".repeat(64)}`;
      await f.base.run(
        "UPDATE money_cutover_authorized_epoch SET writer_epoch=? WHERE singleton=1",
        [rotated],
      );
      await expect(f.sql.batch(statements)).rejects.toThrow();
      const newEpochSql = createMoneyCutoverSql(f.raw, rotated);
      assertMoneyCutoverSqlOrigin(newEpochSql, { writerEpoch: rotated });
      await expect(newEpochSql.batch(statements)).rejects.toThrow(); // Permit is current; retained scope is old.
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(0);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      await f.base.run(
        "UPDATE money_cutover_authorized_epoch SET writer_epoch=? WHERE singleton=1",
        [EPOCH],
      );
      await f.base.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
      ]);
      await expect(f.sql.batch(statements)).rejects.toThrow();
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(0);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      await f.base.run("DELETE FROM money_cutover_freeze WHERE singleton=1");
      await f.sql.batch(statements);
      expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(1);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("registration fence rejects freeze; unconditional update/delete guards close all three tables", async () => {
    const f = await fixture();
    try {
      await f.base.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
      ]);
      await expect(f.registerFixtureData()).rejects.toThrow();
      expect(count(f.db, "financial_action_source_registrations")).toBe(0);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      await f.base.run("DELETE FROM money_cutover_freeze WHERE singleton=1");
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!, "immutable-fence");
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      for (const [table, column, value] of [
        [
          "financial_action_source_registrations",
          "registration_ref",
          command.original.actionSource.registrationRef,
        ],
        ["financial_retained_r1_originals", "r1_ref", command.key.r1Ref],
        ["financial_retained_r1_receipts", "receipt_ref", command.r1ReceiptRef],
      ] as const) {
        await expect(
          f.sql.run(`UPDATE ${table} SET ${column}=${column} WHERE ${column}=?`, [value]),
        ).rejects.toThrow();
        await expect(
          f.sql.run(`DELETE FROM ${table} WHERE ${column}=?`, [value]),
        ).rejects.toThrow();
      }
      expect(count(f.db, "financial_action_source_registrations")).toBe(1);
      expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(1);
    } finally {
      f.close();
    }
  });

  test("a committed batch with a lost acknowledgement is recovered by R1-only GET before C0", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      const statements = await buildFinancialR1MechanicalBatch(f.options, command);
      const lostAck = async () => {
        await f.sql.batch(statements);
        throw new SqlError("unavailable", "committed response lost");
      };
      await expect(lostAck()).rejects.toMatchObject({ code: "unavailable" });
      const writesAt = f.writes;
      const recovered = await f.store.readRetainedR1Original(command);
      expect(recovered.status).toBe("found");
      expect(f.writes).toBe(writesAt); // Recovery is GET-only; no second batch.
      expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(1);
      expect(count(f.db, "financial_preproof_challenges")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("full four-ref collision and corrupt receipt are distinguished from complete absence", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      const changed = structuredClone(command);
      (changed.key as { r1Ref: string }).r1Ref = "r1:foreign";
      (changed.original as { r1Ref: string }).r1Ref = "r1:foreign";
      await expect(f.store.readRetainedR1Original(changed)).rejects.toMatchObject({
        code: "conflict",
      });
      const crossRole = structuredClone(await f.command(ACTIONS[1]!, "cross-role"));
      (crossRole.key as { challengeRef: string }).challengeRef = command.key.r1Ref;
      (crossRole.original as { challengeRef: string }).challengeRef = command.key.r1Ref;
      (crossRole.original.c0.challenge as { challengeRef: string }).challengeRef =
        command.key.r1Ref;
      await expect(f.store.readRetainedR1Original(crossRole)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(
        f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, crossRole)),
      ).rejects.toThrow();
      expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
      await withoutGuard(f.db, "financial_retained_r1_receipts_no_delete", () =>
        f.base.run("DELETE FROM financial_retained_r1_receipts WHERE receipt_ref=?", [
          command.r1ReceiptRef,
        ]),
      );
      await expect(f.store.readRetainedR1Original(command)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      f.close();
    }
  });

  test("exact terms bytes and selected source digest cannot be replaced by matching-looking DTO data", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!);
      const badTerms = structuredClone(command);
      (badTerms.original.selectedTerms as { bodyUtf8Base64url: string }).bodyUtf8Base64url =
        "Zm9yZWlnbg";
      await expect(buildFinancialR1MechanicalBatch(f.options, badTerms)).rejects.toMatchObject({
        code: "invalid_request",
      });
      const badSource = structuredClone(command);
      (badSource.original.actionSource as { registrationDigest: string }).registrationDigest =
        `sha256:${"f".repeat(64)}`;
      await expect(buildFinancialR1MechanicalBatch(f.options, badSource)).rejects.toMatchObject({
        code: "invalid_request",
      });
      const invalidUtf8 = structuredClone(command);
      const malformedBytes = new Uint8Array([0xff]);
      const malformedDigest = await bytesDigest(malformedBytes);
      (invalidUtf8.original.selectedTerms as { bodyUtf8Base64url: string }).bodyUtf8Base64url =
        base64UrlEncode(malformedBytes);
      (invalidUtf8.original.selectedTerms as { bodyByteLength: number }).bodyByteLength = 1;
      (invalidUtf8.original.selectedTerms as { digest: string }).digest = malformedDigest;
      (invalidUtf8.original.c0.selection.terms as { digest: string }).digest = malformedDigest;
      await expect(buildFinancialR1MechanicalBatch(f.options, invalidUtf8)).rejects.toMatchObject({
        code: "invalid_request",
      });
      const invalidScalar = structuredClone(command);
      (invalidScalar.original.selectedTerms as { locale: string }).locale = "\ud800";
      await expect(buildFinancialR1MechanicalBatch(f.options, invalidScalar)).rejects.toMatchObject(
        { code: "invalid_request" },
      );
    } finally {
      f.close();
    }
  });

  test("a 32 KiB exact UTF-8 display body survives base64url and SQL without the old 16 KiB per-string wire cap", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!, "large-terms", "x".repeat(32_768));
      expect(command.original.selectedTerms.bodyUtf8Base64url.length).toBeGreaterThan(16_384);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      const read = await f.store.readRetainedR1Original(command);
      expect(read.status).toBe("found");
      if (read.status !== "found") throw Error("large exact terms lost");
      expect(read.original.selectedTerms.bodyByteLength).toBe(32_768);
      expect(read.original.selectedTerms.bodyUtf8Base64url).toBe(
        command.original.selectedTerms.bodyUtf8Base64url,
      );
      const unicode = await f.command(ACTIONS[0]!, "unicode-terms", "決済条件📄");
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, unicode));
      const unicodeRead = await f.store.readRetainedR1Original(unicode);
      expect(unicodeRead.status).toBe("found");
      if (unicodeRead.status !== "found") throw Error("Unicode terms lost");
      expect(unicodeRead.original.selectedTerms.bodyByteLength).toBe(
        new TextEncoder().encode("決済条件📄").length,
      );
      const largeUnicodeText = "📄".repeat(8_192);
      expect(new TextEncoder().encode(largeUnicodeText).length).toBe(32_768);
      const largeUnicode = await f.command(ACTIONS[0]!, "large-unicode-terms", largeUnicodeText);
      expect(largeUnicode.original.selectedTerms.bodyUtf8Base64url.length).toBe(43_691);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, largeUnicode));
      const largeUnicodeRead = await f.store.readRetainedR1Original(largeUnicode);
      expect(largeUnicodeRead.status).toBe("found");
      if (largeUnicodeRead.status !== "found") throw Error("large Unicode terms lost");
      expect(largeUnicodeRead.original.selectedTerms.bodyByteLength).toBe(32_768);
      expect(largeUnicodeRead.original.selectedTerms.bodyUtf8Base64url).toBe(
        largeUnicode.original.selectedTerms.bodyUtf8Base64url,
      );
      const tooLarge = await f.command(ACTIONS[0]!, "oversize-terms", "x".repeat(32_769));
      await expect(buildFinancialR1MechanicalBatch(f.options, tooLarge)).rejects.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      f.close();
    }
  });

  test("a caller mutation during an asynchronous original read cannot change the snapshotted command", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      const mutable = structuredClone(command);
      const pending = f.store.readRetainedR1Original(mutable);
      (mutable.original.economic as { amountMinor: number }).amountMinor = 999;
      const found = await pending;
      expect(found.status).toBe("found");
      if (found.status !== "found") throw Error("snapshotted original absent");
      expect((found.original.economic as { amountMinor: number }).amountMinor).toBe(500);
    } finally {
      f.close();
    }
  });

  test("malformed persisted command and orphan receipt are unavailable, never positive absence", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      await withoutGuard(f.db, "financial_retained_r1_originals_no_update", () =>
        f.base.run("UPDATE financial_retained_r1_originals SET command_json='{}' WHERE r1_ref=?", [
          command.key.r1Ref,
        ]),
      );
      await expect(f.store.readRetainedR1Original(command)).rejects.toMatchObject({
        code: "unavailable",
      });
      await withoutGuard(f.db, "financial_retained_r1_originals_no_update", () =>
        f.base.run("UPDATE financial_retained_r1_originals SET command_json=? WHERE r1_ref=?", [
          canonicalJson(command),
          command.key.r1Ref,
        ]),
      );
      f.db.exec("PRAGMA foreign_keys=OFF");
      try {
        await withoutGuard(f.db, "financial_retained_r1_originals_no_delete", () =>
          f.base.run("DELETE FROM financial_retained_r1_originals WHERE r1_ref=?", [
            command.key.r1Ref,
          ]),
        );
      } finally {
        f.db.exec("PRAGMA foreign_keys=ON");
      }
      await expect(f.store.readRetainedR1Original(command)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      f.close();
    }
  });

  test("a newly registered incarnation does not replace historical selected source bytes", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      const later = {
        version: "financial-action-registration-canonical-v1",
        registrationRef: "action-registration:test",
        incarnation: "incarnation:later",
        sourceRef: "action-source:later",
        originRef: "origin:later",
        financialRealm: f.options.realm.financialRealm,
        organizationId: SCOPE.organizationId,
        workspaceId: SCOPE.workspaceId,
        workspaceRef: SCOPE.workspaceRef,
      };
      await f.sql.run(
        `INSERT INTO financial_action_source_registrations
        (registration_ref,incarnation,registration_digest,digest_recipe,registration_json,created_at)
        VALUES(?,?,?,?,?,?)`,
        [
          later.registrationRef,
          later.incarnation,
          await canonicalDigest([later.version, later]),
          later.version,
          canonicalJson(later),
          AT,
        ],
      );
      const read = await f.store.readRetainedR1Original(command);
      expect(read.status).toBe("found");
      if (read.status !== "found") throw Error("historical R1 missing");
      expect(read.original.actionSource.incarnation).toBe("incarnation:test");
      expect(read.original.selectedTerms).toEqual(command.original.selectedTerms);
    } finally {
      f.close();
    }
  });
});
