# Releasing Takoserver

This runbook publishes a Takoserver version: an annotated Git tag and a GitHub
Release whose notes are the version's [CHANGELOG](../CHANGELOG.md) section, with
the files listed in [release assets](release-assets.md). It is written for
2.0.0 and applies to later versions with the numbers changed. A release
publishes source and those files; it deploys nothing. Hosted and other
Cloudflare surfaces change only through `bun run deploy` ([deploy](deploy.md)).

Takoserver has its own semver stream. There is no ecosystem-wide GA gate, and
a green check, a branch, or this document does not by itself authorize a
release: whether and when to release is the repository owner's decision.

Decisions for 2.0.0 (repository owner, 2026-10-11):

- **Release candidate first.** `2.0.0-rc.1` is published as a GitHub
  pre-release. `2.0.0` follows once operators have tried it
  ([Promote a candidate](#5-promote-a-candidate-to-200)).
- **The pinned workerd is attached** under AGPL-3.0-or-later with its notices
  bundle; the Workflow guard is not attached
  ([release assets](release-assets.md)).
- **Tags are annotated and unsigned**, like `v1.0.0`.

A tag and a Release are a **published identity** that self-host operators pin.
No `bun run deploy` surface owns them (1.0.0 was also made by hand), so this
runbook applies that class's obligations by hand:

- **provenance**: the tag names one reviewed `main` commit, and every attached
  file is listed with its SHA-256;
- **post-conditions**: [Verify the release](#4-verify-the-release);
- **reversal**: a published tag or asset is never overwritten;
  [Defects after release](#6-defects-after-release) is the forward-repair plan;
- **failure handling**: stop at the first failed step, print what failed, and
  do not retry blindly. Note whether the failure came before or after
  `git push` of the tag: before it nothing is published; after it the tag is
  permanent.

## Version and CHANGELOG

The version is a [SemVer](https://semver.org/) string, such as `2.0.0-rc.1` or
`2.0.0`, with no `v` in files and a `v` in the tag. It lives in three places
that ship and that [`tests/release-version.test.ts`](../tests/release-version.test.ts)
keeps equal: `package.json` `version`, `info.version` in
[`src/openapi.ts`](../src/openapi.ts) (served at `/openapi.json`), and its
generated copy `openapi/takoserver.openapi.json` (`bun run openapi:write`).

The newest CHANGELOG section must be that version, with the heading
`## [<version>] - Unreleased` while it is being prepared and
`## [<version>] - YYYY-MM-DD` once the release date is set. A
`<!-- pending: #N … -->` line in a section marks a pull request whose entry is
written only after it merges. `bun scripts/release-notes.ts <version>` prints
the section, with repository-relative links pointed at the tag `v<version>`,
and refuses it while the heading says `Unreleased` or a pending marker
remains; `--allow-unreleased` previews it.

## 1. Preconditions

Record each result with the commit it was run on. Every item refers to the
**release commit** `X`: the `main` commit the tag will name, where
`package.json` says the version and the CHANGELOG heading has its date.

Use a dedicated clean checkout and a private run directory outside it, as root
(the native lanes need network namespaces and TCP 443), with the shell's
`NODE_ENV` removed. Keep `$RUN` short: native tests bind Unix sockets under
`TMPDIR`, which may be at most 73 bytes.

```sh
export REL=/absolute/path/takoserver-release      # a clean clone, not a working tree
export RUN=/var/tmp/tsr                           # private, outside $REL, and short
export V=2.0.0-rc.1
mkdir -p -m 0700 "$RUN/tmp" "$RUN/assets" "$RUN/native"
git -C "$REL" fetch origin main --tags
export X="$(git -C "$REL" rev-parse origin/main)"  # or an ancestor the owner chose
git -C "$REL" switch --detach "$X"
test -z "$(git -C "$REL" status --porcelain)"
```

- [ ] **Version and notes.** `jq -r .version "$REL/package.json"` prints `$V`,
      and `(cd "$REL" && bun scripts/release-notes.ts "$V")` succeeds without
      `--allow-unreleased`. Set the date and write or remove every pending
      entry in a pull request before tagging; the tag never names a commit
      whose section is unfinished. Check that every pull request merged up to
      `X` is either in the section or deliberately left out:

      ```sh
      git -C "$REL" log --merges --first-parent --format='%s' v1.0.0.."$X" \
        | sed -n 's/^Merge pull request #\([0-9]*\).*/\1/p'
      ```

- [ ] **The tag is new.** Both print nothing:
      `git -C "$REL" tag -l "v$V"` and `git -C "$REL" ls-remote --tags origin "refs/tags/v$V"`.
- [ ] **CI is green on `X`.** Both `Takoserver quality` and
      `Takoserver dependency audit` succeeded for exactly `X`:

      ```sh
      gh run list -R tako0614/takoserver --commit "$X" \
        --json workflowName,status,conclusion,databaseId
      ```

      A failure of a test the CHANGELOG lists as intermittent may be re-run
      once; record both runs. Any other failure stops the release.
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
- [ ] **The native lanes pass on `X`**, one file at a time, with the workerd
      that will be attached and a guard built from `X`
      ([release assets](release-assets.md#workflow-execution-guard)). They also
      need Linux x86-64, `/proc`, `/usr/bin/setpriv` and OpenSSL:

      ```sh
      cd "$REL"
      export NATIVE_PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin:/sbin"
      export TAKOSERVER_WORKERD_BINARY=/usr/local/libexec/takoserver/workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52
      export TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY=/usr/local/libexec/takoserver/workflow-execution-guard
      TAKOSERVER_V2_ENTRY_NATIVE=1 TAKOSERVER_NATIVE_WORKERD_PARENT_LIFETIME=1 \
        env -u NODE_ENV bun scripts/check-native-evidence.ts   # the three lanes must say "ready"
      env -u NODE_ENV bun -e 'import { collectNativeEvidenceGates as gates } from "./scripts/native-evidence.ts";
        const lanes = new Set(["workerd-artifact", "workerd-parent-lifetime", "takoform-v2-bun-entry-lifecycle"]);
        for (const file of new Set(gates("tests").filter((g) => lanes.has(g.capability)).map((g) => `tests/${g.file}`)))
          console.log(file);' > "$RUN/native-files.txt"
      while read -r file; do
        unshare --net sh -c 'ip link set lo up && exec env -i PATH="$NATIVE_PATH" HOME="$HOME" TMPDIR="$RUN/tmp" \
            TAKOSERVER_WORKERD_BINARY="$TAKOSERVER_WORKERD_BINARY" \
            TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY="$TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY" \
            TAKOSERVER_V2_ENTRY_NATIVE=1 TAKOSERVER_NATIVE_WORKERD_PARENT_LIFETIME=1 \
            bun --no-env-file test --timeout 600000 "./$1"' sh "$file" \
          < /dev/null > "$RUN/native/$(basename "$file").log" 2>&1
        echo "exit=$? $file"
      done < "$RUN/native-files.txt" | tee "$RUN/native-summary.txt"
      sha256sum "$RUN/native-summary.txt" "$RUN"/native/*.log > "$RUN/native-digests.txt"
      ```

      On 2026-10-11 the selection was 54 files. Every file must pass, or fail
      only in a way the CHANGELOG's Known limitations names for this version.
      A skipped native test counts as not run. Then run the ordinary journey
      three times the same way (`tests/selfhost-v2-ordinary-journey-native.test.ts`),
      since it is the end-to-end install path, and record each result.
- [ ] **Docs clean-room install.** On a machine or VM with no earlier Takoserver
      state, a person who did not write the docs follows
      [First install and first use](self-host-operations.md#first-install-and-first-use)
      steps 1 to 9 literally, from a clone of `X` and with the binary that will
      be attached, and reaches a Worker served over HTTPS. Record every
      deviation and fix the docs (a docs change moves `X`, so re-run the checks
      above on the new commit). Separately, start `X` on a copy of a used 1.0.0
      data root and confirm the refusal from
      [Upgrading from v1.0.0](self-host-operations.md#upgrading-from-v100).
- [ ] **No open security work blocks the release:** no unpublished advisory
      for a supported version, and the dependency audit on `X` is green.
- [ ] **The assets are ready** in `$RUN/assets`:
  - the workerd binary, copied from the build output as
    `workerd-closed-graph-2026-08-11-linux-x64` and verified as in
    [What an operator verifies](release-assets.md#what-an-operator-verifies);
  - its build inputs unchanged since the build commit:
    `git -C "$REL" diff --exit-code 8ca90e2f "$X" -- workerd ':(exclude)workerd/notices' scripts/build-workerd.ts src/workerd-artifact.ts scripts/workerd-toolchain-prerequisites.sh`
    (`workerd/notices` holds the license texts of the notices bundle, not a build input);
  - the [notices bundle](release-assets.md#the-notices-bundle), generated with
    `<tag>` = `v$V` and `<commit>` = `$X`;
  - the guard digest from a `-trimpath` build at `X`, for the release notes;
  - `SHA256SUMS`:

    ```sh
    (cd "$RUN/assets" && sha256sum workerd-closed-graph-2026-08-11-linux-x64 \
       workerd-closed-graph-2026-08-11-notices.tar.gz > SHA256SUMS && sha256sum --check SHA256SUMS)
    ```

## 2. Tag

Tags are annotated and not signed, like `v1.0.0`:

```sh
git -C "$REL" tag -a "v$V" -m "Takoserver $V" "$X"
test "$(git -C "$REL" rev-parse "v$V^{commit}")" = "$X"
git -C "$REL" cat-file -p "v$V" | sed -n '1,2p'    # object $X, type commit
git -C "$REL" push origin "refs/tags/v$V"          # never --force
```

After the push the tag is permanent; any later problem is repaired forward.

## 3. GitHub Release

Cut the notes from the CHANGELOG and pass them as a file. (1.0.0's notes were
passed inline and were published with literal `\n` sequences.) Add the guard
digest measured at `X` to the notes file if it differs from the one in the
CHANGELOG. Create the Release as a draft, attach the files, review it, then
publish it.

```sh
cd "$REL"
env -u NODE_ENV bun scripts/release-notes.ts "$V" > "$RUN/notes-v$V.md"
gh release create "v$V" -R tako0614/takoserver \
  --verify-tag --draft --prerelease \
  --title "Takoserver $V" \
  --notes-file "$RUN/notes-v$V.md"
gh release upload "v$V" -R tako0614/takoserver \
  "$RUN/assets/workerd-closed-graph-2026-08-11-linux-x64" \
  "$RUN/assets/workerd-closed-graph-2026-08-11-notices.tar.gz" \
  "$RUN/assets/SHA256SUMS"
gh release view "v$V" -R tako0614/takoserver --json tagName,isDraft,isPrerelease,assets
```

`--verify-tag` refuses to create a missing tag, and `--draft` keeps the
Release private until it has been reviewed. `gh release upload` refuses a name
that already exists; never pass `--clobber`. Review the rendered draft on
GitHub, then publish it:

```sh
# A release candidate: a pre-release, never the latest release.
gh release edit "v$V" -R tako0614/takoserver --draft=false --prerelease --latest=false
# The final version (section 5): the latest release.
gh release edit "v$V" -R tako0614/takoserver --draft=false --prerelease=false --latest
```

While only candidates of 2.0.0 exist, `v1.0.0` stays the latest release, and
`releases/latest` keeps pointing to it.

## 4. Verify the release

```sh
gh release view "v$V" -R tako0614/takoserver --json isDraft,isPrerelease,tagName
gh api repos/tako0614/takoserver/releases/latest --jq .tag_name   # v1.0.0 for a candidate, v2.0.0 for the final
git -C "$REL" ls-remote origin "refs/tags/v$V" "refs/tags/v$V^{}"  # the peeled line is $X
gh release view "v$V" -R tako0614/takoserver --json body --jq .body | diff - "$RUN/notes-v$V.md"
mkdir "$RUN/download" && gh release download "v$V" -R tako0614/takoserver -D "$RUN/download"
(cd "$RUN/download" && sha256sum --check SHA256SUMS)
```

Then, on a clean machine, install from the tag (`git clone --branch "v$V"`,
`bun install --frozen-lockfile`) with the downloaded binary, following the
operator checks in [release assets](release-assets.md#what-an-operator-verifies),
and check that the started Host reports the version and its v2 discovery:

```sh
curl -fsS http://127.0.0.1:8787/openapi.json | jq -r .info.version   # $V
curl -fsS http://127.0.0.1:8787/.well-known/takoform/v2 > /dev/null
```

Record the tag object, commit `X`, the notes digest, the check and native log
digests and the asset digests where the owner keeps release evidence (the
`takos-control` task ledger for this release). A candidate does not change
[SECURITY.md](../SECURITY.md): 1.0.0 stays supported until 2.0.0 is released.

## 5. Promote a candidate to 2.0.0

After the owner decides that a candidate is ready (operators have tried it,
and its reported problems are fixed or listed as known limitations):

1. In one pull request to `main`:
   - set the version to `2.0.0` in `package.json` and `src/openapi.ts`, and run
     `bun run openapi:write`;
   - in `CHANGELOG.md`, add `## [2.0.0] - Unreleased` above the candidate's
     section and move the candidate section's body into it. Replace the
     candidate paragraph at its top with a sentence that 2.0.0 is the
     release, add the entries for pull requests merged since the candidate,
     re-check every Known limitation against `main`, and update the Release
     assets subsection for the 2.0.0 tag;
   - leave the candidate's section with one line, for example
     `Release candidate of 2.0.0. Its changes are listed under 2.0.0.`
2. Run all of [Preconditions](#1-preconditions) again with `V=2.0.0` on the new
   release commit, including the native lanes, the clean-room install and a
   new notices bundle that names `v2.0.0` and its commit. The workerd binary
   is the same bytes as in the candidate, attached again under the same name
   to the new Release.
3. [Tag](#2-tag) `v2.0.0`, create the [Release](#3-github-release) without
   `--prerelease`, and publish it with `--latest`.
4. [Verify](#4-verify-the-release): `releases/latest` is `v2.0.0`.
5. In a pull request, update the supported-versions table in
   [SECURITY.md](../SECURITY.md): 2.x is current and 1.0.0 is no longer
   supported, from the release date. Add a first line to the candidate
   Release's notes saying that 2.0.0 supersedes it.

A further candidate (`2.0.0-rc.2`) uses the same steps as the first, with its
own CHANGELOG section above the previous candidate's.

## 6. Defects after release

A published tag or asset is never moved, deleted and recreated, or replaced
with different bytes under the same name; operators may already have pinned
it. Repair forward:

- **Notes are wrong.** Edit them in place (`gh release edit --notes-file`);
  notes are not part of the pinned identity. Fix the CHANGELOG in the same
  change.
- **A candidate is defective.** Add a warning at the top of its notes and
  publish the fix as the next candidate (`2.0.0-rc.2`).
- **A final release is defective.** Add a prominent warning at the top of its
  notes, mark it `--prerelease` if it must stop being the latest release, and
  publish the fix as the next patch version (2.0.1) through this runbook.
- **An attached file is wrong or harmful.** Delete that one asset
  (`gh release delete-asset "v$V" <name> -R tako0614/takoserver --yes`), say
  so in the notes, and ship corrected bytes only under the next version. Do
  not upload a different file under the old name.
- **A security issue.** Follow [SECURITY.md](../SECURITY.md): a private
  advisory, a fixed release of the current major line, then disclosure.
- **A mistake found before the draft is published** (wrong notes or assets on
  a draft) can be fixed on the draft, or the draft deleted
  (`gh release delete "v$V" --yes` keeps the tag). A pushed tag that points at
  the wrong commit is not reused: release the corrected commit as the next
  version.

For operators, a release is not reversible on a data root it has migrated. A
2.x Host cannot hand a migrated root back to 1.0.0; return by restoring the
cold copy taken before the upgrade, as in
[Upgrading from v1.0.0](self-host-operations.md#upgrading-from-v100) and
[Restore boundary](self-host-operations.md#restore-boundary). Between 2.x
releases follow [Update and code rollback](self-host-operations.md#update-and-code-rollback).
