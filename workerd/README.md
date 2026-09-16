# Takoserver closed-graph workerd artifact

Takoserver self-host Worker execution is pinned to one reviewed workerd source
and one Linux x86-64 binary. It does not search `node_modules`, accept another
workerd with the same version string, or fall back after verification fails.
The runtime pin in [`src/workerd-artifact.ts`](../src/workerd-artifact.ts) is the
canonical identity and includes:

- upstream workerd commit
  `0129b1e7aaf9afbc21cba79d215723d9839eb7a0` and archive SHA-256
  `1f725582898dbdea4d59a8a71fe65bd62f3aaa7f117dd7107eed5a0d11273919`;
- [`patches/closed-module-graph.patch`](patches/closed-module-graph.patch),
  SHA-256
  `61b3ed73af00898cbd1032c2750aab9360b7c5508c548218890a2810bae45f45`;
- its V8 dependency patch, SHA-256
  `3c9e787096cb68514c710cfa05966a025c10f771a472dc2babce0b5bd4a2371d`;
- reviewed native-source identity
  `c4417a4bf5e80b07c43fbd437251759dfd34313b44ccdbe27023f4b3666d11ed`;
- resulting workerd SHA-256
  `c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`.

The overlay contains the generic opt-in `APPLICATION` / `HOST_PRIVATE` module
registry policy, both legacy and new resolver implementations, CommonJS and
Node shortcut propagation, V8 generated-script provenance preservation,
architecture documentation, and actual resolver tests. It changes no default
behavior when `modulePolicy` is absent.

## Build

Use an empty private state root outside the repository. The build script writes
downloads, source, Bazel output, repository cache, temporary files, and the
verified final artifact only below that root. It refuses a pre-existing source
directory and never installs a compiler or runtime globally.

The reviewed build used Bazelisk v1.29.0 (SHA-256
`5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992`),
the source-pinned Bazel 9.2.0 executable (SHA-256
`7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694`),
and Ubuntu clang 20.1.8 (`2ubuntu8`). `WORKERD_LLVM_ROOT` is an absolute
filesystem root containing that compiler under `usr/bin` and its matching
LLVM/libc++ files under `usr/lib`; `/` is valid when those packages are
installed on the host. `BAZELISK` is the absolute path to the pinned binary.

```sh
BAZELISK=/absolute/path/to/bazelisk \
WORKERD_LLVM_ROOT=/absolute/compiler-root \
bun run build:workerd -- \
  --state-root /absolute/private/workerd-build
```

An already downloaded upstream archive can be supplied with `--archive
/absolute/workerd.tar.gz`; its digest is checked before extraction. To verify
only the immutable archive and overlay application, add `--prepare-only`.
After a full build, the script verifies Bazelisk, Bazel, V8 patch, and final
binary digests before writing
`artifacts/workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`.
Configure that absolute path as `TAKOSERVER_WORKERD_BINARY`.

The native acceptance run covers these real V8 targets:

```text
//src/workerd/tests:closed-module-graph-test
//src/workerd/tests:module-imports-test
//src/workerd/api/tests:new-module-registry-test
//src/workerd/api/tests:new-module-registry-startup-eval-test
//src/workerd/jsg:modules-new-test
//src/workerd/jsg:resource-test
```

The Takoserver owner gate does not rebuild workerd. It validates the runtime
adapter and fixtures portably; tests given `TAKOSERVER_WORKERD_BINARY` also run
the exact binary's capability probe and real serving E2E. Publishing or
replacing an operator's binary is a separate release/deployment authority and
is not performed by this build script.

## Unqualified WorkerLoader closed-graph candidate

`patches/worker-loader-closed-graph.candidate.patch` is a separate development
overlay, applied **after** the active `closed-module-graph.patch`. It keeps the
existing WorkerLoader `modules` dictionary application-only, adds a separate
optional `hostPrivateModules` dictionary, and adds `mainModuleRole` plus an
explicit application-main policy using the same native module boundary as
static services. Separate dictionaries let the same logical module name exist
once in each provenance namespace without adding a second role authority to a
module entry. Its SHA-256 is
`5a65dc6c02b1b444513e670b3b44eaf6cf4ea419a1590c73a39a72cbdc15b7d7`.

Static patch application (`git apply --check` and GNU `patch --dry-run --fuzz=0`)
and JS syntax checks, plus independent source review, have passed. Native
compilation and WorkerLoader/closed-graph tests have not.
The normal build script does not apply this candidate, and the active patch,
source and binary pins remain unchanged. Do not claim Workflow execution
support or configure a candidate binary from these static checks.

Promotion requires a separately qualified combined overlay and new artifact
identity, then outer/tenant-isolate runtime wiring and native RPC, lifecycle and
isolation acceptance. The existing one-process guard and its physical-stop
barrier are not replaced by this candidate.
