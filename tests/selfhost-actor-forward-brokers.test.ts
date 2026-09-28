import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
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

test("Actor HTTP broker preserves repeated Set-Cookie response fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-forward-cookies-"));
  const token = "c".repeat(64);
  const cookies = [
    "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; HttpOnly",
    "csrf=two; Path=/; SameSite=Strict",
  ];
  try {
    const brokers = await openSelfhostActorForwardBrokers({
      tenantId: "tenant-one",
      namespaceResourceUid: "uid-actor-namespace-one",
      token,
      httpSocketPath: join(root, "http.sock"),
      upgradeSocketPath: join(root, "upgrade.sock"),
      executionHost: {
        async fetch() {
          const headers = new Headers([["x-actor-response", "kept"]]);
          for (const cookie of cookies) headers.append("set-cookie", cookie);
          return new Response("cookie-bearing response", { status: 201, headers });
        },
        async reserveDuplex() {
          throw new Error("unexpected duplex reservation");
        },
      },
    });
    try {
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath: brokers.socketMapping.httpSocketPath,
            path: "http://actor.invalid/session",
            headers: {
              "x-takoserver-private-broker-token": token,
              "x-takoserver-private-broker-actor-id": encodeURIComponent("room-one"),
            },
          },
          resolve,
        );
        request.once("error", reject);
        request.end();
      });
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      const responseCookies: string[] = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (response.rawHeaders[index]?.toLowerCase() === "set-cookie") {
          responseCookies.push(response.rawHeaders[index + 1] ?? "");
        }
      }

      expect(response.statusCode).toBe(201);
      expect(response.headers["x-actor-response"]).toBe("kept");
      expect(responseCookies).toEqual(cookies);
      expect(Buffer.concat(chunks).toString()).toBe("cookie-bearing response");
    } finally {
      await brokers.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
