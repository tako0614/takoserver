import { describe, expect, mock, test } from "bun:test";
import {
  type FormAuthorityCoreVerifierReadbackExpectation,
  readFormAuthorityCoreVerifierIdentityProbe,
} from "../scripts/deploy/form-authority.ts";
import {
  FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND,
  FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH,
  type FormAuthorityCoreVerifierIdentity,
  handleFormAuthorityIdentityProbe,
} from "../src/form-authority-identity-probe.ts";
import {
  TAKOFORM_CORE_COMMIT,
  TAKOFORM_CORE_VERIFIER_PROTOCOL,
  TAKOFORM_CORE_VERSION,
} from "../src/takoform/form-authority-verification.ts";

const PROBE_ORIGIN = "https://form-authority-identity.example.workers.dev";
const AUTHORITY_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const STALE_AUTHORITY_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}` as const;
const STALE_ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}` as const;

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

const exactIdentity = {
  kind: FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND,
  authorityWorkerVersionId: AUTHORITY_VERSION_ID,
  verifier: {
    protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
    coreVersion: TAKOFORM_CORE_VERSION,
    coreCommit: TAKOFORM_CORE_COMMIT,
    artifactDigest: ARTIFACT_DIGEST,
  },
} satisfies FormAuthorityCoreVerifierIdentity;

const expectation = {
  probeOrigin: PROBE_ORIGIN,
  authorityWorkerVersionId: AUTHORITY_VERSION_ID,
  artifactDigest: ARTIFACT_DIGEST,
} satisfies FormAuthorityCoreVerifierReadbackExpectation;

describe("Form authority released-Core verifier identity readback", () => {
  test("the named RPC starts and interrogates the Container under its own Worker Version", async () => {
    const authorityEntrySpecifier = "../src/entry-form-authority-worker.ts";
    const { FormAuthorityEntrypoint } = (await import(authorityEntrySpecifier)) as {
      readonly FormAuthorityEntrypoint: {
        readonly prototype: { readonly verifierIdentity: unknown };
      };
    };
    const containerNames: string[] = [];
    const requests: Request[] = [];
    const id = { toString: () => "opaque", equals: () => true };
    const verifierIdentity = FormAuthorityEntrypoint.prototype
      .verifierIdentity as unknown as (this: {
      readonly env: Record<string, unknown>;
    }) => Promise<FormAuthorityCoreVerifierIdentity>;
    const identity = await verifierIdentity.call({
      env: {
        WORKER_VERSION: { id: AUTHORITY_VERSION_ID },
        TAKOSERVER_ENVIRONMENT: "production",
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: "https://api.example.test",
        TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
        CORE_VERIFIER: {
          idFromName(name: string) {
            containerNames.push(name);
            return id;
          },
          get() {
            return {
              async fetch(input: RequestInfo | URL, init?: RequestInit) {
                requests.push(new Request(input, init));
                return Response.json(exactIdentity.verifier);
              },
            };
          },
        },
      },
    });

    expect(identity).toEqual(exactIdentity);
    expect(containerNames).toEqual(["production:https://api.example.test"]);
    expect(requests.map((request) => request.url)).toEqual([
      "http://takoform-core-verifier/v1/identity",
    ]);
  });

  test("the permanent probe exposes only the exact named-RPC identity", async () => {
    let calls = 0;
    const response = await handleFormAuthorityIdentityProbe(
      new Request(`${PROBE_ORIGIN}${FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH}`),
      {
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: "https://api.example.test",
        PUBLIC_HOST_IDENTITY: {
          async identity(): Promise<never> {
            throw new Error("unexpected");
          },
        },
        FORM_AUTHORITY: {
          async verifierIdentity() {
            calls += 1;
            return structuredClone(exactIdentity);
          },
        },
      },
    );

    expect(calls).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(exactIdentity);
  });

  test("the permanent probe fails closed without leaking RPC or Container failures", async () => {
    const response = await handleFormAuthorityIdentityProbe(
      new Request(`${PROBE_ORIGIN}${FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH}`),
      {
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: "https://api.example.test",
        PUBLIC_HOST_IDENTITY: {
          async identity(): Promise<never> {
            throw new Error("unexpected");
          },
        },
        FORM_AUTHORITY: {
          async verifierIdentity(): Promise<never> {
            throw new Error("container provider detail must not escape");
          },
        },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "verifier_unavailable" } });
  });

  test("deploy readback accepts only the exact authority Worker Version and image artifact", async () => {
    const requests: Request[] = [];
    const accepted = await readFormAuthorityCoreVerifierIdentityProbe(
      expectation,
      async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(exactIdentity);
      },
    );
    expect(accepted).toEqual({ ready: true, identity: exactIdentity });
    expect(requests[0]?.url).toBe(`${PROBE_ORIGIN}${FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH}`);
    expect(requests[0]?.headers.get("cache-control")).toBe("no-store");

    for (const identity of [
      { ...exactIdentity, authorityWorkerVersionId: STALE_AUTHORITY_VERSION_ID },
      {
        ...exactIdentity,
        verifier: { ...exactIdentity.verifier, artifactDigest: STALE_ARTIFACT_DIGEST },
      },
      { ...exactIdentity, unexpected: true },
    ]) {
      const refused = await readFormAuthorityCoreVerifierIdentityProbe(expectation, async () =>
        Response.json(identity),
      );
      expect(refused).toEqual({ ready: false, identity: null });
    }
  });
});
