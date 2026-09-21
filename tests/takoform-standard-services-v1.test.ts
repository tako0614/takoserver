import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import {
  ProviderMutationDefinitiveRefusalError,
  ProviderMutationWholeOperationRefusalError,
} from "../src/provider-driver.ts";
import { TAKOFORM_APPLY_SELECTION_VERSION } from "../src/takoform/apply-selection.ts";
import { TAKOFORM_IMPORT_SELECTION_VERSION } from "../src/takoform/import-selection.ts";
import type { DeferredOperationsConfiguration } from "../src/takoform/operations.ts";
import type {
  InstalledTakoformForm,
  TakoformResourceDriver,
  TakoformStandardServiceResolver,
} from "../src/takoform/types.ts";
import { TakoformHostError } from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost as createTakoformHost } from "./helpers/historical-takoform-host.ts";

const lane = "/apis/forms.takoform.com/v1";
const serviceApiVersion = "standards.takoform.com/v1";
const protocolPattern =
  "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$";

const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "StandardClient",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"f".repeat(64)}`,
    },
  },
  requiresHostApi: "forms.takoform.com/v1",
  role: "revision",
  desiredSchema: {
    type: "object",
    properties: {
      externalServices: {
        type: "array",
        "x-takoform-standard-services": serviceApiVersion,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$", maxLength: 64 },
            required: { type: "boolean", default: true },
            service: {
              type: "object",
              additionalProperties: false,
              properties: {
                apiVersion: { const: serviceApiVersion },
                protocol: { type: "string", pattern: protocolPattern, maxLength: 253 },
              },
              required: ["apiVersion", "protocol"],
            },
          },
          required: ["name", "service"],
        },
      },
    },
    required: ["externalServices"],
    additionalProperties: false,
  },
  operations: ["create", "read", "delete"],
};

describe("stable StandardServiceRef", () => {
  test("does not publish service-retail discovery and required resolution fails closed", async () => {
    let mutations = 0;
    const host = stableHost({
      async selectApply() {
        return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
      },
      async apply() {
        mutations += 1;
        return {};
      },
      async observe() {
        return {};
      },
      async delete() {},
    });

    expect(
      (await host.handle(request(`${lane}/support/standard-services/com.example.future-store`)))
        ?.status,
    ).toBe(404);

    const refused = await host.handle(
      request(`${lane}/resources/prepare`, {
        method: "POST",
        body: JSON.stringify(resource("com.example.future-store")),
      }),
    );
    expect(refused?.status).toBe(422);
    expect(await refused?.json()).toMatchObject({ error: { code: "unsupported_capability" } });
    expect(mutations).toBe(0);
  });

  test("refuses a required exact service before mutation when no supply is configured", async () => {
    let mutations = 0;
    const host = stableHost(
      {
        async selectApply() {
          return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
        },
        async apply() {
          mutations += 1;
          return {};
        },
        async observe() {
          return {};
        },
        async delete() {},
      },
      false,
    );
    const refused = await host.handle(
      request(`${lane}/resources/prepare`, {
        method: "POST",
        body: JSON.stringify(resource("com.example.archive")),
      }),
    );
    expect(refused?.status).toBe(422);
    expect(await refused?.json()).toMatchObject({ error: { code: "unsupported_capability" } });
    expect(mutations).toBe(0);
  });

  test("refuses an initially unsatisfied required slot before driver mutation", async () => {
    let mutations = 0;
    let available = true;
    const resolver: TakoformStandardServiceResolver = {
      async satisfiable({ serviceRef }) {
        if (!available) return false;
        return serviceRef.protocol === "com.example.archive";
      },
      async resolve() {
        if (!available) throw new Error("resolver unavailable");
        return {
          endpoint: { endpoint: "sealed-endpoint:main" },
          credential: { token: "sealed-credential" },
        };
      },
    };
    const host = stableHost(
      {
        async selectApply() {
          return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
        },
        async apply() {
          mutations += 1;
          return {};
        },
        async observe() {
          return {};
        },
        async delete() {},
      },
      true,
      resolver,
    );
    const desired = resource("com.example.archive");
    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("prepare was not routed");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    available = false;
    const refused = await host.handle(
      request(`${lane}/resources/example.forms.invalid/StandardClient/client`, {
        method: "PUT",
        headers: { "idempotency-key": "stable-standard-service-reject-0001", "if-none-match": "*" },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(refused?.status).toBe(422);
    expect(await refused?.json()).toMatchObject({ error: { code: "unsupported_capability" } });
    expect(mutations).toBe(0);
  });

  test("defaults required to true, omits unsupported optional slots, and keeps material sealed", async () => {
    const projected: unknown[] = [];
    const host = stableHost({
      async selectApply() {
        return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
      },
      async apply(input) {
        projected.push(input.standardServices);
        return { outputs: { hostname: "worker.example.invalid" } };
      },
      async observe() {
        return {};
      },
      async delete() {},
    });

    const desired = resource("com.example.archive", undefined, [
      {
        name: "FUTURE_STORE",
        required: false,
        service: { apiVersion: serviceApiVersion, protocol: "com.example.future-store" },
      },
    ]);
    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("prepare was not routed");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const applied = await host.handle(
      request(`${lane}/resources/example.forms.invalid/StandardClient/client`, {
        method: "PUT",
        headers: { "idempotency-key": "stable-standard-service-0001", "if-none-match": "*" },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(applied?.status).toBe(201);
    expect(projected).toEqual([
      [
        {
          name: "ARCHIVE",
          required: true,
          service: { apiVersion: serviceApiVersion, protocol: "com.example.archive" },
          endpoint: { endpoint: "sealed-endpoint:main" },
          credential: { token: "sealed-credential" },
        },
      ],
    ]);
    const portable = JSON.stringify(await applied?.json());
    expect(portable).not.toContain("sealed-endpoint");
    expect(portable).not.toContain("sealed-credential");
  });

  test("does not resolve standard services for an exact completed replay", async () => {
    let available = true;
    let satisfiableCalls = 0;
    let resolveCalls = 0;
    let mutations = 0;
    const resolver: TakoformStandardServiceResolver = {
      async satisfiable({ serviceRef }) {
        satisfiableCalls += 1;
        if (!available) throw new Error("resolver unavailable");
        return serviceRef.protocol === "com.example.archive";
      },
      async resolve() {
        resolveCalls += 1;
        if (!available) throw new Error("resolver unavailable");
        return {
          endpoint: { endpoint: "sealed-endpoint:main" },
          credential: { token: "sealed-credential" },
        };
      },
    };
    const host = stableHost(
      {
        async selectApply() {
          return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
        },
        async apply() {
          mutations += 1;
          return { outputs: { hostname: "worker.example.invalid" } };
        },
        async observe() {
          return {};
        },
        async delete() {},
      },
      true,
      resolver,
    );
    const desired = resource("com.example.archive");
    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("prepare was not routed");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const apply = () =>
      host.handle(
        request(`${lane}/resources/example.forms.invalid/StandardClient/client`, {
          method: "PUT",
          headers: {
            "idempotency-key": "stable-standard-service-replay-0001",
            "if-none-match": "*",
          },
          body: JSON.stringify({ ...desired, review }),
        }),
      );
    const created = await apply();
    expect(created?.status).toBe(201);
    expect(mutations).toBe(1);
    const beforeReplay = { satisfiableCalls, resolveCalls };
    available = false;
    const replayed = await apply();
    expect(replayed?.status).toBe(201);
    expect(mutations).toBe(1);
    expect({ satisfiableCalls, resolveCalls }).toEqual(beforeReplay);
  });

  test("recovers an in-flight mutation without resolving standard services", async () => {
    let available = true;
    let satisfiableCalls = 0;
    let resolveCalls = 0;
    let mutations = 0;
    const modes: Array<"initial" | "recovery" | undefined> = [];
    const projected: Array<readonly unknown[] | undefined> = [];
    const resolver: TakoformStandardServiceResolver = {
      async satisfiable({ serviceRef }) {
        satisfiableCalls += 1;
        if (!available) throw new Error("resolver unavailable");
        return serviceRef.protocol === "com.example.archive";
      },
      async resolve() {
        resolveCalls += 1;
        if (!available) throw new Error("resolver unavailable");
        return {
          endpoint: { endpoint: "sealed-endpoint:main" },
          credential: { token: "sealed-credential" },
        };
      },
    };
    const host = stableHost(
      {
        async selectApply() {
          return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
        },
        async apply(input) {
          mutations += 1;
          modes.push(input.operationMode);
          projected.push(input.standardServices);
          if (mutations === 1) throw new TakoformHostError("backend_unavailable", 503);
          return { observed: structuredClone(input.spec) };
        },
        async observe() {
          return {};
        },
        async delete() {},
      },
      true,
      resolver,
      {
        shouldDefer: () => true,
        pollsBeforeCommit: 1,
        retryAfterSeconds: 0,
        executeOnAccept: false,
        leaseMilliseconds: 1_000,
      },
    );
    const desired = resource("com.example.archive");
    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("prepare was not routed");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const apply = await host.handle(
      request(`${lane}/resources/example.forms.invalid/StandardClient/client`, {
        method: "PUT",
        headers: {
          "idempotency-key": "stable-standard-service-recovery-0001",
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(apply?.status).toBe(202);
    if (!apply) throw new Error("apply was not accepted");
    const operationId = ((await apply.json()) as { operation: { id: string } }).operation.id;
    const operationPath = `${lane}/operations/${operationId}`;
    expect((await host.handle(request(operationPath)))?.status).toBe(200);
    const failedInitial = await host.handle(request(operationPath));
    expect(failedInitial?.status).toBe(200);
    expect(mutations).toBe(1);
    const beforeRecovery = { satisfiableCalls, resolveCalls };
    available = false;
    const recovered = await host.handle(request(operationPath));
    expect(recovered?.status).toBe(200);
    expect(await recovered?.json()).toMatchObject({ done: true });
    expect(modes).toEqual(["initial", "recovery"]);
    expect(projected[0]).toHaveLength(1);
    expect(projected[1]).toBeUndefined();
    expect({ satisfiableCalls, resolveCalls }).toEqual(beforeRecovery);
  });

  test("retains apply projection uncertainty after dispatch and never projects again on repair", async () => {
    const sql = createEphemeralSql();
    let projections = 0;
    let applies = 0;
    const host = createTakoformHost({
      sql,
      objects: createMemoryObjectStore(),
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
      forms: [form],
      deferredOperations: {
        shouldDefer: () => true,
        pollsBeforeCommit: 1,
        retryAfterSeconds: 0,
        executeOnAccept: true,
      },
      driver: {
        async selectApply() {
          return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
        },
        async apply(input) {
          applies += 1;
          return { observed: structuredClone(input.spec) };
        },
        async observe() {
          return {};
        },
        async delete() {},
      },
      standardServiceResolver: {
        async satisfiable() {
          return true;
        },
        async resolve() {
          projections += 1;
          // Material issuance happens only after the saga and effect fences.
          expect(
            await sql.query(
              "SELECT execution_started_at, selection_json FROM tf_provider_mutation_sagas_selection_v1",
            ),
          ).toEqual([
            {
              execution_started_at: expect.any(Number),
              selection_json: expect.any(String),
            },
          ]);
          expect(
            await sql.query("SELECT phase FROM tf_resource_provider_effects ORDER BY phase"),
          ).toEqual([{ phase: "dispatched" }, { phase: "planned" }]);
          throw new Error("material issued but acknowledgement lost");
        },
      },
    });
    const desired = resource("com.example.archive");
    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("prepare was not routed");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const accepted = await host.handle(
      request(`${lane}/resources/example.forms.invalid/StandardClient/client`, {
        method: "PUT",
        headers: { "idempotency-key": "service-apply-retention-0001", "if-none-match": "*" },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(accepted?.status).toBe(202);
    expect(projections).toBe(1);
    expect(applies).toBe(0);
    expect(
      await sql.query(
        "SELECT phase, provider_outcome, execution_started_at, selection_json FROM tf_provider_mutation_sagas_selection_v1",
      ),
    ).toEqual([
      {
        phase: "planned",
        provider_outcome: "indeterminate",
        execution_started_at: expect.any(Number),
        selection_json: expect.any(String),
      },
    ]);
    expect(
      await sql.query("SELECT phase FROM tf_resource_provider_effects ORDER BY phase"),
    ).toEqual([{ phase: "dispatched" }, { phase: "planned" }]);

    expect(await host.maintenance?.drainProviderRepairs()).toMatchObject({
      candidates: 1,
      acquired: 1,
      settled: 1,
      pending: 0,
    });
    expect(projections).toBe(1);
    expect(applies).toBe(1);
  });

  test.each([false, true])(
    "settles a definitive provider refusal only without service slots (%s)",
    async (withServiceSlot) => {
      const sql = createEphemeralSql();
      let applies = 0;
      const claimForm: InstalledTakoformForm = {
        ...form,
        desiredSchema: structuredClone(form.desiredSchema),
        constraints: [{ kind: "claim", property: "/claim" }],
      };
      const claimProperties = claimForm.desiredSchema.properties;
      if (
        claimProperties === null ||
        typeof claimProperties !== "object" ||
        Array.isArray(claimProperties)
      ) {
        throw new Error("standard service fixture properties are not an object");
      }
      (claimProperties as Record<string, unknown>).claim = { type: "string" };
      const host = createTakoformHost({
        sql,
        objects: createMemoryObjectStore(),
        authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
        forms: [claimForm],
        driver: {
          async selectApply() {
            return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
          },
          async apply() {
            applies += 1;
            throw new ProviderMutationDefinitiveRefusalError("unsupported_capability", 422);
          },
          async observe() {
            return {};
          },
          async delete() {},
        },
        standardServiceResolver: {
          async satisfiable() {
            return true;
          },
          async resolve() {
            return {
              endpoint: { endpoint: "sealed-endpoint:main" },
              credential: { token: "sealed-credential" },
            };
          },
        },
      });
      const desired = resource("com.example.archive");
      (desired.spec as Record<string, unknown>).claim = "shared-claim";
      if (!withServiceSlot) desired.spec.externalServices = [];
      const prepared = await host.handle(
        request(`${lane}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
      );
      expect(prepared?.status).toBe(200);
      if (!prepared) throw new Error("prepare was not routed");
      const review = ((await prepared.json()) as { review: Record<string, string> }).review;
      const beforeIncarnations = await sql.query(
        "SELECT COUNT(*) AS n FROM tf_resource_deletion_attestations",
      );
      const beforeClaims = await sql.query("SELECT COUNT(*) AS n FROM tf_resource_claims");
      const response = await host.handle(
        request(`${lane}/resources/example.forms.invalid/StandardClient/client`, {
          method: "PUT",
          headers: {
            "idempotency-key": `definitive-refusal-${withServiceSlot}`,
            "if-none-match": "*",
          },
          body: JSON.stringify({ ...desired, review }),
        }),
      );
      expect(applies).toBe(1);
      if (withServiceSlot) {
        expect(response?.status).toBe(422);
        expect(
          await sql.query(
            "SELECT phase, provider_outcome, execution_started_at, selection_json FROM tf_provider_mutation_sagas_selection_v1",
          ),
        ).toEqual([
          {
            phase: "planned",
            provider_outcome: "indeterminate",
            execution_started_at: expect.any(Number),
            selection_json: expect.any(String),
          },
        ]);
        expect(
          await sql.query("SELECT phase FROM tf_resource_provider_effects ORDER BY phase"),
        ).toEqual([{ phase: "dispatched" }, { phase: "planned" }]);
        expect(
          await sql.query("SELECT COUNT(*) AS n FROM tf_resource_deletion_attestations"),
        ).toEqual([{ n: Number(beforeIncarnations[0]?.n ?? 0) + 1 }]);
        const retainedClaims = await sql.query("SELECT COUNT(*) AS n FROM tf_resource_claims");
        expect(Number(retainedClaims[0]?.n ?? 0)).toBeGreaterThan(Number(beforeClaims[0]?.n ?? 0));
      } else {
        expect(response?.status).toBe(422);
        expect(
          await sql.query("SELECT COUNT(*) AS n FROM tf_provider_mutation_sagas_selection_v1"),
        ).toEqual([{ n: 0 }]);
        expect(await sql.query("SELECT COUNT(*) AS n FROM tf_resource_provider_effects")).toEqual([
          { n: 0 },
        ]);
        expect(
          await sql.query("SELECT COUNT(*) AS n FROM tf_resource_deletion_attestations"),
        ).toEqual(beforeIncarnations);
        expect(await sql.query("SELECT COUNT(*) AS n FROM tf_resource_claims")).toEqual(
          beforeClaims,
        );
      }
    },
  );

  test.each([false, true])(
    "import retains service projection uncertainty across recovery (lost projection ACK: %s)",
    async (loseProjectionAck) => {
      const sql = createEphemeralSql();
      let projections = 0;
      let imports = 0;
      const host = createTakoformHost({
        sql,
        objects: createMemoryObjectStore(),
        authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
        forms: [{ ...form, operations: [...form.operations, "import"] }],
        deferredOperations: {
          shouldDefer: () => true,
          pollsBeforeCommit: 1,
          retryAfterSeconds: 0,
          executeOnAccept: true,
        },
        driver: {
          async selectApply() {
            return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" };
          },
          async selectImport(input) {
            return {
              version: TAKOFORM_IMPORT_SELECTION_VERSION,
              kind: "intrinsic",
              nativeId: input.nativeId,
            };
          },
          async apply() {
            throw new Error("not an apply");
          },
          async import(input) {
            imports += 1;
            if (input.operationMode === "recovery")
              throw new ProviderMutationWholeOperationRefusalError("import_conflict", 409);
            throw new TakoformHostError("import_conflict", 409);
          },
          async observe() {
            return {};
          },
          async delete() {},
        },
        standardServiceResolver: {
          async satisfiable() {
            return true;
          },
          async resolve() {
            projections += 1;
            // Material issuance starts only after both durable dispatch markers.
            expect(
              await sql.query(
                "SELECT execution_started_at, import_selection_json FROM tf_provider_mutation_sagas_selection_v1",
              ),
            ).toEqual([
              {
                execution_started_at: expect.any(Number),
                import_selection_json: expect.any(String),
              },
            ]);
            expect(
              await sql.query("SELECT phase FROM tf_resource_provider_effects ORDER BY phase"),
            ).toEqual([{ phase: "dispatched" }, { phase: "planned" }]);
            if (loseProjectionAck) throw new Error("material issued but acknowledgement lost");
            return {
              endpoint: { endpoint: "sealed-endpoint:main" },
              credential: { token: "sealed-credential" },
            };
          },
        },
      });
      const accepted = await host.handle(
        request(`${lane}/resources/example.forms.invalid/StandardClient/client/import`, {
          method: "POST",
          headers: { "idempotency-key": "service-import-retention-0001", "if-none-match": "*" },
          body: JSON.stringify({
            ...resource("com.example.archive"),
            nativeId: "native-standard-client",
          }),
        }),
      );
      expect(accepted?.status).toBe(202);
      expect(projections).toBe(1);
      expect(imports).toBe(loseProjectionAck ? 0 : 1);
      expect(await host.maintenance?.drainProviderRepairs()).toMatchObject({
        pending: 1,
        settled: 0,
      });
      expect(projections).toBe(1);
      expect(imports).toBe(loseProjectionAck ? 1 : 2);
      expect(
        await sql.query(
          "SELECT phase, provider_outcome, import_selection_json FROM tf_provider_mutation_sagas_selection_v1",
        ),
      ).toEqual([
        {
          phase: "planned",
          provider_outcome: "indeterminate",
          import_selection_json: expect.any(String),
        },
      ]);
      expect(
        await sql.query("SELECT phase FROM tf_resource_provider_effects ORDER BY phase"),
      ).toEqual([{ phase: "dispatched" }, { phase: "planned" }]);
    },
  );

  test("rejects portable endpoint, credential, FormRef, and Resource selector fields", async () => {
    const host = stableHost({
      async selectApply() {
        return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" } as const;
      },
      async apply() {
        throw new Error("invalid portable state must not mutate");
      },
      async observe() {
        return {};
      },
      async delete() {},
    });
    for (const extra of [
      { endpoint: "https://objects.invalid" },
      { credential: "secret" },
      { formRef: { apiVersion: "edge.forms.takoform.com", kind: "ObjectBucket" } },
      { resource: { name: "bucket" } },
    ]) {
      const candidate = resource("com.example.archive");
      Object.assign(candidate.spec.externalServices[0] as object, extra);
      const response = await host.handle(
        request(`${lane}/resources/validate`, {
          method: "POST",
          body: JSON.stringify(candidate),
        }),
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({
        valid: false,
        diagnostics: [{ severity: "error", message: "unknown field" }],
      });
    }
  });
});

function stableHost(
  driver: TakoformResourceDriver,
  withResolver = true,
  resolver?: TakoformStandardServiceResolver,
  deferredOperations?: DeferredOperationsConfiguration,
) {
  return createTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver,
    ...(deferredOperations ? { deferredOperations } : {}),
    ...(withResolver
      ? {
          standardServiceResolver: resolver ?? {
            async satisfiable({ tenantId, space, serviceRef }) {
              return (
                tenantId === "tenant-a" &&
                (space === undefined || space === "main") &&
                serviceRef.protocol === "com.example.archive"
              );
            },
            async resolve({ tenantId, space, slot }) {
              if (
                tenantId !== "tenant-a" ||
                space !== "main" ||
                slot.service.protocol !== "com.example.archive"
              ) {
                return null;
              }
              return {
                endpoint: { endpoint: `sealed-endpoint:${space}` },
                credential: { token: "sealed-credential" },
              };
            },
          },
        }
      : {}),
  });
}

function resource(
  protocol: string,
  required?: boolean,
  tail: readonly Record<string, unknown>[] = [],
) {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name: "client", space: "main" },
    spec: {
      externalServices: [
        {
          name: "ARCHIVE",
          ...(required === undefined ? {} : { required }),
          service: { apiVersion: serviceApiVersion, protocol },
        },
        ...tail,
      ],
    },
  };
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer test");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://api.takoserver.com${path}`, { ...init, headers });
}
