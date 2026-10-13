import { createWorkerEntry, type WorkerEnv } from "../../src/entry-worker.ts";
import type { V2ArtifactSource } from "../../src/takoform-v2/forms/artifact-source.ts";
import { createV2PublicHttpsArtifactSource } from "../../src/takoform-v2/forms/public-https-artifact-source.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../../src/takoform-v2/forms/static-asset-bundle.ts";

type FixtureEnv = WorkerEnv & {
  readonly TEST_ARTIFACT_PAYLOADS?: string;
  readonly TEST_ARTIFACT_HOOK_FAULT?: string;
};

const selected = createWorkerEntry({
  // Both code-selected hooks may coexist; this fixture adds no private Forms.
  composeV2Forms: () => ({}),
  composeV2ArtifactSource: ({ env, formUrl }) => {
    if (formUrl !== STATIC_ASSET_BUNDLE_FORM_URL) {
      throw new Error("artifact source hook received an unexpected Form");
    }
    const fixture = env as FixtureEnv;
    if (fixture.TEST_ARTIFACT_HOOK_FAULT === "throw") {
      throw new TypeError("private transport credential must not appear in a response");
    }
    if (fixture.TEST_ARTIFACT_HOOK_FAULT === "invalid") {
      return {} as V2ArtifactSource;
    }
    const payloads = JSON.parse(fixture.TEST_ARTIFACT_PAYLOADS ?? "{}") as Record<string, string>;
    return createV2PublicHttpsArtifactSource({
      async fetchPublic(request) {
        const payload = payloads[request.url];
        return payload === undefined ? new Response(null, { status: 404 }) : new Response(payload);
      },
    });
  },
});

/** Test-only transport, with the production Worker entry and scheduled drain. */
export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    context: { waitUntil(work: Promise<unknown>): void },
  ): Promise<Response> {
    const local = new URL(request.url);
    if (local.pathname === "/__test/run-scheduled") {
      await selected.scheduled({}, env);
      return new Response(null, { status: 204 });
    }
    const canonical = new URL(`${local.pathname}${local.search}`, env.PUBLIC_ORIGIN);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    return selected.fetch(
      new Request(canonical, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      }),
      env,
      context,
    );
  },
};
