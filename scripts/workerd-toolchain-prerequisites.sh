#!/usr/bin/env bash
set -euo pipefail

readonly expected_libcxx_package_version='1:20.1.8-2ubuntu8'
readonly toolchain_root="${WORKERD_LLVM_ROOT:-/}"
readonly report="${RUNNER_TEMP:?RUNNER_TEMP is required}/workerd-build-runner-report.txt"

if [[ "${toolchain_root}" != /* ]]; then
  echo "prerequisite_failure: WORKERD_LLVM_ROOT must be absolute: ${toolchain_root}" | tee -a "${report}"
  exit 1
fi

if ! sudo apt-get update; then
  echo "prerequisite_failure: apt-get update failed before the workerd build" | tee -a "${report}"
  exit 1
fi

if ! sudo apt-get install --yes --no-install-recommends \
  "libc++-20-dev=${expected_libcxx_package_version}"; then
  echo "prerequisite_failure: could not install pinned libc++-20-dev ${expected_libcxx_package_version}" | tee -a "${report}"
  exit 1
fi

actual_libcxx_package_version="$(dpkg-query -W -f='${Version}' libc++-20-dev 2>/dev/null || true)"
if [[ "${actual_libcxx_package_version}" != "${expected_libcxx_package_version}" ]]; then
  echo "prerequisite_failure: expected libc++-20-dev ${expected_libcxx_package_version}, got '${actual_libcxx_package_version}'" | tee -a "${report}"
  exit 1
fi

libcxx_include="${toolchain_root}/usr/lib/llvm-20/include/c++/v1"
if [[ ! -d "${libcxx_include}" || ! -f "${libcxx_include}/__config" ]]; then
  echo "prerequisite_failure: required pinned libc++ header missing: ${libcxx_include}/__config" | tee -a "${report}"
  exit 1
fi

echo "libcxx_package_version=${actual_libcxx_package_version}" | tee -a "${report}"
echo "libcxx_headers=${libcxx_include}" | tee -a "${report}"
echo "libcxx_prerequisites=verified" | tee -a "${report}"
