# Hosted subscription consumers and configured identity

Ledger key: `hosted-pricing-consumers-20261014`; status: implementation on an
isolated branch, dependent on #325. Repository: takoserver only. This work
changes subscription plan selection, not a schema, price source, live target,
credential or commercial configuration. No staging or production operations
are performed by this worktree.

The CTO instruction of 2026-10-14 12:00 JST keeps the monthly free grant at
USD 1.50, maps USD 10 cash to USD 20 included credit and USD 50 cash to USD 100
included credit, and consumes at three times the configured Cloudflare overage
rate. Amounts inside the wallet remain integer USD micros. Cash and legacy
authoring consideration fields remain explicitly cents at their checked
boundary. This consumer contains no price or plan-ID defaults.

## Ownership and dependencies

| Owner | Scope |
| --- | --- |
| #325 / `106603b4` | Base subscription/refund service, strict pricing/configuration, 0095, complete base gate and merge |
| #336 / `04360c33` | Shared source, preview/compiler integration, final USD-micros values and their own gate; its six current files remain unchanged here |
| This branch | Stripe consumer lookup by configured plan/Price identity and regression coverage, using #325's normalized pricing interface |

The inspected #336 snapshot is `cabd5982`; it contains the final USD 20/100
included amounts but still postpones runtime integration and activation. Its six files are
`config/shared-hosted-pricing.json`, `docs/shared-hosted-pricing.md`,
`scripts/check-imports.ts`, `scripts/pricing/preview.ts`,
`src/shared-hosted-pricing.ts`, and `tests/shared-hosted-pricing.test.ts`.
This branch imports the reviewed #325 snapshot `f6bef44b` as a dependency, keeps
merged #335 and its qualified expiry fixtures, and does not edit either owner's
worktree or branch. No force-push or main push is used.

The compiler still accepts one paid plan at this baseline. Selection helpers
accept the existing normalized row shape, including two configured subscription
rows, but do not bypass the compiler's validation or activate an unresolved
source. Two-plan compiler integration and real Stripe Price/target qualification
remain required; routing tests are not a claimed live two-plan billing pass.
Free eligibility, prepaid consent/limits, usage summary and measurement feed
are separate policy/integration work rather than side effects of selecting a
plan. The root's previous 0092 and 0093/0094 application queues are cancelled.

## Consumer contract

Checkout resolves the requested configured subscription key. Subscription
validation resolves its bound metadata key. Invoice grants use the key from
the invoice's pinned historical revision, not the current first row. Price
verification resolves the unique configured Stripe Price and its own cash
consideration. Free/usage rows and unknown or ambiguous identities never select
a paid plan. Reordering rows cannot exchange a USD 10 cash/20 credit pair with
a USD 50 cash/100 credit pair.

Existing account/mode, customer/Organization, one-item/monthly/quantity,
paid-period, immutable pricing, replay, refund and atomic ledger checks remain
in force. No customer-supplied amount becomes credit authority. Existing
single-plan and historical snapshots continue through their original parser
and money conversions.

Before delivery, run focused selection and existing subscription/refund tests,
independent review, and complete local `bun run check`; record the exact source,
result and log digest in the PR. Merge only after the #325 dependency is on main
and the final source is validated. Staging application belongs to its assigned
operator and does not follow from a source merge or a preview.
