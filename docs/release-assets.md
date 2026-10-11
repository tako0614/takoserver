# Release assets: the closed-graph workerd and the Workflow guard

The complete local Worker profile of a Bun self-host needs two native binaries
that `bun install` does not provide: the patched closed-graph `workerd` and the
Workflow execution guard ([Self-host operations, step 1](self-host-operations.md#1-prerequisites)).
This page says how an operator obtains and verifies each one, and records the
plan and the open decisions for attaching prebuilt copies to a GitHub Release.

Status for 2.0.0: **no prebuilt binary is published.** Nothing in this
repository uploads either binary, and attaching them waits for the decisions
in [Attaching prebuilt binaries](#c-attaching-prebuilt-binaries-to-a-github-release).
The artifact profile (v2 Host API and the artifact Forms) needs neither binary.

## What the Host accepts

| Binary | Setting | What the Host checks | Platform |
| --- | --- | --- | --- |
| closed-graph `workerd` | `TAKOSERVER_WORKERD_BINARY` | Absolute path to a regular, non-symlink, executable file whose SHA-256 is exactly the pin below. The Host copies it into the data root and runs the closed application graph capability probe on the copy. Any mismatch disables Worker execution; it never falls back to the npm `workerd`. | Linux x86-64 only; the reference binary needs glibc 2.38 or newer |
| Workflow execution guard | `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY` | Absolute, symlink-free path to an executable. **There is no digest pin**: the operator is responsible for building it from the same checkout. | Linux x86-64 only |

The workerd pin is [`src/workerd-artifact.ts`](../src/workerd-artifact.ts)
(`WORKERD_CLOSED_GRAPH_ARTIFACT`). It is the only identity the Host accepts:

| Field | Value |
| --- | --- |
| `version` (`workerd --version`) | `2026-08-11` |
| upstream commit | `0129b1e7aaf9afbc21cba79d215723d9839eb7a0` (`cloudflare/workerd`) |
| upstream archive SHA-256 | `1f725582898dbdea4d59a8a71fe65bd62f3aaa7f117dd7107eed5a0d11273919` |
| overlay `workerd/patches/closed-module-graph.patch` SHA-256 | `61b3ed73af00898cbd1032c2750aab9360b7c5508c548218890a2810bae45f45` |
| V8 dependency patch SHA-256 | `3c9e787096cb68514c710cfa05966a025c10f771a472dc2babce0b5bd4a2371d` |
| reviewed native-source identity | `c4417a4bf5e80b07c43fbd437251759dfd34313b44ccdbe27023f4b3666d11ed` |
| Bazelisk v1.29.0 SHA-256 | `5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992` |
| Bazel 9.2.0 SHA-256 | `7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694` |
| compiler | `Ubuntu clang version 20.1.8 (2ubuntu8)` |
| **artifact SHA-256** | **`c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`** |
| platform / arch | `linux` / `x64` |

The pin has not changed since it was introduced (commit `d1869e63`,
2026-09-07). A different binary, including a stripped copy of the same build,
has a different digest and is refused.

## (a) Build from source

### workerd

[`workerd/README.md`](../workerd/README.md) is the build reference. In short,
on Linux x86-64:

1. Install or extract the exact compiler: clang 20.1.8 `2ubuntu8` with its
   matching `libc++-20-dev`, `libc++abi-20-dev`, `lld-20` and
   `libclang-common-20-dev` packages. `WORKERD_LLVM_ROOT` is the absolute root
   that holds them under `usr/bin` and `usr/lib` (`/` when installed system
   wide). [`scripts/workerd-toolchain-prerequisites.sh`](../scripts/workerd-toolchain-prerequisites.sh)
   is what CI uses on an `ubuntu-26.04` runner.
2. Download Bazelisk v1.29.0 and check it:

   ```sh
   curl -fsSL -o "$TOOLS/bazelisk-1.29.0" \
     https://github.com/bazelbuild/bazelisk/releases/download/v1.29.0/bazelisk-linux-amd64
   echo '5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992  '"$TOOLS/bazelisk-1.29.0" \
     | sha256sum --check
   chmod 0755 "$TOOLS/bazelisk-1.29.0"
   ```

3. From the release checkout (tag `v2.0.0`, after `bun install --frozen-lockfile`),
   build into an empty private state root outside the repository:

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
   matching digest is artifact identity, not native qualification.
4. Install the file where only an administrator can replace it, for example
   `install -m 0755 -o root -g root <artifact> /opt/takoserver/bin/workerd`, and
   verify it as in [What to verify](#what-an-operator-verifies).

Budget on the reference host (16 cores, Ubuntu 26.04, 2026-10-07): about 40
minutes from source extraction to artifact, and about 8 GB of build state
(4.7 GB of it the Bazel repository cache). A GitHub-hosted runner with
`--jobs 2` did not finish within 120 minutes.

### Workflow execution guard

The guard has no dependencies outside the Go standard library. Build it from
the release checkout with the pinned toolchain and path-independent flags, so
that two builds of the same source produce the same bytes:

```sh
cd services/workflow-execution-guard
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=go1.26.9 \
  go build -trimpath -buildvcs=false -ldflags=-buildid= \
  -o /opt/takoserver/bin/workflow-execution-guard ./cmd/workflow-execution-guard
```

Observed on 2026-10-11 at source commit `5f4f2eef` (the guard source and
`go.mod` are unchanged on the 2.0.0 release branch): SHA-256
`67709482e9d49b1df1af483f210a5038f1e0a2689f805adb33d5cfc76b2b0b20`,
4,456,737 bytes, statically linked. Two builds from different source paths
produced the same digest. The digest changes whenever the guard source, the
Go toolchain or the flags change, so recompute it at the release commit. The
shorter `go build -o …` in the self-host guide also works, but its output
embeds build paths and its digest is not comparable.

## (b) Exact digests

| Asset | SHA-256 | Size | Source of truth |
| --- | --- | --- | --- |
| workerd `2026-08-11` closed-graph, linux-x64 | `c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52` | 273,943,488 bytes | `src/workerd-artifact.ts` (enforced by the Host) |
| same, `gzip -9 -n` | not pinned; 54,306,558 bytes with the reference host's gzip | — | recompute when packaging |
| workflow-execution-guard, linux-x64 | `67709482e9d49b1df1af483f210a5038f1e0a2689f805adb33d5cfc76b2b0b20` (observed, not enforced) | 4,456,737 bytes | rebuild at the release commit |

The one pinned workerd binary that exists today is on the operator's
development host, built on 2026-10-07 from Takoserver commit `8ca90e2f` with
the same pin:

```text
/root/.local/share/takos/operator-runs/workerd-local-8ca90e2/build-state/artifacts/workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52
sha256  c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52
size    273943488 bytes, mode 0755
file    ELF 64-bit LSB pie executable, x86-64, dynamically linked
        (libc.so.6, libm.so.6 only; highest symbol version GLIBC_2.38), not stripped
--version  workerd 2026-08-11
```

It has not been uploaded anywhere.

## (c) Attaching prebuilt binaries to a GitHub Release

This is a plan. Each open item below must be closed by the repository owner
before any binary is attached.

### Licensing

This section records what the redistributed bytes contain. It is not legal
advice; the copyright holder decides.

- **workerd** is Apache-2.0 (`LICENSE` at the pinned commit). The pinned
  upstream archive has no top-level `NOTICE` file, so Apache-2.0 §4(d) adds no
  workerd-specific notice; §4(a) (ship the license) and §4(b) (modified files
  carry a prominent change notice) apply.
- **The Takoserver patches.** `.reuse/dep5` declares every file of this
  repository, including `workerd/patches/*`, as `AGPL-3.0-or-later`. A binary
  built with them is therefore a modified Apache-2.0 work that contains
  AGPL-3.0-or-later changes. Apache-2.0 code may be combined into an AGPLv3
  work, but distributing the binary then also carries the AGPL object-code
  obligation to provide the Corresponding Source. **Open decision:** either
  (A) distribute under AGPL-3.0-or-later with a Corresponding Source offer,
  or (B) license the patch files under Apache-2.0 with an explicit REUSE
  annotation, so that the binary is an ordinary modified Apache-2.0 work.
- **Statically linked third-party code.** The binary links only `libc` and
  `libm` dynamically; everything else is inside it. From the pinned build's
  dependency set, at least: V8 (BSD-3-Clause, plus its `LICENSE.fdlibm` and
  `LICENSE.strongtalk`), Cap'n Proto/KJ (MIT), ICU (Unicode License), BoringSSL
  (Apache-2.0), abseil-cpp, tcmalloc and Perfetto (Apache-2.0), Highway
  (Apache-2.0 or BSD-3-Clause), Brotli (MIT), zstd (BSD-3-Clause, dual GPLv2),
  zlib (Zlib), fast_float (Apache-2.0, MIT or BSL-1.0), dragonbox (Apache-2.0
  with LLVM exception or BSL-1.0), fp16, nbytes and ncrypto (MIT), ada-url and
  simdutf (Apache-2.0 or MIT), SQLite (public domain), lol-html
  (BSD-3-Clause), workerd-cxx (Apache-2.0 or MIT), LLVM libc++ and llvm-libc
  (Apache-2.0 with LLVM exception), the Rust standard library, and about 180
  Rust crates resolved by `deps/rust/Cargo.lock`. The binary also carries
  Pyodide-related loader code; whether Pyodide (MPL-2.0) bytes are embedded
  must be confirmed. These are the licenses the upstream projects publish;
  the shipped notice file must be generated from the exact build, not copied
  from this list. Some fetched archives (the ada-url and simdutf amalgamations
  and the local lol-html repository) contain no license file, so their text
  must come from the upstream release at the pinned version.
- **Trademark.** Apache-2.0 grants no trademark rights. Name the asset by
  function and pin, for example `workerd-closed-graph-2026-08-11-linux-x64`,
  and describe it as "workerd built from `cloudflare/workerd` commit
  `0129b1e7` with Takoserver's closed-module-graph patches; not an official
  Cloudflare build".
- **The Workflow guard** is Takoserver code (AGPL-3.0-or-later) linked with the
  Go standard library (BSD-3-Clause, whose notice must ship with the binary).

What must ship with an attached workerd binary:

1. `LICENSE` of workerd (Apache-2.0).
2. A modification statement naming the upstream commit, both patches and
   their SHA-256, and the files they change (the patch headers list them).
3. The two patch files themselves.
4. A third-party notice bundle (`THIRD-PARTY-NOTICES.txt`) generated from the
   pinned build, as above.
5. Under option (A): the AGPL-3.0 text and a Corresponding Source offer that
   points to the `v2.0.0` tag, the upstream archive (URL and SHA-256), the
   build script and toolchain pins. The dependency sources Bazel fetches are
   about 4.7 GB; decide whether to rely on their upstream locations with
   clear directions (the owner remains responsible for their availability) or
   to mirror them.

### Reproducibility status

The pinned digest has been reproduced only outside CI. The manual
[`workerd-closed-graph-build`](../.github/workflows/workerd-closed-graph-build.yml)
workflow has never succeeded:

| Run | Commit | Result |
| --- | --- | --- |
| 37541524202 (2026-10-06) | `9ba8dd0d` | `prerequisite_failure`: libc++ headers (`/usr/lib/llvm-20/include/c++/v1`) missing on the runner |
| 37542763135 (2026-10-06) | `7f950372` | `artifact_build_failure`: the build script exited 1 within a minute |
| 37543295654 (2026-10-06) | `0fdfdc46` | `capacity_failure`: stopped by the time limit after 40 minutes |
| 37549527139 (2026-10-07) | `e2accaca` | build completed in 97 minutes but produced `97602205b40ae3b75e36393f8e7c788032a7676a832c6e1c070adb1d27324088`, not the pin |
| 37574129087 (2026-10-07) | `8ca90e2f` | `capacity_failure`: stopped at the 120-minute limit |

The digest mismatch means the build is not yet reproducible across
environments with the same declared toolchain: some input that the pin does
not capture (system headers, package versions, environment) differs between
the reference host and the runner. Until a second independent environment
reproduces `c00638f1…`, a published binary rests on one host's build.
Closing this needs a runner large enough to finish, and a comparison of the
mismatched output against the reference to find the uncaptured input.

### What an operator verifies

```sh
# 1. Digests of everything downloaded, in an empty directory.
sha256sum --check --ignore-missing SHA256SUMS
# 2. If the binary was compressed, the decompressed bytes are what the Host checks.
gunzip -k workerd-closed-graph-2026-08-11-linux-x64.gz
echo 'c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52  workerd-closed-graph-2026-08-11-linux-x64' \
  | sha256sum --check
# 3. Version string and platform.
./workerd-closed-graph-2026-08-11-linux-x64 --version   # workerd 2026-08-11
file workerd-closed-graph-2026-08-11-linux-x64            # ELF 64-bit x86-64
# 4. Guard toolchain and flags.
go version -m workflow-execution-guard-v2.0.0-linux-x64   # go1.26.9, -trimpath=true, CGO_ENABLED=0
```

Then configure the absolute paths and start the Host: the closed-graph
capability probe runs at startup, and the Worker lifecycle Forms appear in
`GET /apis/forms.takoform.com/v2/support?form=…` only if it passes. A digest
match proves identity only; it does not qualify the binary on the operator's
machine.

### SHA256SUMS template

Generate the real file at release time with `sha256sum` over the exact
uploaded files, in a clean directory, and attach it with the assets. GitHub's
automatic source archives are not byte-stable and are not listed.

```text
# Takoserver v2.0.0 release assets. Verify: sha256sum --check --ignore-missing SHA256SUMS
# Source: https://github.com/tako0614/takoserver/tree/v2.0.0 (tag object <tag-sha>, commit <commit-sha>)
c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52  workerd-closed-graph-2026-08-11-linux-x64
<sha256>  workerd-closed-graph-2026-08-11-linux-x64.gz
<sha256>  workflow-execution-guard-v2.0.0-linux-x64
<sha256>  workerd-closed-graph-2026-08-11-NOTICES.tar.gz
```

The NOTICES archive holds items 1 to 5 of the list above. Omit any line whose
asset is not attached; never list an asset that is not part of the release.
