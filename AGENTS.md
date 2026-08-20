# AGENTS.md

> このファイルは `takos-control/engineering.policy.json` と `ecosystem.repos.json` から generator v1 で生成されています。手編集しないでください。

## Repository

- Scope: Independent multi-provider cloud control plane and Console for Resources, deployments, attachments, migration, usage, and billing.
- Repository kind: `product`
- Direct sibling dependencies: なし
- Repository gate: `bun run check`
- Canonical docs: [README.md](README.md), [docs/provisioner.md](docs/provisioner.md), [docs/adr/0001-provision-from-the-worker.md](docs/adr/0001-provision-from-the-worker.md)

## Ownership

- Owns: Takoform Host lanes, catalog offerings, provider packs, placement, and provisioning / Cloud Resources, deployments, attachments, migration, credential grants, usage, wallet, and billing / Takoserver Console, Projects, API keys, direct customer and reseller lanes
- Does not own: Takosumi OSS Run, state, output, audit, or ProviderConnection authority / Takosumi Hosted plan entitlements or sponsored-credit purchase policy / Person identity, legal Organizations, reusable payment profiles, or product-external sessions
- Hazards: Consume Takos ID only through OIDC/HTTP; do not import Takosumi, Hosted, or Takos ID source or accept their cookies. / Shipped Form definitions are frozen by schemaDigest pins; add a definitionVersion instead of editing one. / Reseller customers cross the wire only as opaque tenantRef values and single-use provision tokens.

## Required workflow

- repo固有の挙動・契約・architectureは、このrepo自身のsourceとdocsを正本にします。共通工学ルールをこのrepoで再定義しません。
- 通常変更はこのrepo内に閉じます。横断変更はtask ledgerに対象repoと順序を宣言し、unrelatedなdirty workを変更・stage・commitしません。
- handoff前に `bun run check` を実行します。これはread-onlyで、`format-check`, `lint-or-static-analysis`, `type-or-compile`, `portable-tests`, `portable-build` を完全に検証し、未実装項目をskipしてはいけません。
- formatの書き換えは明示的な `bun run fmt` だけで行い、checkやCIからsourceを書き換えません。
- task ledgerが必要な条件: The change modifies more than one repository. / The work changes production or release behavior. / The work changes a persisted schema or migrates data. / The work changes security, identity, credentials, authorization, billing, or authority. / The work destructively changes data or repository history.
- secret、credential、production記録、private keyをrepoへcommitしません。

## Deploy

- このrepoがproduction targetを持つなら、入口は `bun run deploy` 一つです。無ければ作ります。承認待ちの列も、登録する先もありません。entrypointは副作用なしの `--contract` で、自分に立つtriggerと各obligationの果たし方を宣言します。
- 実行するかどうかはoperatorの判断です。task ledger、branch名、green checkのいずれもdeployを承認しません。逆に、どれも欠けているからといってdeployが禁止されるわけでもありません。
- どのsurfaceも次のobligationを負います。

  - **provenance**: The published bytes belong to one reviewed commit, are built from that worktree, and the commit and artifact digest are recorded. Whatever validates them must cover those bytes.
  - **post-conditions**: After publishing, state how you know the thing works for a real user, and confirm it.
  - **reversal**: State how to get back. If you cannot get back, say so and name the forward-repair plan instead.
  - **failure-handling**: State what the entrypoint prints on failure and what it refuses to do. Raw diagnostics, no blind retry, and a clear split between failing before and after the target was touched.

- 次のtriggerが立つと義務が増えます。判別できないものはirreversible扱いです。

  - **irreversible** (The step leaves the previous artifact unable to serve again: a schema or data migration, a topology change, or anything that rewrites durable state.) → pre-mutation-proof, independent-review
  - **authority** (The step moves money, identity, authentication, authorization, or the deploy mechanism itself.) → independent-review
  - **published-identity** (Publication mints a version, digest, or tag that consumers pin.) → no-overwrite
  - **asynchronous** (Publication completes through an external review or staged delivery the deploy does not control, such as an app store.) → halt

- 果たし方は各surfaceが自分の言葉で決めます。中央は義務を決め、機構は決めません。宣言を弱められませんが、強める分には自由です。
- 利用者/operatorが自分の環境へself-host deployすることは別authorityで、このruleの対象外です。
