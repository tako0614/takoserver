import type { PreparedWorkerdWorkflow } from "./selfhost-workflow-execution-host.ts";
import { WorkflowRuntimeError } from "./workflow-driver.ts";
import { createWorkflowHttpController } from "./workflow-http-controller.ts";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Concrete loopback transport for the guarded class loader. Configuration is
 * constructed from a verified, selected deployment by its owning loader; this
 * module never imports application modules or reaches the shared HTTP graph.
 */
export async function prepareWorkflowHttpExecution(options: {
  readonly channel: {
    readonly journalToken: string;
    readonly recordPayload: (sequence: number, payload: string) => void;
  };
  readonly signal: AbortSignal;
  /** Must reject and clean its own partial artifacts when signal is aborted. */
  readonly configure: (
    companionAddress: string,
    signal: AbortSignal,
  ) => Promise<{
    readonly configPath: string;
    /** Exact private loopback socket of this one guarded process. */
    readonly runOrigin: string;
    readonly dispose: () => Promise<void>;
  }>;
}): Promise<PreparedWorkerdWorkflow> {
  const { channel, signal } = options;
  const token = channel.journalToken;
  if (!/^[0-9a-f]{64}$/u.test(token)) throw new WorkflowRuntimeError("invalid_runtime_input");
  const controller = createWorkflowHttpController();
  const bodies = new Set<Promise<void>>();
  let accepting = true;
  let failure: WorkflowRuntimeError | undefined;
  let rejectTransport!: (error: WorkflowRuntimeError) => void;
  const transportFailed = new Promise<never>((_resolve, reject) => {
    rejectTransport = reject;
  });
  void transportFailed.catch(() => undefined);
  function retainIngressFailure(): WorkflowRuntimeError {
    if (!failure) {
      failure = new WorkflowRuntimeError("host_unavailable");
      rejectTransport(failure);
    }
    return failure;
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const prefix = `/${token}/`;
      if (!accepting || request.method !== "POST" || !path.startsWith(prefix)) {
        return new Response(null, { status: 404 });
      }
      const sequenceText = path.slice(prefix.length);
      const sequence = Number(sequenceText);
      if (!Number.isSafeInteger(sequence) || sequence < 1 || String(sequence) !== sequenceText) {
        return new Response(null, { status: 400 });
      }
      let finishBody!: () => void;
      const body = new Promise<void>((resolve) => {
        finishBody = resolve;
      });
      bodies.add(body);
      try {
        const payload = await readFrame(request);
        const response = controller.exchange(sequence, payload);
        // If journal pairing fails synchronously, do not leak a deferred rejection.
        void response.catch(() => undefined);
        channel.recordPayload(sequence, payload);
        finishBody();
        bodies.delete(body);
        return new Response(await response);
      } catch {
        // Physical shutdown may cancel a parked RESPONSE; its body and driver
        // latch are already accounted for. A failed BODY is never ignored.
        if (bodies.has(body)) retainIngressFailure();
        return new Response(null, { status: 503 });
      } finally {
        finishBody();
        bodies.delete(body);
      }
    },
  });
  let configured: Awaited<ReturnType<typeof options.configure>> | undefined;
  try {
    configured = await options.configure(`127.0.0.1:${server.port}`, signal);
    const origin = new URL(configured.runOrigin);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      !origin.port ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new WorkflowRuntimeError("invalid_runtime_input");
    if (signal.aborted) throw new WorkflowRuntimeError("host_unavailable");
  } catch (error) {
    accepting = false;
    server.stop(true);
    controller.close();
    await configured?.dispose();
    throw error;
  }
  const { configPath, dispose } = configured;
  const runOrigin = new URL(configured.runOrigin).origin;
  let running = false;
  let drained = false;
  return {
    configPath,
    acceptFrame: (sequence, payload) => controller.acceptFrame(sequence, payload),
    async run(driver) {
      if (running || !accepting || signal.aborted)
        throw new WorkflowRuntimeError("host_unavailable");
      running = true;
      controller.run(driver);
      const run = (async () => {
        const deadline = Date.now() + 3_000;
        let ready = false;
        while (Date.now() < deadline && !signal.aborted && accepting) {
          try {
            const response = await fetch(`${runOrigin}/${token}/ready`, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(200)]),
            });
            if (response.status === 200 && (await response.text()) === "ready") {
              ready = true;
              break;
            }
          } catch {
            /* The one child is still opening its private socket. */
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        if (!ready || signal.aborted || !accepting)
          throw new WorkflowRuntimeError("host_unavailable");
        // One RUN only. Lost responses reject infrastructure; never replay in
        // this context and never synthesize a successful application outcome.
        const response = await fetch(`${runOrigin}/${token}/run`, { method: "POST", signal });
        if (response.status !== 200) throw new WorkflowRuntimeError("host_unavailable");
        const payload = await readFrame(response);
        return controller.outcome(payload);
      })();
      return Promise.race([run, transportFailed, controller.failed]);
    },
    async drainAfterStop() {
      if (drained) {
        if (failure) throw failure;
        return;
      }
      accepting = false;
      // The guard has already joined stderr and reaped the sole sender. Close
      // ingress, join body readers/latches, then release parked response waits.
      // Journal sealing belongs to the outer lifecycle, after this barrier.
      server.stop(true);
      await Promise.all([...bodies]);
      controller.close();
      drained = true;
      if (failure) throw failure;
    },
    async dispose() {
      if (!drained || failure) throw new WorkflowRuntimeError("host_unavailable");
      await dispose();
    },
  };
}

async function readFrame(message: Request | Response): Promise<string> {
  const reader = message.body?.getReader();
  if (!reader) throw new WorkflowRuntimeError("host_unavailable");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_FRAME_BYTES) throw new WorkflowRuntimeError("host_unavailable");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
