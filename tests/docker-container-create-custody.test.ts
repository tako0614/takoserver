import { expect, test } from "bun:test";
import {
  createDockerContainerCreateCustody,
  type DockerContainerCreateCustodyOptions,
  type DockerContainerCreateDriver,
  type DockerContainerCreateHeldAuthority,
  type DockerContainerCreateOwnerPort,
  type DockerContainerCreateRecord,
  type DockerContainerCreateSession,
  type DockerContainerCreateTarget,
} from "../src/providers/docker-container-create-custody.ts";
import type {
  DockerContainerNativeIdentity,
  DockerContainerRuntimePolicy,
} from "../src/providers/docker-container-runtime-preparation.ts";

const target: DockerContainerCreateTarget = {
  installationId: "host-one",
  resourceUid: "resource-one",
  incarnationId: "incarnation-one",
  revision: "generation-one",
  nativeName: "takoserver-owned-one",
  identityLabel: `sha256:${"e".repeat(64)}`,
  revisionLabel: `sha256:${"f".repeat(64)}`,
};
const policy: DockerContainerRuntimePolicy = {
  tenantRef: "tenant-one",
  generation: 1,
  policyDigest: `sha256:${"1".repeat(64)}`,
  outboundInternet: false,
};
const native: DockerContainerNativeIdentity = {
  backend: "docker",
  installationId: target.installationId,
  resourceUid: target.resourceUid,
  incarnationId: target.incarnationId,
  revision: target.revision,
  nativeId: "a".repeat(64),
  network: "owned-net",
  networkId: "b".repeat(64),
  image: `registry.example/app@sha256:${"c".repeat(64)}`,
  imageId: `sha256:${"d".repeat(64)}`,
  identityLabel: target.identityLabel,
  revisionLabel: target.revisionLabel,
};

/** External Host/daemon model. It proves consumer behavior, not a native producer. */
function fixture() {
  let durable: DockerContainerCreateRecord | null = null;
  let inspected: Awaited<ReturnType<DockerContainerCreateDriver["inspect"]>> = null;
  let creates = 0;
  let deletes = 0;
  let environmentLoans = 0;
  let current = true;
  let createAckLost = false;
  let claimAckLost = false;
  let bindAckLost = false;
  const revocation = new AbortController();
  const held: DockerContainerCreateHeldAuthority = {
    revocation: revocation.signal,
    stillCurrent: async () => current,
    async withEnvironment(use) {
      environmentLoans++;
      return use({ TOKEN: "synthetic-transient-value" }, revocation.signal);
    },
  };
  const owner: DockerContainerCreateOwnerPort = {
    async read() {
      return durable ? structuredClone(durable) : null;
    },
    async claim(intent) {
      if (durable) return { status: "existing", record: structuredClone(durable) };
      durable = { claimId: "2".repeat(64), intent, nativeId: null, state: "pending" };
      if (claimAckLost) throw new Error("synthetic private owner diagnostic");
      return { status: "won", record: structuredClone(durable) };
    },
    async withAuthority(_record, _phase, use) {
      return use(held);
    },
    async bindNative(record, nativeId) {
      if (
        !durable ||
        durable.claimId !== record.claimId ||
        (durable.nativeId !== null && durable.nativeId !== nativeId)
      )
        throw new Error("synthetic private CAS diagnostic");
      durable = { ...durable, nativeId, state: "bound" };
      if (bindAckLost) throw new Error("synthetic private binding diagnostic");
    },
    async confirmRemoved(record, nativeId) {
      if (!durable || durable.claimId !== record.claimId || durable.nativeId !== nativeId)
        throw new Error("synthetic private removal diagnostic");
      durable = { ...durable, state: "removed" };
    },
  };
  const driver: DockerContainerCreateDriver = {
    async inspect(record) {
      if (record.nativeId && inspected && inspected.native.nativeId !== record.nativeId)
        return null;
      return inspected ? structuredClone(inspected) : null;
    },
    async create(record, values) {
      creates++;
      inspected = {
        native,
        state: "stopped",
        claimId: record.claimId,
        environment: ["IMAGE_DEFAULT=present", `TOKEN=${values.TOKEN}`],
      };
      if (createAckLost) throw new Error("synthetic private daemon diagnostic");
      return native.nativeId;
    },
    async remove() {
      deletes++;
      inspected = null;
      return "deleted";
    },
  };
  const options: DockerContainerCreateCustodyOptions = {
    policy,
    requiredSecretNames: ["TOKEN"],
    owner,
  };
  const run = <T>(use: (session: DockerContainerCreateSession) => Promise<T>) =>
    createDockerContainerCreateCustody(options).withAuthority(target, "reconcile", driver, use);
  return {
    options,
    owner,
    held,
    driver,
    run,
    revocation,
    counts: () => ({ creates, deletes, environmentLoans }),
    record: () => structuredClone(durable),
    setInspected: (value: typeof inspected) => {
      inspected = value;
    },
    loseCreateAck: () => {
      createAckLost = true;
    },
    loseClaimAck: () => {
      claimAckLost = true;
    },
    loseBindAck: () => {
      bindAckLost = true;
    },
    expire: () => {
      current = false;
    },
    seed: (record: DockerContainerCreateRecord) => {
      durable = record;
    },
  };
}

test("lost CREATE ACK is recovered by the original claim and never replays CREATE", async () => {
  const f = fixture();
  f.loseCreateAck();
  expect(await f.run((session) => session.ensureCreated())).toEqual({ native, state: "stopped" });
  expect(await f.run((session) => session.ensureCreated())).toEqual({ native, state: "stopped" });
  expect(f.counts().creates).toBe(1);
  expect(f.record()).toMatchObject({ nativeId: native.nativeId, state: "bound" });
});

test("a known CREATE ID with lost binding ACK cannot fall back to name discovery", async () => {
  const f = fixture();
  f.loseBindAck();
  let inspectedAfterCreate = 0;
  const inspect = f.driver.inspect;
  f.driver.inspect = async (record, signal) => {
    if (f.counts().creates > 0) inspectedAfterCreate++;
    return inspect(record, signal);
  };
  await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(inspectedAfterCreate).toBe(0);
  expect(f.counts().creates).toBe(1);
  expect(await f.run((session) => session.ensureCreated())).toEqual({ native, state: "stopped" });
  expect(f.counts().creates).toBe(1);
});

test("a producer cannot detach its held callback and authorize CREATE after returning", async () => {
  const f = fixture();
  let detached: Promise<unknown> = Promise.resolve();
  f.owner.withAuthority = async (_record, _phase, use) => {
    detached = use(f.held).catch(() => undefined);
    return undefined as never;
  };
  await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "unavailable",
  });
  await detached;
  expect(f.counts().creates).toBe(0);
});

test("concurrent claimants and repeated ensure calls can emit only one CREATE", async () => {
  const f = fixture();
  await Promise.all([
    f.run(async (session) => Promise.all([session.ensureCreated(), session.ensureCreated()])),
    f.run((session) => session.ensureCreated()),
  ]);
  expect(f.counts().creates).toBe(1);
  expect(await f.run((session) => session.inspect())).toEqual({ native, state: "stopped" });
});

test("lost claim ACK and absent native readback retain unknown custody without CREATE", async () => {
  const f = fixture();
  f.loseClaimAck();
  await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(f.record()).toMatchObject({ nativeId: null, state: "pending" });
  expect(await f.run((session) => session.ensureCreated())).toBeNull();
  expect(f.counts().creates).toBe(0);
});

test("bound native disappearance never permits CREATE or name replacement adoption", async () => {
  const f = fixture();
  await f.run((session) => session.ensureCreated());
  f.setInspected(null);
  expect(await f.run((session) => session.ensureCreated())).toBeNull();
  f.setInspected({
    native: { ...native, nativeId: "9".repeat(64) },
    claimId: "2".repeat(64),
    state: "stopped",
    environment: ["TOKEN=synthetic-transient-value"],
  });
  expect(await f.run((session) => session.ensureCreated())).toBeNull();
  expect(f.record()).toMatchObject({ nativeId: native.nativeId });
  expect(f.counts().creates).toBe(1);
});

test("native secret drift, duplicate keys and foreign claim labels cannot reach START", async () => {
  for (const changed of [
    { environment: ["TOKEN=synthetic-other-value"] },
    { environment: ["TOKEN=synthetic-transient-value", "TOKEN=synthetic-transient-value"] },
    { environment: ["IMAGE_DEFAULT=present"] },
    { claimId: "9".repeat(64) },
    { native: { ...native, incarnationId: "foreign-incarnation" } },
  ]) {
    const f = fixture();
    await f.run((session) => session.ensureCreated());
    f.setInspected({
      native,
      state: "stopped",
      claimId: "2".repeat(64),
      environment: ["TOKEN=synthetic-transient-value"],
      ...changed,
    });
    let starts = 0;
    await expect(
      f.run(async (session) => {
        await session.ensureCreated();
        starts++;
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(starts).toBe(0);
    expect(f.counts().creates).toBe(1);
  }
});

test("transient values are detached from mutable maps and never enter public custody metadata", async () => {
  const f = fixture();
  const values = { TOKEN: "synthetic-transient-value" };
  f.held.withEnvironment = async (use) => {
    const pending = use(values, f.revocation.signal);
    values.TOKEN = "synthetic-mutated-after-loan";
    return pending;
  };
  expect(await f.run((session) => session.ensureCreated())).toEqual({ native, state: "stopped" });
  expect(Object.keys(f.record() ?? {})).toEqual(["claimId", "intent", "nativeId", "state"]);
  expect(JSON.stringify(f.record())).not.toContain("synthetic-transient-value");
  expect(JSON.stringify(f.record())).not.toContain("synthetic-mutated-after-loan");
});

test("revocation during a captured current check cancels before any native effect", async () => {
  const f = fixture();
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume: (value: boolean) => void = () => undefined;
  const checking = new Promise<boolean>((resolve) => {
    resume = resolve;
  });
  f.held.stillCurrent = () => {
    enter();
    return checking;
  };
  const pending = f.run((session) => session.ensureCreated());
  await entered;
  Object.defineProperty(f.held, "revocation", { value: new AbortController().signal });
  f.held.stillCurrent = async () => true;
  f.revocation.abort();
  resume(true);
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  expect(f.counts().creates).toBe(0);
  expect(f.counts().environmentLoans).toBe(0);
});

test("in-flight CREATE receives active cancellation and a late ACK cannot bind custody", async () => {
  const f = fixture();
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let finish: (value: string) => void = () => undefined;
  const lateAck = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let signal: AbortSignal | undefined;
  let effects = 0;
  f.driver.create = async (_record, _values, cancellation) => {
    effects++;
    signal = cancellation;
    enter();
    return lateAck;
  };
  const pending = f.run((session) => session.ensureCreated());
  await entered;
  f.revocation.abort();
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  expect(signal?.aborted).toBe(true);
  finish(native.nativeId);
  await Promise.resolve();
  expect(f.record()).toMatchObject({ state: "pending", nativeId: null });
  expect(effects).toBe(1);
});

test("expired current authority and unavailable secret custody cannot adopt daemon Env", async () => {
  for (const cause of ["current", "secret"] as const) {
    const f = fixture();
    await f.run((session) => session.ensureCreated());
    if (cause === "current") f.expire();
    else
      f.held.withEnvironment = async () => {
        throw new Error("synthetic private key-unavailable diagnostic");
      };
    const error = await f
      .run((session) => session.ensureCreated())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(String(error)).toBe("DockerContainerCreateCustodyError: unavailable");
    expect(f.counts().creates).toBe(1);
  }
});

test("double owner or secret callbacks cannot emit extra native effects", async () => {
  for (const duplicate of ["owner", "secret"] as const) {
    const f = fixture();
    if (duplicate === "owner") {
      f.owner.withAuthority = async (_record, _phase, use) => {
        const result = await use(f.held);
        await use(f.held);
        return result;
      };
    } else {
      f.held.withEnvironment = async (use) => {
        const values = { TOKEN: "synthetic-transient-value" };
        const result = await use(values, f.revocation.signal);
        await use(values, f.revocation.signal);
        return result;
      };
    }
    await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(f.counts().creates).toBe(1);
  }
});

test("borrowed sessions close on callback completion and cannot authorize later effects", async () => {
  const f = fixture();
  let borrowed: DockerContainerCreateSession | undefined;
  await f.run(async (session) => {
    borrowed = session;
    await session.ensureCreated();
  });
  if (!borrowed) throw new Error("session not provided");
  expect(borrowed.signal.aborted).toBe(true);
  await expect(borrowed.guard()).rejects.toMatchObject({ code: "unavailable" });
  await expect(borrowed.ensureCreated()).rejects.toMatchObject({ code: "unavailable" });
  expect(f.counts().creates).toBe(1);
});

test("exact-ID delete and absence commit a terminal record that never permits another CREATE", async () => {
  const f = fixture();
  await f.run((session) => session.ensureCreated());
  await createDockerContainerCreateCustody(f.options).withAuthority(
    target,
    "remove",
    f.driver,
    (session) => session.remove(native.nativeId),
  );
  expect(f.record()).toMatchObject({ nativeId: native.nativeId, state: "removed" });
  await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "conflict",
  });
  expect(f.counts().creates).toBe(1);
  expect(f.counts().deletes).toBe(1);
});

test("pending CREATE absence and unknown DELETE ACK cannot establish retirement", async () => {
  const f = fixture();
  f.loseClaimAck();
  await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(
    createDockerContainerCreateCustody(f.options).withAuthority(
      target,
      "remove",
      f.driver,
      (session) => session.remove(native.nativeId),
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.counts().deletes).toBe(0);
  const bound = fixture();
  await bound.run((session) => session.ensureCreated());
  bound.driver.remove = async () => {
    bound.setInspected(null);
    throw new Error("synthetic private delete-ACK diagnostic");
  };
  await expect(
    createDockerContainerCreateCustody(bound.options).withAuthority(
      target,
      "remove",
      bound.driver,
      (session) => session.remove(native.nativeId),
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(bound.record()).toMatchObject({ state: "bound" });
  expect(await bound.run((session) => session.ensureCreated())).toBeNull();
  expect(bound.counts().creates).toBe(1);
});

test("changed scope, policy, extra custody fields and truthy current replies fail closed", async () => {
  const f = fixture();
  await f.run((session) => session.ensureCreated());
  const saved = f.record();
  if (!saved) throw new Error("record not retained");
  for (const changed of [
    { ...saved, intent: { ...saved.intent, incarnationId: "other-incarnation" } },
    { ...saved, intent: { ...saved.intent, policy: { ...policy, generation: 2 } } },
    { ...saved, intent: { ...saved.intent, requiredSecretNames: ["OTHER"] } },
    { ...saved, savedReference: "forbidden-public-reference" },
  ]) {
    f.seed(changed);
    await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
      code: "conflict",
    });
  }
  f.seed(saved);
  f.held.stillCurrent = async () => "truthy" as unknown as boolean;
  await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(f.counts().creates).toBe(1);
});

test("secret names, getters, extra values and cancelled loans cannot reach the daemon", async () => {
  for (const values of [
    {},
    { TOKEN: "synthetic-transient-value", EXTRA: "synthetic-extra-value" },
    Object.defineProperty({}, "TOKEN", {
      enumerable: true,
      get() {
        throw new Error("synthetic private getter diagnostic");
      },
    }),
    { TOKEN: "synthetic\0invalid" },
  ]) {
    const f = fixture();
    f.held.withEnvironment = async (use) => use(values, f.revocation.signal);
    const error = await f
      .run((session) => session.ensureCreated())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(String(error)).toBe("DockerContainerCreateCustodyError: unavailable");
    expect(f.counts().creates).toBe(0);
  }
  const f = fixture();
  f.held.withEnvironment = async (use) =>
    use({ TOKEN: "synthetic-transient-value" }, AbortSignal.abort());
  await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(f.counts().creates).toBe(0);
  for (const names of [[], ["TOKEN", "TOKEN"], ["not-valid-name"]])
    expect(() =>
      createDockerContainerCreateCustody({ ...f.options, requiredSecretNames: names }),
    ).toThrow("invalid_request");
});

test("captured producer and driver methods cannot be replaced during an awaited lookup", async () => {
  const f = fixture();
  let entered: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const read = f.owner.read;
  f.owner.read = async (intent) => {
    entered();
    await paused;
    return read(intent);
  };
  const custody = createDockerContainerCreateCustody(f.options);
  const pending = custody.withAuthority(target, "reconcile", f.driver, (session) =>
    session.ensureCreated(),
  );
  await reading;
  f.owner.claim = async () => {
    throw new Error("replacement producer must not run");
  };
  f.driver.create = async () => {
    throw new Error("replacement driver must not run");
  };
  resume();
  expect(await pending).toEqual({ native, state: "stopped" });
  expect(f.counts().creates).toBe(1);
});

test("revoking a pending successor does not cancel the incumbent's separately held authority", async () => {
  const incumbent = fixture();
  const successor = fixture();
  await incumbent.run((session) => session.ensureCreated());
  successor.expire();
  await expect(successor.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(await incumbent.run((session) => session.inspect())).toEqual({ native, state: "stopped" });
  expect(incumbent.revocation.signal.aborted).toBe(false);
  expect(incumbent.counts().creates).toBe(1);
  expect(successor.counts().creates).toBe(0);
});

test("Docker-valid dotted public and image Env keys coexist with declared secret overrides", async () => {
  const f = fixture();
  const inspect = f.driver.inspect;
  f.driver.inspect = async (record, signal) => {
    const raw = await inspect(record, signal);
    return raw ? { ...raw, environment: [...raw.environment, "APP.MODE=portable"] } : null;
  };
  expect(await f.run((session) => session.ensureCreated())).toEqual({ native, state: "stopped" });
  expect(f.counts().creates).toBe(1);
});

test("a committed removal with lost ACK converges from exact terminal custody without reopening secrets", async () => {
  const f = fixture();
  await f.run((session) => session.ensureCreated());
  const confirm = f.owner.confirmRemoved;
  f.owner.confirmRemoved = async (record, nativeId) => {
    await confirm(record, nativeId);
    throw new Error("synthetic private terminal commit ACK lost");
  };
  const remove = () =>
    createDockerContainerCreateCustody(f.options).withAuthority(
      target,
      "remove",
      f.driver,
      (session) => session.remove(native.nativeId),
    );
  await expect(remove()).rejects.toMatchObject({ code: "unavailable" });
  expect(f.record()).toMatchObject({ state: "removed", nativeId: native.nativeId });
  const loansBeforeRetry = f.counts().environmentLoans;
  f.held.withEnvironment = async () => {
    throw new Error("retired key must not be reopened");
  };
  await remove();
  expect(f.counts().environmentLoans).toBe(loansBeforeRetry);
  expect(f.counts().deletes).toBe(1);
  expect(f.counts().creates).toBe(1);
});

test("terminal cleanup can reacquire current authority after final guard failure and still requires exact absence", async () => {
  const f = fixture();
  await f.run((session) => session.ensureCreated());
  const confirm = f.owner.confirmRemoved;
  f.owner.confirmRemoved = async (record, nativeId) => {
    await confirm(record, nativeId);
    f.expire();
  };
  const remove = (nativeId = native.nativeId) =>
    createDockerContainerCreateCustody(f.options).withAuthority(
      target,
      "remove",
      f.driver,
      (session) => session.remove(nativeId),
    );
  await expect(remove()).rejects.toMatchObject({ code: "unavailable" });
  f.held.stillCurrent = async () => true;
  await remove();
  await expect(remove("9".repeat(64))).rejects.toMatchObject({ code: "conflict" });
  f.setInspected({
    native,
    state: "stopped",
    claimId: "2".repeat(64),
    environment: ["TOKEN=synthetic-unexpected-native-value"],
  });
  await expect(remove()).rejects.toMatchObject({ code: "conflict" });
  await expect(
    createDockerContainerCreateCustody(f.options).withAuthority(
      target,
      "observe",
      f.driver,
      (session) => session.inspect(),
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(f.run((session) => session.ensureCreated())).rejects.toMatchObject({
    code: "conflict",
  });
  expect(f.counts().creates).toBe(1);
  expect(f.counts().deletes).toBe(1);
});

test("canonical integration and staging native names preserve once-only creation custody", async () => {
  for (const nativeName of [
    "takoserver-owned-one",
    "integration-takoserver-secret-stopped-e329",
    "staging-takoserver-secret-stopped-e329",
  ]) {
    const f = fixture();
    const scopedTarget = { ...target, nativeName };
    const create = () =>
      createDockerContainerCreateCustody(f.options).withAuthority(
        scopedTarget,
        "reconcile",
        f.driver,
        (session) => session.ensureCreated(),
      );
    expect(await create()).toEqual({ native, state: "stopped" });
    expect(await create()).toEqual({ native, state: "stopped" });
    expect(f.record()?.intent.nativeName).toBe(nativeName);
    expect(f.counts().creates).toBe(1);
  }
});

test("foreign and lookalike staging names reject before custody or native effects", async () => {
  for (const nativeName of [
    "integration-foreign-secret-stopped-e329",
    "staging-foreign-secret-stopped-e329",
    "preintegration-takoserver-one",
    "integrationtakoserver-one",
    "integration--takoserver-one",
    "integration-staging-takoserver-one",
    "integration-takoserver",
    "integration-takoserver-",
    "staging-takoserver-",
    "Integration-takoserver-one",
    "staging-takoserver-one/foreign",
    "integration-takoserver-one?foreign",
    "integration-takoserver-one\n",
    "staging-takoserver-\0foreign",
  ]) {
    const f = fixture();
    let ownerReads = 0;
    const read = f.owner.read;
    f.owner.read = async (intent) => {
      ownerReads++;
      return read(intent);
    };
    await expect(
      createDockerContainerCreateCustody(f.options).withAuthority(
        { ...target, nativeName },
        "reconcile",
        f.driver,
        (session) => session.ensureCreated(),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(ownerReads).toBe(0);
    expect(f.record()).toBeNull();
    expect(f.counts()).toEqual({ creates: 0, deletes: 0, environmentLoans: 0 });
  }
});
