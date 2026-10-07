import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfhostV2WorkerEndpointHttpsListener,
  verifySelfhostV2WorkerEndpointHttpsSni,
} from "../src/selfhost-v2-worker-endpoint-https.ts";
import type { V2EndpointTlsObservation } from "../src/takoform-v2/worker-endpoint-backend.ts";

type V2WorkerEndpointAddress = Omit<V2EndpointTlsObservation, "ready">;

const suffix = "workers.example.test";
const address: V2WorkerEndpointAddress = {
  endpointUid: "r_endpoint1",
  workerUid: "r_worker1",
  hostname: `v2-${"a".repeat(32)}.${suffix}`,
  url: `https://v2-${"a".repeat(32)}.${suffix}/`,
};

async function certificateFixture(subjectAltName = `DNS:*.${suffix}`) {
  const directory = await mkdtemp(join(tmpdir(), "takoserver-v2-worker-endpoint-https-"));
  await chmod(directory, 0o700);
  const certificatePath = join(directory, "certificate.pem");
  const privateKeyPath = join(directory, "private-key.pem");
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-days",
      "2",
      "-subj",
      `/CN=${subjectAltName.replace(/^DNS:/u, "")}`,
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await child.exited) !== 0) throw new Error("temporary TLS certificate generation failed");
  await chmod(privateKeyPath, 0o600);
  return {
    certificateChain: await readFile(certificatePath, "utf8"),
    privateKey: await readFile(privateKeyPath, "utf8"),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function createLoopbackListener(input: {
  readonly certificateChain: string;
  readonly privateKey: string;
  readonly fetch: (request: Request) => Promise<Response | null>;
}) {
  let loopbackPort: number | undefined;
  const sniNames: string[] = [];
  const listener = await createSelfhostV2WorkerEndpointHttpsListener({
    configuration: { workerEndpointSuffix: suffix, port: 443 },
    ...input,
    factories: {
      serve(options) {
        const server = Bun.serve({ ...options, port: 0, hostname: "127.0.0.1" });
        loopbackPort = server.port;
        // Tests remap the required logical 443 to an OS-selected loopback port.
        return { port: 443, stop: (force) => server.stop(force) };
      },
      async proveSni(probe) {
        if (loopbackPort === undefined) throw new Error("test listener was not created");
        sniNames.push(probe.hostname);
        await verifySelfhostV2WorkerEndpointHttpsSni({
          ...probe,
          host: "127.0.0.1",
          port: loopbackPort,
        });
      },
    },
  });
  if (loopbackPort === undefined) throw new Error("test listener was not created");
  return { listener, port: loopbackPort, sniNames };
}

function get(port: number, host: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        servername: host,
        path,
        headers: { host },
        rejectUnauthorized: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("test HTTPS request timed out")));
    request.once("error", reject);
    request.end();
  });
}

test("V2 Worker Endpoint HTTPS serves exact suffix hosts and witnesses current local SNI", async () => {
  const fixture = await certificateFixture();
  let dispatched = 0;
  const { listener, port, sniNames } = await createLoopbackListener({
    ...fixture,
    fetch: async (request) => {
      dispatched++;
      expect(new URL(request.url).hostname).toBe(address.hostname);
      return new Response(`served:${new URL(request.url).pathname}`);
    },
  });
  try {
    await expect(listener.witness.observeTls(address)).resolves.toEqual({
      ...address,
      ready: true,
    });
    expect(sniNames).toContain(address.hostname);
    expect(await get(port, address.hostname, "/hello")).toEqual({
      status: 200,
      body: "served:/hello",
    });
    expect(dispatched).toBe(1);
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toEqual({
      ...address,
      absent: true,
    });
    const foreign = await get(port, "elsewhere.example.test", "/not-dispatched");
    expect(foreign.status).toBe(404);
    expect(dispatched).toBe(1);
    await listener.close();
    await expect(listener.witness.observeTls(address)).resolves.toEqual({
      ...address,
      ready: false,
    });
  } finally {
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("witness rejects a noncanonical or foreign Endpoint address", async () => {
  const fixture = await certificateFixture();
  const { listener, port, sniNames } = await createLoopbackListener({
    ...fixture,
    fetch: async () => new Response("unexpected"),
  });
  try {
    const foreign = {
      ...address,
      hostname: `v2-${"b".repeat(32)}.foreign.example.test`,
      url: `https://v2-${"b".repeat(32)}.foreign.example.test/`,
    };
    await expect(listener.witness.observeTls(foreign)).resolves.toEqual({
      ...foreign,
      ready: false,
    });
    await expect(listener.witness.observeRouteAbsent(foreign)).resolves.toEqual({
      ...foreign,
      absent: false,
    });
    expect(sniNames).toEqual([`tls-probe.${suffix}`]);
    expect(await get(port, "wrong.other.test")).toEqual({ status: 404, body: "" });
  } finally {
    await listener.close();
    await fixture.cleanup();
  }
});

test("listener rejects noncanonical suffix and validates matching wildcard cert before binding", async () => {
  const fixture = await certificateFixture();
  const wrongWildcard = await certificateFixture("DNS:*.unrelated.example.test");
  let serves = 0;
  const factories = {
    serve() {
      serves++;
      throw new Error("must not bind");
    },
    proveSni: async () => {},
  };
  try {
    await expect(
      createSelfhostV2WorkerEndpointHttpsListener({
        configuration: { workerEndpointSuffix: "Workers.example.test", port: 443 },
        ...fixture,
        fetch: async () => null,
        factories,
      }),
    ).rejects.toThrow("canonical reserved DNS suffix");
    await expect(
      createSelfhostV2WorkerEndpointHttpsListener({
        configuration: { workerEndpointSuffix: suffix, port: 443 },
        certificateChain: wrongWildcard.certificateChain,
        privateKey: wrongWildcard.privateKey,
        fetch: async () => null,
        factories,
      }),
    ).rejects.toThrow("cover the configured wildcard");
    await expect(
      createSelfhostV2WorkerEndpointHttpsListener({
        configuration: { workerEndpointSuffix: suffix, port: 443 },
        certificateChain: fixture.certificateChain,
        privateKey: "not a private key",
        fetch: async () => null,
        factories,
      }),
    ).rejects.toThrow("private key is invalid");
    expect(serves).toBe(0);
  } finally {
    await fixture.cleanup();
    await wrongWildcard.cleanup();
  }
});
