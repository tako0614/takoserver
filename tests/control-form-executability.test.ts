import { expect, test } from "bun:test";
import { edgeProviderOffering } from "../src/edge-forms.ts";
import { buildApp, createEphemeralSql, createMemoryObjectStore } from "../src/index.ts";
import { canonicalJson } from "../src/json.ts";
import type { ProviderOffering } from "../src/provider-port.ts";
import {
  deriveRuntimeImplementationCatalog,
  publicFormCapabilityManifest,
} from "../src/public-worker-implementation.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";

/**
 * The public Form catalogue answers "which Forms exist" for the whole platform.
 * That is a different fact from "which of them this Host will accept", and a
 * client cannot plan a resource from the first one alone. These tests pin the
 * second fact to the composition that owns the answer, so the catalogue can
 * never advertise a lifecycle operation the apply would refuse.
 */

const HOST_ORIGIN = "https://api.takoserver.test";
const NOW = "2026-09-29T00:00:00Z";

interface FormProfile {
  readonly formRef: { readonly kind: string };
  readonly executable?: boolean;
  readonly activated?: boolean;
  readonly availableToPrincipal?: boolean;
}

function identity() {
  return {
    async verify() {
      return {
        providerSubject: "owner-subject",
        email: "owner@example.test",
        displayName: "Owner",
      };
    },
  };
}

function settlement() {
  return {
    async verify() {
      return { fundingRef: "unused", amountMinor: 0, currency: "USD" as const };
    },
  };
}

/** One identity Form this composition really backs, and nothing else. */
function moduleWorkerOffering(): ProviderOffering {
  const form = currentTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  if (!form) throw new Error("published ModuleWorker Form is missing");
  return edgeProviderOffering(form, { id: "test.module-worker" });
}

function host(options: { readonly backed: boolean }) {
  const sql = createEphemeralSql();
  const candidates = currentTakoformCandidates();
  let counter = 0;
  return buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity: identity(),
    settlement: settlement(),
    publicOrigin: HOST_ORIGIN,
    forms: candidates.forms,
    bindings: candidates.bindings,
    hostForms: candidates.forms,
    hostBindings: candidates.bindings,
    providers: [
      {
        id: "catalogue-test-provider",
        offerings: options.backed ? [moduleWorkerOffering()] : [],
        async apply(): Promise<never> {
          throw new Error("the catalogue must not dispatch a provider mutation");
        },
        async observe(): Promise<never> {
          throw new Error("the catalogue must not observe a provider resource");
        },
        async delete(): Promise<never> {
          throw new Error("the catalogue must not delete a provider resource");
        },
      },
    ],
    offerings: [],
    clock: () => new Date(NOW),
    randomId: () => {
      counter += 1;
      return `catalogue_test_${String(counter).padStart(8, "0")}`;
    },
  });
}

async function profiles(app: ReturnType<typeof buildApp>): Promise<readonly FormProfile[]> {
  const response = await app.fetch(new Request(`${HOST_ORIGIN}/v1/forms`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly profiles: readonly FormProfile[] };
  return body.profiles;
}

test("the public Form catalogue states which of those Forms this Host will accept", async () => {
  const app = host({ backed: true });
  const listed = await profiles(app);
  const byKind = new Map(listed.map((profile) => [profile.formRef.kind, profile]));

  // The published publisher set is what a client discovers, unchanged.
  expect(listed).toHaveLength(currentTakoformCandidates().forms.length);

  // Every advertised Form carries this Host's own answer, and only one answer.
  for (const profile of listed) {
    expect(typeof profile.executable).toBe("boolean");
    expect(profile.activated).toBe(profile.executable);
    expect(profile.availableToPrincipal).toBe(profile.executable);
  }

  // The composed provider backs ModuleWorker and nothing else here.
  expect(byKind.get("ModuleWorker")?.executable).toBe(true);
  expect(byKind.get("WorkerVersion")?.executable).toBe(false);

  // Published identities this Host has no handler for must not read as accepted.
  expect(byKind.get("ActorNamespace")?.executable).toBe(false);
  expect(byKind.get("DurableWorkflow")?.executable).toBe(false);

  // The catalogue can never promise more than the code-owned handler manifest
  // proves. This is the gate: a kind that loses its handler loses its claim.
  const catalog = await deriveRuntimeImplementationCatalog({
    implementationPayloadDigest: `sha256:${"c".repeat(64)}`,
    capabilities: publicFormCapabilityManifest(),
  });
  const proven = new Set(catalog.entries.map((entry) => canonicalJson(entry.formRef)));
  for (const profile of listed) {
    if (profile.executable !== true) continue;
    expect(proven.has(canonicalJson(profile.formRef))).toBe(true);
  }
});

test("a composition with no platform-level answer publishes no executability at all", async () => {
  const withoutOfferings = host({ backed: false });
  const listed = await profiles(withoutOfferings);
  const byKind = new Map(listed.map((profile) => [profile.formRef.kind, profile]));

  // An unbacked identity Form is refused, and the catalogue says so.
  expect(byKind.get("ModuleWorker")?.executable).toBe(false);
  expect(byKind.get("ActorNamespace")?.executable).toBe(false);

  // The intrinsic edge kinds are executed by the Host itself in every lane.
  expect(byKind.get("WorkerBundle")?.executable).toBe(true);
});
