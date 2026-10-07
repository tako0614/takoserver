import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./json.ts";
import {
  type LinuxProcessIdentity,
  linuxProcessLiveness,
  readLinuxProcessIdentity,
} from "./workerd-linux-process.ts";

interface Scope {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
}

interface OwnerRecord {
  readonly schema: "takoserver.actor-native-owner@1";
  readonly nonce: string;
  readonly scope: Scope;
  readonly host: LinuxProcessIdentity;
}

interface ChildRecord {
  readonly schema: "takoserver.actor-native-child@1";
  readonly nonce: string;
  readonly scope: Scope;
  readonly child: LinuxProcessIdentity;
}

interface ReadRecord<T> {
  readonly value: T;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly links: bigint;
}

const unavailable = (): Error => new Error("Actor native ownership uncertain");
const sameInode = (a: ReadRecord<unknown>, b: ReadRecord<unknown>): boolean =>
  a.dev === b.dev && a.ino === b.ino;
const sameScope = (a: Scope, b: Scope): boolean =>
  a.tenantId === b.tenantId && a.namespaceResourceUid === b.namespaceResourceUid;
const identityShape = (value: unknown): value is LinuxProcessIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join(",") === "bootId,pid,pidNamespace,startTimeTicks" &&
    Number.isSafeInteger(v.pid) &&
    (v.pid as number) > 1 &&
    typeof v.bootId === "string" &&
    /^[0-9a-f-]{36}$/u.test(v.bootId) &&
    typeof v.pidNamespace === "string" &&
    /^\d+:\d+$/u.test(v.pidNamespace) &&
    typeof v.startTimeTicks === "string" &&
    /^\d+$/u.test(v.startTimeTicks)
  );
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw unavailable();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readRecord<T>(
  path: string,
  validate: (value: unknown) => value is T,
): Promise<ReadRecord<T> | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw unavailable();
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > 2_048n
    )
      throw unavailable();
    const text = await handle.readFile("utf8");
    const after = await lstat(path, { bigint: true }).catch(() => null);
    if (
      !after ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw unavailable();
    const value: unknown = JSON.parse(text);
    if (!validate(value) || canonicalJson(value) !== text) throw unavailable();
    return { value, dev: before.dev, ino: before.ino, links: after.nlink };
  } catch {
    throw unavailable();
  } finally {
    await handle.close();
  }
}

function ownerRecord(value: unknown): value is OwnerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const scope = v.scope as Scope | undefined;
  return (
    Object.keys(v).sort().join(",") === "host,nonce,schema,scope" &&
    v.schema === "takoserver.actor-native-owner@1" &&
    typeof v.nonce === "string" &&
    /^[0-9a-f-]{36}$/u.test(v.nonce) &&
    !!scope &&
    Object.keys(scope).sort().join(",") === "namespaceResourceUid,tenantId" &&
    typeof scope.tenantId === "string" &&
    typeof scope.namespaceResourceUid === "string" &&
    identityShape(v.host)
  );
}

function childRecord(value: unknown): value is ChildRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const scope = v.scope as Scope | undefined;
  return (
    Object.keys(v).sort().join(",") === "child,nonce,schema,scope" &&
    v.schema === "takoserver.actor-native-child@1" &&
    typeof v.nonce === "string" &&
    /^[0-9a-f-]{36}$/u.test(v.nonce) &&
    !!scope &&
    Object.keys(scope).sort().join(",") === "namespaceResourceUid,tenantId" &&
    typeof scope.tenantId === "string" &&
    typeof scope.namespaceResourceUid === "string" &&
    identityShape(v.child)
  );
}

async function publishFile(directory: string, destination: string, value: object): Promise<void> {
  const temporary = join(directory, `.actor-owner-${randomUUID()}`);
  const file = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(canonicalJson(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, destination);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => undefined);
    await syncDirectory(directory);
  }
}

/** A separate, Actor-only custody fence; legacy directory-only leases remain unknown. */
export async function acquireActorNativeLease(input: {
  readonly storageRoot: string;
  readonly key: string;
  readonly scope: Scope;
}): Promise<{
  recordNative(identity: LinuxProcessIdentity): Promise<void>;
  release(afterLockUnlinkBeforeSync?: () => Promise<void>): Promise<void>;
}> {
  if (
    input.key !==
    createHash("sha256")
      .update(JSON.stringify([input.scope.tenantId, input.scope.namespaceResourceUid]))
      .digest("hex")
  )
    throw unavailable();
  const directory = join(input.storageRoot, "leases");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(input.storageRoot);
  const marker = join(directory, input.key);
  const lock = join(directory, `${input.key}.owner.json`);
  const child = join(directory, `${input.key}.child.json`);
  const claim = join(directory, `${input.key}.recovering`);
  const host = await readLinuxProcessIdentity(process.pid);
  if (await exists(claim)) throw unavailable();
  const previous = await readRecord(lock, ownerRecord);
  let recovering = false;
  if (!previous) {
    if ((await exists(marker)) || (await exists(child))) throw unavailable();
  } else {
    if (
      !sameScope(previous.value.scope, input.scope) ||
      (await linuxProcessLiveness(previous.value.host)) !== "stale"
    )
      throw unavailable();
    const oldChild = await readRecord(child, childRecord);
    if (
      oldChild &&
      (!sameScope(oldChild.value.scope, input.scope) ||
        oldChild.value.nonce !== previous.value.nonce ||
        (await linuxProcessLiveness(oldChild.value.child)) !== "stale")
    )
      throw unavailable();
    // One fixed hardlink pins the old inode. A peer cannot create another
    // recovery claim, and fresh acquisition also checks this path.
    await link(lock, claim).catch(() => {
      throw unavailable();
    });
    const pinned = await readRecord(claim, ownerRecord);
    const current = await readRecord(lock, ownerRecord);
    const childAgain = await readRecord(child, childRecord);
    if (
      !pinned ||
      !current ||
      !sameInode(previous, pinned) ||
      !sameInode(previous, current) ||
      current.links !== 2n ||
      !sameScope(current.value.scope, input.scope) ||
      (await linuxProcessLiveness(current.value.host)) !== "stale" ||
      (childAgain &&
        (!sameScope(childAgain.value.scope, input.scope) ||
          childAgain.value.nonce !== current.value.nonce ||
          (await linuxProcessLiveness(childAgain.value.child)) !== "stale"))
    )
      throw unavailable();
    // Keep the fixed claim if this transition has an unknown outcome. A
    // concurrent fresh entrant cannot infer a free namespace from no lock.
    await unlink(lock);
    await syncDirectory(directory);
    recovering = true;
  }
  const record: OwnerRecord = {
    schema: "takoserver.actor-native-owner@1",
    nonce: randomUUID(),
    scope: { ...input.scope },
    host,
  };
  await publishFile(directory, lock, record);
  const owned = await readRecord(lock, ownerRecord);
  if (!owned || owned.value.nonce !== record.nonce) throw unavailable();
  if (!recovering && (await exists(claim))) throw unavailable();
  if (!(await exists(marker))) {
    await mkdir(marker, { mode: 0o700 }).catch(() => {
      throw unavailable();
    });
    await syncDirectory(directory);
  }
  const claimRecord = await readRecord(claim, ownerRecord);
  if (recovering) {
    if (!previous || !claimRecord || !sameInode(previous, claimRecord)) throw unavailable();
    const oldChild = await readRecord(child, childRecord);
    if (oldChild) {
      if (
        oldChild.value.nonce !== previous.value.nonce ||
        (await linuxProcessLiveness(oldChild.value.child)) !== "stale"
      )
        throw unavailable();
      await unlink(child);
      await syncDirectory(directory);
    }
    await unlink(claim);
    await syncDirectory(directory);
  } else if (claimRecord) throw unavailable();
  const finalLock = await readRecord(lock, ownerRecord);
  if ((await exists(claim)) || !finalLock || !sameInode(owned, finalLock)) throw unavailable();
  let releaseStarted = false;
  let releaseHookInvoked = false;
  let released = false;
  return {
    async recordNative(identity) {
      if ((await linuxProcessLiveness(host)) !== "live") throw unavailable();
      const current = await readRecord(lock, ownerRecord);
      if (
        !current ||
        !sameInode(owned, current) ||
        current.value.nonce !== record.nonce ||
        (await exists(claim))
      )
        throw unavailable();
      const prior = await readRecord(child, childRecord);
      if (
        prior &&
        (prior.value.nonce !== record.nonce ||
          !sameScope(prior.value.scope, input.scope) ||
          (await linuxProcessLiveness(prior.value.child)) !== "stale")
      )
        throw unavailable();
      const temporary = join(directory, `.actor-child-${randomUUID()}`);
      const file = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(
          canonicalJson({
            schema: "takoserver.actor-native-child@1",
            nonce: record.nonce,
            scope: input.scope,
            child: identity,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, child);
        await syncDirectory(directory);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      const persisted = await readRecord(child, childRecord);
      if (
        !persisted ||
        persisted.value.nonce !== record.nonce ||
        canonicalJson(persisted.value.child) !== canonicalJson(identity)
      )
        throw unavailable();
    },
    async release(afterLockUnlinkBeforeSync) {
      if (released) return;
      const current = await readRecord(lock, ownerRecord);
      if (
        (!releaseStarted && !current) ||
        (current && (!sameInode(owned, current) || current.value.nonce !== record.nonce)) ||
        (await exists(claim))
      )
        throw unavailable();
      if (!releaseStarted) {
        const native = await readRecord(child, childRecord);
        if (
          native &&
          (native.value.nonce !== record.nonce ||
            (await linuxProcessLiveness(native.value.child)) !== "stale")
        )
          throw unavailable();
        await rm(marker, { recursive: true, force: true });
        await syncDirectory(directory);
        if (native) {
          await unlink(child);
          await syncDirectory(directory);
        }
        releaseStarted = true;
      }
      if (current) await unlink(lock);
      if (!releaseHookInvoked) {
        releaseHookInvoked = true;
        await afterLockUnlinkBeforeSync?.();
      }
      await syncDirectory(directory);
      if (
        (await exists(lock)) ||
        (await exists(marker)) ||
        (await exists(child)) ||
        (await exists(claim))
      )
        throw unavailable();
      released = true;
    },
  };
}
