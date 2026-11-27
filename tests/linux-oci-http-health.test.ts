import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { createLinuxOciHttpHealthProbe } from "../src/providers/linux-oci-http-health.ts";

// Only the Node HTTP transport is modeled. No socket is opened, and these
// status/close facts establish neither original native custody nor readiness.
function rawHttp() {
  const calls: unknown[] = [];
  const response = new EventEmitter();
  const request = new EventEmitter();
  let requestDestroy = 0,
    responseDestroy = 0,
    ends = 0;
  let onConstruct: () => void = () => undefined;
  let onEnd: () => void = () => undefined;
  Object.assign(request, {
    destroy() {
      requestDestroy++;
      return request;
    },
    end() {
      ends++;
      onEnd();
      return request;
    },
  });
  Object.assign(response, {
    statusCode: 204,
    destroy() {
      responseDestroy++;
      return response;
    },
  });
  // The cast is confined to this raw Node transport boundary; no product
  // owner, probe factory, guard, private brand or readiness result is replaced.
  const mock = spyOn(http, "request").mockImplementation(((options: unknown) => {
    calls.push(options);
    onConstruct();
    return request;
  }) as unknown as typeof http.request);
  if (!Object.is(importedRequest, http.request)) throw new Error("raw HTTP interception absent");
  return {
    request,
    response,
    calls,
    counts: () => ({ requestDestroy, responseDestroy, ends }),
    onConstruct(callback: () => void) {
      onConstruct = callback;
    },
    onEnd(callback: () => void) {
      onEnd = callback;
    },
    reply(statusCode = 204) {
      Object.assign(response, { statusCode });
      request.emit("response", response);
    },
    joined() {
      response.emit("close");
      request.emit("close");
    },
    restore() {
      mock.mockRestore();
    },
  };
}
const options = {
  address: "10.77.0.1",
  httpPort: 8080,
  healthPath: "/health",
  timeoutMs: 100,
};

test("OCI HTTP fixed numeric GET waits for both actual close events", async () => {
  const raw = rawHttp();
  const probe = createLinuxOciHttpHealthProbe(options);
  let settled = false;
  try {
    const observation = probe.observe(new AbortController().signal);
    void observation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    expect(raw.calls).toEqual([
      {
        protocol: "http:",
        hostname: "10.77.0.1",
        family: 4,
        port: 8080,
        path: "/health",
        method: "GET",
        agent: false,
        maxHeaderSize: 8192,
        headers: { Connection: "close" },
      },
    ]);
    raw.reply(204);
    await Promise.resolve();
    expect(settled).toBe(false);
    raw.request.emit("close");
    await Promise.resolve();
    expect(settled).toBe(false);
    raw.response.emit("close");
    expect(await observation).toEqual({ statusCode: 204 });
    expect(raw.counts()).toEqual({ requestDestroy: 1, responseDestroy: 1, ends: 1 });
    await probe.close();
    await expect(probe.observe(new AbortController().signal)).rejects.toThrow("already_attempted");
    expect(raw.calls).toHaveLength(1);
  } finally {
    raw.joined();
    await probe.close();
    raw.restore();
  }
});

test("OCI HTTP rejects redirect and error status without another request", async () => {
  for (const status of [302, 500]) {
    const raw = rawHttp();
    const probe = createLinuxOciHttpHealthProbe(options);
    try {
      const observation = probe.observe(new AbortController().signal);
      raw.reply(status);
      raw.joined();
      await expect(observation).rejects.toThrow("unavailable");
      expect(raw.calls).toHaveLength(1);
      expect(raw.counts()).toEqual({ requestDestroy: 1, responseDestroy: 1, ends: 1 });
    } finally {
      await probe.close();
      raw.restore();
    }
  }
});

test("OCI HTTP preserves original health path domain and canonical ULA peer", async () => {
  const raw = rawHttp();
  const healthPath = "/%E3%81%82/status";
  const probe = createLinuxOciHttpHealthProbe({ ...options, address: "fd77::1", healthPath });
  try {
    const observation = probe.observe(new AbortController().signal);
    raw.reply(200);
    raw.joined();
    expect(await observation).toEqual({ statusCode: 200 });
    expect(raw.calls).toEqual([
      {
        protocol: "http:",
        hostname: "fd77::1",
        family: 6,
        port: 8080,
        path: healthPath,
        method: "GET",
        agent: false,
        maxHeaderSize: 8192,
        headers: { Connection: "close" },
      },
    ]);
  } finally {
    await probe.close();
    raw.restore();
  }
});

test("OCI HTTP invalid peer or accepted service data has zero raw effect", () => {
  const raw = rawHttp();
  try {
    for (const changed of [
      { address: "tenant.example" },
      { address: "127.0.0.1" },
      { address: "169.254.169.254" },
      { address: "10.77.0.0" },
      { address: "fe80::1" },
      { address: "::ffff:10.77.0.1" },
      { httpPort: 0 },
      { httpPort: 65536 },
      { healthPath: "//foreign.example/" },
      { healthPath: "/%252e%252e/" },
      { timeoutMs: 0 },
    ])
      expect(() => createLinuxOciHttpHealthProbe({ ...options, ...changed })).toThrow(
        "invalid_request",
      );
    expect(raw.calls).toEqual([]);
  } finally {
    raw.restore();
  }
});

test("OCI HTTP cancellation after last close cannot return a positive status fact", async () => {
  const raw = rawHttp();
  const controller = new AbortController();
  const probe = createLinuxOciHttpHealthProbe(options);
  raw.onEnd(() => {
    raw.reply();
    raw.joined();
    controller.abort();
  });
  try {
    await expect(probe.observe(controller.signal)).rejects.toThrow("unavailable");
    expect(raw.calls).toHaveLength(1);
    expect(raw.counts()).toEqual({ requestDestroy: 1, responseDestroy: 1, ends: 1 });
  } finally {
    await probe.close();
    raw.restore();
  }
});

test("OCI HTTP timeout retains the same handle for late join without resending", async () => {
  const raw = rawHttp();
  const probe = createLinuxOciHttpHealthProbe({ ...options, timeoutMs: 5 });
  try {
    await expect(probe.observe(new AbortController().signal)).rejects.toThrow("unavailable");
    await expect(probe.close()).rejects.toThrow("custody_retained");
    expect(raw.counts()).toEqual({ requestDestroy: 1, responseDestroy: 0, ends: 1 });
    raw.request.emit("close");
    await probe.close();
    expect(raw.calls).toHaveLength(1);
    expect(raw.counts()).toEqual({ requestDestroy: 1, responseDestroy: 0, ends: 1 });
  } finally {
    raw.request.emit("close");
    await probe.close();
    raw.restore();
  }
});

test("OCI HTTP close reentry during the raw constructor joins its original scope", async () => {
  const raw = rawHttp();
  const probe = createLinuxOciHttpHealthProbe(options);
  let closing: Promise<void> | undefined;
  let closed = false;
  raw.onConstruct(() => {
    closing = probe.close();
    void closing.then(
      () => {
        closed = true;
      },
      () => undefined,
    );
  });
  try {
    const observation = probe.observe(new AbortController().signal);
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(raw.counts()).toEqual({ requestDestroy: 1, responseDestroy: 0, ends: 0 });
    raw.request.emit("close");
    await expect(observation).rejects.toThrow("unavailable");
    if (!closing) throw new Error("raw reentry did not occur");
    await closing;
    expect(closed).toBe(true);
    expect(raw.calls).toHaveLength(1);
  } finally {
    raw.request.emit("close");
    await probe.close();
    raw.restore();
  }
});

test("OCI HTTP closed or already aborted probes make no raw request", async () => {
  const raw = rawHttp();
  const closed = createLinuxOciHttpHealthProbe(options);
  const aborted = createLinuxOciHttpHealthProbe(options);
  const controller = new AbortController();
  controller.abort();
  try {
    await closed.close();
    await expect(closed.observe(new AbortController().signal)).rejects.toThrow("already_attempted");
    await expect(aborted.observe(controller.signal)).rejects.toThrow("unavailable");
    await expect(aborted.observe(new AbortController().signal)).rejects.toThrow(
      "already_attempted",
    );
    expect(raw.calls).toEqual([]);
  } finally {
    await aborted.close();
    raw.restore();
  }
});
