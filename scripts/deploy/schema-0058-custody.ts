import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { mutationError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";
import type { DeployTarget } from "./target.ts";

export interface Protected0058Custody {
  readonly attemptPrefix: string;
  readonly leaseRoot: string;
  /** Repeat after asynchronous boundaries, especially before native dispatch. */
  assertContinuity(): void;
}

/** A configured root is custody, not a cache: absence or replacement is unknown history. */
export function resolveProtected0058Custody(target: DeployTarget): Protected0058Custody {
  const binding = target.protected0058Custody;
  if (binding === undefined) {
    throw mutationError(
      "0058 protected attempt has no stable custody binding; prior dispatch cannot be ruled out",
    );
  }
  const { root, rootIdentity } = binding;
  if (!isAbsolute(root)) {
    throw mutationError(
      "0058 protected custody root is invalid; prior dispatch cannot be ruled out",
    );
  }
  const assertContinuity = () => {
    try {
      const state = lstatSync(root, { bigint: true });
      const physicalRoot = realpathSync(root);
      const inside = relative(realpathSync(REPOSITORY), physicalRoot);
      if (
        physicalRoot !== root ||
        inside === "" ||
        (!inside.startsWith("..") && !isAbsolute(inside)) ||
        !state.isDirectory() ||
        state.isSymbolicLink() ||
        (state.mode & 0o777n) !== 0o700n ||
        process.getuid === undefined ||
        state.uid !== BigInt(process.getuid()) ||
        String(state.dev) !== rootIdentity.device ||
        String(state.ino) !== rootIdentity.inode
      ) {
        throw new Error("mismatch");
      }
      for (let cursor = physicalRoot; ; cursor = dirname(cursor)) {
        // An ancestor Git marker would make this an ordinary checkout path.
        if (lstatSync(join(cursor, ".git"), { throwIfNoEntry: false }) !== undefined) {
          throw new Error("checkout");
        }
        const next = dirname(cursor);
        if (next === cursor) break;
      }
    } catch {
      throw mutationError(
        "0058 protected custody root is missing, replaced, aliased, inside a checkout, or unsafe; prior dispatch cannot be ruled out",
      );
    }
  };
  assertContinuity();
  const digest = createHash("sha256")
    .update(`${target.accountId}\0${target.d1.databaseId}`)
    .digest("hex");
  return {
    attemptPrefix: join(root, `d1-0058-${digest}`),
    leaseRoot: root,
    assertContinuity,
  };
}
