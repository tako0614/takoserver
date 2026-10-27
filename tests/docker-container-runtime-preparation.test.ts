import { expect, test } from "bun:test";
import {
  createDockerContainerCreateCustody,
  type DockerContainerCreateCustody,
} from "../src/providers/docker-container-create-custody.ts";
import {
  createDockerContainerRuntimePreparation,
  type DockerContainerNativeIdentity,
  type DockerContainerRuntimePolicy,
  type DockerContainerRuntimeReceipt,
} from "../src/providers/docker-container-runtime-preparation.ts";

const native: DockerContainerNativeIdentity = {
  backend: "docker",
  installationId: "host-one",
  resourceUid: "resource-one",
  incarnationId: "incarnation-one",
  revision: "generation-one",
  nativeId: "a".repeat(64),
  network: "owned-net",
  networkId: "b".repeat(64),
  image: `registry.example/app@sha256:${"c".repeat(64)}`,
  imageId: `sha256:${"d".repeat(64)}`,
  identityLabel: `sha256:${"e".repeat(64)}`,
  revisionLabel: `sha256:${"f".repeat(64)}`,
};
const policy: DockerContainerRuntimePolicy = {
  tenantRef: "tenant-one",
  generation: 1,
  policyDigest: `sha256:${"1".repeat(64)}`,
  outboundInternet: false,
};

function fixture() {
  const revocation = new AbortController();
  const claims = new Set<string>();
  let installs = 0;
  const receipt: DockerContainerRuntimeReceipt = {
    native,
    policy,
    installed: true,
    topology: {
      networkId: native.networkId,
      rulesetDigest: `sha256:${"2".repeat(64)}`,
      meterId: "host-meter-one",
    },
    coverage: {
      ipv4: true,
      ipv6: true,
      tcp: true,
      udp: true,
      hostInput: true,
      forwardedTraffic: true,
      tenantIsolation: true,
      privateAddressDeny: true,
      metadataDeny: true,
      tcp25Deny: true,
      connectionLimit: true,
      bandwidthLimit: true,
      rawEgressMeter: true,
      killSwitch: true,
      denyAllOutbound: true,
      publicInternet: false,
    },
  };
  const lease = {
    revocation: revocation.signal,
    stillCurrent: async () => true,
    readback: async () => receipt,
    async claimStart(identity: DockerContainerNativeIdentity) {
      if (claims.has(identity.nativeId)) return "already-claimed" as const;
      claims.add(identity.nativeId);
      return "claimed" as const;
    },
  };
  const options = {
    policy,
    readStartClaim: async (identity: DockerContainerNativeIdentity) =>
      claims.has(identity.nativeId) ? ("claimed" as const) : ("unclaimed" as const),
    prepare: async () => {
      installs++;
      return lease;
    },
    recover: async () => lease,
  };
  return { options, lease, receipt, revocation, claims, installCount: () => installs };
}

test("lost start acknowledgement consumes the durable claim and recovery never replays start", async () => {
  const f = fixture();
  let starts = 0;
  expect(
    await createDockerContainerRuntimePreparation(f.options).authorizeStart(
      { native, state: "stopped" },
      async (guard) => {
        await guard();
        starts++;
        throw new Error("private native diagnostic");
      },
    ),
  ).toBe("unknown");
  expect(
    await createDockerContainerRuntimePreparation(f.options).authorizeStart(
      { native, state: "stopped" },
      async () => {
        starts++;
      },
    ),
  ).toBe("readback");
  expect(starts).toBe(1);
  expect(f.installCount()).toBe(1);
});

test("missing, foreign, partial or policy-inconsistent native readback cannot spend a start claim", async () => {
  const f = fixture();
  const receipts: unknown[] = [
    null,
    { ...f.receipt, installed: false },
    { ...f.receipt, native: { ...native, backend: "cloudflare" } },
    { ...f.receipt, native: { ...native, nativeId: "9".repeat(64) } },
    { ...f.receipt, topology: { ...f.receipt.topology, networkId: "9".repeat(64) } },
    { ...f.receipt, policy: { ...policy, tenantRef: "other-tenant" } },
    { ...f.receipt, policy: { ...policy, generation: 2 } },
    { ...f.receipt, coverage: { ...f.receipt.coverage, udp: false } },
    { ...f.receipt, coverage: { ...f.receipt.coverage, rawEgressMeter: false } },
    { ...f.receipt, coverage: { ...f.receipt.coverage, denyAllOutbound: false } },
    { ...f.receipt, extra: "synthetic-private-diagnostic" },
  ];
  let starts = 0;
  for (const receipt of receipts) {
    const preparation = createDockerContainerRuntimePreparation({
      ...f.options,
      prepare: async () => ({ ...f.lease, readback: async () => receipt }),
    });
    const error = await preparation
      .authorizeStart({ native, state: "stopped" }, async () => {
        starts++;
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "conflict" });
    expect(String(error)).toBe("DockerContainerRuntimePreparationError: conflict");
  }
  expect(starts).toBe(0);
  expect(f.claims.size).toBe(0);
});

test("revocation and captured lease custody survive mutation during an awaited current check", async () => {
  const f = fixture();
  let resume: (value: boolean) => void = () => undefined;
  const checking = new Promise<boolean>((resolve) => {
    resume = resolve;
  });
  let entered: () => void = () => undefined;
  const captured = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.lease.stillCurrent = () => {
    entered();
    return checking;
  };
  let starts = 0;
  const pending = createDockerContainerRuntimePreparation(f.options).authorizeStart(
    { native, state: "stopped" },
    async () => {
      starts++;
    },
  );
  await captured;
  f.lease.revocation = new AbortController().signal;
  f.lease.stillCurrent = async () => true;
  f.revocation.abort();
  resume(true);
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  expect(starts).toBe(0);
  expect(f.claims.size).toBe(0);
});

test("an unknown durable claim permits only recovery readback, without reinstalling or claiming again", async () => {
  const f = fixture();
  let installs = 0;
  let claims = 0;
  let starts = 0;
  const preparation = createDockerContainerRuntimePreparation({
    ...f.options,
    readStartClaim: async () => "unknown" as const,
    prepare: async () => {
      installs++;
      return f.lease;
    },
    recover: async () => ({
      ...f.lease,
      claimStart: async () => {
        claims++;
        return "claimed" as const;
      },
    }),
  });
  expect(
    await preparation.authorizeStart({ native, state: "stopped" }, async () => {
      starts++;
    }),
  ).toBe("readback");
  expect([installs, claims, starts]).toEqual([0, 0, 0]);
});

test("concurrent preparations share one durable native start claim", async () => {
  const f = fixture();
  let starts = 0;
  const start = async (guard: () => Promise<void>) => {
    await guard();
    starts++;
  };
  const results = await Promise.all([
    createDockerContainerRuntimePreparation(f.options).authorizeStart(
      { native, state: "stopped" },
      start,
    ),
    createDockerContainerRuntimePreparation(f.options).authorizeStart(
      { native, state: "stopped" },
      start,
    ),
  ]);
  expect(results.sort()).toEqual(["readback", "started"]);
  expect(starts).toBe(1);
});

test("an unknown claim and unresolved create-time secrets fail closed without native effects", async () => {
  const f = fixture();
  let starts = 0;
  const preparation = createDockerContainerRuntimePreparation({
    ...f.options,
    prepare: async () => ({ ...f.lease, claimStart: async () => "unknown" as const }),
  });
  expect(
    await preparation.authorizeStart({ native, state: "stopped" }, async () => {
      starts++;
    }),
  ).toBe("readback");
  expect(starts).toBe(0);
  expect(() =>
    createDockerContainerRuntimePreparation({
      ...f.options,
      requiredSecretNames: ["SYNTHETIC_SECRET"],
    }),
  ).toThrow("unavailable");
});

test("running recovery only reads trusted enforcement and never prepares or claims a start", async () => {
  const f = fixture();
  f.claims.add(native.nativeId);
  let installs = 0;
  let readbacks = 0;
  const preparation = createDockerContainerRuntimePreparation({
    ...f.options,
    prepare: async () => {
      installs++;
      return f.lease;
    },
    recover: async () => ({
      ...f.lease,
      readback: async () => {
        readbacks++;
        return f.receipt;
      },
    }),
  });
  await preparation.verifyExisting(native);
  expect(installs).toBe(0);
  expect(readbacks).toBe(1);
  expect(f.claims.size).toBe(1);
});

test("secret preparation cannot bypass typed custody or mix its declared names and policy", () => {
  const f = fixture();
  let ownerCalls = 0;
  const custody = createDockerContainerCreateCustody({
    policy: f.options.policy,
    requiredSecretNames: ["TOKEN"],
    owner: {
      read: async () => {
        ownerCalls++;
        return null;
      },
      claim: async () => {
        throw new Error("synthetic unreachable owner");
      },
      withAuthority: async () => {
        throw new Error("synthetic unreachable owner");
      },
      bindNative: async () => {
        throw new Error("synthetic unreachable owner");
      },
      confirmRunning: async () => {
        throw new Error("synthetic unreachable owner");
      },
      confirmStopped: async () => {
        throw new Error("synthetic unreachable owner");
      },
      confirmRemoved: async () => {
        throw new Error("synthetic unreachable owner");
      },
    },
  });
  expect(() =>
    createDockerContainerRuntimePreparation({
      ...f.options,
      requiredSecretNames: ["TOKEN"],
      createCustody: custody,
    }),
  ).not.toThrow();
  expect(() =>
    createDockerContainerRuntimePreparation({
      ...f.options,
      requiredSecretNames: ["OTHER"],
      createCustody: custody,
    }),
  ).toThrow("conflict");
  expect(() =>
    createDockerContainerRuntimePreparation({
      ...f.options,
      policy: { ...f.options.policy, generation: f.options.policy.generation + 1 },
      requiredSecretNames: ["TOKEN"],
      createCustody: custody,
    }),
  ).toThrow("conflict");
  expect(() =>
    createDockerContainerRuntimePreparation({
      ...f.options,
      requiredSecretNames: ["TOKEN"],
      createCustody: {} as DockerContainerCreateCustody,
    }),
  ).toThrow("invalid_request");
  expect(ownerCalls).toBe(0);
});

test("running native adoption without a durable Host start claim is refused", async () => {
  const f = fixture();
  await expect(
    createDockerContainerRuntimePreparation(f.options).verifyExisting(native),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.installCount()).toBe(0);
});

test("native identity and policy are copied before an awaited preparation can mutate caller objects", async () => {
  const f = fixture();
  const originalNative = { ...native };
  const originalPolicy = { ...policy };
  let resume: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const preparation = createDockerContainerRuntimePreparation({
    ...f.options,
    policy: originalPolicy,
    prepare: async (captured) => {
      await wait;
      expect(captured.nativeId).toBe("a".repeat(64));
      return f.lease;
    },
  });
  const pending = preparation.authorizeStart(
    { native: originalNative, state: "stopped" },
    async (guard) => {
      await guard();
    },
  );
  originalNative.nativeId = "9".repeat(64);
  originalPolicy.tenantRef = "replacement-tenant";
  resume();
  expect(await pending).toBe("started");
  expect(preparation.policy.tenantRef).toBe("tenant-one");
});

test("topology drift during the durable start claim cannot authorize start or recreate its claim", async () => {
  const f = fixture();
  let current = f.receipt;
  let starts = 0;
  f.lease.readback = async () => current;
  const claim = f.lease.claimStart.bind(f.lease);
  f.lease.claimStart = async (identity) => {
    const result = await claim(identity);
    current = {
      ...f.receipt,
      topology: { ...f.receipt.topology, rulesetDigest: `sha256:${"9".repeat(64)}` },
    };
    return result;
  };
  const preparation = createDockerContainerRuntimePreparation(f.options);
  await expect(
    preparation.authorizeStart({ native, state: "stopped" }, async () => {
      starts++;
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(starts).toBe(0);
  expect(f.claims.size).toBe(1);
  expect(
    await preparation.authorizeStart({ native, state: "stopped" }, async () => {
      starts++;
    }),
  ).toBe("readback");
  expect([starts, f.installCount(), f.claims.size]).toEqual([0, 1, 1]);
});

test("a retained running guard reads actual enforcement again after awaited health and body cleanup", async () => {
  for (const change of ["missing", "partial", "network", "rules", "meter"] as const) {
    const f = fixture();
    f.claims.add(native.nativeId);
    let current: unknown = f.receipt;
    const preparation = createDockerContainerRuntimePreparation({
      ...f.options,
      recover: async () => ({ ...f.lease, readback: async () => current }),
    });
    const guard = await preparation.verifyExisting(native);
    // The caller awaits the response body/health work before publishing ready.
    await Promise.resolve();
    current =
      change === "missing"
        ? null
        : change === "partial"
          ? { ...f.receipt, coverage: { ...f.receipt.coverage, udp: false } }
          : {
              ...f.receipt,
              topology: {
                ...f.receipt.topology,
                ...(change === "network"
                  ? { networkId: "9".repeat(64) }
                  : change === "rules"
                    ? { rulesetDigest: `sha256:${"9".repeat(64)}` }
                    : { meterId: "foreign-meter" }),
              },
            };
    await expect(guard()).rejects.toMatchObject({ code: "conflict" });
    expect(f.installCount()).toBe(0);
  }
});

test("a pending fresh readback cannot publish ready after un-aborted authority loss", async () => {
  const f = fixture();
  f.claims.add(native.nativeId);
  let current = true;
  let pending = false;
  let entered: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume: (value: DockerContainerRuntimeReceipt) => void = () => undefined;
  const blocked = new Promise<DockerContainerRuntimeReceipt>((resolve) => {
    resume = resolve;
  });
  const preparation = createDockerContainerRuntimePreparation({
    ...f.options,
    recover: async () => ({
      ...f.lease,
      stillCurrent: async () => current,
      readback: async () => {
        if (!pending) return f.receipt;
        entered();
        return blocked;
      },
    }),
  });
  const guard = await preparation.verifyExisting(native);
  pending = true;
  const verifying = guard();
  await reading;
  current = false;
  resume(f.receipt);
  await expect(verifying).rejects.toMatchObject({ code: "unavailable" });
  expect(f.revocation.signal.aborted).toBe(false);
  expect(f.installCount()).toBe(0);
});
