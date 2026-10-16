import { afterEach, expect, test } from "bun:test";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import type { resolveActorAbiProfile } from "../src/actor-class-execution.ts";
import type {
  createActorUpgradeHandoff,
  installActorResponseRuntime,
  NativeActorUpgradeTransport,
} from "../src/actor-upgrade-handoff.ts";
import { renderActorUpgradeHandoffModuleSource } from "../src/actor-upgrade-handoff-source.ts";

const NativeResponse = Response;
let nextBundle = 0;
type HandoffModule = {
  resolveActorAbiProfile: typeof resolveActorAbiProfile;
  createActorUpgradeHandoff: typeof createActorUpgradeHandoff;
  installActorResponseRuntime: typeof installActorResponseRuntime;
};

afterEach(() => {
  globalThis.Response = NativeResponse;
});

async function freshBundle(): Promise<HandoffModule> {
  const source = `${renderActorUpgradeHandoffModuleSource()}\n// test instance ${nextBundle++}\n`;
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function request(): Request {
  return new Request("http://worker.invalid/socket", {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
}

test("rendered handoff resolves its own exact v2 profile and preserves clone refusal through commit", async () => {
  const module = await freshBundle();
  const profile = module.resolveActorAbiProfile(ACTOR_ABI_INTERFACE_REFS.v2);
  expect(profile.kind).toBe("v2");
  expect(profile.schemaDigest).toBe(ACTOR_ABI_INTERFACE_REFS.v2.schemaDigest);
  expect(profile.socketAttachmentBytes).toBe(16_384);
  module.installActorResponseRuntime();
  const events: string[] = [];
  const native = new NativeResponse(null, { status: 101 });
  const handoff = module.createActorUpgradeHandoff(
    request(),
    {
      async open() {
        return {
          response: native,
          profile,
          commit() {
            events.push("commit");
          },
          abandon() {
            events.push("abandon");
          },
        };
      },
    },
    30_000,
    profile,
  );
  try {
    const response = await handoff.actor.fetch(request());
    expect(response.status).toBe(101);
    expect(() => response.clone()).toThrow(TypeError);
    const alias = new Response(null, response);
    expect(alias.status).toBe(101);
    expect(() => alias.clone()).toThrow(TypeError);
    alias.headers.set("x-app", "kept");
    const committed = await handoff.finish(alias);
    expect(committed).toBeInstanceOf(NativeResponse);
    expect(committed.status).toBe(101);
    expect(committed.headers.get("x-app")).toBe("kept");
    expect(events).toEqual(["commit"]);
  } finally {
    await handoff.abandon();
  }
});

test("separate rendered bundles refuse each other's exact v2 profile and abandon a foreign reservation", async () => {
  const first = await freshBundle();
  const second = await freshBundle();
  const firstProfile = first.resolveActorAbiProfile(ACTOR_ABI_INTERFACE_REFS.v2);
  const secondProfile = second.resolveActorAbiProfile(ACTOR_ABI_INTERFACE_REFS.v2);
  expect(firstProfile).not.toBe(secondProfile);
  let opened = 0;
  let abandoned = 0;
  const transport: NativeActorUpgradeTransport = {
    async open() {
      opened += 1;
      return {
        response: new NativeResponse(null, { status: 101 }),
        profile: secondProfile,
        commit() {
          throw new Error("foreign profile must never commit");
        },
        abandon() {
          abandoned += 1;
        },
      };
    },
  };
  expect(() =>
    first.createActorUpgradeHandoff(request(), transport, 30_000, secondProfile),
  ).toThrow("Actor ABI profile is unavailable");
  expect(opened).toBe(0);
  const handoff = first.createActorUpgradeHandoff(request(), transport, 30_000, firstProfile);
  try {
    await expect(handoff.actor.fetch(request())).rejects.toThrow("backend_unavailable");
    expect(opened).toBe(1);
    expect(abandoned).toBe(1);
  } finally {
    await handoff.abandon();
  }
});

test("rendered handoff refuses a structural profile clone and an unrecognized InterfaceRef", async () => {
  const module = await freshBundle();
  const profile = module.resolveActorAbiProfile(ACTOR_ABI_INTERFACE_REFS.v2);
  const transport: NativeActorUpgradeTransport = {
    async open() {
      throw new Error("invalid profile must never open a reservation");
    },
  };
  expect(() =>
    module.createActorUpgradeHandoff(request(), transport, 30_000, { ...profile }),
  ).toThrow("Actor ABI profile is unavailable");
  expect(() =>
    module.resolveActorAbiProfile({
      ...ACTOR_ABI_INTERFACE_REFS.v2,
      schemaDigest: "sha256:unknown",
    }),
  ).toThrow("Actor runtime InterfaceRef is unavailable");
});
