import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployError } from "../scripts/deploy/errors.ts";
import {
  createCloudflareDispatchNamespaceMutation,
  inspectManagedWorkerDispatchNamespace,
  type ManagedWorkerDispatchNamespaceMutation,
  type ManagedWorkerDispatchNamespaceState,
  runManagedWorkerDispatchNamespace,
} from "../scripts/deploy/managed-worker-dispatch-namespace.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployEnvironment } from "../scripts/deploy/qualification.ts";
import type { ManagedWorkerDispatchNamespaceTarget } from "../scripts/deploy/target.ts";

const COMMIT = "c".repeat(40);
const ACCOUNT_ID = "a".repeat(32);
const NAME = "takoserver-customers";
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function target(
  environment: DeployEnvironment,
  input: { readonly pinned?: boolean; readonly accountId?: string; readonly name?: string } = {},
): ManagedWorkerDispatchNamespaceTarget {
  return {
    kind: "takoserver.deploy-target@v2",
    environment,
    accountId: input.accountId ?? ACCOUNT_ID,
    cloudflareProviderExecutor: {
      dispatchNamespace: input.name ?? NAME,
      ...(input.pinned === false ? {} : { dispatchNamespaceId: ID }),
    },
  };
}

function metadata(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    created_by: "a".repeat(32),
    created_on: "2026-09-04T00:00:00Z",
    modified_by: "a".repeat(32),
    modified_on: "2026-09-04T00:00:00Z",
    namespace_id: ID,
    namespace_name: NAME,
    script_count: 0,
    trusted_workers: false,
    ...overrides,
  };
}

function invocation(environment: DeployEnvironment, action: "status" | "apply") {
  return {
    surface: "takoserver-managed-worker-dispatch-namespace" as const,
    action,
    environment,
    commit: COMMIT,
  };
}

function sequenceState(values: readonly (unknown | null)[]): ManagedWorkerDispatchNamespaceState {
  let index = 0;
  return {
    async dispatchNamespace() {
      const value = values[Math.min(index, values.length - 1)];
      index += 1;
      return value ?? null;
    },
  };
}

function runner(input: { readonly dirty?: boolean; readonly events?: string[] } = {}) {
  return async (command: readonly string[]): Promise<CommandResult> => {
    const joined = command.join(" ");
    if (joined === "git rev-parse HEAD") return result(`${COMMIT}\n`);
    if (joined === "git branch --show-current") return result("feature/dispatch-namespace\n");
    if (joined === "git status --porcelain=v1 -z --untracked-files=all") {
      return result(input.dirty === true ? " M src/example.ts\0" : "");
    }
    if (joined === "git fetch --quiet --all --prune") return result("");
    if (joined === `git branch -r --contains ${COMMIT}`) {
      return result("  origin/feature/dispatch-namespace\n");
    }
    if (joined === "bun run check") {
      input.events?.push("check");
      return result("green\n");
    }
    throw new Error(`unexpected command: ${joined}`);
  };
}

function result(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

test("classifies only absent unpinned state as creatable and never adopts automatically", () => {
  expect(inspectManagedWorkerDispatchNamespace(null, { name: NAME })).toMatchObject({
    status: "absent",
    plan: "create",
    ready: false,
  });
  expect(inspectManagedWorkerDispatchNamespace(null, { name: NAME, pinnedId: ID })).toMatchObject({
    status: "drift",
    plan: "refuse",
    ready: false,
  });
  expect(inspectManagedWorkerDispatchNamespace(metadata(), { name: NAME })).toMatchObject({
    status: "pin-existing",
    plan: "pin-existing",
    ready: false,
  });
  expect(
    inspectManagedWorkerDispatchNamespace(metadata({ script_count: 1 }), { name: NAME }),
  ).toMatchObject({ status: "drift", plan: "refuse", ready: false });
  expect(
    inspectManagedWorkerDispatchNamespace(metadata({ script_count: 9 }), {
      name: NAME,
      pinnedId: ID,
    }),
  ).toMatchObject({ status: "ready", plan: "none", ready: true });
});

test("treats malformed, renamed, changed-id and trusted metadata as drift", () => {
  for (const value of [
    false,
    metadata({ namespace_name: "another-namespace" }),
    metadata({ namespace_id: OTHER_ID }),
    metadata({ trusted_workers: true }),
    metadata({ trusted_workers: null }),
    metadata({ trusted_workers: undefined }),
    metadata({ trusted_workers: "false" }),
    metadata({ trusted_workers: 0 }),
    metadata({ trusted_workers: [] }),
    metadata({ trusted_workers: {} }),
    metadata({ script_count: -1 }),
    metadata({ modified_on: null }),
  ]) {
    expect(
      inspectManagedWorkerDispatchNamespace(value, { name: NAME, pinnedId: ID }),
    ).toMatchObject({ status: "drift", plan: "refuse", ready: false });
  }
});

test("omitted API trust flag uses the documented untrusted namespace default", () => {
  const value = { ...metadata() };
  delete value.trusted_workers;
  expect(inspectManagedWorkerDispatchNamespace(value, { name: NAME })).toMatchObject({
    status: "pin-existing",
    ready: false,
    namespace: { namespaceId: ID, scriptCount: 0, trustedWorkers: false },
  });
  expect(inspectManagedWorkerDispatchNamespace(value, { name: NAME, pinnedId: ID })).toMatchObject({
    status: "ready",
    ready: true,
    namespace: { trustedWorkers: false },
  });
});

test("POST uses the exact dispatch namespace API and body without leaking credentials", async () => {
  const requests: Request[] = [];
  const mutation = createCloudflareDispatchNamespaceMutation({
    accountId: ACCOUNT_ID,
    token: "private-provider-token",
    fetcher: async (request) => {
      requests.push(request);
      return Response.json({
        success: true,
        result: { namespace_id: ID, namespace_name: NAME, trusted_workers: false },
      });
    },
  });
  await expect(mutation.create(NAME)).resolves.toEqual({ namespaceId: ID });
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]?.url ?? "").pathname).toBe(
    `/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces`,
  );
  expect(requests[0]?.method).toBe("POST");
  expect(await requests[0]?.clone().json()).toEqual({ name: NAME });
  expect(await requests[0]?.clone().text()).not.toContain("private-provider-token");
});

test("lost POST acknowledgement is mutation-indeterminate and is never retried", async () => {
  let calls = 0;
  const mutation = createCloudflareDispatchNamespaceMutation({
    accountId: ACCOUNT_ID,
    token: "private-provider-token",
    fetcher: async () => {
      calls += 1;
      throw new Error("provider body private-provider-token");
    },
  });
  const failure = await mutation.create(NAME).catch((error) => error);
  expect(failure).toMatchObject({ phase: "mutation" });
  expect(String(failure)).not.toContain("private-provider-token");
  expect(calls).toBe(1);
});

test("integration fresh creation allows dirty source and returns an explicit target-pin handoff", async () => {
  const events: string[] = [];
  let creates = 0;
  const mutation: ManagedWorkerDispatchNamespaceMutation = {
    async create() {
      creates += 1;
      return { namespaceId: ID };
    },
  };
  const applied = await runManagedWorkerDispatchNamespace(
    invocation("integration", "apply"),
    target("integration", { pinned: false }),
    {
      state: sequenceState([null, null, metadata()]),
      mutate: mutation,
      run: runner({ dirty: true, events }),
      review: "independent-reviewer",
      rehearsalReceiptPath: "ignored-in-integration",
    },
  );
  expect(applied).toMatchObject({
    status: "pin-existing",
    ready: false,
    mutation: "created-needs-target-pin",
    namespaceId: ID,
    pinnedNamespaceId: null,
    rehearsalReceiptDigest: null,
  });
  expect(creates).toBe(1);
  expect(events).toEqual(["check"]);
});

test("creation readback without the optional trust field reaches the explicit pin handoff", async () => {
  const observed = { ...metadata() };
  delete observed.trusted_workers;
  let creates = 0;
  const applied = await runManagedWorkerDispatchNamespace(
    invocation("integration", "apply"),
    target("integration", { pinned: false }),
    {
      state: sequenceState([null, null, observed]),
      mutate: {
        async create() {
          creates += 1;
          return { namespaceId: ID };
        },
      },
      run: runner({ dirty: true }),
      review: "independent-reviewer",
    },
  );
  expect(applied).toMatchObject({
    status: "pin-existing",
    mutation: "created-needs-target-pin",
    namespaceId: ID,
    scriptCount: 0,
    trustedWorkers: false,
    ready: false,
  });
  expect(creates).toBe(1);
});

test("programmatic options cannot redirect creation away from the target account", async () => {
  const requests: string[] = [];
  const options = {
    accountId: "b".repeat(32),
    state: sequenceState([null, null, metadata()]),
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
    run: runner({ dirty: true }),
    review: "independent-reviewer",
    fetcher: async (request: Request) => {
      requests.push(request.url);
      return Response.json({ success: true, result: metadata() });
    },
  };
  await runManagedWorkerDispatchNamespace(
    invocation("integration", "apply"),
    target("integration", { pinned: false }),
    options,
  );
  expect(requests).toEqual([
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces`,
  ]);
});

test("rechecks absence immediately before POST and refuses an existing namespace", async () => {
  let creates = 0;
  const failure = await runManagedWorkerDispatchNamespace(
    invocation("integration", "apply"),
    target("integration", { pinned: false }),
    {
      state: sequenceState([null, metadata()]),
      mutate: {
        async create() {
          creates += 1;
          return { namespaceId: ID };
        },
      },
      run: runner(),
      review: "independent-reviewer",
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "preflight" });
  expect(String(failure)).toContain("changed before creation");
  expect(creates).toBe(0);
});

test("existing unpinned scripts and pinned absence always refuse mutation", async () => {
  for (const [selected, value] of [
    [target("integration", { pinned: false }), metadata({ script_count: 1 })],
    [target("integration"), null],
  ] as const) {
    let creates = 0;
    const failure = await runManagedWorkerDispatchNamespace(
      invocation("integration", "apply"),
      selected,
      {
        state: sequenceState([value]),
        mutate: {
          async create() {
            creates += 1;
            return { namespaceId: ID };
          },
        },
        run: runner(),
        review: "independent-reviewer",
      },
    ).catch((error) => error);
    expect(failure).toMatchObject({ phase: "preflight" });
    expect(creates).toBe(0);
  }
});

test("fresh creation rejects every ID, name, trust or emptiness readback mismatch", async () => {
  for (const [after, acknowledgedId] of [
    [metadata({ namespace_id: OTHER_ID }), ID],
    [metadata({ namespace_name: "another-namespace" }), ID],
    [metadata({ trusted_workers: true }), ID],
    [metadata({ script_count: 1 }), ID],
  ] as const) {
    let creates = 0;
    const failure = await runManagedWorkerDispatchNamespace(
      invocation("integration", "apply"),
      target("integration", { pinned: false }),
      {
        state: sequenceState([null, null, after]),
        mutate: {
          async create() {
            creates += 1;
            return { namespaceId: acknowledgedId };
          },
        },
        run: runner(),
        review: "independent-reviewer",
      },
    ).catch((error) => error);
    expect(failure).toMatchObject({ phase: "verification" });
    expect(creates).toBe(1);
  }
});

test("post-create readback failure is verification failure after exactly one POST", async () => {
  let reads = 0;
  let creates = 0;
  const failure = await runManagedWorkerDispatchNamespace(
    invocation("integration", "apply"),
    target("integration", { pinned: false }),
    {
      state: {
        async dispatchNamespace() {
          reads += 1;
          if (reads < 3) return null;
          throw new Error("readback unavailable");
        },
      },
      mutate: {
        async create() {
          creates += 1;
          return { namespaceId: ID };
        },
      },
      run: runner(),
      review: "independent-reviewer",
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "verification" });
  expect(creates).toBe(1);
});

test("production fresh creation consumes only a same-commit canonical owner-only rehearsal receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takoserver-dispatch-rehearsal-"));
  chmodSync(directory, 0o700);
  const receiptPath = join(directory, "receipt.json");
  try {
    const rehearsal = await runManagedWorkerDispatchNamespace(
      invocation("rehearsal", "apply"),
      target("rehearsal", { pinned: false, accountId: "b".repeat(32) }),
      {
        state: sequenceState([null, null, metadata()]),
        mutate: {
          async create() {
            return { namespaceId: ID };
          },
        },
        run: runner(),
        review: "rehearsal-reviewer",
        rehearsalReceiptPath: receiptPath,
      },
    );
    expect(rehearsal.rehearsalReceiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Number(lstatSync(receiptPath).mode & 0o777)).toBe(0o600);
    expect(readFileSync(receiptPath, "utf8")).not.toContain("token");

    let creates = 0;
    const production = await runManagedWorkerDispatchNamespace(
      invocation("production", "apply"),
      target("production", { pinned: false }),
      {
        state: sequenceState([null, null, metadata()]),
        mutate: {
          async create() {
            creates += 1;
            return { namespaceId: ID };
          },
        },
        run: runner(),
        review: "production-reviewer",
        rehearsalReceiptPath: receiptPath,
      },
    );
    expect(production).toMatchObject({
      mutation: "created-needs-target-pin",
      rehearsalReceiptDigest: rehearsal.rehearsalReceiptDigest,
    });
    expect(creates).toBe(1);

    const repeatedRehearsal = await runManagedWorkerDispatchNamespace(
      invocation("rehearsal", "apply"),
      target("rehearsal", { pinned: false, accountId: "b".repeat(32) }),
      {
        state: sequenceState([null]),
        mutate: {
          async create() {
            creates += 1;
            return { namespaceId: ID };
          },
        },
        run: runner(),
        review: "rehearsal-reviewer",
        rehearsalReceiptPath: receiptPath,
      },
    ).catch((error) => error);
    expect(repeatedRehearsal).toMatchObject({ phase: "preflight" });
    expect(String(repeatedRehearsal)).toContain("cannot be overwritten");
    expect(creates).toBe(1);

    chmodSync(receiptPath, 0o644);
    const looseReceipt = await runManagedWorkerDispatchNamespace(
      invocation("production", "apply"),
      target("production", { pinned: false }),
      {
        state: sequenceState([null]),
        mutate: {
          async create() {
            creates += 1;
            return { namespaceId: ID };
          },
        },
        run: runner(),
        review: "production-reviewer",
        rehearsalReceiptPath: receiptPath,
      },
    ).catch((error) => error);
    expect(looseReceipt).toMatchObject({ phase: "preflight" });
    expect(creates).toBe(1);

    chmodSync(receiptPath, 0o600);
    const wrongCommit = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    wrongCommit.sourceCommit = "d".repeat(40);
    writeFileSync(receiptPath, `${JSON.stringify(wrongCommit, null, 2)}\n`, { mode: 0o600 });
    const mismatchedReceipt = await runManagedWorkerDispatchNamespace(
      invocation("production", "apply"),
      target("production", { pinned: false }),
      {
        state: sequenceState([null]),
        mutate: {
          async create() {
            creates += 1;
            return { namespaceId: ID };
          },
        },
        run: runner(),
        review: "production-reviewer",
        rehearsalReceiptPath: receiptPath,
      },
    ).catch((error) => error);
    expect(mismatchedReceipt).toMatchObject({ phase: "preflight" });
    expect(String(mismatchedReceipt)).toContain("same commit");
    expect(creates).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("status is read-only and apply has no namespace override", async () => {
  const selected = target("integration");
  const topology = selected.cloudflareProviderExecutor;
  if (!topology) throw new Error("missing topology");
  const seen: string[] = [];
  const status = await runManagedWorkerDispatchNamespace(
    invocation("integration", "status"),
    selected,
    {
      state: {
        async dispatchNamespace(name) {
          seen.push(name);
          return metadata({ script_count: 3 });
        },
      },
      run: async () => {
        throw new Error("status must not run commands");
      },
      rehearsalReceiptPath: "not-an-absolute-path",
    },
  );
  expect(status).toMatchObject({ ready: true, plan: "none", namespaceId: ID });
  expect(seen).toEqual([topology.dispatchNamespace]);
});

test("CLI dispatch accepts the namespace-only bootstrap target without runtime qualification", () => {
  const directory = mkdtempSync(join(tmpdir(), "takoserver-dispatch-cli-"));
  const targetPath = join(directory, "rehearsal.json");
  writeFileSync(
    targetPath,
    `${JSON.stringify({
      kind: "takoserver.deploy-target@v2",
      environment: "rehearsal",
      accountId: ACCOUNT_ID,
      cloudflareProviderExecutor: { dispatchNamespace: NAME },
    })}\n`,
  );
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  environment.TAKOSERVER_DEPLOY_TARGET_REHEARSAL = targetPath;
  try {
    const accepted = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "..", "scripts", "deploy.ts"),
        "takoserver-managed-worker-dispatch-namespace",
        "--status",
        "--environment=rehearsal",
        `--commit=${COMMIT}`,
      ],
      { cwd: join(import.meta.dir, ".."), env: environment },
    );
    const acceptedError = new TextDecoder().decode(accepted.stderr);
    expect(acceptedError).toContain("CLOUDFLARE_API_TOKEN is required for rehearsal");
    expect(acceptedError).not.toContain("deploy refused");
    expect(acceptedError).not.toContain("releaseReadbackQualification");
    expect(acceptedError).not.toContain("supplies");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("provider errors never surface a response body", async () => {
  const marker = "provider-private-body";
  const mutation = createCloudflareDispatchNamespaceMutation({
    accountId: ACCOUNT_ID,
    token: "private-provider-token",
    fetcher: async () =>
      Response.json(
        { success: false, result: null, errors: [{ code: 1234, message: marker }] },
        { status: 403 },
      ),
  });
  const failure = (await mutation.create(NAME).catch((error) => error)) as DeployError;
  expect(failure.phase).toBe("mutation");
  expect(`${failure.message} ${failure.detail ?? ""}`).not.toContain(marker);
  expect(`${failure.message} ${failure.detail ?? ""}`).not.toContain("private-provider-token");
});
