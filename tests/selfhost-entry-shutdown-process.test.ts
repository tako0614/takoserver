import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fixtureLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("shutdown fixture exited before readiness");
      text += new TextDecoder().decode(chunk.value);
      if (text.length > 1024) throw new Error("invalid shutdown fixture readiness");
    }
    return text.trim();
  } finally {
    reader.releaseLock();
  }
}

async function readiness(stream: ReadableStream<Uint8Array>): Promise<{
  ingressPort: number;
  dependentPort: number;
  pid: number;
}> {
  return JSON.parse(await fixtureLine(stream));
}

const ordered = [
  "ingress",
  "workerd-reap",
  "v2-worker-suspend",
  "actor-close",
  "data-plane-close",
  "control-database-close",
] as const;

for (const failure of [
  "v2-worker-suspend",
  ...ordered.filter((name) => name !== "v2-worker-suspend"),
  "success",
]) {
  test(`Host process exits after ${failure} without closing unproved dependents`, async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-shutdown-failure-"));
    const custodyPath = join(root, "custody.json");
    const custody = '{"state":"active","identity":"synthetic-retained-custody"}\n';
    await writeFile(custodyPath, custody, { mode: 0o600 });
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/selfhost-entry-shutdown-process.ts"),
        failure,
        root,
      ],
      { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const ports = await bounded(readiness(child.stdout), 10_000, "Host readiness timed out");
      const plane = await fetch(`http://127.0.0.1:${ports.dependentPort}`);
      expect(await plane.text()).toBe("dependent plane");
      child.kill("SIGTERM");
      const code = await bounded(
        child.exited,
        5_000,
        "Host stayed alive after a settled shutdown failure",
      );
      expect(code).toBe(failure === "success" ? 0 : 1);
      const calls = (await readFile(join(root, "calls.log"), "utf8")).trim().split("\n");
      const expected: string[] =
        failure === "success"
          ? [...ordered]
          : [...ordered.slice(0, ordered.indexOf(failure as (typeof ordered)[number]) + 1)];
      if (failure !== "success" && failure !== "ingress") expected.push(`failed:${failure}`);
      expect(calls).toEqual(expected);
      expect(await readFile(custodyPath, "utf8")).toBe(custody);
      const diagnostic = await new Response(child.stderr).text();
      expect(diagnostic).toBe(
        failure === "success"
          ? ""
          : `${failure === "ingress" ? "" : `self-host shutdown failed at ${failure}\n`}self-host shutdown incomplete at ${failure === "ingress" ? "ingress" : "cleanup"}\n`,
      );
      for (const port of [ports.ingressPort, ports.dependentPort]) {
        await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await bounded(child.exited, 5_000, "fixture Host exit unconfirmed during cleanup");
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
}

async function generateLocalCertificate(root: string) {
  const certificatePath = join(root, "certificate.pem");
  const generator = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "private-key.pem"),
      "-out",
      certificatePath,
      "-days",
      "2",
      "-subj",
      "/CN=*.example.test",
      "-addext",
      "subjectAltName=DNS:*.example.test",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  try {
    if ((await bounded(generator.exited, 5_000, "TLS fixture generation timed out")) !== 0)
      throw new Error("local OpenSSL certificate fixture failed");
    return await readFile(certificatePath, "utf8");
  } finally {
    if (generator.exitCode === null) generator.kill("SIGKILL");
    await bounded(generator.exited, 5_000, "TLS fixture generator remained active");
  }
}

function containerGet(port: number, path: string, ca: string) {
  const host = `ce-${"0".repeat(40)}.example.test`;
  const request = httpsGet({
    hostname: "127.0.0.1",
    port,
    path,
    headers: { host },
    servername: host,
    ca,
    agent: false,
  });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  return { request, response };
}

test(
  "Host process receives SIGTERM, fences new Container HTTPS requests, and closes owners after EOF",
  () => containerShutdown(false),
  20_000,
);

test(
  "Host process exits nonzero at the opt-in deadline while the Container HTTPS body remains open",
  () => containerShutdown(true),
  20_000,
);

async function containerShutdown(deadline: boolean) {
  const root = await mkdtemp(join(tmpdir(), "takoserver-shutdown-container-"));
  let request: ClientRequest | undefined;
  try {
    const ca = await generateLocalCertificate(root);
    const graceMs = 1_000;
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/selfhost-entry-shutdown-process.ts"),
        deadline ? "container-deadline" : "container-stream",
        root,
        ...(deadline ? [String(graceMs)] : []),
      ],
      { env: { PATH: process.env.PATH ?? "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const { ingressPort, dependentPort, pid } = await bounded(
        readiness(child.stdout),
        5_000,
        "Container HTTPS Host readiness timed out",
      );
      expect(pid).toBe(child.pid);
      const opened = containerGet(ingressPort, "/held", ca);
      request = opened.request;
      const response = await bounded(opened.response, 3_000, "held TLS response missing");
      expect(response.statusCode).toBe(200);
      const body = response[Symbol.asyncIterator]();
      const first = await bounded(body.next(), 3_000, "held TLS body did not start");
      expect(first.done).toBe(false);
      expect(String(first.value)).toBe("held body\n");
      const terminal = body.next().then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const started = performance.now();
      child.kill("SIGTERM");
      expect(await bounded(fixtureLine(child.stdout), 3_000, "ingress fence timed out")).toBe(
        "ingress-fenced",
      );

      const probe = containerGet(ingressPort, "/fresh", ca);
      try {
        const admission = await bounded(
          probe.response.then(
            (admitted) => admitted.statusCode,
            () => undefined,
          ),
          3_000,
          "new Container HTTPS admission remained open",
        );
        expect(admission).not.toBe(200);
      } finally {
        probe.request.destroy();
      }
      const plane = await bounded(
        fetch(`http://127.0.0.1:${dependentPort}`, { signal: AbortSignal.timeout(3_000) }),
        3_000,
        "dependent plane not available while the body remains open",
      );
      expect(await plane.text()).toBe("dependent plane");
      const calls = async () =>
        (await readFile(join(root, "calls.log"), "utf8")).trim().split("\n");
      expect(await calls()).toEqual(["ingress"]);
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(pid, 0)).not.toThrow();

      if (!deadline) {
        child.stdin.write("release\n");
        child.stdin.end();
        expect(await bounded(terminal, 3_000, "original TLS client did not receive EOF")).toEqual({
          result: { done: true, value: undefined },
        });
      }
      expect(await bounded(child.exited, 5_000, "old Host process did not exit")).toBe(
        deadline ? 1 : 0,
      );
      if (deadline) expect(performance.now() - started).toBeGreaterThanOrEqual(graceMs - 25);
      expect(await calls()).toEqual(
        deadline ? ["ingress"] : ["ingress", "body-eof", ...ordered.slice(1)],
      );
      expect(await new Response(child.stderr).text()).toBe(
        deadline ? "self-host shutdown incomplete at ingress\n" : "",
      );
    } finally {
      request?.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
      await bounded(child.exited, 5_000, "old fixture Host exit unconfirmed during cleanup");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
