#include "../../scripts/native/docker-container-terminal-namespace.h"
#include <assert.h>
#include <stdio.h>

static unsigned int checks;
#define CHECK(e) do { assert(e); checks++; } while (0)

int main(void) {
  struct tns_identity creator = {4, 9}, actual = {4, 10};
  CHECK(tns_kernel_identity_matches(&creator, &actual, 17, 10, 0));
  CHECK(tns_kernel_identity_matches(&creator, &actual, 17, 10, 17));
  CHECK(!tns_kernel_identity_matches(&creator, &actual, 18, 10, 17));
  CHECK(!tns_kernel_identity_matches(&creator, &actual, 0, 10, 0));
  CHECK(!tns_kernel_identity_matches(&creator, &actual, 17, 0, 0));
  CHECK(!tns_kernel_identity_matches(&creator, &actual, 17, 11, 0));
  CHECK(!tns_kernel_identity_matches(NULL, &actual, 17, 10, 0));
  CHECK(!tns_kernel_identity_matches(&creator, NULL, 17, 10, 0));
  CHECK(!tns_kernel_identity_matches(&creator, &creator, 17, 9, 0));
  struct tns_identity invalid = {0, 10};
  CHECK(!tns_kernel_identity_matches(&creator, &invalid, 17, 10, 0));
  invalid = (struct tns_identity){4, 0};
  CHECK(!tns_kernel_identity_matches(&creator, &invalid, 17, 10, 0));
  invalid = (struct tns_identity){0, 9};
  CHECK(!tns_kernel_identity_matches(&invalid, &actual, 17, 10, 0));
  invalid = (struct tns_identity){4, 0};
  CHECK(!tns_kernel_identity_matches(&invalid, &actual, 17, 10, 0));
  actual.inode = UINT64_MAX;
  CHECK(tns_kernel_identity_matches(&creator, &actual, UINT64_MAX,
                                     UINT64_MAX, UINT64_MAX));
  CHECK(!tns_kernel_identity_matches(&creator, &actual, UINT64_MAX - 1,
                                      UINT64_MAX, UINT64_MAX));

  /* Real legacy snapshot fields must be internally consistent. Synthetic
   * inputs here prove only refusal conditions, never an ioctl or birth. */
  CHECK(tns_kernel_counts_consistent(0, 0, 0, 0, 0));
  CHECK(tns_kernel_counts_consistent(2, 5, 3, 0, 0));
  CHECK(!tns_kernel_counts_consistent(0, 5, 3, 0, 0));
  CHECK(!tns_kernel_counts_consistent(2, 3, 5, 0, 0));
  CHECK(!tns_kernel_counts_consistent(UINT64_MAX, 0, 1, 0, 0));
  CHECK(tns_kernel_counts_consistent(UINT64_MAX, UINT64_MAX, 0, 0, 0));
  CHECK(tns_kernel_counts_consistent(1, UINT64_MAX, UINT64_MAX - 1, 0, 0));
  CHECK(!tns_kernel_counts_consistent(1, UINT64_MAX, UINT64_MAX, 0, 0));
  const unsigned int refused[] = {1, 2, 255, UINT32_MAX};
  for (size_t i = 0; i < sizeof(refused) / sizeof(refused[0]); i++) {
    CHECK(!tns_kernel_counts_consistent(2, 5, 3, refused[i], 0));
    CHECK(!tns_kernel_counts_consistent(2, 5, 3, 0, refused[i]));
  }
  printf("PASS %u pure kernel-birth binding checks; no native/device execution\n", checks);
  return 0;
}
