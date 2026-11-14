import { forwardContainerHttp } from "../container-http.ts";
import { createContainerHttpInvocation } from "./container-http-transport.ts";
import type { DockerContainerCoreOwner } from "./docker-container-core-owner.ts";
import type { DockerContainerCreateRecord } from "./docker-container-create-custody.ts";
import {
  createHttpRevisionServing,
  type HttpRevisionServingSnapshot,
} from "./http-revision-serving.ts";
import { originalLinuxOciHttpEndpoint } from "./linux-oci-owned-bundle.ts";

/** Constructed only by the original OCI creator. The opaque key is checked by
 * the original source on EVERY invoke; record/endpoint/observations alone do
 * not register custody. This owns application I/O, not physical retirement. */
export function createLinuxOciContainerHttpRuntime(
  original: object,
  core: DockerContainerCoreOwner,
  record: DockerContainerCreateRecord,
) {
  const lifetime = new AbortController();
  const revision = Object.freeze({
    resourceUid: record.intent.resourceUid,
    incarnationId: record.intent.incarnationId,
    generation: record.intent.policy.generation,
    revision: record.intent.revision,
  });
  let snapshot: HttpRevisionServingSnapshot<typeof revision, string> = {
    version: 1,
    desired: revision.generation,
    serving: revision.generation,
    deleting: false,
    deleted: false,
    revisions: [
      {
        input: revision,
        nativeId: record.nativeId,
        retireAt: null,
        absent: false,
        creating: false,
      },
    ],
  };
  const originalIO = new Set<ReturnType<typeof createContainerHttpInvocation>>();
  const openCalls = new WeakMap<
    Request,
    { actual?: ReturnType<typeof createContainerHttpInvocation>; refuseIfRevoked: () => void }
  >();
  let closed = false,
    closing: Promise<void> | undefined;
  const current = () => {
    if (closed || lifetime.signal.aborted) throw new Error("linux_oci_http_closed");
  };
  const observe = async () => {
    current();
    const actual = await core.observeServingOciHttp(record, original, lifetime.signal);
    current();
    // The endpoint is derived from the original private topology, not caller URL.
    originalLinuxOciHttpEndpoint(original, core, record, actual.httpPort, lifetime.signal);
    return { state: "ready", nativeId: actual.native.nativeId };
  };
  const coordinator = createHttpRevisionServing({
    automaticTimers: false,
    drainTimeoutMs: 30_000,
    // A transient coordinator projection, not a second authority or durable
    // ledger. Core SQL + original native custody are read by the backend below.
    state: {
      async load() {
        return structuredClone(snapshot);
      },
      async persist(_identity, next) {
        snapshot = structuredClone(next);
      },
    },
    backend: {
      observe,
      reconcile: observe, // reads only; this adapter cannot CREATE/START/retry
      async invoke(_revision, request, options) {
        current();
        const actual = await core.observeServingOciHttp(record, original, options.signal);
        current();
        if (options.signal.aborted || actual.native.nativeId !== options.nativeId)
          throw new Error("linux_oci_http_revoked");
        const endpoint = originalLinuxOciHttpEndpoint(
          original,
          core,
          record,
          actual.httpPort,
          options.signal,
        );
        return forwardContainerHttp(
          request,
          endpoint,
          (outgoing) => {
            current();
            if (options.signal.aborted) throw new Error("linux_oci_http_revoked");
            const invocation = createContainerHttpInvocation();
            const originalCall = openCalls.get(request);
            if (originalCall) {
              // A throw-only fence from the ORIGINAL native caller closure.
              // It supplies no grant and its return value is never consulted.
              originalCall.refuseIfRevoked();
              originalCall.actual = invocation;
            }
            originalIO.add(invocation); // BEFORE the actual raw constructor
            void invocation.settlement.then(
              () => {
                try {
                  invocation.assertJoined();
                  originalIO.delete(invocation);
                } catch {
                  /* Keep this exact unknown handle. */
                }
              },
              () => undefined,
            );
            return invocation.send(outgoing);
          },
          options.signal,
        );
      },
      // The public adapter exposes invoke/close only, never coordinator remove
      // or a native-absent observation. Close joins I/O, not the native process.
      async retire() {
        await close();
      },
    },
  });
  const handle = coordinator.open();
  function close(): Promise<void> {
    if (!closing) {
      closed = true;
      lifetime.abort();
      const source = [...originalIO].map((invocation) => invocation.close());
      const logical = handle.close();
      closing = (async () => {
        // Abort/call.finish is not the transport join. Keep the actual handle
        // promises even if the coordinator already removed its logical calls.
        await Promise.all([logical, ...source]);
        for (const invocation of originalIO) {
          await invocation.close();
          invocation.assertJoined();
        }
      })();
      void closing.catch(() => undefined);
    }
    return closing;
  }
  return Object.freeze({
    /** Same original call, with terminal ownership separate from response head.
     * A retained/unknown call cannot be rebound to a second use of its Request. */
    open(request: Request, refuseIfRevoked: () => void) {
      current();
      if (openCalls.has(request)) throw new Error("linux_oci_http_request_retained");
      refuseIfRevoked();
      const call: {
        actual?: ReturnType<typeof createContainerHttpInvocation>;
        refuseIfRevoked: () => void;
      } = { refuseIfRevoked };
      openCalls.set(request, call);
      // A response-body EOF can remove the forwarding adapter's listener
      // before raw request/message close. This original call still owns I/O.
      const cancel = () => {
        void call.actual?.close().catch(() => undefined);
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      const response = handle.invoke(revision, request);
      const settlement = response
        .then(
          () => undefined,
          () => undefined,
        )
        .then(async () => {
          if (call.actual) {
            await call.actual.settlement;
            call.actual.assertJoined();
          }
          request.signal.removeEventListener("abort", cancel);
          openCalls.delete(request); // Only a known no-I/O or actual terminal result.
        });
      void settlement.catch(() => undefined);
      return Object.freeze({ response, settlement });
    },
    fetch(request: Request) {
      current();
      return handle.invoke(revision, request);
    },
    close,
  });
}
