import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfhostScriptStateStore,
  nodeSelfhostScriptStateFileSystem,
} from "../src/providers/selfhost-script-state.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-script-state-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("self-host Worker script state", () => {
  test("fails closed without replacing a malformed existing state", async () => {
    await mkdir(root, { recursive: true });
    const path = join(root, "script-one.json");
    await writeFile(path, '{"activeVersion":"v-one","domains":[', "utf8");
    const store = createSelfhostScriptStateStore({ root });

    await expect(store.read("script-one")).rejects.toMatchObject({ code: "corrupt" });
    expect(await readFile(path, "utf8")).toBe('{"activeVersion":"v-one","domains":[');
  });

  test("keeps the last valid state and cleans a truncated abandoned write", async () => {
    const store = createSelfhostScriptStateStore({ root });
    await store.write("script-one", null, {
      activeVersion: "v-one",
      endpointHostname: "script-one.localhost",
      domains: ["www.example.test"],
    });
    const path = join(root, "script-one.json");
    const abandoned = `${path}.tmp`;
    await writeFile(abandoned, '{"activeVersion":"v-two"', "utf8");

    const recovered = await createSelfhostScriptStateStore({ root }).read("script-one");

    expect(recovered.state).toEqual({
      activeVersion: "v-one",
      endpointHostname: "script-one.localhost",
      domains: ["www.example.test"],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(recovered.state);
    expect(await readFile(abandoned, "utf8").catch(() => null)).toBeNull();
  });

  test("does not replace the last valid state when a staging write is interrupted", async () => {
    const durable = createSelfhostScriptStateStore({ root });
    const initial = await durable.write("script-one", null, {
      activeVersion: "v-one",
      domains: ["one.example.test"],
    });
    const interrupted = createSelfhostScriptStateStore({
      root,
      fileSystem: {
        ...nodeSelfhostScriptStateFileSystem,
        async openExclusive(path: string) {
          const file = await nodeSelfhostScriptStateFileSystem.openExclusive(path);
          return {
            async write(bytes: Uint8Array) {
              await file.write(bytes.slice(0, Math.max(1, Math.floor(bytes.byteLength / 2))));
              throw new Error("simulated interrupted write");
            },
            async sync() {
              await file.sync();
            },
            async close() {
              await file.close();
            },
          };
        },
      },
    });

    await expect(
      interrupted.write("script-one", initial.revision, {
        activeVersion: "v-two",
        domains: ["two.example.test"],
      }),
    ).rejects.toMatchObject({ code: "unavailable" });

    expect((await durable.read("script-one")).state).toEqual(initial.state);
    expect(await readFile(join(root, "script-one.json.tmp"), "utf8").catch(() => null)).toBeNull();
  });

  test("refuses an oversized replacement without making the valid state unreadable", async () => {
    const store = createSelfhostScriptStateStore({ root });
    const initial = await store.write("script-one", null, {
      activeVersion: "v-one",
      domains: [],
    });

    await expect(
      store.write("script-one", initial.revision, {
        domains: ["x".repeat(64 * 1_024)],
      }),
    ).rejects.toMatchObject({ code: "corrupt" });

    expect((await store.read("script-one")).state).toEqual(initial.state);
  });

  test("flushes and closes the staged file before rename, then flushes its directory", async () => {
    let phase: string = "idle";
    const fileSystem = {
      ...nodeSelfhostScriptStateFileSystem,
      async openExclusive(path: string) {
        const file = await nodeSelfhostScriptStateFileSystem.openExclusive(path);
        return {
          async write(bytes: Uint8Array) {
            if (phase !== "idle") throw new Error("write order drifted");
            await file.write(bytes);
            phase = "written";
          },
          async sync() {
            if (phase !== "written") throw new Error("file was not written before sync");
            await file.sync();
            phase = "synced";
          },
          async close() {
            if (phase !== "synced") throw new Error("file was not synced before close");
            await file.close();
            phase = "closed";
          },
        };
      },
      async replace(source: string, destination: string) {
        if (phase !== "closed") throw new Error("staging file was not closed before rename");
        await nodeSelfhostScriptStateFileSystem.replace(source, destination);
        phase = "renamed";
      },
      async syncDirectory(path: string) {
        if (phase !== "renamed") throw new Error("directory was synced before rename");
        await nodeSelfhostScriptStateFileSystem.syncDirectory(path);
        phase = "durable";
      },
    };
    const store = createSelfhostScriptStateStore({ root, fileSystem });

    const written = await store.write("script-one", null, {
      activeVersion: "v-one",
      domains: [],
    });

    expect(written.state.activeVersion).toBe("v-one");
    expect(phase).toBe("durable");
  });

  test("allows one exact-revision writer and returns a typed conflict to the loser", async () => {
    const firstStore = createSelfhostScriptStateStore({ root });
    const secondStore = createSelfhostScriptStateStore({ root });
    const current = await firstStore.read("script-one");

    const outcomes = await Promise.allSettled([
      firstStore.write("script-one", current.revision, {
        endpointHostname: "script-one.localhost",
        domains: [],
      }),
      secondStore.write("script-one", current.revision, {
        domains: ["www.example.test"],
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const conflict = outcomes.find((outcome) => outcome.status === "rejected");
    expect(conflict?.status === "rejected" ? conflict.reason : undefined).toMatchObject({
      code: "conflict",
    });
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("the race had no winner");
    expect((await firstStore.read("script-one")).state).toEqual(winner.value.state);
  });
});
