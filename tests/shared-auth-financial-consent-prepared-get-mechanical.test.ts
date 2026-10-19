import { expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";

// Dedicated child only: synthetic external Root, Clock, Financial and issuer
// observations drive the actual RP pending SQL through the native-shaped
// SQLite adapter. This is NOT genuine Root/R1/native-D1/consent qualification.
const child = process.env.RP_PREPARED_GET_MECHANICAL_CHILD === "1";
if (child) {
  type Fixture = Awaited<
    ReturnType<typeof import("./consent-request-graph-fixture.ts")["graphFixture"]>
  >;
  let fixture: Fixture;
  let retained: unknown;
  let captures = 0;
  let rootRetouches = 0;
  let nextSample = 0;
  const observations = new WeakMap<
    object,
    Readonly<{
      connection: WorkerRequestSql;
      request: Request;
      workspaceId: string;
      held: object;
    }>
  >();
  const readers = new WeakMap<Request, object>();
  const rootPort = Object.freeze({});
  let rootContext: object;
  const assertConnection = (connection: unknown) => {
    if (connection !== fixture.connection) throw Error("foreign connection");
  };
  mock.module("../src/financial-auth-consumer.ts", () => ({
    readWorkerRequestFinancialAuthConsumerPort(connection: unknown) {
      assertConnection(connection);
      return rootPort;
    },
    readWorkerRequestFinancialAuthConsumerContext(connection: unknown, port: unknown) {
      assertConnection(connection);
      if (port !== rootPort) throw Error("foreign port");
      return rootContext;
    },
    assertWorkerRequestFinancialAuthConsumerPort(connection: unknown, port: unknown) {
      assertConnection(connection);
      if (port !== rootPort) throw Error("foreign port");
    },
    assertFinancialAuthConsumerPort(port: unknown, context: unknown) {
      if (port !== rootPort || context !== rootContext) throw Error("foreign context");
    },
    captureWorkerRequestFinancialAuthRpRequest() {
      rootRetouches++;
      throw Error("unexpected second Root touch");
    },
    financialAuthConsumerSourceCurrentness(port: unknown, context: unknown) {
      if (port !== rootPort || context !== rootContext) throw Error("foreign source");
      return { sql: "?=1", params: [1] };
    },
  }));
  mock.module("../src/shared-auth-financial-source.ts", () => ({
    async captureSharedAuthFinancialRequestClockObservationFromR1(
      connection: WorkerRequestSql,
      request: Request,
      workspaceId: string,
      reader: object,
      original: unknown,
    ) {
      assertConnection(connection);
      if (
        original !== retained ||
        reader !== readers.get(request) ||
        workspaceId !== fixture.input.pending.workspace_id
      )
        throw Error("crossed R1");
      captures++;
      const observation = Object.freeze({});
      const held = Object.freeze({
        selectedScope: Object.freeze({
          organizationId: fixture.input.pending.organization_id,
          workspaceId,
          workspaceRef: fixture.input.pending.workspace_ref,
        }),
        sampledAt: nextSample,
        credential: fixture.input.credential,
        human: fixture.input.human,
        currentSession: fixture.input.currentSession,
        finalSession: Object.freeze({}),
      });
      observations.set(observation, { connection, request, workspaceId, held });
      return observation;
    },
    readSharedAuthFinancialRequestNativeObservationData(
      connection: WorkerRequestSql,
      request: Request,
      workspaceId: string,
      observation: object,
    ) {
      const found = observations.get(observation);
      if (
        !found ||
        found.connection !== connection ||
        found.request !== request ||
        found.workspaceId !== workspaceId
      )
        throw Error("foreign observation");
      return found.held;
    },
    captureSharedAuthFinancialRequestClockObservation() {
      throw Error("unexpected legacy recapture");
    },
    proveSharedAuthFinancialRequestIdentityFromObservation() {
      throw Error("prepared GET must not dispatch proof");
    },
    loadSharedAuthFinancialRequestIdentityProofFromObservation() {
      throw Error("prepared GET must not load proof");
    },
    verifyCurrentSharedAuthFinancialRequestIdentityProofFromObservation() {
      throw Error("prepared GET must not verify proof");
    },
  }));
  mock.module("../src/shared-auth-financial-consent-issuer.ts", () => ({
    createSharedAuthFinancialConsentIssuerSource(connection: unknown) {
      assertConnection(connection);
      const original = Object.freeze({
        registrationRef: fixture.input.pending.registration_ref,
        registrationDigest: `sha256:${"b".repeat(64)}`,
        incarnation: fixture.input.pending.incarnation,
      });
      return Object.freeze({
        async readCurrentOriginal() {
          return original;
        },
        async currentness() {
          return { original, sql: "?=1", params: [1] };
        },
      });
    },
  }));
  mock.module("../src/shared-financial-retained-r1.ts", () => ({
    createFinancialActionConsentR1Reader(
      connection: unknown,
      request: unknown,
      workspaceId: unknown,
    ) {
      assertConnection(connection);
      if (!(request instanceof Request) || workspaceId !== fixture.input.pending.workspace_id)
        throw Error("crossed factory");
      const reader = Object.freeze({
        async readRetainedActionConsentR1(challengeRef: unknown) {
          if (challengeRef !== fixture.input.pending.challenge_ref)
            throw Error("crossed challenge");
          return retained;
        },
      });
      readers.set(request, reader);
      return reader;
    },
    readFinancialActionConsentR1RequestCaptures() {
      throw new Error("prepared GET must not capture Financial R1 request originals");
    },
    readFinancialActionConsentR1IdentityEvidenceData() {
      throw new Error("prepared GET must not join Financial identity evidence");
    },
  }));

  const { graphFixture } = await import("./consent-request-graph-fixture.ts");
  const { readWorkerRequestFinancialInputs } = await import("../src/worker-request-composition.ts");
  const { createSharedAuthFinancialConsentRequestHandler } = await import(
    "../src/shared-auth-financial-consent.ts"
  );
  async function setup() {
    fixture = await graphFixture({ seedPending: false });
    const inputs = readWorkerRequestFinancialInputs(fixture.connection);
    rootContext = Object.freeze({
      sql: inputs.sql,
      realm: inputs.realm,
      writerEpoch: inputs.writerEpoch,
    });
    const pending = fixture.input.pending;
    const action = JSON.parse(new TextDecoder().decode(pending.action_original_bytes));
    const challenge = JSON.parse(new TextDecoder().decode(pending.challenge_original_bytes));
    retained = Object.freeze({
      original: { challengeRef: pending.challenge_ref, c0: { challenge } },
      actionIdentity: { action, requestFingerprint: pending.request_fingerprint },
      selectedTerms: {
        digest: pending.terms_digest_original,
        bodyUtf8Base64url: Buffer.from(pending.terms_original_bytes).toString("base64url"),
        bodyByteLength: pending.terms_original_bytes.byteLength,
      },
      actionSource: {
        organizationId: pending.organization_id,
        workspaceId: pending.workspace_id,
        workspaceRef: pending.workspace_ref,
      },
      r1ReceiptRef: "mechanical-r1",
      c0ReceiptRef: "mechanical-c0",
      fullCommandJson: '{"mechanical":"fixed-r1"}',
    });
    nextSample = pending.created_at + 1_000;
    captures = 0;
    rootRetouches = 0;
    return {
      f: fixture,
      handler: createSharedAuthFinancialConsentRequestHandler(fixture.connection),
    };
  }
  const get = () => new Request("https://rp.example.invalid/financial/consent", { method: "GET" });
  const insertCount = (f: Fixture) =>
    f.native.calls.filter((call) =>
      call.sql.includes("INSERT INTO shared_auth_financial_consent_pending"),
    ).length;
  const prepare = async (
    f: Fixture,
    handler: ReturnType<typeof createSharedAuthFinancialConsentRequestHandler>,
  ) =>
    handler.prepareFinancialR1ConsentView(
      get(),
      f.input.pending.workspace_id,
      f.input.pending.challenge_ref,
    );

  test("mechanical guarded INSERT then same-key GET keeps original time and bytes", async () => {
    const { f, handler } = await setup();
    const first = await prepare(f, handler);
    expect(first.disposition).toBe("strict-insert-ack");
    const row = f.db
      .query(
        "SELECT transaction_ref,created_at,expires_at,disclosure_ref FROM shared_auth_financial_consent_pending",
      )
      .get() as Record<string, unknown>;
    expect(row.transaction_ref).toBe(first.transactionRef);
    expect(row.disclosure_ref).toBe(first.disclosureRef);
    expect(row.created_at).toBe(nextSample);
    expect(row.expires_at).toBe(f.input.pending.expires_at);
    nextSample += 1_000;
    const second = await prepare(f, handler);
    expect(second.disposition).toBe("original-get");
    expect(second.transactionRef).toBe(first.transactionRef);
    expect(second.html).toBe(first.html);
    expect(insertCount(f)).toBe(1);
    expect(
      f.db.query("SELECT created_at,expires_at FROM shared_auth_financial_consent_pending").get(),
    ).toEqual({
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
    expect(captures).toBe(2);
    expect(rootRetouches).toBe(0);
    expect(f.native.batchCalls).toBe(1); // Money-wrapped single pending Sql.run
  });

  test("mechanical committed lost ACK uses same-key GET without another INSERT", async () => {
    const { f, handler } = await setup();
    let lost = false;
    f.native.afterBatch = (results) => {
      if (!lost) {
        lost = true;
        throw Error("lost pending ACK after commit");
      }
      return results;
    };
    const first = await prepare(f, handler);
    expect(lost).toBe(true);
    expect(first.disposition).toBe("original-get");
    nextSample += 1_000;
    expect((await prepare(f, handler)).disposition).toBe("original-get");
    expect(insertCount(f)).toBe(1);
    expect(rootRetouches).toBe(0);
  });

  test("mechanical uncommitted unknown stays GET-only on same connection", async () => {
    const { f, handler } = await setup();
    let attempts = 0;
    f.native.beforeBatch = async () => {
      attempts++;
      throw Error("unknown before pending execution");
    };
    await expect(prepare(f, handler)).rejects.toMatchObject({ code: "unavailable" });
    nextSample += 1_000;
    await expect(prepare(f, handler)).rejects.toMatchObject({ code: "unavailable" });
    expect(attempts).toBe(1);
    expect(
      f.db.query("SELECT count(*) AS n FROM shared_auth_financial_consent_pending").get(),
    ).toEqual({ n: 0 });
    expect(rootRetouches).toBe(0);
  });
} else {
  test("runs pending GET SQLite mechanics in an isolated synthetic child", async () => {
    const childProcess = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "test",
        "--timeout",
        "30000",
        fileURLToPath(import.meta.url),
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, RP_PREPARED_GET_MECHANICAL_CHILD: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
    });
    const [exit, stdout, stderr] = await Promise.all([
      childProcess.exited,
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ]);
    expect({ exit, diagnostics: exit === 0 ? "" : stdout + stderr }).toEqual({
      exit: 0,
      diagnostics: "",
    });
    expect(stderr).toContain("3 pass");
    expect(stderr).toContain("0 fail");
  }, 100_000);
}
