import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiGatewayError } from "../src/ai-port.ts";
import { createOpenAiGateway } from "../src/providers/openai.ts";

const model = {
  id: "takoserver-text",
  upstreamId: "@cf/provider/model-v1",
  created: 1_787_054_400,
  ownedBy: "takoserver",
  limits: { maxInputTokens: 24_000, maxOutputTokens: 4_096 },
  price: { inputMinorPerMillionTokens: 40, outputMinorPerMillionTokens: 300 },
} as const;

const UPSTREAM_SECRET = "synthetic-openai-loopback-secret";
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 128 * 1024;

let tlsRoot: string;
let certificate: string;
let privateKey: string;
const servers: Server[] = [];

beforeEach(() => {
  tlsRoot = mkdtempSync(join(tmpdir(), "takoserver-openai-loopback-"));
  const certPath = join(tlsRoot, "localhost-cert.pem");
  const keyPath = join(tlsRoot, "localhost-key.pem");
  const openssl = Bun.which("openssl");
  if (!openssl) throw new Error("openssl is required for the native HTTPS loopback test");

  const generated = Bun.spawnSync([
    openssl,
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  if (generated.exitCode !== 0) {
    throw new Error(
      `could not create the test-only HTTPS certificate: ${generated.stderr.toString()}`,
    );
  }

  chmodSync(tlsRoot, 0o700);
  chmodSync(certPath, 0o600);
  chmodSync(keyPath, 0o600);
  certificate = readFileSync(certPath, "utf8");
  privateKey = readFileSync(keyPath, "utf8");
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  if (tlsRoot) rmSync(tlsRoot, { recursive: true, force: true });
});

test("the allowlisted completion uses native HTTPS and returns no upstream identity or credential", async () => {
  let upstreamRequest: IncomingMessage | undefined;
  let upstreamBody = "";
  const server = await startServer((request, response) => {
    upstreamRequest = request;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (upstreamBody += chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl_loopback",
          object: "chat.completion",
          created: 1_787_054_400,
          model: "@cf/provider/model-v1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello from loopback" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
  });

  const result = await gatewayFor(server).chat(
    { model: "takoserver-text", messages: [{ role: "user", content: "hello" }] },
    { requestId: "ai_loopback", idempotencyKey: "chat-loopback" },
  );

  expect(result).toMatchObject({ model: "takoserver-text" });
  expect(upstreamRequest?.url).toBe("/v1/chat/completions");
  expect(upstreamRequest?.headers.authorization).toBe(`Bearer ${UPSTREAM_SECRET}`);
  expect(upstreamRequest?.headers["idempotency-key"]).toBe("chat-loopback");
  expect(upstreamRequest?.headers["x-request-id"]).toBe("ai_loopback");
  expect(JSON.parse(upstreamBody)).toMatchObject({ model: "@cf/provider/model-v1", stream: false });
  expect(JSON.stringify(result)).not.toContain("@cf/provider/model-v1");
  expect(JSON.stringify(result)).not.toContain(UPSTREAM_SECRET);
});

test("an oversized streamed completion is classified and closes the upstream connection", async () => {
  let chunksWritten = 0;
  let bytesWritten = 0;
  let connectionClosed = false;
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => {
      chunksWritten += 1;
      bytesWritten += STREAM_CHUNK_BYTES;
      const chunk = Buffer.alloc(STREAM_CHUNK_BYTES, 0x20);
      if (chunksWritten === 1) Buffer.from(UPSTREAM_SECRET, "utf8").copy(chunk);
      response.write(chunk);
    }, 10);
    response.on("close", () => {
      connectionClosed = true;
      clearInterval(timer);
    });
  });

  const error = await gatewayFor(server)
    .chat(
      { model: "takoserver-text", messages: [{ role: "user", content: "hello" }] },
      { requestId: "ai_oversized", idempotencyKey: "chat-oversized" },
    )
    .catch((caught: unknown) => caught);
  await waitFor(() => connectionClosed);

  expect(error).toBeInstanceOf(AiGatewayError);
  expect((error as AiGatewayError).code).toBe("invalid_response");
  expect(String(error)).not.toContain(UPSTREAM_SECRET);
  expect(connectionClosed).toBe(true);
  expect(chunksWritten).toBeGreaterThan(0);
  expect(bytesWritten).toBeLessThanOrEqual(RESPONSE_LIMIT_BYTES + 3 * STREAM_CHUNK_BYTES);
});

test("a native upstream disconnect before response headers is classified without leaking transport detail", async () => {
  let requestAccepted = false;
  const server = await startServer((request) => {
    requestAccepted = true;
    request.socket.destroy();
  });

  const error = await gatewayFor(server)
    .chat(
      { model: "takoserver-text", messages: [{ role: "user", content: "hello" }] },
      { requestId: "ai_disconnect", idempotencyKey: "chat-disconnect" },
    )
    .catch((caught: unknown) => caught);

  expect(requestAccepted).toBe(true);
  expect(error).toBeInstanceOf(AiGatewayError);
  expect((error as AiGatewayError).code).toBe("unavailable");
  expect(String(error)).not.toContain(UPSTREAM_SECRET);
});

function gatewayFor(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("loopback server has no TCP address");
  return createOpenAiGateway({
    baseUrl: `https://127.0.0.1:${address.port}/v1`,
    models: [model],
    authorize: () => `Bearer ${UPSTREAM_SECRET}`,
    timeoutMs: 5_000,
    fetch(request) {
      // This is still Bun's native HTTP transport. Only the ephemeral test CA is
      // added; certificate and hostname verification remain enabled.
      return fetch(request, { tls: { ca: certificate } } as RequestInit & { tls: { ca: string } });
    },
  });
}

async function startServer(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server> {
  const server = createServer({ cert: certificate, key: privateKey }, handle);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
