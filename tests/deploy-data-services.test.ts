import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentVariables } from "../scripts/deploy/realized-config.ts";
import { loadTarget } from "../scripts/deploy/target.ts";
import { cloudflareProviderExecutorTarget } from "./helpers/hosted-supply-fixtures.ts";

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
        deliveryModes: ["embedded-binding"],
        customerAccess: "operator-only",
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

const CLOUDFLARE_PROVIDER_EXECUTOR = {
  ...cloudflareProviderExecutorTarget("cloudflare.primary"),
  managedBaseDomain: "hosted.workers.dev",
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
          objectBucketSupplies: SUPPLIES,
          edgeSupplies: EDGE_SUPPLIES,
          cloudflareProviderExecutor: CLOUDFLARE_PROVIDER_EXECUTOR,
          sponsorshipAuthority: {
            workerName: "takoserver-sponsorship-authority",
            organizationId: "org_hosted",
            credentialKeyId: "sponsorship-credential-key",
            credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "B".repeat(42) + "A" },
            receiptKeyId: "receipt-key",
            receiptPublicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
          },
        }),
      );
      const target = loadTarget(path, "production");
      const realized = deploymentVariables(target) as { vars: Record<string, string> };
      expect(JSON.parse(realized.vars.TAKOSERVER_AI_MODELS ?? "null")).toEqual([MODEL]);
      expect(realized.vars).not.toHaveProperty("CLOUDFLARE_ACCOUNT_ID");
      expect(realized.vars.TAKOSERVER_STRIPE_CHECKOUT_ENABLED).toBe("1");
      expect(JSON.parse(realized.vars.TAKOSERVER_OBJECT_BUCKET_SUPPLIES ?? "null")).toEqual(
        SUPPLIES,
      );
      expect(JSON.parse(realized.vars.TAKOSERVER_EDGE_SUPPLIES ?? "null")).toEqual(EDGE_SUPPLIES);
      expect(realized.vars.TAKOSERVER_MANAGED_BASE_DOMAIN).toBe("hosted.workers.dev");
      expect(realized.vars).not.toHaveProperty("TAKOSERVER_WORKER_ENDPOINT_SUFFIX");
      expect(realized.vars).not.toHaveProperty("TAKOSERVER_ZONES");
      expect(JSON.stringify(realized)).not.toContain("TOKEN");
      expect(JSON.stringify(realized)).not.toContain("sk_");
      expect(target.sponsorshipAuthority).toEqual({
        workerName: "takoserver-sponsorship-authority",
        organizationId: "org_hosted",
        credentialKeyId: "sponsorship-credential-key",
        credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "B".repeat(42) + "A" },
        receiptKeyId: "receipt-key",
        receiptPublicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
      });
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

  test("realizes ObjectBucket supply without any public S3 credential configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...BASE,
          objectBucketSupplies: SUPPLIES,
          cloudflareProviderExecutor: CLOUDFLARE_PROVIDER_EXECUTOR,
        }),
      );
      const realized = deploymentVariables(loadTarget(path, "production")) as {
        vars: Record<string, string>;
      };
      expect(JSON.parse(realized.vars.TAKOSERVER_OBJECT_BUCKET_SUPPLIES ?? "null")).toEqual(
        SUPPLIES,
      );
      expect(JSON.stringify(realized)).not.toMatch(/S3|R2_PARENT|ACCESS_KEY/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("will not sell edge capacity without the route-less provider executor", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(path, JSON.stringify({ ...BASE, edgeSupplies: EDGE_SUPPLIES }));
      expect(() => loadTarget(path, "production")).toThrow(
        "Cloudflare supplies and `cloudflareProviderExecutor`",
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
          cloudflareProviderExecutor: CLOUDFLARE_PROVIDER_EXECUTOR,
        }),
      );
      const target = loadTarget(path, "production");
      expect(JSON.stringify(target.edgeSupplies)).toBe(JSON.stringify(EDGE_SUPPLIES));
      expect(target.sponsorshipAuthority).toBeUndefined();
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
