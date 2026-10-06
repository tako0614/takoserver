import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { spawnWorkerdWithParentDeath, workerPortOwnership } from "../src/workerd-linux-process.ts";
import { openWorkerdWorkerExecutionGroup } from "../src/workerd-worker-execution-group.ts";

const CHILD_SOURCE = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [verb, watch, configPath] = process.argv.slice(-3);
if (verb !== "serve" || watch !== "--watch" || !configPath) throw new Error("unexpected child command");
const { port, label, signalledPath, releasePath, dropListenerPath } = JSON.parse(readFileSync(configPath, "utf8"));
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(JSON.parse(readFileSync(configPath, "utf8")).label ?? label) });
let listenerDropped = false;
process.on("SIGTERM", () =>
  writeFileSync(signalledPath + "." + process.pid, "SIGTERM", { mode: 0o600 }),
);
setInterval(() => {
  if (!listenerDropped && existsSync(dropListenerPath)) {
    server.stop(true);
    listenerDropped = true;
  }
  if (!existsSync(releasePath + "." + process.pid)) return;
  if (!listenerDropped) server.stop(true);
  process.exit(0);
}, 10);
`;

type Child = ReturnType<typeof spawnWorkerdWithParentDeath>;

type Fixture = {
  readonly root: string;
  readonly binary: string;
  readonly children: Child[];
  readonly groups: Awaited<ReturnType<typeof openWorkerdWorkerExecutionGroup>>[];
  config(input: {
    readonly workerUid: string;
    readonly port: number;
    readonly label: string;
  }): Promise<{
    readonly bytes: Uint8Array;
    readonly signalledPath: string;
    readonly releasePath: string;
    readonly dropListenerPath: string;
  }>;
  open(input: {
    readonly workerUid: string;
    readonly port: number;
    readonly label: string;
  }): Promise<Awaited<ReturnType<typeof openWorkerdWorkerExecutionGroup>>>;
};

async function unusedPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserve"),
  });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-worker-group-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  const children: Child[] = [];
  const groups: Awaited<ReturnType<typeof openWorkerdWorkerExecutionGroup>>[] = [];
  try {
    await writeFile(binary, `#!${process.execPath}\n${CHILD_SOURCE}`, { mode: 0o700 });
    await chmod(binary, 0o700);
    const config = async ({
      workerUid,
      port,
      label,
    }: {
      readonly workerUid: string;
      readonly port: number;
      readonly label: string;
    }) => {
      const signalledPath = join(root, `${workerUid}.signalled`);
      const releasePath = join(root, `${workerUid}.release`);
      const dropListenerPath = join(root, `${workerUid}.drop-listener`);
      return {
        bytes: new TextEncoder().encode(
          JSON.stringify({ port, label, signalledPath, releasePath, dropListenerPath }),
        ),
        signalledPath,
        releasePath,
        dropListenerPath,
      };
    };
    const open = async ({
      workerUid,
      port,
      label,
    }: {
      readonly workerUid: string;
      readonly port: number;
      readonly label: string;
    }) => {
      const configuration = await config({ workerUid, port, label });
      const group = await openWorkerdWorkerExecutionGroup({
        rootDirectory: join(root, "groups"),
        workerResourceUid: workerUid,
        listenerPort: port,
        configuration: configuration.bytes,
        workerdBinary: binary,
        spawn: (command) => {
          const child = spawnWorkerdWithParentDeath(command, {
            stdout: "ignore",
            stderr: "ignore",
          });
          children.push(child);
          return child;
        },
      });
      groups.push(group);
      return group;
    };
    return { root, binary, children, groups, config, open };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function cleanup(value: Fixture): Promise<void> {
  for (const child of value.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const timeout = Symbol("child exit timeout");
  const exits = await Promise.all(
    value.children.map((child) =>
      Promise.race([child.exited, Bun.sleep(2_000).then(() => timeout)]),
    ),
  );
  if (exits.includes(timeout))
    throw new Error("worker group child exit was not confirmed in cleanup");
  await rm(value.root, { recursive: true, force: true });
}

async function until(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("worker group process observation timed out");
}

async function signalled(path: string, pid: number | undefined): Promise<boolean> {
  if (!pid) return false;
  try {
    return (await readFile(`${path}.${pid}`, "utf8")) === "SIGTERM";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("retiring one Worker group freezes it, reaps only its child, and replays its durable receipt", async () => {
  const owned = await fixture();
  const workerA = "worker-a";
  const workerB = "worker-b";
  const operationId = "8dd887ae-47b3-4ee5-8c26-53a0d63cfc21";
  const wrongOperationId = "d9961166-ce13-4b6c-b387-55d1392ed454";
  const portA = await unusedPort();
  const portB = await unusedPort();
  const configA = await owned.config({ workerUid: workerA, port: portA, label: "A" });
  try {
    const groupA = await owned.open({ workerUid: workerA, port: portA, label: "A" });
    const groupB = await owned.open({ workerUid: workerB, port: portB, label: "B" });
    await Promise.all([groupA.start(), groupB.start()]);
    const childA = owned.children[0];
    const childB = owned.children[1];
    if (!childA || !childB) throw new Error("both isolated Worker children must start");
    expect(await (await groupA.fetch(new Request("https://worker-a.example/a"))).text()).toBe("A");
    expect(await (await groupB.fetch(new Request("https://worker-b.example/b"))).text()).toBe("B");
    await expect(groupA.retire({ workerResourceUid: workerB, operationId })).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(
      await (await groupA.fetch(new Request("https://worker-a.example/still-open"))).text(),
    ).toBe("A");
    expect(await workerPortOwnership(portA, childA.pid)).toBe("owned");
    expect(await workerPortOwnership(portB, childB.pid)).toBe("owned");

    let settled = false;
    const retirement = groupA.retire({ workerResourceUid: workerA, operationId });
    void retirement.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let signalledA = false;
    try {
      await until(() => signalled(configA.signalledPath, childA.pid), 500);
      signalledA = true;
      expect(settled).toBe(false);
      await expect(
        groupA.retire({ workerResourceUid: workerA, operationId: wrongOperationId }),
      ).rejects.toMatchObject({ code: "identity_mismatch" });
      await expect(
        groupA.fetch(new Request("https://worker-a.example/late")),
      ).rejects.toMatchObject({
        code: "admission_closed",
      });
      expect(await (await groupB.fetch(new Request("https://worker-b.example/alive"))).text()).toBe(
        "B",
      );
      expect(await workerPortOwnership(portB, childB.pid)).toBe("owned");
      await writeFile(`${configA.releasePath}.${childA.pid}`, "release", { mode: 0o600 });
    } finally {
      if (signalledA)
        await writeFile(`${configA.releasePath}.${childA.pid}`, "release", { mode: 0o600 });
    }
    const receipt = await retirement;
    expect(receipt.workerResourceUid).toBe(workerA);
    expect(receipt.operationId).toBe(operationId);
    expect(await workerPortOwnership(portA, undefined)).toBe("vacant");
    expect(
      await (await groupB.fetch(new Request("https://worker-b.example/still-alive"))).text(),
    ).toBe("B");
    expect(owned.children).toHaveLength(2);

    const reopened = await owned.open({ workerUid: workerA, port: portA, label: "A" });
    await expect(reopened.start()).rejects.toMatchObject({ code: "already_retired" });
    const replayedReceipt = await reopened.retire({ workerResourceUid: workerA, operationId });
    expect(Object.isFrozen(replayedReceipt)).toBe(true);
    expect(Reflect.set(replayedReceipt, "operationId", wrongOperationId)).toBe(false);
    await expect(reopened.retire({ workerResourceUid: workerA, operationId })).resolves.toEqual(
      receipt,
    );
    await expect(
      reopened.retire({ workerResourceUid: workerA, operationId: wrongOperationId }),
    ).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(owned.children).toHaveLength(2);
    expect(await workerPortOwnership(portB, childB.pid)).toBe("owned");
  } finally {
    await Promise.all(
      owned.groups.map(async (group) => {
        try {
          await group.retire({
            workerResourceUid: group.workerResourceUid,
            operationId: wrongOperationId,
          });
        } catch {
          // Cleanup only: production retirement evidence is asserted above.
        }
      }),
    );
    await cleanup(owned);
  }
});

test("an existing group with no committed retirement receipt refuses a second writer", async () => {
  const owned = await fixture();
  const workerUid = "worker-concurrent";
  const port = await unusedPort();
  try {
    const first = await owned.open({ workerUid, port, label: "one" });
    await expect(owned.open({ workerUid, port, label: "one" })).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    await first.start();
    expect(owned.children).toHaveLength(1);
  } finally {
    for (const group of owned.groups) {
      try {
        await group.retire({
          workerResourceUid: group.workerResourceUid,
          operationId: "8dd887ae-47b3-4ee5-8c26-53a0d63cfc21",
        });
      } catch {
        // Cleanup only.
      }
    }
    await cleanup(owned);
  }
});

test("one group's watched configuration reloads through its same supervisor and receipt binds final bytes", async () => {
  const owned = await fixture();
  const workerUid = "worker-rendered-config";
  const operationId = "8dd887ae-47b3-4ee5-8c26-53a0d63cfc21";
  const port = await unusedPort();
  const initial = await owned.config({ workerUid, port, label: "baseline" });
  let group: Awaited<ReturnType<typeof openWorkerdWorkerExecutionGroup>> | undefined;
  try {
    group = await openWorkerdWorkerExecutionGroup({
      rootDirectory: join(owned.root, "rendered-groups"),
      workerResourceUid: workerUid,
      listenerPort: port,
      configuration: initial.bytes,
      configurationPath: "workers/workerd.capnp",
      workerdBinary: owned.binary,
      spawn: (command) => {
        const child = spawnWorkerdWithParentDeath(command, {
          stdout: "ignore",
          stderr: "ignore",
        });
        owned.children.push(child);
        return child;
      },
    });
    await group.start();
    const child = owned.children[0];
    if (!child) throw new Error("worker group child did not start");
    expect(await (await group.fetch(new Request("https://worker.test/"))).text()).toBe("baseline");

    const nextConfig = {
      ...JSON.parse(new TextDecoder().decode(initial.bytes)),
      label: "rendered",
    };
    await writeFile(group.configurationPath, JSON.stringify(nextConfig), { mode: 0o600 });
    await group.reloadConfiguration();
    expect(owned.children).toHaveLength(1);
    expect(await (await group.fetch(new Request("https://worker.test/"))).text()).toBe("rendered");
    group.sealConfiguration();
    const exactConfiguration = new TextEncoder().encode(JSON.stringify(nextConfig));
    await writeFile(group.configurationPath, JSON.stringify({ ...nextConfig, label: "late" }));
    await expect(group.reloadConfiguration()).rejects.toMatchObject({ code: "admission_closed" });

    await expect(group.retire({ workerResourceUid: workerUid, operationId })).rejects.toMatchObject(
      {
        code: "retirement_uncertain",
      },
    );
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    await writeFile(group.configurationPath, exactConfiguration, { mode: 0o600 });
    const retiring = group.retire({ workerResourceUid: workerUid, operationId });
    await until(() => signalled(initial.signalledPath, child.pid), 500);
    await writeFile(`${initial.releasePath}.${child.pid}`, "release", { mode: 0o600 });
    const receipt = await retiring;
    expect(receipt.configurationSha256).toBe(
      (await bytesDigest(new TextEncoder().encode(JSON.stringify(nextConfig)))).slice(
        "sha256:".length,
      ),
    );
    expect(await workerPortOwnership(port, child.pid)).toBe("vacant");
  } finally {
    if (group) {
      try {
        await group.retire({ workerResourceUid: workerUid, operationId });
      } catch {
        // Cleanup only; assertions above are the process-lifecycle evidence.
      }
    }
    await cleanup(owned);
  }
});

test("a child exit is recovered and retired by the same supervisor without a delayed duplicate start", async () => {
  const owned = await fixture();
  const workerUid = "worker-restart-race";
  const operationId = "8dd887ae-47b3-4ee5-8c26-53a0d63cfc21";
  const port = await unusedPort();
  const config = await owned.config({ workerUid, port, label: "restart" });
  try {
    const group = await owned.open({ workerUid, port, label: "restart" });
    await group.start();
    const firstChild = owned.children[0];
    if (!firstChild?.pid) throw new Error("the initial Worker child must have a PID");

    firstChild.kill("SIGKILL");
    await firstChild.exited;
    await group.start();
    expect(owned.children).toHaveLength(2);
    const recoveredChild = owned.children[1];
    if (!recoveredChild?.pid) throw new Error("the recovered Worker child must have a PID");
    expect(
      await (await group.fetch(new Request("https://worker-restart.example/recovered"))).text(),
    ).toBe("restart");

    const retirement = group.retire({ workerResourceUid: workerUid, operationId });
    await until(() => signalled(config.signalledPath, recoveredChild.pid), 1_000);
    await writeFile(`${config.releasePath}.${recoveredChild.pid}`, "release", { mode: 0o600 });
    await retirement;
    await Bun.sleep(150);
    expect(owned.children).toHaveLength(2);
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
  } finally {
    for (const group of owned.groups) {
      try {
        await group.retire({
          workerResourceUid: group.workerResourceUid,
          operationId: "d9961166-ce13-4b6c-b387-55d1392ed454",
        });
      } catch {
        // Cleanup only.
      }
    }
    await cleanup(owned);
  }
});

test("a failed first readiness retries and retires only through the same supervisor owner", async () => {
  const owned = await fixture();
  const workerUid = "worker-start-retry";
  const operationId = "8dd887ae-47b3-4ee5-8c26-53a0d63cfc21";
  const port = await unusedPort();
  const config = await owned.config({ workerUid, port, label: "retry" });
  try {
    let spawnCount = 0;
    const group = await openWorkerdWorkerExecutionGroup({
      rootDirectory: join(owned.root, "groups"),
      workerResourceUid: workerUid,
      listenerPort: port,
      configuration: config.bytes,
      workerdBinary: owned.binary,
      spawn: (command) => {
        const child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
        owned.children.push(child);
        spawnCount += 1;
        if (spawnCount !== 1) return child;
        return { pid: 1, kill: () => child.kill(), exited: child.exited };
      },
    });
    owned.groups.push(group);
    await expect(group.start()).rejects.toMatchObject({ code: "not_serving" });
    const firstChild = owned.children[0];
    if (!firstChild?.pid)
      throw new Error("the failed-start child must remain identifiable to its owner");
    await until(() => signalled(config.signalledPath, firstChild.pid), 1_000);

    const retry = group.start();
    await writeFile(`${config.releasePath}.${firstChild.pid}`, "release", { mode: 0o600 });
    await retry;
    expect(owned.children).toHaveLength(2);
    const recoveredChild = owned.children[1];
    if (!recoveredChild?.pid) throw new Error("the retried child must have a PID");

    const retirement = group.retire({ workerResourceUid: workerUid, operationId });
    await until(() => signalled(config.signalledPath, recoveredChild.pid), 1_000);
    await writeFile(`${config.releasePath}.${recoveredChild.pid}`, "release", { mode: 0o600 });
    await retirement;
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
    expect(owned.children).toHaveLength(2);
  } finally {
    for (const group of owned.groups) {
      try {
        await group.retire({
          workerResourceUid: group.workerResourceUid,
          operationId: "d9961166-ce13-4b6c-b387-55d1392ed454",
        });
      } catch {
        // Cleanup only.
      }
    }
    await cleanup(owned);
  }
});

test("a cached-ready group never forwards through a foreign listener after its child drops the port", async () => {
  const owned = await fixture();
  const workerUid = "worker-foreign-listener";
  const operationId = "8dd887ae-47b3-4ee5-8c26-53a0d63cfc21";
  const port = await unusedPort();
  const config = await owned.config({ workerUid, port, label: "group" });
  let foreignRequests = 0;
  let foreign: ReturnType<typeof Bun.serve> | undefined;
  try {
    const group = await owned.open({ workerUid, port, label: "group" });
    await group.start();
    const child = owned.children[0];
    if (!child?.pid) throw new Error("the Worker child must have a PID");
    await writeFile(config.dropListenerPath, "drop", { mode: 0o600 });
    await until(async () => (await workerPortOwnership(port, child.pid)) === "vacant");
    foreign = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => {
        foreignRequests += 1;
        return new Response("foreign");
      },
    });

    await expect(
      group.fetch(new Request("https://worker-foreign.example/never-forward")),
    ).rejects.toMatchObject({ code: "not_serving" });
    expect(foreignRequests).toBe(0);
    await expect(group.start()).rejects.toMatchObject({ code: "not_serving" });
    expect((await fetch(`http://127.0.0.1:${port}/foreign-check`)).status).toBe(200);
    expect(foreignRequests).toBe(1);

    const retirement = group.retire({ workerResourceUid: workerUid, operationId });
    await until(() => signalled(config.signalledPath, child.pid), 1_000);
    await writeFile(`${config.releasePath}.${child.pid}`, "release", { mode: 0o600 });
    await expect(retirement).rejects.toMatchObject({ code: "retirement_uncertain" });
    expect(foreignRequests).toBe(1);
    await foreign.stop(true);
    foreign = undefined;
    const receipt = await group.retire({ workerResourceUid: workerUid, operationId });
    expect(receipt.operationId).toBe(operationId);
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
  } finally {
    await foreign?.stop(true);
    for (const group of owned.groups) {
      try {
        await group.retire({
          workerResourceUid: group.workerResourceUid,
          operationId: "d9961166-ce13-4b6c-b387-55d1392ed454",
        });
      } catch {
        // Cleanup only.
      }
    }
    await cleanup(owned);
  }
});

test("an uncertain child shutdown never commits retirement or permits adoption", async () => {
  const owned = await fixture();
  const workerUid = "worker-uncertain-stop";
  const operationId = "8dd887ae-47b3-4ee5-8c26-53a0d63cfc21";
  const port = await unusedPort();
  const config = await owned.config({ workerUid, port, label: "uncertain" });
  try {
    const group = await openWorkerdWorkerExecutionGroup({
      rootDirectory: join(owned.root, "groups"),
      workerResourceUid: workerUid,
      listenerPort: port,
      configuration: config.bytes,
      workerdBinary: owned.binary,
      spawn: (command) => {
        const child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
        owned.children.push(child);
        return {
          pid: child.pid,
          kill: () => undefined,
          exited: child.exited,
        };
      },
    });
    owned.groups.push(group);
    await group.start();
    await expect(group.retire({ workerResourceUid: workerUid, operationId })).rejects.toMatchObject(
      {
        code: "retirement_uncertain",
      },
    );
    expect(await workerPortOwnership(port, owned.children[0]?.pid)).toBe("owned");
    await expect(
      group.retire({
        workerResourceUid: workerUid,
        operationId: "d9961166-ce13-4b6c-b387-55d1392ed454",
      }),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    await expect(
      openWorkerdWorkerExecutionGroup({
        rootDirectory: join(owned.root, "groups"),
        workerResourceUid: workerUid,
        listenerPort: port,
        configuration: config.bytes,
        workerdBinary: owned.binary,
      }),
    ).rejects.toMatchObject({ code: "ownership_uncertain" });
    const child = owned.children[0];
    if (!child?.pid) throw new Error("uncertain child must remain owned by the original handle");
    await writeFile(`${config.releasePath}.${child.pid}`, "release", { mode: 0o600 });
    await child.exited;
    const receipt = await group.retire({ workerResourceUid: workerUid, operationId });
    expect(receipt.operationId).toBe(operationId);
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
  } finally {
    await cleanup(owned);
  }
});
