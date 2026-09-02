# ADR 0005 — Object storage is an exact ObjectBucket Binding

**Status:** accepted, 2026-09-01

> **Amended 2026-09-02 by
> [ADR 0007](0007-objectbucket-joins-the-implementation-catalog.md).** The
> consequence below that "Worker code receives the exact Binding facade, not
> raw `edge.objects` wire envelopes and not a provider-native R2 or S3 client"
> holds on the wrapper hosts. On the ordinary-workers backend, which uploads
> the tenant's exact bundle bytes and has nowhere to interpose a wrapper, the
> declared name carries Cloudflare's native R2 binding. ADR 0007 records that
> divergence and its reasons; this decision's body is unchanged.

## Decision

Takoserver's managed object-storage contract is exactly the current
`edge.forms.takoform.com/ObjectBucket` Resource, its `edge.objects` Interface,
and the `module-worker.object-bucket` Binding consumed by a Worker Version's
`bucketBindings`. Takoserver does not expose provider bucket coordinates,
credentials, or supply material as Resource state or discovery.

The selected Provider Pack owns one deep runtime-binding materializer. It first
exports an opaque capability from the exact active target Deployment and then
imports that capability into the exact consumer pack. Both stages must claim
the same Binding identity. A same-provider native R2 binding and a private S3
transport may implement the Interface internally; neither changes the public
JavaScript facade or creates a second contract. Cross-provider composition is
unsupported until both provider packs implement the explicit two-stage
materialization and therefore fails closed.

The JavaScript facade preserves streaming. `put(key, body, options?)` and
`uploadPart(key, uploadId, partNumber, body, options?)` accept a string,
ArrayBuffer, or byte ReadableStream. `options.contentLength` is required for a
ReadableStream and, when supplied with an intrinsic-length body, must match its
UTF-8 or byte length. Hosts enforce the exact count while streaming and do not
buffer a body to discover its size.

## Authority

Provider capability and credentials are not resale authority. A current
ObjectBucket Offering exists only from an explicit private Supply Contract
composition, and this composition permits only `embedded-binding` delivery.
Takoserver exposes no public `/s3-credentials` or managed standard-service
route. Separate S3 retail is outside this decision and remains absent.

The immutable provider-v2.1.1 v1beta1 ObjectBucket package remains usable only
to observe, delete, and prove absence for already-recorded Deployments. It is
not authorable, sellable, or relabelled as the current versionless family.

## Consequences

- Resource desired, observed, output, and discovery contain no provider
  endpoint, region, native bucket name, access key, or supply document.
- Worker code receives the exact Binding facade, not raw `edge.objects` wire
  envelopes and not a provider-native R2 or S3 client.
- Unsupported and partially implemented materialization fails before provider
  mutation; mixed-provider placement is never guessed.
- The Wrangler `OBJECTS` binding used by Takoserver's own control storage is an
  implementation artifact and is unchanged by this public contract.
