# Takoserver landing site deployment

The landing site is a routine Cloudflare Pages surface owned by this
repository. Its Pages project is fixed as `takoserver-website`. This routine
surface never mutates Cloudflare routes, zones, or domain attachment.

## Commands

```sh
bun run deploy -- takoserver-site --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-site --apply --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-site --status --environment=production --commit=<40-hex-sha>
bun run deploy -- takoserver-site --apply --environment=production --commit=<40-hex-sha>
```

Integration is the iteration lane. It may use a dirty exact HEAD, builds the
site once, seals the link-free output, uploads it once, and performs one
byte-exact immutable deployment URL readback.

Production requires either clean `main` equal to freshly fetched `origin/main`,
or a clean exact HEAD proven reachable from an exact remote ref. It builds and
uploads once, then requires both the immutable deployment URL and
`https://takoserver.com/` to return the sealed `index.html` bytes exactly. The
custom-domain read is a post-condition, not attachment authority.

This routine surface has no reviewer, plan, ledger, journal, or capability
burden. `--status` is read-only. A build or source guard failure occurs before
the Pages mutation. An upload acknowledgement failure is indeterminate: do not
retry; run the same surface with `--status` and inspect exhaustive Pages
deployment history first.

Custom-domain attachment is outside this routine surface. The command publishes
only Pages project bytes and verifies the existing production domain.
