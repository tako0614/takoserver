# Published seams

A seam is a surface a *different product* speaks to Takoserver through. It is
not part of the public API document: no browser and no customer key may reach
one, and `openapi/takoserver.openapi.json` deliberately does not describe it.

That used to mean nothing described it at all. Each side kept its own
transcription of the strings — paths, body keys, status codes — in its own
test, with no artifact between them, so neither side could tell drift from
disagreement.

Each file here is a **recording**, not a description. It is produced by running
a scripted session against a composed Takoserver and writing down what the Host
answered, and the gate re-runs the session and refuses a difference. A consumer
that pins one of these files is pinning behaviour this Host proved.

| Artifact | Surface | Recorded by | Gate |
|---|---|---|---|
| `takoserver.sponsorship-seam.json` | `/v1/sponsorship/tenants/**` — Takosumi Hosted's sponsor lane | `scripts/sponsorship-seam-session.ts` | `bun run check:sponsorship-seam` |

## How a consumer uses one

1. Vendor the file, pinned by size and SHA-256, the way this repository vendors
   Takoform's frozen artifacts under `vendor/takoform/`.
2. Have your own gate parse the vendored copy and assert your client against
   the recorded exchanges — the paths it builds, the request bodies it sends,
   and the status and error code it decodes for each outcome.
3. Deleting or replacing the vendored copy must fail your gate. A transcription
   that no longer parses an artifact is a transcription again.

Two facts the recording carries that prose kept getting wrong:

- **A request without the service credential is answered `not_found` 404**, not
  `401`. The seam does not disclose that it exists.
- **Every refusal carries all four envelope members** (`code`, `message`,
  `requestId`, `retryable`). A consumer that treats `requestId` or `retryable`
  as optional reads a protocol-invalid envelope. `requestId` is fresh per
  response and appears in the recording as a placeholder.

## Regenerating

```bash
bun run seam:write          # re-record
bun run check:sponsorship-seam   # refuse on drift (also part of `bun run check`)
```

A change to the recording is a change to what a consumer receives. Review it as
one.
