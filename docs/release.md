# Releasing Takoserver

This runbook publishes a Takoserver version: a signed Git tag and a GitHub
Release whose notes are the version's [CHANGELOG](../CHANGELOG.md) section.
It is written for 2.0.0 and applies to later versions with the numbers
changed. A release publishes source (and, once decided, the binaries in
[release assets](release-assets.md)); it deploys nothing. Hosted and other
Cloudflare surfaces change only through `bun run deploy` ([deploy](deploy.md)).

Takoserver has its own semver stream. There is no ecosystem-wide GA gate, and
a green check, a branch, or this document does not by itself authorize a
release: whether to release is the repository owner's decision.

A tag and a Release are a **published identity** that self-host operators pin.
No `bun run deploy` surface owns them (1.0.0 was also made by hand), so this
runbook applies that class's obligations by hand:

- **provenance**: the tag names one reviewed `main` commit, and every attached
  file is listed with its SHA-256;
- **post-conditions**: [Verify the release](#4-verify-the-release);
- **reversal**: a published tag or asset is never overwritten;
  [Defects after release](#5-defects-after-release) is the forward-repair plan;
- **failure handling**: stop at the first failed step, print what failed, and
  do not retry blindly. Note whether the failure came before or after
  `git push` of the tag: before it nothing is published; after it the tag is
  permanent.

## Version and pre-release

The version is `MAJOR.MINOR.PATCH` with no `v` in files and a `v` in the tag.
It lives in three places that ship and that
[`tests/release-version.test.ts`](../tests/release-version.test.ts) keeps
equal: `package.json` `version`, `info.version` in
[`src/openapi.ts`](../src/openapi.ts) (served at `/openapi.json`), and its
generated copy `openapi/takoserver.openapi.json` (`bun run openapi:write`).
The newest CHANGELOG section must be that version.

Takoserver has no pre-release convention: 1.0.0 was released directly. If the
owner wants operator feedback before 1.0.0 support ends (see
[SECURITY.md](../SECURITY.md)), release `2.0.0-rc.1` first with the same steps,
`gh release create --prerelease`, and a `## [2.0.0-rc.1] - YYYY-MM-DD`
section; then release `2.0.0` from a later commit.

## 1. Preconditions

Record each result with the commit it was run on. Every item refers to the
**release commit** `X`: the `main` commit the tag will name, where
`package.json` says the version and the CHANGELOG heading has its date.

Use a dedicated clean checkout and a private run directory outside it, as the
Host's user, with the shell's `NODE_ENV` removed. Keep `$RUN` short: the native
Actor tests bind Unix sockets under `TMPDIR`, which may be at most 73 bytes.

```sh
export REL=/absolute/path/takoserver-release      # a clean clone, not a working tree
export RUN=/var/tmp/tsr-run                         # private, outside $REL, and short
export V=2.0.0
mkdir -p -m 0700 "$RUN/tmp"
git -C "$REL" fetch origin main --tags
export X="$(git -C "$REL" rev-parse origin/main)"  # or an ancestor the owner chose
git -C "$REL" switch --detach "$X"
test -z "$(git -C "$REL" status --porcelain)"
```

- [ ] **Owner decisions** are recorded: the version (`2.0.0` or
      `2.0.0-rc.1`), the signing key, and whether binaries are attached and
      under which license option ([release assets](release-assets.md#licensing)).
- [ ] **Version and notes.** `jq -r .version "$REL/package.json"` prints `$V`,
      and `(cd "$REL" && bun scripts/release-notes.ts "$V")` succeeds without
      `--allow-unreleased`, which proves the heading carries a date. Set the
      date in a pull request before tagging; the tag never names a commit
      whose section still says `Unreleased`.
- [ ] **The tag is new.** Both print nothing:
      `git -C "$REL" tag -l "v$V"` and `git -C "$REL" ls-remote --tags origin "refs/tags/v$V"`.
- [ ] **CI is green on `X`.** Both `Takoserver quality` and
      `Takoserver dependency audit` succeeded for exactly `X`:

      ```sh
      gh run list -R tako0614/takoserver --commit "$X" \
        --json workflowName,status,conclusion,databaseId
      ```

      A failure of a test known to be intermittent (the
      [CHANGELOG](../CHANGELOG.md) lists them) may be re-run once; record both
      runs. Any other failure stops the release.
- [ ] **The portable gate passes locally on `X`** with the pinned Bun
      (`.bun-version`):

      ```sh
      cd "$REL"
      env -u NODE_ENV bun install --frozen-lockfile
      env -u NODE_ENV TMPDIR="$RUN/tmp" bun run check > "$RUN/check.log" 2>&1; echo "exit=$?"
      grep -E '^ *[0-9]+ (pass|skip|fail)$' "$RUN/check.log"
      sha256sum "$RUN/check.log"
      ```

      Record the exit status, the pass/skip/fail counts and the log digest.
      `bun run check` also runs the Go checks, migrations, builds, OpenAPI,
      schema and the vendored Takoform v2 conformance probe.
- [ ] **The native lanes pass on `X`** with the pinned workerd
      (`c00638f1…`) and a guard built from `X`
      ([release assets](release-assets.md#a-build-from-source)). They need
      Linux x86-64, root (for the network namespace and TCP 443), `/proc`,
      `/usr/bin/setpriv` and OpenSSL:

      ```sh
      cd "$REL"
      export TAKOSERVER_WORKERD_BINARY=/opt/takoserver/bin/workerd
      export TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY=/opt/takoserver/bin/workflow-execution-guard
      export TAKOSERVER_V2_ENTRY_NATIVE=1 TAKOSERVER_NATIVE_WORKERD_PARENT_LIFETIME=1
      env -u NODE_ENV bun scripts/check-native-evidence.ts   # the three lanes must say "ready"
      env -u NODE_ENV bun -e 'import { collectNativeEvidenceGates as gates } from "./scripts/native-evidence.ts";
        const lanes = new Set(["workerd-artifact", "workerd-parent-lifetime", "takoform-v2-bun-entry-lifecycle"]);
        for (const file of new Set(gates("tests").filter((g) => lanes.has(g.capability)).map((g) => `tests/${g.file}`)))
          console.log(file);' > "$RUN/native-files.txt"
      unshare --net sh -c 'ip link set lo up &&
        exec env -u NODE_ENV TMPDIR="$RUN/tmp" bun test --timeout 600000 $(cat "$RUN/native-files.txt")' \
        > "$RUN/native.log" 2>&1; echo "exit=$?"
      grep -E '^ *[0-9]+ (pass|skip|fail)$' "$RUN/native.log"; sha256sum "$RUN/native.log"
      ```

      On 2026-10-11 the selection was 54 files. Then repeat the ordinary
      journey three times, since it is the end-to-end install path and has a
      known intermittent wait:

      ```sh
      for i in 1 2 3; do
        unshare --net sh -c 'ip link set lo up &&
          exec env -u NODE_ENV TMPDIR="$RUN/tmp" bun test --timeout 600000 tests/selfhost-v2-ordinary-journey-native.test.ts'
      done > "$RUN/journey.log" 2>&1
      ```

      Record each result. A skipped native test counts as not run.
- [ ] **Docs clean-room install.** On a machine or VM with no earlier Takoserver
      state, a person who did not write the docs follows
      [First install and first use](self-host-operations.md#first-install-and-first-use)
      steps 1 to 9 literally, from a clone of `X`, and reaches a Worker served
      over HTTPS. Record every deviation and fix the docs (a docs change moves
      `X`, so re-run the checks above on the new commit). Separately, start
      `X` on a copy of a used 1.0.0 data root and confirm the refusal from
      [Upgrading from v1.0.0](self-host-operations.md#upgrading-from-v100).
- [ ] **No open security work blocks the release:** no unpublished advisory
      for a supported version, and the dependency audit on `X` is green.
- [ ] **Assets**, if any are attached, are built, verified as in
      [What an operator verifies](release-assets.md#what-an-operator-verifies),
      and listed in `$RUN/assets/SHA256SUMS` together with their notices.

## 2. Tag

Sign the tag. The 1.0.0 tag is annotated but not signed (`git tag -v v1.0.0`
prints `no signature found`), so 2.0.0 is the first signed tag. With an SSH
signing key (GPG works the same way with `gpg.format openpgp`):

```sh
git -C "$REL" config gpg.format ssh
git -C "$REL" config user.signingkey /absolute/path/to/release_signing_key.pub
git -C "$REL" tag -s "v$V" -m "Takoserver $V" "$X"
git -C "$REL" config gpg.ssh.allowedSignersFile /absolute/path/to/allowed_signers
git -C "$REL" tag -v "v$V"                       # Good signature, and object $X
test "$(git -C "$REL" rev-parse "v$V^{commit}")" = "$X"
git -C "$REL" push origin "refs/tags/v$V"        # never --force
```

For GitHub to show the tag as verified, the public key must be registered on
the account as a signing key. After the push the tag is permanent; any later
problem is repaired forward.

## 3. GitHub Release

Cut the notes from the CHANGELOG and pass them as a file. (1.0.0's notes were
passed inline and were published with literal `\n` sequences.)

```sh
cd "$REL"
env -u NODE_ENV bun scripts/release-notes.ts "$V" > "$RUN/notes-v$V.md"
gh release create "v$V" -R tako0614/takoserver \
  --verify-tag --draft \
  --title "Takoserver $V" \
  --notes-file "$RUN/notes-v$V.md"
# Only if binaries were decided and built (see docs/release-assets.md):
# gh release upload "v$V" -R tako0614/takoserver "$RUN/assets/"*
gh release view "v$V" -R tako0614/takoserver --json tagName,isDraft,isPrerelease,assets,body
```

`--verify-tag` refuses to create a missing tag, and `--draft` keeps it
private until it has been reviewed. Review the rendered draft on GitHub, then
publish it as the latest release:

```sh
gh release edit "v$V" -R tako0614/takoserver --draft=false --latest
```

For a pre-release use `--prerelease` instead of `--latest`.

## 4. Verify the release

```sh
gh api repos/tako0614/takoserver/releases/latest --jq .tag_name        # v2.0.0
git -C "$REL" ls-remote origin "refs/tags/v$V" "refs/tags/v$V^{}"       # peeled commit is $X
gh release view "v$V" -R tako0614/takoserver --json body --jq .body | diff - "$RUN/notes-v$V.md"
mkdir "$RUN/download" && gh release download "v$V" -R tako0614/takoserver -D "$RUN/download"
(cd "$RUN/download" && sha256sum --check --ignore-missing SHA256SUMS)  # when assets exist
```

Then install from the tag on a clean machine (`git clone --branch v2.0.0`,
`bun install --frozen-lockfile`) and check that the started Host reports the
version and its v2 discovery:

```sh
curl -fsS http://127.0.0.1:8787/openapi.json | jq -r .info.version        # 2.0.0
curl -fsS http://127.0.0.1:8787/.well-known/takoform/v2 > /dev/null
```

After publication:

- update the supported-versions table in [SECURITY.md](../SECURITY.md): 2.x is
  current and 1.0.0 is no longer supported, with the date;
- record the tag object, commit `X`, the notes digest, the check and native
  log digests and any asset digests where the owner keeps release evidence
  (the `takos-control` task ledger for this release).

## 5. Defects after release

A published tag or asset is never moved, deleted and recreated, or replaced
with different bytes under the same name; consumers may already have pinned
it. Repair forward:

- **Notes are wrong.** Edit them in place (`gh release edit --notes-file`);
  notes are not part of the pinned identity. Fix the CHANGELOG in the same
  change.
- **The release is defective.** Add a prominent warning at the top of its
  notes, mark it `--prerelease` if it must stop being the latest release, and
  publish the fix as the next patch version (2.0.1) through this runbook.
- **An attached file is wrong or harmful.** Delete that one asset
  (`gh release delete-asset "v$V" <name> -R tako0614/takoserver --yes`), say
  so in the notes, and ship corrected bytes only under the next version. Do
  not upload a different file under the old name.
- **A security issue.** Follow [SECURITY.md](../SECURITY.md): a private
  advisory, a fixed patch release of the current major line, then disclosure.
- **A mistake found before the draft is published** (wrong notes or assets on
  a draft) can be fixed on the draft, or the draft deleted
  (`gh release delete "v$V" --yes` keeps the tag). A pushed tag that points at
  the wrong commit is not reused: release the corrected commit as the next
  version.

For operators, a release is not reversible on a data root it has migrated. A
2.0.0 Host cannot hand a migrated root back to 1.0.0; return by restoring the
cold copy taken before the upgrade, as in
[Upgrading from v1.0.0](self-host-operations.md#upgrading-from-v100) and
[Restore boundary](self-host-operations.md#restore-boundary). Between 2.x
patch releases follow [Update and code rollback](self-host-operations.md#update-and-code-rollback).
