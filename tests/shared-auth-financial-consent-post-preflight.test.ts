import { expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";

// Actual Financial 7702 reader and RP GET/POST source with synthetic external
// Root/issuer/Clock and an in-memory SQLite origin. Not genuine Auth103 or D1.
const child = process.env.RP_CONSENT_POST_PREFLIGHT_CHILD === "1";
if (child) {
  type Fixture = Awaited<
    ReturnType<typeof import("./fixtures/financial-r1-request-reader-fixture.ts")["fixture"]>
  >;
  type Handler = ReturnType<
    typeof import("../src/shared-auth-financial-consent.ts")["createSharedAuthFinancialConsentRequestHandler"]
  >;
  let f: Fixture;
  let connection: WorkerRequestSql;
  let inputs: object;
  let graph: object;
  let context: object;
  let port: object;
  let retained: object;
  let record: object;
  let current: object;
  let human: object;
  let anchor: object;
  let clockCalls = 0;
  let observerCalls = 0;
  let proofCalls = 0;
  let proofEntries = 0;
  let proofGetterCalls = 0;
  let proofMode: "success" | "unknown" | "malformed" | "expire-after" = "success";
  let proofCapture: unknown;
  let loadCalls = 0;
  let currentCalls = 0;
  let evidenceMode: "success" | "load-unknown" | "crossed-subject" | "expire-after-current" =
    "success";
  let activeChallenge: Readonly<{
    registrationRef: string;
    workspaceId: string;
    createdAt: number;
  }> = { registrationRef: "", workspaceId: "", createdAt: 0 };
  const provedCaptures = new WeakSet<object>();
  const loadedCaptures = new WeakSet<object>();
  const OIDC = Object.freeze({
    issuer: "https://auth.example.test",
    clientId: "client:test",
    subject: "account_original",
    sessionId: "oidc_sid",
    authTime: 1,
  });
  const ref = (name: string) => `${name}:fixture`;
  const pin = (name: string, sequence: number) => ({
    registrationRef: activeChallenge.registrationRef,
    incarnation: ref(`${name}-incarnation`),
    affectedRef: ref(`${name}-affected`),
    sequence,
    eventRef: ref(`${name}-event`),
    eventDigest: `sha256:${"a".repeat(64)}`,
  });
  // Accounts found/current DATA as the named RPC returns it for the held proof.
  const proofData = (status: "found" | "current") => {
    const issuedAt = activeChallenge.createdAt;
    const proof = {
      v: 1,
      proofRef: "proof:from-original",
      challenge: activeChallenge,
      issuer: OIDC.issuer,
      subject: evidenceMode === "crossed-subject" && status === "current" ? "other" : OIDC.subject,
      clientId: OIDC.clientId,
      sid: OIDC.sessionId,
      issuerSessionId: "accounts_issuer_session",
      identityGeneration: 0,
      control: {
        evidenceRef: ref("control-evidence"),
        evidenceDigest: `sha256:${"b".repeat(64)}`,
        expiresAt: issuedAt + 60_000,
        source: {
          registrationRef: ref("control-registration"),
          incarnation: ref("control-incarnation"),
          affectedRef: activeChallenge.workspaceId,
          sequence: 0,
          eventRef: null,
          eventDigest: `sha256:${"c".repeat(64)}`,
          receivers: [{ receiverRef: ref("receiver"), targetRef: ref("target") }],
        },
      },
      parents: {
        grant: pin("grant", 1),
        issuerSession: pin("issuer-session", 1),
        client: pin("client", 1),
        accountGeneration: pin("account-generation", 1),
      },
      issuedAt,
      expiresAt: issuedAt + 60_000,
    };
    return status === "found"
      ? { v: 1, status, proof }
      : { v: 1, status, proof, observedAt: issuedAt + 1 };
  };
  const requireHeldProofCapture = (
    value: unknown,
    request: unknown,
    workspaceId: unknown,
    challengeRef: unknown,
    capture: unknown,
  ) => {
    requireConnection(value);
    if (
      !(request instanceof Request) ||
      workspaceId !== SCOPE.workspaceId ||
      challengeRef !== activeChallengeRef ||
      captures.get(request)?.credential !== capture ||
      !provedCaptures.has(capture as object)
    )
      throw Error("crossed retained RP proof read");
  };
  let dbNow = 0;
  let active = false;
  const captures = new WeakMap<Request, Readonly<{ credential: object; userBinding: object }>>();
  const sourceClock = () => new Date(Date.parse("2026-10-15T00:00:00.000Z") + ++clockCalls * 1_000);
  const clockOriginal = Object.freeze({ clock: sourceClock });
  const requireConnection = (value: unknown) => {
    if (!active || value !== connection) throw Error("foreign connection");
  };
  mock.module("../src/auth103-source-clock.ts", () => ({
    readAuth103SourceClock(clock: unknown) {
      return clock === sourceClock ? clockOriginal : null;
    },
  }));
  mock.module("../src/worker-request-composition.ts", () => ({
    readWorkerRequestFinancialInputs(value: unknown) {
      requireConnection(value);
      return inputs;
    },
    readWorkerRequestConsumers(value: unknown) {
      requireConnection(value);
      return graph;
    },
    readWorkerRequestRetainedRpCapture(value: unknown, capture: unknown) {
      requireConnection(value);
      if (![...requests].some((request) => captures.get(request)?.credential === capture))
        throw Error("foreign capture");
      return retained;
    },
    async proveWorkerRequestRetainedRpFinancialIdentityOriginal(
      value: unknown,
      request: unknown,
      workspaceId: unknown,
      challengeRef: unknown,
      capture: unknown,
    ) {
      proofEntries++;
      requireConnection(value);
      if (
        !(request instanceof Request) ||
        workspaceId !== SCOPE.workspaceId ||
        challengeRef !== activeChallengeRef ||
        captures.get(request)?.credential !== capture
      )
        throw Error("crossed retained RP proof capture");
      proofCalls++;
      proofCapture = capture;
      provedCaptures.add(capture as object);
      if (proofMode === "unknown") throw Error("unknown proof ACK");
      if (proofMode === "expire-after") dbNow = Date.parse(AT) + 301_000;
      if (proofMode === "malformed") {
        const response = {};
        Object.defineProperty(response, "proofRef", {
          enumerable: true,
          get() {
            proofGetterCalls++;
            return "proof:forged";
          },
        });
        return response;
      }
      return Object.freeze({ proofRef: "proof:from-original" });
    },
    async loadWorkerRequestRetainedRpFinancialIdentityProofOriginal(
      value: unknown,
      request: unknown,
      workspaceId: unknown,
      challengeRef: unknown,
      capture: unknown,
    ) {
      requireHeldProofCapture(value, request, workspaceId, challengeRef, capture);
      loadCalls++;
      loadedCaptures.add(capture as object);
      if (evidenceMode === "load-unknown") throw Error("unknown load ACK");
      return proofData("found");
    },
    async verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal(
      value: unknown,
      request: unknown,
      workspaceId: unknown,
      challengeRef: unknown,
      capture: unknown,
    ) {
      requireHeldProofCapture(value, request, workspaceId, challengeRef, capture);
      if (!loadedCaptures.has(capture as object)) throw Error("current before load");
      currentCalls++;
      if (evidenceMode === "expire-after-current") dbNow = Date.parse(AT) + 301_000;
      return proofData("current");
    },
  }));
  const requests = new Set<Request>();
  let activeChallengeRef = "";
  mock.module("../src/financial-auth-consumer.ts", () => ({
    readWorkerRequestFinancialAuthConsumerPort(value: unknown) {
      requireConnection(value);
      return port;
    },
    readWorkerRequestFinancialAuthConsumerContext(value: unknown, selected: unknown) {
      requireConnection(value);
      if (selected !== port) throw Error("foreign port");
      return context;
    },
    assertWorkerRequestFinancialAuthConsumerPort(value: unknown, selected: unknown) {
      requireConnection(value);
      if (selected !== port) throw Error("foreign port");
    },
    assertFinancialAuthConsumerPort(selected: unknown, original: unknown) {
      if (selected !== port || original !== context) throw Error("foreign context");
    },
    async captureWorkerRequestFinancialAuthRpRequest(
      selected: unknown,
      request: unknown,
      workspaceId: unknown,
    ) {
      if (selected !== port || !(request instanceof Request) || workspaceId !== "workspace:test")
        throw Error("crossed Root request");
      observerCalls++;
      const original = Object.freeze({
        credential: Object.freeze({}),
        userBinding: Object.freeze({}),
      });
      captures.set(request, original);
      requests.add(request);
      return original;
    },
    financialAuthConsumerSourceCurrentness(selected: unknown, original: unknown) {
      if (selected !== port || original !== context) throw Error("foreign Root source");
      return { sql: "?=1", params: [1] };
    },
  }));
  const issuer = Object.freeze({
    registrationRef: "rp_consent_registration",
    registrationDigest: `sha256:${"b".repeat(64)}`,
    incarnation: "consent_incarnation",
  });
  mock.module("../src/shared-auth-financial-consent-issuer.ts", () => ({
    createSharedAuthFinancialConsentIssuerSource(value: unknown) {
      requireConnection(value);
      return Object.freeze({
        async readCurrentOriginal() {
          return issuer;
        },
        async currentness() {
          return { original: issuer, sql: "?=1", params: [1] };
        },
      });
    },
  }));

  const { fixture, ACTIONS, SCOPE, AT, EPOCH } = await import(
    "./fixtures/financial-r1-request-reader-fixture.ts"
  );
  const { buildFinancialR1MechanicalBatch } = await import(
    "../src/shared-financial-retained-r1.ts"
  );
  const { sharedAuthFinancialConsentLeafStatements } = await import(
    "../src/shared-auth-financial-consent-schema-plan.ts"
  );
  const { createSharedAuthFinancialConsentRequestHandler } = await import(
    "../src/shared-auth-financial-consent.ts"
  );
  const action = (() => {
    const found = ACTIONS.find((item) => item.kind === "topup");
    if (!found) throw Error("missing topup");
    return found;
  })();
  const url = "https://rp.example.invalid/financial/consent";
  const get = () => new Request(url, { method: "GET" });
  const post = (transactionRef: string, origin: string | null = new URL(url).origin) =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(origin === null ? {} : { origin }),
      },
      body: new URLSearchParams({ approve: "yes", confirmation_transaction: transactionRef }),
    });
  const insert = (table: string, value: Record<string, string | number | null>) => {
    const names = Object.keys(value);
    f.db
      .query(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
      .run(...Object.values(value));
  };
  async function setup(): Promise<{ handler: Handler; challengeRef: string; close: () => void }> {
    f = await fixture();
    active = true;
    connection = Object.create(null) as WorkerRequestSql;
    Object.defineProperty(connection, "sql", { value: f.sql, enumerable: true });
    clockCalls = 0;
    observerCalls = 0;
    proofCalls = 0;
    proofEntries = 0;
    proofGetterCalls = 0;
    proofMode = "success";
    proofCapture = undefined;
    loadCalls = 0;
    currentCalls = 0;
    evidenceMode = "success";
    requests.clear();
    const principalId = "principal:fixture";
    const principalIncarnation = "principal-incarnation:fixture";
    const subject = "account_original";
    const created = new Date(Date.parse(AT) - 10_000).toISOString();
    human = Object.freeze({
      ref: "human_binding",
      issuer: "https://auth.example.test",
      subject,
      controllerIncarnation: "controller_incarnation",
      principalId,
      principalIncarnation,
      targetRef: "auth_target",
      kind: "fresh-shared",
      evidence: Object.freeze({ ref: "human_evidence", digest: `sha256:${"c".repeat(64)}` }),
      previousRef: null,
      enrolledAt: created,
      state: "active",
      terminal: null,
    });
    record = Object.freeze({
      state: "active",
      terminal: null,
      class: "official-shared-rp-session",
      backend: "shared-rp-session",
      organizationId: "org:credential-row-A",
      origin: Object.freeze({
        ref: "authority",
        incarnation: "credential_incarnation",
        targetRef: "auth_target",
        principalId,
        principalIncarnation,
        issuanceRef: "issuance_original",
        issuanceDigest: `sha256:${"d".repeat(64)}`,
        issuedAt: created,
      }),
      rp: Object.freeze({
        principalBindingRef: "human_binding",
        registrationRef: "rp_registration",
        registrationDigest: `sha256:${"e".repeat(64)}`,
        sessionDigest: `sha256:${"f".repeat(64)}`,
        sessionCreatedAt: Date.parse(AT) - 5_000,
        enrolledSessionVersion: 3,
        issuer: "https://auth.example.test",
        clientId: "client:test",
        subject,
        issuerSessionId: "issuer_session",
        authTime: Date.parse(AT) - 8_000,
        accountId: subject,
        workspaceId: "row_workspace_A",
        workspaceRef: "row_ref_A",
      }),
    });
    current = Object.freeze({
      version: 7,
      absoluteExpiresAt: Date.parse(AT) + 600_000,
      lastUsedAt: Date.parse(AT) - 100,
    });
    anchor = Object.freeze({});
    retained = Object.freeze({
      record,
      current,
      finalSession: Object.freeze({
        selectedWorkspaceId: SCOPE.workspaceId,
        principalId,
        identity: OIDC,
      }),
      selectedScope: Object.freeze({
        organizationId: SCOPE.organizationId,
        workspaceId: SCOPE.workspaceId,
        workspaceRef: SCOPE.workspaceRef,
      }),
    });
    port = Object.freeze({
      readValidatedCredential(capture: unknown) {
        if (![...requests].some((request) => captures.get(request)?.credential === capture))
          throw Error("foreign credential");
        return { backend: "shared-rp-session", record, current };
      },
      readValidatedPrincipalBinding(capture: unknown) {
        if (![...requests].some((request) => captures.get(request)?.userBinding === capture))
          throw Error("foreign human");
        return { anchor, binding: human };
      },
    });
    inputs = Object.freeze({
      sql: f.sql,
      client: f.client,
      realm: f.options.realm,
      clock: sourceClock,
      writerEpoch: EPOCH,
    });
    context = Object.freeze({ sql: f.sql, realm: f.options.realm, writerEpoch: EPOCH });
    graph = Object.freeze({
      sql: f.sql,
      client: f.client,
      realm: f.options.realm,
      sharedAuth: Object.freeze({
        observeFinalWorkspaceOrganization() {
          throw Error("not invoked");
        },
        finalSessionSelection() {
          throw Error("not invoked");
        },
      }),
    });
    f.db.exec(`
CREATE TABLE auth_principal_incarnations (principal_id TEXT NOT NULL,principal_incarnation TEXT NOT NULL,state TEXT NOT NULL,identity_kind TEXT NOT NULL,identity_subject TEXT NOT NULL,principal_created_at TEXT NOT NULL,origin_kind TEXT NOT NULL,identity_authority_body TEXT,identity_authority_digest TEXT,PRIMARY KEY(principal_id,principal_incarnation));
CREATE TABLE shared_principal_bindings (binding_ref TEXT PRIMARY KEY NOT NULL,principal_id TEXT NOT NULL,principal_incarnation TEXT NOT NULL,state TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,controller_incarnation TEXT NOT NULL,target_ref TEXT NOT NULL,evidence_ref TEXT NOT NULL,evidence_digest TEXT NOT NULL,binding_kind TEXT NOT NULL,UNIQUE(binding_ref,principal_id,principal_incarnation),FOREIGN KEY(principal_id,principal_incarnation) REFERENCES auth_principal_incarnations(principal_id,principal_incarnation) ON DELETE RESTRICT);
CREATE TABLE credential_authority_classes (authority_ref TEXT PRIMARY KEY NOT NULL,credential_incarnation TEXT NOT NULL UNIQUE,principal_id TEXT NOT NULL,principal_incarnation TEXT NOT NULL,principal_binding_ref TEXT NOT NULL,target_ref TEXT NOT NULL,backend TEXT NOT NULL,class TEXT NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,workspace_ref TEXT NOT NULL,state TEXT NOT NULL,issuance_ref TEXT NOT NULL,issuance_digest TEXT NOT NULL,rp_registration_ref TEXT NOT NULL,rp_registration_digest TEXT NOT NULL,session_digest TEXT NOT NULL,session_created_at INTEGER NOT NULL,session_enrolled_version INTEGER NOT NULL,issuer TEXT NOT NULL,client_id TEXT NOT NULL,subject TEXT NOT NULL,issuer_session_id TEXT NOT NULL,auth_time INTEGER NOT NULL,account_id TEXT NOT NULL);
CREATE TABLE shared_auth_sessions (digest TEXT PRIMARY KEY NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,account_id TEXT NOT NULL,principal_id TEXT NOT NULL,workspace_id TEXT NOT NULL,absolute_expires_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,grant_checked_at INTEGER NOT NULL);
`);
    insert("principals", {
      id: principalId,
      provider: "google",
      provider_subject: subject,
      email: "fixture@example.invalid",
      display_name: "fixture",
      created_at: created,
    });
    insert("auth_principal_incarnations", {
      principal_id: principalId,
      principal_incarnation: principalIncarnation,
      state: "active",
      identity_kind: "google",
      identity_subject: subject,
      principal_created_at: created,
      origin_kind: "fresh-shared",
      identity_authority_body: null,
      identity_authority_digest: null,
    });
    insert("shared_principal_bindings", {
      binding_ref: "human_binding",
      principal_id: principalId,
      principal_incarnation: principalIncarnation,
      state: "active",
      issuer: "https://auth.example.test",
      subject,
      controller_incarnation: "controller_incarnation",
      target_ref: "auth_target",
      evidence_ref: "human_evidence",
      evidence_digest: `sha256:${"c".repeat(64)}`,
      binding_kind: "fresh-shared",
    });
    insert("credential_authority_classes", {
      authority_ref: "authority",
      credential_incarnation: "credential_incarnation",
      principal_id: principalId,
      principal_incarnation: principalIncarnation,
      principal_binding_ref: "human_binding",
      target_ref: "auth_target",
      backend: "shared-rp-session",
      class: "official-shared-rp-session",
      organization_id: "org:credential-row-A",
      workspace_id: "row_workspace_A",
      workspace_ref: "row_ref_A",
      state: "active",
      issuance_ref: "issuance_original",
      issuance_digest: `sha256:${"d".repeat(64)}`,
      rp_registration_ref: "rp_registration",
      rp_registration_digest: `sha256:${"e".repeat(64)}`,
      session_digest: `sha256:${"f".repeat(64)}`,
      session_created_at: Date.parse(AT) - 5_000,
      session_enrolled_version: 3,
      issuer: "https://auth.example.test",
      client_id: "client:test",
      subject,
      issuer_session_id: "issuer_session",
      auth_time: Date.parse(AT) - 8_000,
      account_id: subject,
    });
    insert("shared_auth_sessions", {
      digest: `sha256:${"f".repeat(64)}`,
      created_at: Date.parse(AT) - 5_000,
      status: "active",
      version: 7,
      account_id: subject,
      principal_id: principalId,
      workspace_id: "row_workspace_A",
      absolute_expires_at: Date.parse(AT) + 600_000,
      last_used_at: Date.parse(AT) - 100,
      grant_checked_at: Date.parse(AT) - 200,
    });
    for (const statement of sharedAuthFinancialConsentLeafStatements()) f.db.exec(statement.sql);
    await f.base.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
      SCOPE.organizationId,
      "fixture",
      principalId,
      AT,
    ]);
    await f.base.run("INSERT INTO org_memberships VALUES(?,?,?,?)", [
      SCOPE.organizationId,
      principalId,
      "owner",
      AT,
    ]);
    await f.base.run("INSERT INTO org_wallet_workspace_bindings VALUES(?,?,?)", [
      SCOPE.workspaceRef,
      SCOPE.organizationId,
      AT,
    ]);
    const command = await f.command(action, action.kind);
    activeChallengeRef = command.key.challengeRef;
    activeChallenge = command.original.c0.challenge;
    await f.registerFixtureData();
    await f.c0.prepare(command.original.c0);
    await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
    dbNow = Date.parse(AT) + 2_000;
    const originalQuery = f.db.query.bind(f.db);
    Object.defineProperty(f.db, "query", {
      configurable: true,
      value: (sql: string) => {
        const now = new Date(dbNow).toISOString();
        return originalQuery(
          sql
            .replaceAll("strftime('%s','now')", `strftime('%s','${now}')`)
            .replaceAll("strftime('%f','now')", `strftime('%f','${now}')`),
        );
      },
    });
    return {
      handler: createSharedAuthFinancialConsentRequestHandler(connection),
      challengeRef: command.key.challengeRef,
      close: () => {
        active = false;
        f.close();
      },
    };
  }
  async function prepared(handler: Handler, challengeRef: string) {
    return handler.prepareFinancialR1ConsentView(get(), SCOPE.workspaceId, challengeRef);
  }
  const writes = () => f.writes;
  const consentWrites = () =>
    f.db
      .query(
        "SELECT (SELECT count(*) FROM shared_auth_financial_consent_pending) AS pending,(SELECT count(*) FROM shared_auth_financial_consent_commands) AS command,(SELECT count(*) FROM shared_auth_financial_consent_originals) AS original",
      )
      .get();

  test("actual R1 and RP POST preflight reads pending only with one held Clock", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const before = {
        writes: writes(),
        rows: consentWrites(),
        observer: observerCalls,
        clock: clockCalls,
      };
      const submission = await s.handler.readPreparedFinancialR1SubmissionData(
        post(view.transactionRef),
        SCOPE.workspaceId,
        s.challengeRef,
      );
      expect(submission.pending.transaction_ref).toBe(view.transactionRef);
      expect(submission.submission.transactionRef).toBe(view.transactionRef);
      expect({ writes: writes(), rows: consentWrites() }).toEqual({
        writes: before.writes,
        rows: before.rows,
      });
      expect(observerCalls - before.observer).toBe(1);
      expect(clockCalls - before.clock).toBe(1);
    } finally {
      s.close();
    }
  });

  test("separate proof continuation uses the same prepared Request and held opaque capture", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const request = post(view.transactionRef);
      const before = { writes: writes(), observer: observerCalls, clock: clockCalls };
      const submission = await s.handler.readPreparedFinancialR1SubmissionData(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
      );
      expect(proofCalls).toBe(0);
      const proof = await s.handler.provePreparedFinancialR1Identity(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
        submission,
      );
      expect(proof).toEqual({ proofRef: "proof:from-original" });
      expect(proofCalls).toBe(1);
      expect(proofCapture).toBe(captures.get(request)?.credential);
      expect(observerCalls - before.observer).toBe(1);
      expect(clockCalls - before.clock).toBe(1);
      expect(writes()).toBe(before.writes);
    } finally {
      s.close();
    }
  });

  test("proof continuation rejects cloned result, other Request and handler before dispatch", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const request = post(view.transactionRef);
      const submission = await s.handler.readPreparedFinancialR1SubmissionData(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
      );
      await expect(
        s.handler.provePreparedFinancialR1Identity(request, SCOPE.workspaceId, s.challengeRef, {
          ...submission,
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(
        s.handler.provePreparedFinancialR1Identity(
          post(view.transactionRef),
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      const other = createSharedAuthFinancialConsentRequestHandler(connection);
      await expect(
        other.provePreparedFinancialR1Identity(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(proofEntries).toBe(0);
    } finally {
      s.close();
    }
  });

  test("pre-dispatch currentness failure never reaches Root proof and stays sticky", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const request = post(view.transactionRef);
      const submission = await s.handler.readPreparedFinancialR1SubmissionData(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
      );
      const before = writes();
      dbNow = Date.parse(AT) + 301_000;
      await expect(
        s.handler.provePreparedFinancialR1Identity(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      dbNow = Date.parse(AT) + 2_000;
      await expect(
        s.handler.provePreparedFinancialR1Identity(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(proofEntries).toBe(0);
      expect(writes()).toBe(before);
    } finally {
      s.close();
    }
  });

  test("unknown proof ACK is sticky for the same prepared original", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const request = post(view.transactionRef);
      const submission = await s.handler.readPreparedFinancialR1SubmissionData(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
      );
      proofMode = "unknown";
      const first = s.handler.provePreparedFinancialR1Identity(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
        submission,
      );
      const second = s.handler.provePreparedFinancialR1Identity(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
        submission,
      );
      expect(second).toBe(first);
      await expect(first).rejects.toMatchObject({ code: "unavailable" });
      expect(proofCalls).toBe(1);
    } finally {
      s.close();
    }
  });

  test("malformed proof getter and failed post-effect currentness cannot grant or resend", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const request = post(view.transactionRef);
      const submission = await s.handler.readPreparedFinancialR1SubmissionData(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
      );
      proofMode = "malformed";
      await expect(
        s.handler.provePreparedFinancialR1Identity(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(proofGetterCalls).toBe(0);
      expect(proofCalls).toBe(1);
      await expect(
        s.handler.provePreparedFinancialR1Identity(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(proofCalls).toBe(1);
    } finally {
      s.close();
    }
    const next = await setup();
    try {
      const view = await prepared(next.handler, next.challengeRef);
      const request = post(view.transactionRef);
      const submission = await next.handler.readPreparedFinancialR1SubmissionData(
        request,
        SCOPE.workspaceId,
        next.challengeRef,
      );
      proofMode = "expire-after";
      await expect(
        next.handler.provePreparedFinancialR1Identity(
          request,
          SCOPE.workspaceId,
          next.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(proofCalls).toBe(1);
      await expect(
        next.handler.provePreparedFinancialR1Identity(
          request,
          SCOPE.workspaceId,
          next.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(proofCalls).toBe(1);
    } finally {
      next.close();
    }
  });

  async function provedSubmission(s: Awaited<ReturnType<typeof setup>>) {
    const view = await prepared(s.handler, s.challengeRef);
    const request = post(view.transactionRef);
    const submission = await s.handler.readPreparedFinancialR1SubmissionData(
      request,
      SCOPE.workspaceId,
      s.challengeRef,
    );
    return { request, submission };
  }

  test("identity evidence joins the prepared proof's own load/current in actual Financial", async () => {
    const s = await setup();
    try {
      const { request, submission } = await provedSubmission(s);
      const before = { writes: writes(), observer: observerCalls, clock: clockCalls };
      await s.handler.provePreparedFinancialR1Identity(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
        submission,
      );
      const evidence = s.handler.readPreparedFinancialR1IdentityEvidence(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
        submission,
      );
      expect(
        s.handler.readPreparedFinancialR1IdentityEvidence(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).toBe(evidence);
      const joined = await evidence;
      expect(joined).toMatchObject({
        kind: "financial-proof",
        proofRef: "proof:from-original",
        registrationRef: SCOPE.registrationRef,
        identityGeneration: 0,
      });
      expect(joined.sourceParentPins).toHaveLength(4);
      expect(Object.isFrozen(joined)).toBe(true);
      expect([proofCalls, loadCalls, currentCalls]).toEqual([1, 1, 1]);
      expect(observerCalls - before.observer).toBe(0);
      expect(clockCalls - before.clock).toBe(0);
      expect(writes()).toBe(before.writes);
    } finally {
      s.close();
    }
  });

  test("identity evidence never proves itself and rejects a cloned prepared result", async () => {
    const s = await setup();
    try {
      const { request, submission } = await provedSubmission(s);
      await expect(
        s.handler.readPreparedFinancialR1IdentityEvidence(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      await s.handler.provePreparedFinancialR1Identity(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
        submission,
      );
      await expect(
        s.handler.readPreparedFinancialR1IdentityEvidence(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          {
            ...submission,
          },
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect([proofEntries, loadCalls, currentCalls]).toEqual([1, 0, 0]);
    } finally {
      s.close();
    }
  });

  test("unknown load and a crossed current subject stay sticky without resend", async () => {
    for (const mode of ["load-unknown", "crossed-subject"] as const) {
      const s = await setup();
      try {
        const { request, submission } = await provedSubmission(s);
        await s.handler.provePreparedFinancialR1Identity(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        );
        evidenceMode = mode;
        const first = s.handler.readPreparedFinancialR1IdentityEvidence(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        );
        await expect(first).rejects.toMatchObject({ code: "unavailable" });
        expect(
          s.handler.readPreparedFinancialR1IdentityEvidence(
            request,
            SCOPE.workspaceId,
            s.challengeRef,
            submission,
          ),
        ).toBe(first);
        expect([loadCalls, currentCalls]).toEqual(mode === "load-unknown" ? [1, 0] : [1, 1]);
      } finally {
        s.close();
      }
    }
  });

  test("identity evidence rejects a pending row that expires after the current read", async () => {
    const s = await setup();
    try {
      const { request, submission } = await provedSubmission(s);
      await s.handler.provePreparedFinancialR1Identity(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
        submission,
      );
      evidenceMode = "expire-after-current";
      await expect(
        s.handler.readPreparedFinancialR1IdentityEvidence(
          request,
          SCOPE.workspaceId,
          s.challengeRef,
          submission,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect([loadCalls, currentCalls]).toEqual([1, 1]);
    } finally {
      s.close();
    }
  });

  test("POST rejects missing, null, foreign Origin and Referer-only without writes", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const before = writes();
      for (const origin of [null, "null", "https://foreign.invalid"]) {
        const request = post(view.transactionRef, origin);
        request.headers.set("referer", url);
        await expect(
          s.handler.readPreparedFinancialR1SubmissionData(
            request,
            SCOPE.workspaceId,
            s.challengeRef,
          ),
        ).rejects.toMatchObject({ code: "unavailable" });
      }
      expect(writes()).toBe(before);
    } finally {
      s.close();
    }
  });

  test("POST rejects second body read and transaction mismatch without writes", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const before = writes();
      const request = post(view.transactionRef);
      await s.handler.readPreparedFinancialR1SubmissionData(
        request,
        SCOPE.workspaceId,
        s.challengeRef,
      );
      await expect(
        s.handler.readPreparedFinancialR1SubmissionData(request, SCOPE.workspaceId, s.challengeRef),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(
        s.handler.readPreparedFinancialR1SubmissionData(
          post(`rpfc_${"z".repeat(43)}`),
          SCOPE.workspaceId,
          s.challengeRef,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(writes()).toBe(before);
    } finally {
      s.close();
    }
  });

  test("POST rejects expired original pending and unknown pending SELECT without writes", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const before = writes();
      dbNow = Date.parse(AT) + 301_000;
      await expect(
        s.handler.readPreparedFinancialR1SubmissionData(
          post(view.transactionRef),
          SCOPE.workspaceId,
          s.challengeRef,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      dbNow = Date.parse(AT) + 2_000;
      const originalQuery = f.db.query.bind(f.db);
      Object.defineProperty(f.db, "query", {
        configurable: true,
        value: (sql: string) => {
          if (
            sql.includes(
              "FROM shared_auth_financial_consent_pending WHERE transaction_ref=? LIMIT 2",
            )
          )
            throw Error("unknown pending read");
          return originalQuery(sql);
        },
      });
      await expect(
        s.handler.readPreparedFinancialR1SubmissionData(
          post(view.transactionRef),
          SCOPE.workspaceId,
          s.challengeRef,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(writes()).toBe(before);
    } finally {
      s.close();
    }
  });

  test("POST refuses graph replacement during pending await with zero writes", async () => {
    const s = await setup();
    try {
      const view = await prepared(s.handler, s.challengeRef);
      const before = writes();
      const originalQuery = f.db.query.bind(f.db);
      Object.defineProperty(f.db, "query", {
        configurable: true,
        value: (sql: string) => {
          if (
            sql.includes(
              "FROM shared_auth_financial_consent_pending WHERE transaction_ref=? LIMIT 2",
            )
          )
            graph = Object.freeze({ ...graph });
          return originalQuery(sql);
        },
      });
      await expect(
        s.handler.readPreparedFinancialR1SubmissionData(
          post(view.transactionRef),
          SCOPE.workspaceId,
          s.challengeRef,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(writes()).toBe(before);
    } finally {
      s.close();
    }
  });
} else {
  test("runs actual Financial/RP POST preflight in isolated synthetic-Root child", async () => {
    const worker = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "test",
        "--timeout",
        "30000",
        fileURLToPath(import.meta.url),
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, RP_CONSENT_POST_PREFLIGHT_CHILD: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
    });
    const [exit, stdout, stderr] = await Promise.all([
      worker.exited,
      new Response(worker.stdout).text(),
      new Response(worker.stderr).text(),
    ]);
    expect({ exit, diagnostics: exit === 0 ? "" : stdout + stderr }).toEqual({
      exit: 0,
      diagnostics: "",
    });
    expect(stderr).toContain(
      "(pass) actual R1 and RP POST preflight reads pending only with one held Clock",
    );
    expect(stderr).toContain("14 pass");
    expect(stderr).toContain("0 fail");
  }, 100_000);
}
