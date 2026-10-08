import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import { SELFHOST_WORKER_DATA_SERVICE_MODULE } from "../src/providers/selfhost-data-service.ts";
import { SELFHOST_WORKER_DATA_TOKEN_BINDING } from "../src/providers/selfhost-worker-wrapper.ts";
import {
  WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING,
  WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
  WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
  workerdV2PrivateActorBindingName,
  workerdV2PrivateWorkflowBindingName,
} from "../src/providers/workerd-v2-private-binding-names.ts";
import { type WorkerdSite, writeWorkerdPrivateExecution } from "../src/workerd-runtime.ts";

const encoder = new TextEncoder();
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const token = "a".repeat(64);
const namespaceResourceUid = "uid-ActorNamespace-target";
const httpService = workerdV2PrivateActorBindingName("HTTP", 0);
const upgradeService = workerdV2PrivateActorBindingName("UPGRADE", 0);

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(withBinding = true) {
  const root = mkdtempSync(join(tmpdir(), "acfg-"));
  const brokerRoot = mkdtempSync(join(tmpdir(), "ab-"));
  roots.push(root, brokerRoot);
  chmodSync(brokerRoot, 0o700);
  const httpSocketPath = join(brokerRoot, "http.sock");
  const upgradeSocketPath = join(brokerRoot, "upgrade.sock");
  for (const path of [httpSocketPath, upgradeSocketPath]) {
    servers.push(Bun.serve({ unix: path, fetch: () => new Response(null, { status: 204 }) }));
  }
  const mainModule = "index.mjs";
  const hostEntrypoint = "__actor-entry.mjs";
  const ownerModule = "__owner.mjs";
  const site: WorkerdSite = {
    directory: "actor",
    mainModule,
    hostEntrypoint,
    hostModules: withBinding ? [WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE] : [],
    hostnames: [],
    ...(withBinding
      ? {
          actorForward: {
            schema: "takoserver.selfhost-actor-forward@v1" as const,
            bindings: [
              {
                publicName: "TARGET",
                tenantId: "tenant-1",
                namespaceResourceUid,
                httpService,
                upgradeService,
                token,
                runtimeClassRef: ACTOR_ABI_INTERFACE_REFS.v2,
              },
            ],
          },
        }
      : {}),
  };
  const modules = new Map([[mainModule, encoder.encode("export default {};")]]);
  const hostModules = new Map(
    [
      hostEntrypoint,
      ...(withBinding ? [WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE] : []),
      ownerModule,
    ].map((name) => [name, encoder.encode("export default {};")]),
  );
  const variantHostModules = new Map([...hostModules].filter(([name]) => name !== ownerModule));
  const actorForwardSockets = [
    { tenantId: "tenant-1", namespaceResourceUid, token, httpSocketPath, upgradeSocketPath },
  ];
  return {
    root,
    site: { ...site, hostModules: [...(site.hostModules ?? []), ownerModule] },
    modules,
    hostModules,
    actorForwardSockets,
    runSocketPath: join(root, "run.sock"),
    actorProxySocketPath: join(root, "duplex.sock"),
    actor: {
      namespaceKey: "b".repeat(64),
      storagePath: join(root, "storage"),
      ownerModule,
      className: "ActorOwner",
      alarmAdmissionAddress: "127.0.0.1:17777",
      variants: [
        {
          site,
          modules,
          hostModules: variantHostModules,
          className: "TargetActor",
          actorForwardSockets,
        },
      ],
    },
  };
}

test("v2 Actor class gets only its Version's exact private forward broker", async () => {
  const input = fixture();
  const config = await readFile(await writeWorkerdPrivateExecution(input), "utf8");
  expect(config).toContain(`(name = "${httpService}", service = "actor-version-0-forward-http-0")`);
  expect(config).toContain(
    `(name = "${upgradeService}", service = "actor-version-0-forward-upgrade-0")`,
  );
  expect(config).toContain(`unix:${input.actorForwardSockets[0]?.httpSocketPath}`);
  expect(config).toContain(`unix:${input.actorForwardSockets[0]?.upgradeSocketPath}`);
  expect(config).not.toContain('name = "router"');
});

test("two weighted class Versions may reuse the same exact broker, not an aliased grant", async () => {
  const shared = fixture();
  const first = shared.actor.variants[0];
  const socket = shared.actorForwardSockets[0];
  if (!first || !socket || !first.site.actorForward) throw new Error("Actor fixture unavailable");
  const config = await readFile(
    await writeWorkerdPrivateExecution({
      ...shared,
      actor: { ...shared.actor, variants: [first, { ...first }] },
    }),
    "utf8",
  );
  expect(config).toContain('name = "actor-version-1-forward-http-0"');
  expect(config).toContain('name = "actor-version-1-forward-upgrade-0"');

  const aliased = fixture();
  const aliasedFirst = aliased.actor.variants[0];
  const aliasedSocket = aliased.actorForwardSockets[0];
  const aliasedBinding = aliasedFirst?.site.actorForward?.bindings[0];
  if (!aliasedFirst || !aliasedSocket || !aliasedFirst.site.actorForward || !aliasedBinding)
    throw new Error("Actor fixture unavailable");
  const secondToken = "c".repeat(64);
  await expect(
    writeWorkerdPrivateExecution({
      ...aliased,
      actor: {
        ...aliased.actor,
        variants: [
          aliasedFirst,
          {
            ...aliasedFirst,
            site: {
              ...aliasedFirst.site,
              actorForward: {
                ...aliasedFirst.site.actorForward,
                bindings: [{ ...aliasedBinding, token: secondToken }],
              },
            },
            actorForwardSockets: [{ ...aliasedSocket, token: secondToken }],
          },
        ],
      },
    }),
  ).rejects.toThrow("unusable Actor class forward broker");
});

test("v2 Actor class retains each Version's exact SQLite facade on the current Host listener", async () => {
  const input = fixture();
  const first = input.actor.variants[0];
  if (!first) throw new Error("Actor fixture unavailable");
  const module = SELFHOST_WORKER_DATA_SERVICE_MODULE;
  const dataPlane = {
    address: "127.0.0.1:17778",
    module,
    vars: [
      { name: SELFHOST_WORKER_DATA_TOKEN_BINDING, value: "test-token", kind: "text" as const },
    ],
  };
  const moduleBytes = encoder.encode("export default {};");
  const hostModules = new Map([...input.hostModules, [module, moduleBytes]]);
  const variantHostModules = new Map([...first.hostModules, [module, moduleBytes]]);
  const secondDataPlane = {
    ...dataPlane,
    vars: [
      { name: SELFHOST_WORKER_DATA_TOKEN_BINDING, value: "second-token", kind: "text" as const },
    ],
  };
  const selected = {
    ...input,
    site: { ...input.site, dataPlane },
    hostModules,
    dataPlaneAddress: "127.0.0.1:17778",
    actor: {
      ...input.actor,
      variants: [
        {
          ...first,
          site: {
            ...first.site,
            dataPlane,
            vars: [{ name: "VERSION_MARKER", kind: "text" as const, value: "first" }],
          },
          hostModules: variantHostModules,
        },
        {
          ...first,
          site: {
            ...first.site,
            dataPlane: secondDataPlane,
            vars: [{ name: "VERSION_MARKER", kind: "text" as const, value: "second" }],
          },
          hostModules: variantHostModules,
        },
      ],
    },
  };
  const config = await readFile(await writeWorkerdPrivateExecution(selected), "utf8");
  expect(config).toContain(
    `(name = "${WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING}", service = "actor-version-0-selfhost-data")`,
  );
  expect(config).toContain('name = "actor-version-0-selfhost-data-origin"');
  expect(config).toContain('address = "127.0.0.1:17778", http = ()');
  const firstFacade = config.slice(
    config.indexOf('(name = "actor-version-0-selfhost-data", worker = ('),
    config.indexOf('(name = "actor-version-0-selfhost-data-origin"'),
  );
  const secondFacade = config.slice(
    config.indexOf('(name = "actor-version-1-selfhost-data", worker = ('),
    config.indexOf('(name = "actor-version-1-selfhost-data-origin"'),
  );
  expect(firstFacade).toContain(
    `name = "${SELFHOST_WORKER_DATA_TOKEN_BINDING}", text = "test-token"`,
  );
  expect(firstFacade).not.toContain("second-token");
  expect(secondFacade).toContain(
    `name = "${SELFHOST_WORKER_DATA_TOKEN_BINDING}", text = "second-token"`,
  );
  expect(secondFacade).not.toContain("test-token");
  const firstClass = config.slice(
    config.indexOf('(name = "actor-version-0", worker = ('),
    config.indexOf('(name = "actor-version-1", worker = ('),
  );
  const secondClass = config.slice(
    config.indexOf('(name = "actor-version-1", worker = ('),
    config.indexOf('(name = "actor-version-0-selfhost-data", worker = ('),
  );
  expect(firstClass).toContain('(name = "VERSION_MARKER", text = "first")');
  expect(firstClass).not.toContain('(name = "VERSION_MARKER", text = "second")');
  expect(secondClass).toContain('(name = "VERSION_MARKER", text = "second")');
  expect(secondClass).not.toContain('(name = "VERSION_MARKER", text = "first")');
  await expect(
    writeWorkerdPrivateExecution({ ...selected, dataPlaneAddress: "127.0.0.1:17779" }),
  ).rejects.toThrow("private data plane listener changed");
  const { dataPlaneAddress: _current, ...withoutListener } = selected;
  await expect(writeWorkerdPrivateExecution(withoutListener)).rejects.toThrow(
    "private data plane listener unavailable",
  );
});

test("v2 Actor class retains the selected Version's Workflow broker inside its native environment", async () => {
  const input = fixture();
  const first = input.actor.variants[0];
  if (!first) throw new Error("Actor fixture unavailable");
  const brokerRoot = mkdtempSync(join(tmpdir(), "awf-"));
  roots.push(brokerRoot);
  chmodSync(brokerRoot, 0o700);
  const socketPath = join(brokerRoot, `${"d".repeat(22)}.sock`);
  servers.push(Bun.serve({ unix: socketPath, fetch: () => new Response(null, { status: 204 }) }));
  const workflow = {
    schema: "takoserver.v2-workflow-binding-forward@1" as const,
    snapshotDigest: `sha256:${"e".repeat(64)}` as const,
    bindings: [
      {
        publicName: "WORKFLOW",
        serviceName: workerdV2PrivateWorkflowBindingName(0),
        tenantId: "tenant-1",
        workflowResourceUid: "uid-DurableWorkflow-1",
        token: "f".repeat(64),
      },
    ],
  };
  const hostModules = new Map(
    [...first.hostModules]
      .filter(([name]) => name !== first.site.hostEntrypoint)
      .concat([
        [
          WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
          encoder.encode("export default {};"),
        ] as const,
        ["__generated-actor-class-entry.js", encoder.encode("export default {};")] as const,
      ]),
  );
  const selected = {
    ...input,
    actor: {
      ...input.actor,
      variants: [
        {
          ...first,
          site: {
            ...first.site,
            hostEntrypoint: "__generated-actor-class-entry.js",
            workflowForward: workflow,
            hostModules: [
              ...(first.site.hostModules ?? []),
              WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
            ],
          },
          hostModules,
          workflowSourceEntrypoint: WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
          workflowBindings: [{ name: workflow.bindings[0]?.serviceName as string, socketPath }],
        },
      ],
    },
  };
  const config = await readFile(await writeWorkerdPrivateExecution(selected), "utf8");
  expect(config).toContain(`name = "${workflow.bindings[0]?.serviceName}"`);
  expect(config).toContain(`unix:${socketPath}`);
  expect(config).toContain('name = "actor-version-0-workflow-0"');
  const selectedVariant = selected.actor.variants[0];
  if (!selectedVariant) throw new Error("Actor Workflow variant unavailable");
  const withoutMapping = {
    ...selected,
    actor: {
      ...selected.actor,
      variants: [{ ...selectedVariant, workflowBindings: [] }],
    },
  };
  await expect(writeWorkerdPrivateExecution(withoutMapping)).rejects.toThrow(
    "Actor class Workflow broker unavailable",
  );
  const mixedWrapper = {
    ...selected,
    actor: {
      ...selected.actor,
      variants: [
        {
          ...selectedVariant,
          workflowSourceEntrypoint: first.site.hostEntrypoint as string,
        },
      ],
    },
  };
  await expect(writeWorkerdPrivateExecution(mixedWrapper)).rejects.toThrow(
    "unusable Actor class Workflow source",
  );
});

test("v2 Actor class refuses a missing or different-token broker", async () => {
  const missing = fixture();
  const missingVariant = missing.actor.variants[0];
  if (!missingVariant) throw new Error("Actor fixture unavailable");
  await expect(
    writeWorkerdPrivateExecution({
      ...missing,
      actor: {
        ...missing.actor,
        variants: [{ ...missingVariant, actorForwardSockets: [] }],
      },
    }),
  ).rejects.toThrow("Actor class forward broker unavailable");
  const wrong = fixture();
  const wrongVariant = wrong.actor.variants[0];
  const wrongSocket = wrong.actorForwardSockets[0];
  if (!wrongVariant || !wrongSocket) throw new Error("Actor fixture unavailable");
  await expect(
    writeWorkerdPrivateExecution({
      ...wrong,
      actor: {
        ...wrong.actor,
        variants: [
          {
            ...wrongVariant,
            actorForwardSockets: [{ ...wrongSocket, token: "c".repeat(64) }],
          },
        ],
      },
    }),
  ).rejects.toThrow("Actor class forward broker unavailable");
});

test("retained v1 Actor class config does not acquire forward services", async () => {
  const legacy = fixture(false);
  const config = await readFile(await writeWorkerdPrivateExecution(legacy), "utf8");
  expect(config).toContain('name = "actor-version-0"');
  expect(config).not.toContain("actor-version-0-forward-");
  expect(config).not.toContain(`unix:${legacy.actorForwardSockets[0]?.httpSocketPath}`);
});
