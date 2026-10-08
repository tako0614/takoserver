import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import {
  WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
  workerdV2PrivateActorBindingName,
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
