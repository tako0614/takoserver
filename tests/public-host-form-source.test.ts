import { expect, test } from "bun:test";
import { createCatalog } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { parseHostedEdgeSupplies } from "../src/hosted-edge-supplies.ts";
import { createLedger } from "../src/ledger.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import type { CloudflareProviderExecutorRpc } from "../src/providers/cloudflare-provider-executor-port.ts";
import { selectPublicHostFormSource } from "../src/public-host-form-source.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { createWorkerProductionComposition } from "../src/worker-production-composition.ts";
import { edgeSuppliesFixture } from "./helpers/hosted-supply-fixtures.ts";

test("public Host defaults to the released Forms and registers no Actor class ABI", () => {
  const selected = selectPublicHostFormSource(undefined);
  expect(selected.forms).toEqual(currentTakoformCandidates().forms);
  expect(selected.bindings).toEqual(currentTakoformCandidates().bindings);
  expect(selected.retainedForms).toEqual([]);
  expect(selected.workerClassRuntimeContracts).toEqual([]);
});

test("explicit source candidate carries the exact Actor class ABI without publishing it", () => {
  const selected = selectPublicHostFormSource("actor-forward");
  const actor = selected.forms.find((form) => form.identity.formRef.kind === "ActorNamespace");
  if (!actor?.identity.packageDigest || !actor.workerClassRuntime?.runtimeClassRef)
    throw new Error("Actor class ABI is absent");
  expect(selected.workerClassRuntimeContracts).toEqual([
    {
      formRef: actor.identity.formRef,
      packageDigest: actor.identity.packageDigest,
      runtimeClassRef: actor.workerClassRuntime.runtimeClassRef,
    },
  ]);
  expect(
    selected.retainedForms.some((form) => form.identity.formRef.kind === "ActorNamespace"),
  ).toBe(true);
  expect(selected.retainedBindings.length).toBeGreaterThan(0);
});

test("source candidate refuses a published Worker identity and unknown choices", () => {
  const identity = {
    workerArtifactDigest: `sha256:${"a".repeat(64)}` as const,
    implementationPayloadDigest: `sha256:${"b".repeat(64)}` as const,
    capabilityDigest: `sha256:${"c".repeat(64)}` as const,
    implementationDigest: `sha256:${"d".repeat(64)}` as const,
  };
  expect(() => selectPublicHostFormSource("actor-forward", identity)).toThrow(
    "unpublished Actor source cannot serve a public Form authority identity",
  );
  expect(() => selectPublicHostFormSource("ActorNamespace")).toThrow(
    "unknown public Host Form source candidate",
  );
});

test("exact forward Actor ABI creates only technical proxy capability, not a sellable identity", async () => {
  const selected = selectPublicHostFormSource("actor-forward");
  const supply = edgeSuppliesFixture();
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-09-28T00:00:00.000Z");
  let inspected = 0;
  const composition = createWorkerProductionComposition({
    env: {
      TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(supply),
      TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
      CLOUDFLARE_PROVIDER_EXECUTOR: {
        async inspectWorkerClass() {
          inspected += 1;
          return "valid";
        },
      } as unknown as CloudflareProviderExecutorRpc,
    },
    forms: selected.forms,
    retainedForms: selected.retainedForms,
    workerClassRuntimeContracts: selected.workerClassRuntimeContracts,
    formSourceCandidate: "actor-forward",
    now: new Date("2026-09-28T00:00:00.000Z"),
  });
  const actor = selected.forms.find((form) => form.identity.formRef.kind === "ActorNamespace");
  const provider = composition.providers[0];
  if (!provider || !actor) throw new Error("Actor technical proxy fixture is incomplete");
  expect(composition.providers[0]?.workerClassRuntime?.contracts).toEqual(
    selected.workerClassRuntimeContracts,
  );
  expect(provider.offerings.filter((offering) => offering.form.kind === "ActorNamespace")).toEqual([
    expect.objectContaining({
      id: "cloudflare.technical.actor-forward.v1",
      form: actor.identity.formRef,
      capabilities: ["create", "delete", "import", "observe"],
    }),
  ]);
  expect(composition.offerings.some((offering) => offering.form.kind === "ActorNamespace")).toBe(
    false,
  );
  expect(createCatalog(composition.offerings).offeringsFor(actor.identity.formRef)).toEqual([]);
  const actorContract = selected.workerClassRuntimeContracts[0];
  if (!actorContract || !actor.workerClassRuntime) {
    throw new Error("Actor class runtime contract is incomplete");
  }
  const resourceIdentity = (uid: string) => ({
    uid,
    generation: "1",
    revision: "revision-1",
    formRef: actor.identity.formRef,
  });
  expect(
    await provider.workerClassRuntime?.inspect({
      contract: actorContract,
      tenantId: "tenant-actor-test",
      space: "main",
      className: "Counter",
      holder: resourceIdentity("actor-holder"),
      worker: resourceIdentity("actor-worker"),
      deployment: resourceIdentity("actor-deployment"),
      version: resourceIdentity("actor-version"),
      weight: 10_000,
      bundle: { ...resourceIdentity("actor-bundle"), manifestDigest: `sha256:${"d".repeat(64)}` },
      providerInstallationRef: supply.providerInstallation.id,
      holderNativeId: `actor:${"e".repeat(32)}`,
      versionNativeId: "worker:version",
    }),
  ).toBe("valid");
  const driver = createProviderDriver({
    providers: composition.providers,
    providerPacks: composition.providerPacks,
    catalog: createCatalog(composition.offerings),
    ledger: createLedger(sql, clock),
    deployments: createResourceDeploymentStore(sql, clock),
  });
  await expect(
    driver.selectApply({
      tenantId: "tenant-actor-test",
      resourceUid: "actor_test",
      form: actor,
      name: "actor",
      space: "main",
      spec: {},
      relations: [],
    }),
  ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
  expect(inspected).toBe(1);
});

test("Actor technical proxy offering refuses absent opt-in, exact class ABI, or inspection RPC", () => {
  const selected = selectPublicHostFormSource("actor-forward");
  const supply = edgeSuppliesFixture();
  const inspector = async () => "valid" as const;
  const compose = (overrides: Partial<Parameters<typeof createWorkerProductionComposition>[0]>) =>
    createWorkerProductionComposition({
      env: {
        TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(supply),
        TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
        CLOUDFLARE_PROVIDER_EXECUTOR: {
          inspectWorkerClass: inspector,
        } as unknown as CloudflareProviderExecutorRpc,
      },
      forms: selected.forms,
      retainedForms: selected.retainedForms,
      workerClassRuntimeContracts: selected.workerClassRuntimeContracts,
      now: new Date("2026-09-28T00:00:00.000Z"),
      ...overrides,
    });
  const hasActorOffering = (value: ReturnType<typeof createWorkerProductionComposition>) =>
    value.providers[0]?.offerings.some((offering) => offering.form.kind === "ActorNamespace");

  expect(hasActorOffering(compose({}))).toBe(false);
  expect(
    hasActorOffering(
      compose({
        formSourceCandidate: "actor-forward",
        workerClassRuntimeContracts: [],
      }),
    ),
  ).toBe(false);
  const [contract] = selected.workerClassRuntimeContracts;
  if (!contract) throw new Error("Actor candidate class contract is missing");
  expect(
    hasActorOffering(
      compose({
        formSourceCandidate: "actor-forward",
        workerClassRuntimeContracts: [{ ...contract, packageDigest: `sha256:${"f".repeat(64)}` }],
      }),
    ),
  ).toBe(false);
  expect(
    hasActorOffering(
      createWorkerProductionComposition({
        env: {
          TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(supply),
          TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
          CLOUDFLARE_PROVIDER_EXECUTOR: {} as unknown as CloudflareProviderExecutorRpc,
        },
        forms: selected.forms,
        retainedForms: selected.retainedForms,
        workerClassRuntimeContracts: selected.workerClassRuntimeContracts,
        formSourceCandidate: "actor-forward",
        now: new Date("2026-09-28T00:00:00.000Z"),
      }),
    ),
  ).toBe(false);
});

test("commercial supply parser refuses an unreviewed Actor identity class", () => {
  const supplied = edgeSuppliesFixture();
  expect(() =>
    parseHostedEdgeSupplies(
      JSON.stringify({
        ...supplied,
        offerings: [{ ...supplied.offerings[0], formKind: "ActorNamespace" }],
      }),
    ),
  ).toThrow("invalid hosted edge supplies");
});
