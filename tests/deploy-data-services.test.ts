import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentVariables } from "../scripts/deploy/realized-config.ts";
import { loadTarget } from "../scripts/deploy/target.ts";
import { PRODUCTION_STANDARD_SERVICE_SUPPLIES_KIND } from "../src/standard-service-production.ts";

const BASE = {
  kind: "takoserver.deploy-target@v2",
  environment: "production",
  accountId: "a10162d23653f1ad1193dabf520a5dd0",
  workerName: "takoserver-api",
  d1: {
    databaseName: "takoserver-runtime",
    databaseId: "85c5a15d-a80f-42fe-a907-7ec0d86e008e",
  },
  r2: { bucketName: "takoserver-objects" },
  publicOrigin: "https://api.takoserver.com",
  signing: { currentKeyId: "takoserver-runtime-2026-08" },
};

const MODEL = {
  id: "takoserver-text",
  upstreamId: "@cf/meta/llama-3.1-8b-instruct",
  created: 1_787_054_400,
  ownedBy: "takoserver",
  maxInputTokens: 24_000,
  maxOutputTokens: 4_096,
  inputMinorPerMillionTokens: 40,
  outputMinorPerMillionTokens: 300,
};

const STANDARD_SERVICE_SUPPLIES = {
  kind: PRODUCTION_STANDARD_SERVICE_SUPPLIES_KIND,
  supplies: [
    {
      serviceRef: {
        apiVersion: "standards.takoform.com/v1",
        protocol: "com.amazonaws.s3",
      },
      backend: { kind: "cloudflare-r2", supplyNamespace: "production-primary" },
    },
  ],
};

const SUPPLIES = {
  kind: "takoserver.hosted-object-bucket-supplies@v2",
  supplies: [
    {
      offeringId: "storage.object.cloudflare",
      displayName: "Object storage",
      provider: { kind: "cloudflare" },
      providerInstallation: {
        id: "cloudflare.primary",
        providerPackRef: "cloudflare",
        supplyContractRef: "cloudflare.contract",
        state: "active",
        regions: [{ id: "global", capacity: "available" }],
      },
      supplyContract: {
        id: "cloudflare.contract",
        providerType: "cloudflare",
        permittedResourceClasses: ["storage.object", "compute.edge"],
        deliveryModes: ["native-credentials", "embedded-binding"],
        customerAccess: "scoped-native-access",
        whiteLabelAllowed: true,
        endUserTermsRequired: false,
        regions: ["global"],
        validFrom: "2026-01-01T00:00:00.000Z",
        evidenceRef: "private:cloudflare",
      },
      pricePlan: {
        id: "storage.object.cloudflare.price-v1",
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: [
          { meter: "storage.gib-hour", amountMinor: 2, quantity: 720 },
          { meter: "requests.million", amountMinor: 50 },
        ],
      },
      placement: {
        deliveryMode: "native-credentials",
        supportPolicyRef: "support:hosted:standard",
        abusePolicyRef: "abuse:hosted:standard",
        portability: {
          api: "portable",
          exportFormats: ["s3.object-set.takoform.com/v1"],
          importFormats: ["s3.object-set.takoform.com/v1"],
          migrationModes: ["offline"],
        },
        isolation: "dedicated-resource",
      },
    },
  ],
};

const EDGE_SUPPLIES = {
  kind: "takoserver.hosted-edge-supplies@v2",
  providerInstallation: SUPPLIES.supplies[0]?.providerInstallation,
  supplyContract: SUPPLIES.supplies[0]?.supplyContract,
  offerings: [
    {
      formKind: "ModuleWorker",
      offeringId: "compute.edge.cloudflare.global",
      displayName: "Edge Worker",
      pricePlan: {
        id: "compute.edge.cloudflare.global.price-v1",
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: [{ meter: "compute.worker.requests.million", amountMinor: 30 }],
      },
      placement: {
        deliveryMode: "embedded-binding",
        supportPolicyRef: "support:hosted:standard",
        abusePolicyRef: "abuse:hosted:standard",
        portability: {
          api: "portable",
          exportFormats: [],
          importFormats: [],
          migrationModes: ["offline"],
        },
        isolation: "dedicated-resource",
      },
    },
  ],
};

const RUNTIME_INPUT_SEAL_KEYRING = {
  currentKeyId: "runtime-input-2026-08",
  previousKeyIds: ["runtime-input-2026-07"],
  commitment: `sha256:${"1".repeat(64)}`,
};

describe("private data service deploy configuration", () => {
  test("realizes the exact Takos ID issuer and client without a direct upstream identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...BASE,
          takosId: { issuer: "https://id.takos.jp", clientId: "takoserver" },
        }),
      );
      const realized = deploymentVariables(loadTarget(path, "production")) as {
        vars: Record<string, string>;
      };
      expect(realized.vars).toMatchObject({
        PUBLIC_ORIGIN: "https://api.takoserver.com",
        TAKOS_ID_ISSUER: "https://id.takos.jp",
        TAKOS_ID_CLIENT_ID: "takoserver",
      });
      expect(realized.vars).not.toHaveProperty("GOOGLE_CLIENT_ID");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects two hosted identity authorities", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...BASE,
          takosId: { issuer: "https://id.takos.jp", clientId: "takoserver" },
          googleClientId: "1234-example.apps.googleusercontent.com",
        }),
      );
      expect(() => loadTarget(path, "production")).toThrow("cannot configure both");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("validates private prices and realizes no secret value", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...BASE,
          aiModels: [MODEL],
          stripeCheckout: true,
          r2ParentAccessKeyId: "parent-key",
          objectBucketSupplies: SUPPLIES,
          edgeSupplies: EDGE_SUPPLIES,
          runtimeInputSealKeyring: RUNTIME_INPUT_SEAL_KEYRING,
          workerEndpointSuffix: "hosted.workers.dev",
          sponsorship: true,
        }),
      );
      const target = loadTarget(path, "production");
      const realized = deploymentVariables(target) as { vars: Record<string, string> };
      expect(JSON.parse(realized.vars.TAKOSERVER_AI_MODELS ?? "null")).toEqual([MODEL]);
      expect(realized.vars.CLOUDFLARE_ACCOUNT_ID).toBe(BASE.accountId);
      expect(realized.vars.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID).toBe("parent-key");
      expect(realized.vars.TAKOSERVER_STRIPE_CHECKOUT_ENABLED).toBe("1");
      expect(JSON.parse(realized.vars.TAKOSERVER_OBJECT_BUCKET_SUPPLIES ?? "null")).toEqual(
        SUPPLIES,
      );
      expect(JSON.parse(realized.vars.TAKOSERVER_EDGE_SUPPLIES ?? "null")).toEqual(EDGE_SUPPLIES);
      expect(realized.vars).toMatchObject({
        TAKOSERVER_RUNTIME_INPUT_SEAL_CURRENT_KEY_ID: "runtime-input-2026-08",
        TAKOSERVER_RUNTIME_INPUT_SEAL_PREVIOUS_KEY_IDS: '["runtime-input-2026-07"]',
        TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING_COMMITMENT: RUNTIME_INPUT_SEAL_KEYRING.commitment,
      });
      expect(realized.vars.TAKOSERVER_WORKER_ENDPOINT_SUFFIX).toBe("hosted.workers.dev");
      expect(realized.vars).not.toHaveProperty("TAKOSERVER_ZONES");
      expect(JSON.stringify(realized)).not.toContain("TOKEN");
      expect(JSON.stringify(realized)).not.toContain("sk_");
      expect(target.sponsorship).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("realizes stable S3 supply without a current ObjectBucket sale", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...BASE,
          standardServiceSupplies: STANDARD_SERVICE_SUPPLIES,
        }),
      );
      const realized = deploymentVariables(loadTarget(path, "production")) as {
        vars: Record<string, string>;
      };
      expect(realized.vars.CLOUDFLARE_ACCOUNT_ID).toBe(BASE.accountId);
      expect(JSON.parse(realized.vars.TAKOSERVER_STANDARD_SERVICE_SUPPLIES ?? "null")).toEqual(
        STANDARD_SERVICE_SUPPLIES,
      );
      expect(realized.vars).not.toHaveProperty("TAKOSERVER_OBJECT_BUCKET_SUPPLIES");
      expect(realized.vars).not.toHaveProperty("TAKOSERVER_R2_PARENT_ACCESS_KEY_ID");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects an unbounded stable standard-service supply", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...BASE,
          standardServiceSupplies: {
            ...STANDARD_SERVICE_SUPPLIES,
            supplies: [
              {
                ...STANDARD_SERVICE_SUPPLIES.supplies[0],
                credential: "must-not-be-here",
              },
            ],
          },
        }),
      );
      expect(() => loadTarget(path, "production")).toThrow(
        "invalid production standard-service supplies",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps Stripe Checkout disabled unless the target names that customer surface", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(path, JSON.stringify(BASE));
      const realized = deploymentVariables(loadTarget(path, "production")) as {
        vars: Record<string, string>;
      };
      expect(realized.vars).not.toHaveProperty("TAKOSERVER_STRIPE_CHECKOUT_ENABLED");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed price configuration before a deploy can start", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(path, JSON.stringify({ ...BASE, aiModels: [{ ...MODEL, surprise: true }] }));
      expect(() => loadTarget(path, "production")).toThrow("deploy target `aiModels` is invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("will not sell a Cloudflare bucket without its ordinary S3 data plane", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(path, JSON.stringify({ ...BASE, objectBucketSupplies: SUPPLIES }));
      expect(() => loadTarget(path, "production")).toThrow("must be configured together");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("will not sell edge capacity without the exact provider endpoint suffix", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(path, JSON.stringify({ ...BASE, edgeSupplies: EDGE_SUPPLIES }));
      expect(() => loadTarget(path, "production")).toThrow(
        "edge supplies, `workerEndpointSuffix`, and `runtimeInputSealKeyring`",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps edge capacity independent from optional sponsorship", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...BASE,
          edgeSupplies: EDGE_SUPPLIES,
          runtimeInputSealKeyring: RUNTIME_INPUT_SEAL_KEYRING,
          workerEndpointSuffix: "hosted.workers.dev",
        }),
      );
      const target = loadTarget(path, "production");
      expect(JSON.stringify(target.edgeSupplies)).toBe(JSON.stringify(EDGE_SUPPLIES));
      expect(target.sponsorship).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects runtime-input seal metadata outside edge capacity and every open or unsafe descriptor", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({ ...BASE, runtimeInputSealKeyring: RUNTIME_INPUT_SEAL_KEYRING }),
      );
      expect(() => loadTarget(path, "production")).toThrow(
        "runtimeInputSealKeyring is allowed only with edge supplies",
      );

      for (const runtimeInputSealKeyring of [
        { ...RUNTIME_INPUT_SEAL_KEYRING, extra: true },
        { ...RUNTIME_INPUT_SEAL_KEYRING, previousKeyIds: ["old", "older", "oldest"] },
        { ...RUNTIME_INPUT_SEAL_KEYRING, previousKeyIds: ["runtime-input-2026-08"] },
        { ...RUNTIME_INPUT_SEAL_KEYRING, commitment: "not-a-commitment" },
      ]) {
        writeFileSync(
          path,
          JSON.stringify({
            ...BASE,
            edgeSupplies: EDGE_SUPPLIES,
            workerEndpointSuffix: "hosted.workers.dev",
            runtimeInputSealKeyring,
          }),
        );
        expect(() => loadTarget(path, "production")).toThrow(
          "deploy target `runtimeInputSealKeyring` is invalid",
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects the retired host runtime service descriptor", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...BASE,
          hostedTopology: {
            service: "retired-runtime-service",
            entrypoint: "RetiredRuntimeEntrypoint",
            token: "must-not-be-here",
          },
        }),
      );
      expect(() => loadTarget(path, "production")).toThrow("unexpected keys");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
