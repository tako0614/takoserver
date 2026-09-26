/** Host-private native owner. No public admission or namespace API is installed here. */
interface NativeState {
  readonly facets: {
    get(
      name: string,
      create: () => { readonly class: unknown; readonly id: string },
    ): { fetch(request: Request): Promise<Response> };
  };
  waitUntil(promise: Promise<unknown>): void;
}

// Bun currently retains the original headers when cloning a Request with an
// empty replacement Headers. Rebuild from the URL so the private hop headers
// cannot reach the application even when they were the only headers present.
function withHeaders(request: Request, headers: Headers): Request {
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    redirect: "manual",
  });
}

/**
 * One native Durable Object per namespace/opaque ID, with one private facet.
 * The per-ID owner reserves an invocation through response-body completion.
 * This does not qualify crash recovery or native request lifetime limits;
 * the self-host Actor admission refusal remains in force.
 */
export function createActorNativeOwner() {
  return class ActorOwner {
    readonly state: NativeState;
    readonly env: { readonly CLASS: unknown };
    private tail: Promise<void> = Promise.resolve();
    constructor(state: NativeState, env: { readonly CLASS: unknown }) {
      this.state = state;
      this.env = env;
    }
    fetch(request: Request): Promise<Response> {
      let resolve!: (response: Response) => void;
      let reject!: (error: unknown) => void;
      const head = new Promise<Response>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      // The native input gate cannot stay closed while delivering a streaming
      // response: it defers the head and deadlocks the body pump. The owning
      // instance instead reserves the turn until the actual body terminates.
      const turn = this.tail.then(async () => {
        const encodedId = request.headers.get("x-takoserver-private-actor-id");
        if (!encodedId) throw new Error("Actor identity unavailable");
        const id = decodeURIComponent(encodedId);
        const headers = new Headers(request.headers);
        headers.delete("x-takoserver-private-actor-id");
        const child = this.state.facets.get("actor", () => ({ class: this.env.CLASS, id }));
        const response = await child.fetch(withHeaders(request, headers));
        if (response.body === null) {
          resolve(response);
          return;
        }
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        resolve(
          new Response(readable, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
        );
        try {
          await response.body.pipeTo(writable);
        } catch {
          /* cancellation/error terminates this body, then releases the gate */
        }
      });
      this.tail = turn.catch(reject);
      this.state.waitUntil(this.tail);
      return head;
    }
  };
}

export function createActorNativeIngress(token: string) {
  return {
    fetch(
      request: Request,
      env: {
        readonly NAMESPACE: {
          idFromName(name: string): unknown;
          get(id: unknown): { fetch(request: Request): Promise<Response> };
        };
      },
    ): Response | Promise<Response> {
      if (request.headers.get("x-takoserver-private-actor-token") !== token)
        return new Response(null, { status: 404 });
      const id = request.headers.get("x-takoserver-private-actor-id");
      if (!id) return new Response(null, { status: 204 });
      const headers = new Headers(request.headers);
      headers.delete("x-takoserver-private-actor-token");
      return env.NAMESPACE.get(env.NAMESPACE.idFromName(id)).fetch(withHeaders(request, headers));
    },
  };
}
