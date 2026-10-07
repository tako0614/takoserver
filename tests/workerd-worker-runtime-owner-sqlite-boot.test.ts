import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpenWorkerdWorkerRuntimeOwnerOptions,
  openWorkerdWorkerRuntimeOwner,
} from "../src/workerd-worker-runtime-owner.ts";

test("SQLite native owner rejects an unscoped or incomplete private boot binder before touching custody", async () => {
  const base: OpenWorkerdWorkerRuntimeOwnerOptions = {
    rootDirectory: join(tmpdir(), "unopened-v2-sqlite-owner-boot"),
    workerResourceUid: "worker-sqlite-boot",
    targetKey: "sqlite-boot-target",
    publicationState: {
      async resolve() {
        throw new Error("must not resolve publication");
      },
    },
    workerdBinary: null,
    listenerPortForOperation: async () => 12345,
  };
  const valid = {
    address: "127.0.0.1:12345",
    issueGrant: () => "unused",
    resolveCurrentBinding: async () => null,
  };
  for (const candidate of [
    { ...valid, address: "0.0.0.0:12345" },
    { ...valid, address: "127.0.0.1:0" },
    { ...valid, address: "127.0.0.1:65536" },
    { ...valid, issueGrant: null },
    { ...valid, resolveCurrentBinding: null },
  ]) {
    await expect(
      openWorkerdWorkerRuntimeOwner({
        ...base,
        v2SqliteBinding: candidate as unknown as NonNullable<
          OpenWorkerdWorkerRuntimeOwnerOptions["v2SqliteBinding"]
        >,
      }),
    ).rejects.toMatchObject({ code: "invalid_identity" });
  }
});
