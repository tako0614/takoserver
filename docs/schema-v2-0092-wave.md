# Canonical integration 0092 schema wave

Ledger key: `canonical-v2-0092-20261013`. Scope: reviewed staging schema
transition and its private canonical dependency qualification. Production D1,
production settings, production deployment, and historical migration bytes are
outside this work.

Source integration (2026-10-14): successor PR #327 to draft PR #322 is merged,
after the separate fresh integration `storageLineage: "v2-0092"` profile from
PR #320 entered main. That profile creates an empty staging D1; this ledger
instead governs the existing generated `storageLineage: "v2-0088"` pair and
its explicit `appliedSchemaLineage: "v2-0092"` successor. Both pin the same
immutable 0001–0092 projection of the current audited source, but neither
selector confers the other's authority. No schema application or target
selection occurred during source integration.

| Order | Owner | Required evidence |
| --- | --- | --- |
| 1 | takoserver | Pin the existing 0092 source, implement exact integration 0088→0092 selector, bounded wallet preservation proof, Worker applied-schema selector, local gate and independent review. |
| 2 | takoserver-private | Pin the reviewed public source; prove terminal or GET-recovered publication attempts and frozen historical native/claim/source identity; make inspector, gateway, Tail, Host and CPE owner code capable of qualifying the current exact 88 predecessor and subsequent explicitly selected exact 92 readback. Own durable no-overwrite schema dispatch custody. Preserve 88/89 default paths. |
| 3 | operator via private owning entrypoint | On the reviewed commit, record clean remote source, exact target/production-D1 identities, status and private owner qualification; apply the single sealed 0089–0092 file to staging; read back exact lineage, shape and protected wallet rows. |
| 4 | operator via private owning entrypoint | Only after schema proof, explicitly select `takoformV2.appliedSchemaLineage: "v2-0092"` while preserving `storageLineage: "v2-0088"`. The current USD-micros Worker/CPE closure remains held until a separately qualified 0093/0094 schema cutover, complete 0094 canonical shape and money-unit policy; 0092 is not a serving schema for that artifact. |

The source inventory already includes 0092, but that inventory alone gives no
apply authority. The public `takoserver-d1-schema --through-migration=0092`
status is read only and reports `ownerQualified: false` without the private
owner callback. Direct public CLI apply cannot inject the required private
qualification and refuses before mutation. The private owner must call the
public `runD1Schema` with `canonicalV20092OwnerProof`, freshly deriving the
bound proof at initial, post-gate, final, immediate dispatch, and post-readback
fences. A user-authored JSON approval or boolean does not satisfy that callback.

The 0092 import has no down migration. Before the single sealed file is sent,
the private owner persists a no-overwrite dispatched attempt bound to the
reviewed source, native target identity, sealed import and pre-mutation wallet
proof. If the response is uncertain, that attempt remains dispatched even if
the immediate D1 readback still shows 88 rows. A fresh apply cannot resend it;
the private owner must use GET-only reconciliation. Exact 92 plus protected
wallet and native readback may terminalize it. A partial prefix or foreign
schema requires manual forward repair. The previous 0088 Worker artifact is not a
qualified 0092 successor; the private dependency owner must prepare the
successor before the D1 apply and complete its readback afterwards. The current
USD-micros Worker cannot serve on the 0092 successor or fresh 0092 pair, with
or without billing configuration. This wave never qualifies the distinct
0093/0094 cutover or a first 0094 Worker bootstrap.
