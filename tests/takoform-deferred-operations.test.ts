import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderMutationDefinitiveRefusalError } from "../src/index.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { ProviderMutationRecoveryError } from "../src/provider-driver.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { TAKOFORM_APPLY_SELECTION_VERSION } from "../src/takoform/apply-selection.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverReceipt,
  TakoformHost,
  TakoformResourceDriver,
} from "../src/takoform/types.ts";
import { TakoformHostError } from "../src/takoform/types.ts";
import { createConfiguredHistoricalTakoformHost } from "./helpers/historical-takoform-host.ts";

const lane = "/apis/forms.takoform.com/v1beta4";
const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "DeferredThing",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    implementationDigest: `sha256:${"b".repeat(64)}`,
  },
  desiredSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  operations: ["create", "read", "update", "delete"],
};
const importForm: InstalledTakoformForm = {
  ...form,
  identity: {
    formRef: {
      ...form.identity.formRef,
      kind: "DeferredImportThing",
      schemaDigest: `sha256:${"f".repeat(64)}`,
    },
  },
  operations: [...form.operations, "import"],
};
const claimedForm: InstalledTakoformForm = {
  ...form,
  identity: {
    formRef: {
      ...form.identity.formRef,
      kind: "DeferredClaimedThing",
      schemaDigest: `sha256:${"d".repeat(64)}`,
    },
  },
  constraints: [{ kind: "claim", property: "/value" }],
};

/** A Form that publishes an address, so a receipt can be one it cannot carry. */
const publishingForm: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "DeferredEndpoint",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"c".repeat(64)}`,
    },
  },
  desiredSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { url: { type: "string", pattern: "^https://[a-z.-]+/$" } },
    required: ["url"],
    additionalProperties: false,
  },
  operations: ["create", "read", "update", "delete"],
};

/** A Form that holds a relation, so a parent can have a blocking dependent. */
const dependentForm: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "DeferredDependent",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"e".repeat(64)}`,
    },
  },
  desiredSchema: {
    type: "object",
    required: ["parent"],
    additionalProperties: false,
    properties: {
      parent: {
        type: "object",
        required: ["apiVersion", "kind", "name"],
        additionalProperties: false,
        "x-takoform-target-formrefs": [{ ...form.identity.formRef }],
        properties: {
          apiVersion: { const: form.identity.formRef.apiVersion },
          kind: { const: form.identity.formRef.kind },
          name: { type: "string" },
        },
      },
    },
  },
  operations: ["create", "read", "delete"],
};

const roots: string[] = [];
let schemaSeedRoot: string | undefined;
let schemaSeedPath: string | undefined;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  if (schemaSeedRoot) rmSync(schemaSeedRoot, { recursive: true, force: true });
});

describe("durable deferred Takoform operations", () => {
  test("serializes concurrent same-operation provider execution in the real store", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const entered = deferred();
    const release = deferred();
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        providerCalls += 1;
        entered.resolve();
        await release.promise;
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver).open();
    const desired = desiredResource("concurrent", "one-provider-call");
    const review = await prepareReview(opened.host, desired);
    const path = `${lane}/resources/example.forms.invalid/DeferredThing/concurrent`;
    const apply = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "PUT",
          headers: {
            "idempotency-key": "concurrent-provider-operation-0001",
            "if-none-match": "*",
          },
          body: JSON.stringify({ ...desired, review }),
        }),
      );

    const first = apply();
    await entered.promise;
    const second = apply();
    const earlySecond = await Promise.race([
      second,
      new Promise<undefined>((resolve) => setTimeout(resolve, 50)),
    ]);
    release.resolve();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(providerCalls).toBe(1);
    expect(firstResponse?.status).toBe(201);
    expect(earlySecond?.status).toBe(503);
    expect(secondResponse?.status).toBe(503);
    expect((await apply())?.status).toBe(201);
    expect(providerCalls).toBe(1);
    opened.close();
  });

  test("resumes the same exact provider mutation across renewed run authority", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let providerCalls = 0;
    const providerOperationIds: string[] = [];
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        providerCalls += 1;
        providerOperationIds.push(input.operationId);
        if (providerCalls === 1) {
          throw new TakoformHostError("backend_unavailable", 503);
        }
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver).open();
    const desired = desiredResource("renewed-authority", "same-desired-state");
    const review = await prepareReview(opened.host, desired);
    const path = `${lane}/resources/example.forms.invalid/DeferredThing/renewed-authority`;

    const first = await opened.host.handle(
      request(path, "primary", {
        method: "PUT",
        headers: {
          "idempotency-key": "renewed-authority-first-0001",
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(first?.status).toBe(503);
    expect(providerCalls).toBe(1);

    const retried = await opened.host.handle(
      request(path, "alternate", {
        method: "PUT",
        headers: {
          "idempotency-key": "renewed-authority-second-0001",
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(retried?.status).toBe(201);
    expect(providerCalls).toBe(2);
    expect(providerOperationIds).toHaveLength(2);
    expect(new Set(providerOperationIds).size).toBe(1);
    expect(
      opened.database
        .query(
          "SELECT operation_id FROM tf_provider_mutation_sagas_selection_v1 WHERE target_name = ?",
        )
        .all("renewed-authority"),
    ).toEqual([]);
    expect(
      opened.database
        .query("SELECT name FROM tf_resources WHERE name = ?")
        .all("renewed-authority"),
    ).toEqual([{ name: "renewed-authority" }]);
    opened.close();
  });

  test("survives Host reconstruction and settles through the real lifecycle engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-deferred-operation-"));
    roots.push(root);
    const databasePath = join(root, "control.sqlite");
    const driver = new InMemoryTakoformResourceDriver();
    let ids = 0;
    const openHost = (): {
      readonly host: TakoformHost;
      readonly close: () => void;
    } => {
      const database = new Database(databasePath);
      migrateSqlite(database);
      return {
        host: createConfiguredHistoricalTakoformHost({
          sql: createSqliteSql(database),
          objects: createMemoryObjectStore(),
          authenticate: async (request) => {
            const token = request.headers.get("authorization");
            if (token === "Bearer primary") {
              return { tenantId: "tenant-a", principalId: "principal-a" };
            }
            if (token === "Bearer alternate") {
              return { tenantId: "tenant-a", principalId: "principal-b" };
            }
            return null;
          },
          forms: [form],
          driver,
          routes: {
            hostApiVersion: "forms.takoform.com/v1beta4",
            apiPath: lane,
            supportProfileApiVersion: "support.takoform.com/v1alpha2",
            reviewSpecDigest: true,
          },
          deferredOperations: {
            shouldDefer: ({ request }) =>
              request.headers.get("takoform-conformance-probe") === "async",
            pollsBeforeCommit: 2,
            retryAfterSeconds: 0,
          },
          randomId: () => `stable-${++ids}`,
        }),
        close: () => database.close(),
      };
    };

    const desired = {
      apiVersion: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      form: { formRef: form.identity.formRef },
      metadata: { name: "durable", space: "main" },
      spec: { value: "first" },
    };
    let opened = openHost();
    const prepared = await opened.host.handle(
      request(`${lane}/resources/prepare`, "primary", {
        method: "POST",
        body: JSON.stringify(desired),
      }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("prepare returned no response");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const apply = request(
      `${lane}/resources/example.forms.invalid/DeferredThing/durable`,
      "primary",
      {
        method: "PUT",
        headers: {
          "idempotency-key": "create-durable-0001",
          "if-none-match": "*",
          "takoform-conformance-probe": "async",
        },
        body: JSON.stringify({ ...desired, review }),
      },
    );
    const accepted = await opened.host.handle(apply.clone());
    expect(accepted?.status).toBe(202);
    expect(accepted?.headers.get("retry-after")).toBe("0");
    if (!accepted) throw new Error("apply returned no response");
    const acceptedBody = (await accepted.json()) as {
      operation: { id: string; done: boolean };
    };
    expect(acceptedBody.operation).toMatchObject({ done: false });

    opened.close();
    opened = openHost();
    const replayed = await opened.host.handle(apply.clone());
    expect(await replayed?.json()).toEqual(acceptedBody);
    expect(replayed?.status).toBe(202);

    const operationPath = `${lane}/operations/${acceptedBody.operation.id}`;
    const hidden = await opened.host.handle(request(operationPath, "alternate"));
    expect(hidden?.status).toBe(404);
    expect(await hidden?.json()).toMatchObject({
      error: { code: "operation_not_found" },
    });

    const pending = await opened.host.handle(request(operationPath, "primary"));
    expect(pending?.status).toBe(200);
    expect(pending?.headers.get("retry-after")).toBe("0");
    expect(await pending?.json()).toEqual(acceptedBody.operation);

    const committing = await opened.host.handle(request(operationPath, "primary"));
    expect(committing?.headers.get("retry-after")).toBe("0");
    expect(await committing?.json()).toEqual(acceptedBody.operation);

    const settled = await opened.host.handle(request(operationPath, "primary"));
    expect(settled?.status).toBe(200);
    const settledText = await settled?.text();
    const settledBody = JSON.parse(settledText ?? "null") as {
      readonly result: { readonly resource: { readonly form: unknown } };
    };
    expect(settledBody).toMatchObject({
      apiVersion: "operations.takoform.com/v1alpha1",
      kind: "Operation",
      id: acceptedBody.operation.id,
      done: true,
      result: {
        resource: {
          metadata: { name: "durable", space: "main", uid: expect.any(String) },
          spec: { value: "first" },
        },
      },
    });
    expect(settledBody.result.resource.form).toEqual({
      formRef: form.identity.formRef,
    });
    const settledAgain = await opened.host.handle(request(operationPath, "primary"));
    expect(await settledAgain?.text()).toBe(settledText);
    opened.close();
  });

  test("has three closed cancel outcomes and never exposes another principal's operation", async () => {
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const memory = new InMemoryTakoformResourceDriver();
    const harness = persistentHarness(undefined, {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        if (input.name === "cancel-too-late") {
          providerEntered.resolve();
          await releaseProvider.promise;
        }
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    });
    const opened = harness.open();
    const first = await acceptCreate(opened.host, "cancel-before", "cancel-before-0001");
    const cancelled = await opened.host.handle(
      request(`${lane}/operations/${first}/cancel`, "primary", {
        method: "POST",
        headers: { "idempotency-key": "cancel-operation-0001" },
      }),
    );
    expect(cancelled?.status).toBe(200);
    const cancelledText = await cancelled?.text();
    expect(JSON.parse(cancelledText ?? "null")).toMatchObject({
      id: first,
      done: true,
      error: { code: "operation_cancelled", retryable: false },
    });
    const cancelledAgain = await opened.host.handle(
      request(`${lane}/operations/${first}/cancel`, "primary", {
        method: "POST",
        headers: { "idempotency-key": "cancel-operation-0002" },
      }),
    );
    expect(await cancelledAgain?.text()).toBe(cancelledText);

    const ready = await acceptCreate(opened.host, "cancel-ready", "cancel-ready-0001");
    await opened.host.handle(request(`${lane}/operations/${ready}`, "primary"));
    const readyCancellation = await opened.host.handle(
      request(`${lane}/operations/${ready}/cancel`, "primary", {
        method: "POST",
        headers: { "idempotency-key": "cancel-operation-ready-0001" },
      }),
    );
    expect(readyCancellation?.status).toBe(200);
    expect(await readyCancellation?.json()).toMatchObject({
      id: ready,
      done: true,
      error: { code: "operation_cancelled" },
    });

    const second = await acceptCreate(opened.host, "cancel-too-late", "cancel-late-0001");
    const firstPoll = await opened.host.handle(request(`${lane}/operations/${second}`, "primary"));
    expect(firstPoll?.headers.get("retry-after")).toBe("0");
    const committedIntent = await opened.host.handle(
      request(`${lane}/operations/${second}`, "primary"),
    );
    expect(committedIntent?.headers.get("retry-after")).toBe("0");
    const tooLate = await opened.host.handle(
      request(`${lane}/operations/${second}/cancel`, "primary", {
        method: "POST",
        headers: { "idempotency-key": "cancel-operation-late-0001" },
      }),
    );
    expect(tooLate?.status).toBe(409);
    expect(await tooLate?.json()).toMatchObject({
      error: { code: "operation_cancelled" },
    });
    const settling = opened.host.handle(request(`${lane}/operations/${second}`, "primary"));
    await providerEntered.promise;
    releaseProvider.resolve();
    const committed = await settling;
    const committedText = await committed?.text();
    expect(JSON.parse(committedText ?? "null")).toMatchObject({
      done: true,
      result: { resource: {} },
    });
    const settledCancel = await opened.host.handle(
      request(`${lane}/operations/${second}/cancel`, "primary", {
        method: "POST",
        headers: { "idempotency-key": "cancel-operation-settled-0001" },
      }),
    );
    expect(settledCancel?.status).toBe(200);
    expect(await settledCancel?.text()).toBe(committedText);

    for (const token of ["alternate", "other-tenant"]) {
      const hidden = await opened.host.handle(request(`${lane}/operations/${second}`, token));
      expect(hidden?.status).toBe(404);
      expect(await hidden?.json()).toMatchObject({
        error: { code: "operation_not_found" },
      });
    }
    opened.close();
  });

  test("recovers an expired commit lease and retains no transport credential or probe header", async () => {
    let now = Date.parse("2026-08-23T00:00:00.000Z");
    const harness = persistentHarness(() => new Date(now));
    let opened = harness.open();
    const operationId = await acceptCreate(opened.host, "recover", "recover-create-0001", {
      "x-operation-secret": "must-not-persist",
    });
    opened.database
      .query(
        `UPDATE tf_deferred_operations_selection_v1
         SET phase = 'committing', polls_remaining = 0,
             lease_token = 'lease_dead_process', lease_until = ?
         WHERE id = ?`,
      )
      .run(now + 1_000, operationId);
    const stored = opened.database
      .query(
        `SELECT request_headers_json, request_body_json
         FROM tf_deferred_operations_selection_v1 WHERE id = ?`,
      )
      .get(operationId) as {
      request_headers_json: string;
      request_body_json: string;
    };
    expect(stored.request_headers_json).not.toContain("authorization");
    expect(stored.request_headers_json).not.toContain("conformance-probe");
    expect(stored.request_headers_json).not.toContain("must-not-persist");
    expect(stored.request_body_json).not.toContain("must-not-persist");
    opened.close();

    now += 1_001;
    opened = harness.open();
    const recovered = await opened.host.handle(
      request(`${lane}/operations/${operationId}`, "primary"),
    );
    expect(recovered?.status).toBe(200);
    expect(await recovered?.json()).toMatchObject({
      done: true,
      result: { resource: {} },
    });
    opened.close();
  });

  test("retries the exact provider plan with the same operation after a lost receipt boundary", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const operationIds: string[] = [];
    const operationModes: Array<"initial" | "recovery" | undefined> = [];
    const providerHandles: Array<string | undefined> = [];
    let attempts = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      async apply(input) {
        operationIds.push(input.operationId);
        operationModes.push(input.operationMode);
        providerHandles.push(input.providerHandle);
        attempts += 1;
        if (attempts === 1) {
          throw new ProviderMutationRecoveryError("running", "opaque-provider-handle");
        }
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver).open();
    const operationId = await acceptCreate(
      opened.host,
      "provider-plan-retry",
      "provider-plan-retry-0001",
    );
    const operationPath = `${lane}/operations/${operationId}`;

    await opened.host.handle(request(operationPath, "primary"));
    await opened.host.handle(request(operationPath, "primary"));
    const held = await opened.host.handle(request(operationPath, "primary"));
    expect(await held?.json()).toMatchObject({ id: operationId, done: false });
    expect(
      opened.database
        .query(
          `SELECT phase, lease_token, lease_until, terminal_json
           FROM tf_deferred_operations_selection_v1 WHERE id = ?`,
        )
        .get(operationId),
    ).toEqual({
      phase: "committing",
      lease_token: null,
      lease_until: null,
      terminal_json: null,
    });
    expect(
      opened.database
        .query(
          `SELECT phase, receipt_json FROM tf_provider_mutation_sagas_selection_v1
           WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toEqual({ phase: "planned", receipt_json: null });
    expect(
      opened.database
        .query(
          `SELECT provider_handle, provider_outcome
           FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toEqual({ provider_handle: "opaque-provider-handle", provider_outcome: "running" });

    // Exercise the same path after the provider-mutation lease has expired:
    // recovery must still carry the durable handle and never dispatch again.
    opened.database
      .query(
        `UPDATE tf_provider_mutation_sagas_selection_v1
         SET execution_lease_until = 0 WHERE operation_id = ?`,
      )
      .run(operationId);
    const recovered = await opened.host.handle(request(operationPath, "primary"));
    expect(await recovered?.json()).toMatchObject({
      id: operationId,
      done: true,
      result: { resource: { metadata: { name: "provider-plan-retry" } } },
    });
    expect(operationIds).toEqual([operationId, operationId]);
    expect(operationModes).toEqual(["initial", "recovery"]);
    expect(providerHandles).toEqual([undefined, "opaque-provider-handle"]);
    expect(
      opened.database
        .query(
          "SELECT operation_id FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
        )
        .all(operationId),
    ).toEqual([]);
    opened.close();
  });

  test("retains recovery provenance when a cached receipt follows a lost Host commit", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const operationModes: Array<"initial" | "recovery" | undefined> = [];
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        providerCalls += 1;
        operationModes.push(input.operationMode);
        if (input.operationMode === "initial") {
          throw new ProviderMutationRecoveryError("indeterminate", "recovery-handle");
        }
        const receipt = await memory.apply(input);
        // The Host owns this reserved field; a provider cannot choose the mode.
        return { ...receipt, providerExecutionMode: "initial" };
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [form], {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const desired = desiredResource("receipt-recovery-provenance", "recovery");
    const review = await prepareReview(opened.host, desired);
    const path = `${lane}/resources/example.forms.invalid/DeferredThing/receipt-recovery-provenance`;
    const apply = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "PUT",
          headers: {
            "idempotency-key": "receipt-recovery-provenance-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify({ ...desired, review }),
        }),
      );

    const first = await apply();
    expect(first?.status).toBe(202);
    if (!first) throw new Error("initial recovery attempt returned no response");
    const operationId = ((await first.json()) as { operation: { id: string } }).operation.id;
    expect(operationModes).toEqual(["initial"]);

    const releaseFinalCommit = failNextProviderSagaCommit(opened.database);
    const lostCommit = await apply();
    expect(lostCommit?.status).toBe(202);
    expect(operationModes).toEqual(["initial", "recovery"]);
    expect(
      opened.database
        .query(
          `SELECT phase, receipt_json FROM tf_provider_mutation_sagas_selection_v1
           WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toMatchObject({
      phase: "executed",
      receipt_json: expect.stringContaining('"providerExecutionMode":"recovery"'),
    });

    releaseFinalCommit();
    const settled = await apply();
    expect(settled?.status).toBe(201);
    expect(providerCalls).toBe(2);
    expect(operationModes).toEqual(["initial", "recovery"]);
    expect(JSON.stringify(await settled?.json())).not.toContain("providerExecutionMode");
    expect(
      opened.database
        .query(
          `SELECT operation_mode FROM tf_resource_provider_effects
           WHERE effect_id = ? AND phase = 'succeeded'`,
        )
        .get(operationId),
    ).toEqual({ operation_mode: "recovery" });
    opened.close();
  });

  test("keeps initial provenance when a cached initial receipt follows a lost Host commit", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const operationModes: Array<"initial" | "recovery" | undefined> = [];
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        providerCalls += 1;
        operationModes.push(input.operationMode);
        const receipt = await memory.apply(input);
        // The provider attempts to forge recovery provenance on an initial call.
        return { ...receipt, providerExecutionMode: "recovery" };
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [form], {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const releaseFinalCommit = failNextProviderSagaCommit(opened.database);
    const desired = desiredResource("receipt-initial-provenance", "initial");
    const review = await prepareReview(opened.host, desired);
    const path = `${lane}/resources/example.forms.invalid/DeferredThing/receipt-initial-provenance`;
    const apply = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "PUT",
          headers: {
            "idempotency-key": "receipt-initial-provenance-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify({ ...desired, review }),
        }),
      );

    const lostCommit = await apply();
    expect(lostCommit?.status).toBe(202);
    if (!lostCommit) throw new Error("initial receipt commit returned no response");
    const operationId = ((await lostCommit.json()) as { operation: { id: string } }).operation.id;
    expect(providerCalls).toBe(1);
    expect(operationModes).toEqual(["initial"]);
    expect(
      opened.database
        .query(
          `SELECT phase, receipt_json FROM tf_provider_mutation_sagas_selection_v1
           WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toMatchObject({
      phase: "executed",
      receipt_json: expect.stringContaining('"providerExecutionMode":"initial"'),
    });

    releaseFinalCommit();
    const settled = await apply();
    expect(settled?.status).toBe(201);
    expect(providerCalls).toBe(1);
    expect(operationModes).toEqual(["initial"]);
    expect(JSON.stringify(await settled?.json())).not.toContain("providerExecutionMode");
    expect(
      opened.database
        .query(
          `SELECT operation_mode FROM tf_resource_provider_effects
           WHERE effect_id = ? AND phase = 'succeeded'`,
        )
        .get(operationId),
    ).toEqual({ operation_mode: "initial" });
    opened.close();
  });

  test("retains recovery provenance when a cached import receipt follows a lost Host commit", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const operationModes: Array<"initial" | "recovery" | undefined> = [];
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      selectImport: (input) => memory.selectImport(input),
      apply: (input) => memory.apply(input),
      import: async (input) => {
        providerCalls += 1;
        operationModes.push(input.operationMode);
        if (input.operationMode === "initial") {
          throw new ProviderMutationRecoveryError("indeterminate", "import-recovery-handle");
        }
        const receipt = await memory.import(input);
        // The provider attempts to forge initial provenance on a recovery call.
        return { ...receipt, providerExecutionMode: "initial" };
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [importForm], {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const desired = importedResource("receipt-import-recovery-provenance", "recovery");
    const path = `${lane}/resources/example.forms.invalid/DeferredImportThing/receipt-import-recovery-provenance/import`;
    const importResource = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "POST",
          headers: {
            "idempotency-key": "receipt-import-recovery-provenance-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify(desired),
        }),
      );

    const first = await importResource();
    expect(first?.status).toBe(202);
    if (!first) throw new Error("initial import recovery attempt returned no response");
    const operationId = ((await first.json()) as { operation: { id: string } }).operation.id;
    expect(operationModes).toEqual(["initial"]);

    const releaseFinalCommit = failNextProviderSagaCommit(opened.database);
    const lostCommit = await importResource();
    expect(lostCommit?.status).toBe(202);
    expect(operationModes).toEqual(["initial", "recovery"]);
    expect(
      opened.database
        .query(
          `SELECT phase, receipt_json FROM tf_provider_mutation_sagas_selection_v1
           WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toMatchObject({
      phase: "executed",
      receipt_json: expect.stringContaining('"providerExecutionMode":"recovery"'),
    });

    releaseFinalCommit();
    const settled = await importResource();
    expect(settled?.status).toBe(200);
    expect(providerCalls).toBe(2);
    expect(operationModes).toEqual(["initial", "recovery"]);
    expect(JSON.stringify(await settled?.json())).not.toContain("providerExecutionMode");
    expect(
      opened.database
        .query(
          `SELECT operation_mode FROM tf_resource_provider_effects
           WHERE effect_id = ? AND phase = 'succeeded'`,
        )
        .get(operationId),
    ).toEqual({ operation_mode: "recovery" });
    opened.close();
  });

  test("keeps initial provenance when a cached initial import receipt follows a lost Host commit", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const operationModes: Array<"initial" | "recovery" | undefined> = [];
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      selectImport: (input) => memory.selectImport(input),
      apply: (input) => memory.apply(input),
      import: async (input) => {
        providerCalls += 1;
        operationModes.push(input.operationMode);
        const receipt = await memory.import(input);
        // The provider attempts to forge recovery provenance on an initial call.
        return { ...receipt, providerExecutionMode: "recovery" };
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [importForm], {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const desired = importedResource("receipt-import-initial-provenance", "initial");
    const path = `${lane}/resources/example.forms.invalid/DeferredImportThing/receipt-import-initial-provenance/import`;
    const importResource = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "POST",
          headers: {
            "idempotency-key": "receipt-import-initial-provenance-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify(desired),
        }),
      );

    const releaseFinalCommit = failNextProviderSagaCommit(opened.database);
    const lostCommit = await importResource();
    expect(lostCommit?.status).toBe(202);
    if (!lostCommit) throw new Error("initial import receipt commit returned no response");
    const operationId = ((await lostCommit.json()) as { operation: { id: string } }).operation.id;
    expect(providerCalls).toBe(1);
    expect(operationModes).toEqual(["initial"]);
    expect(
      opened.database
        .query(
          `SELECT phase, receipt_json FROM tf_provider_mutation_sagas_selection_v1
           WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toMatchObject({
      phase: "executed",
      receipt_json: expect.stringContaining('"providerExecutionMode":"initial"'),
    });

    releaseFinalCommit();
    const settled = await importResource();
    expect(settled?.status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(operationModes).toEqual(["initial"]);
    expect(JSON.stringify(await settled?.json())).not.toContain("providerExecutionMode");
    expect(
      opened.database
        .query(
          `SELECT operation_mode FROM tf_resource_provider_effects
           WHERE effect_id = ? AND phase = 'succeeded'`,
        )
        .get(operationId),
    ).toEqual({ operation_mode: "initial" });
    opened.close();
  });

  test("uses durable recovery provenance for a cached provider delete receipt", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const deleteModes: Array<"initial" | "recovery" | undefined> = [];
    const recoveryActions: Array<"observe" | "converge" | undefined> = [];
    let deleteCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async (input) => {
        deleteCalls += 1;
        deleteModes.push(input.operationMode);
        recoveryActions.push(input.recoveryAction);
        if (input.operationMode === "initial") {
          throw new ProviderMutationRecoveryError("indeterminate", "delete-recovery-handle");
        }
        // The provider attempts to forge initial provenance on a recovery call.
        return { providerExecutionMode: "initial" };
      },
    };
    const opened = persistentHarness(undefined, driver, [form], {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const current = await createNow(opened.host, "receipt-delete-provenance");
    const query = new URLSearchParams({
      space: current.metadata.space,
      group: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      definitionVersion: form.identity.formRef.definitionVersion,
      schemaDigest: form.identity.formRef.schemaDigest,
    });
    const path = `${lane}/resources/example.forms.invalid/DeferredThing/receipt-delete-provenance?${query}`;
    const remove = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "DELETE",
          headers: {
            "idempotency-key": "receipt-delete-provenance-0001",
            "if-match": `"${current.metadata.revision}"`,
            "takoform-expected-generation": current.metadata.generation,
          },
        }),
      );

    const first = await remove();
    expect(first?.status).toBe(202);
    if (!first) throw new Error("initial delete recovery attempt returned no response");
    const operationId = ((await first.json()) as { operation: { id: string } }).operation.id;
    expect(deleteModes).toEqual(["initial"]);
    expect(recoveryActions).toEqual([undefined]);

    const releaseFinalCommit = failNextProviderSagaCommit(opened.database);
    const lostCommit = await remove();
    expect(lostCommit?.status).toBe(202);
    expect(deleteModes).toEqual(["initial", "recovery"]);
    expect(recoveryActions).toEqual([undefined, "observe"]);
    expect(
      opened.database
        .query(
          `SELECT phase, receipt_json FROM tf_provider_mutation_sagas_selection_v1
           WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toMatchObject({
      phase: "executed",
      receipt_json: expect.stringContaining('"providerExecutionMode":"recovery"'),
    });

    releaseFinalCommit();
    const settled = await remove();
    expect(settled?.status).toBe(204);
    expect(deleteCalls).toBe(2);
    expect(
      opened.database
        .query(
          `SELECT operation_mode FROM tf_resource_provider_effects
           WHERE effect_id = ? AND phase = 'succeeded'`,
        )
        .get(operationId),
    ).toEqual({ operation_mode: "recovery" });
    opened.close();
  });

  test("background repair marks delete recovery as maintenance convergence", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let defer = false;
    let now = Date.parse("2026-09-24T00:00:00.000Z");
    const recoveryActions: Array<"observe" | "converge" | undefined> = [];
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async (input) => {
        recoveryActions.push(input.recoveryAction);
        if (input.operationMode !== "recovery") {
          throw new ProviderMutationRecoveryError("indeterminate");
        }
        return await memory.delete(input);
      },
    };
    const opened = persistentHarness(() => new Date(now), driver, [form], {
      shouldDefer: () => defer,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const current = await createNow(opened.host, "maintenance-delete-convergence");
    defer = true;
    const query = new URLSearchParams({
      space: current.metadata.space,
      group: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      definitionVersion: form.identity.formRef.definitionVersion,
      schemaDigest: form.identity.formRef.schemaDigest,
    });
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/maintenance-delete-convergence?${query}`,
        "primary",
        {
          method: "DELETE",
          headers: {
            "idempotency-key": "maintenance-delete-convergence-0001",
            "if-match": `"${current.metadata.revision}"`,
            "takoform-expected-generation": current.metadata.generation,
          },
        },
      ),
    );
    expect(accepted?.status).toBe(202);
    expect(recoveryActions).toEqual([undefined]);
    const leases = opened.database
      .query(
        `SELECT operation.lease_until AS operation_lease_until,
                saga.execution_lease_until AS provider_lease_until
         FROM tf_deferred_operations_selection_v1 AS operation
         INNER JOIN tf_provider_mutation_sagas_selection_v1 AS saga
           ON saga.operation_id = operation.id
         WHERE operation.target_name = ?`,
      )
      .get("maintenance-delete-convergence") as {
      operation_lease_until: number | null;
      provider_lease_until: number | null;
    } | null;
    now = Math.max(now, leases?.operation_lease_until ?? 0, leases?.provider_lease_until ?? 0) + 1;
    const maintenance = opened.host.maintenance;
    if (!maintenance) throw new Error("durable Host maintenance is unavailable");
    expect(await maintenance.drainProviderRepairs(8)).toEqual({
      candidates: 1,
      acquired: 1,
      settled: 1,
      pending: 0,
    });
    expect(recoveryActions).toEqual([undefined, "converge"]);
    opened.close();
  });

  test("keeps initial provenance for a cached provider delete receipt", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const deleteModes: Array<"initial" | "recovery" | undefined> = [];
    let deleteCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async (input) => {
        deleteCalls += 1;
        deleteModes.push(input.operationMode);
        // The provider attempts to forge recovery provenance on an initial call.
        return { providerExecutionMode: "recovery" };
      },
    };
    const opened = persistentHarness(undefined, driver, [form], {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const current = await createNow(opened.host, "receipt-delete-initial-provenance");
    const query = new URLSearchParams({
      space: current.metadata.space,
      group: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      definitionVersion: form.identity.formRef.definitionVersion,
      schemaDigest: form.identity.formRef.schemaDigest,
    });
    const path = `${lane}/resources/example.forms.invalid/DeferredThing/receipt-delete-initial-provenance?${query}`;
    const remove = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "DELETE",
          headers: {
            "idempotency-key": "receipt-delete-initial-provenance-0001",
            "if-match": `"${current.metadata.revision}"`,
            "takoform-expected-generation": current.metadata.generation,
          },
        }),
      );

    const releaseFinalCommit = failNextProviderSagaCommit(opened.database);
    const lostCommit = await remove();
    expect(lostCommit?.status).toBe(202);
    if (!lostCommit) throw new Error("initial delete receipt commit returned no response");
    const operationId = ((await lostCommit.json()) as { operation: { id: string } }).operation.id;
    expect(deleteCalls).toBe(1);
    expect(deleteModes).toEqual(["initial"]);
    expect(
      opened.database
        .query(
          `SELECT phase, receipt_json FROM tf_provider_mutation_sagas_selection_v1
           WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toMatchObject({
      phase: "executed",
      receipt_json: expect.stringContaining('"providerExecutionMode":"initial"'),
    });

    releaseFinalCommit();
    const settled = await remove();
    expect(settled?.status).toBe(204);
    expect(deleteCalls).toBe(1);
    expect(deleteModes).toEqual(["initial"]);
    expect(
      opened.database
        .query(
          `SELECT operation_mode FROM tf_resource_provider_effects
           WHERE effect_id = ? AND phase = 'succeeded'`,
        )
        .get(operationId),
    ).toEqual({ operation_mode: "initial" });
    opened.close();
  });

  test("returns a 202 Operation handle when inline execution holds a provider-plan conflict", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async () => {
        providerCalls += 1;
        throw new TakoformHostError("resource_busy", 409);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [form], {
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const desired = desiredResource("inline-plan-conflict", "held-provider-plan");
    const review = await prepareReview(opened.host, desired);
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/inline-plan-conflict`,
        "primary",
        {
          method: "PUT",
          headers: {
            "idempotency-key": "inline-plan-conflict-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify({ ...desired, review }),
        },
      ),
    );
    expect(accepted?.status).toBe(202);
    expect(accepted?.headers.get("retry-after")).toBe("0");
    if (!accepted) throw new Error("inline plan conflict returned no response");
    const body: unknown = await accepted.json();
    expect(body).toEqual({
      operation: {
        apiVersion: "operations.takoform.com/v1alpha1",
        kind: "Operation",
        id: expect.any(String),
        done: false,
      },
    });
    expect(providerCalls).toBe(1);
    expect(
      opened.database
        .query("SELECT phase, terminal_json FROM tf_deferred_operations_selection_v1")
        .all(),
    ).toEqual([{ phase: "committing", terminal_json: null }]);
    opened.close();
  });

  test("returns a 202 Operation handle when an inline receipt commit loses its resource fence", async () => {
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const memory = new InMemoryTakoformResourceDriver();
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        if (input.previous) {
          providerCalls += 1;
          providerEntered.resolve();
          await releaseProvider.promise;
        }
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [form], {
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const current = await createNow(opened.host, "inline-receipt-conflict");
    const desired = desiredResource("inline-receipt-conflict", "inline-provider-update");
    const review = await prepareReview(opened.host, desired, {
      "takoform-expected-generation": current.metadata.generation,
    });
    const settling = opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/inline-receipt-conflict`,
        "primary",
        {
          method: "PUT",
          headers: {
            "idempotency-key": "inline-receipt-conflict-0001",
            "if-match": `"${current.metadata.revision}"`,
            "takoform-conformance-probe": "async",
            "takoform-expected-generation": current.metadata.generation,
          },
          body: JSON.stringify({
            ...desired,
            expectedUid: current.metadata.uid,
            expectedGeneration: current.metadata.generation,
            review,
          }),
        },
      ),
    );
    await providerEntered.promise;

    const concurrent = storedResource("inline-receipt-conflict", current.metadata.uid);
    concurrent.metadata.generation = current.metadata.generation;
    concurrent.metadata.revision = "99";
    concurrent.spec = { value: "concurrent-writer" };
    opened.database
      .query(
        `UPDATE tf_resources SET revision = '99', resource_json = ?
         WHERE tenant_id = 'tenant-a' AND space = 'main'
           AND api_version = 'example.forms.invalid' AND kind = 'DeferredThing'
           AND name = 'inline-receipt-conflict'`,
      )
      .run(JSON.stringify(concurrent));
    releaseProvider.resolve();

    const accepted = await settling;
    expect(accepted?.status).toBe(202);
    expect(accepted?.headers.get("retry-after")).toBe("0");
    if (!accepted) throw new Error("inline receipt conflict returned no response");
    const body: unknown = await accepted.json();
    expect(body).toEqual({
      operation: {
        apiVersion: "operations.takoform.com/v1alpha1",
        kind: "Operation",
        id: expect.any(String),
        done: false,
      },
    });
    expect(providerCalls).toBe(1);
    expect(
      opened.database
        .query("SELECT phase, receipt_json FROM tf_provider_mutation_sagas_selection_v1")
        .all(),
    ).toEqual([{ phase: "executed", receipt_json: expect.any(String) }]);
    opened.close();
  });

  test("tracks an inline import provider repair with a 202 Operation handle", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      selectImport: (input) => memory.selectImport(input),
      apply: (input) => memory.apply(input),
      import: async () => {
        providerCalls += 1;
        throw new ProviderMutationRecoveryError("indeterminate", "import-provider-handle");
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [importForm], {
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const desired = {
      apiVersion: importForm.identity.formRef.apiVersion,
      kind: importForm.identity.formRef.kind,
      form: { formRef: importForm.identity.formRef },
      metadata: { name: "inline-import-repair", space: "main" },
      spec: { value: "imported" },
      nativeId: "native-inline-import",
    };
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredImportThing/inline-import-repair/import`,
        "primary",
        {
          method: "POST",
          headers: {
            "idempotency-key": "inline-import-repair-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify(desired),
        },
      ),
    );
    expect(accepted?.status).toBe(202);
    expect(accepted?.headers.get("retry-after")).toBe("0");
    if (!accepted) throw new Error("inline import repair returned no response");
    const body: unknown = await accepted.json();
    expect(body).toEqual({
      operation: {
        apiVersion: "operations.takoform.com/v1alpha1",
        kind: "Operation",
        id: expect.any(String),
        done: false,
      },
    });
    expect(providerCalls).toBe(1);
    opened.close();
  });

  test("tracks an inline delete provider repair with a 202 Operation handle", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async () => {
        providerCalls += 1;
        throw new ProviderMutationRecoveryError("indeterminate", "delete-provider-handle");
      },
    };
    const opened = persistentHarness(undefined, driver, [form], {
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const current = await createNow(opened.host, "inline-delete-repair");
    const query = new URLSearchParams({
      space: "main",
      group: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      definitionVersion: form.identity.formRef.definitionVersion,
      schemaDigest: form.identity.formRef.schemaDigest,
    });
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/inline-delete-repair?${query}`,
        "primary",
        {
          method: "DELETE",
          headers: {
            "idempotency-key": "inline-delete-repair-0001",
            "takoform-conformance-probe": "async",
            "takoform-expected-generation": current.metadata.generation,
          },
        },
      ),
    );
    expect(accepted?.status).toBe(202);
    expect(accepted?.headers.get("retry-after")).toBe("0");
    if (!accepted) throw new Error("inline delete repair returned no response");
    const body: unknown = await accepted.json();
    expect(body).toEqual({
      operation: {
        apiVersion: "operations.takoform.com/v1alpha1",
        kind: "Operation",
        id: expect.any(String),
        done: false,
      },
    });
    expect(providerCalls).toBe(1);
    opened.close();
  });

  test("keeps an inline terminal dependency failure as a 409 response", async () => {
    const occupied = "the provider still has dependent objects";
    const memory = new InMemoryTakoformResourceDriver();
    let refusing = false;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async (input) => {
        if (refusing) {
          throw new ProviderMutationDefinitiveRefusalError("dependency_in_use", 409, occupied);
        }
        return await memory.delete(input);
      },
    };
    const opened = persistentHarness(undefined, driver, [form], {
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const current = await createNow(opened.host, "inline-terminal-failure");
    refusing = true;
    const query = new URLSearchParams({
      space: "main",
      group: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      definitionVersion: form.identity.formRef.definitionVersion,
      schemaDigest: form.identity.formRef.schemaDigest,
    });
    const failed = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/inline-terminal-failure?${query}`,
        "primary",
        {
          method: "DELETE",
          headers: {
            "idempotency-key": "inline-terminal-failure-0001",
            "takoform-conformance-probe": "async",
            "takoform-expected-generation": current.metadata.generation,
          },
        },
      ),
    );
    expect(failed?.status).toBe(409);
    expect(await failed?.json()).toMatchObject({
      error: { code: "dependency_in_use", message: occupied, retryable: false },
    });
    opened.close();
  });

  test("rereads a terminal operation completed during a repair hold instead of returning its stale error", async () => {
    let database: Database | undefined;
    const memory = new InMemoryTakoformResourceDriver();
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        if (!database) throw new Error("test database is unavailable");
        const terminalJson = JSON.stringify({
          apiVersion: "operations.takoform.com/v1alpha1",
          kind: "Operation",
          id: input.operationId,
          done: true,
          error: {
            code: "dependency_in_use",
            message: "another worker terminalized this operation",
            requestId: `req_${input.operationId}`,
            retryable: false,
          },
        });
        database
          .query(
            `UPDATE tf_deferred_operations_selection_v1
             SET phase = 'failed', terminal_json = ?, lease_token = NULL, lease_until = NULL
             WHERE id = ? AND phase = 'committing'`,
          )
          .run(terminalJson, input.operationId);
        throw new ProviderMutationRecoveryError("indeterminate", "stale-provider-handle");
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [form], {
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    database = opened.database;
    const desired = desiredResource("inline-terminal-reread", "terminalized-elsewhere");
    const review = await prepareReview(opened.host, desired);
    const response = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/inline-terminal-reread`,
        "primary",
        {
          method: "PUT",
          headers: {
            "idempotency-key": "inline-terminal-reread-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify({ ...desired, review }),
        },
      ),
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      error: {
        code: "dependency_in_use",
        message: "another worker terminalized this operation",
        retryable: false,
      },
    });
    opened.close();
  });

  test("background drain converges every dispatched no-receipt operation exactly once", async () => {
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    const memory = new InMemoryTakoformResourceDriver();
    const initialEntered = deferred();
    const releaseInitial = deferred();
    const recoveryEntered = deferred();
    const releaseRecovery = deferred();
    const operationIds: string[] = [];
    const modes: Array<"initial" | "recovery" | undefined> = [];
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      async apply(input) {
        operationIds.push(input.operationId);
        modes.push(input.operationMode);
        if (input.operationMode !== "recovery") {
          initialEntered.resolve();
          await releaseInitial.promise;
          throw new ProviderMutationRecoveryError("indeterminate");
        }
        recoveryEntered.resolve();
        await releaseRecovery.promise;
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(() => new Date(now), driver).open();
    const operationId = await acceptCreate(
      opened.host,
      "automatic-provider-repair",
      "automatic-provider-repair-0001",
    );
    const operationPath = `${lane}/operations/${operationId}`;
    await opened.host.handle(request(operationPath, "primary"));
    await opened.host.handle(request(operationPath, "primary"));
    const initial = opened.host.handle(request(operationPath, "primary"));
    await initialEntered.promise;
    expect(
      opened.database
        .query(
          `SELECT operation.expires_at AS operation_expiry, saga.expires_at AS saga_expiry
           FROM tf_deferred_operations_selection_v1 AS operation
           INNER JOIN tf_provider_mutation_sagas_selection_v1 AS saga ON saga.operation_id = operation.id
           WHERE operation.id = ?`,
        )
        .get(operationId),
    ).toEqual({
      operation_expiry: 253402300799999,
      saga_expiry: 253402300799999,
    });
    // The exact dispatched command remains drainable beyond the ordinary
    // seven-day replay window, even if this worker died before its catch path.
    now += 8 * 24 * 60 * 60_000;
    releaseInitial.resolve();
    const held = await initial;
    expect(await held?.json()).toMatchObject({ id: operationId, done: false });

    const maintenance = opened.host.maintenance;
    if (!maintenance) throw new Error("durable Host maintenance is unavailable");
    const firstDrain = maintenance.drainProviderRepairs(8);
    await recoveryEntered.promise;
    const duplicateDrain = await maintenance.drainProviderRepairs(8);
    expect(duplicateDrain).toEqual({ candidates: 0, acquired: 0, settled: 0, pending: 0 });
    releaseRecovery.resolve();
    expect(await firstDrain).toEqual({ candidates: 1, acquired: 1, settled: 1, pending: 0 });

    const terminal = await opened.host.handle(request(operationPath, "primary"));
    expect(await terminal?.json()).toMatchObject({
      id: operationId,
      done: true,
      result: { resource: { metadata: { name: "automatic-provider-repair" } } },
    });
    expect(operationIds).toEqual([operationId, operationId]);
    expect(modes).toEqual(["initial", "recovery"]);
    expect(await maintenance.drainProviderRepairs(8)).toEqual({
      candidates: 0,
      acquired: 0,
      settled: 0,
      pending: 0,
    });
    opened.close();
  });

  test("reservation-bearing requests are durable before dispatch and cancellation stays terminal", async () => {
    const opened = persistentHarness().open();
    const desired = desiredResource("reserved-durable", "reserved");
    const prepared = await opened.host.handle(
      request(`${lane}/resources/prepare`, "reserved", {
        method: "POST",
        body: JSON.stringify(desired),
      }),
    );
    if (!prepared?.ok) throw new Error(`reserved prepare failed: ${prepared?.status}`);
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/reserved-durable`,
        "reserved",
        {
          method: "PUT",
          headers: {
            "idempotency-key": "reserved-durable-0001",
            "if-none-match": "*",
          },
          body: JSON.stringify({ ...desired, review }),
        },
      ),
    );
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("reservation operation was not accepted");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    expect(
      opened.database
        .query(
          `SELECT phase, worker_endpoint_origin_reservation_id AS reservation
           FROM tf_deferred_operations_selection_v1 WHERE id = ?`,
        )
        .get(operationId),
    ).toEqual({ phase: "pending", reservation: "endpoint-reservation-01" });

    const cancelled = await opened.host.handle(
      request(`${lane}/operations/${operationId}/cancel`, "reserved", {
        method: "POST",
        headers: { "idempotency-key": "reserved-durable-cancel-0001" },
      }),
    );
    expect(await cancelled?.json()).toMatchObject({
      id: operationId,
      done: true,
      error: { code: "operation_cancelled" },
    });
    expect(await opened.host.maintenance?.drainProviderRepairs(8)).toEqual({
      candidates: 0,
      acquired: 0,
      settled: 0,
      pending: 0,
    });
    opened.close();
  });

  test("a stale lease cannot release the recovered worker's claim reservation", async () => {
    let now = Date.parse("2026-08-23T00:00:00.000Z");
    const root = mkdtempSync(join(tmpdir(), "takoserver-deferred-claim-"));
    roots.push(root);
    const database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    const entered = [deferred(), deferred()];
    const released = [deferred(), deferred()];
    let calls = 0;
    const driver: TakoformResourceDriver = {
      async selectApply() {
        return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
      },
      async apply(input) {
        const call = calls++;
        entered[call]?.resolve();
        await released[call]?.promise;
        return { observed: input.spec };
      },
      async observe(input) {
        return { observed: input.resource.spec };
      },
      async delete() {},
    };
    let ids = 0;
    const host = createConfiguredHistoricalTakoformHost({
      sql: createSqliteSql(database),
      objects: createMemoryObjectStore(),
      authenticate: async () => ({
        tenantId: "tenant-a",
        principalId: "principal-a",
      }),
      forms: [claimedForm],
      driver,
      routes: {
        hostApiVersion: "forms.takoform.com/v1beta4",
        apiPath: lane,
        supportProfileApiVersion: "support.takoform.com/v1alpha2",
        reviewSpecDigest: true,
      },
      deferredOperations: {
        shouldDefer: () => true,
        pollsBeforeCommit: 1,
        retryAfterSeconds: 0,
        leaseMilliseconds: 1_000,
      },
      clock: () => new Date(now),
      randomId: () => `lease-claim-${++ids}`,
    });
    const desired = {
      apiVersion: claimedForm.identity.formRef.apiVersion,
      kind: claimedForm.identity.formRef.kind,
      form: { formRef: claimedForm.identity.formRef },
      metadata: { name: "claimed", space: "main" },
      spec: { value: "exclusive" },
    };
    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, "primary", {
        method: "POST",
        body: JSON.stringify(desired),
      }),
    );
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.status}`);
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const accepted = await host.handle(
      request(`${lane}/resources/example.forms.invalid/DeferredClaimedThing/claimed`, "primary", {
        method: "PUT",
        headers: {
          "idempotency-key": "deferred-claim-create-0001",
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    if (accepted?.status !== 202) throw new Error(`accept failed: ${accepted?.status}`);
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    const operationPath = `${lane}/operations/${operationId}`;

    await host.handle(request(operationPath, "primary"));
    const staleExecution = host.handle(request(operationPath, "primary"));
    await entered[0]?.promise;
    now += 1_001;
    const recoveredExecution = host.handle(request(operationPath, "primary"));
    await entered[1]?.promise;

    released[0]?.resolve();
    await staleExecution;
    expect(
      database.query("SELECT state FROM tf_resource_claims WHERE holder_name = 'claimed'").all(),
    ).toEqual([{ state: "reserved" }]);

    released[1]?.resolve();
    const settled = await recoveredExecution;
    expect(await settled?.json()).toMatchObject({
      done: true,
      result: { resource: {} },
    });
    expect(
      database.query("SELECT state FROM tf_resource_claims WHERE holder_name = 'claimed'").all(),
    ).toEqual([{ state: "committed" }]);
    database.close();
  });

  test("a deferred no-op preserves the live Resource's committed claim", async () => {
    const opened = persistentHarness(undefined, new InMemoryTakoformResourceDriver(), [
      claimedForm,
    ]).open();
    const desired = (name: string) => ({
      apiVersion: claimedForm.identity.formRef.apiVersion,
      kind: claimedForm.identity.formRef.kind,
      form: { formRef: claimedForm.identity.formRef },
      metadata: { name, space: "main" },
      spec: { value: "one-deferred-claim" },
    });
    const holder = desired("deferred-holder");
    const holderReview = await prepareReviewFor(opened.host, holder);
    const created = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredClaimedThing/deferred-holder`,
        "primary",
        {
          method: "PUT",
          headers: {
            "idempotency-key": "deferred-holder-create-0001",
            "if-none-match": "*",
          },
          body: JSON.stringify({ ...holder, review: holderReview }),
        },
      ),
    );
    expect(created?.status).toBe(201);
    if (!created) throw new Error("deferred claim holder create returned no response");
    const generation = String(
      ((await created.json()) as { metadata?: { generation?: unknown } }).metadata?.generation,
    );

    const noOpReview = await prepareReviewFor(opened.host, holder, {
      "takoform-expected-generation": generation,
    });
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredClaimedThing/deferred-holder`,
        "primary",
        {
          method: "PUT",
          headers: {
            "idempotency-key": "deferred-holder-no-op-0001",
            "takoform-conformance-probe": "async",
            "takoform-expected-generation": generation,
          },
          body: JSON.stringify({ ...holder, review: noOpReview }),
        },
      ),
    );
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("deferred no-op returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    const operationPath = `${lane}/operations/${operationId}`;
    await opened.host.handle(request(operationPath, "primary"));
    await opened.host.handle(request(operationPath, "primary"));
    const settled = await opened.host.handle(request(operationPath, "primary"));
    expect(await settled?.json()).toMatchObject({
      done: true,
      result: { resource: { metadata: { name: "deferred-holder" } } },
    });

    const contender = desired("deferred-contender");
    const contenderReview = await prepareReviewFor(opened.host, contender);
    const refused = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredClaimedThing/deferred-contender`,
        "primary",
        {
          method: "PUT",
          headers: {
            "idempotency-key": "deferred-contender-create-0001",
            "if-none-match": "*",
          },
          body: JSON.stringify({ ...contender, review: contenderReview }),
        },
      ),
    );
    expect(refused?.status).toBe(400);
    expect(await refused?.json()).toMatchObject({ error: { code: "invalid_argument" } });
    opened.close();
  });

  test("refuses a replacement incarnation before provider work and records a deterministic terminal", async () => {
    let providerCalls = 0;
    const memory = new InMemoryTakoformResourceDriver();
    const harness = persistentHarness(undefined, {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        providerCalls += 1;
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    });
    const opened = harness.open();
    const operationId = await acceptCreate(opened.host, "fenced", "fenced-create-0001");
    opened.database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, relations_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '1', '1', ?, '[]', 1)`,
      )
      .run(
        "tenant-a",
        "main",
        form.identity.formRef.apiVersion,
        form.identity.formRef.kind,
        "fenced",
        "uid_replacement",
        JSON.stringify(storedResource("fenced", "uid_replacement")),
      );
    await opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    await opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    const terminal = await opened.host.handle(
      request(`${lane}/operations/${operationId}`, "primary"),
    );
    expect(await terminal?.json()).toMatchObject({
      done: true,
      error: {
        code: "uid_mismatch",
        message: "the accepted resource incarnation changed",
        requestId: `req_${operationId}`,
        retryable: false,
      },
    });
    expect(providerCalls).toBe(0);
    opened.close();
  });

  test("holds an executed update receipt until its exact logical revision is repaired", async () => {
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const memory = new InMemoryTakoformResourceDriver();
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        if (input.previous) {
          providerCalls += 1;
          providerEntered.resolve();
          await releaseProvider.promise;
        }
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver).open();
    const current = await createNow(opened.host, "update-fence");
    const desired = desiredResource("update-fence", "provider-update");
    const review = await prepareReview(opened.host, desired, {
      "takoform-expected-generation": current.metadata.generation,
    });
    const accepted = await opened.host.handle(
      request(`${lane}/resources/example.forms.invalid/DeferredThing/update-fence`, "primary", {
        method: "PUT",
        headers: {
          "idempotency-key": "update-fence-0001",
          "if-match": `"${current.metadata.revision}"`,
          "takoform-conformance-probe": "async",
          "takoform-expected-generation": current.metadata.generation,
        },
        body: JSON.stringify({
          ...desired,
          expectedUid: current.metadata.uid,
          expectedGeneration: current.metadata.generation,
          review,
        }),
      }),
    );
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("update returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    await opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    await opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    const settling = opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    await providerEntered.promise;

    const concurrent = storedResource("update-fence", current.metadata.uid);
    concurrent.metadata.generation = current.metadata.generation;
    concurrent.metadata.revision = "99";
    concurrent.spec = { value: "concurrent-writer" };
    opened.database
      .query(
        `UPDATE tf_resources SET revision = '99', resource_json = ?
         WHERE tenant_id = 'tenant-a' AND space = 'main'
           AND api_version = 'example.forms.invalid' AND kind = 'DeferredThing'
           AND name = 'update-fence'`,
      )
      .run(JSON.stringify(concurrent));
    releaseProvider.resolve();

    const repairRequired = await settling;
    expect(await repairRequired?.json()).toMatchObject({
      done: false,
      id: operationId,
    });
    expect(providerCalls).toBe(1);
    expect(
      opened.database.query("SELECT revision FROM tf_resources WHERE name = 'update-fence'").get(),
    ).toEqual({ revision: "99" });
    expect(
      opened.database
        .query(
          "SELECT phase, expires_at FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
        )
        .get(operationId),
    ).toEqual({ phase: "executed", expires_at: null });

    const competingDesired = desiredResource("update-fence", "competing-writer");
    const competingReview = await prepareReview(opened.host, competingDesired, {
      "takoform-expected-generation": current.metadata.generation,
    });
    const competing = await opened.host.handle(
      request(`${lane}/resources/example.forms.invalid/DeferredThing/update-fence`, "primary", {
        method: "PUT",
        headers: {
          "idempotency-key": "update-fence-competing-0001",
          "if-match": '"99"',
          "takoform-expected-generation": current.metadata.generation,
        },
        body: JSON.stringify({
          ...competingDesired,
          expectedUid: current.metadata.uid,
          expectedGeneration: current.metadata.generation,
          review: competingReview,
        }),
      }),
    );
    expect(competing?.status).toBe(409);
    expect(await competing?.json()).toMatchObject({
      error: { code: "resource_busy" },
    });
    expect(providerCalls).toBe(1);

    opened.database
      .query(
        `UPDATE tf_resources SET revision = ?, resource_json = ?
         WHERE tenant_id = 'tenant-a' AND space = 'main'
           AND api_version = 'example.forms.invalid' AND kind = 'DeferredThing'
           AND name = 'update-fence'`,
      )
      .run(current.metadata.revision, JSON.stringify(current));
    const repaired = await opened.host.handle(
      request(`${lane}/operations/${operationId}`, "primary"),
    );
    expect(await repaired?.json()).toMatchObject({
      done: true,
      result: { resource: { spec: { value: "provider-update" } } },
    });
    expect(providerCalls).toBe(1);
    expect(
      opened.database
        .query(
          "SELECT operation_id FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
        )
        .all(operationId),
    ).toEqual([]);
    opened.close();
  });

  /**
   * The revision is not the delete fence, and pinning it wedged a real
   * teardown.
   *
   * A deferred `ModuleWorker` delete was accepted at revision 2; deleting the
   * Worker's dependents re-rendered the parent and the live revision became 3.
   * Every retry replayed the same durable record under the provider's
   * deterministic delete idempotency key and answered 412 forever. The released
   * provider states the rule on every resource page and sends no `If-Match` on
   * a delete, so the Host now honours it: incarnation and generation fence a
   * delete, and a revision that moved under it does not.
   */
  test("commits a delete whose logical revision moved while the provider ran", async () => {
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const memory = new InMemoryTakoformResourceDriver();
    let providerDeleteCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async (input) => {
        providerDeleteCalls += 1;
        providerEntered.resolve();
        await releaseProvider.promise;
        return await memory.delete(input);
      },
    };
    const opened = persistentHarness(undefined, driver).open();
    const current = await createNow(opened.host, "delete-fence");
    const query = new URLSearchParams({
      space: "main",
      group: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      definitionVersion: form.identity.formRef.definitionVersion,
      schemaDigest: form.identity.formRef.schemaDigest,
    });
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/delete-fence?${query}`,
        "primary",
        {
          method: "DELETE",
          headers: {
            "idempotency-key": "delete-fence-0001",
            "if-match": `"${current.metadata.revision}"`,
            "takoform-conformance-probe": "async",
            "takoform-expected-generation": current.metadata.generation,
          },
        },
      ),
    );
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("delete returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    await opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    await opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    const settling = opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    await providerEntered.promise;

    const concurrent = storedResource("delete-fence", current.metadata.uid);
    concurrent.metadata.generation = current.metadata.generation;
    concurrent.metadata.revision = "91";
    opened.database
      .query(
        `UPDATE tf_resources SET revision = '91', resource_json = ?
         WHERE tenant_id = 'tenant-a' AND space = 'main'
           AND api_version = 'example.forms.invalid' AND kind = 'DeferredThing'
           AND name = 'delete-fence'`,
      )
      .run(JSON.stringify(concurrent));
    releaseProvider.resolve();

    expect(await (await settling)?.json()).toMatchObject({
      done: true,
      result: { deleted: true },
    });
    expect(providerDeleteCalls).toBe(1);
    expect(
      opened.database.query("SELECT name FROM tf_resources WHERE name = 'delete-fence'").all(),
    ).toEqual([]);
    expect(
      opened.database
        .query(
          `SELECT action, resource_generation, resource_revision
           FROM tf_resource_execution_evidence
           WHERE tenant_id = 'tenant-a' AND operation_id = ?`,
        )
        .get(operationId),
    ).toEqual({
      action: "delete",
      resource_generation: current.metadata.generation,
      resource_revision: "91",
    });
    opened.close();
  });

  test("still refuses a delete whose generation moved while the provider ran", async () => {
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const memory = new InMemoryTakoformResourceDriver();
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async (input) => {
        providerEntered.resolve();
        await releaseProvider.promise;
        return await memory.delete(input);
      },
    };
    const opened = persistentHarness(undefined, driver).open();
    const current = await createNow(opened.host, "generation-fence");
    const query = new URLSearchParams({
      space: "main",
      group: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      definitionVersion: form.identity.formRef.definitionVersion,
      schemaDigest: form.identity.formRef.schemaDigest,
    });
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/generation-fence?${query}`,
        "primary",
        {
          method: "DELETE",
          headers: {
            "idempotency-key": "generation-fence-0001",
            "takoform-conformance-probe": "async",
            "takoform-expected-generation": current.metadata.generation,
          },
        },
      ),
    );
    if (!accepted) throw new Error("delete returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    await opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    await opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    const settling = opened.host.handle(request(`${lane}/operations/${operationId}`, "primary"));
    await providerEntered.promise;

    // A different desired state, not a re-render: the caller asked to delete
    // something that is no longer what is there.
    const concurrent = storedResource("generation-fence", current.metadata.uid);
    concurrent.metadata.generation = "2";
    concurrent.metadata.revision = "2";
    opened.database
      .query(
        `UPDATE tf_resources SET generation = '2', revision = '2', resource_json = ?
         WHERE tenant_id = 'tenant-a' AND space = 'main'
           AND api_version = 'example.forms.invalid' AND kind = 'DeferredThing'
           AND name = 'generation-fence'`,
      )
      .run(JSON.stringify(concurrent));
    releaseProvider.resolve();

    expect(await (await settling)?.json()).toMatchObject({ done: false, id: operationId });
    expect(
      opened.database
        .query("SELECT generation FROM tf_resources WHERE name = 'generation-fence'")
        .get(),
    ).toEqual({ generation: "2" });
    opened.close();
  });

  /**
   * The teardown sequence the self-host end-to-end run could not complete.
   *
   * `tofu destroy` deletes a parent whose dependents are still present, gets a
   * refusal, removes the dependents, and asks again — under the *same*
   * plan-derived idempotency key, because the provider derives a delete key
   * from ref/name/space/uid/generation and none of those moved. Every step of
   * that must be able to happen twice.
   */
  test("a refused delete can be retried under the same key once its dependents are gone", async () => {
    const opened = persistentHarness(undefined, undefined, [form, dependentForm]).open();
    const parent = await createNow(opened.host, "parent");
    const child = {
      apiVersion: dependentForm.identity.formRef.apiVersion,
      kind: dependentForm.identity.formRef.kind,
      form: { formRef: dependentForm.identity.formRef },
      metadata: { name: "child", space: "main" },
      spec: {
        parent: {
          apiVersion: form.identity.formRef.apiVersion,
          kind: form.identity.formRef.kind,
          name: "parent",
        },
      },
    };
    const created = await opened.host.handle(
      request(`${lane}/resources/example.forms.invalid/DeferredDependent/child`, "primary", {
        method: "PUT",
        headers: {
          "idempotency-key": "create-child-0001",
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...child, review: await prepareReviewFor(opened.host, child) }),
      }),
    );
    expect(created?.status).toBe(201);

    // The deferred lane, which is what a Host answering 202 puts the provider
    // through: the refusal is recorded against the durable acceptance, and the
    // retry arrives on the same replay key.
    const deleteParent = async () =>
      await opened.host.handle(
        request(
          `${lane}/resources/example.forms.invalid/DeferredThing/parent?${new URLSearchParams({
            space: "main",
            group: form.identity.formRef.apiVersion,
            kind: form.identity.formRef.kind,
            definitionVersion: form.identity.formRef.definitionVersion,
            schemaDigest: form.identity.formRef.schemaDigest,
          })}`,
          "primary",
          {
            method: "DELETE",
            headers: {
              // The provider's key: derived from the address and generation,
              // which a refused delete leaves exactly where they were.
              "idempotency-key": "delete-parent-0001",
              "takoform-conformance-probe": "async",
              "takoform-expected-generation": parent.metadata.generation,
            },
          },
        ),
      );

    // The provider polls until the operation settles; the parent still has a
    // dependent, so it settles as a refusal.
    const accepted = await deleteParent();
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("delete returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    let settled: Record<string, unknown> | undefined;
    for (let poll = 0; poll < 8 && !settled?.done; poll += 1) {
      const response = await opened.host.handle(
        request(`${lane}/operations/${operationId}`, "primary"),
      );
      settled = (await response?.json()) as Record<string, unknown>;
    }
    expect(settled).toMatchObject({ done: true, error: { code: "dependency_in_use" } });

    const childDeleted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredDependent/child?${new URLSearchParams({
          space: "main",
          group: dependentForm.identity.formRef.apiVersion,
          kind: dependentForm.identity.formRef.kind,
          definitionVersion: dependentForm.identity.formRef.definitionVersion,
          schemaDigest: dependentForm.identity.formRef.schemaDigest,
        })}`,
        "primary",
        {
          method: "DELETE",
          headers: {
            "idempotency-key": "delete-child-0001",
            "takoform-expected-generation": "1",
          },
        },
      ),
    );
    expect(childDeleted?.status).toBe(204);

    // The same plan-derived key again. A settled refusal must not be replayed
    // as the answer to a question whose facts have changed.
    const retried = await deleteParent();
    expect(retried?.status).toBe(202);
    if (!retried) throw new Error("delete retry returned no response");
    const retriedId = ((await retried.json()) as { operation: { id: string } }).operation.id;
    let deleted: Record<string, unknown> | undefined;
    for (let poll = 0; poll < 8 && !deleted?.done; poll += 1) {
      const response = await opened.host.handle(
        request(`${lane}/operations/${retriedId}`, "primary"),
      );
      deleted = (await response?.json()) as Record<string, unknown>;
    }
    expect(deleted).toMatchObject({ done: true, result: { deleted: true } });
    expect(opened.database.query("SELECT name FROM tf_resources").all()).toEqual([]);
    opened.close();
  });

  /**
   * A provider refusal that names what must be removed first is a *result*,
   * not an indeterminate outcome.
   *
   * A non-empty ObjectBucket's delete answered exactly that, and the Host read
   * it as a mutation whose outcome it could not prove: the planned saga stayed,
   * the operation was held for repair, and every retry went into delete
   * recovery, which answered `backend_unavailable` "this is retryable: re-run
   * the same apply". Re-running never empties a bucket, so a Worker that had
   * ever accepted one upload could not be torn down at all.
   */
  test("settles a refusal that names its cause instead of holding it for delete recovery", async () => {
    const occupied =
      "the bucket still holds objects, and this Host does not empty a bucket for you; " +
      "delete its contents and destroy again";
    const memory = new InMemoryTakoformResourceDriver();
    let refusing = true;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async (input) => {
        if (refusing) {
          throw new ProviderMutationDefinitiveRefusalError("dependency_in_use", 409, occupied);
        }
        return await memory.delete(input);
      },
    };
    const opened = persistentHarness(undefined, driver).open();
    const current = await createNow(opened.host, "occupied-bucket");
    const remove = async () =>
      await opened.host.handle(
        request(
          `${lane}/resources/example.forms.invalid/DeferredThing/occupied-bucket?${new URLSearchParams(
            {
              space: "main",
              group: form.identity.formRef.apiVersion,
              kind: form.identity.formRef.kind,
              definitionVersion: form.identity.formRef.definitionVersion,
              schemaDigest: form.identity.formRef.schemaDigest,
            },
          )}`,
          "primary",
          {
            method: "DELETE",
            headers: {
              "idempotency-key": "delete-occupied-bucket-0001",
              "takoform-conformance-probe": "async",
              "takoform-expected-generation": current.metadata.generation,
            },
          },
        ),
      );

    const accepted = await remove();
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("delete returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    let settled: Record<string, unknown> | undefined;
    for (let poll = 0; poll < 8 && !settled?.done; poll += 1) {
      const polled = await opened.host.handle(
        request(`${lane}/operations/${operationId}`, "primary"),
      );
      settled = (await polled?.json()) as Record<string, unknown>;
    }
    // The provider's own sentence, under a code the released provider does not
    // automatically retry.
    expect(settled).toMatchObject({
      done: true,
      error: { code: "dependency_in_use", message: occupied, retryable: false },
    });

    // Nothing is held for repair, so nothing ever reaches delete recovery.
    expect(await opened.host.maintenance?.drainProviderRepairs(8)).toEqual({
      candidates: 0,
      acquired: 0,
      settled: 0,
      pending: 0,
    });
    expect(
      opened.database
        .query("SELECT operation_id FROM tf_provider_mutation_sagas_selection_v1")
        .all(),
    ).toEqual([]);
    expect(
      opened.database
        .query(
          `SELECT effect_kind, phase FROM tf_resource_provider_effects
           WHERE effect_id = ? ORDER BY event_id`,
        )
        .all(operationId),
    ).toEqual([
      { effect_kind: "delete", phase: "cancelled" },
      { effect_kind: "delete", phase: "dispatched" },
      { effect_kind: "delete", phase: "planned" },
    ]);

    // And once the operator has done what the refusal asked, the same destroy
    // under the same key is a second attempt rather than the stored refusal.
    refusing = false;
    const retried = await remove();
    expect(retried?.status).toBe(202);
    if (!retried) throw new Error("delete retry returned no response");
    const retriedId = ((await retried.json()) as { operation: { id: string } }).operation.id;
    expect(retriedId).not.toBe(operationId);
    let finished: Record<string, unknown> | undefined;
    for (let poll = 0; poll < 8 && !finished?.done; poll += 1) {
      const polled = await opened.host.handle(
        request(`${lane}/operations/${retriedId}`, "primary"),
      );
      finished = (await polled?.json()) as Record<string, unknown>;
    }
    expect(finished).toMatchObject({ done: true, result: { deleted: true } });
    expect(opened.database.query("SELECT name FROM tf_resources").all()).toEqual([]);
    opened.close();
  });

  /**
   * A Host defect must not be pinned to a resource name forever.
   *
   * The released provider's idempotency key is a pure function of the plan, so
   * the operator who repairs the Host re-runs the identical request. When the
   * Host replayed a settled `unsupported_capability`, a fixed Host answered the
   * same 422 without the driver being entered at all, and the only escapes were
   * renaming the resource or editing the Host's database.
   */
  test("re-attempts a settled refusal that described the Host, once the Host can answer", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let capable = false;
    const applies: string[] = [];
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        applies.push(input.name);
        if (!capable) {
          throw new ProviderMutationDefinitiveRefusalError("unsupported_capability", 422);
        }
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver).open();
    const desired = desiredResource("repaired-host", "initial");
    const review = await prepareReview(opened.host, desired);
    const create = async () =>
      await opened.host.handle(
        request(`${lane}/resources/example.forms.invalid/DeferredThing/repaired-host`, "primary", {
          method: "PUT",
          headers: {
            "idempotency-key": "create-repaired-host-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify({ ...desired, review }),
        }),
      );

    const accepted = await create();
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("create returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    const drive = async (id: string): Promise<Record<string, unknown>> => {
      let document: Record<string, unknown> | undefined;
      for (let poll = 0; poll < 8 && !document?.done; poll += 1) {
        const polled = await opened.host.handle(request(`${lane}/operations/${id}`, "primary"));
        document = (await polled?.json()) as Record<string, unknown>;
      }
      if (!document) throw new Error("the operation never answered");
      return document;
    };
    expect(await drive(operationId)).toMatchObject({
      done: true,
      error: { code: "unsupported_capability" },
    });
    expect(applies).toEqual(["repaired-host"]);

    // The Host is repaired. The identical request is a second attempt.
    capable = true;
    const retried = await create();
    expect(retried?.status).toBe(202);
    if (!retried) throw new Error("create retry returned no response");
    const retriedId = ((await retried.json()) as { operation: { id: string } }).operation.id;
    expect(retriedId).not.toBe(operationId);
    expect(await drive(retriedId)).toMatchObject({
      done: true,
      result: { resource: { metadata: { name: "repaired-host" } } },
    });
    expect(applies).toEqual(["repaired-host", "repaired-host"]);
    opened.close();
  });

  /**
   * Only that one code. Every other settled failure is still a result the same
   * key replays — widening it would also retry a refusal a provider answered
   * *after* it was invoked, and that is a second provider call rather than a
   * second attempt.
   */
  test("replays any other settled failure rather than attempting it again", async () => {
    const opened = persistentHarness().open();
    const current = await createNow(opened.host, "settled-failure");
    const remove = async () =>
      await opened.host.handle(
        request(
          `${lane}/resources/example.forms.invalid/DeferredThing/settled-failure?${new URLSearchParams(
            {
              space: "main",
              group: form.identity.formRef.apiVersion,
              kind: form.identity.formRef.kind,
              definitionVersion: form.identity.formRef.definitionVersion,
              schemaDigest: form.identity.formRef.schemaDigest,
            },
          )}`,
          "primary",
          {
            method: "DELETE",
            headers: {
              "idempotency-key": "delete-settled-failure-0001",
              "takoform-conformance-probe": "async",
              "takoform-expected-generation": current.metadata.generation,
            },
          },
        ),
      );

    const accepted = await remove();
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("delete returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;
    // The desired state moves under the acceptance, which is a fence a delete
    // still keeps, so this settles as a failure before any provider is asked.
    const moved = storedResource("settled-failure", current.metadata.uid);
    moved.metadata.generation = "9";
    opened.database
      .query(
        "UPDATE tf_resources SET generation = '9', resource_json = ? WHERE name = 'settled-failure'",
      )
      .run(JSON.stringify(moved));
    let settled: Record<string, unknown> | undefined;
    for (let poll = 0; poll < 8 && !settled?.done; poll += 1) {
      const polled = await opened.host.handle(
        request(`${lane}/operations/${operationId}`, "primary"),
      );
      settled = (await polled?.json()) as Record<string, unknown>;
    }
    expect(settled).toMatchObject({ done: true, error: { code: "generation_conflict" } });

    const replayed = await remove();
    expect(replayed?.status).toBe(202);
    if (!replayed) throw new Error("delete replay returned no response");
    // The same durable operation, not a fresh attempt.
    expect(((await replayed.json()) as { operation: { id: string } }).operation.id).toBe(
      operationId,
    );
    opened.close();
  });

  /**
   * An invalid Form projection does not erase a real provider effect.
   *
   * The provider's executed receipt is the only authority that can adopt or
   * compensate the native object. A projection failure cannot discard it and
   * start again under a new operation id or Resource uid: provider idempotency
   * is bound to the original operation, not the caller's replay key. Until an
   * explicit recovery consumes that receipt, the same command stays held and
   * must never dispatch the provider again.
   */
  test("holds an unpublishable receipt without duplicating provider work", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let published = "https://ported.invalid:28988/";
    const appliedResourceUids: string[] = [];
    let issuedReceipt: TakoformDriverReceipt | undefined;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        appliedResourceUids.push(input.resourceUid);
        const base = await memory.apply(input);
        const observed = base.observed ?? {};
        const outputs = { url: published };
        issuedReceipt = {
          ...base,
          outputs,
          deploymentMutation: {
            kind: "create",
            deployment: {
              tenantId: input.tenantId,
              id: `deployment:${input.operationId}`,
              resourceUid: input.resourceUid,
              offeringId: "test.unpublishable",
              providerPackRef: "provider.unpublishable",
              providerInstallationRef: "provider.unpublishable.primary",
              nativeId: `native:${input.operationId}`,
              state: "active",
              observed,
              outputs,
            },
          },
        };
        return issuedReceipt;
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    // The production shape: every provider-backed mutation is a durable
    // command, settled inline.
    const opened = persistentHarness(undefined, driver, [publishingForm], {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const desired = {
      apiVersion: publishingForm.identity.formRef.apiVersion,
      kind: publishingForm.identity.formRef.kind,
      form: { formRef: publishingForm.identity.formRef },
      metadata: { name: "unpublishable", space: "main" },
      spec: { value: "ported" },
    };
    const review = await prepareReviewFor(opened.host, desired);
    const path = `${lane}/resources/example.forms.invalid/DeferredEndpoint/unpublishable`;
    const apply = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "PUT",
          headers: { "idempotency-key": "unpublishable-0001", "if-none-match": "*" },
          body: JSON.stringify({ ...desired, review }),
        }),
      );

    const held = await apply();
    expect(held?.status).toBe(202);
    if (!held) throw new Error("held apply returned no response");
    const operationId = ((await held.json()) as { operation: { id: string } }).operation.id;
    expect(
      opened.database
        .query(
          `SELECT id, resource_uid, phase
           FROM tf_deferred_operations_selection_v1 WHERE id = ?`,
        )
        .get(operationId),
    ).toEqual({ id: operationId, resource_uid: appliedResourceUids[0], phase: "committing" });
    const executed = opened.database
      .query(
        `SELECT operation_id, resource_uid, phase, receipt_json
         FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
      )
      .get(operationId) as {
      operation_id: string;
      resource_uid: string;
      phase: string;
      receipt_json: string;
    };
    expect(executed).toMatchObject({
      operation_id: operationId,
      resource_uid: appliedResourceUids[0],
      phase: "executed",
    });
    expect(JSON.parse(executed.receipt_json)).toEqual({
      ...issuedReceipt,
      providerExecutionMode: "initial",
    });
    expect(
      opened.database
        .query(
          `SELECT effect_kind, phase FROM tf_resource_provider_effects
           WHERE effect_id = ? ORDER BY event_id`,
        )
        .all(operationId),
    ).toEqual([
      { effect_kind: "apply", phase: "dispatched" },
      { effect_kind: "apply", phase: "planned" },
    ]);
    expect(opened.database.query("SELECT state FROM tf_operations").all()).toEqual([]);
    expect(opened.database.query("SELECT * FROM tf_resource_deployments").all()).toEqual([]);

    // Changing what a fresh provider call would publish cannot authorize one:
    // the exact executed receipt remains the only repair authority.
    published = "https://repaired.invalid/";
    const retried = await apply();
    expect(retried?.status).toBe(202);
    if (!retried) throw new Error("held apply retry returned no response");
    expect(((await retried.json()) as { operation: { id: string } }).operation.id).toBe(
      operationId,
    );
    expect(appliedResourceUids).toEqual([executed.resource_uid]);
    expect(
      opened.database
        .query(
          `SELECT operation_id, resource_uid, phase, receipt_json
           FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toEqual(executed);
    expect(
      opened.database
        .query(
          `SELECT count(*) AS terminal FROM tf_resource_provider_effects
           WHERE effect_id = ? AND phase IN ('cancelled', 'succeeded')`,
        )
        .get(operationId),
    ).toEqual({ terminal: 0 });
    expect(opened.database.query("SELECT * FROM tf_resource_deployments").all()).toEqual([]);
    expect(
      opened.database.query("SELECT uid FROM tf_resources WHERE name = 'unpublishable'").all(),
    ).toEqual([]);
    opened.close();
  });

  /**
   * A refusal that mutated nothing leaves nothing behind.
   *
   * A create reserves an incarnation before the provider is asked: a deletion
   * attestation opened `live`, a `planned` effect, and — once the saga is
   * marked — a `dispatched` one. A refusal raised inside the driver after that
   * marker commits no Resource, so the record described an incarnation that
   * never existed. The attestation could not be closed by a deletion that never
   * happened and the `apply` effect had no terminal event, so both stood for
   * good; a real self-host ended every refused `WorkerEndpoint` create with
   * exactly that pair, and it is the pair every later "is this endpoint
   * provably gone" question reads.
   */
  test("leaves no attestation and no open effect when a create is refused before the provider acts", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let refuse = true;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        // The shape a self-host's endpoint mint refuses with: a statement about
        // this Host, raised after the Host marked its own dispatch and before
        // anything native was touched.
        if (refuse) {
          throw new ProviderMutationDefinitiveRefusalError("unsupported_capability", 422);
        }
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver).open();
    const desired = desiredResource("refused-create", "nothing-was-mutated");
    const review = await prepareReview(opened.host, desired);
    const path = `${lane}/resources/example.forms.invalid/DeferredThing/refused-create`;
    const apply = () =>
      opened.host.handle(
        request(path, "primary", {
          method: "PUT",
          headers: { "idempotency-key": "refused-create-0001", "if-none-match": "*" },
          body: JSON.stringify({ ...desired, review }),
        }),
      );

    expect((await apply())?.status).toBe(422);
    const ledger = () => ({
      attestations: opened.database
        .query("SELECT count(*) AS rows FROM tf_resource_deletion_attestations")
        .get() as { rows: number },
      effects: opened.database
        .query("SELECT count(*) AS rows FROM tf_resource_provider_effects")
        .get() as { rows: number },
    });
    expect(ledger()).toEqual({ attestations: { rows: 0 }, effects: { rows: 0 } });

    // And the same request is still a request: the refusal was about this Host,
    // so once it stops refusing the identical apply creates the Resource.
    refuse = false;
    expect((await apply())?.status).toBe(201);
    expect(ledger()).toEqual({ attestations: { rows: 1 }, effects: { rows: 3 } });
    opened.close();
  });

  test("retains a pending repair when an entered driver throws an unbranded refusal", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const writes: string[] = [];
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      apply: async (input) => {
        writes.push(input.operationId);
        await memory.apply(input);
        throw new TakoformHostError("unsupported_capability", 422);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [form], {
      pollsBeforeCommit: 1,
      executeOnAccept: true,
    }).open();
    const desired = desiredResource("unbranded-refusal", "entered-and-wrote");
    const review = await prepareReview(opened.host, desired);
    const accepted = await opened.host.handle(
      request(
        `${lane}/resources/example.forms.invalid/DeferredThing/unbranded-refusal`,
        "primary",
        {
          method: "PUT",
          headers: {
            "idempotency-key": "unbranded-refusal-0001",
            "if-none-match": "*",
            "takoform-conformance-probe": "async",
          },
          body: JSON.stringify({ ...desired, review }),
        },
      ),
    );
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("unbranded refusal returned no response");
    const acceptedBody = (await accepted.json()) as { operation: { id: string; done: boolean } };
    expect(acceptedBody.operation).toMatchObject({ done: false });
    const operationId = acceptedBody.operation.id;

    expect(writes).toEqual([operationId]);
    expect(
      opened.database
        .query(
          `SELECT phase, terminal_json FROM tf_deferred_operations_selection_v1
           WHERE id = ?`,
        )
        .get(operationId),
    ).toEqual({ phase: "committing", terminal_json: null });

    const saga = opened.database
      .query(
        `SELECT operation_id, resource_uid, phase, provider_outcome, receipt_json
         FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
      )
      .get(operationId) as {
      operation_id: string;
      resource_uid: string;
      phase: string;
      provider_outcome: string;
      receipt_json: string | null;
    } | null;
    expect(saga).toEqual({
      operation_id: operationId,
      resource_uid: expect.any(String),
      phase: "planned",
      provider_outcome: "indeterminate",
      receipt_json: null,
    });
    if (!saga) throw new Error("entered refusal saga was not retained");
    expect(
      opened.database
        .query(
          `SELECT phase FROM tf_resource_provider_effects
           WHERE effect_id = ? ORDER BY phase`,
        )
        .all(operationId),
    ).toEqual([{ phase: "dispatched" }, { phase: "planned" }]);
    expect(
      opened.database
        .query(
          `SELECT state FROM tf_resource_deletion_attestations
           WHERE resource_uid = ?`,
        )
        .get(saga.resource_uid),
    ).toEqual({ state: "live" });
    expect(
      opened.database
        .query("SELECT COUNT(*) AS rows FROM tf_operations WHERE id = ?")
        .get(operationId),
    ).toEqual({ rows: 0 });
    opened.close();
  });

  test("answers an over-budget inline mutation with the operation contract and settles it for the next poll", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const gate = deferred();
    const applied = deferred();
    let providerCalls = 0;
    const driver: TakoformResourceDriver = {
      ...memory,
      selectApply: (input) => memory.selectApply(input),
      selectImport: (input) => memory.selectImport?.(input),
      apply: async (input) => {
        providerCalls += 1;
        await gate.promise;
        const receipt = await memory.apply(input);
        applied.resolve();
        return receipt;
      },
      observe: (input) => memory.observe(input),
      import: (input) => memory.import?.(input),
      delete: (input) => memory.delete(input),
    };
    const opened = persistentHarness(undefined, driver, [form], {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      executeOnAccept: true,
      inlineExecuteMilliseconds: 10,
    }).open();
    const desired = desiredResource("inline-budget", "inline");
    const review = await prepareReview(opened.host, desired);
    const path = `${lane}/resources/example.forms.invalid/DeferredThing/inline-budget`;
    const accepted = await opened.host.handle(
      request(path, "primary", {
        method: "PUT",
        headers: {
          "idempotency-key": "inline-budget-0001",
          "if-none-match": "*",
          "takoform-conformance-probe": "async",
        },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    // The blocked provider attempt outlives the request: the Host answers
    // with the durable operation instead of an HTTP timeout.
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("apply returned no response");
    const operationId = ((await accepted.json()) as { operation: { id: string } }).operation.id;

    // A poll inside the live lease waits instead of dispatching twice.
    const operationPath = `${lane}/operations/${operationId}`;
    const waiting = await opened.host.handle(request(operationPath, "primary"));
    expect(waiting?.status).toBe(200);
    expect(await waiting?.json()).toMatchObject({ id: operationId, done: false });
    expect(providerCalls).toBe(1);

    gate.resolve();
    await applied.promise;
    let settled: Response | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const poll = await opened.host.handle(request(operationPath, "primary"));
      const body = (await poll?.json()) as { done?: boolean };
      if (body.done === true) {
        settled = poll;
        break;
      }
      await Bun.sleep(5);
    }
    expect(settled?.status).toBe(200);
    expect(providerCalls).toBe(1);
    opened.close();
  });
});

function persistentHarness(
  clock: () => Date = () => new Date(),
  driver: TakoformResourceDriver = new InMemoryTakoformResourceDriver(),
  forms: readonly InstalledTakoformForm[] = [form],
  /** The production shape defers every provider-backed mutation inline. */
  deferred: {
    readonly shouldDefer?: () => boolean;
    readonly pollsBeforeCommit?: number;
    readonly executeOnAccept?: boolean;
    readonly inlineExecuteMilliseconds?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "takoserver-deferred-operation-"));
  roots.push(root);
  const databasePath = join(root, "control.sqlite");
  // Keep each test on its own durable file while avoiding repeated migration
  // transactions in this fixture-heavy suite.
  copyFileSync(ensureSchemaSeed(), databasePath);
  let ids = 0;
  return {
    open() {
      const database = new Database(databasePath);
      const host = createConfiguredHistoricalTakoformHost({
        sql: createSqliteSql(database),
        objects: createMemoryObjectStore(),
        authenticate: async (incoming) => {
          const token = incoming.headers.get("authorization");
          if (token === "Bearer primary") {
            return { tenantId: "tenant-a", principalId: "principal-a" };
          }
          if (token === "Bearer alternate") {
            return { tenantId: "tenant-a", principalId: "principal-b" };
          }
          if (token === "Bearer other-tenant") {
            return { tenantId: "tenant-b", principalId: "principal-a" };
          }
          if (token === "Bearer reserved") {
            return {
              tenantId: "tenant-a",
              principalId: "principal-reserved",
              scope: {
                space: "main",
                mode: "tenant-run" as const,
                workerEndpointOriginReservationId: "endpoint-reservation-01",
              },
            };
          }
          return null;
        },
        forms,
        driver,
        routes: {
          hostApiVersion: "forms.takoform.com/v1beta4",
          apiPath: lane,
          supportProfileApiVersion: "support.takoform.com/v1alpha2",
          reviewSpecDigest: true,
        },
        deferredOperations: {
          shouldDefer: ({ request: incoming }) =>
            incoming.headers.get("takoform-conformance-probe") === "async",
          pollsBeforeCommit: 2,
          retryAfterSeconds: 0,
          leaseMilliseconds: 1_000,
          ...deferred,
        },
        clock,
        randomId: () => `harness-${++ids}`,
      });
      return { host, database, close: () => database.close() };
    },
  };
}

function ensureSchemaSeed(): string {
  if (schemaSeedPath) return schemaSeedPath;
  const root = mkdtempSync(join(tmpdir(), "takoserver-deferred-schema-"));
  const path = join(root, "control.sqlite");
  try {
    const database = new Database(path);
    try {
      migrateSqlite(database);
    } finally {
      database.close();
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  schemaSeedRoot = root;
  schemaSeedPath = path;
  return path;
}

async function acceptCreate(
  host: TakoformHost,
  name: string,
  key: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const desired = {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name, space: "main" },
    spec: { value: name },
  };
  const prepared = await host.handle(
    request(`${lane}/resources/prepare`, "primary", {
      method: "POST",
      body: JSON.stringify(desired),
    }),
  );
  if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.status}`);
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;
  const accepted = await host.handle(
    request(`${lane}/resources/example.forms.invalid/DeferredThing/${name}`, "primary", {
      method: "PUT",
      headers: {
        ...extraHeaders,
        "idempotency-key": key,
        "if-none-match": "*",
        "takoform-conformance-probe": "async",
      },
      body: JSON.stringify({ ...desired, review }),
    }),
  );
  if (accepted?.status !== 202) throw new Error(`accept failed: ${accepted?.status}`);
  const body = (await accepted.json()) as { operation: { id: string } };
  return body.operation.id;
}

async function createNow(
  host: TakoformHost,
  name: string,
): Promise<ReturnType<typeof storedResource>> {
  const desired = desiredResource(name, "initial");
  const review = await prepareReview(host, desired);
  const created = await host.handle(
    request(`${lane}/resources/example.forms.invalid/DeferredThing/${name}`, "primary", {
      method: "PUT",
      headers: {
        "idempotency-key": `create-${name}-0001`,
        "if-none-match": "*",
      },
      body: JSON.stringify({ ...desired, review }),
    }),
  );
  if (created?.status !== 201) throw new Error(`create failed: ${created?.status}`);
  return (await created.json()) as ReturnType<typeof storedResource>;
}

function desiredResource(name: string, value: string) {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name, space: "main" },
    spec: { value },
  };
}

function importedResource(name: string, value: string) {
  return {
    apiVersion: importForm.identity.formRef.apiVersion,
    kind: importForm.identity.formRef.kind,
    form: { formRef: importForm.identity.formRef },
    metadata: { name, space: "main" },
    spec: { value },
    nativeId: `native-${name}`,
  };
}

async function prepareReview(
  host: TakoformHost,
  desired: ReturnType<typeof desiredResource>,
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  const prepared = await host.handle(
    request(`${lane}/resources/prepare`, "primary", {
      method: "POST",
      headers,
      body: JSON.stringify(desired),
    }),
  );
  if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.status}`);
  return ((await prepared.json()) as { review: Record<string, string> }).review;
}

async function prepareReviewFor(
  host: TakoformHost,
  desired: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  const prepared = await host.handle(
    request(`${lane}/resources/prepare`, "primary", {
      method: "POST",
      headers,
      body: JSON.stringify(desired),
    }),
  );
  if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.status}`);
  return ((await prepared.json()) as { review: Record<string, string> }).review;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = (): void => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function storedResource(name: string, uid: string) {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: form.identity,
    metadata: { name, space: "main", uid, generation: "1", revision: "1" },
    spec: { value: name },
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: "2026-08-23T00:00:00.000Z",
        },
      ],
    },
  };
}

function request(path: string, token: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://candidate.invalid${path}`, { ...init, headers });
}

function failNextProviderSagaCommit(database: Database): () => void {
  database.exec(`
    CREATE TRIGGER fail_next_provider_saga_commit
    BEFORE DELETE ON tf_provider_mutation_sagas_selection_v1
    BEGIN
      SELECT no_such_provider_commit_function();
    END;
  `);
  return () => database.exec("DROP TRIGGER fail_next_provider_saga_commit");
}
