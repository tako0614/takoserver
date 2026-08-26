import { describe, expect, test } from "bun:test";
import { createJavaScriptWorkerModuleInspector } from "../src/takoform/worker-module-inspector.ts";

const inspector = createJavaScriptWorkerModuleInspector();

describe("Worker module inspector", () => {
  test("recognizes direct syntactic portable Worker handlers", async () => {
    await expect(inspect(`export default { async fetch() {}, scheduled() {} };`)).resolves.toEqual({
      loadable: true,
      handlers: ["fetch", "scheduled"],
    });
    await expect(
      inspect(`const worker = { queue: async (_batch, _env) => {} }; export default worker;`),
    ).resolves.toEqual({ loadable: true, handlers: ["queue"] });
    await expect(
      inspect(`
        const app = { fetch: (request) => new Response(request.url) };
        var index_default = {
          fetch: (request, env, context) => app.fetch(request, env, context),
        };
        export { index_default as default };
      `),
    ).resolves.toEqual({ loadable: true, handlers: ["fetch"] });
    await expect(
      inspect(`export class Session {}; export default { fetch() {} };`),
    ).resolves.toEqual({ loadable: true, handlers: ["fetch"], classes: ["Session"] });
  });

  test("rejects Road's legacy direct member handler", async () => {
    await expect(
      inspect(`
        var METHODS = ["get", "post", "put", "delete", "options", "patch"];
        var METHOD_NAME_ALL_LOWERCASE = "all";
        var HonoBase = class {
          fetch = (request) => new Response(request.url);
          constructor(options = {}) {
            const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
            allMethods.forEach((method) => {
              this[method] = () => this;
            });
            const { strict, ...optionsWithoutStrict } = options;
            Object.assign(this, optionsWithoutStrict);
            this.getPath = strict ?? true ? options.getPath : undefined;
          }
        };
        var Hono = class extends HonoBase {
          constructor(options = {}) {
            super(options);
            this.router = options.router ?? {};
          }
        };
        var app = new Hono();
        app.use("*", () => {});
        var index_default = { fetch: app.fetch };
        export { index_default as default };
      `),
    ).resolves.toEqual({ loadable: false, handlers: [] });

    await expect(
      inspect(`
        const app = { fetch() {}, alarm() {} };
        export default { fetch: app.fetch, alarm: app.alarm };
      `),
    ).resolves.toEqual({ loadable: false, handlers: [] });
  });

  test("fails closed on unresolved, dynamic, nonfunction, computed, and getter members", async () => {
    const refusedMembers = [
      `export default { fetch: app.fetch };`,
      `const app = makeApp(); export default { fetch: app.fetch };`,
      `const app = { fetch: 42 }; export default { fetch: app.fetch };`,
      `const app = { handlers: { fetch() {} } }; export default { fetch: app.handlers.fetch };`,
      `const app = { fetch() {} }; const key = "fetch"; export default { fetch: app[key] };`,
      `const app = { get fetch() { return () => {}; } }; export default { fetch: app.fetch };`,
      `class App { fetch = 42; } const app = new App(); export default { fetch: app.fetch };`,
      `class App { get fetch() { return () => {}; } } const app = new App(); export default { fetch: app.fetch };`,
    ];

    for (const source of refusedMembers) {
      await expect(inspect(source)).resolves.toEqual({
        loadable: false,
        handlers: [],
      });
    }
  });

  const unsafeClassMemberCases = [
    {
      name: "a computed class field precedes a callable fetch field",
      source: `
        const unknown = "not-fetch";
        class App { [unknown] = 1; fetch = () => {}; }
        const app = new App();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "an inherited class contains a computed element",
      source: `
        const unknown = "not-fetch";
        class Base { [unknown]() {}; }
        class App extends Base { fetch = () => {}; }
        const app = new App();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "a constructor overwrites fetch",
      source: `
        class App { fetch = () => {}; constructor() { this.fetch = 42; } }
        const app = new App();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "an inherited constructor overwrites fetch",
      source: `
        class Base { fetch = () => {}; constructor() { this.fetch = 42; } }
        class App extends Base {}
        const app = new App();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "a constructor uses a computed fetch write",
      source: `
        class App { fetch = () => {}; constructor() { this["fetch"] = 42; } }
        const app = new App();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "a constructor replaces the instance",
      source: `
        class App { fetch = () => {}; constructor() { return { fetch: 42 }; } }
        const app = new App();
        export default { fetch: app.fetch };
      `,
    },
  ] as const;

  for (const unsafeCase of unsafeClassMemberCases) {
    test(`fails closed when ${unsafeCase.name}`, async () => {
      await expect(inspect(unsafeCase.source)).resolves.toEqual({
        loadable: false,
        handlers: [],
      });
    });
  }

  const unsafeBindingCases = [
    {
      name: "the constructed instance binding is reassigned",
      source: `
        class App { fetch = () => {}; }
        let app = new App();
        app = { fetch: 42 };
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "the constructed instance binding is reassigned after export",
      source: `
        class App { fetch = () => {}; }
        let app = new App();
        export default { fetch: app.fetch };
        app = { fetch: 42 };
      `,
    },
    {
      name: "the constructed instance member is overwritten",
      source: `
        class App { fetch = () => {}; }
        const app = new App();
        app.fetch = 42;
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "a computed instance member is overwritten",
      source: `
        class App { fetch = () => {}; }
        const app = new App();
        const key = "fetch";
        app[key] = 42;
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "an alias overwrites the constructed instance member",
      source: `
        class App { fetch = () => {}; }
        const app = new App();
        const alias = app;
        alias.fetch = 42;
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "a duplicated var binding makes the instance ambiguous",
      source: `
        class App { fetch = () => {}; }
        var app = new App();
        var app = new App();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "duplicate callable var declarations make the handler ambiguous",
      source: `
        var handler = () => {};
        var handler = () => {};
        export default { fetch: handler };
      `,
    },
    {
      name: "class aliases form a cycle",
      source: `
        var App = Alias;
        var Alias = App;
        const app = new App();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "instance aliases form a cycle",
      source: `
        var app = alias;
        var alias = app;
        export default { fetch: app.fetch };
      `,
    },
  ] as const;

  for (const unsafeCase of unsafeBindingCases) {
    test(`fails closed when ${unsafeCase.name}`, async () => {
      await expect(inspect(unsafeCase.source)).resolves.toEqual({
        loadable: false,
        handlers: [],
      });
    });
  }

  const unsafeEffectCases = [
    {
      name: "an instance method call overwrites its fetch member",
      source: `
        class App {
          fetch = () => {};
          breakIt() { this.fetch = 42; }
        }
        const app = new App();
        app.breakIt();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "a function call receives the instance and overwrites its fetch member",
      source: `
        class App { fetch = () => {}; }
        function breakIt(target) { target.fetch = 42; }
        const app = new App();
        breakIt(app);
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "a closure call overwrites the instance fetch member",
      source: `
        class App { fetch = () => {}; }
        const app = new App();
        function breakIt() { app.fetch = 42; }
        breakIt();
        export default { fetch: app.fetch };
      `,
    },
    {
      name: "a constructor writes fetch through a late alias of this",
      source: `
        class App {
          fetch = () => {};
          constructor() {
            let alias;
            alias = this;
            alias.fetch = 42;
          }
        }
        const app = new App();
        export default { fetch: app.fetch };
      `,
    },
  ] as const;

  for (const unsafeCase of unsafeEffectCases) {
    test(`fails closed when ${unsafeCase.name}`, async () => {
      await expect(inspect(unsafeCase.source)).resolves.toEqual({
        loadable: false,
        handlers: [],
      });
    });
  }

  test("rejects every indirect handler and default-object shape", async () => {
    const refusedIndirectShapes = [
      `const handler = () => {}; export default { fetch: handler };`,
      `function handler() {}; export default { fetch: handler };`,
      `export default { fetch: makeHandler() };`,
      `function createWorker() { return { fetch() {} }; } export default createWorker();`,
      `const worker = { fetch() {} }; const alias = worker; export default alias;`,
      `const worker = { fetch() {} }; sideEffect(); export default worker;`,
      `const worker = { fetch() {} }; export default worker; sideEffect();`,
      `var worker = { fetch() {} }; var worker = { fetch() {} }; export default worker;`,
      `export default { ["fetch"]() {} };`,
      `export default { get fetch() { return () => {}; } };`,
      `export default { ...{ fetch() {} } };`,
      `export default { fetch() {}, fetch: () => {} };`,
    ];

    for (const source of refusedIndirectShapes) {
      await expect(inspect(source)).resolves.toEqual({ loadable: false, handlers: [] });
    }
  });

  test("rejects a 20,000-link export alias chain within the inspection budget", async () => {
    const declarations = [`const worker0 = { fetch() {} };`];
    for (let index = 1; index <= 20_000; index += 1) {
      declarations.push(`const worker${index} = worker${index - 1};`);
    }
    declarations.push(`export default worker20000;`);

    await expect(inspect(declarations.join("\n"))).resolves.toEqual({
      loadable: false,
      handlers: [],
    });
  }, 4_000);

  test("honors the advertised 10 MiB module byte boundary", async () => {
    const directWorker = `export default { fetch() {} };`;
    const moduleAtLimit = `${directWorker}${" ".repeat(10_485_760 - directWorker.length)}`;
    await expect(inspect(moduleAtLimit)).resolves.toEqual({
      loadable: true,
      handlers: ["fetch"],
    });
    await expect(inspect(`${moduleAtLimit} `)).resolves.toEqual({
      loadable: false,
      handlers: [],
    });
  });

  test("fails closed on the AST depth bound", async () => {
    const nested = `${"[".repeat(140)}0${"]".repeat(140)}`;
    await expect(inspect(`export default { fetch: () => ${nested} };`)).resolves.toEqual({
      loadable: false,
      handlers: [],
    });
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
    await expect(
      inspect(
        `function makeWorker() { sideEffect(); return { fetch() {} }; } export default makeWorker();`,
      ),
    ).resolves.toEqual({ loadable: false, handlers: [] });
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
