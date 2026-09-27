import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSelfhostActorForwardBrokers } from "../src/selfhost-actor-forward-brokers.ts";

test("Actor forward brokers bind exact Host scope and reject unauthenticated calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-forward-brokers-"));
  const calls: unknown[] = [];
  const token = "b".repeat(64);
  const options = {
    tenantId: "tenant-one",
    namespaceResourceUid: "uid-actor-namespace-one",
    token,
    httpSocketPath: join(root, "http.sock"),
    upgradeSocketPath: join(root, "upgrade.sock"),
    executionHost: {
      async fetch(scope: unknown, request: Request) {
        calls.push({ scope, path: new URL(request.url).pathname });
        return new Response("selected Actor HTTP");
      },
      async reserveDuplex() {
        throw new Error("unauthorized reservation reached Host");
      },
    },
  };
  try {
    const brokers = await openSelfhostActorForwardBrokers(options);
    try {
      expect(brokers.socketMapping).toEqual({
        tenantId: options.tenantId,
        namespaceResourceUid: options.namespaceResourceUid,
        httpSocketPath: options.httpSocketPath,
        upgradeSocketPath: options.upgradeSocketPath,
      });
      const id = "room/日本語";
      const denied = await fetch("http://actor.invalid/probe", {
        unix: brokers.socketMapping.httpSocketPath,
        headers: { "x-takoserver-private-broker-actor-id": encodeURIComponent(id) },
      });
      expect(denied.status).toBe(404);
      const response = await fetch("http://actor.invalid/probe", {
        unix: brokers.socketMapping.httpSocketPath,
        headers: {
          "x-takoserver-private-broker-token": token,
          "x-takoserver-private-broker-actor-id": encodeURIComponent(id),
        },
      });
      expect(await response.text()).toBe("selected Actor HTTP");
      expect(calls).toEqual([
        {
          scope: {
            tenantId: options.tenantId,
            namespaceResourceUid: options.namespaceResourceUid,
            id,
          },
          path: "/probe",
        },
      ]);
      const unauthenticatedUpgrade = await fetch("http://actor.invalid/socket", {
        unix: brokers.socketMapping.upgradeSocketPath,
        redirect: "manual",
      });
      expect(unauthenticatedUpgrade.status).toBe(404);
      expect(calls).toHaveLength(1);
    } finally {
      await brokers.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
