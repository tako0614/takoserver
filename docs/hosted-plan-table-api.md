# Shared Hosted plan table API contract

Task ledger: `hosted-plan-table-api-contract-20261014`. Repository: takoserver.
This change corrects the published subscription response schema and the unified
billing document. It does not change pricing configuration, money writes,
authorization, schema migrations, or deployment behavior.

## Source and ownership

The base is #336 `b18af470`, following merged #325 `bf90a9f8` and #335 `f3904b41`.
#336 now owns the Stripe plan selection originally prepared in #340, so #340
was closed after its full local gate passed. Its implementation is not merged
a second time. All thirteen #336 paths remain unchanged in this correction.

`GET /v1/organizations/{organizationId}/payments/subscription` returns the
compiled table. Authoring v1 emits Free / subscription / usage (three rows);
v2 emits Free / subscription / subscription / usage (four rows). OpenAPI must
accept both. Three commercial roles do not mean three literal plan IDs. Read
scope remains `wallet:read`; starting/changing a subscription remains
`payments:write`, and the four routine Hosted wallet commands are unchanged.

## Verification and delivery

A regression uses the real v2 compiler and control-route Request/Response
boundary. Before the schema fix, its four-row response exceeds the advertised
maximum of three. Both legacy and v2 outputs must fit the corrected schema,
with the two configured cash/credit pairs and existing row variants preserved.
Regenerate OpenAPI, explicitly format, run focused checks and the complete local
`bun run check`, and record exact source/results before merge after #336.

Source can be reverted independently before publication. This is a read-schema
correction with no durable money mutation. Staging D1/application and production
remain untouched; cancelled 0092 and 0093/0094 root queues stay cancelled.
