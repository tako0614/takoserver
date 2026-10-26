# Release assets: the closed-graph workerd and the Workflow guard

The complete local Worker profile of a Bun self-host needs two native binaries
that `bun install` does not provide: the patched closed-graph `workerd` and the
Workflow execution guard ([Self-host operations, step 1](self-host-operations.md#1-prerequisites)).
The artifact profile (v2 Host API and the artifact Forms) needs neither.

Decision (2026-10-11, repository owner): from `v2.0.0-rc.1`, the pinned workerd
binary is **attached to the GitHub Release under AGPL-3.0-or-later**, with the
notices bundle described below. The Workflow guard is **not attached**;
operators build it from the release tag. Nothing in this repository uploads
either binary: the person who runs [the release runbook](release.md) attaches
the files.

## What the Host accepts

| Binary | Setting | What the Host checks | Platform |
| --- | --- | --- | --- |
| closed-graph `workerd` | `TAKOSERVER_WORKERD_BINARY` | Absolute path to a regular, non-symlink, executable file whose SHA-256 is exactly the pin below. The Host copies it into the data root and runs the closed application graph capability probe on the copy. Any mismatch disables Worker execution; it never falls back to the npm `workerd`. | Linux x86-64 only; the attached binary needs glibc 2.38 or newer |
| Workflow execution guard | `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY` | Absolute, symlink-free path to an executable. **There is no digest pin**: the operator builds it from the same checkout. | Linux x86-64 only |

The workerd pin is [`src/workerd-artifact.ts`](../src/workerd-artifact.ts)
(`WORKERD_CLOSED_GRAPH_ARTIFACT`). It is the only identity the Host accepts:

| Field | Value |
| --- | --- |
| `version` (`workerd --version`) | `2026-08-11` |
| upstream commit | `0129b1e7aaf9afbc21cba79d215723d9839eb7a0` (`cloudflare/workerd`) |
| upstream archive SHA-256 | `1f725582898dbdea4d59a8a71fe65bd62f3aaa7f117dd7107eed5a0d11273919` |
| overlay `workerd/patches/closed-module-graph.patch` SHA-256 | `61b3ed73af00898cbd1032c2750aab9360b7c5508c548218890a2810bae45f45` |
| V8 dependency patch (added by the overlay) SHA-256 | `3c9e787096cb68514c710cfa05966a025c10f771a472dc2babce0b5bd4a2371d` |
| reviewed native-source identity | `c4417a4bf5e80b07c43fbd437251759dfd34313b44ccdbe27023f4b3666d11ed` |
| Bazelisk v1.29.0 SHA-256 | `5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992` |
| Bazel 9.2.0 SHA-256 | `7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694` |
| compiler | `Ubuntu clang version 20.1.8 (2ubuntu8)` |
| **artifact SHA-256** | **`c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`** |
| platform / arch | `linux` / `x64` |

The pin has not changed since it was introduced (commit `d1869e63`,
2026-09-07). A different binary, including a stripped or recompressed copy of
the same build, has a different digest and is refused.

## Attached files

Each release that carries the binary attaches exactly these files:

| File | Content | SHA-256 | Size |
| --- | --- | --- | --- |
| `workerd-closed-graph-2026-08-11-linux-x64` | The pinned binary, uncompressed and unmodified, so that its digest is the pin. ELF x86-64, dynamically linked to `libc.so.6` and `libm.so.6` only (highest symbol version `GLIBC_2.38`), not stripped. `--version` prints `workerd 2026-08-11`. | `c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52` | 273,943,488 bytes |
| `workerd-closed-graph-2026-08-11-notices.tar.gz` | The [notices bundle](#the-notices-bundle). | computed per release | about 246 KB |
| `SHA256SUMS` | Digests of the two files above. | — | — |

GitHub's automatic source archives are not byte-stable and are not listed in
`SHA256SUMS`; the source is the tag itself.

### Where the attached binary comes from

The one pinned binary that exists today was built on the operator's
development host and has not been uploaded anywhere yet:

```text
path      /root/.local/share/takos/operator-runs/workerd-local-8ca90e2/build-state/artifacts/workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52
sha256    c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52
size      273943488 bytes, mode 0755
built     2026-10-07 08:06 UTC, by `bun run build:workerd` from Takoserver commit 8ca90e2f
host      Ubuntu 26.04 LTS, 16 cores, x86-64
compiler  clang 20.1.8 (2ubuntu8) and its libc++/lld 20.1.8 packages, extracted from
          the Ubuntu .deb files into a private root used as WORKERD_LLVM_ROOT
bazel     Bazelisk 1.29.0, source-pinned Bazel 9.2.0
```

Every build input is unchanged between `8ca90e2f` and the release commit; the
runbook checks this with
`git diff --exit-code 8ca90e2f <release commit> -- workerd ':(exclude)workerd/notices' scripts/build-workerd.ts src/workerd-artifact.ts scripts/workerd-toolchain-prerequisites.sh`
(empty on 2026-10-11 at `a6564aa7`).

### Reproducibility is not established

The pinned digest has been produced only on that host. The manual
[`workerd-closed-graph-build`](../.github/workflows/workerd-closed-graph-build.yml)
workflow has never succeeded:

| Run | Commit | Result |
| --- | --- | --- |
| 37541524202 (2026-10-06) | `9ba8dd0d` | `prerequisite_failure`: libc++ headers (`/usr/lib/llvm-20/include/c++/v1`) missing on the runner |
| 37542763135 (2026-10-06) | `7f950372` | `artifact_build_failure`: the build script exited 1 within a minute |
| 37543295654 (2026-10-06) | `0fdfdc46` | `capacity_failure`: stopped by the time limit after 40 minutes |
| 37549527139 (2026-10-07) | `e2accaca` | build completed in 97 minutes but produced `97602205b40ae3b75e36393f8e7c788032a7676a832c6e1c070adb1d27324088`, not the pin |
| 37574129087 (2026-10-07) | `8ca90e2f` | `capacity_failure`: stopped at the 120-minute limit |

The mismatch means some input the pin does not capture (system headers,
package versions or environment) differs between the reference host and the
runner. Until a second, independent environment reproduces `c00638f1…`, the
attached binary rests on one host's build, and the release notes say so.
Closing this needs a runner large enough to finish and a comparison of the
mismatched output against the reference.

## Licensing

This records what the redistributed bytes contain and how each obligation is
met. It is not legal advice.

- The binary combines upstream workerd, which is Apache-2.0 (`LICENSE` at the
  pinned commit, SHA-256
  `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594`), with
  Takoserver's patches, which `.reuse/dep5` declares `AGPL-3.0-or-later` like
  every file of this repository. Apache-2.0 code may be included in an AGPLv3
  work, so the binary is distributed as a whole under **AGPL-3.0-or-later**,
  while the upstream parts keep their own licenses.
- **Apache-2.0 §4(a)–(d).** The bundle carries the upstream license (a), a
  statement of the modifications (b), and the patches, which keep every
  upstream notice (c). The pinned upstream archive has no `NOTICE` file (only
  `LICENSE`, plus a sample's own license), so §4(d) adds nothing from workerd
  itself; third-party `NOTICE` files are carried where they exist.
- **AGPL-3.0 §6 (object code).** The bundle names the Corresponding Source:
  this repository at the release tag (the patches in `workerd/patches/` and the
  build procedure in `scripts/build-workerd.ts` and `workerd/README.md`), the
  upstream archive by URL and SHA-256, and the dependency sources that Bazel
  fetches, pinned by the upstream archive's lock files, at their upstream
  locations. Under §6(d) the release owner stays responsible for those
  locations remaining available; mirroring the reference build's repository
  cache (about 4.7 GB) is the fallback if one disappears.
- **Third-party code inside the binary.** Everything except `libc` and `libm` is
  statically linked: V8 (with its `LICENSE.fdlibm` and `LICENSE.strongtalk`),
  Cap'n Proto/KJ, ICU, BoringSSL, abseil-cpp, tcmalloc, Perfetto, Highway,
  Brotli, zstd, zlib, fast_float, dragonbox, fp16, nbytes, ncrypto, ada-url,
  simdutf, SQLite, lol-html, workerd-cxx, LLVM libc++ and llvm-libc, the Rust
  standard library and 186 Rust crates. The binary also carries
  Pyodide-related loader code. The bundle carries their license files as
  collected from the build, not as listed here, with the Rust standard library
  and libc++ notices taken from the toolchain.
- **Trademark.** Apache-2.0 grants no trademark rights. The asset is named by
  function and pin, and the notice says it is not an official Cloudflare build.
- **The guard** is not attached. Anyone who attaches it later must add the Go
  standard library's BSD-3-Clause notice.

### The notices bundle

Layout of `workerd-closed-graph-2026-08-11-notices.tar.gz`:

```text
workerd-closed-graph-2026-08-11-notices/
  NOTICE.md                        the text below, with the tag and commit filled in
  LICENSE.workerd-Apache-2.0       upstream LICENSE from the pinned archive
  LICENSE.AGPL-3.0                 this repository's LICENSE
  patches/closed-module-graph.patch
  third-party/<repository>/...     license, copying and notice files from the build,
                                   at their paths inside the repository
  third-party/rust-std-1.96.0/     the Rust standard library's notices (step 3)
  third-party/llvm-libc++-20.1.8-2ubuntu8/copyright
                                   the Ubuntu copyright file of libc++ and libc++abi (step 3)
  third-party/MANUAL.md            texts added by hand (step 4)
```

`NOTICE.md`:

```markdown
# workerd-closed-graph-2026-08-11-linux-x64

This file is workerd built from cloudflare/workerd commit
0129b1e7aaf9afbc21cba79d215723d9839eb7a0 (archive SHA-256
1f725582898dbdea4d59a8a71fe65bd62f3aaa7f117dd7107eed5a0d11273919) with
Takoserver's closed-module-graph patches. It is not an official Cloudflare
build. SHA-256 c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52.

License: the binary as a whole is distributed under the GNU Affero General
Public License, version 3 or later (LICENSE.AGPL-3.0). workerd is licensed under
the Apache License 2.0 (LICENSE.workerd-Apache-2.0). Third-party components keep
their own licenses (third-party/).

Modifications: Takos modified workerd with patches/closed-module-graph.patch
(SHA-256 61b3ed73af00898cbd1032c2750aab9360b7c5508c548218890a2810bae45f45),
which adds an opt-in APPLICATION / HOST_PRIVATE module registry policy to the
legacy and new module registries, CommonJS and Node shortcut propagation,
documentation and tests, and the V8 patch
0039-Preserve-generated-script-host-options-for-dynamic-import.patch (SHA-256
3c9e787096cb68514c710cfa05966a025c10f771a472dc2babce0b5bd4a2371d). The
patch header lists every changed file. Behaviour is unchanged when a Worker
does not set modulePolicy.

Corresponding Source:
- https://github.com/tako0614/takoserver/tree/<tag> (commit <commit>):
  workerd/patches/, scripts/build-workerd.ts, workerd/README.md and
  src/workerd-artifact.ts, which pins every input digest;
- https://github.com/cloudflare/workerd/archive/0129b1e7aaf9afbc21cba79d215723d9839eb7a0.tar.gz,
  whose lock files pin the dependency sources Bazel fetches.

Build: `bun run build:workerd` at Takoserver commit 8ca90e2f (build inputs
identical to <commit>), 2026-10-07, Ubuntu 26.04 LTS x86-64, clang 20.1.8
(2ubuntu8), Bazelisk 1.29.0 and Bazel 9.2.0. This digest has not yet been
reproduced in a second environment.
```

#### Which tag and commit `NOTICE.md` names

`<tag>` is `v$V` (`v2.0.0-rc.1`) and `<commit>` is the release commit `$X`
that the tag will name ([release runbook](release.md#1-preconditions)). `$X`
exists only after the release preparation is merged to `main`, and the bundle
names it, so the order is fixed:

1. Merge every change meant for the release, including this document, to
   `main`, and fix `$X`.
2. Generate the bundle with `$X` as below, then write `SHA256SUMS`
   ([release runbook](release.md#1-preconditions), "The assets are ready").
3. Create the tag on `$X` ([Tag](release.md#2-tag)).

The bundle's digest is recorded only in `SHA256SUMS` and in the release
evidence (the `takos-control` task ledger), never in a file of this repository:
committing it would move `$X`, and the bundle would then name a commit that the
tag does not point to. If `main` must change after step 2, the new commit is a
new `$X` and needs a new bundle. The `tree/v$V` link in `NOTICE.md` resolves
only once the tag is pushed.

#### Generating the bundle

Use a host that holds the completed build state of the pinned binary (`$B`,
the `--state-root` of `bun run build:workerd`) and the compiler root it was
built with (`$WORKERD_LLVM_ROOT`). `$REL`, `$RUN`, `$V` and `$X` are those of
the [release runbook](release.md#1-preconditions), with `$REL` checked out at
`$X`.

1. Copy the fixed files:

   ```sh
   N="$RUN/notices/workerd-closed-graph-2026-08-11-notices"
   mkdir -p "$N/patches" "$N/third-party"
   tar -xzOf "$B/downloads/workerd-0129b1e7aaf9afbc21cba79d215723d9839eb7a0.tar.gz" \
     workerd-0129b1e7aaf9afbc21cba79d215723d9839eb7a0/LICENSE > "$N/LICENSE.workerd-Apache-2.0"
   cp "$REL/LICENSE" "$N/LICENSE.AGPL-3.0"
   cp "$REL/workerd/patches/closed-module-graph.patch" "$N/patches/"
   ```

2. Write `NOTICE.md` from the template above, which is the only `markdown`
   block in this file, and check that no placeholder is left:

   ```sh
   sed -n '/^```markdown$/,/^```$/{/^```/d;p}' "$REL/docs/release-assets.md" \
     | sed "s|<tag>|v$V|g; s|<commit>|$X|g" > "$N/NOTICE.md"
   ! grep -n '<tag>\|<commit>' "$N/NOTICE.md"
   ```

3. Collect license files from every repository the build fetched, skipping only
   build tools (including more than is linked is acceptable; leaving one out is
   not). Each file keeps its path inside the repository, so a nested license
   cannot overwrite the top-level one (when files were flattened, Perfetto's
   `python/LICENSE` replaced its `LICENSE`):

   ```sh
   E="$(ls -d "$B"/bazel-output/*/external)"
   for d in "$E"/*/; do
     name="$(basename "$d")"
     case "$name" in
       rules_rust++crate+crates_vendor__*) ;;
       @*|*.marker|rules_*|aspect_*|bazel_*|platforms*|apple_support*|*toolchain*|remotejdk*|remote_jdk*|local_*|*python*|nodejs*|*esbuild*|jq*|yq*|tar.bzl*|toml.bzl*|package_metadata*|*benchmark*|*protoc*) continue ;;
     esac
     files="$(cd "$d" && find -L . -maxdepth 2 -type f \( -iname 'LICEN[CS]E*' -o -iname 'COPYING*' -o -iname 'NOTICE*' -o -iname 'UNLICENSE*' \) | sort)"
     if [ -n "$files" ]; then
       mkdir -p "$N/third-party/$name" && printf '%s\n' "$files" | while read -r f; do (cd "$d" && cp --parents "$f" "$N/third-party/$name/"); done
     elif [ -f "$d/Cargo.toml" ]; then
       mkdir -p "$N/third-party/$name" && grep -m1 -E '^license *=' "$d/Cargo.toml" > "$N/third-party/$name/LICENSE-EXPRESSION"
     else
       echo "needs manual text: $name"
     fi
   done
   ```

   The loop skips toolchains, but two toolchain runtimes are linked into the
   binary, whose `.comment` section names rustc 1.96.0 and clang 20.1.8: the
   Rust standard library and libc++/libc++abi from the Ubuntu
   `llvm-toolchain-20` `1:20.1.8-2ubuntu8` packages (the `libc++abi-20-dev`
   copyright file is the same bytes). Add their notices:

   ```sh
   T="$E/rules_rust++rust+rust_linux_x86_64__x86_64-unknown-linux-gnu__stable_tools/share/doc/rust"
   mkdir -p "$N/third-party/rust-std-1.96.0" "$N/third-party/llvm-libc++-20.1.8-2ubuntu8"
   cp "$T/COPYRIGHT-library.html" "$N/third-party/rust-std-1.96.0/"
   cp -R "$T/licenses" "$N/third-party/rust-std-1.96.0/"
   cp "$WORKERD_LLVM_ROOT/usr/share/doc/libc++-20-dev/copyright" "$N/third-party/llvm-libc++-20.1.8-2ubuntu8/"
   ```

4. Put `third-party/MANUAL.md` in place. It holds the upstream license text, at
   the pinned version, for each repository the loop reports and for each crate
   that has only a `LICENSE-EXPRESSION`, and says for each where the version is
   pinned and where the text comes from. For this binary the file is kept in
   the repository as `workerd/notices/MANUAL.md` (written on 2026-10-11,
   SHA-256 `f43f3222c02638532362b49a8f95d912ab12e4ecc3e38fc15693e1200942c5e2`):

   ```sh
   cp "$REL/workerd/notices/MANUAL.md" "$N/third-party/MANUAL.md"
   ```

   Copy it while the loop reports exactly the repositories and crates below;
   otherwise add the new entries to `workerd/notices/MANUAL.md` the same way,
   and change the pinned build in the same pull request. It covers:
   - the seven repositories the loop reports: `+http+capnp-cpp` (the archive's
     `LICENSE` sits outside the `c++/` directory the build uses), `+http+simdutf`
     and `ada-url+` (single-header archives; texts from the `v9.0.0` and `v4.0.0`
     tags), `+pyodide+pyodide-314.0.4` (text from tag `314.0.4`),
     `+new_local_repository+com_cloudflare_lol_html` (a wrapper with no source;
     the `lol_html` crates' license is already collected), and `perfetto_cfg+`
     and `workerd-v8+` (directories of the workerd archive itself, covered by
     `LICENSE.workerd-Apache-2.0`);
   - 30 crates whose packages ship no license file: 23 `swc-project/swc` crates
     and `swc_sourcemap`, `base64-simd`, `vsimd`, `bytes-str`, `par-core`,
     `link_args` and `selectors`, with the versions and checksums of the
     workerd archive's `deps/rust/Cargo.lock`.

5. Pack it reproducibly, with fixed modes, and check it against the 2026-10-11
   run:

   ```sh
   find "$N" -type d -exec chmod 0755 {} + && find "$N" -type f -exec chmod 0644 {} +
   (cd "$RUN/notices" && LC_ALL=C tar --format=gnu --sort=name --owner=0 --group=0 --numeric-owner \
       --mtime=2026-08-11 -cf - workerd-closed-graph-2026-08-11-notices | gzip -9 -n \
       > "$RUN/assets/workerd-closed-graph-2026-08-11-notices.tar.gz")
   (cd "$N" && find . -type f ! -path ./NOTICE.md -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum
   ```

   With the same build state and `MANUAL.md`, the last line prints
   `4fb8874fb109eb90d7f48e3007cdb9a9711b640cc5798cd8b3aacfccfa31e2c7`: only
   `NOTICE.md` differs from the 2026-10-11 run.

#### The 2026-10-11 run

The procedure above was run on 2026-10-11 against the build state of the pinned
binary (`/root/.local/share/takos/operator-runs/workerd-local-8ca90e2/build-state`),
with `<tag>` = `v2.0.0-rc.1` and, because `$X` did not exist yet, `<commit>` =
`db29e3d43865a6956b6ccb071e33877f77785d00`, the head of the release preparation
branch before this record (build inputs unchanged since `8ca90e2f`). That bundle is a rehearsal:
its `NOTICE.md` names a commit that the tag will not point to, so it is not
uploaded, and the release regenerates the bundle with `$X`.

| Item | Result |
| --- | --- |
| Bundle SHA-256 (rehearsal, `<commit>` = `db29e3d4`) | `73f6a698821f343c82bfeed2940b5f223b65029b1cac2b4902a08780525e1c7b` |
| Size | 246,429 bytes; 342 files |
| Everything except `NOTICE.md` (last line of step 5) | `4fb8874fb109eb90d7f48e3007cdb9a9711b640cc5798cd8b3aacfccfa31e2c7` |
| `third-party/` | 208 directories: 176 repositories whose files step 3 collected, the two toolchain runtimes, and the 30 crates covered by `MANUAL.md` |
| Placeholders in `NOTICE.md` | none left |
| `patches/closed-module-graph.patch` | `61b3ed73af00898cbd1032c2750aab9360b7c5508c548218890a2810bae45f45`, as `NOTICE.md` states |
| `LICENSE.workerd-Apache-2.0` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594`, the same bytes as `LICENSE` in the pinned archive and at `cloudflare/workerd` `0129b1e7` on GitHub |
| License text per directory | every `third-party/` directory holds a non-empty text, except the 30 crates, which `MANUAL.md` lists; `MANUAL.md` has an entry for each of the seven reported repositories |
| Reproducibility | two packs of the same tree, a pack of a copy in another directory, and a full regeneration into an empty directory gave the same digest |

What is not exact or not included:

- **Not determined exactly** (part 3 of `MANUAL.md`). For the 23 swc crates the
  commits their packages record are not on GitHub, so the text is swc's
  `LICENSE`, unchanged on `main` from 2024-08-11 to 2026-10-11, a period that
  covers all 23 publications. `swc_sourcemap` 10.0.2 ships no BSD-3-Clause
  text, so the text and copyright line are those of `swc-project/swc-sourcemap`,
  the repository it was moved from. `link_args` 0.6.0 (MIT OR Apache-2.0 OR
  Zlib) has no license text or copyright line upstream at any commit, so only
  the Apache-2.0 text is carried.
- **Not covered by a notice in the bundle:** `libc` and `libm`, which are
  linked dynamically from the operator's system, and what the linker adds from
  the build host's glibc and GCC 15.2.0 (`.comment` names GCC): the startup
  files and the static `libgcc`/`libgcc_eh`, which provides the `_Unwind_*`
  unwinder. `libgcc` is GPL-3.0-or-later with the GCC Runtime Library
  Exception 3.1; the bundle relies on that exception and adds no notice for
  it, which the repository owner should confirm. No npm package is embedded:
  workerd uses them only for types and build tooling, and the binary contains
  no `node_modules` path.

## What an operator verifies

In an empty directory, after downloading the release files, and with a
checkout of the same tag:

```sh
# 1. The files are the ones the release lists.
sha256sum --check SHA256SUMS
# 2. The binary is the one this version of the Host accepts.
grep -o 'sha256: "[0-9a-f]\{64\}"' /path/to/takoserver-checkout/src/workerd-artifact.ts
#    must print the same digest as the binary's line in SHA256SUMS:
#    c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52
# 3. It runs on this machine and reports the pinned version.
ldd --version | head -n 1          # glibc 2.38 or newer
chmod 0755 workerd-closed-graph-2026-08-11-linux-x64
./workerd-closed-graph-2026-08-11-linux-x64 --version   # workerd 2026-08-11
```

Then install it where only an administrator can replace it, for example
`install -m 0755 -o root -g root workerd-closed-graph-2026-08-11-linux-x64 /usr/local/libexec/takoserver/workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`,
set `TAKOSERVER_WORKERD_BINARY` to that path, and start the Host. The closed
application graph capability probe runs at startup, and the Worker lifecycle
Forms appear in `GET /apis/forms.takoform.com/v2/support?form=…` only if it
passes. A digest match proves identity only; it does not qualify the binary on
the operator's machine.

## Building from source

Building is the alternative to the attached binary, and the only way to get
the guard.

### workerd

[`workerd/README.md`](../workerd/README.md) is the build reference. In short,
on Linux x86-64:

1. Install or extract the exact compiler: clang 20.1.8 `2ubuntu8` with the
   matching `libc++-20-dev`, `libc++abi-20-dev`, `lld-20` and
   `libclang-common-20-dev` packages and their dependencies.
   `WORKERD_LLVM_ROOT` is the absolute root that holds them under `usr/bin` and
   `usr/lib` (`/` when installed system wide).
   [`scripts/workerd-toolchain-prerequisites.sh`](../scripts/workerd-toolchain-prerequisites.sh)
   is what CI uses on an `ubuntu-26.04` runner.
2. Download Bazelisk v1.29.0 and check it:

   ```sh
   curl -fsSL -o "$TOOLS/bazelisk-1.29.0" \
     https://github.com/bazelbuild/bazelisk/releases/download/v1.29.0/bazelisk-linux-amd64
   echo '5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992  '"$TOOLS/bazelisk-1.29.0" \
     | sha256sum --check
   chmod 0755 "$TOOLS/bazelisk-1.29.0"
   ```

3. From the release checkout, after `bun install --frozen-lockfile`, build into
   an empty private state root outside the repository:

   ```sh
   BAZELISK="$TOOLS/bazelisk-1.29.0" \
   WORKERD_LLVM_ROOT=/absolute/compiler-root \
   bun run build:workerd -- \
     --state-root /absolute/private/workerd-build \
     --jobs 2 \
     --memory-mb 8192
   ```

   Add `--plan` first to print the pinned target and scheduler arguments
   without downloading or compiling. The script verifies every input digest
   and the final binary, then writes
   `<state root>/artifacts/workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`.
   Its last line is a JSON report with `nativeQualification: "not-run"`: a
   matching digest is artifact identity, not native qualification. A build
   that produces another digest is refused by the script and by the Host.

Budget on the reference host: about 40 minutes from source extraction to
artifact, and about 8 GB of build state (4.7 GB of it the Bazel repository
cache). A GitHub-hosted runner with `--jobs 2` did not finish within 120
minutes.

### Workflow execution guard

The guard has no dependencies outside the Go standard library. Build it from
the release checkout with the pinned toolchain and path-independent flags, so
that two builds of the same source produce the same bytes:

```sh
cd services/workflow-execution-guard
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=go1.26.10 \
  go build -trimpath -buildvcs=false -ldflags=-buildid= \
  -o /usr/local/libexec/takoserver/workflow-execution-guard ./cmd/workflow-execution-guard
go version -m /usr/local/libexec/takoserver/workflow-execution-guard   # go1.26.10, -trimpath=true, CGO_ENABLED=0
```

On 2026-10-11, from source commit `5f4f2eef` with Go 1.26.9, the same flags
produced SHA-256
`67709482e9d49b1df1af483f210a5038f1e0a2689f805adb33d5cfc76b2b0b20`,
4,456,737 bytes, statically linked, from two different source paths. An
operator who builds the same tag with the same command can compare against
the digest the release notes give. The digest changes whenever the guard
source, the Go toolchain or the flags change, so the release recomputes it at
the release commit. The shorter `go build -o …` in the self-host guide also
works, but its output embeds build paths and its digest is not comparable (a
plain go1.26.9 build of the same source gave `37e4919e…`).

## SHA256SUMS template

Generate the real file at release time with `sha256sum` over the exact files
to be uploaded, in a clean directory, and attach it with them:

```text
c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52  workerd-closed-graph-2026-08-11-linux-x64
<sha256 of the bundle>  workerd-closed-graph-2026-08-11-notices.tar.gz
```

`sha256sum --check` reads only lines of this form, so the file holds nothing
else. List exactly the attached files, never one that is not attached.

The bundle's line exists only after the bundle is generated at the release
commit, and it is not written into this repository
([Which tag and commit `NOTICE.md` names](#which-tag-and-commit-noticemd-names)).
The 2026-10-11 rehearsal digest `73f6a698…` is not that line.
