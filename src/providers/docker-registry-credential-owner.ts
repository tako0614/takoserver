import { type BigIntStats, constants, fstatSync, lstatSync, realpathSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DockerContainerCreateSession } from "./docker-container-create-custody.ts";
import type { DockerImageAcquisitionTarget } from "./docker-container-image-acquisition.ts";
import type { DockerRegistryCredentialOwner } from "./docker-registry-source.ts";
import { DockerRegistrySourceError } from "./docker-registry-wire.ts";

type RegistryCredentials = Parameters<
  Parameters<DockerRegistryCredentialOwner["withCredentials"]>[3]
>[0];

/** Host operator input, never tenant Env or a public Form field. A configured
 * file is mandatory: absent files and absent entries never select anonymous. */
export type DockerRegistryCredentialStore =
  | { readonly kind: "anonymous" }
  | { readonly kind: "file"; readonly path: string; readonly maxBytes: number };

export interface FileDockerRegistryCredentialOwner extends DockerRegistryCredentialOwner {
  /** Revoke new/held loans, then join their original callbacks and fd cleanup.
   * Existing Source owns body cancellation/deadlines; this is not a wire abort. */
  close(): Promise<void>;
}

const REF =
  /^([a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?)\/([a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*)@(sha256:[a-f0-9]{64})$/u;
const identityKeys = [
  "installationId",
  "resourceUid",
  "incarnationId",
  "revision",
  "identityLabel",
  "revisionLabel",
] as const;
const fail = (code: "invalid_request" | "conflict" | "unavailable" = "unavailable"): never => {
  throw new DockerRegistrySourceError(code);
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    fail("conflict");
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((char) => {
    const point = char.charCodeAt(0);
    return point < 32 || point === 127;
  });
function scopeOf(image: string) {
  if (!text(image, 512)) return fail("invalid_request");
  const match = REF.exec(image);
  if (!match) return fail("invalid_request");
  let url: URL;
  try {
    url = new URL(`https://${match[1]}`);
  } catch {
    return fail("invalid_request");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.port && Number(url.port) < 1)
  )
    return fail("invalid_request");
  return { origin: url.origin, repository: match[2]! };
}
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function external(parent: string) {
  // A .git file also marks linked worktrees. No credential/config bytes are read.
  for (let at = parent; ; at = dirname(at)) {
    try {
      lstatSync(join(at, ".git"));
      return fail("invalid_request");
    } catch (error) {
      if (error instanceof DockerRegistrySourceError) throw error;
      if (!record(error) || error.code !== "ENOENT") return fail();
    }
    if (dirname(at) === at) return;
  }
}

/** File format: canonical JSON (optional final newline),
 * {"version":1,"credentials":[{"origin":"https://registry.example",
 * "repository":"org/app","username":"...","password":"..."}]}.
 * Each entry is an exact credential scope, not a registry admission list.
 * The original Source still owns public address, Realm and service policy. */
export function createFileDockerRegistryCredentialOwner(
  input: DockerRegistryCredentialStore,
  maxConcurrentLoans = 8,
): FileDockerRegistryCredentialOwner {
  if (
    !input ||
    !["anonymous", "file"].includes(input.kind) ||
    !Number.isSafeInteger(maxConcurrentLoans) ||
    maxConcurrentLoans < 1 ||
    maxConcurrentLoans > 128
  )
    return fail("invalid_request");
  exact(input, input.kind === "anonymous" ? ["kind"] : ["kind", "path", "maxBytes"]);
  const store = Object.freeze({ ...input });
  if (
    store.kind === "file" &&
    (!text(store.path, 4096) ||
      !isAbsolute(store.path) ||
      resolve(store.path) !== store.path ||
      store.path.split("/").length > 64 ||
      !Number.isSafeInteger(store.maxBytes) ||
      store.maxBytes < 1 ||
      store.maxBytes > 1_048_576)
  )
    return fail("invalid_request");
  let closed = false;
  const pending = new Set<Promise<unknown>>();

  async function loan<T>(
    session: DockerContainerCreateSession,
    target: DockerImageAcquisitionTarget,
    scope: { readonly origin: string; readonly repository: string },
    use: (credentials: RegistryCredentials) => Promise<T>,
  ): Promise<T> {
    let file: FileHandle | undefined, parentFile: FileHandle | undefined;
    let filePin: BigIntStats | undefined, parentPin: BigIntStats | undefined;
    let bytes: Buffer | undefined,
      live = true,
      username: string | undefined,
      password: string | undefined;
    const captured = Object.freeze({ ...target });
    const expected = scopeOf(captured.image);
    if (scope.origin !== expected.origin || scope.repository !== expected.repository)
      return fail("conflict");
    const parent = store.kind === "file" ? dirname(store.path) : undefined;
    const uid = process.getuid?.();
    const check = () => {
      if (closed || !live || session.signal.aborted) return fail();
      for (const key of identityKeys)
        if (captured[key] !== session.record.intent[key] || target[key] !== captured[key])
          return fail("conflict");
      if (
        target.image !== captured.image ||
        scope.origin !== expected.origin ||
        scope.repository !== expected.repository
      )
        return fail("conflict");
      if (store.kind === "file" && filePin && parentPin && file && parentFile && parent) {
        try {
          if (
            realpathSync(parent) !== parent ||
            !same(parentPin, fstatSync(parentFile.fd, { bigint: true })) ||
            !same(parentPin, lstatSync(parent, { bigint: true })) ||
            !same(filePin, fstatSync(file.fd, { bigint: true })) ||
            !same(filePin, lstatSync(store.path, { bigint: true }))
          )
            return fail("conflict");
        } catch (error) {
          if (error instanceof DockerRegistrySourceError) throw error;
          return fail();
        }
      }
    };
    async function step<V>(io: () => Promise<V>): Promise<V> {
      check();
      await session.guard();
      check();
      const result = await io();
      check();
      await session.guard();
      check();
      return result;
    }
    try {
      check();
      await session.guard();
      check();
      if (store.kind === "anonymous") {
        const result = await use(Object.freeze({ kind: "anonymous" }));
        check();
        await session.guard();
        check();
        return result;
      }
      if (uid === undefined || !parent) return fail();
      external(parent);
      await step(async () => {
        parentFile = await open(
          parent,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      });
      parentPin = await step(() => parentFile!.stat({ bigint: true }));
      if (
        !parentPin.isDirectory() ||
        parentPin.uid !== BigInt(uid) ||
        (parentPin.mode & 0o7777n) !== 0o700n ||
        realpathSync(parent) !== parent
      )
        return fail("conflict");
      await step(async () => {
        file = await open(
          store.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      });
      filePin = await step(() => file!.stat({ bigint: true }));
      if (
        !filePin.isFile() ||
        filePin.uid !== BigInt(uid) ||
        filePin.nlink !== 1n ||
        (filePin.mode & 0o7777n) !== 0o600n ||
        filePin.size < 1n ||
        filePin.size > BigInt(store.maxBytes)
      )
        return fail("conflict");
      check();
      bytes = Buffer.alloc(store.maxBytes + 1);
      let total = 0;
      for (;;) {
        const read = await step(() => file!.read(bytes!, total, bytes!.byteLength - total, total));
        total += read.bytesRead;
        if (total > store.maxBytes) return fail("conflict");
        if (read.bytesRead === 0) break;
      }
      if (BigInt(total) !== filePin.size) return fail("conflict");
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
      const value: unknown = JSON.parse(raw);
      // Canonical serialization also refuses duplicate object keys.
      if (raw !== JSON.stringify(value) && raw !== `${JSON.stringify(value)}\n`)
        return fail("conflict");
      exact(value, ["version", "credentials"]);
      if (
        value.version !== 1 ||
        !Array.isArray(value.credentials) ||
        value.credentials.length > 128
      )
        return fail("conflict");
      const scopes = new Set<string>();
      for (const entry of value.credentials) {
        exact(entry, ["origin", "repository", "username", "password"]);
        if (
          !text(entry.origin, 512) ||
          !text(entry.repository, 512) ||
          !text(entry.username, 512) ||
          entry.username.includes(":") ||
          !text(entry.password, 8192)
        )
          return fail("conflict");
        const canonical = scopeOf(
          `${entry.origin.slice(8)}/${entry.repository}@sha256:${"0".repeat(64)}`,
        );
        if (entry.origin !== canonical.origin || entry.repository !== canonical.repository)
          return fail("conflict");
        const key = `${entry.origin}\0${entry.repository}`;
        if (scopes.has(key)) return fail("conflict");
        scopes.add(key);
        if (entry.origin === expected.origin && entry.repository === expected.repository) {
          username = entry.username;
          password = entry.password;
        }
      }
      if (username === undefined || password === undefined) return fail("conflict");
      check();
      await session.guard();
      check();
      const credentials = Object.freeze({
        kind: "basic" as const,
        get username() {
          check();
          return username!;
        },
        get password() {
          check();
          return password!;
        },
      });
      const result = await use(credentials);
      // Source joins this result on EOF/cancel: an updated file cannot produce a
      // successful body/supply completion. No per-chunk wire abort is claimed.
      check();
      await session.guard();
      check();
      return result;
    } catch (error) {
      if (error instanceof DockerRegistrySourceError) throw error;
      return fail();
    } finally {
      live = false;
      username = undefined;
      password = undefined;
      bytes?.fill(0);
      const results = await Promise.allSettled([file?.close(), parentFile?.close()]);
      if (results.some((result) => result.status === "rejected")) fail();
    }
  }
  return Object.freeze({
    withCredentials<T>(
      session: DockerContainerCreateSession,
      target: DockerImageAcquisitionTarget,
      scope: { readonly origin: string; readonly repository: string },
      use: (credentials: RegistryCredentials) => Promise<T>,
    ) {
      if (closed || pending.size >= maxConcurrentLoans)
        return Promise.reject(new DockerRegistrySourceError("unavailable"));
      const operation = loan<T>(session, target, scope, use);
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  });
}
