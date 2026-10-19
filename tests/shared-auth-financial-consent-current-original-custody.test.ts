import { expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { SharedAuthFinancialConsentOriginalData } from "../src/shared-auth-financial-consent-store.ts";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";

// This exercises the RP handler's provenance, not genuine Root, Financial,
// issuer, native D1, browser affirmation or NEW admission.
const child = process.env.RP_CURRENT_ORIGINAL_CHILD === "1";
if (child) {
  const connection = Object.freeze({}) as WorkerRequestSql;
  const request = new Request("https://fixture.invalid/financial/consent", { method: "POST" });
  const workspaceId = "selected_workspace_B";
  const observation = Object.freeze({});
  const sql = Object.freeze({
    query() {
      counters.sql++;
      throw Error("static original read must not query");
    },
    run() {
      counters.writes++;
      throw Error("static original read must not write");
    },
  });
  const sharedAuth = Object.freeze({
    observeFinalWorkspaceOrganization() {
      throw Error("not invoked");
    },
    finalSessionSelection() {
      throw Error("not invoked");
    },
  });
  const graphOriginal = Object.freeze({ sql, sharedAuth });
  const inputs = Object.freeze({ sql, realm: Object.freeze({}), writerEpoch: "epoch:test" });
  let graph: typeof graphOriginal = graphOriginal;
  let clockDrift = false;
  let finalUnknown = false;
  let historicalOriginal: SharedAuthFinancialConsentOriginalData;
  let consent: object;
  let retained: object;
  let native: object;
  let reader: object;
  const counters = {
    historical: 0,
    local: 0,
    r1: 0,
    observer: 0,
    clock: 0,
    native: 0,
    sql: 0,
    writes: 0,
  };

  const originalWorker = await import("../src/worker-request-composition.ts");
  mock.module("../src/worker-request-composition.ts", () => ({
    ...originalWorker,
    readWorkerRequestConsumers(value: unknown) {
      if (value !== connection) throw Error("foreign connection");
      return graph;
    },
    readWorkerRequestFinancialInputs(value: unknown) {
      if (value !== connection) throw Error("foreign connection");
      return inputs;
    },
    readWorkerRequestRetainedRpCapture() {
      throw Error("not invoked");
    },
  }));
  mock.module("../src/shared-auth-financial-consent-store.ts", () => ({
    SharedAuthFinancialConsentOriginalReadError: class extends Error {
      constructor(readonly code: string) {
        super(code);
      }
    },
    createSharedAuthFinancialConsentProofReferenceReader() {
      return {
        async readProofOriginalData() {
          counters.historical++;
          return { original: historicalOriginal };
        },
      };
    },
    createSharedAuthFinancialConsentLocalProofDataReader() {
      return {
        async readLocalProofOriginalData() {
          counters.local++;
          return {
            consentProofRef: (consent as { consentRef: string }).consentRef,
            original: historicalOriginal,
          };
        },
      };
    },
    persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData() {
      throw Error("not invoked");
    },
    prepareSharedAuthFinancialConsentPendingFromObservation() {
      throw Error("not invoked");
    },
    readSharedAuthFinancialConsentPreparedPendingForPost() {
      throw Error("not invoked");
    },
    snapshotSharedAuthFinancialConsentRequestCaptureData() {
      throw Error("not invoked");
    },
  }));
  mock.module("../src/shared-auth-financial-consent-issuer.ts", () => ({
    createSharedAuthFinancialConsentIssuerSource() {
      return {
        async readCurrentOriginal() {
          return (consent as { consentIssuer: object }).consentIssuer;
        },
      };
    },
  }));
  mock.module("../src/shared-financial-retained-r1.ts", () => ({
    createFinancialActionConsentR1Reader(value: unknown, actual: unknown, selected: unknown) {
      if (value !== connection || actual !== request || selected !== workspaceId)
        throw Error("foreign Financial reader origin");
      reader = Object.freeze({
        async readRetainedActionConsentR1() {
          counters.r1++;
          if (finalUnknown && counters.r1 % 2 === 0) throw Error("unknown final R1 GET");
          return retained;
        },
      });
      return reader;
    },
  }));
  mock.module("../src/shared-auth-financial-source.ts", () => ({
    async captureSharedAuthFinancialRequestClockObservationFromR1(
      value: unknown,
      actual: unknown,
      selected: unknown,
      selectedReader: unknown,
      original: unknown,
    ) {
      if (
        value !== connection ||
        actual !== request ||
        selected !== workspaceId ||
        selectedReader !== reader ||
        original !== retained
      )
        throw Error("foreign observation");
      counters.observer++;
      counters.clock++;
      return observation;
    },
    async captureSharedAuthFinancialRequestClockObservation() {
      throw Error("not invoked");
    },
    readSharedAuthFinancialRequestNativeObservationData(
      value: unknown,
      actual: unknown,
      selected: unknown,
      observed: unknown,
    ) {
      counters.native++;
      if (
        clockDrift ||
        value !== connection ||
        actual !== request ||
        selected !== workspaceId ||
        observed !== observation
      )
        throw Error("late source/Clock drift");
      return native;
    },
    proveSharedAuthFinancialRequestIdentityFromObservation() {
      throw Error("current consent verification must not dispatch proof");
    },
    loadSharedAuthFinancialRequestIdentityProofFromObservation() {
      throw Error("current consent verification must not load proof");
    },
    verifyCurrentSharedAuthFinancialRequestIdentityProofFromObservation() {
      throw Error("current consent verification must not verify proof");
    },
  }));

  const { createSharedFinancialActionIdentity } = await import("../src/shared-financial-action.ts");
  const { canonicalJson } = await import("../src/json.ts");
  const { syntheticV4Original } = await import("./consent-v4-fixture.ts");
  const {
    createSharedAuthFinancialConsentRequestHandler,
    readSharedAuthFinancialConsentCurrentOriginalData,
  } = await import("../src/shared-auth-financial-consent.ts");
  const encoder = new TextEncoder();
  const action = {
    amountMinor: 1000,
    kind: "topup",
    organizationId: "org_action",
    reference: "original",
  };
  const actionIdentity = await createSharedFinancialActionIdentity(action);
  const sampledAt = 1_760_000_100_000;
  const challenge = {
    v: 1,
    challengeRef: "challenge_original",
    registrationRef: "financial_challenge_registration",
    clientId: "takoserver-console-staging-v1",
    workspaceId,
    organizationId: "org_action",
    workspaceRef: "selected_ref_B",
    requestFingerprint: actionIdentity.requestFingerprint,
    createdAt: sampledAt - 100_000,
    expiresAt: sampledAt + 200_000,
  };
  const pending = {
    action_original_bytes: encoder.encode(canonicalJson(action)),
    challenge_original_bytes: encoder.encode(canonicalJson(challenge)),
    terms_digest_original: `sha256:${"a".repeat(64)}`,
    organization_id: challenge.organizationId,
    workspace_id: workspaceId,
    workspace_ref: challenge.workspaceRef,
    request_fingerprint: actionIdentity.requestFingerprint,
    registration_ref: "rp_consent_registration",
    incarnation: "consent_incarnation",
    principal_id: "principal:original",
    principal_binding_ref: "binding:original",
    authority_ref: "credential:original",
    credential_incarnation: "credential-incarnation:original",
    created_at: sampledAt - 100_000,
    expires_at: sampledAt + 200_000,
  };
  const credential = {
    rp: {
      sessionDigest: "session:digest",
      accountId: "account:original",
      issuer: "issuer:original",
      clientId: "client:original",
      subject: "subject:original",
      issuerSessionId: "session:original",
      authTime: sampledAt - 200_000,
    },
  };
  const identity = await syntheticV4Original(
    pending as unknown as Parameters<typeof syntheticV4Original>[0],
    credential as unknown as Parameters<typeof syntheticV4Original>[1],
    7,
    "consent:original",
  );
  consent = identity.original;
  const originalBytes = encoder.encode(identity.canonicalOriginalJson);
  const commandBytes = encoder.encode("original-full-command-bytes");
  const originalDigest = identity.consentDigest;
  const command = Object.freeze({
    key: Object.freeze({
      registrationRef: pending.registration_ref,
      incarnation: pending.incarnation,
      transactionRef: `rpfc_${"a".repeat(43)}`,
      commandRef: "command:original",
      consentRef: identity.original.consentRef,
      receiptRef: "receipt:original",
    }),
    selectedScope: Object.freeze({
      organizationId: challenge.organizationId,
      workspaceId,
      workspaceRef: challenge.workspaceRef,
    }),
    family: "rp-explicit-action-consent" as const,
    commandBytes,
    commandCustodySHA256: `sha256:${"b".repeat(64)}`,
    originalBytes,
    originalDigest,
    originalCustodySHA256: `sha256:${"c".repeat(64)}`,
    capturedAt: sampledAt - 50_000,
  });
  historicalOriginal = Object.freeze({
    state: "receipted-original-data" as const,
    command,
    originalBytes,
    originalDigest,
    originalCustodySHA256: command.originalCustodySHA256,
    recordedAt: sampledAt - 10_000,
    receiptRef: command.key.receiptRef,
    receiptRecordedAt: sampledAt - 10_000,
  });
  const selectedTerms = identity.original.selectedTerms;
  retained = Object.freeze({
    original: Object.freeze({
      challengeRef: challenge.challengeRef,
      c0: Object.freeze({ challenge, selection: Object.freeze({ terms: selectedTerms }) }),
    }),
    actionIdentity: Object.freeze({
      version: identity.original.actionVersion,
      requestFingerprint: identity.original.actionRequestFingerprint,
      action: identity.original.action,
    }),
    selectedTerms,
    actionSource: identity.original.source,
    scopeRealm: Object.freeze({
      ...identity.original.path,
      financialRealm: identity.original.financialRealmRef,
    }),
    billingBinding: Object.freeze({ ...identity.original.path }),
    fullCommandJson: "exact:full-command",
    r1ReceiptRef: "receipt:r1",
    c0ReceiptRef: "receipt:c0",
  });
  native = Object.freeze({
    selectedScope: Object.freeze({ ...identity.original.path }),
    sampledAt,
    credential: Object.freeze({
      rp: Object.freeze({
        accountId: credential.rp.accountId,
        principalBindingRef: identity.original.principalBinding.ref,
      }),
      origin: Object.freeze({
        ref: identity.original.credentialClass.ref,
        issuanceDigest: identity.original.credentialClass.digest,
        incarnation: identity.original.credentialClass.incarnation,
      }),
    }),
    human: Object.freeze({
      principalId: identity.original.rpSession.observedPrincipalId,
      ref: identity.original.principalBinding.ref,
      evidence: Object.freeze({ digest: identity.original.principalBinding.digest }),
      controllerIncarnation: identity.original.principalBinding.incarnation,
    }),
    currentSession: Object.freeze({ version: 7, absoluteExpiresAt: sampledAt + 200_000 }),
    finalSession: Object.freeze({
      accountId: identity.original.rpSession.accountId,
      sessionDigest: identity.original.rpSession.sessionDigest,
      principalId: identity.original.rpSession.observedPrincipalId,
      identity: Object.freeze({ ...identity.original.rpSession.identity }),
    }),
  });

  test("registers only after final R1 read and exposes detached exact receipt DATA", async () => {
    const handler = createSharedAuthFinancialConsentRequestHandler(connection);
    let witness: Awaited<ReturnType<typeof handler.verifyCurrentActionConsent>>;
    try {
      witness = await handler.verifyCurrentActionConsent(request, {
        workspaceId,
        consentProofRef: identity.original.consentRef,
      });
    } catch (error) {
      throw Error(`stage=${JSON.stringify(counters)} original=${String(error)}`);
    }
    expect(witness).toEqual({
      state: "financial-action-consent-local-current-witness",
      consentProofRef: identity.original.consentRef,
      sampledAt,
      originalDigest,
    });
    expect(counters.r1).toBe(2);
    expect(counters.observer).toBe(1);
    expect(counters.clock).toBe(1);
    const before = { ...counters };
    const first = readSharedAuthFinancialConsentCurrentOriginalData(
      handler,
      connection,
      request,
      workspaceId,
      witness,
    );
    expect(first.sampledAt).toBe(sampledAt);
    expect(first.original).toEqual(historicalOriginal);
    expect(first.original).not.toBe(historicalOriginal);
    expect(first.original.receiptRef).toBe(command.key.receiptRef);
    expect(first.original.receiptRecordedAt).toBe(sampledAt - 10_000);
    first.original.originalBytes[0] = (first.original.originalBytes[0] ?? 0) ^ 1;
    first.original.command.commandBytes[0] = (first.original.command.commandBytes[0] ?? 0) ^ 1;
    const second = readSharedAuthFinancialConsentCurrentOriginalData(
      handler,
      connection,
      request,
      workspaceId,
      witness,
    );
    expect(second.original.originalBytes).toEqual(originalBytes);
    expect(second.original.command.commandBytes).toEqual(commandBytes);
    expect(counters.r1).toBe(before.r1);
    expect(counters.observer).toBe(before.observer);
    expect(counters.clock).toBe(before.clock);
    expect(counters.sql).toBe(before.sql);
    expect(counters.writes).toBe(before.writes);
    for (const [
      selectedHandler,
      selectedConnection,
      selectedRequest,
      selectedWorkspace,
      selectedWitness,
    ] of [
      [
        createSharedAuthFinancialConsentRequestHandler(connection),
        connection,
        request,
        workspaceId,
        witness,
      ],
      [handler, Object.freeze({}) as WorkerRequestSql, request, workspaceId, witness],
      [handler, connection, new Request(request.url), workspaceId, witness],
      [handler, connection, request, "workspace:foreign", witness],
      [handler, connection, request, workspaceId, { ...witness }],
    ] as const) {
      expect(() =>
        readSharedAuthFinancialConsentCurrentOriginalData(
          selectedHandler,
          selectedConnection,
          selectedRequest,
          selectedWorkspace,
          selectedWitness,
        ),
      ).toThrow();
    }
    graph = Object.freeze({ ...graphOriginal });
    expect(() =>
      readSharedAuthFinancialConsentCurrentOriginalData(
        handler,
        connection,
        request,
        workspaceId,
        witness,
      ),
    ).toThrow();
    graph = graphOriginal;
    clockDrift = true;
    expect(() =>
      readSharedAuthFinancialConsentCurrentOriginalData(
        handler,
        connection,
        request,
        workspaceId,
        witness,
      ),
    ).toThrow();
    clockDrift = false;
    const readsBeforeUnknown = counters.r1;
    finalUnknown = true;
    await expect(
      handler.verifyCurrentActionConsent(request, {
        workspaceId,
        consentProofRef: identity.original.consentRef,
      }),
    ).rejects.toThrow();
    expect(counters.r1 - readsBeforeUnknown).toBe(2);
    expect(() =>
      readSharedAuthFinancialConsentCurrentOriginalData(handler, connection, request, workspaceId, {
        ...witness,
      }),
    ).toThrow();
    historicalOriginal.originalBytes[0] = (historicalOriginal.originalBytes[0] ?? 0) ^ 1;
    expect(() =>
      readSharedAuthFinancialConsentCurrentOriginalData(
        handler,
        connection,
        request,
        workspaceId,
        witness,
      ),
    ).toThrow();
    expect(counters.writes).toBe(0);
  });
} else {
  test("current original custody is bound in an isolated synthetic child", async () => {
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
      env: { ...process.env, RP_CURRENT_ORIGINAL_CHILD: "1" },
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
      "(pass) registers only after final R1 read and exposes detached exact receipt DATA",
    );
    expect(stderr).toContain("1 pass");
    expect(stderr).toContain("0 fail");
  }, 100_000);
}
