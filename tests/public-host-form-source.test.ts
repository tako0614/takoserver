import { expect, test } from "bun:test";
import { parseHostedEdgeSupplies } from "../src/hosted-edge-supplies.ts";
import { selectPublicHostFormSource } from "../src/public-host-form-source.ts";
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

test("source ABI reaches the common provider proxy but does not mint an Actor Offering", () => {
  const selected = selectPublicHostFormSource("actor-forward");
  const supply = edgeSuppliesFixture();
  const composition = createWorkerProductionComposition({
    env: {
      TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(supply),
      TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
      CLOUDFLARE_PROVIDER_EXECUTOR: {} as NonNullable<
        Parameters<
          typeof createWorkerProductionComposition
        >[0]["env"]["CLOUDFLARE_PROVIDER_EXECUTOR"]
      >,
    },
    forms: selected.forms,
    retainedForms: selected.retainedForms,
    workerClassRuntimeContracts: selected.workerClassRuntimeContracts,
    now: new Date("2026-09-28T00:00:00.000Z"),
  });
  expect(composition.providers[0]?.workerClassRuntime?.contracts).toEqual(
    selected.workerClassRuntimeContracts,
  );
  expect(composition.offerings.some((offering) => offering.form.kind === "ActorNamespace")).toBe(
    false,
  );
  expect(
    composition.providers[0]?.offerings.some((offering) => offering.form.kind === "ActorNamespace"),
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
