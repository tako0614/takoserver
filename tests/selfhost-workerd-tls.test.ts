import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalWorkerEndpointOrigin } from "../src/provider-worker-endpoint-origin.ts";
import {
  SELFHOST_TLS_ENVIRONMENT,
  selfhostWorkerEndpointScheme,
} from "../src/selfhost-composition.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { findWorkerd } from "../src/workerd-supervisor.ts";

/**
 * The scheme the Host publishes and the scheme the socket serves are the same
 * fact.
 *
 * They were not. `canonicalWorkerEndpointOrigin` forced `https` while the
 * generated `workerd.capnp` ended `sockets = [ ( ... http = (), ... ) ]`, so a
 * self-host advertised an `https://` address nothing answered on. On the
 * loopback default the Worker behind it quietly pinned the `http` origin its
 * own requests arrived under; on any other suffix the same Worker would refuse
 * to establish an origin at all, and the Takoform module has no way to pass one
 * in.
 */

const WORKERD = findWorkerd(resolve(import.meta.dir, ".."));
const HOSTNAME = "tls-probe.localhost";

let root: string;
let workerd: { kill(): void; readonly exited: Promise<number> } | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-tls-"));
});

afterEach(async () => {
  if (workerd) {
    // Waited out rather than merely signalled: a 150 MB runtime still holding
    // its socket while the next file starts one of its own is how a suite
    // becomes flaky.
    workerd.kill();
    await workerd.exited;
    workerd = undefined;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a self-host with no certificate publishes the http address its socket serves", async () => {
  const runtime = createWorkerdRuntime({ root, port: 18_799, isReady: () => true });
  await runtime.write(
    "sw-plain",
    { directory: "sw-plain", mainModule: "index.js", hostnames: [HOSTNAME] },
    new Map([["index.js", new TextEncoder().encode(MODULE)]]),
  );
  await runtime.reload();
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain('( name = "http", address = "*:18799", http = (), service = "router" )');
  expect(config).not.toContain("tlsOptions");

  // And the Host publishes that, rather than an https address it cannot serve.
  expect(selfhostWorkerEndpointScheme({ tlsConfigured: false }).scheme).toBe("http");
  expect(canonicalWorkerEndpointOrigin("sw-plain", "localhost", "http")).toBe(
    "http://sw-plain.localhost",
  );
});

test("a non-loopback suffix with no certificate says plainly that no identity can be established", () => {
  const loopback = selfhostWorkerEndpointScheme({
    workerEndpointSuffix: "localhost",
    tlsConfigured: false,
  });
  expect(loopback).toEqual({ scheme: "http" });

  const exposed = selfhostWorkerEndpointScheme({
    workerEndpointSuffix: "workers.example.test",
    tlsConfigured: false,
  });
  expect(exposed.scheme).toBe("http");
  expect(exposed.warning).toContain("http://<script>.workers.example.test");
  expect(exposed.warning).toContain("establish no origin at all");
  expect(exposed.warning).toContain(SELFHOST_TLS_ENVIRONMENT.certificateFile);
  expect(exposed.warning).toContain(SELFHOST_TLS_ENVIRONMENT.privateKeyFile);

  // With a certificate there is nothing to warn about and the address is https.
  expect(
    selfhostWorkerEndpointScheme({
      workerEndpointSuffix: "workers.example.test",
      tlsConfigured: true,
    }),
  ).toEqual({ scheme: "https" });
});

test.skipIf(WORKERD === null)(
  "a configured certificate makes the socket serve TLS on the address the Host publishes",
  async () => {
    const keypair = await selfSignedKeypair();
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(reserved.port);
    reserved.stop(true);

    const runtime = createWorkerdRuntime({ root, port, tls: keypair, isReady: () => true });
    await runtime.write(
      "sw-tls",
      { directory: "sw-tls", mainModule: "index.js", hostnames: [HOSTNAME] },
      new Map([["index.js", new TextEncoder().encode(MODULE)]]),
    );
    await runtime.reload();

    const configPath = join(root, "workers", "workerd.capnp");
    const config = await readFile(configPath, "utf8");
    expect(config).toContain(`( name = "https", address = "*:${port}", https = ( options = ()`);
    expect(config).toContain("tlsOptions = ( keypair = ( privateKey = ");
    // The generated configuration already held every binding value; the key
    // does not change what it is, only how carefully it must be written.
    expect(existsSync(configPath)).toBe(true);

    workerd = Bun.spawn([WORKERD as string, "serve", configPath], {
      stdout: "ignore",
      stderr: "ignore",
    });

    // A real TLS handshake against the socket workerd bound, answered by the
    // script the Host published on the address the Host advertises.
    let answered: Response | null = null;
    for (let attempt = 0; attempt < 60 && !answered; attempt += 1) {
      try {
        answered = await fetch(`https://127.0.0.1:${port}/`, {
          headers: { host: HOSTNAME },
          tls: { rejectUnauthorized: false },
          signal: AbortSignal.timeout(500),
        });
      } catch {
        await new Promise<void>((wake) => setTimeout(wake, 100));
      }
    }
    if (!answered) throw new Error("the TLS socket never answered");
    expect(answered.status).toBe(200);
    expect(await answered.text()).toBe("served over tls");

    // Plain HTTP against a TLS socket is not a downgrade path.
    await expect(
      fetch(`http://127.0.0.1:${port}/`, {
        headers: { host: HOSTNAME },
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toBeDefined();

    expect(selfhostWorkerEndpointScheme({ tlsConfigured: true }).scheme).toBe("https");
    expect(canonicalWorkerEndpointOrigin("sw-tls", "localhost", "https")).toBe(
      "https://sw-tls.localhost",
    );
  },
  60_000,
);

const MODULE = `export default {
  async fetch() {
    return new Response("served over tls");
  },
};
`;

/**
 * A throwaway certificate for this test alone, minted here rather than checked
 * in: a private key in the repository is a private key in the repository, even
 * one that only ever names `*.localhost`.
 */
async function selfSignedKeypair(): Promise<{
  readonly privateKey: string;
  readonly certificateChain: string;
}> {
  const keyPath = join(root, "tls-key.pem");
  const certificatePath = join(root, "tls-cert.pem");
  const openssl = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=selfhost-tls-test",
      "-addext",
      `subjectAltName=DNS:${HOSTNAME},DNS:localhost,IP:127.0.0.1`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  expect(await openssl.exited).toBe(0);
  return {
    privateKey: await readFile(keyPath, "utf8"),
    certificateChain: await readFile(certificatePath, "utf8"),
  };
}
