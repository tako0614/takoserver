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
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import {
  createSharedFinancialActionIdentity,
  type SharedFinancialAction,
} from "../src/shared-financial-action.ts";
import {
  buildFinancialC0OriginalRoleOccupancyStatementData,
  buildFinancialR1CoPreparationBatch,
  buildFinancialR1HistoricalC0RecordJsonData,
  buildFinancialR1MechanicalBatch,
  createFinancialActionConsentR1Reader,
  createFinancialRetainedR1Store,
  type FinancialR1WriteCommand,
  readFinancialRequestBoundR1History,
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
  // C0 SQL no longer names money_cutover_* tables and passes Root S unchanged;
  // on the Financial 0104 schema its freeze/permit/epoch are the C0 money fences.
  // This fixture installs the unfenced C0 candidate, so its C0 prepare stays a
  // mechanical raw-Sql fixture on this same primary; R1 writes use the actual S wrapper.
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

describe("fixed registration C0 R1 contribution", () => {
  const tables = [
    "financial_action_source_registrations",
    "financial_preproof_challenges",
    "financial_preproof_challenge_receipts",
    "financial_retained_r1_originals",
    "financial_retained_r1_receipts",
  ] as const;
  // Explicit generic-SQLite fixture bracket only. This is not the missing genuine
  // Root R.batch/permit/currentness port and is not exported by product source.
  function fixtureTransaction(statements: readonly SqlStatement[]): readonly SqlStatement[] {
    return [
      {
        sql: "INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)",
        params: [EPOCH],
      },
      ...statements,
      { sql: "DELETE FROM money_cutover_writer_permit WHERE singleton=1" },
    ];
  }
  for (const action of ACTIONS) {
    test(`${action.kind} compiles one exact registration and both existing pairs without effects`, async () => {
      const f = await fixture();
      try {
        const command = await f.command(action),
          before = [f.writes, f.clocks, f.providerRequests];
        const c0 = createFinancialPreproofChallengeStore(f.options).buildPreparationContribution(
          command.original.c0,
          AT,
        );
        const oldC0 = f.c0.buildPreparationBatch(command.original.c0, AT),
          oldR1 = await buildFinancialR1MechanicalBatch(f.options, command),
          fixed = await buildFinancialR1CoPreparationBatch(f.options, command, AT);
        expect(fixed).toHaveLength(5);
        expect(fixed.slice(1, 3)).toEqual([...oldC0]);
        expect(c0.statements).toEqual(oldC0);
        const originalParams = fixed[3]?.params,
          oldOriginalParams = oldR1[0]?.params;
        if (!originalParams) throw Error("co-batch original input missing");
        if (!oldOriginalParams) throw Error("old R1 original input missing");
        // The new-only CTE reuses four role IDs instead of repeating 32 binds.
        // Re-expand every original slot to verify all old typed values, not a subset.
        const roles = originalParams.slice(0, 4);
        expect([
          ...originalParams.slice(0, 13),
          ...originalParams.slice(21),
          ...roles,
          ...roles,
          ...roles,
          ...roles,
          ...roles,
          ...roles,
          ...roles,
          ...roles,
        ]).toEqual([...oldOriginalParams]);
        expect(originalParams).toHaveLength(28);
        const source = command.original.actionSource;
        const registration = {
          version: "financial-action-registration-canonical-v1",
          registrationRef: source.registrationRef,
          incarnation: source.incarnation,
          sourceRef: source.ref,
          originRef: source.originRef,
          financialRealm: source.financialRealm,
          organizationId: source.organizationId,
          workspaceId: source.workspaceId,
          workspaceRef: source.workspaceRef,
        };
        expect(Object.keys(registration)).toHaveLength(9);
        expect(await canonicalDigest([registration.version, registration])).toBe(
          source.registrationDigest,
        );
        expect(fixed[0]?.params?.slice(0, 6)).toEqual([
          source.registrationRef,
          source.incarnation,
          source.registrationDigest,
          registration.version,
          canonicalJson(registration),
          AT,
        ]);
        expect(c0.preparedImage.recordJson).toBe(
          canonicalJson({
            ...command.original.c0,
            scope: command.original.scopeRealm,
          }),
        );
        expect(buildFinancialR1HistoricalC0RecordJsonData(command)).toBe(
          c0.preparedImage.recordJson,
        );
        expect(buildFinancialR1HistoricalC0RecordJsonData(command)).not.toBe(
          canonicalJson(command.original.c0),
        );
        expect(c0.preparedImage).toEqual({
          challengeRef: command.key.challengeRef,
          preparationRef: command.key.preparationRef,
          receiptRef: command.original.c0ReceiptRef,
          challengeJson: canonicalJson(command.original.c0.challenge),
          scopeJson: canonicalJson(command.original.scopeRealm),
          recordJson: c0.preparedImage.recordJson,
          createdAt: AT,
        });
        expect(Object.isFrozen(c0)).toBe(true);
        expect(Object.isFrozen(c0.preparedImage)).toBe(true);
        expect(Object.isFrozen(c0.statements)).toBe(true);
        expect(
          fixed.every(
            (statement) => Object.isFrozen(statement) && Object.isFrozen(statement.params),
          ),
        ).toBe(true);
        expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
        expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
      } finally {
        f.close();
      }
    });
  }

  test("one generic fixture transaction retains all five rows and exact 32768-byte displayed terms", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "co-batch-full-terms", "x".repeat(32768));
      const fixed = await buildFinancialR1CoPreparationBatch(f.options, command, AT);
      expect(await f.base.batch(fixtureTransaction(fixed))).toHaveLength(7);
      expect(tables.map((table) => count(f.db, table))).toEqual([1, 1, 1, 1, 1]);
      const retained = await f.store.readRetainedR1Original(command);
      expect(retained.status).toBe("found");
      if (retained.status !== "found") throw Error("positive five-row R1 absent");
      expect(retained.original).toEqual(command.original);
      expect(retained.original.selectedTerms.bodyByteLength).toBe(32768);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("terminal mandatory receipt rejects a missing C0 receipt and rolls back every new row", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "co-batch-missing-c0-receipt"),
        fixed = await buildFinancialR1CoPreparationBatch(f.options, command, AT);
      await expect(
        f.base.batch(fixtureTransaction(fixed.filter((_, index) => index !== 2))),
      ).rejects.toMatchObject({ code: "constraint" });
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });

  for (const crossed of ["record", "scope", "createdAt"] as const) {
    test(`terminal mandatory receipt rejects a valid but crossed C0 ${crossed} preimage`, async () => {
      const f = await fixture();
      try {
        const command = await f.command(ACTIONS[0]!, `co-batch-crossed-${crossed}`),
          fixed = await buildFinancialR1CoPreparationBatch(f.options, command, AT),
          other = structuredClone(command.original.c0);
        const otherScope = { ...SCOPE };
        if (crossed === "record")
          Object.assign(other.selection.business, { ref: "business:crossed" });
        if (crossed === "scope") {
          otherScope.workspaceRef = "workspace-ref:crossed";
          Object.assign(other.challenge, { workspaceRef: otherScope.workspaceRef });
          Object.assign(other.selection.billingBinding, { workspaceRef: otherScope.workspaceRef });
        }
        const alternateC0 = createFinancialPreproofChallengeStore({
          ...f.options,
          scope: otherScope,
        }).buildPreparationContribution(
          other,
          crossed === "createdAt" ? "2026-10-15T00:00:00.001Z" : AT,
        );
        const registration = fixed[0],
          original = fixed[3],
          receipt = fixed[4];
        if (!registration || !original || !receipt) throw Error("fixed five statements missing");
        await expect(
          f.base.batch(
            fixtureTransaction([registration, ...alternateC0.statements, original, receipt]),
          ),
        ).rejects.toMatchObject({ code: "constraint" });
        expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
        expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      } finally {
        f.close();
      }
    });
  }

  test("a conditional in-transaction five-row milestone reaches an exact late SQL fault then rolls back", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "co-batch-late-fault"),
        fixed = await buildFinancialR1CoPreparationBatch(f.options, command, AT);
      // The integer-overflow branch is reached only when all five exact new rows
      // already exist in this transaction. Missing rows return 0 and must fail this test.
      const lateFault: SqlStatement = {
        sql: `SELECT CASE WHEN
          EXISTS(SELECT 1 FROM financial_action_source_registrations WHERE registration_ref=? AND incarnation=?)
          AND EXISTS(SELECT 1 FROM financial_preproof_challenges WHERE challenge_ref=? AND preparation_ref=?)
          AND EXISTS(SELECT 1 FROM financial_preproof_challenge_receipts WHERE receipt_ref=? AND all_rows_match=1)
          AND EXISTS(SELECT 1 FROM financial_retained_r1_originals WHERE r1_ref=? AND receipt_ref=?)
          AND EXISTS(SELECT 1 FROM financial_retained_r1_receipts WHERE receipt_ref=? AND all_rows_match=1)
          THEN abs(-9223372036854775808) ELSE 0 END AS all_five_reached_before_late_fault`,
        params: [
          command.original.actionSource.registrationRef,
          command.original.actionSource.incarnation,
          command.key.challengeRef,
          command.key.preparationRef,
          command.original.c0ReceiptRef,
          command.key.r1Ref,
          command.r1ReceiptRef,
          command.r1ReceiptRef,
        ],
      };
      await expect(f.base.batch(fixtureTransaction([...fixed, lateFault]))).rejects.toMatchObject({
        name: "SqlError",
        code: "unavailable",
        message: "integer overflow",
      });
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("the complete action economic terms and source image is detached before the digest await", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "co-batch-before-await"),
        original = structuredClone(command),
        before = [f.writes, f.clocks, f.providerRequests];
      const pending = buildFinancialR1CoPreparationBatch(f.options, command, AT);
      Object.assign(command.original.selectedTerms, {
        bodyUtf8Base64url: "altered",
        ref: "terms:altered",
      });
      Object.assign(command.original.actionSource, { originRef: "origin:altered" });
      Object.assign(command.original.economic, { amountMinor: 999 });
      const fixed = await pending;
      expect(fixed).toEqual(await buildFinancialR1CoPreparationBatch(f.options, original, AT));
      expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
    } finally {
      f.close();
    }
  });

  test("extra SQL-shaped command data and invalid time fail before a contribution or effects", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "co-batch-closed-input"),
        before = [f.writes, f.clocks, f.providerRequests];
      await expect(
        buildFinancialR1CoPreparationBatch(
          f.options,
          Object.assign(structuredClone(command), { sql: "SELECT 1" }),
          AT,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        buildFinancialR1CoPreparationBatch(f.options, command, "today"),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
    } finally {
      f.close();
    }
  });
});

describe("business-key historical DATA and new-five-only CAS", () => {
  const tables = [
    "financial_action_source_registrations",
    "financial_preproof_challenges",
    "financial_preproof_challenge_receipts",
    "financial_retained_r1_originals",
    "financial_retained_r1_receipts",
  ] as const;
  function fixtureTransaction(statements: readonly SqlStatement[]): readonly SqlStatement[] {
    return [
      {
        sql: "INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)",
        params: [EPOCH],
      },
      ...statements,
      { sql: "DELETE FROM money_cutover_writer_permit WHERE singleton=1" },
    ];
  }
  async function candidate(
    f: Awaited<ReturnType<typeof fixture>>,
    action: SharedFinancialAction,
    suffix: string,
    scope: FinancialPreproofScope = SCOPE,
  ) {
    const command = await f.command(action, suffix),
      o = command.original;
    Object.assign(o.c0.challenge, scope);
    Object.assign(o.scopeRealm, scope);
    Object.assign(o.c0.selection.billingBinding, {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      workspaceRef: scope.workspaceRef,
    });
    const source = o.actionSource;
    Object.assign(source, {
      ref: `action-source:${suffix}`,
      registrationRef: `action-registration:${suffix}`,
      incarnation: `incarnation:${suffix}`,
      originRef: `origin:${suffix}`,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      workspaceRef: scope.workspaceRef,
    });
    const registration = {
      version: "financial-action-registration-canonical-v1",
      registrationRef: source.registrationRef,
      incarnation: source.incarnation,
      sourceRef: source.ref,
      originRef: source.originRef,
      financialRealm: source.financialRealm,
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      workspaceRef: source.workspaceRef,
    };
    Object.assign(source, {
      registrationDigest: await canonicalDigest([registration.version, registration]),
    });
    Object.assign(source, {
      digest: await canonicalDigest([
        "financial-selected-action-source-canonical-v1",
        {
          version: "financial-selected-action-source-canonical-v1",
          ref: source.ref,
          registrationRef: source.registrationRef,
          registrationDigest: source.registrationDigest,
          incarnation: source.incarnation,
          originRef: source.originRef,
          financialRealm: source.financialRealm,
          organizationId: source.organizationId,
          workspaceId: source.workspaceId,
          workspaceRef: source.workspaceRef,
          selectedAt: source.selectedAt,
        },
      ]),
    });
    return { command, options: { ...f.options, scope } };
  }

  test("positive absence requires all four history tables and is DATA only without effects", async () => {
    const f = await fixture();
    try {
      const before = [f.writes, f.clocks, f.providerRequests];
      expect(await f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).toEqual({
        status: "not-found",
      });
      expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
      await expect(f.store.prepare(await f.command(ACTIONS[0]!))).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      f.close();
    }
  });

  test("same business reads the actual complete old command and full terms without selecting again", async () => {
    const f = await fixture();
    try {
      const c = await candidate(f, ACTIONS[0]!, "business-original");
      await f.base.batch(
        fixtureTransaction(await buildFinancialR1CoPreparationBatch(c.options, c.command, AT)),
      );
      const before = [f.writes, f.clocks, f.providerRequests];
      const read = await f.store.readBusinessRetainedR1Data(ACTIONS[0]!);
      expect(read.status).toBe("found");
      if (read.status !== "found") throw Error("historical original missing");
      expect(read.original).toEqual(c.command.original);
      expect(read.r1ReceiptRef).toBe(c.command.r1ReceiptRef);
      expect(read.c0ReceiptRef).toBe(c.command.original.c0ReceiptRef);
      const expectedAction = ACTIONS[0];
      if (!expectedAction) throw Error("expected original action missing");
      expect(read.actionIdentity.action).toEqual(expectedAction);
      expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
    } finally {
      f.close();
    }
  });

  test("changed body finds the original reference then conflicts and cannot commit another five rows", async () => {
    const f = await fixture();
    try {
      const first = await candidate(f, ACTIONS[0]!, "business-body-original");
      await f.base.batch(
        fixtureTransaction(
          await buildFinancialR1CoPreparationBatch(first.options, first.command, AT),
        ),
      );
      const changed: SharedFinancialAction = {
        kind: "topup",
        organizationId: SCOPE.organizationId,
        reference: ACTIONS[0]!.reference,
        amountMinor: 999,
      };
      await expect(f.store.readBusinessRetainedR1Data(changed)).rejects.toMatchObject({
        code: "conflict",
      });
      const second = await candidate(f, changed, "business-body-changed");
      await expect(
        f.base.batch(
          fixtureTransaction(
            await buildFinancialR1CoPreparationBatch(second.options, second.command, AT),
          ),
        ),
      ).rejects.toMatchObject({ code: "constraint" });
      expect(tables.map((table) => count(f.db, table))).toEqual([1, 1, 1, 1, 1]);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      const kept = await f.store.readBusinessRetainedR1Data(ACTIONS[0]!);
      expect(kept.status === "found" && kept.original).toEqual(first.command.original);
    } finally {
      f.close();
    }
  });

  test("another workspace cannot turn the same Org business into absence or another selection", async () => {
    const f = await fixture();
    try {
      const first = await candidate(f, ACTIONS[0]!, "business-workspace-original");
      await f.base.batch(
        fixtureTransaction(
          await buildFinancialR1CoPreparationBatch(first.options, first.command, AT),
        ),
      );
      const scope = {
        ...SCOPE,
        workspaceId: "workspace:other",
        workspaceRef: "workspace-ref:other",
        clientId: "client:other",
      };
      const otherStore = createFinancialRetainedR1Store({ ...f.options, scope });
      await expect(otherStore.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
        code: "unavailable",
      });
      const second = await candidate(f, ACTIONS[0]!, "business-workspace-other", scope);
      await expect(
        f.base.batch(
          fixtureTransaction(
            await buildFinancialR1CoPreparationBatch(second.options, second.command, AT),
          ),
        ),
      ).rejects.toMatchObject({ code: "constraint" });
      expect(tables.map((table) => count(f.db, table))).toEqual([1, 1, 1, 1, 1]);
      const kept = await f.store.readBusinessRetainedR1Data(ACTIONS[0]!);
      expect(kept.status === "found" && kept.original).toEqual(first.command.original);
    } finally {
      f.close();
    }
  });

  test("two precompiled different-ref candidates elect one under serial atomic fixture transactions", async () => {
    const f = await fixture();
    try {
      const first = await candidate(f, ACTIONS[0]!, "business-first"),
        second = await candidate(f, ACTIONS[0]!, "business-second");
      const firstBatch = await buildFinancialR1CoPreparationBatch(first.options, first.command, AT),
        secondBatch = await buildFinancialR1CoPreparationBatch(second.options, second.command, AT);
      expect(first.command.key).not.toEqual(second.command.key);
      await f.base.batch(fixtureTransaction(firstBatch));
      await expect(f.base.batch(fixtureTransaction(secondBatch))).rejects.toMatchObject({
        code: "constraint",
      });
      expect(tables.map((table) => count(f.db, table))).toEqual([1, 1, 1, 1, 1]);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      const kept = await f.store.readBusinessRetainedR1Data(ACTIONS[0]!);
      expect(kept.status === "found" && kept.original).toEqual(first.command.original);
      // Old two-statement DATA API remains unchanged and is not claimed to enforce this new CAS.
      const old = await buildFinancialR1MechanicalBatch(second.options, second.command);
      expect(old[0]?.params).toHaveLength(52);
      expect(old[0]?.sql).not.toContain("r1_input");
    } finally {
      f.close();
    }
  });

  for (const distinct of ["kind", "organization"] as const) {
    test(`a distinct ${distinct} keeps its actual business namespace and can retain a second original`, async () => {
      const f = await fixture();
      try {
        const first = await candidate(f, ACTIONS[0]!, `business-distinct-${distinct}-first`);
        await f.base.batch(
          fixtureTransaction(
            await buildFinancialR1CoPreparationBatch(first.options, first.command, AT),
          ),
        );
        const scope =
          distinct === "organization" ? { ...SCOPE, organizationId: "org:other" } : SCOPE;
        const other: SharedFinancialAction =
          distinct === "kind"
            ? {
                kind: "card-setup",
                organizationId: SCOPE.organizationId,
                reference: ACTIONS[0]!.reference,
                setupDisclosureRevision: "disclosure:other",
              }
            : {
                kind: "topup",
                organizationId: scope.organizationId,
                reference: ACTIONS[0]!.reference,
                amountMinor: 500,
              };
        const second = await candidate(f, other, `business-distinct-${distinct}-second`, scope);
        await f.base.batch(
          fixtureTransaction(
            await buildFinancialR1CoPreparationBatch(second.options, second.command, AT),
          ),
        );
        expect(tables.map((table) => count(f.db, table))).toEqual([2, 2, 2, 2, 2]);
        const read = await createFinancialRetainedR1Store(
          second.options,
        ).readBusinessRetainedR1Data(other);
        expect(read.status === "found" && read.original).toEqual(second.command.original);
      } finally {
        f.close();
      }
    });
  }

  for (const partial of [
    "R1-original-only",
    "R1-receipt-only",
    "C0-only",
    "C0-original-only",
    "C0-receipt-only",
  ] as const) {
    test(`${partial} history is unavailable and blocks a different-ref candidate without altering history`, async () => {
      const f = await fixture();
      try {
        const first = await candidate(f, ACTIONS[0]!, `business-partial-${partial}`);
        if (partial.startsWith("R1")) {
          const fixed = await buildFinancialR1CoPreparationBatch(first.options, first.command, AT);
          await f.base.batch(
            fixtureTransaction(partial === "R1-original-only" ? fixed.slice(0, 4) : fixed),
          );
          if (partial === "R1-receipt-only") {
            f.db.exec("PRAGMA foreign_keys=OFF");
            try {
              await withoutGuard(f.db, "financial_retained_r1_originals_no_delete", () => {
                f.db
                  .query("DELETE FROM financial_retained_r1_originals WHERE r1_ref=?")
                  .run(first.command.key.r1Ref);
              });
            } finally {
              f.db.exec("PRAGMA foreign_keys=ON");
            }
          }
        } else if (partial === "C0-original-only") {
          const original = f.c0.buildPreparationBatch(first.command.original.c0, AT)[0];
          if (!original) throw Error("C0 original missing");
          await f.base.batch([original]);
        } else {
          await f.c0.prepare(first.command.original.c0);
          if (partial === "C0-receipt-only") {
            f.db.exec("PRAGMA foreign_keys=OFF");
            try {
              await withoutGuard(f.db, "financial_preproof_challenges_no_delete", () => {
                f.db
                  .query("DELETE FROM financial_preproof_challenges WHERE challenge_ref=?")
                  .run(first.command.key.challengeRef);
              });
            } finally {
              f.db.exec("PRAGMA foreign_keys=ON");
            }
          }
        }
        const before = tables.map((table) => count(f.db, table));
        await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
          code: "unavailable",
        });
        const second = await candidate(f, ACTIONS[0]!, `business-after-${partial}`);
        await expect(
          f.base.batch(
            fixtureTransaction(
              await buildFinancialR1CoPreparationBatch(second.options, second.command, AT),
            ),
          ),
        ).rejects.toMatchObject({ code: "constraint" });
        expect(tables.map((table) => count(f.db, table))).toEqual(before);
        expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      } finally {
        f.close();
      }
    });
  }

  for (const corrupt of ["malformed-original", "crossed-receipt"] as const) {
    test(`${corrupt} business history is held rather than parsed as absence`, async () => {
      const f = await fixture();
      try {
        const first = await candidate(f, ACTIONS[0]!, `business-${corrupt}`);
        await f.base.batch(
          fixtureTransaction(
            await buildFinancialR1CoPreparationBatch(first.options, first.command, AT),
          ),
        );
        if (corrupt === "malformed-original") {
          const altered = structuredClone(first.command);
          Object.assign(altered.original.economic, { amountMinor: 999 });
          await withoutGuard(f.db, "financial_retained_r1_originals_no_update", () => {
            f.db
              .query("UPDATE financial_retained_r1_originals SET command_json=? WHERE r1_ref=?")
              .run(canonicalJson(altered), first.command.key.r1Ref);
          });
          await withoutGuard(f.db, "financial_retained_r1_receipts_no_update", () => {
            f.db
              .query("UPDATE financial_retained_r1_receipts SET command_json=? WHERE receipt_ref=?")
              .run(canonicalJson(altered), first.command.r1ReceiptRef);
          });
        } else {
          const other = await candidate(f, ACTIONS[0]!, "business-crossed-command");
          await withoutGuard(f.db, "financial_retained_r1_receipts_no_update", () => {
            f.db
              .query("UPDATE financial_retained_r1_receipts SET command_json=? WHERE receipt_ref=?")
              .run(canonicalJson(other.command), first.command.r1ReceiptRef);
          });
        }
        await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
          code: "unavailable",
        });
      } finally {
        f.close();
      }
    });
  }

  test("empty history with a missing C0 schema guard is unavailable until the original guard is restored", async () => {
    const f = await fixture();
    try {
      await withoutGuard(f.db, "financial_preproof_challenges_no_delete", async () => {
        await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
          code: "unavailable",
        });
      });
      expect(await f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).toEqual({
        status: "not-found",
      });
    } finally {
      f.close();
    }
  });

  test("multiple same-business histories written through the old DATA API are held without first-row adoption", async () => {
    const f = await fixture();
    try {
      for (const suffix of ["business-old-first", "business-old-second"]) {
        const c = await candidate(f, ACTIONS[0]!, suffix);
        await f.c0.prepare(c.command.original.c0);
        const registration = (
          await buildFinancialR1CoPreparationBatch(c.options, c.command, AT)
        )[0];
        if (!registration) throw Error("registration fixture missing");
        await f.base.batch(
          fixtureTransaction([
            registration,
            ...(await buildFinancialR1MechanicalBatch(c.options, c.command)),
          ]),
        );
      }
      expect(tables.map((table) => count(f.db, table))).toEqual([2, 2, 2, 2, 2]);
      await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
        code: "unavailable",
      });
      const third = await candidate(f, ACTIONS[0]!, "business-old-third");
      await expect(
        f.base.batch(
          fixtureTransaction(
            await buildFinancialR1CoPreparationBatch(third.options, third.command, AT),
          ),
        ),
      ).rejects.toMatchObject({ code: "constraint" });
      expect(tables.map((table) => count(f.db, table))).toEqual([2, 2, 2, 2, 2]);
    } finally {
      f.close();
    }
  });

  test("unknown query is unavailable and a later empty DATA read does not classify that attempt's effects", async () => {
    const f = await fixture();
    try {
      f.unknownQuery();
      await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(await f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).toEqual({
        status: "not-found",
      });
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
      // This DATA reader supplies no unknown latch, abort proof or NEW permission.
    } finally {
      f.close();
    }
  });

  test("lookup detaches the caller action before awaiting and returns the retained original unchanged", async () => {
    const f = await fixture();
    try {
      const first = await candidate(f, ACTIONS[0]!, "business-read-before-await");
      await f.base.batch(
        fixtureTransaction(
          await buildFinancialR1CoPreparationBatch(first.options, first.command, AT),
        ),
      );
      const action = structuredClone(ACTIONS[0]!);
      const pending = f.store.readBusinessRetainedR1Data(action);
      Object.assign(action, { amountMinor: 999, reference: "topup:after-await" });
      const read = await pending;
      expect(read.status === "found" && read.original).toEqual(first.command.original);
    } finally {
      f.close();
    }
  });

  test("closed lookup input rejects extra SQL and getters without invoking them", async () => {
    const f = await fixture();
    try {
      let gets = 0;
      const action = structuredClone(ACTIONS[0]!);
      Object.defineProperty(action, "reference", {
        enumerable: true,
        get() {
          gets++;
          return "topup:forged";
        },
      });
      await expect(f.store.readBusinessRetainedR1Data(action)).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(gets).toBe(0);
      await expect(
        f.store.readBusinessRetainedR1Data(
          Object.assign(structuredClone(ACTIONS[0]!), { sql: "SELECT 1" }),
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 0, 0, 0, 0]);
    } finally {
      f.close();
    }
  });

  test("actual C0.prepare retains an opaque body and its outer business blocks fresh references", async () => {
    const f = await fixture();
    try {
      const prior = await candidate(f, ACTIONS[0]!, "business-opaque-C0");
      Object.assign(prior.command.original.c0.selection.action, { body: { amountMinor: 500 } });
      expect(await f.c0.prepare(prior.command.original.c0)).toEqual({
        preparationRef: prior.command.key.preparationRef,
        challengeRef: prior.command.key.challengeRef,
        receiptRef: prior.command.original.c0ReceiptRef,
      });
      expect(await f.c0.readChallenge(prior.command.key.challengeRef)).toEqual(
        prior.command.original.c0.challenge,
      );
      const oldOriginal = f.db.query("SELECT * FROM financial_preproof_challenges").all(),
        oldReceipt = f.db.query("SELECT * FROM financial_preproof_challenge_receipts").all();
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 1, 1, 0, 0]);
      await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
        code: "unavailable",
      });
      const fresh = await candidate(f, ACTIONS[0]!, "business-after-opaque-C0");
      const fixed = await buildFinancialR1CoPreparationBatch(fresh.options, fresh.command, AT);
      expect(fixed[3]?.params).toHaveLength(28);
      await expect(f.base.batch(fixtureTransaction(fixed))).rejects.toMatchObject({
        code: "constraint",
      });
      expect(tables.map((table) => count(f.db, table))).toEqual([0, 1, 1, 0, 0]);
      expect(f.db.query("SELECT * FROM financial_preproof_challenges").all()).toEqual(oldOriginal);
      expect(f.db.query("SELECT * FROM financial_preproof_challenge_receipts").all()).toEqual(
        oldReceipt,
      );
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("actual crossed outer and body C0 keys within its challenge Org are both held", async () => {
    const f = await fixture();
    try {
      const outer = ACTIONS[0]!,
        body: SharedFinancialAction = {
          kind: "card-setup",
          organizationId: SCOPE.organizationId,
          reference: "card:crossed-C0-body",
          setupDisclosureRevision: "disclosure:crossed",
        };
      const prior = await candidate(f, outer, "business-crossed-outer-body-C0");
      Object.assign(prior.command.original.c0.selection.action, { body });
      expect(await f.c0.prepare(prior.command.original.c0)).toMatchObject({
        challengeRef: prior.command.key.challengeRef,
      });
      const oldOriginal = f.db.query("SELECT * FROM financial_preproof_challenges").all(),
        oldReceipt = f.db.query("SELECT * FROM financial_preproof_challenge_receipts").all();
      for (const [index, action] of [outer, body].entries()) {
        await expect(f.store.readBusinessRetainedR1Data(action)).rejects.toMatchObject({
          code: "unavailable",
        });
        const fresh = await candidate(f, action, `business-crossed-C0-attempt-${index}`);
        await expect(
          f.base.batch(
            fixtureTransaction(
              await buildFinancialR1CoPreparationBatch(fresh.options, fresh.command, AT),
            ),
          ),
        ).rejects.toMatchObject({ code: "constraint" });
        expect(tables.map((table) => count(f.db, table))).toEqual([0, 1, 1, 0, 0]);
        expect(f.db.query("SELECT * FROM financial_preproof_challenges").all()).toEqual(
          oldOriginal,
        );
        expect(f.db.query("SELECT * FROM financial_preproof_challenge_receipts").all()).toEqual(
          oldReceipt,
        );
      }
    } finally {
      f.close();
    }
  });

  test("unvalidated C0 body Org cannot occupy another Org while both refs remain held in its actual Org", async () => {
    const f = await fixture();
    try {
      const foreignScope = { ...SCOPE, organizationId: "org:foreign-C0-body" };
      const body: SharedFinancialAction = {
        kind: "topup",
        organizationId: foreignScope.organizationId,
        reference: "topup:foreign-C0-body",
        amountMinor: 500,
      };
      const prior = await candidate(f, ACTIONS[0]!, "business-C0-unvalidated-org");
      Object.assign(prior.command.original.c0.selection.action, { body });
      expect(await f.c0.prepare(prior.command.original.c0)).toMatchObject({
        challengeRef: prior.command.key.challengeRef,
      });
      await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
        code: "unavailable",
      });
      const actualOrgBodyKey: SharedFinancialAction = {
        ...body,
        organizationId: SCOPE.organizationId,
      };
      await expect(f.store.readBusinessRetainedR1Data(actualOrgBodyKey)).rejects.toMatchObject({
        code: "unavailable",
      });
      const actualOrgAttempt = await candidate(
        f,
        actualOrgBodyKey,
        "business-C0-actual-org-blocked",
      );
      await expect(
        f.base.batch(
          fixtureTransaction(
            await buildFinancialR1CoPreparationBatch(
              actualOrgAttempt.options,
              actualOrgAttempt.command,
              AT,
            ),
          ),
        ),
      ).rejects.toMatchObject({ code: "constraint" });
      const foreignStore = createFinancialRetainedR1Store({ ...f.options, scope: foreignScope });
      expect(await foreignStore.readBusinessRetainedR1Data(body)).toEqual({ status: "not-found" });
      const independent = await candidate(f, body, "business-C0-real-foreign-org", foreignScope);
      await f.base.batch(
        fixtureTransaction(
          await buildFinancialR1CoPreparationBatch(independent.options, independent.command, AT),
        ),
      );
      const read = await foreignStore.readBusinessRetainedR1Data(body);
      expect(read.status === "found" && read.original).toEqual(independent.command.original);
      expect(tables.map((table) => count(f.db, table))).toEqual([1, 2, 2, 1, 1]);
      await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      f.close();
    }
  });
});

describe("Hosted supplier retained Financial command DATA", () => {
  test("all five actions return the actual stored full command and byte-exact JSON", async () => {
    for (const action of ACTIONS) {
      const f = await fixture();
      try {
        await f.registerFixtureData();
        const command = await f.command(action);
        await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
        await f.c0.prepare(command.original.c0);
        const before = [f.writes, f.clocks, f.providerRequests];
        const stored = f.db
          .query("SELECT command_json FROM financial_retained_r1_originals WHERE challenge_ref=?")
          .get(command.key.challengeRef) as { command_json: string };
        const read = await f.store.readBusinessRetainedR1Data(action);
        if (read.status !== "found") throw Error("retained Financial command missing");
        expect(read.fullCommand).toEqual(command);
        expect(read.fullCommandJson).toBe(stored.command_json);
        expect(JSON.parse(read.fullCommandJson)).toEqual(read.fullCommand);
        expect(read.fullCommand.original).toEqual(read.original);
        expect(read.fullCommand.key.challengeRef).toBe(read.original.challengeRef);
        expect(read.fullCommand.r1ReceiptRef).toBe(read.r1ReceiptRef);
        expect(read.fullCommand.original.c0ReceiptRef).toBe(read.c0ReceiptRef);
        expect(read.fullCommand.original.selectedTerms).toEqual(command.original.selectedTerms);
        expect(read.actionIdentity.action).toEqual(action);
        if (action.kind === "plan-change" || action.kind === "cancel") {
          expect(read.actionIdentity.action.kind).not.toBe("subscription-start");
          expect(read.original.economic.kind).toBe(action.kind);
        }
        expect(await f.store.readJoinedRetainedR1Data(command.key.challengeRef)).toEqual(read);
        await expect(
          f.store.readRetainedActionConsentR1(command.key.challengeRef),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
      } finally {
        f.close();
      }
    }
  });

  test("returned full command is detached from the old caller and deeply immutable", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      await f.c0.prepare(command.original.c0);
      const read = await f.store.readBusinessRetainedR1Data(ACTIONS[0]!);
      if (read.status !== "found") throw Error("retained command missing");
      const raw = read.fullCommandJson;
      Object.assign(command.key, { r1Ref: "r1:changed-caller" });
      expect(read.fullCommand).not.toBe(command);
      expect(read.fullCommand.key.r1Ref).not.toBe(command.key.r1Ref);
      expect(Object.isFrozen(read.fullCommand)).toBe(true);
      expect(Object.isFrozen(read.fullCommand.key)).toBe(true);
      expect(Object.isFrozen(read.fullCommand.original.selectedTerms)).toBe(true);
      expect(Reflect.set(read.fullCommand.key, "r1Ref", "r1:mutation-refused")).toBe(false);
      expect(read.fullCommandJson).toBe(raw);
      expect(await f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).toEqual(read);
    } finally {
      f.close();
    }
  });

  test("an unknown historical GET does not emit a command or write and same GET later recovers", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      await f.c0.prepare(command.original.c0);
      const before = [f.writes, f.clocks, f.providerRequests];
      f.unknownQuery();
      await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
        code: "unavailable",
      });
      const read = await f.store.readBusinessRetainedR1Data(ACTIONS[0]!);
      if (read.status !== "found") throw Error("original GET recovery missing");
      expect(read.fullCommand).toEqual(command);
      expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
    } finally {
      f.close();
    }
  });

  test("complete historical absence carries no replacement command or NEW permission", async () => {
    const f = await fixture();
    try {
      const before = [f.writes, f.clocks, f.providerRequests];
      expect(await f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).toEqual({
        status: "not-found",
      });
      expect(await f.store.readJoinedRetainedR1Data("challenge:absent-hosted-source")).toEqual({
        status: "not-found",
      });
      await expect(f.store.prepare(await f.command(ACTIONS[0]!))).rejects.toMatchObject({
        code: "unavailable",
      });
      expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
    } finally {
      f.close();
    }
  });

  test("a retained R1 without its original C0 join cannot supply a full command to Hosted", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
      const before = [f.writes, f.clocks, f.providerRequests];
      await expect(f.store.readBusinessRetainedR1Data(ACTIONS[0]!)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect([f.writes, f.clocks, f.providerRequests]).toEqual(before);
    } finally {
      f.close();
    }
  });

  test("historical C0 image matches the actual stored five-key record", async () => {
    const f = await fixture();
    try {
      await f.registerFixtureData();
      const command = await f.command(ACTIONS[0]!);
      await f.c0.prepare(command.original.c0);
      const rows = await f.sql.query(
        "SELECT record_json FROM financial_preproof_challenges WHERE challenge_ref=?",
        [command.key.challengeRef],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.record_json).toBe(buildFinancialR1HistoricalC0RecordJsonData(command));
      expect(rows[0]?.record_json).not.toBe(canonicalJson(command.original.c0));
    } finally {
      f.close();
    }
  });

  test("an orphan C0 original occupies its saved receipt-ref role", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!);
      const original = f.c0.buildPreparationBatch(command.original.c0, AT)[0];
      if (!original) throw Error("C0 original contribution missing");
      await f.base.batch([original]);
      const receiptRef = command.original.c0ReceiptRef;
      expect(receiptRef).not.toBe(command.key.challengeRef);
      expect(receiptRef).not.toBe(command.key.preparationRef);
      const collision = buildFinancialC0OriginalRoleOccupancyStatementData(receiptRef);
      const occupied = await f.sql.query(collision.sql, collision.params);
      expect(occupied).toHaveLength(1);
      expect(occupied[0]?.hit).toBe(1);
      expect(
        await f.sql.query(
          "SELECT receipt_ref FROM financial_preproof_challenge_receipts WHERE receipt_ref=?",
          [receiptRef],
        ),
      ).toEqual([]);
    } finally {
      f.close();
    }
  });

  test("request-bound historical entry refuses a caller-built connection before request access", async () => {
    let requestAccess = 0;
    const request = new Proxy({} as Request, {
      get() {
        requestAccess++;
        throw new Error("untrusted request getter");
      },
    });
    await expect(
      readFinancialRequestBoundR1History(
        Object.freeze({}) as never,
        request,
        "workspace:test",
        "challenge:unoriginated",
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(requestAccess).toBe(0);
  });
});

test("request-owned R1 consumer rejects a caller-built connection at construction", () => {
  let touched = 0;
  const fake = Object.create(null, {
    query: {
      get() {
        touched++;
        throw Error("caller getter");
      },
    },
  });
  expect(() =>
    createFinancialActionConsentR1Reader(
      fake,
      new Request("https://fixture.invalid"),
      "workspace:test",
    ),
  ).toThrow("unavailable");
  expect(touched).toBe(0);
});
