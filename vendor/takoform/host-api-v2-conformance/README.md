# Takoform Host API v2 HTTP baseline probe

`host-api.mjs` is Takoform's caller-driven Host API v2 HTTP baseline probe,
copied byte-for-byte from `https://github.com/tako0614/takoform.git` commit
`ba0bf1c4c7f1f89f7ebc4b7082a169760c904d54` (`conformance/v2/host-api.mjs`,
untagged `main`; Takoform has not tagged a release containing it). `LICENSE`
is the MIT notice that covers it. `source-manifest.json` pins both files by
size and SHA-256, and `tests/helpers/takoform-v2-host-api-conformance.ts`
pins the manifest itself and refuses drifted bytes before importing the probe.

`tests/takoform-v2-host-api-conformance.test.ts` (portable, in `bun run check`)
boots a real `bun src/entry-bun.ts` Host on loopback and runs the probe against
every held-artifact Form the Host supports without native Worker execution.
`tests/takoform-v2-host-api-conformance-native.test.ts` (opt-in,
`TAKOSERVER_V2_ENTRY_NATIVE=1` with the pinned workerd and Workflow guard) runs
it against the complete Worker profile's data and artifact Forms. A passing run
means only what the probe says: the mandatory HTTP baseline passed for those
fixtures. It is not full Host conformance: the probe reports restart
durability, fault injection, concurrency, cross-principal authority, optional
features and Form-specific behavior as `not-tested`.

To refresh, copy both files from a newer Takoform commit, update every size,
digest and the commit here, and update the manifest pin in the helper.
