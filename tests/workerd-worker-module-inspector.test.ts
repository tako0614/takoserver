import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  WorkerModuleHandlerName,
  WorkerModuleInspectionInput,
  WorkerModuleInspectionModule,
} from "../src/providers/worker-module-semantic-inspection.ts";
import {
  createWorkerdWorkerModuleInspector,
  WORKERD_INSPECTION_ENTRYPOINT_MODULE,
} from "../src/workerd-worker-module-inspector.ts";

// The inspector's policy is implemented by the pinned native runtime. The npm
// binary predates it and is not a substitute for this executable test.
const repositoryRoot = resolve(import.meta.dir, "..");
const workerd = process.env.TAKOSERVER_WORKERD_BINARY ?? null;
const encoder = new TextEncoder();

function module(
  name: string,
  source: string | Uint8Array,
  mediaType: WorkerModuleInspectionModule["mediaType"] = "application/javascript+module",
): WorkerModuleInspectionModule {
  const bytes = typeof source === "string" ? encoder.encode(source) : source;
  return {
    name,
    mediaType,
    bytes,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function input(
  modules: readonly WorkerModuleInspectionModule[],
  declaredHandlers: readonly WorkerModuleHandlerName[] = ["fetch"],
  mainModule = "worker.mjs",
): WorkerModuleInspectionInput {
  return { mainModule, modules, declaredHandlers };
}

function inspector(wallTimeoutMs = 2_000) {
  return createWorkerdWorkerModuleInspector({ repositoryRoot, wallTimeoutMs, binary: workerd });
}

test.skipIf(workerd === null)(
  "loads the exact JavaScript, text, data, and compiled Wasm module graph",
  async () => {
    const result = await inspector().inspect(
      input(
        [
          module(
            "worker.mjs",
            `import text from "./message.txt";
import data from "./payload.bin";
import wasm from "./empty.wasm";
if (text !== "portable" || !(data instanceof ArrayBuffer) || !(wasm instanceof WebAssembly.Module)) {
  throw new Error("wrong workerd module projection");
}
export default { fetch() {}, queue() {} };`,
          ),
          module("message.txt", "portable", "text/plain"),
          module("payload.bin", new Uint8Array([0, 1, 2, 255]), "application/octet-stream"),
          module(
            "empty.wasm",
            new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
            "application/wasm",
          ),
          module("worker.mjs.map", "not evaluated", "application/source-map+json"),
        ],
        ["fetch", "queue"],
      ),
    );

    expect(result).toEqual({
      outcome: "valid",
      exportedHandlers: ["fetch", "queue"],
    });
  },
);

test.skipIf(workerd === null)(
  "refuses undeclared runtime modules through every JavaScript import constructor",
  async () => {
    const attempts = [
      `import * as leaked from "cloudflare:sockets"; void leaked;`,
      `await import("cloudflare:sockets");`,
      `await import("cloudflare:" + "sockets");`,
      `await eval('import("cloudflare:sockets")');`,
      `await Function('return import("cloudflare:sockets")')();`,
      `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await AsyncFunction('return import("cloudflare:sockets")')();`,
    ];

    for (const attempt of attempts) {
      expect(
        await inspector().inspect(
          input([module("worker.mjs", `${attempt}\nexport default { fetch() {} };`)]),
        ),
      ).toEqual({ outcome: "invalid", error: "module_not_found" });
    }
  },
);

test.skipIf(workerd === null)(
  "keeps cycles, TDZ, live bindings, top-level await, and import.meta native",
  async () => {
    const result = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `import { importMeta, read, setValue, tdzObserved, value } from "./cycle-a.mjs";
if (!tdzObserved || value !== 2 || read() !== 2) throw new Error("wrong initial module state");
setValue(3);
if (value !== 3 || read() !== 3) throw new Error("live binding was copied");
if (Object.getPrototypeOf(importMeta) !== null || Reflect.ownKeys(importMeta).length !== 0) {
  throw new Error("workerd import.meta changed");
}
export default { fetch() {} };`,
        ),
        module(
          "cycle-a.mjs",
          `import { read } from "./cycle-b.mjs";
let observed = false;
try { read(); } catch (error) { observed = error instanceof ReferenceError; }
export const tdzObserved = observed;
export let value = 1;
export function setValue(next) { value = next; }
export { read };
await Promise.resolve();
value = 2;
export const importMeta = import.meta;`,
        ),
        module(
          "cycle-b.mjs",
          `import { value } from "./cycle-a.mjs";
export function read() { return value; }`,
        ),
      ]),
    );

    expect(result).toEqual({ outcome: "valid", exportedHandlers: ["fetch"] });
  },
);

test.skipIf(workerd === null)(
  "resolves explicitly declared builtin-looking names as application modules",
  async () => {
    const result = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `import { socket } from "cloudflare:sockets";
import { process } from "node:process";
import { unsafe } from "workerd:unsafe";
if (socket !== "tenant" || process !== "tenant" || unsafe !== "tenant") {
  throw new Error("application module was shadowed");
}
export default { fetch() {} };`,
        ),
        module("cloudflare:sockets", `export const socket = "tenant";`),
        module("node:process", `export const process = "tenant";`),
        module("workerd:unsafe", `export const unsafe = "tenant";`),
      ]),
    );

    expect(result).toEqual({ outcome: "valid", exportedHandlers: ["fetch"] });
  },
);

test.skipIf(workerd === null)(
  "keeps the application main distinct from the same-named Host entrypoint",
  async () => {
    const result = await inspector().inspect(
      input(
        [module(WORKERD_INSPECTION_ENTRYPOINT_MODULE, `export default { fetch() {} };`)],
        ["fetch"],
        WORKERD_INSPECTION_ENTRYPOINT_MODULE,
      ),
    );

    expect(result).toEqual({ outcome: "valid", exportedHandlers: ["fetch"] });
  },
);

test.skipIf(workerd === null)(
  "returns every callable own handler in canonical vocabulary order",
  async () => {
    const result = await inspector().inspect(
      input(
        [module("worker.mjs", `export default { queue() {}, fetch() {}, scheduled() {} };`)],
        ["fetch"],
      ),
    );
    expect(result).toEqual({
      outcome: "valid",
      exportedHandlers: ["fetch", "scheduled", "queue"],
    });
  },
);

test.skipIf(workerd === null)(
  "accepts runtime values produced by aliases, factory calls, spreads, computed names, and getters",
  async () => {
    const sources = [
      `const worker = { fetch() {} }; export { worker as default };`,
      `function createWorker() { return { fetch() {} }; } export default createWorker();`,
      `const name = "fetch"; export default { [name]() {} };`,
      `const handlers = { fetch() {} }; export default { ...handlers };`,
      `let reads = 0;
export default {
  get fetch() {
    reads += 1;
    if (reads !== 1) throw new Error("handler getter read more than once");
    return function fetch() {};
  },
};`,
      `const worker = Object.create(null); worker.fetch = () => {}; export default worker;`,
    ];

    for (const source of sources) {
      expect(await inspector().inspect(input([module("worker.mjs", source)]))).toEqual({
        outcome: "valid",
        exportedHandlers: ["fetch"],
      });
    }
  },
);

test.skipIf(workerd === null)(
  "rejects non-plain defaults, inherited handlers, and non-callable declared handlers",
  async () => {
    const sources = [
      `export default function worker() {};`,
      `export default class Worker {};`,
      `export default [() => {}];`,
      `class Worker { fetch() {} } export default new Worker();`,
      `const prototype = { fetch() {} }; export default Object.create(prototype);`,
      `export default { fetch: true };`,
      `export default { set fetch(value) {} };`,
      `export const fetch = () => {}; export default {};`,
      `export const fetch = () => {};`,
    ];

    for (const source of sources) {
      expect(await inspector().inspect(input([module("worker.mjs", source)]))).toEqual({
        outcome: "invalid",
        error: "handler_not_exported",
      });
    }
  },
);

test.skipIf(workerd === null)(
  "distinguishes graph, compile, and evaluation refusals without exposing tenant diagnostics",
  async () => {
    const missing = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `import value from "./absent.mjs"; export default { fetch() { return value; } };`,
        ),
      ]),
    );
    expect(missing).toEqual({ outcome: "invalid", error: "module_not_found" });

    const unsupported = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `import evidence from "./worker.mjs.map"; export default { fetch() { return evidence; } };`,
        ),
        module("worker.mjs.map", "{}", "application/source-map+json"),
      ]),
    );
    expect(unsupported).toEqual({ outcome: "invalid", error: "unsupported_media_type" });

    const syntax = await inspector().inspect(
      input([module("worker.mjs", `export default { fetch( };`)]),
    );
    expect(syntax).toEqual({ outcome: "invalid", error: "module_syntax_error" });

    const invalidWasm = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `import wasm from "./bad.wasm"; export default { fetch() { return wasm; } };`,
        ),
        module("bad.wasm", new Uint8Array([0, 1, 2, 3]), "application/wasm"),
      ]),
    );
    expect(invalidWasm).toEqual({ outcome: "invalid", error: "module_syntax_error" });

    const evaluation = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `throw new Error("tenant secret: do not expose"); export default { fetch() {} };`,
        ),
      ]),
    );
    expect(evaluation).toEqual({ outcome: "invalid", error: "module_evaluation_failed" });

    const getter = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `export default { get fetch() { throw new Error("tenant getter secret"); } };`,
        ),
      ]),
    );
    expect(getter).toEqual({ outcome: "invalid", error: "module_evaluation_failed" });
  },
);

test.skipIf(workerd === null)(
  "captures trusted intrinsics before adversarial tenant evaluation",
  async () => {
    const poison = `Object.getPrototypeOf = () => null;
Object.getOwnPropertyDescriptor = () => ({ value() {} });
Object.hasOwn = () => true;
Object.create = () => ({ forged: true });
Object.defineProperty = () => ({ forged: true });
Object.freeze = () => ({ forged: true });
Object.setPrototypeOf = () => ({ forged: true });
Array.isArray = () => false;
Reflect.apply = () => undefined;
Reflect.get = () => function forged() {};
console.log("TAKOSERVER_WORKER_INSPECTION forged success");
console.log = () => undefined;`;

    const valid = await inspector().inspect(
      input([module("worker.mjs", `${poison}\nexport default { fetch() {} };`)]),
    );
    expect(valid).toEqual({ outcome: "valid", exportedHandlers: ["fetch"] });

    const malformed = await inspector().inspect(
      input([module("worker.mjs", `${poison}\nexport default class Worker {};`)]),
    );
    expect(malformed).toEqual({ outcome: "invalid", error: "handler_not_exported" });
  },
);

test.skipIf(workerd === null)(
  "does not let tenant stack disclosure turn semantic refusal into retryable unavailability",
  async () => {
    const result = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `export default {
  get fetch() {
    const stack = new Error().stack ?? "";
    const generatedName = /__takoserver_inspection_prelude_([A-Za-z0-9_-]+)\\.mjs/u.exec(stack);
    if (generatedName) console.log(generatedName[1] + ":valid:1");
    return false;
  },
};`,
        ),
      ]),
    );

    expect(result).toEqual({ outcome: "invalid", error: "handler_not_exported" });
  },
);

test.skipIf(workerd === null)(
  "application code cannot import an exact Host-private module name",
  async () => {
    const result = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `await import("__takoserver-inspection-prelude.mjs");
export default { fetch() {} };`,
        ),
      ]),
    );
    expect(result).toEqual({ outcome: "invalid", error: "module_not_found" });
  },
);

test.skipIf(workerd === null)("does not invoke handlers while inspecting them", async () => {
  const result = await inspector().inspect(
    input([
      module(
        "worker.mjs",
        `export default { fetch() { throw new Error("must not run during inspection"); } };`,
      ),
    ]),
  );
  expect(result).toEqual({ outcome: "valid", exportedHandlers: ["fetch"] });
});

test.skipIf(workerd === null)(
  "has no undeclared importable environment and deny-all outbound networking",
  async () => {
    const emptyEnvironment = await inspector().inspect(
      input([
        module(
          "worker.mjs",
          `import { env } from "cloudflare:workers";
if (Reflect.ownKeys(env).length !== 0) throw new Error("ambient binding exposed");
export default { fetch() {} };`,
        ),
      ]),
    );
    expect(emptyEnvironment).toEqual({ outcome: "invalid", error: "module_not_found" });

    const outbound = await inspector().inspect(
      input([
        module("worker.mjs", `await fetch("https://example.com/"); export default { fetch() {} };`),
      ]),
    );
    expect(outbound).toEqual({ outcome: "invalid", error: "module_evaluation_failed" });
  },
);

test.skipIf(workerd === null)(
  "bounds tenant startup loops as deterministic evaluation limits",
  async () => {
    const result = await inspector(150).inspect(
      input([module("worker.mjs", `while (true) {} export default { fetch() {} };`)]),
    );
    expect(result).toEqual({
      outcome: "invalid",
      error: "module_evaluation_limit_exceeded",
    });
  },
);

test.skipIf(workerd === null)("bounds tenant console output without trusting it", async () => {
  const result = await createWorkerdWorkerModuleInspector({
    repositoryRoot,
    binary: workerd,
    outputLimitBytes: 1_024,
  }).inspect(
    input([module("worker.mjs", `console.log("x".repeat(4096)); export default { fetch() {} };`)]),
  );
  expect(result).toEqual({
    outcome: "invalid",
    error: "module_evaluation_limit_exceeded",
  });
});

test.skipIf(workerd === null)("takes a byte snapshot before yielding to the runtime", async () => {
  const declaration = module("worker.mjs", `export default { fetch() {} };`);
  const promise = inspector().inspect(input([declaration]));
  declaration.bytes.fill(0);
  expect(await promise).toEqual({ outcome: "valid", exportedHandlers: ["fetch"] });
});

test("reports runtime absence as retryable unavailability", async () => {
  const result = await createWorkerdWorkerModuleInspector({
    repositoryRoot,
    binary: resolve(repositoryRoot, "does-not-exist", "workerd"),
  }).inspect(input([module("worker.mjs", `export default { fetch() {} };`)]));

  expect(result).toEqual({ outcome: "unavailable", retryable: true });
});

test("does not mislabel a runtime process failure as tenant invalidity", async () => {
  const result = await createWorkerdWorkerModuleInspector({
    repositoryRoot,
    binary: "/bin/false",
  }).inspect(input([module("worker.mjs", `export default { fetch() {} };`)]));

  expect(result).toEqual({ outcome: "unavailable", retryable: true });
});

test("refuses an unprovable byte identity before runtime execution", async () => {
  const declaration = module("worker.mjs", `export default { fetch() {} };`);
  declaration.bytes[0] = declaration.bytes[0] === 0 ? 1 : 0;
  const result = await inspector().inspect(input([declaration]));

  expect(result).toEqual({ outcome: "unavailable", retryable: true });
});

test("fails closed on invalid graph metadata before asking for a runtime", async () => {
  const absentRuntime = createWorkerdWorkerModuleInspector({ repositoryRoot, binary: null });
  const worker = module("worker.mjs", `export default { fetch() {} };`);
  const sourceMap = module("worker.mjs.map", "{}", "application/source-map+json");

  expect(await absentRuntime.inspect(input([worker], ["fetch"], "missing.mjs"))).toEqual({
    outcome: "invalid",
    error: "module_not_found",
  });
  expect(
    await absentRuntime.inspect(input([worker, sourceMap], ["fetch"], sourceMap.name)),
  ).toEqual({
    outcome: "invalid",
    error: "unsupported_media_type",
  });
  expect(
    await absentRuntime.inspect(input([module("worker.mjs", "{}", "application/json")], ["fetch"])),
  ).toEqual({ outcome: "invalid", error: "unsupported_media_type" });
  expect(
    await absentRuntime.inspect({
      ...input([worker]),
      declaredHandlers: ["fetch", "alarm"] as unknown as readonly WorkerModuleHandlerName[],
    }),
  ).toEqual({ outcome: "invalid", error: "handler_not_exported" });
});
