import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfhostVersionBindingStore,
  type SelfhostVersionBindingStore,
} from "../src/providers/selfhost-version-bindings.ts";

/**
 * The environment of one immutable Worker Version, kept outside the version
 * directory whose digest means "the bytes the tenant committed". A sensitive
 * value can live here, so the file's permissions and the shape of its digest
 * are part of the contract, not an implementation detail.
 */

let root: string;
let store: SelfhostVersionBindingStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-version-bindings-"));
  store = createSelfhostVersionBindingStore({ root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SET = {
  handlers: ["fetch" as const],
  vars: [{ name: "LANE", value: "takoform-v1", kind: "text" as const }],
  sensitiveVars: [{ name: "ENCRYPTION_KEY", value: "placeholder-secret", kind: "text" as const }],
};

test("stores and returns one version's bindings", async () => {
  expect(await store.read("sw-a", "v-1")).toBeNull();
  const written = await store.write("sw-a", "v-1", SET);
  expect(written.vars).toEqual(SET.vars);
  expect(written.sensitiveVars).toEqual(SET.sensitiveVars);
  expect(written.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(await store.read("sw-a", "v-1")).toEqual(written);
});

test("keeps one salt for one version so a retry does not move its digest", async () => {
  const first = await store.write("sw-a", "v-1", SET);
  const second = await store.write("sw-a", "v-1", {
    // Order is normalized, so presenting the same set differently is the same set.
    handlers: ["fetch"],
    vars: [...SET.vars],
    sensitiveVars: [...SET.sensitiveVars],
  });
  expect(second.digest).toBe(first.digest);
});

test("commits to the values with a salt rather than a guessable hash of them", async () => {
  const other = createSelfhostVersionBindingStore({ root: join(root, "other") });
  const first = await store.write("sw-a", "v-1", SET);
  const second = await other.write("sw-a", "v-1", SET);
  expect(second.digest).not.toBe(first.digest);
  // The digest is not the SHA-256 of the value, so a short secret cannot be
  // recovered from the generation string that carries it.
  const naive = new Bun.CryptoHasher("sha256").update("placeholder-secret").digest("hex");
  expect(first.digest).not.toContain(naive);
});

test("changing a value changes the digest", async () => {
  const first = await store.write("sw-a", "v-1", SET);
  const changed = await store.write("sw-a", "v-1", {
    handlers: ["fetch"],
    vars: SET.vars,
    sensitiveVars: [{ name: "ENCRYPTION_KEY", value: "rotated", kind: "text" }],
  });
  expect(changed.digest).not.toBe(first.digest);
});

test("writes the record so only the operator can read it", async () => {
  await store.write("sw-a", "v-1", SET);
  expect((await stat(join(root, "sw-a", "v-1.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "sw-a"))).mode & 0o777).toBe(0o700);
});

test("refuses a name that is not a script or a version", async () => {
  await expect(store.write("../escape", "v-1", SET)).rejects.toMatchObject({ code: "corrupt" });
  await expect(store.write("sw-a", "../escape", SET)).rejects.toMatchObject({ code: "corrupt" });
  await expect(store.read("sw-a", "v 1")).rejects.toMatchObject({ code: "corrupt" });
});

test("refuses a set that names the same binding twice", async () => {
  await expect(
    store.write("sw-a", "v-1", {
      handlers: ["fetch"],
      vars: [{ name: "SAME", value: "a", kind: "text" }],
      sensitiveVars: [{ name: "SAME", value: "b", kind: "text" }],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
});

test("reports a tampered record as corrupt instead of serving it", async () => {
  await store.write("sw-a", "v-1", SET);
  const path = join(root, "sw-a", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...raw, extra: true }), "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
  await writeFile(path, "{not json", "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
});

test("a record an earlier build wrote is still read, and carries no handlers", async () => {
  // `@v1` predates event delivery on this Host: it has no handler list and no
  // event token, so a Version published under it keeps serving and simply
  // cannot be wrapped.
  const path = join(root, "sw-a", "v-1.json");
  await store.write("sw-a", "v-1", SET);
  const legacy = JSON.stringify({
    format: "takoserver.selfhost-version-bindings@v1",
    salt: "A".repeat(43),
    vars: SET.vars,
    sensitiveVars: SET.sensitiveVars,
  });
  await writeFile(path, legacy, "utf8");
  const read = await store.read("sw-a", "v-1");
  expect(read?.handlers).toBeUndefined();
  expect(read?.eventToken).toBeUndefined();
  expect(read?.vars).toEqual(SET.vars);
});

test("mints an event token the caller never chose, once per version", async () => {
  const first = await store.write("sw-a", "v-1", SET);
  expect(first.eventToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const again = await store.write("sw-a", "v-1", SET);
  expect(again.eventToken).toBe(first.eventToken);
  const other = await store.write("sw-a", "v-2", SET);
  expect(other.eventToken).not.toBe(first.eventToken);
});

test("forgets one version, and every version of a deleted script", async () => {
  await store.write("sw-a", "v-1", SET);
  await store.write("sw-a", "v-2", SET);
  expect(await store.remove("sw-a", "v-1")).toBe(true);
  expect(await store.remove("sw-a", "v-1")).toBe(false);
  expect(await store.read("sw-a", "v-2")).not.toBeNull();
  await store.removeScript("sw-a");
  expect(await store.read("sw-a", "v-2")).toBeNull();
});
