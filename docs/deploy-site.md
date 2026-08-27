# Takoserver landing site deployment

The landing site is a routine Cloudflare Pages surface owned by this
repository. Its Pages project is fixed as `takoserver-website`; the deploy
entrypoint does not discover or mutate Cloudflare routes, zones, or domains.

## Commands

```sh
bun run deploy -- site --environment=integration
bun run deploy -- site --environment=production
```

Integration is the iteration lane. It accepts a dirty worktree, requires a
non-`main` branch, builds the site once, uploads once to that branch's Pages
preview, and performs one immutable deployment URL GET.

Production is intentionally narrower. It requires a clean `main` worktree,
fetches `origin/main`, and refuses unless `HEAD` equals that freshly fetched
commit. It then builds once, uploads once, and performs one immutable deployment
URL GET plus one `https://takoserver.com/` GET. Both readbacks must return the
same bytes as the built `index.html`.

The command has no `status`, `plan`, or `apply` mode, reviewer/ledger state, or
Cloudflare API-token inventory. A build or source guard failure occurs before
the Pages mutation. If upload acknowledgement or the immutable URL is
indeterminate, do not retry blindly; inspect Pages deployment history first.

The production custom-domain attachment is a separate one-time topology
operation. This routine site command only publishes the Pages project and
verifies its public bytes.
