import { expect, mock, test } from "bun:test";
import type { SharedFinancialAction } from "../../src/shared-financial-action.ts";
import type { WorkerRequestSql } from "../../src/worker-request-composition.ts";

// Synthetic EXTERNAL Root origin/predicates only, in a dedicated Bun process.
// Actual Financial schema, original parsers, receipts, Money SQL, and final
// selected-owner join execute unchanged against SQLite. This is not genuine
// Root currentness, authenticated display/consent, native D1, or NEW permission.
type Fixture = Awaited<
  ReturnType<typeof import("./financial-r1-request-reader-fixture.ts")["fixture"]>
>;
let f: Fixture;
const connection = Object.create(null) as WorkerRequestSql;
const request = new Request("https://fixture.invalid/selected-original");
const principalId = "principal:fixture";
let state: {
  inputs: object;
  port: {
    readValidatedCredential: (capture: unknown) => object;
    readValidatedPrincipalBinding: (capture: unknown) => object;
  };
  expectedCredentialReader: (capture: unknown) => object;
  expectedPrincipalReader: (capture: unknown) => object;
  context: object;
  retained: {
    record: {
      class: string;
      organizationId: string;
      origin: { principalId: string; principalIncarnation: string };
    };
    current: object;
    finalSession: { selectedWorkspaceId: string; principalId: string };
    selectedScope: { workspaceId: string; organizationId: string; workspaceRef: string };
  };
  active: boolean;
  sourceCurrent: boolean;
  humanCurrent: boolean;
  rpCurrent: boolean;
  captures: number;
  captureMode: "found" | "absent" | "unknown";
  captureGate?: Promise<void>;
  captureArgs: Array<{
    readonly port: unknown;
    readonly request: unknown;
    readonly workspaceId: unknown;
  }>;
  captureResults: Array<{
    readonly credential: object;
    readonly userBinding: object;
  }>;
  credentialHandles: unknown[];
  userHandles: unknown[];
};
const requireOrigin = (original: unknown) => {
  if (original !== connection || !state.active) throw Error("synthetic origin unavailable");
};
mock.module("../../src/worker-request-composition.ts", () => ({
  readWorkerRequestFinancialInputs(original: unknown) {
    requireOrigin(original);
    return state.inputs;
  },
  readWorkerRequestRetainedRpCapture(original: unknown) {
    requireOrigin(original);
    return state.retained;
  },
}));
mock.module("../../src/financial-auth-consumer.ts", () => ({
  readWorkerRequestFinancialAuthConsumerPort(original: unknown) {
    requireOrigin(original);
    return state.port;
  },
  readWorkerRequestFinancialAuthConsumerContext(original: unknown, port: unknown) {
    requireOrigin(original);
    if (port !== state.port) throw Error("port");
    return state.context;
  },
  assertWorkerRequestFinancialAuthConsumerPort(original: unknown, port: unknown) {
    requireOrigin(original);
    if (port !== state.port) throw Error("port");
    const credentialReader = Object.getOwnPropertyDescriptor(
      port as object,
      "readValidatedCredential",
    );
    const principalReader = Object.getOwnPropertyDescriptor(
      port as object,
      "readValidatedPrincipalBinding",
    );
    if (
      !credentialReader ||
      !("value" in credentialReader) ||
      credentialReader.value !== state.expectedCredentialReader ||
      !principalReader ||
      !("value" in principalReader) ||
      principalReader.value !== state.expectedPrincipalReader
    )
      throw Error("replaced Root reader method");
  },
  async captureWorkerRequestFinancialAuthRpRequest(
    port: unknown,
    actual: unknown,
    workspaceId: unknown,
  ) {
    if (
      port !== state.port ||
      actual !== request ||
      workspaceId !== state.retained.selectedScope.workspaceId
    )
      throw Error("capture");
    state.captures++;
    state.captureArgs.push({ port, request: actual, workspaceId });
    if (state.captureGate) await state.captureGate;
    if (state.captureMode === "absent") return null;
    if (state.captureMode === "unknown") throw Error("synthetic unknown final touch");
    const captures = Object.freeze({
      credential: Object.freeze({}),
      userBinding: Object.freeze({}),
    });
    state.captureResults.push(captures);
    return captures;
  },
  financialAuthConsumerSourceCurrentness() {
    return { sql: "?=1", params: [state.sourceCurrent ? 1 : 0] };
  },
}));
mock.module("../../src/shared-principal-authority.ts", () => ({
  sharedPrincipalCurrentness() {
    return { sql: "?=1", params: [state.humanCurrent ? 1 : 0] };
  },
}));
mock.module("../../src/credential-authority-class.ts", () => ({
  sharedRpCredentialCurrentness(record: unknown, current: unknown, organizationId: unknown) {
    if (
      record !== state.retained.record ||
      current !== state.retained.current ||
      organizationId !== state.retained.record.organizationId
    )
      throw Error("crossed credential row scope");
    return { sql: "?=1", params: [state.rpCurrent ? 1 : 0] };
  },
}));
const { fixture, ACTIONS, SCOPE, AT, EPOCH } = await import(
  "./financial-r1-request-reader-fixture.ts"
);
const {
  createFinancialActionConsentR1Reader,
  buildFinancialR1MechanicalBatch,
  readFinancialActionConsentR1RequestCaptures,
  readFinancialRequestBoundR1History,
} = await import("../../src/shared-financial-retained-r1.ts");

function expectUnavailable(action: () => unknown) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "unavailable" });
}

function topupAction() {
  const action = ACTIONS.find((candidate) => candidate.kind === "topup");
  if (!action) throw Error("missing fixture topup action");
  return action;
}

async function setup(action: SharedFinancialAction = topupAction(), terms?: string) {
  f = await fixture();
  const port = {
    readValidatedCredential: (capture: unknown) => {
      state.credentialHandles.push(capture);
      return {
        backend: "shared-rp-session",
        record: state.retained.record,
        current: state.retained.current,
      };
    },
    readValidatedPrincipalBinding: (capture: unknown) => {
      state.userHandles.push(capture);
      return {
        binding: { principalId, principalIncarnation: "principal-incarnation:fixture" },
      };
    },
  };
  state = {
    inputs: {
      sql: f.sql,
      client: f.client,
      realm: f.options.realm,
      clock: f.options.clock,
      writerEpoch: EPOCH,
    },
    port,
    expectedCredentialReader: port.readValidatedCredential,
    expectedPrincipalReader: port.readValidatedPrincipalBinding,
    context: { sql: f.sql, realm: f.options.realm, writerEpoch: EPOCH },
    retained: {
      record: {
        class: "official-shared-rp-session",
        organizationId: "org:credential-row-A",
        origin: { principalId, principalIncarnation: "principal-incarnation:fixture" },
      },
      current: {},
      finalSession: { selectedWorkspaceId: SCOPE.workspaceId, principalId },
      selectedScope: {
        workspaceId: SCOPE.workspaceId,
        organizationId: SCOPE.organizationId,
        workspaceRef: SCOPE.workspaceRef,
      },
    },
    active: true,
    sourceCurrent: true,
    humanCurrent: true,
    rpCurrent: true,
    captures: 0,
    captureMode: "found",
    captureArgs: [],
    captureResults: [],
    credentialHandles: [],
    userHandles: [],
  };
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
  const command = await f.command(action, action.kind, terms);
  const install = async () => {
    await f.registerFixtureData();
    await f.c0.prepare(command.original.c0);
    await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, command));
  };
  const reader = createFinancialActionConsentR1Reader(connection, request, SCOPE.workspaceId);
  return { command, install, reader };
}

test("request-owned R1 consumer returns exact five-action originals, both receipts and separate credential-row/selected scopes", async () => {
  for (const action of ACTIONS) {
    const { command, install, reader } = await setup(action);
    try {
      await install();
      const before = { writes: f.writes, provider: f.providerRequests, clocks: f.clocks };
      const original = await reader.readRetainedActionConsentR1(command.key.challengeRef);
      expect(original.original).toEqual(command.original);
      expect(original.fullCommand).toEqual(command);
      expect(JSON.parse(original.fullCommandJson)).toEqual(command);
      expect(original.actionIdentity.action).toEqual(action);
      expect(original.actionIdentity.requestFingerprint).toBe(
        command.original.c0.challenge.requestFingerprint,
      );
      expect(original.selectedTerms).toEqual(command.original.selectedTerms);
      expect(original.billingBinding).toEqual(command.original.c0.selection.billingBinding);
      expect(original.actionSource).toEqual(command.original.actionSource);
      expect(original.scopeRealm).toEqual(command.original.scopeRealm);
      expect(original.r1ReceiptRef).toBe(command.r1ReceiptRef);
      expect(original.c0ReceiptRef).toBe(command.original.c0ReceiptRef);
      expect(state.retained.record.organizationId).not.toBe(original.scopeRealm.organizationId);
      expect(Object.isFrozen(original)).toBe(true);
      expect(Object.isFrozen(original.fullCommand.original.selectedTerms)).toBe(true);
      expect({ writes: f.writes, provider: f.providerRequests, clocks: f.clocks }).toEqual(before);
      expect(state.captures).toBe(1);
      expect(Object.keys(original).sort()).toEqual(
        [
          "original",
          "actionIdentity",
          "selectedTerms",
          "billingBinding",
          "actionSource",
          "scopeRealm",
          "r1ReceiptRef",
          "c0ReceiptRef",
          "fullCommand",
          "fullCommandJson",
        ].sort(),
      );
    } finally {
      f.close();
    }
  }
});

test("RP entry refuses complete historical absence without writing or turning it into preparation", async () => {
  const { command, reader } = await setup();
  try {
    expect(
      await readFinancialRequestBoundR1History(
        connection,
        request,
        SCOPE.workspaceId,
        command.key.challengeRef,
      ),
    ).toEqual({ status: "not-found" });
    const before = f.writes;
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.writes).toBe(before);
    await expect(
      f.store.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    f.close();
  }
});

test("RP entry refuses a C0-only original instead of reconstructing R1 or terms", async () => {
  const { command, reader } = await setup();
  try {
    await f.c0.prepare(command.original.c0);
    const before = f.writes;
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.writes).toBe(before);
  } finally {
    f.close();
  }
});

for (const kind of ["sourceCurrent", "humanCurrent", "rpCurrent"] as const) {
  test(`RP entry requires the final same-primary ${kind} predicate`, async () => {
    const { command, install, reader } = await setup();
    try {
      await install();
      expect((await f.store.readJoinedRetainedR1Data(command.key.challengeRef)).status).toBe(
        "found",
      );
      state[kind] = false;
      await expect(
        reader.readRetainedActionConsentR1(command.key.challengeRef),
      ).rejects.toMatchObject({ code: "unavailable" });
      state[kind] = true;
      expect(
        (await reader.readRetainedActionConsentR1(command.key.challengeRef)).r1ReceiptRef,
      ).toBe(command.r1ReceiptRef);
    } finally {
      f.close();
    }
  });
}

test("RP entry rechecks selected Org owner and membership rather than the retained credential Org", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    await f.base.run("UPDATE org_memberships SET role='member' WHERE org_id=?", [
      SCOPE.organizationId,
    ]);
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    await f.base.run("UPDATE org_memberships SET role='owner' WHERE org_id=?", [
      SCOPE.organizationId,
    ]);
    await f.base.run("UPDATE orgs SET owner_principal_id=? WHERE id=?", [
      "principal:other",
      SCOPE.organizationId,
    ]);
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    f.close();
  }
});

test("RP entry refuses a changed selected Workspace binding", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    state.retained.selectedScope = {
      ...state.retained.selectedScope,
      workspaceRef: "workspace-ref:other",
    };
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    f.close();
  }
});

test("RP entry preserves a held request and refuses different request or replaced origin", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    const other = createFinancialActionConsentR1Reader(
      connection,
      new Request(request.url),
      SCOPE.workspaceId,
    );
    await expect(other.readRetainedActionConsentR1(command.key.challengeRef)).rejects.toMatchObject(
      { code: "unavailable" },
    );
    state.context = { ...state.context };
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    f.close();
  }
});

test("RP entry keeps unknown reads unavailable and original history usable afterwards", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    const before = f.writes;
    f.unknownQuery();
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      (await reader.readRetainedActionConsentR1(command.key.challengeRef)).fullCommand,
    ).toEqual(command);
    expect(f.writes).toBe(before);
  } finally {
    f.close();
  }
});

test("RP entry returns exact large UTF-8 historical terms with no RP cap truncation or disclosure alias", async () => {
  const terms = "決済条件📄".repeat(1500);
  const { command, install, reader } = await setup(topupAction(), terms);
  try {
    await install();
    const original = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    expect(original.selectedTerms.bodyByteLength).toBe(new TextEncoder().encode(terms).length);
    expect(original.selectedTerms.bodyByteLength).toBeGreaterThan(16_384);
    expect(original.selectedTerms.bodyUtf8Base64url).toBe(
      command.original.selectedTerms.bodyUtf8Base64url,
    );
    expect("disclosureRef" in original).toBe(false);
    expect("consentProofRef" in original).toBe(false);
  } finally {
    f.close();
  }
});

test("one R1 reader reuses the opaque original across sequential GETs without caching found", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    expect(state.captures).toBe(0);
    expect(
      (await reader.readRetainedActionConsentR1(command.key.challengeRef)).fullCommand,
    ).toEqual(command);
    state.sourceCurrent = false;
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    state.sourceCurrent = true;
    expect(
      (await reader.readRetainedActionConsentR1(command.key.challengeRef)).fullCommand,
    ).toEqual(command);
    expect(state.captures).toBe(1);
    expect(new Set(state.credentialHandles).size).toBe(1);
    expect(new Set(state.userHandles).size).toBe(1);
    expect(state.credentialHandles.length).toBeGreaterThanOrEqual(3);
  } finally {
    f.close();
  }
});

test("the request-capture bridge returns the exact opaque Root capture for an actual successful result", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    const original = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    const before = { writes: f.writes, provider: f.providerRequests, clocks: f.clocks };
    const captures = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      reader,
      original,
    );
    expect(state.captureResults).toHaveLength(1);
    expect(captures === state.captureResults[0]).toBe(true);
    expect(Object.isFrozen(captures)).toBe(true);
    expect(captures.credential === state.captureResults[0]?.credential).toBe(true);
    expect(captures.userBinding === state.captureResults[0]?.userBinding).toBe(true);
    expect(state.captureArgs).toEqual([
      { port: state.port, request, workspaceId: SCOPE.workspaceId },
    ]);
    expect({ writes: f.writes, provider: f.providerRequests, clocks: f.clocks }).toEqual(before);
  } finally {
    f.close();
  }
});

test("sequential successful originals map to the same capture without memoizing the result", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    const first = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    const second = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    expect(first).not.toBe(second);
    const firstCapture = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      reader,
      first,
    );
    expect(firstCapture === state.captureResults[0]).toBe(true);
    const secondCapture = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      reader,
      second,
    );
    expect(secondCapture === state.captureResults[0]).toBe(true);
    expect(state.captures).toBe(1);
  } finally {
    f.close();
  }
});

test("separate readers map only their own successful original to their own capture", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    const anotherReader = createFinancialActionConsentR1Reader(
      connection,
      request,
      SCOPE.workspaceId,
    );
    const first = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    const second = await anotherReader.readRetainedActionConsentR1(command.key.challengeRef);
    const firstCaptures = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      reader,
      first,
    );
    const secondCaptures = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      anotherReader,
      second,
    );
    expect(firstCaptures === state.captureResults[0]).toBe(true);
    expect(secondCaptures === state.captureResults[1]).toBe(true);
    expect(firstCaptures).not.toBe(secondCaptures);
    expectUnavailable(() =>
      readFinancialActionConsentR1RequestCaptures(
        connection,
        request,
        SCOPE.workspaceId,
        reader,
        second,
      ),
    );
    expect(state.captures).toBe(2);
  } finally {
    f.close();
  }
});

test("parallel R1 GETs share one pending Root capture and preserve both original results", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    let release = () => {};
    state.captureGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads = [
      reader.readRetainedActionConsentR1(command.key.challengeRef),
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ];
    await Promise.resolve();
    const pendingCaptures = state.captures;
    release();
    const originals = await Promise.all(reads);
    expect(pendingCaptures).toBe(1);
    expect(originals.map((original) => original.fullCommand)).toEqual([command, command]);
    expect(originals).toHaveLength(2);
    const recovered = originals.map((original) =>
      readFinancialActionConsentR1RequestCaptures(
        connection,
        request,
        SCOPE.workspaceId,
        reader,
        original,
      ),
    );
    expect(
      recovered.length === 2 && recovered.every((capture) => capture === state.captureResults[0]),
    ).toBe(true);
    expect(recovered[0]).toBe(recovered[1]);
    expect(state.captures).toBe(1);
    expect(new Set(state.credentialHandles).size).toBe(1);
  } finally {
    f.close();
  }
});

for (const mode of ["absent", "unknown"] as const) {
  test(`Root ${mode} capture remains unavailable without observer resend`, async () => {
    const { command, install, reader } = await setup();
    try {
      await install();
      state.captureMode = mode;
      await expect(
        reader.readRetainedActionConsentR1(command.key.challengeRef),
      ).rejects.toMatchObject({ code: "unavailable" });
      state.captureMode = "found";
      await expect(
        reader.readRetainedActionConsentR1(command.key.challengeRef),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(state.captures).toBe(1);
      expectUnavailable(() =>
        readFinancialActionConsentR1RequestCaptures(
          connection,
          request,
          SCOPE.workspaceId,
          reader,
          Object.create(null),
        ),
      );
      expect(state.captures).toBe(1);
    } finally {
      f.close();
    }
  });
}

test("an initial invalid origin stays unavailable after the source echo is restored", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    state.active = false;
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    state.active = true;
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(state.captures).toBe(0);
  } finally {
    f.close();
  }
});

test("SQL unknown recovery reads the held original without another Root observation", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    f.unknownQuery();
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    const original = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    expect(original.fullCommand).toEqual(command);
    const sqlRecoveryCaptures = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      reader,
      original,
    );
    expect(sqlRecoveryCaptures === state.captureResults[0]).toBe(true);
    expect(state.captures).toBe(1);
    expect(new Set(state.credentialHandles).size).toBe(1);
  } finally {
    f.close();
  }
});

test("copied, proxied, inherited, or getter-bearing originals cannot recover captures", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    const original = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    const before = { writes: f.writes, provider: f.providerRequests, clocks: f.clocks };
    let getterCalls = 0;
    const proxied = new Proxy(original, {
      get() {
        getterCalls++;
        throw Error("result getter");
      },
    });
    const getterBearing = Object.create(null, {
      fullCommand: {
        get() {
          getterCalls++;
          throw Error("forged result getter");
        },
      },
    });
    const untrusted = [{ ...original }, proxied, Object.create(original), getterBearing];
    f.unknownQuery();
    for (const candidate of untrusted) {
      expectUnavailable(() =>
        readFinancialActionConsentR1RequestCaptures(
          connection,
          request,
          SCOPE.workspaceId,
          reader,
          candidate,
        ),
      );
    }
    const originalCapture = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      reader,
      original,
    );
    expect(originalCapture === state.captureResults[0]).toBe(true);
    expect(getterCalls).toBe(0);
    expect(state.captures).toBe(1);
    expect({ writes: f.writes, provider: f.providerRequests, clocks: f.clocks }).toEqual(before);
    await expect(
      reader.readRetainedActionConsentR1(command.key.challengeRef),
    ).rejects.toMatchObject({ code: "unavailable" });
    const healthy = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    expect(healthy.fullCommand).toEqual(command);
    expect(state.captures).toBe(1);
    const healthyCaptures = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      reader,
      healthy,
    );
    expect(healthyCaptures === state.captureResults[0]).toBe(true);
  } finally {
    f.close();
  }
});

test("capture lookup requires exact connection, Request, workspace, and reader without getter evaluation", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    const original = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    const anotherReader = createFinancialActionConsentR1Reader(
      connection,
      request,
      SCOPE.workspaceId,
    );
    const sameUrlRequest = new Request(request.url);
    let getterCalls = 0;
    const proxiedRequest = new Proxy(sameUrlRequest, {
      get() {
        getterCalls++;
        throw Error("request getter");
      },
    });
    const fakeConnection = Object.create(null, {
      query: {
        get() {
          getterCalls++;
          throw Error("connection getter");
        },
      },
    });
    const proxiedReader = new Proxy(reader, {
      get() {
        getterCalls++;
        throw Error("reader getter");
      },
    });
    for (const [candidateConnection, candidateRequest, candidateWorkspace, candidateReader] of [
      [fakeConnection, request, SCOPE.workspaceId, reader],
      [connection, sameUrlRequest, SCOPE.workspaceId, reader],
      [connection, proxiedRequest, SCOPE.workspaceId, reader],
      [connection, request, `${SCOPE.workspaceId}:other`, reader],
      [connection, request, SCOPE.workspaceId, anotherReader],
      [connection, request, SCOPE.workspaceId, proxiedReader],
    ] as const) {
      expectUnavailable(() =>
        readFinancialActionConsentR1RequestCaptures(
          candidateConnection as WorkerRequestSql,
          candidateRequest,
          candidateWorkspace,
          candidateReader,
          original,
        ),
      );
    }
    expect(getterCalls).toBe(0);
    expect(state.captures).toBe(1);
  } finally {
    f.close();
  }
});

test("capture lookup reasserts the held origin and never re-observes the Root capture", async () => {
  const { command, install, reader } = await setup();
  try {
    await install();
    const original = await reader.readRetainedActionConsentR1(command.key.challengeRef);
    const before = { writes: f.writes, provider: f.providerRequests, clocks: f.clocks };
    let getterCalls = 0;
    const credentialDescriptor = Object.getOwnPropertyDescriptor(
      state.port,
      "readValidatedCredential",
    );
    if (!credentialDescriptor || !("value" in credentialDescriptor))
      throw Error("missing original Root reader descriptor");
    Object.defineProperty(state.port, "readValidatedCredential", {
      configurable: true,
      enumerable: credentialDescriptor.enumerable === true,
      get() {
        getterCalls++;
        throw Error("Root reader getter");
      },
    });
    const originalContext = state.context;
    state.context = { ...originalContext };
    expectUnavailable(() =>
      readFinancialActionConsentR1RequestCaptures(
        connection,
        request,
        SCOPE.workspaceId,
        reader,
        original,
      ),
    );
    expect(getterCalls).toBe(0);
    Object.defineProperty(state.port, "readValidatedCredential", credentialDescriptor);
    expectUnavailable(() =>
      readFinancialActionConsentR1RequestCaptures(
        connection,
        request,
        SCOPE.workspaceId,
        reader,
        original,
      ),
    );
    expect(getterCalls).toBe(0);
    state.context = originalContext;
    const restoredCaptures = readFinancialActionConsentR1RequestCaptures(
      connection,
      request,
      SCOPE.workspaceId,
      reader,
      original,
    );
    expect(restoredCaptures === state.captureResults[0]).toBe(true);
    expect(state.captures).toBe(1);
    expect(getterCalls).toBe(0);
    expect({ writes: f.writes, provider: f.providerRequests, clocks: f.clocks }).toEqual(before);
  } finally {
    f.close();
  }
});

test("standalone historical reads retain their separate per-invocation observation contract", async () => {
  const { command, install } = await setup();
  try {
    await install();
    expect(
      (
        await readFinancialRequestBoundR1History(
          connection,
          request,
          SCOPE.workspaceId,
          command.key.challengeRef,
        )
      ).status,
    ).toBe("found");
    expect(
      (
        await readFinancialRequestBoundR1History(
          connection,
          request,
          SCOPE.workspaceId,
          command.key.challengeRef,
        )
      ).status,
    ).toBe("found");
    expect(state.captures).toBe(2);
  } finally {
    f.close();
  }
});
