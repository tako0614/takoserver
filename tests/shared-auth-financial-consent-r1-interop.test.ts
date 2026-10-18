import { expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";

// Actual Financial 7702 reader + actual RP source, isolated external Root and
// source Clock only. This is not genuine Auth103, native D1 or NEW admission.
const isolated = process.env.RP_R1_CLOCK_INTEROP_CHILD === "1";
if (isolated) {
  type Fixture = Awaited<
    ReturnType<typeof import("./fixtures/financial-r1-request-reader-fixture.ts")["fixture"]>
  >;
  const connection = Object.create(null) as WorkerRequestSql;
  const request = new Request("https://fixture.invalid/rp-financial-original", { method: "GET" });
  let f: Fixture;
  let active = true;
  let captures = 0;
  let clockCalls = 0;
  const sourceClock = () => {
    clockCalls++;
    return new Date("2026-10-15T00:00:00.000Z");
  };
  const clockOriginal = Object.freeze({ clock: sourceClock });
  let inputs: object;
  let graph: object;
  let context: object;
  let port: object;
  let retained: object;
  let originalCaptures: Readonly<{ credential: object; userBinding: object }>;
  const requireOrigin = (value: unknown) => {
    if (!active || value !== connection) throw Error("foreign connection");
  };
  mock.module("../src/auth103-source-clock.ts", () => ({
    readAuth103SourceClock(clock: unknown) {
      return clock === sourceClock ? clockOriginal : null;
    },
  }));
  mock.module("../src/worker-request-composition.ts", () => ({
    readWorkerRequestFinancialInputs(value: unknown) {
      requireOrigin(value);
      return inputs;
    },
    readWorkerRequestConsumers(value: unknown) {
      requireOrigin(value);
      return graph;
    },
    readWorkerRequestRetainedRpCapture(value: unknown, capture: unknown) {
      requireOrigin(value);
      if (capture !== originalCaptures?.credential) throw Error("foreign credential capture");
      return retained;
    },
  }));
  mock.module("../src/financial-auth-consumer.ts", () => ({
    readWorkerRequestFinancialAuthConsumerPort(value: unknown) {
      requireOrigin(value);
      return port;
    },
    readWorkerRequestFinancialAuthConsumerContext(value: unknown, selectedPort: unknown) {
      requireOrigin(value);
      if (selectedPort !== port) throw Error("foreign Root port");
      return context;
    },
    assertWorkerRequestFinancialAuthConsumerPort(value: unknown, selectedPort: unknown) {
      requireOrigin(value);
      if (selectedPort !== port) throw Error("foreign Root port");
    },
    assertFinancialAuthConsumerPort(selectedPort: unknown, selectedContext: unknown) {
      if (selectedPort !== port || selectedContext !== context) throw Error("crossed Root context");
    },
    async captureWorkerRequestFinancialAuthRpRequest(
      selectedPort: unknown,
      actual: unknown,
      workspaceId: unknown,
    ) {
      if (selectedPort !== port || actual !== request || workspaceId !== "workspace:test")
        throw Error("crossed original request");
      captures++;
      originalCaptures = Object.freeze({
        credential: Object.freeze({}),
        userBinding: Object.freeze({}),
      });
      return originalCaptures;
    },
    financialAuthConsumerSourceCurrentness() {
      return { sql: "?=1", params: [1] };
    },
  }));
  mock.module("../src/shared-principal-authority.ts", () => ({
    sharedPrincipalCurrentness() {
      return { sql: "?=1", params: [1] };
    },
  }));
  mock.module("../src/credential-authority-class.ts", () => ({
    sharedRpCredentialCurrentness() {
      return { sql: "?=1", params: [1] };
    },
  }));

  const { fixture, ACTIONS, SCOPE, AT, EPOCH } = await import(
    "./fixtures/financial-r1-request-reader-fixture.ts"
  );
  const {
    createFinancialActionConsentR1Reader,
    buildFinancialR1MechanicalBatch,
    readFinancialActionConsentR1RequestCaptures,
  } = await import("../src/shared-financial-retained-r1.ts");
  const {
    captureSharedAuthFinancialRequestClockObservationFromR1,
    readSharedAuthFinancialRequestNativeObservationData,
  } = await import("../src/shared-auth-financial-source.ts");
  const action = ACTIONS.find((candidate) => candidate.kind === "topup");
  if (!action) throw Error("fixture topup missing");
  f = await fixture();
  Object.defineProperty(connection, "sql", { value: f.sql, enumerable: true });
  const record = Object.freeze({
    class: "official-shared-rp-session",
    organizationId: "org:credential-row-A",
    origin: Object.freeze({
      principalId: "principal:fixture",
      principalIncarnation: "principal-incarnation:fixture",
    }),
  });
  const current = Object.freeze({});
  const binding = Object.freeze({
    principalId: "principal:fixture",
    principalIncarnation: "principal-incarnation:fixture",
  });
  const anchor = Object.freeze({});
  retained = Object.freeze({
    record,
    current,
    finalSession: Object.freeze({
      selectedWorkspaceId: SCOPE.workspaceId,
      principalId: binding.principalId,
    }),
    selectedScope: Object.freeze({
      organizationId: SCOPE.organizationId,
      workspaceId: SCOPE.workspaceId,
      workspaceRef: SCOPE.workspaceRef,
    }),
  });
  port = Object.freeze({
    readValidatedCredential(capture: unknown) {
      if (capture !== originalCaptures?.credential) throw Error("foreign credential");
      return { backend: "shared-rp-session", record, current };
    },
    readValidatedPrincipalBinding(capture: unknown) {
      if (capture !== originalCaptures?.userBinding) throw Error("foreign human");
      return { anchor, binding };
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
  await f.base.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
    SCOPE.organizationId,
    "fixture",
    binding.principalId,
    AT,
  ]);
  await f.base.run("INSERT INTO org_memberships VALUES(?,?,?,?)", [
    SCOPE.organizationId,
    binding.principalId,
    "owner",
    AT,
  ]);
  await f.base.run("INSERT INTO org_wallet_workspace_bindings VALUES(?,?,?)", [
    SCOPE.workspaceRef,
    SCOPE.organizationId,
    AT,
  ]);
  const command = await f.command(action, action.kind);
  await f.registerFixtureData();
  await f.c0.prepare(command.original.c0);
  await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));

  test("actual R1 reader and five-argument static getter feed one RP Clock observation", async () => {
    try {
      const before = { writes: f.writes, provider: f.providerRequests };
      const reader = createFinancialActionConsentR1Reader(connection, request, SCOPE.workspaceId);
      const original = await reader.readRetainedActionConsentR1(command.key.challengeRef);
      expect(original.fullCommand).toEqual(command);
      expect(captures).toBe(1);
      const sameCaptures = readFinancialActionConsentR1RequestCaptures(
        connection,
        request,
        SCOPE.workspaceId,
        reader,
        original,
      );
      expect(Object.is(sameCaptures, originalCaptures)).toBe(true);
      const observation = await captureSharedAuthFinancialRequestClockObservationFromR1(
        connection,
        request,
        SCOPE.workspaceId,
        reader,
        original,
      );
      const held = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        SCOPE.workspaceId,
        observation,
      );
      expect(
        Object.is(held.selectedScope, (retained as { selectedScope: object }).selectedScope),
      ).toBe(true);
      expect(Object.is(held.credential, record)).toBe(true);
      expect(Object.is(held.human, binding)).toBe(true);
      expect(Object.is(held.currentSession, current)).toBe(true);
      expect(
        Object.is(held.finalSession, (retained as { finalSession: object }).finalSession),
      ).toBe(true);
      expect(held.sampledAt).toBe(Date.parse(AT));
      expect(clockCalls).toBe(1);
      expect(captures).toBe(1);
      expect({ writes: f.writes, provider: f.providerRequests }).toEqual(before);

      for (const [selectedRequest, selectedWorkspace, selectedReader, selectedOriginal] of [
        [new Request(request.url), SCOPE.workspaceId, reader, original],
        [request, "workspace:foreign", reader, original],
        [request, SCOPE.workspaceId, {}, original],
        [request, SCOPE.workspaceId, reader, { ...original }],
      ] as const) {
        expect(() =>
          readFinancialActionConsentR1RequestCaptures(
            connection,
            selectedRequest,
            selectedWorkspace,
            selectedReader,
            selectedOriginal,
          ),
        ).toThrow();
      }
      expect(() =>
        readFinancialActionConsentR1RequestCaptures(
          Object.create(null) as WorkerRequestSql,
          request,
          SCOPE.workspaceId,
          reader,
          original,
        ),
      ).toThrow();
      expect(() =>
        readSharedAuthFinancialRequestNativeObservationData(
          connection,
          new Request(request.url),
          SCOPE.workspaceId,
          observation,
        ),
      ).toThrow();
      expect(captures).toBe(1);
      expect(clockCalls).toBe(1);
    } finally {
      active = false;
      f.close();
    }
  });
} else {
  test("runs actual Financial→RP Clock interop in an isolated external-Root child", async () => {
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
      env: { ...process.env, RP_R1_CLOCK_INTEROP_CHILD: "1" },
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
      "(pass) actual R1 reader and five-argument static getter feed one RP Clock observation",
    );
    expect(stderr).toContain("1 pass");
    expect(stderr).toContain("0 fail");
  }, 100_000);
}
