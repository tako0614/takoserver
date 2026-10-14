# Actor WebSocket hibernation qualification

The current Host source targets `ActorNamespace/0.3.0`, `WorkerVersion/0.5.0`
and the exact `worker.actor@2.0.0` InterfaceRef. The latter is selected
unpublished publisher source; a matching source digest does not establish
publication or hosted Actor support.

The native owner already owns the hibernatable server WebSocket, its durable
alarm, callback queue and tenant Facet lifetime. It accepts the socket with
`acceptWebSocket`, stores connection metadata with `serializeAttachment`, and
recovers native connections through `getWebSockets`. Tenant code receives the
portable socket facade rather than the native WebSocket or owner authority.

The portable v2 attachment maximum is 16,384 bytes. The previous native owner
encoded those bytes as base64 together with socket ID, actor ID and provisional
reservation metadata. Cloudflare documents a 16,384-byte maximum for the
**complete serialized native attachment**, including that metadata. A maximum
portable attachment reached the real Core owner on the pinned native artifact
and failed: its 22,323-byte envelope was rejected before the native upgrade.
The earlier 16 KiB port test supplied a synthetic HTTP response, while the
existing native socket journey used only a one-byte attachment.

The repair keeps complete copied v2 bytes in the same native owner's private
SQLite-backed KV storage, keyed only by the Host-generated socket ID. The
native envelope carries a small `owner-kv-v1` marker and the existing identity
and reservation metadata. The tenant's SQL facade uses its separate child
Facet storage; owner KV is never projected into `ActorContext`. Legacy writes
and old base64-envelope reads remain supported. Missing, foreign or oversized
payloads close the affected connection before callback admission.

Terminal payloads survive their callback and Host completion. Uncommitted
abandonment, expiry and failed establishment reclaim their own payloads.
Unknown callback settlement retains custody. The Host-only
`retireSocketAttachments()` joins the owner's event/control queues and requires
proven quiescence before deleting at most 32 owned keys per call. It returns
`{ deleted, complete }`; the outer retirement owner must finish every page
before declaring deletion complete. Constructor scans and elapsed time do not
prove callback settlement, so neither performs orphan reclamation.

`tests/actor-native-hibernation.test.ts` separates two questions. Its native
boundary probe calls the real platform serializer with the current envelope.
Its Actor regression runs the real native owner and portable tenant Actor,
commits the Host's upgrade reservation and reads the complete attachment on
the same connection. It then evicts only the fixture owner, requires a changed
memory-only constructor marker, and resumes the same client/socket ID with the
same complete attachment digest. Both require the exact closed-graph artifact selected by
`selectClosedGraphWorkerd`; missing capability remains unproven rather than
being counted as a native pass.

The accepted artifact descriptor fixes upstream commit
`0129b1e7aaf9afbc21cba79d215723d9839eb7a0`, reviewed source and patch digests,
and executable SHA256
`c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`.
This local evidence does not qualify the live WfP account, normal hosted Form
composition, independent deployment review or staging acceptance.

Full hibernation acceptance must keep a connection open while demonstrating
owner reconstruction, attachment restoration, fresh callback admission and
Version selection. Closing a socket and opening a new one after a process
restart does not prove that behavior. Alarm/message interleaving, close/error,
unknown upgrade acknowledgement, namespace retirement and tenant separation
remain part of that acceptance. Pending timers or unfinished I/O prevent
hibernation; forced shutdown can disconnect a socket and is a separate case.

The pinned upstream's test-only `workerd:unsafe.evict(stub, { webSockets:
"hibernate" })` preserves storage and hibernatable sockets and rebuilds the
owner on the next event. The fixture invokes it from an isolated test driver
service with `unsafe_module`; the actual owner's and tenant's closed module
graphs stay unchanged. Core settlement snapshots retain the existing HMAC,
actor, graph and observation-stamp checks. These fixture snapshots do not
qualify the production Host's listener ownership or a resource DELETE barrier.
An `abort`, process kill, or socket reconnect is not an equivalent test.

The source also gives an admitted alarm the existing socket context with a
fresh owner-local nonce, current ABI profile and retained Version fences.
Alarm list/get/send/attachment operations share that turn; an alarm has no
original client upgrade and cannot accept a new connection. The nonce stops
working when the turn settles. Focused source tests pass, including stale
nonce, profile mismatch and unknown retirement refusal. On the pinned native
artifact, the repaired maximum attachment survived genuine owner eviction on
one open client/socket ID with a new constructor marker and the same digest;
an admitted alarm listed that socket, read the bytes and sent on it.

The same native regression then exposed a separate terminal transport failure:
the close callback completed and reclaimed its payload, but the client stayed
in `CLOSING`. The owner uses compatibility date `2026-01-01`, which requires an
explicit reciprocal native Close frame. The candidate owner now replies after
the terminal callback and Host completion attempt, inside the existing event
tail before attachment release. Reserved no-status code1005 is never emitted.
An unknown Host completion still rejects and retains poisoned custody even if
the physical transport closes. The final repaired native terminal case and
independent hosted staging remain pending.

Primary platform references:

- [WebSocket attachment API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#extended-methods)
- [Synchronous owner KV API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#synchronous-kv-api)
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Native close handler and compatibility boundary](https://developers.cloudflare.com/durable-objects/api/base/#websocketclose)
- [Facet abort and retained storage](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
- [Pinned test-only eviction API](https://github.com/cloudflare/workerd/blob/0129b1e7aaf9afbc21cba79d215723d9839eb7a0/src/workerd/api/unsafe.h)
