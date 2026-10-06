import { expect, test } from "bun:test";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  validateModuleWorkerUpdate,
  validateWorkerDeploymentUpdate,
  validateWorkerEndpointUpdate,
  validateWorkerVersionUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
  WorkerFormValidationError,
} from "../src/takoform-v2/forms/worker-specs.ts";

function expectInvalid(action: () => unknown): void {
  expect(action).toThrow(WorkerFormValidationError);
}

test("ModuleWorker has only the empty spec and accepts only its unchanged update", () => {
  expect(MODULE_WORKER_FORM_URL).toBe("https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/");
  expect(WORKER_VERSION_FORM_URL).toBe(
    "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/",
  );
  expect(WORKER_DEPLOYMENT_FORM_URL).toBe(
    "https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/",
  );
  expect(WORKER_ENDPOINT_FORM_URL).toBe(
    "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/",
  );
  expect(parseModuleWorkerSpec({})).toEqual({});
  expect(validateModuleWorkerUpdate({}, {})).toEqual({});
  for (const invalid of [null, [], { name: "worker" }, { extra: undefined }]) {
    expectInvalid(() => parseModuleWorkerSpec(invalid));
  }
  expectInvalid(() => validateModuleWorkerUpdate({}, { runtime: "module" }));
});

test("WorkerDeployment validates references and weights, then normalizes version order", () => {
  const spec = {
    versions: [
      { weight: 4_000, workerVersion: { resourceUid: "version-b" } },
      { weight: 6_000, workerVersion: { resourceUid: "version-a" } },
    ],
    worker: { resourceUid: "worker-a" },
  };
  expect(parseWorkerDeploymentSpec(spec)).toEqual({
    worker: { resourceUid: "worker-a" },
    versions: [
      { workerVersion: { resourceUid: "version-a" }, weight: 6_000 },
      { workerVersion: { resourceUid: "version-b" }, weight: 4_000 },
    ],
  });
  expect(
    validateWorkerDeploymentUpdate(spec, {
      worker: { resourceUid: "worker-a" },
      versions: [
        { workerVersion: { resourceUid: "version-a" }, weight: 6_000 },
        { workerVersion: { resourceUid: "version-b" }, weight: 4_000 },
      ],
    }),
  ).toEqual(parseWorkerDeploymentSpec(spec));
  expect(
    validateWorkerDeploymentUpdate(spec, {
      worker: { resourceUid: "worker-a" },
      versions: [
        { workerVersion: { resourceUid: "version-a" }, weight: 5_000 },
        { workerVersion: { resourceUid: "version-b" }, weight: 5_000 },
      ],
    }).versions,
  ).toEqual([
    { workerVersion: { resourceUid: "version-a" }, weight: 5_000 },
    { workerVersion: { resourceUid: "version-b" }, weight: 5_000 },
  ]);

  for (const invalid of [
    { ...spec, extra: true },
    { worker: { resourceUid: "worker-a", name: "alias" }, versions: spec.versions },
    { worker: { resourceUid: "worker-a" }, versions: [] },
    {
      worker: { resourceUid: "worker-a" },
      versions: [
        { workerVersion: { resourceUid: "version-a" }, weight: 9_999 },
        { workerVersion: { resourceUid: "version-b" }, weight: 2 },
      ],
    },
    {
      worker: { resourceUid: "worker-a" },
      versions: [
        { workerVersion: { resourceUid: "version-a" }, weight: 5_000 },
        { workerVersion: { resourceUid: "version-a" }, weight: 5_000 },
      ],
    },
    {
      worker: { resourceUid: "worker-a" },
      versions: [{ workerVersion: { resourceUid: "version-a" }, weight: 10_000.5 }],
    },
  ]) {
    expectInvalid(() => parseWorkerDeploymentSpec(invalid));
  }
  expectInvalid(() =>
    validateWorkerDeploymentUpdate(spec, { ...spec, worker: { resourceUid: "worker-b" } }),
  );
});

test("WorkerEndpoint fixes its exact worker reference for the attachment lifetime", () => {
  const spec = { worker: { resourceUid: "worker-a" } };
  expect(parseWorkerEndpointSpec(spec)).toEqual(spec);
  expect(validateWorkerEndpointUpdate(spec, { worker: { resourceUid: "worker-a" } })).toEqual(spec);
  for (const invalid of [
    null,
    { worker: { resourceUid: "" } },
    { worker: { resourceUid: "worker-a", name: "other" } },
    { worker: { resourceUid: "worker-a" }, extra: false },
  ]) {
    expectInvalid(() => parseWorkerEndpointSpec(invalid));
  }
  expectInvalid(() => validateWorkerEndpointUpdate(spec, { worker: { resourceUid: "worker-b" } }));
});

test("WorkerVersion expands defaults and normalizes unordered declaration sets", () => {
  const input = {
    worker: { resourceUid: "worker-a" },
    bundle: { resourceUid: "bundle-a" },
    handlers: ["queue", "fetch"],
    vars: { ZED: [true, { INNER: "😀" }], ALPHA: -0 },
    requiredSensitiveVars: ["TOKEN_Z", "TOKEN_A"],
    kvBindings: [
      { name: "ZStore", resource: { resourceUid: "kv-z" } },
      { name: "AStore", resource: { resourceUid: "kv-a" } },
    ],
    sqliteBindings: [{ name: "Database", resource: { resourceUid: "db-a" } }],
    bucketBindings: [{ name: "Bucket", resource: { resourceUid: "bucket-a" } }],
    queueProducerBindings: [{ name: "Queue", resource: { resourceUid: "queue-a" } }],
    serviceBindings: [{ name: "Service", resource: { resourceUid: "service-a" } }],
    actorBindings: [{ name: "Actor", resource: { resourceUid: "actor-a" } }],
    workflowBindings: [{ name: "Workflow", resource: { resourceUid: "workflow-a" } }],
    assets: {
      bundle: { resourceUid: "assets-a" },
      runWorkerFirst: true,
      notFoundHandling: "single_page_application",
    },
  };
  expect(parseWorkerVersionSpec(input)).toEqual({
    worker: { resourceUid: "worker-a" },
    bundle: { resourceUid: "bundle-a" },
    handlers: ["fetch", "queue"],
    vars: { ALPHA: 0, ZED: [true, { INNER: "😀" }] },
    requiredSensitiveVars: ["TOKEN_A", "TOKEN_Z"],
    kvBindings: [
      { name: "AStore", resource: { resourceUid: "kv-a" } },
      { name: "ZStore", resource: { resourceUid: "kv-z" } },
    ],
    sqliteBindings: [{ name: "Database", resource: { resourceUid: "db-a" } }],
    bucketBindings: [{ name: "Bucket", resource: { resourceUid: "bucket-a" } }],
    queueProducerBindings: [{ name: "Queue", resource: { resourceUid: "queue-a" } }],
    serviceBindings: [{ name: "Service", resource: { resourceUid: "service-a" } }],
    actorBindings: [{ name: "Actor", resource: { resourceUid: "actor-a" } }],
    workflowBindings: [{ name: "Workflow", resource: { resourceUid: "workflow-a" } }],
    assets: {
      bundle: { resourceUid: "assets-a" },
      runWorkerFirst: true,
      notFoundHandling: "single_page_application",
    },
  });

  const reordered = {
    ...input,
    handlers: ["fetch", "queue"],
    vars: { ALPHA: 0, ZED: [true, { INNER: "😀" }] },
    requiredSensitiveVars: ["TOKEN_A", "TOKEN_Z"],
    kvBindings: [...input.kvBindings].reverse(),
  };
  expect(validateWorkerVersionUpdate(input, reordered)).toEqual(parseWorkerVersionSpec(input));
});

test("WorkerVersion validates its complete closed shape and static-only composition", () => {
  const moduleSpec = {
    worker: { resourceUid: "worker-a" },
    bundle: { resourceUid: "bundle-a" },
    handlers: [],
  };
  const parsed = parseWorkerVersionSpec(moduleSpec);
  expect(parsed).toMatchObject({
    handlers: [],
    vars: {},
    requiredSensitiveVars: [],
    kvBindings: [],
    sqliteBindings: [],
    bucketBindings: [],
    queueProducerBindings: [],
    serviceBindings: [],
    actorBindings: [],
    workflowBindings: [],
  });
  expect(validateWorkerVersionUpdate(moduleSpec, parsed)).toEqual(parsed);
  expectInvalid(() =>
    validateWorkerVersionUpdate(moduleSpec, { ...moduleSpec, bundle: { resourceUid: "bundle-b" } }),
  );

  const staticSpec = {
    worker: { resourceUid: "worker-a" },
    handlers: [],
    assets: {
      bundle: { resourceUid: "assets-a" },
      runWorkerFirst: false,
      notFoundHandling: "none",
    },
  };
  expect(parseWorkerVersionSpec(staticSpec)).toMatchObject({
    worker: staticSpec.worker,
    handlers: [],
    assets: staticSpec.assets,
  });

  const badVersions: unknown[] = [
    null,
    { ...moduleSpec, extra: true },
    { worker: moduleSpec.worker, bundle: moduleSpec.bundle },
    { worker: moduleSpec.worker, handlers: [] },
    { ...moduleSpec, handlers: ["fetch", "fetch"] },
    { ...moduleSpec, handlers: ["alarm"] },
    { ...moduleSpec, vars: null },
    { ...moduleSpec, assets: { ...staticSpec.assets, unknown: true } },
    {
      ...moduleSpec,
      handlers: ["queue"],
      assets: { ...staticSpec.assets, runWorkerFirst: true },
    },
    { ...moduleSpec, handlers: [], assets: { ...staticSpec.assets, runWorkerFirst: true } },
    { ...moduleSpec, requiredSensitiveVars: ["lowercase"] },
    { ...moduleSpec, kvBindings: [{ name: "not-valid", resource: { resourceUid: "kv-a" } }] },
    {
      ...moduleSpec,
      kvBindings: [{ name: "Same", resource: { resourceUid: "kv-a" } }],
      sqliteBindings: [{ name: "Same", resource: { resourceUid: "db-a" } }],
    },
    { ...moduleSpec, vars: { Same: "x" }, requiredSensitiveVars: ["Same"] },
    {
      ...moduleSpec,
      vars: { Same: "x" },
      kvBindings: [{ name: "Same", resource: { resourceUid: "kv-a" } }],
    },
    { worker: moduleSpec.worker, handlers: [], assets: staticSpec.assets, vars: { FLAG: true } },
    {
      worker: moduleSpec.worker,
      handlers: [],
      assets: { ...staticSpec.assets, runWorkerFirst: true },
    },
    { worker: moduleSpec.worker, handlers: ["fetch"], assets: staticSpec.assets },
    {
      worker: moduleSpec.worker,
      handlers: [],
      assets: staticSpec.assets,
      serviceBindings: [{ name: "Service", resource: { resourceUid: "service-a" } }],
    },
  ];
  for (const invalid of badVersions) expectInvalid(() => parseWorkerVersionSpec(invalid));
});

test("WorkerVersion vars bound finite JSON, nesting, object keys and Unicode scalar strings", () => {
  const base = {
    worker: { resourceUid: "worker-a" },
    bundle: { resourceUid: "bundle-a" },
    handlers: [],
  };
  const valueWithEightLevels: unknown = {
    LEVEL: {
      LEVEL: {
        LEVEL: {
          LEVEL: {
            LEVEL: {
              LEVEL: {
                LEVEL: {
                  LEVEL: "ok",
                },
              },
            },
          },
        },
      },
    },
  };
  expect(parseWorkerVersionSpec({ ...base, vars: { VALID: valueWithEightLevels } })).toBeDefined();

  const tooDeep: unknown = { LEVEL: valueWithEightLevels };
  const tooManyItems = Array.from({ length: 65 }, (_, index) => index);
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    tooManyItems,
    { LEVEL: tooManyItems },
    { _notAVarsKey: true },
    "😀".repeat(8_193),
    "\ud800",
  ]) {
    expectInvalid(() => parseWorkerVersionSpec({ ...base, vars: { VALID: value } }));
  }
  expectInvalid(() => parseWorkerVersionSpec({ ...base, vars: { VALID: tooDeep } }));
  expect(parseWorkerVersionSpec({ ...base, vars: { VALID: "😀".repeat(8_192) } })).toBeDefined();
  expectInvalid(() =>
    parseWorkerVersionSpec({
      ...base,
      vars: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`V${index}`, true])),
    }),
  );
  expectInvalid(() => parseWorkerVersionSpec({ ...base, vars: { VALID: new Date() } }));
  const cyclic: { readonly [key: string]: unknown } = { self: {} };
  (cyclic.self as Record<string, unknown>).self = cyclic;
  expectInvalid(() => parseWorkerVersionSpec({ ...base, vars: { VALID: cyclic } }));
  expectInvalid(() => parseWorkerVersionSpec({ ...base, vars: { VALID: undefined } }));
});

test("WorkerVersion applies each declared collection bound and one env-name collision domain", () => {
  const base = {
    worker: { resourceUid: "worker-a" },
    bundle: { resourceUid: "bundle-a" },
    handlers: [],
  };
  const maxBindings = Array.from({ length: 64 }, (_, index) => ({
    name: `B${index}`,
    resource: { resourceUid: `kv-${index}` },
  }));
  expect(parseWorkerVersionSpec({ ...base, kvBindings: maxBindings }).kvBindings).toHaveLength(64);
  expectInvalid(() =>
    parseWorkerVersionSpec({
      ...base,
      kvBindings: [...maxBindings, { name: "B64", resource: { resourceUid: "kv-64" } }],
    }),
  );

  const sensitive = Array.from({ length: 64 }, (_, index) => `SECRET_${index}`);
  expect(
    parseWorkerVersionSpec({ ...base, requiredSensitiveVars: sensitive }).requiredSensitiveVars,
  ).toHaveLength(64);
  expectInvalid(() =>
    parseWorkerVersionSpec({ ...base, requiredSensitiveVars: [...sensitive, "SECRET_64"] }),
  );
  expectInvalid(() =>
    parseWorkerVersionSpec({
      ...base,
      vars: { READABLE: true },
      kvBindings: [{ name: "READABLE", resource: { resourceUid: "kv-1" } }],
    }),
  );
  expectInvalid(() =>
    parseWorkerVersionSpec({
      ...base,
      vars: { SECRET_A: true },
      requiredSensitiveVars: ["SECRET_A"],
    }),
  );
  expectInvalid(() =>
    parseWorkerVersionSpec({ ...base, requiredSensitiveVars: ["SECRET_A", "SECRET_A"] }),
  );
});
