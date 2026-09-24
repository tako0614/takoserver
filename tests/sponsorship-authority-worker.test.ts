import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

test("sponsorship registration handler refuses HTTP without any authority bindings", async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/entry-sponsorship-authority-worker.ts")],
    target: "browser",
    external: ["cloudflare:workers"],
  });
  expect(build.success).toBe(true);
  expect(build.outputs).toHaveLength(1);
  const artifact = build.outputs[0];
  if (!artifact) throw new Error("missing sponsorship test artifact");
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "sponsorship-registration-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: await artifact.text() },
            },
          },
          env: {},
          triggers: [],
        },
      },
    ],
  });
  try {
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      for (const path of ["/", "/issueTenantRunCredential", "/v1/sponsorship/tenants"]) {
        const response = await runtime.dispatchFetch(`https://authority.test${path}`, {
          method,
          headers: { authorization: "Bearer not-an-authority", cookie: "session=not-authority" },
          ...(method === "GET" || method === "HEAD" ? {} : { body: "not valid JSON" }),
        });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
        expect(response.headers.has("location")).toBe(false);
      }
    }
  } finally {
    await runtime.dispose();
  }
});
