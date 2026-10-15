import { randomUUID } from "node:crypto";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import { createSelfhostContainerBindingBroker } from "./selfhost-container-binding-broker.ts";

/** A fresh private Unix socket; no Docker or native endpoint reaches workerd. */
export async function openSelfhostContainerBindingSocket(
  options: Parameters<typeof createSelfhostContainerBindingBroker>[0] & {
    readonly directory: string;
  },
) {
  const directory = await realpath(options.directory);
  const metadata = await lstat(options.directory);
  if (
    directory !== options.directory ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.uid !== process.getuid?.()
  )
    throw new TypeError("private broker directory required");
  const path = join(directory, `${randomUUID().replaceAll("-", "").slice(0, 22)}.sock`);
  if (Buffer.byteLength(path) > 100) throw new TypeError("broker socket path too long");
  const broker = createSelfhostContainerBindingBroker(options);
  const server = createServer({ maxHeaderSize: 65_536 }, async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.on("aborted", () => abort.abort());
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) abort.abort();
    });
    try {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2)
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      const body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
      const result = await broker(
        new Request(`http://broker.invalid${incoming.url ?? "/"}`, {
          method: incoming.method ?? "POST",
          headers,
          body,
          signal: abort.signal,
          ...({ duplex: "half" } as { duplex: "half" }),
        }),
      );
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.flushHeaders();
      if (result.body) {
        const input = result.body.getReader();
        const cancel = () => {
          void input.cancel().catch(() => {});
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        try {
          while (!abort.signal.aborted) {
            const next = await input.read();
            if (next.done) break;
            if (!outgoing.write(next.value))
              await new Promise<void>((resolve) => {
                const finish = () => {
                  outgoing.removeListener("drain", finish);
                  outgoing.removeListener("close", finish);
                  resolve();
                };
                outgoing.once("drain", finish);
                outgoing.once("close", finish);
              });
          }
        } finally {
          abort.signal.removeEventListener("abort", cancel);
          await input.cancel().catch(() => {});
        }
      }
      outgoing.end();
    } catch {
      outgoing.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  const pin = await lstat(path);
  let closed = false;
  return {
    path,
    identity: { dev: pin.dev, ino: pin.ino, uid: pin.uid },
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await lstat(path).catch(() => null);
      if (current && current.dev === pin.dev && current.ino === pin.ino && current.uid === pin.uid)
        await unlink(path);
    },
    support: C.supported,
  };
}
