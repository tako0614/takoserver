import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { createProviderFormAvailability } from "../src/provider-driver.ts";
import { PROVISIONER_PATH } from "../src/providers/remote.ts";
import { createProvisionerEndpoint } from "../src/provisioner-endpoint.ts";
import {
  createStandaloneProviderComposition,
  RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
  resolveStandaloneProviderMode,
} from "../src/standalone-provider-composition.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const runtime: WorkerdRuntime = {
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return false;
  },
};

const artifacts = {
  async manifest() {
    return null;
  },
  async blob() {
    return null;
  },
};

async function compose(
  mode: ReturnType<typeof resolveStandaloneProviderMode>,
  retiredFetch?: (request: Request) => Promise<Response>,
) {
  return createStandaloneProviderComposition({
    mode,
    edge: await buildEdgeForms(),
    stableForms: stableProductionTakoformCatalog().forms,
    dataRoot: "/tmp/unused",
    runtime,
    artifacts,
    now: new Date("2026-08-25T00:00:00.000Z"),
    ...(mode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN
      ? {
          retiredCloudflare: {
            accountId: "account-for-composition-only",
            artifacts,
            authorize: () => "Bearer test-only-authority",
            apiOrigin: "https://api.cloudflare.test/client/v4",
            zones: [],
            ...(retiredFetch ? { fetch: retiredFetch } : {}),
          },
        }
      : {}),
  });
}

describe("the standalone Bun provider composition", () => {
  test("generic Cloudflare storage credentials do not switch off stable Provider3 execution", async () => {
    const withoutAccount = resolveStandaloneProviderMode({});
    const withAccount = resolveStandaloneProviderMode({
      cloudflareAccountId: "account-used-by-d1-r2-and-standard-services",
    });
    expect(withoutAccount).toBe("stable-selfhost");
    expect(withAccount).toBe(withoutAccount);

    const composition = await compose(withAccount);
    const availability = createProviderFormAvailability(composition.providers);
    const executable: string[] = [];
    for (const form of stableProductionTakoformCatalog().forms) {
      if (
        (
          await availability.resolve({
            tenantId: "tenant-a",
            principalId: "principal-a",
            form,
          })
        ).executable
      ) {
        executable.push(form.identity.formRef.kind);
      }
    }
    expect(executable.sort()).toEqual([
      "AtLeastOnceQueue",
      "EdgeKVNamespace",
      "ModuleWorker",
      "ObjectBucket",
      "QueueConsumer",
      "SQLiteDatabase",
      "SQLiteMigrationApplication",
      "SQLiteMigrationSet",
      "StaticAssetBundle",
      "WorkerBundle",
      "WorkerCronTrigger",
      "WorkerCustomDomain",
      "WorkerDeployment",
      "WorkerEndpoint",
      "WorkerVersion",
    ]);
  });

  test("the explicit retired Cloudflare drain publishes no current offering", async () => {
    const mode = resolveStandaloneProviderMode({
      retiredProviderMode: RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
      cloudflareAccountId: "account-used-only-for-the-retired-drain",
      cloudflareCredentialConfigured: true,
      provisionerCredentialConfigured: true,
    });
    const composition = await compose(mode);
    expect(composition.mode).toBe(RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN);
    expect(composition.offerings).toEqual([]);
    expect(composition.providers.flatMap((provider) => provider.offerings)).toEqual([]);
    expect(
      composition.providers
        .flatMap((provider) => provider.recoveryOfferings ?? [])
        .map((offering) => ({
          apiVersion: offering.form.apiVersion,
          kind: offering.form.kind,
        })),
    ).toEqual([
      {
        apiVersion: "edge.forms.takoform.com/v1beta1",
        kind: "ObjectBucket",
      },
    ]);
  });

  test("the retired composition exposes only authenticated observe and delete", async () => {
    const calls: Array<{ readonly method: string; readonly url: string }> = [];
    const mode = resolveStandaloneProviderMode({
      retiredProviderMode: RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
      cloudflareAccountId: "account-used-only-for-the-retired-drain",
      cloudflareCredentialConfigured: true,
      provisionerCredentialConfigured: true,
    });
    const composition = await compose(mode, async (request) => {
      calls.push({ method: request.method, url: request.url });
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: request.method === "GET" ? { name: "retired-bucket" } : {},
      });
    });
    const offering = composition.providers[0]?.recoveryOfferings?.[0];
    if (!offering) throw new Error("expected the retired ObjectBucket offering");
    const credential = "retired-drain-endpoint-credential";
    const endpoint = createProvisionerEndpoint({
      providers: composition.providers,
      credential,
      applyOfferingIds: composition.offerings.map((candidate) => candidate.id),
    });
    const invoke = async (operation: string, input: Record<string, unknown>) => {
      const response = await endpoint(
        new Request(`https://provisioner.test${PROVISIONER_PATH}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ operation, input: { offering, ...input } }),
        }),
      );
      return (await response?.json()) as {
        readonly ticket: {
          readonly phase: string;
          readonly failure?: { readonly code?: string };
        };
      };
    };
    const identity = { tenantRef: "tenant-retired", space: "default", name: "media" };

    expect(
      (await invoke("apply", { operationId: "retired-create", identity, spec: {} })).ticket,
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(
      (await invoke("adopt", { nativeId: "r2:retired-bucket", identity, spec: {} })).ticket,
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(
      (await invoke("observe", { nativeId: "r2:retired-bucket", identity, spec: {} })).ticket,
    ).toMatchObject({ phase: "succeeded" });
    expect(
      (
        await invoke("delete", {
          operationId: "retired-delete",
          nativeId: "r2:retired-bucket",
          identity,
          spec: {},
        })
      ).ticket,
    ).toMatchObject({ phase: "succeeded" });
    expect(calls).toEqual([
      {
        method: "GET",
        url: "https://api.cloudflare.test/client/v4/accounts/account-for-composition-only/r2/buckets/retired-bucket",
      },
      {
        method: "DELETE",
        url: "https://api.cloudflare.test/client/v4/accounts/account-for-composition-only/r2/buckets/retired-bucket",
      },
    ]);

    const hidden = createProvisionerEndpoint({
      providers: composition.providers,
      applyOfferingIds: [],
    });
    const hiddenResponse = await hidden(
      new Request(`https://provisioner.test${PROVISIONER_PATH}`, { method: "POST" }),
    );
    expect(hiddenResponse?.status).toBe(404);
  });

  test("invalid, implicit, and mixed recovery modes fail before composition", () => {
    expect(() => resolveStandaloneProviderMode({ retiredProviderMode: "cloudflare" })).toThrow(
      "TAKOSERVER_RETIRED_PROVIDER_MODE",
    );
    expect(() =>
      resolveStandaloneProviderMode({
        retiredProviderMode: RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
        cloudflareCredentialConfigured: true,
        provisionerCredentialConfigured: true,
      }),
    ).toThrow("CLOUDFLARE_ACCOUNT_ID");
    expect(() =>
      resolveStandaloneProviderMode({
        retiredProviderMode: RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
        cloudflareAccountId: "account-used-only-for-the-retired-drain",
        provisionerCredentialConfigured: true,
      }),
    ).toThrow("CLOUDFLARE_API_TOKEN");
    expect(() =>
      resolveStandaloneProviderMode({
        retiredProviderMode: RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
        cloudflareAccountId: "account-used-only-for-the-retired-drain",
        cloudflareCredentialConfigured: true,
      }),
    ).toThrow("TAKOSERVER_PROVISIONER_TOKEN");
    expect(() => resolveStandaloneProviderMode({ legacyEdgeForms: "0" })).toThrow(
      "TAKOSERVER_EDGE_FORMS",
    );
    expect(() => resolveStandaloneProviderMode({ cloudflareZones: "[]" })).toThrow(
      "TAKOSERVER_ZONES",
    );
    expect(() =>
      resolveStandaloneProviderMode({
        retiredProviderMode: RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
        cloudflareAccountId: "account-used-only-for-the-retired-drain",
        cloudflareCredentialConfigured: true,
        provisionerCredentialConfigured: true,
        cloudflareZones: "not-even-json",
      }),
    ).toThrow("TAKOSERVER_ZONES");
    expect(() =>
      resolveStandaloneProviderMode({
        retiredProviderMode: RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
        cloudflareAccountId: "account-used-only-for-the-retired-drain",
        cloudflareCredentialConfigured: true,
        provisionerCredentialConfigured: true,
        workerEndpointSuffix: "workers.example.test",
      }),
    ).toThrow("stable self-host provider settings");
  });
});
