# ADR 0003 — Serve standards as standards, Takoform for the rest

**Status:** accepted, 2026-08-23
**Companion:** Takoform decision 0043 (`terraform-provider-takoform`,
`spec/decisions/0043-forms-target-popular-vendor-locked-primitives.md`), which
records the survey this rule reads from and binds only Takoform's half.

## The rule

Takoserver's public surfaces split by one test: does the service category have
a de-facto standard API?

- **Where a standard exists, Takoserver serves that standard API itself.** The
  S3 data plane stays the S3-compatible API; the AI data plane is the
  OpenAI-compatible API, today the non-streaming Chat Completions shape at
  `/v1/ai/chat/completions` that `src/data-ai.ts` and the canonical OpenAPI
  document actually serve — Responses is where that surface is headed, not
  what it is, and this record does not pretend otherwise; a future cache is
  the Redis protocol, mail submission is SMTP — onward down the survey's
  integrate column. Takoserver never mints its own surface for a category the
  industry already made portable.
- **Where none exists, Takoserver serves Takoform.** The vendor-locked
  categories — workers, functions, containers, tables, queues, topics,
  schedules, vector indexes, and their families — reach Takoserver only as
  the Takoform Host API and its Form contracts. Takoserver never invents a
  proprietary provisioning surface for them, which is the standing hazard
  ("never mint a provider-shaped Form locally") restated as the positive rule.

A workload on the Takoform half reaches the standard half — Takoserver's own
S3-compatible or Responses endpoint, or anyone else's — through Takoform's
external standard-service slots (Takoform decision 0045): portable state
carries a name and a protocol, Takoserver resolves the endpoint and the
credential.

For stable S3 that is the exact service
`standards.takoform.com/v1/com.amazonaws.s3`. The supply and its lifetime are
Host-owned and out of band: immutable Worker revisions in one tenant/space/slot
share it, and deleting or failing a portable Resource is never authority to
delete that native service. Released ObjectBucket / `edge.objects` identities
remain historical drain-only records; they are not the current S3 model.

## Why

The maintainer directed it (2026-08-23), and it is what the existing ownership
already implies: this repository owns "Public AI and S3 data planes" and the
"Takoform Host" side by side. This record fixes that adjacency as the rule
that decides every future surface, so the next category is placed by the
survey instead of by habit. One server offers the standard half as standards
and the vendor-locked half as Takoform; a customer keeps standard SDKs where
standards exist and gains portability exactly where none does.

## What it forbids

A Takoserver-proprietary API for a category with a de-facto standard, and a
proprietary provisioning surface for a category Takoform specifies. An
exception to either is its own ADR against the survey, never a habit.
