import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE } from "../src/generated/takoform-publisher-set-authority-closure.ts";
import {
  TAKOFORM_PUBLISHER_SET_RECEIPT,
  TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST,
} from "../src/generated/takoform-publisher-set-receipt.ts";
import { bytesDigest, canonicalDigest, canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import {
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../src/takoform/admission.ts";
import {
  TAKOFORM_CORE_COMMIT,
  TAKOFORM_CORE_VERIFIER_PROTOCOL,
  TAKOFORM_CORE_VERSION,
  type TakoformCoreVerifierContainerNamespace,
} from "../src/takoform/form-authority-verification.ts";
import type {
  FormAuthorityPlan,
  FormAuthorityPlanRequest,
} from "../src/takoform/host-admission-coordinator.ts";
import {
  createProductionFormAuthorityComposition,
  deriveFormAuthorityIdentity,
  type FormAuthorityEndpointConfiguration,
} from "../src/takoform/host-admission-endpoint.ts";
import {
  YURUCOMMU_FORM_VERSIONS,
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";
import {
  loadPublisherSetClosure,
  PUBLISHER_SET_IMPORT_KIND,
} from "../src/takoform/publisher-set-closure.ts";

const digest = (hex: string) => `sha256:${hex.repeat(64)}` as const;
const PUBLIC_VERSION_ID = "00000000-0000-4000-8000-000000000011";
const HOST_ID = "https://api.takoserver.example";
const ARTIFACT_DIGEST = digest("a");
const PAYLOAD_DIGEST = digest("8");
const CAPABILITIES = yurucommuLifecycleCapabilityManifest(YURUCOMMU_IDENTITY_CAPABILITY_KINDS);
const EXPECTED_REPOSITORY = "https://github.com/tako0614/takoform-forms.git";
const EXPECTED_REPOSITORY_COMMIT = "3231633605b737ce5279d7fc020b4780568e7091";
const EXPECTED_SET_ID = "e7f8a39311dd011b8467e97e7f300cabb9a6b06c";
const IMPLEMENTED_KINDS = Object.keys(YURUCOMMU_FORM_VERSIONS).sort();
/** Core attests the exact raw policy bytes; the Host pins the canonical digest. */
const RAW_POLICY_DIGEST = await bytesDigest(
  new TextEncoder().encode(TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE.core.publisherPolicy),
);
const UNIMPLEMENTED_KINDS = [
  "ActorNamespace",
  "DurableWorkflow",
  "ObjectBucket",
  "StaticAssetBundle",
  "WorkerCustomDomain",
];

describe("exact publisher-set import", () => {
  test("binds one exact import identity and a closed 17-package evidence set", async () => {
    const closure = await loadPublisherSetClosure();
    expect(closure.identity).toEqual({
      kind: PUBLISHER_SET_IMPORT_KIND,
      repository: EXPECTED_REPOSITORY,
      repositoryCommit: EXPECTED_REPOSITORY_COMMIT,
      setId: EXPECTED_SET_ID,
      setTag: `forms/sets/${EXPECTED_SET_ID}`,
      receiptDigest: TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST,
      coreVersion: TAKOFORM_CORE_VERSION,
      packageCount: 17,
    });
    expect(await canonicalDigest(TAKOFORM_PUBLISHER_SET_RECEIPT)).toBe(
      TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST,
    );
    expect(closure.publisherKey).toBe(`takoform-forms:${await canonicalDigest(closure.identity)}`);
    expect(closure.evidence.publisher.publisherKey).toBe(closure.publisherKey);

    expect(closure.packageSet).toHaveLength(17);
    const kinds = closure.packageSet.map((entry) => entry.formRef.kind).sort();
    expect(new Set(kinds).size).toBe(17);
    expect(kinds).toEqual([...IMPLEMENTED_KINDS, ...UNIMPLEMENTED_KINDS].sort());

    const { evidence } = closure;
    expect(evidence.checkpoint).toEqual({
      apiVersion: TAKOFORM_REVOCATION_V1,
      sequence: 0,
      digest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
      entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
      previousDigest: null,
      revokedPackageDigests: [],
    });
    expect(evidence.publisher.sourceCommit).toBe(EXPECTED_SET_ID);
    expect(evidence.publisher.group).toBe("edge.forms.takoform.com");
    expect(evidence.publisher.repositoryIdentifier).toBe("repo:tako0614/takoform-forms");
    expect(evidence.publisher.ownerIdentifier).toBe("owner:tako0614");
    expect(evidence.core?.protocol).toBe(TAKOFORM_CORE_VERIFIER_PROTOCOL);
    expect(evidence.core?.expectedSourceCommit).toBe(EXPECTED_SET_ID);
    expect(evidence.core?.packageBundles).toHaveLength(17);
    expect(evidence.packageBundleDigests).toHaveLength(17);
    for (const entry of evidence.packageBundleDigests) {
      const raw = evidence.core?.packageBundles.find(
        (bundle) => bundle.packageDigest === entry.packageDigest,
      );
      if (!raw) throw new Error("raw bundle is missing");
      expect(entry.formRef).toBeDefined();
      expect(canonicalJson(raw.formRef)).toBe(canonicalJson(entry.formRef));
      expect(await bytesDigest(new TextEncoder().encode(raw.bundle))).toBe(entry.bundleDigest);
    }
    if (!evidence.core || !evidence.checkpointBundleDigest)
      throw new Error("core evidence missing");
    expect(await bytesDigest(new TextEncoder().encode(evidence.core.checkpointBundle))).toBe(
      evidence.checkpointBundleDigest,
    );
    const serialized = canonicalJson(evidence);
    expect(serialized).not.toContain('"official"');
    expect(serialized).not.toContain('"publisherClass"');

    for (const entry of closure.packageSet) {
      const pkg = await closure.packages.load(entry);
      expect(pkg.packageDigest).toBe(entry.packageDigest);
      expect(await canonicalDigest(pkg.manifest)).toBe(entry.packageDigest);
      for (const file of pkg.files) {
        if (!(file.bytes instanceof Uint8Array) || !file.digest) {
          throw new Error("bytes must be bounded and digested");
        }
        expect(await bytesDigest(file.bytes)).toBe(file.digest);
      }
    }
    await expect(
      closure.packages.load({
        formRef: closure.packageSet[0]!.formRef,
        packageDigest: digest("f"),
      }),
    ).rejects.toMatchObject({ code: "package_unavailable" });
  });

  test("plans the complete import but supports and activates only the implemented subset", async () => {
    const fixture = await productionFixture(fakeContainer());
    const plan = await fixture.composition.endpoint.plan(fixture.request);

    expect(plan.packages).toHaveLength(17);
    expect(plan.commands).toHaveLength(2 + 17 + IMPLEMENTED_KINDS.length * 2);
    expect(kindsOf(plan, "AllowPublisher")).toEqual([]);
    expect(plan.commands.filter((command) => command.kind === "AllowPublisher")).toHaveLength(1);
    expect(plan.commands.filter((command) => command.kind === "AppendCheckpoint")).toHaveLength(1);
    expect(kindsOf(plan, "InstallPackage")).toEqual(
      [...IMPLEMENTED_KINDS, ...UNIMPLEMENTED_KINDS].sort(),
    );
    expect(kindsOf(plan, "SetSupport")).toEqual(IMPLEMENTED_KINDS);
    expect(kindsOf(plan, "SetActivation")).toEqual(IMPLEMENTED_KINDS);
    for (const kind of UNIMPLEMENTED_KINDS) {
      const pkg = plan.packages.find((entry) => entry.formRef.kind === kind);
      expect(pkg?.operations).toEqual([]);
    }
    expect(fixture.container.requests).toEqual([]);
  });

  test("apply verifies the whole raw set through released Core once; readback separates installed from supported and active", async () => {
    const container = fakeContainer();
    const fixture = await productionFixture(container);
    const plan = await fixture.composition.endpoint.plan(fixture.request);
    const applied = await fixture.composition.endpoint.apply(plan);

    expect(applied.status).toBe("converged");
    expect(applied.verificationMode).toBe("released-core");
    expect(applied.productionEligible).toBe(true);
    expect(applied.receipts).toHaveLength(plan.commands.length);
    expect(applied.nextPlan.commands).toEqual([]);

    expect(container.requests.map((request) => request.url)).toEqual([
      "http://takoform-core-verifier/v1/verify-set",
    ]);
    const sent = container.requests[0]?.body as {
      readonly protocol: string;
      readonly expectedSourceCommit: string;
      readonly packages: readonly {
        readonly packageDigest: string;
        readonly formRef: { readonly kind: string };
        readonly index: string;
        readonly bundle: string;
        readonly files: readonly { readonly path: string; readonly bytes: string }[];
      }[];
    };
    expect(sent.protocol).toBe(TAKOFORM_CORE_VERIFIER_PROTOCOL);
    expect(sent.expectedSourceCommit).toBe(EXPECTED_SET_ID);
    expect(sent.packages).toHaveLength(17);
    expect(sent.packages.map((pkg) => pkg.formRef.kind).sort()).toEqual(
      [...IMPLEMENTED_KINDS, ...UNIMPLEMENTED_KINDS].sort(),
    );
    for (const pkg of sent.packages) {
      expect(pkg.index.length).toBeGreaterThan(0);
      expect(pkg.bundle.length).toBeGreaterThan(0);
      expect(pkg.files.length).toBeGreaterThan(0);
    }

    const readback = applied.readback;
    expect(readback.forms).toHaveLength(17);
    for (const form of readback.forms) {
      expect(form.installed).toBe(true);
      if (IMPLEMENTED_KINDS.includes(form.formRef.kind)) {
        expect(form.supported).toBe(true);
        expect(form.activationHead.present).toBe(true);
        expect(form.activationHead.active).toBe(true);
        expect(form.activationHead.implementationDigest).toBe(
          fixture.composition.identity.implementationDigest,
        );
      } else {
        expect(UNIMPLEMENTED_KINDS).toContain(form.formRef.kind);
        expect(form.supported).toBe(false);
        expect(form.operations).toEqual([]);
        expect(form.activationHead).toEqual({
          present: false,
          active: false,
          implementationDigest: null,
          eventDigest: null,
        });
      }
    }
    const objectBucket = readback.forms.find((form) => form.formRef.kind === "ObjectBucket");
    expect(objectBucket).toMatchObject({ installed: true, supported: false, operations: [] });

    const publishers = await fixture.sql.query(
      "SELECT publisher_key, event_type, source_commit FROM tf_form_publisher_events",
    );
    expect(publishers).toEqual([
      {
        publisher_key: fixture.closure.publisherKey,
        event_type: "allow",
        source_commit: EXPECTED_SET_ID,
      },
    ]);
    const installs = await fixture.sql.query(
      "SELECT package_digest, publisher_key FROM tf_form_install_events ORDER BY package_digest",
    );
    expect(installs).toHaveLength(17);
    expect(new Set(installs.map((row) => row.publisher_key))).toEqual(
      new Set([fixture.closure.publisherKey]),
    );
    const stored = (await fixture.objects.list({ prefix: "formpkg/", limit: 1_000 })).objects;
    for (const entry of fixture.closure.packageSet) {
      const hex = entry.packageDigest.slice("sha256:".length);
      expect(stored.some((object) => object.key.includes(hex))).toBe(true);
    }

    const again = await fixture.composition.endpoint.plan(fixture.request);
    expect(again.commands).toEqual([]);
    const reapplied = await fixture.composition.endpoint.apply(again);
    expect(reapplied.status).toBe("converged");
    expect(container.requests).toHaveLength(1);
  });

  test("a refused verification leaves no durable state and every retry re-verifies all 17 packages", async () => {
    const container = fakeContainer();
    const fixture = await productionFixture(container);
    const plan = await fixture.composition.endpoint.plan(fixture.request);

    container.refuse = true;
    await expect(fixture.composition.endpoint.apply(plan)).rejects.toMatchObject({
      code: "verification_evidence_refused",
    });
    expect(await fixture.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
    expect(await fixture.sql.query("SELECT * FROM tf_form_install_events")).toEqual([]);
    expect((await fixture.objects.list({ prefix: "formpkg/", limit: 1_000 })).objects).toEqual([]);

    container.refuse = false;
    fixture.failIdentityCallAt(12);
    const partial = await fixture.composition.endpoint.apply(plan);
    expect(partial.status).toBe("partial");
    expect(partial.failure).toBeDefined();
    expect(partial.receipts.length).toBeLessThan(plan.commands.length);
    expect(partial.nextPlan.commands.length).toBeGreaterThan(0);

    const recovered = await fixture.composition.endpoint.apply(partial.nextPlan);
    expect(recovered.status).toBe("converged");
    expect(recovered.nextPlan.commands).toEqual([]);
    const verifySets = container.requests.filter((request) =>
      request.url.endsWith("/v1/verify-set"),
    );
    expect(verifySets).toHaveLength(3);
    for (const request of verifySets) {
      expect((request.body as { readonly packages: unknown[] }).packages).toHaveLength(17);
    }
    expect(recovered.readback.forms.filter((form) => form.installed)).toHaveLength(17);
    expect(recovered.readback.forms.filter((form) => form.supported)).toHaveLength(
      IMPLEMENTED_KINDS.length,
    );
  });

  test("refuses evidence that is not the embedded exact import before touching Core", async () => {
    const container = fakeContainer();
    const fixture = await productionFixture(container);
    const evidence = fixture.request.evidence;
    const variants: FormAuthorityPlanRequest["evidence"][] = [
      {
        ...evidence,
        packageBundleDigests: evidence.packageBundleDigests.map((entry, index) =>
          index === 0 ? { ...entry, bundleDigest: digest("b") } : entry,
        ),
      },
      { ...evidence, publisher: { ...evidence.publisher, sourceCommit: "f".repeat(40) } },
      {
        ...evidence,
        publisher: { ...evidence.publisher, publisherKey: "takoform-forms:other-import" },
      },
      { ...evidence, packageBundleDigests: evidence.packageBundleDigests.slice(0, 12) },
    ];
    for (const variant of variants) {
      await expect(
        fixture.composition.endpoint.plan({ ...fixture.request, evidence: variant }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        fixture.composition.endpoint.readback({ ...fixture.request, evidence: variant }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(container.requests).toEqual([]);
    expect(await fixture.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
  });
});

function kindsOf(plan: FormAuthorityPlan, kind: FormAuthorityPlan["commands"][number]["kind"]) {
  if (kind === "AllowPublisher" || kind === "AppendCheckpoint") return [];
  return plan.commands
    .filter((command) => command.kind === kind)
    .map((command) => ("formRef" in command ? command.formRef.kind : ""))
    .sort();
}

interface FakeContainer {
  readonly namespace: TakoformCoreVerifierContainerNamespace;
  readonly requests: { readonly url: string; readonly body: unknown }[];
  refuse: boolean;
}

function fakeContainer(): FakeContainer {
  const requests: { readonly url: string; readonly body: unknown }[] = [];
  const container: FakeContainer = {
    requests,
    refuse: false,
    namespace: {
      idFromName: (name) => ({ toString: () => name, equals: () => true }),
      get: () => ({
        async fetch(input, init) {
          const request = new Request(input, init);
          const body = request.method === "POST" ? await request.json() : null;
          requests.push({ url: request.url, body });
          if (container.refuse) {
            return Response.json({ code: "verification_refused" }, { status: 422 });
          }
          if (request.url.endsWith("/v1/identity")) return Response.json(coreIdentity());
          return Response.json(coreResponse(body as { readonly packages: readonly unknown[] }));
        },
      }),
    },
  };
  return container;
}

function coreIdentity() {
  return {
    protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
    coreVersion: TAKOFORM_CORE_VERSION,
    coreCommit: TAKOFORM_CORE_COMMIT,
    artifactDigest: ARTIFACT_DIGEST,
  };
}

/** Mirrors the Go service response shape for the exact receipt-backed set. */
function coreResponse(body: { readonly packages: readonly unknown[] }) {
  const receipt = TAKOFORM_PUBLISHER_SET_RECEIPT;
  return {
    identity: coreIdentity(),
    publisher: {
      policyDigest: RAW_POLICY_DIGEST,
      trustedRootDigest: receipt.trustedRootDigest,
      oidcIssuer: receipt.oidcIssuer,
      sourceRepository: receipt.sourceRepository,
      workflow: receipt.workflow,
      ref: receipt.ref,
      identity: receipt.publisherIdentity,
      sourceCommit: receipt.sourceCommit,
      workflowCommit: receipt.workflowCommit,
      buildConfigCommit: receipt.buildConfigCommit,
    },
    checkpoint: {
      checkpointApiVersion: receipt.checkpoint.apiVersion,
      sequence: receipt.checkpoint.sequence,
      digest: receipt.checkpoint.digest,
      entriesDigest: receipt.checkpoint.entriesDigest,
      bundleDigest: receipt.checkpoint.bundleDigest,
      revokedPackageDigests: [],
    },
    packages: body.packages.map((value) => {
      const pkg = value as { readonly packageDigest: string; readonly formRef: unknown };
      const entry = receipt.packages.find((item) => item.packageDigest === pkg.packageDigest);
      if (!entry) throw new Error(`unexpected package ${pkg.packageDigest}`);
      return {
        packageDigest: pkg.packageDigest,
        formRef: pkg.formRef,
        bundleDigest: entry.bundleDigest,
      };
    }),
  };
}

async function productionFixture(container: FakeContainer) {
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  const semantic = await derivePublicFormImplementationIdentity({
    implementationPayloadDigest: PAYLOAD_DIGEST,
    capabilities: CAPABILITIES,
  });
  const configuration: FormAuthorityEndpointConfiguration = {
    environment: "production",
    hostId: HOST_ID,
    workerArtifactDigest: digest("5"),
    publicWorkerVersionId: PUBLIC_VERSION_ID,
    implementationPayloadDigest: semantic.implementationPayloadDigest,
    implementationDigest: semantic.implementationDigest,
    capabilities: CAPABILITIES,
    coreVerifierArtifactDigest: ARTIFACT_DIGEST,
  };
  const identity = await deriveFormAuthorityIdentity(configuration);
  const live = {
    kind: "takoserver.public-host-identity@v2" as const,
    hostId: identity.hostId,
    workerVersionId: identity.publicWorkerVersionId,
    workerArtifactDigest: identity.workerArtifactDigest,
    implementationPayloadDigest: semantic.implementationPayloadDigest,
    capabilityDigest: semantic.capabilityDigest,
    implementationDigest: identity.implementationDigest,
  };
  let identityCalls = 0;
  let failAt: number | null = null;
  const composition = await createProductionFormAuthorityComposition({
    configuration,
    bindings: {
      sql,
      objects,
      publicHostIdentity: {
        async identity() {
          identityCalls += 1;
          if (failAt !== null && identityCalls === failAt) {
            failAt = null;
            throw new Error("public Host identity temporarily unavailable");
          }
          return live;
        },
      },
      coreVerifier: container.namespace,
    },
  });
  const closure = await loadPublisherSetClosure();
  const request: FormAuthorityPlanRequest = {
    kind: "takoserver.form-authority-plan-request@v2",
    ...composition.identity,
    activation: {
      kind: "space",
      tenantId: "tenant-takos",
      space: "space-takos",
      desiredActive: true,
    },
    evidence: closure.evidence,
    actor: "production-operator",
    reason: "import the exact publisher set and activate the implemented subset",
  };
  return {
    composition,
    request,
    sql,
    objects,
    closure,
    container,
    failIdentityCallAt(call: number) {
      failAt = identityCalls + call;
    },
  };
}
