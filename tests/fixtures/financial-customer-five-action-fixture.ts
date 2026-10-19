import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type {
  RpAuthorityRecord,
  TokenAuthorityRecord,
} from "../../src/credential-authority-class.ts";
import { MIGRATIONS } from "../../src/db-schema.ts";
import { canonicalDigest, canonicalJson } from "../../src/json.ts";
import {
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../../src/money-cutover-sql.ts";
import { type Sql, SqlError } from "../../src/ports.ts";
import { createSharedFinancialActionIdentity } from "../../src/shared-financial-action.ts";
import { customerAdmissionCandidate } from "../../src/shared-financial-admission.ts";
import {
  type ConsentCandidate,
  prepareConsentBatch,
} from "../../src/shared-financial-consent-data.ts";
import {
  createHistoryH0Component,
  type HistoryEnrollment,
  type HistoryRoot,
  type HistoryScope,
} from "../../src/shared-financial-customer-history.ts";
import {
  captureCustomerJournalSnapshot,
  readCompletedCustomerReceipt,
  readCustomerJournalSnapshot,
} from "../../src/shared-financial-customer-journal.ts";
import { parseFinancialIdentityChallenge } from "../../src/shared-financial-source-contract.ts";
import type { SharedPrincipalBinding } from "../../src/shared-principal-authority.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { installFinancial0104Fences } from "../helpers/financial-0104-fenced.ts";

const HERE = new URL("./", import.meta.url).pathname;
const PACKET = new URL("./", import.meta.url).pathname;

const S = (n: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(n).digest("hex")}`;
const names = [
  "shared_customer_challenges",
  "financial_payer_challenge_sources",
  "financial_payer_grants",
  "financial_payer_consent_witnesses",
  "financial_payer_consent_receipts",
  "financial_payer_grant_revocations",
];
const sourceNames = [
  "financial_source_registrations",
  "financial_source_heads",
  "financial_source_events",
  "financial_source_receipts",
];
let fixtureId = 0;
const iso = (v: number) => new Date(v).toISOString();
export async function fixture(
  rp = false,
  file = false,
  challengeHistoryRef = "history:synthetic-unqualified",
) {
  const fileName = file ? `${process.env.TMPDIR}/l1-restart-${++fixtureId}.sqlite` : ":memory:";
  const db = new Database(fileName);
  const sql = createSqliteSql(db);
  for (const m of MIGRATIONS) db.exec(m.sql);
  expect(MIGRATIONS.length).toBe(100);
  db.exec(readFileSync(`${HERE}/root-rp-synthetic-table.sql`, "utf8"));
  db.exec(readFileSync(`${HERE}/root-retained-suffix.sql`, "utf8"));
  db.exec(readFileSync(`${HERE}/shared-financial-source-component-schema.sql`, "utf8"));
  db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
  db.exec(MONEY_CUTOVER_FREEZE_DDL);
  db.exec(
    readFileSync(
      new URL("./financial-five-action-consent-schema.unnumbered.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(readFileSync(`${PACKET}/customer-l1-schema.unnumbered.sql`, "utf8"));
  db.exec(MONEY_CUTOVER_PERMIT_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
  // Consent writes require the exact Financial 0104 consent fences and run only
  // through Root's actual permit-framed Money writer.
  installFinancial0104Fences(db, { consent: true });
  db.exec(readFileSync(`${PACKET}/shared-financial-customer-history-component-schema.sql`, "utf8"));
  db.exec(readFileSync(`${PACKET}/customer-journal-schema.unnumbered.sql`, "utf8"));
  // The Customer L1/H0/journal candidates plus their exact 0104 money fences: the
  // fenced 0104 Customer shape every Customer write requires. Customer rows are
  // therefore written only inside the actual Money writer's permit frame below.
  installFinancial0104Fences(db, { customer: true });
  const money = createMoneyCutoverSql(sql, S("writer"));
  const now = Date.now(),
    created = iso(now - 60000),
    expires = iso(now + 3600000),
    at = iso(now - 1000);
  const challengeCreatedMs = now - 60000,
    challengeExpiresMs = challengeCreatedMs + 300000;
  const owner = "owner:synthetic",
    machine = "broker:synthetic",
    org = "org:synthetic";
  for (const [id, subject] of [
    [owner, "human"],
    [machine, "machine"],
  ] as const) {
    await sql.run(
      "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES(?,?,?,?,?,?)",
      [id, "google", subject, `${subject}@invalid.example`, subject, created],
    );
    await sql.run(
      `INSERT INTO auth_principal_incarnations(principal_id,principal_incarnation,identity_kind,identity_subject,principal_created_at,origin_kind,origin_ref,origin_digest,enrolled_at) VALUES(?,?,?,?,?,'proved-legacy',?,?,?)`,
      [id, `inc:${id}`, "google", subject, created, `origin:${id}`, S(id), created],
    );
  }
  const financialRealm =
    "realm:" +
    (
      await canonicalDigest({
        accountId: "acct_synthetic",
        mode: "test",
        billingAuthority: "authority.synthetic",
      })
    ).slice(7);
  const frozenRealm = {
    accountId: "acct_synthetic",
    financialRealm,
    livemode: false as const,
    billingAuthority: "authority.synthetic",
  };
  await sql.run(`INSERT INTO stripe_mode_realm VALUES(1,'test',?)`, [created]);
  await sql.run(
    `INSERT INTO stripe_billing_account_realms VALUES(1,'acct_synthetic','test','authority.synthetic',?)`,
    [created],
  );
  await sql.run(`INSERT INTO money_cutover_authorized_epoch VALUES(1,?)`, [S("writer")]);
  // Consent and Customer rows share the one actual Money writer for this epoch.
  const consentWriter = money;
  const h0 = await setupH0(money, financialRealm);
  await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at)VALUES(?,?,?,?)", [
    org,
    "synthetic",
    owner,
    created,
  ]);
  await sql.run("INSERT INTO org_memberships(org_id,principal_id,role,created_at)VALUES(?,?,?,?)", [
    org,
    owner,
    "owner",
    created,
  ]);
  const human: SharedPrincipalBinding = {
    ref: "binding:human",
    issuer: "https://issuer.invalid",
    subject: "account:human",
    controllerIncarnation: "controller:1",
    principalId: owner,
    principalIncarnation: `inc:${owner}`,
    targetRef: "target:financial",
    kind: "proved-legacy",
    evidence: { ref: "evidence:human", digest: S("human-binding") },
    previousRef: null,
    enrolledAt: created,
    state: "active",
    terminal: null,
  };
  await sql.run(
    `INSERT INTO shared_principal_bindings(binding_ref,issuer,subject,controller_incarnation,principal_id,principal_incarnation,target_ref,binding_kind,evidence_ref,evidence_digest,previous_binding_ref,enrolled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      human.ref,
      human.issuer,
      human.subject,
      human.controllerIncarnation,
      human.principalId,
      human.principalIncarnation,
      human.targetRef,
      human.kind,
      human.evidence.ref,
      human.evidence.digest,
      null,
      created,
    ],
  );
  // Synthetic broker Principal has its own retained shared binding. The current
  // Root broker predicate requires this row; it is not a genuine enrollment.
  await sql.run(
    `INSERT INTO shared_principal_bindings(binding_ref,issuer,subject,controller_incarnation,principal_id,principal_incarnation,target_ref,binding_kind,evidence_ref,evidence_digest,previous_binding_ref,enrolled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      "binding:broker",
      "https://issuer.invalid",
      "account:broker",
      "controller:broker",
      machine,
      `inc:${machine}`,
      "target:financial",
      "proved-legacy",
      "evidence:broker",
      S("broker-binding"),
      null,
      created,
    ],
  );
  const origin = {
    ref: rp ? "authority:rp" : "authority:broker",
    incarnation: rp ? "credential:rp" : "credential:broker",
    targetRef: "target:financial",
    principalId: rp ? owner : machine,
    principalIncarnation: `inc:${rp ? owner : machine}`,
    issuanceRef: rp ? "issuance:rp" : "issuance:broker",
    issuanceDigest: S(rp ? "issuance:rp" : "issuance:broker"),
    issuedAt: created,
  };
  let credential: TokenAuthorityRecord | RpAuthorityRecord;
  let current: ConsentCandidate["auth"]["current"];
  if (!rp) {
    const token = {
      id: "token:broker",
      digest: S("token:broker"),
      scopesJson: '["payments:write"]',
      createdAt: created,
    };
    await sql.run(
      `INSERT INTO auth_tokens(secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at,revoked_at)VALUES(?,?,'api_key',?,?,?, ?,?,?,NULL)`,
      [token.digest, token.id, machine, org, "synthetic", token.scopesJson, created, expires],
    );
    credential = {
      origin,
      class: "official-shared-broker",
      backend: "auth-token",
      organizationId: org,
      tokenKind: "api_key",
      token,
      state: "active",
      terminal: null,
    };
    current = expires;
    await sql.run(
      `INSERT INTO credential_authority_classes(authority_ref,credential_incarnation,class,backend,target_ref,organization_id,principal_id,principal_incarnation,issuance_ref,issuance_digest,issued_at,token_id,token_digest,token_kind,token_scopes_json,token_created_at)VALUES(?,?,'official-shared-broker','auth-token',?,?,?,?,?,?,?,?,?,'api_key',?,?)`,
      [
        origin.ref,
        origin.incarnation,
        origin.targetRef,
        org,
        machine,
        origin.principalIncarnation,
        origin.issuanceRef,
        origin.issuanceDigest,
        created,
        token.id,
        token.digest,
        token.scopesJson,
        created,
      ],
    );
  } else {
    const session = {
      principalBindingRef: human.ref,
      registrationRef: "rp-registration:synthetic",
      registrationDigest: S("rp-registration"),
      sessionDigest: S("rp-session"),
      sessionCreatedAt: now - 60000,
      enrolledSessionVersion: 1,
      issuer: human.issuer,
      clientId: "client:synthetic",
      subject: human.subject,
      issuerSessionId: "sid:synthetic",
      authTime: now - 60000,
      accountId: human.subject,
      workspaceId: "workspace:synthetic",
      workspaceRef: "workspace-ref:synthetic",
    };
    current = {
      version: 2,
      absoluteExpiresAt: now + 3600000,
      lastUsedAt: now - 1000,
    };
    await sql.run(`INSERT INTO shared_auth_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      session.sessionDigest,
      session.accountId,
      owner,
      session.workspaceId,
      "SYNTHETIC-NO-SECRET",
      session.sessionCreatedAt,
      current.lastUsedAt,
      current.absoluteExpiresAt,
      now - 1000,
      1,
      "active",
    ]);
    credential = {
      origin,
      class: "official-shared-rp-session",
      backend: "shared-rp-session",
      organizationId: org,
      rp: session,
      state: "active",
      terminal: null,
    };
    const row = {
      authority_ref: origin.ref,
      credential_incarnation: origin.incarnation,
      class: credential.class,
      backend: credential.backend,
      target_ref: origin.targetRef,
      organization_id: org,
      principal_id: owner,
      principal_incarnation: origin.principalIncarnation,
      issuance_ref: origin.issuanceRef,
      issuance_digest: origin.issuanceDigest,
      issued_at: created,
      principal_binding_ref: human.ref,
      rp_registration_ref: session.registrationRef,
      rp_registration_digest: session.registrationDigest,
      session_digest: session.sessionDigest,
      session_created_at: session.sessionCreatedAt,
      session_enrolled_version: session.enrolledSessionVersion,
      issuer: session.issuer,
      client_id: session.clientId,
      subject: session.subject,
      issuer_session_id: session.issuerSessionId,
      auth_time: session.authTime,
      account_id: session.accountId,
      workspace_id: session.workspaceId,
      workspace_ref: session.workspaceRef,
    };
    await sql.run(
      `INSERT INTO credential_authority_classes(${Object.keys(row).join(",")})VALUES(${Object.keys(
        row,
      )
        .map(() => "?")
        .join(",")})`,
      Object.values(row),
    );
    await sql.run("UPDATE shared_auth_sessions SET version=2 WHERE digest=?", [
      session.sessionDigest,
    ]);
  }
  const registration = {
    registrationRef: "source:registration",
    incarnation: "source:incarnation",
    genesisDigest: S("genesis"),
    receivers: [{ receiverRef: "receiver:financial", targetRef: "target:financial" }],
  };
  await sql.run(
    `INSERT INTO financial_source_registrations(registration_ref,incarnation,receiver_ref,target_ref,genesis_digest,registration_digest,registration_json,qualification_ref,registered_at)VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      registration.registrationRef,
      registration.incarnation,
      "receiver:financial",
      "target:financial",
      registration.genesisDigest,
      S("registration"),
      JSON.stringify(registration),
      "qualification:synthetic",
      created,
    ],
  );
  for (const affected of ["component:session", "component:workspace"])
    await sql.run(`INSERT INTO financial_source_heads VALUES(?,?,?,?,?,0,?,'active',NULL,?)`, [
      registration.registrationRef,
      registration.incarnation,
      affected,
      "genesis:" + affected,
      created,
      registration.genesisDigest,
      created,
    ]);
  const action = {
    kind: "topup" as const,
    organizationId: org,
    reference: "business:1",
    amountMinor: 100,
  };
  const identity = await createSharedFinancialActionIdentity(action);
  const selectedTerms = {
    revision: "price:original",
    purchaseCreditExpiry: { kind: "none" },
    cashAmountMinor: 100,
  };
  const originalDigest = await canonicalDigest({
    organizationId: org,
    realm: frozenRealm,
    purpose: "hosted_subscription",
  });
  const nativeKey = "takoserver_customer_" + originalDigest.slice(7);
  const nativeRequest = {
    organizationId: org,
    realm: frozenRealm,
    metadata: {
      organizationId: org,
      takoserverPurpose: "hosted_subscription",
      stripeAccountId: "acct_synthetic",
      financialRealm,
      customerCreationCommand: originalDigest,
      customerCreationKey: nativeKey,
    },
  };
  // Existing custody test's independently specified original recipe vector, not a second production derivation.
  const customerOriginal = {
    realmJson: canonicalJson(frozenRealm),
    requestJson: canonicalJson(nativeRequest),
    fingerprint: await canonicalDigest(nativeRequest),
    key: nativeKey,
  };
  const input: ConsentCandidate = {
    challengeRef: "challenge:1",
    actionKind: "topup",
    actionRef: "business:1",
    requestFingerprint: identity.requestFingerprint,
    grantRef: "grant:1",
    grantIncarnation: "grant-inc:1",
    identityProofRef: "identity-proof:1",
    consentRegistrationRef: "consent-registration:synthetic",
    consentIncarnation: "consent-incarnation:1",
    consentRef: "consent-original:1",
    consentProofRef: "consent-proof:1",
    consentDigest: S("consent-original"),
    issuanceAttempt: "attempt:1",
    receiptRef: "consent-receipt:1",
    issuedAt: at,
    auth: { human, credential, current },
  };
  async function challenge(input: ConsentCandidate, count = 2, until = challengeExpiresMs) {
    const original = parseFinancialIdentityChallenge({
      v: 1,
      challengeRef: input.challengeRef,
      registrationRef: registration.registrationRef,
      clientId: "client:synthetic",
      workspaceId: "workspace:synthetic",
      organizationId: org,
      workspaceRef: "workspace-ref:synthetic",
      requestFingerprint: input.requestFingerprint,
      createdAt: challengeCreatedMs,
      expiresAt: until,
    });
    const action = {
      kind: input.actionKind,
      organizationId: org,
      reference: input.actionRef,
      amountMinor: 100,
    };
    const c = {
      challenge_ref: input.challengeRef,
      organization_id: org,
      action_kind: input.actionKind,
      action_ref: input.actionRef,
      request_fingerprint: input.requestFingerprint,
      action_json: canonicalJson(action),
      selection_json: JSON.stringify({
        fixture: "synthetic-original-selection",
        auth: { human: input.auth.human, credential: input.auth.credential },
        selectedTerms: JSON.parse(canonicalJson(selectedTerms)),
        customer: customerOriginal,
      }),
      challenge_json: JSON.stringify(original),
      receiver_ref: "receiver:financial",
      target_ref: "target:financial",
      account_id: "acct_synthetic",
      mode: "test",
      billing_authority: "authority.synthetic",
      financial_realm: financialRealm,
      writer_epoch: S("writer"),
      history_ref: challengeHistoryRef,
      history_digest: S("history-synthetic"),
      source_count: count,
      created_at_ms: original.createdAt,
      expires_at_ms: original.expiresAt,
    };
    await consentWriter.run(
      `INSERT INTO shared_customer_challenges(${Object.keys(c).join(",")})VALUES(${Object.keys(c)
        .map(() => "?")
        .join(",")})`,
      Object.values(c),
    );
    for (const affected of ["component:session", "component:workspace"])
      await consentWriter.run(
        `INSERT INTO financial_payer_challenge_sources VALUES(?,?,?,?,?,?,?,?,?,?,0,?,NULL)`,
        [
          input.challengeRef,
          registration.registrationRef,
          registration.incarnation,
          affected,
          S("registration"),
          "qualification:synthetic",
          registration.genesisDigest,
          "genesis:" + affected,
          "receiver:financial",
          "target:financial",
          registration.genesisDigest,
        ],
      );
  }
  await challenge(input);
  await consentWriter.batch(prepareConsentBatch(input, org));
  const admission = await customerAdmissionCandidate(
    { action, consent: input, selectedTerms },
    identity,
    customerOriginal,
    at,
  );
  const journal = await seedJournal(sql, money, org, customerOriginal.realmJson, h0, at);
  const snapshot = async (tables = names) => {
    const rows: Record<string, unknown> = {};
    for (const table of tables)
      rows[table] = await sql.query(`SELECT * FROM ${table} ORDER BY rowid`);
    return rows;
  };
  const history = await snapshot([
    "principals",
    "orgs",
    "org_memberships",
    "auth_tokens",
    ...sourceNames,
  ]);
  const close = () => {
    db.close();
    if (file && existsSync(fileName)) unlinkSync(fileName);
  };
  return {
    db,
    sql,
    consentWriter,
    money,
    input,
    org,
    created,
    expires,
    at,
    challengeCreatedMs,
    challengeExpiresMs,
    registration,
    challenge,
    snapshot,
    history,
    fileName,
    close,
    action,
    identity,
    selectedTerms,
    original: customerOriginal,
    admission,
    journal,
  };
}

async function setupH0(sql: Sql, financialRealm: string) {
  const root: HistoryRoot = {
    primaryRef: "primary:synthetic",
    primaryIncarnation: "primary-inc:1",
    physicalBindingRef: "binding:fixture",
    physicalBindingIncarnation: "binding-inc:1",
    resourceRef: "resource:fixture",
    lineageEvidenceRef: "lineage:fixture",
    qualificationRef: "qualification:synthetic-unmounted",
    profileRef: "profile:all-writers-fixture",
    accountId: "acct_synthetic",
    mode: "test",
    billingAuthority: "authority.synthetic",
    financialRealm,
    writerEpoch: S("writer"),
  };
  const scope = (kind: HistoryScope["scopeKind"], ref: string): HistoryScope => ({
    scopeKind: kind,
    originalScopeRef: ref,
    originalScopeIncarnation: `inc:${ref}`,
    sourceRegistrationRef: "registration:synthetic",
    sourceIncarnation: "source-inc:1",
    sourceHeadRef: `head:${ref}`,
    sourceSequence: 1,
    evidenceRef: `evidence:${ref}`,
    evidenceDigest: S(ref),
    fenceRef: kind === "writer" || kind === "credential-alias" ? `fence:${ref}` : null,
    drainRef: kind === "writer" ? `drain:${ref}` : null,
    drainDisposition: kind === "writer" ? "retained-original" : "not-applicable",
    ownerPrincipalId: null,
    orgCreatedAt: null,
  });
  const run: HistoryEnrollment = {
    enrollmentRef: "enrollment:1",
    enrollmentIncarnation: "enrollment-inc:1",
    generation: 1,
    startReceiptRef: "receipt:start1",
    sealReceiptRef: "receipt:seal1",
    previousStartReceiptRef: null,
    previousSealRef: null,
    required: [
      {
        ...scope("physical-primary", root.primaryRef),
        originalScopeIncarnation: root.primaryIncarnation,
      },
      ...[
        "customer",
        "topup",
        "subscription",
        "plan",
        "card",
        "on-demand",
        "legacy-settlement",
        "events",
      ].map((x) => scope("writer", x)),
      scope("credential-alias", "alias:current"),
      scope("credential-alias", "alias:retired"),
    ],
  };
  const h0 = createHistoryH0Component(sql);
  await h0.start(root, run);
  for (const [i, item] of run.required.entries())
    await h0.inventory(root, run, item, `inventory:${i}`);
  await h0.seal(root, run, 0);
  return { root, run };
}
async function seedJournal(
  sql: Sql,
  money: Sql,
  org: string,
  realmJson: string,
  h0: Awaited<ReturnType<typeof setupH0>>,
  at: string,
) {
  // Synthetic local graph, not genuine H0/profile/primary enrollment or an H1 issuer.
  const birth = (
    await sql.query(
      "SELECT birth_ref FROM financial_customer_history_birth_observations WHERE org_id=? AND phase='post-seal'",
      [org],
    )
  )[0];
  if (!birth || typeof birth.birth_ref !== "string")
    throw new Error("actual H0 post-seal birth missing");
  const historyRef = "history:synthetic-unqualified",
    genesis = "history-entry:genesis",
    receipt = "history-receipt:genesis";
  await money.run(
    `INSERT INTO financial_customer_history_coverages(history_ref,coverage_incarnation,attempt_ref,expected_receipt_ref,coverage_kind,original_org_origin,organization_id,primary_ref,enrollment_ref,complete_seal_ref,seal_kind,realm_registration,realm_incarnation,realm_json,required_scopes_json,writer_epoch,previous_history_ref,created_at)
    VALUES(?,?,?,?,'qualified-genesis',?,?,?,?,?,'complete-seal',?,?,?,?,?,NULL,?)`,
    [
      historyRef,
      "history-inc:1",
      "history-attempt:genesis",
      receipt,
      birth.birth_ref,
      org,
      h0.root.primaryRef,
      h0.run.enrollmentRef,
      h0.run.sealReceiptRef,
      "realm-registration:synthetic",
      "realm-inc:1",
      realmJson,
      canonicalJson(h0.run.required),
      S("writer"),
      at,
    ],
  );
  for (const [i, item] of h0.run.required.entries())
    await money.run(
      `INSERT INTO financial_customer_history_scopes(scope_ref,history_ref,inventory_ref,scope_kind,original_scope_ref,original_scope_incarnation,evidence_json) VALUES(?,?,?,?,?,?,?)`,
      [
        `scope:${i}`,
        historyRef,
        `inventory:${i}`,
        item.scopeKind,
        item.originalScopeRef,
        item.originalScopeIncarnation,
        canonicalJson(item),
      ],
    );
  await money.run(
    `INSERT INTO financial_customer_history_entries(entry_ref,history_ref,journal_sequence,ordinal,writer_kind,evidence_kind,transition_ref,coupling_attempt_ref,expected_history_receipt_ref,command_before_exists,binding_before_exists,binding_after_exists,recorded_at)
    VALUES(?,?,0,0,'customer-custody','genesis',?,?,?,0,0,0,?)`,
    [genesis, historyRef, receipt, "history-attempt:genesis", receipt, at],
  );
  await money.run(`INSERT INTO financial_customer_history_heads VALUES(?,?,?,?,0,?,?,'active')`, [
    birth.birth_ref,
    "realm-registration:synthetic",
    "realm-inc:1",
    historyRef,
    genesis,
    receipt,
  ]);
  await money.run(
    `INSERT INTO financial_customer_history_receipts(receipt_ref,attempt_ref,history_ref,journal_sequence,original_org_origin,realm_registration,realm_incarnation,entry_ref,evidence_kind,all_rows_match,created_at)
    VALUES(?,?,?,0,?,?,?,?,'genesis',1,?)`,
    [
      receipt,
      "history-attempt:genesis",
      historyRef,
      birth.birth_ref,
      "realm-registration:synthetic",
      "realm-inc:1",
      genesis,
      at,
    ],
  );
  const snapshot = await readCustomerJournalSnapshot(sql, {
    organizationId: org,
    realmRegistration: "realm-registration:synthetic",
    realmIncarnation: "realm-inc:1",
  });
  if (!snapshot) throw new Error("synthetic journal incomplete");
  return snapshot;
}
