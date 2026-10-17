# Unknown-length object streams — F4 acceptance proposal

This document and the JSON vectors define **proposed F4 acceptance**, exercised
against a test-only mock sink. They do not claim that the shipped adapters accept
unknown-length streams; the self-host implementation is qualified separately
below. [ADR 0005](adr/0005-object-storage-is-an-exact-objectbucket-binding.md)
currently requires `options.contentLength` for a `ReadableStream`, and
`src/providers/edge-objects-adapter.ts` rejects its omission as `invalid_body`.
That conformance gap must be resolved by the ObjectBucket/stream implementation
owners and the Takoform contract owner before these cases qualify an adapter.

## Inputs and byte ceilings

Both `put` and multipart `uploadPart` accept byte `ReadableStream` bodies without
`options.contentLength`. The HTTP bridge accepts a chunked request without
`Content-Length`; a direct JavaScript stream needs no transfer-coding header.
These vectors model decoded HTTP body chunks, not a raw HTTP parser or network
server. They do not test transfer-coding syntax or conflicting length headers.

The proposal retains the existing ceilings from the
[bucket-binding contract](provisioner.md#what-a-workers-bucket-binding-may-say)
and the adapter's multipart ledger:

| Boundary | Inclusive maximum / minimum | Overflow or refusal code |
| --- | ---: | --- |
| One `put` | 314,572,800 bytes (300 MiB) | `value_too_large` |
| One `uploadPart` | 5,368,709,120 bytes (5 GiB) | `invalid_body` |
| Completed multipart object, selected parts summed | 5,368,709,120 bytes (5 GiB) | `value_too_large` |
| Selected part count | 1 through 10,000 | Current argument validation remains authoritative; no count-boundary vector here |
| Every selected non-final part | At least 5,242,880 bytes (5 MiB) | `invalid_part` |

The `uploadPart` overflow choice extends the existing intrinsic-body overflow
mapping to a body whose length becomes known while reading. It is proposed, not
an already-published unknown-length error contract. The same is true of the
unknown-length `put` overflow mapping.

Zero bytes is accepted for `put` and a sole/final multipart part. Empty byte
chunks do not signal EOF and count as zero bytes. Exactly the maximum succeeds;
the first chunk that would add byte maximum + 1 fails immediately, cancels the
producer, and is not acknowledged as written. Count bytes, not chunk count or
JavaScript string length. Never concatenate a body to discover its length.

## Errors, visibility, and backpressure

Portable failures are `Error` objects with **both `name` and `message` equal to
the listed code**, following the existing adapter error shape. There is no new
HTTP status or JSON `code` field in this proposal.

- A producer that errors mid-stream fails as `backend_unavailable`. Its original
  message and stack are not a portable response. A clean EOF is valid for an
  unknown-length body; without a declared length it cannot be called truncated.
- A non-byte chunk fails as `invalid_body` and cancels the producer.
- Failed `put` or failed multipart completion leaves the previous object visible.
  A failed part has no completed part receipt. Previously completed parts may
  remain staged for explicit abort/retry; this test does not define upload expiry.
- Read only when the downstream sink can accept another chunk. Await each write
  before the next read; a slow producer and a slow sink must both finish without
  accumulating the body. The fixture source has `highWaterMark: 0` and the mock
  observes at most one emitted, unacknowledged chunk.

## D05: unequal multipart sizes

Do not require equal non-final sizes. Parts of 5 MiB and 6 MiB followed by a
7-byte final part are accepted. A non-final part of 5 MiB - 1 is refused as
`invalid_part`. Unequal parts totaling exactly 5 GiB are accepted, and a selected
total of 5 GiB + 1 is refused as `value_too_large`, even when each part separately
fits. Completion failure leaves the prior object intact. These cases retain the
current ledger's minimum and aggregate checks while exercising unknown-length
sources; they do not qualify a provider's native multipart constraints.

## Running and replacing the mock

```bash
bun test tests/stream-unknown-length-vectors.test.ts
```

`tests/fixtures/stream-unknown-length/vectors.json` contains 52 vectors: the same
11 basic cases for `put` and `upload` in each transport, plus four D05 multipart
cases in each transport. Each declares byte segments, the maximum real chunk
size, optional producer interruption/delay, sink delay, and the exact expected
result. The 300 MiB and 5 GiB tests use their actual byte counts, reusing one
bounded byte buffer rather than allocating or storing a complete object. Logical
segments larger than `chunkBytes` are emitted in multiple actual chunks.

`createMockSink` lives in the test file. The single `createSink` factory is the
replacement seam for a future implementation bridge. `FixtureSink` uses the
existing `EdgeObjects` method types; an adapter bridge supplies `inspect()` for
object visibility/receipt assertions and acknowledges consumed chunks through
`SinkContext`. HTTP bridges receive the modeled headers. Preserve the vectors,
omitted content-length options, expected error shapes, visibility assertions, and
source/backpressure checks when changing the factory. Mock PASS is fixture
evidence only; the current production adapter is intentionally not under test.

## Self-host implementation and forward contract alignment

The self-host ObjectBucket path counts unknown-length byte streams in its
private filesystem stage, under the same put and part ceilings. A supplied
`contentLength` still requires exact EOF matching. Put publishes only after the
stage finishes and its existing conditional commit succeeds; multipart records
the actual part size in its existing durable receipt. Its private transport
returns that size to the Worker facade, whose portable part receipt remains
`{etag, partNumber}`. No whole-body buffer is used to discover the size.
The generated Worker facade validates byte chunks before HTTP encoding can
coerce another chunk type into bytes, and the data-plane stage counts them
independently. Reader operations and byte brand checks are captured before
tenant code runs. Producer failures preserve their sanitized portable code
even if the transport wraps the stream error.

ReadableStream bodies use the Host-private `byte-chunks-v1` transport on the
existing ObjectBucket route. Each data record has a four-byte big-endian length
and between one and 65,536 payload bytes. Empty source chunks are skipped, and
zero-length wire data records are refused. The terminal
`0xffffffff` record is emitted only after validated source EOF. The receiver
requires this record followed by wire EOF, refusing truncated records,
oversized records, missing termination, and trailing bytes before publication.
This prevents a transport that presents producer failure as clean HTTP EOF
from publishing an empty or partial replacement. Existing raw-body requests
remain compatible. Logical `contentLength` excludes the framing records and is
never sent as framed HTTP `Content-Length`.
The private authenticated listener permits at most 26,843,545,604 wire bytes:
five times the 5 GiB logical ceiling plus the four-byte terminal marker. Every
data frame contains at least one payload byte, so even one-byte fragments fit
this finite budget. Raw legacy bodies fit the same listener budget. The stage
continues to enforce the smaller operation-specific logical byte ceilings.

`tests/selfhost-object-stream-vectors.test.ts` exercises the production stage
consumer and completion receipt validator with the original 52 vectors. Its
sink discards bytes, so the actual 300 MiB/5 GiB counting results do not claim
filesystem or native-provider qualification. The store and broker tests
separately verify filesystem byte content, EOF visibility, conditional writes,
failed streams, durable receipts, and unequal parts at bounded sizes. A local
HTTP test also connects the generated facade and data service to the actual
filesystem data-plane listener. Facade ceiling tests count real byte chunks
through the production consumer while discarding them; they do not prove a
5 GiB native HTTP or filesystem transfer.

This runtime work does not change the immutable `edge.objects` 1.0.0 definition.
That Interface still mandates stream lengths and equal-sized non-final parts;
the owning Takoform release must establish the forward contract identity and
pins before this proposal is advertised as a published portable guarantee.
Native R2 and private-S3 adapters require separate streaming bridges and
qualification. Ordinary Worker HTTP and control-plane artifact upload also
remain separate acceptance surfaces; these ObjectBucket vectors define no
generic HTTP body ceiling.
