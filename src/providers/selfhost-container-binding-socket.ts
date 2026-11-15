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
    readonly socketName?: string;
  },
) {
  const socketName = options.socketName;
  if (socketName !== undefined && !/^[0-9a-f]{64}\.sock$/u.test(socketName))
    throw new TypeError("private broker basename required");
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
  const path = join(
    directory,
    socketName ?? `${randomUUID().replaceAll("-", "").slice(0, 22)}.sock`,
  );
  if (Buffer.byteLength(path) > 100) throw new TypeError("broker socket path too long");
  const broker = createSelfhostContainerBindingBroker(options);
  let closing: Promise<void> | undefined;
  const handlers = new Map<AbortController, Promise<void>>();
  const server = createServer({ maxHeaderSize: 65_536 }, (incoming, outgoing) => {
    const abort = new AbortController();
    let resolveHandler!: () => void;
    let rejectHandler!: (error: unknown) => void;
    let cancellation: Promise<void> | undefined;
    const settlement = new Promise<void>((resolve, reject) => {
      resolveHandler = resolve;
      rejectHandler = reject;
    });
    // Retain the exact task before its body or cancellation can reenter close.
    handlers.set(abort, settlement);
    void settlement.catch(() => {});
    void run()
      .then(() => cancellation)
      .then(() => {
        handlers.delete(abort);
        resolveHandler();
      }, rejectHandler);
    return settlement;

    async function run() {
      if (closing) {
        outgoing.destroy();
        return;
      }
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
            if (!cancellation) cancellation = input.cancel();
            return cancellation;
          };
          const onAbort = () => {
            void cancel().catch(() => {});
          };
          abort.signal.addEventListener("abort", onAbort, { once: true });
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
            abort.signal.removeEventListener("abort", onAbort);
            await cancel().catch(() => {});
          }
        }
        outgoing.end();
      } catch {
        outgoing.destroy();
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  const pin = await lstat(path);
  return {
    path,
    identity: { dev: pin.dev, ino: pin.ino, uid: pin.uid },
    close(): Promise<void> {
      if (closing) return closing;
      let resolveClose!: () => void;
      let rejectClose!: (error: unknown) => void;
      // Publish the join before the original close side effects can reenter.
      closing = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      void (async () => {
        server.closeAllConnections();
        for (const abort of handlers.keys()) abort.abort();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all(handlers.values());
        const current = await lstat(path).catch(() => null);
        if (
          current &&
          current.dev === pin.dev &&
          current.ino === pin.ino &&
          current.uid === pin.uid
        )
          await unlink(path);
      })().then(resolveClose, rejectClose);
      return closing;
    },
    support: C.supported,
  };
}
