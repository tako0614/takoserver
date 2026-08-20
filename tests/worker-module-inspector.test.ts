import { describe, expect, test } from "bun:test";
import { createJavaScriptWorkerModuleInspector } from "../src/takoform/worker-module-inspector.ts";

const inspector = createJavaScriptWorkerModuleInspector();

describe("Worker module inspector", () => {
  test("recognizes only exported portable Worker handlers", async () => {
    await expect(inspect(`export default { async fetch() {}, scheduled() {} };`)).resolves.toEqual({
      loadable: true,
      handlers: ["fetch", "scheduled"],
    });
    await expect(
      inspect(`const worker = { queue: async (_batch, _env) => {} }; export default worker;`),
    ).resolves.toEqual({ loadable: true, handlers: ["queue"] });
  });

  test("fails closed on invalid syntax, execution, and unsupported media", async () => {
    await expect(inspect(`export default { fetch( { }`)).resolves.toEqual({
      loadable: false,
      handlers: [],
    });
    await expect(inspect(`export default makeWorker();`)).resolves.toEqual({
      loadable: false,
      handlers: [],
    });
    await expect(inspect(`export default { fetch() {} };`, "text/plain")).resolves.toEqual({
      loadable: false,
      handlers: [],
    });
  });
});

async function inspect(source: string, mediaType = "application/javascript+module") {
  return await inspector.inspect({
    digest: `sha256:${"a".repeat(64)}`,
    mediaType,
    bytes: new TextEncoder().encode(source),
  });
}
