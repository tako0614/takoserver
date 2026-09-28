import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FormAuthorityDeployState,
  type FormAuthorityProcess,
  publicFormCapabilityManifest,
  runFormAuthority,
  type SelectedFormAuthorityTarget,
  takoformCoreVerifierArtifactDigest,
  writeFormAuthorityConfig,
} from "../scripts/deploy/form-authority.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH } from "../src/form-authority-identity-probe.ts";
import { canonicalJson } from "../src/json.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import {
  cloudflareProviderExecutorTarget,
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

const SURFACE = "takoserver-existing-space-operator-worker" as const;
const COMMIT = "a".repeat(40);
const HOST_VERSION = "11111111-1111-4111-8111-111111111111";
const CORE_VERSION = "22222222-2222-4222-8222-222222222222";
const BRIDGE_VERSION = "33333333-3333-4333-8333-333333333333";
const NEXT_VERSION = "44444444-4444-4444-8444-444444444444";
const HOST_BUNDLE = "export default {};\n";
const BUNDLE = "export default class Operator {}\n";
const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as const;
const KEY = { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) } as const;
const POLICY = {
  kind: "takoserver.space-form-admission-policy@v1",
  organizationId: "org_operator",
  forms: [
    {
      formRef: {
        apiVersion: "edge.forms.takoform.com",
        kind: "Alpha",
        definitionVersion: "1.0.0",
        schemaDigest: digest("schema"),
      },
      packageDigest: digest("package"),
    },
  ],
} as const;

function target(environment: DeployTarget["environment"] = "integration") {
  return {
    kind: "takoserver.deploy-target@v2",
    environment,
    accountId: "a".repeat(32),
    workerName: "takoserver-api-test",
    d1: { databaseName: "takoserver-test", databaseId: "00000000-0000-4000-8000-000000000000" },
    r2: { bucketName: "takoserver-test" },
    publicOrigin: "https://api.example.test",
    signing: { currentKeyId: "key-current" },
    edgeSupplies: edgeSuppliesFixture(),
    objectBucketSupplies: objectBucketSuppliesFixture(),
    cloudflareProviderExecutor: cloudflareProviderExecutorTarget(),
    formAuthority: {
      workerName: "takoserver-core-test",
      hostId: "https://api.example.test",
      identityProbeWorkerName: "takoserver-probe-test",
      identityProbeOrigin: "https://probe.example.test",
      managedSpaceAdmissionPolicy: POLICY,
      existingSpaceOperator: {
        workerName: "takoserver-existing-space-test",
        origin: "https://operator.example.test",
        publicJwk: KEY,
      },
    },
  } satisfies DeployTarget;
}

type OperatorTestTarget = ReturnType<typeof target>;

function selected(t: OperatorTestTarget, authority = false): SelectedFormAuthorityTarget {
  return {
    kind: authority ? "authority" : "existing-space-operator",
    workerName: authority
      ? t.formAuthority.workerName
      : t.formAuthority.existingSpaceOperator.workerName,
    hostId: t.formAuthority.hostId,
    main: authority
      ? "src/entry-form-authority-worker.ts"
      : "src/entry-existing-space-operator-worker.ts",
    policyAuthority: "takoserver-host",
    verificationMode: "released-core",
    verificationAvailable: true,
    productionEligible: false,
    ...(authority
      ? {}
      : {
          authorityWorkerName: t.formAuthority.workerName,
          operatorOrigin: t.formAuthority.existingSpaceOperator.origin,
          operatorPublicJwk: KEY,
        }),
  };
}

interface TestConfiguration {
  [key: string]: unknown;
  vars: Record<string, string>;
  services: { binding: string; service: string; entrypoint: string }[];
  d1_databases?: { binding: string; database_id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  version_metadata?: { binding: string };
  durable_objects?: { bindings: { name: string; class_name: string }[] };
}

function configuration(t: OperatorTestTarget, authority = false): TestConfiguration {
  const root = mkdtempSync(join(tmpdir(), "existing-space-publication-config-"));
  try {
    const path = join(root, "worker.json");
    writeFormAuthorityConfig({
      path,
      main: selected(t, authority).main,
      selected: selected(t, authority),
      target: t,
      invocation: {
        surface: authority ? "takoserver-form-authority-worker" : SURFACE,
        environment: t.environment,
        action: "status",
        commit: COMMIT,
      },
      capabilityManifestJson: canonicalJson(publicFormCapabilityManifest()),
    });
    return JSON.parse(readFileSync(path, "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bindings(config: TestConfiguration): Record<string, unknown>[] {
  return [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...config.services.map(({ binding, ...fields }) => ({
      name: binding,
      type: "service",
      ...fields,
    })),
    ...(config.d1_databases ?? []).map((item) => ({
      name: item.binding,
      type: "d1",
      id: item.database_id,
    })),
    ...(config.r2_buckets ?? []).map((item) => ({
      name: item.binding,
      type: "r2_bucket",
      bucket_name: item.bucket_name,
    })),
    ...(config.version_metadata
      ? [{ name: config.version_metadata.binding, type: "version_metadata" }]
      : []),
    ...(config.durable_objects?.bindings ?? []).map((item) => ({
      ...item,
      type: "durable_object_namespace",
    })),
  ];
}

function harness(
  t = target(),
  input: {
    mutateBridge?: (bindings: Record<string, unknown>[]) => void;
    mutateCore?: (bindings: Record<string, unknown>[]) => void;
    coreCommit?: string;
    hostCommit?: string;
    coreDigest?: string;
    coreAbsent?: boolean;
    bridgeAbsent?: boolean;
    coreVerifierVersion?: string;
    domainOwner?: string;
    extraDomain?: boolean;
    subdomain?: boolean;
    secret?: boolean;
    driftCoreBeforeUpload?: boolean;
  } = {},
) {
  let uploaded = false;
  let coreReads = 0;
  const calls: string[][] = [];
  const coreBindings = bindings(configuration(t, true));
  const bridgeBindings = bindings(configuration(t));
  input.mutateCore?.(coreBindings);
  input.mutateBridge?.(bridgeBindings);
  const bridgeName = t.formAuthority.existingSpaceOperator.workerName;
  const history = (version: string, old = false) => ({
    id: `deployment-${version}`,
    created_on: old ? "2026-09-26T00:00:00Z" : "2026-09-27T00:00:00Z",
    versions: [{ version_id: version, percentage: 100 }],
  });
  const state: FormAuthorityDeployState = {
    async workerScripts() {
      return [
        ...(input.coreAbsent ? [] : [t.formAuthority.workerName]),
        ...(!input.bridgeAbsent || uploaded ? [bridgeName] : []),
      ];
    },
    async workerDeployments(name) {
      if (name === t.workerName) return [history(HOST_VERSION)];
      if (name === t.formAuthority.workerName) return [history(CORE_VERSION)];
      return uploaded
        ? [history(NEXT_VERSION), ...(!input.bridgeAbsent ? [history(BRIDGE_VERSION, true)] : [])]
        : [history(BRIDGE_VERSION)];
    },
    async workerVersion(name) {
      if (name === t.workerName)
        return {
          annotations: {
            "workers/message": `takoserver-worker:${input.hostCommit ?? COMMIT}:${digest(HOST_BUNDLE).slice(7)}`,
            "workers/triggered_by": "version_upload",
          },
          resources: {
            bindings: Object.entries(
              expectedExactBindingClosure(t, { workerArtifactDigest: digest(HOST_BUNDLE) }),
            ).flatMap(([name, value]) =>
              value ? [{ name, type: value.type, ...value.fields }] : [],
            ),
          },
        };
      const core = name === t.formAuthority.workerName;
      if (core) coreReads += 1;
      return {
        annotations: {
          "workers/message": `form-authority:${core ? "takoserver-form-authority-worker" : SURFACE}:${core ? (input.coreCommit ?? COMMIT) : COMMIT}:${core ? (input.coreDigest ?? digest(BUNDLE)) : digest(BUNDLE)}`,
        },
        resources: {
          bindings: core
            ? input.driftCoreBeforeUpload && coreReads > 1
              ? [...coreBindings, { name: "FOREIGN", type: "plain_text", text: "x" }]
              : coreBindings
            : bridgeBindings,
        },
      };
    },
    async workerSecrets(name) {
      return name === t.workerName
        ? expectedWorkerSecrets(t).map((name) => ({ name, type: "secret_text" }))
        : name === bridgeName && input.secret
          ? [{ name: "UNEXPECTED", type: "secret_text" }]
          : [];
    },
    async workerDomains() {
      return [
        { hostname: "api.example.test", service: t.workerName },
        ...(!input.bridgeAbsent || uploaded
          ? [{ hostname: "operator.example.test", service: input.domainOwner ?? bridgeName }]
          : []),
        ...(input.extraDomain ? [{ hostname: "extra.example.test", service: bridgeName }] : []),
      ];
    },
    async workerSubdomain(name) {
      return { enabled: name === bridgeName && !!input.subdomain, previewsEnabled: false };
    },
    async workerRoutes() {
      return [];
    },
  };
  const run: FormAuthorityProcess = async (command) => {
    calls.push([...command]);
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    if (command.join(" ") === "git rev-parse HEAD") return ok(COMMIT);
    if (command.join(" ") === "git branch --show-current") return ok("main");
    if (command.includes("status")) return ok();
    if (command[0] === "bun" && (command[1] === "run" || command[1] === "test")) return ok();
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("missing dry-run output directory");
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, "worker.js"),
        command.some((value) => value.includes("public-worker-proof")) ? HOST_BUNDLE : BUNDLE,
      );
      return ok();
    }
    if (command.includes("--no-bundle")) {
      uploaded = true;
      return ok();
    }
    throw new Error(`unexpected process: ${command.join(" ")}`);
  };
  const fetcher = async (url: string) => {
    if (new URL(url).pathname === FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH)
      return Response.json({
        kind: "takoserver.form-authority-core-verifier-identity@v1",
        authorityWorkerVersionId: input.coreVerifierVersion ?? CORE_VERSION,
        verifier: {
          protocol: "takoserver.takoform-core-verifier@v1",
          coreVersion: "v1.1.0",
          coreCommit: "e0e48b864de2a127a255cb0574d37bbb0f1cac29",
          artifactDigest: takoformCoreVerifierArtifactDigest(),
        },
      });
    return Response.json({
      kind: "takoserver.public-host-identity@v2",
      hostId: t.formAuthority.hostId,
      workerVersionId: HOST_VERSION,
      workerArtifactDigest: digest(HOST_BUNDLE),
      ...(await derivePublicFormImplementationIdentity({
        implementationPayloadDigest: digest("implementation"),
        capabilities: publicFormCapabilityManifest(),
      })),
    });
  };
  return { calls, state, run, fetcher, uploaded: () => uploaded };
}

async function invoke(
  h: ReturnType<typeof harness>,
  t: DeployTarget,
  action: "status" | "apply" = "status",
) {
  return runFormAuthority(
    { surface: SURFACE, environment: t.environment, action, commit: COMMIT },
    t,
    {
      state: h.state,
      run: h.run,
      fetcher: h.fetcher,
      review: "independent-review-test",
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-only-deployment-token" },
    },
  );
}

describe("released-Core existing Space operator publication", () => {
  test.each(["integration", "rehearsal", "production"] as const)(
    "seals a storage-free explicit ingress and reads exact dependencies in %s",
    async (environment) => {
      const t = target(environment);
      const config = configuration(t);
      expect(config.services).toEqual([
        {
          binding: "PUBLIC_HOST_IDENTITY",
          service: t.workerName,
          entrypoint: "PublicHostIdentityEntrypoint",
        },
        {
          binding: "FORM_AUTHORITY",
          service: t.formAuthority.workerName,
          entrypoint: "FormAuthorityEntrypoint",
        },
      ]);
      expect(Object.keys(config.vars).sort()).toEqual(
        [
          "TAKOSERVER_ENVIRONMENT",
          "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
          "TAKOSERVER_EXISTING_SPACE_OPERATOR_ORIGIN",
          "TAKOSERVER_EXISTING_SPACE_OPERATOR_PUBLIC_JWK",
          "TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY",
        ].sort(),
      );
      expect(config.vars.TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY).toBe(canonicalJson(POLICY));
      expect(config.vars.TAKOSERVER_EXISTING_SPACE_OPERATOR_PUBLIC_JWK).toBe(canonicalJson(KEY));
      expect(config.routes).toEqual([{ pattern: "operator.example.test", custom_domain: true }]);
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      for (const key of [
        "d1_databases",
        "r2_buckets",
        "containers",
        "durable_objects",
        "secrets_store_secrets",
      ])
        expect(config[key]).toBeUndefined();
      const h = harness(t);
      expect(await invoke(h, t)).toMatchObject({
        ready: true,
        authorityVersionId: CORE_VERSION,
        coreVerifierAuthorityWorkerVersionId: CORE_VERSION,
        routeMode: "authenticated-existing-space-custom-domain",
      });
      expect(h.uploaded()).toBe(false);
    },
  );

  test.each([false, true])(
    "publishes only bridge once with sealed dependency proof; first publication=%s",
    async (bridgeAbsent) => {
      const t = target();
      const h = harness(t, { bridgeAbsent });
      const result = await invoke(h, t, "apply");
      expect(result).toMatchObject({
        versionId: NEXT_VERSION,
        coreVerifierAuthorityWorkerVersionId: CORE_VERSION,
        authorityVersionId: CORE_VERSION,
      });
      const uploads = h.calls.filter((command) => command.includes("--no-bundle"));
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toContain("--containers-rollout");
    },
  );

  test.each([
    { coreAbsent: true },
    { coreCommit: "b".repeat(40) },
    { hostCommit: "b".repeat(40) },
    { coreVerifierVersion: BRIDGE_VERSION },
    {
      mutateCore: (values: Record<string, unknown>[]) => {
        values.splice(
          values.findIndex((v) => v.name === "TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY"),
          1,
        );
      },
    },
    {
      mutateCore: (values: Record<string, unknown>[]) => {
        const policy = values.find((v) => v.name === "TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY");
        if (!policy) throw new Error("missing policy fixture");
        policy.text = canonicalJson({ ...POLICY, organizationId: "org_other" });
      },
    },
  ])("status and apply refuse non-exact released authority %#", async (input) => {
    const t = target();
    const h = harness(t, input);
    expect((await invoke(h, t)).ready).toBe(false);
    await expect(invoke(h, t, "apply")).rejects.toThrow();
    expect(h.uploaded()).toBe(false);
  });

  test.each([{ coreDigest: digest("wrong") }, { driftCoreBeforeUpload: true }])(
    "refuses dependency artifact or closure drift before upload %#",
    async (input) => {
      const t = target();
      const h = harness(t, input);
      await expect(invoke(h, t, "apply")).rejects.toThrow();
      expect(h.uploaded()).toBe(false);
    },
  );

  test.each([
    { name: "STATE_DB", type: "d1", id: "foreign" },
    { name: "OBJECTS", type: "r2_bucket", bucket_name: "foreign" },
    { name: "PROVIDER_TOKEN", type: "secret_text" },
    { name: "CUSTOMER", type: "service", service: "foreign" },
  ])("refuses extra bridge closure binding $name", async (extra) => {
    const t = target();
    const h = harness(t, {
      mutateBridge: (values) => {
        values.push(extra);
      },
    });
    expect((await invoke(h, t)).ready).toBe(false);
    await expect(invoke(h, t, "apply")).rejects.toThrow();
    expect(h.uploaded()).toBe(false);
  });

  test.each([
    ["FORM_AUTHORITY", "IntegrationFormAuthorityEntrypoint"],
    ["FORM_AUTHORITY", "default"],
    ["PUBLIC_HOST_IDENTITY", "default"],
  ])("refuses the wrong named RPC entrypoint %s/%s", async (name, entrypoint) => {
    const t = target();
    const h = harness(t, {
      mutateBridge(values) {
        const binding = values.find((value) => value.name === name);
        if (!binding) throw new Error("missing service fixture");
        binding.entrypoint = entrypoint;
      },
    });
    expect((await invoke(h, t)).ready).toBe(false);
    await expect(invoke(h, t, "apply")).rejects.toThrow();
    expect(h.uploaded()).toBe(false);
  });

  test.each([
    { domainOwner: "foreign" },
    { extraDomain: true },
    { subdomain: true },
    { secret: true },
  ])("refuses unexpected ingress or secret topology %#", async (input) => {
    const t = target();
    const h = harness(t, input);
    await expect(invoke(h, t)).rejects.toThrow();
    expect(h.uploaded()).toBe(false);
  });

  test("fails missing explicit configuration before credential or provider access", async () => {
    const t = target();
    const { existingSpaceOperator: _, ...authority } = t.formAuthority;
    await expect(
      runFormAuthority(
        { surface: SURFACE, environment: "integration", action: "apply", commit: COMMIT },
        { ...t, formAuthority: authority },
        {
          run: async () => {
            throw new Error("unexpected process");
          },
        },
      ),
    ).rejects.toThrow("no complete existing Space operator");
  });
});
