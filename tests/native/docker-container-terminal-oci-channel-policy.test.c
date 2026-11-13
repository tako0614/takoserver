#define _GNU_SOURCE
#include "../../scripts/native/docker-container-terminal-oci-stdio.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
  unsigned int checks = 0;
  /* Every mode value: any group/other bit must refuse, independent of the
   * owner's access bits. No FIFO, socket, descriptor or main is executed. */
  for (unsigned int bits = 0; bits < 010000; bits++) {
    mode_t mode = S_IFIFO | (mode_t)bits;
    assert(tns_ocip_private_fifo(mode, 0) == ((bits & 0077U) == 0)); checks++;
    assert(!tns_ocip_private_fifo(mode, 1)); checks++;
  }
  assert(tns_ocip_private_fifo(S_IFIFO | 0600, 0)); checks++;
  assert(!tns_ocip_private_fifo(S_IFIFO | 0666, 0)); checks++;
  assert(!tns_ocip_private_fifo(S_IFIFO | 0601, 0)); checks++;
  assert(!tns_ocip_private_fifo(S_IFIFO | 0610, 0)); checks++;
  assert(!tns_ocip_private_fifo(S_IFREG | 0600, 0)); checks++;
  assert(!tns_ocip_private_fifo(S_IFSOCK | 0600, 0)); checks++;
  printf("PASS %u pure FIFO permission checks; no descriptor operations\n", checks);
  return 0;
}
