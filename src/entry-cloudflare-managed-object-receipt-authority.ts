import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type ManagedObjectReceiptAuthority,
  type ManagedObjectReceiptResult,
  managedObjectReceiptAdminProof,
  managedObjectReceiptInstanceName,
  managedObjectReceiptRuntimeProof,
} from "./providers/cloudflare-managed-object-receipt.ts";
import { TakoserverManagedObjectReceipt } from "./providers/cloudflare-managed-object-receipt-object.ts";
import type {
  CloudflareManagedObjectReceiptAuthority,
  CloudflareManagedObjectReceiptStub,
} from "./providers/cloudflare-worker-backend.ts";

export { TakoserverManagedObjectReceipt };

export interface ManagedObjectReceiptAuthorityWorkerEnv {
  readonly OBJECT_RECEIPTS: {
    getByName(instanceName: string): CloudflareManagedObjectReceiptStub;
  };
  readonly MANAGED_PROVIDER_ID: string;
  readonly TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID: string;
  readonly TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID: string;
  readonly TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY: string;
  readonly TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET: string;
}

interface ReceiptRequest {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
}

/**
 * The only parent-operator capability exported by the route-less authority.
 *
 * Secret bytes and the administrative Durable Object namespace stay in this
 * isolate. The public Host receives a service-binding stub whose methods either
 * mint the exact tenant runtime binding or perform one bounded admin operation.
 */
export class TakoserverManagedObjectReceiptAuthority
  extends WorkerEntrypoint<ManagedObjectReceiptAuthorityWorkerEnv>
  implements CloudflareManagedObjectReceiptAuthority
{
  takoserverObjectReceiptRuntimeBinding(input: ReceiptRequest) {
    return createManagedObjectReceiptAuthority(this.env).takoserverObjectReceiptRuntimeBinding(
      input,
    );
  }

  takoserverObjectReceiptInspect(input: ReceiptRequest) {
    return createManagedObjectReceiptAuthority(this.env).takoserverObjectReceiptInspect(input);
  }

  takoserverObjectReceiptPrepareDestroy(
    input: ReceiptRequest & { readonly authorityProof?: string },
  ) {
    return createManagedObjectReceiptAuthority(this.env).takoserverObjectReceiptPrepareDestroy(
      input,
    );
  }

  takoserverObjectReceiptCommitDestroy(
    input: ReceiptRequest & { readonly authorityProof: string },
  ) {
    return createManagedObjectReceiptAuthority(this.env).takoserverObjectReceiptCommitDestroy(
      input,
    );
  }
}

/** Testable core behind the WorkerEntrypoint service-binding boundary. */
export function createManagedObjectReceiptAuthority(
  env: ManagedObjectReceiptAuthorityWorkerEnv,
): CloudflareManagedObjectReceiptAuthority {
  return new ManagedObjectReceiptAuthorityService(env);
}

class ManagedObjectReceiptAuthorityService implements CloudflareManagedObjectReceiptAuthority {
  constructor(private readonly env: ManagedObjectReceiptAuthorityWorkerEnv) {}

  async takoserverObjectReceiptRuntimeBinding(input: ReceiptRequest) {
    try {
      this.assertProvider(input.authority.providerId);
      return success({
        instanceName: await managedObjectReceiptInstanceName(input.authority),
        proof: await managedObjectReceiptRuntimeProof({
          secret: this.proofSecret(),
          authority: input.authority,
          bucketName: input.bucketName,
        }),
      });
    } catch {
      return invalidArgument();
    }
  }

  async takoserverObjectReceiptInspect(input: ReceiptRequest) {
    const sealed = await this.adminRequest("inspect", input);
    if (!sealed.ok) return sealed.result;
    return await sealed.stub.takoserverObjectReceiptInspect(sealed.request);
  }

  async takoserverObjectReceiptPrepareDestroy(
    input: ReceiptRequest & { readonly authorityProof?: string },
  ) {
    const sealed = await this.adminRequest("prepare-destroy", input);
    if (!sealed.ok) return sealed.result;
    if (
      input.authorityProof !== undefined &&
      !constantTimeTextEqual(input.authorityProof, sealed.request.proof)
    ) {
      return conflict();
    }
    const result = await sealed.stub.takoserverObjectReceiptPrepareDestroy(sealed.request);
    if (!result.ok) return result;
    return success({ ...result.value, authorityProof: sealed.request.proof });
  }

  async takoserverObjectReceiptCommitDestroy(
    input: ReceiptRequest & { readonly authorityProof: string },
  ) {
    let prepareProof: string;
    try {
      this.assertProvider(input.authority.providerId);
      prepareProof = await managedObjectReceiptAdminProof({
        secret: this.proofSecret(),
        operation: "prepare-destroy",
        authority: input.authority,
        bucketName: input.bucketName,
      });
    } catch {
      return invalidArgument<{ readonly destroyed: true }>();
    }
    if (!constantTimeTextEqual(input.authorityProof, prepareProof)) {
      return conflict<{ readonly destroyed: true }>();
    }
    const sealed = await this.adminRequest("commit-destroy", input);
    if (!sealed.ok) return sealed.result;
    return await sealed.stub.takoserverObjectReceiptCommitDestroy(sealed.request);
  }

  private proofSecret(): string {
    const secret = this.env.TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET;
    if (typeof secret !== "string" || secret.length === 0) {
      throw new TypeError("managed ObjectBucket receipt proof authority is unavailable");
    }
    return secret;
  }

  private assertProvider(providerId: string): void {
    if (providerId !== this.env.MANAGED_PROVIDER_ID) {
      throw new TypeError("managed ObjectBucket receipt provider identity conflicts");
    }
  }

  private async adminRequest(
    operation: "inspect" | "prepare-destroy" | "commit-destroy",
    input: ReceiptRequest,
  ): Promise<
    | {
        readonly ok: true;
        readonly stub: CloudflareManagedObjectReceiptStub;
        readonly request: {
          readonly authority: ManagedObjectReceiptAuthority;
          readonly bucketName: string;
          readonly proof: string;
        };
      }
    | {
        readonly ok: false;
        readonly result: ManagedObjectReceiptResult<never>;
      }
  > {
    try {
      this.assertProvider(input.authority.providerId);
      const instanceName = await managedObjectReceiptInstanceName(input.authority);
      const proof = await managedObjectReceiptAdminProof({
        secret: this.proofSecret(),
        operation,
        authority: input.authority,
        bucketName: input.bucketName,
      });
      return {
        ok: true,
        stub: this.env.OBJECT_RECEIPTS.getByName(instanceName),
        request: { authority: input.authority, bucketName: input.bucketName, proof },
      };
    } catch {
      return { ok: false, result: invalidArgument() };
    }
  }
}

/** No URL, workers.dev hostname, preview URL, or default service RPC exists. */
export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};

function success<T>(value: T): ManagedObjectReceiptResult<T> {
  return { ok: true, value };
}

function invalidArgument<T = never>(): ManagedObjectReceiptResult<T> {
  return { ok: false, error: { code: "invalid_argument" } };
}

function conflict<T = never>(): ManagedObjectReceiptResult<T> {
  return { ok: false, error: { code: "conflict" } };
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (typeof left !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < right.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
